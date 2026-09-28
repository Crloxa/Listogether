// lyrics.go 实现歌词（D-017）：host 发布 → 校验/内存缓存（LRU 50）→ 转发其他在线成员；
// 连接挂载后与屏障完成切歌时补发当前曲目缓存。不进快照、不占 revision。
package room

import (
	"listogether/apps/relay/internal/protocol"
)

// 歌词缓存上限（每房间）。
const maxLyricsEntries = 50

type lyricsEntry struct {
	Format string
	Text   string
}

// handleTrackLyrics 处理 host 的歌词发布。
func (r *Room) handleTrackLyrics(m *member, env *protocol.Envelope) {
	if err := r.requireRole(m, RoleHost); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeTrackLyrics(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	// 缓存（容量上限，淘汰最旧）
	if _, exists := r.lyrics[p.TrackID]; !exists {
		r.lyricsOrder = append(r.lyricsOrder, p.TrackID)
		if len(r.lyricsOrder) > maxLyricsEntries {
			evict := r.lyricsOrder[0]
			r.lyricsOrder = r.lyricsOrder[1:]
			delete(r.lyrics, evict)
		}
	}
	r.lyrics[p.TrackID] = &lyricsEntry{Format: p.Format, Text: p.Lyrics}
	r.logger.Info("lyrics published", "roomId", r.cfg.ID, "trackId", p.TrackID, "format", p.Format)
	// 转发给其他在线成员（发布者本地已有）；与聊天一致：不占 revision、不进快照
	r.broadcastExcept(m.ID, protocol.TypeTrackLyrics, m.ID, protocol.MarshalPayload(p))
}

// sendLyricsForTrack 向单个连接补发指定曲目的缓存歌词（连接挂载后调用）。
func (r *Room) sendLyricsForTrack(c Conn, trackID string) {
	if trackID == "" {
		return
	}
	entry, ok := r.lyrics[trackID]
	if !ok {
		return
	}
	env := protocol.Envelope{
		V: protocol.ProtocolVersion, Type: protocol.TypeTrackLyrics, EventID: protocol.NewEventID(),
		RoomRevision: r.revision, SenderID: "relay", SentAtMs: r.now().UnixMilli(),
		Payload: protocol.MarshalPayload(protocol.TrackLyricsPayload{TrackID: trackID, Format: entry.Format, Lyrics: entry.Text}),
	}
	_ = c.Send(env)
}

// broadcastLyricsForTrack 向全部在线成员补发指定曲目的缓存歌词（屏障完成切歌时调用）。
func (r *Room) broadcastLyricsForTrack(trackID string) {
	if trackID == "" {
		return
	}
	entry, ok := r.lyrics[trackID]
	if !ok {
		return
	}
	r.broadcast(protocol.TypeTrackLyrics, "relay", protocol.MarshalPayload(protocol.TrackLyricsPayload{TrackID: trackID, Format: entry.Format, Lyrics: entry.Text}))
}

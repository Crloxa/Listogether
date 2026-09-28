// queue.go 实现房间曲库、点歌审批、队列管理、投票跳过与聊天（Phase 3，D-012/D-013）。
// Relay 是这些状态的权威；音频文件只在房主本机，队列播放的执行者是房主客户端。
package room

import (
	"listogether/apps/relay/internal/protocol"
	"time"
)

// Phase 3 参数（D-012/D-013；均为固定值，不引入配置面）。
const (
	// listener 点歌冷却与配额；host/co_dj 不受限（审批权本身就是节流阀）。
	listenerRequestCooldown = 30 * time.Second
	listenerPendingQuota    = 2

	chatCap        = 50 // 每房间保留的聊天条数
	chatWindow     = 10 * time.Second
	chatRateMax    = 10 // 窗口内每成员最大消息数
	emptyEntryName = "房主"
)

// ---- 曲库 ----

func (r *Room) handleLibraryAdd(m *member, env *protocol.Envelope) {
	// 曲库 = 房主本地文件元数据；只有房主能导入（D-012）
	if err := r.checkWrite(m, env, RoleHost); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeLibraryAdd(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	if len(r.library)+len(p.Tracks) > protocol.MaxLibraryLen {
		r.sendError(m, protocol.CodeInvalidMessage, "曲库已满（最多 500 首）", env.EventID)
		return
	}
	existing := make(map[string]struct{}, len(r.library))
	for _, e := range r.library {
		existing[e.TrackID] = struct{}{}
	}
	nowMs := r.now().UnixMilli()
	for _, tr := range p.Tracks {
		if _, dup := existing[tr.TrackID]; dup {
			continue // 重复导入按 trackId 幂等跳过
		}
		r.library = append(r.library, protocol.LibraryEntry{
			TrackID: tr.TrackID, Title: tr.Title, Artist: tr.Artist,
			DurationMs: tr.DurationMs, AddedBy: m.ID, AddedAtMs: nowMs,
		})
		existing[tr.TrackID] = struct{}{}
	}
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handleLibraryRemove(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeLibraryRemove(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	kept := r.library[:0]
	removed := false
	for _, e := range r.library {
		if e.TrackID == p.TrackID {
			removed = true
			continue
		}
		kept = append(kept, e)
	}
	if !removed {
		r.sendError(m, protocol.CodeInvalidMessage, "曲库中没有该曲目", env.EventID)
		return
	}
	r.library = kept
	r.bump()
	r.broadcastSnapshot()
}

// ---- 点歌与队列 ----

func (r *Room) handleQueueRequest(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ, RoleListener); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeQueueRequest(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	var libEntry *protocol.LibraryEntry
	for i := range r.library {
		if r.library[i].TrackID == p.TrackID {
			libEntry = &r.library[i]
			break
		}
	}
	if libEntry == nil {
		r.sendError(m, protocol.CodeInvalidMessage, "曲库中没有该曲目", env.EventID)
		return
	}
	// 重复检测：待审批 + 队列中已有同一 trackId（D-012）
	for _, e := range r.pendingReqs {
		if e.Track.TrackID == p.TrackID {
			r.sendError(m, protocol.CodeDuplicateTrack, "该歌曲已在待审批列表中", env.EventID)
			return
		}
	}
	for _, e := range r.queue {
		if e.Track.TrackID == p.TrackID {
			r.sendError(m, protocol.CodeDuplicateTrack, "该歌曲已在队列中", env.EventID)
			return
		}
	}
	now := r.now()
	if m.Role == RoleListener {
		// 冷却与配额只约束 listener（D-012）
		if last, ok := r.requestAt[m.ID]; ok && now.Sub(last) < listenerRequestCooldown {
			r.sendError(m, protocol.CodeRateLimited, "点歌太频繁，请稍后再试", env.EventID)
			return
		}
		count := 0
		for _, e := range r.pendingReqs {
			if e.RequestedBy == m.ID {
				count++
			}
		}
		for _, e := range r.queue {
			if e.RequestedBy == m.ID {
				count++
			}
		}
		if count >= listenerPendingQuota {
			r.sendError(m, protocol.CodeRateLimited, "你的点歌配额已用完（最多 2 首未播放）", env.EventID)
			return
		}
	}
	if len(r.pendingReqs) >= protocol.MaxPendingLen {
		r.sendError(m, protocol.CodeRateLimited, "待审批列表已满", env.EventID)
		return
	}
	entry := protocol.QueueEntry{
		EntryID:         protocol.NewEventID(),
		Track:           protocol.Track{TrackID: libEntry.TrackID, Title: libEntry.Title, Artist: libEntry.Artist, DurationMs: libEntry.DurationMs},
		RequestedBy:     m.ID,
		RequestedByName: m.Name,
		AddedAtMs:       now.UnixMilli(),
	}
	if m.Role == RoleHost || m.Role == RoleCoDJ {
		// host/co_dj 免审批直接入队尾（D-012 插队规则）
		if len(r.queue) >= protocol.MaxQueueLen {
			r.sendError(m, protocol.CodeInvalidMessage, "队列已满", env.EventID)
			return
		}
		r.queue = append(r.queue, entry)
	} else {
		r.pendingReqs = append(r.pendingReqs, entry)
		r.requestAt[m.ID] = now
	}
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handleQueueApprove(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeQueueEntryID(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	idx := indexOfEntry(r.pendingReqs, p.EntryID)
	if idx < 0 {
		r.sendError(m, protocol.CodeInvalidMessage, "待审批列表中没有该条目", env.EventID)
		return
	}
	if len(r.queue) >= protocol.MaxQueueLen {
		r.sendError(m, protocol.CodeInvalidMessage, "队列已满", env.EventID)
		return
	}
	entry := r.pendingReqs[idx]
	r.pendingReqs = append(r.pendingReqs[:idx], r.pendingReqs[idx+1:]...)
	r.queue = append(r.queue, entry)
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handleQueueReject(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeQueueEntryID(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	idx := indexOfEntry(r.pendingReqs, p.EntryID)
	if idx < 0 {
		r.sendError(m, protocol.CodeInvalidMessage, "待审批列表中没有该条目", env.EventID)
		return
	}
	entry := r.pendingReqs[idx]
	r.pendingReqs = append(r.pendingReqs[:idx], r.pendingReqs[idx+1:]...)
	r.appendHistory(protocol.HistoryEntry{Track: entry.Track, Outcome: "rejected", AtMs: r.now().UnixMilli(), RequestedByName: entry.RequestedByName})
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handleQueueRemove(m *member, env *protocol.Envelope) {
	p, perr := protocol.DecodeQueueEntryID(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	// 撤销：host/co_dj 可移除任意条目；listener 只能撤销自己的条目（D-012）
	if idx := indexOfEntry(r.queue, p.EntryID); idx >= 0 {
		if err := r.requireRemovalAllowed(m, &r.queue[idx], env); err != nil {
			return
		}
		r.queue = append(r.queue[:idx], r.queue[idx+1:]...)
		r.bump()
		r.broadcastSnapshot()
		return
	}
	if idx := indexOfEntry(r.pendingReqs, p.EntryID); idx >= 0 {
		if err := r.requireRemovalAllowed(m, &r.pendingReqs[idx], env); err != nil {
			return
		}
		r.pendingReqs = append(r.pendingReqs[:idx], r.pendingReqs[idx+1:]...)
		r.bump()
		r.broadcastSnapshot()
		return
	}
	r.sendError(m, protocol.CodeInvalidMessage, "队列中没有该条目", env.EventID)
}

func (r *Room) requireRemovalAllowed(m *member, entry *protocol.QueueEntry, env *protocol.Envelope) *AccessError {
	if m.Role == RoleHost || m.Role == RoleCoDJ || entry.RequestedBy == m.ID {
		return nil
	}
	err := &AccessError{Code: protocol.CodeUnauthorized, Message: "只能撤销自己点播的条目"}
	r.sendError(m, err.Code, err.Message, env.EventID)
	return err
}

func (r *Room) handleQueueReorder(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeQueueReorder(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	if len(p.EntryIDs) != len(r.queue) {
		r.sendError(m, protocol.CodeInvalidMessage, "重排列表必须包含当前队列的全部条目", env.EventID)
		return
	}
	byID := make(map[string]protocol.QueueEntry, len(r.queue))
	for _, e := range r.queue {
		byID[e.EntryID] = e
	}
	reordered := make([]protocol.QueueEntry, 0, len(p.EntryIDs))
	for _, id := range p.EntryIDs {
		e, ok := byID[id]
		if !ok {
			r.sendError(m, protocol.CodeInvalidMessage, "重排列表包含未知条目", env.EventID)
			return
		}
		reordered = append(reordered, e)
	}
	r.queue = reordered
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handleQueueClear(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	if _, perr := protocol.DecodeQueueClear(env.Payload); perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	r.queue = []protocol.QueueEntry{}
	r.pendingReqs = []protocol.QueueEntry{}
	r.bump()
	r.broadcastSnapshot()
}

// ---- 投票跳过与曲目历史 ----

// skipVotePassed 判断当前票数是否通过：严格超过在线成员半数且至少 2 票（D-013）。
func (r *Room) skipVotePassed() bool {
	votes := len(r.skipVotes)
	return votes >= 2 && votes*2 > r.onlineCount()
}

func (r *Room) onlineCount() int {
	n := 0
	for _, id := range r.order {
		if m := r.members[id]; m != nil && m.Status == StatusOnline {
			n++
		}
	}
	return n
}

func (r *Room) handleSkipVote(m *member, env *protocol.Envelope) {
	// 投票不做 revision 检查：与 READY 同理，按 transitionId 绑定，避免并发投票互相拒绝
	if _, perr := protocol.DecodeSkipVote(env.Payload); perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	if r.transitionID == "" {
		r.sendError(m, protocol.CodeInvalidMessage, "没有正在播放的曲目", env.EventID)
		return
	}
	if r.skipTransition != r.transitionID {
		r.skipVotes = make(map[string]bool)
		r.skipTransition = r.transitionID
	}
	if r.skipVotes == nil {
		r.skipVotes = make(map[string]bool)
	}
	r.skipVotes[m.ID] = true
	passed := r.skipVotePassed()
	r.bump()
	r.broadcastSnapshot()
	if passed {
		r.logger.Info("skip vote passed", "roomId", r.cfg.ID, "transitionId", r.transitionID, "votes", len(r.skipVotes))
	}
}

// handleTrackFinished 由房主上报曲目结束方式（D-012）：
// played/skipped 记当前曲目历史；failed+trackId 移除队列条目（失败自动跳过）。
func (r *Room) handleTrackFinished(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodeTrackFinished(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	if p.TrackID != "" {
		// 指向队列条目的失败上报：移除该条目使房主可继续取下一首
		for i := range r.queue {
			if r.queue[i].Track.TrackID == p.TrackID {
				entry := r.queue[i]
				r.queue = append(r.queue[:i], r.queue[i+1:]...)
				r.appendHistory(protocol.HistoryEntry{Track: entry.Track, Outcome: p.Outcome, AtMs: r.now().UnixMilli(), RequestedByName: entry.RequestedByName})
				r.bump()
				r.broadcastSnapshot()
				return
			}
		}
		r.sendError(m, protocol.CodeInvalidMessage, "队列中没有该曲目", env.EventID)
		return
	}
	if r.currentTrack == nil {
		r.sendError(m, protocol.CodeInvalidMessage, "没有正在播放的曲目", env.EventID)
		return
	}
	entry := protocol.HistoryEntry{Track: *r.currentTrack, Outcome: p.Outcome, AtMs: r.now().UnixMilli()}
	if r.currentEntry != nil {
		entry.RequestedByName = r.currentEntry.RequestedByName
	}
	r.appendHistory(entry)
	r.bump()
	r.broadcastSnapshot()
}

func (r *Room) handlePlayMode(m *member, env *protocol.Envelope) {
	if err := r.checkWrite(m, env, RoleHost, RoleCoDJ); err != nil {
		r.sendError(m, err.Code, err.Message, env.EventID)
		return
	}
	p, perr := protocol.DecodePlayMode(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	r.playMode = p.Mode
	r.bump()
	r.broadcastSnapshot()
}

// ---- 聊天 ----

// handleChatMessage 转发聊天消息：不占 revision、不进快照，限流后补齐身份字段（D-013）。
func (r *Room) handleChatMessage(m *member, env *protocol.Envelope) {
	p, perr := protocol.DecodeChatMessage(env.Payload)
	if perr != nil {
		r.sendError(m, perr.Code, perr.Message, env.EventID)
		return
	}
	now := r.now()
	window := r.chatAt[m.ID]
	recent := window[:0]
	for _, t := range window {
		if now.Sub(t) < chatWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) >= chatRateMax {
		r.chatAt[m.ID] = recent
		r.sendError(m, protocol.CodeRateLimited, "发送太频繁，请稍后再试", env.EventID)
		return
	}
	r.chatAt[m.ID] = append(recent, now)

	entry := protocol.ChatEntry{
		MessageID: protocol.NewEventID(),
		MemberID:  m.ID,
		Name:      m.Name,
		Kind:      p.Kind,
		Text:      p.Text,
		SentAtMs:  now.UnixMilli(),
	}
	r.chat = append(r.chat, entry)
	if len(r.chat) > chatCap {
		r.chat = r.chat[len(r.chat)-chatCap:]
	}
	r.broadcast(protocol.TypeChatMessage, m.ID, protocol.MarshalPayload(entry))
}

// sendChatHistoryTo 在连接建立时单发最近聊天记录（D-013）；无聊天时不发送，避免空噪音。
func (r *Room) sendChatHistoryTo(c Conn) {
	if len(r.chat) == 0 {
		return
	}
	msgs := append([]protocol.ChatEntry{}, r.chat...)
	env := protocol.Envelope{
		V: protocol.ProtocolVersion, Type: protocol.TypeChatHistory,
		EventID: protocol.NewEventID(), RoomRevision: r.revision, SenderID: "relay",
		SentAtMs: r.now().UnixMilli(),
		Payload:  protocol.MarshalPayload(protocol.ChatHistoryPayload{Messages: msgs}),
	}
	_ = c.Send(env)
}

// ---- 内部工具 ----

func indexOfEntry(entries []protocol.QueueEntry, entryID string) int {
	for i := range entries {
		if entries[i].EntryID == entryID {
			return i
		}
	}
	return -1
}

// removeQueuedByTrackID 移除队列中首个匹配 trackId 的条目并返回它（无匹配返回 nil）。
func (r *Room) removeQueuedByTrackID(trackID string) *protocol.QueueEntry {
	for i := range r.queue {
		if r.queue[i].Track.TrackID == trackID {
			entry := r.queue[i]
			r.queue = append(r.queue[:i], r.queue[i+1:]...)
			return &entry
		}
	}
	return nil
}

func (r *Room) appendHistory(entry protocol.HistoryEntry) {
	r.history = append(r.history, entry)
	if len(r.history) > protocol.MaxHistoryLen {
		r.history = r.history[len(r.history)-protocol.MaxHistoryLen:]
	}
}

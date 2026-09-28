// lyrics_test.go：歌词发布权限、体积边界、缓存补发（D-017）。
package room

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"listogether/apps/relay/internal/protocol"
)

func publishLyrics(t *testing.T, r *Room, conn *fakeConn, memberID, trackID, format, text string) {
	t.Helper()
	r.HandleEnvelope(conn, envelope(t, memberID, protocol.TypeTrackLyrics, latestRevision(conn),
		protocol.TrackLyricsPayload{TrackID: trackID, Format: format, Lyrics: text}))
}

func TestLyricsHostOnly(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	listenerConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, listenerConn, listenerIdentity("m-2"))

	publishLyrics(t, r, listenerConn, "m-2", "t1", "lrc", "[00:01.00]x")
	errEnv := waitEnvelopeType(t, listenerConn, protocol.TypeError)
	if got := payloadCode(t, errEnv); got != protocol.CodeUnauthorized {
		t.Fatalf("listener 发布歌词应被拒, got %s", got)
	}

	// co_dj 也无权发布（歌词与曲库一致：仅 host）
	coDJConn := &fakeConn{}
	attachOK(t, r, coDJConn, Identity{MemberID: "dj-1", Name: "DJ", Role: RoleCoDJ})
	publishLyrics(t, r, coDJConn, "dj-1", "t1", "lrc", "[00:01.00]x")
	errEnv = waitEnvelopeType(t, coDJConn, protocol.TypeError)
	if got := payloadCode(t, errEnv); got != protocol.CodeUnauthorized {
		t.Fatalf("co_dj 发布歌词应被拒, got %s", got)
	}
}

func TestLyricsPublishAndForward(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	listenerConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, listenerConn, listenerIdentity("m-2"))

	publishLyrics(t, r, hostConn, "host-1", "t1", "lrc", "[00:12.00]第一句\n[00:18.50]第二句")
	env := waitEnvelopeType(t, listenerConn, protocol.TypeTrackLyrics)
	var p protocol.TrackLyricsPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.TrackID != "t1" || p.Format != "lrc" || !strings.Contains(p.Lyrics, "第二句") {
		t.Fatalf("unexpected lyrics payload: %+v", p)
	}
}

func TestLyricsTooLarge(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())

	big := strings.Repeat("[00:01.00]x\n", 200)
	publishLyrics(t, r, hostConn, "host-1", "t1", "plain", strings.Repeat(big, 60)) // 远超 48KB
	env := waitEnvelopeType(t, hostConn, protocol.TypeError)
	if got := payloadCode(t, env); got != protocol.CodeLyricsTooLarge {
		t.Fatalf("超限歌词应回 LYRICS_TOO_LARGE, got %s", got)
	}
}

func TestLyricsDeliveredOnTrackSwitch(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	listenerConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, listenerConn, listenerIdentity("m-2"))

	// 房主发布 t1 的歌词
	publishLyrics(t, r, hostConn, "host-1", "t1", "lrc", "[00:01.00]hello")

	// 切歌到 t1：屏障 → 成员 READY → 全员就绪自动开始 → 缓存歌词补发
	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, latestRevision(hostConn), protocol.NextTrackPreparePayload{
		TransitionID: "tr-lyr", Track: protocol.Track{TrackID: "t1", Title: "A", DurationMs: 180000},
		StartPositionMs: 0, PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)
	r.HandleEnvelope(listenerConn, envelope(t, "m-2", protocol.TypeReady, latestRevision(listenerConn), protocol.ReadyPayload{TransitionID: "tr-lyr"}))
	waitFor(t, func() bool {
		env := waitEnvelopeType(t, listenerConn, protocol.TypeTrackLyrics)
		return env != nil
	})
}

func TestLyricsDeliveredToLateMember(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	publishLyrics(t, r, hostConn, "host-1", "t1", "lrc", "[00:01.00]hello")

	// 直接在 actor 内置当前曲目（模拟播放中），新成员挂载后应补发歌词
	_ = r.Do(func() {
		track := protocol.Track{TrackID: "t1", Title: "A", DurationMs: 180000}
		r.currentTrack = &track
	})

	lateConn := &fakeConn{}
	attachOK(t, r, lateConn, listenerIdentity("m-late"))
	env := waitEnvelopeType(t, lateConn, protocol.TypeTrackLyrics)
	var p protocol.TrackLyricsPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.TrackID != "t1" {
		t.Fatalf("新成员应收到当前曲目歌词, got %+v", p)
	}
}

func TestLyricsCacheEviction(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())

	// 发布 maxLyricsEntries+10 条，缓存应保持上限内
	for i := 0; i < maxLyricsEntries+10; i++ {
		publishLyrics(t, r, hostConn, "host-1", "track-"+itoaForTest(i), "plain", "x")
	}
	if len(r.lyrics) > maxLyricsEntries {
		t.Fatalf("缓存应不超过 %d, got %d", maxLyricsEntries, len(r.lyrics))
	}
}

func itoaForTest(i int) string {
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

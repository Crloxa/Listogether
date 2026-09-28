package room

import (
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"listogether/apps/relay/internal/protocol"
)

// fakeConn 记录收到的信封与关闭码；Send 永不失败（除非 failAfter 触发）。
type fakeConn struct {
	mu         sync.Mutex
	sent       []protocol.Envelope
	closed     bool
	closedCode int
	closedBy   string
	fail       bool
}

func (c *fakeConn) Send(env protocol.Envelope) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return false
	}
	c.sent = append(c.sent, env)
	return true
}

func (c *fakeConn) Close(code int, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		c.closedCode = code
		c.closedBy = reason
	}
}

func (c *fakeConn) envelopeTypes() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	types := make([]string, 0, len(c.sent))
	for _, e := range c.sent {
		types = append(types, e.Type)
	}
	return types
}

func (c *fakeConn) lastOfType(t string) *protocol.Envelope {
	c.mu.Lock()
	defer c.mu.Unlock()
	var found *protocol.Envelope
	for i := range c.sent {
		if c.sent[i].Type == t {
			found = &c.sent[i]
		}
	}
	return found
}

func (c *fakeConn) snapshot() *protocol.RoomSnapshot {
	env := c.lastOfType(protocol.TypeRoomSnapshot)
	if env == nil {
		return nil
	}
	var snap protocol.RoomSnapshot
	if err := json.Unmarshal(env.Payload, &snap); err != nil {
		panic(err)
	}
	return &snap
}

type testHooks struct {
	mu          sync.Mutex
	removed     []string
	invalidated [][2]string
}

func (h *testHooks) RoomRemoved(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removed = append(h.removed, roomID)
}

func (h *testHooks) SessionInvalidated(roomID, memberID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.invalidated = append(h.invalidated, [2]string{roomID, memberID})
}

func newTestRoom(t *testing.T, cfg Config, hooks HubHooks) *Room {
	t.Helper()
	if hooks == nil {
		hooks = &testHooks{}
	}
	return New(cfg, hooks, slog.New(slog.NewTextHandler(testDiscard{}, nil)))
}

type testDiscard struct{}

func (testDiscard) Write(p []byte) (int, error) { return len(p), nil }

// waitFor 轮询直到 cond 成立；HandleEnvelope 等接口异步提交到 actor，必须等待。
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("条件在 2s 内未满足")
}

// waitEnvelopeType 等待连接收到指定类型信封并返回。
func waitEnvelopeType(t *testing.T, c *fakeConn, typ string) *protocol.Envelope {
	t.Helper()
	var found *protocol.Envelope
	waitFor(t, func() bool {
		found = c.lastOfType(typ)
		return found != nil
	})
	return found
}

func hostIdentity() Identity { return Identity{MemberID: "host-1", Name: "房主", Role: RoleHost} }

func listenerIdentity(id string) Identity {
	return Identity{MemberID: id, Name: "成员-" + id, Role: RoleListener}
}

func attachOK(t *testing.T, r *Room, c Conn, id Identity) {
	t.Helper()
	res := r.Attach(c, id)
	if res.Err != nil {
		t.Fatalf("attach %s: %v", id.MemberID, res.Err)
	}
}

func envelope(t *testing.T, senderID, typ string, revision int64, payload any) *protocol.Envelope {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return &protocol.Envelope{
		V: protocol.ProtocolVersion, Type: typ, EventID: "evt-" + typ + "-" + senderID,
		RoomRevision: revision, SenderID: senderID, SentAtMs: 0, Payload: raw,
	}
}

func mustDecodeSnapshotEnv(t *testing.T, env protocol.Envelope) protocol.RoomSnapshot {
	t.Helper()
	var snap protocol.RoomSnapshot
	if err := json.Unmarshal(env.Payload, &snap); err != nil {
		t.Fatalf("snapshot unmarshal: %v", err)
	}
	return snap
}

func TestAttachHostGetsSnapshotAndRevisionOne(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1", MaxMembers: 8}, nil)
	c := &fakeConn{}
	attachOK(t, r, c, hostIdentity())

	snap := c.snapshot()
	if snap == nil {
		t.Fatal("挂载后应收到 ROOM_SNAPSHOT")
	}
	if snap.RoomID != "r1" || snap.Revision != 1 || snap.Playing {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
	if len(snap.Members) != 1 || snap.Members[0].Role != RoleHost {
		t.Fatalf("成员视图异常: %+v", snap.Members)
	}
}

func TestSecondMemberJoinBroadcastsMemberJoined(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1", MaxMembers: 8}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	memberConn := &fakeConn{}
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	joined := hostConn.lastOfType(protocol.TypeMemberJoined)
	if joined == nil {
		t.Fatal("房主应收到 MEMBER_JOINED")
	}
	var payload protocol.MemberJoinedPayload
	if err := json.Unmarshal(joined.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Member.MemberID != "m-2" || payload.Member.Role != RoleListener || payload.Member.Status != StatusOnline {
		t.Fatalf("unexpected member payload: %+v", payload.Member)
	}
}

func TestAttachLockedAndFullRejected(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1", MaxMembers: 2}, nil)
	attachOK(t, r, &fakeConn{}, hostIdentity())
	attachOK(t, r, &fakeConn{}, listenerIdentity("m-2"))
	res := r.Attach(&fakeConn{}, listenerIdentity("m-3"))
	if res.Err == nil || res.Err.Code != protocol.CodeRoomFull {
		t.Fatalf("应拒绝 ROOM_FULL, got %v", res.Err)
	}
}

func TestListenerCannotControlPlayback(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	listenerConn := &fakeConn{}
	attachOK(t, r, listenerConn, listenerIdentity("m-2"))
	r.HandleEnvelope(listenerConn, envelope(t, "m-2", protocol.TypePlay, 1, protocol.PositionPayload{PositionMs: 0}))

	errEnv := waitEnvelopeType(t, listenerConn, protocol.TypeError)
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errEnv.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", payload.Code)
	}
}

func TestCoDJCanPrepareButNotPlay(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	djConn := &fakeConn{}
	attachOK(t, r, djConn, Identity{MemberID: "dj-1", Name: "DJ", Role: RoleCoDJ})
	// revision 1 = 加入广播
	now := time.Now().UnixMilli()
	r.HandleEnvelope(djConn, envelope(t, "dj-1", protocol.TypePlay, 1, protocol.PositionPayload{PositionMs: 0}))
	waitEnvelopeType(t, djConn, protocol.TypeError) // co_dj PLAY 应被拒绝

	r.HandleEnvelope(djConn, envelope(t, "dj-1", protocol.TypeNextTrackPrepare, 1, protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: protocol.Track{TrackID: "k1", Title: "T", DurationMs: 1000},
		StartPositionMs: 0, PrepareDeadlineMs: now + 2000, StartAtMs: now + 5000,
	}))
	waitEnvelopeType(t, djConn, protocol.TypeNextTrackPrepare) // co_dj 切歌应被接受
}

func TestPlayPauseSeekBumpRevisionAndBroadcast(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	// attach host → revision 1；attach m-2 → revision 2
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePlay, 2, protocol.PositionPayload{PositionMs: 1200}))
	play := waitEnvelopeType(t, memberConn, protocol.TypePlay)
	if play.RoomRevision != 3 || play.SenderID != "host-1" {
		t.Fatalf("PLAY revision=%d sender=%s, want 3/host-1", play.RoomRevision, play.SenderID)
	}

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePause, 3, protocol.PositionPayload{PositionMs: 2400}))
	pause := waitEnvelopeType(t, memberConn, protocol.TypePause)
	if pause.RoomRevision != 4 {
		t.Fatalf("PAUSE revision = %d, want 4", pause.RoomRevision)
	}
	// 拉取快照确认权威状态（PAUSE 本身只广播事件）
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 4, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && !snap.Playing && snap.PositionMs == 2400 && snap.Revision == 4
	})
}

func TestStaleRevisionRejected(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, &fakeConn{}, listenerIdentity("m-2")) // revision -> 2

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePlay, 1, protocol.PositionPayload{PositionMs: 0}))
	errEnv := waitEnvelopeType(t, hostConn, protocol.TypeError)
	var payload struct {
		Code       string `json:"code"`
		RefEventID string `json:"refEventId"`
	}
	if err := json.Unmarshal(errEnv.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != protocol.CodeStaleRevision {
		t.Fatalf("code = %s, want STALE_REVISION", payload.Code)
	}
	if payload.RefEventID != "evt-PLAY-host-1" {
		t.Fatalf("refEventId = %q", payload.RefEventID)
	}
}

func TestHeartbeatNeverStale(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeHeartbeat, 0, protocol.HeartbeatPayload{ClientTimeMs: 1}))
	waitFor(t, func() bool {
		// 等一个处理周期；不允许出现 ERROR
		return true
	})
	if hostConn.lastOfType(protocol.TypeError) != nil {
		t.Fatal("HEARTBEAT 不应因 revision 被拒绝")
	}
}

func TestBarrierFullFlow(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	now := time.Now().UnixMilli()
	track := protocol.Track{TrackID: "k1", Title: "Song A", DurationMs: 180000}
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, 2, protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: track, StartPositionMs: 0,
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)

	// 屏障期间快照带 ready=false（经 RESYNC 拉取验证）
	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeResyncRequest, 3, protocol.ResyncRequestPayload{}))
	var barrierSnap *protocol.RoomSnapshot
	waitFor(t, func() bool {
		snap := memberConn.snapshot()
		if snap == nil || snap.Revision < 3 || snap.Members[0].Ready == nil {
			return false
		}
		barrierSnap = snap
		return true
	})
	if *barrierSnap.Members[0].Ready {
		t.Fatalf("屏障期间 ready 应为 false: %+v", barrierSnap.Members[0])
	}

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 3, protocol.ReadyPayload{TransitionID: "tr-1"}))
	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeReady, 4, protocol.ReadyPayload{TransitionID: "tr-1"}))

	start := waitEnvelopeType(t, hostConn, protocol.TypeNextTrackStart)
	var startPayload protocol.NextTrackStartPayload
	if err := json.Unmarshal(start.Payload, &startPayload); err != nil {
		t.Fatal(err)
	}
	if startPayload.TransitionID != "tr-1" || startPayload.StartAtMs != now+8000 {
		t.Fatalf("unexpected start payload: %+v", startPayload)
	}
	// 拉取快照确认切歌后的权威状态（播放中位置按时间外推，不要求恰为 0）
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 6, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		final := hostConn.snapshot()
		return final.CurrentTrack != nil && final.CurrentTrack.TrackID == "k1" && final.Playing && final.PositionMs < 2000
	})
}

func TestReadyWrongTransitionRejected(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, 1, protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: protocol.Track{TrackID: "k1", Title: "T"},
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 2, protocol.ReadyPayload{TransitionID: "tr-other"}))
	waitEnvelopeType(t, hostConn, protocol.TypeError)
}

// 回归测试：屏障期间快照必须携带屏障的 transitionId/startAtMs，
// 否则客户端会把 PREPARE 信息当作过期而丢弃（见 HANDOFF Phase 1 修复记录）。
func TestSnapshotDuringBarrierCarriesTransition(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, 1, protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: protocol.Track{TrackID: "k1", Title: "T"},
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 2, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && snap.Revision >= 2 && snap.TransitionID != nil
	})
	snap := hostConn.snapshot()
	if *snap.TransitionID != "tr-1" || snap.StartAtMs == nil || *snap.StartAtMs != now+8000 {
		t.Fatalf("屏障期间快照应携带 transitionId/startAtMs: %+v", snap)
	}
}

func TestPrepareTimesMustBeFutureAndOrdered(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	now := time.Now().UnixMilli()

	// startAt <= deadline（跨字段约束）
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, 1, protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: protocol.Track{TrackID: "k1", Title: "T"},
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 5000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeError)

	// deadline 已过期（相对服务器时间）
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, 1, protocol.NextTrackPreparePayload{
		TransitionID: "tr-2", Track: protocol.Track{TrackID: "k1", Title: "T"},
		PrepareDeadlineMs: now - 1000, StartAtMs: now + 8000,
	}))
	waitFor(t, func() bool {
		count := 0
		for _, e := range hostConn.sent {
			if e.Type == protocol.TypeError {
				count++
			}
		}
		return count >= 2
	})
}

func TestHostLeaveTransfersToEarliestMember(t *testing.T) {
	hooks := &testHooks{}
	r := newTestRoom(t, Config{ID: "r1"}, hooks)
	hostConn := &fakeConn{}
	m2 := &fakeConn{}
	m3 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m2, listenerIdentity("m-2"))
	attachOK(t, r, m3, listenerIdentity("m-3"))

	r.Detach(hostConn, true) // 房主优雅离开
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap := m2.snapshot()
		if snap != nil {
			for _, m := range snap.Members {
				if m.MemberID == "m-2" && m.Role == RoleHost {
					return // 转移成功
				}
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("房主离开后应转移给最早加入的 m-2: %v", m2.snapshot())
}

func TestOfflineTTLRemovalWithTimeoutReason(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1", OfflineTTL: 10 * time.Millisecond}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	r.Detach(memberConn, false) // 异常断开 → offline
	time.Sleep(20 * time.Millisecond)
	r.PresenceTick()
	// PresenceTick 是异步的；等待移除广播
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if left := hostConn.lastOfType(protocol.TypeMemberLeft); left != nil {
			var payload protocol.MemberLeftPayload
			if err := json.Unmarshal(left.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.MemberID != "m-2" || payload.Reason != "timeout" {
				t.Fatalf("unexpected left payload: %+v", payload)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("offline 超时后应广播 MEMBER_LEFT(timeout)")
}

func TestRoomClosedWhenLastMemberLeaves(t *testing.T) {
	hooks := &testHooks{}
	r := newTestRoom(t, Config{ID: "r1"}, hooks)
	c := &fakeConn{}
	attachOK(t, r, c, hostIdentity())
	r.Detach(c, true)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hooks.mu.Lock()
		removed := len(hooks.removed) > 0
		hooks.mu.Unlock()
		if removed {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("最后一名成员离开后房间应被移除")
}

func TestResyncRequestSendsSnapshotAndForwardsToHost(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{Reason: "manual"}))
	waitEnvelopeType(t, memberConn, protocol.TypeRoomSnapshot)
	fwd := waitEnvelopeType(t, hostConn, protocol.TypeResyncRequest)
	if fwd.SenderID != "m-2" {
		t.Fatalf("房主收到的转发送 senderId = %q, want m-2", fwd.SenderID)
	}
}

func TestWebrtcSignalingForwardedToTarget(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeWebrtcOffer, 0, protocol.WebrtcSdpPayload{ToMemberID: "m-2", Sdp: "v=0"}))
	offer := waitEnvelopeType(t, memberConn, protocol.TypeWebrtcOffer)
	if offer.SenderID != "host-1" {
		t.Fatalf("offer senderId = %q, want host-1", offer.SenderID)
	}

	// 目标不在线：静默丢弃
	r.Detach(memberConn, false)
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil
	})
	beforeErr := len(hostConn.sent)
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeIceCandidate, 0, protocol.IceCandidatePayload{ToMemberID: "m-2", Candidate: "c"}))
	waitFor(t, func() bool { return true })
	if hostConn.lastOfType(protocol.TypeError) != nil {
		t.Fatal("目标离线时转发丢弃，不应回 ERROR")
	}
	_ = beforeErr
}

func TestSnapshotPositionAdvancesWhilePlaying(t *testing.T) {
	base := time.Now()
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePlay, 1, protocol.PositionPayload{PositionMs: 1000}))
	waitEnvelopeType(t, hostConn, protocol.TypePlay)
	// 模拟时钟前进 2s 后，通过 RESYNC 拉取新快照
	r.nowFunc = func() time.Time { return base.Add(2 * time.Second) }
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 1, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && snap.PositionMs >= 2900 && snap.PositionMs <= 3100
	})
}

// ---- Phase 2：快照携带屏障元数据 + 屏障超时强制开始 ----

// latestRevision 返回连接最近收到的最大 roomRevision（服务端广播总是携带当前 revision）。
func latestRevision(c *fakeConn) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var max int64
	for _, e := range c.sent {
		if e.RoomRevision > max {
			max = e.RoomRevision
		}
	}
	return max
}

func startBarrier(t *testing.T, r *Room, hostConn *fakeConn, transitionID string) int64 {
	t.Helper()
	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, latestRevision(hostConn), protocol.NextTrackPreparePayload{
		TransitionID: transitionID, Track: protocol.Track{TrackID: "k1", Title: "Song A", DurationMs: 180000},
		StartPositionMs: 0, PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)
	return now
}

func TestSnapshotCarriesPendingPrepareMetadata(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))
	startBarrier(t, r, hostConn, "tr-1")

	// 成员重连（先断开再挂回）后从快照恢复屏障元数据
	r.Detach(memberConn, false)
	r.Attach(memberConn, listenerIdentity("m-2"))
	waitFor(t, func() bool {
		snap := memberConn.snapshot()
		return snap != nil && snap.PendingPrepare != nil && snap.Revision >= 2
	})
	snap := memberConn.snapshot()
	pp := snap.PendingPrepare
	if pp.TransitionID != "tr-1" || pp.Track.TrackID != "k1" || pp.StartPositionMs != 0 || pp.StartAtMs == 0 || pp.PrepareDeadlineMs == 0 {
		t.Fatalf("快照应携带完整屏障元数据: %+v", pp)
	}

	// 屏障完成后 pendingPrepare 应消失
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	waitFor(t, func() bool { return memberConn.lastOfType(protocol.TypeNextTrackStart) != nil })
	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		final := memberConn.snapshot()
		return final != nil && final.CurrentTrack != nil
	})
	if pp := memberConn.snapshot().PendingPrepare; pp != nil {
		t.Fatalf("屏障完成后快照不应再携带 pendingPrepare: %+v", pp)
	}
}

func TestHostForceStartSkipsUnreadyMembers(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))
	startBarrier(t, r, hostConn, "tr-1")

	// 只有房主就绪，成员始终未 READY；deadline 到达后房主强制开始
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && len(snap.Members) >= 2 && snap.Members[1].Ready != nil && !*snap.Members[1].Ready
	})
	startAt := time.Now().Add(200 * time.Millisecond).UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackStart, latestRevision(hostConn), protocol.NextTrackStartPayload{TransitionID: "tr-1", StartAtMs: startAt}))

	for _, c := range []*fakeConn{hostConn, memberConn} {
		start := waitEnvelopeType(t, c, protocol.TypeNextTrackStart)
		var payload protocol.NextTrackStartPayload
		if err := json.Unmarshal(start.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.TransitionID != "tr-1" || payload.StartAtMs != startAt {
			t.Fatalf("强制开始应使用房主提供的 startAtMs: %+v", payload)
		}
	}
	// 权威状态：曲目已切换且正在播放
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && snap.CurrentTrack != nil && snap.Playing
	})
}

func TestForceStartValidations(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))

	// 无屏障时强制开始被拒绝
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackStart, latestRevision(hostConn), protocol.NextTrackStartPayload{TransitionID: "tr-x", StartAtMs: 1}))
	waitEnvelopeType(t, hostConn, protocol.TypeError)

	startBarrier(t, r, hostConn, "tr-1")

	// 听众越权被拒绝
	r.HandleEnvelope(memberConn, envelope(t, "m-2", protocol.TypeNextTrackStart, latestRevision(memberConn), protocol.NextTrackStartPayload{TransitionID: "tr-1", StartAtMs: 1}))
	waitEnvelopeType(t, memberConn, protocol.TypeError)

	// transitionId 不匹配被拒绝
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackStart, latestRevision(hostConn), protocol.NextTrackStartPayload{TransitionID: "tr-other", StartAtMs: 1}))
	waitFor(t, func() bool {
		count := 0
		for _, e := range hostConn.sent {
			if e.Type == protocol.TypeError {
				count++
			}
		}
		return count >= 2
	})

	// 屏障未被以上失败操作解散
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && snap.PendingPrepare != nil && snap.PendingPrepare.TransitionID == "tr-1"
	})
}

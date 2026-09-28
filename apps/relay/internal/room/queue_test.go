package room

import (
	"encoding/json"
	"testing"
	"time"

	"listogether/apps/relay/internal/protocol"
)

// ---- 测试工具 ----

func addLibrary(t *testing.T, r *Room, hostConn *fakeConn, tracks ...protocol.Track) {
	t.Helper()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeLibraryAdd, latestRevision(hostConn), protocol.LibraryAddPayload{Tracks: tracks}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return snap != nil && len(snap.Library) >= len(tracks)
	})
}

// requestTrack 发送点歌请求并等待其在待审批区或队列中可见（同时保证后续请求拿到新 revision）。
func requestTrack(t *testing.T, r *Room, conn *fakeConn, memberID, trackID string) {
	t.Helper()
	r.HandleEnvelope(conn, envelope(t, memberID, protocol.TypeQueueRequest, latestRevision(conn), protocol.QueueRequestPayload{TrackID: trackID}))
	waitFor(t, func() bool {
		snap := conn.snapshot()
		if snap == nil {
			return false
		}
		for _, e := range append(append([]protocol.QueueEntry{}, snap.PendingRequests...), snap.Queue...) {
			if e.Track.TrackID == trackID {
				return true
			}
		}
		return false
	})
}

// requestTrackExpectError 发送预期被拒的点歌请求（调用方需已通过 waitFor 保证 conn 的 revision 新鲜）。
func requestTrackExpectError(t *testing.T, r *Room, conn *fakeConn, memberID, trackID, wantCode string) {
	t.Helper()
	r.HandleEnvelope(conn, envelope(t, memberID, protocol.TypeQueueRequest, latestRevision(conn), protocol.QueueRequestPayload{TrackID: trackID}))
	if got := payloadCode(t, waitEnvelopeType(t, conn, protocol.TypeError)); got != wantCode {
		t.Fatalf("code = %s, want %s", got, wantCode)
	}
}

func testTrack(id, title string) protocol.Track {
	return protocol.Track{TrackID: id, Title: title, DurationMs: 180000}
}

func pendingEntries(snap *protocol.RoomSnapshot) []protocol.QueueEntry {
	if snap == nil {
		return nil
	}
	return snap.PendingRequests
}

// ---- 曲库 ----

func TestLibraryAddHostOnly(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	listenerConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, listenerConn, listenerIdentity("m-2"))

	// listener 越权被拒绝
	r.HandleEnvelope(listenerConn, envelope(t, "m-2", protocol.TypeLibraryAdd, latestRevision(listenerConn), protocol.LibraryAddPayload{Tracks: []protocol.Track{testTrack("k1", "A")}}))
	errEnv := waitEnvelopeType(t, listenerConn, protocol.TypeError)
	if got := payloadCode(t, errEnv); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}

	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"))
	snap := listenerConn.snapshot()
	if len(snap.Library) != 2 {
		t.Fatalf("快照应携带曲库: %+v", snap.Library)
	}
	if snap.Library[0].AddedBy != "host-1" {
		t.Fatalf("曲库条目应记录 addedBy: %+v", snap.Library[0])
	}

	// 重复导入按 trackId 幂等
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeLibraryAdd, latestRevision(hostConn), protocol.LibraryAddPayload{Tracks: []protocol.Track{testTrack("k1", "A")}}))
	waitFor(t, func() bool { return true })
	if n := listenerConn.snapshot().Library; len(n) != 2 {
		t.Fatalf("重复导入不应新增条目: %+v", n)
	}
}

func TestLibraryRemoveHostOnly(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	djConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, djConn, Identity{MemberID: "dj-1", Name: "DJ", Role: RoleCoDJ})
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	// 共同 DJ 无权删曲库
	r.HandleEnvelope(djConn, envelope(t, "dj-1", protocol.TypeLibraryRemove, latestRevision(djConn), protocol.LibraryRemovePayload{TrackID: "k1"}))
	if got := payloadCode(t, waitEnvelopeType(t, djConn, protocol.TypeError)); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeLibraryRemove, latestRevision(hostConn), protocol.LibraryRemovePayload{TrackID: "k1"}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Library) == 0 })

	// 移除不存在的曲目报错
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeLibraryRemove, latestRevision(hostConn), protocol.LibraryRemovePayload{TrackID: "k1"}))
	if got := payloadCode(t, waitEnvelopeType(t, hostConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

// ---- 点歌与审批 ----

func TestQueueRequestListenerNeedsApproval(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	memberConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, memberConn, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	// 曲库外的曲目拒绝
	requestTrackExpectError(t, r, memberConn, "m-2", "k9", protocol.CodeInvalidMessage)

	requestTrack(t, r, memberConn, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(memberConn.snapshot())) == 1 })
	pending := pendingEntries(memberConn.snapshot())[0]
	if pending.RequestedBy != "m-2" || pending.RequestedByName != "成员-m-2" {
		t.Fatalf("点歌人标记缺失: %+v", pending)
	}
	if len(memberConn.snapshot().Queue) != 0 {
		t.Fatal("listener 点歌应进入待审批区，不直接入队")
	}

	// 审批通过入队尾
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueApprove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: pending.EntryID}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })
	if n := len(memberConn.snapshot().PendingRequests); n != 0 {
		t.Fatalf("审批后待审批区应清空: %d", n)
	}
}

func TestDJRequestBypassesApproval(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	djConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, djConn, Identity{MemberID: "dj-1", Name: "DJ", Role: RoleCoDJ})
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	requestTrack(t, r, djConn, "dj-1", "k1")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })
	if n := len(hostConn.snapshot().PendingRequests); n != 0 {
		t.Fatalf("co_dj 点歌应免审批: %d", n)
	}
}

func TestQueueRequestDuplicateRejected(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	m2 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	attachOK(t, r, m2, listenerIdentity("m-3"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	requestTrack(t, r, m1, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 1 })

	// 不同成员重复点同一首 → DUPLICATE_TRACK（此刻 m2 已收到待审批广播，revision 新鲜）
	requestTrackExpectError(t, r, m2, "m-3", "k1", protocol.CodeDuplicateTrack)
}

func TestListenerRequestCooldownAndQuota(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"), testTrack("k3", "C"))

	// 冷却：第二条请求在 30s 内被限流
	requestTrack(t, r, m1, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 1 })
	requestTrackExpectError(t, r, m1, "m-2", "k2", protocol.CodeRateLimited)

	// 时间前进 31s：冷却结束，配额 2 生效（k1 仍在待审批区占 1 个配额）
	r.nowFunc = func() time.Time { return time.Now().Add(31 * time.Second) }
	requestTrack(t, r, m1, "m-2", "k2")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 2 })
	entries := pendingEntries(m1.snapshot())
	var k2Entry string
	for _, e := range entries {
		if e.Track.TrackID == "k2" {
			k2Entry = e.EntryID
		}
	}
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueApprove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: k2Entry}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })

	// 配额：pending(k1) + queue(k2) = 2 → 第 3 首被限流
	requestTrackExpectError(t, r, m1, "m-2", "k3", protocol.CodeRateLimited)
}

func TestQueueApproveRejectAndHistory(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"))
	r.nowFunc = func() time.Time { return time.Now().Add(60 * time.Second) } // 越过冷却

	requestTrack(t, r, m1, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 1 })
	entryID := pendingEntries(m1.snapshot())[0].EntryID

	// 拒绝 → 历史 rejected
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueReject, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: entryID}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return len(snap.PendingRequests) == 0 && len(snap.History) == 1
	})
	if h := hostConn.snapshot().History[0]; h.Outcome != "rejected" || h.RequestedByName != "成员-m-2" {
		t.Fatalf("拒绝历史异常: %+v", h)
	}

	// 再次点歌并批准
	r.nowFunc = func() time.Time { return time.Now().Add(120 * time.Second) }
	requestTrack(t, r, m1, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 1 })
	entryID = pendingEntries(m1.snapshot())[0].EntryID
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueApprove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: entryID}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })

	// 审批不存在的条目报错
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueApprove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: "nope"}))
	if got := payloadCode(t, waitEnvelopeType(t, hostConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

func TestQueueRemovePermissions(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	m2 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	attachOK(t, r, m2, listenerIdentity("m-3"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"))

	// 两名成员各点一首（冷却期内不同成员互不影响）
	requestTrack(t, r, m1, "m-2", "k1")
	requestTrack(t, r, m2, "m-3", "k2")
	waitFor(t, func() bool { return len(pendingEntries(hostConn.snapshot())) == 2 })
	entries := pendingEntries(hostConn.snapshot())
	var mine, otherID string
	for _, e := range entries {
		if e.RequestedBy == "m-2" {
			mine = e.EntryID
		} else {
			otherID = e.EntryID
		}
	}

	// listener 不能撤销别人的条目
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeQueueRemove, latestRevision(m1), protocol.QueueEntryIDPayload{EntryID: otherID}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}
	// listener 可以撤销自己的
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeQueueRemove, latestRevision(m1), protocol.QueueEntryIDPayload{EntryID: mine}))
	waitFor(t, func() bool { return len(pendingEntries(hostConn.snapshot())) == 1 })
	// host 可以移除任意条目
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueRemove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: otherID}))
	waitFor(t, func() bool { return len(pendingEntries(hostConn.snapshot())) == 0 })
}

func TestQueueReorderRequiresSameSet(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	djConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, djConn, Identity{MemberID: "dj-1", Name: "DJ", Role: RoleCoDJ})
	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"))

	requestTrack(t, r, hostConn, "host-1", "k1")
	requestTrack(t, r, hostConn, "host-1", "k2")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 2 })
	queue := hostConn.snapshot().Queue
	if queue[0].Track.TrackID != "k1" || queue[1].Track.TrackID != "k2" {
		t.Fatalf("初始顺序异常: %+v", queue)
	}

	// 缺少条目的重排被拒绝
	r.HandleEnvelope(djConn, envelope(t, "dj-1", protocol.TypeQueueReorder, latestRevision(djConn), protocol.QueueReorderPayload{EntryIDs: []string{queue[0].EntryID}}))
	if got := payloadCode(t, waitEnvelopeType(t, djConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}

	// co_dj 可重排
	r.HandleEnvelope(djConn, envelope(t, "dj-1", protocol.TypeQueueReorder, latestRevision(djConn), protocol.QueueReorderPayload{EntryIDs: []string{queue[1].EntryID, queue[0].EntryID}}))
	waitFor(t, func() bool {
		q := hostConn.snapshot().Queue
		return len(q) == 2 && q[0].Track.TrackID == "k2" && q[1].Track.TrackID == "k1"
	})
}

func TestQueueClearHostAndDJOnly(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	requestTrack(t, r, hostConn, "host-1", "k1")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })

	// listener 无权清空
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeQueueClear, latestRevision(m1), protocol.QueueClearPayload{}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueClear, latestRevision(hostConn), protocol.QueueClearPayload{}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 0 })
}

// ---- 投票跳过 ----

func TestSkipVoteRequiresPlayingTrack(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	m1 := &fakeConn{}
	attachOK(t, r, m1, listenerIdentity("m-2"))
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeSkipVote, 0, protocol.SkipVotePayload{}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

func TestSkipVotePassesAtMajority(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	m2 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	attachOK(t, r, m2, listenerIdentity("m-3"))
	// 播放第一首
	startBarrier(t, r, hostConn, "tr-1")
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	r.HandleEnvelope(m2, envelope(t, "m-3", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	waitFor(t, func() bool { return hostConn.lastOfType(protocol.TypeNextTrackStart) != nil })

	// 3 人在线需要 2 票；第一票不通过
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeSkipVote, 0, protocol.SkipVotePayload{}))
	waitFor(t, func() bool {
		sv := m1.snapshot().SkipVotes
		return sv != nil && len(sv.MemberIDs) == 1
	})
	if m1.snapshot().SkipVotes.Passed {
		t.Fatal("1/3 票不应通过")
	}

	// 第二票通过；重复投票幂等
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeSkipVote, 0, protocol.SkipVotePayload{}))
	r.HandleEnvelope(m2, envelope(t, "m-3", protocol.TypeSkipVote, 0, protocol.SkipVotePayload{}))
	waitFor(t, func() bool {
		sv := m1.snapshot().SkipVotes
		return sv != nil && sv.Passed
	})
	if n := len(m1.snapshot().SkipVotes.MemberIDs); n != 2 {
		t.Fatalf("重复投票应幂等: %d", n)
	}

	// 切歌后投票清零（屏障完成只广播 NEXT_TRACK_START，快照经 RESYNC 拉取）
	startBarrier(t, r, hostConn, "tr-2")
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-2"}))
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-2"}))
	r.HandleEnvelope(m2, envelope(t, "m-3", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-2"}))
	waitFor(t, func() bool { return hostConn.lastOfType(protocol.TypeNextTrackStart) != nil })
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool { return m1.snapshot().SkipVotes == nil })
}

// ---- 曲目历史与失败跳过 ----

func TestTrackFinishedHostOnlyAndHistory(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"))

	// listener 越权
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeTrackFinished, latestRevision(m1), protocol.TrackFinishedPayload{Outcome: "played"}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}

	// 无播放中曲目
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeTrackFinished, latestRevision(hostConn), protocol.TrackFinishedPayload{Outcome: "played"}))
	if got := payloadCode(t, waitEnvelopeType(t, hostConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}

	// 播放队列曲目 → finishBarrier 移除队列条目 → played 历史
	requestTrack(t, r, hostConn, "host-1", "k1")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })
	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, latestRevision(hostConn), protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: testTrack("k1", "A"), StartPositionMs: 0,
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	waitFor(t, func() bool { return hostConn.lastOfType(protocol.TypeNextTrackStart) != nil })
	// 屏障完成只广播 NEXT_TRACK_START；队列状态经 RESYNC 拉取
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 0 })

	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeTrackFinished, latestRevision(hostConn), protocol.TrackFinishedPayload{Outcome: "played"}))
	waitFor(t, func() bool { return len(hostConn.snapshot().History) == 1 })
	if h := hostConn.snapshot().History[0]; h.Outcome != "played" || h.Track.TrackID != "k1" {
		t.Fatalf("历史异常: %+v", h)
	}
}

func TestTrackFinishedFailedRemovesQueueEntry(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))
	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"))

	// m1 点 k1 → 待审批 → 房主批准入队
	requestTrack(t, r, m1, "m-2", "k1")
	waitFor(t, func() bool { return len(pendingEntries(m1.snapshot())) == 1 })
	pending := pendingEntries(m1.snapshot())[0]
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeQueueApprove, latestRevision(hostConn), protocol.QueueEntryIDPayload{EntryID: pending.EntryID}))
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 1 })

	// 房主把 k2 直接加入队列
	r.nowFunc = func() time.Time { return time.Now().Add(60 * time.Second) }
	requestTrack(t, r, hostConn, "host-1", "k2")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 2 })

	// 下一首文件缺失：failed + trackId 移除该条目（失败自动跳过）
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeTrackFinished, latestRevision(hostConn), protocol.TrackFinishedPayload{Outcome: "failed", TrackID: "k1"}))
	waitFor(t, func() bool {
		snap := hostConn.snapshot()
		return len(snap.Queue) == 1 && snap.Queue[0].Track.TrackID == "k2" && len(snap.History) == 1
	})
	if h := hostConn.snapshot().History[0]; h.Outcome != "failed" || h.RequestedByName != "成员-m-2" {
		t.Fatalf("失败历史异常: %+v", h)
	}

	// 未知 trackId 报错
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeTrackFinished, latestRevision(hostConn), protocol.TrackFinishedPayload{Outcome: "failed", TrackID: "k9"}))
	if got := payloadCode(t, waitEnvelopeType(t, hostConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

// ---- 播放模式 ----

func TestPlayModeHostAndDJOnly(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))

	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypePlayMode, latestRevision(m1), protocol.PlayModePayload{Mode: "shuffle"}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeUnauthorized {
		t.Fatalf("code = %s, want UNAUTHORIZED", got)
	}
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePlayMode, latestRevision(hostConn), protocol.PlayModePayload{Mode: "shuffle"}))
	waitFor(t, func() bool { return hostConn.snapshot().PlayMode == "shuffle" })

	// 非法模式拒绝
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypePlayMode, latestRevision(hostConn), protocol.PlayModePayload{Mode: "crazy"}))
	if got := payloadCode(t, waitEnvelopeType(t, hostConn, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

// ---- 聊天 ----

func payloadCode(t *testing.T, env *protocol.Envelope) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Code
}

func TestChatBroadcastAndHistory(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	m1 := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	attachOK(t, r, m1, listenerIdentity("m-2"))

	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeChatMessage, 0, protocol.ChatMessagePayload{Kind: "text", Text: "大家好"}))
	chat := waitEnvelopeType(t, hostConn, protocol.TypeChatMessage)
	if chat.SenderID != "m-2" {
		t.Fatalf("聊天应携带发送者: %s", chat.SenderID)
	}
	var entry protocol.ChatEntry
	if err := json.Unmarshal(chat.Payload, &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Name != "成员-m-2" || entry.Text != "大家好" || entry.Kind != "text" {
		t.Fatalf("转发应补齐身份字段: %+v", entry)
	}

	// 新成员加入收到历史
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeChatMessage, 0, protocol.ChatMessagePayload{Kind: "reaction", Text: "👍"}))
	waitFor(t, func() bool { return true })
	m2 := &fakeConn{}
	attachOK(t, r, m2, listenerIdentity("m-3"))
	histEnv := waitEnvelopeType(t, m2, protocol.TypeChatHistory)
	var hist protocol.ChatHistoryPayload
	if err := json.Unmarshal(histEnv.Payload, &hist); err != nil {
		t.Fatal(err)
	}
	if len(hist.Messages) != 2 {
		t.Fatalf("应收到 2 条聊天历史: %+v", hist.Messages)
	}

	// 服务端不接受客户端提交 CHAT_HISTORY
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeChatHistory, 0, protocol.ChatHistoryPayload{}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeInvalidMessage {
		t.Fatalf("code = %s, want INVALID_MESSAGE", got)
	}
}

func TestChatRateLimited(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	m1 := &fakeConn{}
	attachOK(t, r, m1, listenerIdentity("m-2"))

	for i := 0; i < 10; i++ {
		r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeChatMessage, 0, protocol.ChatMessagePayload{Kind: "text", Text: "m"}))
	}
	waitFor(t, func() bool { return len(m1.sent) >= 10 })
	r.HandleEnvelope(m1, envelope(t, "m-2", protocol.TypeChatMessage, 0, protocol.ChatMessagePayload{Kind: "text", Text: "m"}))
	if got := payloadCode(t, waitEnvelopeType(t, m1, protocol.TypeError)); got != protocol.CodeRateLimited {
		t.Fatalf("code = %s, want RATE_LIMITED", got)
	}
}

// ---- 屏障完成时移除任意位置队列条目 ----

func TestFinishBarrierRemovesQueuedEntryAnywhere(t *testing.T) {
	r := newTestRoom(t, Config{ID: "r1"}, nil)
	hostConn := &fakeConn{}
	attachOK(t, r, hostConn, hostIdentity())
	addLibrary(t, r, hostConn, testTrack("k1", "A"), testTrack("k2", "B"))

	// 队列：k1, k2；房主直接准备 k2（随机模式的典型情况）
	requestTrack(t, r, hostConn, "host-1", "k1")
	requestTrack(t, r, hostConn, "host-1", "k2")
	waitFor(t, func() bool { return len(hostConn.snapshot().Queue) == 2 })

	now := time.Now().UnixMilli()
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeNextTrackPrepare, latestRevision(hostConn), protocol.NextTrackPreparePayload{
		TransitionID: "tr-1", Track: testTrack("k2", "B"), StartPositionMs: 0,
		PrepareDeadlineMs: now + 5000, StartAtMs: now + 8000,
	}))
	waitEnvelopeType(t, hostConn, protocol.TypeNextTrackPrepare)
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeReady, 0, protocol.ReadyPayload{TransitionID: "tr-1"}))
	waitFor(t, func() bool { return hostConn.lastOfType(protocol.TypeNextTrackStart) != nil })
	r.HandleEnvelope(hostConn, envelope(t, "host-1", protocol.TypeResyncRequest, 0, protocol.ResyncRequestPayload{}))
	waitFor(t, func() bool {
		queue := hostConn.snapshot().Queue
		return len(queue) == 1 && queue[0].Track.TrackID == "k1"
	})
}

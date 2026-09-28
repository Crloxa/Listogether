import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomStore } from "../transport/ws/room-store";
import { FakeWebSocket, stubWebSocket } from "./helpers";

const snapshotEnvelope = (revision: number, overrides: Record<string, unknown> = {}) => ({
  v: 1,
  type: "ROOM_SNAPSHOT",
  eventId: "evt-snap",
  roomRevision: revision,
  senderId: "relay",
  sentAtMs: 0,
  payload: {
    roomId: "room-1",
    revision,
    playing: false,
    positionMs: 0,
    currentTrack: null,
    transitionId: null,
    startAtMs: null,
    queue: [],
    members: [
      { memberId: "host-1", name: "房主", role: "host", status: "online" },
    ],
    ...overrides,
  },
});

function newStore() {
  return new RoomStore({
    roomId: "room-1",
    sessionToken: "tok",
    memberId: "host-1",
    serverTimeMs: 1_000_000,
    localTimeMs: 1_000_000,
  });
}

describe("RoomStore", () => {
  beforeEach(() => {
    stubWebSocket();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("连接成功后进入 connected 并按 15s 心跳", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    expect(store.getState().status).toBe("connected");

    vi.advanceTimersByTime(15_000);
    expect(ws.sentTypes()).toEqual(["HEARTBEAT"]);
    const hb = ws.lastSent()!;
    expect(hb.type).toBe("HEARTBEAT");
    expect(hb.roomRevision).toBe(0);
    expect(hb.senderId).toBe("host-1");
  });

  it("应用快照与成员增减，事件清除上一次错误", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(3));
    expect(store.getState().room?.revision).toBe(3);
    expect(store.getState().room?.members).toHaveLength(1);

    ws.simulateServerMessage({ v: 1, type: "ERROR", eventId: "e", roomRevision: 3, senderId: "relay", sentAtMs: 0, payload: { code: "STALE_REVISION", message: "旧事件" } });
    expect(store.getState().lastError?.code).toBe("STALE_REVISION");

    ws.simulateServerMessage({
      v: 1, type: "MEMBER_JOINED", eventId: "e2", roomRevision: 4, senderId: "m-2", sentAtMs: 0,
      payload: { member: { memberId: "m-2", name: "小明", role: "listener", status: "online" } },
    });
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().room?.members.map((m) => m.memberId)).toEqual(["host-1", "m-2"]);

    ws.simulateServerMessage({ v: 1, type: "MEMBER_LEFT", eventId: "e3", roomRevision: 5, senderId: "relay", sentAtMs: 0, payload: { memberId: "m-2", reason: "kicked" } });
    expect(store.getState().room?.members).toHaveLength(1);
  });

  it("PLAY/PAUSE/SEEK 更新播放状态与外推锚点", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(1));

    ws.simulateServerMessage({ v: 1, type: "PLAY", eventId: "e", roomRevision: 2, senderId: "host-1", sentAtMs: 0, payload: { positionMs: 1000 } });
    expect(store.getState().room?.playing).toBe(true);
    expect(store.livePositionMs()).toBeGreaterThanOrEqual(1000);

    ws.simulateServerMessage({ v: 1, type: "PAUSE", eventId: "e", roomRevision: 3, senderId: "host-1", sentAtMs: 0, payload: { positionMs: 2500 } });
    expect(store.getState().room?.playing).toBe(false);
    expect(store.livePositionMs()).toBe(2500);
  });

  it("收到 PREPARE 后置屏障但不自动 READY；媒体就绪后经 notifyBarrierMediaReady 上报（同一转换只发一次）", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(1));

    const prepare = {
      v: 1, type: "NEXT_TRACK_PREPARE", eventId: "e", roomRevision: 2, senderId: "host-1", sentAtMs: 0,
      payload: {
        transitionId: "tr-1",
        track: { trackId: "k1", title: "Song A", durationMs: 180_000 },
        startPositionMs: 0,
        prepareDeadlineMs: 1_005_000,
        startAtMs: 1_008_000,
      },
    };
    ws.simulateServerMessage(prepare);
    ws.simulateServerMessage(prepare); // 重复广播不改变屏障状态

    const barrier = store.getState().pendingPrepare;
    expect(barrier?.transitionId).toBe("tr-1");
    expect(store.getState().room?.members[0]?.ready).toBe(false);
    // Phase 2：READY 由媒体层在管道就绪后上报，收 PREPARE 不再自动发送
    expect(ws.sentTypes().filter((t) => t === "READY")).toHaveLength(0);

    expect(store.notifyBarrierMediaReady()).toBe(true);
    expect(store.notifyBarrierMediaReady()).toBe(false); // 同一 transitionId 去重
    expect(ws.sentTypes().filter((t) => t === "READY")).toHaveLength(1);
    expect(ws.lastSent()!.payload).toEqual({ transitionId: "tr-1" });

    ws.simulateServerMessage({ v: 1, type: "NEXT_TRACK_START", eventId: "e", roomRevision: 3, senderId: "relay", sentAtMs: 0, payload: { transitionId: "tr-1", startAtMs: 1_008_000 } });
    expect(store.getState().pendingPrepare).toBeNull();
    expect(store.getState().lastCompletedPrepare?.transitionId).toBe("tr-1");
    expect(store.getState().room?.currentTrack?.title).toBe("Song A");
    expect(store.getState().room?.playing).toBe(true);
    // 屏障开始前显示位置为 0
    expect(store.livePositionMs()).toBe(0);
  });

  it("重连快照携带 pendingPrepare 时恢复屏障元数据并允许再次 READY", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(5, {
      pendingPrepare: {
        transitionId: "tr-2",
        track: { trackId: "k2", title: "Song B", durationMs: 200_000 },
        startPositionMs: 0,
        prepareDeadlineMs: 1_006_000,
        startAtMs: 1_009_000,
      },
    }));
    expect(store.getState().pendingPrepare?.track.title).toBe("Song B");
    expect(store.getState().pendingPrepare?.startAtMs).toBe(1_009_000);

    expect(store.notifyBarrierMediaReady()).toBe(true);
    expect(ws.sentTypes().filter((t) => t === "READY")).toHaveLength(1);
  });

  it("forceStartBarrier 发送 NEXT_TRACK_START（服务器当前时间），无屏障时不发送", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    expect(store.forceStartBarrier()).toBe(false);
    expect(ws.sentTypes()).not.toContain("NEXT_TRACK_START");

    ws.simulateServerMessage(snapshotEnvelope(1, {
      pendingPrepare: {
        transitionId: "tr-3",
        track: { trackId: "k3", title: "Song C", durationMs: 1 },
        startPositionMs: 0,
        prepareDeadlineMs: 999_000,
        startAtMs: 1_009_000,
      },
    }));
    expect(store.forceStartBarrier()).toBe(true);
    const env = ws.lastSent()!;
    expect(env.type).toBe("NEXT_TRACK_START");
    expect(env.payload).toEqual({ transitionId: "tr-3", startAtMs: 1_000_000 });
  });

  it("subscribeEnvelopes 把服务端信封转发给媒体层（含 WEBRTC 信令与 ERROR）", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    const seen: string[] = [];
    store.subscribeEnvelopes((env) => seen.push(env.type));
    ws.simulateServerMessage(snapshotEnvelope(1));
    ws.simulateServerMessage({
      v: 1, type: "WEBRTC_OFFER", eventId: "e2", roomRevision: 1, senderId: "m-9", sentAtMs: 0,
      payload: { toMemberId: "host-1", sdp: "v=0" },
    });
    ws.simulateServerMessage({ v: 1, type: "ERROR", eventId: "e3", roomRevision: 1, senderId: "relay", sentAtMs: 0, payload: { code: "STALE_REVISION" } });
    expect(seen).toEqual(["ROOM_SNAPSHOT", "WEBRTC_OFFER", "ERROR"]);
  });

  it("异常断线后自动重连，重连成功则恢复", () => {
    const store = newStore();
    store.connect();
    const first = FakeWebSocket.latest!;
    first.simulateOpen();
    first.simulateAbnormalClose();
    expect(store.getState().status).toBe("reconnecting");

    vi.advanceTimersByTime(9_000);
    expect(FakeWebSocket.instances.length).toBe(2); // 已重连
    FakeWebSocket.latest!.simulateOpen();
    expect(store.getState().status).toBe("connected");
    expect(store.getState().reconnectAttempt).toBe(0);
  });

  it("关闭码 4001 触发致命提示且不再重连", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.close(4001, "session invalid");
    expect(store.getState().fatalMessage).toContain("重新加入");
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it("leave() 用 3001 显式离开且不再重连", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    store.leave();
    expect(store.getState().status).toBe("closed");
    expect(ws.closedWith?.code).toBe(3001);
    ws.simulateAbnormalClose(); // 离开后到达的 close 不触发重连
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it("未连接时 send 返回 false；发送携带最新 revision", () => {
    const store = newStore();
    expect(store.send("PLAY", { positionMs: 0 })).toBe(false);

    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(7));
    expect(store.send("SEEK", { positionMs: 42 })).toBe(true);
    const env = ws.lastSent()!;
    expect(env.roomRevision).toBe(7);
    expect(env.senderId).toBe("host-1");
    expect(env.payload).toEqual({ positionMs: 42 });
  });

  it("同一 tick 连续发送写事件时本地 revision 乐观递增（避免 STALE_REVISION 自竞态）", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(7));
    store.trackFinished("played");
    store.pause();
    const parsed = ws.sent.map((raw) => JSON.parse(raw) as { type: string; roomRevision: number });
    const tf = parsed[0];
    const pause = parsed[1];
    expect(tf?.type).toBe("TRACK_FINISHED");
    expect(tf?.roomRevision).toBe(7);
    expect(pause?.type).toBe("PAUSE");
    expect(pause?.roomRevision).toBe(8);
    // 服务端事件到达后校准回权威值
    ws.simulateServerMessage(snapshotEnvelope(8));
    store.play();
    expect(ws.lastSent()!.roomRevision).toBe(8);
  });

  // ---- Phase 3：队列、点歌、聊天（D-012/D-013） ----

  it("快照携带曲库/队列条目/待审批/历史/投票与播放模式", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(
      snapshotEnvelope(9, {
        playMode: "shuffle",
        library: [{ trackId: "k1", title: "Song A", durationMs: 180_000, addedBy: "host-1", addedAtMs: 1 }],
        queue: [
          {
            entryId: "qe-1",
            track: { trackId: "k1", title: "Song A", durationMs: 180_000 },
            requestedBy: "m-2",
            requestedByName: "小明",
            addedAtMs: 2,
          },
        ],
        pendingRequests: [
          {
            entryId: "qe-2",
            track: { trackId: "k2", title: "Song B", durationMs: 1 },
            requestedBy: "m-3",
            requestedByName: "小红",
            addedAtMs: 3,
          },
        ],
        history: [{ track: { trackId: "k0", title: "Song Z", durationMs: 1 }, outcome: "played", atMs: 4 }],
        skipVotes: { transitionId: "tr-1", memberIds: ["m-2"], passed: false },
      }),
    );
    const room = store.getState().room!;
    expect(room.playMode).toBe("shuffle");
    expect(room.library).toHaveLength(1);
    expect(room.queue[0]?.requestedByName).toBe("小明");
    expect(room.pendingRequests).toHaveLength(1);
    expect(room.history?.[0]?.outcome).toBe("played");
    expect(room.skipVotes?.memberIds).toEqual(["m-2"]);
  });

  it("CHAT_HISTORY 恢复聊天；CHAT_MESSAGE 追加并截断到 100 条", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage({
      v: 1, type: "CHAT_HISTORY", eventId: "e", roomRevision: 1, senderId: "relay", sentAtMs: 0,
      payload: { messages: [{ messageId: "m1", memberId: "m-2", name: "小明", kind: "text", text: "嗨", sentAtMs: 1 }] },
    });
    expect(store.getState().chat.map((c) => c.text)).toEqual(["嗨"]);

    ws.simulateServerMessage({
      v: 1, type: "CHAT_MESSAGE", eventId: "e", roomRevision: 2, senderId: "m-3", sentAtMs: 0,
      payload: { messageId: "m2", memberId: "m-3", name: "小红", kind: "reaction", text: "👍", sentAtMs: 2 },
    });
    expect(store.getState().chat).toHaveLength(2);
    expect(store.getState().chat[1]?.kind).toBe("reaction");

    // 无身份字段的残缺转发不入列
    ws.simulateServerMessage({
      v: 1, type: "CHAT_MESSAGE", eventId: "e", roomRevision: 2, senderId: "m-3", sentAtMs: 0,
      payload: { kind: "text", text: "残缺" },
    });
    expect(store.getState().chat).toHaveLength(2);

    for (let i = 0; i < 120; i++) {
      ws.simulateServerMessage({
        v: 1, type: "CHAT_MESSAGE", eventId: `e${i}`, roomRevision: 2, senderId: "m-3", sentAtMs: 0,
        payload: { messageId: `bulk-${i}`, memberId: "m-3", name: "小红", kind: "text", text: "m", sentAtMs: i },
      });
    }
    expect(store.getState().chat).toHaveLength(100);
  });

  it("队列/点歌/聊天动作发送正确 payload", () => {
    const store = newStore();
    store.connect();
    const ws = FakeWebSocket.latest!;
    ws.simulateOpen();
    ws.simulateServerMessage(snapshotEnvelope(4));

    expect(store.libraryAdd([{ trackId: "k1", title: "A", durationMs: 1 }])).toBe(true);
    expect(ws.lastSent()!.type).toBe("LIBRARY_ADD");

    store.requestTrack("k1");
    expect(ws.lastSent()!.payload).toEqual({ trackId: "k1" });

    store.approveEntry("qe-1");
    expect(ws.lastSent()!.type).toBe("QUEUE_APPROVE");
    store.rejectEntry("qe-1");
    store.removeEntry("qe-1");
    store.reorderQueue(["b", "a"]);
    expect(ws.lastSent()!.payload).toEqual({ entryIds: ["b", "a"] });
    store.clearQueue();
    expect(ws.lastSent()!.payload).toEqual({});
    store.skipVote();
    expect(ws.lastSent()!.type).toBe("SKIP_VOTE");
    store.trackFinished("failed", "k1");
    expect(ws.lastSent()!.payload).toEqual({ outcome: "failed", trackId: "k1" });
    store.trackFinished("played");
    expect(ws.lastSent()!.payload).toEqual({ outcome: "played" });
    store.setPlayMode("repeat_one");
    expect(ws.lastSent()!.payload).toEqual({ mode: "repeat_one" });

    store.sendChat("text", "大家好");
    const chat = ws.lastSent()!;
    expect(chat.type).toBe("CHAT_MESSAGE");
    expect(chat.payload).toEqual({ kind: "text", text: "大家好" });
  });
});

import { describe, expect, it } from "vitest";
import {
  ENVELOPE_SCHEMA,
  ERROR_CODES,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  makeEnvelope,
  validateEnvelope,
  type EnvelopeType,
} from "../src";
import type { NextTrackPreparePayload, RoomSnapshot } from "../src/types";

const snapshot: RoomSnapshot = {
  roomId: "room-1",
  revision: 7,
  playing: true,
  positionMs: 12000,
  currentTrack: { trackId: "t-1", title: "Song A", artist: "Artist", durationMs: 180000 },
  transitionId: null,
  startAtMs: null,
  playMode: "order",
  library: [{ trackId: "t-2", title: "Song B", durationMs: 200000, addedBy: "m-host", addedAtMs: 1 }],
  queue: [
    {
      entryId: "qe-1",
      track: { trackId: "t-2", title: "Song B", durationMs: 0 },
      requestedBy: "m-2",
      requestedByName: "friend",
      addedAtMs: 2,
    },
  ],
  pendingRequests: [],
  history: [{ track: { trackId: "t-1", title: "Song A", durationMs: 180000 }, outcome: "played", atMs: 3 }],
  skipVotes: null,
  members: [
    { memberId: "m-host", name: "host", role: "host", status: "online" },
    { memberId: "m-2", name: "friend", role: "listener", status: "online", ready: false },
  ],
};

const prepare: NextTrackPreparePayload = {
  transitionId: "tr-1",
  track: { trackId: "t-2", title: "Song B", durationMs: 200000 },
  startPositionMs: 0,
  prepareDeadlineMs: 1000,
  startAtMs: 3000,
};

const SAMPLE_PAYLOADS: Record<EnvelopeType, unknown> = {
  ROOM_SNAPSHOT: snapshot,
  MEMBER_JOINED: { member: { memberId: "m-3", name: "late", role: "listener", status: "online" } },
  MEMBER_LEFT: { memberId: "m-3", reason: "left" },
  PLAY: { positionMs: 15000 },
  PAUSE: { positionMs: 15000 },
  SEEK: { positionMs: 60000 },
  NEXT_TRACK_PREPARE: prepare,
  READY: { transitionId: "tr-1" },
  NEXT_TRACK_START: { transitionId: "tr-1", startAtMs: 3000 },
  RESYNC_REQUEST: {},
  WEBRTC_OFFER: { toMemberId: "m-2", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" },
  WEBRTC_ANSWER: { toMemberId: "m-host", sdp: "v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\n" },
  ICE_CANDIDATE: { toMemberId: "m-2", candidate: "candidate:1 1 udp 1 192.168.0.2 5000 typ host" },
  HEARTBEAT: { clientTimeMs: 42 },
  ERROR: { code: "INVALID_MESSAGE", message: "bad envelope", refEventId: "evt-1" },
  LIBRARY_ADD: { tracks: [{ trackId: "t-2", title: "Song B", durationMs: 200000 }] },
  LIBRARY_REMOVE: { trackId: "t-2" },
  QUEUE_REQUEST: { trackId: "t-2" },
  QUEUE_APPROVE: { entryId: "qe-1" },
  QUEUE_REJECT: { entryId: "qe-1" },
  QUEUE_REMOVE: { entryId: "qe-1" },
  QUEUE_REORDER: { entryIds: ["qe-1"] },
  QUEUE_CLEAR: {},
  SKIP_VOTE: {},
  TRACK_FINISHED: { outcome: "played" },
  PLAY_MODE: { mode: "shuffle" },
  CHAT_MESSAGE: { kind: "text", text: "大家好" },
  CHAT_HISTORY: {
    messages: [{ messageId: "m1", memberId: "m-2", name: "friend", kind: "text", text: "嗨", sentAtMs: 1 }],
  },
  TRACK_LYRICS: { trackId: "t-1", format: "lrc", lyrics: "[00:12.00]第一句\n[00:18.50]第二句" },
};

describe("protocol schema 基线", () => {
  it("定义了全部 29 个事件且与 payload 样例一一对应", () => {
    expect(EVENT_TYPES).toHaveLength(29);
    for (const type of EVENT_TYPES) {
      expect(SAMPLE_PAYLOADS, `缺少事件 ${type} 的样例 payload`).toBeDefined();
    }
  });

  it("错误码来自 canonical schema 且包含关键错误", () => {
    expect(ERROR_CODES).toContain("INVALID_MESSAGE");
    expect(ERROR_CODES).toContain("UNSUPPORTED_VERSION");
    expect(ERROR_CODES).toContain("UNKNOWN_TYPE");
    expect(ERROR_CODES).toContain("STALE_REVISION");
    expect(ERROR_CODES).toContain("DUPLICATE_TRACK");
    expect(ERROR_CODES).toContain("LYRICS_TOO_LARGE");
  });

  it("track.source 平台来源字段：接受合法值并拒绝未知平台/可用性", () => {
    const withSource: RoomSnapshot = {
      ...snapshot,
      library: [
        {
          trackId: "t-netease",
          title: "海阔天空",
          artist: "Beyond",
          durationMs: 326000,
          source: { platform: "netease", url: "https://music.163.com/song?id=347230", playability: "needs_login" },
          addedBy: "m-host",
          addedAtMs: 1,
        },
      ],
    };
    expect(validateEnvelope(makeEnvelope({ type: "ROOM_SNAPSHOT", payload: withSource })).ok).toBe(true);

    const badPlatform: RoomSnapshot = {
      ...snapshot,
      library: [
        {
          trackId: "t-x",
          title: "X",
          durationMs: 1,
          // @ts-expect-error 故意注入未知平台验证 schema 拒绝
          source: { platform: "evil", url: "https://evil.example/x" },
          addedBy: "m-host",
          addedAtMs: 1,
        },
      ],
    };
    expect(validateEnvelope(makeEnvelope({ type: "ROOM_SNAPSHOT", payload: badPlatform })).ok).toBe(false);

    const badPlayability = {
      ...snapshot,
      library: [
        {
          trackId: "t-y",
          title: "Y",
          durationMs: 1,
          source: { platform: "netease", url: "https://music.163.com/song?id=1", playability: "free" },
          addedBy: "m-host",
          addedAtMs: 1,
        },
      ],
    } as unknown as RoomSnapshot;
    expect(validateEnvelope(makeEnvelope({ type: "ROOM_SNAPSHOT", payload: badPlayability })).ok).toBe(false);
  });

  it("TRACK_LYRICS 超过 48KB 上限被拒绝（防止 64KB 帧被撑爆）", () => {
    const oversized = { trackId: "t-1", format: "lrc", lyrics: "[00:01.00]x".repeat(5000) };
    expect(validateEnvelope(makeEnvelope({ type: "TRACK_LYRICS", payload: oversized })).ok).toBe(false);
  });

  it("角色枚举为 host/co_dj/listener", () => {
    const defs = (ENVELOPE_SCHEMA as { $defs: Record<string, { enum?: string[] }> }).$defs;
    expect(defs.role?.enum).toEqual(["host", "co_dj", "listener"]);
  });
});

describe("validateEnvelope", () => {
  it("接受全部事件类型的合法样例", () => {
    for (const type of EVENT_TYPES) {
      const envelope = makeEnvelope({ type, payload: SAMPLE_PAYLOADS[type] });
      const result = validateEnvelope(envelope);
      expect(result.errors, `${type} 应通过校验: ${result.errors.join("; ")}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("接受 RESYNC_REQUEST 带 reason 的样例", () => {
    const result = validateEnvelope(
      makeEnvelope({ type: "RESYNC_REQUEST", payload: { reason: "drift" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("拒绝未知事件类型", () => {
    const result = validateEnvelope(
      makeEnvelope({ type: "TOTALLY_UNKNOWN" as EnvelopeType, payload: {} }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/type/i);
  });

  it("拒绝错误的协议版本", () => {
    const envelope = { ...makeEnvelope({ type: "HEARTBEAT", payload: { clientTimeMs: 1 } }), v: 2 };
    const result = validateEnvelope(envelope);
    expect(result.ok).toBe(false);
  });

  it("拒绝缺少必填字段（eventId/senderId/sentAtMs/roomRevision）", () => {
    for (const key of ["eventId", "senderId", "sentAtMs", "roomRevision"] as const) {
      const envelope = makeEnvelope({ type: "HEARTBEAT", payload: { clientTimeMs: 1 } });
      delete (envelope as unknown as Record<string, unknown>)[key];
      const result = validateEnvelope(envelope);
      expect(result.ok, `删除 ${key} 后应被拒绝`).toBe(false);
      expect(result.errors.join(" ")).toMatch(key);
    }
  });

  it("拒绝负数 roomRevision 与 sentAtMs", () => {
    expect(
      validateEnvelope(
        makeEnvelope({ type: "HEARTBEAT", payload: { clientTimeMs: 1 }, roomRevision: -1 }),
      ).ok,
    ).toBe(false);
    expect(
      validateEnvelope(makeEnvelope({ type: "HEARTBEAT", payload: { clientTimeMs: -5 } })).ok,
    ).toBe(false);
  });

  it("拒绝信封上的未知附加字段", () => {
    const envelope = {
      ...makeEnvelope({ type: "HEARTBEAT", payload: { clientTimeMs: 1 } }),
      secretToken: "should-not-be-here",
    };
    expect(validateEnvelope(envelope).ok).toBe(false);
  });

  it("payload 与 type 绑定：PLAY 携带 prepare payload 被拒绝", () => {
    const result = validateEnvelope(makeEnvelope({ type: "PLAY", payload: prepare }));
    expect(result.ok).toBe(false);
  });

  it("HEARTBEAT 缺少 clientTimeMs 被拒绝", () => {
    expect(validateEnvelope(makeEnvelope({ type: "HEARTBEAT", payload: {} })).ok).toBe(false);
  });

  it("ERROR 携带未知错误码被拒绝", () => {
    const result = validateEnvelope(
      makeEnvelope({ type: "ERROR", payload: { code: "NOT_A_CODE" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("NEXT_TRACK_PREPARE 的 startAtMs 必须晚于 prepareDeadlineMs 才有语义（schema 只校验形状）", () => {
    const result = validateEnvelope(
      makeEnvelope({
        type: "NEXT_TRACK_PREPARE",
        payload: { ...prepare, startAtMs: 500, prepareDeadlineMs: 900 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("拒绝非对象输入", () => {
    for (const bad of [null, 42, "string", [], undefined]) {
      const result = validateEnvelope(bad);
      expect(result.ok, `${String(bad)} 应被拒绝`).toBe(false);
    }
  });

  it("默认版本号为当前协议版本", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

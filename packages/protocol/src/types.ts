import type { ErrorCode } from "./error-codes";

export type EnvelopeType =
  | "ROOM_SNAPSHOT"
  | "MEMBER_JOINED"
  | "MEMBER_LEFT"
  | "PLAY"
  | "PAUSE"
  | "SEEK"
  | "NEXT_TRACK_PREPARE"
  | "READY"
  | "NEXT_TRACK_START"
  | "RESYNC_REQUEST"
  | "WEBRTC_OFFER"
  | "WEBRTC_ANSWER"
  | "ICE_CANDIDATE"
  | "HEARTBEAT"
  | "ERROR"
  | "LIBRARY_ADD"
  | "LIBRARY_REMOVE"
  | "QUEUE_REQUEST"
  | "QUEUE_APPROVE"
  | "QUEUE_REJECT"
  | "QUEUE_REMOVE"
  | "QUEUE_REORDER"
  | "QUEUE_CLEAR"
  | "SKIP_VOTE"
  | "TRACK_FINISHED"
  | "PLAY_MODE"
  | "CHAT_MESSAGE"
  | "CHAT_HISTORY"
  | "TRACK_LYRICS";

export interface Envelope<TPayload = Record<string, unknown>> {
  v: number;
  type: EnvelopeType;
  eventId: string;
  roomRevision: number;
  senderId: string;
  sentAtMs: number;
  payload: TPayload;
}

export type MemberRole = "host" | "co_dj" | "listener";
export type MemberStatus = "online" | "offline";

export interface Member {
  memberId: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  /** 仅在下一首准备屏障期间有意义。 */
  ready?: boolean;
}

/** 平台标识（D-014）；other 为已知形态外但链接合法的平台。 */
export type Platform = "netease" | "qqmusic" | "spotify" | "ytmusic" | "other";

/**
 * 平台侧可用性判断（D-014）。注意：这是"平台确认可用性"，
 * 不代表房间内可播——房间内可播永远取决于房主本机文件（D-001）。
 */
export type Playability =
  | "playable"
  | "needs_login"
  | "preview_only"
  | "region_locked"
  | "unavailable"
  | "unknown";

/** 平台链接识别结果；本地文件曲目的 source 缺省。 */
export interface TrackSource {
  platform: Platform;
  /** 规范化后的平台链接。 */
  url: string;
  externalId?: string;
  playability?: Playability;
  /** 平台封面 URL（客户端直连加载显示，P-005）。 */
  coverUrl?: string;
  resolvedAtMs?: number;
}

export interface Track {
  trackId: string;
  title: string;
  artist?: string;
  /** 未知时长用 0 表示。 */
  durationMs: number;
  /** 平台链接来源信息（Phase 4，D-014）；本地文件曲目缺省。 */
  source?: TrackSource | null;
}

/** 快照携带的进行中下一首准备屏障元数据（Phase 2：重连成员恢复屏障信息）。 */
export interface PendingPrepareInfo {
  transitionId: string;
  track: Track;
  startPositionMs: number;
  prepareDeadlineMs: number;
  startAtMs: number;
}

export type PlayMode = "order" | "repeat_one" | "shuffle";

/** 队列条目：服务端生成 entryId，点歌人信息随条目下发（D-012）。 */
export interface QueueEntry {
  entryId: string;
  track: Track;
  requestedBy: string;
  requestedByName: string;
  addedAtMs: number;
}

/** 房间曲库条目：只有元数据，音频文件只存在于房主本机（D-012）。 */
export interface LibraryEntry {
  trackId: string;
  title: string;
  artist?: string;
  durationMs: number;
  /** 平台链接来源（D-014）；缺省为本地曲目。 */
  source?: TrackSource | null;
  addedBy: string;
  addedAtMs: number;
}

export type TrackOutcome = "played" | "skipped" | "failed" | "rejected";

export interface HistoryEntry {
  track: Track;
  outcome: TrackOutcome;
  atMs: number;
  requestedByName?: string;
}

/** 当前曲目的投票跳过状态（D-013）。 */
export interface SkipVoteState {
  transitionId: string;
  memberIds: string[];
  passed: boolean;
}

export type ChatKind = "text" | "reaction";

export interface ChatEntry {
  messageId: string;
  memberId: string;
  name: string;
  kind: ChatKind;
  text: string;
  sentAtMs: number;
}

export interface RoomSnapshot {
  roomId: string;
  revision: number;
  playing: boolean;
  positionMs: number;
  currentTrack: Track | null;
  transitionId: string | null;
  startAtMs: number | null;
  /** 进行中的下一首准备屏障；无屏障时缺省或为 null。 */
  pendingPrepare?: PendingPrepareInfo | null;
  /** 播放模式；缺省为 order。 */
  playMode?: PlayMode;
  /** 房间曲库（仅元数据）；缺省为空。 */
  library?: LibraryEntry[];
  queue: QueueEntry[];
  /** 待审批的点歌请求；缺省为空。 */
  pendingRequests?: QueueEntry[];
  /** 最近播放/跳过/失败/拒绝历史；缺省为空。 */
  history?: HistoryEntry[];
  /** 当前曲目的投票跳过状态；无投票时缺省或为 null。 */
  skipVotes?: SkipVoteState | null;
  members: Member[];
}

export interface MemberJoinedPayload {
  member: Member;
}

export type MemberLeftReason = "left" | "kicked" | "timeout" | "room_closed";

export interface MemberLeftPayload {
  memberId: string;
  reason: MemberLeftReason;
}

export interface PositionPayload {
  positionMs: number;
}

export interface NextTrackPreparePayload {
  transitionId: string;
  track: Track;
  startPositionMs: number;
  prepareDeadlineMs: number;
  startAtMs: number;
}

export interface ReadyPayload {
  transitionId: string;
}

export interface NextTrackStartPayload {
  transitionId: string;
  startAtMs: number;
}

export type ResyncReason = "late_join" | "drift" | "stalled" | "manual";

export interface ResyncRequestPayload {
  reason?: ResyncReason;
}

export interface WebRtcSdpPayload {
  toMemberId: string;
  sdp: string;
}

export interface IceCandidatePayload {
  toMemberId: string;
  candidate: string;
}

export interface HeartbeatPayload {
  clientTimeMs: number;
}

export interface LibraryAddPayload {
  tracks: Track[];
}

export interface LibraryRemovePayload {
  trackId: string;
}

export interface QueueRequestPayload {
  trackId: string;
}

/** QUEUE_APPROVE/QUEUE_REJECT/QUEUE_REMOVE 共用。 */
export interface QueueEntryIdPayload {
  entryId: string;
}

export interface QueueReorderPayload {
  entryIds: string[];
}

export interface TrackFinishedPayload {
  outcome: TrackOutcome;
  /** failed 时指向队列中失败条目（服务端将其移除）；省略时指当前播放曲目。 */
  trackId?: string;
}

export interface PlayModePayload {
  mode: PlayMode;
}

export interface ChatMessagePayload {
  kind: ChatKind;
  text: string;
  /** Relay 转发时补齐的身份字段。 */
  messageId?: string;
  memberId?: string;
  name?: string;
  sentAtMs?: number;
}

export interface ChatHistoryPayload {
  messages: ChatEntry[];
}

/** 歌词格式：lrc 逐行时间戳可同步高亮；plain 纯文本整段显示（D-017）。 */
export type LyricsFormat = "lrc" | "plain";

export interface TrackLyricsPayload {
  trackId: string;
  format: LyricsFormat;
  /** 歌词原文（≤48KB 文本、≤500 行、单行 ≤512 字符）。 */
  lyrics: string;
}

export interface ErrorPayload {
  code: ErrorCode;
  message?: string;
  refEventId?: string;
}

export type EnvelopePayloadMap = {
  ROOM_SNAPSHOT: RoomSnapshot;
  MEMBER_JOINED: MemberJoinedPayload;
  MEMBER_LEFT: MemberLeftPayload;
  PLAY: PositionPayload;
  PAUSE: PositionPayload;
  SEEK: PositionPayload;
  NEXT_TRACK_PREPARE: NextTrackPreparePayload;
  READY: ReadyPayload;
  NEXT_TRACK_START: NextTrackStartPayload;
  RESYNC_REQUEST: ResyncRequestPayload;
  WEBRTC_OFFER: WebRtcSdpPayload;
  WEBRTC_ANSWER: WebRtcSdpPayload;
  ICE_CANDIDATE: IceCandidatePayload;
  HEARTBEAT: HeartbeatPayload;
  ERROR: ErrorPayload;
  LIBRARY_ADD: LibraryAddPayload;
  LIBRARY_REMOVE: LibraryRemovePayload;
  QUEUE_REQUEST: QueueRequestPayload;
  QUEUE_APPROVE: QueueEntryIdPayload;
  QUEUE_REJECT: QueueEntryIdPayload;
  QUEUE_REMOVE: QueueEntryIdPayload;
  QUEUE_REORDER: QueueReorderPayload;
  QUEUE_CLEAR: Record<string, never>;
  SKIP_VOTE: Record<string, never>;
  TRACK_FINISHED: TrackFinishedPayload;
  PLAY_MODE: PlayModePayload;
  CHAT_MESSAGE: ChatMessagePayload;
  CHAT_HISTORY: ChatHistoryPayload;
  TRACK_LYRICS: TrackLyricsPayload;
};

export type TypedEnvelope<T extends keyof EnvelopePayloadMap = keyof EnvelopePayloadMap> = Envelope<
  EnvelopePayloadMap[T]
>;

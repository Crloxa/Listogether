/**
 * 媒体接线层：把 RoomStore 的房间事件流接到房主/成员音频控制器。
 * 组件不直接操作 WebAudio/WebRTC；角色变化时由 UI 挂载/卸载对应的 handle。
 * 封面（D-016）：房主在切歌/新成员通道 open 时经 DataChannel 发送；成员接收进 CoverStore。
 */
import type { Envelope, NextTrackPreparePayload } from "@listogether/protocol";
import type { RoomStore } from "../transport/ws/room-store";
import { compressCoverBlob, CoverAssembler, type CoverStore } from "./cover-channel";
import { HostAudioController } from "./host-audio";
import { MemberAudioController } from "./member-audio";

function selfId(store: RoomStore): string {
  return store.memberId;
}

/** 在线成员（排除自己）——房主 reconcile 的目标集合。 */
function otherOnlineMemberIds(store: RoomStore): string[] {
  const room = store.getState().room;
  if (!room) return [];
  return room.members.filter((m) => m.status === "online" && m.memberId !== selfId(store)).map((m) => m.memberId);
}

/** 房主本机文件注册表：屏障按 trackId 解析音频文件（D-012）。 */
export interface HostFileResolver {
  getFile(trackId: string): File | null;
  /** 屏障曲目在房主本机缺文件时回调（UI 提示，不上报 READY，等待补文件或强制开始）。 */
  onTrackMissing(trackId: string): void;
  /** 读取条目封面字节（D-016，DataChannel 发送）；无封面返回 null。 */
  getCoverBytes?(trackId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

export interface HostMediaHandle {
  controller: HostAudioController;
  dispose(): void;
}

export function wireHostMedia(store: RoomStore, files?: HostFileResolver): HostMediaHandle {
  const controller = new HostAudioController(
    (type, payload) => store.send(type, payload as Record<string, unknown>),
    {
      onOffer: (memberId, sdp) => store.send("WEBRTC_OFFER", { toMemberId: memberId, sdp }),
      onCandidate: (memberId, candidate) => store.send("ICE_CANDIDATE", { toMemberId: memberId, candidate }),
    },
  );

  // 封面发送（D-016）：读取 → 压缩到 ≤512KB → 广播；(成员,trackId) 去重在控制器内
  const sendCover = (trackId: string | null | undefined) => {
    if (!trackId || !files?.getCoverBytes) return;
    void files
      .getCoverBytes(trackId)
      .then(async (cover) => {
        if (!cover) return;
        const blob = new Blob([cover.bytes.buffer as ArrayBuffer], { type: cover.mime });
        const compressed = await compressCoverBlob(blob);
        if (!compressed) return;
        const bytes = new Uint8Array(await compressed.arrayBuffer());
        await controller.broadcastCover(trackId, compressed.type || cover.mime, bytes);
      })
      .catch(() => {
        /* 封面读取失败不影响音频（成员显示占位） */
      });
  };
  controller.onCoverChannelOpen = () => {
    // 新成员通道 open：补发当前曲目封面（去重记录已由控制器清理）
    const trackId = controller.currentCoverTrackId;
    if (trackId) sendCover(trackId);
  };

  const unsubscribe = store.subscribeEnvelopes((env: Envelope) => {
    switch (env.type) {
      case "ROOM_SNAPSHOT":
      case "MEMBER_JOINED":
      case "MEMBER_LEFT":
        controller.syncMembers(otherOnlineMemberIds(store));
        break;
      case "WEBRTC_ANSWER": {
        // 成员的应答（senderId 为该成员）
        const { sdp } = env.payload as { sdp: string };
        controller.handleAnswer(env.senderId, sdp);
        break;
      }
      case "ICE_CANDIDATE": {
        const { candidate } = env.payload as { candidate: string };
        if (env.senderId === selfId(store)) break; // 自己的候选回显
        controller.handleCandidate(env.senderId, candidate);
        break;
      }
      case "NEXT_TRACK_PREPARE": {
        // 队列衔接（Phase 3）：按屏障曲目解析房主本机文件并暂存解码缓冲；
        // 就绪后上报 READY。缺文件时不 READY（屏障会超时，可强制开始）。
        const { track } = env.payload as unknown as NextTrackPreparePayload;
        const file = files?.getFile(track.trackId) ?? null;
        if (file) {
          void controller
            .stageFile(track.trackId, file)
            .then(() => store.notifyBarrierMediaReady())
            .catch(() => files?.onTrackMissing(track.trackId));
        } else {
          files?.onTrackMissing(track.trackId);
        }
        break;
      }
      case "NEXT_TRACK_START": {
        const { startAtMs } = env.payload as { startAtMs: number };
        const prepared = store.getState().lastCompletedPrepare;
        controller.startBarrierSegment(startAtMs, prepared?.startPositionMs ?? 0, store.serverNow());
        // 曲目切换（D-016）：向所有 open 通道发送新曲目封面
        sendCover(prepared?.track.trackId);
        break;
      }
      case "RESYNC_REQUEST": {
        // Relay 转发来的成员重新同步：只为该成员重建音频段（只影响请求者）
        if (env.senderId === selfId(store) || env.senderId === "relay") break;
        controller.resyncMember(env.senderId, Math.round(store.livePositionMs()), store.serverNow());
        break;
      }
      default:
        break;
    }
  });

  return {
    controller,
    dispose: () => {
      unsubscribe();
      controller.release();
    },
  };
}

export interface MemberMediaHandle {
  controller: MemberAudioController;
  dispose(): void;
}

export interface MemberCoverOptions {
  /** 封面接收缓存（D-016）；组件持有并订阅显示。 */
  coverStore: CoverStore;
}

export function wireMemberMedia(store: RoomStore, covers?: MemberCoverOptions): MemberMediaHandle {
  const controller = new MemberAudioController({
    serverNowMs: () => store.serverNow(),
    currentSongStartAtMs: () => store.getState().room?.startAtMs ?? null,
    sendResync: (reason) => store.resync(reason),
    notifyBarrierMediaReady: () => store.notifyBarrierMediaReady(),
    sendSignaling: (type, toMemberId, value) => {
      const payload = type === "WEBRTC_ANSWER" ? { toMemberId, sdp: value } : { toMemberId, candidate: value };
      store.send(type, payload);
    },
    onDataChannel: (channel) => {
      if (!covers) return;
      const assembler = new CoverAssembler((trackId, mime, bytes) => covers.coverStore.put(trackId, mime, bytes));
      channel.onmessage = (event) => {
        try {
          assembler.handle(JSON.parse(String(event.data)));
        } catch {
          /* 非 JSON 帧忽略 */
        }
      };
    },
  });

  const unsubscribe = store.subscribeEnvelopes((env: Envelope) => {
    switch (env.type) {
      case "WEBRTC_OFFER": {
        const { sdp } = env.payload as { sdp: string };
        controller.handleOffer(env.senderId, sdp);
        break;
      }
      case "ICE_CANDIDATE": {
        const { candidate } = env.payload as { candidate: string };
        controller.handleCandidate(candidate);
        break;
      }
      case "NEXT_TRACK_PREPARE":
      case "ROOM_SNAPSHOT":
        controller.evaluateReady();
        break;
      default:
        break;
    }
  });

  return {
    controller,
    dispose: () => {
      unsubscribe();
      controller.release();
    },
  };
}

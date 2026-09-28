/** 房间页：快照/成员/播放状态展示、房主本地音频与队列推进、成员收听（Phase 3/4）。
 * 连接失败、自动播放限制、迟到提示、屏障超时与队列衔接（D-012/D-013）的提示是本页的明确职责。
 * Phase 4（D-014~D-017）：平台链接解析、OAuth 面板、封面显示、歌词同步、媒体键与常亮。 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomStore } from "../../transport/ws/room-store";
import {
  wireHostMedia,
  wireMemberMedia,
  type HostMediaHandle,
  type MemberMediaHandle,
} from "../../media/wiring";
import { CoverStore } from "../../media/cover-channel";
import { MediaSessionController } from "../../media/media-session";
import { requestWakeLock, type WakeLockHandle } from "../../media/wake-lock";
import { setRuntimeIceServers, clearRuntimeIceServers, runtimeTurnEnabled } from "../../media/webrtc/ice-config";
import type { MemberAudioDebug } from "../../media/member-audio";
import { loadSession, clearSession, type RoomSession } from "./session";
import { roomApi, iceApi } from "./api";
import { buildInviteLink } from "./invite";
import { useHostLibrary } from "./use-host-library";
import LibraryPanel from "./LibraryPanel";
import QueuePanel from "../queue/QueuePanel";
import ChatPanel from "../chat/ChatPanel";
import LinkResolver from "../providers/LinkResolver";
import OAuthPanel from "../providers/OAuthPanel";
import LyricsPanel from "./LyricsPanel";
import { describePlayability } from "../providers/normalize";
import { previousTrackFromHistory } from "../queue/history";
import { estimateHostUpstreamKbps, HOST_UPSTREAM_WARN_KBPS } from "./bandwidth";
import { navigate } from "../../app/router";
import CopyButton from "../../ui/CopyButton";
import { formatMs } from "../../ui/format";

const ROLE_LABEL: Record<string, string> = { host: "房主", co_dj: "共同 DJ", listener: "听众" };

const STATUS_LABEL: Record<string, string> = {
  connecting: "正在连接房间…",
  connected: "已连接",
  reconnecting: "连接中断，正在重连…",
  closed: "连接已断开",
};

export default function RoomPage({ roomId }: { roomId: string }) {
  const session = loadSessionGuarded(roomId);
  if (!session) {
    return (
      <main className="page">
        <h1>房间 {roomId}</h1>
        <p role="alert" data-testid="session-missing">
          本页没有有效的房间会话。请从邀请链接重新加入。
        </p>
        <a href="/">返回首页</a>
      </main>
    );
  }
  return <RoomView roomId={roomId} session={session} />;
}

function loadSessionGuarded(roomId: string): RoomSession | null {
  return loadSession(roomId);
}

function RoomView({ roomId, session }: { roomId: string; session: RoomSession }) {
  const [store] = useState(
    () =>
      new RoomStore({
        roomId,
        sessionToken: session.sessionToken,
        memberId: session.memberId,
        serverTimeMs: session.serverTimeMs,
        localTimeMs: session.localTimeMs,
      }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [, setTick] = useState(0);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [memberVolume, setMemberVolume] = useState(1);
  const [memberMuted, setMemberMuted] = useState(false);
  const [lateDismissedFor, setLateDismissedFor] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [missingBarrierTrack, setMissingBarrierTrack] = useState<string | null>(null);

  // 媒体接线放 ref：500ms 状态刷新循环与渲染读取保持同一实例
  const hostMediaRef = useRef<HostMediaHandle | null>(null);
  const memberMediaRef = useRef<MemberMediaHandle | null>(null);
  // 离开房间时清理运行时 ICE 配置（避免下一个房间沿用过期 TURN 凭据）
  useEffect(() => () => clearRuntimeIceServers(), []);
  // 封面缓存（D-016）：成员端接收存储；房主端也可用于显示自己发出的封面
  const coverStoreRef = useRef<CoverStore | null>(null);
  if (!coverStoreRef.current) coverStoreRef.current = new CoverStore();
  const coverStore = coverStoreRef.current;
  const [, forceCoverTick] = useState(0);
  useEffect(() => coverStore.subscribe(() => forceCoverTick((t) => t + 1)), [coverStore]);

  const room = state.room;
  const members = room?.members ?? [];
  // 权威角色来自服务端快照（房主离开会转移）；session.role 只作初始回退。
  // 媒体接线只依赖角色字符串：快照/成员变化不得重建媒体连接。
  const selfMember = members.find((m) => m.memberId === session.memberId);
  const selfRole = selfMember?.role ?? session.role;
  const isHost = selfRole === "host";
  const canPrepare = selfRole === "host" || selfRole === "co_dj";

  // 房主本机曲库（enabled 仅房主：成员不导入、不上报）
  const library = useHostLibrary(store, isHost);
  // 曲库/推进逻辑经 ref 供媒体接线读取，避免 library 状态变化重建媒体连接
  const libraryRef = useRef(library);
  libraryRef.current = library;

  useEffect(() => {
    store.connect();
    const timer = setInterval(() => {
      // 成员侧健康检查：音频连接 failed 时自动触发一次重新同步
      memberMediaRef.current?.controller.checkHealth();
      setTick((t) => t + 1);
    }, 500);
    return () => {
      clearInterval(timer);
      // 卸载≠离开：刷新/关闭页面走 offline 宽限期，保留会话供重连（D-009）
      store.disconnect();
    };
  }, [store]);

  // ---- 房主队列推进（Phase 3，D-012/D-013） ----

  const retryPendingRef = useRef(false);
  const failureCountRef = useRef(0);
  const autoSkipHandledRef = useRef<Set<string>>(new Set());
  const prevQueueLenRef = useRef<number | null>(null);

  /** 取下一首并发起屏障（房主是队列播放的执行者）；队列空则暂停。 */
  const advanceToNext = useCallback(
    (outcome: "played" | "skipped" | "none") => {
      const s = store.getState();
      const room = s.room;
      if (!room) return;
      if (outcome !== "none" && room.currentTrack) {
        store.trackFinished(outcome);
      }
      const mode = room.playMode ?? "order";
      if (mode === "repeat_one" && room.currentTrack) {
        const current = libraryRef.current.entries.find((e) => e.trackId === room.currentTrack!.trackId);
        if (current?.file) {
          failureCountRef.current = 0;
          setQueueNotice(null);
          store.prepareNext({ trackId: current.trackId, title: current.title, durationMs: current.durationMs });
          return;
        }
      }
      const queue = room.queue;
      if (queue.length === 0) {
        if (room.playing) store.pause();
        setQueueNotice("队列已播完。从曲库点歌或加入曲目后继续。");
        return;
      }
      // 随机播放选曲：非加密用途，Math.random 足够（不用于任何安全决策）
      const pick = (mode === "shuffle" ? queue[Math.floor(Math.random() * queue.length)] : queue[0]) ?? null;
      if (!pick) {
        if (room.playing) store.pause();
        setQueueNotice("队列已播完。从曲库点歌或加入曲目后继续。");
        return;
      }
      const file = libraryRef.current.entries.find((e) => e.trackId === pick.track.trackId)?.file;
      if (!file) {
        // 失败自动跳过：上报 failed（服务端移除条目），快照更新后重试下一首
        failureCountRef.current += 1;
        if (failureCountRef.current > queue.length) {
          setQueueNotice("队列中的曲目都缺少本地音频文件，已停止播放。请导入文件或清理队列。");
          if (room.playing) store.pause();
          failureCountRef.current = 0;
          return;
        }
        retryPendingRef.current = true;
        store.trackFinished("failed", pick.track.trackId);
        return;
      }
      failureCountRef.current = 0;
      setQueueNotice(null);
      store.prepareNext(pick.track);
    },
    [store],
  );
  const advanceRef = useRef(advanceToNext);
  advanceRef.current = advanceToNext;

  // 失败自动跳过的重试：服务端移除失败条目后队列长度减少
  useEffect(() => {
    if (!isHost) return;
    const len = room?.queue.length ?? 0;
    const prev = prevQueueLenRef.current;
    prevQueueLenRef.current = len;
    if (retryPendingRef.current && prev != null && len < prev) {
      retryPendingRef.current = false;
      advanceRef.current("none");
    }
  }, [room?.queue, isHost]);

  // 投票跳过通过（D-013）：房主端自动执行跳过并播下一首，每个 transitionId 一次
  useEffect(() => {
    if (!isHost) return;
    const sv = room?.skipVotes;
    if (!sv?.passed) return;
    if (autoSkipHandledRef.current.has(sv.transitionId)) return;
    autoSkipHandledRef.current.add(sv.transitionId);
    advanceRef.current("skipped");
  }, [room?.skipVotes, isHost]);

  // 仅供本地开发/端到端验证（import.meta.env.DEV，生产构建不含）：
  // 自动化测试无法操作系统文件选择器，改经此钩子走与真实导入完全相同的路径。
  useEffect(() => {
    if (!import.meta.env.DEV || !isHost) return;
    const target = window as unknown as {
      __listoImportAudio?: (url: string) => Promise<{ trackId: string; title: string; durationMs: number }>;
      __listoImportAudioSet?: (urls: string[]) => Promise<{ trackId: string; title: string; durationMs: number }[]>;
    };
    target.__listoImportAudio = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`读取音频失败：HTTP ${res.status}`);
      const blob = await res.blob();
      const name = decodeURIComponent(url.split("/").pop() ?? "e2e.wav");
      const imported = await libraryRef.current.importFiles([new File([blob], name, { type: blob.type || "audio/wav" })]);
      const first = imported[0];
      if (!first) throw new Error("音频导入失败（格式不支持或已损坏）");
      return first;
    };
    // 多文件导入（歌词自动检测 + ID3 封面 E2E 用）；与文件夹导入完全同路径
    target.__listoImportAudioSet = async (urls: string[]) => {
      const files: File[] = [];
      for (const url of urls) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`读取文件失败：HTTP ${res.status}`);
        const blob = await res.blob();
        const name = decodeURIComponent(url.split("/").pop() ?? "file.bin");
        files.push(new File([blob], name, { type: blob.type || "application/octet-stream" }));
      }
      const imported = await libraryRef.current.importFiles(files);
      if (imported.length === 0) throw new Error("导入失败（格式不支持或已损坏）");
      return imported;
    };
    return () => {
      delete target.__listoImportAudio;
      delete target.__listoImportAudioSet;
    };
  }, [store, isHost, session.memberId]);

  // 房主/成员媒体接线随角色切换（房主转移后旧房主停止发流，新房主加载文件后接管）
  useEffect(() => {
    if (selfRole === "host") {
      const handle = wireHostMedia(store, {
        getFile: (trackId) => libraryRef.current.entries.find((e) => e.trackId === trackId)?.file ?? null,
        onTrackMissing: (trackId) => setMissingBarrierTrack(trackId),
        getCoverBytes: (trackId) => libraryRef.current.getCoverBytes(trackId),
      });
      // 曲目自然播完 → 记录 played 并衔接下一首（Phase 3 队列衔接）
      handle.controller.onTrackEnded = () => advanceRef.current("played");
      hostMediaRef.current = handle;
      return () => {
        handle.dispose();
        hostMediaRef.current = null;
      };
    }
    const handle = wireMemberMedia(store, { coverStore });
    memberMediaRef.current = handle;
    return () => {
      handle.dispose();
      memberMediaRef.current = null;
    };
  }, [store, selfRole, coverStore]);

  // 切歌补发歌词（D-017）：屏障曲目变化时房主补发本地缓存（Relay 重启后兜底）
  const barrierTrackId = state.pendingPrepare?.track.trackId ?? null;
  const republishedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHost || !barrierTrackId || republishedForRef.current === barrierTrackId) return;
    republishedForRef.current = barrierTrackId;
    libraryRef.current.republishLyrics(barrierTrackId);
  }, [barrierTrackId, isHost]);

  // 调试状态（端到端证据采集用；不含任何凭证），每次刷新循环更新
  useEffect(() => {
    const target = window as unknown as { __listo?: unknown };
    const writeDebug = () => {
      const s = store.getState();
      target.__listo = {
        roomId,
        memberId: session.memberId,
        role: s.room?.members.find((m) => m.memberId === session.memberId)?.role ?? session.role,
        revision: s.room?.revision ?? null,
        playing: s.room?.playing ?? false,
        transitionId: s.room?.transitionId ?? null,
        lateJoin: s.lateJoin,
        positionMs: Math.round(store.livePositionMs()),
        serverNowMs: Math.round(store.serverNow()),
        currentTrack: s.room?.currentTrack ?? null,
        queue: s.room?.queue.map((e) => ({ title: e.track.title, by: e.requestedByName })) ?? [],
        pendingRequests: s.room?.pendingRequests?.length ?? 0,
        skipVotes: s.room?.skipVotes ?? null,
        playMode: s.room?.playMode ?? "order",
        chatCount: s.chat.length,
        roomLibrary: s.room?.library?.length ?? 0,
        library: libraryRef.current.debug(),
        lyrics: s.lyrics ? { trackId: s.lyrics.trackId, format: s.lyrics.format, bytes: s.lyrics.lyrics.length } : null,
        iceTurnEnabled: runtimeTurnEnabled(),
        host: hostMediaRef.current?.controller.debug() ?? null,
        member: memberMediaRef.current?.controller.debug() ?? null,
      };
    };
    writeDebug();
    const timer = setInterval(writeDebug, 500);
    return () => {
      clearInterval(timer);
      delete target.__listo;
    };
  }, [store, roomId, session.memberId, session.role]);

  useEffect(() => {
    let cancelled = false;
    roomApi
      .info(roomId)
      .then((info) => {
        if (!cancelled) setLocked(info.locked);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // ICE 配置（D-018）：进房拉取 TURN 短期凭据，TTL/2 周期刷新（钳制 5min..30min）；
  // 拉取失败保持既有配置（静态 VITE_ICE_SERVERS / 默认 STUN），不阻塞建联。
  useEffect(() => {
    if (!session.sessionToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const cfg = await iceApi.fetchConfig(session.sessionToken);
        if (cancelled) return;
        setRuntimeIceServers(
          cfg.iceServers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
          cfg.turnEnabled,
        );
        const delayMs = Math.min(30 * 60_000, Math.max(5 * 60_000, (cfg.ttlSeconds / 2) * 1000));
        timer = setTimeout(() => void pull(), delayMs);
      } catch {
        if (!cancelled) timer = setTimeout(() => void pull(), 60_000);
      }
    };
    void pull();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [session.sessionToken]);

  // ---- Phase 4：Media Session（媒体键/锁屏）、屏幕常亮、封面与歌词展示 ----

  const mediaSessionRef = useRef<MediaSessionController | null>(null);
  useEffect(() => {
    const session = (navigator as Navigator & { mediaSession?: Navigator["mediaSession"] | null }).mediaSession ?? null;
    if (!mediaSessionRef.current && session) {
      mediaSessionRef.current = new MediaSessionController({
        session,
        onPlay: () => hostPlayRef.current(),
        onPause: () => hostPauseRef.current(),
        onSeekTo: (pos) => hostSeekRef.current(pos),
        onSkipNext: () => hostSkipRef.current(),
      });
    }
    return () => {
      mediaSessionRef.current?.dispose();
      mediaSessionRef.current = null;
    };
  }, []);

  // 锁屏元数据随曲目变化；播放状态/进度每秒本地刷新（不上网络）
  const currentTrackId = room?.currentTrack?.trackId ?? null;
  useEffect(() => {
    mediaSessionRef.current?.setMetadata(
      room?.currentTrack
        ? { title: room.currentTrack.title, artist: room.currentTrack.artist, album: room.currentTrack.source?.platform }
        : null,
    );
  }, [room?.currentTrack]);
  useEffect(() => {
    const timer = setInterval(() => {
      mediaSessionRef.current?.setPlaybackState(
        room?.playing ?? false,
        Math.round(store.livePositionMs()),
        room?.currentTrack?.durationMs ?? 0,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [room?.playing, room?.currentTrack?.durationMs, store]);

  // 屏幕常亮（房主播放中）：纯增强，失败静默
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  useEffect(() => {
    if (isHost && room?.playing && !wakeLockRef.current) {
      void requestWakeLock().then((handle) => {
        wakeLockRef.current = handle;
      });
    } else if ((!room?.playing || !isHost) && wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, [isHost, room?.playing]);
  useEffect(
    () => () => {
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
    },
    [],
  );

  // 封面来源（D-016）：房主显示本机条目封面（ID3），成员显示 DataChannel 接收的封面；
  // 平台链接曲目各端直连加载 source.coverUrl（P-005：不经 DataChannel 转发）
  const currentTrack = room?.currentTrack ?? null;
  const hostOwnCoverUrl = isHost && currentTrackId
    ? (library.entries.find((e) => e.trackId === currentTrackId)?.coverUrl ?? null)
    : null;
  const receivedCoverUrl = coverStore.get(currentTrackId)?.url ?? null;
  const coverSrc = hostOwnCoverUrl ?? receivedCoverUrl ?? currentTrack?.source?.coverUrl ?? null;

  const onlineCount = members.filter((m) => m.status === "online").length;
  const readyCount = members.filter((m) => m.ready === true).length;
  const barrier = state.pendingPrepare;
  const durationMs = room?.currentTrack?.durationMs ?? 0;
  const positionMs = store.livePositionMs();
  const hostMedia = hostMediaRef.current;
  const memberMedia = memberMediaRef.current;

  // 迟到提示（D-004）：连接建立时歌曲已在播放中才提示，点击重新同步后不再打扰
  const lateJoin =
    !isHost && state.lateJoin && room?.transitionId != null && room.transitionId !== lateDismissedFor;

  // 屏障超时（D-011）：deadline 已过仍未全员就绪，房主可强制开始
  const barrierTimedOut = barrier != null && store.serverNow() > barrier.prepareDeadlineMs;

  // 屏障曲目在房主本机缺文件：明确提示（不 READY，等待导入或强制开始）
  const barrierFileMissing =
    isHost &&
    barrier != null &&
    !library.entries.some((e) => e.trackId === barrier.track.trackId && e.file != null);

  const hostDebug = hostMedia?.controller.debug() ?? null;
  const memberDebug = memberMedia?.controller.debug() ?? null;

  // 上一首（D-020）：从最近播放/跳过历史取可回放曲目；无则禁用按钮
  const previousTrack = previousTrackFromHistory(room?.history ?? []);

  // 房主上行带宽估算（D-020）：单流码率（文件大小×8÷时长）×已连接成员数
  const connectedPeers = hostDebug ? hostDebug.peers.filter((p) => p.state === "connected").length : 0;
  const currentFile = isHost && currentTrackId
    ? (library.entries.find((e) => e.trackId === currentTrackId)?.file ?? null)
    : null;
  const upstreamKbps = estimateHostUpstreamKbps(currentFile, durationMs, connectedPeers);
  const upstreamWarn = upstreamKbps != null && upstreamKbps > HOST_UPSTREAM_WARN_KBPS;

  async function withActionError(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message || "操作失败");
    }
  }

  function hostPlay() {
    if (!hostMedia) return;
    hostMedia.controller.playFrom(Math.round(store.livePositionMs()), store.serverNow());
    store.play();
  }

  function hostPause() {
    if (!hostMedia) return;
    hostMedia.controller.pause();
    store.pause();
  }

  function hostSeek(position: number) {
    if (!hostMedia) return;
    hostMedia.controller.seekTo(position, store.serverNow());
    store.seek(position);
  }

  function hostSkipCurrent() {
    advanceRef.current("skipped");
  }

  function memberResync() {
    memberMedia?.controller.requestResync();
    setLateDismissedFor(room?.transitionId ?? lateDismissedFor);
  }

  function leaveRoom() {
    clearSession(roomId);
    store.leave();
    navigate("/");
  }

  // 媒体键（MediaSession）回调经 ref 拿到最新渲染的播放函数
  const hostPlayRef = useRef(() => {});
  const hostPauseRef = useRef(() => {});
  const hostSeekRef = useRef((_pos: number) => {});
  const hostSkipRef = useRef(() => {});
  hostPlayRef.current = () => hostPlay();
  hostPauseRef.current = () => hostPause();
  hostSeekRef.current = (pos: number) => hostSeek(pos);
  hostSkipRef.current = () => hostSkipCurrent();

  return (
    <main className="page">
      <header className="room-header">
        <h1>房间 {roomId}</h1>
        <p>
          你是 <strong>{session.name}</strong>（{ROLE_LABEL[selfRole] ?? selfRole}） · 在线 {onlineCount}/{members.length}
        </p>
        <button type="button" onClick={leaveRoom} data-testid="leave-room">
          离开房间
        </button>
      </header>

      <section aria-live="polite" data-testid="connection-banner" className={`banner status-${state.status}`}>
        {STATUS_LABEL[state.status] ?? state.status}
        {state.status === "reconnecting" && `（第 ${state.reconnectAttempt} 次重试）`}
      </section>

      {state.fatalMessage && (
        <section role="alert" className="banner fatal" data-testid="fatal-banner">
          {state.fatalMessage}
          <div>
            {state.fatalKind === "retry_exhausted" && (
              <button type="button" onClick={() => store.retryReconnect()} data-testid="fatal-retry-btn">
                重试连接
              </button>
            )}
            <a href="/">返回首页</a>
          </div>
        </section>
      )}

      {state.lastError && (
        <section role="alert" className="banner warn" data-testid="error-banner">
          操作被拒绝：{state.lastError.message || state.lastError.code}
        </section>
      )}
      {actionError && (
        <section role="alert" className="banner warn" data-testid="action-error">
          {actionError}
        </section>
      )}

      {lateJoin && (
        <section className="banner warn" data-testid="late-join-banner">
          当前歌曲已开始，你从中途加入。点击“重新同步”接入当前音频（不会影响其他成员）。
        </section>
      )}

      {isHost && room?.currentTrack && hostDebug && !hostDebug.loadedCurrent && (
        <section className="banner warn" data-testid="host-audio-missing">
          房间已有播放中的曲目，但本机尚未加载对应的音频文件，成员将听不到声音。请在曲库中导入该文件并通过“下一首播放”切歌。
        </section>
      )}

      {barrierFileMissing && barrier && (
        <section className="banner warn" data-testid="barrier-file-missing">
          {barrier.track.source
            ? `下一首《${barrier.track.title}》来自平台链接：平台音频不能由本应用直接播放（合规边界，不绕过会员/DRM/地区限制），需要本机对应的音频文件才能全员播放。请导入同名文件（会自动绑定），或强制开始跳过本曲。`
            : `下一首《${barrier.track.title}》在本机没有对应的音频文件，无法准备。请导入同名文件（会自动绑定），或强制开始跳过本曲。`}
        </section>
      )}

      {queueNotice && isHost && (
        <section className="banner info" data-testid="queue-notice">
          {queueNotice}
        </section>
      )}

      <section className="card">
        <h2>正在播放</h2>
        {currentTrack ? (
          <div className="now-playing-row" data-testid="now-playing-row">
            {coverSrc ? (
              <img src={coverSrc} alt="专辑封面" className="cover" data-testid="now-playing-cover" />
            ) : (
              <div className="cover placeholder" data-testid="cover-placeholder" aria-label="封面占位" />
            )}
            <div>
              <p data-testid="now-playing">
                《{currentTrack.title}》
                {currentTrack.artist ? ` — ${currentTrack.artist}` : ""} ·{" "}
                {room?.playing ? "播放中" : "已暂停"} · {formatMs(positionMs)}
                {durationMs > 0 ? ` / ${formatMs(durationMs)}` : ""}
              </p>
              {currentTrack.source && (
                <p className="hint" data-testid="now-playing-source">
                  来自平台链接{describePlayability(currentTrack.source.playability)
                    ? ` · ${describePlayability(currentTrack.source.playability)?.label}`
                    : ""}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p data-testid="now-playing-empty">
            还没有播放中的歌曲。房主导入本地音频后，从曲库或队列“下一首播放”开始第一首歌。
          </p>
        )}
        {barrier && (
          <p className="banner info" data-testid="barrier-banner">
            准备下一首：《{barrier.track.title}》· 已就绪 {readyCount}/{onlineCount} ·{" "}
            {Math.max(0, Math.ceil((barrier.startAtMs - store.serverNow()) / 1000))} 秒后统一开始
            {barrierTimedOut ? " · 已超过准备截止时间" : ""}
            {canPrepare && barrierTimedOut && (
              <button type="button" onClick={() => store.forceStartBarrier()} data-testid="force-start-btn">
                立即开始（跳过未就绪成员）
              </button>
            )}
          </p>
        )}
        {canPrepare && !isHost && barrierTimedOut && readyCount === 0 && (
          <p className="hint" data-testid="co-dj-barrier-hint">
            仍无成员就绪：房主本机可能缺少这首歌的音频文件。可点“立即开始”直接跳过，或从队列移除后换一首。
          </p>
        )}
        {isHost && (
          <div className="controls" data-testid="host-controls">
            <button
              type="button"
              onClick={() => {
                if (previousTrack) {
                  store.prepareNext({
                    trackId: previousTrack.trackId,
                    title: previousTrack.title,
                    durationMs: previousTrack.durationMs,
                  });
                }
              }}
              disabled={!previousTrack}
              title={previousTrack ? `重新播放《${previousTrack.title}》` : "还没有可回放的播放记录"}
              data-testid="prev-track-btn"
            >
              上一首
            </button>
            <button type="button" onClick={hostPlay} data-testid="play-btn" disabled={!room?.currentTrack}>
              播放
            </button>
            <button type="button" onClick={hostPause} data-testid="pause-btn" disabled={!room?.currentTrack}>
              暂停
            </button>
            <label className="seek">
              进度
              <input
                type="range"
                min={0}
                max={durationMs > 0 ? durationMs : 100}
                value={Math.min(positionMs, durationMs > 0 ? durationMs : positionMs)}
                disabled={!room?.currentTrack || durationMs === 0}
                onChange={(e) => hostSeek(Number(e.target.value))}
                data-testid="seek-slider"
              />
            </label>
            <span className="hint" data-testid="host-audio-status">
              {hostDebug
                ? `音频服务：${hostDebug.peers.filter((p) => p.state === "connected").length}/${hostDebug.peers.length} 个连接已建立`
                : "音频未初始化"}
              {upstreamKbps != null ? ` · 预计上行 ≈ ${upstreamKbps >= 1000 ? (upstreamKbps / 1000).toFixed(1) + " Mbps" : upstreamKbps + " kbps"}` : ""}
            </span>
          </div>
        )}
        {upstreamWarn && (
          <p className="banner warn" data-testid="bandwidth-warn">
            在线成员较多，房主上行带宽可能不足（估算 ≈ {(upstreamKbps! / 1000).toFixed(1)} Mbps）。建议减少在线成员数，或使用较低码率的音频文件。
          </p>
        )}
        {!isHost && canPrepare && (
          <p className="hint" data-testid="co-dj-note">
            你可以审批点歌、管理队列并从曲库发起下一首（音频文件由房主本机提供）。
          </p>
        )}
      </section>

      {!isHost && (
        <section className="card" data-testid="member-audio">
          <h2>本机音频</h2>
          <p data-testid="audio-status">{memberAudioText(memberDebug)}</p>
          {memberMedia && memberMedia.controller.ctxState !== "running" && (
            <button type="button" onClick={() => memberMedia.controller.unlock()} data-testid="enable-sound">
              启用声音
            </button>
          )}
          <div className="controls">
            <label className="seek">
              音量
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={memberVolume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMemberVolume(v);
                  memberMedia?.controller.setVolume(v);
                }}
                data-testid="volume-slider"
              />
            </label>
            <label className="seek">
              <input
                type="checkbox"
                checked={memberMuted}
                onChange={(e) => {
                  setMemberMuted(e.target.checked);
                  memberMedia?.controller.setMuted(e.target.checked);
                }}
                data-testid="mute-toggle"
              />{" "}
              静音
            </label>
          </div>
        </section>
      )}

      <section className="card">
        <h2>成员</h2>
        <ul data-testid="member-list">
          {members.map((m) => (
            <li key={m.memberId} data-testid="member-item">
              <span className={`dot ${m.status}`} aria-label={m.status} />
              {m.name}
              <span className="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
              {barrier && m.ready !== undefined && <span className="badge">{m.ready ? "已就绪 ✓" : "准备中…"}</span>}
              {isHost && m.memberId !== session.memberId && (
                <span className="member-admin">
                  <button
                    type="button"
                    onClick={() => withActionError(() => roomApi.kick(roomId, session.sessionToken, m.memberId))}
                  >
                    踢出
                  </button>
                  {m.role !== "co_dj" && (
                    <button
                      type="button"
                      onClick={() => withActionError(() => roomApi.setRole(roomId, session.sessionToken, m.memberId, "co_dj"))}
                    >
                      设为共同 DJ
                    </button>
                  )}
                  {m.role !== "listener" && (
                    <button
                      type="button"
                      onClick={() => withActionError(() => roomApi.setRole(roomId, session.sessionToken, m.memberId, "listener"))}
                    >
                      设为听众
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        {!isHost && (
          <button type="button" onClick={memberResync} data-testid="resync-btn">
            重新同步（只影响自己）
          </button>
        )}
      </section>

      {isHost && (
        <section className="card">
          <h2>房主管理</h2>
          {session.inviteToken && (
            <p>
              邀请链接：
              <code data-testid="invite-link">
                {buildInviteLink(window.location.origin, roomId, session.inviteToken)}
              </code>{" "}
              <CopyButton text={buildInviteLink(window.location.origin, roomId, session.inviteToken)} />
            </p>
          )}
          <div className="controls">
            <button
              type="button"
              data-testid="lock-toggle"
              onClick={() =>
                withActionError(async () => {
                  const res = await roomApi.lock(roomId, session.sessionToken, !(locked ?? false));
                  setLocked(res.locked);
                })
              }
            >
              {locked ? "解锁房间" : "锁房（停止新成员加入）"}
            </button>
            <button
              type="button"
              data-testid="close-room"
              onClick={() => {
                if (!window.confirm("确定关闭房间？所有成员将被请出。")) return;
                withActionError(async () => {
                  await roomApi.close(roomId, session.sessionToken);
                  clearSession(roomId);
                  navigate("/");
                });
              }}
            >
              关闭房间
            </button>
          </div>
        </section>
      )}

      {isHost && <LibraryPanel store={store} library={library} />}
      {isHost && (
        <LinkResolver roomId={roomId} sessionToken={session.sessionToken} onAddToLibrary={(track) => library.addPlatformTrack(track)} />
      )}
      <OAuthPanel sessionToken={session.sessionToken} />
      <QueuePanel store={store} selfMemberId={session.memberId} selfRole={selfRole} onSkipCurrent={hostSkipCurrent} />
      <LyricsPanel store={store} positionMs={positionMs} />
      <ChatPanel store={store} selfMemberId={session.memberId} />

      <section className="card hint" data-testid="autoplay-notice">
        <h2>关于自动播放限制</h2>
        <p>
          浏览器通常会阻止未经交互的自动播放。若进入房间后没有声音，点击“启用声音”（成员）或导入本地文件（房主）
          即可解锁；音频连接状态见“本机音频”卡片。控制通道的同步不依赖该设置。
        </p>
      </section>
    </main>
  );
}

/** 成员音频状态行：把媒体控制器状态翻译成可操作的提示。 */
function memberAudioText(debug: MemberAudioDebug | null): string {
  if (!debug || debug.ctxState === "none") return "声音未启用：点击“启用声音”后可收听房主分享的音频。";
  if (debug.ctxState === "suspended") return "浏览器暂停了声音播放：请点击“启用声音”。";
  if (debug.pcState === "failed" || debug.pcState === "disconnected" || debug.pcState === "closed") {
    return "音频连接中断：正在尝试自动恢复；若长时间无声请点击“重新同步”。";
  }
  if (debug.pcState === "connected" && debug.hasTrack) {
    return debug.muted ? "音频已连接（已静音）。" : "音频已连接，正在接收房主分享的音频。";
  }
  if (debug.pcState === "connected") return "音频通道已建立，等待音频流…";
  return "正在建立音频连接…";
}

/**
 * Media Session（Phase 4）：媒体键/锁屏控制与元数据显示。
 * 纯集成层：navigator.mediaSession 不存在（旧浏览器/不支持的平台）时全部安全降级。
 * deps 全部可注入，单测覆盖决策逻辑。
 */

export interface MediaSessionTrackMeta {
  title: string;
  artist?: string;
  album?: string;
}

export interface MediaSessionDeps {
  session: Navigator["mediaSession"] | null | undefined;
  onPlay(): void;
  onPause(): void;
  onSeekTo(positionMs: number): void;
  onSkipNext(): void;
}

export class MediaSessionController {
  constructor(private readonly deps: MediaSessionDeps) {
    const session = deps.session;
    if (!session) return;
    try {
      session.setActionHandler("play", () => deps.onPlay());
      session.setActionHandler("pause", () => deps.onPause());
      if ("setActionHandler" in session) {
        // next/prev 与 seek 在部分平台不支持：忽略不支持错误
        this.safeSet("nexttrack", () => deps.onSkipNext());
        this.safeSet("seekto", (details: MediaSessionActionDetails) => {
          if (typeof details.seekTime === "number") deps.onSeekTo(details.seekTime * 1000);
        });
      }
    } catch {
      /* 环境不支持：全部降级为无媒体键 */
    }
  }

  private safeSet(action: MediaSessionAction, handler: (details: MediaSessionActionDetails) => void): void {
    try {
      this.deps.session?.setActionHandler(action, handler);
    } catch {
      /* 平台不支持该动作 */
    }
  }

  /** 更新锁屏/媒体中心元数据；无曲目时清空标题。 */
  setMetadata(track: MediaSessionTrackMeta | null): void {
    const session = this.deps.session;
    if (!session || !("metadata" in session)) return;
    try {
      session.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist ?? "",
            album: track.album ?? "",
          })
        : null;
    } catch {
      /* MediaMetadata 不存在（旧环境） */
    }
  }

  /** 播放状态与进度（锁屏进度条）；duration 未知时跳过。 */
  setPlaybackState(playing: boolean, positionMs: number, durationMs: number): void {
    const session = this.deps.session;
    if (!session) return;
    try {
      session.playbackState = playing ? "playing" : "paused";
      if (durationMs > 0 && "setPositionState" in session) {
        session.setPositionState({
          duration: durationMs / 1000,
          position: Math.min(positionMs, durationMs) / 1000,
          playbackRate: 1,
        });
      }
    } catch {
      /* 非法的 position state 忽略 */
    }
  }

  dispose(): void {
    const session = this.deps.session;
    if (!session) return;
    for (const action of ["play", "pause", "nexttrack", "seekto"] as MediaSessionAction[]) {
      try {
        session.setActionHandler(action, null);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** QueuePanel：共享队列、点歌审批、排序、投票跳过、播放模式与历史（Phase 3）。
 * 权限由服务端权威判定，这里按快照角色控制入口显隐（host/co_dj 管理操作）。 */
import { useSyncExternalStore } from "react";
import type { QueueEntry } from "@listogether/protocol";
import type { RoomStore } from "../../transport/ws/room-store";
import { formatMs } from "../../ui/format";

const ROLE_LABEL: Record<string, string> = { host: "房主", co_dj: "共同 DJ", listener: "听众" };

const OUTCOME_LABEL: Record<string, string> = {
  played: "已播完",
  skipped: "已跳过",
  failed: "播放失败",
  rejected: "已拒绝",
};

export interface QueuePanelProps {
  store: RoomStore;
  selfMemberId: string;
  selfRole: string;
  /** 房主的“跳过当前”入口（媒体执行在房主端，D-012）；非管理角色不显示按钮。 */
  onSkipCurrent: () => void;
}

export function canManageQueue(role: string): boolean {
  return role === "host" || role === "co_dj";
}

export default function QueuePanel({ store, selfMemberId, selfRole, onSkipCurrent }: QueuePanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const room = state.room;
  const manage = canManageQueue(selfRole);
  const queue = room?.queue ?? [];
  const pending = room?.pendingRequests ?? [];
  const history = [...(room?.history ?? [])].reverse(); // 最新在前
  const skipVotes = room?.skipVotes ?? null;
  const playMode = room?.playMode ?? "order";
  const onlineCount = room?.members.filter((m) => m.status === "online").length ?? 0;

  function move(entry: QueueEntry, delta: -1 | 1): void {
    const ids = queue.map((e) => e.entryId);
    const index = ids.indexOf(entry.entryId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const a = ids[index];
    const b = ids[target];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[target] = a;
    store.reorderQueue(ids);
  }

  return (
    <section className="card" data-testid="queue-panel">
      <h2>队列</h2>

      {(room?.library?.length ?? 0) > 0 && (
        <div className="queue-block" data-testid="request-section">
          <h3>从曲库点歌</h3>
          <ul>
            {room!.library!.map((entry) => (
              <li key={entry.trackId} data-testid="request-item">
                《{entry.title}》{entry.artist ? ` — ${entry.artist}` : ""}
                <span className="hint"> · {formatMs(entry.durationMs)}</span>
                <button
                  type="button"
                  onClick={() => store.requestTrack(entry.trackId)}
                  data-testid="request-track-btn"
                >
                  点歌
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending.length > 0 && (
        <div className="queue-block" data-testid="pending-requests">
          <h3>待审批（{pending.length}）</h3>
          <ul>
            {pending.map((e) => (
              <li key={e.entryId} data-testid="pending-item">
                《{e.track.title}》{e.track.artist ? ` — ${e.track.artist}` : ""} · {e.requestedByName}
                {manage ? (
                  <>
                    <button type="button" onClick={() => store.approveEntry(e.entryId)} data-testid="approve-btn">
                      批准
                    </button>
                    <button type="button" onClick={() => store.rejectEntry(e.entryId)} data-testid="reject-btn">
                      拒绝
                    </button>
                  </>
                ) : (
                  <span className="badge">等待房主审批</span>
                )}
                {(manage || e.requestedBy === selfMemberId) && (
                  <button type="button" onClick={() => store.removeEntry(e.entryId)} data-testid="pending-remove-btn">
                    撤销
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {queue.length === 0 ? (
        <p data-testid="queue-empty">队列为空。从曲库点歌，或由房主直接播放。</p>
      ) : (
        <ol data-testid="queue-list">
          {queue.map((e, index) => (
            <li key={e.entryId} data-testid="queue-item">
              <span className="queue-title">
                《{e.track.title}》{e.track.artist ? ` — ${e.track.artist}` : ""}
              </span>
              <span className="hint">
                {" "}
                · {formatMs(e.track.durationMs)} · 点歌：{e.requestedByName}
              </span>
              {manage && (
                <span className="member-admin">
                  <button
                    type="button"
                    onClick={() => move(e, -1)}
                    disabled={index === 0}
                    aria-label={`上移 ${e.track.title}`}
                    data-testid="move-up-btn"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(e, 1)}
                    disabled={index === queue.length - 1}
                    aria-label={`下移 ${e.track.title}`}
                    data-testid="move-down-btn"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => store.prepareNext(e.track)}
                    title="立即发起下一首屏障（插队播放）"
                    data-testid="play-now-btn"
                  >
                    下一首播放
                  </button>
                </span>
              )}
              {(manage || e.requestedBy === selfMemberId) && (
                <button type="button" onClick={() => store.removeEntry(e.entryId)} data-testid="queue-remove-btn">
                  移除
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="controls" data-testid="queue-tools">
        {manage ? (
          <>
            <label>
              播放模式{" "}
              <select
                value={playMode}
                onChange={(e) => store.setPlayMode(e.target.value as "order" | "repeat_one" | "shuffle")}
                data-testid="play-mode-select"
              >
                <option value="order">顺序播放</option>
                <option value="repeat_one">单曲循环</option>
                <option value="shuffle">随机播放</option>
              </select>
            </label>
            <button type="button" onClick={onSkipCurrent} data-testid="skip-btn">
              跳过当前
            </button>
            <button type="button" onClick={() => store.clearQueue()} data-testid="clear-queue-btn">
              清空队列
            </button>
          </>
        ) : (
          <button type="button" onClick={() => store.skipVote()} data-testid="skip-vote-btn" disabled={!room?.transitionId}>
            投票跳过当前歌曲
            {skipVotes && `（${skipVotes.memberIds.length}/${Math.max(2, Math.floor(onlineCount / 2) + 1)} 票）`}
          </button>
        )}
        {skipVotes && skipVotes.memberIds.length > 0 && (
          <span className="hint" data-testid="skip-votes-count">
            当前曲目跳过票数：{skipVotes.memberIds.length}
            {skipVotes.passed ? " · 已通过，即将跳过" : ""}
          </span>
        )}
      </div>

      {history.length > 0 && (
        <div className="queue-block" data-testid="queue-history">
          <h3>最近记录</h3>
          <ul>
            {history.slice(0, 10).map((h, i) => (
              <li key={`${h.atMs}-${i}`} data-testid="history-item">
                《{h.track.title}》
                {h.requestedByName ? ` · 点歌：${h.requestedByName}` : ""} ·{" "}
                <span className={`outcome outcome-${h.outcome}`}>{OUTCOME_LABEL[h.outcome] ?? h.outcome}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

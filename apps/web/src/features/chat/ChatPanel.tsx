/** ChatPanel：房间聊天与基础反应（Phase 3，D-013）。
 * 聊天是即时事件流（不进快照、不占 revision）；连接时由 CHAT_HISTORY 恢复最近记录。
 * 反应 = kind=reaction 的消息，由快捷按钮发送，不引入独立事件。 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RoomStore } from "../../transport/ws/room-store";

const REACTIONS = ["👍", "❤️", "🎉", "😂", "😮", "😢"] as const;

export default function ChatPanel({ store, selfMemberId }: { store: RoomStore; selfMemberId: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  // 新消息到达时滚动到底部（仅当用户接近底部，避免打断翻阅）
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [state.chat.length]);

  function send(kind: "text" | "reaction", value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (store.sendChat(kind, trimmed)) setText("");
  }

  return (
    <section className="card" data-testid="chat-panel">
      <h2>聊天</h2>
      <ol className="chat-list" ref={listRef} data-testid="chat-list">
        {state.chat.length === 0 ? (
          <li className="hint" data-testid="chat-empty">
            还没有消息。打个招呼吧。
          </li>
        ) : (
          state.chat.map((m) => (
            <li key={m.messageId} className={m.memberId === selfMemberId ? "chat-self" : undefined} data-testid="chat-item">
              {m.kind === "reaction" ? (
                <span className="chat-reaction">
                  {m.name} {m.text}
                </span>
              ) : (
                <>
                  <strong>{m.name}</strong>：{m.text}
                </>
              )}
            </li>
          ))
        )}
      </ol>
      <div className="controls" data-testid="chat-reactions">
        {REACTIONS.map((emoji) => (
          <button key={emoji} type="button" onClick={() => send("reaction", emoji)} data-testid={`reaction-${emoji}`}>
            {emoji}
          </button>
        ))}
      </div>
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          send("text", text);
        }}
      >
        <input
          type="text"
          value={text}
          maxLength={500}
          placeholder="说点什么…"
          onChange={(e) => setText(e.target.value)}
          data-testid="chat-input"
        />
        <button type="submit" disabled={!text.trim()} data-testid="chat-send-btn">
          发送
        </button>
      </form>
    </section>
  );
}

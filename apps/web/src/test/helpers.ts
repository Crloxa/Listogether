import { vi } from "vitest";

/** 模拟 Relay /healthz；body 为 null 时让 fetch 直接 reject。 */
export function stubRelayHealth(body: unknown, rejectWith?: Error) {
  const impl = rejectWith
    ? vi.fn().mockRejectedValue(rejectWith)
    : vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });
  vi.stubGlobal("fetch", impl);
  return impl;
}

export interface FetchRoute {
  /** URL 包含匹配。 */
  url: string;
  method?: string;
  status?: number;
  body?: unknown;
  rejectWith?: Error;
}

/** 按 URL 包含 + 方法路由的 fetch 桩；未匹配返回 404 JSON。 */
export function stubFetchApi(routes: FetchRoute[]) {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const route of routes) {
      if (!url.includes(route.url)) continue;
      if (route.method && route.method.toUpperCase() !== method) continue;
      if (route.rejectWith) throw route.rejectWith;
      const status = route.status ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => route.body,
      } as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ code: "ROOM_NOT_FOUND", message: "no route" }),
    } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

type WsHandler = ((ev: unknown) => void) | null;

/**
 * 受控 FakeWebSocket：测试拿到实例后手动触发 open/serverMessage/close，
 * 并读取客户端发出的帧。
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: WsHandler = null;
  onmessage: WsHandler = null;
  onclose: WsHandler = null;
  onerror: WsHandler = null;
  closedWith: { code: number; reason: string } | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get latest(): FakeWebSocket | undefined {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }

  /** 测试模拟连接建立。 */
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  /** 测试模拟服务端消息（对象将被 JSON 序列化）。 */
  simulateServerMessage(env: unknown) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }

  /** 测试模拟异常断线（如网络中断）。 */
  simulateAbnormalClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "" });
  }

  lastSent(): Record<string, unknown> | null {
    const last = this.sent[this.sent.length - 1];
    return last ? (JSON.parse(last) as Record<string, unknown>) : null;
  }

  sentTypes(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }
}

export function stubWebSocket() {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  return FakeWebSocket;
}

/** Relay HTTP 地址（API 与 healthz 用）。 */
export const relayBaseUrl: string = import.meta.env.VITE_RELAY_HTTP_URL ?? "http://localhost:8080";

/** 由 HTTP 地址推导 WebSocket 地址（http→ws，https→wss）。 */
export function relayWsUrl(path: string): string {
  return `${relayBaseUrl.replace(/^http/, "ws")}${path}`;
}


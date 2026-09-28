/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Relay HTTP 地址，用于 healthz 探测。 */
  readonly VITE_RELAY_HTTP_URL?: string;
  /** ICE 服务器列表（JSON RTCIceServer[]，D-010）；未配置用默认公共 STUN。 */
  readonly VITE_ICE_SERVERS?: string;
}

/**
 * 成员侧 PeerConnection：应答房主 offer、交换 ICE、回调远端轨道与连接状态。
 * 房主重新同步会发来新的 offer：旧连接关闭后用新连接替换。
 */
import { COVER_CHANNEL_LABEL } from "../cover-channel";

export interface MemberPeerDeps {
  iceServers: RTCIceServer[];
  sendAnswer(toMemberId: string, sdp: string): void;
  sendCandidate(toMemberId: string, candidate: string): void;
  onRemoteTrack(stream: MediaStream): void;
  onConnectionStateChange(state: RTCPeerConnectionState): void;
  /** 房主创建的 listo-data 通道（封面 P2P，D-016）。 */
  onDataChannel?(channel: RTCDataChannel): void;
}

export class MemberPeerManager {
  private pc: RTCPeerConnection | null = null;
  /** 当前 offer 来自的房主成员 ID（应答与 ICE 的目标）。 */
  private peerMemberId: string | null = null;

  constructor(private readonly deps: MemberPeerDeps) {}

  /** 当前连接状态；未建联时为 "none"。 */
  get connectionState(): RTCPeerConnectionState | "none" {
    return this.pc?.connectionState ?? "none";
  }

  /** 当前 ICE 连接状态；未建联时为 "none"。 */
  get iceState(): RTCIceConnectionState | "none" {
    return this.pc?.iceConnectionState ?? "none";
  }

  async handleOffer(fromMemberId: string, sdp: string): Promise<void> {
    this.close();
    const pc = new RTCPeerConnection({ iceServers: this.deps.iceServers });
    this.pc = pc;
    this.peerMemberId = fromMemberId;
    // 开发/端到端验证探针：供页面侧 getStats 诊断（生产构建不含）
    if (import.meta.env.DEV) {
      (window as unknown as { __listoMemberPc?: RTCPeerConnection }).__listoMemberPc = pc;
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) this.deps.onRemoteTrack(stream);
    };
    pc.onicecandidate = (event) => {
      const cand = event.candidate;
      if (cand && cand.candidate && this.peerMemberId) {
        this.deps.sendCandidate(this.peerMemberId, cand.candidate);
      }
    };
    pc.onconnectionstatechange = () => this.deps.onConnectionStateChange(pc.connectionState);
    pc.ondatachannel = (event) => {
      if (event.channel.label === COVER_CHANNEL_LABEL) this.deps.onDataChannel?.(event.channel);
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const answerSdp = pc.localDescription?.sdp;
    if (answerSdp && this.peerMemberId) this.deps.sendAnswer(this.peerMemberId, answerSdp);
  }

  async handleCandidate(candidate: string): Promise<void> {
    if (!this.pc || this.pc.signalingState === "closed") return;
    try {
      await this.pc.addIceCandidate({ candidate, sdpMid: "0", sdpMLineIndex: 0 });
    } catch {
      /* 无效候选忽略 */
    }
  }

  close(): void {
    const pc = this.pc;
    this.pc = null;
    this.peerMemberId = null;
    if (!pc) return;
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      /* 已关闭 */
    }
  }
}

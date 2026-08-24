import {
  parseRtcDataMessage,
  type ControllerRtcSignal,
  type RemoteEnvelope,
  type RemoteIceCandidate,
  type RemotePath,
  type ServerMessage,
} from "../app/remote/RemoteProtocol.ts";
import {
  createRemoteRtcConfiguration,
  serializeRemoteIceCandidate,
} from "../app/remote/WebRtcConfig.ts";
import type { RtcPeerConnectionFactory } from "../app/remote/WebRtcHost.ts";

const MAX_PENDING_ICE_CANDIDATES = 64;
const MAX_RTC_MESSAGES_PER_SECOND = 120;

export interface WebRtcControllerEvents {
  sendSignal(message: ControllerRtcSignal): boolean;
  onState(connected: boolean, path: RemotePath): void;
}

/** Controller側の単一Host peerとDataChannelを管理する */
export class WebRtcController {
  private readonly events: WebRtcControllerEvents;
  private readonly peerFactory: RtcPeerConnectionFactory;
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private rtcSessionId: string | null = null;
  private answerSent = false;
  private connected = false;
  private rateStartedAt = 0;
  private rateCount = 0;
  private readonly pendingLocalCandidates: RemoteIceCandidate[] = [];
  private readonly pendingRemoteCandidates: RemoteIceCandidate[] = [];

  constructor(events: WebRtcControllerEvents, peerFactory: RtcPeerConnectionFactory = (configuration) => new RTCPeerConnection(configuration)) {
    this.events = events;
    this.peerFactory = peerFactory;
  }

  /** Host offerから直接接続peerを作りanswerをsignalingへ返す */
  async handleOffer(message: Extract<ServerMessage, { type: "rtcOffer" }>): Promise<void> {
    this.closePeerOnly();
    this.rtcSessionId = message.rtcSessionId;
    const connection = this.peerFactory(createRemoteRtcConfiguration());
    this.connection = connection;
    this.answerSent = false;
    connection.addEventListener("datachannel", (event) => this.acceptChannel(connection, event.channel));
    connection.addEventListener("icecandidate", (event) => this.sendCandidate(connection, event.candidate));
    connection.addEventListener("connectionstatechange", () => this.handleConnectionState(connection));
    try {
      await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
      await this.flushRemoteCandidates(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const sdp = connection.localDescription?.sdp;
      if (!sdp || this.connection !== connection || this.rtcSessionId !== message.rtcSessionId || !this.events.sendSignal({
        v: 1,
        type: "rtcAnswer",
        rtcSessionId: message.rtcSessionId,
        sdp,
      })) {
        this.closePeerOnly();
        return;
      }
      this.answerSent = true;
      for (const candidate of this.pendingLocalCandidates.splice(0)) {
        this.events.sendSignal({ v: 1, type: "rtcIceCandidate", rtcSessionId: message.rtcSessionId, candidate });
      }
    } catch {
      this.closePeerOnly();
    }
  }

  /** 現在negotiation世代のHost ICEだけを適用する */
  async handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    if (this.rtcSessionId !== message.rtcSessionId) return;
    if (!connection.remoteDescription) {
      if (this.pendingRemoteCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeerOnly();
        return;
      }
      this.pendingRemoteCandidates.push(message.candidate);
      return;
    }
    try {
      await connection.addIceCandidate(message.candidate);
    } catch {
      this.closePeerOnly();
    }
  }

  /** RemoteEnvelopeをreliable ordered channelへ送る */
  send(envelope: RemoteEnvelope): boolean {
    return this.sendData({ v: 1, type: "remote", envelope });
  }

  /** peerとDataChannelを破棄する */
  close(): void {
    this.closePeerOnly();
  }

  private acceptChannel(connection: RTCPeerConnection, channel: RTCDataChannel): void {
    if (this.connection !== connection || channel.label !== "remote") {
      channel.close();
      return;
    }
    this.channel?.close();
    this.channel = channel;
    channel.addEventListener("open", () => {
      if (this.connection !== connection || this.channel !== channel) return;
      this.setConnected(true);
    });
    channel.addEventListener("close", () => this.handleChannelClosed(channel));
    channel.addEventListener("error", () => this.handleChannelClosed(channel));
    channel.addEventListener("message", (event) => this.handleData(event.data));
  }

  private handleData(data: unknown): void {
    if (!this.acceptDataMessage()) return;
    const message = parseRtcDataMessage(data);
    if (!message) return;
    if (message.type === "ping") this.sendData({ v: 1, type: "pong", nonce: message.nonce });
  }

  /** schema検証前に過剰なDataChannel frameを落とす */
  private acceptDataMessage(): boolean {
    const now = performance.now();
    if (now - this.rateStartedAt >= 1_000) {
      this.rateStartedAt = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    return this.rateCount <= MAX_RTC_MESSAGES_PER_SECOND;
  }

  private sendData(message: unknown): boolean {
    if (!this.channel || this.channel.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendCandidate(connection: RTCPeerConnection, candidate: RTCIceCandidate | null): void {
    if (!candidate || this.connection !== connection || !this.rtcSessionId) return;
    const init = serializeRemoteIceCandidate(candidate);
    if (!this.answerSent) {
      if (this.pendingLocalCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeerOnly();
        return;
      }
      this.pendingLocalCandidates.push(init);
      return;
    }
    this.events.sendSignal({ v: 1, type: "rtcIceCandidate", rtcSessionId: this.rtcSessionId, candidate: init });
  }

  private handleConnectionState(connection: RTCPeerConnection): void {
    if (this.connection !== connection) return;
    if (connection.connectionState === "failed" || connection.connectionState === "closed") this.closePeerOnly();
  }

  private handleChannelClosed(channel: RTCDataChannel): void {
    if (this.channel !== channel) return;
    this.closePeerOnly();
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.events.onState(connected, connected ? "DIRECT" : "UNKNOWN");
  }

  private async flushRemoteCandidates(connection: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingRemoteCandidates.splice(0)) await connection.addIceCandidate(candidate);
  }

  private closePeerOnly(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.pendingLocalCandidates.length = 0;
    this.pendingRemoteCandidates.length = 0;
    this.answerSent = false;
    this.rateStartedAt = 0;
    this.rateCount = 0;
    this.rtcSessionId = null;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    try { channel?.close(); } catch { /* noop */ }
    try { connection?.close(); } catch { /* noop */ }
    if (wasConnected) this.events.onState(false, "UNKNOWN");
  }
}

import {
  isTerminalControllerClose,
  joinRoomResponseSchema,
  parseServerMessage,
  remoteInitialConnectTimeoutMs,
  remoteSessionTimeoutMs,
  type RemoteCommand,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol.ts";
import { WebSocketTransport, type RemoteTransport } from "../app/remote/WebSocketTransport.ts";
import { ControllerCommandSender } from "./ControllerCommandSender.ts";
import { WebRtcController } from "./WebRtcController.ts";

export interface ControllerConnectionEvents {
  onStatus(status: "joining" | "connecting" | "connected" | "disconnected" | "error", detail?: string): void;
  onPermissions(permissions: RemotePermissions): void;
  onWebRtcState(connected: boolean): void;
}

/** JOINとWebRTC signalingを管理する */
export class ControllerConnection {
  private readonly baseUrl = import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
  private readonly events: ControllerConnectionEvents;
  private transport: RemoteTransport | null = null;
  private readonly commands: ControllerCommandSender;
  private readonly webRtc: WebRtcController;
  private controllerSessionId: string | null = null;
  private destroyed = false;
  private expiryTimer: number | null = null;
  private readyTimer: number | null = null;

  constructor(events: ControllerConnectionEvents) {
    this.events = events;
    this.webRtc = new WebRtcController({
      sendSignal: (message) => this.transport?.send(message) ?? false,
      onState: (connected) => this.events.onWebRtcState(connected),
      onFailure: () => this.events.onStatus("error", "WebRTC direct connection failed"),
    });
    this.commands = new ControllerCommandSender((envelope) => this.webRtc.send(envelope));
  }

  /** QR secretを短期session ticketへ交換してWebSocket control planeへ接続する */
  async join(roomId: string, joinSecret: string): Promise<void> {
    if (!this.baseUrl) throw new Error("VITE_REMOTE_BASE_URL is not configured");
    this.events.onStatus("joining");
    const response = await fetch(new URL(`v1/rooms/${encodeURIComponent(roomId)}/join`, this.withTrailingSlash(this.baseUrl)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinSecret }),
    });
    if (this.destroyed) return;
    if (!response.ok) {
      throw new Error(response.status === 403
        ? "QR expired, JOIN closed, or room expired"
        : `JOIN failed (${response.status})`);
    }
    const parsed = joinRoomResponseSchema.safeParse(await response.json());
    if (this.destroyed) return;
    if (!parsed.success || parsed.data.roomId !== roomId) throw new Error("Invalid JOIN response");
    this.commands.setPermissions(parsed.data.permissions);
    this.controllerSessionId = parsed.data.controllerSessionId;
    this.events.onPermissions(parsed.data.permissions);
    this.connect(roomId, parsed.data.sessionTicket);
    this.scheduleExpiry(parsed.data.expiresAt);
    this.scheduleReadyDeadline(parsed.data.connectBy);
  }

  sendCommand(command: RemoteCommand): boolean {
    return this.commands.send(command);
  }

  /** Controller sessionの接続資源を破棄する */
  destroy(): void {
    this.destroyed = true;
    this.cleanupConnection();
  }

  private connect(roomId: string, sessionTicket: string): void {
    this.events.onStatus("connecting");
    this.transport = new WebSocketTransport({
      baseUrl: this.baseUrl,
      roomId,
      sessionTicket,
      events: {
        onOpen: () => this.events.onStatus("connecting"),
        onClose: (event) => {
          if (this.destroyed) return;
          if (isTerminalControllerClose(event.code)) this.endSession(event.code === 4002 ? "Remote session opened elsewhere" : "Remote session expired");
          else this.disconnectSession("Re-scan the QR to reconnect");
        },
        onError: () => { if (!this.destroyed) this.events.onStatus("disconnected"); },
        onMessage: (data) => this.handleMessage(data),
      },
    });
  }

  private scheduleExpiry(expiresAt: number): void {
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) return this.endSession("Remote session expired");
    this.expiryTimer = window.setTimeout(() => this.endSession("Remote session expired"), remaining);
  }

  private scheduleReadyDeadline(connectBy: number): void {
    const remaining = remoteInitialConnectTimeoutMs(connectBy);
    if (remaining <= 0) return this.endSession("Remote connection ticket expired");
    this.readyTimer = window.setTimeout(() => this.endSession("Remote connection ticket expired"), remaining);
  }

  /** terminal errorとしてsessionを終了する */
  private endSession(detail: string): void {
    this.finishSession("error", detail);
  }

  /** 再JOINが必要な切断としてsessionを終了する */
  private disconnectSession(detail: string): void {
    this.finishSession("disconnected", detail);
  }

  /** cleanup後に終了理由ごとのstatusを一度だけ通知する */
  private finishSession(status: "error" | "disconnected", detail: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanupConnection();
    this.events.onStatus(status, detail);
  }

  /** session timerと全transportを同じ順序で解放する */
  private cleanupConnection(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
    this.expiryTimer = null;
    this.readyTimer = null;
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.webRtc.close();
  }

  /** server stateをHost authorityとして適用する */
  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    if (message.type === "ready" && message.role === "controller") {
      if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.commands.setPermissions(message.permissions);
      this.events.onPermissions(message.permissions);
      this.events.onStatus("connecting");
    } else if (message.type === "rtcOffer" && message.controllerSessionId === this.controllerSessionId) {
      void this.webRtc.handleOffer(message);
    } else if (message.type === "rtcIceCandidate" && message.controllerSessionId === this.controllerSessionId) {
      void this.webRtc.handleCandidate(message);
    } else if (message.type === "error") {
      this.events.onStatus("error", message.message);
    }
  }

  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}

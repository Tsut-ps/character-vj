import PartySocket from "partysocket";
import { REMOTE_TICKET_PROTOCOL_PREFIX } from "./RemoteProtocol.ts";

export interface RemoteTransportEvents {
  /** WebSocket OPENを通知する */
  onOpen(): void;
  /** WebSocket close情報を通知する */
  onClose(event: CloseEvent): void;
  /** 受信payloadを未解釈のまま通知する */
  onMessage(data: unknown): void;
  /** transport errorを通知する */
  onError(): void;
}

export interface RemoteTransport {
  readonly isOpen: boolean;
  /** signaling messageをOPEN時だけ送る */
  send(message: unknown): boolean;
  /** reconnectを停止してtransportを閉じる */
  close(): void;
}

export interface WebSocketTransportOptions {
  baseUrl: string;
  roomId: string;
  sessionTicket: string;
  autoReconnect?: boolean;
  events: RemoteTransportEvents;
}

export type RemoteTransportFactory = (options: WebSocketTransportOptions) => RemoteTransport;

/** 将来差し替え可能なstale送信を保持しないPartySocket transport */
export class WebSocketTransport implements RemoteTransport {
  private readonly socket: PartySocket;

  /** Worker originとsession ticketからbufferなしPartySocketを作る */
  constructor(options: WebSocketTransportOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Remote URL must be HTTP(S)");
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("VITE_REMOTE_BASE_URL must be an origin without credentials or path");
    }
    this.socket = new PartySocket({
      host: url.host,
      protocol: url.protocol === "https:" ? "wss" : "ws",
      party: "room",
      room: options.roomId,
      protocols: [`${REMOTE_TICKET_PROTOCOL_PREFIX}${options.sessionTicket}`],
      maxEnqueuedMessages: 0,
      minReconnectionDelay: 600,
      maxReconnectionDelay: 5_000,
      connectionTimeout: 5_000,
      maxRetries: options.autoReconnect === false ? 0 : undefined,
    });
    this.socket.addEventListener("open", () => options.events.onOpen());
    this.socket.addEventListener("close", (event) => options.events.onClose(event));
    this.socket.addEventListener("message", (event) => options.events.onMessage(event.data));
    this.socket.addEventListener("error", () => options.events.onError());
  }

  /** 現在のWebSocket OPEN状態を返す */
  get isOpen(): boolean {
    return this.socket.readyState === 1;
  }

  /** signaling payloadをOPEN時だけ送り再接続後は呼び出し側で再同期する */
  send(message: unknown): boolean {
    return this.sendOnlyWhenOpen(message);
  }

  /** PartySocketの自動reconnectを停止する */
  close(): void {
    this.socket.close(1000, "client shutdown");
  }

  /** CLOSED中はsend自体を呼ばずPartySocket queueを迂回する */
  private sendOnlyWhenOpen(message: unknown): boolean {
    if (!this.isOpen) return false;
    const encoded = JSON.stringify(message);
    try {
      this.socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }
}

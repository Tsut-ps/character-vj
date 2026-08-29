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
  events: RemoteTransportEvents;
}

export type RemoteTransportFactory = (options: WebSocketTransportOptions) => RemoteTransport;

/** Worker signaling専用の再接続しないWebSocket transport */
export class WebSocketTransport implements RemoteTransport {
  private readonly socket: WebSocket;

  /** Worker originとsession ticketから標準WebSocketを作る */
  constructor(options: WebSocketTransportOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Remote URL must be HTTP(S)");
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("VITE_REMOTE_BASE_URL must be an origin without credentials or path");
    }
    const socketUrl = new URL(`/parties/room/${encodeURIComponent(options.roomId)}`, url.origin);
    socketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(socketUrl, [`${REMOTE_TICKET_PROTOCOL_PREFIX}${options.sessionTicket}`]);
    this.socket.addEventListener("open", () => options.events.onOpen());
    this.socket.addEventListener("close", (event) => options.events.onClose(event));
    this.socket.addEventListener("message", (event) => options.events.onMessage(event.data));
    this.socket.addEventListener("error", () => options.events.onError());
  }

  /** 現在のWebSocket OPEN状態を返す */
  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** signaling payloadをOPEN時だけ送り再接続後は呼び出し側で再同期する */
  send(message: unknown): boolean {
    if (!this.isOpen) return false;
    const encoded = JSON.stringify(message);
    try {
      this.socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  /** signaling接続を明示的に閉じる */
  close(): void {
    try { this.socket.close(1000, "client shutdown"); } catch { /* noop */ }
  }
}

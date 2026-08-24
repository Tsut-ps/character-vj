import QRCode from "qrcode";
import type { RemoteHostElements } from "../ui/createVjUi.ts";
import { RemoteInputAdapter } from "./RemoteInputAdapter.ts";
import {
  createRoomResponseSchema,
  DEFAULT_REMOTE_PERMISSIONS,
  hostTicketResponseSchema,
  parseServerMessage,
  remoteSessionTimeoutMs,
  type HostClientMessage,
  type RemotePermissions,
  type ServerMessage,
} from "./RemoteProtocol.ts";
import {
  WebSocketTransport,
  type RemoteTransport,
  type RemoteTransportFactory,
  type WebSocketTransportOptions,
} from "./WebSocketTransport.ts";
import {
  WebRtcHost,
  type RemoteWebRtcHost,
  type WebRtcHostEvents,
  type WebRtcHostFactory,
} from "./WebRtcHost.ts";

interface PendingRequest {
  resolve: (message: Extract<ServerMessage, { type: "hostAck" }>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteManagerDependencies {
  baseUrl?: string;
  fetch?: typeof fetch;
  transportFactory?: RemoteTransportFactory;
  createQr?: (value: string) => Promise<string>;
  controllerUrl?: () => URL;
  webRtcFactory?: WebRtcHostFactory;
}

/** Host remote session、QR、permissions、transport、RTTを管理する */
export class RemoteManager {
  private readonly ui: RemoteHostElements;
  private readonly adapter: RemoteInputAdapter;
  private readonly log: (message: string) => void;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transportFactory: RemoteTransportFactory;
  private readonly createQr: (value: string) => Promise<string>;
  private readonly controllerUrl: () => URL;
  private readonly webRtc: RemoteWebRtcHost;
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private session: {
    roomId: string;
    hostToken: string;
    expiresAt: number;
  } | null = null;
  private transport: RemoteTransport | null = null;
  private ready = false;
  private joinOpen = false;
  private joinVisible = false;
  private destroyed = false;
  private readonly controllers = new Set<string>();
  private readonly rttByController = new Map<string, number>();
  private readonly webRtcByController = new Map<string, boolean>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;

  constructor(
    ui: RemoteHostElements,
    adapter: RemoteInputAdapter,
    log: (message: string) => void,
    signal: AbortSignal,
    dependencies: RemoteManagerDependencies = {},
  ) {
    this.ui = ui;
    this.adapter = adapter;
    this.log = log;
    this.baseUrl =
      dependencies.baseUrl ??
      import.meta.env.VITE_REMOTE_BASE_URL?.trim() ??
      "";
    this.fetchImpl =
      dependencies.fetch ?? ((input, init) => fetch(input, init));
    this.transportFactory =
      dependencies.transportFactory ??
      ((options: WebSocketTransportOptions) => new WebSocketTransport(options));
    this.createQr =
      dependencies.createQr ??
      ((value) =>
        QRCode.toDataURL(value, {
          width: 420,
          margin: 2,
          errorCorrectionLevel: "M",
        }));
    this.controllerUrl =
      dependencies.controllerUrl ??
      (() =>
        new URL(
          `${import.meta.env.BASE_URL}controller.html`,
          window.location.origin,
        ));
    const webRtcEvents: WebRtcHostEvents = {
      sendSignal: (message) => this.transport?.send(message) ?? false,
      onEnvelope: (controllerSessionId, envelope) => this.adapter.handle(controllerSessionId, envelope),
      onState: (controllerSessionId, connected) =>
        this.handleWebRtcState(controllerSessionId, connected),
      onLatency: (controllerSessionId, rttMs) =>
        this.handleWebRtcLatency(controllerSessionId, rttMs),
    };
    this.webRtc =
      dependencies.webRtcFactory?.(webRtcEvents) ??
      new WebRtcHost(webRtcEvents);
    this.adapter.setPermissions(this.permissions);
    this.syncPermissionInputs();

    this.ui.startButton.addEventListener(
      "click",
      () => this.toggleRemote(),
      { signal },
    );
    this.ui.showQrButton.addEventListener("click", () => void this.showQr(), {
      signal,
    });
    this.ui.closeQrButton.addEventListener("click", () => void this.closeQr(), {
      signal,
    });
    for (const input of Object.values(this.ui.permissionInputs)) {
      input.addEventListener(
        "change",
        () => this.updatePermissionsFromUi(),
        { signal },
      );
    }
    this.renderConnectionSummary();
    this.renderControllerState();
    this.renderRemoteToggle(false);
    this.renderStatus("OFFLINE");
    if (!this.baseUrl) {
      this.renderStatus("NOT CONFIGURED");
      this.ui.showQrButton.disabled = true;
      this.ui.startButton.title = "Set VITE_REMOTE_BASE_URL at build time";
    } else {
      this.ui.showQrButton.disabled = true;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ready && this.joinOpen)
      this.transport?.send({
        v: 1,
        type: "closeJoin",
        requestId: crypto.randomUUID(),
      });
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.adapter.resetSession();
    this.webRtc.destroy();
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.rejectPending("Remote manager destroyed");
    this.rejectReadyWaiters("Remote manager destroyed");
  }

  /** Remote sessionのONとOFFを現在状態から切り替える */
  private toggleRemote(): void {
    if (this.session || this.transport || this.reconnecting) {
      this.stopRemote();
      return;
    }
    void this.startRemote();
  }

  /** JOINを閉じてRemote sessionを手動終了する */
  private stopRemote(): void {
    if (this.ready && this.joinOpen) {
      this.transport?.send({
        v: 1,
        type: "closeJoin",
        requestId: crypto.randomUUID(),
      });
    }
    this.endSession("OFFLINE");
    this.log("REMOTE OFFLINE");
  }

  private async startRemote(): Promise<void> {
    if (this.destroyed || !this.baseUrl || this.session || this.transport)
      return;
    this.renderRemoteToggle(false, true);
    this.setPermissionInputsDisabled(true);
    this.renderStatus("STARTING");
    try {
      await this.ensureSession();
      await this.waitUntilReady();
      this.renderStatus("ONLINE");
      this.ui.showQrButton.disabled = false;
      this.log("REMOTE ONLINE");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Remote start failed";
      this.endSession("ERROR");
      this.log(`REMOTE ERROR / ${message}`);
    } finally {
      this.renderRemoteToggle(Boolean(this.session));
    }
  }

  private async showQr(): Promise<void> {
    if (this.destroyed || !this.ready || !this.session || this.joinVisible)
      return;
    this.ui.showQrButton.disabled = true;
    try {
      const ack = await this.request({
        v: 1,
        type: "openJoin",
        requestId: crypto.randomUUID(),
      });
      if (!ack.ok || !ack.joinSecret || !this.session)
        throw new Error(ack.error ?? "OPEN JOIN failed");
      this.joinOpen = true;
      this.ui.join.textContent = "OPEN";
      const controllerUrl = this.controllerUrl();
      controllerUrl.hash = new URLSearchParams({
        room: this.session.roomId,
        join: ack.joinSecret,
      }).toString();
      const qrDataUrl = await this.createQr(controllerUrl.toString());
      if (this.destroyed) return;
      this.ui.qrImage.src = qrDataUrl;
      this.ui.qrRoom.textContent = `ROOM ${this.session.roomId}`;
      this.ui.qrStatus.textContent = "JOIN OPEN";
      this.ui.qrOverlay.hidden = false;
      this.joinVisible = true;
      this.ui.showQrButton.textContent = "QR表示中";
      this.renderStatus("ONLINE");
      this.log("REMOTE JOIN OPEN");
    } catch (error) {
      if (this.joinOpen && this.ready) {
        try {
          await this.request({
            v: 1,
            type: "closeJoin",
            requestId: crypto.randomUUID(),
          });
        } catch {
          /* Host切断時はserver側でもJOINを閉じる */
        }
      }
      this.joinOpen = false;
      this.ui.join.textContent = "CLOSED";
      this.hideQrView();
      this.renderStatus("ERROR");
      this.log(
        `REMOTE ERROR / ${error instanceof Error ? error.message : "Remote connection failed"}`,
      );
    } finally {
      this.ui.showQrButton.disabled = this.joinVisible || !this.ready;
    }
  }

  private async closeQr(): Promise<void> {
    if (!this.joinVisible || !this.ready) return;
    this.ui.closeQrButton.disabled = true;
    this.ui.qrStatus.textContent = "CLOSING JOIN…";
    try {
      const ack = await this.request({
        v: 1,
        type: "closeJoin",
        requestId: crypto.randomUUID(),
      });
      if (!ack.ok) throw new Error(ack.error ?? "CLOSE JOIN failed");
      this.joinOpen = false;
      this.ui.join.textContent = "CLOSED";
      this.hideQrView();
      this.renderStatus("ONLINE");
      this.log("REMOTE JOIN CLOSED");
    } catch (error) {
      this.renderStatus("ERROR");
      this.ui.qrStatus.textContent =
        error instanceof Error ? error.message : "CLOSE FAILED";
    } finally {
      this.ui.closeQrButton.disabled = false;
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.transport) return;
    const response = await this.fetchImpl(
      new URL("v1/rooms", this.withTrailingSlash(this.baseUrl)),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: this.permissions }),
      },
    );
    if (!response.ok)
      throw new Error(`Room create failed (${response.status})`);
    const parsed = createRoomResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid room create response");
    this.session = {
      roomId: parsed.data.roomId,
      hostToken: parsed.data.hostToken,
      expiresAt: parsed.data.expiresAt,
    };
    this.connect(parsed.data.sessionTicket);
    this.scheduleExpiry(parsed.data.expiresAt);
  }

  private connect(sessionTicket: string): void {
    if (!this.session) throw new Error("Missing room id");
    let transport: RemoteTransport;
    transport = this.transportFactory({
      baseUrl: this.baseUrl,
      roomId: this.session.roomId,
      sessionTicket,
      events: {
        onOpen: () => {
          if (this.transport === transport)
            this.renderStatus("AUTHENTICATING");
        },
        onClose: (event) => {
          if (this.transport === transport) this.handleClose(event);
        },
        onMessage: (data) => {
          if (this.transport === transport) this.handleMessage(data);
        },
        onError: () => {
          if (!this.destroyed && this.transport === transport)
            this.renderStatus("RECONNECTING");
        },
      },
    });
    this.transport = transport;
  }

  private handleClose(event: CloseEvent): void {
    if (this.destroyed || !this.transport || !this.session) return;
    if (
      event.code === 4001 ||
      event.code === 4003 ||
      event.code === 4401 ||
      event.code === 4403
    ) {
      this.endSession(
        event.code === 4001 ? "HOST REPLACED" : "SESSION EXPIRED",
      );
      return;
    }
    this.transport = null;
    this.ready = false;
    this.joinOpen = false;
    this.ui.join.textContent = "CLOSED";
    this.adapter.releaseAllControllers();
    this.clearControllerConnections();
    this.rejectPending("Remote connection closed");
    this.hideQrView();
    this.renderStatus("RECONNECTING");
    this.ui.showQrButton.disabled = true;
    void this.reconnectHost();
  }

  private async reconnectHost(): Promise<void> {
    if (this.reconnecting || this.destroyed || !this.session) return;
    this.reconnecting = true;
    const session = this.session;
    try {
      const response = await this.fetchImpl(
        new URL(
          `v1/rooms/${encodeURIComponent(session.roomId)}/host-ticket`,
          this.withTrailingSlash(this.baseUrl),
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostToken: session.hostToken }),
        },
      );
      if (!response.ok)
        throw new Error(`Host reconnect failed (${response.status})`);
      const parsed = hostTicketResponseSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.roomId !== session.roomId ||
        this.session !== session
      )
        throw new Error("Invalid host ticket response");
      this.connect(parsed.data.sessionTicket);
    } catch (error) {
      if (this.session === session) {
        this.log(
          `REMOTE ERROR / ${error instanceof Error ? error.message : "Remote reconnect error"}`,
        );
        this.endSession("DISCONNECTED");
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private scheduleExpiry(expiresAt: number): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) return this.endSession("SESSION EXPIRED");
    this.expiryTimer = setTimeout(
      () => this.endSession("SESSION EXPIRED"),
      remaining,
    );
  }

  private endSession(status: string): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.ready = false;
    this.joinOpen = false;
    this.ui.join.textContent = "CLOSED";
    this.adapter.resetSession();
    this.clearControllerConnections();
    this.rejectPending("Remote session ended");
    this.rejectReadyWaiters("Remote session ended");
    this.hideQrView();
    const transport = this.transport;
    this.transport = null;
    this.session = null;
    transport?.close();
    this.renderStatus(status);
    this.renderRemoteToggle(false);
    this.ui.showQrButton.disabled = true;
    this.setPermissionInputsDisabled(false);
  }

  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    switch (message.type) {
      case "ready":
        if (message.role !== "host") return;
        this.ready = true;
        this.permissions = message.permissions;
        this.adapter.setPermissions(message.permissions);
        this.syncPermissionInputs();
        this.renderStatus("ONLINE");
        this.renderRemoteToggle(true);
        this.ui.showQrButton.disabled = false;
        this.ui.closeQrButton.disabled = false;
        for (const waiter of this.readyWaiters) {
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.readyWaiters.clear();
        this.transport?.send({
          v: 1,
          type: "requestState",
          requestId: crypto.randomUUID(),
        });
        return;
      case "hostAck": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
        return;
      }
      case "state": {
        this.joinOpen = message.joinOpen;
        this.ui.join.textContent = message.joinOpen ? "OPEN" : "CLOSED";
        this.permissions = message.permissions;
        this.adapter.setPermissions(message.permissions);
        this.syncPermissionInputs();

        const nextControllers = new Set(
          message.controllers.map(
            (controller) => controller.controllerSessionId,
          ),
        );

        for (const controllerSessionId of this.controllers) {
          if (!nextControllers.has(controllerSessionId)) {
            this.adapter.releaseController(controllerSessionId);
            this.rttByController.delete(controllerSessionId);
            this.webRtcByController.delete(controllerSessionId);
          }
        }

        this.controllers.clear();
        for (const controllerSessionId of nextControllers) {
          this.controllers.add(controllerSessionId);
        }

        this.webRtc.syncControllers(this.controllers);
        this.renderConnectionSummary();

        if (!message.joinOpen) this.hideQrView();
        this.renderControllerState();
        return;
      }
      case "controllerConnected":
        this.controllers.add(message.controllerSessionId);
        this.webRtc.controllerConnected(message.controllerSessionId);
        this.renderConnectionSummary();
        this.renderControllerState();
        return;
      case "controllerDisconnected":
        this.controllers.delete(message.controllerSessionId);
        this.rttByController.delete(message.controllerSessionId);
        this.webRtcByController.delete(message.controllerSessionId);
        this.webRtc.controllerDisconnected(message.controllerSessionId);
        this.adapter.releaseController(message.controllerSessionId);
        this.renderConnectionSummary();
        this.renderControllerState();
        return;
      case "rtcAnswer":
        void this.webRtc.handleAnswer(message);
        return;
      case "rtcIceCandidate":
        void this.webRtc.handleCandidate(message);
        return;
      case "error":
        this.renderStatus("ERROR");
        this.log(`REMOTE ${message.code} / ${message.message}`);
        return;
      default:
        return;
    }
  }

  /** session開始前のpermissionだけをlocal stateへ反映する */
  private updatePermissionsFromUi(): void {
    if (this.session) return;
    this.permissions = {
      cue: this.ui.permissionInputs.cue.checked,
      tapSync: this.ui.permissionInputs.tapSync.checked,
      record: this.ui.permissionInputs.record.checked,
      clear: this.ui.permissionInputs.clear.checked,
    };
    this.adapter.setPermissions(this.permissions);
    this.renderPermissionSummary();
  }

  private request(
    message: HostClientMessage,
  ): Promise<Extract<ServerMessage, { type: "hostAck" }>> {
    if (!("requestId" in message))
      return Promise.reject(new Error("Message has no request id"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote ACK timeout"));
      }, 6_000);
      this.pendingRequests.set(message.requestId, { resolve, reject, timer });
      if (!this.transport?.send(message)) {
        clearTimeout(timer);
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote socket is not open"));
      }
    });
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error("Remote connection timeout"));
      }, 8_000);
      this.readyWaiters.add(waiter);
    });
  }

  private handleWebRtcLatency(
    controllerSessionId: string,
    rttMs: number,
  ): void {
    this.setLatency(controllerSessionId, rttMs);
  }

  private setLatency(controllerSessionId: string, rttMs: number): void {
    this.rttByController.set(controllerSessionId, rttMs);
    this.renderControllerState();
  }

  private handleWebRtcState(
    controllerSessionId: string,
    connected: boolean,
  ): void {
    this.webRtcByController.set(controllerSessionId, connected);
    if (!connected) this.adapter.releaseController(controllerSessionId);
    this.renderConnectionSummary();
    this.renderControllerState();
  }

  private renderControllerState(): void {
    this.ui.count.textContent = String(this.controllers.size);
    if (this.controllers.size === 0) {
      this.ui.stats.hidden = true;
      this.ui.stats.replaceChildren();
      return;
    }
    this.ui.stats.hidden = false;
    this.ui.stats.replaceChildren(
      ...[...this.controllers].map((id, index) => {
        const row = document.createElement("div");
        const rtt = this.rttByController.get(id);
        const connected = this.webRtcByController.get(id) === true;
        row.innerHTML = `<b>#${index + 1}</b><span>WebRTC (${connected ? "DIRECT" : "接続中"})</span><span>RTT ${rtt === undefined ? "—" : `${Math.round(rtt)} ms`}</span>`;
        return row;
      }),
    );
  }

  private renderConnectionSummary(): void {
    const anyRtc = [...this.webRtcByController.values()].some(Boolean);
    const state = anyRtc ? "DIRECT" : this.controllers.size > 0 ? "接続中" : "未接続";
    this.ui.transport.textContent = state;
  }

  /** controller peerと表示用connection stateをまとめて破棄する */
  private clearControllerConnections(): void {
    this.webRtc.syncControllers([]);
    this.controllers.clear();
    this.rttByController.clear();
    this.webRtcByController.clear();
    this.renderConnectionSummary();
    this.renderControllerState();
  }

  private syncPermissionInputs(): void {
    this.ui.permissionInputs.cue.checked = this.permissions.cue;
    this.ui.permissionInputs.tapSync.checked = this.permissions.tapSync;
    this.ui.permissionInputs.record.checked = this.permissions.record;
    this.ui.permissionInputs.clear.checked = this.permissions.clear;
    this.renderPermissionSummary();
  }

  /** 選択中permissionを折りたたみ見出しへ短く表示する */
  private renderPermissionSummary(): void {
    const labels = [
      this.permissions.cue ? "CUE" : null,
      this.permissions.tapSync ? "TAP" : null,
      this.permissions.record ? "REC" : null,
      this.permissions.clear ? "CLEAR" : null,
    ].filter((label): label is string => label !== null);
    this.ui.permissionSummary.textContent = labels.length > 0 ? labels.join(" · ") : "許可なし";
  }

  /** permission入力のsession中変更を防ぐ */
  private setPermissionInputsDisabled(disabled: boolean): void {
    for (const input of Object.values(this.ui.permissionInputs)) input.disabled = disabled;
  }

  /** Remote toggleのlabelと操作可否を同じ状態から描画する */
  private renderRemoteToggle(active: boolean, busy = false): void {
    this.ui.startButton.textContent = busy ? "……" : active ? "ON" : "OFF";
    this.ui.startButton.disabled = busy || !this.baseUrl || this.destroyed;
    this.ui.startButton.classList.toggle("active", active);
    this.ui.startButton.setAttribute("aria-pressed", String(active));
    this.ui.startButton.setAttribute("aria-label", active ? "Remoteを停止" : "Remoteを開始");
    this.ui.sessionActions.hidden = !active;
  }

  /** Remote状態を記号と色へ統一して見出しへ表示する */
  private renderStatus(status: string): void {
    const state = status === "ONLINE"
      ? "online"
      : status === "OFFLINE"
        ? "offline"
        : status === "STARTING" || status === "AUTHENTICATING" || status === "RECONNECTING"
          ? "pending"
          : "error";
    const mark = state === "online" ? "●" : state === "offline" ? "○" : state === "pending" ? "……" : "×";
    this.ui.status.textContent = status === "STARTING" ? "(STARTING)" : `${mark} ${status}`;
    this.ui.status.setAttribute("data-state", state);
  }

  private hideQrView(): void {
    this.joinVisible = false;
    this.ui.qrOverlay.hidden = true;
    this.ui.qrImage.removeAttribute("src");
    this.ui.showQrButton.textContent = "QRを表示";
    this.ui.showQrButton.disabled = !this.ready;
  }

  private rejectPending(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  private rejectReadyWaiters(message: string): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.readyWaiters.clear();
  }

  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}

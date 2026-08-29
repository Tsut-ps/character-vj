import {
  DEFAULT_REMOTE_PERMISSIONS,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol.ts";
import { ControllerConnection } from "./ControllerConnection.ts";
import { ControllerCueTracker } from "./ControllerCueTracker.ts";

type ControllerStatus = "joining" | "connecting" | "connected" | "disconnected" | "error";

/** 観客向けtouch UIとpointer lifecycleをRemoteCommandへ変換する */
export class ControllerApp {
  private readonly host: HTMLElement;
  private readonly connection: ControllerConnection;
  private readonly cueTracker = new ControllerCueTracker();
  private readonly lifecycleAbort = new AbortController();
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private status: ControllerStatus = "joining";
  private webRtcConnected = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.innerHTML = this.template();
    this.connection = new ControllerConnection({
      onStatus: (status, detail) => this.setStatus(status, detail),
      onPermissions: (permissions) => this.setPermissions(permissions),
      onWebRtcState: (connected) => this.setWebRtcState(connected),
    });
    this.bindControls();
  }

  async start(): Promise<void> {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const roomId = fragment.get("room");
    const joinSecret = fragment.get("join");
    if (!roomId || !joinSecret) {
      this.setStatus("error", "Invalid or incomplete QR URL");
      return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}#room=${encodeURIComponent(roomId)}`);
    try {
      await this.connection.join(roomId, joinSecret);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : "JOIN failed");
    }
  }

  destroy(): void {
    this.releaseHeldCues();
    this.lifecycleAbort.abort();
    this.connection.destroy();
  }

  private template(): string {
    const cueButtons = Array.from({ length: 9 }, (_, index) => {
      const cue = index + 1;
      return `<button class="cue cue-${cue}" data-cue="${cue}" aria-label="Cue ${cue}">${cue}</button>`;
    }).join("");
    return `
      <section class="controller-shell">
        <header><h1>Character VJ Remote</h1><b data-status>● JOINING</b></header>
        <div class="cue-grid">${cueButtons}</div>
        <div class="utility-grid">
          <button data-command="tap">TAP</button>
          <button data-command="sync">SYNC</button>
          <button data-command="record">REC</button>
        </div>
        <button class="clear" data-command="clear">CLEAR</button>
        <div class="controller-path"><span>WebRTC Direct</span><b data-transport>未接続</b></div>
        <p data-detail></p>
      </section>
    `;
  }

  private bindControls(): void {
    const signal = this.lifecycleAbort.signal;
    this.host.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-cue]")) {
      button.addEventListener("pointerdown", (event) => this.onCueDown(event, button), { signal });
      button.addEventListener("pointerup", (event) => this.onCueRelease(event), { signal });
      button.addEventListener("pointercancel", (event) => this.onCueRelease(event), { signal });
      button.addEventListener("lostpointercapture", (event) => this.onCueRelease(event), { signal });
    }
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-command]")) {
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (button.disabled) return;
        const type = button.dataset.command;
        if (type === "tap" || type === "sync" || type === "record" || type === "clear") this.connection.sendCommand({ type });
      }, { signal });
    }
    window.addEventListener("blur", () => this.releaseHeldCues(), { signal });
    window.addEventListener("pagehide", () => this.releaseHeldCues(), { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.releaseHeldCues();
    }, { signal });
  }

  private onCueDown(event: PointerEvent, button: HTMLButtonElement): void {
    event.preventDefault();
    const cue = Number(button.dataset.cue);
    if (button.disabled || !Number.isInteger(cue) || cue < 1 || cue > 9) return;
    if (!this.connection.sendCommand({ type: "cue", cue: cue as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, state: "down" })) return;
    this.cueTracker.hold(event.pointerId, cue);
    button.classList.add("active");
    try { button.setPointerCapture(event.pointerId); } catch { this.onCueRelease(event); }
  }

  private onCueRelease(event: PointerEvent): void {
    const cue = this.cueTracker.release(event.pointerId);
    if (cue === null) return;
    this.connection.sendCommand({ type: "cue", cue: cue as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, state: "up" });
    this.host.querySelector<HTMLButtonElement>(`[data-cue="${cue}"]`)?.classList.remove("active");
  }

  private releaseLocalPointers(): void {
    this.cueTracker.releaseAll();
    for (const button of this.host.querySelectorAll(".cue.active")) button.classList.remove("active");
  }

  private releaseHeldCues(): void {
    for (const cue of this.cueTracker.releaseAll()) {
      this.connection.sendCommand({ type: "cue", cue: cue as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, state: "up" });
    }
    for (const button of this.host.querySelectorAll(".cue.active")) button.classList.remove("active");
  }

  private setStatus(status: ControllerStatus, detail?: string): void {
    this.status = status;
    const label = this.required<HTMLElement>("[data-status]");
    label.textContent = `● ${status === "connected" ? "CONNECTED" : status.toUpperCase()}`;
    label.dataset.state = status;
    this.required<HTMLElement>("[data-detail]").textContent = detail ?? "";
    if (status !== "connected") this.releaseLocalPointers();
    this.applyDisabledState();
  }

  private setPermissions(permissions: RemotePermissions): void {
    if (this.permissions.cue && !permissions.cue) this.releaseLocalPointers();
    this.permissions = permissions;
    this.applyDisabledState();
  }

  private setWebRtcState(connected: boolean): void {
    this.webRtcConnected = connected;
    this.required<HTMLElement>("[data-transport]").textContent = connected ? "接続済み" : "未接続";
    if (!connected) this.releaseLocalPointers();
    if (connected) this.setStatus("connected");
    else this.applyDisabledState();
  }

  private applyDisabledState(): void {
    const connected = this.status === "connected" && this.webRtcConnected;
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-cue]")) button.disabled = !connected || !this.permissions.cue;
    this.required<HTMLButtonElement>("[data-command=tap]").disabled = !connected || !this.permissions.tapSync;
    this.required<HTMLButtonElement>("[data-command=sync]").disabled = !connected || !this.permissions.tapSync;
    this.required<HTMLButtonElement>("[data-command=record]").disabled = !connected || !this.permissions.record;
    this.required<HTMLButtonElement>("[data-command=clear]").disabled = !connected || !this.permissions.clear;
  }

  private required<T extends Element>(selector: string): T {
    const element = this.host.querySelector<T>(selector);
    if (!element) throw new Error(`Controller element not found: ${selector}`);
    return element;
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { RemoteInputAdapter } from "../src/app/remote/RemoteInputAdapter.ts";
import { RemoteManager } from "../src/app/remote/RemoteManager.ts";
import type { RemoteTransport, WebSocketTransportOptions } from "../src/app/remote/WebSocketTransport.ts";
import type { RemoteEnvelope, ServerMessage } from "../src/app/remote/RemoteProtocol.ts";
import type { RemoteWebRtcHost, WebRtcHostEvents } from "../src/app/remote/WebRtcHost.ts";
import type { AppAction } from "../src/app/types.ts";
import type { RemoteHostElements } from "../src/app/ui/createVjUi.ts";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const CONTROLLER_ID = "20000000-0000-4000-8000-000000000002";
const HOST_TOKEN = "h".repeat(43);
const FIRST_TICKET = "a".repeat(43);
const SECOND_TICKET = "b".repeat(43);

class FakeElement extends EventTarget {
  textContent: string | null = "";
  innerHTML = "";
  hidden = false;
  disabled = false;
  checked = false;
  title = "";
  src = "";
  readonly classList = { toggle: () => false };

  /** test対象がQR srcを破棄した状態を再現する */
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  /** controller一覧のDOM更新を副作用なしで受け取る */
  replaceChildren(..._nodes: unknown[]): void {}

  /** test対象のARIA更新を副作用なしで受け取る */
  setAttribute(_name: string, _value: string): void {}
}

class FakeTransport implements RemoteTransport {
  isOpen = true;
  readonly sent: unknown[] = [];
  readonly options: WebSocketTransportOptions;

  /** transport optionとevent callbackを保持する */
  constructor(options: WebSocketTransportOptions) {
    this.options = options;
  }

  /** signaling payloadを記録する */
  send(message: unknown): boolean {
    if (!this.isOpen) return false;
    this.sent.push(message);
    return true;
  }

  /** test transportを閉じる */
  close(): void {
    this.isOpen = false;
  }

  /** server JSON受信を発火する */
  receive(message: unknown): void {
    this.options.events.onMessage(JSON.stringify(message));
  }

  /** server起点のWebSocket closeを発火する */
  disconnect(code = 1006): void {
    this.isOpen = false;
    this.options.events.onClose({ code } as CloseEvent);
  }
}

class FakeWebRtcHost implements RemoteWebRtcHost {
  readonly events: WebRtcHostEvents;
  readonly controllers = new Set<string>();

  constructor(events: WebRtcHostEvents) {
    this.events = events;
  }

  syncControllers(controllerSessionIds: Iterable<string>): void {
    this.controllers.clear();
    for (const controllerSessionId of controllerSessionIds) this.controllers.add(controllerSessionId);
  }

  controllerConnected(controllerSessionId: string): void { this.controllers.add(controllerSessionId); }
  controllerDisconnected(controllerSessionId: string): void { this.controllers.delete(controllerSessionId); }
  async handleAnswer(_message: Extract<ServerMessage, { type: "rtcAnswer" }>): Promise<void> {}
  async handleCandidate(_message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {}

  receive(controllerSessionId: string, envelope: RemoteEnvelope): void {
    this.events.onEnvelope(controllerSessionId, envelope);
  }

  state(controllerSessionId: string, connected: boolean): void {
    this.events.onState(controllerSessionId, connected);
  }

  latency(controllerSessionId: string, rttMs: number): void {
    this.events.onLatency(controllerSessionId, rttMs);
  }

  destroy(): void {
    this.controllers.clear();
  }
}

interface ManagerHarness {
  manager: RemoteManager;
  ui: RemoteHostElements;
  transports: FakeTransport[];
  actions: AppAction[];
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  qrValues: string[];
  webRtc: FakeWebRtcHost;
}

interface HarnessOptions {
  hostTicketFailures?: number;
  createQr?: (value: string) => Promise<string>;
}

/** EventTarget互換の最小HTMLElement test doubleを返す */
function fakeElement<T extends HTMLElement>(): T {
  return new FakeElement() as unknown as T;
}

/** RemoteManagerが必要とするHost UI test doubleを作る */
function createRemoteUi(): RemoteHostElements {
  const qrOverlay = fakeElement<HTMLElement>();
  qrOverlay.hidden = true;
  return {
    status: fakeElement<HTMLElement>(),
    count: fakeElement<HTMLElement>(),
    join: fakeElement<HTMLElement>(),
    startButton: fakeElement<HTMLButtonElement>(),
    showQrButton: fakeElement<HTMLButtonElement>(),
    sessionActions: fakeElement<HTMLElement>(),
    transport: fakeElement<HTMLElement>(),
    permissionSummary: fakeElement<HTMLElement>(),
    permissionInputs: {
      cue: fakeElement<HTMLInputElement>(),
      tapSync: fakeElement<HTMLInputElement>(),
      record: fakeElement<HTMLInputElement>(),
      clear: fakeElement<HTMLInputElement>(),
    },
    stats: fakeElement<HTMLElement>(),
    qrOverlay,
    qrImage: fakeElement<HTMLImageElement>(),
    qrRoom: fakeElement<HTMLElement>(),
    qrStatus: fakeElement<HTMLElement>(),
    closeQrButton: fakeElement<HTMLButtonElement>(),
  };
}

/** async UI handlerが指定状態へ進むまで短時間待つ */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for RemoteManager test state");
}

/** test用APIとtransportを注入したRemoteManagerを作る */
function createHarness(options: HarnessOptions = {}): ManagerHarness {
  const ui = createRemoteUi();
  const transports: FakeTransport[] = [];
  const actions: AppAction[] = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const qrValues: string[] = [];
  let webRtc: FakeWebRtcHost | null = null;
  let remainingHostTicketFailures = options.hostTicketFailures ?? 0;
  const expiresAt = Date.now() + 60_000;
  const fetchStub: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchCalls.push({ url, init });
    if (new URL(url).pathname === "/v1/rooms") {
      return Response.json({ v: 1, roomId: ROOM_ID, hostToken: HOST_TOKEN, sessionTicket: FIRST_TICKET, expiresAt }, { status: 201 });
    }
    if (new URL(url).pathname === `/v1/rooms/${ROOM_ID}/host-ticket`) {
      if (remainingHostTicketFailures > 0) {
        remainingHostTicketFailures -= 1;
        return Response.json({ error: "temporary" }, { status: 503 });
      }
      return Response.json({ v: 1, roomId: ROOM_ID, sessionTicket: SECOND_TICKET, expiresAt });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const manager = new RemoteManager(
    ui,
    new RemoteInputAdapter((action) => actions.push(action)),
    () => undefined,
    new AbortController().signal,
    {
      baseUrl: "https://remote.example",
      fetch: fetchStub,
      transportFactory: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
      createQr: async (value) => {
        qrValues.push(value);
        return options.createQr?.(value) ?? "data:image/png;base64,test";
      },
      controllerUrl: () => new URL("https://user.github.io/repository/controller.html"),
      webRtcFactory: (events) => {
        webRtc = new FakeWebRtcHost(events);
        return webRtc;
      },
    },
  );
  if (!webRtc) throw new Error("Fake WebRTC host was not created");
  return { manager, ui, transports, actions, fetchCalls, qrValues, webRtc };
}

/** START REMOTEを完了してready済みtransportを返す */
async function startRemote(harness: ManagerHarness): Promise<FakeTransport> {
  harness.ui.startButton.dispatchEvent(new Event("click"));
  assert.equal(harness.ui.status.textContent, "(STARTING)");
  assert.equal(harness.ui.startButton.textContent, "……");
  await waitFor(() => harness.transports.length === 1);
  const transport = harness.transports[0];
  const createCall = harness.fetchCalls.find((call) => new URL(call.url).pathname === "/v1/rooms");
  assert.deepEqual(JSON.parse(String(createCall?.init?.body)), {
    permissions: { cue: true, tapSync: false, record: false, clear: false },
  });
  assert.equal(harness.ui.permissionInputs.cue.disabled, true);
  transport.receive({
    v: 1,
    type: "ready",
    role: "host",
    roomId: ROOM_ID,
  });
  await waitFor(() => harness.ui.status.textContent === "● ONLINE");
  assert.equal(harness.ui.startButton.textContent, "ON");
  assert.equal(harness.ui.startButton.disabled, false);
  assert.equal(harness.ui.sessionActions.hidden, false);
  return transport;
}

/** 指定typeの最後の送信messageを取得する */
function lastMessage(transport: FakeTransport, type: string): Record<string, unknown> {
  const message = [...transport.sent].reverse().find((candidate) => (
    typeof candidate === "object" && candidate !== null && "type" in candidate && candidate.type === type
  ));
  assert.ok(message && typeof message === "object");
  return message as Record<string, unknown>;
}

test("openJoin ACK前はQRを表示せずcloseJoin ACK後に閉じる", async () => {
  const harness = createHarness();
  const transport = await startRemote(harness);
  harness.ui.showQrButton.dispatchEvent(new Event("click"));
  await waitFor(() => transport.sent.some((message) => typeof message === "object" && message !== null && "type" in message && message.type === "openJoin"));
  assert.equal(harness.ui.qrOverlay.hidden, true);
  const open = lastMessage(transport, "openJoin");
  transport.receive({ v: 1, type: "hostAck", requestId: open.requestId, action: "openJoin", ok: true, joinSecret: "j".repeat(43) });
  await waitFor(() => harness.ui.qrOverlay.hidden === false);
  assert.match(harness.qrValues[0], /repository\/controller\.html#room=/u);

  harness.ui.closeQrButton.dispatchEvent(new Event("click"));
  const close = lastMessage(transport, "closeJoin");
  assert.equal(harness.ui.qrOverlay.hidden, false);
  transport.receive({ v: 1, type: "hostAck", requestId: close.requestId, action: "closeJoin", ok: true });
  await waitFor(() => harness.ui.qrOverlay.hidden === true);
  assert.equal(harness.ui.join.textContent, "CLOSED");
  harness.manager.destroy();
});

test("Host切断時はmemory上のtokenからticketを再発行する", async () => {
  const harness = createHarness();
  const first = await startRemote(harness);
  first.disconnect();
  await waitFor(() => harness.transports.length === 2);
  const reconnectCall = harness.fetchCalls.find((call) => call.url.endsWith(`/v1/rooms/${ROOM_ID}/host-ticket`));
  if (!reconnectCall) throw new Error("Host ticket refresh was not requested");
  assert.deepEqual(JSON.parse(String(reconnectCall.init?.body)), { hostToken: HOST_TOKEN });
  assert.equal(harness.transports[1].options.sessionTicket, SECOND_TICKET);
  harness.manager.destroy();
});

test("Host ticketの一時失敗後もsession期限内は再接続する", async () => {
  const harness = createHarness({ hostTicketFailures: 1 });
  const first = await startRemote(harness);
  first.disconnect();
  await waitFor(() => harness.transports.length === 2);
  const reconnectCalls = harness.fetchCalls.filter((call) => call.url.endsWith(`/v1/rooms/${ROOM_ID}/host-ticket`));
  assert.equal(reconnectCalls.length, 2);
  harness.transports[1].receive({ v: 1, type: "ready", role: "host", roomId: ROOM_ID });
  await waitFor(() => harness.ui.status.textContent === "● ONLINE");
  harness.manager.destroy();
});

test("QR生成中にsessionを終了しても古いQRを再表示しない", async () => {
  let resolveQr!: (value: string) => void;
  const harness = createHarness({
    createQr: () => new Promise((resolve) => { resolveQr = resolve; }),
  });
  const transport = await startRemote(harness);
  harness.ui.showQrButton.dispatchEvent(new Event("click"));
  await waitFor(() => transport.sent.some((message) => typeof message === "object" && message !== null && "type" in message && message.type === "openJoin"));
  const open = lastMessage(transport, "openJoin");
  transport.receive({ v: 1, type: "hostAck", requestId: open.requestId, action: "openJoin", ok: true, joinSecret: "j".repeat(43) });
  await waitFor(() => typeof resolveQr === "function");
  harness.ui.startButton.dispatchEvent(new Event("click"));
  resolveQr("data:image/png;base64,late");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.ui.qrOverlay.hidden, true);
  assert.equal(harness.ui.status.textContent, "○ OFFLINE");
  harness.manager.destroy();
});

test("START REMOTEをONとOFFで切り替える", async () => {
  const harness = createHarness();
  const transport = await startRemote(harness);
  harness.ui.startButton.dispatchEvent(new Event("click"));
  assert.equal(transport.isOpen, false);
  assert.equal(harness.ui.status.textContent, "○ OFFLINE");
  assert.equal(harness.ui.startButton.textContent, "OFF");
  assert.equal(harness.ui.startButton.disabled, false);
  assert.equal(harness.ui.sessionActions.hidden, true);
  assert.equal(harness.ui.showQrButton.disabled, true);
  assert.equal(harness.ui.permissionInputs.cue.disabled, false);
  harness.manager.destroy();
});

test("開始前の操作許可を折りたたみ見出しへ反映する", () => {
  const harness = createHarness();
  assert.equal(harness.ui.permissionSummary.textContent, "CUE");
  harness.ui.permissionInputs.tapSync.checked = true;
  harness.ui.permissionInputs.tapSync.dispatchEvent(new Event("change"));
  assert.equal(harness.ui.permissionSummary.textContent, "CUE · TAP");
  harness.manager.destroy();
});

test("Remote errorを見出しへ記号付きで表示する", async () => {
  const harness = createHarness();
  const transport = await startRemote(harness);
  transport.receive({ v: 1, type: "error", code: "test_error", message: "test error" });
  assert.equal(harness.ui.status.textContent, "× ERROR");
  harness.manager.destroy();
});

test("WebRTC command replayを二重発火せずdisconnect時にCueを解放する", async () => {
  const harness = createHarness();
  const transport = await startRemote(harness);
  const envelope = { v: 1, seq: 0, command: { type: "cue", cue: 3, state: "down" } } as const;
  harness.webRtc.receive(CONTROLLER_ID, envelope);
  harness.webRtc.receive(CONTROLLER_ID, envelope);
  transport.receive({ v: 1, type: "controllerDisconnected", controllerSessionId: CONTROLLER_ID });
  assert.deepEqual(
    harness.actions.map((action) => action.type === "cue" ? [action.cue, action.phase] : null),
    [[2, "down"], [2, "up"]],
  );
  harness.manager.destroy();
});

test("DIRECT peer切断時にControllerのdown中Cueを解放する", async () => {
  const harness = createHarness();
  await startRemote(harness);
  harness.webRtc.receive(CONTROLLER_ID, { v: 1, seq: 0, command: { type: "cue", cue: 4, state: "down" } });
  harness.webRtc.state(CONTROLLER_ID, true);
  harness.webRtc.state(CONTROLLER_ID, false);
  harness.manager.destroy();
  assert.deepEqual(
    harness.actions.map((action) => action.type === "cue" ? [action.cue, action.phase] : null),
    [[3, "down"], [3, "up"]],
  );
});

test("Remote開始時にTURN credential APIを呼ばない", async () => {
  const harness = createHarness();
  await startRemote(harness);
  assert.equal(harness.fetchCalls.some((call) => call.url.endsWith("/ice-servers")), false);
  assert.equal(harness.ui.transport.textContent, "未接続");
  harness.manager.destroy();
});

test("Controller数をroom上限付きで表示する", async () => {
  const harness = createHarness();
  const transport = await startRemote(harness);
  assert.equal(harness.ui.count.textContent, "0/20");
  transport.receive({ v: 1, type: "controllerConnected", controllerSessionId: CONTROLLER_ID });
  assert.equal(harness.ui.count.textContent, "1/20");
  harness.manager.destroy();
});

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSecretToken, hashToken } from "../src/auth";
import { DEFAULT_PERMISSIONS } from "../src/protocol";

/** WebSocket closeをtimeout付きで待つ */
function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session close timeout")), 5_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

/** 条件に一致するJSON WebSocket messageをtimeout付きで待つ */
function waitForMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 5_000);
    const onMessage = (event: MessageEvent): void => {
      try {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (!predicate(message)) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(message);
      } catch {
        // 対象外messageを無視して次のserver messageを待つ
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

/** session ticketをWebSocket subprotocolへ設定する */
function socketHeaders(sessionTicket: string): HeadersInit {
  return {
    Origin: "https://tsut-ps.github.io",
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": `cvj-ticket.${sessionTicket}`,
  };
}

describe("Worker edge security", () => {
  it("非WebSocketのPartyServer requestをDO到達前に拒否する", async () => {
    const response = await SELF.fetch(`https://worker.test/parties/room/${crypto.randomUUID()}`);
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 426, body: "Upgrade Required" });
  });

  it("tokenを返すv1 responseをcache禁止にする", async () => {
    const response = await SELF.fetch("https://worker.test/v1/rooms", {
      method: "POST",
      headers: { Origin: "https://tsut-ps.github.io", "content-type": "application/json" },
      body: JSON.stringify({ permissions: DEFAULT_PERMISSIONS }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("session ticketなしWebSocket Upgradeを401で拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
      },
    });
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 401, body: "Missing session ticket" });
  });

  it("URL queryのsession ticketを認証に使用しない", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}?ticket=${createSecretToken()}`, {
      headers: { Origin: "https://tsut-ps.github.io", Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("過大なWebSocket subprotocol headerを拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `cvj-ticket.${"a".repeat(600)}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("UUIDに見える不正room IDをDO到達前に拒否する", async () => {
    const roomId = "------------------------------------";
    const response = await SELF.fetch(`https://worker.test/v1/rooms/${roomId}/join`, {
      method: "POST",
      headers: { Origin: "https://tsut-ps.github.io", "content-type": "application/json" },
      body: JSON.stringify({ joinSecret: createSecretToken() }),
    });
    expect(response.status).toBe(400);
  });

  it("許可外OriginのWebSocket Upgradeを403で拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://attacker.example",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "cvj-ticket.invalid-ticket-value-that-is-long-enough",
      },
    });
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 403, body: "Forbidden Origin" });
  });

  it("CORSへwildcardを返さず許可Originだけを反映する", async () => {
    const response = await SELF.fetch("https://worker.test/v1/rooms", {
      method: "OPTIONS",
      headers: { Origin: "https://tsut-ps.github.io" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://tsut-ps.github.io");
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("session期限で接続中WebSocketを終了する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const sessionTicket = createSecretToken();
    const expiresAt = Date.now() + 250;
    await env.Room.getByName(roomId).initializeRoom(
      await hashToken(hostToken),
      await hashToken(sessionTicket),
      expiresAt,
      DEFAULT_PERMISSIONS,
    );
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `cvj-ticket.${sessionTicket}`,
      },
    });
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(`cvj-ticket.${sessionTicket}`);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const close = await waitForClose(socket!);
    expect(close.code).toBe(4003);
  });

  it("新しいHost接続時に古いHostを切断する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const sessionTicket = createSecretToken();
    await env.Room.getByName(roomId).initializeRoom(
      await hashToken(hostToken),
      await hashToken(sessionTicket),
      Date.now() + 60_000,
      DEFAULT_PERMISSIONS,
    );
    const headers = {
      Origin: "https://tsut-ps.github.io",
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `cvj-ticket.${sessionTicket}`,
    };
    const firstResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers });
    const first = firstResponse.webSocket!;
    first.accept();
    const firstClosed = waitForClose(first);
    const secondResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers });
    const second = secondResponse.webSocket!;
    second.accept();
    expect((await firstClosed).code).toBe(4001);
    second.close(1000, "done");
  });

  it("Controller command本文を拒否し切断状態だけ永続化する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const hostTicket = createSecretToken();
    const controllerTicket = createSecretToken();
    const controllerSessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    const stub = env.Room.getByName(roomId);
    await stub.initializeRoom(await hashToken(hostToken), await hashToken(hostTicket), expiresAt, DEFAULT_PERMISSIONS);
    const joinSecret = createSecretToken();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_state SET join_open = 1, join_secret_hash = ? WHERE singleton = 1",
        await hashToken(joinSecret),
      );
    });
    expect((await stub.joinWithSecret(
      joinSecret,
      await hashToken(controllerTicket),
      controllerSessionId,
      expiresAt,
    )).ok).toBe(true);
    const hostResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers: socketHeaders(hostTicket) });
    const host = hostResponse.webSocket!;
    const hostReady = waitForMessage(host, (message) => message.type === "ready");
    host.accept();
    await hostReady;

    const controllerResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers: socketHeaders(controllerTicket) });
    const controller = controllerResponse.webSocket!;
    const controllerReady = waitForMessage(controller, (message) => message.type === "ready");
    controller.accept();
    await controllerReady;
    const rejected = waitForMessage(controller, (message) => message.type === "error");
    controller.send(JSON.stringify({ v: 1, seq: 1, command: { type: "cue", cue: 1, state: "down" } }));
    expect(await rejected).toMatchObject({ code: "forbidden_message" });
    const disconnected = waitForMessage(host, (message) => message.type === "controllerDisconnected");
    controller.close(1000, "done");
    await disconnected;
    host.close(1000, "done");
  });

  it("認証済みHostとController間だけWebRTC signalingを中継する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const hostTicket = createSecretToken();
    const controllerTicket = createSecretToken();
    const controllerSessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 60_000;
    const stub = env.Room.getByName(roomId);
    await stub.initializeRoom(await hashToken(hostToken), await hashToken(hostTicket), expiresAt, DEFAULT_PERMISSIONS);
    const joinSecret = createSecretToken();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_state SET join_open = 1, join_secret_hash = ? WHERE singleton = 1",
        await hashToken(joinSecret),
      );
    });
    expect((await stub.joinWithSecret(
      joinSecret,
      await hashToken(controllerTicket),
      controllerSessionId,
      expiresAt,
    )).ok).toBe(true);

    const hostResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers: socketHeaders(hostTicket) });
    const host = hostResponse.webSocket!;
    const hostReady = waitForMessage(host, (message) => message.type === "ready");
    host.accept();
    await hostReady;
    const controllerResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers: socketHeaders(controllerTicket) });
    const controller = controllerResponse.webSocket!;
    const controllerReady = waitForMessage(controller, (message) => message.type === "ready");
    controller.accept();
    await controllerReady;

    const rtcSessionId = crypto.randomUUID();
    const offerReceived = waitForMessage(controller, (message) => message.type === "rtcOffer");
    host.send(JSON.stringify({
      v: 1,
      type: "rtcOffer",
      controllerSessionId,
      rtcSessionId,
      sdp: `v=0\r\n${"a".repeat(2_000)}`,
    }));
    expect(await offerReceived).toMatchObject({ type: "rtcOffer", controllerSessionId, rtcSessionId });

    const answerReceived = waitForMessage(host, (message) => message.type === "rtcAnswer");
    controller.send(JSON.stringify({ v: 1, type: "rtcAnswer", rtcSessionId, sdp: "v=0\r\n" }));
    expect(await answerReceived).toMatchObject({ type: "rtcAnswer", controllerSessionId, rtcSessionId });

    const candidate = { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null };
    const controllerCandidate = waitForMessage(controller, (message) => message.type === "rtcIceCandidate");
    host.send(JSON.stringify({ v: 1, type: "rtcIceCandidate", controllerSessionId, rtcSessionId, candidate }));
    expect(await controllerCandidate).toMatchObject({ type: "rtcIceCandidate", controllerSessionId, rtcSessionId, candidate });
    const hostCandidate = waitForMessage(host, (message) => message.type === "rtcIceCandidate");
    controller.send(JSON.stringify({ v: 1, type: "rtcIceCandidate", rtcSessionId, candidate }));
    expect(await hostCandidate).toMatchObject({ type: "rtcIceCandidate", controllerSessionId, rtcSessionId, candidate });

    const controllerRejected = waitForMessage(controller, (message) => message.type === "error");
    controller.send(JSON.stringify({ v: 1, type: "rtcOffer", controllerSessionId, rtcSessionId, sdp: "v=0" }));
    expect(await controllerRejected).toMatchObject({ code: "forbidden_message" });
    const hostRejected = waitForMessage(host, (message) => message.type === "error");
    host.send(JSON.stringify({ v: 1, type: "rtcAnswer", controllerSessionId, rtcSessionId, sdp: "v=0" }));
    expect(await hostRejected).toMatchObject({ code: "forbidden_message" });
    controller.close(1000, "done");
    host.close(1000, "done");
  });

  it("Host control連打をSQLite更新前に制限する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const hostTicket = createSecretToken();
    await env.Room.getByName(roomId).initializeRoom(
      await hashToken(hostToken),
      await hashToken(hostTicket),
      Date.now() + 60_000,
      DEFAULT_PERMISSIONS,
    );
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers: socketHeaders(hostTicket) });
    const host = response.webSocket!;
    const ready = waitForMessage(host, (message) => message.type === "ready");
    host.accept();
    await ready;
    const limited = waitForMessage(host, (message) => message.type === "error" && message.code === "rate_limited");
    for (let index = 0; index < 31; index += 1) {
      host.send(JSON.stringify({ v: 1, type: "openJoin", requestId: crypto.randomUUID() }));
    }
    expect((await limited).code).toBe("rate_limited");
    host.close(1000, "done");
  });
});

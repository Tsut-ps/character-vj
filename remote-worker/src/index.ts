import { Hono, type Context, type Next } from "hono";
import { partyserverMiddleware } from "hono-party";
import { createSecretToken, hashToken } from "./auth";
import { Room } from "./Room";
import { createRoomRequestSchema, hostTicketRequestSchema, joinRequestSchema, roomIdSchema, SESSION_TICKET_TTL_MS } from "./protocol";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();
const TICKET_PROTOCOL_PREFIX = "cvj-ticket.";

/** configのOrigin allowlistを空要素なしで取得する */
function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean));
}

/** HTTPとWebSocket Upgradeで同じ完全一致Origin policyを適用する */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return Boolean(origin && allowedOrigins(env).has(origin));
}

/** 許可済みOriginだけへ限定CORS headerを付与する */
async function corsGuard(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const origin = c.req.header("Origin");
  if (c.req.method === "OPTIONS") {
    if (!origin || !allowedOrigins(c.env).has(origin)) return c.json({ error: "origin_forbidden" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      },
    });
  }
  await next();
  c.header("Cache-Control", "no-store");
  if (origin && allowedOrigins(c.env).has(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
}

/** mobile共有IPを強く締めすぎない補助keyを作る */
function requestActorKey(request: Request): string {
  const ip = requestIp(request);
  const agent = request.headers.get("user-agent")?.slice(0, 80) ?? "unknown";
  return `${ip}:${agent}`;
}

/** Cloudflareが確定した接続元IPをrate keyへ変換する */
function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

/** UA変更では迂回できない緩いIP abuse上限を適用する */
async function edgeAbuseAllowed(request: Request, env: Env): Promise<boolean> {
  const ip = requestIp(request);
  return (await env.EDGE_ABUSE_RATE_LIMITER.limit({ key: `edge:${ip}` })).success;
}

/** WebSocket subprotocolから短期session ticketだけを取り出す */
function sessionTicketFromRequest(request: Request): string | null {
  const header = request.headers.get("Sec-WebSocket-Protocol");
  if (!header || header.length > 512) return null;
  const protocols = header.split(",").map((value) => value.trim());
  const matches = protocols.filter((value) => value.startsWith(TICKET_PROTOCOL_PREFIX));
  if (matches.length !== 1) return null;
  const ticket = matches[0].slice(TICKET_PROTOCOL_PREFIX.length);
  return /^[A-Za-z0-9_-]{32,256}$/u.test(ticket) ? ticket : null;
}

/** 小さいJSON bodyだけをparseしてmemory abuseを防ぐ */
async function readSmallJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 1024) return null;
  try {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let received = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > 1024) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

app.use("/v1/*", corsGuard);
app.use("/v1/*", async (c, next) => {
  if (c.req.method !== "OPTIONS" && !await edgeAbuseAllowed(c.req.raw, c.env)) return c.json({ error: "rate_limited" }, 429);
  return next();
});

/** Upgrade前に軽量なOriginとticket存在確認を確実に返す */
app.use("/parties/*", async (c, next) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("Upgrade Required", 426);
  if (!originAllowed(c.req.raw, c.env)) return c.text("Forbidden Origin", 403);
  if (!await edgeAbuseAllowed(c.req.raw, c.env)) return c.text("Rate limited", 429);
  const ticket = sessionTicketFromRequest(c.req.raw);
  if (!ticket) return c.text("Missing session ticket", 401);
  await next();
  if (c.res.status === 101) c.res.headers.set("Sec-WebSocket-Protocol", `${TICKET_PROTOCOL_PREFIX}${ticket}`);
});

/** 新規roomと分離済みHost token/session ticketを発行する */
app.post("/v1/rooms", async (c) => {
  if (!originAllowed(c.req.raw, c.env)) return c.json({ error: "origin_forbidden" }, 403);
  const rate = await c.env.ROOM_CREATE_RATE_LIMITER.limit({ key: `create:${requestIp(c.req.raw)}` });
  if (!rate.success) return c.json({ error: "rate_limited" }, 429);
  const body = createRoomRequestSchema.safeParse(await readSmallJson(c.req.raw));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);

  const roomId = crypto.randomUUID();
  const hostToken = createSecretToken();
  const sessionTicket = createSecretToken();
  const expiresAt = Date.now() + SESSION_TICKET_TTL_MS;
  const stub = c.env.Room.getByName(roomId);
  const initialized = await stub.initializeRoom(await hashToken(hostToken), await hashToken(sessionTicket), expiresAt, body.data.permissions);
  if (!initialized) return c.json({ error: "room_collision" }, 409);
  return c.json({ v: 1, roomId, hostToken, sessionTicket, expiresAt }, 201);
});

/** Host token検証後に短期Host ticketを再発行する */
app.post("/v1/rooms/:roomId/host-ticket", async (c) => {
  if (!originAllowed(c.req.raw, c.env)) return c.json({ error: "origin_forbidden" }, 403);
  const roomId = c.req.param("roomId");
  if (!roomIdSchema.safeParse(roomId).success) return c.json({ error: "invalid_room" }, 400);
  const [actorRate, roomRate] = await Promise.all([
    c.env.HOST_TICKET_RATE_LIMITER.limit({ key: `host-ticket-actor:${requestActorKey(c.req.raw)}` }),
    c.env.HOST_TICKET_RATE_LIMITER.limit({ key: `host-ticket-room:${roomId}` }),
  ]);
  if (!actorRate.success || !roomRate.success) return c.json({ error: "rate_limited" }, 429);
  const body = hostTicketRequestSchema.safeParse(await readSmallJson(c.req.raw));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const sessionTicket = createSecretToken();
  const requestedExpiresAt = Date.now() + SESSION_TICKET_TTL_MS;
  const expiresAt = await c.env.Room.getByName(roomId).createHostTicket(
    body.data.hostToken,
    await hashToken(sessionTicket),
    requestedExpiresAt,
  );
  if (!expiresAt) return c.json({ error: "forbidden" }, 403);
  return c.json({ v: 1, roomId, sessionTicket, expiresAt });
});

/** OPEN中のjoinSecretを短期controller ticketへ交換する */
app.post("/v1/rooms/:roomId/join", async (c) => {
  if (!originAllowed(c.req.raw, c.env)) return c.json({ error: "origin_forbidden" }, 403);
  const roomId = c.req.param("roomId");
  if (!roomIdSchema.safeParse(roomId).success) return c.json({ error: "invalid_room" }, 400);
  const [actorRate, roomRate] = await Promise.all([
    c.env.JOIN_RATE_LIMITER.limit({ key: `join-actor:${requestActorKey(c.req.raw)}` }),
    c.env.JOIN_RATE_LIMITER.limit({ key: `join-room:${roomId}` }),
  ]);
  if (!actorRate.success || !roomRate.success) return c.json({ error: "rate_limited" }, 429);
  const body = joinRequestSchema.safeParse(await readSmallJson(c.req.raw));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);

  const controllerSessionId = crypto.randomUUID();
  const sessionTicket = createSecretToken();
  const requestedExpiresAt = Date.now() + SESSION_TICKET_TTL_MS;
  const result = await c.env.Room.getByName(roomId).joinWithSecret(
    body.data.joinSecret,
    await hashToken(sessionTicket),
    controllerSessionId,
    requestedExpiresAt,
  );
  if (result.reason === "full") return c.json({ error: "room_full" }, 429);
  if (!result.ok || !result.permissions || !result.expiresAt || !result.connectBy) return c.json({ error: "forbidden" }, 403);
  return c.json({
    v: 1,
    roomId,
    controllerSessionId,
    sessionTicket,
    expiresAt: result.expiresAt,
    connectBy: result.connectBy,
    permissions: result.permissions,
  });
});

/** OriginとticketをUpgrade前に検証してserver-side identityへ置換する */
app.use("*", partyserverMiddleware<AppEnv>({
  options: {
    onBeforeConnect: async (request, lobby, c) => {
      if (lobby.className !== "Room" || !roomIdSchema.safeParse(lobby.name).success) return new Response("Not Found", { status: 404 });
      if (!originAllowed(request, c.env)) return new Response("Forbidden Origin", { status: 403 });
      const ticket = sessionTicketFromRequest(request);
      if (!ticket) return new Response("Missing session ticket", { status: 401 });
      const [actorRate, roomRate] = await Promise.all([
        c.env.WS_RATE_LIMITER.limit({ key: `ws-actor:${requestActorKey(request)}` }),
        c.env.WS_RATE_LIMITER.limit({ key: `ws-room:${lobby.name}` }),
      ]);
      if (!actorRate.success || !roomRate.success) return new Response("Rate limited", { status: 429 });
      const authorization = await c.env.Room.getByName(lobby.name).authorizeWebSocket(ticket);
      if (!authorization.ok || !authorization.role || !authorization.expiresAt) {
        return new Response("Invalid session ticket", { status: 401 });
      }

      const headers = new Headers(request.headers);
      headers.delete("sec-websocket-protocol");
      headers.delete("x-remote-internal-role");
      headers.delete("x-remote-internal-controller");
      headers.delete("x-remote-internal-expires");
      headers.set("x-remote-internal-role", authorization.role);
      if (authorization.controllerSessionId) headers.set("x-remote-internal-controller", authorization.controllerSessionId);
      headers.set("x-remote-internal-expires", String(authorization.expiresAt));
      return new Request(request.url, { method: request.method, headers });
    },
  },
  onError: (error) => console.error(JSON.stringify({ event: "partyserver_error", message: error.message })),
}));

/** 未定義routeへJSON 404を返す */
app.notFound((c) => c.json({ error: "not_found" }, 404));

export { Room };
export default app;

import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { constantTimeEqual, createSecretToken, hashToken } from "./auth";
import {
  controllerMessageSchema,
  DEFAULT_PERMISSIONS,
  hostMessageSchema,
  MAX_ACTIVE_CONTROLLERS,
  MAX_CONTROLLER_SESSIONS,
  MAX_HOST_CONTROL_MESSAGES_PER_MINUTE,
  MAX_HOST_MESSAGES_PER_SECOND,
  PENDING_CONTROLLER_TICKET_TTL_MS,
  parseJsonCandidate,
  payloadWithinLimit,
  permissionsSchema,
  SESSION_TICKET_TTL_MS,
  signalingMessageSchema,
  signalingPayloadWithinLimit,
  type Permissions,
} from "./protocol";
import { checkCommandRate } from "./rateLimit";

type Role = "host" | "controller";

interface RemoteConnectionState {
  role: Role;
  controllerSessionId?: string;
  sessionExpiresAt: number;
  rateStartedAt: number;
  rateCount: number;
}

type RoomRow = {
  host_token_hash: string;
  join_open: number;
  join_secret_hash: string | null;
  permissions_json: string;
  current_host_connection_id: string | null;
  expires_at: number;
} & Record<string, SqlStorageValue>;

type TicketRow = {
  role: Role;
  controller_session_id: string | null;
  expires_at: number;
} & Record<string, SqlStorageValue>;

export interface WebSocketAuthorization {
  ok: boolean;
  role?: Role;
  controllerSessionId?: string;
  expiresAt?: number;
}

export interface JoinResult {
  ok: boolean;
  reason?: "forbidden" | "full";
  permissions?: Permissions;
  expiresAt?: number;
  connectBy?: number;
}

/** 1 remote roomをSQLiteとhibernatable WebSocketで管理する */
export class Room extends Server<Env> {
  static options = { hibernate: true };
  private hostMessageRate = { rateStartedAt: 0, rateCount: 0 };
  private hostControlRate = { rateStartedAt: 0, rateCount: 0 };
  private schemaReady = false;
  private currentHostConnectionId: string | null = null;
  private readonly currentControllerConnections = new Map<string, string>();

  /** PartyServer起動時にschemaと接続attachmentを復元する */
  async onStart(): Promise<void> {
    this.ensureSchema();
    if (!await this.ctx.storage.get<boolean>("initialized")) return;
    const room = this.getRoom();
    if (!room) return;
    if (room.expires_at <= Date.now()) {
      await this.expireRoom();
      return;
    }
    this.currentHostConnectionId = room.current_host_connection_id;
    this.currentControllerConnections.clear();
    for (const connection of this.getConnections<RemoteConnectionState>("role:controller")) {
      const controllerSessionId = connection.state?.controllerSessionId;
      if (controllerSessionId) this.currentControllerConnections.set(controllerSessionId, connection.id);
    }
    await this.scheduleSessionAlarm(room.expires_at);
  }

  /** 新規roomのhashと絶対期限を保存する */
  async initializeRoom(hostTokenHash: string, ticketHash: string, expiresAt: number, permissions: Permissions): Promise<boolean> {
    if (await this.ctx.storage.get<boolean>("initialized")) return false;
    const now = Date.now();
    const roomExpiresAt = Math.min(expiresAt, now + SESSION_TICKET_TTL_MS);
    if (!Number.isSafeInteger(expiresAt) || roomExpiresAt <= now) return false;
    this.ensureSchema();
    const existing = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM room_state").one().count;
    if (existing > 0) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO room_state (singleton, host_token_hash, join_open, join_secret_hash, permissions_json, current_host_connection_id, expires_at) VALUES (1, ?, 0, NULL, ?, NULL, ?)",
      hostTokenHash,
      JSON.stringify(permissions),
      roomExpiresAt,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'host', NULL, ?)",
      ticketHash,
      roomExpiresAt,
    );
    try {
      const initializedWrite = this.ctx.storage.put("initialized", true);
      const alarmWrite = this.ctx.storage.setAlarm(roomExpiresAt);
      await Promise.all([initializedWrite, alarmWrite]);
    } catch (error) {
      this.schemaReady = false;
      await this.ctx.storage.deleteAll();
      throw error;
    }
    return true;
  }

  /** host token検証後に再接続用host ticket hashを保存する */
  async createHostTicket(hostToken: string, ticketHash: string, expiresAt: number): Promise<number | null> {
    const room = await this.getActiveRoom();
    if (!room || !constantTimeEqual(room.host_token_hash, await hashToken(hostToken))) return null;
    const ticketExpiresAt = Math.min(expiresAt, room.expires_at);
    if (!Number.isSafeInteger(expiresAt) || ticketExpiresAt <= Date.now()) return null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE role = 'host'");
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'host', NULL, ?)",
        ticketHash,
        ticketExpiresAt,
      );
    });
    return ticketExpiresAt;
  }

  /** join状態とsecretを検証してcontroller sessionを発行可能にする */
  async joinWithSecret(joinSecret: string, ticketHash: string, controllerSessionId: string, expiresAt: number): Promise<JoinResult> {
    const room = await this.getActiveRoom();
    if (!room) return { ok: false, reason: "forbidden" };
    const candidateHash = await hashToken(joinSecret);
    if (room.expires_at <= Date.now() || room.join_open !== 1 || !room.join_secret_hash || !constantTimeEqual(room.join_secret_hash, candidateHash)) {
      return { ok: false, reason: "forbidden" };
    }
    const now = Date.now();
    const sessionExpiresAt = Math.min(expiresAt, room.expires_at);
    const ticketExpiresAt = Math.min(sessionExpiresAt, now + PENDING_CONTROLLER_TICKET_TTL_MS);
    if (!Number.isSafeInteger(expiresAt) || sessionExpiresAt <= now) return { ok: false, reason: "forbidden" };
    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
      const controllerCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tickets WHERE role = 'controller'",
      ).one().count;
      if (controllerCount >= MAX_CONTROLLER_SESSIONS) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'controller', ?, ?)",
        ticketHash,
        controllerSessionId,
        ticketExpiresAt,
      );
      return true;
    });
    if (!inserted) return { ok: false, reason: "full" };
    return {
      ok: true,
      permissions: this.parsePermissions(room.permissions_json),
      expiresAt: sessionExpiresAt,
      connectBy: ticketExpiresAt,
    };
  }

  /** WebSocket Upgrade前に短期ticketをroomとroleへ結び付ける */
  async authorizeWebSocket(ticket: string): Promise<WebSocketAuthorization> {
    const room = await this.getActiveRoom();
    if (!room) return { ok: false };
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
    const ticketHash = await hashToken(ticket);
    const row = this.ctx.storage.sql.exec<TicketRow>(
      "SELECT role, controller_session_id, expires_at FROM tickets WHERE ticket_hash = ?",
      ticketHash,
    ).toArray()[0];
    if (!row || row.expires_at <= now || room.expires_at <= now) return { ok: false };
    if (row.role === "controller") {
      if (!row.controller_session_id) return { ok: false };
    }
    return {
      ok: true,
      role: row.role,
      controllerSessionId: row.controller_session_id ?? undefined,
      expiresAt: row.role === "controller" ? room.expires_at : Math.min(row.expires_at, room.expires_at),
    };
  }

  /** server側で認証済みの接続情報だけをhibernation attachmentへ保存する */
  async onConnect(connection: Connection<RemoteConnectionState>, context: ConnectionContext): Promise<void> {
    const role = context.request.headers.get("x-remote-internal-role");
    const controllerSessionId = context.request.headers.get("x-remote-internal-controller");
    const sessionExpiresAt = Number(context.request.headers.get("x-remote-internal-expires"));
    if ((role !== "host" && role !== "controller") || !Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
      connection.close(4401, "Unauthorized");
      return;
    }
    const permissions = this.currentPermissions();
    connection.setState({
      role,
      controllerSessionId: controllerSessionId ?? undefined,
      sessionExpiresAt,
      rateStartedAt: Date.now(),
      rateCount: 0,
    });
    await this.scheduleSessionAlarm(sessionExpiresAt);

    if (role === "host") this.connectHost(connection);
    else if (!controllerSessionId) {
      connection.close(4401, "Missing controller identity");
      return;
    } else {
      if (!this.connectController(connection, controllerSessionId, sessionExpiresAt)) {
        connection.close(4429, "Room controller limit reached");
        return;
      }
    }

    this.send(connection, {
      v: 1,
      type: "ready",
      role,
      roomId: this.name,
      ...(controllerSessionId ? { controllerSessionId } : {}),
      permissions,
    });
    if (role === "host") this.sendState(connection);
  }

  /** 認証済みroleに応じて許可されたmessage schemaだけを処理する */
  async onMessage(connection: Connection<RemoteConnectionState>, message: WSMessage): Promise<void> {
    const initialState = connection.state;
    if (!initialState) {
      connection.close(4401, "Missing connection state");
      return;
    }
    if (initialState.sessionExpiresAt <= Date.now()) {
      connection.close(4003, "Session expired");
      return;
    }
    let state = initialState;
    let controllerRateAllowed = true;
    if (state.role === "controller") {
      const rate = checkCommandRate(state, Date.now());
      state = { ...state, ...rate.state };
      controllerRateAllowed = rate.allowed;
      connection.setState(state);
    } else {
      const rate = checkCommandRate(this.hostMessageRate, Date.now(), MAX_HOST_MESSAGES_PER_SECOND);
      this.hostMessageRate = rate.state;
      if (!rate.allowed) return;
    }
    const text = typeof message === "string" && signalingPayloadWithinLimit(message) ? message : null;
    if (text === null) {
      if (controllerRateAllowed) this.sendError(connection, "invalid_payload", "Message must be bounded UTF-8 JSON");
      return;
    }
    const candidate = parseJsonCandidate(text);
    if (candidate === null) {
      if (controllerRateAllowed) this.sendError(connection, "malformed_json", "Malformed JSON");
      return;
    }
    if (!payloadWithinLimit(text) && !signalingMessageSchema.safeParse(candidate).success) {
      if (controllerRateAllowed) this.sendError(connection, "invalid_payload", "Message exceeds allowed size");
      return;
    }
    if (state.role === "host") await this.handleHostMessage(connection, candidate);
    else this.handleControllerMessage(connection, candidate, state, controllerRateAllowed);
  }

  /** current接続だけを切断扱いにしてhostへcontroller解放を通知する */
  async onClose(connection: Connection<RemoteConnectionState>): Promise<void> {
    const state = connection.state;
    if (!state) return;
    if (!await this.ctx.storage.get<boolean>("initialized")) return;
    if (state.role === "host") {
      if (this.currentHostConnectionId === connection.id) {
        this.currentHostConnectionId = null;
        this.ctx.storage.sql.exec(
          "UPDATE room_state SET current_host_connection_id = NULL, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
        );
      }
      return;
    }
    if (!state.controllerSessionId) return;
    if (this.currentControllerConnections.get(state.controllerSessionId) !== connection.id) return;
    this.currentControllerConnections.delete(state.controllerSessionId);
    this.sendToHosts({ v: 1, type: "controllerDisconnected", controllerSessionId: state.controllerSessionId });
  }

  /** 期限切れconnectionを閉じて次のsession期限だけをalarmへ登録する */
  async onAlarm(): Promise<void> {
    const now = Date.now();
    const room = await this.getActiveRoom(now);
    if (!room) return;
    let nextExpiry = room.expires_at;
    for (const connection of this.getConnections<RemoteConnectionState>()) {
      const state = connection.state;
      if (!state) continue;
      if (state.sessionExpiresAt <= now) {
        if (state.role === "host" && room.current_host_connection_id === connection.id) {
          this.ctx.storage.sql.exec(
            "UPDATE room_state SET current_host_connection_id = NULL, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
          );
        }
        connection.close(4003, "Session expired");
      } else {
        nextExpiry = Math.min(nextExpiry, state.sessionExpiresAt);
      }
    }
    await this.ctx.storage.setAlarm(nextExpiry);
  }

  /** 接続roleとcontroller identityを検索用tagへ変換する */
  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const role = context.request.headers.get("x-remote-internal-role");
    const controller = context.request.headers.get("x-remote-internal-controller");
    return [
      ...(role === "host" || role === "controller" ? [`role:${role}`] : []),
      ...(controller ? [`controller:${controller}`] : []),
    ];
  }

  /** 古いhostを明示的に切断してroomあたり1 hostへ保つ */
  private connectHost(connection: Connection<RemoteConnectionState>): void {
    const room = this.getRoom();
    this.currentHostConnectionId = connection.id;
    this.ctx.storage.sql.exec(
      "UPDATE room_state SET current_host_connection_id = ?, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
      connection.id,
    );
    if (!room?.current_host_connection_id || room.current_host_connection_id === connection.id) return;
    this.getConnection(room.current_host_connection_id)?.close(4001, "Host replaced");
  }

  /** 同じcontroller sessionの旧接続を閉じて接続状態をhostへ通知する */
  private connectController(connection: Connection<RemoteConnectionState>, controllerSessionId: string, sessionExpiresAt: number): boolean {
    const activeControllers = new Set(
      [...this.getConnections<RemoteConnectionState>("role:controller")]
        .map((item) => item.state?.controllerSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    activeControllers.add(controllerSessionId);
    if (activeControllers.size > MAX_ACTIVE_CONTROLLERS) return false;
    const previousConnectionId = this.currentControllerConnections.get(controllerSessionId);
    this.currentControllerConnections.set(controllerSessionId, connection.id);
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET expires_at = ? WHERE role = 'controller' AND controller_session_id = ?",
      sessionExpiresAt,
      controllerSessionId,
    );
    if (previousConnectionId && previousConnectionId !== connection.id) {
      this.getConnection(previousConnectionId)?.close(4002, "Controller reconnected");
    }
    this.sendToHosts({ v: 1, type: "controllerConnected", controllerSessionId });
    return true;
  }

  /** host専用controlとWebRTC signalingだけを処理する */
  private async handleHostMessage(connection: Connection<RemoteConnectionState>, candidate: unknown): Promise<void> {
    if (this.currentHostConnectionId !== connection.id) {
      connection.close(4001, "Host replaced");
      return;
    }
    const result = hostMessageSchema.safeParse(candidate);
    if (!result.success) {
      this.sendError(connection, "forbidden_message", "Host message schema rejected");
      return;
    }
    const message = result.data;
    if (message.type === "openJoin" || message.type === "closeJoin" || message.type === "requestState") {
      const rate = checkCommandRate(this.hostControlRate, Date.now(), MAX_HOST_CONTROL_MESSAGES_PER_MINUTE, 60_000);
      this.hostControlRate = rate.state;
      if (!rate.allowed) {
        this.sendError(connection, "rate_limited", "Host control rate exceeded");
        return;
      }
    }
    if (message.type === "openJoin") await this.openJoin(connection, message.requestId);
    else if (message.type === "closeJoin") this.closeJoin(connection, message.requestId);
    else if (message.type === "requestState") {
      this.sendAck(connection, message.requestId, message.type);
      this.sendState(connection);
    } else if (message.type === "rtcOffer" || message.type === "rtcIceCandidate") {
      this.sendToController(message.controllerSessionId, message);
    }
  }

  /** controller signalingをrate制限して現在Hostだけへ転送する */
  private handleControllerMessage(
    connection: Connection<RemoteConnectionState>,
    candidate: unknown,
    state: Readonly<RemoteConnectionState>,
    controllerRateAllowed: boolean,
  ): void {
    const result = controllerMessageSchema.safeParse(candidate);
    if (!result.success || !state.controllerSessionId) {
      if (controllerRateAllowed) this.sendError(connection, "forbidden_message", "Controller message schema rejected");
      return;
    }
    if (this.currentControllerConnections.get(state.controllerSessionId) !== connection.id) {
      connection.close(4002, "Controller reconnected");
      return;
    }
    if (controllerRateAllowed) this.sendToHosts({ ...result.data, controllerSessionId: state.controllerSessionId });
  }

  /** OPEN ACK用secretを毎回ローテーションしhashだけを保存する */
  private async openJoin(connection: Connection<RemoteConnectionState>, requestId: string): Promise<void> {
    const joinSecret = createSecretToken();
    const secretHash = await hashToken(joinSecret);
    this.ctx.storage.sql.exec(
      "UPDATE room_state SET join_open = 1, join_secret_hash = ? WHERE singleton = 1",
      secretHash,
    );
    this.sendAck(connection, requestId, "openJoin", joinSecret);
    this.sendState(connection);
  }

  /** CLOSE ACK前にjoinを閉じて現在secretを即時無効化する */
  private closeJoin(connection: Connection<RemoteConnectionState>, requestId: string): void {
    this.ctx.storage.sql.exec("UPDATE room_state SET join_open = 0, join_secret_hash = NULL WHERE singleton = 1");
    this.sendAck(connection, requestId, "closeJoin");
    this.sendState(connection);
  }

  /** hostへ現在のjoin、permissions、controller一覧を送る */
  private sendState(connection: Connection): void {
    const room = this.getRoom();
    if (!room) return;
    const controllers = [...this.getConnections<RemoteConnectionState>("role:controller")]
      .map((item) => item.state?.controllerSessionId)
      .filter((id): id is string => Boolean(id));
    this.send(connection, {
      v: 1,
      type: "state",
      joinOpen: room.join_open === 1,
      permissions: this.parsePermissions(room.permissions_json),
      controllers: [...new Set(controllers)].map((controllerSessionId) => ({ controllerSessionId })),
    });
  }

  /** host ACKを共通形で返す */
  private sendAck(
    connection: Connection,
    requestId: string,
    action: "openJoin" | "closeJoin" | "requestState",
    joinSecret?: string,
  ): void {
    this.send(connection, { v: 1, type: "hostAck", requestId, action, ok: true, ...(joinSecret ? { joinSecret } : {}) });
  }

  /** 現在のhost接続だけへmessageを送り旧hostとcontrollerへの漏洩を防ぐ */
  private sendToHosts(message: unknown): void {
    if (!this.currentHostConnectionId) return;
    const host = this.getConnection(this.currentHostConnectionId);
    if (host) this.send(host, message);
  }

  /** 指定controller sessionだけへmessageを送る */
  private sendToController(controllerSessionId: string, message: unknown): void {
    const connectionId = this.currentControllerConnections.get(controllerSessionId);
    const controller = connectionId ? this.getConnection(connectionId) : undefined;
    if (controller) this.send(controller, message);
  }

  /** JSON server messageを単一接続へ送る */
  private send(connection: Connection, message: unknown): void {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
  }

  /** schema拒否理由をidentity情報なしで接続元へ返す */
  private sendError(connection: Connection, code: string, message: string): void {
    this.send(connection, { v: 1, type: "error", code, message });
  }

  /** room stateの現在permissionsを安全な初期値付きで取得する */
  private currentPermissions(): Permissions {
    const room = this.getRoom();
    return room ? this.parsePermissions(room.permissions_json) : { ...DEFAULT_PERMISSIONS };
  }

  /** 永続JSONをZod検証して破損時は安全な初期権限へ戻す */
  private parsePermissions(value: string): Permissions {
    try {
      const parsed: unknown = JSON.parse(value);
      const result = permissionsSchema.safeParse(parsed);
      return result.success ? result.data : { ...DEFAULT_PERMISSIONS };
    } catch {
      return { ...DEFAULT_PERMISSIONS };
    }
  }

  /** 現在のalarmより早いsession期限だけを登録する */
  private async scheduleSessionAlarm(expiresAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt < current) await this.ctx.storage.setAlarm(expiresAt);
  }

  /** 期限内のroomだけを返し期限切れstateを完全削除する */
  private async getActiveRoom(now = Date.now()): Promise<RoomRow | undefined> {
    if (!await this.ctx.storage.get<boolean>("initialized")) return undefined;
    this.ensureSchema();
    const room = this.getRoom();
    if (room && room.expires_at > now) return room;
    await this.expireRoom();
    return undefined;
  }

  /** 接続を終了してroomのSQLiteと認証情報を解放する */
  private async expireRoom(): Promise<void> {
    for (const connection of this.getConnections<RemoteConnectionState>()) {
      connection.close(4003, "Session expired");
    }
    this.hostMessageRate = { rateStartedAt: 0, rateCount: 0 };
    this.hostControlRate = { rateStartedAt: 0, rateCount: 0 };
    this.schemaReady = false;
    this.currentHostConnectionId = null;
    this.currentControllerConnections.clear();
    await this.ctx.storage.deleteAll();
  }

  /** singleton room rowを取得する */
  private getRoom(): RoomRow | undefined {
    return this.ctx.storage.sql.exec<RoomRow>(
      "SELECT host_token_hash, join_open, join_secret_hash, permissions_json, current_host_connection_id, expires_at FROM room_state WHERE singleton = 1",
    ).toArray()[0];
  }

  /** 起動または初回RPCでSQLite schemaを一度だけ準備する */
  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        host_token_hash TEXT NOT NULL,
        join_open INTEGER NOT NULL DEFAULT 0,
        join_secret_hash TEXT,
        permissions_json TEXT NOT NULL,
        current_host_connection_id TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('host', 'controller')),
        controller_session_id TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tickets_expires_at ON tickets(expires_at);
    `);
    this.schemaReady = true;
  }
}

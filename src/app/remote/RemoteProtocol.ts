import { z } from "zod";

const REMOTE_PROTOCOL_VERSION = 1 as const;
const REMOTE_COMMAND_MAX_BYTES = 1024;
const REMOTE_SERVER_MESSAGE_MAX_BYTES = 64 * 1024;
const REMOTE_RTC_DATA_MAX_BYTES = 2048;
export const REMOTE_ROOM_RATE_LIMIT = 600;
export const REMOTE_TICKET_PROTOCOL_PREFIX = "cvj-ticket.";
export const REMOTE_SESSION_MAX_MS = 60 * 60 * 1000;
export const REMOTE_INITIAL_CONNECT_MAX_MS = 60 * 1000;
const TERMINAL_CONTROLLER_CLOSE_CODES = new Set([4002, 4003, 4401, 4403, 4429]);

const cueNumberSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
  z.literal(6), z.literal(7), z.literal(8), z.literal(9),
]);

const remotePermissionsSchema = z.object({
  cue: z.boolean(),
  tapSync: z.boolean(),
  record: z.boolean(),
  clear: z.boolean(),
}).strict();

export type RemotePermissions = z.infer<typeof remotePermissionsSchema>;

export const DEFAULT_REMOTE_PERMISSIONS: RemotePermissions = {
  cue: true,
  tapSync: false,
  record: false,
  clear: false,
};

const remoteCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cue"),
    cue: cueNumberSchema,
    state: z.enum(["down", "up"]),
    latch: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("tap") }).strict(),
  z.object({ type: z.literal("sync") }).strict(),
  z.object({ type: z.literal("record") }).strict(),
  z.object({ type: z.literal("clear") }).strict(),
]);

export const remoteEnvelopeSchema = z.object({
  v: z.literal(REMOTE_PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().safe(),
  command: remoteCommandSchema,
}).strict();

export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteEnvelope = z.infer<typeof remoteEnvelopeSchema>;

const rtcSdpSchema = z.string().min(1).max(20_000);
const rtcSessionIdSchema = z.string().uuid();
const rtcIceCandidateSchema = z.object({
  candidate: z.string().max(4_096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().max(65_535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
}).strict();

export type RemoteIceCandidate = z.infer<typeof rtcIceCandidateSchema>;

export type ControllerRtcSignal =
  | { v: 1; type: "rtcAnswer"; rtcSessionId: string; sdp: string }
  | { v: 1; type: "rtcIceCandidate"; rtcSessionId: string; candidate: RemoteIceCandidate };

const hostClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("openJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("closeJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("requestState"), requestId: z.string().uuid() }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("rtcOffer"),
    controllerSessionId: z.string().uuid(),
    rtcSessionId: rtcSessionIdSchema,
    sdp: rtcSdpSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("rtcIceCandidate"),
    controllerSessionId: z.string().uuid(),
    rtcSessionId: rtcSessionIdSchema,
    candidate: rtcIceCandidateSchema,
  }).strict(),
]);

const controllerSummarySchema = z.object({
  controllerSessionId: z.string().uuid(),
}).strict();

const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(1),
    type: z.literal("ready"),
    role: z.enum(["host", "controller"]),
    roomId: z.string().uuid(),
    controllerSessionId: z.string().uuid().optional(),
    permissions: remotePermissionsSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("hostAck"),
    requestId: z.string().uuid(),
    action: z.enum(["openJoin", "closeJoin", "requestState"]),
    ok: z.boolean(),
    joinSecret: z.string().min(32).max(256).optional(),
    error: z.string().max(160).optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("state"),
    joinOpen: z.boolean(),
    permissions: remotePermissionsSchema,
    controllers: z.array(controllerSummarySchema).max(20),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("controllerConnected"),
    controllerSessionId: z.string().uuid(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("controllerDisconnected"),
    controllerSessionId: z.string().uuid(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("rtcOffer"),
    controllerSessionId: z.string().uuid(),
    rtcSessionId: rtcSessionIdSchema,
    sdp: rtcSdpSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("rtcAnswer"),
    controllerSessionId: z.string().uuid(),
    rtcSessionId: rtcSessionIdSchema,
    sdp: rtcSdpSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("rtcIceCandidate"),
    controllerSessionId: z.string().uuid(),
    rtcSessionId: rtcSessionIdSchema,
    candidate: rtcIceCandidateSchema,
  }).strict(),
  z.object({ v: z.literal(1), type: z.literal("error"), code: z.string().max(64), message: z.string().max(160) }).strict(),
]);

export type HostClientMessage = z.infer<typeof hostClientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const createRoomResponseSchema = z.object({
  v: z.literal(1),
  roomId: z.string().uuid(),
  hostToken: z.string().min(32).max(256),
  sessionTicket: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
}).strict();

export const hostTicketResponseSchema = z.object({
  v: z.literal(1),
  roomId: z.string().uuid(),
  sessionTicket: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
}).strict();

export const joinRoomResponseSchema = z.object({
  v: z.literal(1),
  roomId: z.string().uuid(),
  controllerSessionId: z.string().uuid(),
  sessionTicket: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
  connectBy: z.number().int().positive(),
  permissions: remotePermissionsSchema,
}).strict();

const rtcDataMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("remote"), envelope: remoteEnvelopeSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal("ping"), nonce: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.string().uuid() }).strict(),
]);
export type RtcDataMessage = z.infer<typeof rtcDataMessageSchema>;

/** commandがHostで設定された観客権限に含まれるか判定する */
export function commandAllowed(command: RemoteCommand, permissions: RemotePermissions): boolean {
  switch (command.type) {
    case "cue": return permissions.cue;
    case "tap":
    case "sync": return permissions.tapSync;
    case "record": return permissions.record;
    case "clear": return permissions.clear;
  }
  return false;
}

/** server JSONをZod検証し不正messageをnullへ畳み込む */
export function parseServerMessage(data: unknown): ServerMessage | null {
  return parseJsonMessage(
    data,
    REMOTE_SERVER_MESSAGE_MAX_BYTES,
    serverMessageSchema,
  );
}

/** DataChannel JSONを1 KiB上限とZodでRemoteEnvelopeへ検証する */
export function parseRemoteEnvelopeMessage(data: unknown): RemoteEnvelope | null {
  return parseJsonMessage(data, REMOTE_COMMAND_MAX_BYTES, remoteEnvelopeSchema);
}

/** WebRTC DataChannel frameを小さいtyped messageへ検証する */
export function parseRtcDataMessage(data: unknown): RtcDataMessage | null {
  return parseJsonMessage(data, REMOTE_RTC_DATA_MAX_BYTES, rtcDataMessageSchema);
}

/** JSON受信境界を共通化してsize制限とschema検証の差異を防ぐ */
function parseJsonMessage<T>(
  data: unknown,
  maxBytes: number,
  schema: z.ZodType<T>,
): T | null {
  if (
    typeof data !== "string" ||
    data.length > maxBytes ||
    new TextEncoder().encode(data).byteLength > maxBytes
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(data);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 自動再接続してはいけないcontroller close codeを判定する */
export function isTerminalControllerClose(code: number): boolean {
  return TERMINAL_CONTROLLER_CLOSE_CODES.has(code);
}

/** server期限とlocal上限の早い方を再接続停止時間にする */
export function remoteSessionTimeoutMs(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.min(expiresAt - now, REMOTE_SESSION_MAX_MS));
}

/** 初回ticket期限とlocal上限の早い方を接続待機時間にする */
export function remoteInitialConnectTimeoutMs(connectBy: number, now = Date.now()): number {
  return Math.max(0, Math.min(connectBy - now, REMOTE_INITIAL_CONNECT_MAX_MS));
}

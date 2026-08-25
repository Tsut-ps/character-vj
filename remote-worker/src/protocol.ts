import { z } from "zod";

const MAX_CLIENT_MESSAGE_BYTES = 1024;
const MAX_SIGNALING_MESSAGE_BYTES = 24 * 1024;
export const SESSION_TICKET_TTL_MS = 60 * 60 * 1000;
export const PENDING_CONTROLLER_TICKET_TTL_MS = 60 * 1000;
export const MAX_CONTROLLERS = 20;
export const JOIN_TIMEOUT_MS = 30_000;
export const MAX_HOST_MESSAGES_PER_SECOND = 300;
export const MAX_HOST_CONTROL_MESSAGES_PER_MINUTE = 30;

export const permissionsSchema = z.object({
  cue: z.boolean(),
  tapSync: z.boolean(),
  record: z.boolean(),
  clear: z.boolean(),
}).strict();

export type Permissions = z.infer<typeof permissionsSchema>;

export const DEFAULT_PERMISSIONS: Permissions = {
  cue: true,
  tapSync: false,
  record: false,
  clear: false,
};

const rtcSdpSchema = z.string().min(1).max(20_000);
const rtcSessionIdSchema = z.string().uuid();
const rtcIceCandidateSchema = z.object({
  candidate: z.string().max(4_096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().max(65_535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
}).strict();

const controllerRtcAnswerSchema = z.object({
  v: z.literal(1),
  type: z.literal("rtcAnswer"),
  rtcSessionId: rtcSessionIdSchema,
  sdp: rtcSdpSchema,
}).strict();
const controllerRtcCandidateSchema = z.object({
  v: z.literal(1),
  type: z.literal("rtcIceCandidate"),
  rtcSessionId: rtcSessionIdSchema,
  candidate: rtcIceCandidateSchema,
}).strict();
const hostRtcOfferSchema = z.object({
  v: z.literal(1),
  type: z.literal("rtcOffer"),
  controllerSessionId: z.string().uuid(),
  rtcSessionId: rtcSessionIdSchema,
  sdp: rtcSdpSchema,
}).strict();
const hostRtcCandidateSchema = z.object({
  v: z.literal(1),
  type: z.literal("rtcIceCandidate"),
  controllerSessionId: z.string().uuid(),
  rtcSessionId: rtcSessionIdSchema,
  candidate: rtcIceCandidateSchema,
}).strict();

export const controllerMessageSchema = z.union([
  controllerRtcAnswerSchema,
  controllerRtcCandidateSchema,
]);

export const hostMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("openJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("activateJoin") }).strict(),
  z.object({ v: z.literal(1), type: z.literal("closeJoin"), requestId: z.string().uuid() }).strict(),
  hostRtcOfferSchema,
  hostRtcCandidateSchema,
]);

export const signalingMessageSchema = z.union([
  controllerRtcAnswerSchema,
  controllerRtcCandidateSchema,
  hostRtcOfferSchema,
  hostRtcCandidateSchema,
]);

export const createRoomRequestSchema = z.object({ permissions: permissionsSchema }).strict();
export const joinRequestSchema = z.object({ joinSecret: z.string().min(32).max(256) }).strict();
export const hostTicketRequestSchema = z.object({ hostToken: z.string().min(32).max(256) }).strict();
export const roomIdSchema = z.string().uuid();

export function parseJsonCandidate(text: string): unknown | null {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export function payloadWithinLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_CLIENT_MESSAGE_BYTES;
}

export function signalingPayloadWithinLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_SIGNALING_MESSAGE_BYTES;
}

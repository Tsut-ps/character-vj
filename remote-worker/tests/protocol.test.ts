import { describe, expect, it } from "vitest";
import {
  controllerMessageSchema,
  hostMessageSchema,
  parseJsonCandidate,
  payloadWithinLimit,
  signalingMessageSchema,
  signalingPayloadWithinLimit,
  SESSION_TICKET_TTL_MS,
} from "../src/protocol";
import { checkCommandRate } from "../src/rateLimit";

describe("remote protocol security", () => {
  it("session上限を1時間に固定する", () => {
    expect(SESSION_TICKET_TTL_MS).toBe(60 * 60 * 1000);
  });
  it("controllerによるhost commandとrole偽装を拒否する", () => {
    const requestId = crypto.randomUUID();
    expect(controllerMessageSchema.safeParse({ v: 1, type: "openJoin", requestId }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({
      v: 1,
      seq: 1,
      role: "host",
      command: { type: "cue", cue: 1, state: "down" },
    }).success).toBe(false);
    expect(hostMessageSchema.safeParse({ v: 1, type: "openJoin", requestId }).success).toBe(true);
  });

  it("WebRTC signalingのrole方向とidentityを固定する", () => {
    const controllerSessionId = crypto.randomUUID();
    const rtcSessionId = crypto.randomUUID();
    const candidate = { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null };
    expect(hostMessageSchema.safeParse({ v: 1, type: "rtcOffer", controllerSessionId, rtcSessionId, sdp: "v=0" }).success).toBe(true);
    expect(controllerMessageSchema.safeParse({ v: 1, type: "rtcOffer", controllerSessionId, rtcSessionId, sdp: "v=0" }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 1, type: "rtcAnswer", rtcSessionId, sdp: "v=0" }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ v: 1, type: "rtcAnswer", controllerSessionId, rtcSessionId, sdp: "v=0" }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 1, type: "rtcIceCandidate", rtcSessionId, candidate }).success).toBe(true);
    expect(controllerMessageSchema.safeParse({ v: 1, type: "rtcIceCandidate", controllerSessionId, rtcSessionId, candidate }).success).toBe(false);
  });

  it("malformed JSONとoversized payloadを拒否する", () => {
    expect(parseJsonCandidate("{")).toBeNull();
    expect(payloadWithinLimit(JSON.stringify({ v: 1, type: "rtcAnswer", rtcSessionId: crypto.randomUUID(), sdp: "v=0" }))).toBe(true);
    expect(payloadWithinLimit("x".repeat(1025))).toBe(false);
  });

  it("1 KiB超過は検証済みsignalingだけ許可する", () => {
    const signaling = JSON.stringify({ v: 1, type: "rtcAnswer", rtcSessionId: crypto.randomUUID(), sdp: `v=0${"a".repeat(2_000)}` });
    expect(payloadWithinLimit(signaling)).toBe(false);
    expect(signalingPayloadWithinLimit(signaling)).toBe(true);
    expect(signalingMessageSchema.safeParse(JSON.parse(signaling)).success).toBe(true);
    expect(signalingPayloadWithinLimit("x".repeat(24 * 1024 + 1))).toBe(false);
  });

  it("Controller command本文とunknown versionをsignalingから拒否する", () => {
    expect(controllerMessageSchema.safeParse({ v: 1, seq: 1, command: { type: "unknown" } }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 2, seq: 1, command: { type: "tap" } }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 1, seq: 1, command: { type: "cue", cue: 1, state: "down" } }).success).toBe(false);
  });

  it("controller signalingを60 msg/secへ制限する", () => {
    let state = { rateStartedAt: 1000, rateCount: 0 };
    for (let index = 0; index < 60; index += 1) {
      const result = checkCommandRate(state, 1000);
      state = result.state;
      expect(result.allowed).toBe(true);
    }
    expect(checkCommandRate(state, 1000).allowed).toBe(false);
    expect(checkCommandRate(state, 2000).allowed).toBe(true);
  });

  it("長いrate窓もtimerなしで更新する", () => {
    let state = { rateStartedAt: 1000, rateCount: 0 };
    for (let index = 0; index < 30; index += 1) state = checkCommandRate(state, 1000, 30, 60_000).state;
    expect(checkCommandRate(state, 59_000, 30, 60_000).allowed).toBe(false);
    expect(checkCommandRate(state, 61_000, 30, 60_000).allowed).toBe(true);
  });
});

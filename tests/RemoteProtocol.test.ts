import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalControllerClose,
  parseRemoteEnvelopeMessage,
  parseRtcDataMessage,
  parseServerMessage,
  REMOTE_INITIAL_CONNECT_MAX_MS,
  REMOTE_SESSION_MAX_MS,
  remoteInitialConnectTimeoutMs,
  remoteSessionTimeoutMs,
} from "../src/app/remote/RemoteProtocol.ts";
import { createRemoteRtcConfiguration } from "../src/app/remote/WebRtcConfig.ts";

test("二重接続と期限切れのclose codeでは再接続を止める", () => {
  assert.equal(isTerminalControllerClose(4002), true);
  assert.equal(isTerminalControllerClose(4003), true);
  assert.equal(isTerminalControllerClose(4401), true);
  assert.equal(isTerminalControllerClose(4429), true);
  assert.equal(isTerminalControllerClose(1006), false);
});

test("DataChannelでは検証済みRemoteEnvelopeだけを受け付ける", () => {
  const valid = JSON.stringify({ v: 1, seq: 3, command: { type: "cue", cue: 9, state: "down" } });
  assert.equal(parseRemoteEnvelopeMessage(valid)?.seq, 3);
  assert.equal(parseRemoteEnvelopeMessage(JSON.stringify({ v: 1, seq: 3, command: { type: "cue", cue: 10, state: "down" } })), null);
  assert.equal(parseRemoteEnvelopeMessage("x".repeat(1025)), null);
});

test("RTTはHost側だけで計測してControllerへ返送しない", () => {
  const nonce = crypto.randomUUID();
  assert.equal(parseRtcDataMessage(JSON.stringify({ v: 1, type: "ping", nonce }))?.type, "ping");
  assert.equal(parseRtcDataMessage(JSON.stringify({ v: 1, type: "latency", rttMs: 10 })), null);
});

test("server signalingはcontroller identity付きschemaだけを受け付ける", () => {
  const controllerSessionId = crypto.randomUUID();
  const rtcSessionId = crypto.randomUUID();
  assert.equal(parseServerMessage(JSON.stringify({ v: 1, type: "rtcOffer", controllerSessionId, rtcSessionId, sdp: "v=0" }))?.type, "rtcOffer");
  assert.equal(parseServerMessage(JSON.stringify({ v: 1, type: "rtcAnswer", rtcSessionId, sdp: "v=0" })), null);
});

test("WebRTCはCloudflare STUNだけを使う直接接続に固定する", () => {
  const configuration = createRemoteRtcConfiguration();
  assert.equal(configuration.iceTransportPolicy, "all");
  assert.deepEqual(configuration.iceServers, [{ urls: "stun:stun.cloudflare.com:3478" }]);
});

test("client時計が遅れていても再接続を1時間で止める", () => {
  assert.equal(remoteSessionTimeoutMs(10 * REMOTE_SESSION_MAX_MS, 0), REMOTE_SESSION_MAX_MS);
  assert.equal(remoteSessionTimeoutMs(999, 1000), 0);
});

test("初回readyが届かなければ1分で再接続を止める", () => {
  assert.equal(remoteInitialConnectTimeoutMs(10 * REMOTE_INITIAL_CONNECT_MAX_MS, 0), REMOTE_INITIAL_CONNECT_MAX_MS);
  assert.equal(remoteInitialConnectTimeoutMs(999, 1000), 0);
});

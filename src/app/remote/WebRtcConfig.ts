import type { RemoteIceCandidate } from "./RemoteProtocol.ts";

const DIRECT_STUN: RTCIceServer = { urls: "stun:stun.cloudflare.com:3478" };

/** Cloudflare STUNを使う直接接続用ICE設定を作る */
export function createRemoteRtcConfiguration(): RTCConfiguration {
  return { iceServers: [DIRECT_STUN], iceTransportPolicy: "all" };
}

/** Native ICE candidateをstrict signaling schemaへ変換する */
export function serializeRemoteIceCandidate(candidate: RTCIceCandidate): RemoteIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

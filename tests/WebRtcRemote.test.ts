import assert from "node:assert/strict";
import test from "node:test";
import type { ServerMessage } from "../src/app/remote/RemoteProtocol.ts";
import { WebRtcHost } from "../src/app/remote/WebRtcHost.ts";
import { WebRtcController } from "../src/controller/WebRtcController.ts";

class FakeDataChannel extends EventTarget {
  readonly label = "remote";
  readyState: RTCDataChannelState = "connecting";
  closed = false;

  send(): void {}

  close(): void {
    this.closed = true;
    this.readyState = "closed";
  }
}

class FakePeerConnection extends EventTarget {
  readonly channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCLocalSessionDescriptionInit | null = null;
  closed = false;
  private readonly remoteGate: Promise<void>;

  constructor(remoteGate = Promise.resolve()) {
    super();
    this.remoteGate = remoteGate;
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0" };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.remoteGate;
    this.remoteDescription = description;
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    this.channel.close();
  }
}

function asPeerFactory(peers: FakePeerConnection[]): () => RTCPeerConnection {
  return () => {
    const peer = peers.shift();
    if (!peer) throw new Error("Missing fake peer");
    return peer as unknown as RTCPeerConnection;
  };
}

function offer(controllerSessionId: string, rtcSessionId: string): Extract<ServerMessage, { type: "rtcOffer" }> {
  return { v: 1, type: "rtcOffer", controllerSessionId, rtcSessionId, sdp: "v=0" };
}

test("古いHost peerのclose eventは同じControllerの新しいpeerを閉じない", async () => {
  const first = new FakePeerConnection();
  const second = new FakePeerConnection();
  const host = new WebRtcHost({
    sendSignal: () => true,
    onEnvelope: () => {},
    onState: () => {},
    onLatency: () => {},
  }, asPeerFactory([first, second]));
  const controllerSessionId = crypto.randomUUID();

  host.controllerConnected(controllerSessionId);
  await Promise.resolve();
  host.controllerDisconnected(controllerSessionId);
  host.controllerConnected(controllerSessionId);
  first.channel.dispatchEvent(new Event("close"));

  assert.equal(second.closed, false);
  host.destroy();
});

test("古いController offerの完了は新しいpeerを閉じない", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = new FakePeerConnection(firstGate);
  const second = new FakePeerConnection();
  const controller = new WebRtcController({
    sendSignal: () => true,
    onState: () => {},
    onFailure: () => {},
  }, asPeerFactory([first, second]));
  const controllerSessionId = crypto.randomUUID();

  const firstOffer = controller.handleOffer(offer(controllerSessionId, crypto.randomUUID()));
  await Promise.resolve();
  await controller.handleOffer(offer(controllerSessionId, crypto.randomUUID()));
  releaseFirst();
  await firstOffer;

  assert.equal(second.closed, false);
  controller.close();
});

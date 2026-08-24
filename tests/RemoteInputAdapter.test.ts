import assert from "node:assert/strict";
import test from "node:test";
import { RemoteInputAdapter } from "../src/app/remote/RemoteInputAdapter.ts";
import { parseServerMessage } from "../src/app/remote/RemoteProtocol.ts";
import type { AppAction } from "../src/app/types.ts";

test("Remote cueをcontroller別sourceIdのAppActionへ変換する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  assert.equal(adapter.handle(controller, { v: 1, seq: 0, command: { type: "cue", cue: 3, state: "down" } }, 0), true);
  assert.deepEqual(actions[0], {
    type: "cue",
    cue: 2,
    phase: "down",
    source: "remote",
    sourceId: `remote:${controller}:3`,
    strength: 1,
    latchToggle: undefined,
  });
});

test("Host側でもseq replayとrollbackを破棄する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  assert.equal(adapter.handle(controller, { v: 1, seq: 4, command: { type: "cue", cue: 1, state: "down" } }, 0), true);
  assert.equal(adapter.handle(controller, { v: 1, seq: 4, command: { type: "cue", cue: 1, state: "up" } }, 1), false);
  assert.equal(adapter.handle(controller, { v: 1, seq: 3, command: { type: "cue", cue: 1, state: "up" } }, 2), false);
  assert.equal(actions.length, 1);
});

test("controller切断時にdown中Cueをすべて解放する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  adapter.handle(controller, { v: 1, seq: 0, command: { type: "cue", cue: 1, state: "down" } }, 0);
  adapter.handle(controller, { v: 1, seq: 1, command: { type: "cue", cue: 3, state: "down" } }, 1);
  adapter.releaseController(controller);
  assert.deepEqual(actions.slice(-2).map((action) => action.type === "cue" ? [action.cue, action.phase] : null), [[0, "up"], [2, "up"]]);
});

test("controller再接続後も古いseqを拒否する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  adapter.handle(controller, { v: 1, seq: 4, command: { type: "cue", cue: 1, state: "down" } }, 0);
  adapter.releaseController(controller);
  assert.equal(adapter.handle(controller, { v: 1, seq: 4, command: { type: "cue", cue: 1, state: "down" } }, 1), false);
  assert.equal(adapter.handle(controller, { v: 1, seq: 5, command: { type: "cue", cue: 1, state: "down" } }, 2), true);
});

test("Remote session終了後は新しいseqを0から受け付ける", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  adapter.handle(controller, { v: 1, seq: 4, command: { type: "cue", cue: 1, state: "down" } }, 0);
  adapter.resetSession();
  assert.equal(adapter.handle(controller, { v: 1, seq: 0, command: { type: "cue", cue: 1, state: "down" } }, 1), true);
});

test("permission違反とcue範囲外をHost側でも拒否する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  const controller = crypto.randomUUID();
  adapter.setPermissions({ cue: false, tapSync: false, record: false, clear: false });
  assert.equal(adapter.handle(controller, { v: 1, seq: 0, command: { type: "cue", cue: 1, state: "down" } }, 0), false);
  const invalid = { v: 1, seq: 1, command: { type: "cue", cue: 10, state: "down" } };
  assert.equal(adapter.handle(controller, invalid, 1), false);
  assert.equal(actions.length, 0);
});

test("500 controllerのstate messageを受信できる", () => {
  const controllerSessionId = crypto.randomUUID();
  const message = JSON.stringify({
    v: 1,
    type: "state",
    joinOpen: false,
    permissions: { cue: true, tapSync: false, record: false, clear: false },
    controllers: Array.from({ length: 500 }, () => ({ controllerSessionId })),
  });
  assert.equal(parseServerMessage(message)?.type, "state");
});

test("room全体の過剰なRemote入力を制限する", () => {
  const actions: AppAction[] = [];
  const adapter = new RemoteInputAdapter((action) => actions.push(action));
  for (let index = 0; index < 601; index += 1) {
    adapter.handle(crypto.randomUUID(), { v: 1, seq: 0, command: { type: "cue", cue: 1, state: "down" } }, 0);
  }
  assert.equal(actions.length, 600);
});

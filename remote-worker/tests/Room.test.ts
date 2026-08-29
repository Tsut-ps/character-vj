import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, createSecretToken, hashToken } from "../src/auth";
import type { Room } from "../src/Room";
import { DEFAULT_PERMISSIONS, MAX_CONTROLLERS, PENDING_CONTROLLER_TICKET_TTL_MS } from "../src/protocol";

interface Fixture {
  roomId: string;
  hostToken: string;
  hostTicket: string;
  expiresAt: number;
  stub: DurableObjectStub<Room>;
}

/** 独立DOへhost tokenとticketを初期化する */
async function createFixture(ttlMs = 60_000): Promise<Fixture> {
  const roomId = crypto.randomUUID();
  const hostToken = createSecretToken();
  const hostTicket = createSecretToken();
  const expiresAt = Date.now() + ttlMs;
  const stub = env.Room.getByName(roomId);
  const initialized = await stub.initializeRoom(
    await hashToken(hostToken),
    await hashToken(hostTicket),
    expiresAt,
    DEFAULT_PERMISSIONS,
  );
  expect(initialized).toBe(true);
  return { roomId, hostToken, hostTicket, expiresAt, stub };
}

/** test専用にjoin stateを直接設定してsecret lifecycleを検証可能にする */
async function setJoin(stub: DurableObjectStub<Room>, open: boolean, secret?: string, expiresAt = Date.now() + 30_000): Promise<void> {
  const secretHash = secret ? await hashToken(secret) : null;
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE room_state SET join_open = ?, join_secret_hash = ?, join_expires_at = ? WHERE singleton = 1",
      open ? 1 : 0,
      secretHash,
      open ? expiresAt : null,
    );
  });
}

describe("Room secret and ticket lifecycle", () => {
  it("固定長hashだけを定時間比較する", async () => {
    const first = await hashToken("first");
    const same = await hashToken("first");
    const different = await hashToken("different");
    expect(constantTimeEqual(first, same)).toBe(true);
    expect(constantTimeEqual(first, different)).toBe(false);
    expect(constantTimeEqual(first, "invalid")).toBe(false);
  });

  it("joinOpen=falseでJOINを拒否する", async () => {
    const fixture = await createFixture();
    const result = await fixture.stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("間違ったjoinSecretを拒否する", async () => {
    const fixture = await createFixture();
    await setJoin(fixture.stub, true, createSecretToken());
    const result = await fixture.stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("保存permission破損時は全操作を拒否する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    await runInDurableObject(fixture.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE room_state SET permissions_json = ? WHERE singleton = 1", "invalid");
    });
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), fixture.expiresAt);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("secretローテーション後に古いQRを拒否する", async () => {
    const fixture = await createFixture();
    const oldSecret = createSecretToken();
    const newSecret = createSecretToken();
    await setJoin(fixture.stub, true, oldSecret);
    await setJoin(fixture.stub, true, newSecret);
    const oldResult = await fixture.stub.joinWithSecret(oldSecret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    const newResult = await fixture.stub.joinWithSecret(newSecret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(oldResult.ok).toBe(false);
    expect(newResult.ok).toBe(true);
  });

  it("QR CLOSE後の新規JOINを拒否する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    await setJoin(fixture.stub, false);
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("表示から30秒を過ぎたQRをserver側でも拒否する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret, Date.now() - 1);
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), fixture.expiresAt);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(fixture.stub);
    await runInDurableObject(fixture.stub, (_instance, state) => {
      const room = state.storage.sql.exec<{ join_open: number; join_secret_hash: string | null; join_expires_at: number | null }>(
        "SELECT join_open, join_secret_hash, join_expires_at FROM room_state WHERE singleton = 1",
      ).one();
      expect(room).toEqual({ join_open: 0, join_secret_hash: null, join_expires_at: null });
    });
  });

  it("session ticketなしと別room token流用を拒否する", async () => {
    const first = await createFixture();
    const second = await createFixture();
    expect((await first.stub.authorizeWebSocket("")).ok).toBe(false);
    expect((await second.stub.authorizeWebSocket(first.hostTicket)).ok).toBe(false);
    const authorized = await first.stub.authorizeWebSocket(first.hostTicket);
    expect(authorized.role).toBe("host");
    expect(authorized.expiresAt).toBe(first.expiresAt);
  });

  it("host tokenとjoin secretを混同しない", async () => {
    const fixture = await createFixture();
    await setJoin(fixture.stub, true, createSecretToken());
    const result = await fixture.stub.joinWithSecret(fixture.hostToken, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("host ticket再発行時に古いticketを無効化する", async () => {
    const fixture = await createFixture();
    const nextTicket = createSecretToken();
    const created = await fixture.stub.createHostTicket(
      fixture.hostToken,
      await hashToken(nextTicket),
      Date.now() + 60_000,
    );
    expect(created).toBe(fixture.expiresAt);
    expect((await fixture.stub.authorizeWebSocket(fixture.hostTicket)).ok).toBe(false);
    expect((await fixture.stub.authorizeWebSocket(nextTicket)).role).toBe("host");
  });

  it("未初期化roomへの試行で永続stateを作らない", async () => {
    const stub = env.Room.getByName(crypto.randomUUID());
    const result = await stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("initialized")).toBeUndefined();
    });
  });

  it("room作成時に絶対期限のalarmを設定する", async () => {
    const fixture = await createFixture();
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(fixture.expiresAt);
    });
  });

  it("再発行ticketをroom期限より延長しない", async () => {
    const fixture = await createFixture();
    const hostExpiry = await fixture.stub.createHostTicket(
      fixture.hostToken,
      await hashToken(createSecretToken()),
      Date.now() + 3_600_000,
    );
    expect(hostExpiry).toBe(fixture.expiresAt);

    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    const joined = await fixture.stub.joinWithSecret(
      secret,
      await hashToken(createSecretToken()),
      crypto.randomUUID(),
      Date.now() + 3_600_000,
    );
    expect(joined.expiresAt).toBe(fixture.expiresAt);
  });

  it("未接続controller ticketを1分で失効させる", async () => {
    const fixture = await createFixture(60 * 60 * 1000);
    const secret = createSecretToken();
    const ticket = createSecretToken();
    const joinedAt = Date.now();
    await setJoin(fixture.stub, true, secret);
    const joined = await fixture.stub.joinWithSecret(
      secret,
      await hashToken(ticket),
      crypto.randomUUID(),
      fixture.expiresAt,
    );
    expect(joined.expiresAt).toBe(fixture.expiresAt);
    expect(joined.connectBy).toBeLessThan(fixture.expiresAt);
    await runInDurableObject(fixture.stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ expires_at: number }>(
        "SELECT expires_at FROM tickets WHERE role = 'controller'",
      ).one();
      expect(row.expires_at).toBeGreaterThan(joinedAt);
      expect(row.expires_at).toBeLessThanOrEqual(joinedAt + PENDING_CONTROLLER_TICKET_TTL_MS + 100);
      expect(row.expires_at).toBe(joined.connectBy);
    });
  });

  it("期限切れroomの認証情報とSQLiteを完全削除する", async () => {
    const fixture = await createFixture();
    await runInDurableObject(fixture.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE room_state SET expires_at = ? WHERE singleton = 1", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(fixture.stub)).toBe(true);
    expect((await fixture.stub.authorizeWebSocket(fixture.hostTicket)).ok).toBe(false);
    expect(await fixture.stub.createHostTicket(
      fixture.hostToken,
      await hashToken(createSecretToken()),
      Date.now() + 60_000,
    )).toBeNull();
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(await state.storage.get("initialized")).toBeUndefined();
      const tables = state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name IN ('room_state', 'tickets', 'controllers')",
      ).toArray();
      expect(tables).toEqual([]);
    });
  });

  it("controller session数をroom単位で制限する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    await runInDurableObject(fixture.stub, (_instance, state) => {
      for (let index = 0; index < MAX_CONTROLLERS; index += 1) {
        const sessionId = crypto.randomUUID();
        state.storage.sql.exec(
          "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'controller', ?, ?)",
          `ticket-${index}`,
          sessionId,
          Date.now() + 60_000,
        );
      }
    });
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result).toEqual({ ok: false, reason: "full" });
  });
});

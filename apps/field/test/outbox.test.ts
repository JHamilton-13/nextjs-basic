import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import type { OperationEnvelope, OperationResult } from "@phc/domain";
import { openPhcDb, type Db } from "../src/lib/db";
import { Outbox, TransportError, type Transport } from "../src/lib/outbox";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const op = (n: number, auditId = "a1", o: Partial<OperationEnvelope> = {}): OperationEnvelope => ({
  opId: uuid(n), entity: "audit_item", entityId: `${auditId}:1:wall_length`, baseVersion: 0, payload: { actual64: 1 },
  createdAt: "2026-11-08T10:00:00.000Z", actor: "u1", ...o
});

let db: Db; let clock: number; let n = 0;
const applied: OperationResult = { status: "applied", newVersion: 1 };
const mk = (transport: Transport, extra: { canSend?: (a: string) => boolean } = {}) =>
  new Outbox(db, transport, { now: () => clock, baseMs: 1000, maxMs: 30000, ...extra });
const statuses = async (ob: Outbox) => (await ob.list()).map((r) => r.state.status);

beforeEach(async () => { clock = 1_000_000; db = await openPhcDb(`test-${++n}`); });

describe("Outbox", () => {
  it("persists an enqueued op durably before any network call", async () => {
    const ob = mk({ send: async () => { throw new Error("must not be called"); } });
    await ob.enqueue(op(1), "a1");
    const reopened = mk({ send: async () => applied }); // a fresh instance on the same db = app restart
    expect((await reopened.list()).map((r) => r.state.status)).toEqual(["pending"]);
  });

  it("sends in FIFO order and marks confirmed only after the server confirms", async () => {
    const sent: string[] = [];
    const ob = mk({ send: async (o) => { sent.push(o.opId); return applied; } });
    await ob.enqueue(op(1), "a1"); await ob.enqueue(op(2), "a1"); await ob.enqueue(op(3), "a2");
    const s = await ob.drain();
    expect(sent).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(await statuses(ob)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(s).toMatchObject({ confirmed: 3, failed: 0, conflicts: 0 });
  });

  it("a network error leaves the op queued as failed(retryable) and stops the drain", async () => {
    const calls: string[] = [];
    const ob = mk({ send: async (o) => { calls.push(o.opId); throw new TransportError("network", "Failed to fetch", true); } });
    await ob.enqueue(op(1), "a1"); await ob.enqueue(op(2), "a2");
    const s = await ob.drain();
    expect(calls).toEqual([uuid(1)]); // second op not tried: the network is down
    const recs = await ob.list();
    expect(recs[0]?.state).toMatchObject({ status: "failed", retryable: true, attempts: 1, lastError: "Failed to fetch" });
    expect(recs[1]?.state.status).toBe("pending");
    expect(s.networkDown).toBe(true);
    expect(await ob.pendingCount()).toBe(2);
  });

  it("retries with exponential backoff and never before it is due", async () => {
    let fail = true; const calls: number[] = [];
    const ob = mk({ send: async () => { calls.push(clock); if (fail) throw new TransportError("network", "x", true); return applied; } });
    await ob.enqueue(op(1), "a1");
    await ob.drain();                       // attempt 1 fails, next at +1000
    await ob.drain();                       // not due yet
    expect(calls).toHaveLength(1);
    clock += 1000; await ob.drain();        // attempt 2 fails, next at +2000
    expect(calls).toHaveLength(2);
    clock += 1999; await ob.drain();        // 1ms early
    expect(calls).toHaveLength(2);
    clock += 1; fail = false; await ob.drain();
    expect(calls).toHaveLength(3);
    expect(await statuses(ob)).toEqual(["confirmed"]);
  });

  it("forceNow retries immediately regardless of backoff", async () => {
    let fail = true;
    const ob = mk({ send: async () => { if (fail) throw new TransportError("network", "x", true); return applied; } });
    await ob.enqueue(op(1), "a1"); await ob.drain();
    fail = false; await ob.drain({ ignoreBackoff: true });
    expect(await statuses(ob)).toEqual(["confirmed"]);
  });

  it("app killed mid-send (power loss): recover() returns sent ops to pending and the resend is a safe duplicate", async () => {
    const ob = mk({ send: async () => applied });
    await ob.enqueue(op(1), "a1");
    const rec = (await ob.list())[0]!;
    await db.put("outbox", { ...rec, state: { ...rec.state, status: "sent" } }); // simulate crash after marking sent
    const ob2 = mk({ send: async () => ({ status: "duplicate", original: applied }) });
    expect(await ob2.recover()).toBe(1);
    expect(await statuses(ob2)).toEqual(["pending"]);
    await ob2.drain();
    expect(await statuses(ob2)).toEqual(["confirmed"]); // duplicate of an applied op counts as confirmed
  });

  it("a duplicate response of a conflict is still a conflict", async () => {
    const ob = mk({ send: async () => ({ status: "duplicate", original: { status: "conflict", currentVersion: 3, baseVersion: 0 } }) });
    await ob.enqueue(op(1), "a1"); await ob.drain();
    expect((await ob.list())[0]?.state).toMatchObject({ status: "conflict", conflictVersion: 3 });
  });

  it("a conflict is never retried and blocks later ops of the SAME audit only", async () => {
    const sent: string[] = [];
    const ob = mk({ send: async (o) => { sent.push(o.opId); return o.opId === uuid(1) ? { status: "conflict", currentVersion: 2, baseVersion: 0 } : applied; } });
    await ob.enqueue(op(1, "a1"), "a1"); await ob.enqueue(op(2, "a1"), "a1"); await ob.enqueue(op(3, "a2"), "a2");
    const s = await ob.drain();
    expect(sent).toEqual([uuid(1), uuid(3)]);
    expect(await statuses(ob)).toEqual(["conflict", "pending", "confirmed"]);
    expect(s).toMatchObject({ conflicts: 1, blockedAudits: ["a1"] });
    await ob.drain(); // draining again changes nothing
    expect(sent).toEqual([uuid(1), uuid(3)]);
  });

  it("a server rejection is failed and not retryable, blocking that audit", async () => {
    const ob = mk({ send: async () => ({ status: "rejected", message: "evidence_missing: drawingRef" }) });
    await ob.enqueue(op(1), "a1"); await ob.enqueue(op(2), "a1");
    await ob.drain();
    const recs = await ob.list();
    expect(recs[0]?.state).toMatchObject({ status: "failed", retryable: false, lastError: "evidence_missing: drawingRef" });
    expect(recs[1]?.state.status).toBe("pending");
  });

  it("a permanent server error (e.g. permission) is not retryable; an auth error is retryable", async () => {
    let kind: "perm" | "auth" = "perm";
    const ob = mk({ send: async () => { throw kind === "perm" ? new TransportError("server", "insufficient privilege", false) : new TransportError("auth", "JWT expired", true); } });
    await ob.enqueue(op(1, "a1"), "a1"); await ob.drain();
    expect((await ob.list())[0]?.state).toMatchObject({ status: "failed", retryable: false });
    kind = "auth";
    await ob.enqueue(op(2, "a2"), "a2"); await ob.drain();
    expect((await ob.list())[1]?.state).toMatchObject({ status: "failed", retryable: true });
  });

  it("only sends ops whose actor is the signed-in user", async () => {
    const sent: string[] = [];
    const ob = mk({ send: async (o) => { sent.push(o.actor); return applied; } }, { canSend: (a) => a === "u1" });
    await ob.enqueue(op(1, "a1", { actor: "u2" }), "a1"); await ob.enqueue(op(2, "a2", { actor: "u1" }), "a2");
    await ob.drain();
    expect(sent).toEqual(["u1"]);
    expect(await statuses(ob)).toEqual(["pending", "confirmed"]);
  });

  it("pendingCount ignores confirmed ops; list survives reopen", async () => {
    const ob = mk({ send: async () => applied });
    await ob.enqueue(op(1), "a1"); await ob.enqueue(op(2), "a1");
    expect(await ob.pendingCount()).toBe(2);
    await ob.drain();
    expect(await ob.pendingCount()).toBe(0);
    expect((await mk({ send: async () => applied }).list())).toHaveLength(2);
  });

  it("drains one at a time even when drain() is called concurrently (single flight)", async () => {
    let inFlight = 0; let max = 0;
    const ob = mk({ send: async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return applied; } });
    await ob.enqueue(op(1), "a1"); await ob.enqueue(op(2), "a1");
    await Promise.all([ob.drain(), ob.drain(), ob.drain()]);
    expect(max).toBe(1);
    expect(await statuses(ob)).toEqual(["confirmed", "confirmed"]);
  });
});

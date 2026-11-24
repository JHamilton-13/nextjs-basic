import { describe, it, expect } from "vitest";
import {
  validateEnvelope, applyOperation, emptyServerState, transitionStatus, nextRetryDelayMs, newClientOp,
  type OperationEnvelope, type ServerState, type ClientOpState,
} from "../src/sync";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const op = (n: number, o: Partial<OperationEnvelope> = {}): OperationEnvelope => ({
  opId: uuid(n), entity: "audit_item", entityId: "item-1", baseVersion: 0, payload: { result: "PASS" },
  createdAt: "2026-11-08T10:00:00.000Z", actor: "inst1", ...o,
});

describe("validateEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    expect(validateEnvelope(op(1)).ok).toBe(true);
  });
  it("rejects bad opId, missing actor, bad version, bad date", () => {
    expect(validateEnvelope(op(1, { opId: "nope" })).ok).toBe(false);
    expect(validateEnvelope(op(1, { actor: "" })).ok).toBe(false);
    expect(validateEnvelope(op(1, { baseVersion: -1 })).ok).toBe(false);
    expect(validateEnvelope(op(1, { baseVersion: 1.5 })).ok).toBe(false);
    expect(validateEnvelope(op(1, { createdAt: "yesterday" })).ok).toBe(false);
    expect(validateEnvelope(op(1, { entity: "" })).ok).toBe(false);
  });
});

describe("applyOperation: idempotency and versions (reference model of apply_op)", () => {
  it("applies a new op and bumps the entity version", () => {
    const { state, outcome } = applyOperation(emptyServerState(), op(1));
    expect(outcome).toEqual({ status: "applied", newVersion: 1 });
    expect(state.versions["audit_item:item-1"]).toBe(1);
  });
  it("the same opId twice applies once and returns the recorded outcome (scenario 12/14)", () => {
    const s1 = applyOperation(emptyServerState(), op(1));
    const s2 = applyOperation(s1.state, op(1));
    expect(s2.outcome).toEqual({ status: "duplicate", original: { status: "applied", newVersion: 1 } });
    expect(s2.state.versions["audit_item:item-1"]).toBe(1);
    expect(s2.state.applied).toEqual(s1.state.applied);
  });
  it("a stale baseVersion is a conflict and never overwrites (scenario 13)", () => {
    let st: ServerState = emptyServerState();
    st = applyOperation(st, op(1, { baseVersion: 0, payload: { result: "PASS" } })).state; // user A
    const b = applyOperation(st, op(2, { baseVersion: 0, actor: "inst2", payload: { result: "FAIL" } })); // user B, offline, stale
    expect(b.outcome).toEqual({ status: "conflict", currentVersion: 1, baseVersion: 0 });
    expect(b.state.versions["audit_item:item-1"]).toBe(1);
    expect(b.state.data["audit_item:item-1"]).toEqual({ result: "PASS" });
  });
  it("retrying a conflicted opId returns the same conflict", () => {
    let st = applyOperation(emptyServerState(), op(1)).state;
    const c1 = applyOperation(st, op(2, { baseVersion: 0 }));
    const c2 = applyOperation(c1.state, op(2, { baseVersion: 0 }));
    expect(c2.outcome).toEqual({ status: "duplicate", original: c1.outcome });
  });
  it("resolution with a fresh opId at the current version applies", () => {
    let st = applyOperation(emptyServerState(), op(1)).state;
    const r = applyOperation(st, op(3, { baseVersion: 1, payload: { result: "FAIL" } }));
    expect(r.outcome).toEqual({ status: "applied", newVersion: 2 });
    expect(r.state.data["audit_item:item-1"]).toEqual({ result: "FAIL" });
  });
  it("a baseVersion from the future is a conflict too", () => {
    const r = applyOperation(emptyServerState(), op(1, { baseVersion: 5 }));
    expect(r.outcome.status).toBe("conflict");
  });
  it("invalid envelopes are rejected and not recorded", () => {
    const r = applyOperation(emptyServerState(), op(1, { opId: "bad" }));
    expect(r.outcome.status).toBe("rejected");
    expect(Object.keys(r.state.applied)).toHaveLength(0);
  });
  it("does not mutate the input state", () => {
    const s0 = emptyServerState();
    applyOperation(s0, op(1));
    expect(s0).toEqual(emptyServerState());
  });
});

describe("client op status transitions", () => {
  const fresh = (): ClientOpState => newClientOp(uuid(1));
  const go = (s: ClientOpState, ...events: Parameters<typeof transitionStatus>[1][]) => {
    let cur = s;
    for (const e of events) {
      const r = transitionStatus(cur, e);
      if (!r.ok) throw new Error(`bad transition ${cur.status} + ${e.type}`);
      cur = r.value;
    }
    return cur;
  };
  it("starts pending", () => {
    expect(fresh()).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("pending -> sent -> confirmed", () => {
    const s = go(fresh(), { type: "send" }, { type: "server_confirmed" });
    expect(s.status).toBe("confirmed");
  });
  it("only confirmed counts as synced", () => {
    expect(go(fresh(), { type: "send" }).status).not.toBe("confirmed");
    expect(go(fresh(), { type: "send" }, { type: "network_error", message: "timeout" }).status).not.toBe("confirmed");
  });
  it("sent -> conflict is terminal until resolved with a new op", () => {
    const s = go(fresh(), { type: "send" }, { type: "server_conflict", currentVersion: 4 });
    expect(s.status).toBe("conflict");
    expect(transitionStatus(s, { type: "send" }).ok).toBe(false);
    expect(transitionStatus(s, { type: "server_confirmed" }).ok).toBe(false);
  });
  it("sent -> failed(retryable) -> pending increments attempts", () => {
    const s = go(fresh(), { type: "send" }, { type: "network_error", message: "offline" });
    expect(s).toMatchObject({ status: "failed", retryable: true, attempts: 1, lastError: "offline" });
    const r = go(s, { type: "retry" });
    expect(r).toMatchObject({ status: "pending", attempts: 1 });
  });
  it("a server rejection is failed and not retryable", () => {
    const s = go(fresh(), { type: "send" }, { type: "server_rejected", message: "invalid" });
    expect(s).toMatchObject({ status: "failed", retryable: false });
    expect(transitionStatus(s, { type: "retry" }).ok).toBe(false);
  });
  it("app killed mid-send (power loss, scenario 14): sent -> pending via recover; resend is safe because of idempotency", () => {
    const s = go(fresh(), { type: "send" }, { type: "recover" });
    expect(s.status).toBe("pending");
  });
  it("recover on non-sent states is a no-op transition error", () => {
    expect(transitionStatus(fresh(), { type: "recover" }).ok).toBe(false);
  });
  it("confirmed is final", () => {
    const s = go(fresh(), { type: "send" }, { type: "server_confirmed" });
    for (const t of ["send", "retry", "recover"] as const) expect(transitionStatus(s, { type: t }).ok).toBe(false);
  });
  it("cannot confirm without being sent", () => {
    expect(transitionStatus(fresh(), { type: "server_confirmed" }).ok).toBe(false);
  });
});

describe("nextRetryDelayMs", () => {
  it("backs off exponentially and caps", () => {
    const o = { baseMs: 1000, maxMs: 30000 };
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => nextRetryDelayMs(n, o))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
  it("never returns NaN or negative for odd input", () => {
    const o = { baseMs: 1000, maxMs: 30000 };
    expect(nextRetryDelayMs(-5, o)).toBe(1000);
    expect(nextRetryDelayMs(Number.NaN, o)).toBe(1000);
    expect(nextRetryDelayMs(1e9, o)).toBe(30000);
  });
});

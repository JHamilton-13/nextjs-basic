import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { parseLength } from "@phc/domain";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import { startAudit, recordMeasurement, reconcileFromServer, auditSummary } from "../src/lib/audits";
import type { TemplateConfig } from "../src/lib/types";

const L = (s: string) => { const r = parseLength(s); if (!r.ok) throw new Error(s); return r.value; };
const config: TemplateConfig = {
  policy: { nonCriticalIssueState: "manager_review_required" },
  sections: [
    { key: "walls", title: "Walls", items: [
      { key: "wall_length", label: "Wall length", kind: "tolerance", critical: false, requires: { measurement: true, drawingRef: true },
        rule: { plus64: 32, minus64: 32, reviewBand64: 64, source: "company_standard", sourceRef: "Owner 2026-11-07", method: "tape measure" } },
      { key: "wall_plumb", label: "Plumb (observation)", kind: "observation", critical: false },
      { key: "access", label: "Access", kind: "check", critical: false }] },
    { key: "mep", title: "MEP", items: [{ key: "outlets", label: "Outlets", kind: "check", critical: true, requires: { photo: 1 } }] }
  ]
};
const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201"; const T = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000301";

let db: Db; let ob: Outbox; let n = 0; let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(9000 + ++seq).padStart(12, "0")}`;
const ctx = () => ({ db, outbox: ob, userId: "u1", newId: ids, now: () => "2026-11-08T10:00:00.000Z" });

beforeEach(async () => {
  db = await openPhcDb(`audits-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [{ id: R, project_id: P, name: "Kitchen", floor: null }], templates: [{ id: T, name: "Tpl", version: 1, config }] });
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
});

describe("startAudit (works fully offline)", () => {
  it("creates the audit and its items locally and queues exactly one create op", async () => {
    const r = await startAudit(ctx(), { auditId: A, projectId: P, roomId: R, templateId: T });
    expect(r.ok).toBe(true);
    expect((await db.get("audits", A))).toMatchObject({ auditId: A, version: 1, projectId: P, roomId: R, templateId: T, createdBy: "u1" });
    const items = await db.getAllFromIndex("items", "by_audit", A);
    expect(items.map((i) => i.itemKey).sort()).toEqual(["access", "outlets", "wall_length", "wall_plumb"]);
    expect(items.find((i) => i.itemKey === "outlets")).toMatchObject({ critical: true, kind: "check", result: "NOT_ENTERED", nextBase: 0, pending: false });
    const q = await ob.list();
    expect(q).toHaveLength(1);
    expect(q[0]?.op).toMatchObject({ entity: "audit", entityId: `${A}:1`, baseVersion: 0, actor: "u1", payload: { action: "create", projectId: P, roomId: R, templateId: T } });
    expect(q[0]?.state.status).toBe("pending");
  });
  it("rejects an unknown template or project from the cache", async () => {
    const r1 = await startAudit(ctx(), { auditId: A, projectId: P, roomId: null, templateId: "nope" });
    expect(!r1.ok && r1.error.code).toBe("template_not_cached");
    const r2 = await startAudit(ctx(), { auditId: A, projectId: "nope", roomId: null, templateId: T });
    expect(!r2.ok && r2.error.code).toBe("project_not_cached");
    expect(await ob.list()).toHaveLength(0);
  });
  it("is idempotent for the same audit id (no duplicate create op)", async () => {
    await startAudit(ctx(), { auditId: A, projectId: P, roomId: null, templateId: T });
    const again = await startAudit(ctx(), { auditId: A, projectId: P, roomId: null, templateId: T });
    expect(!again.ok && again.error.code).toBe("audit_exists");
    expect(await ob.list()).toHaveLength(1);
  });
});

describe("recordMeasurement", () => {
  beforeEach(async () => { await startAudit(ctx(), { auditId: A, projectId: P, roomId: R, templateId: T }); });
  const rec = (expected: string, actual: string, extra: Partial<Parameters<typeof recordMeasurement>[1]> = {}) =>
    recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected, actual, drawingRef: "A-201 rev C", ...extra });

  it("shows a provisional PASS/REVIEW/FAIL using the template rule (never hardcoded)", async () => {
    for (const [actual, want] of [['120"', "PASS"], ['120 1/2"', "PASS"], ['119 1/2"', "PASS"], ['120 33/64"', "REVIEW"], ['121"', "REVIEW"], ['121 1/64"', "FAIL"], ['118 63/64"', "FAIL"]] as const) {
      const r = await rec('120"', actual);
      expect(r.ok && r.value.result, actual).toBe(want);
    }
  });
  it("queues an apply_op with 1/64-inch integers and the right base version", async () => {
    const r1 = await rec('120"', '121"'); expect(r1.ok).toBe(true);
    const r2 = await rec('120"', '120 1/4"'); expect(r2.ok).toBe(true);
    const ops = (await ob.list()).filter((x) => x.op.entity === "audit_item");
    expect(ops).toHaveLength(2);
    expect(ops[0]?.op).toMatchObject({ entityId: `${A}:1:wall_length`, baseVersion: 0, actor: "u1", payload: { actual64: L('121"'), expected64: L('120"'), drawingRef: "A-201 rev C" } });
    expect(ops[1]?.op.baseVersion).toBe(1); // second offline edit builds on the first
    const item = await db.get("items", `${A}:1:wall_length`);
    expect(item).toMatchObject({ pending: true, nextBase: 2, actual64: L('120 1/4"'), deviation64: 16, result: "PASS" });
  });
  it("accepts feet-inches and millimetres", async () => {
    const r = await rec("10'", "3048 mm");
    expect(r.ok && r.value.result).toBe("PASS");
  });
  it("refuses to save without the required drawing reference (evidence rule) and queues nothing", async () => {
    const before = (await ob.list()).length;
    const r = await recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected: '120"', actual: '120"', drawingRef: "  " });
    expect(!r.ok && r.error.code).toBe("evidence_missing");
    expect(!r.ok && r.error.code === "evidence_missing" && r.error.missing.map((m) => m.kind)).toEqual(["drawingRef"]);
    expect((await ob.list()).length).toBe(before);
  });
  it("returns typed errors for bad numbers, wrong item kinds and unknown items", async () => {
    const bad = await rec('120"', "abc"); expect(!bad.ok && bad.error.code).toBe("invalid_length");
    const empty = await rec("", '120"'); expect(!empty.ok && empty.error.code).toBe("invalid_length");
    const kind = await recordMeasurement(ctx(), { auditId: A, itemKey: "access", expected: '1"', actual: '1"', drawingRef: "x" });
    expect(!kind.ok && kind.error.code).toBe("not_a_measurement_item");
    const unk = await recordMeasurement(ctx(), { auditId: A, itemKey: "zzz", expected: '1"', actual: '1"', drawingRef: "x" });
    expect(!unk.ok && unk.error.code).toBe("unknown_item");
  });
});

describe("reconcileFromServer (server result is authoritative once confirmed)", () => {
  it("overwrites the provisional result and base version only when nothing is pending", async () => {
    await startAudit(ctx(), { auditId: A, projectId: P, roomId: R, templateId: T });
    await recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected: '120"', actual: '120 3/4"', drawingRef: "x" });
    const rows = [{ item_key: "wall_length", result: "REVIEW", row_version: 1 }];
    await reconcileFromServer(db, A, rows, { hasPendingOps: true });
    expect((await db.get("items", `${A}:1:wall_length`))?.result).toBe("REVIEW"); // provisional (computed locally: 48/64 over -> REVIEW)
    expect((await db.get("items", `${A}:1:wall_length`))?.pending).toBe(true);
    await reconcileFromServer(db, A, [{ item_key: "wall_length", result: "PASS", row_version: 1 }], { hasPendingOps: false });
    expect(await db.get("items", `${A}:1:wall_length`)).toMatchObject({ result: "PASS", pending: false, nextBase: 1 });
  });
});

describe("auditSummary", () => {
  it("counts entered items and flags a critical fail", async () => {
    await startAudit(ctx(), { auditId: A, projectId: P, roomId: R, templateId: T });
    expect(await auditSummary(db, A)).toMatchObject({ total: 4, entered: 0, criticalFail: false });
    await recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected: '120"', actual: '125"', drawingRef: "x" });
    expect(await auditSummary(db, A)).toMatchObject({ entered: 1, fail: 1, criticalFail: false });
  });
});

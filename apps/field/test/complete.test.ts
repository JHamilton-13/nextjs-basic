import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import { startAudit, recordCheck, recordMeasurement, submitAudit, auditReadiness, groupedItems } from "../src/lib/audits";
import { addPhoto, photoCount, finalizeConfirmedPhotos, type Compressor } from "../src/lib/photos";
import type { TemplateConfig } from "../src/lib/types";

const config: TemplateConfig = {
  policy: { nonCriticalIssueState: "manager_review_required" },
  sections: [
    { key: "walls", title: "Walls", items: [
      { key: "wall_length", label: "Wall length", kind: "tolerance", critical: false, requires: { measurement: true, drawingRef: true, photo: 1 },
        rule: { plus64: 32, minus64: 32, reviewBand64: 64, source: "company_standard", sourceRef: "Owner 2026-11-07", method: "tape measure" } },
      { key: "wall_plumb", label: "Plumb (observation)", kind: "observation", critical: false, requires: { note: true } },
      { key: "access", label: "Access", kind: "check", critical: false }] },
    { key: "mep", title: "MEP", items: [
      { key: "outlets", label: "Outlets", kind: "check", critical: true, requires: { photo: 1 } },
      { key: "sprinklers", label: "Sprinklers", kind: "check", critical: true, requires: { photo: 1 } },
      { key: "approval_item", label: "Needs approval", kind: "check", critical: false, requires: { supervisorApproval: true } }] }
  ]
};
const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201"; const T = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000301";

let db: Db; let ob: Outbox; let n = 0; let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(7000 + ++seq).padStart(12, "0")}`;
const ctx = () => ({ db, outbox: ob, userId: "u1", newId: ids, now: () => "2026-11-08T10:00:00.000Z" });
const compress: Compressor = async (file) => ({ blob: new Blob([new Uint8Array(500)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", original: file });
const pctx = () => ({ ...ctx(), compress });
const jpg = () => new Blob([new Uint8Array(2000)], { type: "image/jpeg" });

beforeEach(async () => {
  db = await openPhcDb(`complete-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [{ id: R, project_id: P, name: "Kitchen", floor: null }], templates: [{ id: T, name: "Tpl", version: 1, config }] });
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
  await startAudit(ctx(), { auditId: A, projectId: P, roomId: R, templateId: T });
});

describe("addPhoto (offline)", () => {
  it("stores the compressed photo + original locally and queues register, upload, confirm with the right lanes and dependencies", async () => {
    const r = await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ auditId: A, projectId: P, itemKey: "outlets", mime: "image/jpeg", bytes: 500, confirmed: false, capturedBy: "u1" });
    expect(r.value.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.storagePath).toBe(`${P}/${A}/${r.value.id}.jpg`);
    const stored = await db.get("photos", r.value.id);
    expect(stored?.blob?.size).toBe(500); expect(stored?.originalBlob?.size).toBe(2000);
    const q = (await ob.list()).filter((x) => x.op.entity === "photo");
    expect(q.map((x) => [x.op.payload.action, x.lane ?? "data"])).toEqual([["register", "data"], ["upload", "files"], ["confirm", "files"]]);
    expect(q[1]?.after).toEqual([q[0]?.op.opId]); expect(q[2]?.after).toEqual([q[1]?.op.opId]);
    expect(q[0]?.op.payload).toMatchObject({ projectId: P, auditId: A, itemKey: "outlets", bytes: 500, storagePath: r.value.storagePath, sha256: r.value.sha256 });
  });
  it("counts photos per item and allows overall (no item) photos", async () => {
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    await addPhoto(pctx(), { auditId: A, itemKey: null, file: jpg() });
    expect(await photoCount(db, A, "outlets")).toBe(1);
    expect(await photoCount(db, A, "sprinklers")).toBe(0);
    expect(await photoCount(db, A, null)).toBe(1);
  });
  it("rejects unknown audits, unknown items, empty or failed compression, and oversize files", async () => {
    expect((await addPhoto(pctx(), { auditId: "nope", itemKey: null, file: jpg() }))).toMatchObject({ ok: false, error: { code: "audit_not_found" } });
    expect((await addPhoto(pctx(), { auditId: A, itemKey: "zzz", file: jpg() }))).toMatchObject({ ok: false, error: { code: "unknown_item" } });
    const bad = await addPhoto({ ...ctx(), compress: async () => { throw new Error("decode failed"); } }, { auditId: A, itemKey: null, file: jpg() });
    expect(bad).toMatchObject({ ok: false, error: { code: "compress_failed" } });
    const huge = await addPhoto({ ...ctx(), compress: async (f) => ({ blob: new Blob([new Uint8Array(11 * 1024 * 1024)]), thumb: "t", mime: "image/jpeg", original: f }) }, { auditId: A, itemKey: null, file: jpg() });
    expect(huge).toMatchObject({ ok: false, error: { code: "file_too_large" } });
    expect((await ob.list()).filter((x) => x.op.entity === "photo")).toHaveLength(0);
  });
  it("finalizeConfirmedPhotos drops the heavy blobs only after the confirm op is confirmed", async () => {
    const r = await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    if (!r.ok) throw new Error("setup");
    expect(await finalizeConfirmedPhotos(db, ob)).toBe(0);                  // nothing confirmed yet: nothing removed
    expect((await db.get("photos", r.value.id))?.blob).toBeDefined();
    const q = (await ob.list()).filter((x) => x.op.entity === "photo");
    const confirmRec = q[2]!;
    await db.put("outbox", { ...confirmRec, state: { ...confirmRec.state, status: "confirmed" } });
    expect(await finalizeConfirmedPhotos(db, ob)).toBe(1);
    const after = await db.get("photos", r.value.id);
    expect(after).toMatchObject({ confirmed: true, thumb: "data:image/jpeg;base64,AAAA" });
    expect(after?.blob).toBeUndefined(); expect(after?.originalBlob).toBeUndefined();
  });
});

describe("recordCheck", () => {
  it("records PASS/FAIL/REVIEW/N/A for check items and queues an op with the right base version", async () => {
    const r = await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS", note: "clear" });
    expect(r.ok).toBe(true);
    const op = (await ob.list()).find((x) => x.op.entityId === `${A}:1:access`)!.op;
    expect(op).toMatchObject({ entity: "audit_item", baseVersion: 0, actor: "u1", payload: { result: "PASS", note: "clear" } });
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "FAIL" });
    const ops = (await ob.list()).filter((x) => x.op.entityId === `${A}:1:access`);
    expect(ops.map((x) => x.op.baseVersion)).toEqual([0, 1]);
    expect(await db.get("items", `${A}:1:access`)).toMatchObject({ result: "FAIL", pending: true, nextBase: 2 });
  });
  it("critical MEP item needs its photo first (evidence rule), then succeeds", async () => {
    const no = await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS" });
    expect(no).toMatchObject({ ok: false, error: { code: "evidence_missing" } });
    expect(!no.ok && no.error.code === "evidence_missing" && no.error.missing).toEqual([{ kind: "photo", required: 1, have: 0 }]);
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    const yes = await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL", note: "outlet in filler zone" });
    expect(yes.ok).toBe(true);
  });
  it("orders the photo's register op BEFORE the result op (the server counts registered photos)", async () => {
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL" });
    const q = await ob.list();
    const reg = q.findIndex((x) => x.op.entity === "photo" && x.op.payload.action === "register");
    const res = q.findIndex((x) => x.op.entityId === `${A}:1:outlets`);
    expect(reg).toBeGreaterThan(-1); expect(res).toBeGreaterThan(reg);
  });
  it("observation items record OBSERVED and honour a required note", async () => {
    const no = await recordCheck(ctx(), { auditId: A, itemKey: "wall_plumb", result: "OBSERVED" });
    expect(no).toMatchObject({ ok: false, error: { code: "evidence_missing" } });
    const yes = await recordCheck(ctx(), { auditId: A, itemKey: "wall_plumb", result: "OBSERVED", note: "leans 1/2in" });
    expect(yes.ok).toBe(true);
    expect((await db.get("items", `${A}:1:wall_plumb`))?.result).toBe("OBSERVED");
  });
  it("rejects invalid combinations: PASS on an observation, OBSERVED on a check, a measurement item, unknown item, supervisor approval", async () => {
    expect(await recordCheck(ctx(), { auditId: A, itemKey: "wall_plumb", result: "PASS", note: "x" })).toMatchObject({ ok: false, error: { code: "invalid_result" } });
    expect(await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "OBSERVED" })).toMatchObject({ ok: false, error: { code: "invalid_result" } });
    expect(await recordCheck(ctx(), { auditId: A, itemKey: "wall_length", result: "PASS" })).toMatchObject({ ok: false, error: { code: "use_measurement" } });
    expect(await recordCheck(ctx(), { auditId: A, itemKey: "zzz", result: "PASS" })).toMatchObject({ ok: false, error: { code: "unknown_item" } });
    const sup = await recordCheck(ctx(), { auditId: A, itemKey: "approval_item", result: "PASS" });
    expect(sup).toMatchObject({ ok: false, error: { code: "evidence_missing" } });
  });
  it("tolerance items can now require photos too", async () => {
    const m = { auditId: A, itemKey: "wall_length", expected: '120"', actual: '120"', drawingRef: "A-1" };
    expect(await recordMeasurement(ctx(), m)).toMatchObject({ ok: false, error: { code: "evidence_missing" } });
    await addPhoto(pctx(), { auditId: A, itemKey: "wall_length", file: jpg() });
    expect((await recordMeasurement(ctx(), m)).ok).toBe(true);
  });
});

describe("submitAudit and readiness (owner decisions: no result gating; managers release)", () => {
  it("submits with nothing entered, queues one submit op with baseVersion 1, and locks the audit locally", async () => {
    const r = await submitAudit(ctx(), { auditId: A });
    expect(r.ok).toBe(true);
    const op = (await ob.list()).find((x) => x.op.entity === "audit" && x.op.payload.action === "submit")!.op;
    expect(op).toMatchObject({ entityId: `${A}:1`, baseVersion: 1, actor: "u1" });
    expect((await db.get("audits", A))?.submittedAt).toBe("2026-11-08T10:00:00.000Z");
    expect(await submitAudit(ctx(), { auditId: A })).toMatchObject({ ok: false, error: { code: "already_submitted" } });
  });
  it("after submit, results and measurements are refused (server would too) but late photos are allowed", async () => {
    await submitAudit(ctx(), { auditId: A });
    expect(await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS" })).toMatchObject({ ok: false, error: { code: "audit_submitted" } });
    expect(await recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected: '1"', actual: '1"', drawingRef: "x" })).toMatchObject({ ok: false, error: { code: "audit_submitted" } });
    expect((await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() })).ok).toBe(true);
  });
  it("readiness preview follows the domain rules and the template policy", async () => {
    expect((await auditReadiness(db, A)).state).toBe("not_started");
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS" });
    expect((await auditReadiness(db, A)).state).toBe("in_progress");
    await addPhoto(pctx(), { auditId: A, itemKey: "sprinklers", file: jpg() });
    await recordCheck(ctx(), { auditId: A, itemKey: "sprinklers", result: "FAIL" });
    expect((await auditReadiness(db, A)).state).toBe("not_ready");            // critical FAIL flags immediately
    await submitAudit(ctx(), { auditId: A });
    const r = await auditReadiness(db, A);
    expect(r.state).toBe("not_ready");
    expect(r.criticalNotEntered).toEqual(["outlets"]);                         // warned about, but does not block (owner decision)
  });
  it("non-critical FAIL after submit gives manager_review_required (template policy); a clean audit is ready", async () => {
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "FAIL" });
    await submitAudit(ctx(), { auditId: A });
    expect((await auditReadiness(db, A)).state).toBe("manager_review_required");
  });
  it("a server-reported state takes precedence over the local preview", async () => {
    await submitAudit(ctx(), { auditId: A });
    const a = (await db.get("audits", A))!;
    await db.put("audits", { ...a, serverState: "released_for_installation" });
    expect((await auditReadiness(db, A)).state).toBe("released_for_installation");
  });
});

describe("groupedItems", () => {
  it("groups by section in template order and counts entered items", async () => {
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS" });
    const g = await groupedItems(db, A);
    expect(g.map((s) => s.title)).toEqual(["Walls", "MEP"]);
    expect(g[0]).toMatchObject({ total: 3, entered: 1 });
    expect(g[1]?.items.map((i) => i.itemKey)).toEqual(["outlets", "sprinklers", "approval_item"]);
  });
});

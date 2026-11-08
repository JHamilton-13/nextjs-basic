import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import { startAudit, recordCheck, recordMeasurement, submitAudit, reviseAudit, latestAudit, auditReadiness, groupedItems, reconcileFromServer } from "../src/lib/audits";
import { addPhoto, addAnnotatedPhoto, photoCount, photoSourceBlob, finalizeConfirmedPhotos, type Compressor } from "../src/lib/photos";
import type { Shape } from "../src/lib/annotations";
import type { TemplateConfig } from "../src/lib/types";

const config: TemplateConfig = {
  policy: { nonCriticalIssueState: "manager_review_required" },
  sections: [
    { key: "walls", title: "Walls", items: [
      { key: "wall_length", label: "Wall length", kind: "tolerance", critical: false, requires: { measurement: true, drawingRef: true },
        rule: { plus64: 32, minus64: 32, reviewBand64: 64, source: "company_standard", sourceRef: "Owner", method: "tape" } },
      { key: "access", label: "Access", kind: "check", critical: false }] },
    { key: "mep", title: "MEP", items: [{ key: "outlets", label: "Outlets", kind: "check", critical: true, requires: { photo: 1 } }] }
  ]
};
const P = "00000000-0000-4000-8000-000000000101"; const T = "aaaaaaaa-0000-4000-8000-000000000001"; const A = "00000000-0000-4000-8000-000000000301";
let db: Db; let ob: Outbox; let n = 0; let seq = 0; let clock = 0; let label = "Pat Installer";
const ids = () => `00000000-0000-4000-8000-${String(8000 + ++seq).padStart(12, "0")}`;
const ctx = () => ({ db, outbox: ob, userId: "u1", userLabel: label, newId: ids, now: () => new Date(Date.UTC(2026, 10, 8, 9, 0, 0) + clock * 60_000).toISOString() });
const compress: Compressor = async (file) => ({ blob: new Blob([new Uint8Array(500)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", original: file });
const pctx = () => ({ ...ctx(), compress });
const jpg = () => new Blob([new Uint8Array(2000)], { type: "image/jpeg" });
const flat = { blob: new Blob([new Uint8Array(700)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,BBBB", mime: "image/jpeg" };
const shapes: Shape[] = [
  { type: "pen", color: "#e53935", width: 0.01, points: [[0.1, 0.1], [0.4, 0.4]] },
  { type: "highlight", color: "#fdd835", width: 0.03, points: [[0.2, 0.5], [0.8, 0.5]] },
  { type: "text", color: "#111111", size: 0.05, at: [0.3, 0.6], text: "wrong spot" },
];

beforeEach(async () => {
  clock = 0; label = "Pat Installer";
  db = await openPhcDb(`revise-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [], templates: [{ id: T, name: "Tpl", version: 1, config }] });
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
  await startAudit(ctx(), { auditId: A, projectId: P, roomId: null, templateId: T });
});

describe("who and when (attribution uses the time it happened on site)", () => {
  it("records who recorded a result and when; the audit records who started and who submitted it", async () => {
    clock = 5; await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS" });
    const item = await db.get("items", `${A}:1:access`);
    expect(item).toMatchObject({ resultBy: "Pat Installer", resultAt: "2026-11-08T09:05:00.000Z" });
    expect(item?.issueBy).toBeUndefined();
    clock = 30; await submitAudit(ctx(), { auditId: A });
    expect(await db.get("audits", `${A}:1`)).toMatchObject({ createdByLabel: "Pat Installer", submittedBy: "u1", submittedByLabel: "Pat Installer", submittedAt: "2026-11-08T09:30:00.000Z" });
  });
  it("a FAIL raises an issue with its raiser and time; a later FAIL by someone else keeps the original raiser", async () => {
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    clock = 10; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL" });
    expect(await db.get("items", `${A}:1:outlets`)).toMatchObject({ issueBy: "Pat Installer", issueAt: "2026-11-08T09:10:00.000Z", resultBy: "Pat Installer" });
    label = "Sam Lead"; clock = 25; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL", note: "still wrong" });
    expect(await db.get("items", `${A}:1:outlets`)).toMatchObject({ resultBy: "Sam Lead", resultAt: "2026-11-08T09:25:00.000Z", issueBy: "Pat Installer", issueAt: "2026-11-08T09:10:00.000Z" });
  });
  it("a PASS clears the issue; raising it again records a new raiser and time", async () => {
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    clock = 1; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL" });
    clock = 2; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS" });
    const passed = await db.get("items", `${A}:1:outlets`);
    expect(passed?.issueBy).toBeUndefined(); expect(passed?.issueAt).toBeUndefined();
    label = "Sam Lead"; clock = 3; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "REVIEW" });
    expect(await db.get("items", `${A}:1:outlets`)).toMatchObject({ issueBy: "Sam Lead", issueAt: "2026-11-08T09:03:00.000Z" });
  });
  it("a measurement outside tolerance raises an issue too", async () => {
    clock = 4; await recordMeasurement(ctx(), { auditId: A, itemKey: "wall_length", expected: '120"', actual: '125"', drawingRef: "A-1" });
    expect(await db.get("items", `${A}:1:wall_length`)).toMatchObject({ result: "FAIL", issueBy: "Pat Installer", issueAt: "2026-11-08T09:04:00.000Z" });
  });
  it("the server's names and times replace the local ones after sync", async () => {
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "FAIL" });
    await reconcileFromServer(db, A, 1, [{ item_key: "access", result: "FAIL", row_version: 1, result_at: "2026-11-08T09:00:00Z", result_by_label: "Pat Installer (server)", issue_raised_at: "2026-11-08T09:00:00Z", issue_raised_by_label: "Pat Installer (server)" }], { hasPendingOps: false });
    expect(await db.get("items", `${A}:1:access`)).toMatchObject({ resultBy: "Pat Installer (server)", issueBy: "Pat Installer (server)", pending: false });
  });
});

describe("reviseAudit (offline)", () => {
  async function submitted() {
    await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() });
    clock = 5; await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL", note: "wrong spot" });
    await recordCheck(ctx(), { auditId: A, itemKey: "access", result: "PASS" });
    clock = 20; await submitAudit(ctx(), { auditId: A });
  }
  it("needs a submitted audit and a reason", async () => {
    expect(await reviseAudit(ctx(), { auditId: A, reason: "why" })).toMatchObject({ ok: false, error: { code: "not_submitted" } });
    await submitted();
    expect(await reviseAudit(ctx(), { auditId: A, reason: "   " })).toMatchObject({ ok: false, error: { code: "reason_required" } });
    expect(await reviseAudit(ctx(), { auditId: "nope", reason: "x" })).toMatchObject({ ok: false, error: { code: "audit_not_found" } });
  });
  it("creates version 2 locally with results and who/when carried over, and queues one revise op after the submit", async () => {
    await submitted();
    clock = 40;
    const r = await reviseAudit(ctx(), { auditId: A, reason: "Re-measured after GC moved the outlet" });
    expect(r).toMatchObject({ ok: true, value: { version: 2 } });
    const v2 = await latestAudit(db, A);
    expect(v2).toMatchObject({ key: `${A}:2`, version: 2, reviseReason: "Re-measured after GC moved the outlet", createdByLabel: "Pat Installer" });
    expect(v2?.submittedAt).toBeUndefined();
    const items = await db.getAllFromIndex("items", "by_audit", `${A}:2`);
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.itemKey === "outlets")).toMatchObject({ key: `${A}:2:outlets`, version: 2, auditKey: `${A}:2`, result: "FAIL", note: "wrong spot", resultBy: "Pat Installer", issueBy: "Pat Installer", pending: false, nextBase: 0 });
    const q = await ob.list();
    const last = q[q.length - 1]!;
    expect(last.op).toMatchObject({ entity: "audit", entityId: `${A}:2`, baseVersion: 0, payload: { action: "revise", reason: "Re-measured after GC moved the outlet" } });
    const submitIdx = q.findIndex((x) => x.op.entity === "audit" && x.op.payload.action === "submit");
    expect(submitIdx).toBeGreaterThan(-1); expect(submitIdx).toBeLessThan(q.length - 1);
  });
  it("leaves version 1 untouched and read-only; edits go to version 2 with :2: entity ids", async () => {
    await submitted();
    await reviseAudit(ctx(), { auditId: A, reason: "fix" });
    const v1 = await db.get("audits", `${A}:1`);
    expect(v1?.submittedAt).toBeDefined();
    expect((await db.get("items", `${A}:1:outlets`))?.result).toBe("FAIL");
    clock = 60; expect((await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS", note: "moved" })).ok).toBe(true);
    expect((await db.get("items", `${A}:1:outlets`))?.result).toBe("FAIL");            // version 1 unchanged
    expect(await db.get("items", `${A}:2:outlets`)).toMatchObject({ result: "PASS", pending: true, nextBase: 1, resultAt: "2026-11-08T10:00:00.000Z" });
    const op = (await ob.list()).filter((x) => x.op.entity === "audit_item").pop()!.op;
    expect(op).toMatchObject({ entityId: `${A}:2:outlets`, baseVersion: 0 });
  });
  it("earlier-version photos still satisfy a photo requirement in the new version", async () => {
    await submitted();
    await reviseAudit(ctx(), { auditId: A, reason: "fix" });
    expect(await photoCount(db, A, "outlets")).toBe(1);
    expect((await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS", note: "moved" })).ok).toBe(true);
  });
  it("version 2 can be submitted with its own submit op (entityId :2, base 1); cannot revise an unsubmitted version 2", async () => {
    await submitted();
    await reviseAudit(ctx(), { auditId: A, reason: "fix" });
    expect(await reviseAudit(ctx(), { auditId: A, reason: "again" })).toMatchObject({ ok: false, error: { code: "not_submitted" } });
    await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS", note: "moved" });
    expect((await submitAudit(ctx(), { auditId: A })).ok).toBe(true);
    const op = (await ob.list()).filter((x) => x.op.entity === "audit" && x.op.payload.action === "submit").pop()!.op;
    expect(op).toMatchObject({ entityId: `${A}:2`, baseVersion: 1 });
    expect((await reviseAudit(ctx(), { auditId: A, reason: "third" })).ok).toBe(true);        // v3 is allowed once v2 is submitted
    expect((await latestAudit(db, A))?.version).toBe(3);
  });
  it("readiness and sections can be read for any version", async () => {
    await submitted();
    await reviseAudit(ctx(), { auditId: A, reason: "fix" });
    await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "PASS", note: "moved" });
    expect((await auditReadiness(db, A, 1)).state).toBe("not_ready");
    expect((await auditReadiness(db, A)).state).toBe("in_progress");
    expect((await groupedItems(db, A, 1)).flatMap((g) => g.items).find((i) => i.itemKey === "outlets")?.result).toBe("FAIL");
    expect((await groupedItems(db, A)).flatMap((g) => g.items).find((i) => i.itemKey === "outlets")?.result).toBe("PASS");
  });
});

describe("annotated photo copies", () => {
  async function original() { const r = await addPhoto(pctx(), { auditId: A, itemKey: "outlets", file: jpg() }); if (!r.ok) throw new Error("setup"); return r.value; }

  it("saves a flattened copy linked to the untouched original, with editable marks, queued like any photo", async () => {
    const o = await original();
    const r = await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: flat });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ annotatedFrom: o.id, itemKey: "outlets", bytes: 700, version: 1, confirmed: false });
    expect(r.value.annotations).toHaveLength(3);
    expect(await db.get("photos", o.id)).toMatchObject({ bytes: 500 });                        // the original is unchanged
    expect((await db.get("photos", o.id))?.annotatedFrom).toBeUndefined();
    const q = (await ob.list()).filter((x) => x.op.entity === "photo" && x.op.entityId === r.value.id);
    expect(q.map((x) => [x.op.payload.action, x.lane ?? "data"])).toEqual([["register", "data"], ["upload", "files"], ["confirm", "files"]]);
    expect(q[0]?.op.payload).toMatchObject({ annotatedFrom: o.id, version: 1 });
    expect((q[0]?.op.payload.annotations as unknown[]).length).toBe(3);
    expect(q[1]?.op.payload.annotations).toBeUndefined();                                        // marks travel with the register step only
  });
  it("an annotated copy is not extra evidence", async () => {
    const o = await original();
    await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: flat });
    expect(await photoCount(db, A, "outlets")).toBe(1);
  });
  it("editing marks again creates a NEW copy (history kept); an annotated copy cannot itself be annotated", async () => {
    const o = await original();
    const c1 = await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: flat });
    const c2 = await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes: [shapes[0]!], flattened: flat });
    expect(c1.ok && c2.ok && c1.value.id !== c2.value.id).toBe(true);
    expect((await db.getAllFromIndex("photos", "by_audit", A)).filter((p) => p.annotatedFrom === o.id)).toHaveLength(2);
    if (!c1.ok) return;
    expect(await addAnnotatedPhoto(ctx(), { originalId: c1.value.id, shapes, flattened: flat })).toMatchObject({ ok: false, error: { code: "cannot_annotate_a_copy" } });
  });
  it("rejects invalid marks, missing photos and empty/oversize images", async () => {
    const o = await original();
    expect(await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes: [], flattened: flat })).toMatchObject({ ok: false, error: { code: "invalid_annotations" } });
    expect(await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes: [{ type: "pen", color: "red", width: 0.01, points: [[0, 0]] } as never], flattened: flat })).toMatchObject({ ok: false, error: { code: "invalid_annotations" } });
    expect(await addAnnotatedPhoto(ctx(), { originalId: "nope", shapes, flattened: flat })).toMatchObject({ ok: false, error: { code: "photo_not_found" } });
    expect(await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: { ...flat, blob: new Blob([]) } })).toMatchObject({ ok: false, error: { code: "compress_failed" } });
    expect(await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: { ...flat, blob: new Blob([new Uint8Array(11 * 1024 * 1024)]) } })).toMatchObject({ ok: false, error: { code: "file_too_large" } });
    expect((await ob.list()).filter((x) => x.op.payload.annotations)).toHaveLength(0);
  });
  it("can annotate a photo from an earlier version; the copy belongs to the current version", async () => {
    const o = await original();
    await recordCheck(ctx(), { auditId: A, itemKey: "outlets", result: "FAIL" });
    await submitAudit(ctx(), { auditId: A });
    await reviseAudit(ctx(), { auditId: A, reason: "fix" });
    const r = await addAnnotatedPhoto(ctx(), { originalId: o.id, shapes, flattened: flat });
    expect(r.ok && r.value.version).toBe(2);
  });
  it("the original stays available for editing marks until the version is submitted and confirmed", async () => {
    const o = await original();
    expect(photoSourceBlob((await db.get("photos", o.id))!)?.size).toBeGreaterThan(0);
    await submitAudit(ctx(), { auditId: A });
    const confirmRec = (await ob.list()).filter((x) => x.op.entity === "photo" && x.op.payload.action === "confirm")[0]!;
    await db.put("outbox", { ...confirmRec, state: { ...confirmRec.state, status: "confirmed" } });
    expect(await finalizeConfirmedPhotos(db, ob)).toBe(1);
    expect(photoSourceBlob((await db.get("photos", o.id))!)).toBeNull();                      // gone locally: editing needs a download
  });
});

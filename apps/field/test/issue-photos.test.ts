import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import { addAnnotatedIssuePhoto, addIssuePhoto, ensureRemoteThumb, finalizeConfirmedPhotos, type Compressor } from "../src/lib/photos";
import { createIssue, type IssueCtx } from "../src/lib/issues";
import type { Shape } from "../src/lib/annotations";

const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201";
const compress: Compressor = async (file) => ({ blob: new Blob([new Uint8Array(500)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", original: file });
const jpg = () => new Blob([new Uint8Array(100)], { type: "image/jpeg" });
const pen: Shape = { type: "pen", color: "#e53935", width: 0.01, points: [[0.1, 0.1], [0.5, 0.5]] };

let db: Db; let ob: Outbox; let n = 0; let seq = 0; let clock = 0;
const ctx = (): IssueCtx => ({ db, userId: "u1", userLabel: "Pat Installer", compress, notify: () => ob.notify(),
  newId: () => `00000000-0000-4000-8000-${String(6000 + ++seq).padStart(12, "0")}`, now: () => `2026-11-08T10:${String(10 + ++clock).padStart(2, "0")}:00.000Z` });
const mk = async (files: Blob[] = []) => { const r = await createIssue(ctx(), { roomId: R, kind: "missing_part", tradeId: null, title: "Pull missing", files }); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

beforeEach(async () => {
  db = await openPhcDb(`issue-photos-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [{ id: R, project_id: P, name: "Kitchen", floor: null }], templates: [], trades: [] });
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
});

describe("addIssuePhoto", () => {
  it("adds a photo to an existing issue and queues register, upload, confirm (grouped by the issue's room)", async () => {
    const i = await mk();
    const before = (await ob.list()).length;
    const r = await addIssuePhoto({ ...ctx(), compress }, { issueId: i.id, file: jpg() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ issueId: i.id, auditId: "", projectId: P, confirmed: false, bytes: 500, capturedBy: "u1" });
    const added = (await ob.list()).slice(before);
    expect(added.map((q) => q.op.payload.action)).toEqual(["register", "upload", "confirm"]);
    expect(added.every((q) => q.auditId === R && q.op.entity === "photo" && q.op.entityId === r.value.id)).toBe(true);
    expect(added.map((q) => q.lane ?? "data")).toEqual(["data", "files", "files"]);
  });
  it("refuses an unknown or voided issue and unprocessable photos, queueing nothing", async () => {
    expect(await addIssuePhoto(ctx(), { issueId: "00000000-0000-4000-8000-0000000009aa", file: jpg() })).toMatchObject({ ok: false, error: { code: "issue_not_found" } });
    const i = await mk();
    const n0 = (await ob.list()).length;
    expect(await addIssuePhoto({ ...ctx(), compress: async () => { throw new Error("decode failed"); } }, { issueId: i.id, file: jpg() })).toMatchObject({ ok: false, error: { code: "compress_failed" } });
    expect(await addIssuePhoto({ ...ctx(), compress: async (f) => ({ blob: new Blob([new Uint8Array(11 * 1024 * 1024)]), thumb: "t", mime: "image/jpeg", original: f }) }, { issueId: i.id, file: jpg() })).toMatchObject({ ok: false, error: { code: "file_too_large" } });
    await db.put("issues", { ...i, voidedAt: "2026-11-08T11:00:00Z", voidedBy: "u1", voidedByLabel: "Pat" });
    expect(await addIssuePhoto(ctx(), { issueId: i.id, file: jpg() })).toMatchObject({ ok: false, error: { code: "issue_void" } });
    expect((await ob.list()).length).toBe(n0);
  });
});

describe("addAnnotatedIssuePhoto (markup saves a separate copy; the original is never changed)", () => {
  const flattened = { blob: new Blob([new Uint8Array(700)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,BBBB", mime: "image/jpeg" };
  it("creates a marked-up copy linked to the original, with its marks, and queues it like any photo", async () => {
    const i = await mk([jpg()]);
    const orig = (await db.getAllFromIndex("photos", "by_issue", i.id))[0]!;
    const before = (await ob.list()).length;
    const r = await addAnnotatedIssuePhoto(ctx(), { originalId: orig.id, shapes: [pen], flattened });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ issueId: i.id, annotatedFrom: orig.id, bytes: 700, auditId: "" });
    expect(r.value.annotations).toEqual([pen]);
    expect(await db.get("photos", orig.id)).toMatchObject({ bytes: 500, thumb: "data:image/jpeg;base64,AAAA" });   // original untouched
    const added = (await ob.list()).slice(before);
    expect(added[0]!.op.payload).toMatchObject({ action: "register", issueId: i.id, annotatedFrom: orig.id, annotations: [pen] });
    expect(added.map((q) => q.op.payload.action)).toEqual(["register", "upload", "confirm"]);
  });
  it("refuses a copy of a copy, bad marks, a missing original and an empty image", async () => {
    const i = await mk([jpg()]);
    const orig = (await db.getAllFromIndex("photos", "by_issue", i.id))[0]!;
    const copy = await addAnnotatedIssuePhoto(ctx(), { originalId: orig.id, shapes: [pen], flattened });
    if (!copy.ok) throw new Error("setup");
    expect(await addAnnotatedIssuePhoto(ctx(), { originalId: copy.value.id, shapes: [pen], flattened })).toMatchObject({ ok: false, error: { code: "cannot_annotate_a_copy" } });
    expect(await addAnnotatedIssuePhoto(ctx(), { originalId: orig.id, shapes: [], flattened })).toMatchObject({ ok: false, error: { code: "invalid_annotations" } });
    expect(await addAnnotatedIssuePhoto(ctx(), { originalId: "00000000-0000-4000-8000-0000000009bb", shapes: [pen], flattened })).toMatchObject({ ok: false, error: { code: "photo_not_found" } });
    expect(await addAnnotatedIssuePhoto(ctx(), { originalId: orig.id, shapes: [pen], flattened: { ...flattened, blob: new Blob([]) } })).toMatchObject({ ok: false, error: { code: "compress_failed" } });
  });
});

describe("finalizing issue photos once the server has them", () => {
  it("drops the heavy images and keeps the preview after the confirm step is confirmed, and never before", async () => {
    const i = await mk([jpg()]);
    const p = (await db.getAllFromIndex("photos", "by_issue", i.id))[0]!;
    expect(await finalizeConfirmedPhotos(db, ob)).toBe(0);
    expect((await db.get("photos", p.id))!.blob).toBeDefined();
    const conf = (await ob.list()).find((q) => q.op.entity === "photo" && q.op.entityId === p.id && q.op.payload.action === "confirm")!;
    await db.put("outbox", { ...conf, state: { ...conf.state, status: "confirmed" } });
    expect(await finalizeConfirmedPhotos(db, ob)).toBe(1);
    const after = (await db.get("photos", p.id))!;
    expect(after.blob).toBeUndefined(); expect(after.originalBlob).toBeUndefined();
    expect(after).toMatchObject({ confirmed: true, thumb: "data:image/jpeg;base64,AAAA", issueId: i.id });
  });
});

describe("ensureRemoteThumb (photos taken by other people are previewed on demand, online only)", () => {
  const stub = (o = {}) => ({ id: "00000000-0000-4000-8000-0000000008a1", auditId: "", issueId: "i9", version: 0, projectId: P, itemKey: null, thumb: "", mime: "image/jpeg", bytes: 1000, sha256: "a".repeat(64), capturedAt: "2026-11-08T09:00:00Z", capturedBy: "u9", storagePath: `${P}/issues/i9/x.jpg`, confirmed: true, ...o });
  it("downloads once, makes a small preview and caches it", async () => {
    await db.put("photos", stub());
    let downloads = 0;
    const deps = { db, download: async (path: string) => { downloads++; expect(path).toBe(`${P}/issues/i9/x.jpg`); return new Blob([new Uint8Array(10)]); }, makeThumb: async () => "data:image/jpeg;base64,THUMB" };
    expect(await ensureRemoteThumb(deps, "00000000-0000-4000-8000-0000000008a1")).toBe("data:image/jpeg;base64,THUMB");
    expect((await db.get("photos", "00000000-0000-4000-8000-0000000008a1"))!.thumb).toBe("data:image/jpeg;base64,THUMB");
    expect(await ensureRemoteThumb(deps, "00000000-0000-4000-8000-0000000008a1")).toBe("data:image/jpeg;base64,THUMB");
    expect(downloads).toBe(1);
  });
  it("leaves the plain tile when the download fails or the photo is unknown", async () => {
    await db.put("photos", stub());
    expect(await ensureRemoteThumb({ db, download: async () => { throw new Error("offline"); }, makeThumb: async () => "x" }, "00000000-0000-4000-8000-0000000008a1")).toBeNull();
    expect((await db.get("photos", "00000000-0000-4000-8000-0000000008a1"))!.thumb).toBe("");
    expect(await ensureRemoteThumb({ db, download: async () => null, makeThumb: async () => "x" }, "00000000-0000-4000-8000-0000000008a1")).toBeNull();
    expect(await ensureRemoteThumb({ db, download: async () => new Blob([]), makeThumb: async () => "x" }, "nope")).toBeNull();
  });
});

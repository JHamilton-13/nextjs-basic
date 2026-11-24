import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import type { Compressor } from "../src/lib/photos";
import { completeIssue, createIssue, issueStatus, reconcileIssues, reopenIssue, updateIssue, voidIssue, type IssueCtx, type ServerIssueRow } from "../src/lib/issues";

const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201";
const T_PLUMB = "00000000-0000-4000-8000-0000000000a1"; const T_OLD = "00000000-0000-4000-8000-0000000000a2";
const compress: Compressor = async (file) => ({ blob: new Blob([new Uint8Array(500)], { type: "image/jpeg" }), thumb: "data:image/jpeg;base64,AAAA", mime: "image/jpeg", original: file });
const jpg = () => new Blob([new Uint8Array(100)], { type: "image/jpeg" });

let db: Db; let ob: Outbox; let n = 0; let seq = 0; let clock = 0;
const ctx = (o: Partial<IssueCtx> = {}): IssueCtx => ({
  db, userId: "u1", userLabel: "Pat Installer", compress, notify: () => ob.notify(),
  newId: () => `00000000-0000-4000-8000-${String(5000 + ++seq).padStart(12, "0")}`, now: () => `2026-11-08T10:${String(10 + ++clock).padStart(2, "0")}:00.000Z`, ...o,
});
const queue = async () => (await ob.list()).filter((q) => q.op.entity === "room_issue");
const input = (o: Record<string, unknown> = {}) => ({ roomId: R, kind: "punch_item" as const, tradeId: null, title: "Door sticks", files: [] as Blob[], ...o });

beforeEach(async () => {
  db = await openPhcDb(`issues-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [{ id: R, project_id: P, name: "Kitchen", floor: null }], templates: [],
    trades: [{ id: T_PLUMB, name: "Plumbing", sort_order: 10, active: true }, { id: T_OLD, name: "Roofing", sort_order: 100, active: false }] });
  await db.put("meta", { isAdmin: false, byProject: { [P]: "installer" } }, "roles");
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
});

describe("createIssue (works fully offline)", () => {
  it("stores the issue with who and when and queues exactly one create operation, grouped by room", async () => {
    const r = await createIssue(ctx(), input({ title: "  Door sticks  ", description: " Top hinge " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await db.get("issues", r.value.id)).toMatchObject({ id: r.value.id, projectId: P, roomId: R, kind: "punch_item", tradeId: null, title: "Door sticks", description: "Top hinge", raisedBy: "u1", raisedByLabel: "Pat Installer", pending: true, nextBase: 1 });
    const q = await queue();
    expect(q).toHaveLength(1);
    expect(q[0]!.auditId).toBe(R);
    expect(q[0]!.op).toMatchObject({ entity: "room_issue", entityId: r.value.id, baseVersion: 0, actor: "u1", payload: { action: "create", roomId: R, kind: "punch_item", title: "Door sticks", description: "Top hinge" } });
    expect("tradeId" in q[0]!.op.payload).toBe(false);
    expect(issueStatus(r.value)).toBe("open");
  });
  it("leaves out an empty description and ignores a trade on any kind but Pre Install Correction", async () => {
    const r = await createIssue(ctx(), input({ tradeId: T_PLUMB }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tradeId).toBeNull();
    const p = (await queue())[0]!.op.payload;
    expect("description" in p).toBe(false);
    expect("tradeId" in p).toBe(false);
  });
  it("Pre Install Correction needs a trade from the phone's trade list (offline), and an inactive or unknown trade is refused; nothing is queued", async () => {
    expect(await createIssue(ctx(), input({ kind: "pre_install_correction" }))).toMatchObject({ ok: false, error: { code: "blocked" } });
    expect(await createIssue(ctx(), input({ kind: "pre_install_correction", tradeId: T_OLD }))).toMatchObject({ ok: false, error: { code: "trade_inactive" } });
    expect(await createIssue(ctx(), input({ kind: "pre_install_correction", tradeId: "00000000-0000-4000-8000-0000000000ff" }))).toMatchObject({ ok: false, error: { code: "trade_not_found" } });
    expect(await queue()).toHaveLength(0);
    expect(await db.getAll("issues")).toHaveLength(0);
    const ok = await createIssue(ctx(), input({ kind: "pre_install_correction", tradeId: T_PLUMB }));
    expect(ok.ok).toBe(true);
    expect((await queue())[0]!.op.payload).toMatchObject({ kind: "pre_install_correction", tradeId: T_PLUMB });
  });
  it("blocks a blank title and a Damaged part without a photo, saving nothing", async () => {
    expect(await createIssue(ctx(), input({ title: "  " }))).toMatchObject({ ok: false, error: { code: "blocked", message: "Add a title" } });
    expect(await createIssue(ctx(), input({ kind: "damaged_part" }))).toMatchObject({ ok: false, error: { code: "blocked", message: "A damaged part needs a photo" } });
    expect(await db.getAll("issues")).toHaveLength(0);
    expect(await ob.list()).toHaveLength(0);
  });
  it("saves the issue and its photos together: create first, then register / upload / confirm per photo with the right lanes", async () => {
    const r = await createIssue(ctx(), input({ kind: "damaged_part", files: [jpg(), jpg()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = await ob.list();
    expect(all).toHaveLength(1 + 2 * 3);
    expect(all[0]!.op.entity).toBe("room_issue");
    const photos = await db.getAllFromIndex("photos", "by_issue", r.value.id);
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({ issueId: r.value.id, auditId: "", projectId: P, itemKey: null, confirmed: false, capturedBy: "u1" });
    expect(photos[0]!.storagePath).toBe(`${P}/issues/${r.value.id}/${photos[0]!.id}.jpg`);
    for (const p of photos) {
      const mine = all.filter((q) => q.op.entity === "photo" && q.op.entityId === p.id);
      expect(mine.map((q) => q.op.payload.action)).toEqual(["register", "upload", "confirm"]);
      expect(mine.map((q) => q.lane ?? "data")).toEqual(["data", "files", "files"]);
      expect(mine[1]!.after).toEqual([mine[0]!.op.opId]); expect(mine[2]!.after).toEqual([mine[1]!.op.opId]);
      expect(mine[0]!.op.payload).toMatchObject({ projectId: P, issueId: r.value.id, storagePath: p.storagePath, bytes: 500 });
      expect(mine.every((q) => q.auditId === R)).toBe(true);
    }
  });
  it("saves nothing at all when a photo cannot be processed", async () => {
    const r = await createIssue(ctx({ compress: async () => { throw new Error("decode failed"); } }), input({ files: [jpg()] }));
    expect(r).toMatchObject({ ok: false, error: { code: "compress_failed" } });
    expect(await db.getAll("issues")).toHaveLength(0);
    expect(await ob.list()).toHaveLength(0);
    const huge = await createIssue(ctx({ compress: async (f) => ({ blob: new Blob([new Uint8Array(11 * 1024 * 1024)]), thumb: "t", mime: "image/jpeg", original: f }) }), input({ files: [jpg()] }));
    expect(huge).toMatchObject({ ok: false, error: { code: "file_too_large" } });
    expect(await db.getAll("issues")).toHaveLength(0);
  });
  it("refuses a room that is not on this device", async () => {
    expect(await createIssue(ctx(), input({ roomId: "00000000-0000-4000-8000-0000000009ff" }))).toMatchObject({ ok: false, error: { code: "room_not_cached" } });
  });
});

const make = async (o: Record<string, unknown> = {}) => { const r = await createIssue(ctx(), input(o)); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

describe("changing an issue (edit, complete, reopen, void)", () => {
  it("chains base versions across several offline changes", async () => {
    const i = await make();
    expect((await updateIssue(ctx(), i.id, { title: "Door sticks badly" })).ok).toBe(true);
    expect((await completeIssue(ctx(), i.id, " fixed ")).ok).toBe(true);
    expect((await reopenIssue(ctx(), i.id)).ok).toBe(true);
    expect((await voidIssue(ctx(), i.id, "wrong room")).ok).toBe(true);
    const q = await queue();
    expect(q.map((x) => [x.op.baseVersion, x.op.payload.action])).toEqual([[0, "create"], [1, "update"], [2, "complete"], [3, "reopen"], [4, "void"]]);
    expect(q[2]!.op.payload).toMatchObject({ note: "fixed" });
    expect(q[4]!.op.payload).toMatchObject({ note: "wrong room" });
    const cur = (await db.get("issues", i.id))!;
    expect(cur.nextBase).toBe(5);
    expect(issueStatus(cur)).toBe("void");
    expect(cur).toMatchObject({ voidedBy: "u1", voidNote: "wrong room" });
  });
  it("records who completed it and when, and clears it on reopen", async () => {
    const i = await make();
    await completeIssue(ctx(), i.id);
    expect(await db.get("issues", i.id)).toMatchObject({ completedBy: "u1", completedByLabel: "Pat Installer" });
    expect(issueStatus((await db.get("issues", i.id))!)).toBe("completed");
    await reopenIssue(ctx(), i.id);
    const after = (await db.get("issues", i.id))!;
    expect(after.completedAt).toBeUndefined();
    expect(issueStatus(after)).toBe("open");
  });
  it("update sends only what changed; changing to another kind drops the trade; changing to Pre Install Correction needs one", async () => {
    const i = await make({ kind: "pre_install_correction", tradeId: T_PLUMB });
    await updateIssue(ctx(), i.id, { title: "Pipe in wrong place" });
    expect((await queue())[1]!.op.payload).toEqual({ action: "update", title: "Pipe in wrong place" });
    await updateIssue(ctx(), i.id, { kind: "punch_item" });
    expect((await queue())[2]!.op.payload).toEqual({ action: "update", kind: "punch_item" });
    expect((await db.get("issues", i.id))!.tradeId).toBeNull();
    expect(await updateIssue(ctx(), i.id, { kind: "pre_install_correction" })).toMatchObject({ ok: false, error: { code: "blocked", message: "Add a trade" } });
    expect(await updateIssue(ctx(), i.id, { kind: "pre_install_correction", tradeId: T_OLD })).toMatchObject({ ok: false, error: { code: "trade_inactive" } });
    expect((await updateIssue(ctx(), i.id, { kind: "pre_install_correction", tradeId: T_PLUMB })).ok).toBe(true);
    expect((await queue())[3]!.op.payload).toEqual({ action: "update", kind: "pre_install_correction", tradeId: T_PLUMB });
    expect(await queue()).toHaveLength(4);
  });
  it("update refuses an empty change, a blank title, and a completed issue", async () => {
    const i = await make();
    expect(await updateIssue(ctx(), i.id, {})).toMatchObject({ ok: false, error: { code: "nothing_to_change" } });
    expect(await updateIssue(ctx(), i.id, { title: "  " })).toMatchObject({ ok: false, error: { code: "blocked", message: "Add a title" } });
    await completeIssue(ctx(), i.id);
    expect(await updateIssue(ctx(), i.id, { title: "x" })).toMatchObject({ ok: false, error: { code: "issue_completed" } });
  });
  it("a Damaged part cannot be completed without an original photo on this phone; it can with one", async () => {
    const i = await make({ kind: "damaged_part", files: [jpg()] });
    expect((await completeIssue(ctx(), i.id)).ok).toBe(true);
    await reopenIssue(ctx(), i.id);
    // a Damaged part whose only photo is gone (e.g. changed kind then back) is blocked
    const j = await make({ kind: "missing_part" });
    await updateIssue(ctx(), j.id, { kind: "damaged_part" });
    expect(await completeIssue(ctx(), j.id)).toMatchObject({ ok: false, error: { code: "photo_required" } });
    expect((await queue()).filter((q) => q.op.entityId === j.id && q.op.payload.action === "complete")).toHaveLength(0);
  });
  it("refuses wrong-state changes and unknown issues", async () => {
    const i = await make();
    expect(await reopenIssue(ctx(), i.id)).toMatchObject({ ok: false, error: { code: "not_completed" } });
    await completeIssue(ctx(), i.id);
    expect(await completeIssue(ctx(), i.id)).toMatchObject({ ok: false, error: { code: "already_completed" } });
    await voidIssue(ctx(), i.id);
    for (const f of [() => updateIssue(ctx(), i.id, { title: "x" }), () => completeIssue(ctx(), i.id), () => reopenIssue(ctx(), i.id), () => voidIssue(ctx(), i.id)]) expect(await f()).toMatchObject({ ok: false, error: { code: "issue_void" } });
    expect(await completeIssue(ctx(), "00000000-0000-4000-8000-0000000009aa")).toMatchObject({ ok: false, error: { code: "issue_not_found" } });
  });
  it("only the raiser or a manager may change an issue (the server enforces it too)", async () => {
    const i = await make();
    const other = ctx({ userId: "u2", userLabel: "Sam Other" });
    expect(await completeIssue(other, i.id)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await voidIssue(other, i.id)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    await db.put("meta", { isAdmin: false, byProject: { [P]: "installation_manager" } }, "roles");
    expect((await completeIssue(other, i.id)).ok).toBe(true);
    await db.put("meta", { isAdmin: true, byProject: {} }, "roles");
    expect((await reopenIssue(other, i.id)).ok).toBe(true);
  });
  it("with no role stored yet, the raiser may still act and others may not", async () => {
    await db.delete("meta", "roles");
    const i = await make();
    expect((await completeIssue(ctx(), i.id)).ok).toBe(true);
    expect(await reopenIssue(ctx({ userId: "u2" }), i.id)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
  });
});

describe("reconcileIssues (what the server says wins, except for changes still waiting to be sent)", () => {
  const row = (o: Partial<ServerIssueRow> = {}): ServerIssueRow => ({
    id: "00000000-0000-4000-8000-0000000007a1", project_id: P, room_id: R, kind: "touch_up", trade_id: null, title: "Scuff", description: null, row_version: 2,
    raised_by: "u9", raised_by_label: "Sam Other", raised_at: "2026-11-08T09:00:00Z", completed_by: null, completed_by_label: null, completed_at: null, completed_note: null,
    voided_by: null, voided_by_label: null, voided_at: null, void_note: null, ...o });
  it("adds issues raised by other people, with who and when", async () => {
    await reconcileIssues(db, [row()], new Set());
    expect(await db.get("issues", row().id)).toMatchObject({ title: "Scuff", raisedBy: "u9", raisedByLabel: "Sam Other", pending: false, nextBase: 2, kind: "touch_up" });
  });
  it("shows completed and voided state from the server", async () => {
    await reconcileIssues(db, [row({ completed_by: "u9", completed_by_label: "Sam Other", completed_at: "2026-11-08T11:00:00Z", completed_note: "done" }), row({ id: "00000000-0000-4000-8000-0000000007a2", voided_by: "u9", voided_by_label: "Sam Other", voided_at: "2026-11-08T11:00:00Z" })], new Set());
    expect(issueStatus((await db.get("issues", row().id))!)).toBe("completed");
    expect(issueStatus((await db.get("issues", "00000000-0000-4000-8000-0000000007a2"))!)).toBe("void");
  });
  it("keeps a local issue that still has queued changes, and drops one the server no longer has", async () => {
    const mine = await make();
    await reconcileIssues(db, [row({ id: mine.id, title: "Server title", row_version: 1 })], new Set([mine.id]));
    expect((await db.get("issues", mine.id))!.title).toBe("Door sticks");
    await reconcileIssues(db, [], new Set());
    expect(await db.get("issues", mine.id)).toBeUndefined();
  });
});

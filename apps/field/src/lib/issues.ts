import { canChangeIssue, canCompleteIssue, err, issueSaveBlockers, ok, requiresTrade, type IssueKind, type OperationEnvelope, type Result } from "@phc/domain";
import type { Db } from "./db";
import { newOutboxRecord } from "./outbox";
import { hex, MAX_UPLOAD_BYTES, type Compressor } from "./photos";
import type { LocalIssue, LocalPhoto } from "./types";

export type IssueStatus = "open" | "completed" | "void";
export const issueStatus = (i: LocalIssue): IssueStatus => (i.voidedAt ? "void" : i.completedAt ? "completed" : "open");

export interface IssueCtx { db: Db; userId: string; userLabel: string; compress: Compressor; newId: () => string; now: () => string; notify: () => void }
export type IssueError = {
  code: "blocked" | "room_not_cached" | "trade_not_found" | "trade_inactive" | "compress_failed" | "file_too_large" | "issue_not_found" | "not_allowed"
    | "nothing_to_change" | "issue_completed" | "already_completed" | "not_completed" | "issue_void" | "photo_required";
  message: string;
};

/** What my role on a project lets me do. With no role stored yet (never synced since the update) the raiser may still act; the server decides. */
async function mayChange(db: Db, issue: LocalIssue, userId: string): Promise<boolean> {
  const m = (await db.get("meta", "roles")) as { isAdmin: boolean; byProject: Record<string, string> } | undefined;
  const role = m ? (m.byProject[issue.projectId] ?? null) : "installer";
  return canChangeIssue({ role, isRaiser: issue.raisedBy === userId, isAdmin: m?.isAdmin ?? false });
}

/** An active trade is required for a NEW choice; a trade that was deactivated after it was chosen may stay on an existing issue. */
async function checkTrade(db: Db, tradeId: string): Promise<IssueError | null> {
  const t = await db.get("trades", tradeId);
  if (!t) return { code: "trade_not_found", message: "That trade is not on this phone yet. Connect once to refresh the trade list." };
  if (!t.active) return { code: "trade_inactive", message: "That trade is no longer used. Choose another." };
  return null;
}

const originalPhotos = async (db: Db, issueId: string) => (await db.getAllFromIndex("photos", "by_issue", issueId)).filter((p) => !p.annotatedFrom);

/**
 * Raises an issue entirely locally (works with no connectivity). The issue, its photos and every queued operation are written in
 * ONE transaction, so a crash can never leave a photo without its issue. Photos are processed first: if one fails, nothing is saved.
 * The issue's create operation is queued before its photos are registered (the server needs the issue to exist first).
 */
export async function createIssue(
  ctx: IssueCtx,
  input: { roomId: string; kind: IssueKind; tradeId: string | null; title: string; description?: string; files: Blob[] },
): Promise<Result<LocalIssue, IssueError>> {
  const { db } = ctx;
  const room = await db.get("rooms", input.roomId);
  if (!room) return err({ code: "room_not_cached", message: "That room is not on this phone yet. Connect once to download it." });
  const title = input.title.trim(); const description = (input.description ?? "").trim();
  const tradeId = requiresTrade(input.kind) ? input.tradeId : null;
  const blockers = issueSaveBlockers({ kind: input.kind, tradeId, title, photoCount: input.files.length });
  if (blockers.length > 0) return err({ code: "blocked", message: blockers.join(". ") });
  if (tradeId) { const e = await checkTrade(db, tradeId); if (e) return err(e); }

  const processed: { blob: Blob; thumb: string; mime: string; original: Blob; sha256: string }[] = [];
  for (const f of input.files) {
    let c;
    try { c = await ctx.compress(f); } catch (e) { return err({ code: "compress_failed", message: `Could not process the photo: ${e instanceof Error ? e.message : String(e)}` }); }
    if (c.blob.size === 0) return err({ code: "compress_failed", message: "The photo came out empty. Please retake it." });
    if (c.blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The photo is too large to upload (over 10 MB)." });
    processed.push({ ...c, sha256: hex(await crypto.subtle.digest("SHA-256", await c.blob.arrayBuffer())) });
  }

  const id = ctx.newId(); const at = ctx.now();
  const issue: LocalIssue = { id, projectId: room.project_id, roomId: room.id, kind: input.kind, tradeId, title, description, raisedBy: ctx.userId, raisedByLabel: ctx.userLabel, raisedAt: at, pending: true, nextBase: 1 };
  const create: OperationEnvelope = {
    opId: ctx.newId(), entity: "room_issue", entityId: id, baseVersion: 0, createdAt: at, actor: ctx.userId,
    payload: { action: "create", roomId: room.id, kind: input.kind, title, ...(description ? { description } : {}), ...(tradeId ? { tradeId } : {}) },
  };
  const tx = db.transaction(["issues", "photos", "outbox"], "readwrite");
  const writes: Promise<unknown>[] = [tx.objectStore("issues").add(issue), tx.objectStore("outbox").add(newOutboxRecord(create, room.id))];
  for (const c of processed) {
    const pid = ctx.newId(); const capturedAt = ctx.now();
    const photo: LocalPhoto = {
      id: pid, auditId: "", issueId: id, version: 0, projectId: room.project_id, itemKey: null, blob: c.blob, originalBlob: c.original, thumb: c.thumb, mime: c.mime,
      bytes: c.blob.size, sha256: c.sha256, capturedAt, capturedBy: ctx.userId, storagePath: `${room.project_id}/issues/${id}/${pid}.jpg`, confirmed: false,
    };
    writes.push(...queueIssuePhoto(ctx, tx, photo, room.id));
  }
  await Promise.all(writes);
  await tx.done;
  ctx.notify();
  return ok(issue);
}

/** Minimal shape of the transaction these helpers write to (keeps them usable from a transaction that also touches other stores). */
interface PhotoTx { objectStore(name: "photos" | "outbox"): { add(v: any): Promise<unknown> } }

/**
 * Stores one issue photo and queues its register (data lane), upload and confirm (files lane, each waiting for the step before).
 * The queue group is the room, so the issue's own operations and its photos stay in order. Returns the writes to await.
 */
export function queueIssuePhoto(ctx: { newId: () => string; userId: string }, tx: PhotoTx, photo: LocalPhoto, roomId: string): Promise<unknown>[] {
  const base = { entity: "photo", entityId: photo.id, baseVersion: 0, createdAt: photo.capturedAt, actor: ctx.userId };
  const common = { projectId: photo.projectId, issueId: photo.issueId, storagePath: photo.storagePath, sha256: photo.sha256, bytes: photo.bytes, capturedAt: photo.capturedAt };
  const reg: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "register", ...common, ...(photo.annotatedFrom ? { annotatedFrom: photo.annotatedFrom, annotations: photo.annotations } : {}) } };
  const up: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "upload", ...common, mime: photo.mime } };
  const conf: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "confirm", ...common } };
  return [
    tx.objectStore("photos").add(photo),
    tx.objectStore("outbox").add(newOutboxRecord(reg, roomId)),
    tx.objectStore("outbox").add(newOutboxRecord(up, roomId, { lane: "files", after: [reg.opId] })),
    tx.objectStore("outbox").add(newOutboxRecord(conf, roomId, { lane: "files", after: [up.opId] })),
  ];
}

// ------------------------------------------------------------------------------------------------------------------
// changing an issue
// ------------------------------------------------------------------------------------------------------------------

/** Loads the issue and applies the checks every change shares: it exists, I may change it, it is not void. */
async function loadForChange(ctx: IssueCtx, id: string): Promise<Result<LocalIssue, IssueError>> {
  const issue = await ctx.db.get("issues", id);
  if (!issue) return err({ code: "issue_not_found", message: "That issue is not on this phone." });
  if (!(await mayChange(ctx.db, issue, ctx.userId))) return err({ code: "not_allowed", message: "Only the person who raised this issue, or a manager, can change it." });
  if (issue.voidedAt) return err({ code: "issue_void", message: "This issue was voided." });
  return ok(issue);
}

/** Writes the changed issue and queues one operation for it, in one transaction. */
async function commit(ctx: IssueCtx, before: LocalIssue, after: LocalIssue, payload: Record<string, unknown>): Promise<LocalIssue> {
  const at = ctx.now();
  const op: OperationEnvelope = { opId: ctx.newId(), entity: "room_issue", entityId: before.id, baseVersion: before.nextBase, payload, createdAt: at, actor: ctx.userId };
  const next: LocalIssue = { ...after, pending: true, nextBase: before.nextBase + 1 };
  const tx = ctx.db.transaction(["issues", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("issues").put(next), tx.objectStore("outbox").add(newOutboxRecord(op, before.roomId))]);
  await tx.done;
  ctx.notify();
  return next;
}

const without = <T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

/** Edits an open issue (kind, trade, title, description). Only what changed is sent. Changing to another kind drops the trade. */
export async function updateIssue(
  ctx: IssueCtx, id: string, patch: { kind?: IssueKind; tradeId?: string | null; title?: string; description?: string },
): Promise<Result<LocalIssue, IssueError>> {
  const loaded = await loadForChange(ctx, id);
  if (!loaded.ok) return loaded;
  const issue = loaded.value;
  if (issue.completedAt) return err({ code: "issue_completed", message: "Reopen this issue before editing it." });
  if (patch.kind === undefined && patch.tradeId === undefined && patch.title === undefined && patch.description === undefined) return err({ code: "nothing_to_change", message: "Nothing to change." });

  const kind = patch.kind ?? issue.kind;
  const tradeId = requiresTrade(kind) ? (patch.tradeId !== undefined ? patch.tradeId : issue.tradeId) : null;
  const title = patch.title !== undefined ? patch.title.trim() : issue.title;
  const blockers = issueSaveBlockers({ kind, tradeId, title, photoCount: 1 }); // the photo rule applies when completing, not when editing
  if (blockers.length > 0) return err({ code: "blocked", message: blockers.join(". ") });
  if (tradeId && tradeId !== issue.tradeId) { const e = await checkTrade(ctx.db, tradeId); if (e) return err(e); }

  const description = patch.description !== undefined ? patch.description.trim() : issue.description;
  const payload: Record<string, unknown> = {
    action: "update",
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.title !== undefined ? { title } : {}),
    ...(patch.description !== undefined ? { description } : {}),
    ...(patch.tradeId !== undefined && requiresTrade(kind) ? { tradeId } : {}),
  };
  return ok(await commit(ctx, issue, { ...issue, kind, tradeId, title, description }, payload));
}

export async function completeIssue(ctx: IssueCtx, id: string, note?: string): Promise<Result<LocalIssue, IssueError>> {
  const loaded = await loadForChange(ctx, id);
  if (!loaded.ok) return loaded;
  const issue = loaded.value;
  if (issue.completedAt) return err({ code: "already_completed", message: "This issue is already completed." });
  const can = canCompleteIssue(issue.kind, (await originalPhotos(ctx.db, id)).length);
  if (!can.ok) return err({ code: "photo_required", message: "A damaged part needs a photo before it can be completed." });
  const text = note?.trim();
  return ok(await commit(ctx, issue, { ...issue, completedBy: ctx.userId, completedByLabel: ctx.userLabel, completedAt: ctx.now(), ...(text ? { completedNote: text } : {}) },
    { action: "complete", ...(text ? { note: text } : {}) }));
}

export async function reopenIssue(ctx: IssueCtx, id: string): Promise<Result<LocalIssue, IssueError>> {
  const loaded = await loadForChange(ctx, id);
  if (!loaded.ok) return loaded;
  const issue = loaded.value;
  if (!issue.completedAt) return err({ code: "not_completed", message: "This issue is not completed." });
  return ok(await commit(ctx, issue, without(issue, "completedBy", "completedByLabel", "completedAt", "completedNote"), { action: "reopen" }));
}

/** Voids an issue (an open or a completed one): kept in history, never shown in the app, never changeable again. */
export async function voidIssue(ctx: IssueCtx, id: string, note?: string): Promise<Result<LocalIssue, IssueError>> {
  const loaded = await loadForChange(ctx, id);
  if (!loaded.ok) return loaded;
  const text = note?.trim();
  return ok(await commit(ctx, loaded.value, { ...loaded.value, voidedBy: ctx.userId, voidedByLabel: ctx.userLabel, voidedAt: ctx.now(), ...(text ? { voidNote: text } : {}) },
    { action: "void", ...(text ? { note: text } : {}) }));
}

// ------------------------------------------------------------------------------------------------------------------
// what the server says
// ------------------------------------------------------------------------------------------------------------------

export interface ServerIssueRow {
  id: string; project_id: string; room_id: string; kind: IssueKind; trade_id: string | null; title: string; description: string | null; row_version: number;
  raised_by: string; raised_by_label: string | null; raised_at: string;
  completed_by: string | null; completed_by_label: string | null; completed_at: string | null; completed_note: string | null;
  voided_by: string | null; voided_by_label: string | null; voided_at: string | null; void_note: string | null;
}

const fromRow = (r: ServerIssueRow): LocalIssue => ({
  id: r.id, projectId: r.project_id, roomId: r.room_id, kind: r.kind, tradeId: r.trade_id, title: r.title, description: r.description ?? "",
  raisedBy: r.raised_by, raisedByLabel: r.raised_by_label ?? "Someone", raisedAt: r.raised_at,
  ...(r.completed_at ? { completedBy: r.completed_by ?? "", completedByLabel: r.completed_by_label ?? "Someone", completedAt: r.completed_at, ...(r.completed_note ? { completedNote: r.completed_note } : {}) } : {}),
  ...(r.voided_at ? { voidedBy: r.voided_by ?? "", voidedByLabel: r.voided_by_label ?? "Someone", voidedAt: r.voided_at, ...(r.void_note ? { voidNote: r.void_note } : {}) } : {}),
  pending: false, nextBase: r.row_version,
});

/**
 * Replaces the local issues with the server's. An issue that still has operations waiting to be sent (`pendingIds`) is left alone, so
 * nothing the person did on site is overwritten before it reaches the server. An issue the server no longer shows is dropped.
 */
export async function reconcileIssues(db: Db, rows: ServerIssueRow[], pendingIds: Set<string>): Promise<void> {
  const tx = db.transaction("issues", "readwrite");
  const seen = new Set<string>();
  for (const r of rows) { seen.add(r.id); if (!pendingIds.has(r.id)) await tx.store.put(fromRow(r)); }
  for (const local of await tx.store.getAll()) if (!seen.has(local.id) && !pendingIds.has(local.id)) await tx.store.delete(local.id);
  await tx.done;
}

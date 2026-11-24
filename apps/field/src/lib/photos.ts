import { err, ok, type OperationEnvelope, type Result } from "@phc/domain";
import { latestAudit, type Ctx } from "./audits";
import { validateShapes, type Shape } from "./annotations";
import type { Db } from "./db";
import { newOutboxRecord, type Outbox } from "./outbox";
import type { LocalPhoto } from "./types";

/** Turns a camera file into the JPEG that gets uploaded, a small preview, and keeps the original. Browser: see imaging.ts. */
export type Compressor = (file: Blob) => Promise<{ blob: Blob; thumb: string; mime: string; original: Blob }>;
export interface PhotoCtx extends Ctx { compress: Compressor }

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type PhotoError = { code: "audit_not_found" | "unknown_item" | "compress_failed" | "file_too_large"; message: string };

export const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Saves a photo on the device and queues its three server steps: register the row (data lane), upload the file and
 * confirm it (files lane, each waiting for the step before). The register op is queued BEFORE any result that needs the
 * photo, because the server counts registered photos as evidence. Evidence is never deleted from the device until confirmed.
 */
export async function addPhoto(ctx: PhotoCtx, input: { auditId: string; itemKey: string | null; file: Blob }): Promise<Result<LocalPhoto, PhotoError>> {
  const { db } = ctx;
  const audit = await latestAudit(db, input.auditId);
  if (!audit) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  if (input.itemKey !== null && !(await db.get("items", `${audit.key}:${input.itemKey}`))) return err({ code: "unknown_item", message: "That item is not part of this audit." });

  let c;
  try { c = await ctx.compress(input.file); } catch (e) { return err({ code: "compress_failed", message: `Could not process the photo: ${e instanceof Error ? e.message : String(e)}` }); }
  if (c.blob.size === 0) return err({ code: "compress_failed", message: "The photo came out empty. Please retake it." });
  if (c.blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The photo is too large to upload (over 10 MB)." });

  const sha256 = hex(await crypto.subtle.digest("SHA-256", await c.blob.arrayBuffer()));
  const id = ctx.newId();
  const photo: LocalPhoto = {
    id, auditId: audit.auditId, version: audit.version, projectId: audit.projectId, itemKey: input.itemKey, blob: c.blob, originalBlob: c.original,
    thumb: c.thumb, mime: c.mime, bytes: c.blob.size, sha256, capturedAt: ctx.now(), capturedBy: ctx.userId,
    storagePath: `${audit.projectId}/${audit.auditId}/${id}.jpg`, confirmed: false,
  };
  const base = { entity: "photo", entityId: id, baseVersion: 0, createdAt: ctx.now(), actor: ctx.userId };
  const common = { projectId: photo.projectId, auditId: photo.auditId, version: photo.version, itemKey: photo.itemKey, storagePath: photo.storagePath, sha256, bytes: photo.bytes, capturedAt: photo.capturedAt };
  const reg: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "register", ...common } };
  const up: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "upload", ...common, mime: photo.mime } };
  const conf: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "confirm", ...common } };

  const tx = db.transaction(["photos", "outbox"], "readwrite");
  await Promise.all([
    tx.objectStore("photos").add(photo),
    tx.objectStore("outbox").add(newOutboxRecord(reg, photo.auditId)),
    tx.objectStore("outbox").add(newOutboxRecord(up, photo.auditId, { lane: "files", after: [reg.opId] })),
    tx.objectStore("outbox").add(newOutboxRecord(conf, photo.auditId, { lane: "files", after: [up.opId] })),
  ]);
  await tx.done;
  ctx.outbox.notify();
  return ok(photo);
}

/** Original photos for an item across ALL versions of the audit (earlier photos stay evidence; annotated copies are not extra evidence). */
export async function photoCount(db: Db, auditId: string, itemKey: string | null): Promise<number> {
  return (await db.getAllFromIndex("photos", "by_audit", auditId)).filter((p) => p.itemKey === itemKey && !p.annotatedFrom).length;
}

/** The image to draw on: the local compressed copy, else the untouched original, else null (it was cleaned up after upload). */
export const photoSourceBlob = (p: LocalPhoto): Blob | null => p.blob ?? p.originalBlob ?? null;

export type AnnotateError = { code: "photo_not_found" | "cannot_annotate_a_copy" | "invalid_annotations" | "audit_not_found" | "compress_failed" | "file_too_large"; message: string };

/**
 * Saves an annotated COPY of a photo: the flattened image (for reports) plus the editable vector marks. The original is
 * never modified and stays the evidence; the copy is a separate photo record linked to it, queued like any other photo.
 */
export async function addAnnotatedPhoto(
  ctx: Ctx,
  input: { originalId: string; shapes: Shape[]; flattened: { blob: Blob; thumb: string; mime: string } },
): Promise<Result<LocalPhoto, AnnotateError>> {
  const { db } = ctx;
  const original = await db.get("photos", input.originalId);
  if (!original) return err({ code: "photo_not_found", message: "That photo is not on this device." });
  if (original.annotatedFrom) return err({ code: "cannot_annotate_a_copy", message: "Annotate the original photo; each save creates a new annotated copy." });
  const v = validateShapes(input.shapes);
  if (!v.ok) return err({ code: "invalid_annotations", message: v.error.message });
  const audit = await latestAudit(db, original.auditId);
  if (!audit) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  const blob = input.flattened.blob;
  if (blob.size === 0) return err({ code: "compress_failed", message: "The annotated image came out empty." });
  if (blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The annotated photo is too large to upload (over 10 MB)." });

  const sha256 = hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const id = ctx.newId();
  const photo: LocalPhoto = {
    id, auditId: audit.auditId, version: audit.version, projectId: audit.projectId, itemKey: original.itemKey, blob, thumb: input.flattened.thumb,
    mime: input.flattened.mime, bytes: blob.size, sha256, capturedAt: ctx.now(), capturedBy: ctx.userId,
    storagePath: `${audit.projectId}/${audit.auditId}/${id}.jpg`, confirmed: false, annotatedFrom: original.id, annotations: v.value,
  };
  const base = { entity: "photo", entityId: id, baseVersion: 0, createdAt: ctx.now(), actor: ctx.userId };
  const common = { projectId: photo.projectId, auditId: photo.auditId, version: photo.version, itemKey: photo.itemKey, storagePath: photo.storagePath, sha256, bytes: photo.bytes, capturedAt: photo.capturedAt };
  const reg: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "register", ...common, annotatedFrom: original.id, annotations: v.value } };
  const up: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "upload", ...common, mime: photo.mime } };
  const conf: OperationEnvelope = { ...base, opId: ctx.newId(), payload: { action: "confirm", ...common } };
  const tx = db.transaction(["photos", "outbox"], "readwrite");
  await Promise.all([
    tx.objectStore("photos").add(photo),
    tx.objectStore("outbox").add(newOutboxRecord(reg, photo.auditId)),
    tx.objectStore("outbox").add(newOutboxRecord(up, photo.auditId, { lane: "files", after: [reg.opId] })),
    tx.objectStore("outbox").add(newOutboxRecord(conf, photo.auditId, { lane: "files", after: [up.opId] })),
  ]);
  await tx.done;
  ctx.outbox.notify();
  return ok(photo);
}

// ------------------------------------------------------------------------------------------------------------------
// photos on issues (same compression, size limit and register -> upload -> confirm steps as audit photos)
// ------------------------------------------------------------------------------------------------------------------

export interface IssueCtx { db: Db; userId: string; userLabel: string; compress: Compressor; newId: () => string; now: () => string; notify: () => void }

/** Minimal shape of the transaction these helpers write to (so they work inside a transaction that also touches other stores). */
interface PhotoTx { objectStore(name: "photos" | "outbox"): { add(v: any): Promise<unknown> } }

/**
 * Stores one issue photo and queues its register (data lane), upload and confirm (files lane, each waiting for the step before).
 * The queue group is the issue's room, so the issue's own operations and its photos stay in order. Returns the writes to await.
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

export type IssuePhotoError = { code: "issue_not_found" | "issue_void" | "compress_failed" | "file_too_large" | "photo_not_found" | "cannot_annotate_a_copy" | "invalid_annotations"; message: string };

/** Adds a photo to an existing issue (works offline). */
export async function addIssuePhoto(ctx: IssueCtx, input: { issueId: string; file: Blob }): Promise<Result<LocalPhoto, IssuePhotoError>> {
  const { db } = ctx;
  const issue = await db.get("issues", input.issueId);
  if (!issue) return err({ code: "issue_not_found", message: "That issue is not on this phone." });
  if (issue.voidedAt) return err({ code: "issue_void", message: "This issue was voided." });
  let c;
  try { c = await ctx.compress(input.file); } catch (e) { return err({ code: "compress_failed", message: `Could not process the photo: ${e instanceof Error ? e.message : String(e)}` }); }
  if (c.blob.size === 0) return err({ code: "compress_failed", message: "The photo came out empty. Please retake it." });
  if (c.blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The photo is too large to upload (over 10 MB)." });
  const id = ctx.newId();
  const photo: LocalPhoto = {
    id, auditId: "", issueId: issue.id, version: 0, projectId: issue.projectId, itemKey: null, blob: c.blob, originalBlob: c.original, thumb: c.thumb, mime: c.mime,
    bytes: c.blob.size, sha256: hex(await crypto.subtle.digest("SHA-256", await c.blob.arrayBuffer())), capturedAt: ctx.now(), capturedBy: ctx.userId,
    storagePath: `${issue.projectId}/issues/${issue.id}/${id}.jpg`, confirmed: false,
  };
  const tx = db.transaction(["photos", "outbox"], "readwrite");
  await Promise.all(queueIssuePhoto(ctx, tx, photo, issue.roomId));
  await tx.done;
  ctx.notify();
  return ok(photo);
}

/** Saves a marked-up COPY of an issue photo (flattened image + editable marks). The original is never modified. */
export async function addAnnotatedIssuePhoto(
  ctx: IssueCtx, input: { originalId: string; shapes: Shape[]; flattened: { blob: Blob; thumb: string; mime: string } },
): Promise<Result<LocalPhoto, IssuePhotoError>> {
  const { db } = ctx;
  const original = await db.get("photos", input.originalId);
  if (!original || !original.issueId) return err({ code: "photo_not_found", message: "That photo is not on this phone." });
  if (original.annotatedFrom) return err({ code: "cannot_annotate_a_copy", message: "Annotate the original photo; each save creates a new annotated copy." });
  const v = validateShapes(input.shapes);
  if (!v.ok) return err({ code: "invalid_annotations", message: v.error.message });
  const issue = await db.get("issues", original.issueId);
  if (!issue) return err({ code: "issue_not_found", message: "That issue is not on this phone." });
  if (issue.voidedAt) return err({ code: "issue_void", message: "This issue was voided." });
  const blob = input.flattened.blob;
  if (blob.size === 0) return err({ code: "compress_failed", message: "The annotated image came out empty." });
  if (blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The annotated photo is too large to upload (over 10 MB)." });
  const id = ctx.newId();
  const photo: LocalPhoto = {
    id, auditId: "", issueId: issue.id, version: 0, projectId: issue.projectId, itemKey: null, blob, thumb: input.flattened.thumb, mime: input.flattened.mime,
    bytes: blob.size, sha256: hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), capturedAt: ctx.now(), capturedBy: ctx.userId,
    storagePath: `${issue.projectId}/issues/${issue.id}/${id}.jpg`, confirmed: false, annotatedFrom: original.id, annotations: v.value,
  };
  const tx = db.transaction(["photos", "outbox"], "readwrite");
  await Promise.all(queueIssuePhoto(ctx, tx, photo, issue.roomId));
  await tx.done;
  ctx.notify();
  return ok(photo);
}

/**
 * Photos taken by other people are not on this phone. When one is on screen and the phone is online, download it once, keep only a
 * small preview, and cache that. Returns the preview, or null (a plain tile is shown) when it cannot be fetched.
 */
export async function ensureRemoteThumb(
  deps: { db: Db; download: (storagePath: string) => Promise<Blob | null>; makeThumb: (b: Blob) => Promise<string> }, photoId: string,
): Promise<string | null> {
  const p = await deps.db.get("photos", photoId);
  if (!p) return null;
  if (p.thumb) return p.thumb;
  try {
    const blob = await deps.download(p.storagePath);
    if (!blob || blob.size === 0) return null;
    const thumb = await deps.makeThumb(blob);
    await deps.db.put("photos", { ...p, thumb });
    return thumb;
  } catch { return null; }
}

/**
 * Once the server confirmed a photo AND its audit version is submitted (so it will not be edited or annotated here again),
 * drop the heavy blobs and keep the preview. Returns how many photos were finalized.
 */
export async function finalizeConfirmedPhotos(db: Db, outbox: Outbox): Promise<number> {
  const confirmed = new Set((await outbox.list()).filter((r) => r.op.entity === "photo" && r.op.payload.action === "confirm" && r.state.status === "confirmed").map((r) => r.op.entityId));
  let n = 0;
  for (const id of confirmed) {
    const p = await db.get("photos", id);
    if (p && !p.confirmed) {
      // an audit photo waits for its version to be submitted; an issue photo has no submit step, so it is finalized once the server has it
      if (!p.issueId && !(await db.get("audits", `${p.auditId}:${p.version}`))?.submittedAt) continue; // still being worked on: keep the images
      const { blob: _b, originalBlob: _o, ...rest } = p;
      await db.put("photos", { ...rest, confirmed: true });
      n++;
    }
  }
  return n;
}

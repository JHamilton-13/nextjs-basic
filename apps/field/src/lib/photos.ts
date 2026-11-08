import { err, ok, type OperationEnvelope, type Result } from "@phc/domain";
import type { Ctx } from "./audits";
import type { Db } from "./db";
import { newOutboxRecord, type Outbox } from "./outbox";
import type { LocalPhoto } from "./types";

/** Turns a camera file into the JPEG that gets uploaded, a small preview, and keeps the original. Browser: see imaging.ts. */
export type Compressor = (file: Blob) => Promise<{ blob: Blob; thumb: string; mime: string; original: Blob }>;
export interface PhotoCtx extends Ctx { compress: Compressor }

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type PhotoError = { code: "audit_not_found" | "unknown_item" | "compress_failed" | "file_too_large"; message: string };

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Saves a photo on the device and queues its three server steps: register the row (data lane), upload the file and
 * confirm it (files lane, each waiting for the step before). The register op is queued BEFORE any result that needs the
 * photo, because the server counts registered photos as evidence. Evidence is never deleted from the device until confirmed.
 */
export async function addPhoto(ctx: PhotoCtx, input: { auditId: string; itemKey: string | null; file: Blob }): Promise<Result<LocalPhoto, PhotoError>> {
  const { db } = ctx;
  const audit = await db.get("audits", input.auditId);
  if (!audit) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  if (input.itemKey !== null && !(await db.get("items", `${input.auditId}:1:${input.itemKey}`))) return err({ code: "unknown_item", message: "That item is not part of this audit." });

  let c;
  try { c = await ctx.compress(input.file); } catch (e) { return err({ code: "compress_failed", message: `Could not process the photo: ${e instanceof Error ? e.message : String(e)}` }); }
  if (c.blob.size === 0) return err({ code: "compress_failed", message: "The photo came out empty. Please retake it." });
  if (c.blob.size > MAX_UPLOAD_BYTES) return err({ code: "file_too_large", message: "The photo is too large to upload (over 10 MB)." });

  const sha256 = hex(await crypto.subtle.digest("SHA-256", await c.blob.arrayBuffer()));
  const id = ctx.newId();
  const photo: LocalPhoto = {
    id, auditId: audit.auditId, projectId: audit.projectId, itemKey: input.itemKey, blob: c.blob, originalBlob: c.original,
    thumb: c.thumb, mime: c.mime, bytes: c.blob.size, sha256, capturedAt: ctx.now(), capturedBy: ctx.userId,
    storagePath: `${audit.projectId}/${audit.auditId}/${id}.jpg`, confirmed: false,
  };
  const base = { entity: "photo", entityId: id, baseVersion: 0, createdAt: ctx.now(), actor: ctx.userId };
  const common = { projectId: photo.projectId, auditId: photo.auditId, itemKey: photo.itemKey, storagePath: photo.storagePath, sha256, bytes: photo.bytes, capturedAt: photo.capturedAt };
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

export async function photoCount(db: Db, auditId: string, itemKey: string | null): Promise<number> {
  return (await db.getAllFromIndex("photos", "by_audit", auditId)).filter((p) => p.itemKey === itemKey).length;
}

/** Once the server confirmed a photo, drop the heavy blobs (keep the preview). Returns how many photos were finalized. */
export async function finalizeConfirmedPhotos(db: Db, outbox: Outbox): Promise<number> {
  const confirmed = new Set((await outbox.list()).filter((r) => r.op.entity === "photo" && r.op.payload.action === "confirm" && r.state.status === "confirmed").map((r) => r.op.entityId));
  let n = 0;
  for (const id of confirmed) {
    const p = await db.get("photos", id);
    if (p && !p.confirmed) {
      const { blob: _b, originalBlob: _o, ...rest } = p;
      await db.put("photos", { ...rest, confirmed: true });
      n++;
    }
  }
  return n;
}

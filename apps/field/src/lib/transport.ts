import type { OperationEnvelope, OperationResult } from "@phc/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./db";
import { TransportError, type Transport } from "./outbox";

const APPLIED: OperationResult = { status: "applied", newVersion: 1 };

interface Failure { code?: string | undefined; message?: string | undefined; status?: number | undefined }

/** Every failure becomes retryable (network down, token expired, 5xx) or permanent (permission, validation). */
function classify(f: Failure): TransportError {
  const msg = f.message || "Request failed";
  const code = f.code ?? "";
  const status = f.status ?? 0;
  if (status === 0 && !code) return new TransportError("network", msg, true);
  if (/failed to fetch|network|load failed|timed out|timeout|abort/i.test(msg) && !code) return new TransportError("network", msg, true);
  if (status === 401 || code === "28000" || /jwt|not authenticated/i.test(msg)) return new TransportError("auth", msg, true);
  if (status >= 500) return new TransportError("server", msg, true);
  return new TransportError("server", msg, false); // e.g. 42501 permission denied, size_mismatch: retrying cannot help
}

const storageFailure = (e: unknown): Failure => {
  const x = e as { message?: string; status?: number; statusCode?: string | number };
  const status = typeof x.status === "number" ? x.status : x.statusCode !== undefined ? Number(x.statusCode) : 0;
  return { message: x.message, status: Number.isFinite(status) ? status : 0 };
};

/** Sends results/audits through the apply_op RPC, and photo steps through the table, storage and confirm_photo RPC. */
export function supabaseTransport(sb: SupabaseClient, db: Db): Transport {
  async function applyOp(op: OperationEnvelope): Promise<OperationResult> {
    let res;
    try { res = await sb.rpc("apply_op", { op }); } catch (e) { throw new TransportError("network", e instanceof Error ? e.message : String(e), true); }
    if (res.error) throw classify({ code: res.error.code, message: res.error.message, status: res.status });
    return res.data as OperationResult;
  }

  async function photo(op: OperationEnvelope): Promise<OperationResult> {
    const p = op.payload as { action: string; projectId: string; auditId: string; version?: number; annotatedFrom?: string; annotations?: unknown; itemKey: string | null; storagePath: string; sha256: string; bytes: number; capturedAt: string; mime?: string };
    try {
      if (p.action === "register") {
        const { error, status } = await sb.from("photos").insert({
          id: op.entityId, project_id: p.projectId, audit_id: p.auditId, version: p.version ?? 1, item_key: p.itemKey, storage_path: p.storagePath,
          checksum_sha256: p.sha256, bytes: p.bytes, captured_by: op.actor, captured_at: p.capturedAt,
          // only sent for annotated copies, so ordinary photos keep working on a database that predates annotations
          ...(p.annotatedFrom ? { annotated_from: p.annotatedFrom, annotations: p.annotations } : {}),
        });
        if (error && error.code !== "23505") throw classify({ code: error.code, message: error.message, status }); // 23505 = already registered (a retry)
        return APPLIED;
      }
      if (p.action === "upload") {
        const local = await db.get("photos", op.entityId);
        if (!local?.blob) return APPLIED; // already uploaded and cleaned up
        const { error } = await sb.storage.from("audit-photos").upload(p.storagePath, local.blob, { contentType: p.mime ?? "image/jpeg", upsert: false });
        if (error) {
          const f = storageFailure(error);
          if (f.status === 409 || /already exists|duplicate/i.test(f.message ?? "")) return APPLIED; // a retry after a lost response
          throw classify(f);
        }
        return APPLIED;
      }
      if (p.action === "confirm") {
        const { error, status } = await sb.rpc("confirm_photo", { p_photo_id: op.entityId });
        if (error) {
          // "upload_not_found" can be a brief delay after upload: retry. Anything else (size_mismatch, permission) is permanent.
          if (/upload_not_found/.test(error.message)) throw new TransportError("server", error.message, true);
          throw classify({ code: error.code, message: error.message, status });
        }
        return APPLIED;
      }
      return { status: "rejected", message: `unknown photo action ${p.action}` };
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError("network", e instanceof Error ? e.message : String(e), true);
    }
  }

  return { send: (op) => (op.entity === "photo" ? photo(op) : applyOp(op)) };
}

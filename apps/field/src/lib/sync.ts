import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./db";
import { replaceCache } from "./db";
import { reconcileFromServer, type ServerItemRow } from "./audits";
import { finalizeConfirmedPhotos } from "./photos";
import type { DrainSummary, Outbox } from "./outbox";
import type { ProjectRow, RoomRow, TemplateRow } from "./types";

/** Downloads what this user may see (RLS decides) into IndexedDB so the app works offline. */
export async function pullCache(sb: SupabaseClient, db: Db): Promise<void> {
  const [p, r, t] = await Promise.all([
    sb.from("projects").select("id,name,customer,address").is("archived_at", null),
    sb.from("rooms").select("id,project_id,name,floor"),
    sb.from("audit_templates").select("id,name,version,config").eq("active", true),
  ]);
  const failed = p.error ?? r.error ?? t.error;
  if (failed) throw new Error(failed.message);
  await replaceCache(db, { projects: (p.data ?? []) as ProjectRow[], rooms: (r.data ?? []) as RoomRow[], templates: (t.data ?? []) as TemplateRow[] });
}

/** After a drain: for audits with nothing left in the queue, replace provisional results with the server's. */
export async function pullAuditResults(sb: SupabaseClient, db: Db, outbox: Outbox): Promise<void> {
  const queue = await outbox.list();
  for (const audit of await db.getAll("audits")) {
    const mine = queue.filter((q) => q.auditId === audit.auditId);
    const created = mine.some((q) => q.op.entity === "audit" && q.state.status === "confirmed");
    if (!created) continue; // the audit does not exist on the server yet
    const hasPendingOps = mine.some((q) => q.state.status !== "confirmed");
    if (hasPendingOps) continue;
    const { data, error } = await sb.from("audit_items").select("item_key,result,row_version").eq("audit_id", audit.auditId).eq("version", 1);
    if (!error && data) await reconcileFromServer(db, audit.auditId, data as ServerItemRow[], { hasPendingOps: false });
  }
}

/** For audits whose submit reached the server, ask the server for the authoritative readiness. */
export async function pullAuditStates(sb: SupabaseClient, db: Db, outbox: Outbox): Promise<void> {
  const queue = await outbox.list();
  for (const audit of await db.getAll("audits")) {
    if (!audit.submittedAt) continue;
    const submitted = queue.some((q) => q.auditId === audit.auditId && q.op.entity === "audit" && q.op.payload.action === "submit" && q.state.status === "confirmed");
    if (!submitted) continue;
    const { data, error } = await sb.rpc("audit_state", { p_audit_id: audit.auditId, p_version: 1 });
    if (!error && typeof data === "string" && data !== audit.serverState) await db.put("audits", { ...audit, serverState: data });
  }
}

export interface SyncResult extends DrainSummary { pulled: boolean; error?: string }

export async function syncNow(deps: { sb: SupabaseClient; db: Db; outbox: Outbox }, o: { ignoreBackoff?: boolean } = {}): Promise<SyncResult> {
  const { sb, db, outbox } = deps;
  await outbox.recover();
  const sum = await outbox.drain(o);
  if (sum.networkDown) return { ...sum, pulled: false };
  try {
    await finalizeConfirmedPhotos(db, outbox);
    await pullAuditResults(sb, db, outbox);
    await pullAuditStates(sb, db, outbox);
    await pullCache(sb, db);
    return { ...sum, pulled: true };
  } catch (e) {
    return { ...sum, pulled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

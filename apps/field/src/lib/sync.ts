import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./db";
import { replaceCache } from "./db";
import { reconcileFromServer, type ServerItemRow } from "./audits";
import { finalizeConfirmedPhotos } from "./photos";
import type { DrainSummary, Outbox } from "./outbox";
import { reconcileRoomChecks, type ServerCheckRow } from "./roomChecks";
import type { ProjectRow, RoomRow, TemplateRow } from "./types";

/** Downloads what this user may see (RLS decides) into IndexedDB so the app works offline. */
export async function pullCache(sb: SupabaseClient, db: Db): Promise<void> {
  const [p, r, t] = await Promise.all([
    sb.from("projects").select("id,name,customer,address").is("archived_at", null),
    sb.from("rooms").select("id,project_id,name,floor,details,details_source"),
    sb.from("audit_templates").select("id,name,version,config").eq("active", true),
  ]);
  const failed = p.error ?? r.error ?? t.error;
  if (failed) throw new Error(failed.message);
  await replaceCache(db, { projects: (p.data ?? []) as ProjectRow[], rooms: (r.data ?? []) as RoomRow[], templates: (t.data ?? []) as TemplateRow[] });
}

/** Label for an embedded profile row: name, else email. */
const labelOf = (p: unknown): string | null => {
  const x = (Array.isArray(p) ? p[0] : p) as { full_name?: string | null; email?: string | null } | null | undefined;
  return x?.full_name?.trim() || x?.email || null;
};

/** After a drain: for each audit VERSION with nothing left in the queue, replace provisional results with the server's. */
export async function pullAuditResults(sb: SupabaseClient, db: Db, outbox: Outbox): Promise<void> {
  const queue = await outbox.list();
  for (const audit of await db.getAll("audits")) {
    const mine = queue.filter((q) => q.auditId === audit.auditId);
    const created = mine.some((q) => q.op.entity === "audit" && q.op.entityId === audit.key && (q.op.payload.action === "create" || q.op.payload.action === "revise") && q.state.status === "confirmed");
    if (!created) continue; // this version does not exist on the server yet
    // pending work in this audit (this or an earlier version) could still change the server's rows: wait until it is confirmed
    if (mine.some((q) => q.state.status !== "confirmed")) continue;
    const full = "item_key,result,row_version,result_at,issue_raised_at,result_by_profile:profiles!audit_items_result_by_fkey(full_name,email),issue_by_profile:profiles!audit_items_issue_raised_by_fkey(full_name,email)";
    let res: { data: unknown; error: unknown } = await sb.from("audit_items").select(full).eq("audit_id", audit.auditId).eq("version", audit.version);
    // a database that predates attribution columns: fall back to the basic columns
    if (res.error) res = await sb.from("audit_items").select("item_key,result,row_version").eq("audit_id", audit.auditId).eq("version", audit.version);
    if (res.error || !res.data) continue;
    const rows: ServerItemRow[] = (res.data as unknown as Record<string, unknown>[]).map((r) => ({
      item_key: String(r.item_key), result: String(r.result), row_version: Number(r.row_version),
      result_at: (r.result_at as string | null | undefined) ?? null, issue_raised_at: (r.issue_raised_at as string | null | undefined) ?? null,
      result_by_label: labelOf(r.result_by_profile), issue_raised_by_label: labelOf(r.issue_by_profile),
    }));
    await reconcileFromServer(db, audit.auditId, audit.version, rows, { hasPendingOps: false });
  }
}

/**
 * After a drain: for each room with nothing left in the queue, replace the local checklist with the server's.
 * (The outbox groups a room's checklist operations under the room id.)
 */
export async function pullRoomChecks(sb: SupabaseClient, db: Db, outbox: Outbox): Promise<void> {
  const queue = await outbox.list();
  const rooms = await db.getAll("rooms");
  if (rooms.length === 0) return;
  const res = await sb.from("room_checks").select("room_id,project_id,item_key,state,note,checked_at,row_version,by:profiles!room_checks_checked_by_fkey(full_name,email)");
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data ?? []) as unknown as (Omit<ServerCheckRow, "by_label"> & { by: unknown })[];
  for (const room of rooms) {
    if (queue.some((q) => q.auditId === room.id && q.state.status !== "confirmed")) continue; // still has unsynced ticks: keep local state
    await reconcileRoomChecks(db, room.id, rows.filter((r) => r.room_id === room.id).map((r) => ({ ...r, by_label: labelOf(r.by) })));
  }
}

/** For audits whose submit reached the server, ask the server for the authoritative readiness. */
export async function pullAuditStates(sb: SupabaseClient, db: Db, outbox: Outbox): Promise<void> {
  const queue = await outbox.list();
  for (const audit of await db.getAll("audits")) {
    if (!audit.submittedAt) continue;
    const submitted = queue.some((q) => q.auditId === audit.auditId && q.op.entity === "audit" && q.op.entityId === audit.key && q.op.payload.action === "submit" && q.state.status === "confirmed");
    if (!submitted) continue;
    const { data, error } = await sb.rpc("audit_state", { p_audit_id: audit.auditId, p_version: audit.version });
    if (!error && typeof data === "string" && data !== audit.serverState) await db.put("audits", { ...audit, serverState: data });
  }
}

export interface SyncResult extends DrainSummary { pulled: boolean; error?: string }

/** A failure that means "cannot reach the server" (as opposed to the server refusing something). */
export const looksLikeNetworkFailure = (m: string): boolean => /failed to fetch|network|load failed|timed out|timeout|abort|offline|disconnected/i.test(m);

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
    await pullRoomChecks(sb, db, outbox);
    return { ...sum, pulled: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // The phone's own "am I online" flag is unreliable (it says yes on Wi-Fi with no internet), so go by what actually failed.
    return { ...sum, pulled: false, error, networkDown: looksLikeNetworkFailure(error) };
  }
}

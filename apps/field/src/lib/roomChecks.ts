import { err, ok, type OperationEnvelope, type Result } from "@phc/domain";
import type { Db } from "./db";
import { newOutboxRecord } from "./outbox";
import type { CheckState, LocalRoomCheck } from "./types";

/** The checklist pills, in order. The keys must equal app.room_check_keys() in the database (a test compares them). */
export const ROOM_CHECK_ITEMS: { key: string; label: string }[] = [
  { key: "cabinetry_matches_plans", label: "Matches plans" },
  { key: "doors_drawers_adjusted", label: "Doors & drawers" },
  { key: "fillers", label: "Fillers" },
  { key: "crown", label: "Crown / sub crown" },
  { key: "light_apron_bottoms", label: "Light apron / bottoms" },
  { key: "finished_toes", label: "Finished toes" },
  { key: "accessories_inside", label: "Accessories inside" },
  { key: "shelves", label: "Shelves" },
  { key: "hardware", label: "Hardware" },
  { key: "clean", label: "Cabinetry clean" },
  { key: "finishing", label: "Caulk, fast caps, nail holes" },
];

/** Longer wording for the item panel (from the sign-off sheet). */
export const ROOM_CHECK_LONG: Record<string, string> = {
  cabinetry_matches_plans: "Cabinetry is correct and matches plans",
  doors_drawers_adjusted: "Doors and drawers are all adjusted and functional",
  fillers: "All fillers are correctly installed",
  crown: "All sub crown / crown is installed and complete",
  light_apron_bottoms: "All light apron / finished bottoms are installed and complete",
  finished_toes: "Finished toes are installed, including appliance toe skins",
  accessories_inside: "All accessories in this room are installed inside cabinetry",
  shelves: "All shelves are installed",
  hardware: "Hardware is installed and complete",
  clean: "The cabinetry is clean",
  finishing: "All caulking is complete, fast caps are installed and nail holes are filled",
};

export interface CheckCtx { db: Db; userId: string; userLabel: string; newId: () => string; now: () => string; notify: () => void }
export type CheckError = { code: "unknown_item" | "note_required" | "note_too_long" | "room_not_cached"; message: string };

export const checkKey = (roomId: string, itemKey: string) => `${roomId}:${itemKey}`;

/**
 * Sets one pill. Written to IndexedDB and the outbox in ONE transaction (works with no connectivity). `clear` un-ticks it.
 * Not done needs a note explaining why (the server enforces this too).
 */
export async function setRoomCheck(
  ctx: CheckCtx, roomId: string, itemKey: string, state: CheckState | "clear", note?: string,
): Promise<Result<{ opId: string }, CheckError>> {
  if (!ROOM_CHECK_ITEMS.some((i) => i.key === itemKey)) return err({ code: "unknown_item", message: "That checklist item does not exist." });
  const text = note?.trim();
  if (state === "not_done" && !text) return err({ code: "note_required", message: "Add a note saying why this is not finished." });
  if (text && text.length > 500) return err({ code: "note_too_long", message: "Keep the note under 500 characters." });
  const room = await ctx.db.get("rooms", roomId);
  if (!room) return err({ code: "room_not_cached", message: "That room is not available on this device yet. Connect once to download it." });

  const key = checkKey(roomId, itemKey);
  const cur = await ctx.db.get("room_checks", key);
  const baseVersion = cur?.nextBase ?? 0;
  const at = ctx.now();
  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "room_check", entityId: key, baseVersion,
    payload: { state, ...(text && state !== "clear" ? { note: text } : {}) }, createdAt: at, actor: ctx.userId,
  };
  const tx = ctx.db.transaction(["room_checks", "outbox"], "readwrite");
  const writes: Promise<unknown>[] = [tx.objectStore("outbox").add(newOutboxRecord(op, roomId))];
  if (state === "clear") {
    // The server deletes the row, so the next base is 0 (which is also what a missing local row means).
    writes.push(tx.objectStore("room_checks").delete(key));
  } else {
    const row: LocalRoomCheck = { key, roomId, projectId: room.project_id, itemKey, state, ...(text ? { note: text } : {}), by: ctx.userLabel, at, pending: true, nextBase: baseVersion + 1 };
    writes.push(tx.objectStore("room_checks").put(row));
  }
  await Promise.all(writes);
  await tx.done;
  ctx.notify();
  return ok({ opId: op.opId });
}

export interface ServerCheckRow { room_id: string; item_key: string; state: string; note: string | null; checked_at: string; row_version: number; by_label: string | null; project_id: string }

/** Replace one room's local checks with the server's (call only when nothing for that room is still queued). */
export async function reconcileRoomChecks(db: Db, roomId: string, rows: ServerCheckRow[]): Promise<void> {
  const tx = db.transaction("room_checks", "readwrite");
  for (const old of await tx.store.index("by_room").getAll(roomId)) await tx.store.delete(old.key);
  for (const r of rows) {
    if (r.state !== "done" && r.state !== "not_done" && r.state !== "na") continue;
    await tx.store.put({
      key: checkKey(r.room_id, r.item_key), roomId: r.room_id, projectId: r.project_id, itemKey: r.item_key, state: r.state,
      ...(r.note ? { note: r.note } : {}), ...(r.by_label ? { by: r.by_label } : {}), at: r.checked_at, pending: false, nextBase: r.row_version,
    });
  }
  await tx.done;
}

/** Counts for a progress line: items marked done or N/A, out of all items. */
export function checkProgress(checks: LocalRoomCheck[]): { complete: number; notDone: number; total: number } {
  return { complete: checks.filter((c) => c.state === "done" || c.state === "na").length, notDone: checks.filter((c) => c.state === "not_done").length, total: ROOM_CHECK_ITEMS.length };
}

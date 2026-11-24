import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { openPhcDb, replaceCache, type Db } from "../src/lib/db";
import { Outbox } from "../src/lib/outbox";
import { checkProgress, reconcileRoomChecks, ROOM_CHECK_ITEMS, setRoomCheck } from "../src/lib/roomChecks";
import { CARD_FIELDS, fieldsFor, HIDDEN_KEYS, MORE_FIELDS } from "../src/lib/roomFields";

const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201";
let db: Db; let ob: Outbox; let n = 0; let seq = 0; let t = 0;
const ctx = () => ({ db, userId: "u1", userLabel: "Pat Installer", newId: () => `00000000-0000-4000-8000-${String(7000 + ++seq).padStart(12, "0")}`, now: () => `2026-11-08T10:${String(10 + ++t).padStart(2, "0")}:00.000Z`, notify: () => ob.notify() });

beforeEach(async () => {
  db = await openPhcDb(`rooms-${++n}`);
  await replaceCache(db, { projects: [{ id: P, name: "Project One", customer: null, address: null }], rooms: [{ id: R, project_id: P, name: "Kitchen", floor: null, details: { panelName: "Slab" } }], templates: [] });
  ob = new Outbox(db, { send: async () => { throw new Error("offline"); } });
});

describe("room checklist items", () => {
  it("are the same 11 keys, in the same order, as app.room_check_keys() in the database", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261108001300_room_checklist.sql", import.meta.url), "utf8");
    const body = /app\.room_check_keys\(\) returns text\[\][\s\S]*?select array\[([\s\S]*?)\]/.exec(sql)![1]!;
    const keys = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(ROOM_CHECK_ITEMS.map((i) => i.key)).toEqual(keys);
    expect(keys).toHaveLength(11);
  });
});

describe("setRoomCheck (works fully offline)", () => {
  it("one tap marks done: stores the pill and queues exactly one room_check op with who and when", async () => {
    const r = await setRoomCheck(ctx(), R, "finished_toes", "done");
    expect(r.ok).toBe(true);
    const row = await db.get("room_checks", `${R}:finished_toes`);
    expect(row).toMatchObject({ state: "done", by: "Pat Installer", pending: true, nextBase: 1, roomId: R, projectId: P });
    const q = await ob.list();
    expect(q).toHaveLength(1);
    expect(q[0]!.auditId).toBe(R);
    expect(q[0]!.op).toMatchObject({ entity: "room_check", entityId: `${R}:finished_toes`, baseVersion: 0, payload: { state: "done" }, actor: "u1" });
  });
  it("not done needs a note (blank is refused) and keeps it", async () => {
    expect((await setRoomCheck(ctx(), R, "finished_toes", "not_done")).ok).toBe(false);
    const blank = await setRoomCheck(ctx(), R, "finished_toes", "not_done", "   ");
    expect(blank.ok).toBe(false);
    expect((await ob.list())).toHaveLength(0);
    const note = "Toe skins installed after wood floor installation. After 11/5";
    expect((await setRoomCheck(ctx(), R, "finished_toes", "not_done", note)).ok).toBe(true);
    expect(await db.get("room_checks", `${R}:finished_toes`)).toMatchObject({ state: "not_done", note });
    expect((await ob.list())[0]!.op.payload).toEqual({ state: "not_done", note });
  });
  it("rejects unknown items, over-long notes and rooms that are not on the device, queueing nothing", async () => {
    expect(await setRoomCheck(ctx(), R, "made_up", "done")).toMatchObject({ ok: false, error: { code: "unknown_item" } });
    expect(await setRoomCheck(ctx(), R, "shelves", "not_done", "x".repeat(501))).toMatchObject({ ok: false, error: { code: "note_too_long" } });
    expect(await setRoomCheck(ctx(), "00000000-0000-4000-8000-0000000009ff", "shelves", "done")).toMatchObject({ ok: false, error: { code: "room_not_cached" } });
    expect(await ob.list()).toHaveLength(0);
  });
  it("chains base versions across several offline taps: tick, change, untick, tick again", async () => {
    await setRoomCheck(ctx(), R, "shelves", "done");
    await setRoomCheck(ctx(), R, "shelves", "na");
    await setRoomCheck(ctx(), R, "shelves", "clear");
    await setRoomCheck(ctx(), R, "shelves", "done");
    expect((await ob.list()).map((q) => q.op.baseVersion)).toEqual([0, 1, 2, 0]);          // clear resets the server row, so the next tick starts at 0 again
    expect((await ob.list()).map((q) => (q.op.payload as { state: string }).state)).toEqual(["done", "na", "clear", "done"]);
  });
  it("untick removes the local pill but keeps the queued clear", async () => {
    await setRoomCheck(ctx(), R, "hardware", "done");
    await setRoomCheck(ctx(), R, "hardware", "clear");
    expect(await db.get("room_checks", `${R}:hardware`)).toBeUndefined();
    expect((await ob.list()).at(-1)!.op.payload).toEqual({ state: "clear" });
  });
  it("a note on done/na is not sent unless the person typed one; clear never carries a note", async () => {
    await setRoomCheck(ctx(), R, "clean", "clear", "ignored");
    expect((await ob.list())[0]!.op.payload).toEqual({ state: "clear" });
  });
});

describe("reconcileRoomChecks and progress", () => {
  it("replaces a room's local pills with the server's and drops unknown states", async () => {
    await setRoomCheck(ctx(), R, "clean", "done");
    await reconcileRoomChecks(db, R, [
      { room_id: R, project_id: P, item_key: "hardware", state: "done", note: null, checked_at: "2026-11-08T09:00:00Z", row_version: 3, by_label: "Sam" },
      { room_id: R, project_id: P, item_key: "fillers", state: "weird", note: null, checked_at: "2026-11-08T09:00:00Z", row_version: 1, by_label: null },
    ]);
    const rows = await db.getAllFromIndex("room_checks", "by_room", R);
    expect(rows.map((r) => r.itemKey)).toEqual(["hardware"]);
    expect(rows[0]).toMatchObject({ pending: false, nextBase: 3, by: "Sam" });
  });
  it("counts done and N/A as complete and not-done separately", () => {
    const mk = (state: "done" | "not_done" | "na") => ({ key: "k", roomId: R, projectId: P, itemKey: "x", state, pending: false, nextBase: 1 });
    expect(checkProgress([mk("done"), mk("na"), mk("not_done")])).toEqual({ complete: 2, notDone: 1, total: 11 });
  });
});

describe("room details shown to installers", () => {
  it("lists only fields with a value, in order, and never a PHC-only field", () => {
    const pairs = fieldsFor({ woodSpecies: "Pre Finished", panelName: "Slab", edgebanding: "  ", phcOnlyNotes: "internal", gateCode: "1234" }, CARD_FIELDS);
    expect(pairs.map((p) => [p.key, p.value])).toEqual([["panelName", "Slab"], ["woodSpecies", "Pre Finished"]]);
    expect(fieldsFor({ phcOnlyNotes: "internal", gateCode: "1" }, [...CARD_FIELDS, ...MORE_FIELDS, { key: "phcOnlyNotes", label: "x" }, { key: "gateCode", label: "y" }])).toEqual([]);
    expect(HIDDEN_KEYS.has("phcOnlyNotes") && HIDDEN_KEYS.has("gateCode")).toBe(true);
  });
});

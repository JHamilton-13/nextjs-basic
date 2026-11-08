import { describe, it, expect } from "vitest";
import { PRESET_OPTIONS, type ReportOptions } from "@phc/domain";
import { FakeDb } from "./fakes";
import { choosePhotos, initialsOf, loadReportData } from "./loadReportData";

function seed() {
  const db = new FakeDb();
  db.rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Bath" }];
  db.profiles = [{ id: "u1", full_name: "Rick Wells", email: "rw@example.test" }, { id: "u2", full_name: null, email: "pat.lee@example.test" }];
  const issue = (id: string, o: Partial<(typeof db.issues)[number]> = {}) => ({ id, room_id: "r1", kind: "pre_install_correction", title: `t ${id}`, description: `d ${id}`, trade_name: "Plumbing", raised_by: "u1", raised_at: "2026-09-10T18:43:00Z", completed_at: null, voided_at: null, ...o });
  db.issues = [issue("a"), issue("b", { completed_at: "2026-09-11T10:00:00Z" }), issue("c", { voided_at: "2026-09-11T10:00:00Z" }), issue("d", { kind: "punch_item", trade_name: null }), issue("e", { room_id: "r2", raised_by: "u2" })];
  return db;
}
const photos = () => [
  { id: "o1", issue_id: "a", storage_path: "p1/a/o1.jpg", captured_at: "2026-09-10T18:50:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
  { id: "m1", issue_id: "a", storage_path: "p1/a/m1.jpg", captured_at: "2026-09-10T20:00:00Z", confirmed_at: "2026-09-10T20:01:00Z", annotated_from: "o1" },
  { id: "o2", issue_id: "a", storage_path: "p1/a/o2.jpg", captured_at: "2026-09-10T18:40:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
  { id: "o3", issue_id: "a", storage_path: "p1/a/o3.jpg", captured_at: "2026-09-10T18:45:00Z", confirmed_at: null, annotated_from: null },
];

describe("initialsOf", () => {
  it("uses first and last name", () => { expect(initialsOf("Rick Wells", "x@y.test")).toBe("RW"); expect(initialsOf("  maria  de la cruz ", null)).toBe("MC"); });
  it("single name gives one letter", () => { expect(initialsOf("Cher", null)).toBe("C"); });
  it("falls back to the email", () => { expect(initialsOf(null, "pat.lee@example.test")).toBe("PL"); expect(initialsOf("", "pat@example.test")).toBe("P"); });
  it("never throws on nothing", () => { expect(initialsOf(null, null)).toBe("?"); });
});

describe("choosePhotos: one kind of photo, never both", () => {
  it("annotated: the marked-up copy replaces its original (which is archived); originals never marked up stay; never-uploaded photos are left out", () => {
    expect(choosePhotos(photos(), "annotated").map((p) => [p.id, p.capturedAt])).toEqual([["o2", "2026-09-10T18:40:00Z"], ["m1", "2026-09-10T18:50:00Z"]]);
  });
  it("original: the originals only, even when a marked-up copy exists", () => {
    expect(choosePhotos(photos(), "original").map((p) => p.id)).toEqual(["o2", "o1"]);
  });
  it("none: nothing", () => { expect(choosePhotos(photos(), "none")).toEqual([]); });
});

describe("loadReportData", () => {
  it("builder preset: Pre-Install only, voided left out, trade names and initials", async () => {
    const d = await loadReportData(seed(), "p1", PRESET_OPTIONS.builder_site_audit);
    expect(d.model.totals).toMatchObject({ identified: 3, incomplete: 2 });                 // a, b, e
    expect(d.model.rooms.map((r) => r.roomName)).toEqual(["Kitchen", "Bath"]);
    expect(d.model.rooms[0]!.issues.map((i) => [i.id, i.status, i.tradeName, i.raisedByInitials])).toEqual([["a", "open", "Plumbing", "RW"], ["b", "completed", "Plumbing", "RW"]]);
    expect(d.model.rooms[1]!.issues[0]!.raisedByInitials).toBe("PL");
    expect(d.project.name).toBe("Sample Project");
  });
  it("service preset lists punch items whatever the room status", async () => {
    const d = await loadReportData(seed(), "p1", PRESET_OPTIONS.service);
    expect(d.model.rooms.map((r) => [r.roomName, r.issues.map((i) => i.id)])).toEqual([["Kitchen", ["d"]]]);
  });
  it("photo paths follow the photo mode and only cover issues that are on the report", async () => {
    const db = seed(); db.photos = photos();
    const ann = await loadReportData(db, "p1", PRESET_OPTIONS.builder_site_audit);
    expect(ann.photoPaths).toEqual({ o2: "p1/a/o2.jpg", m1: "p1/a/m1.jpg" });
    const orig = await loadReportData(db, "p1", { ...PRESET_OPTIONS.builder_site_audit, photos: "original" });
    expect(orig.photoPaths).toEqual({ o2: "p1/a/o2.jpg", o1: "p1/a/o1.jpg" });
    const none = await loadReportData(db, "p1", { ...PRESET_OPTIONS.builder_site_audit, photos: "none" });
    expect(none.photoPaths).toEqual({});
    const other = await loadReportData(db, "p1", { ...PRESET_OPTIONS.service });   // issue "a" is a Pre-Install: its photos are not on a service report
    expect(other.photoPaths).toEqual({});
  });
  it("room status: a room never opened is Not completed and says so; a fully ticked room is Completed with the latest who and when", async () => {
    const db = seed();
    const keys = ["cabinetry_matches_plans", "doors_drawers_adjusted", "fillers", "crown", "light_apron_bottoms", "finished_toes", "accessories_inside", "shelves", "hardware", "clean", "finishing"];
    db.checks = keys.map((k, i) => ({ room_id: "r1", item_key: k, state: (i % 2 ? "na" : "done") as "done" | "na", note: null, checked_by: i === 10 ? "u2" : "u1", checked_at: `2026-09-10T1${i % 10}:00:00Z` }));
    const d = await loadReportData(db, "p1", { ...PRESET_OPTIONS.room_status, kinds: [], checklist: "all" } satisfies ReportOptions);
    expect(d.model.rooms[0]!.checklist).toMatchObject({ completed: true, outstanding: [], byWho: "RW", at: "2026-09-10T19:00:00Z" });
    expect(d.model.rooms[1]!.checklist).toMatchObject({ completed: false, started: false, outstanding: ["Checklist not started"] });
  });
  it("lists not-done items with their note", async () => {
    const db = seed();
    db.checks = [{ room_id: "r2", item_key: "finished_toes", state: "not_done", note: "After floor install, after 11/5", checked_by: "u1", checked_at: "2026-09-10T12:00:00Z" }];
    const d = await loadReportData(db, "p1", { ...PRESET_OPTIONS.room_status, kinds: [], checklist: "incomplete" });
    const bath = d.model.rooms.find((r) => r.roomName === "Bath")!;
    expect(bath.checklist!.outstanding).toContain("Finished toes: After floor install, after 11/5");
    expect(bath.checklist!.outstanding).toContain("Matches plans");
  });
  it("throws a clear error when the project is not visible to this manager", async () => {
    const db = seed(); db.project = null;
    await expect(loadReportData(db, "p1", PRESET_OPTIONS.builder_site_audit)).rejects.toMatchObject({ code: "project_not_found" });
  });
});

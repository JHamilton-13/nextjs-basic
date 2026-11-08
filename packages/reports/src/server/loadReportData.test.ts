import { describe, it, expect } from "vitest";
import { FakeDb } from "./fakes";
import { initialsOf, loadBuilderAuditData, loadRoomStatusData } from "./loadReportData";

function seed() {
  const db = new FakeDb();
  db.rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Bath" }];
  db.profiles = [{ id: "u1", full_name: "Rick Wells", email: "rw@example.test" }, { id: "u2", full_name: null, email: "pat.lee@example.test" }];
  const issue = (id: string, o: Partial<(typeof db.issues)[number]> = {}) => ({ id, room_id: "r1", kind: "pre_install_correction", title: `t ${id}`, description: `d ${id}`, trade_name: "Plumbing", raised_by: "u1", raised_at: "2026-09-10T18:43:00Z", completed_at: null, voided_at: null, ...o });
  db.issues = [issue("a"), issue("b", { completed_at: "2026-09-11T10:00:00Z" }), issue("c", { voided_at: "2026-09-11T10:00:00Z" }), issue("d", { kind: "punch_item", trade_name: null }), issue("e", { room_id: "r2", raised_by: "u2" })];
  return db;
}

describe("initialsOf", () => {
  it("uses first and last name", () => {
    expect(initialsOf("Rick Wells", "x@y.test")).toBe("RW");
    expect(initialsOf("  maria  de la cruz ", null)).toBe("MC");
  });
  it("single name gives one letter", () => { expect(initialsOf("Cher", null)).toBe("C"); });
  it("falls back to the email", () => {
    expect(initialsOf(null, "pat.lee@example.test")).toBe("PL");
    expect(initialsOf("", "pat@example.test")).toBe("P");
  });
  it("never throws on nothing", () => { expect(initialsOf(null, null)).toBe("?"); });
});

describe("loadBuilderAuditData", () => {
  it("returns the Pre-Install Corrections only, voided left out, with trade names and initials", async () => {
    const d = await loadBuilderAuditData(seed(), "p1");
    expect(d.summary.identified).toBe(3);          // a, b, e
    expect(d.summary.incomplete).toBe(2);          // a, e
    expect(d.summary.rooms.map((r) => r.roomName)).toEqual(["Kitchen", "Bath"]);
    expect(d.summary.rooms[0]!.issues.map((i) => [i.id, i.status, i.tradeName, i.raisedByInitials])).toEqual([["a", "open", "Plumbing", "RW"], ["b", "completed", "Plumbing", "RW"]]);
    expect(d.summary.rooms[1]!.issues[0]!.raisedByInitials).toBe("PL");
    expect(d.project.name).toBe("Sample Project");
  });
  it("uses the marked-up copy of a photo when there is one, with the original's capture time", async () => {
    const db = seed();
    db.photos = [
      { id: "o1", issue_id: "a", storage_path: "p1/a/o1.jpg", captured_at: "2026-09-10T18:50:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
      { id: "m1", issue_id: "a", storage_path: "p1/a/m1.jpg", captured_at: "2026-09-10T20:00:00Z", confirmed_at: "2026-09-10T20:01:00Z", annotated_from: "o1" },
      { id: "o2", issue_id: "a", storage_path: "p1/a/o2.jpg", captured_at: "2026-09-10T18:40:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
      { id: "o3", issue_id: "a", storage_path: "p1/a/o3.jpg", captured_at: "2026-09-10T18:45:00Z", confirmed_at: null, annotated_from: null },
    ];
    const d = await loadBuilderAuditData(db, "p1");
    const a = d.summary.rooms[0]!.issues[0]!;
    expect(a.photos).toEqual([{ id: "o2", capturedAt: "2026-09-10T18:40:00Z" }, { id: "m1", capturedAt: "2026-09-10T18:50:00Z" }]);   // by capture time; o3 not uploaded yet
    expect(d.photoPaths).toEqual({ o2: "p1/a/o2.jpg", m1: "p1/a/m1.jpg" });
  });
  it("throws a clear error when the project is not visible to this manager", async () => {
    const db = seed(); db.project = null;
    await expect(loadBuilderAuditData(db, "p1")).rejects.toMatchObject({ code: "project_not_found" });
  });
});

describe("loadRoomStatusData", () => {
  it("a room never opened is Not completed and says so", async () => {
    const rows = await loadRoomStatusData(seed(), "p1");
    expect(rows[0]).toMatchObject({ roomName: "Kitchen", completed: false, byWho: null, at: null, outstanding: ["Checklist not started"] });
  });
  it("counts open issues of every kind, not voided or completed", async () => {
    const rows = await loadRoomStatusData(seed(), "p1");
    expect(rows[0]!.openIssues).toBe(2);           // a (pre-install) and d (punch); b completed, c voided
    expect(rows[1]!.openIssues).toBe(1);
  });
  it("a fully ticked room is Completed with the latest who and when", async () => {
    const db = seed();
    const keys = ["cabinetry_matches_plans", "doors_drawers_adjusted", "fillers", "crown", "light_apron_bottoms", "finished_toes", "accessories_inside", "shelves", "hardware", "clean", "finishing"];
    db.checks = keys.map((k, i) => ({ room_id: "r1", item_key: k, state: i % 2 ? "na" : "done", note: null, checked_by: i === 10 ? "u2" : "u1", checked_at: `2026-09-10T1${i % 10}:00:00Z` }));
    const rows = await loadRoomStatusData(db, "p1");
    expect(rows[0]).toMatchObject({ completed: true, outstanding: [], byWho: "RW" });
    expect(rows[0]!.at).toBe("2026-09-10T19:00:00Z");
  });
  it("lists not-done items with their note", async () => {
    const db = seed();
    db.checks = [{ room_id: "r2", item_key: "finished_toes", state: "not_done", note: "After floor install, after 11/5", checked_by: "u1", checked_at: "2026-09-10T12:00:00Z" }];
    const rows = await loadRoomStatusData(db, "p1");
    expect(rows[1]!.completed).toBe(false);
    expect(rows[1]!.outstanding).toContain("Finished toes: After floor install, after 11/5");
    expect(rows[1]!.outstanding).toContain("Matches plans");
  });
});

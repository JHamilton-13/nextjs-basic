import { describe, it, expect } from "vitest";
import {
  builderAuditSummary, categoryOf, isValidEmail, requiresTrade, roomStatus,
  type IssueKind, type PillDef, type PillMark, type ReportIssue,
} from "../src";

const ALL_KINDS: IssueKind[] = ["pre_install_correction", "punch_item", "touch_up", "missing_part", "damaged_part"];

describe("categoryOf", () => {
  it("maps every kind", () => {
    expect(categoryOf("pre_install_correction")).toBe("pre_install_corrections");
    expect(categoryOf("punch_item")).toBe("service");
    expect(categoryOf("missing_part")).toBe("service");
    expect(categoryOf("damaged_part")).toBe("service");
    expect(categoryOf("touch_up")).toBe("touch_ups");
  });
  it("covers all five kinds exactly (a new kind must be placed in a category)", () => {
    expect(new Set(ALL_KINDS.map(categoryOf))).toEqual(new Set(["pre_install_corrections", "service", "touch_ups"]));
  });
});

describe("requiresTrade", () => {
  it("is true only for pre_install_correction", () => {
    expect(ALL_KINDS.filter(requiresTrade)).toEqual(["pre_install_correction"]);
  });
});

const rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Bath 1" }, { id: "r3", name: "Laundry" }];
const issue = (id: string, roomId: string, kind: IssueKind, status: ReportIssue["status"], o: Partial<ReportIssue> = {}): ReportIssue => ({
  id, roomId, kind, status, tradeName: kind === "pre_install_correction" ? "plumbing" : null, title: `t-${id}`, description: `d-${id}`,
  raisedByInitials: "RW", raisedOn: "2026-09-10T18:43:00Z", photos: [], ...o,
});

describe("builderAuditSummary", () => {
  it("counts identified and incomplete (void excluded; other kinds ignored)", () => {
    const issues = [
      issue("a", "r1", "pre_install_correction", "open"),
      issue("b", "r1", "pre_install_correction", "open"),
      issue("c", "r2", "pre_install_correction", "completed"),
      issue("d", "r2", "pre_install_correction", "void"),
      issue("e", "r1", "punch_item", "open"),
    ];
    const s = builderAuditSummary(issues, rooms);
    expect(s.identified).toBe(3);
    expect(s.incomplete).toBe(2);
  });
  it("omits rooms without pre-install issues, keeps room order and issue order", () => {
    const issues = [
      issue("x", "r3", "pre_install_correction", "open"),
      issue("y", "r1", "pre_install_correction", "open"),
      issue("z", "r1", "pre_install_correction", "completed"),
      issue("p", "r2", "touch_up", "open"),
    ];
    const s = builderAuditSummary(issues, rooms);
    expect(s.rooms.map((r) => r.roomName)).toEqual(["Kitchen", "Laundry"]);       // room order, not issue order; Bath 1 has none
    expect(s.rooms[0]!.issues.map((i) => i.id)).toEqual(["y", "z"]);               // issue order kept
  });
  it("with no issues returns 0, 0, []", () => {
    expect(builderAuditSummary([], rooms)).toEqual({ identified: 0, incomplete: 0, rooms: [] });
    expect(builderAuditSummary([], [])).toEqual({ identified: 0, incomplete: 0, rooms: [] });
  });
  it("leaves voided issues out of the room lists too", () => {
    const s = builderAuditSummary([issue("v", "r1", "pre_install_correction", "void")], rooms);
    expect(s).toEqual({ identified: 0, incomplete: 0, rooms: [] });
  });
  it("ignores an issue whose room is not in the room list, in both counts and lists (totals always match what is shown)", () => {
    const s = builderAuditSummary([issue("q", "gone", "pre_install_correction", "open"), issue("k", "r1", "pre_install_correction", "open")], rooms);
    expect(s.identified).toBe(1);
    expect(s.incomplete).toBe(1);
    expect(s.rooms).toHaveLength(1);
  });
  it("does not change its inputs", () => {
    const issues = [issue("a", "r1", "pre_install_correction", "open")];
    const copy = JSON.parse(JSON.stringify(issues));
    builderAuditSummary(issues, rooms);
    expect(issues).toEqual(copy);
  });
});

const defs: PillDef[] = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: `Item ${i}` }));
const mark = (key: string, state: PillMark["state"], note: string | null = null): PillMark => ({ key, state, note });

describe("roomStatus", () => {
  it("is completed when every pill is done or na", () => {
    const marks = defs.map((d, i) => mark(d.key, i % 2 === 0 ? "done" : "na"));
    expect(roomStatus(defs, marks)).toEqual({ completed: true, outstanding: [] });
  });
  it("an all-N/A room is completed", () => {
    expect(roomStatus(defs, defs.map((d) => mark(d.key, "na"))).completed).toBe(true);
  });
  it("with no marks has 11 unticked outstanding and completed false", () => {
    const s = roomStatus(defs, []);
    expect(s.completed).toBe(false);
    expect(s.outstanding).toHaveLength(11);
    expect(s.outstanding.every((o) => o.state === "unticked" && o.note === null)).toBe(true);
    expect(s.outstanding.map((o) => o.key)).toEqual(defs.map((d) => d.key));          // checklist order
  });
  it("keeps the note on a not_done pill", () => {
    const marks = defs.map((d) => mark(d.key, "done"));
    marks[5] = mark("k5", "not_done", "Toe skins installed after wood floor installation. After 11/5");
    const s = roomStatus(defs, marks);
    expect(s.completed).toBe(false);
    expect(s.outstanding).toEqual([{ key: "k5", label: "Item 5", state: "not_done", note: "Toe skins installed after wood floor installation. After 11/5" }]);
  });
  it("mixes not_done and unticked, in checklist order", () => {
    const s = roomStatus(defs, [mark("k0", "done"), mark("k3", "not_done", "later"), mark("k1", "na")]);
    expect(s.outstanding.map((o) => [o.key, o.state])).toEqual([["k2", "unticked"], ["k3", "not_done"], ["k4", "unticked"], ["k5", "unticked"], ["k6", "unticked"], ["k7", "unticked"], ["k8", "unticked"], ["k9", "unticked"], ["k10", "unticked"]]);
  });
  it("ignores marks for items that are not in the checklist definition", () => {
    const s = roomStatus(defs, [mark("not-a-real-item", "done")]);
    expect(s.outstanding).toHaveLength(11);
  });
  it("a room is never completed when the checklist definition is empty (nothing to confirm)", () => {
    expect(roomStatus([], []).completed).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of ["a@b.com", "first.last+tag@sub.example.co.uk", "builder@example.test"]) expect(isValidEmail(ok), ok).toBe(true);
  });
  it("rejects bad ones", () => {
    for (const bad of ["a@b", " ", "", "a b@c.com", "a@b .com", "@b.com", "a@", "a@@b.com", "a@b..com", "a@.com", "a@b.", "a@b.c", "a,b@c.com", "a@b.com\nBcc: x@y.com"]) expect(isValidEmail(bad), JSON.stringify(bad)).toBe(false);
  });
  it("rejects absurdly long input", () => {
    expect(isValidEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isValidEmail(`a@${"b".repeat(250)}.com`)).toBe(false);
  });
  it("does not trim: surrounding spaces are not part of a valid address", () => {
    expect(isValidEmail(" a@b.com")).toBe(false);
    expect(isValidEmail("a@b.com ")).toBe(false);
  });
});

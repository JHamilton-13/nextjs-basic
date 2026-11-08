import { describe, it, expect } from "vitest";
import { buildReportModel, normalizeReportOptions, PRESET_OPTIONS, reportTitle, type IssueKind, type ModelSourceIssue, type ReportOptions, type RoomChecklistInfo } from "../src";

const rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Bath 1" }, { id: "r3", name: "Laundry" }];
const issue = (id: string, roomId: string, kind: IssueKind, status: ModelSourceIssue["status"], o: Partial<ModelSourceIssue> = {}): ModelSourceIssue => ({
  id, roomId, kind, status, tradeName: kind === "pre_install_correction" ? "Plumbing" : null, title: `t-${id}`, description: `d-${id}`,
  raisedByInitials: "RW", raisedOn: "2026-09-10T18:43:00Z", completedOn: status === "completed" ? "2026-09-11T10:00:00Z" : null, photos: [], ...o,
});
const check = (completed: boolean, outstanding: string[] = [], started = true): RoomChecklistInfo => ({ completed, outstanding, started, byWho: started ? "RW" : null, at: started ? "2026-09-10T20:00:00Z" : null });
const checklist: Record<string, RoomChecklistInfo> = { r1: check(true), r2: check(false, ["Finished toes: after 11/5"]), r3: check(false, ["Checklist not started"], false) };
const opts = (o: Partial<ReportOptions> = {}): ReportOptions => ({ ...PRESET_OPTIONS.custom, ...o });

describe("presets", () => {
  it("the builder audit is Pre-Install Corrections only, open and completed, no checklist, no empty rooms", () => {
    expect(PRESET_OPTIONS.builder_site_audit).toMatchObject({ kinds: ["pre_install_correction"], issueStatus: "both", checklist: "none", emptyRooms: false, photos: "annotated" });
  });
  it("the service report lists Punch, Missing and Damaged regardless of status", () => {
    expect(PRESET_OPTIONS.service).toMatchObject({ kinds: ["punch_item", "missing_part", "damaged_part"], issueStatus: "both", checklist: "none" });
  });
  it("the room status report shows every room's checklist and the open service items", () => {
    expect(PRESET_OPTIONS.room_status).toMatchObject({ checklist: "all", issueStatus: "open", kinds: ["punch_item", "missing_part", "damaged_part"] });
  });
  it("titles", () => {
    expect([reportTitle(PRESET_OPTIONS.builder_site_audit), reportTitle(PRESET_OPTIONS.service), reportTitle(PRESET_OPTIONS.room_status), reportTitle(PRESET_OPTIONS.custom)]).toEqual(["Builder Site Audit", "Service Report", "Room Status", "Project Report"]);
  });
});

describe("normalizeReportOptions (what the browser may ask for)", () => {
  it("accepts a good request", () => {
    const r = normalizeReportOptions({ preset: "custom", kinds: ["touch_up", "punch_item"], issueStatus: "open", checklist: "incomplete", emptyRooms: true, photos: "original" });
    expect(r).toEqual({ ok: true, value: { preset: "custom", kinds: ["punch_item", "touch_up"], issueStatus: "open", checklist: "incomplete", emptyRooms: true, photos: "original" } });
  });
  it("puts kinds in the fixed order and drops duplicates", () => {
    const r = normalizeReportOptions({ ...PRESET_OPTIONS.custom, kinds: ["touch_up", "touch_up", "pre_install_correction"] });
    expect(r.ok && r.value.kinds).toEqual(["pre_install_correction", "touch_up"]);
  });
  it("rejects unknown values with a reason, never guesses", () => {
    for (const bad of [{ preset: "weekly" }, { issueStatus: "void" }, { checklist: "some" }, { photos: "both" }, { kinds: ["nope"] }, { kinds: "touch_up" }, { emptyRooms: "yes" }]) {
      const r = normalizeReportOptions({ ...PRESET_OPTIONS.custom, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("photos are one or the other: there is no way to ask for both", () => {
    expect(normalizeReportOptions({ ...PRESET_OPTIONS.custom, photos: ["annotated", "original"] }).ok).toBe(false);
  });
  it("needs something to show", () => {
    const r = normalizeReportOptions({ ...PRESET_OPTIONS.custom, kinds: [], checklist: "none" });
    expect(r).toEqual({ ok: false, error: { code: "nothing_selected", message: expect.stringContaining("Choose") } });
  });
  it("fills missing fields from the preset and refuses non-objects", () => {
    expect(normalizeReportOptions({ preset: "service" })).toEqual({ ok: true, value: PRESET_OPTIONS.service });
    expect(normalizeReportOptions(null).ok).toBe(false);
    expect(normalizeReportOptions("x").ok).toBe(false);
  });
});

describe("buildReportModel", () => {
  const issues = [
    issue("a", "r1", "pre_install_correction", "open"),
    issue("b", "r1", "punch_item", "completed"),
    issue("c", "r2", "damaged_part", "open"),
    issue("d", "r2", "missing_part", "void"),
    issue("e", "r2", "touch_up", "open"),
  ];
  const build = (o: Partial<ReportOptions>, extra: ModelSourceIssue[] = []) => buildReportModel({ rooms, issues: [...issues, ...extra], checklist }, opts(o));

  it("lists only the chosen kinds, and never voided issues", () => {
    const m = build({ kinds: ["punch_item", "damaged_part", "missing_part"], issueStatus: "both", checklist: "none" });
    expect(m.rooms.map((r) => [r.roomName, r.issues.map((i) => i.id)])).toEqual([["Kitchen", ["b"]], ["Bath 1", ["c"]]]);
  });
  it("issue status: open only, completed only, or both", () => {
    const ids = (s: ReportOptions["issueStatus"]) => build({ kinds: ["pre_install_correction", "punch_item", "damaged_part"], issueStatus: s, checklist: "none" }).rooms.flatMap((r) => r.issues.map((i) => i.id));
    expect(ids("open")).toEqual(["a", "c"]);
    expect(ids("completed")).toEqual(["b"]);
    expect(ids("both")).toEqual(["a", "b", "c"]);
  });
  it("a room's items are listed even when the room's checklist is complete (Kitchen is completed but its punch item shows)", () => {
    const m = build({ kinds: ["punch_item"], issueStatus: "both", checklist: "none" });
    expect(m.rooms.map((r) => r.roomName)).toEqual(["Kitchen"]);
  });
  it("rooms with nothing to list are left out unless asked for", () => {
    expect(build({ kinds: ["touch_up"], checklist: "none", emptyRooms: false }).rooms.map((r) => r.roomName)).toEqual(["Bath 1"]);
    expect(build({ kinds: ["touch_up"], checklist: "none", emptyRooms: true }).rooms.map((r) => r.roomName)).toEqual(["Kitchen", "Bath 1", "Laundry"]);
  });
  it("checklist 'incomplete' shows only rooms whose checklist is not completed, with what is outstanding", () => {
    const m = build({ kinds: [], checklist: "incomplete" });
    expect(m.rooms.map((r) => r.roomName)).toEqual(["Bath 1", "Laundry"]);
    expect(m.rooms[0]!.checklist).toMatchObject({ completed: false, outstanding: ["Finished toes: after 11/5"] });
  });
  it("checklist 'all' also shows completed rooms", () => {
    const m = build({ kinds: [], checklist: "all" });
    expect(m.rooms.map((r) => [r.roomName, r.checklist!.completed])).toEqual([["Kitchen", true], ["Bath 1", false], ["Laundry", false]]);
  });
  it("checklist 'none' carries no checklist info at all", () => {
    expect(build({ kinds: ["touch_up"], checklist: "none" }).rooms.every((r) => r.checklist === null)).toBe(true);
  });
  it("a room with issues AND an incomplete checklist shows both; issues keep their order", () => {
    const m = build({ kinds: ["damaged_part", "touch_up"], issueStatus: "open", checklist: "incomplete" }, [issue("f", "r2", "damaged_part", "open")]);
    const bath = m.rooms.find((r) => r.roomName === "Bath 1")!;
    expect(bath.issues.map((i) => i.id)).toEqual(["c", "e", "f"]);
    expect(bath.checklist!.completed).toBe(false);
  });
  it("totals: identified, incomplete and rooms completed come from what is shown", () => {
    const m = build({ kinds: ["pre_install_correction", "punch_item"], issueStatus: "both", checklist: "all" });
    expect(m.totals).toMatchObject({ identified: 2, incomplete: 1, roomsCompleted: 1, roomsWithChecklist: 3 });
  });
  it("matches the builder audit numbers for the builder preset", () => {
    const m = buildReportModel({ rooms, issues, checklist }, PRESET_OPTIONS.builder_site_audit);
    expect(m.totals.identified).toBe(1);
    expect(m.totals.incomplete).toBe(1);
    expect(m.rooms.map((r) => r.roomName)).toEqual(["Kitchen"]);
  });
  it("an issue in a room that is not in the room list is ignored, and inputs are not changed", () => {
    const stray = issue("z", "gone", "punch_item", "open");
    const before = JSON.stringify(issues);
    const m = build({ kinds: ["punch_item"], issueStatus: "both", checklist: "none" }, [stray]);
    expect(m.totals.identified).toBe(1);
    expect(JSON.stringify(issues)).toBe(before);
  });
  it("a room with no checklist info is treated as not started", () => {
    const m = buildReportModel({ rooms: [{ id: "x", name: "New room" }], issues: [], checklist: {} }, opts({ kinds: [], checklist: "incomplete" }));
    expect(m.rooms[0]!.checklist).toMatchObject({ completed: false, started: false });
  });
});

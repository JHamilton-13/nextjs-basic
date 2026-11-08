import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
// pdf-parse prints debug output when imported from its index; the lib file avoids that
// @ts-expect-error no types for the lib path
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { buildReportModel, PRESET_OPTIONS, type IssueKind, type ModelSourceIssue, type ReportOptions, type RoomChecklistInfo } from "@phc/domain";
import { ReportDocument } from "./ReportDocument";
import { renderReport } from "./render";
import { LOGO_FILE } from "./fonts";

const TZ = "America/Phoenix";
const logo = readFileSync(LOGO_FILE);
const rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Primary Bath" }];
const photo = () => sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 150, g: 140, b: 120 } } }).jpeg().toBuffer();

const issue = (id: string, roomId: string, status: ModelSourceIssue["status"], o: Partial<ModelSourceIssue> = {}, kind: IssueKind = "pre_install_correction"): ModelSourceIssue => ({
  id, roomId, kind, status, tradeName: kind === "pre_install_correction" ? "Plumbing" : null, title: `Title ${id}`, description: `Description ${id}`,
  raisedByInitials: "RW", raisedOn: "2026-09-10T18:43:00Z", completedOn: status === "completed" ? "2026-09-11T17:00:00Z" : null, photos: [], ...o,
});
const done: RoomChecklistInfo = { completed: true, outstanding: [], started: true, byWho: "RW", at: "2026-09-10T20:00:00Z" };
const notDone: RoomChecklistInfo = { completed: false, outstanding: ["Finished toes: Toe skins installed after wood floor installation. After 11/5", "Hardware"], started: true, byWho: "RW", at: "2026-09-10T20:15:00Z" };

async function render(issues: ModelSourceIssue[], options: ReportOptions = PRESET_OPTIONS.builder_site_audit, photos: Record<string, Buffer | null> = {}, o: { preparedFor?: string | null; checklist?: Record<string, RoomChecklistInfo> } = {}) {
  const model = buildReportModel({ rooms, issues, checklist: o.checklist ?? { r1: done, r2: notDone } }, options);
  const buf = await renderReport(
    <ReportDocument jobName="Sample Job – Lot 12" preparedFor={o.preparedFor === undefined ? "True Performance" : o.preparedFor} siteAddress="123 Example Street, Sampleville" builtAt="2026-09-12T17:00:00Z" timezone={TZ} model={model} logo={logo} photos={photos} />,
  );
  return pdfParse(buf) as Promise<{ numpages: number; text: string }>;
}

describe("ReportDocument: the builder site audit preset (same look as before)", () => {
  it("cover has the job, prepared-for, address and counts", async () => {
    const r = await render([issue("a", "r1", "open"), issue("b", "r2", "completed")]);
    expect(r.text).toContain("Builder Site Audit");
    expect(r.text).toContain("Sample Job – Lot 12");
    expect(r.text).toContain("Prepared For True Performance");
    expect(r.text).toContain("123 Example Street, Sampleville");
    expect(r.text).toContain("2 Issues Identified");
    expect(r.text).toContain("1 Issue Incomplete");
    expect(r.text).toContain("Raised by: RW 9/10");
  });
  it("uses the singular for one issue", async () => { expect((await render([issue("a", "r1", "open")])).text).toContain("1 Issue Identified"); });
  it("handles no issues", async () => {
    const r = await render([]);
    expect(r.text).toContain("0 Issues Identified");
    expect(r.text).toContain("No Pre-Install Corrections");
  });
  it("omits Prepared For when there is no builder contact", async () => { expect((await render([issue("a", "r1", "open")], PRESET_OPTIONS.builder_site_audit, {}, { preparedFor: null })).text).not.toContain("Prepared For"); });
  it("shows the title when the description is empty", async () => { expect((await render([issue("a", "r1", "open", { description: "", title: "Only a title" })])).text).toContain("Only a title"); });
  it("does not print a kind badge or any row-end numbers on a Pre-Install-only report", async () => {
    const r = await render([issue("a", "r1", "open")]);
    expect(r.text).not.toContain("PRE-INSTALL CORRECTION");
    expect(r.text).not.toMatch(/Open\s*$/m);
  });
  it("adds pages for many photos and numbers them", async () => {
    const p = await photo(); const photos: Record<string, Buffer | null> = {};
    const ps = Array.from({ length: 20 }, (_, i) => { photos[`p${i}`] = p; return { id: `p${i}`, capturedAt: "2026-09-10T18:43:00Z" }; });
    const r = await render([issue("a", "r1", "open", { photos: ps })], PRESET_OPTIONS.builder_site_audit, photos);
    expect(r.numpages).toBeGreaterThan(2);
    expect(r.text).toContain(`Page 2 of ${r.numpages}`);
    expect(r.text).toContain("11:43 9/10/26");
  });
  it("prints a placeholder for a photo that could not be loaded", async () => {
    const r = await render([issue("a", "r1", "open", { photos: [{ id: "x", capturedAt: "2026-09-10T18:43:00Z" }] })], PRESET_OPTIONS.builder_site_audit, { x: null });
    expect(r.text).toContain("Photo unavailable");
  });
  it("does not throw on emoji or a very long room name", async () => {
    const model = buildReportModel({ rooms: [{ id: "z", name: "R".repeat(200) }], issues: [issue("a", "z", "open", { description: "Chipped 😬 door" })], checklist: {} }, PRESET_OPTIONS.builder_site_audit);
    const buf = await renderReport(<ReportDocument jobName="Job 😬" preparedFor={null} siteAddress={null} builtAt="2026-09-12T17:00:00Z" timezone={TZ} model={model} logo={logo} photos={{}} />);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe("ReportDocument: service, status and custom reports", () => {
  const svc = [issue("p", "r1", "completed", {}, "punch_item"), issue("m", "r2", "open", { description: "Missing hinge" }, "missing_part"), issue("d", "r2", "open", { description: "Chipped door" }, "damaged_part")];
  it("lists punch, missing and damaged items per room regardless of room status, with their kind and state", async () => {
    const r = await render(svc, PRESET_OPTIONS.service);
    expect(r.text).toContain("Service Report");
    for (const s of ["Kitchen", "Primary Bath", "PUNCH ITEM", "MISSING PART", "DAMAGED PART", "Missing hinge", "Chipped door"]) expect(r.text, s).toContain(s);
    expect(r.text).toContain("Completed 9/11");
    expect(r.text).toContain("3 Issues Identified");
    expect(r.text).toContain("2 Issues Incomplete");
  });
  it("the status report lists every room's checklist, completed or not, with what is outstanding", async () => {
    const r = await render(svc, PRESET_OPTIONS.room_status);
    expect(r.text).toContain("Room Status");
    expect(r.text).toContain("Completed");
    expect(r.text).toContain("Not completed");
    expect(r.text).toContain("Toe skins installed after wood floor");
    expect(r.text).toContain("1 of 2 Rooms Completed");
    expect(r.text).toContain("Missing hinge");                       // open service items are on the status report too
    expect(r.text).not.toContain("Completed 9/11");                   // the completed punch item is not (open only)
  });
  it("'incomplete rooms only' leaves out completed rooms", async () => {
    const r = await render([], { ...PRESET_OPTIONS.room_status, kinds: [] , checklist: "incomplete" });
    expect(r.text).toContain("Primary Bath");
    expect(r.text).not.toContain("Kitchen");
    expect(r.text).toContain("1 Room Not Completed");
  });
  it("rooms with nothing to list show a plain line when asked for", async () => {
    const r = await render([], { ...PRESET_OPTIONS.service, emptyRooms: true });
    expect(r.text).toContain("Kitchen");
    expect(r.text).toContain("Nothing to list");
  });
  it("says so when the options match nothing", async () => {
    const r = await render([], PRESET_OPTIONS.service);
    expect(r.text).toContain("Nothing to report for the options chosen");
  });
  it("prints which options were chosen, so the reader knows what the report covers", async () => {
    const r = await render(svc, PRESET_OPTIONS.service);
    expect(r.text).toMatch(/Shows:.*Punch Items.*Missing Parts.*Damaged Parts/s);
  });
  it("a custom report with several kinds shows kind badges and works with no photos", async () => {
    const r = await render([issue("a", "r1", "open"), issue("t", "r1", "open", {}, "touch_up")], { ...PRESET_OPTIONS.custom, checklist: "none", photos: "none" });
    expect(r.text).toContain("Project Report");
    expect(r.text).toContain("TOUCH-UP");
    expect(r.text).toContain("PRE-INSTALL CORRECTION");
  });
});

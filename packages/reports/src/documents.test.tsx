import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
// pdf-parse prints debug output when imported from its index; the lib file avoids that
// @ts-expect-error no types for the lib path
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { builderAuditSummary, type ReportIssue } from "@phc/domain";
import { BuilderAuditDocument } from "./BuilderAuditDocument";
import { RoomStatusDocument } from "./RoomStatusDocument";
import { renderReport } from "./render";
import { LOGO_FILE } from "./fonts";

const TZ = "America/Phoenix";
const logo = readFileSync(LOGO_FILE);
const rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Primary Bath" }];
const photo = () => sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 150, g: 140, b: 120 } } }).jpeg().toBuffer();

const issue = (id: string, roomId: string, status: ReportIssue["status"], o: Partial<ReportIssue> = {}): ReportIssue => ({
  id, roomId, kind: "pre_install_correction", status, tradeName: "Plumbing", title: `Title ${id}`, description: `Description ${id}`,
  raisedByInitials: "RW", raisedOn: "2026-09-10T18:43:00Z", photos: [], ...o,
});

async function audit(issues: ReportIssue[], photos: Record<string, Buffer | null> = {}, preparedFor: string | null = "True Performance") {
  const buf = await renderReport(
    <BuilderAuditDocument jobName="Sample Job – Lot 12" preparedFor={preparedFor} siteAddress="123 Example Street, Sampleville" builtAt="2026-09-12T17:00:00Z" timezone={TZ}
      summary={builderAuditSummary(issues, rooms)} logo={logo} photos={photos} />,
  );
  return pdfParse(buf) as Promise<{ numpages: number; text: string }>;
}

describe("BuilderAuditDocument", () => {
  it("cover has the job, prepared-for, address and counts", async () => {
    const r = await audit([issue("a", "r1", "open"), issue("b", "r2", "completed")]);
    expect(r.text).toContain("Sample Job – Lot 12");
    expect(r.text).toContain("Prepared For True Performance");
    expect(r.text).toContain("123 Example Street, Sampleville");
    expect(r.text).toContain("2 Issues Identified");
    expect(r.text).toContain("1 Issue Incomplete");
    expect(r.text).toContain("Raised by: RW 9/10");
  });
  it("uses the singular for one issue", async () => {
    const r = await audit([issue("a", "r1", "open")]);
    expect(r.text).toContain("1 Issue Identified");
  });
  it("handles no issues", async () => {
    const r = await audit([]);
    expect(r.text).toContain("0 Issues Identified");
    expect(r.text).toContain("No Pre-Install Corrections");
  });
  it("omits Prepared For when there is no builder contact", async () => {
    const r = await audit([issue("a", "r1", "open")], {}, null);
    expect(r.text).not.toContain("Prepared For");
  });
  it("shows the title when the description is empty", async () => {
    const r = await audit([issue("a", "r1", "open", { description: "", title: "Only a title" })]);
    expect(r.text).toContain("Only a title");
  });
  it("adds pages for many photos and numbers them", async () => {
    const p = await photo();
    const photos: Record<string, Buffer | null> = {};
    const ps = Array.from({ length: 20 }, (_, i) => { photos[`p${i}`] = p; return { id: `p${i}`, capturedAt: "2026-09-10T18:43:00Z" }; });
    const r = await audit([issue("a", "r1", "open", { photos: ps })], photos);
    expect(r.numpages).toBeGreaterThan(2);
    expect(r.text).toContain(`Page 2 of ${r.numpages}`);
    expect(r.text).toContain("11:43 9/10/26");
  });
  it("prints a placeholder for a photo that could not be loaded", async () => {
    const r = await audit([issue("a", "r1", "open", { photos: [{ id: "x", capturedAt: "2026-09-10T18:43:00Z" }] })], { x: null });
    expect(r.text).toContain("Photo unavailable");
  });
  it("does not throw on emoji or a very long room name", async () => {
    const long = "R".repeat(200);
    const buf = await renderReport(
      <BuilderAuditDocument jobName="Job 😬" preparedFor={null} siteAddress={null} builtAt="2026-09-12T17:00:00Z" timezone={TZ} logo={logo} photos={{}}
        summary={builderAuditSummary([issue("a", "z", "open", { description: "Chipped 😬 door" })], [{ id: "z", name: long }])} />,
    );
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe("RoomStatusDocument", () => {
  it("lists rooms, status, who and when, and open issues", async () => {
    const buf = await renderReport(
      <RoomStatusDocument jobName="Sample Job" preparedFor="True Performance" siteAddress={null} builtAt="2026-09-12T17:00:00Z" timezone={TZ} logo={logo}
        rows={[
          { roomName: "Kitchen", completed: true, byWho: "RW", at: "2026-09-10T18:43:00Z", outstanding: [], openIssues: 0 },
          { roomName: "Primary Bath", completed: false, byWho: null, at: null, outstanding: ["Toe skins: install after floor, after 11/5"], openIssues: 2 },
        ]} />,
    );
    const r = await (pdfParse(buf) as Promise<{ text: string }>);
    expect(r.text).toContain("Kitchen");
    expect(r.text).toContain("Completed");
    expect(r.text).toContain("Not completed");
    expect(r.text).toContain("Toe skins");
  });
});

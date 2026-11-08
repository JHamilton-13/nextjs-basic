// Builds sample reports from FAKE data only (no real builder, address or person) for a visual check.
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { builderAuditSummary, type ReportIssue } from "@phc/domain";
import { BuilderAuditDocument, RoomStatusDocument, renderReport, prepareImage, LOGO_FILE } from "../src";

const out = process.argv[2] ?? "../../docs/testing/images";
const TZ = "America/Phoenix";

const colors = ["#8a7f6a", "#6b7f8a", "#7f6b6b", "#6b8a73"];
async function fakePhoto(i: number): Promise<Buffer> {
  const c = colors[i % colors.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500"><rect width="2000" height="1500" fill="${c}"/><rect x="300" y="300" width="1400" height="900" fill="none" stroke="#fff" stroke-width="12"/><text x="1000" y="800" font-size="120" text-anchor="middle" fill="#fff" font-family="sans-serif">SAMPLE PHOTO ${i + 1}</text></svg>`;
  return prepareImage(await sharp(Buffer.from(svg)).jpeg().toBuffer());
}

const rooms = [{ id: "r1", name: "Kitchen" }, { id: "r2", name: "Primary Bath" }, { id: "r3", name: "Laundry" }];
const mk = (id: string, roomId: string, status: ReportIssue["status"], trade: string, description: string, n: number, extra: Partial<ReportIssue> = {}): ReportIssue => ({
  id, roomId, kind: "pre_install_correction", status, tradeName: trade, title: description.slice(0, 40), description, raisedByInitials: "RW",
  raisedOn: "2026-09-10T18:43:00Z", photos: Array.from({ length: n }, (_, k) => ({ id: `${id}-${k}`, capturedAt: `2026-09-10T${18 + k}:${10 + k * 7}:00Z` })), ...extra,
});
const issues = [
  mk("a", "r1", "open", "Plumbing", "Supply line for the sink is 2 in. left of the cabinet cutout. Needs to be moved before the base cabinets are set.", 2),
  mk("b", "r1", "open", "Electrical", "No outlet rough-in on the island wall. Outlet required by plan.", 1),
  mk("c", "r1", "completed", "Framing", "Wall bowed about 3/4 in. at the pantry. Shim or re-frame so the tall cabinet sits plumb.", 3),
  mk("d", "r2", "open", "Windows", "Window sill is lower than the tub deck. Confirm height with the builder before the surround is ordered.", 2),
  mk("e", "r3", "open", "Drywall", "Hole in the wall behind the washer box.", 0),
];

const photos: Record<string, Buffer | null> = {};
let i = 0;
for (const is of issues) for (const p of is.photos) photos[p.id] = await fakePhoto(i++);
photos["c-2"] = null;                                   // shows the "Photo unavailable" tile

const logo = readFileSync(LOGO_FILE);
const common = { jobName: "Sample Project – Lot 12", preparedFor: "Sample Builder Co.", siteAddress: "123 Example Street, Sampleville, AZ 00000", builtAt: "2026-09-12T17:00:00Z", timezone: TZ, logo };

writeFileSync(`${out}/builder-audit-sample.pdf`, await renderReport(<BuilderAuditDocument {...common} summary={builderAuditSummary(issues, rooms)} photos={photos} />));
writeFileSync(`${out}/room-status-sample.pdf`, await renderReport(
  <RoomStatusDocument {...common} rows={[
    { roomName: "Kitchen", completed: true, byWho: "RW", at: "2026-09-10T18:43:00Z", outstanding: [], openIssues: 2 },
    { roomName: "Primary Bath", completed: false, byWho: "RW", at: "2026-09-10T20:15:00Z", outstanding: ["Toe skins: installed after wood floor installation. After 11/5", "Final clean"], openIssues: 1 },
    { roomName: "Laundry", completed: false, byWho: null, at: null, outstanding: ["Not started"], openIssues: 1 },
  ]} />));
console.log("written to", out);

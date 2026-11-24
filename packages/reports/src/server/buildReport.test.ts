import { describe, it, expect } from "vitest";
import sharp from "sharp";
// @ts-expect-error no types for the lib path
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { PRESET_OPTIONS } from "@phc/domain";
import { FakeDb, FakeStorage } from "./fakes";
import { buildReport, MAX_PDF_BYTES } from "./buildReport";
import { ReportTooLargeError } from "./errors";

const TZ = "America/Phoenix";
const jpeg = (w = 1200, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 130, g: 120, b: 110 } } }).jpeg().toBuffer();
const noisyPng = (w: number, h: number) => sharp(Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 2654435761) % 251)), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

function seed() {
  const db = new FakeDb();
  db.rooms = [{ id: "r1", name: "Kitchen" }];
  db.profiles = [{ id: "u1", full_name: "Rick Wells", email: null }];
  db.issues = [{ id: "a", room_id: "r1", kind: "pre_install_correction", title: "Supply line", description: "Supply line is off", trade_name: "Plumbing", raised_by: "u1", raised_at: "2026-09-10T18:43:00Z", completed_at: null, voided_at: null }];
  db.photos = [
    { id: "ph1", issue_id: "a", storage_path: "p1/a/ph1.jpg", captured_at: "2026-09-10T18:50:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
    { id: "ph2", issue_id: "a", storage_path: "p1/a/ph2.jpg", captured_at: "2026-09-10T18:55:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
  ];
  return db;
}
const deps = (db: FakeDb, storage: FakeStorage) => ({ db, storage, timezone: TZ, now: () => new Date("2026-09-12T17:00:00Z"), newId: () => "00000000-0000-4000-8000-000000000001", logo: Buffer.alloc(0) });

describe("buildReport", () => {
  it("builds the site audit, stores it under <project>/<report>.pdf and records one built report", async () => {
    const db = seed(); const st = new FakeStorage();
    st.files.set("issue-photos/p1/a/ph1.jpg", await jpeg()); st.files.set("issue-photos/p1/a/ph2.jpg", await jpeg(800, 1200));
    const r = await buildReport({ ...deps(db, st), logo: await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer() }, "p1", PRESET_OPTIONS.builder_site_audit);
    expect(r.reportId).toBe("00000000-0000-4000-8000-000000000001");
    expect(st.uploads).toEqual(["p1/00000000-0000-4000-8000-000000000001.pdf"]);
    const row = db.reports.get(r.reportId)!;
    expect(row).toMatchObject({ status: "built", project_id: "p1", report_type: "builder_site_audit", file_size: r.bytes });
    expect(r.bytes).toBeGreaterThan(1000);
    expect(r).toMatchObject({ identified: 1, incomplete: 1, photosMissing: 0 });
    const text = (await pdfParse(st.files.get("reports/" + st.uploads[0]!)!)).text as string;
    expect(text).toContain("1 Issue Identified");
    expect(text).toContain("Supply line is off");
  });
  it("a photo that cannot be downloaded, or is corrupt, becomes a placeholder and the build still succeeds", async () => {
    const db = seed(); const st = new FakeStorage();
    st.files.set("issue-photos/p1/a/ph1.jpg", Buffer.from("not an image"));          // corrupt
    st.failDownload.add("p1/a/ph2.jpg");                                              // cannot be read
    const r = await buildReport({ ...deps(db, st), logo: await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer() }, "p1", PRESET_OPTIONS.builder_site_audit);
    expect(r.photosMissing).toBe(2);
    const text = (await pdfParse(st.files.get("reports/" + st.uploads[0]!)!)).text as string;
    expect(text.match(/Photo unavailable/g)).toHaveLength(2);
  });
  it("a PDF over the limit throws ReportTooLargeError with its size, stores nothing and records nothing", async () => {
    const db = seed(); const st = new FakeStorage();
    st.files.set("issue-photos/p1/a/ph1.jpg", await jpeg()); st.files.set("issue-photos/p1/a/ph2.jpg", await jpeg());
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    await expect(buildReport({ ...deps(db, st), logo, maxBytes: 5000 }, "p1", PRESET_OPTIONS.builder_site_audit)).rejects.toSatisfy((e: unknown) => e instanceof ReportTooLargeError && e.bytes > 5000);
    expect(st.uploads).toEqual([]);
    expect(db.reports.size).toBe(0);
  });
  it("a new build replaces the last preview of that type (row and file) but not a saved report", async () => {
    const db = seed(); const st = new FakeStorage();
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    let n = 0; const d = { ...deps(db, st), logo, newId: () => `00000000-0000-4000-8000-00000000010${++n}` };
    const first = await buildReport(d, "p1", PRESET_OPTIONS.room_status);
    const second = await buildReport(d, "p1", PRESET_OPTIONS.room_status);
    expect([...db.reports.keys()]).toEqual([second.reportId]);
    expect(st.files.has(`reports/p1/${first.reportId}.pdf`)).toBe(false);
    db.reports.get(second.reportId)!.printed_at = "2026-09-12T10:00:00Z";
    const third = await buildReport(d, "p1", PRESET_OPTIONS.room_status);
    expect([...db.reports.keys()].sort()).toEqual([second.reportId, third.reportId].sort());
    expect(st.files.has(`reports/p1/${second.reportId}.pdf`)).toBe(true);
  });
  it("photo mode: marked-up copy OR original, never both; none skips downloads", async () => {
    const db = seed(); const st = new FakeStorage();
    db.photos = [
      { id: "o1", issue_id: "a", storage_path: "p1/a/o1.jpg", captured_at: "2026-09-10T18:50:00Z", confirmed_at: "2026-09-10T19:00:00Z", annotated_from: null },
      { id: "m1", issue_id: "a", storage_path: "p1/a/m1.jpg", captured_at: "2026-09-10T20:00:00Z", confirmed_at: "2026-09-10T20:01:00Z", annotated_from: "o1" },
    ];
    for (const id of ["o1", "m1"]) st.files.set(`issue-photos/p1/a/${id}.jpg`, await jpeg());
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    const downloaded: string[] = []; const orig = st.download.bind(st); st.download = async (b, p) => { downloaded.push(p); return orig(b, p); };
    let n = 0; const d = { ...deps(db, st), logo, newId: () => `00000000-0000-4000-8000-00000000020${++n}` };
    await buildReport(d, "p1", { ...PRESET_OPTIONS.builder_site_audit, photos: "annotated" });
    expect(downloaded).toEqual(["p1/a/m1.jpg"]);
    downloaded.length = 0;
    await buildReport(d, "p1", { ...PRESET_OPTIONS.builder_site_audit, photos: "original" });
    expect(downloaded).toEqual(["p1/a/o1.jpg"]);
    downloaded.length = 0;
    await buildReport(d, "p1", { ...PRESET_OPTIONS.builder_site_audit, photos: "none" });
    expect(downloaded).toEqual([]);
  });
  it("a service report prints the service items and has its own type", async () => {
    const db = seed(); const st = new FakeStorage();
    db.issues.push({ id: "s", room_id: "r1", kind: "damaged_part", title: "Chipped door", description: "Chipped door front", trade_name: null, raised_by: "u1", raised_at: "2026-09-10T18:43:00Z", completed_at: null, voided_at: null });
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    const r = await buildReport({ ...deps(db, st), logo }, "p1", PRESET_OPTIONS.service);
    expect(db.reports.get(r.reportId)!.report_type).toBe("service");
    const text = (await pdfParse(st.files.get("reports/" + st.uploads[0]!)!)).text as string;
    expect(text).toContain("Service Report");
    expect(text).toContain("Chipped door front");
    expect(text).not.toContain("Supply line is off");                       // the Pre-Install item is not on a service report
  });
  it("the limit is 18 MB", () => { expect(MAX_PDF_BYTES).toBe(18 * 1024 * 1024); });
  it("builds a status PDF without touching photos", async () => {
    const db = seed(); const st = new FakeStorage();
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    const r = await buildReport({ ...deps(db, st), logo }, "p1", PRESET_OPTIONS.room_status);
    expect(db.reports.get(r.reportId)).toMatchObject({ report_type: "room_status", status: "built" });
    const text = (await pdfParse(st.files.get("reports/" + st.uploads[0]!)!)).text as string;
    expect(text).toContain("Kitchen");
    expect(text).toContain("Not completed");
    expect(text).toContain("Room Status");
  });
  it("a job with no Pre-Install Corrections still builds a valid audit", async () => {
    const db = seed(); db.issues = []; const st = new FakeStorage();
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    const r = await buildReport({ ...deps(db, st), logo }, "p1", PRESET_OPTIONS.builder_site_audit);
    expect(r).toMatchObject({ identified: 0, incomplete: 0 });
  });
  it("when recording the report fails after the upload, the error is reported (the stored file is harmless and unreferenced)", async () => {
    const db = seed(); db.failCreate = true; const st = new FakeStorage();
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    await expect(buildReport({ ...deps(db, st), logo }, "p1", PRESET_OPTIONS.room_status)).rejects.toMatchObject({ code: "db_error" });
  });
  it("shrinks big photos before they go in (a 4000 px photo does not make the PDF huge)", async () => {
    const db = seed(); const st = new FakeStorage();
    st.files.set("issue-photos/p1/a/ph1.jpg", await sharp(await noisyPng(1800, 1200)).jpeg({ quality: 95 }).toBuffer());
    st.files.set("issue-photos/p1/a/ph2.jpg", await jpeg());
    const logo = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#000" } }).png().toBuffer();
    const r = await buildReport({ ...deps(db, st), logo }, "p1", PRESET_OPTIONS.builder_site_audit);
    expect(r.bytes).toBeLessThan(2 * 1024 * 1024);
  });
});

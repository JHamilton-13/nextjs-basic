import { describe, it, expect } from "vitest";
import { FakeDb, FakeStorage } from "./fakes";
import { cleanupReports } from "./cleanup";
import { ReportError } from "./errors";

const P = "p1";
async function mk(db: FakeDb, storage: FakeStorage, id: string, type: "builder_site_audit" | "room_status" = "builder_site_audit") {
  await db.createReport({ id, projectId: P, type, path: `${P}/${id}.pdf`, bytes: 10 });
  storage.files.set(`reports/${P}/${id}.pdf`, Buffer.from("%PDF " + id));
}

describe("cleanupReports (keeps only the latest sent or printed report per type)", () => {
  it("removes the replaced reports' rows AND their files", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "old"); await mk(db, st, "new");
    await db.markReportPrinted("old"); db.reports.get("old")!.printed_at = "2026-09-01T10:00:00Z";
    await db.markReportPrinted("new"); db.reports.get("new")!.printed_at = "2026-09-02T10:00:00Z";
    const r = await cleanupReports({ db, storage: st }, P, "builder_site_audit", "new");
    expect(r).toEqual({ removedReports: 1, removedFiles: 1, failedFiles: 0 });
    expect([...db.reports.keys()]).toEqual(["new"]);
    expect([...st.files.keys()]).toEqual([`reports/${P}/new.pdf`]);
  });
  it("sweeps files that no report row points to (left over from an earlier failure)", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "keep");
    st.files.set(`reports/${P}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`, Buffer.from("x"));
    st.files.set(`reports/${P}/notes.txt`, Buffer.from("x"));
    const r = await cleanupReports({ db, storage: st }, P, "builder_site_audit", "keep");
    expect(r.removedFiles).toBe(1);
    expect(st.files.has(`reports/${P}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`)).toBe(false);
    expect(st.files.has(`reports/${P}/notes.txt`)).toBe(true);          // only .pdf files named like a report are ours to remove
    expect(st.files.has(`reports/${P}/keep.pdf`)).toBe(true);
  });
  it("leaves a file under 10 minutes old alone (another build may still be recording it)", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "keep");
    const fresh = `reports/${P}/ffffffff-ffff-4fff-8fff-ffffffffffff.pdf`;
    st.files.set(fresh, Buffer.from("x")); st.createdAt.set(fresh, new Date(Date.now() - 2 * 60_000).toISOString());
    const r = await cleanupReports({ db, storage: st }, P, "builder_site_audit", "keep");
    expect(r.removedFiles).toBe(0);
    expect(st.files.has(fresh)).toBe(true);
  });
  it("never sweeps a file whose row exists, even for the other type", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "audit"); await mk(db, st, "status", "room_status");
    await cleanupReports({ db, storage: st }, P, "builder_site_audit", "audit");
    expect(st.files.size).toBe(2);
  });
  it("counts files it could not remove and carries on", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "a"); await mk(db, st, "b");
    st.failRemove = true;
    const r = await cleanupReports({ db, storage: st }, P, "builder_site_audit", "b");
    expect(r.removedReports).toBe(1);
    expect(r.failedFiles).toBe(1);
    expect(r.removedFiles).toBe(0);
  });
  it("throws when the database refuses (so the caller can decide), never half-deletes files", async () => {
    const db = new FakeDb(); const st = new FakeStorage();
    await mk(db, st, "a");
    db.pruneReports = async () => { throw new ReportError("forbidden", "forbidden"); };
    await expect(cleanupReports({ db, storage: st }, P, "builder_site_audit", "a")).rejects.toMatchObject({ code: "forbidden" });
    expect(st.files.size).toBe(1);
  });
});

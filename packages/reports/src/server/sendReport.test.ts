import { describe, it, expect } from "vitest";
import { FakeDb, FakeStorage } from "./fakes";
import { fakeTransport } from "./transport";
import { checkColleagueAddresses, sendReport, sendTestReport, shareReport } from "./sendReport";

async function setup(type: "builder_site_audit" | "room_status" = "builder_site_audit") {
  const db = new FakeDb(); const storage = new FakeStorage();
  const r = await db.createReport({ id: "r1", projectId: "p1", type, path: "p1/r1.pdf", bytes: 100 });
  storage.files.set("reports/p1/r1.pdf", Buffer.from("%PDF-1.4 sample"));
  const transport = fakeTransport();
  const deps = { db, storage, transport, from: "Reports <sender@example.test>", timezone: "America/Phoenix", now: () => new Date("2026-09-12T17:00:00Z") };
  return { db, storage, transport, deps, r };
}
const to = { name: "Sample Builder", email: "builder@example.test" };

describe("sendReport", () => {
  it("sends exactly one email and marks the report sent", async () => {
    const { db, transport, deps } = await setup();
    expect(await sendReport(deps, "r1", to)).toBe("sent");
    expect(transport.sent).toHaveLength(1);
    const m = transport.sent[0]!;
    expect(m.to).toBe("builder@example.test");
    expect(m.from).toBe("Reports <sender@example.test>");
    expect(m.subject).toContain("Sample Project");
    expect(m.attachment.filename).toBe("Sample Project Site Audit 2026-09-12.pdf");
    expect(m.attachment.content.toString()).toBe("%PDF-1.4 sample");
    expect(db.reports.get("r1")).toMatchObject({ status: "sent", message_id: transport.sent[0] ? expect.stringMatching(/^fake-/) : "", recipient_email: "builder@example.test" });
  });
  it("two simultaneous sends email once; the second is told report_already_queued", async () => {
    const { transport, deps } = await setup();
    const results = await Promise.allSettled([sendReport(deps, "r1", to), sendReport(deps, "r1", to)]);
    expect(transport.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "report_already_queued" });
  });
  it("a send after it was sent is refused and sends nothing", async () => {
    const { transport, deps } = await setup();
    await sendReport(deps, "r1", to);
    await expect(sendReport(deps, "r1", to)).rejects.toMatchObject({ code: "report_already_sent" });
    expect(transport.sent).toHaveLength(1);
  });
  it("a transport failure leaves the report failed with the error, and a retry then sends", async () => {
    const { db, deps } = await setup();
    const bad = fakeTransport({ failWith: "smtp down" });
    await expect(sendReport({ ...deps, transport: bad }, "r1", to)).rejects.toMatchObject({ code: "send_failed" });
    expect(db.reports.get("r1")).toMatchObject({ status: "failed", error: expect.stringContaining("smtp down") });
    const good = fakeTransport();
    expect(await sendReport({ ...deps, transport: good }, "r1", to)).toBe("sent");
    expect(good.sent).toHaveLength(1);
  });
  it("a report stuck in queued for more than 10 minutes can be retried; before that it cannot", async () => {
    const { db, transport, deps } = await setup();
    await db.queueReportSend("r1", null, "builder@example.test");                  // a crashed earlier attempt
    await expect(sendReport(deps, "r1", to)).rejects.toMatchObject({ code: "report_already_queued" });
    db.reports.get("r1")!.queued_at = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(await sendReport(deps, "r1", to)).toBe("sent");
    expect(transport.sent).toHaveLength(1);
  });
  it("an invalid recipient is rejected before anything is queued", async () => {
    const { db, transport, deps } = await setup();
    for (const email of ["nope", "a@b", "a@b.com\nBcc: x@y.com", ""]) {
      await expect(sendReport(deps, "r1", { name: "X", email })).rejects.toMatchObject({ code: "invalid_recipient" });
    }
    expect(db.reports.get("r1")!.status).toBe("built");
    expect(transport.sent).toHaveLength(0);
  });
  it("a missing PDF file marks the report failed instead of sending an empty email", async () => {
    const { db, storage, transport, deps } = await setup();
    storage.files.clear();
    await expect(sendReport(deps, "r1", to)).rejects.toMatchObject({ code: "pdf_missing" });
    expect(db.reports.get("r1")!.status).toBe("failed");
    expect(transport.sent).toHaveLength(0);
  });
  it("an unknown report is forbidden, nothing sent", async () => {
    const { transport, deps } = await setup();
    await expect(sendReport(deps, "nope", to)).rejects.toMatchObject({ code: "report_not_found" });
    expect(transport.sent).toHaveLength(0);
  });
  it("if the email went out but recording it failed, the error says to check the Sent folder (report stays queued, no auto resend)", async () => {
    const { db, transport, deps } = await setup();
    db.markReportSent = async () => { throw new Error("db down"); };
    await expect(sendReport(deps, "r1", to)).rejects.toMatchObject({ code: "sent_not_recorded", message: expect.stringContaining("Sent folder") });
    expect(transport.sent).toHaveLength(1);
    expect(db.reports.get("r1")!.status).toBe("queued");
  });
  it("names a status report differently", async () => {
    const { transport, deps } = await setup("room_status");
    await sendReport(deps, "r1", to);
    expect(transport.sent[0]!.attachment.filename).toBe("Sample Project Room Status 2026-09-12.pdf");
  });
});

describe("after a send", () => {
  it("the previously saved report of that type is removed with its file; a failed clean-up never fails the send", async () => {
    const { db, storage, transport, deps } = await setup();
    await db.createReport({ id: "older", projectId: "p1", type: "builder_site_audit", path: "p1/older.pdf", bytes: 10 });
    storage.files.set("reports/p1/older.pdf", Buffer.from("%PDF old"));
    db.reports.get("older")!.status = "sent"; db.reports.get("older")!.sent_at = "2026-09-01T10:00:00Z";
    await sendReport(deps, "r1", to);
    expect([...db.reports.keys()]).toEqual(["r1"]);
    expect(storage.files.has("reports/p1/older.pdf")).toBe(false);
    expect(transport.sent).toHaveLength(1);
  });
  it("a clean-up failure is swallowed", async () => {
    const { db, deps } = await setup();
    db.pruneReports = async () => { throw new Error("db down"); };
    expect(await sendReport(deps, "r1", to)).toBe("sent");
  });
});

describe("sendTestReport", () => {
  it("sends only to the manager, labelled as a test, and leaves the status built", async () => {
    const { db, transport, deps } = await setup();
    await sendTestReport(deps, "r1", "manager@example.test");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe("manager@example.test");
    expect(transport.sent[0]!.subject).toMatch(/^TEST/);
    expect(db.reports.get("r1")!.status).toBe("built");
    await sendReport(deps, "r1", to);                                     // a test does not use up the real send
    expect(transport.sent).toHaveLength(2);
  });
  it("rejects a bad manager address and a missing report", async () => {
    const { transport, deps } = await setup();
    await expect(sendTestReport(deps, "r1", "bad")).rejects.toMatchObject({ code: "invalid_recipient" });
    await expect(sendTestReport(deps, "zzz", "m@example.test")).rejects.toMatchObject({ code: "report_not_found" });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("checkColleagueAddresses", () => {
  it("accepts addresses on the domain (any case), de-duplicates, trims", () => {
    expect(checkColleagueAddresses([" A@Phc.Example ", "b@phc.example", "A@Phc.Example"], "@PHC.example")).toEqual({ ok: true, emails: ["A@Phc.Example", "b@phc.example"] });
  });
  it("refuses other domains (including look-alikes and sub-domains), bad addresses, none and too many", () => {
    for (const bad of ["x@gmail.example", "x@phc.example.evil.test", "x@notphc.example", "x@sub.phc.example", "no-at-sign", "a b@phc.example", "x@phc.example\nBcc: y@z.test"]) {
      expect(checkColleagueAddresses([bad], "phc.example").ok, bad).toBe(false);
    }
    expect(checkColleagueAddresses([], "phc.example")).toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(checkColleagueAddresses(Array.from({ length: 11 }, (_, i) => `u${i}@phc.example`), "phc.example")).toMatchObject({ ok: false, code: "too_many_recipients" });
  });
});

describe("shareReport", () => {
  const share = async () => { const s = await setup(); return { ...s, sdeps: { ...s.deps, phcDomain: "phc.example" } }; };
  it("sends one copy to each colleague, records them, and leaves the builder send untouched", async () => {
    const { db, transport, sdeps } = await share();
    const r = await shareReport(sdeps, "r1", ["a@phc.example", "b@phc.example"], "manager@phc.example");
    expect(r.sentTo).toEqual(["a@phc.example", "b@phc.example"]);
    expect(transport.sent.map((m) => m.to)).toEqual(["a@phc.example", "b@phc.example"]);
    expect(transport.sent[0]!.text).toContain("manager@phc.example shared");
    expect(transport.sent[0]!.text).toContain("not for the builder");
    expect(db.reports.get("r1")).toMatchObject({ status: "built", shared_to: ["a@phc.example", "b@phc.example"] });
    expect(await sendReport(sdeps, "r1", to)).toBe("sent");                       // the builder can still be sent the same report, once
  });
  it("can be repeated any number of times", async () => {
    const { transport, sdeps } = await share();
    await shareReport(sdeps, "r1", ["a@phc.example"], null); await shareReport(sdeps, "r1", ["a@phc.example"], null);
    expect(transport.sent).toHaveLength(2);
  });
  it("a non-PHC address stops everything before anything is sent", async () => {
    const { transport, db, sdeps } = await share();
    await expect(shareReport(sdeps, "r1", ["a@phc.example", "builder@example.test"], null)).rejects.toMatchObject({ code: "recipient_not_phc" });
    expect(transport.sent).toHaveLength(0);
    expect(db.reports.get("r1")!.shared_at).toBeNull();
  });
  it("when some fail, the ones that were reached are recorded and the error names the rest", async () => {
    const { db, sdeps } = await share();
    let n = 0;
    const flaky = { sent: [] as never[], async send(m: { to: string }) { if (m.to.startsWith("bad")) throw new Error("rejected"); n++; return { messageId: `x${n}` }; } };
    await expect(shareReport({ ...sdeps, transport: flaky as never }, "r1", ["a@phc.example", "bad@phc.example"], null)).rejects.toMatchObject({ code: "share_failed", message: expect.stringContaining("bad@phc.example") });
    expect(db.reports.get("r1")!.shared_to).toEqual(["a@phc.example"]);
  });
  it("refuses a report whose builder send is in flight, and a missing PDF", async () => {
    const { db, storage, sdeps } = await share();
    await db.queueReportSend("r1", null, "builder@example.test");
    await expect(shareReport(sdeps, "r1", ["a@phc.example"], null)).rejects.toMatchObject({ code: "report_already_queued" });
    db.reports.get("r1")!.status = "built"; storage.files.clear();
    await expect(shareReport(sdeps, "r1", ["a@phc.example"], null)).rejects.toMatchObject({ code: "pdf_missing" });
  });
  it("sharing makes this the saved report and removes the older saved one of its type", async () => {
    const { db, storage, sdeps } = await share();
    await db.createReport({ id: "older", projectId: "p1", type: "builder_site_audit", path: "p1/older.pdf", bytes: 10 });
    storage.files.set("reports/p1/older.pdf", Buffer.from("x")); db.reports.get("older")!.printed_at = "2026-09-01T10:00:00Z";
    await shareReport(sdeps, "r1", ["a@phc.example"], null);
    expect([...db.reports.keys()]).toEqual(["r1"]);
    expect(storage.files.has("reports/p1/older.pdf")).toBe(false);
  });
});

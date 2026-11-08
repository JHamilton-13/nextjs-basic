import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { FakeDb, FakeStorage } from "./fakes";
import { fakeTransport } from "./transport";
import { ReportTooLargeError } from "./errors";
import { handleReportsRequest, type HandlerContext } from "./handler";

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";

async function ctx(over: Partial<HandlerContext> = {}) {
  const db = new FakeDb(); db.project = { id: P, name: "Sample Project", address: null, prepared_for_name: "Sample Builder", prepared_for_email: "builder@example.test" };
  db.rooms = [{ id: "r1", name: "Kitchen" }];
  const storage = new FakeStorage(); const transport = fakeTransport();
  const c: HandlerContext = {
    getUser: async (t) => (t === "good" ? { id: "u1", email: "manager@example.test" } : null),
    makeDeps: () => ({ db, storage }), transport: () => transport, env: { REPORT_FROM: "Reports <sender@example.test>" },
    logo: await sharp({ create: { width: 10, height: 10, channels: 4, background: "#000" } }).png().toBuffer(), ...over,
  };
  return { c, db, storage, transport };
}
const post = (body: unknown, auth: string | undefined = "Bearer good") => ({ method: "POST", authorization: auth, body });

describe("reports api", () => {
  it("refuses anything but POST, and a missing or wrong token", async () => {
    const { c } = await ctx();
    expect((await handleReportsRequest({ method: "GET", authorization: "Bearer good", body: {} }, c)).status).toBe(405);
    expect((await handleReportsRequest(post({ action: "build" }, ""), c)).status).toBe(401);
    expect((await handleReportsRequest(post({ action: "build" }, "Bearer wrong"), c)).status).toBe(401);
    expect((await handleReportsRequest(post({ action: "build" }, "Basic abc"), c)).status).toBe(401);
  });
  it("rejects unknown actions and malformed ids before touching anything", async () => {
    const { c, db, storage } = await ctx();
    expect((await handleReportsRequest(post({ action: "delete" }), c)).status).toBe(400);
    expect((await handleReportsRequest(post({ action: "build", projectId: "x'; drop", type: "room_status" }), c)).status).toBe(400);
    expect((await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "weekly" } }), c)).status).toBe(400);
    expect((await handleReportsRequest(post({ action: "send", reportId: "nope" }), c)).status).toBe(400);
    expect((await handleReportsRequest(post(null), c)).status).toBe(400);
    expect(db.reports.size + storage.uploads.length).toBe(0);
  });
  it("rejects options that make no sense, with the reason", async () => {
    const { c, db } = await ctx();
    const none = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "custom", kinds: [], checklist: "none" } }), c);
    expect(none).toMatchObject({ status: 422, json: { error: "nothing_selected" } });
    const both = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "custom", photos: "both" } }), c);
    expect(both).toMatchObject({ status: 400, json: { error: "bad_options" } });
    expect((await handleReportsRequest(post({ action: "build", projectId: P }), c)).status).toBe(400);
    expect(db.reports.size).toBe(0);
  });
  it("builds a service report from options", async () => {
    const { c, db } = await ctx();
    const r = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "service", issueStatus: "open", photos: "none", emptyRooms: true } }), c);
    expect(r.status).toBe(200);
    expect([...db.reports.values()][0]).toMatchObject({ report_type: "service" });
  });
  it("builds a report", async () => {
    const { c, db } = await ctx();
    const r = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "room_status" } }), c);
    expect(r.status).toBe(200);
    expect(db.reports.size).toBe(1);
    expect(r.json).toMatchObject({ bytes: expect.any(Number), reportId: expect.any(String) });
  });
  it("reports a too-large PDF as 413 with its size", async () => {
    const { c, db, storage } = await ctx();
    const boom = Object.assign(Object.create(db), { listRooms: async () => { throw new ReportTooLargeError(20_000_000, 18 * 1024 * 1024); } });
    const r = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "room_status" } }), { ...c, makeDeps: () => ({ db: boom, storage }) });
    expect(r).toMatchObject({ status: 413, json: { error: "report_too_large", bytes: 20_000_000, limit: 18 * 1024 * 1024 } });
  });
  it("sends to the builder contact saved on the job, never to an address from the browser", async () => {
    const { c, db, transport } = await ctx();
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    const storage = c.makeDeps("good").storage as unknown as FakeStorage;
    storage.files.set(`reports/${P}/${R}.pdf`, Buffer.from("%PDF"));
    const r = await handleReportsRequest(post({ action: "send", reportId: R, to: "attacker@example.test" }), c);
    expect(r).toMatchObject({ status: 200, json: { status: "sent", to: "builder@example.test" } });
    expect(transport.sent.map((m) => m.to)).toEqual(["builder@example.test"]);
    const again = await handleReportsRequest(post({ action: "send", reportId: R }), c);
    expect(again).toMatchObject({ status: 409, json: { error: "report_already_sent" } });
    expect(transport.sent).toHaveLength(1);
  });
  it("records a print, then keeps only the newest saved report of that type", async () => {
    const { c, db } = await ctx();
    const old = "33333333-3333-4333-8333-333333333333";
    await db.createReport({ id: old, projectId: P, type: "builder_site_audit", path: `${P}/${old}.pdf`, bytes: 10 });
    db.reports.get(old)!.sent_at = "2026-09-01T10:00:00Z"; db.reports.get(old)!.status = "sent";
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    const r = await handleReportsRequest(post({ action: "print", reportId: R }), c);
    expect(r).toMatchObject({ status: 200, json: { status: "printed" } });
    expect(db.reports.get(R)!.printed_at).toBeTruthy();
    expect(db.reports.has(old)).toBe(false);
  });
  it("print needs a valid report id and a manager", async () => {
    const { c } = await ctx();
    expect((await handleReportsRequest(post({ action: "print", reportId: "nope" }), c)).status).toBe(400);
    expect((await handleReportsRequest(post({ action: "print", reportId: R }), c)).status).toBe(404);
  });
  it("shares with colleagues on the PHC domain only, one copy each, and keeps the report as the saved one", async () => {
    const { c, db, transport } = await ctx({ env: { REPORT_FROM: "Reports <sender@example.test>", PHC_EMAIL_DOMAIN: "phc.example" } });
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    (c.makeDeps("good").storage as unknown as FakeStorage).files.set(`reports/${P}/${R}.pdf`, Buffer.from("%PDF"));
    const bad = await handleReportsRequest(post({ action: "share", reportId: R, recipients: ["builder@example.test"] }), c);
    expect(bad).toMatchObject({ status: 422, json: { error: "recipient_not_phc" } });
    expect(transport.sent).toHaveLength(0);
    const ok = await handleReportsRequest(post({ action: "share", reportId: R, recipients: ["a@phc.example", "B@PHC.example", "a@phc.example"] }), c);
    expect(ok).toMatchObject({ status: 200, json: { status: "shared", to: ["a@phc.example", "B@PHC.example"] } });
    expect(transport.sent.map((m) => m.to)).toEqual(["a@phc.example", "B@PHC.example"]);
    expect(db.reports.get(R)!.shared_at).toBeTruthy();
    expect(db.reports.get(R)!.status).toBe("built");                                   // sharing does not use up the builder's once-only send
    const again = await handleReportsRequest(post({ action: "share", reportId: R, recipients: ["a@phc.example"] }), c);
    expect(again.status).toBe(200);
  });
  it("says plainly when PHC_EMAIL_DOMAIN is not set", async () => {
    const { c, db } = await ctx();
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    const r = await handleReportsRequest(post({ action: "share", reportId: R, recipients: ["a@phc.example"] }), c);
    expect(r).toMatchObject({ status: 500, json: { error: "not_configured" } });
    expect(String(r.json.message)).toContain("PHC_EMAIL_DOMAIN");
  });
  it("will not send without a valid builder email on the job", async () => {
    const { c, db, transport } = await ctx();
    db.project!.prepared_for_email = null;
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    const r = await handleReportsRequest(post({ action: "send", reportId: R }), c);
    expect(r).toMatchObject({ status: 422, json: { error: "no_recipient" } });
    expect(transport.sent).toHaveLength(0);
    expect(db.reports.get(R)!.status).toBe("built");
  });
  it("says so plainly when REPORT_FROM is not set, and sends nothing", async () => {
    const { c, db, transport } = await ctx({ env: {} });
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    const r = await handleReportsRequest(post({ action: "send", reportId: R }), c);
    expect(r).toMatchObject({ status: 500, json: { error: "not_configured" } });
    expect(String(r.json.message)).toContain("REPORT_FROM");
    expect(transport.sent).toHaveLength(0);
  });
  it("sends a test copy to the signed-in manager only", async () => {
    const { c, db, transport } = await ctx();
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    (c.makeDeps("good").storage as unknown as FakeStorage).files.set(`reports/${P}/${R}.pdf`, Buffer.from("%PDF"));
    const r = await handleReportsRequest(post({ action: "sendTest", reportId: R, to: "attacker@example.test" }), c);
    expect(r).toMatchObject({ status: 200, json: { to: "manager@example.test" } });
    expect(transport.sent.map((m) => m.to)).toEqual(["manager@example.test"]);
    expect(db.reports.get(R)!.status).toBe("built");
  });
  it("maps a send failure to 502 and keeps the error message free of secrets", async () => {
    const { c, db } = await ctx({ transport: () => fakeTransport({ failWith: "Gmail refused the message (403): Quota exceeded" }) });
    await db.createReport({ id: R, projectId: P, type: "builder_site_audit", path: `${P}/${R}.pdf`, bytes: 10 });
    (c.makeDeps("good").storage as unknown as FakeStorage).files.set(`reports/${P}/${R}.pdf`, Buffer.from("%PDF"));
    const r = await handleReportsRequest(post({ action: "send", reportId: R }), c);
    expect(r.status).toBe(502);
    expect(db.reports.get(R)!.status).toBe("failed");
  });
  it("an unexpected error is a generic 500 that does not leak details", async () => {
    const { c } = await ctx({ makeDeps: () => { throw new Error("secret-ish internal detail"); } });
    const r = await handleReportsRequest(post({ action: "build", projectId: P, options: { preset: "room_status" } }), c);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("secret-ish");
  });
});

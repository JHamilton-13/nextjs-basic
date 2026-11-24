import { describe, it, expect } from "vitest";
import { PRESET_OPTIONS } from "@phc/domain";
import { callReportsApi, canManageReports, describeReportProblem, reportStatusLabel, savedLabel, stuckQueued } from "../src/lib/reportsApi";

const P = "p1";
describe("canManageReports (who sees the manager screens)", () => {
  it("is true for admin and the three managers on that project, false for everyone else", () => {
    expect(canManageReports({ isAdmin: true, byProject: {} }, P)).toBe(true);
    for (const role of ["production_manager", "project_manager", "installation_manager"]) expect(canManageReports({ isAdmin: false, byProject: { [P]: role } }, P), role).toBe(true);
    for (const role of ["installer", "warehouse", "general_contractor", "client", "shop"]) expect(canManageReports({ isAdmin: false, byProject: { [P]: role } }, P), role).toBe(false);
  });
  it("only for the project where the role is held, and false with no roles yet", () => {
    expect(canManageReports({ isAdmin: false, byProject: { other: "project_manager" } }, P)).toBe(false);
    expect(canManageReports(undefined, P)).toBe(false);
  });
});

describe("callReportsApi", () => {
  const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("posts JSON with the signed-in token and returns the data", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ reportId: "r1", bytes: 10 }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await callReportsApi(f, "TOKEN", { action: "build", projectId: P, options: PRESET_OPTIONS.room_status });
    expect(r).toEqual({ ok: true, data: { reportId: "r1", bytes: 10 } });
    expect(seen!.url).toBe("/api/reports");
    expect(seen!.init.method).toBe("POST");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ action: "build", projectId: P, options: PRESET_OPTIONS.room_status });
  });
  it("returns the server's error code and message", async () => {
    expect(await callReportsApi(res(409, { error: "report_already_sent", message: "x" }), "t", { action: "send", reportId: "r" })).toMatchObject({ ok: false, status: 409, code: "report_already_sent" });
  });
  it("turns a network failure and a non-JSON page into plain errors", async () => {
    const down = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await callReportsApi(down, "t", { action: "send", reportId: "r" })).toMatchObject({ ok: false, code: "network" });
    const html = (async () => new Response("<html>Bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    expect(await callReportsApi(html, "t", { action: "send", reportId: "r" })).toMatchObject({ ok: false, status: 502, code: "server_error" });
  });
});

describe("describeReportProblem (plain words for managers)", () => {
  it("covers every code the server can return", () => {
    for (const c of ["not_signed_in", "forbidden", "project_not_found", "report_not_found", "report_already_queued", "report_already_sent", "invalid_recipient", "no_recipient", "report_too_large", "not_configured", "pdf_missing", "send_failed", "sent_not_recorded", "network", "server_error", "db_error", "upload_failed", "recipient_not_phc", "too_many_recipients", "bad_options", "nothing_selected", "share_failed"]) {
      expect(describeReportProblem({ code: c, message: "m" }).length, c).toBeGreaterThan(10);
    }
  });
  it("shows the size when a report is too large", () => {
    expect(describeReportProblem({ code: "report_too_large", message: "m", bytes: 20 * 1024 * 1024 })).toMatch(/20\.0 MB/);
  });
  it("falls back to the server's message for an unknown code", () => {
    expect(describeReportProblem({ code: "weird", message: "Something odd" })).toBe("Something odd");
  });
  it("sent_not_recorded tells the manager to check the Sent folder", () => {
    expect(describeReportProblem({ code: "sent_not_recorded", message: "" })).toMatch(/Sent folder/);
  });
});

describe("report status", () => {
  it("has plain labels", () => {
    expect([reportStatusLabel("built"), reportStatusLabel("queued"), reportStatusLabel("sent"), reportStatusLabel("failed")]).toEqual(["Ready to send", "Sending…", "Sent", "Failed"]);
  });
  it("a queued report is stuck after 10 minutes", () => {
    const now = Date.parse("2026-09-12T12:00:00Z");
    expect(stuckQueued({ status: "queued", queued_at: "2026-09-12T11:55:00Z" }, now)).toBe(false);
    expect(stuckQueued({ status: "queued", queued_at: "2026-09-12T11:49:00Z" }, now)).toBe(true);
    expect(stuckQueued({ status: "sent", queued_at: "2026-09-12T11:00:00Z" }, now)).toBe(false);
    expect(stuckQueued({ status: "queued", queued_at: null }, now)).toBe(true);
  });
});

describe("savedLabel", () => {
  it("only emailed or printed reports count as saved", () => {
    expect(savedLabel({ status: "built", sent_at: null, printed_at: null })).toBe("preview");
    expect(savedLabel({ status: "failed", sent_at: null, printed_at: null })).toBe("preview");
    expect(savedLabel({ status: "sent", sent_at: "2026-09-01T10:00:00Z", printed_at: null })).toBe("sent");
    expect(savedLabel({ status: "built", sent_at: null, printed_at: "2026-09-01T10:00:00Z" })).toBe("printed");
    expect(savedLabel({ status: "sent", sent_at: "2026-09-01T10:00:00Z", printed_at: "2026-09-01T11:00:00Z" })).toBe("sent and printed");
    expect(savedLabel({ status: "built", sent_at: null, printed_at: null, shared_at: "2026-09-01T10:00:00Z" })).toBe("shared");
  });
});

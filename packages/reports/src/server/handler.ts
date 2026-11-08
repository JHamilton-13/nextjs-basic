import { isValidEmail } from "@phc/domain";
import { buildReport, type BuildDeps } from "./buildReport";
import { ReportError, ReportTooLargeError } from "./errors";
import type { ReportDb, ReportStorage } from "./ports";
import { printReport, sendReport, sendTestReport } from "./sendReport";
import type { EmailTransport } from "./transport";

export interface ApiRequest { method: string; authorization: string | undefined; body: unknown }
export interface ApiResponse { status: number; json: Record<string, unknown> }

export interface HandlerContext {
  /** Checks the access token with Supabase and returns who it belongs to. */
  getUser(token: string): Promise<{ id: string; email: string | null } | null>;
  /** Database and storage acting as that user (their own session; row-level security applies). */
  makeDeps(token: string): { db: ReportDb; storage: ReportStorage };
  transport(): EmailTransport;
  env: { REPORT_FROM?: string; REPORT_TIMEZONE?: string };
  logo?: Buffer;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  forbidden: 403, project_not_found: 404, report_not_found: 404, report_already_queued: 409, report_already_sent: 409, report_not_queued: 409,
  invalid_recipient: 422, no_recipient: 422, report_too_large: 413, not_configured: 500, pdf_missing: 409,
};
const bad = (status: number, code: string, message: string): ApiResponse => ({ status, json: { error: code, message } });

/** One endpoint, four actions: build, print, send, sendTest. The route file only wires real Supabase and Gmail into this. */
export async function handleReportsRequest(req: ApiRequest, ctx: HandlerContext): Promise<ApiResponse> {
  if (req.method !== "POST") return bad(405, "method_not_allowed", "Use POST.");
  const m = /^Bearer (.+)$/.exec(req.authorization ?? "");
  if (!m) return bad(401, "not_signed_in", "Sign in again.");
  const token = m[1]!;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const action = body.action;
  if (action !== "build" && action !== "send" && action !== "sendTest" && action !== "print") return bad(400, "bad_request", "Unknown action.");

  try {
    const user = await ctx.getUser(token);
    if (!user) return bad(401, "not_signed_in", "Sign in again.");
    const { db, storage } = ctx.makeDeps(token);
    const timezone = ctx.env.REPORT_TIMEZONE || "America/Phoenix";

    if (action === "build") {
      const projectId = String(body.projectId ?? ""); const type = body.type;
      if (!UUID.test(projectId) || (type !== "builder_site_audit" && type !== "room_status")) return bad(400, "bad_request", "A job and a report type are required.");
      const deps: BuildDeps = { db, storage, timezone, ...(ctx.logo ? { logo: ctx.logo } : {}) };
      return { status: 200, json: { ...(await buildReport(deps, projectId, type)) } };
    }

    const reportId = String(body.reportId ?? "");
    if (!UUID.test(reportId)) return bad(400, "bad_request", "A report is required.");
    if (action === "print") {                                   // printing needs no email settings
      await printReport({ db, storage }, reportId);
      return { status: 200, json: { status: "printed" } };
    }
    const from = ctx.env.REPORT_FROM;
    if (!from) return bad(500, "not_configured", "Sending is not set up yet: the REPORT_FROM setting is missing in Vercel.");
    const deps = { db, storage, transport: ctx.transport(), from, timezone };

    if (action === "sendTest") {
      if (!user.email || !isValidEmail(user.email)) return bad(422, "invalid_recipient", "Your account has no valid email address.");
      await sendTestReport(deps, reportId, user.email);
      return { status: 200, json: { status: "test_sent", to: user.email } };
    }

    // send: the recipient is the builder contact saved on the job, read here on the server (never taken from the browser)
    const report = await db.getReport(reportId);
    if (!report) return bad(404, "report_not_found", "That report was not found, or you do not have access to it.");
    const project = await db.getProject(report.project_id);
    if (!project?.prepared_for_email || !isValidEmail(project.prepared_for_email)) {
      return bad(422, "no_recipient", "Add the builder's name and email on the job first.");
    }
    await sendReport(deps, reportId, { name: project.prepared_for_name, email: project.prepared_for_email });
    return { status: 200, json: { status: "sent", to: project.prepared_for_email } };
  } catch (e) {
    if (e instanceof ReportTooLargeError) return { status: 413, json: { error: e.code, message: e.message, bytes: e.bytes, limit: e.limit } };
    if (e instanceof ReportError) return bad(STATUS[e.code] ?? (e.code === "send_failed" || e.code === "sent_not_recorded" ? 502 : 500), e.code, e.message);
    console.error("reports api error", e instanceof Error ? e.message : e);       // never log the token or the request body
    return bad(500, "server_error", "Something went wrong on the server. Nothing was sent.");
  }
}

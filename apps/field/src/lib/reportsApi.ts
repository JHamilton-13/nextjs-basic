import { OVERRIDE_ROLES } from "@phc/domain";
import type { MyRoles } from "./issues";

/** Admins and the three manager roles on that job see the manager screens. The database and the server enforce the same rule. */
export function canManageReports(roles: MyRoles | undefined, projectId: string): boolean {
  if (!roles) return false;
  if (roles.isAdmin) return true;
  const role = roles.byProject[projectId];
  return !!role && (OVERRIDE_ROLES as readonly string[]).includes(role);
}

export type ReportsRequest =
  | { action: "build"; projectId: string; type: "builder_site_audit" | "room_status" }
  | { action: "send" | "sendTest"; reportId: string };
export type ReportsResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; bytes?: number };

export async function callReportsApi(fetchImpl: typeof fetch, accessToken: string, body: ReportsRequest): Promise<ReportsResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/reports", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, code: "network", message: "No connection" };
  }
  let json: Record<string, unknown> | null = null;
  try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
  if (res.ok && json) return { ok: true, data: json };
  const code = typeof json?.error === "string" ? json.error : "server_error";
  return { ok: false, status: res.status, code, message: typeof json?.message === "string" ? json.message : "The server could not do that.", ...(typeof json?.bytes === "number" ? { bytes: json.bytes } : {}) };
}

export function describeReportProblem(p: { code: string; message: string; bytes?: number }): string {
  switch (p.code) {
    case "not_signed_in": return "Your sign-in has expired. Sign in again, then try again.";
    case "forbidden": return "Only managers of this job can do that.";
    case "project_not_found": return "That job was not found, or you do not have access to it.";
    case "report_not_found": return "That report was not found.";
    case "report_already_queued": return "This report is already being sent. Wait a few minutes, then check the status.";
    case "report_already_sent": return "This report has already been sent. It can only be sent once.";
    case "invalid_recipient": return "That email address does not look right.";
    case "no_recipient": return "Add the builder's name and a valid email on this job first, then save.";
    case "report_too_large": return `The PDF is too large${p.bytes ? ` (${(p.bytes / 1024 / 1024).toFixed(1)} MB)` : ""}. The limit is 18 MB, so it was not saved. Remove or shrink photos and try again.`;
    case "not_configured": return "Sending is not set up yet. The owner needs to add the email settings in Vercel (see docs/ops/gmail-send-setup.md).";
    case "pdf_missing": return "The PDF file could not be found. Build the report again.";
    case "send_failed": return `The email was not sent. ${p.message.replace(/^The email was not sent:\s*/, "")} You can retry.`;
    case "sent_not_recorded": return "The email was sent but could not be recorded. Check the Sent folder before trying again.";
    case "network": return "No connection. Reports need the internet. Try again when you are online.";
    case "db_error": return `The database refused that: ${p.message}`;
    case "upload_failed": return `The PDF could not be stored. ${p.message} Try again.`.replace(/\s+/g, " ");
    case "server_error": return "The server had a problem. Nothing was sent. Try again in a minute.";
    default: return p.message || "Something went wrong.";
  }
}

export type ReportStatus = "built" | "queued" | "sent" | "failed";
export const reportStatusLabel = (s: ReportStatus): string => ({ built: "Ready to send", queued: "Sending…", sent: "Sent", failed: "Failed" })[s];

/** A report left in "queued" for over 10 minutes may be retried (the database allows it); the screen tells the manager to check the Sent folder first. */
export const stuckQueued = (r: { status: ReportStatus; queued_at: string | null }, nowMs: number): boolean =>
  r.status === "queued" && (r.queued_at === null || nowMs - Date.parse(r.queued_at) > 10 * 60_000);

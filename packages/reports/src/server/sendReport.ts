import { isValidEmail } from "@phc/domain";
import { cleanupReports } from "./cleanup";
import { ReportError } from "./errors";
import { safeFileName, type EmailTransport } from "./transport";
import type { ReportDb, ReportRow, ReportStorage } from "./ports";

export interface SendDeps { db: ReportDb; storage: ReportStorage; transport: EmailTransport; from: string; timezone: string; now?: () => Date }

const KIND_NAME: Record<ReportRow["report_type"], string> = { builder_site_audit: "Site Audit", room_status: "Room Status", service: "Service Report", custom: "Project Report" };
const kindOf = (r: ReportRow) => KIND_NAME[r.report_type];

async function load(deps: SendDeps, reportId: string) {
  const report = await deps.db.getReport(reportId);
  if (!report) throw new ReportError("report_not_found", "That report was not found, or you do not have access to it.");
  const project = await deps.db.getProject(report.project_id);
  if (!project) throw new ReportError("project_not_found", "That job was not found, or you do not have access to it.");
  const date = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  return { report, project, date };
}

const bodyText = (name: string | null, jobName: string, kind: string) =>
  `${name ? `Hello ${name},` : "Hello,"}\n\nPlease find the ${kind.toLowerCase()} report for ${jobName} attached.\n\nPublic House Creative`;

/**
 * Sends the report to the builder exactly once. The database claims the send first (queue_report_send), so a double click, a second
 * manager, or a retry after a crash cannot email twice; a failed or stuck (over 10 minutes) report can be retried.
 */
export async function sendReport(deps: SendDeps, reportId: string, to: { name: string | null; email: string }): Promise<"sent"> {
  if (!isValidEmail(to.email)) throw new ReportError("invalid_recipient", "That email address does not look right.");
  const { project, date } = await load(deps, reportId);
  const report = await deps.db.queueReportSend(reportId, to.name, to.email);   // throws report_already_queued / report_already_sent / forbidden
  const file = await deps.storage.download("reports", report.storage_path);
  if (!file) {
    await deps.db.markReportFailed(reportId, "The PDF file could not be found. Build the report again.");
    throw new ReportError("pdf_missing", "The PDF file could not be found. Build the report again.");
  }
  let messageId: string;
  try {
    ({ messageId } = await deps.transport.send({
      from: deps.from, to: to.email, subject: `${project.name} – ${kindOf(report)}`, text: bodyText(to.name, project.name, kindOf(report)),
      attachment: { filename: safeFileName(project.name, date, kindOf(report)), content: file, contentType: "application/pdf" },
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await deps.db.markReportFailed(reportId, msg);
    throw new ReportError("send_failed", `The email was not sent: ${msg}`);
  }
  try {
    await deps.db.markReportSent(reportId, messageId);
  } catch {
    // The email is out. Leaving the report queued (not failed) prevents an automatic resend; the manager is told to check first.
    throw new ReportError("sent_not_recorded", "The email was sent but could not be recorded. Check the Sent folder before trying again.");
  }
  try { await cleanupReports({ db: deps.db, storage: deps.storage, ...(deps.now ? { now: deps.now } : {}) }, report.project_id, report.report_type, reportId); }
  catch (e) { console.error("report cleanup failed", e instanceof Error ? e.message : e); }   // the email is out; tidying up must never turn that into an error
  return "sent";
}

/** The manager pressed Print: record it, then keep only this report as the saved one of its type. */
export async function printReport(deps: { db: ReportDb; storage: ReportStorage; now?: () => Date }, reportId: string): Promise<void> {
  const report = await deps.db.getReport(reportId);
  if (!report) throw new ReportError("report_not_found", "That report was not found, or you do not have access to it.");
  await deps.db.markReportPrinted(reportId);
  try { await cleanupReports(deps, report.project_id, report.report_type, reportId); }
  catch (e) { console.error("report cleanup failed", e instanceof Error ? e.message : e); }
}

/** Sends the PDF to the signed-in manager only, so they can see exactly what the builder would get. Does not change the report's status. */
export async function sendTestReport(deps: SendDeps, reportId: string, managerEmail: string): Promise<void> {
  if (!isValidEmail(managerEmail)) throw new ReportError("invalid_recipient", "Your account has no valid email address.");
  const { report, project, date } = await load(deps, reportId);
  const file = await deps.storage.download("reports", report.storage_path);
  if (!file) throw new ReportError("pdf_missing", "The PDF file could not be found. Build the report again.");
  await deps.transport.send({
    from: deps.from, to: managerEmail, subject: `TEST – ${project.name} – ${kindOf(report)}`,
    text: `This is a test copy. It was not sent to the builder.\n\n${bodyText(null, project.name, kindOf(report))}`,
    attachment: { filename: safeFileName(project.name, date, kindOf(report)), content: file, contentType: "application/pdf" },
  });
}

export interface ShareDeps extends SendDeps { phcDomain: string }
export const MAX_SHARE_RECIPIENTS = 10;

/** Only addresses on the PHC email domain (a Vercel setting, never stored in the repo) may be shared with. */
export function checkColleagueAddresses(raw: string[], domain: string): { ok: true; emails: string[] } | { ok: false; code: string; message: string } {
  const d = domain.trim().replace(/^@/, "").toLowerCase();
  const emails = [...new Set(raw.map((e) => e.trim()))].filter((e) => e !== "");
  if (emails.length === 0) return { ok: false, code: "invalid_recipient", message: "Add at least one colleague's email address." };
  if (emails.length > MAX_SHARE_RECIPIENTS) return { ok: false, code: "too_many_recipients", message: `Share with at most ${MAX_SHARE_RECIPIENTS} people at a time.` };
  for (const e of emails) {
    if (!isValidEmail(e)) return { ok: false, code: "invalid_recipient", message: `"${e}" does not look like an email address.` };
    if (e.slice(e.lastIndexOf("@") + 1).toLowerCase() !== d) return { ok: false, code: "recipient_not_phc", message: `"${e}" is not a PHC address. Colleagues must be at @${d}. Use Send to builder for the builder.` };
  }
  return { ok: true, emails };
}

/**
 * Emails the report to colleagues inside PHC. It can be done any number of times (only the builder email is once-only). Each person gets
 * their own copy. Whoever was reached is recorded, the report becomes the saved one of its type, and older saved ones are removed.
 */
export async function shareReport(deps: ShareDeps, reportId: string, recipients: string[], sharedBy: string | null): Promise<{ sentTo: string[] }> {
  const checked = checkColleagueAddresses(recipients, deps.phcDomain);
  if (!checked.ok) throw new ReportError(checked.code, checked.message);
  const { report, project, date } = await load(deps, reportId);
  if (report.status === "queued") throw new ReportError("report_already_queued", "This report is being emailed right now. Wait for it to finish.");
  const file = await deps.storage.download("reports", report.storage_path);
  if (!file) throw new ReportError("pdf_missing", "The PDF file could not be found. Build the report again.");
  const sentTo: string[] = []; const failed: string[] = [];
  for (const to of checked.emails) {
    try {
      await deps.transport.send({
        from: deps.from, to, subject: `${project.name} – ${kindOf(report)}`,
        text: `${sharedBy ? `${sharedBy} shared` : "A colleague shared"} the ${kindOf(report).toLowerCase()} for ${project.name} with you. The PDF is attached.\n\nPublic House Creative (internal: not for the builder or client)`,
        attachment: { filename: safeFileName(project.name, date, kindOf(report)), content: file, contentType: "application/pdf" },
      });
      sentTo.push(to);
    } catch { failed.push(to); }
  }
  if (sentTo.length > 0) {
    try { await deps.db.markReportShared(reportId, sentTo); } catch { throw new ReportError("sent_not_recorded", "The email was sent but could not be recorded. Check the Sent folder before trying again."); }
    try { await cleanupReports(deps, report.project_id, report.report_type, reportId); } catch (e) { console.error("report cleanup failed", e instanceof Error ? e.message : e); }
  }
  if (failed.length > 0) throw new ReportError("share_failed", `${sentTo.length > 0 ? `Sent to ${sentTo.join(", ")}. ` : ""}Could not send to ${failed.join(", ")}. Try those again.`);
  return { sentTo };
}

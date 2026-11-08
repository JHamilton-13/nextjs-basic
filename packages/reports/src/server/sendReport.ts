import { isValidEmail } from "@phc/domain";
import { ReportError } from "./errors";
import { safeFileName, type EmailTransport } from "./transport";
import type { ReportDb, ReportRow, ReportStorage } from "./ports";

export interface SendDeps { db: ReportDb; storage: ReportStorage; transport: EmailTransport; from: string; timezone: string; now?: () => Date }

const kindOf = (r: ReportRow) => (r.report_type === "room_status" ? "Room Status" : "Site Audit");

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
  return "sent";
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

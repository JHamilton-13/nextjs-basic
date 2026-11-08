import { readFileSync } from "node:fs";
import { createElement } from "react";
import { BuilderAuditDocument } from "../BuilderAuditDocument";
import { RoomStatusDocument } from "../RoomStatusDocument";
import { LOGO_FILE } from "../fonts";
import { prepareImage } from "../prepareImage";
import { MAX_PDF_BYTES, renderReport } from "../render";
import { ReportTooLargeError, ReportError } from "./errors";
import { loadBuilderAuditData, loadRoomStatusData } from "./loadReportData";
import type { ReportDb, ReportRow, ReportStorage } from "./ports";

export { MAX_PDF_BYTES };

export interface BuildDeps {
  db: ReportDb; storage: ReportStorage; timezone: string;
  now?: () => Date; newId?: () => string; logo?: Buffer; maxBytes?: number;
}
export interface BuildResult { reportId: string; bytes: number; identified: number; incomplete: number; photosMissing: number }

/** Loads everything the signed-in manager can see, renders the PDF, stores it, and records one report row (status built). */
export async function buildReport(deps: BuildDeps, projectId: string, type: ReportRow["report_type"]): Promise<BuildResult> {
  const { db, storage, timezone } = deps;
  const now = deps.now ?? (() => new Date());
  const limit = deps.maxBytes ?? MAX_PDF_BYTES;
  const logo = deps.logo ?? readFileSync(LOGO_FILE);
  const builtAt = now().toISOString();
  let pdf: Buffer; let identified = 0; let incomplete = 0; let photosMissing = 0;

  if (type === "builder_site_audit") {
    const data = await loadBuilderAuditData(db, projectId);
    const photos: Record<string, Buffer | null> = {};
    const entries = Object.entries(data.photoPaths);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const [id, path] = entries[next++]!;
        try {
          const raw = await storage.download("issue-photos", path);
          photos[id] = raw ? await prepareImage(raw) : null;
        } catch { photos[id] = null; }
        if (!photos[id]) photosMissing++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
    identified = data.summary.identified; incomplete = data.summary.incomplete;
    pdf = await renderReport(createElement(BuilderAuditDocument, {
      jobName: data.project.name, preparedFor: data.project.prepared_for_name, siteAddress: data.project.address, builtAt, timezone, summary: data.summary, logo, photos,
    }));
  } else {
    const project = await db.getProject(projectId);
    if (!project) throw new ReportError("project_not_found", "That job was not found, or you do not have access to it.");
    const rows = await loadRoomStatusData(db, projectId);
    pdf = await renderReport(createElement(RoomStatusDocument, {
      jobName: project.name, preparedFor: project.prepared_for_name, siteAddress: project.address, builtAt, timezone, logo, rows,
    }));
  }

  if (pdf.length > limit) throw new ReportTooLargeError(pdf.length, limit);
  const reportId = (deps.newId ?? (() => crypto.randomUUID()))();
  const path = `${projectId}/${reportId}.pdf`;
  await storage.upload("reports", path, pdf);
  await db.createReport({ id: reportId, projectId, type, path, bytes: pdf.length });
  return { reportId, bytes: pdf.length, identified, incomplete, photosMissing };
}

import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReportOptions } from "@phc/domain";
import { ReportDocument } from "../ReportDocument";
import { LOGO_FILE } from "../fonts";
import { prepareImage } from "../prepareImage";
import { MAX_PDF_BYTES, renderReport } from "../render";
import { cleanupReports } from "./cleanup";
import { ReportTooLargeError } from "./errors";
import { loadReportData } from "./loadReportData";
import type { ReportDb, ReportStorage } from "./ports";

export { MAX_PDF_BYTES };

export interface BuildDeps {
  db: ReportDb; storage: ReportStorage; timezone: string;
  now?: () => Date; newId?: () => string; logo?: Buffer; maxBytes?: number;
}
export interface BuildResult { reportId: string; bytes: number; identified: number; incomplete: number; photosMissing: number; removedReports: number }

/** Loads what the signed-in manager can see, shows what the options ask for, renders the PDF, stores it, and records one report row (status built). */
export async function buildReport(deps: BuildDeps, projectId: string, options: ReportOptions): Promise<BuildResult> {
  const { db, storage, timezone } = deps;
  const now = deps.now ?? (() => new Date());
  const limit = deps.maxBytes ?? MAX_PDF_BYTES;
  const logo = deps.logo ?? readFileSync(LOGO_FILE);
  const builtAt = now().toISOString();

  const data = await loadReportData(db, projectId, options);
  const photos: Record<string, Buffer | null> = {};
  let photosMissing = 0;
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
  const pdf = await renderReport(createElement(ReportDocument, {
    jobName: data.project.name, preparedFor: data.project.prepared_for_name, siteAddress: data.project.address, builtAt, timezone, model: data.model, logo, photos,
  }));

  if (pdf.length > limit) throw new ReportTooLargeError(pdf.length, limit);
  const reportId = (deps.newId ?? (() => crypto.randomUUID()))();
  const path = `${projectId}/${reportId}.pdf`;
  await storage.upload("reports", path, pdf);
  const type = options.preset;
  await db.createReport({ id: reportId, projectId, type, path, bytes: pdf.length, options });
  // the new build replaces the last preview of its type (a saved report stays until something newer is saved); never fails the build
  let removedReports = 0;
  try { removedReports = (await cleanupReports({ db, storage, now }, projectId, type, reportId)).removedReports; } catch (e) { console.error("report cleanup failed", e instanceof Error ? e.message : e); }
  const t = data.model.totals;
  return { reportId, bytes: pdf.length, identified: t.identified, incomplete: t.incomplete, photosMissing, removedReports };
}

import type { ReportDb, ReportRow, ReportStorage } from "./ports";

export interface CleanupResult { removedReports: number; removedFiles: number; failedFiles: number }
const REPORT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i;
const SWEEP_AFTER_MS = 10 * 60_000;

/**
 * Keeps only what the owner wants: the newest emailed-or-printed report per job and type, plus the report just acted on.
 * The database decides which rows go (prune_reports) and hands back their file paths; the files are then deleted here.
 * Finally any report file that no row points to (a leftover from an earlier failure) is removed, unless it is under 10 minutes old
 * (another build may still be recording it).
 */
export async function cleanupReports(deps: { db: ReportDb; storage: ReportStorage; now?: () => Date }, projectId: string, type: ReportRow["report_type"], keepId: string): Promise<CleanupResult> {
  const { db, storage } = deps;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const paths = await db.pruneReports(projectId, type, keepId);
  let failedFiles = paths.length > 0 ? await storage.remove("reports", paths) : 0;
  let removedFiles = paths.length - failedFiles;

  const known = new Set(await db.listReportPaths(projectId));
  const orphans = (await storage.list("reports", projectId))
    .filter((f) => REPORT_FILE.test(f.path.slice(projectId.length + 1)) && !known.has(f.path))
    .filter((f) => f.createdAt === null || nowMs - Date.parse(f.createdAt) > SWEEP_AFTER_MS)
    .map((f) => f.path);
  if (orphans.length > 0) {
    const failed = await storage.remove("reports", orphans);
    failedFiles += failed; removedFiles += orphans.length - failed;
  }
  return { removedReports: paths.length, removedFiles, failedFiles };
}

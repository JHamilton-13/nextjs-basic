import { buildReportModel, roomStatus, ROOM_CHECK_ITEMS, type ModelSourceIssue, type PhotoMode, type ReportModel, type ReportOptions, type RoomChecklistInfo } from "@phc/domain";
import type { ReportDb, ReportProject, IssueRow, IssuePhotoRow } from "./ports";
import { ReportError } from "./errors";

/** "Rick Wells" -> "RW"; one name -> one letter; no name -> from the email ("pat.lee@x" -> "PL"); nothing -> "?". */
export function initialsOf(fullName: string | null, email: string | null): string {
  const letters = (s: string) => s.split(/[\s._+-]+/).map((w) => w.trim()).filter(Boolean);
  const pick = (words: string[]) => (words.length === 0 ? "" : (words.length === 1 ? words[0]![0]! : words[0]![0]! + words[words.length - 1]![0]!).toUpperCase());
  return pick(letters(fullName ?? "")) || pick(letters((email ?? "").split("@")[0] ?? "")) || "?";
}

const statusOf = (i: IssueRow): ModelSourceIssue["status"] => (i.voided_at ? "void" : i.completed_at ? "completed" : "open");

/**
 * Photos for an issue, ONE kind only (never both):
 *  - "annotated": the newest marked-up copy of each original, or the original if it was never marked up (a marked-up original is archived);
 *  - "original": the originals only;
 *  - "none": no photos.
 * Always shown with the ORIGINAL's capture time. Photos that were never uploaded (not confirmed) are left out.
 */
export function choosePhotos(photos: IssuePhotoRow[], mode: PhotoMode = "annotated"): { id: string; path: string; capturedAt: string; issueId: string; originalId: string }[] {
  if (mode === "none") return [];
  const confirmed = photos.filter((p) => p.confirmed_at);
  const originals = confirmed.filter((p) => !p.annotated_from);
  return originals.map((o) => {
    const copies = mode === "annotated" ? confirmed.filter((p) => p.annotated_from === o.id).sort((a, b) => b.captured_at.localeCompare(a.captured_at)) : [];
    const shown = copies[0] ?? o;
    return { id: shown.id, path: shown.storage_path, capturedAt: o.captured_at, issueId: o.issue_id, originalId: o.id };
  }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export interface ReportData { project: ReportProject; model: ReportModel; photoPaths: Record<string, string> }

/** Loads what the signed-in manager can see and decides what the report shows (see buildReportModel). */
export async function loadReportData(db: ReportDb, projectId: string, options: ReportOptions): Promise<ReportData> {
  const project = await db.getProject(projectId);
  if (!project) throw new ReportError("project_not_found", "That job was not found, or you do not have access to it.");
  const [rooms, issues, photos, checks] = await Promise.all([db.listRooms(projectId), db.listIssues(projectId), options.photos === "none" ? Promise.resolve([] as IssuePhotoRow[]) : db.listIssuePhotos(projectId), db.listRoomChecks(projectId)]);
  const wantedKinds = new Set<string>(options.kinds);
  const mine = issues.filter((i) => wantedKinds.has(i.kind));
  const people = await db.listProfiles([...new Set([...mine.map((i) => i.raised_by), ...checks.map((c) => c.checked_by)])]);
  const who = new Map(people.map((p) => [p.id, initialsOf(p.full_name, p.email)] as const));

  const chosen = choosePhotos(photos, options.photos);
  const source: ModelSourceIssue[] = mine.map((i) => ({
    id: i.id, roomId: i.room_id, kind: i.kind as ModelSourceIssue["kind"], status: statusOf(i), tradeName: i.trade_name, title: i.title, description: i.description ?? "",
    raisedByInitials: who.get(i.raised_by) ?? "?", raisedOn: i.raised_at, completedOn: i.completed_at,
    photos: chosen.filter((p) => p.issueId === i.id).map((p) => ({ id: p.id, capturedAt: p.capturedAt })),
  }));

  const checklist: Record<string, RoomChecklistInfo> = {};
  for (const room of rooms) {
    const marks = checks.filter((c) => c.room_id === room.id);
    const st = roomStatus(ROOM_CHECK_ITEMS, marks.map((c) => ({ key: c.item_key, state: c.state, note: c.note })));
    const latest = marks.slice().sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
    checklist[room.id] = {
      completed: st.completed, started: marks.length > 0,
      outstanding: marks.length === 0 ? ["Checklist not started"] : st.outstanding.map((o) => (o.note ? `${o.label}: ${o.note}` : o.label)),
      byWho: latest ? who.get(latest.checked_by) ?? "?" : null, at: latest?.checked_at ?? null,
    };
  }

  const model = buildReportModel({ rooms, issues: source, checklist }, options);
  const photoPaths: Record<string, string> = {};
  for (const room of model.rooms) for (const i of room.issues) for (const p of i.photos) { const c = chosen.find((x) => x.id === p.id); if (c) photoPaths[p.id] = c.path; }
  return { project, model, photoPaths };
}

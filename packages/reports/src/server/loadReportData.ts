import { builderAuditSummary, roomStatus, ROOM_CHECK_ITEMS, type BuilderAuditSummary, type IssueKind, type ReportIssue } from "@phc/domain";
import type { ReportDb, ReportProject, IssueRow, IssuePhotoRow } from "./ports";
import { ReportError } from "./errors";
import type { RoomStatusRow } from "../RoomStatusDocument";

/** "Rick Wells" -> "RW"; one name -> one letter; no name -> from the email ("pat.lee@x" -> "PL"); nothing -> "?". */
export function initialsOf(fullName: string | null, email: string | null): string {
  const letters = (s: string) => s.split(/[\s._+-]+/).map((w) => w.trim()).filter(Boolean);
  const pick = (words: string[]) => (words.length === 0 ? "" : (words.length === 1 ? words[0]![0]! : words[0]![0]! + words[words.length - 1]![0]!).toUpperCase());
  return pick(letters(fullName ?? "")) || pick(letters((email ?? "").split("@")[0] ?? "")) || "?";
}

const statusOf = (i: IssueRow): ReportIssue["status"] => (i.voided_at ? "void" : i.completed_at ? "completed" : "open");

/** For each original photo: the newest marked-up copy if there is one (it is what the manager wants to see), shown with the ORIGINAL's capture time. */
export function choosePhotos(photos: IssuePhotoRow[]): { id: string; path: string; capturedAt: string; issueId: string; originalId: string }[] {
  const confirmed = photos.filter((p) => p.confirmed_at);
  const originals = confirmed.filter((p) => !p.annotated_from);
  return originals.map((o) => {
    const copies = confirmed.filter((p) => p.annotated_from === o.id).sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    const shown = copies[0] ?? o;
    return { id: shown.id, path: shown.storage_path, capturedAt: o.captured_at, issueId: o.issue_id, originalId: o.id };
  }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export interface BuilderAuditData { project: ReportProject; summary: BuilderAuditSummary; photoPaths: Record<string, string> }

export async function loadBuilderAuditData(db: ReportDb, projectId: string): Promise<BuilderAuditData> {
  const project = await db.getProject(projectId);
  if (!project) throw new ReportError("project_not_found", "That job was not found, or you do not have access to it.");
  const [rooms, issues, photos] = await Promise.all([db.listRooms(projectId), db.listIssues(projectId), db.listIssuePhotos(projectId)]);
  const pre = issues.filter((i) => i.kind === "pre_install_correction");
  const profiles = await db.listProfiles([...new Set(pre.map((i) => i.raised_by))]);
  const who = new Map(profiles.map((p) => [p.id, initialsOf(p.full_name, p.email)] as const));
  const chosen = choosePhotos(photos);
  const photoPaths: Record<string, string> = {};
  const reportIssues: ReportIssue[] = pre.map((i) => {
    const mine = chosen.filter((p) => p.issueId === i.id);
    for (const p of mine) photoPaths[p.id] = p.path;
    return {
      id: i.id, roomId: i.room_id, kind: i.kind as IssueKind, status: statusOf(i), tradeName: i.trade_name, title: i.title, description: i.description ?? "",
      raisedByInitials: who.get(i.raised_by) ?? "?", raisedOn: i.raised_at, photos: mine.map((p) => ({ id: p.id, capturedAt: p.capturedAt })),
    };
  });
  return { project, summary: builderAuditSummary(reportIssues, rooms), photoPaths };
}

export async function loadRoomStatusData(db: ReportDb, projectId: string): Promise<RoomStatusRow[]> {
  const [rooms, issues, checks] = await Promise.all([db.listRooms(projectId), db.listIssues(projectId), db.listRoomChecks(projectId)]);
  const profiles = await db.listProfiles([...new Set(checks.map((c) => c.checked_by))]);
  const who = new Map(profiles.map((p) => [p.id, initialsOf(p.full_name, p.email)] as const));
  return rooms.map((room) => {
    const mine = checks.filter((c) => c.room_id === room.id);
    const st = roomStatus(ROOM_CHECK_ITEMS, mine.map((c) => ({ key: c.item_key, state: c.state, note: c.note })));
    const latest = mine.slice().sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
    const outstanding = mine.length === 0 ? ["Checklist not started"] : st.outstanding.map((o) => (o.note ? `${o.label}: ${o.note}` : o.label));
    return {
      roomName: room.name, completed: st.completed, byWho: latest ? who.get(latest.checked_by) ?? "?" : null, at: latest?.checked_at ?? null,
      outstanding, openIssues: issues.filter((i) => i.room_id === room.id && statusOf(i) === "open").length,
    };
  });
}

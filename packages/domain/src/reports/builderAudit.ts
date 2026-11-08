import type { IssueKind } from "./categories";

export interface ReportIssue {
  id: string;
  roomId: string;
  kind: IssueKind;
  status: "open" | "completed" | "void";
  tradeName: string | null;
  title: string;
  description: string;
  raisedByInitials: string;
  /** ISO timestamp of when it was raised on site. */
  raisedOn: string;
  photos: { id: string; capturedAt: string }[];
}

export interface BuilderAuditRoom { roomId: string; roomName: string; issues: ReportIssue[] }
export interface BuilderAuditSummary { identified: number; incomplete: number; rooms: BuilderAuditRoom[] }

/**
 * What the builder PDF shows: Pre Install Corrections only, grouped by room in the app's room order (issues keep their own order).
 * Voided issues never count and never appear. "Identified" = open + completed; "Incomplete" = open.
 * An issue whose room is not in `rooms` is left out of both the counts and the lists, so the totals always match what is printed.
 */
export function builderAuditSummary(issues: readonly ReportIssue[], rooms: readonly { id: string; name: string }[]): BuilderAuditSummary {
  const out: BuilderAuditRoom[] = [];
  let identified = 0; let incomplete = 0;
  for (const room of rooms) {
    const mine = issues.filter((i) => i.roomId === room.id && i.kind === "pre_install_correction" && i.status !== "void");
    if (mine.length === 0) continue;
    identified += mine.length;
    incomplete += mine.filter((i) => i.status === "open").length;
    out.push({ roomId: room.id, roomName: room.name, issues: mine });
  }
  return { identified, incomplete, rooms: out };
}

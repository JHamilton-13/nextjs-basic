export interface PillDef { key: string; label: string }
export interface PillMark { key: string; state: "done" | "not_done" | "na"; note: string | null }
export interface OutstandingPill { key: string; label: string; state: "not_done" | "unticked"; note: string | null }

/**
 * A room is Completed when every checklist pill is Done or N/A. A pill nobody has touched counts as outstanding ("unticked"),
 * so a room that was never opened is Not completed. An empty checklist definition is never Completed (nothing was confirmed).
 * Open issues do not change the status (owner decision); the open-issue count is shown beside it elsewhere.
 */
export function roomStatus(defs: readonly PillDef[], marks: readonly PillMark[]): { completed: boolean; outstanding: OutstandingPill[] } {
  const byKey = new Map(marks.map((m) => [m.key, m] as const));
  const outstanding: OutstandingPill[] = [];
  for (const d of defs) {
    const m = byKey.get(d.key);
    if (m && (m.state === "done" || m.state === "na")) continue;
    outstanding.push({ key: d.key, label: d.label, state: m ? "not_done" : "unticked", note: m ? m.note : null });
  }
  return { completed: defs.length > 0 && outstanding.length === 0, outstanding };
}

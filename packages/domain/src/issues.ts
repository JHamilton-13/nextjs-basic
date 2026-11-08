import { categoryOf, type IssueCategory, type IssueKind } from "./reports/categories";
import { isOverrideRole } from "./roles";

/** The kinds inside each category, in the order the Add Issue screen offers them. */
export const ISSUE_KINDS_BY_CATEGORY: Record<IssueCategory, IssueKind[]> = {
  pre_install_corrections: ["pre_install_correction"],
  service: ["punch_item", "missing_part", "damaged_part"],
  touch_ups: ["touch_up"],
};

/**
 * What stops the Add Issue form from saving, as short messages (empty = it can be saved). Mirrors the database: a Pre Install
 * Correction needs a trade, and a Damaged part needs a photo (the database enforces the photo rule when completing).
 */
export function issueSaveBlockers(i: { kind: IssueKind | null; tradeId: string | null; title: string; photoCount: number }): string[] {
  const out: string[] = [];
  if (i.kind === null) out.push("Choose a kind");
  if (i.kind === "pre_install_correction" && !i.tradeId) out.push("Add a trade");
  if (i.title.trim() === "") out.push("Add a title");
  if (i.kind === "damaged_part" && i.photoCount < 1) out.push("A damaged part needs a photo");
  return out;
}

/** Owner decision: only the person who raised an issue, or a manager, can edit, complete, reopen or void it. The database enforces it too. */
export function canChangeIssue(p: { role: string | null; isRaiser: boolean; isAdmin: boolean }): boolean {
  if (p.isAdmin) return true;
  if (p.role !== null && isOverrideRole(p.role)) return true;
  return p.isRaiser && p.role === "installer";
}

export function canCompleteIssue(kind: IssueKind, originalPhotoCount: number): { ok: true } | { ok: false; reason: "photo_required" } {
  return kind === "damaged_part" && originalPhotoCount < 1 ? { ok: false, reason: "photo_required" } : { ok: true };
}

export { categoryOf };

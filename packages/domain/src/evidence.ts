import { isOverrideRole, isValidTimestamp, type Role } from "./roles";
import type { ToleranceResult } from "./tolerance";

export interface ItemRequirements {
  /** Minimum number of photos. */
  photo?: number;
  measurement?: boolean;
  note?: boolean;
  drawingRef?: boolean;
  supervisorApproval?: boolean;
}

export interface Evidence {
  photoCount?: number;
  /** A recorded measurement (a MeasurementRecord satisfies this). */
  measurement?: { result: ToleranceResult };
  note?: string;
  drawingRef?: string;
  supervisorApproval?: { approvedBy: string; role: Role; at: string };
}

export type MissingRequirement =
  | { kind: "photo"; required: number; have: number }
  | { kind: "measurement" }
  | { kind: "note" }
  | { kind: "drawingRef" }
  | { kind: "supervisorApproval" };

const filled = (s: string | undefined): boolean => typeof s === "string" && s.trim() !== "";

/** Returns what is still missing for the item to be marked Complete. Empty array = satisfied. */
export function canComplete(requires: ItemRequirements, evidence: Evidence): MissingRequirement[] {
  const missing: MissingRequirement[] = [];

  if (requires.photo !== undefined && requires.photo > 0) {
    const raw = evidence.photoCount;
    const have = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (have < requires.photo) missing.push({ kind: "photo", required: requires.photo, have });
  }
  if (requires.measurement && !evidence.measurement) missing.push({ kind: "measurement" });
  if (requires.note && !filled(evidence.note)) missing.push({ kind: "note" });
  if (requires.drawingRef && !filled(evidence.drawingRef)) missing.push({ kind: "drawingRef" });
  if (requires.supervisorApproval) {
    const a = evidence.supervisorApproval;
    const valid = a !== undefined && filled(a.approvedBy) && isOverrideRole(a.role) && isValidTimestamp(a.at);
    if (!valid) missing.push({ kind: "supervisorApproval" });
  }
  return missing;
}

export interface EvidenceException {
  userId: string;
  role: Role;
  reason: string;
  at: string;
}

export type ExceptionError = "role_not_authorized" | "reason_required" | "invalid_timestamp" | "user_required";

export type Completion =
  | { status: "complete" }
  | { status: "complete_with_exception"; missing: MissingRequirement[]; exception: EvidenceException }
  | { status: "blocked"; missing: MissingRequirement[]; exceptionError?: ExceptionError };

function exceptionProblem(x: EvidenceException): ExceptionError | undefined {
  if (!filled(x.userId)) return "user_required";
  if (!isOverrideRole(x.role)) return "role_not_authorized";
  if (!filled(x.reason)) return "reason_required";
  if (!isValidTimestamp(x.at)) return "invalid_timestamp";
  return undefined;
}

/**
 * Decides whether an item may be marked Complete. A required step never completes without its evidence;
 * only an authorized, reasoned, timestamped exception can stand in, and it is returned so it can be audit-logged.
 */
export function resolveCompletion(requires: ItemRequirements, evidence: Evidence, exception?: EvidenceException): Completion {
  const missing = canComplete(requires, evidence);
  if (missing.length === 0) return { status: "complete" };
  if (!exception) return { status: "blocked", missing };
  const problem = exceptionProblem(exception);
  if (problem) return { status: "blocked", missing, exceptionError: problem };
  return { status: "complete_with_exception", missing, exception };
}

import { ok, err, type Result } from "./result";
import { DEFAULT_RELEASE_ROLES, isOverrideRole, isValidTimestamp, type Role } from "./roles";

export type ReadinessState =
  | "not_started"
  | "in_progress"
  | "ready"
  | "ready_with_exceptions"
  | "not_ready"
  | "manager_review_required"
  | "released_for_installation";

/** OBSERVED = observation-only items (plumb, flatness, floor level): never affect readiness. */
export type ItemResult = "PASS" | "REVIEW" | "FAIL" | "NOT_ENTERED" | "OBSERVED" | "NOT_APPLICABLE";

export interface AuditItemOutcome {
  itemId: string;
  /** Critical items (MEP rough-in conflicts) stop the gate on FAIL. */
  critical: boolean;
  result: ItemResult;
}

export interface ReadinessPolicy {
  /** What a non-critical FAIL/REVIEW produces, per template config. */
  nonCriticalIssueState: "manager_review_required" | "ready_with_exceptions";
  /** Roles allowed to release. Defaults to DEFAULT_RELEASE_ROLES. */
  releaseRoles?: readonly Role[];
}

export interface Override {
  readonly id: string;
  readonly auditId: string;
  /** The override authorizes release of exactly this audit version. */
  readonly auditVersion: number;
  readonly grantedBy: string;
  readonly role: Role;
  readonly reason: string;
  readonly supportingDocIds: readonly string[];
  readonly at: string;
}

export interface ReleaseRecord {
  readonly releasedBy: string;
  readonly role: Role;
  readonly at: string;
  readonly auditVersion: number;
  readonly basis: "clear" | "override";
  readonly overrideId?: string;
}

export interface AuditRecord {
  auditId: string;
  projectId: string;
  version: number;
  submitted: boolean;
  submittedAt?: string;
  submittedBy?: string;
  items: readonly AuditItemOutcome[];
  /** Full history, including overrides for older versions (which are no longer valid). */
  overrides: readonly Override[];
  release?: ReleaseRecord;
}

export type AuditEventType = "audit_submitted" | "override_granted" | "released" | "audit_revised";

/** Returned from state-changing functions so callers can write the append-only audit_log. */
export interface AuditEvent {
  type: AuditEventType;
  auditId: string;
  projectId: string;
  version: number;
  actorId: string;
  role?: Role;
  at: string;
  details?: Record<string, unknown>;
}

export interface ReadinessError {
  code:
    | "already_submitted"
    | "audit_submitted"
    | "unknown_item"
    | "invalid_timestamp"
    | "role_not_authorized"
    | "reason_required"
    | "audit_not_submitted"
    | "override_not_needed"
    | "duplicate_override_id"
    | "already_released"
    | "inspection_not_complete"
    | "override_required"
    | "not_submitted"
    | "user_required";
  message: string;
  itemIds?: string[];
  failedItemIds?: string[];
}

const e = (code: ReadinessError["code"], message: string, extra: Partial<ReadinessError> = {}) =>
  err<ReadinessError>({ code, message, ...extra });

const filled = (s: unknown): s is string => typeof s === "string" && s.trim() !== "";
const entered = (i: AuditItemOutcome) => i.result !== "NOT_ENTERED";

export const isEditable = (a: AuditRecord): boolean => !a.submitted;

/** Items that FAILED or need REVIEW (excludes observation / N/A). */
function problemItemIds(a: AuditRecord): string[] {
  return a.items.filter((i) => i.result === "FAIL" || i.result === "REVIEW").map((i) => i.itemId);
}

function validOverride(a: AuditRecord): Override | undefined {
  return a.overrides.find((o) => o.auditId === a.auditId && o.auditVersion === a.version);
}

/** The single source of truth for an audit's readiness state. */
export function auditState(a: AuditRecord, policy: ReadinessPolicy): ReadinessState {
  if (a.release && a.release.auditVersion === a.version) return "released_for_installation";

  const criticalFail = a.items.some((i) => i.critical && i.result === "FAIL");
  if (criticalFail) return "not_ready";

  // Owner decision 2026-11-08: submitting does not require every item to have a result, so once
  // submitted, items that were never entered simply do not count.
  if (!a.submitted) {
    return a.items.some(entered) ? "in_progress" : "not_started";
  }
  if (a.items.some((i) => i.critical && i.result === "REVIEW")) return "manager_review_required";
  if (a.items.some((i) => !i.critical && (i.result === "FAIL" || i.result === "REVIEW"))) return policy.nonCriticalIssueState;
  return "ready";
}

export function setItemOutcome(a: AuditRecord, outcome: AuditItemOutcome): Result<AuditRecord, ReadinessError> {
  if (a.submitted) return e("audit_submitted", "A submitted audit cannot be edited; revise it to create a new version");
  if (!a.items.some((i) => i.itemId === outcome.itemId)) return e("unknown_item", `No item ${outcome.itemId} in this audit`);
  return ok({ ...a, items: a.items.map((i) => (i.itemId === outcome.itemId ? { ...outcome } : i)) });
}

const event = (a: AuditRecord, type: AuditEventType, actorId: string, at: string, role?: Role, details?: Record<string, unknown>): AuditEvent => ({
  type, auditId: a.auditId, projectId: a.projectId, version: a.version, actorId, at,
  ...(role !== undefined ? { role } : {}),
  ...(details !== undefined ? { details } : {}),
});

export function submitAudit(a: AuditRecord, userId: string, at: string): Result<{ audit: AuditRecord; event: AuditEvent }, ReadinessError> {
  if (!filled(userId)) return e("user_required", "A submitting user is required");
  if (!isValidTimestamp(at)) return e("invalid_timestamp", "Timestamp is not a valid date-time");
  if (a.submitted) return e("already_submitted", "This audit version is already submitted");
  const audit: AuditRecord = { ...a, submitted: true, submittedAt: at, submittedBy: userId };
  return ok({ audit, event: event(audit, "audit_submitted", userId, at) });
}

export interface GrantOverrideInput {
  id: string;
  grantedBy: string;
  role: Role;
  reason: string;
  supportingDocIds?: string[];
  at: string;
}

export function grantOverride(
  a: AuditRecord,
  input: GrantOverrideInput,
  policy: ReadinessPolicy,
): Result<{ audit: AuditRecord; event: AuditEvent }, ReadinessError> {
  if (!isOverrideRole(input.role)) return e("role_not_authorized", `Role ${input.role} cannot grant overrides`);
  if (!filled(input.grantedBy)) return e("user_required", "An approving user is required");
  if (!filled(input.reason)) return e("reason_required", "A reason is required for an override");
  if (!isValidTimestamp(input.at)) return e("invalid_timestamp", "Timestamp is not a valid date-time");
  if (a.release && a.release.auditVersion === a.version) return e("already_released", "This audit version is already released");
  if (!a.submitted) return e("audit_not_submitted", "Submit the audit before an override can authorize its release");
  if (a.overrides.some((o) => o.id === input.id)) return e("duplicate_override_id", `Override ${input.id} already exists`);
  if (auditState(a, policy) === "ready") return e("override_not_needed", "This audit is ready; no override is needed");

  const override: Override = Object.freeze({
    id: input.id,
    auditId: a.auditId,
    auditVersion: a.version,
    grantedBy: input.grantedBy,
    role: input.role,
    reason: input.reason,
    supportingDocIds: Object.freeze([...(input.supportingDocIds ?? [])]),
    at: input.at,
  });
  const audit: AuditRecord = { ...a, overrides: [...a.overrides, override] };
  return ok({
    audit,
    event: event(audit, "override_granted", input.grantedBy, input.at, input.role, {
      overrideId: override.id,
      reason: override.reason,
      supportingDocIds: [...override.supportingDocIds],
      failedItemIds: problemItemIds(a),
    }),
  });
}

export function release(
  a: AuditRecord,
  actor: { userId: string; role: Role },
  at: string,
  policy: ReadinessPolicy,
): Result<{ audit: AuditRecord; event: AuditEvent }, ReadinessError> {
  if (!isValidTimestamp(at)) return e("invalid_timestamp", "Timestamp is not a valid date-time");
  if (!filled(actor.userId)) return e("user_required", "A releasing user is required");
  if (a.release && a.release.auditVersion === a.version) return e("already_released", "This audit version is already released");
  const roles = policy.releaseRoles ?? DEFAULT_RELEASE_ROLES;
  if (!roles.includes(actor.role)) return e("role_not_authorized", `Role ${actor.role} cannot release a project`);
  if (!a.submitted) return e("inspection_not_complete", "The inspection must be submitted before release");

  const state = auditState(a, policy);
  if (state === "not_started" || state === "in_progress") return e("inspection_not_complete", "The inspection is not complete");

  let record: ReleaseRecord;
  if (state === "ready") {
    record = Object.freeze({ releasedBy: actor.userId, role: actor.role, at, auditVersion: a.version, basis: "clear" as const });
  } else {
    const o = validOverride(a);
    if (!o) {
      return e("override_required", "A documented override from an authorized manager is required to release this audit", {
        failedItemIds: problemItemIds(a),
      });
    }
    record = Object.freeze({ releasedBy: actor.userId, role: actor.role, at, auditVersion: a.version, basis: "override" as const, overrideId: o.id });
  }
  const audit: AuditRecord = { ...a, release: record };
  return ok({
    audit,
    event: event(audit, "released", actor.userId, at, actor.role, {
      basis: record.basis,
      ...(record.overrideId !== undefined ? { overrideId: record.overrideId } : {}),
    }),
  });
}

/**
 * Creates version n+1 of a submitted audit. Item outcomes carry over so corrections can be made; the submitted
 * original is untouched. Overrides stay in history but only match their own version, so they no longer authorize
 * release; any release is revoked.
 */
export function reviseAudit(
  a: AuditRecord,
  actor: { userId: string; role: Role },
  at: string,
  reason: string,
): Result<{ audit: AuditRecord; event: AuditEvent }, ReadinessError> {
  if (!filled(actor.userId)) return e("user_required", "A revising user is required");
  if (!isValidTimestamp(at)) return e("invalid_timestamp", "Timestamp is not a valid date-time");
  if (!filled(reason)) return e("reason_required", "A reason is required to revise an audit");
  if (!a.submitted) return e("not_submitted", "Only a submitted audit needs a revision; edit this one directly");

  const { release: _release, submittedAt: _sa, submittedBy: _sb, ...rest } = a;
  const audit: AuditRecord = { ...rest, version: a.version + 1, submitted: false, items: a.items.map((i) => ({ ...i })) };
  return ok({
    audit,
    event: event(audit, "audit_revised", actor.userId, at, actor.role, { reason, previousVersion: a.version, releaseRevoked: a.release !== undefined }),
  });
}

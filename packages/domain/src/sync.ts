import { ok, err, type Result } from "./result";
import { isValidTimestamp } from "./roles";

/** Envelope for every offline write. `opId` is a client-generated UUID and doubles as the idempotency key. */
export interface OperationEnvelope {
  opId: string;
  entity: string;
  entityId: string;
  /** The entity version the client last saw (0 for a new entity). */
  baseVersion: number;
  payload: Record<string, unknown>;
  createdAt: string;
  actor: string;
}

export interface EnvelopeError {
  code: "invalid_envelope";
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim() !== "";

export function validateEnvelope(op: OperationEnvelope): Result<OperationEnvelope, EnvelopeError> {
  const bad = (message: string) => err<EnvelopeError>({ code: "invalid_envelope", message });
  if (typeof op.opId !== "string" || !UUID.test(op.opId)) return bad("opId must be a UUID");
  if (!nonEmpty(op.entity)) return bad("entity is required");
  if (!nonEmpty(op.entityId)) return bad("entityId is required");
  if (!nonEmpty(op.actor)) return bad("actor is required");
  if (!Number.isSafeInteger(op.baseVersion) || op.baseVersion < 0) return bad("baseVersion must be a non-negative integer");
  if (!isValidTimestamp(op.createdAt)) return bad("createdAt must be a valid date-time");
  if (typeof op.payload !== "object" || op.payload === null || Array.isArray(op.payload)) return bad("payload must be an object");
  return ok(op);
}

export type ApplyOutcome =
  | { status: "applied"; newVersion: number }
  | { status: "conflict"; currentVersion: number; baseVersion: number }
  | { status: "rejected"; message: string };

export type OperationResult = ApplyOutcome | { status: "duplicate"; original: ApplyOutcome };

export interface ServerState {
  versions: Record<string, number>;
  data: Record<string, unknown>;
  /** opId -> first outcome (the applied_ops table). */
  applied: Record<string, ApplyOutcome>;
}

export const emptyServerState = (): ServerState => ({ versions: {}, data: {}, applied: {} });

/**
 * Pure reference model of the server-side apply_op function: each opId is applied at most once;
 * a stale or future baseVersion is a conflict and never overwrites; replays return the recorded outcome.
 */
export function applyOperation(state: ServerState, op: OperationEnvelope): { state: ServerState; outcome: OperationResult } {
  const valid = validateEnvelope(op);
  if (!valid.ok) return { state, outcome: { status: "rejected", message: valid.error.message } };

  const prior = state.applied[op.opId];
  if (prior) return { state, outcome: { status: "duplicate", original: prior } };

  const key = `${op.entity}:${op.entityId}`;
  const currentVersion = state.versions[key] ?? 0;

  if (op.baseVersion !== currentVersion) {
    const outcome: ApplyOutcome = { status: "conflict", currentVersion, baseVersion: op.baseVersion };
    return { state: { ...state, applied: { ...state.applied, [op.opId]: outcome } }, outcome };
  }
  const outcome: ApplyOutcome = { status: "applied", newVersion: currentVersion + 1 };
  return {
    state: {
      versions: { ...state.versions, [key]: outcome.newVersion },
      data: { ...state.data, [key]: op.payload },
      applied: { ...state.applied, [op.opId]: outcome },
    },
    outcome,
  };
}

// ---- client-side status of one queued operation ----

export type ClientStatus = "pending" | "sent" | "confirmed" | "conflict" | "failed";

export interface ClientOpState {
  opId: string;
  status: ClientStatus;
  attempts: number;
  retryable?: boolean;
  lastError?: string;
  conflictVersion?: number;
}

export type ClientEvent =
  | { type: "send" }
  | { type: "server_confirmed" }
  | { type: "server_conflict"; currentVersion: number }
  | { type: "network_error"; message: string }
  | { type: "server_rejected"; message: string }
  | { type: "retry" }
  /** App restarted while an op was in flight; resend is safe because of idempotency. */
  | { type: "recover" };

export interface TransitionError {
  code: "invalid_transition";
  message: string;
}

export const newClientOp = (opId: string): ClientOpState => ({ opId, status: "pending", attempts: 0 });

/** Only `confirmed` (server acknowledged) may be shown as synced. */
export function transitionStatus(s: ClientOpState, ev: ClientEvent): Result<ClientOpState, TransitionError> {
  const bad = () => err<TransitionError>({ code: "invalid_transition", message: `Cannot apply ${ev.type} while ${s.status}` });
  const base = { opId: s.opId, attempts: s.attempts };
  switch (ev.type) {
    case "send":
      return s.status === "pending" ? ok({ ...base, status: "sent" }) : bad();
    case "server_confirmed":
      return s.status === "sent" ? ok({ ...base, status: "confirmed" }) : bad();
    case "server_conflict":
      return s.status === "sent" ? ok({ ...base, status: "conflict", conflictVersion: ev.currentVersion }) : bad();
    case "network_error":
      return s.status === "sent"
        ? ok({ ...base, attempts: s.attempts + 1, status: "failed", retryable: true, lastError: ev.message })
        : bad();
    case "server_rejected":
      return s.status === "sent"
        ? ok({ ...base, attempts: s.attempts + 1, status: "failed", retryable: false, lastError: ev.message })
        : bad();
    case "retry":
      return s.status === "failed" && s.retryable === true ? ok({ ...base, status: "pending" }) : bad();
    case "recover":
      return s.status === "sent" ? ok({ ...base, status: "pending" }) : bad();
  }
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** Exponential backoff: baseMs * 2^attempts, capped at maxMs. Bad input yields the base delay. */
export function nextRetryDelayMs(attempts: number, o: BackoffOptions): number {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  return Math.min(o.maxMs, o.baseMs * 2 ** Math.min(n, 30));
}

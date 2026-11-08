import {
  newClientOp, nextRetryDelayMs, transitionStatus,
  type ClientEvent, type OperationEnvelope, type OperationResult,
} from "@phc/domain";
import type { Db } from "./db";
import type { OutboxRecord } from "./types";

/** Thrown by a Transport. `retryable` = try again later (network down, token expired); false = permanent. */
export class TransportError extends Error {
  constructor(public kind: "network" | "auth" | "server", message: string, public retryable: boolean) {
    super(message);
  }
}

export interface Transport {
  /** Sends one operation. Resolves with the server's outcome; throws TransportError on any transport failure. */
  send(op: OperationEnvelope): Promise<OperationResult>;
}

export interface OutboxOptions {
  now?: () => number;
  baseMs?: number;
  maxMs?: number;
  /** Only ops whose actor passes are sent (a different user signed in on this device must not send someone else's ops). */
  canSend?: (actor: string) => boolean;
  onChange?: () => void;
}

export interface DrainSummary {
  confirmed: number;
  failed: number;
  conflicts: number;
  networkDown: boolean;
  blockedAudits: string[];
}

export interface OutboxExtra { lane?: "data" | "files"; after?: string[] }

export function newOutboxRecord(op: OperationEnvelope, auditId: string, extra: OutboxExtra = {}): OutboxRecord {
  return { auditId, op, state: newClientOp(op.opId), nextAttemptAt: 0, ...(extra.lane ? { lane: extra.lane } : {}), ...(extra.after ? { after: extra.after } : {}) };
}

/**
 * Durable outbound queue. Every local write is stored here BEFORE any network call, sent strictly in order,
 * retried with backoff, and only shown as synced once the server confirms (never optimistically).
 * Idempotency (client-generated opId, server-side apply_op) makes resends after a crash or lost response safe.
 */
export class Outbox {
  private running: Promise<DrainSummary> | undefined;
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(private db: Db, private transport: Transport, private opts: OutboxOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.baseMs = opts.baseMs ?? 2000;
    this.maxMs = opts.maxMs ?? 5 * 60 * 1000;
  }

  async enqueue(op: OperationEnvelope, auditId: string, extra: OutboxExtra = {}): Promise<number> {
    const seq = (await this.db.add("outbox", newOutboxRecord(op, auditId, extra))) as number;
    this.opts.onChange?.();
    return seq;
  }

  /** Call after writing to the outbox store inside your own transaction. */
  notify(): void { this.opts.onChange?.(); }

  list(): Promise<OutboxRecord[]> { return this.db.getAll("outbox"); }

  /** Ops still waiting to reach the server (pending, in flight, or failed-but-retryable). */
  async pendingCount(): Promise<number> {
    return (await this.list()).filter((r) => r.state.status === "pending" || r.state.status === "sent" || (r.state.status === "failed" && r.state.retryable === true)).length;
  }

  /** Ops that need a human: server conflict or permanent rejection. */
  async attentionCount(): Promise<number> {
    return (await this.list()).filter((r) => r.state.status === "conflict" || (r.state.status === "failed" && r.state.retryable === false)).length;
  }

  /** On startup: anything left in `sent` was interrupted mid-flight. Resend is safe because of idempotency. */
  async recover(): Promise<number> {
    let n = 0;
    for (const rec of await this.list()) {
      if (rec.state.status === "sent") { await this.transition(rec, { type: "recover" }); n++; }
    }
    return n;
  }

  drain(o: { ignoreBackoff?: boolean } = {}): Promise<DrainSummary> {
    if (this.running) return this.running;
    this.running = this.run(o).finally(() => { this.running = undefined; this.opts.onChange?.(); });
    return this.running;
  }

  private async transition(rec: OutboxRecord, ev: ClientEvent, patch: Partial<OutboxRecord> = {}): Promise<OutboxRecord> {
    const r = transitionStatus(rec.state, ev);
    if (!r.ok) throw new Error(r.error.message);
    const next: OutboxRecord = { ...rec, ...patch, state: r.value };
    await this.db.put("outbox", next);
    return next;
  }

  private async run(o: { ignoreBackoff?: boolean }): Promise<DrainSummary> {
    const sum: DrainSummary = { confirmed: 0, failed: 0, conflicts: 0, networkDown: false, blockedAudits: [] };
    const blocked = new Set<string>();
    const all = await this.list();
    const statusOf = new Map(all.map((r) => [r.op.opId, r.state] as const));
    let filesDown = false; // a retryable failure while uploading pauses ALL uploads for this drain, but not results

    for (let rec of all) {
      const lane = `${rec.auditId}:${rec.lane ?? "data"}`;
      const block = () => { if (!blocked.has(lane)) { blocked.add(lane); if (!sum.blockedAudits.includes(rec.auditId)) sum.blockedAudits.push(rec.auditId); } };
      const st = rec.state;
      if (st.status === "confirmed") continue;
      if (blocked.has(lane)) continue;
      if (st.status === "conflict" || (st.status === "failed" && st.retryable === false)) { block(); continue; }
      if (this.opts.canSend && !this.opts.canSend(rec.op.actor)) continue;
      if (filesDown && rec.lane === "files") continue;

      // Dependencies (e.g. upload after the photo is registered): wait for them; if one can never succeed, this one is stuck too.
      const deps = (rec.after ?? []).map((id) => statusOf.get(id));
      if (deps.some((d) => !d || d.status === "conflict" || (d.status === "failed" && d.retryable === false))) { block(); continue; }
      if (deps.some((d) => d && d.status !== "confirmed")) continue;

      if (st.status === "failed") {
        if (!o.ignoreBackoff && rec.nextAttemptAt > this.now()) { block(); continue; }
        rec = await this.transition(rec, { type: "retry" });
      }
      if (rec.state.status !== "pending") continue;

      rec = await this.transition(rec, { type: "send" });
      let outcome: OperationResult;
      try {
        outcome = await this.transport.send(rec.op);
      } catch (e) {
        const te = e instanceof TransportError ? e : new TransportError("network", e instanceof Error ? e.message : String(e), true);
        if (te.retryable) {
          const attemptsAfter = rec.state.attempts + 1;
          const failed = await this.transition(rec, { type: "network_error", message: te.message }, { nextAttemptAt: this.now() + nextRetryDelayMs(attemptsAfter - 1, { baseMs: this.baseMs, maxMs: this.maxMs }) });
          statusOf.set(failed.op.opId, failed.state);
          sum.failed++;
          if (rec.lane === "files") { filesDown = true; block(); continue; } // storage trouble only: keep sending results
          sum.networkDown = true;
          break; // the API is unreachable: stop, keep order, try again later
        }
        const done = await this.transition(rec, { type: "server_rejected", message: te.message });
        statusOf.set(done.op.opId, done.state);
        sum.failed++; block();
        continue;
      }

      const eff = outcome.status === "duplicate" ? outcome.original : outcome;
      let done: OutboxRecord;
      if (eff.status === "applied") { done = await this.transition(rec, { type: "server_confirmed" }); sum.confirmed++; }
      else if (eff.status === "conflict") { done = await this.transition(rec, { type: "server_conflict", currentVersion: eff.currentVersion }); sum.conflicts++; block(); }
      else { done = await this.transition(rec, { type: "server_rejected", message: eff.message }); sum.failed++; block(); }
      statusOf.set(done.op.opId, done.state);
    }
    return sum;
  }
}

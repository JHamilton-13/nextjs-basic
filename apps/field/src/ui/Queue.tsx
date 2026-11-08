import type { AppCtx } from "../App";
import { useLive } from "./useLive";

const WHAT = (e: string) => (e === "audit" ? "Create audit" : e === "audit_item" ? "Save measurement" : e);

export function Queue({ ctx }: { ctx: AppCtx }) {
  const rows = useLive(ctx.tick, () => ctx.outbox.list());
  const mine = (a: string) => a === ctx.identity.userId;
  return (
    <>
      <h1>Sync queue</h1>
      <p className="muted">Everything you do is saved on this device first, then sent in order. An item only says “synced” after the server confirms it.</p>
      <button className="primary" disabled={ctx.syncing || !ctx.hasSession} onClick={() => void ctx.sync(true)} data-testid="sync-now">{ctx.syncing ? "Syncing…" : "Sync now"}</button>
      {!ctx.hasSession && <p className="chip warn">Sign in again (needs a connection) to send your changes.</p>}
      {ctx.lastSync?.error && <p className="chip warn">Last sync: {ctx.lastSync.error}</p>}
      {rows?.length === 0 && <p className="muted">Nothing queued.</p>}
      <ul className="plain" data-testid="queue-list">
        {rows?.map((r) => (
          <li className="row static" key={r.seq} data-testid="queue-row">
            <span>{WHAT(r.op.entity)}<small> · {r.op.entityId.split(":").slice(-1)[0]}</small></span>
            <span className={`chip ${r.state.status === "confirmed" ? "good" : r.state.status === "conflict" || (r.state.status === "failed" && !r.state.retryable) ? "bad" : "warn"}`} data-testid="queue-status">
              {r.state.status === "failed" ? (r.state.retryable ? "will retry" : "rejected") : r.state.status === "confirmed" ? "synced" : r.state.status}
            </span>
            {!mine(r.op.actor) && <small>belongs to another user</small>}
            {r.state.lastError && <small className="err">{r.state.lastError}</small>}
            {r.state.status === "conflict" && <small className="err">Someone else changed this item. It needs a manager to resolve (not overwritten).</small>}
          </li>
        ))}
      </ul>
    </>
  );
}

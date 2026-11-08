import type { AppCtx } from "../App";
import { ROOM_CHECK_ITEMS } from "../lib/roomChecks";
import { useLive } from "./useLive";
import { fmtBytes, readStorage, storageWarning } from "../lib/storage";

const WHAT = (e: string) => (e === "audit" ? "Create audit" : e === "audit_item" ? "Save measurement" : e === "room_check" ? "Room checklist" : e === "room_issue" ? "Issue" : e === "photo" ? "Photo" : e);
const ACTION: Record<string, string> = { create: "raised", update: "edited", complete: "completed", reopen: "reopened", void: "voided", register: "registered", upload: "uploading", confirm: "confirming" };
const WHICH = (op: { entity: string; entityId: string; payload: Record<string, unknown> }) => { const k = op.entityId.split(":").slice(-1)[0]!; if (op.entity === "room_check") return ROOM_CHECK_ITEMS.find((i) => i.key === k)?.label ?? k; if (op.entity === "room_issue" || (op.entity === "photo" && op.payload.issueId)) return ACTION[String(op.payload.action)] ?? String(op.payload.action ?? ""); return k; };

export function Queue({ ctx }: { ctx: AppCtx }) {
  const rows = useLive(ctx.tick, () => ctx.outbox.list());
  const mine = (a: string) => a === ctx.identity.userId;
  const storage = useLive(ctx.tick, () => readStorage());
  const warn = storage ? storageWarning(storage) : null;
  return (
    <>
      <h1>Sync queue</h1>
      <section className="card" data-testid="storage-info">
        <h2>Device storage</h2>
        {storage ? (
          <>
            <p>
              {storage.persisted ? <span className="chip good">Protected from automatic clearing</span> : <span className="chip warn">Not protected from automatic clearing</span>}{" "}
              {storage.installed ? <span className="chip good">Installed</span> : <span className="chip gray">Running in the browser</span>}
            </p>
            {storage.supported && <p className="muted small">Using {fmtBytes(storage.usedBytes)} of {fmtBytes(storage.quotaBytes)} available to this app.</p>}
            {warn && <p className="hint" role="status">{warn}</p>}
            {!storage.installed && (
              <details>
                <summary>How to install on your phone</summary>
                <p><strong>iPhone (Safari):</strong> tap the Share button, then “Add to Home Screen”, then Add. Open the app from the new icon.</p>
                <p><strong>Android (Chrome):</strong> tap the ⋮ menu, then “Install app” (or “Add to Home screen”).</p>
              </details>
            )}
          </>
        ) : <p className="muted">Checking…</p>}
      </section>
      <p className="muted small" data-testid="build-id">App version {__BUILD_ID__}. If something looks old, close the app completely and open it again.</p>
      <p className="muted">Everything you do is saved on this device first, then sent in order. An item only says “synced” after the server confirms it.</p>
      <button className="primary" disabled={ctx.syncing || !ctx.hasSession} onClick={() => void ctx.sync(true)} data-testid="sync-now">{ctx.syncing ? "Syncing…" : "Sync now"}</button>
      {!ctx.hasSession && <p className="chip warn">Sign in again (needs a connection) to send your changes.</p>}
      {ctx.lastSync?.error && <p className="chip warn">Last sync: {ctx.lastSync.error}</p>}
      {rows?.length === 0 && <p className="muted">Nothing queued.</p>}
      <ul className="plain" data-testid="queue-list">
        {rows?.map((r) => (
          <li className="row static" key={r.seq} data-testid="queue-row">
            <span>{WHAT(r.op.entity)}<small> · {WHICH(r.op)}</small></span>
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

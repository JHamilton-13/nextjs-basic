import { useState } from "react";
import type { AppCtx } from "../App";
import { CARD_FIELDS, fieldsFor, hasTBD, MORE_FIELDS } from "../lib/roomFields";
import { checkProgress, ROOM_CHECK_ITEMS, ROOM_CHECK_LONG, setRoomCheck } from "../lib/roomChecks";
import type { CheckState, LocalRoomCheck, OutboxRecord, RoomRow } from "../lib/types";
import { fmtWhen } from "./when";

const SOURCE: Record<string, string> = { cockpit: "Cockpit", masterfile: "the master file", warehouse_tracker: "the Warehouse Tracker", manual: "entered by hand" };
const STATE_WORD: Record<CheckState, string> = { done: "Done", not_done: "Not done", na: "N/A" };

function Details({ pairs }: { pairs: { key: string; label: string; value: string }[] }) {
  return <dl className="spec">{pairs.map((f) => <div key={f.key}><dt>{f.label}</dt><dd className={hasTBD(f.value) ? "tbd" : ""}>{f.value}</dd></div>)}</dl>;
}

/** One room: its details (read-only) and the completion checklist (tap a pill to mark it done). */
export function RoomCard({ ctx, room, checks, queue }: { ctx: AppCtx; room: RoomRow; checks: LocalRoomCheck[]; queue: OutboxRecord[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const byKey = new Map(checks.map((c) => [c.itemKey, c]));
  const prog = checkProgress(checks);
  const attention = queue.some((q) => q.state.status === "conflict" || (q.state.status === "failed" && !q.state.retryable));
  const card = fieldsFor(room.details, CARD_FIELDS);
  const more = fieldsFor(room.details, MORE_FIELDS);

  const cctx = { db: ctx.db, userId: ctx.identity.userId, userLabel: ctx.identity.label, newId: () => crypto.randomUUID(), now: () => new Date().toISOString(), notify: () => ctx.outbox.notify() };
  async function set(itemKey: string, state: CheckState | "clear", text?: string) {
    setError(null);
    const r = await setRoomCheck(cctx, room.id, itemKey, state, text);
    if (!r.ok) { setError(r.error.message); return false; }
    void ctx.sync();
    return true;
  }
  function tap(itemKey: string) {
    const cur = byKey.get(itemKey);
    setError(null);
    if (!cur) { setOpen(null); void set(itemKey, "done"); return; }   // one tap marks it done
    setAsking(false); setNote(cur.note ?? ""); setOpen(open === itemKey ? null : itemKey); // tapping a marked pill opens its panel
  }
  const sel = open ? byKey.get(open) : undefined;

  return (
    <section className="card room" data-testid="room-card" data-room={room.name}>
      <header className="roomhead">
        <h2>{room.name}</h2>
        <span className={`chip ${attention ? "bad" : prog.complete === prog.total ? "good" : prog.notDone > 0 ? "warn" : "gray"}`} data-testid="room-progress">
          {attention ? "needs attention" : `${prog.complete}/${prog.total}`}
        </span>
      </header>
      {card.length > 0 ? <Details pairs={card} /> : <p className="muted small">No room details yet.</p>}
      {more.length > 0 && <details><summary>More details</summary><Details pairs={more} /></details>}
      {room.details_source && card.length + more.length > 0 && <p className="muted small">Details from {SOURCE[room.details_source] ?? room.details_source}.</p>}

      <div className="pills" role="group" aria-label={`Completion checklist for ${room.name}`}>
        {ROOM_CHECK_ITEMS.map((it) => {
          const c = byKey.get(it.key);
          return (
            <button key={it.key} className={`pill ${c?.state ?? "none"} ${open === it.key ? "open" : ""}`} aria-pressed={c ? c.state === "done" : false} data-state={c?.state ?? "none"} data-pending={c?.pending ? "yes" : "no"} onClick={() => tap(it.key)} data-testid={`pill-${it.key}`}>
              <span className="mark" aria-hidden="true">{c?.state === "done" ? "✓" : c?.state === "not_done" ? "!" : c?.state === "na" ? "–" : ""}</span>{it.label}{c?.state === "na" ? " (N/A)" : ""}
            </button>
          );
        })}
      </div>

      {open && sel && (
        <div className="panel" data-testid="pill-panel">
          <strong>{ROOM_CHECK_LONG[open]}</strong>
          <p className="muted small">{STATE_WORD[sel.state]} · {sel.by ?? "someone"} · {fmtWhen(sel.at)}{sel.pending ? " · waiting to sync" : ""}</p>
          {!asking ? (
            <div className="btnrow">
              <button className={sel.state === "done" ? "on" : ""} onClick={() => { void set(open, "done").then((ok) => ok && setOpen(null)); }} data-testid="set-done">Done</button>
              <button className={sel.state === "not_done" ? "on" : ""} onClick={() => setAsking(true)} data-testid="set-notdone">Not done</button>
              <button className={sel.state === "na" ? "on" : ""} onClick={() => { void set(open, "na").then((ok) => ok && setOpen(null)); }} data-testid="set-na">N/A</button>
              <button onClick={() => { void set(open, "clear").then((ok) => ok && setOpen(null)); }} data-testid="set-clear">Clear</button>
            </div>
          ) : (
            <>
              <label>Why is this not finished?
                <textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Toe skins installed after wood floor installation. After 11/5" data-testid="notdone-note" />
              </label>
              <div className="btnrow">
                <button className="primary" onClick={() => { void set(open, "not_done", note).then((ok) => { if (ok) { setAsking(false); setOpen(null); } }); }} data-testid="save-notdone">Save as not done</button>
                <button onClick={() => setAsking(false)}>Back</button>
              </div>
            </>
          )}
        </div>
      )}
      {error && <p className="err" role="alert">{error}</p>}

      {checks.filter((c) => c.state === "not_done" && c.note).map((c) => (
        <p className="notdone-note" key={c.itemKey} data-testid="notdone-line"><strong>{ROOM_CHECK_ITEMS.find((i) => i.key === c.itemKey)?.label}:</strong> {c.note} <small className="muted">— {c.by ?? "someone"}, {fmtWhen(c.at)}</small></p>
      ))}
    </section>
  );
}

import { useState } from "react";
import { categoryOf, requiresTrade, type IssueCategory, type IssueKind } from "@phc/domain";
import type { AppCtx } from "../App";
import { browserCompress } from "../lib/imaging";
import { CATEGORY_LABEL, CATEGORY_ORDER, KIND_LABEL, KIND_ORDER, reasonText } from "../lib/issueLabels";
import { completeIssue, issueStatus, loadRoles, mayChangeIssue, reopenIssue, updateIssue, voidIssue, type IssueCtx } from "../lib/issues";
import type { LocalIssue, OutboxRecord, RoomRow, TradeRow } from "../lib/types";
import { AddIssueSheet } from "./AddIssueSheet";
import { PhotoStrip } from "./PhotoStrip";
import { useLive } from "./useLive";
import { fmtWhen } from "./when";

const issueCtx = (ctx: AppCtx): IssueCtx => ({ db: ctx.db, userId: ctx.identity.userId, userLabel: ctx.identity.label, compress: browserCompress, newId: () => crypto.randomUUID(), now: () => new Date().toISOString(), notify: () => ctx.outbox.notify() });

/** The issues on one room: Add issue, counts per kind, an Open / Completed switch, and the list grouped by category. Voided issues never show. */
export function IssueSection({ ctx, room, issues, queue }: { ctx: AppCtx; room: RoomRow; issues: LocalIssue[]; queue: OutboxRecord[] }) {
  const [view, setView] = useState<"open" | "completed">("open");
  const [adding, setAdding] = useState(false);
  const meta = useLive(ctx.tick, async () => ({ trades: await ctx.db.getAll("trades"), roles: await loadRoles(ctx.db) }));
  const trades: TradeRow[] = meta?.trades ?? [];
  const live = issues.filter((i) => issueStatus(i) !== "void").sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const open = live.filter((i) => issueStatus(i) === "open");
  const shown = view === "open" ? open : live.filter((i) => issueStatus(i) === "completed");
  const countOf = (k: IssueKind) => open.filter((i) => i.kind === k).length;

  return (
    <div className="issues" data-testid="issues">
      <div className="issues-head">
        <h3>Issues</h3>
        <button className="primary" onClick={() => setAdding(true)} data-testid="add-issue">Add issue</button>
      </div>
      <div className="counts" role="group" aria-label="Open issues by kind">
        {KIND_ORDER.map((k) => <span key={k} className={`chip ${countOf(k) > 0 ? "warn" : "gray"}`} data-testid={`count-${k}`}>{KIND_LABEL[k]} {countOf(k)}</span>)}
      </div>
      <div className="seg" role="group" aria-label="Show open or completed issues">
        <button aria-pressed={view === "open"} className={view === "open" ? "on" : ""} onClick={() => setView("open")} data-testid="view-open">Open</button>
        <button aria-pressed={view === "completed"} className={view === "completed" ? "on" : ""} onClick={() => setView("completed")} data-testid="view-completed">Completed</button>
      </div>
      {shown.length === 0 && <p className="muted" data-testid="issues-empty">{view === "open" ? "No open issues in this room." : "Nothing completed yet."}</p>}
      {CATEGORY_ORDER.map((c) => {
        const list = shown.filter((i) => categoryOf(i.kind) === c);
        if (list.length === 0) return null;
        return (
          <div key={c} className="issue-group">
            <h4>{CATEGORY_LABEL[c as IssueCategory]}</h4>
            {list.map((i) => <IssueCard key={i.id} ctx={ctx} issue={i} trades={trades} may={mayChangeIssue(meta?.roles, i, ctx.identity.userId)} queue={queue.filter((q) => q.op.entityId === i.id || q.op.payload.issueId === i.id)} />)}
          </div>
        );
      })}
      {adding && <AddIssueSheet ctx={ctx} room={room} trades={trades} onClose={() => setAdding(false)} />}
    </div>
  );
}

function IssueCard({ ctx, issue, trades, may, queue }: { ctx: AppCtx; issue: LocalIssue; trades: TradeRow[]; may: boolean; queue: OutboxRecord[] }) {
  const photos = useLive(ctx.tick, () => ctx.db.getAllFromIndex("photos", "by_issue", issue.id), [issue.id]) ?? [];
  const [panel, setPanel] = useState<"none" | "complete" | "edit" | "void">("none");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = issueStatus(issue);
  const tradeName = issue.tradeId ? trades.find((t) => t.id === issue.tradeId)?.name ?? "Trade" : null;
  const failed = queue.find((q) => q.state.status === "conflict" || (q.state.status === "failed" && !q.state.retryable));
  const sorted = photos.slice().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  async function run(f: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setError(null);
    const r = await f();
    if (!r.ok) { setError(r.error?.message ?? "Could not save."); return; }
    setPanel("none"); setNote("");
    void ctx.sync();
  }

  return (
    <article className={`issue-card ${status}`} data-testid="issue-card" data-kind={issue.kind} data-status={status}>
      <header className="issue-head">
        <span className="chip info" data-testid="issue-kind">{KIND_LABEL[issue.kind]}</span>
        {tradeName && <span className="chip gray" data-testid="issue-trade">{tradeName}</span>}
        {issue.pending && !failed && <span className="chip progress" data-testid="issue-pending">waiting to sync</span>}
        {failed && <span className="chip bad" data-testid="issue-attention">needs attention</span>}
      </header>
      <strong className="issue-title" data-testid="issue-title">{issue.title}</strong>
      {issue.description && <p className="issue-desc">{issue.description}</p>}
      <p className="muted small" data-testid="issue-raised">Raised by {issue.raisedByLabel} · {fmtWhen(issue.raisedAt)}</p>
      {issue.completedAt && <p className="muted small" data-testid="issue-completed">Completed by {issue.completedByLabel} · {fmtWhen(issue.completedAt)}{issue.completedNote ? ` · ${issue.completedNote}` : ""}</p>}
      {failed && <p className="err" role="alert" data-testid="issue-reason">{failed.state.status === "conflict" ? "Someone else changed this issue. It needs a manager to sort out." : reasonText(failed.state.lastError)}</p>}
      <PhotoStrip ctx={ctx} scope={{ kind: "issue", issueId: issue.id }} photos={sorted} disabled={!may || status !== "open"} />

      {may && panel === "none" && (
        <div className="btnrow">
          {status === "open" && <button onClick={() => { setPanel("complete"); setError(null); }} data-testid="issue-complete">Complete</button>}
          {status === "open" && <button onClick={() => { setPanel("edit"); setError(null); }} data-testid="issue-edit">Edit</button>}
          {status === "completed" && <button onClick={() => void run(() => reopenIssue(issueCtx(ctx), issue.id))} data-testid="issue-reopen">Reopen</button>}
          <button onClick={() => { setPanel("void"); setError(null); }} data-testid="issue-void">Void</button>
        </div>
      )}
      {panel === "complete" && (
        <div className="panel">
          <label>Note <small className="muted">(optional)</small><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Replacement fitted" data-testid="issue-note" /></label>
          <div className="btnrow"><button className="primary" onClick={() => void run(() => completeIssue(issueCtx(ctx), issue.id, note))} data-testid="issue-complete-confirm">Mark complete</button><button onClick={() => setPanel("none")}>Back</button></div>
        </div>
      )}
      {panel === "void" && (
        <div className="panel">
          <p><strong>Void this issue?</strong> It is kept in the history but disappears from this list. This cannot be undone here.</p>
          <label>Reason <small className="muted">(optional)</small><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Raised in the wrong room" data-testid="issue-note" /></label>
          <div className="btnrow"><button className="primary" onClick={() => void run(() => voidIssue(issueCtx(ctx), issue.id, note))} data-testid="issue-void-confirm">Void issue</button><button onClick={() => setPanel("none")}>Back</button></div>
        </div>
      )}
      {panel === "edit" && <EditPanel ctx={ctx} issue={issue} trades={trades} onDone={() => { setPanel("none"); void ctx.sync(); }} onBack={() => setPanel("none")} />}
      {error && <p className="chip bad" role="alert" data-testid="issue-error">{error}</p>}
    </article>
  );
}

function EditPanel({ ctx, issue, trades, onDone, onBack }: { ctx: AppCtx; issue: LocalIssue; trades: TradeRow[]; onDone: () => void; onBack: () => void }) {
  const [kind, setKind] = useState<IssueKind>(issue.kind);
  const [tradeId, setTradeId] = useState<string | null>(issue.tradeId);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [error, setError] = useState<string | null>(null);
  // an existing trade that was deactivated later stays selectable on this issue; new choices are active trades only
  const choices = trades.filter((t) => t.active || t.id === issue.tradeId).sort((a, b) => a.sort_order - b.sort_order);

  async function save() {
    const patch: { kind?: IssueKind; tradeId?: string | null; title?: string; description?: string } = {};
    if (kind !== issue.kind) patch.kind = kind;
    if (title.trim() !== issue.title) patch.title = title;
    if (description.trim() !== issue.description) patch.description = description;
    if (requiresTrade(kind) && tradeId !== issue.tradeId) patch.tradeId = tradeId;
    if (requiresTrade(kind) && kind !== issue.kind && tradeId !== null && patch.tradeId === undefined) patch.tradeId = tradeId;
    const r = await updateIssue(issueCtx(ctx), issue.id, patch);
    if (!r.ok) { setError(r.error.message); return; }
    onDone();
  }
  return (
    <div className="panel" data-testid="edit-panel">
      <label>Kind
        <select value={kind} onChange={(e) => { const k = e.target.value as IssueKind; setKind(k); if (!requiresTrade(k)) setTradeId(null); }} data-testid="edit-kind">
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {requiresTrade(kind) && (
        <div className="pills">{choices.map((t) => <button key={t.id} className={`pill ${tradeId === t.id ? "done" : "none"}`} aria-pressed={tradeId === t.id} onClick={() => setTradeId(t.id)} data-testid={`edit-trade-${t.name.toLowerCase().replace(/\W+/g, "-")}`}>{t.name}</button>)}</div>
      )}
      <label>Title<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="edit-title" /></label>
      <label>Description<textarea value={description} rows={3} maxLength={2000} onChange={(e) => setDescription(e.target.value)} data-testid="edit-desc" /></label>
      {error && <p className="chip bad" role="alert">{error}</p>}
      <div className="btnrow"><button className="primary" onClick={() => void save()} data-testid="edit-save">Save changes</button><button onClick={onBack}>Back</button></div>
    </div>
  );
}

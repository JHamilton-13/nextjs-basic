import { useEffect, useMemo, useState } from "react";
import { issueSaveBlockers, ISSUE_KINDS_BY_CATEGORY, requiresTrade, type IssueCategory, type IssueKind } from "@phc/domain";
import type { AppCtx } from "../App";
import { browserCompress } from "../lib/imaging";
import { CATEGORY_HELP, CATEGORY_LABEL, CATEGORY_ORDER, KIND_LABEL } from "../lib/issueLabels";
import { createIssue } from "../lib/issues";
import type { RoomRow, TradeRow } from "../lib/types";

/** Full-screen form: category, then kind, then (for Pre-Install Corrections) a trade, then title, description and photos. Saves entirely on the phone. */
export function AddIssueSheet({ ctx, room, trades, onClose }: { ctx: AppCtx; room: RoomRow; trades: TradeRow[]; onClose: () => void }) {
  const [category, setCategory] = useState<IssueCategory | null>(null);
  const [kind, setKind] = useState<IssueKind | null>(null);
  const [tradeId, setTradeId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const blockers = category === null ? ["Choose a category"] : issueSaveBlockers({ kind, tradeId, title, photoCount: files.length });
  const activeTrades = trades.filter((t) => t.active).sort((a, b) => a.sort_order - b.sort_order);

  function pickCategory(c: IssueCategory) {
    setCategory(c); setTradeId(null);
    const kinds = ISSUE_KINDS_BY_CATEGORY[c];
    setKind(kinds.length === 1 ? kinds[0]! : null);
  }
  // copy the files NOW: the input's FileList is emptied as soon as its value is reset, before a state update would read it
  function addFiles(list: FileList | null) { const picked = list ? Array.from(list) : []; if (picked.length > 0) setFiles((f) => [...f, ...picked]); }

  async function save() {
    if (kind === null || blockers.length > 0) return;
    setBusy(true); setError(null);
    const r = await createIssue(
      { db: ctx.db, userId: ctx.identity.userId, userLabel: ctx.identity.label, compress: browserCompress, newId: () => crypto.randomUUID(), now: () => new Date().toISOString(), notify: () => ctx.outbox.notify() },
      { roomId: room.id, kind, tradeId, title, description, files },
    );
    if (!r.ok) { setError(r.error.message); setBusy(false); return; }
    void ctx.sync();
    onClose();
  }

  return (
    <div className="sheet" role="dialog" aria-label={`Add issue to ${room.name}`} data-testid="add-issue-sheet">
      <div className="sheet-bar"><strong>Add issue · {room.name}</strong><button onClick={onClose} data-testid="issue-cancel">Cancel</button></div>
      <div className="sheet-body">
        <h3>What kind of issue?</h3>
        <div className="cats">
          {CATEGORY_ORDER.map((c) => (
            <button key={c} className={`cat ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => pickCategory(c)} data-testid={`cat-${c}`}>
              <strong>{CATEGORY_LABEL[c]}</strong><small>{CATEGORY_HELP[c]}</small>
            </button>
          ))}
        </div>

        {category !== null && ISSUE_KINDS_BY_CATEGORY[category].length > 1 && (
          <>
            <h3>Which one?</h3>
            <div className="pills">
              {ISSUE_KINDS_BY_CATEGORY[category].map((k) => (
                <button key={k} className={`pill ${kind === k ? "done" : "none"}`} aria-pressed={kind === k} onClick={() => setKind(k)} data-testid={`kind-${k}`}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          </>
        )}

        {kind !== null && requiresTrade(kind) && (
          <>
            <h3>Trade <small className="muted">(required)</small></h3>
            <div className="pills" data-testid="trade-list">
              {activeTrades.length === 0 && <p className="muted">No trades on this phone yet. Connect once to download them.</p>}
              {activeTrades.map((t) => (
                <button key={t.id} className={`pill ${tradeId === t.id ? "done" : "none"}`} aria-pressed={tradeId === t.id} onClick={() => setTradeId(t.id)} data-testid={`trade-${t.name.toLowerCase().replace(/\W+/g, "-")}`}>{t.name}</button>
              ))}
            </div>
          </>
        )}

        {category !== null && (
          <>
            <label>Title
              <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong?" data-testid="issue-title-input" />
            </label>
            <label>Description <small className="muted">(optional)</small>
              <textarea value={description} rows={3} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="Anything else worth saying" data-testid="issue-desc-input" />
            </label>
            <h3>Photos {kind === "damaged_part" && <small className="muted">(at least one is required)</small>}</h3>
            <div className="thumbs">
              {previews.map((u, i) => (
                <figure key={u}><img src={u} alt={`Photo ${i + 1}`} width={64} height={64} />
                  <button className="small" onClick={() => setFiles((f) => f.filter((_, j) => j !== i))} data-testid="issue-photo-remove">Remove</button></figure>
              ))}
            </div>
            <div className="btnrow">
              <label className="filebtn">Take a photo
                <input type="file" accept="image/*" capture="environment" hidden data-testid="issue-photo-take" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </label>
              <label className="filebtn">Choose from photos
                <input type="file" accept="image/*" multiple hidden data-testid="issue-photo-pick" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
            <p className="muted small">You can mark up a photo with a pen, highlighter or text after the issue is saved.</p>
          </>
        )}
        {error && <p className="chip bad" role="alert">{error}</p>}
      </div>
      <div className="sheet-foot">
        {blockers.length > 0 && <p className="hint" data-testid="issue-blockers">{blockers.join(" · ")}</p>}
        <button className="primary" disabled={blockers.length > 0 || busy} onClick={() => void save()} data-testid="issue-save">{busy ? "Saving…" : "Save issue"}</button>
      </div>
    </div>
  );
}

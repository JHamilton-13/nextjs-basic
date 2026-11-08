import { useState } from "react";
import { evaluate, formatLength, parseLength, type ReadinessState, type ToleranceSource } from "@phc/domain";
import type { AppCtx } from "../App";
import { auditReadiness, groupedItems, recordCheck, recordMeasurement, submitAudit, type CheckResult } from "../lib/audits";
import { browserCompress } from "../lib/imaging";
import { addPhoto } from "../lib/photos";
import type { LocalItem, LocalPhoto } from "../lib/types";
import { useLive } from "./useLive";

const chipFor = (r: LocalItem["result"]) => (r === "PASS" ? "good" : r === "FAIL" ? "bad" : r === "REVIEW" ? "warn" : r === "NOT_ENTERED" ? "gray" : "info");
const STATE_LABEL: Record<ReadinessState, string> = {
  not_started: "Not started", in_progress: "In progress", ready: "Ready", ready_with_exceptions: "Ready with exceptions",
  not_ready: "NOT READY", manager_review_required: "Manager review required", released_for_installation: "Released for installation",
};
const STATE_CLASS: Record<ReadinessState, string> = {
  not_started: "gray", in_progress: "progress", ready: "good", ready_with_exceptions: "warn", not_ready: "bad", manager_review_required: "warn", released_for_installation: "good",
};
const mkCtx = (ctx: AppCtx) => ({ db: ctx.db, outbox: ctx.outbox, userId: ctx.identity.userId, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });

export function AuditView({ ctx, auditId }: { ctx: AppCtx; auditId: string }) {
  const data = useLive(ctx.tick, async () => {
    const audit = await ctx.db.get("audits", auditId);
    const room = audit?.roomId ? await ctx.db.get("rooms", audit.roomId) : undefined;
    const project = audit ? await ctx.db.get("projects", audit.projectId) : undefined;
    const queue = (await ctx.outbox.list()).filter((q) => q.auditId === auditId);
    return { audit, room, project, queue, groups: await groupedItems(ctx.db, auditId), photos: await ctx.db.getAllFromIndex("photos", "by_audit", auditId), ready: await auditReadiness(ctx.db, auditId) };
  }, [auditId]);
  if (!data?.audit) return <p>Loading…</p>;
  const { audit, groups, photos, ready, queue } = data;
  const locked = Boolean(audit.submittedAt);
  const created = queue.find((q) => q.op.entity === "audit" && q.op.payload.action === "create");
  const entered = groups.reduce((n, g) => n + g.entered, 0); const total = groups.reduce((n, g) => n + g.total, 0);
  const photosFor = (key: string | null) => photos.filter((p) => p.itemKey === key);

  return (
    <>
      <button className="link" onClick={() => ctx.go({ name: "projects" })}>← Projects</button>
      <h1>{data.project?.name ?? "Audit"}</h1>
      <p className="muted">{data.room?.name ?? "No room"} · {entered}/{total} items entered{locked ? " · submitted" : ""}</p>
      <p>
        <span className={`chip ${STATE_CLASS[ready.state]}`} data-testid="readiness">{STATE_LABEL[ready.state]}</span>{" "}
        <span className={`chip ${created?.state.status === "confirmed" ? "good" : "warn"}`} data-testid="audit-sync">{created?.state.status === "confirmed" ? "Audit is on the server" : "Audit saved on this device, not synced yet"}</span>
        {ready.fromServer && <small data-testid="server-state"> confirmed by the server</small>}
      </p>
      {ready.criticalFailed.length > 0 && <p className="chip bad" role="alert" data-testid="critical-banner">Critical item failed: this site is NOT READY. Installation cannot start without a manager's documented override.</p>}

      <section className="card">
        <h2>Room photos</h2>
        <PhotoStrip ctx={ctx} auditId={auditId} itemKey={null} photos={photosFor(null)} disabled={false} />
      </section>

      {groups.map((g, idx) => (
        <details key={g.key} open={idx === 0} className="card" data-testid={`section-${g.key}`}>
          <summary><strong>{g.title}</strong><small> · {g.entered}/{g.total}</small></summary>
          {g.items.map((i) => <ItemCard key={i.key} ctx={ctx} item={i} photos={photosFor(i.itemKey)} locked={locked} />)}
        </details>
      ))}

      <SubmitPanel ctx={ctx} auditId={auditId} locked={locked} ready={ready} />
    </>
  );
}

function PhotoStrip({ ctx, auditId, itemKey, photos, disabled }: { ctx: AppCtx; auditId: string; itemKey: string | null; photos: LocalPhoto[]; disabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null);
    for (const f of Array.from(files)) {
      const r = await addPhoto({ ...mkCtx(ctx), compress: browserCompress }, { auditId, itemKey, file: f });
      if (!r.ok) { setError(r.error.message); break; }
    }
    setBusy(false);
    void ctx.sync();
  }
  return (
    <div className="photos">
      <div className="thumbs">
        {photos.map((p) => (
          <figure key={p.id} data-testid="photo-thumb">
            <img src={p.thumb} alt="Site photo" width={64} height={64} />
            <figcaption className={p.confirmed ? "ok" : "wait"} data-testid="photo-status">{p.confirmed ? "Uploaded" : "On this device"}</figcaption>
          </figure>
        ))}
      </div>
      {!disabled && (
        <label className="filebtn">
          {busy ? "Saving photo…" : "Add photo"}
          <input type="file" accept="image/*" capture="environment" multiple hidden data-testid={`photo-input-${itemKey ?? "room"}`} onChange={(e) => { void onFile(e.target.files); e.target.value = ""; }} />
        </label>
      )}
      {error && <p className="chip bad" role="alert">{error}</p>}
    </div>
  );
}

function hints(item: LocalItem, have: number): string[] {
  const out: string[] = [];
  if (item.requires.photo) out.push(`Photo required (${have}/${item.requires.photo})`);
  if (item.requires.note) out.push("Note required");
  if (item.requires.drawingRef) out.push("Drawing reference required");
  if (item.requires.supervisorApproval) out.push("Needs supervisor approval (not available in the app yet)");
  return out;
}

function ItemCard({ ctx, item, photos, locked }: { ctx: AppCtx; item: LocalItem; photos: LocalPhoto[]; locked: boolean }) {
  return (
    <div className="item" data-testid={`item-${item.itemKey}`}>
      <h3>{item.label}{item.critical && <span className="chip bad small-chip"> critical</span>}</h3>
      <p>
        <span className={`chip ${chipFor(item.result)}`} data-testid={`result-${item.itemKey}`}>{item.result === "NOT_ENTERED" ? "Not entered" : item.result === "NOT_APPLICABLE" ? "N/A" : item.result}</span>{" "}
        {item.pending ? <span className="chip warn" data-testid={`pending-${item.itemKey}`}>Waiting to sync</span> : item.result !== "NOT_ENTERED" ? <span className="chip good" data-testid={`synced-${item.itemKey}`}>Synced</span> : null}
      </p>
      {hints(item, photos.length).map((h) => <p key={h} className="hint">{h}</p>)}
      {item.kind === "tolerance" ? <MeasurementForm ctx={ctx} item={item} locked={locked} /> : <CheckForm ctx={ctx} item={item} locked={locked} />}
      <PhotoStrip ctx={ctx} auditId={item.auditId} itemKey={item.itemKey} photos={photos} disabled={false} />
    </div>
  );
}

function CheckForm({ ctx, item, locked }: { ctx: AppCtx; item: LocalItem; locked: boolean }) {
  const [note, setNote] = useState(item.note ?? "");
  const [error, setError] = useState<string | null>(null);
  async function mark(result: CheckResult) {
    setError(null);
    const r = await recordCheck(mkCtx(ctx), { auditId: item.auditId, itemKey: item.itemKey, result, note });
    if (!r.ok) setError(r.error.message); else void ctx.sync();
  }
  if (locked) return item.note ? <p className="muted">Note: {item.note}</p> : null;
  return (
    <>
      <label>Note{item.requires.note ? " (required)" : " (optional)"}<input data-testid="note" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {item.kind === "observation" ? (
        <button className="primary" onClick={() => mark("OBSERVED")} data-testid="mark-observed">Mark observed</button>
      ) : (
        <div className="btnrow">
          <button className="pass" onClick={() => mark("PASS")} data-testid="mark-pass">Pass</button>
          <button className="fail" onClick={() => mark("FAIL")} data-testid="mark-fail">Fail</button>
          <button onClick={() => mark("REVIEW")} data-testid="mark-review">Review</button>
          <button onClick={() => mark("NOT_APPLICABLE")} data-testid="mark-na">N/A</button>
        </div>
      )}
      {error && <p className="chip bad" role="alert" data-testid="save-error">{error}</p>}
    </>
  );
}

function MeasurementForm({ ctx, item, locked }: { ctx: AppCtx; item: LocalItem; locked: boolean }) {
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [drawingRef, setDrawingRef] = useState(item.drawingRef ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live preview using the template's rule data (same engine the server uses).
  const e = parseLength(expected); const a = parseLength(actual);
  let preview: { result: string; dev: string } | null = null;
  if (e.ok && a.ok && item.rule) {
    const ev = evaluate(a.value, {
      expected: e.value, plus: item.rule.plus64, minus: item.rule.minus64,
      ...(item.rule.reviewBand64 !== undefined ? { reviewBand: item.rule.reviewBand64 } : {}),
      source: item.rule.source as ToleranceSource, sourceRef: item.rule.sourceRef, method: item.rule.method,
    });
    if (ev.ok) preview = { result: ev.value.result, dev: (ev.value.deviation >= 0 ? "+" : "-") + formatLength(Math.abs(ev.value.deviation), "fraction") };
  }
  async function save() {
    setError(null);
    const r = await recordMeasurement(mkCtx(ctx), { auditId: item.auditId, itemKey: item.itemKey, expected, actual, drawingRef, note });
    if (!r.ok) { setError(r.error.message); return; }
    setActual(""); setNote("");
    void ctx.sync();
  }
  if (locked) return item.actual64 !== undefined ? <p className="muted">Measured {formatLength(item.actual64, "fraction")} vs {formatLength(item.expected64 ?? 0, "fraction")} on drawing</p> : null;
  return (
    <>
      {item.actual64 !== undefined && <small> last: {formatLength(item.actual64, "fraction")} vs {formatLength(item.expected64 ?? 0, "fraction")}</small>}
      <label>Expected (from approved drawing)<input data-testid="expected" inputMode="text" placeholder={'e.g. 10\' 4 1/2"  or  3150 mm'} value={expected} onChange={(x) => setExpected(x.target.value)} /></label>
      <label>Measured on site<input data-testid="actual" inputMode="text" value={actual} onChange={(x) => setActual(x.target.value)} /></label>
      <label>Drawing reference<input data-testid="drawing-ref" placeholder="e.g. A-201 rev C" value={drawingRef} onChange={(x) => setDrawingRef(x.target.value)} /></label>
      <label>Note (optional)<input value={note} onChange={(x) => setNote(x.target.value)} /></label>
      {preview && <p><span className={`chip ${chipFor(preview.result as LocalItem["result"])}`} data-testid="preview">{preview.result}</span> <small>{preview.dev} from drawing</small></p>}
      {(expected || actual) && (!e.ok || !a.ok) && <p className="muted" data-testid="parse-hint">{!e.ok && expected ? `Expected: ${e.error.message}` : !a.ok && actual ? `Measured: ${a.error.message}` : ""}</p>}
      <button className="primary" onClick={save} data-testid="save-measurement">Save measurement</button>
      {error && <p className="chip bad" role="alert" data-testid="save-error">{error}</p>}
    </>
  );
}

function SubmitPanel({ ctx, auditId, locked, ready }: { ctx: AppCtx; auditId: string; locked: boolean; ready: Awaited<ReturnType<typeof auditReadiness>> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (locked) {
    return (
      <section className="card" data-testid="submitted-panel">
        <h2>Submitted</h2>
        <p>This audit is read-only. A manager decides whether installation can be released{ready.state === "not_ready" ? ", and a documented override is required because a critical item failed" : ""}.</p>
      </section>
    );
  }
  async function submit() {
    const r = await submitAudit(mkCtx(ctx), { auditId });
    if (!r.ok) setError(r.error.message); else { setConfirming(false); void ctx.sync(); }
  }
  return (
    <section className="card" data-testid="submit-panel">
      <h2>Submit audit</h2>
      {ready.notEntered > 0 && <p className="hint" data-testid="warn-not-entered">{ready.notEntered} item(s) have no result. You can still submit; items not entered are not counted.</p>}
      {ready.criticalNotEntered.length > 0 && <p className="chip warn" data-testid="warn-critical-not-entered">Critical items not checked: {ready.criticalNotEntered.join(", ")}</p>}
      {ready.criticalFailed.length > 0 && <p className="chip bad">A critical item failed: this audit will be NOT READY.</p>}
      {!confirming ? (
        <button className="primary" onClick={() => setConfirming(true)} data-testid="submit-audit">Submit audit…</button>
      ) : (
        <>
          <p><strong>Submit now?</strong> After submitting you cannot change results. Photos still on this device will finish uploading.</p>
          <button className="primary" onClick={submit} data-testid="confirm-submit">Yes, submit</button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
      {error && <p className="chip bad" role="alert">{error}</p>}
    </section>
  );
}

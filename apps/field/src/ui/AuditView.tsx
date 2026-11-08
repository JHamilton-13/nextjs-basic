import { useState } from "react";
import { evaluate, formatLength, parseLength, type ToleranceSource } from "@phc/domain";
import type { AppCtx } from "../App";
import { auditSummary, recordMeasurement } from "../lib/audits";
import type { LocalItem } from "../lib/types";
import { useLive } from "./useLive";

const chipFor = (r: LocalItem["result"]) => (r === "PASS" ? "good" : r === "FAIL" ? "bad" : r === "REVIEW" ? "warn" : r === "NOT_ENTERED" ? "gray" : "info");

export function AuditView({ ctx, auditId }: { ctx: AppCtx; auditId: string }) {
  const data = useLive(ctx.tick, async () => {
    const audit = await ctx.db.get("audits", auditId);
    const items = await ctx.db.getAllFromIndex("items", "by_audit", auditId);
    const room = audit?.roomId ? await ctx.db.get("rooms", audit.roomId) : undefined;
    const project = audit ? await ctx.db.get("projects", audit.projectId) : undefined;
    const queue = (await ctx.outbox.list()).filter((q) => q.auditId === auditId);
    return { audit, items, room, project, queue, sum: await auditSummary(ctx.db, auditId) };
  }, [auditId]);
  if (!data?.audit) return <p>Loading…</p>;
  const created = data.queue.find((q) => q.op.entity === "audit");
  const tolerance = data.items.filter((i) => i.kind === "tolerance");
  const others = data.items.filter((i) => i.kind !== "tolerance");

  return (
    <>
      <button className="link" onClick={() => ctx.go({ name: "projects" })}>← Projects</button>
      <h1>{data.project?.name ?? "Audit"}</h1>
      <p className="muted">{data.room?.name ?? "No room"} · {data.sum.entered}/{data.sum.total} items entered</p>
      <p><span className={`chip ${created?.state.status === "confirmed" ? "good" : "warn"}`} data-testid="audit-sync">{created?.state.status === "confirmed" ? "Audit is on the server" : "Audit saved on this device, not synced yet"}</span></p>
      {data.sum.criticalFail && <p className="chip bad" role="alert">Critical item failed: this site is NOT READY.</p>}

      <h2>Measurements</h2>
      {tolerance.map((i) => <MeasurementCard key={i.key} ctx={ctx} item={i} />)}

      <details>
        <summary>Other checklist items ({others.length}) — added in the next step</summary>
        <ul className="plain">{others.map((i) => <li key={i.key}>{i.label}{i.critical ? " (critical)" : ""}</li>)}</ul>
      </details>
    </>
  );
}

function MeasurementCard({ ctx, item }: { ctx: AppCtx; item: LocalItem }) {
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
    const r = await recordMeasurement(
      { db: ctx.db, outbox: ctx.outbox, userId: ctx.identity.userId, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() },
      { auditId: item.auditId, itemKey: item.itemKey, expected, actual, drawingRef, note },
    );
    if (!r.ok) { setError(r.error.message); return; }
    setActual(""); setNote("");
    void ctx.sync();
  }

  return (
    <section className="card" data-testid={`item-${item.itemKey}`}>
      <h3>{item.label}</h3>
      <p>
        <span className={`chip ${chipFor(item.result)}`} data-testid={`result-${item.itemKey}`}>{item.result === "NOT_ENTERED" ? "Not entered" : item.result}</span>{" "}
        {item.pending ? <span className="chip warn" data-testid={`pending-${item.itemKey}`}>Waiting to sync</span> : item.result !== "NOT_ENTERED" ? <span className="chip good" data-testid={`synced-${item.itemKey}`}>Synced</span> : null}
        {item.actual64 !== undefined && <small> last: {formatLength(item.actual64, "fraction")} vs {formatLength(item.expected64 ?? 0, "fraction")}</small>}
      </p>
      <label>Expected (from approved drawing)<input data-testid="expected" inputMode="text" placeholder={'e.g. 10\' 4 1/2"  or  3150 mm'} value={expected} onChange={(x) => setExpected(x.target.value)} /></label>
      <label>Measured on site<input data-testid="actual" inputMode="text" value={actual} onChange={(x) => setActual(x.target.value)} /></label>
      <label>Drawing reference<input data-testid="drawing-ref" placeholder="e.g. A-201 rev C" value={drawingRef} onChange={(x) => setDrawingRef(x.target.value)} /></label>
      <label>Note (optional)<input value={note} onChange={(x) => setNote(x.target.value)} /></label>
      {preview && <p><span className={`chip ${chipFor(preview.result as LocalItem["result"])}`} data-testid="preview">{preview.result}</span> <small>{preview.dev} from drawing</small></p>}
      {(expected || actual) && (!e.ok || !a.ok) && <p className="muted" data-testid="parse-hint">{!e.ok && expected ? `Expected: ${e.error.message}` : !a.ok && actual ? `Measured: ${a.error.message}` : ""}</p>}
      <button className="primary" onClick={save} data-testid="save-measurement">Save measurement</button>
      {error && <p className="chip bad" role="alert" data-testid="save-error">{error}</p>}
    </section>
  );
}

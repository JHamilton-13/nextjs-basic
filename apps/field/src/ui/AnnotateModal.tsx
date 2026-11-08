import { useEffect, useRef, useState } from "react";
import type { AppCtx } from "../App";
import { drawShapes, ERASER_RADIUS, hitsShape, PALETTE, simplifyPoints, type Pt, type Shape } from "../lib/annotations";
import { flattenAnnotated } from "../lib/imaging";
import { addAnnotatedIssuePhoto, addAnnotatedPhoto } from "../lib/photos";
import type { LocalPhoto } from "../lib/types";

type Tool = "pen" | "highlight" | "text" | "erase";
const WIDTHS = [0.004, 0.008, 0.016];          // pen width as a fraction of the image width
const TEXT_SIZES = [0.035, 0.05, 0.075];        // text height as a fraction of the image height

/**
 * Full-screen editor: freehand pen, highlighter, text. Marks are kept as normalized vector shapes. Saving never touches the
 * original photo: it creates a new annotated copy (flattened image + editable marks) that is queued for upload.
 */
export function AnnotateModal({ ctx, source, original, initial, onClose }: { ctx: AppCtx; source: Blob; original: LocalPhoto; initial: Shape[]; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const live = useRef<Pt[] | null>(null);
  const [shapes, setShapes] = useState<Shape[]>(initial);
  const cur = useRef<Shape[]>(initial);            // always the latest marks (state can lag inside pointer handlers)
  const [past, setPast] = useState<Shape[][]>([]);   // undo history: every add, erase gesture and clear is one step
  const erasing = useRef<{ pushed: boolean } | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [colorIdx, setColorIdx] = useState(0);
  const [thick, setThick] = useState(1);
  const [pending, setPending] = useState<Pt | null>(null);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const color = PALETTE[colorIdx]!;

  useEffect(() => {
    const url = URL.createObjectURL(source);
    const im = new Image();
    im.onload = () => {
      img.current = im;
      const c = canvas.current!; const scale = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
      c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
      setReady(true);
    };
    im.onerror = () => setError("This photo could not be opened.");
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [source]);

  // Size the canvas by measuring the space left between the bar and the tools (percent heights are unreliable on iOS Safari),
  // keeping the photo's aspect ratio. Re-fit when the phone rotates or the on-screen keyboard changes the height.
  useEffect(() => {
    const fit = () => {
      const c = canvas.current; const w = wrap.current; if (!c || !w || !c.width || !c.height) return;
      const s = Math.min(w.clientWidth / c.width, w.clientHeight / c.height);
      c.style.width = `${Math.max(1, Math.floor(c.width * s))}px`; c.style.height = `${Math.max(1, Math.floor(c.height * s))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit); if (wrap.current) ro.observe(wrap.current);
    window.addEventListener("orientationchange", fit);
    return () => { ro.disconnect(); window.removeEventListener("orientationchange", fit); };
  }, [ready]);

  function paint(extra?: Shape) {
    const c = canvas.current; const im = img.current; if (!c || !im) return;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(im, 0, 0, c.width, c.height);
    drawShapes(g, extra ? [...shapes, extra] : shapes, c.width, c.height);
  }
  useEffect(() => { if (ready) paint(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shapes, ready]);

  const at = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const strokeShape = (points: Pt[]): Shape => ({ type: tool === "highlight" ? "highlight" : "pen", color, width: WIDTHS[thick]! * (tool === "highlight" ? 3 : 1), points });

  function commit(next: Shape[]) { const prev = cur.current; setPast((p) => [...p, prev]); cur.current = next; setShapes(next); }
  function undo() { const prev = past[past.length - 1]; if (!prev) return; cur.current = prev; setShapes(prev); setPast((p) => p.slice(0, -1)); }
  function erase(p: Pt) {
    const c = canvas.current!; const g = erasing.current!;
    const keep = cur.current.filter((s) => !hitsShape(s, p, ERASER_RADIUS, c.width, c.height));
    if (keep.length === cur.current.length) return;
    if (!g.pushed) { g.pushed = true; const prev = cur.current; setPast((q) => [...q, prev]); }     // one undo step per drag
    cur.current = keep; setShapes(keep);
  }

  function down(e: React.PointerEvent) {
    if (!ready) return;
    e.preventDefault();
    if (tool === "erase") { (e.target as Element).setPointerCapture(e.pointerId); erasing.current = { pushed: false }; erase(at(e)); return; }
    if (tool === "text") { setPending(at(e)); setText(""); return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    live.current = [at(e)];
    paint(strokeShape(live.current));
  }
  function move(e: React.PointerEvent) {
    if (erasing.current) { erase(at(e)); return; }
    if (!live.current) return;
    live.current.push(at(e));
    paint(strokeShape(live.current));
  }
  function up() {
    if (erasing.current) { erasing.current = null; return; }
    if (!live.current) return;
    const pts = simplifyPoints(live.current);
    live.current = null;
    commit([...cur.current, strokeShape(pts)]);
  }
  function addText() {
    if (!pending || !text.trim()) return;
    commit([...cur.current, { type: "text", color, size: TEXT_SIZES[thick]!, at: pending, text: text.trim().slice(0, 200) }]);
    setPending(null); setText("");
  }
  async function save() {
    setSaving(true); setError(null);
    try {
      const flattened = await flattenAnnotated(source, shapes);
      const base = { db: ctx.db, userId: ctx.identity.userId, userLabel: ctx.identity.label, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() };
      const r = original.issueId
        ? await addAnnotatedIssuePhoto({ ...base, compress: async (f) => ({ blob: f, thumb: "", mime: "image/jpeg", original: f }), notify: () => ctx.outbox.notify() }, { originalId: original.id, shapes, flattened })
        : await addAnnotatedPhoto({ ...base, outbox: ctx.outbox }, { originalId: original.id, shapes, flattened });
      if (!r.ok) { setError(r.error.message); setSaving(false); return; }
      void ctx.sync();
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSaving(false); }
  }

  return (
    <div className="modal" role="dialog" aria-label="Annotate photo" data-testid="annotate-modal">
      <div className="modal-bar">
        <button onClick={onClose} data-testid="cancel-annotation">Cancel</button>
        <strong>Mark up photo</strong>
        <button className="primary" disabled={!ready || saving || shapes.length === 0} onClick={save} data-testid="save-annotation">{saving ? "Saving…" : "Save copy"}</button>
      </div>
      <div className="canvas-wrap" ref={wrap}><canvas ref={canvas} className="annot" data-testid="annotate-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} /></div>
      {pending && (
        <div className="textrow">
          <input autoFocus placeholder="Type a short note" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addText(); }} data-testid="text-input" />
          <button className="primary" onClick={addText} data-testid="text-add">Add</button>
        </div>
      )}
      <div className="tools" data-testid="tools" data-marks={shapes.length}>
        <div className="toolrow">
          {(["pen", "highlight", "text", "erase"] as Tool[]).map((t) => (
            <button key={t} className={tool === t ? "on" : ""} onClick={() => { setTool(t); setPending(null); }} data-testid={`tool-${t}`}>{t === "pen" ? "Pen" : t === "highlight" ? "Highlight" : t === "text" ? "Text" : "Erase"}</button>
          ))}
          <button disabled={past.length === 0} onClick={undo} data-testid="undo">Undo</button>
        </div>
        <div className="toolrow">
          {PALETTE.map((c, i) => <button key={c} aria-label={`Color ${i + 1}`} className={`sw ${colorIdx === i ? "on" : ""}`} style={{ background: c }} onClick={() => setColorIdx(i)} data-testid={`color-${i}`} />)}
        </div>
        <div className="toolrow">
          {["Thin", "Medium", "Thick"].map((l, i) => <button key={l} className={thick === i ? "on" : ""} onClick={() => setThick(i)} data-testid={`thick-${i}`}>{l}</button>)}
          <button disabled={shapes.length === 0} onClick={() => commit([])} data-testid="clear">Clear</button>
        </div>
      </div>
      <p className="muted small note">The original photo is never changed. Saving creates a marked-up copy.</p>
      {error && <p className="chip bad" role="alert">{error}</p>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { AppCtx } from "../App";
import { drawShapes, PALETTE, simplifyPoints, type Pt, type Shape } from "../lib/annotations";
import { flattenAnnotated } from "../lib/imaging";
import { addAnnotatedPhoto } from "../lib/photos";
import type { LocalPhoto } from "../lib/types";

type Tool = "pen" | "highlight" | "text";
const WIDTHS = [0.004, 0.008, 0.016];          // pen width as a fraction of the image width
const TEXT_SIZES = [0.035, 0.05, 0.075];        // text height as a fraction of the image height

/**
 * Full-screen editor: freehand pen, highlighter, text. Marks are kept as normalized vector shapes. Saving never touches the
 * original photo: it creates a new annotated copy (flattened image + editable marks) that is queued for upload.
 */
export function AnnotateModal({ ctx, source, original, initial, onClose }: { ctx: AppCtx; source: Blob; original: LocalPhoto; initial: Shape[]; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const live = useRef<Pt[] | null>(null);
  const [shapes, setShapes] = useState<Shape[]>(initial);
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

  function down(e: React.PointerEvent) {
    if (!ready) return;
    e.preventDefault();
    if (tool === "text") { setPending(at(e)); setText(""); return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    live.current = [at(e)];
    paint(strokeShape(live.current));
  }
  function move(e: React.PointerEvent) {
    if (!live.current) return;
    live.current.push(at(e));
    paint(strokeShape(live.current));
  }
  function up() {
    if (!live.current) return;
    const pts = simplifyPoints(live.current);
    live.current = null;
    setShapes((s) => [...s, strokeShape(pts)]);
  }
  function addText() {
    if (!pending || !text.trim()) return;
    setShapes((s) => [...s, { type: "text", color, size: TEXT_SIZES[thick]!, at: pending, text: text.trim().slice(0, 200) }]);
    setPending(null); setText("");
  }
  async function save() {
    setSaving(true); setError(null);
    try {
      const flattened = await flattenAnnotated(source, shapes);
      const r = await addAnnotatedPhoto(
        { db: ctx.db, outbox: ctx.outbox, userId: ctx.identity.userId, userLabel: ctx.identity.label, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() },
        { originalId: original.id, shapes, flattened },
      );
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
      <div className="canvas-wrap"><canvas ref={canvas} className="annot" data-testid="annotate-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} /></div>
      {pending && (
        <div className="textrow">
          <input autoFocus placeholder="Type a short note" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addText(); }} data-testid="text-input" />
          <button className="primary" onClick={addText} data-testid="text-add">Add</button>
        </div>
      )}
      <div className="tools">
        {(["pen", "highlight", "text"] as Tool[]).map((t) => (
          <button key={t} className={tool === t ? "on" : ""} onClick={() => { setTool(t); setPending(null); }} data-testid={`tool-${t}`}>{t === "pen" ? "Pen" : t === "highlight" ? "Highlighter" : "Text"}</button>
        ))}
        <span className="swatches">{PALETTE.map((c, i) => <button key={c} aria-label={`Color ${i + 1}`} className={`sw ${colorIdx === i ? "on" : ""}`} style={{ background: c }} onClick={() => setColorIdx(i)} data-testid={`color-${i}`} />)}</span>
        <span>{["Thin", "Medium", "Thick"].map((l, i) => <button key={l} className={thick === i ? "on" : ""} onClick={() => setThick(i)} data-testid={`thick-${i}`}>{l}</button>)}</span>
        <button disabled={shapes.length === 0} onClick={() => setShapes((s) => s.slice(0, -1))} data-testid="undo">Undo</button>
        <button disabled={shapes.length === 0} onClick={() => setShapes([])}>Clear</button>
      </div>
      <p className="muted small">The original photo is never changed. Saving creates a marked-up copy.</p>
      {error && <p className="chip bad" role="alert">{error}</p>}
    </div>
  );
}

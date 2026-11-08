import { err, ok, type Result } from "@phc/domain";

/**
 * Annotations are stored as editable vector shapes with coordinates NORMALIZED to the image (0..1), so they stay
 * correct at any display or export size. First version: freehand pen, highlighter, text label.
 * The rules below mirror app.annotations_valid() in the database; the server re-validates everything.
 */
export type Pt = [number, number];
export interface StrokeShape { type: "pen" | "highlight"; color: string; /** fraction of image width */ width: number; points: Pt[] }
export interface TextShape { type: "text"; color: string; /** fraction of image height */ size: number; at: Pt; text: string }
export type Shape = StrokeShape | TextShape;

export const PALETTE = ["#e53935", "#fdd835", "#1e88e5", "#111111", "#43a047"] as const;
export const LIMITS = { shapes: 200, points: 2000, text: 200 } as const;
export const HIGHLIGHT_ALPHA = 0.35;

const COLOR = /^#[0-9a-fA-F]{6}$/;
const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const pt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;

export type AnnotationError = { code: "invalid_annotations"; message: string };
const bad = (message: string) => err<AnnotationError>({ code: "invalid_annotations", message });

export function validateShapes(x: unknown): Result<Shape[], AnnotationError> {
  if (!Array.isArray(x) || x.length < 1) return bad("Add at least one mark before saving.");
  if (x.length > LIMITS.shapes) return bad(`Too many marks (limit ${LIMITS.shapes}).`);
  const out: Shape[] = [];
  for (const s of x as Record<string, unknown>[]) {
    if (typeof s !== "object" || s === null) return bad("Invalid mark.");
    if (typeof s.color !== "string" || !COLOR.test(s.color)) return bad("Invalid color.");
    if (s.type === "pen" || s.type === "highlight") {
      if (!num(s.width) || s.width <= 0 || s.width > 0.2) return bad("Invalid line width.");
      if (!Array.isArray(s.points) || s.points.length < 1 || s.points.length > LIMITS.points || !s.points.every(pt)) return bad("Invalid line.");
      out.push({ type: s.type, color: s.color, width: s.width, points: (s.points as Pt[]).map((p) => [p[0], p[1]]) });
    } else if (s.type === "text") {
      if (typeof s.text !== "string" || s.text.trim() === "" || s.text.length > LIMITS.text) return bad("Invalid text.");
      if (!num(s.size) || s.size < 0.005 || s.size > 0.3) return bad("Invalid text size.");
      if (!pt(s.at)) return bad("Invalid text position.");
      out.push({ type: "text", color: s.color, size: s.size, at: [s.at[0], s.at[1]], text: s.text });
    } else return bad("Unsupported mark type.");
  }
  return ok(out);
}

/** Evenly thins a long stroke to at most `max` points, always keeping the first and last point. */
export function simplifyPoints(points: Pt[], max: number = LIMITS.points): Pt[] {
  if (points.length <= max) return points;
  const out: Pt[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/** The subset of CanvasRenderingContext2D we draw with (so drawing can be tested without a browser). */
export interface Canvas2DLike {
  save(): void; restore(): void; beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  stroke(): void; fillText(t: string, x: number, y: number): void; strokeText(t: string, x: number, y: number): void;
  strokeStyle: string | CanvasGradient | CanvasPattern; fillStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; lineCap: string; lineJoin: string; globalAlpha: number; font: string; textBaseline: string;
}

/** Draws shapes onto a w x h canvas. Used both for the live editor and for the flattened copy that gets uploaded. */
export function drawShapes(c: Canvas2DLike, shapes: Shape[], w: number, h: number): void {
  for (const s of shapes) {
    c.save();
    if (s.type === "text") {
      const px = Math.max(8, Math.round(s.size * h));
      c.font = `700 ${px}px system-ui, -apple-system, sans-serif`;
      c.textBaseline = "top";
      c.lineJoin = "round";
      c.strokeStyle = "#ffffff"; c.lineWidth = Math.max(2, px * 0.18); c.globalAlpha = 1;
      c.strokeText(s.text, s.at[0] * w, s.at[1] * h);     // light outline keeps the label legible on any photo
      c.fillStyle = s.color;
      c.fillText(s.text, s.at[0] * w, s.at[1] * h);
    } else {
      c.strokeStyle = s.color;
      c.lineWidth = Math.max(1, s.width * w);
      c.lineCap = "round"; c.lineJoin = "round";
      c.globalAlpha = s.type === "highlight" ? HIGHLIGHT_ALPHA : 1;
      c.beginPath();
      const [first, ...rest] = s.points;
      c.moveTo(first![0] * w, first![1] * h);
      if (rest.length === 0) c.lineTo(first![0] * w, first![1] * h); // a tap draws a dot
      for (const p of rest) c.lineTo(p[0] * w, p[1] * h);
      c.stroke();
    }
    c.restore();
  }
}

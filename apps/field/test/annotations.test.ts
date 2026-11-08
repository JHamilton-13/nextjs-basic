import { describe, it, expect } from "vitest";
import { drawShapes, simplifyPoints, validateShapes, PALETTE, type Canvas2DLike, type Shape } from "../src/lib/annotations";

const pen: Shape = { type: "pen", color: "#e53935", width: 0.01, points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]] };
const hi: Shape = { type: "highlight", color: "#fdd835", width: 0.03, points: [[0, 0], [1, 1]] };
const txt: Shape = { type: "text", color: "#111111", size: 0.05, at: [0.2, 0.3], text: "outlet here" };

describe("validateShapes (mirrors the database CHECK)", () => {
  it("accepts pen, highlighter and text shapes", () => {
    const r = validateShapes([pen, hi, txt]);
    expect(r.ok).toBe(true);
  });
  it("rejects anything else: arrows, empty lists, non-arrays", () => {
    expect(validateShapes([{ type: "arrow", color: "#ff0000", width: 0.01, points: [[0, 0]] }]).ok).toBe(false);
    expect(validateShapes([]).ok).toBe(false);
    expect(validateShapes("nope").ok).toBe(false);
    expect(validateShapes(null).ok).toBe(false);
  });
  it("rejects bad coordinates, widths, colors and text", () => {
    const bad = (s: unknown) => expect(validateShapes([s]).ok).toBe(false);
    bad({ ...pen, points: [[1.01, 0.5]] });
    bad({ ...pen, points: [[-0.1, 0.5]] });
    bad({ ...pen, points: [[Number.NaN, 0.5]] });
    bad({ ...pen, points: [] });
    bad({ ...pen, width: 0 });
    bad({ ...pen, width: 0.5 });
    bad({ ...pen, color: "red" });
    bad({ ...txt, text: "   " });
    bad({ ...txt, text: "x".repeat(201) });
    bad({ ...txt, size: 0.001 });
    bad({ ...txt, at: [0.5] });
  });
  it("enforces the 200-shape and 2000-point limits", () => {
    expect(validateShapes(Array.from({ length: 200 }, () => pen)).ok).toBe(true);
    expect(validateShapes(Array.from({ length: 201 }, () => pen)).ok).toBe(false);
    expect(validateShapes([{ ...pen, points: Array.from({ length: 2000 }, () => [0.5, 0.5]) }]).ok).toBe(true);
    expect(validateShapes([{ ...pen, points: Array.from({ length: 2001 }, () => [0.5, 0.5]) }]).ok).toBe(false);
  });
  it("returns a copy containing only known fields", () => {
    const r = validateShapes([{ ...pen, evil: "x" }]);
    expect(r.ok && Object.keys(r.value[0]!).sort()).toEqual(["color", "points", "type", "width"]);
  });
  it("palette colors are valid", () => { for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/i); });
});

describe("simplifyPoints", () => {
  it("keeps short strokes unchanged and caps long ones while keeping the first and last point", () => {
    expect(simplifyPoints([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
    const long = Array.from({ length: 5000 }, (_, i) => [i / 5000, 0.5] as [number, number]);
    const s = simplifyPoints(long, 2000);
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s[0]).toEqual(long[0]); expect(s[s.length - 1]).toEqual(long[long.length - 1]);
  });
});

function recorder() {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const c = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => (k in state ? state[k] : (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x)).join(",")})@a=${state.globalAlpha ?? 1},w=${state.lineWidth ?? ""},s=${state.strokeStyle ?? ""}`); }),
    set: (_t, k: string, v) => { state[k] = v; return true; },
  });
  return { c: c as unknown as Canvas2DLike, calls, state };
}

describe("drawShapes (normalized coordinates scale to any image size)", () => {
  it("draws strokes at pixel positions and widths scaled to the image", () => {
    const { c, calls } = recorder();
    drawShapes(c, [pen], 2000, 1000);
    expect(calls.filter((x) => x.startsWith("moveTo"))[0]).toContain("moveTo(200,100)");
    expect(calls.some((x) => x.startsWith("lineTo(1000,500)"))).toBe(true);
    expect(calls.some((x) => x.startsWith("stroke") && x.includes("w=20") && x.includes("s=#e53935"))).toBe(true);
  });
  it("the same shapes on a half-size image land at half the pixels", () => {
    const a = recorder(); const b = recorder();
    drawShapes(a.c, [pen], 2000, 1000); drawShapes(b.c, [pen], 1000, 500);
    expect(a.calls.find((x) => x.startsWith("lineTo"))).toContain("lineTo(1000,500)");
    expect(b.calls.find((x) => x.startsWith("lineTo"))).toContain("lineTo(500,250)");
  });
  it("highlighter is semi-transparent; pen is opaque", () => {
    const h = recorder(); drawShapes(h.c, [hi], 1000, 1000);
    expect(h.calls.find((x) => x.startsWith("stroke"))).toContain("a=0.35");
    const p = recorder(); drawShapes(p.c, [pen], 1000, 1000);
    expect(p.calls.find((x) => x.startsWith("stroke"))).toContain("a=1");
  });
  it("draws a dot for a single-point stroke and text at its position", () => {
    const r = recorder(); drawShapes(r.c, [{ ...pen, points: [[0.5, 0.5]] }, txt], 1000, 1000);
    expect(r.calls.filter((x) => x.startsWith("lineTo")).length).toBe(1);
    expect(r.calls.some((x) => x.startsWith("fillText(outlet here,200,300)"))).toBe(true);
    expect(r.state.font).toContain("50px");
  });
  it("restores the canvas state after every shape", () => {
    const r = recorder(); drawShapes(r.c, [pen, hi, txt], 100, 100);
    expect(r.calls.filter((x) => x.startsWith("save")).length).toBe(3);
    expect(r.calls.filter((x) => x.startsWith("restore")).length).toBe(3);
  });
});

import { hitsShape, ERASER_RADIUS } from "../src/lib/annotations";
describe("eraser hit-testing", () => {
  const line: Shape = { type: "pen", color: "#e53935", width: 0.004, points: [[0.1, 0.5], [0.9, 0.5]] };
  const dot: Shape = { type: "pen", color: "#e53935", width: 0.004, points: [[0.5, 0.5]] };
  const label: Shape = { type: "text", color: "#111111", size: 0.05, at: [0.2, 0.2], text: "Move fan" };
  it("hits a stroke when the touch is on or near it", () => {
    expect(hitsShape(line, [0.5, 0.5], ERASER_RADIUS, 1000, 1000)).toBe(true);
    expect(hitsShape(line, [0.5, 0.52], ERASER_RADIUS, 1000, 1000)).toBe(true);
  });
  it("misses a stroke when the touch is clearly away from it", () => {
    expect(hitsShape(line, [0.5, 0.7], ERASER_RADIUS, 1000, 1000)).toBe(false);
    expect(hitsShape(line, [0.95, 0.5], 0.01, 1000, 1000)).toBe(false);
  });
  it("handles a single-point dot and a text label", () => {
    expect(hitsShape(dot, [0.5, 0.51], ERASER_RADIUS, 1000, 1000)).toBe(true);
    expect(hitsShape(dot, [0.8, 0.8], ERASER_RADIUS, 1000, 1000)).toBe(false);
    expect(hitsShape(label, [0.25, 0.22], ERASER_RADIUS, 1000, 1000)).toBe(true);
    expect(hitsShape(label, [0.8, 0.9], ERASER_RADIUS, 1000, 1000)).toBe(false);
  });
  it("accounts for a non-square image", () => {
    // 2000x1000: a 0.035-of-width radius is 70px, so 60px above the line is a hit but 100px is not
    expect(hitsShape(line, [0.5, 0.56], ERASER_RADIUS, 2000, 1000)).toBe(true);
    expect(hitsShape(line, [0.5, 0.62], ERASER_RADIUS, 2000, 1000)).toBe(false);
  });
});

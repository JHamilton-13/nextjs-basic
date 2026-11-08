import { describe, it, expect } from "vitest";
import { evaluate, validateRule, buildMeasurement, type ToleranceRule } from "../src/tolerance";
import { parseLength } from "../src/units";

const L = (s: string) => {
  const r = parseLength(s);
  if (!r.ok) throw new Error(s);
  return r.value;
};

// Rule DATA (company decision 2026-11-07): +/- 1/2", review band 1" total deviation.
// The engine has no built-in numbers; these come from the audit template.
const wallRule = (expected: string): ToleranceRule => ({
  expected: L(expected),
  plus: L('1/2"'),
  minus: L('1/2"'),
  reviewBand: L('1"'),
  source: "company_standard",
  sourceRef: "Owner decision 2026-11-07",
  method: "tape measure",
});

const res = (actual: string, rule: ToleranceRule) => {
  const r = evaluate(L(actual), rule);
  if (!r.ok) throw new Error(`rule error ${r.error.code}`);
  return r.value;
};

describe("evaluate: boundaries at exactly 1/2\" and 1\" (expected 120\")", () => {
  const rule = wallRule('120"');
  it("exact match is PASS", () => {
    expect(res('120"', rule).result).toBe("PASS");
    expect(res('120"', rule).deviation).toBe(0);
  });
  it("exactly +1/2\" is PASS (inclusive)", () => {
    expect(res('120 1/2"', rule).result).toBe("PASS");
  });
  it("exactly -1/2\" is PASS (inclusive)", () => {
    expect(res('119 1/2"', rule).result).toBe("PASS");
  });
  it("1/64\" over +1/2\" is REVIEW", () => {
    expect(res('120 33/64"', rule).result).toBe("REVIEW");
  });
  it("1/64\" under -1/2\" is REVIEW", () => {
    expect(res('119 31/64"', rule).result).toBe("REVIEW");
  });
  it("exactly +1\" is REVIEW (inclusive)", () => {
    expect(res('121"', rule).result).toBe("REVIEW");
  });
  it("exactly -1\" is REVIEW (inclusive)", () => {
    expect(res('119"', rule).result).toBe("REVIEW");
  });
  it("1/64\" over +1\" is FAIL", () => {
    expect(res('121 1/64"', rule).result).toBe("FAIL");
  });
  it("1/64\" under -1\" is FAIL", () => {
    expect(res('118 63/64"', rule).result).toBe("FAIL");
  });
  it("reports signed deviation in 1/64 units", () => {
    expect(res('121"', rule).deviation).toBe(64);
    expect(res('119"', rule).deviation).toBe(-64);
  });
  it("works for a ceiling height example too (96\" expected)", () => {
    const r = wallRule('96"');
    expect(res('96 1/2"', r).result).toBe("PASS");
    expect(res('97"', r).result).toBe("REVIEW");
    expect(res('97 1/16"', r).result).toBe("FAIL");
  });
});

describe("evaluate: rule data drives everything (nothing hardcoded)", () => {
  it("different rule, different boundaries", () => {
    const tight: ToleranceRule = { ...wallRule('100"'), plus: L('1/8"'), minus: L('1/8"'), reviewBand: L('1/4"') };
    expect(res('100 1/8"', tight).result).toBe("PASS");
    expect(res('100 9/64"', tight).result).toBe("REVIEW");
    expect(res('100 1/4"', tight).result).toBe("REVIEW");
    expect(res('100 17/64"', tight).result).toBe("FAIL");
  });
  it("asymmetric tolerance", () => {
    const rule: ToleranceRule = { ...wallRule('100"'), plus: L('1/4"'), minus: L('1/16"'), reviewBand: L('1/2"') };
    expect(res('100 1/4"', rule).result).toBe("PASS");
    expect(res('99 15/16"', rule).result).toBe("PASS");
    expect(res('99 63/64"', rule).result).toBe("PASS");
    expect(res('99 59/64"', rule).result).toBe("REVIEW"); // 5/64 under, minus is 4/64
  });
  it("no review band means over tolerance is FAIL", () => {
    const { reviewBand: _rb, ...rest } = wallRule('100"');
    const rule: ToleranceRule = rest;
    expect(res('100 33/64"', rule).result).toBe("FAIL");
  });
  it("zero tolerance: only exact match passes", () => {
    const rule: ToleranceRule = { ...wallRule('10"'), plus: 0, minus: 0 };
    expect(res('10"', rule).result).toBe("PASS");
    expect(res('10 1/64"', rule).result).toBe("REVIEW"); // still inside band
  });
});

describe("validateRule", () => {
  it("rejects reviewBand smaller than tolerance", () => {
    const bad: ToleranceRule = { ...wallRule('100"'), reviewBand: L('1/4"') };
    const r = evaluate(L('100"'), bad);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("review_band_smaller_than_tolerance");
    expect(validateRule(bad).ok).toBe(false);
  });
  it("rejects negative or non-integer values", () => {
    expect(validateRule({ ...wallRule('100"'), plus: -1 }).ok).toBe(false);
    expect(validateRule({ ...wallRule('100"'), minus: 0.5 }).ok).toBe(false);
    expect(validateRule({ ...wallRule('100"'), expected: Number.NaN }).ok).toBe(false);
  });
  it("rejects non-integer actual", () => {
    const r = evaluate(1.5, wallRule('100"'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("invalid_actual");
  });
  it("accepts a valid rule", () => {
    expect(validateRule(wallRule('100"')).ok).toBe(true);
  });
});

describe("buildMeasurement: full record per spec", () => {
  it("records expected, actual, tolerance, method, user, time, photos, drawing ref, note, result", () => {
    const rule = wallRule('144"');
    const m = buildMeasurement({
      actual: L('145"'),
      rule,
      userId: "user-1",
      timestamp: "2026-11-08T10:00:00.000Z",
      photoIds: ["p1"],
      drawingRef: "A-201 rev C",
      note: "north wall",
    });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value).toMatchObject({
      expected: L('144"'),
      actual: L('145"'),
      plus: L('1/2"'),
      minus: L('1/2"'),
      reviewBand: L('1"'),
      method: "tape measure",
      userId: "user-1",
      timestamp: "2026-11-08T10:00:00.000Z",
      photoIds: ["p1"],
      drawingRef: "A-201 rev C",
      note: "north wall",
      result: "REVIEW",
      deviation: 64,
    });
  });
  it("rejects bad timestamps / missing user", () => {
    const rule = wallRule('144"');
    expect(buildMeasurement({ actual: 1, rule, userId: "", timestamp: "2026-11-08T10:00:00.000Z" }).ok).toBe(false);
    expect(buildMeasurement({ actual: 1, rule, userId: "u", timestamp: "not a date" }).ok).toBe(false);
  });
});

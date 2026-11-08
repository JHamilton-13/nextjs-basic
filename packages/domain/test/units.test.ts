import { describe, it, expect } from "vitest";
import { parseLength, formatLength, parseMoisture, formatMoisture, inchesToLength, mmToLength, lengthToMm } from "../src/units";

const ok = (s: string, opts?: Parameters<typeof parseLength>[1]) => {
  const r = parseLength(s, opts);
  if (!r.ok) throw new Error(`expected ok for "${s}": ${r.error.code}`);
  return r.value;
};
const errCode = (s: string, opts?: Parameters<typeof parseLength>[1]) => {
  const r = parseLength(s, opts);
  if (r.ok) throw new Error(`expected error for "${s}", got ${r.value}`);
  return r.error.code;
};

describe("parseLength: canonical unit is integer 1/64 inch", () => {
  it("parses whole inches", () => {
    expect(ok('3"')).toBe(192);
    expect(ok("3 in")).toBe(192);
    expect(ok("3 inches")).toBe(192);
  });
  it("parses fractional inches", () => {
    expect(ok('3 5/8"')).toBe(3 * 64 + 40);
    expect(ok('5/8"')).toBe(40);
    expect(ok('1/64"')).toBe(1);
    expect(ok('63/64"')).toBe(63);
    expect(ok("3-5/8")).toBe(232);
  });
  it("parses decimal inches (rounded to nearest 1/64)", () => {
    expect(ok('3.625"')).toBe(232);
    expect(ok("0.5")).toBe(32);
    expect(ok("0.015625")).toBe(1);
    expect(ok("0.0156")).toBe(1);
    expect(ok("0.0234")).toBe(1); // 1.4976/64 -> 1
    expect(ok("0.0235")).toBe(2); // 1.504/64 -> 2
  });
  it("parses millimeters with documented rounding to nearest 1/64 in", () => {
    expect(ok("25.4mm")).toBe(64);
    expect(ok("25.4 mm")).toBe(64);
    expect(ok("12.7mm")).toBe(32);
    expect(ok("0mm")).toBe(0);
    expect(ok("0.4mm")).toBe(1); // 1.0079 -> 1
  });
  it("parses feet-inches", () => {
    expect(ok("8'")).toBe(8 * 12 * 64);
    expect(ok("8' 1 1/2\"")).toBe((8 * 12 + 1) * 64 + 32);
    expect(ok("8'-1 1/2\"")).toBe((8 * 12 + 1) * 64 + 32);
    expect(ok("8' 6\"")).toBe((8 * 12 + 6) * 64);
    expect(ok("0' 3/4\"")).toBe(48);
    expect(ok("10'")).toBe(7680);
  });
  it("uses defaultUnit for bare numbers", () => {
    expect(ok("25.4", { defaultUnit: "mm" })).toBe(64);
    expect(ok("2", { defaultUnit: "in" })).toBe(128);
    expect(ok("2")).toBe(128); // default is inches
  });
  it("trims whitespace and is case-insensitive on units", () => {
    expect(ok("  3 5/8 IN ")).toBe(232);
    expect(ok("25.4 MM")).toBe(64);
  });
  it("returns typed errors, never NaN", () => {
    expect(errCode("")).toBe("empty");
    expect(errCode("   ")).toBe("empty");
    expect(errCode("abc")).toBe("invalid_format");
    expect(errCode("3 5/")).toBe("invalid_format");
    expect(errCode("3 5/0")).toBe("invalid_fraction");
    expect(errCode("1/3")).toBe("unsupported_denominator");
    expect(errCode("1/128")).toBe("unsupported_denominator");
    expect(errCode("9/8 5/8")).toBe("invalid_format");
    expect(errCode("NaN")).toBe("invalid_format");
    expect(errCode("Infinity")).toBe("invalid_format");
    expect(errCode("1e3")).toBe("invalid_format");
    expect(errCode("-3")).toBe("negative");
    expect(errCode("3 furlongs")).toBe("invalid_format");
    expect(errCode("8' 13\"")).toBe("out_of_range_inches");
    expect(errCode("99999999999999999999")).toBe("out_of_range");
  });
  it("allows negative values only when asked", () => {
    expect(ok("-1/2\"", { allowNegative: true })).toBe(-32);
    expect(ok("-25.4mm", { allowNegative: true })).toBe(-64);
  });
  it("allows improper fractions within an inch count (e.g. 9/8)", () => {
    expect(ok('9/8"')).toBe(72);
  });
});

describe("conversions", () => {
  it("inchesToLength / mmToLength / lengthToMm", () => {
    expect(inchesToLength(0.5)).toBe(32);
    expect(mmToLength(25.4)).toBe(64);
    expect(lengthToMm(64)).toBeCloseTo(25.4, 10);
  });
  it("mm rounding is half away from zero", () => {
    // 0.5/64 in = 0.19844 mm: exactly half a unit
    const halfUnitMm = (25.4 / 64) / 2;
    expect(mmToLength(halfUnitMm)).toBe(1);
    expect(mmToLength(-halfUnitMm)).toBe(-1);
  });
});

describe("formatLength", () => {
  it("fraction style reduces fractions", () => {
    expect(formatLength(232, "fraction")).toBe('3 5/8"');
    expect(formatLength(64, "fraction")).toBe('1"');
    expect(formatLength(32, "fraction")).toBe('1/2"');
    expect(formatLength(34, "fraction")).toBe('17/32"');
    expect(formatLength(1, "fraction")).toBe('1/64"');
    expect(formatLength(0, "fraction")).toBe('0"');
    expect(formatLength(-32, "fraction")).toBe('-1/2"');
  });
  it("decimal style trims trailing zeros", () => {
    expect(formatLength(232, "decimal")).toBe('3.625"');
    expect(formatLength(64, "decimal")).toBe('1"');
    expect(formatLength(1, "decimal")).toBe('0.015625"');
  });
  it("mm style uses one decimal", () => {
    expect(formatLength(64, "mm")).toBe("25.4 mm");
    expect(formatLength(0, "mm")).toBe("0.0 mm");
  });
  it("feet-inches style", () => {
    expect(formatLength((8 * 12 + 1) * 64 + 32, "feet-inches")).toBe('8\' 1 1/2"');
    expect(formatLength(8 * 12 * 64, "feet-inches")).toBe("8'");
    expect(formatLength(6 * 64, "feet-inches")).toBe('6"');
    expect(formatLength(30 * 64 + 8, "feet-inches")).toBe('2\' 6 1/8"');
  });
  it("round-trips through parse for all four styles", () => {
    for (const v of [0, 1, 31, 32, 33, 63, 64, 232, 767, 6144, 6176, 12345]) {
      for (const style of ["fraction", "feet-inches"] as const) {
        const s = formatLength(v, style);
        expect(ok(s)).toBe(v);
      }
      expect(ok(formatLength(v, "decimal"))).toBe(v);
    }
  });
});

describe("moisture percentage (separate quantity)", () => {
  it("parses to integer hundredths of a percent", () => {
    const r = parseMoisture("12.5%");
    expect(r.ok && r.value).toBe(1250);
    const r2 = parseMoisture("8");
    expect(r2.ok && r2.value).toBe(800);
  });
  it("rejects bad values with typed errors", () => {
    const bad = parseMoisture("wet");
    expect(bad.ok).toBe(false);
    const neg = parseMoisture("-1%");
    expect(!neg.ok && neg.error.code).toBe("negative");
    const big = parseMoisture("101%");
    expect(!big.ok && big.error.code).toBe("out_of_range");
    const empty = parseMoisture("");
    expect(!empty.ok && empty.error.code).toBe("empty");
  });
  it("formats", () => {
    expect(formatMoisture(1250)).toBe("12.5%");
    expect(formatMoisture(800)).toBe("8%");
  });
});

import { ok, err, type Result } from "./result";

/**
 * Canonical length: an integer count of 1/64 inch.
 * Conversions from decimal inches and millimetres round to the nearest 1/64",
 * with exact halves rounding away from zero (a 1e-9 guard absorbs float fuzz).
 */
export type Length64 = number;

export const UNITS_PER_INCH = 64;
const MM_PER_INCH = 25.4;

export type LengthParseErrorCode =
  | "empty"
  | "invalid_format"
  | "invalid_fraction"
  | "unsupported_denominator"
  | "out_of_range_inches"
  | "negative"
  | "out_of_range";

export interface LengthParseError {
  code: LengthParseErrorCode;
  message: string;
  input: string;
}

export interface ParseLengthOptions {
  /** Unit assumed when the input has no unit marker. Default "in". */
  defaultUnit?: "in" | "mm";
  /** Accept a leading minus sign (used for deviations). Default false. */
  allowNegative?: boolean;
}

const EPS = 1e-9;
const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x) + EPS);

export function inchesToLength(inches: number): Length64 {
  return roundHalfAway(inches * UNITS_PER_INCH);
}
export function mmToLength(mm: number): Length64 {
  return roundHalfAway((mm * UNITS_PER_INCH) / MM_PER_INCH);
}
export function lengthToMm(v: Length64): number {
  return (v * MM_PER_INCH) / UNITS_PER_INCH;
}

const VALID_DENOMINATORS = new Set([2, 4, 8, 16, 32, 64]);

const fail = (code: LengthParseErrorCode, message: string, input: string) =>
  err<LengthParseError>({ code, message, input });

/** Parses the inch portion (no feet): "3 5/8", "3-5/8", "5/8", "3.625", ".5", "3". */
function parseInchBody(body: string, input: string): Result<Length64, LengthParseError> {
  const b = body.trim();
  if (b === "") return fail("invalid_format", "Missing inch value", input);

  let m = /^(\d+)(?:\s+|-)(\d+)\/(\d+)$/.exec(b);
  if (m) return fractionToLength(Number(m[1]), Number(m[2]), Number(m[3]), input);
  m = /^(\d+)\/(\d+)$/.exec(b);
  if (m) return fractionToLength(0, Number(m[1]), Number(m[2]), input);
  m = /^(\d*\.\d+|\d+)$/.exec(b);
  if (m) {
    const v = inchesToLength(Number(m[1]));
    return Number.isSafeInteger(v) && v >= 0 ? ok(v) : fail("out_of_range", "Value too large", input);
  }
  return fail("invalid_format", `Cannot read "${input}" as a length`, input);
}

function fractionToLength(whole: number, num: number, den: number, input: string): Result<Length64, LengthParseError> {
  if (den === 0) return fail("invalid_fraction", "Denominator cannot be zero", input);
  if (!VALID_DENOMINATORS.has(den)) {
    return fail("unsupported_denominator", `Denominator ${den} is not one of 2,4,8,16,32,64`, input);
  }
  const v = whole * UNITS_PER_INCH + (num * UNITS_PER_INCH) / den;
  return Number.isSafeInteger(v) ? ok(v) : fail("out_of_range", "Value too large", input);
}

export function parseLength(raw: string, options: ParseLengthOptions = {}): Result<Length64, LengthParseError> {
  const { defaultUnit = "in", allowNegative = false } = options;
  let s = raw.trim().toLowerCase();
  if (s === "") return fail("empty", "Enter a measurement", raw);

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  const finish = (r: Result<Length64, LengthParseError>): Result<Length64, LengthParseError> => {
    if (!r.ok) return r;
    if (negative && r.value !== 0) {
      if (!allowNegative) return fail("negative", "Negative lengths are not allowed here", raw);
      return ok(-r.value);
    }
    return ok(r.value === 0 ? 0 : r.value); // avoid -0
  };

  // millimetres
  const mmMatch = /^(\d*\.\d+|\d+)\s*mm$/.exec(s);
  if (mmMatch) {
    const v = mmToLength(Number(mmMatch[1]));
    return finish(Number.isSafeInteger(v) ? ok(v) : fail("out_of_range", "Value too large", raw));
  }

  // feet (and optional inches)
  const ftMatch = /^(\d+)\s*'\s*(?:-\s*)?(.*)$/.exec(s);
  if (ftMatch) {
    const feet = Number(ftMatch[1]);
    const rest = (ftMatch[2] ?? "").trim().replace(/\s*(?:"|inches|inch|in)$/, "");
    let inchUnits = 0;
    if (rest !== "") {
      const r = parseInchBody(rest, raw);
      if (!r.ok) return r;
      inchUnits = r.value;
      if (inchUnits >= 12 * UNITS_PER_INCH) {
        return fail("out_of_range_inches", "Inches must be under 12 when feet are given", raw);
      }
    }
    const total = feet * 12 * UNITS_PER_INCH + inchUnits;
    return finish(Number.isSafeInteger(total) ? ok(total) : fail("out_of_range", "Value too large", raw));
  }

  // inches with optional unit marker, or bare number in the default unit
  const hasInchMarker = /(?:"|inches|inch|in)$/.test(s);
  if (!hasInchMarker && defaultUnit === "mm") {
    const m = /^(\d*\.\d+|\d+)$/.exec(s);
    if (!m) return fail("invalid_format", `Cannot read "${raw}" as millimetres`, raw);
    const v = mmToLength(Number(m[1]));
    return finish(Number.isSafeInteger(v) ? ok(v) : fail("out_of_range", "Value too large", raw));
  }
  const body = s.replace(/\s*(?:"|inches|inch|in)$/, "");
  return finish(parseInchBody(body, raw));
}

export type LengthFormat = "fraction" | "decimal" | "mm" | "feet-inches";

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function fractionInches(absUnits: number): string {
  const whole = Math.floor(absUnits / UNITS_PER_INCH);
  const rem = absUnits % UNITS_PER_INCH;
  if (rem === 0) return `${whole}`;
  const g = gcd(rem, UNITS_PER_INCH);
  const frac = `${rem / g}/${UNITS_PER_INCH / g}`;
  return whole === 0 ? frac : `${whole} ${frac}`;
}

export function formatLength(v: Length64, style: LengthFormat): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  switch (style) {
    case "fraction":
      return `${sign}${fractionInches(a)}"`;
    case "decimal": {
      const t = (a / UNITS_PER_INCH).toFixed(6).replace(/\.?0+$/, "");
      return `${sign}${t === "" ? "0" : t}"`;
    }
    case "mm":
      return `${sign}${((a * MM_PER_INCH) / UNITS_PER_INCH).toFixed(1)} mm`;
    case "feet-inches": {
      const perFoot = 12 * UNITS_PER_INCH;
      const feet = Math.floor(a / perFoot);
      const rem = a % perFoot;
      if (feet === 0) return `${sign}${fractionInches(rem)}"`;
      if (rem === 0) return `${sign}${feet}'`;
      return `${sign}${feet}' ${fractionInches(rem)}"`;
    }
  }
}

// ---- Moisture: a separate quantity, integer hundredths of a percent ----

export type Moisture100 = number;

export type MoistureParseErrorCode = "empty" | "invalid_format" | "negative" | "out_of_range";
export interface MoistureParseError {
  code: MoistureParseErrorCode;
  message: string;
  input: string;
}

export function parseMoisture(raw: string): Result<Moisture100, MoistureParseError> {
  const fail2 = (code: MoistureParseErrorCode, message: string) => err<MoistureParseError>({ code, message, input: raw });
  let s = raw.trim();
  if (s === "") return fail2("empty", "Enter a moisture reading");
  s = s.replace(/\s*%$/, "");
  if (s.startsWith("-")) return fail2("negative", "Moisture cannot be negative");
  const m = /^(\d*\.\d+|\d+)$/.exec(s);
  if (!m) return fail2("invalid_format", `Cannot read "${raw}" as a percentage`);
  const v = roundHalfAway(Number(m[1]) * 100);
  if (v > 10000) return fail2("out_of_range", "Moisture cannot exceed 100%");
  return ok(v);
}

export function formatMoisture(v: Moisture100): string {
  return `${(v / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

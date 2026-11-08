import { ok, err, type Result } from "./result";
import type { Length64 } from "./units";

export type ToleranceSource =
  | "project_spec"
  | "approved_drawing"
  | "company_standard"
  | "manufacturer"
  | "industry_standard"
  | "custom";

const SOURCES: readonly ToleranceSource[] = [
  "project_spec",
  "approved_drawing",
  "company_standard",
  "manufacturer",
  "industry_standard",
  "custom",
];

/**
 * All numbers come from rule data (audit template / project). The engine contains no defaults.
 * `reviewBand` is the maximum TOTAL deviation from `expected` that is still REVIEW rather than FAIL
 * (owner decision 2026-11-07), not an extra margin added on top of the tolerance.
 */
export interface ToleranceRule {
  expected: Length64;
  plus: Length64;
  minus: Length64;
  reviewBand?: Length64;
  source: ToleranceSource;
  sourceRef: string;
  method: string;
}

export type ToleranceResult = "PASS" | "REVIEW" | "FAIL";

export type ToleranceErrorCode =
  | "invalid_rule"
  | "review_band_smaller_than_tolerance"
  | "invalid_actual"
  | "invalid_measurement";
export interface ToleranceError {
  code: ToleranceErrorCode;
  message: string;
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const e = (code: ToleranceErrorCode, message: string) => err<ToleranceError>({ code, message });

export function validateRule(rule: ToleranceRule): Result<ToleranceRule, ToleranceError> {
  if (!isInt(rule.expected)) return e("invalid_rule", "expected must be an integer count of 1/64 inch");
  if (!isInt(rule.plus) || rule.plus < 0) return e("invalid_rule", "plus must be a non-negative integer");
  if (!isInt(rule.minus) || rule.minus < 0) return e("invalid_rule", "minus must be a non-negative integer");
  if (rule.reviewBand !== undefined) {
    if (!isInt(rule.reviewBand) || rule.reviewBand < 0) return e("invalid_rule", "reviewBand must be a non-negative integer");
    if (rule.reviewBand < Math.max(rule.plus, rule.minus)) {
      return e("review_band_smaller_than_tolerance", "reviewBand must be at least as large as plus and minus");
    }
  }
  if (!SOURCES.includes(rule.source)) return e("invalid_rule", `unknown source ${String(rule.source)}`);
  if (typeof rule.sourceRef !== "string" || typeof rule.method !== "string") {
    return e("invalid_rule", "sourceRef and method must be strings");
  }
  return ok(rule);
}

export interface Evaluation {
  result: ToleranceResult;
  /** actual - expected, in 1/64 inch (signed). */
  deviation: Length64;
  expected: Length64;
  actual: Length64;
}

export function evaluate(actual: Length64, rule: ToleranceRule): Result<Evaluation, ToleranceError> {
  const v = validateRule(rule);
  if (!v.ok) return v;
  if (!isInt(actual)) return e("invalid_actual", "actual must be an integer count of 1/64 inch");

  const deviation = actual - rule.expected;
  let result: ToleranceResult;
  if (deviation >= -rule.minus && deviation <= rule.plus) result = "PASS";
  else if (rule.reviewBand !== undefined && Math.abs(deviation) <= rule.reviewBand) result = "REVIEW";
  else result = "FAIL";
  return ok({ result, deviation, expected: rule.expected, actual });
}

export interface MeasurementRecord {
  expected: Length64;
  actual: Length64;
  plus: Length64;
  minus: Length64;
  reviewBand?: Length64;
  source: ToleranceSource;
  sourceRef: string;
  method: string;
  userId: string;
  timestamp: string;
  photoIds: string[];
  drawingRef?: string;
  note?: string;
  deviation: Length64;
  result: ToleranceResult;
}

export interface BuildMeasurementInput {
  actual: Length64;
  rule: ToleranceRule;
  userId: string;
  timestamp: string;
  photoIds?: string[];
  drawingRef?: string;
  note?: string;
}

export function buildMeasurement(input: BuildMeasurementInput): Result<MeasurementRecord, ToleranceError> {
  if (typeof input.userId !== "string" || input.userId.trim() === "") return e("invalid_measurement", "userId is required");
  if (typeof input.timestamp !== "string" || Number.isNaN(Date.parse(input.timestamp))) {
    return e("invalid_measurement", "timestamp must be an ISO date-time string");
  }
  const ev = evaluate(input.actual, input.rule);
  if (!ev.ok) return ev;
  const { rule } = input;
  return ok({
    expected: rule.expected,
    actual: input.actual,
    plus: rule.plus,
    minus: rule.minus,
    ...(rule.reviewBand !== undefined ? { reviewBand: rule.reviewBand } : {}),
    source: rule.source,
    sourceRef: rule.sourceRef,
    method: rule.method,
    userId: input.userId,
    timestamp: input.timestamp,
    photoIds: input.photoIds ?? [],
    ...(input.drawingRef !== undefined ? { drawingRef: input.drawingRef } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    deviation: ev.value.deviation,
    result: ev.value.result,
  });
}

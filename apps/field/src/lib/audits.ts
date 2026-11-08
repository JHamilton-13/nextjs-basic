import { canComplete, err, evaluate, ok, parseLength, type MissingRequirement, type OperationEnvelope, type Result, type ToleranceRule, type ToleranceSource } from "@phc/domain";
import type { Db } from "./db";
import { newOutboxRecord, type Outbox } from "./outbox";
import type { LocalAudit, LocalItem, LocalResult } from "./types";

export interface Ctx {
  db: Db;
  outbox: Outbox;
  userId: string;
  newId: () => string;
  now: () => string;
}

export type StartError = { code: "template_not_cached" | "project_not_cached" | "audit_exists"; message: string };

/**
 * Starts an audit entirely locally (works with no connectivity): the audit, its items from the cached
 * template, and the "create" operation are written in ONE IndexedDB transaction, so a crash can never
 * leave an audit without its queued create op.
 */
export async function startAudit(
  ctx: Ctx,
  input: { auditId: string; projectId: string; roomId: string | null; templateId: string },
): Promise<Result<LocalAudit, StartError>> {
  const { db } = ctx;
  const [template, project, existing] = await Promise.all([db.get("templates", input.templateId), db.get("projects", input.projectId), db.get("audits", input.auditId)]);
  if (!template) return err({ code: "template_not_cached", message: "That template is not available offline yet. Connect once to download it." });
  if (!project) return err({ code: "project_not_cached", message: "That project is not available offline yet. Connect once to download it." });
  if (existing) return err({ code: "audit_exists", message: "This audit was already started." });

  const audit: LocalAudit = { auditId: input.auditId, version: 1, projectId: input.projectId, roomId: input.roomId, templateId: input.templateId, createdBy: ctx.userId, createdAt: ctx.now() };
  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "audit", entityId: `${audit.auditId}:1`, baseVersion: 0,
    payload: { action: "create", projectId: audit.projectId, roomId: audit.roomId, templateId: audit.templateId },
    createdAt: ctx.now(), actor: ctx.userId,
  };
  const items: LocalItem[] = template.config.sections.flatMap((s) =>
    s.items.map((it): LocalItem => ({
      key: `${audit.auditId}:1:${it.key}`, auditId: audit.auditId, itemKey: it.key, sectionKey: s.key, sectionTitle: s.title,
      label: it.label, kind: it.kind, critical: it.critical, requires: it.requires ?? {},
      ...(it.rule ? { rule: it.rule } : {}), result: "NOT_ENTERED", pending: false, nextBase: 0,
    })));

  const tx = db.transaction(["audits", "items", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("audits").add(audit), ...items.map((i) => tx.objectStore("items").add(i)), tx.objectStore("outbox").add(newOutboxRecord(op, audit.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok(audit);
}

export type MeasurementError =
  | { code: "unknown_item" | "not_a_measurement_item"; message: string }
  | { code: "invalid_length"; field: "expected" | "actual"; message: string }
  | { code: "evidence_missing"; missing: MissingRequirement[]; message: string }
  | { code: "invalid_rule"; message: string };

export interface MeasurementInput { auditId: string; itemKey: string; expected: string; actual: string; drawingRef: string; note?: string }
export interface MeasurementOutcome { result: "PASS" | "REVIEW" | "FAIL"; deviation64: number; opId: string }

/**
 * Records one tolerance measurement locally and queues it. The PASS/REVIEW/FAIL shown here is provisional:
 * the server recomputes it from the template rule and its answer replaces this one after sync.
 */
export async function recordMeasurement(ctx: Ctx, input: MeasurementInput): Promise<Result<MeasurementOutcome, MeasurementError>> {
  const { db } = ctx;
  const item = await db.get("items", `${input.auditId}:1:${input.itemKey}`);
  if (!item) return err({ code: "unknown_item", message: "That item is not part of this audit." });
  if (item.kind !== "tolerance" || !item.rule) return err({ code: "not_a_measurement_item", message: "This item is not a measurement." });

  const expected = parseLength(input.expected);
  if (!expected.ok) return err({ code: "invalid_length", field: "expected", message: expected.error.message });
  const actual = parseLength(input.actual);
  if (!actual.ok) return err({ code: "invalid_length", field: "actual", message: actual.error.message });

  const drawingRef = input.drawingRef.trim();
  const note = input.note?.trim();
  const rule: ToleranceRule = {
    expected: expected.value, plus: item.rule.plus64, minus: item.rule.minus64,
    ...(item.rule.reviewBand64 !== undefined ? { reviewBand: item.rule.reviewBand64 } : {}),
    source: item.rule.source as ToleranceSource, sourceRef: item.rule.sourceRef, method: item.rule.method,
  };
  const ev = evaluate(actual.value, rule);
  if (!ev.ok) return err({ code: "invalid_rule", message: ev.error.message });
  if (ev.value.result !== "PASS" && ev.value.result !== "REVIEW" && ev.value.result !== "FAIL") return err({ code: "invalid_rule", message: "Unexpected result" });

  const missing = canComplete(item.requires, { measurement: { result: ev.value.result }, drawingRef });
  if (missing.length > 0) {
    return err({ code: "evidence_missing", missing, message: `Missing: ${missing.map((m) => (m.kind === "drawingRef" ? "drawing reference" : m.kind)).join(", ")}` });
  }

  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "audit_item", entityId: item.key, baseVersion: item.nextBase,
    payload: { actual64: actual.value, expected64: expected.value, drawingRef, ...(note ? { note } : {}) },
    createdAt: ctx.now(), actor: ctx.userId,
  };
  const updated: LocalItem = {
    ...item, result: ev.value.result, pending: true, nextBase: item.nextBase + 1,
    expected64: expected.value, actual64: actual.value, deviation64: ev.value.deviation, drawingRef, ...(note ? { note } : {}),
  };
  const tx = db.transaction(["items", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("items").put(updated), tx.objectStore("outbox").add(newOutboxRecord(op, input.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok({ result: ev.value.result, deviation64: ev.value.deviation, opId: op.opId });
}

export interface ServerItemRow { item_key: string; result: string; row_version: number }

/** Once every queued op for an audit is confirmed, the server's answer replaces the provisional local one. */
export async function reconcileFromServer(db: Db, auditId: string, rows: ServerItemRow[], o: { hasPendingOps: boolean }): Promise<void> {
  if (o.hasPendingOps) return;
  const tx = db.transaction("items", "readwrite");
  for (const row of rows) {
    const cur = await tx.store.get(`${auditId}:1:${row.item_key}`);
    if (cur) await tx.store.put({ ...cur, result: row.result as LocalResult, pending: false, nextBase: row.row_version });
  }
  await tx.done;
}

export interface AuditSummary { total: number; entered: number; pass: number; review: number; fail: number; criticalFail: boolean }

export async function auditSummary(db: Db, auditId: string): Promise<AuditSummary> {
  const items = await db.getAllFromIndex("items", "by_audit", auditId);
  const count = (r: LocalResult) => items.filter((i) => i.result === r).length;
  return {
    total: items.length, entered: items.filter((i) => i.result !== "NOT_ENTERED").length,
    pass: count("PASS"), review: count("REVIEW"), fail: count("FAIL"),
    criticalFail: items.some((i) => i.critical && i.result === "FAIL"),
  };
}

import { auditState, canComplete, err, evaluate, ok, parseLength, type AuditItemOutcome, type MissingRequirement, type OperationEnvelope, type ReadinessState, type Result, type ToleranceRule, type ToleranceSource } from "@phc/domain";
import type { Db } from "./db";
import { newOutboxRecord, type Outbox } from "./outbox";
import { photoCount } from "./photos";
import type { LocalAudit, LocalItem, LocalResult } from "./types";

export interface Ctx {
  db: Db;
  outbox: Outbox;
  userId: string;
  /** Display name (or email) of the signed-in user: stored with results so "who" survives offline and later sync. */
  userLabel: string;
  newId: () => string;
  now: () => string;
}

/** The newest local version of an audit: the only one that can be edited. */
export async function latestAudit(db: Db, auditId: string): Promise<LocalAudit | undefined> {
  const all = await db.getAllFromIndex("audits", "by_audit_id", auditId);
  return all.sort((a, b) => b.version - a.version)[0];
}

const isIssue = (r: string) => r === "FAIL" || r === "REVIEW";

/** Who recorded this result and when; and who raised the issue. An issue (FAIL/REVIEW) keeps its first raiser while it stays an issue. */
function attribution(ctx: Ctx, item: LocalItem, newResult: string): Pick<LocalItem, "resultBy" | "resultAt" | "issueBy" | "issueAt"> {
  const at = ctx.now();
  const base = { resultBy: ctx.userLabel, resultAt: at };
  if (!isIssue(newResult)) return base;
  if (isIssue(item.result) && item.issueBy && item.issueAt) return { ...base, issueBy: item.issueBy, issueAt: item.issueAt };
  return { ...base, issueBy: ctx.userLabel, issueAt: at };
}

/** Drops any issue fields carried on `item` (used when the result is no longer an issue). */
const withoutIssue = (item: LocalItem): LocalItem => { const { issueBy: _b, issueAt: _a, ...rest } = item; return rest; }

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
  const [template, project, existing] = await Promise.all([db.get("templates", input.templateId), db.get("projects", input.projectId), latestAudit(db, input.auditId)]);
  if (!template) return err({ code: "template_not_cached", message: "That template is not available offline yet. Connect once to download it." });
  if (!project) return err({ code: "project_not_cached", message: "That project is not available offline yet. Connect once to download it." });
  if (existing) return err({ code: "audit_exists", message: "This audit was already started." });

  const audit: LocalAudit = { key: `${input.auditId}:1`, auditId: input.auditId, version: 1, projectId: input.projectId, roomId: input.roomId, templateId: input.templateId, createdBy: ctx.userId, createdByLabel: ctx.userLabel, createdAt: ctx.now() };
  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "audit", entityId: audit.key, baseVersion: 0,
    payload: { action: "create", projectId: audit.projectId, roomId: audit.roomId, templateId: audit.templateId },
    createdAt: ctx.now(), actor: ctx.userId,
  };
  const items: LocalItem[] = template.config.sections.flatMap((s) =>
    s.items.map((it): LocalItem => ({
      key: `${audit.key}:${it.key}`, auditId: audit.auditId, version: 1, auditKey: audit.key, itemKey: it.key, sectionKey: s.key, sectionTitle: s.title,
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
  | { code: "unknown_item" | "not_a_measurement_item" | "audit_submitted"; message: string }
  | { code: "invalid_length"; field: "expected" | "actual"; message: string }
  | { code: "evidence_missing"; missing: MissingRequirement[]; message: string }
  | { code: "invalid_rule"; message: string };

const missingText = (missing: MissingRequirement[]) =>
  `Missing: ${missing.map((m) => (m.kind === "drawingRef" ? "drawing reference" : m.kind === "photo" ? `photo (${m.have}/${m.required})` : m.kind === "supervisorApproval" ? "supervisor approval (not available in the app yet)" : m.kind)).join(", ")}`;

export interface MeasurementInput { auditId: string; itemKey: string; expected: string; actual: string; drawingRef: string; note?: string }
export interface MeasurementOutcome { result: "PASS" | "REVIEW" | "FAIL"; deviation64: number; opId: string }

/**
 * Records one tolerance measurement locally and queues it. The PASS/REVIEW/FAIL shown here is provisional:
 * the server recomputes it from the template rule and its answer replaces this one after sync.
 */
export async function recordMeasurement(ctx: Ctx, input: MeasurementInput): Promise<Result<MeasurementOutcome, MeasurementError>> {
  const { db } = ctx;
  const audit = await latestAudit(db, input.auditId);
  const item = audit ? await db.get("items", `${audit.key}:${input.itemKey}`) : undefined;
  if (!audit || !item) return err({ code: "unknown_item", message: "That item is not part of this audit." });
  if (audit.submittedAt) return err({ code: "audit_submitted", message: "This audit was submitted and can no longer be edited. Revise it to make changes." });
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

  const missing = canComplete(item.requires, { measurement: { result: ev.value.result }, drawingRef, photoCount: await photoCount(db, input.auditId, input.itemKey) });
  if (missing.length > 0) {
    return err({ code: "evidence_missing", missing, message: missingText(missing) });
  }

  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "audit_item", entityId: item.key, baseVersion: item.nextBase,
    payload: { actual64: actual.value, expected64: expected.value, drawingRef, ...(note ? { note } : {}) },
    createdAt: ctx.now(), actor: ctx.userId,
  };
  const updated: LocalItem = {
    ...withoutIssue(item), ...attribution(ctx, item, ev.value.result), result: ev.value.result, pending: true, nextBase: item.nextBase + 1,
    expected64: expected.value, actual64: actual.value, deviation64: ev.value.deviation, drawingRef, ...(note ? { note } : {}),
  };
  const tx = db.transaction(["items", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("items").put(updated), tx.objectStore("outbox").add(newOutboxRecord(op, input.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok({ result: ev.value.result, deviation64: ev.value.deviation, opId: op.opId });
}

export interface ServerItemRow {
  item_key: string; result: string; row_version: number;
  result_at?: string | null; result_by_label?: string | null; issue_raised_at?: string | null; issue_raised_by_label?: string | null;
}

/** Once every queued op for an audit is confirmed, the server's answer replaces the provisional local one. */
export async function reconcileFromServer(db: Db, auditId: string, version: number, rows: ServerItemRow[], o: { hasPendingOps: boolean }): Promise<void> {
  if (o.hasPendingOps) return;
  const tx = db.transaction("items", "readwrite");
  for (const row of rows) {
    const cur = await tx.store.get(`${auditId}:${version}:${row.item_key}`);
    if (!cur) continue;
    const next: LocalItem = { ...withoutIssue(cur), result: row.result as LocalResult, pending: false, nextBase: row.row_version };
    if (row.result_at) { next.resultAt = row.result_at; if (row.result_by_label) next.resultBy = row.result_by_label; }
    if (row.issue_raised_at) { next.issueAt = row.issue_raised_at; if (row.issue_raised_by_label) next.issueBy = row.issue_raised_by_label; }
    await tx.store.put(next);
  }
  await tx.done;
}

export interface AuditSummary { total: number; entered: number; pass: number; review: number; fail: number; criticalFail: boolean }

export async function auditSummary(db: Db, auditId: string, version?: number): Promise<AuditSummary> {
  const audit = version ? await db.get("audits", `${auditId}:${version}`) : await latestAudit(db, auditId);
  const items = audit ? await db.getAllFromIndex("items", "by_audit", audit.key) : [];
  const count = (r: LocalResult) => items.filter((i) => i.result === r).length;
  return {
    total: items.length, entered: items.filter((i) => i.result !== "NOT_ENTERED").length,
    pass: count("PASS"), review: count("REVIEW"), fail: count("FAIL"),
    criticalFail: items.some((i) => i.critical && i.result === "FAIL"),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Check / observation items, submit, readiness
// ---------------------------------------------------------------------------------------------------------------

export type CheckResult = "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE" | "OBSERVED";
export type CheckError =
  | { code: "audit_not_found" | "unknown_item" | "use_measurement" | "audit_submitted" | "invalid_result"; message: string }
  | { code: "evidence_missing"; missing: MissingRequirement[]; message: string };

/** Records a result for a check (PASS/FAIL/REVIEW/N-A) or observation (OBSERVED) item, enforcing its evidence rules first. */
export async function recordCheck(
  ctx: Ctx,
  input: { auditId: string; itemKey: string; result: CheckResult; note?: string; drawingRef?: string },
): Promise<Result<{ result: CheckResult }, CheckError>> {
  const { db } = ctx;
  const audit = await latestAudit(db, input.auditId);
  if (!audit) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  const item = await db.get("items", `${audit.key}:${input.itemKey}`);
  if (!item) return err({ code: "unknown_item", message: "That item is not part of this audit." });
  if (audit.submittedAt) return err({ code: "audit_submitted", message: "This audit was submitted and can no longer be edited. Revise it to make changes." });
  if (item.kind === "tolerance") return err({ code: "use_measurement", message: "This item is a measurement. Enter the measured value instead." });
  const allowed: CheckResult[] = item.kind === "observation" ? ["OBSERVED"] : ["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"];
  if (!allowed.includes(input.result)) return err({ code: "invalid_result", message: item.kind === "observation" ? "Observation items are only marked as observed." : "Choose pass, fail, review or not applicable." });

  const note = input.note?.trim(); const drawingRef = input.drawingRef?.trim();
  // A "measurement" requirement only applies to measurement items; it cannot be met by a check item.
  const missing = canComplete({ ...item.requires, measurement: false }, { note, drawingRef, photoCount: await photoCount(db, input.auditId, input.itemKey) });
  if (missing.length > 0) return err({ code: "evidence_missing", missing, message: missingText(missing) });

  const op: OperationEnvelope = {
    opId: ctx.newId(), entity: "audit_item", entityId: item.key, baseVersion: item.nextBase,
    payload: { result: input.result, ...(note ? { note } : {}), ...(drawingRef ? { drawingRef } : {}) },
    createdAt: ctx.now(), actor: ctx.userId,
  };
  const updated: LocalItem = { ...withoutIssue(item), ...attribution(ctx, item, input.result), result: input.result, pending: true, nextBase: item.nextBase + 1, ...(note ? { note } : {}), ...(drawingRef ? { drawingRef } : {}) };
  const tx = db.transaction(["items", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("items").put(updated), tx.objectStore("outbox").add(newOutboxRecord(op, input.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok({ result: input.result });
}

export type SubmitError = { code: "audit_not_found" | "already_submitted"; message: string };

/**
 * Submits the audit. Per the owner's decision there is no requirement that items have results (the screen warns instead).
 * After this the audit is read-only here; a manager decides on release.
 */
export async function submitAudit(ctx: Ctx, input: { auditId: string }): Promise<Result<{ submittedAt: string }, SubmitError>> {
  const audit = await latestAudit(ctx.db, input.auditId);
  if (!audit) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  if (audit.submittedAt) return err({ code: "already_submitted", message: "This audit was already submitted." });
  const at = ctx.now();
  // Every audit version starts at server row_version 1; the queued create/revise op always precedes this one.
  const op: OperationEnvelope = { opId: ctx.newId(), entity: "audit", entityId: audit.key, baseVersion: 1, payload: { action: "submit" }, createdAt: at, actor: ctx.userId };
  const tx = ctx.db.transaction(["audits", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("audits").put({ ...audit, submittedAt: at, submittedBy: ctx.userId, submittedByLabel: ctx.userLabel }), tx.objectStore("outbox").add(newOutboxRecord(op, audit.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok({ submittedAt: at });
}

export interface Readiness { state: ReadinessState; fromServer: boolean; notEntered: number; criticalNotEntered: string[]; criticalFailed: string[] }

/** Readiness shown to the installer: the server's answer once known, otherwise computed locally with the domain rules. */
export async function auditReadiness(db: Db, auditId: string, version?: number): Promise<Readiness> {
  const audit = version ? await db.get("audits", `${auditId}:${version}`) : await latestAudit(db, auditId);
  if (!audit) throw new Error("audit not found");
  const items = await db.getAllFromIndex("items", "by_audit", audit.key);
  const template = await db.get("templates", audit.templateId);
  const outcomes: AuditItemOutcome[] = items.map((i) => ({ itemId: i.itemKey, critical: i.critical, result: i.result }));
  const local = auditState(
    { auditId, projectId: audit.projectId, version: audit.version, submitted: Boolean(audit.submittedAt), items: outcomes, overrides: [] },
    { nonCriticalIssueState: template?.config.policy.nonCriticalIssueState ?? "manager_review_required" },
  );
  return {
    state: (audit.serverState as ReadinessState | undefined) ?? local, fromServer: Boolean(audit.serverState),
    notEntered: items.filter((i) => i.result === "NOT_ENTERED").length,
    criticalNotEntered: items.filter((i) => i.critical && i.result === "NOT_ENTERED").map((i) => i.itemKey),
    criticalFailed: items.filter((i) => i.critical && i.result === "FAIL").map((i) => i.itemKey),
  };
}

export interface SectionGroup { key: string; title: string; total: number; entered: number; items: LocalItem[] }

/** Items grouped by checklist section, in the template's own order (IndexedDB returns them sorted by key). */
export async function groupedItems(db: Db, auditId: string, version?: number): Promise<SectionGroup[]> {
  const audit = version ? await db.get("audits", `${auditId}:${version}`) : await latestAudit(db, auditId);
  const items = audit ? await db.getAllFromIndex("items", "by_audit", audit.key) : [];
  const template = audit ? await db.get("templates", audit.templateId) : undefined;
  const byKey = new Map(items.map((i) => [i.itemKey, i] as const));
  const sections = template
    ? template.config.sections.map((s) => ({ key: s.key, title: s.title, items: s.items.map((it) => byKey.get(it.key)).filter((i): i is LocalItem => Boolean(i)) }))
    : [{ key: "all", title: "Items", items }];
  return sections.map((s) => ({ ...s, total: s.items.length, entered: s.items.filter((i) => i.result !== "NOT_ENTERED").length }));
}

export type ReviseError = { code: "audit_not_found" | "not_submitted" | "reason_required"; message: string };

/**
 * Starts a revision (version n+1) of a SUBMITTED audit, entirely offline. Results, notes and who/when carry over so the
 * installer only changes what is wrong; the previous version stays untouched and read-only as the record. Earlier photos
 * keep counting as evidence. The revise operation is queued right after the previous version's submit.
 */
export async function reviseAudit(ctx: Ctx, input: { auditId: string; reason: string }): Promise<Result<{ version: number }, ReviseError>> {
  const cur = await latestAudit(ctx.db, input.auditId);
  if (!cur) return err({ code: "audit_not_found", message: "That audit is not on this device." });
  if (!cur.submittedAt) return err({ code: "not_submitted", message: "This audit has not been submitted, so you can keep editing it." });
  const reason = input.reason.trim();
  if (!reason) return err({ code: "reason_required", message: "Say why you are revising this audit." });

  const version = cur.version + 1;
  const audit: LocalAudit = {
    key: `${cur.auditId}:${version}`, auditId: cur.auditId, version, projectId: cur.projectId, roomId: cur.roomId, templateId: cur.templateId,
    createdBy: ctx.userId, createdByLabel: ctx.userLabel, createdAt: ctx.now(), reviseReason: reason,
  };
  const items = (await ctx.db.getAllFromIndex("items", "by_audit", cur.key)).map((i): LocalItem => ({ ...i, key: `${audit.key}:${i.itemKey}`, version, auditKey: audit.key, pending: false, nextBase: 0 }));
  const op: OperationEnvelope = { opId: ctx.newId(), entity: "audit", entityId: audit.key, baseVersion: 0, payload: { action: "revise", reason }, createdAt: ctx.now(), actor: ctx.userId };
  const tx = ctx.db.transaction(["audits", "items", "outbox"], "readwrite");
  await Promise.all([tx.objectStore("audits").add(audit), ...items.map((i) => tx.objectStore("items").add(i)), tx.objectStore("outbox").add(newOutboxRecord(op, audit.auditId))]);
  await tx.done;
  ctx.outbox.notify();
  return ok({ version });
}

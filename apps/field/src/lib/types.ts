import type { ClientOpState, OperationEnvelope } from "@phc/domain";

export interface ProjectRow { id: string; name: string; customer: string | null; address: string | null }
export interface RoomRow { id: string; project_id: string; name: string; floor: string | null }

/** Template config exactly as stored in audit_templates.config (see docs/architecture/audit-template-config.md). */
export interface TemplateItemDef {
  key: string;
  label: string;
  kind: "check" | "tolerance" | "observation";
  critical: boolean;
  requires?: { photo?: number; measurement?: boolean; note?: boolean; drawingRef?: boolean; supervisorApproval?: boolean };
  rule?: { plus64: number; minus64: number; reviewBand64?: number; source: string; sourceRef: string; method: string };
}
export interface TemplateConfig {
  policy: { nonCriticalIssueState: "manager_review_required" | "ready_with_exceptions" };
  sections: { key: string; title: string; items: TemplateItemDef[] }[];
}
export interface TemplateRow { id: string; name: string; version: number; config: TemplateConfig }

export interface LocalAudit {
  auditId: string;
  version: 1;
  projectId: string;
  roomId: string | null;
  templateId: string;
  createdBy: string;
  createdAt: string;
}

export type LocalResult = "PASS" | "REVIEW" | "FAIL" | "NOT_ENTERED" | "OBSERVED" | "NOT_APPLICABLE";

export interface LocalItem {
  /** `${auditId}:${version}:${itemKey}` — also the apply_op entityId. */
  key: string;
  auditId: string;
  itemKey: string;
  sectionKey: string;
  sectionTitle: string;
  label: string;
  kind: TemplateItemDef["kind"];
  critical: boolean;
  requires: NonNullable<TemplateItemDef["requires"]>;
  rule?: NonNullable<TemplateItemDef["rule"]>;
  /** Result shown to the user. Provisional (computed here) until the server confirms and returns its own. */
  result: LocalResult;
  /** true while a queued op for this item has not been confirmed by the server. */
  pending: boolean;
  /** baseVersion to put on the NEXT op for this item (server row_version, plus ops already queued). */
  nextBase: number;
  expected64?: number;
  actual64?: number;
  deviation64?: number;
  drawingRef?: string;
  note?: string;
}

export interface OutboxRecord {
  seq?: number;
  auditId: string;
  op: OperationEnvelope;
  state: ClientOpState;
  /** epoch ms; a failed-retryable op is not retried before this time. */
  nextAttemptAt: number;
}

export interface Identity { userId: string; email: string }

import type { ClientOpState, OperationEnvelope } from "@phc/domain";

export interface ProjectRow { id: string; name: string; customer: string | null; address: string | null }
export interface RoomRow {
  id: string; project_id: string; name: string; floor: string | null;
  /** Room spec fields (panelName, woodSpecies, ...), text only. Never holds PHC-only notes (the database refuses them). */
  details?: Record<string, string>;
  /** cockpit | masterfile | warehouse_tracker | manual */
  details_source?: string | null;
}

export type CheckState = "done" | "not_done" | "na";
/** One pill on a room's completion checklist. No record = nobody has acted on it yet. */
export interface LocalRoomCheck {
  /** `${roomId}:${itemKey}` — also the apply_op entityId. */
  key: string;
  roomId: string;
  projectId: string;
  itemKey: string;
  state: CheckState;
  /** Required when state is not_done (why it is not finished). */
  note?: string;
  /** Who set it and when it happened on site (not when it synced). */
  by?: string;
  at?: string;
  pending: boolean;
  /** baseVersion for the NEXT op on this item (server row_version, plus ops already queued; 0 once cleared). */
  nextBase: number;
}

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
  /** `${auditId}:${version}` — one local record per audit VERSION (a revision is a new version). */
  key: string;
  auditId: string;
  version: number;
  projectId: string;
  roomId: string | null;
  templateId: string;
  createdBy: string;
  /** Display name (or email) of the creator, captured when it happened. */
  createdByLabel: string;
  createdAt: string;
  /** Version 2+: why the audit was revised. */
  reviseReason?: string;
  submittedBy?: string;
  submittedByLabel?: string;
  /** Set locally when the installer submits; the audit is then read-only on this device (the server enforces it too). */
  submittedAt?: string;
  /** Readiness as reported by the server after the submit synced (authoritative). */
  serverState?: string;
}

export type LocalResult = "PASS" | "REVIEW" | "FAIL" | "NOT_ENTERED" | "OBSERVED" | "NOT_APPLICABLE";

export interface LocalItem {
  /** `${auditId}:${version}:${itemKey}` — also the apply_op entityId. */
  key: string;
  auditId: string;
  version: number;
  /** `${auditId}:${version}` */
  auditKey: string;
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
  /** Who recorded the current result and when it happened on site (not when it synced). */
  resultBy?: string;
  resultAt?: string;
  /** Who first raised the issue (a FAIL or REVIEW) and when; cleared when the item stops being an issue. */
  issueBy?: string;
  issueAt?: string;
}

export interface LocalPhoto {
  id: string;
  auditId: string;
  /** Audit version current when the photo was taken. Photos count as evidence for that version and every later one. */
  version: number;
  /** Set when this is an annotated copy: the original photo it was drawn on (the original is never changed). */
  annotatedFrom?: string;
  /** Editable vector marks of an annotated copy (normalized 0..1 coordinates). */
  annotations?: import("./annotations").Shape[];
  projectId: string;
  /** null = an overall/room photo not tied to one checklist item. */
  itemKey: string | null;
  /** Compressed JPEG that gets uploaded. Removed from the device only after the server confirms the upload. */
  blob?: Blob;
  /** The untouched original, kept until the upload is confirmed (never delete unconfirmed evidence). */
  originalBlob?: Blob;
  /** Small data-URL preview, kept after the blobs are dropped. */
  thumb: string;
  mime: string;
  bytes: number;
  sha256: string;
  capturedAt: string;
  capturedBy: string;
  storagePath: string;
  confirmed: boolean;
}

export interface OutboxRecord {
  seq?: number;
  auditId: string;
  /** Results/registrations ("data") and file uploads ("files") run in separate lanes so a stuck upload cannot block results. */
  lane?: "data" | "files";
  /** opIds that must be confirmed before this one may be sent. */
  after?: string[];
  op: OperationEnvelope;
  state: ClientOpState;
  /** epoch ms; a failed-retryable op is not retried before this time. */
  nextAttemptAt: number;
}

export interface Identity { userId: string; email: string; /** display name, else email */ label: string }

import { KIND_ORDER, normalizeReportOptions, PRESET_OPTIONS, type IssueKind, type ReportOptions, type ReportPreset } from "@phc/domain";

export const KIND_PLURAL: Record<IssueKind, string> = { pre_install_correction: "Pre-Install Corrections", punch_item: "Punch Items", missing_part: "Missing Parts", damaged_part: "Damaged Parts", touch_up: "Touch-Ups" };
export const PRESET_LABEL: Record<ReportPreset, string> = { builder_site_audit: "Builder site audit", service: "Service report", room_status: "Room status", custom: "Custom" };

export const applyPreset = (p: ReportPreset): ReportOptions => ({ ...PRESET_OPTIONS[p], kinds: [...PRESET_OPTIONS[p].kinds] });

/** Any change to a preset's choices makes it a custom report (the preset only names the starting point). */
export const change = (o: ReportOptions, patch: Partial<ReportOptions>): ReportOptions => ({ ...o, ...patch, preset: "custom" });

export function setKind(o: ReportOptions, kind: IssueKind, on: boolean): ReportOptions {
  const set = new Set(o.kinds);
  if (on) set.add(kind); else set.delete(kind);
  return change(o, { kinds: KIND_ORDER.filter((k) => set.has(k)) });
}

export const optionsProblem = (o: ReportOptions): string | null => { const r = normalizeReportOptions(o); return r.ok ? null : r.error.message; };

export function summarizeOptions(o: ReportOptions): string {
  const status = o.issueStatus === "both" ? "open and completed" : `${o.issueStatus} only`;
  return [
    o.kinds.length > 0 ? `${o.kinds.map((k) => KIND_PLURAL[k]).join(", ")}, ${status}` : null,
    o.checklist === "all" ? "room status for every room" : o.checklist === "incomplete" ? "rooms not yet completed" : null,
    o.photos === "none" ? "no photos" : o.photos === "annotated" ? "marked-up photos" : "original photos",
    o.emptyRooms ? "includes rooms with nothing to list" : null,
  ].filter(Boolean).join(" · ");
}

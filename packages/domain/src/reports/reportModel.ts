import { err, ok, type Result } from "../result";
import type { IssueKind } from "./categories";

export type ReportPreset = "builder_site_audit" | "service" | "room_status" | "custom";
export type ChecklistMode = "none" | "incomplete" | "all";
export type PhotoMode = "none" | "annotated" | "original";
export type IssueStatusFilter = "open" | "completed" | "both";

/** What a manager chose to put on a report. Photos are ONE of: none, the marked-up copy (original if never marked up), or the originals. */
export interface ReportOptions {
  preset: ReportPreset;
  kinds: IssueKind[];
  issueStatus: IssueStatusFilter;
  checklist: ChecklistMode;
  /** List rooms that have nothing else to show. */
  emptyRooms: boolean;
  photos: PhotoMode;
}

export const KIND_ORDER: IssueKind[] = ["pre_install_correction", "punch_item", "missing_part", "damaged_part", "touch_up"];
const SERVICE_KINDS: IssueKind[] = ["punch_item", "missing_part", "damaged_part"];

export const PRESET_OPTIONS: Record<ReportPreset, ReportOptions> = {
  builder_site_audit: { preset: "builder_site_audit", kinds: ["pre_install_correction"], issueStatus: "both", checklist: "none", emptyRooms: false, photos: "annotated" },
  service: { preset: "service", kinds: SERVICE_KINDS, issueStatus: "both", checklist: "none", emptyRooms: false, photos: "annotated" },
  room_status: { preset: "room_status", kinds: SERVICE_KINDS, issueStatus: "open", checklist: "all", emptyRooms: false, photos: "none" },
  custom: { preset: "custom", kinds: KIND_ORDER, issueStatus: "both", checklist: "incomplete", emptyRooms: false, photos: "annotated" },
};

export function reportTitle(o: Pick<ReportOptions, "preset">): string {
  return { builder_site_audit: "Builder Site Audit", service: "Service Report", room_status: "Room Status", custom: "Project Report" }[o.preset];
}

export type OptionsError = { code: "bad_options" | "nothing_selected"; message: string };
const PRESETS = Object.keys(PRESET_OPTIONS) as ReportPreset[];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v);

/** Validates a request for a report. Missing fields come from the chosen preset; anything unknown is refused with a reason. */
export function normalizeReportOptions(input: unknown): Result<ReportOptions, OptionsError> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return err({ code: "bad_options", message: "Report options are missing." });
  const o = input as Record<string, unknown>;
  const preset = o.preset === undefined ? "custom" : o.preset;
  if (!oneOf(preset, PRESETS)) return err({ code: "bad_options", message: "Unknown report type." });
  const base = PRESET_OPTIONS[preset];

  let kinds = base.kinds;
  if (o.kinds !== undefined) {
    if (!Array.isArray(o.kinds) || !o.kinds.every((k) => oneOf(k, KIND_ORDER))) return err({ code: "bad_options", message: "Unknown issue type." });
    kinds = KIND_ORDER.filter((k) => (o.kinds as string[]).includes(k));
  }
  const issueStatus = o.issueStatus === undefined ? base.issueStatus : o.issueStatus;
  if (!oneOf(issueStatus, ["open", "completed", "both"] as const)) return err({ code: "bad_options", message: "Issue status must be open, completed or both." });
  const checklist = o.checklist === undefined ? base.checklist : o.checklist;
  if (!oneOf(checklist, ["none", "incomplete", "all"] as const)) return err({ code: "bad_options", message: "Room status must be none, incomplete or all." });
  const photos = o.photos === undefined ? base.photos : o.photos;
  if (!oneOf(photos, ["none", "annotated", "original"] as const)) return err({ code: "bad_options", message: "Photos must be none, marked-up or original (one or the other)." });
  const emptyRooms = o.emptyRooms === undefined ? base.emptyRooms : o.emptyRooms;
  if (typeof emptyRooms !== "boolean") return err({ code: "bad_options", message: "Empty rooms must be on or off." });

  if (kinds.length === 0 && checklist === "none") return err({ code: "nothing_selected", message: "Choose at least one issue type or show the room status." });
  return ok({ preset, kinds, issueStatus, checklist, emptyRooms, photos });
}

export interface ModelSourceIssue {
  id: string; roomId: string; kind: IssueKind; status: "open" | "completed" | "void"; tradeName: string | null;
  title: string; description: string; raisedByInitials: string; raisedOn: string; completedOn: string | null;
  photos: { id: string; capturedAt: string }[];
}
export interface RoomChecklistInfo { completed: boolean; outstanding: string[]; started: boolean; byWho: string | null; at: string | null }
export interface ModelRoom { roomId: string; roomName: string; checklist: RoomChecklistInfo | null; issues: ModelSourceIssue[] }
export interface ReportModel {
  options: ReportOptions;
  rooms: ModelRoom[];
  totals: { identified: number; incomplete: number; roomsCompleted: number; roomsWithChecklist: number };
}

const NOT_STARTED: RoomChecklistInfo = { completed: false, outstanding: ["Checklist not started"], started: false, byWho: null, at: null };

/**
 * Decides what is printed. A room appears when it has a chosen issue, or its checklist is to be shown (all rooms, or only the ones not
 * completed), or "rooms with nothing to list" is on. A room's issues are listed whatever its checklist status is. Voided issues never appear.
 */
export function buildReportModel(input: { rooms: readonly { id: string; name: string }[]; issues: readonly ModelSourceIssue[]; checklist: Readonly<Record<string, RoomChecklistInfo>> }, options: ReportOptions): ReportModel {
  const kinds = new Set<IssueKind>(options.kinds);
  const wanted = (i: ModelSourceIssue) => i.status !== "void" && kinds.has(i.kind) && (options.issueStatus === "both" || i.status === options.issueStatus);
  const rooms: ModelRoom[] = [];
  let identified = 0; let incomplete = 0; let roomsCompleted = 0; let roomsWithChecklist = 0;
  for (const room of input.rooms) {
    const mine = input.issues.filter((i) => i.roomId === room.id && wanted(i));
    const info = input.checklist[room.id] ?? NOT_STARTED;
    const showChecklist = options.checklist === "all" || (options.checklist === "incomplete" && !info.completed);
    if (mine.length === 0 && !showChecklist && !options.emptyRooms) continue;
    identified += mine.length; incomplete += mine.filter((i) => i.status === "open").length;
    if (showChecklist) { roomsWithChecklist++; if (info.completed) roomsCompleted++; }
    rooms.push({ roomId: room.id, roomName: room.name, checklist: showChecklist ? { ...info, outstanding: [...info.outstanding] } : null, issues: mine.map((i) => ({ ...i, photos: [...i.photos] })) });
  }
  return { options, rooms, totals: { identified, incomplete, roomsCompleted, roomsWithChecklist } };
}

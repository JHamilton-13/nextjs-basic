// In-memory stand-ins for the database and storage, used by the tests and by the sample/e2e tooling. They follow the same rules as migration 1700.
import type { ReportDb, ReportStorage, ReportRow, ReportProject, IssueRow, IssuePhotoRow, ProfileRow, RoomCheckRow, RoomRow } from "./ports";
import { ReportError } from "./errors";

export class FakeDb implements ReportDb {
  project: ReportProject | null = { id: "p1", name: "Sample Project", address: "123 Example Street", prepared_for_name: "Sample Builder", prepared_for_email: "builder@example.test" };
  rooms: RoomRow[] = [];
  issues: IssueRow[] = [];
  photos: IssuePhotoRow[] = [];
  profiles: ProfileRow[] = [];
  checks: RoomCheckRow[] = [];
  reports = new Map<string, ReportRow>();
  clock = () => new Date();
  failCreate = false;
  async getProject() { return this.project; }
  async listRooms() { return this.rooms; }
  async listIssues() { return this.issues; }
  async listIssuePhotos() { return this.photos; }
  async listProfiles(ids: string[]) { return this.profiles.filter((p) => ids.includes(p.id)); }
  async listRoomChecks() { return this.checks; }
  async createReport(a: { id: string; projectId: string; type: ReportRow["report_type"]; path: string; bytes: number }) {
    if (this.failCreate) throw new ReportError("db_error", "insert failed");
    const r: ReportRow = { id: a.id, project_id: a.projectId, report_type: a.type, storage_path: a.path, file_size: a.bytes, built_at: this.clock().toISOString(), status: "built", recipient_name: null, recipient_email: null, queued_at: null, sent_at: null, printed_at: null, message_id: null, error: null };
    this.reports.set(r.id, r);
    return { ...r };
  }
  async getReport(id: string) { const r = this.reports.get(id); return r ? { ...r } : null; }
  async queueReportSend(id: string, name: string | null, email: string) {
    const r = this.reports.get(id);
    if (!r) throw new ReportError("forbidden", "forbidden");
    if (r.status === "sent") throw new ReportError("report_already_sent", "report_already_sent");
    if (r.status === "queued" && r.queued_at && this.clock().getTime() - Date.parse(r.queued_at) < 10 * 60_000) throw new ReportError("report_already_queued", "report_already_queued");
    Object.assign(r, { status: "queued", queued_at: this.clock().toISOString(), recipient_name: name, recipient_email: email, error: null });
    return { ...r };
  }
  async markReportSent(id: string, messageId: string) { const r = this.reports.get(id)!; if (r.status !== "queued") throw new ReportError("report_not_queued", "report_not_queued"); Object.assign(r, { status: "sent", sent_at: this.clock().toISOString(), message_id: messageId }); }
  async markReportPrinted(id: string) { const r = this.reports.get(id); if (!r) throw new ReportError("forbidden", "forbidden"); r.printed_at = this.clock().toISOString(); }
  async listReportPaths(projectId: string) { return [...this.reports.values()].filter((r) => r.project_id === projectId).map((r) => r.storage_path); }
  /** Same rule as prune_reports in migration 1800. */
  async pruneReports(projectId: string, type: ReportRow["report_type"], keepId: string) {
    const saved = (r: ReportRow) => r.sent_at !== null || r.printed_at !== null;
    const stamp = (r: ReportRow) => Math.max(r.sent_at ? Date.parse(r.sent_at) : -Infinity, r.printed_at ? Date.parse(r.printed_at) : -Infinity);
    const newest = [...this.reports.values()].filter((r) => r.project_id === projectId && r.report_type === type && saved(r)).sort((a, b) => stamp(b) - stamp(a))[0];
    const now = this.clock().getTime(); const paths: string[] = [];
    for (const r of [...this.reports.values()]) {
      if (r.project_id !== projectId) continue;
      if (r.status === "queued" && r.queued_at && now - Date.parse(r.queued_at) < 10 * 60_000) continue;
      const replaced = r.report_type === type && r.id !== keepId && r.id !== newest?.id;
      const oldPreview = !saved(r) && now - Date.parse(r.built_at) > 60 * 60_000;
      if (replaced || oldPreview) { this.reports.delete(r.id); paths.push(r.storage_path); }
    }
    return paths;
  }
  async markReportFailed(id: string, error: string) { const r = this.reports.get(id)!; if (r.status !== "queued") throw new ReportError("report_not_queued", "report_not_queued"); Object.assign(r, { status: "failed", error }); }
}

export class FakeStorage implements ReportStorage {
  files = new Map<string, Buffer>();
  failDownload = new Set<string>();
  uploads: string[] = [];
  key = (bucket: string, path: string) => `${bucket}/${path}`;
  async download(bucket: string, path: string) { return this.failDownload.has(path) ? null : this.files.get(this.key(bucket, path)) ?? null; }
  async upload(bucket: string, path: string, bytes: Buffer) { this.uploads.push(path); this.files.set(this.key(bucket, path), bytes); }
  failRemove = false;
  createdAt = new Map<string, string>();
  async remove(bucket: string, paths: string[]) { let failed = 0; for (const p of paths) { if (this.failRemove) { failed++; continue; } this.files.delete(this.key(bucket, p)); } return failed; }
  async list(bucket: string, folder: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(`${bucket}/${folder}/`) && !k.slice(`${bucket}/${folder}/`.length).includes("/"))
      .map((k) => ({ path: k.slice(bucket.length + 1), createdAt: this.createdAt.get(k) ?? "2020-01-01T00:00:00Z" }));
  }
  async signedUrl(bucket: string, path: string, seconds: number) { return `https://storage.example.test/${bucket}/${path}?expires=${seconds}`; }
}

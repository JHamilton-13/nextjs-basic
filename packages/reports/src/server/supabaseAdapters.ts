// The real database and storage, always through the signed-in manager's own Supabase session (row-level security applies; no service key).
import type { SupabaseClient } from "@supabase/supabase-js";
import { ReportError } from "./errors";
import type { IssuePhotoRow, IssueRow, ProfileRow, ReportDb, ReportProject, ReportRow, ReportStorage, RoomCheckRow, RoomRow } from "./ports";

const CODES = ["too_many_recipients", "report_already_queued", "report_already_sent", "report_not_queued", "invalid_recipient", "forbidden"];

function fail(error: { message: string; code?: string }): never {
  const code = CODES.find((c) => error.message.includes(c));
  if (code) throw new ReportError(code, code === "forbidden" ? "You do not have permission to do that." : code);
  throw new ReportError("db_error", error.message);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rows<T>(q: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) fail(error);
  return (data ?? []) as T[];
}

export function supabaseDb(sb: SupabaseClient): ReportDb {
  return {
    async getProject(id) {
      const { data, error } = await sb.from("projects").select("id,name,address,prepared_for_name,prepared_for_email").eq("id", id).maybeSingle();
      if (error) fail(error);
      return (data as ReportProject | null) ?? null;
    },
    listRooms: (projectId) => rows<RoomRow>(sb.from("rooms").select("id,name").eq("project_id", projectId).order("created_at").order("name")),
    async listIssues(projectId) {
      const data = await rows<IssueRow & { trades: { name: string } | null }>(
        sb.from("room_issues").select("id,room_id,kind,title,description,raised_by,raised_at,completed_at,voided_at,trades(name)").eq("project_id", projectId).order("raised_at"));
      return data.map(({ trades, ...i }) => ({ ...i, trade_name: trades?.name ?? null }));
    },
    listIssuePhotos: (projectId) => rows<IssuePhotoRow>(sb.from("issue_photos").select("id,issue_id,storage_path,captured_at,confirmed_at,annotated_from").eq("project_id", projectId).order("captured_at")),
    async listProfiles(ids) { return ids.length === 0 ? [] : rows<ProfileRow>(sb.from("profiles").select("id,full_name,email").in("id", ids)); },
    listRoomChecks: (projectId) => rows<RoomCheckRow>(sb.from("room_checks").select("room_id,item_key,state,note,checked_by,checked_at").eq("project_id", projectId)),
    async createReport(a) {
      const { data, error } = await sb.rpc("create_report", { p_id: a.id, p_project: a.projectId, p_type: a.type, p_path: a.path, p_bytes: a.bytes, p_options: a.options });
      if (error) fail(error);
      return data as ReportRow;
    },
    async getReport(id) {
      const { data, error } = await sb.from("reports").select("*").eq("id", id).maybeSingle();
      if (error) fail(error);
      return (data as ReportRow | null) ?? null;
    },
    async queueReportSend(id, name, email) {
      const { data, error } = await sb.rpc("queue_report_send", { p_report_id: id, p_recipient_name: name, p_recipient_email: email });
      if (error) fail(error);
      return data as ReportRow;
    },
    async markReportSent(id, messageId) { const { error } = await sb.rpc("mark_report_sent", { p_report_id: id, p_message_id: messageId }); if (error) fail(error); },
    async markReportPrinted(id) { const { error } = await sb.rpc("mark_report_printed", { p_report_id: id }); if (error) fail(error); },
    async markReportShared(id, emails) { const { error } = await sb.rpc("mark_report_shared", { p_report_id: id, p_emails: emails }); if (error) fail(error); },
    async pruneReports(projectId, type, keepId) {
      const { data, error } = await sb.rpc("prune_reports", { p_project: projectId, p_type: type, p_keep: keepId });
      if (error) fail(error);
      return (data ?? []) as string[];
    },
    async listReportPaths(projectId) { return (await rows<{ storage_path: string }>(sb.from("reports").select("storage_path").eq("project_id", projectId))).map((r) => r.storage_path); },
    async markReportFailed(id, message) { const { error } = await sb.rpc("mark_report_failed", { p_report_id: id, p_error: message }); if (error) fail(error); },
  };
}

export function supabaseStorage(sb: SupabaseClient): ReportStorage {
  return {
    async download(bucket, path) {
      const { data, error } = await sb.storage.from(bucket).download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async upload(bucket, path, bytes) {
      const { error } = await sb.storage.from(bucket).upload(path, bytes, { contentType: "application/pdf", upsert: false });
      if (error) throw new ReportError("upload_failed", `Could not store the PDF: ${error.message}`);
    },
    async remove(bucket, paths) {
      const { data, error } = await sb.storage.from(bucket).remove(paths);
      if (error) return paths.length;
      return Math.max(0, paths.length - (data?.length ?? 0));
    },
    async list(bucket, folder) {
      const { data, error } = await sb.storage.from(bucket).list(folder, { limit: 1000 });
      if (error || !data) return [];
      return data.filter((f) => f.id !== null).map((f) => ({ path: `${folder}/${f.name}`, createdAt: f.created_at ?? null }));
    },
    async signedUrl(bucket, path, seconds) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, seconds);
      if (error || !data) throw new ReportError("preview_failed", `Could not make a preview link: ${error?.message ?? "unknown"}`);
      return data.signedUrl;
    },
  };
}

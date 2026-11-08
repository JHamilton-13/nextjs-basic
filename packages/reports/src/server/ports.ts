export interface ReportProject { id: string; name: string; address: string | null; prepared_for_name: string | null; prepared_for_email: string | null }
export interface RoomRow { id: string; name: string }
export interface IssueRow {
  id: string; room_id: string; kind: string; title: string; description: string | null; trade_name: string | null;
  raised_by: string; raised_at: string; completed_at: string | null; voided_at: string | null;
}
export interface IssuePhotoRow { id: string; issue_id: string; storage_path: string; captured_at: string; confirmed_at: string | null; annotated_from: string | null }
export interface ProfileRow { id: string; full_name: string | null; email: string | null }
export interface RoomCheckRow { room_id: string; item_key: string; state: "done" | "not_done" | "na"; note: string | null; checked_by: string; checked_at: string }
export interface ReportRow {
  id: string; project_id: string; report_type: "builder_site_audit" | "room_status"; storage_path: string; file_size: number;
  status: "built" | "queued" | "sent" | "failed"; recipient_name: string | null; recipient_email: string | null;
  built_at: string; queued_at: string | null; sent_at: string | null; printed_at: string | null; message_id: string | null; error: string | null;
}

/** Everything the report code needs from the database. Implemented over Supabase (the signed-in manager's session) and by FakeDb in tests. */
export interface ReportDb {
  getProject(id: string): Promise<ReportProject | null>;
  listRooms(projectId: string): Promise<RoomRow[]>;                       // in the app's room order
  listIssues(projectId: string): Promise<IssueRow[]>;
  listIssuePhotos(projectId: string): Promise<IssuePhotoRow[]>;
  listProfiles(ids: string[]): Promise<ProfileRow[]>;
  listRoomChecks(projectId: string): Promise<RoomCheckRow[]>;
  createReport(a: { id: string; projectId: string; type: ReportRow["report_type"]; path: string; bytes: number }): Promise<ReportRow>;
  getReport(id: string): Promise<ReportRow | null>;
  queueReportSend(id: string, recipientName: string | null, recipientEmail: string): Promise<ReportRow>;
  markReportSent(id: string, messageId: string): Promise<void>;
  markReportFailed(id: string, error: string): Promise<void>;
  markReportPrinted(id: string): Promise<void>;
  /** Deletes the reports that are no longer wanted (see migration 1800) and returns their file paths. */
  pruneReports(projectId: string, type: ReportRow["report_type"], keepId: string): Promise<string[]>;
  /** Storage paths of every report row of this job (used to find files nothing points to). */
  listReportPaths(projectId: string): Promise<string[]>;
}

export interface ReportStorage {
  /** null when the file is missing or cannot be read (the report then prints a placeholder). */
  download(bucket: string, path: string): Promise<Buffer | null>;
  upload(bucket: string, path: string, bytes: Buffer): Promise<void>;
  signedUrl(bucket: string, path: string, seconds: number): Promise<string>;
  /** Returns how many files could NOT be removed. */
  remove(bucket: string, paths: string[]): Promise<number>;
  /** Files directly inside a folder, with when they were stored. */
  list(bucket: string, folder: string): Promise<{ path: string; createdAt: string | null }[]>;
}

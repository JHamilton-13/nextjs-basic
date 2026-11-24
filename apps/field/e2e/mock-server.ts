// Local stand-in for the Supabase endpoints the app uses. It reuses the domain package's reference model of apply_op
// (applyOperation), and the REAL example template from supabase/seed.sql. Test-only: never deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOM_CHECK_ITEMS } from "../src/lib/roomChecks";
import { applyOperation, auditState, emptyServerState, evaluate, isValidEmail, type AuditItemOutcome, type ServerState } from "@phc/domain";
import { fakeTransport, handleReportsRequest, ReportError, type ReportDb, type ReportRow, type ReportStorage } from "@phc/reports";
import { Buffer as NodeBuffer } from "node:buffer";

const PORT = Number(process.env.MOCK_PORT ?? 54500);
const TOKEN = "test-token";
const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201"; const T = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000004";

const seed = fs.readFileSync(path.resolve(__dirname, "../../../supabase/seed.sql"), "utf8");
const config = JSON.parse(seed.split("$json$")[1]!) as { sections: { key: string; items: { key: string; kind: string; rule?: { plus64: number; minus64: number; reviewBand64?: number; source: string; sourceRef: string; method: string } }[] }[] };
type Def = { key: string; kind: string; critical: boolean; requires?: { photo?: number }; rule?: { plus64: number; minus64: number; reviewBand64?: number; source: string; sourceRef: string; method: string } };
const items = config.sections.flatMap((s) => s.items) as unknown as Def[];
const policy = (config as unknown as { policy: { nonCriticalIssueState: "manager_review_required" | "ready_with_exceptions" } }).policy;
const photos = new Map<string, { id: string; audit_id: string; version: number; item_key: string | null; storage_path: string; bytes: number; confirmed: boolean; annotated_from: string | null; annotations: unknown[] | null }>();
// current result + who/when for every audit item row, per version (mirrors audit_items on the real server)
const rows = new Map<string, { result: string; row_version: number; result_at: string | null; result_by: string | null; issue_at: string | null; issue_by: string | null }>();
const R2 = "00000000-0000-4000-8000-000000000202";
const checks = new Map<string, { state: string; note: string | null; checked_at: string; row_version: number }>();
const LABEL = "Pat Installer";
// ---- issues (mirrors room_issues / issue_photos / trades on the real server) ----
const OTHER = "00000000-0000-4000-8000-000000000005"; const OTHER_LABEL = "Sam Other";
const TRADES = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "Plumbing", sort_order: 10, active: true },
  { id: "00000000-0000-4000-8000-0000000000a2", name: "Electrical", sort_order: 20, active: true },
  { id: "00000000-0000-4000-8000-0000000000a3", name: "HVAC", sort_order: 30, active: true },
  { id: "00000000-0000-4000-8000-0000000000a4", name: "Roofing", sort_order: 100, active: false },
];
type IssueRow = { id: string; project_id: string; room_id: string; kind: string; trade_id: string | null; title: string; description: string | null; row_version: number;
  raised_by: string; raised_at: string; completed_by: string | null; completed_at: string | null; completed_note: string | null; voided_by: string | null; voided_at: string | null; void_note: string | null };
type IssuePhotoRow = { id: string; issue_id: string; project_id: string; storage_path: string; bytes: number; checksum_sha256: string; captured_by: string; captured_at: string; confirmed_at: string | null; annotated_from: string | null; annotations: unknown[] | null };
const SEED_ISSUE = "00000000-0000-4000-8000-00000000b001"; const SEED_PHOTO = "00000000-0000-4000-8000-00000000b101";
const SEED_PHOTO_PATH = `${P}/issues/${SEED_ISSUE}/${SEED_PHOTO}.jpg`;
const issues = new Map<string, IssueRow>();
const issuePhotos = new Map<string, IssuePhotoRow>();
const MANAGERS = new Set(["admin", "production_manager", "project_manager", "installation_manager"]);
let myRole = "installer";
const seedPhotoBytes = fs.readFileSync(path.resolve(__dirname, "camera-12mp-exif6.jpg"));
const objects = new Map<string, number>();
const objectBytes = new Map<string, Buffer>();
let storageDown = false;

// ---- reports (mirrors projects.prepared_for_*, public.reports and the 'reports' bucket on the real server; the api handler is the REAL code) ----
let contact = { prepared_for_name: null as string | null, prepared_for_email: null as string | null, address: "1 Test St" as string | null, contact_source: null as string | null };
const reports = new Map<string, ReportRow>();
let transport = fakeTransport();
let transportFail: string | null = null;
const sentMail: { to: string; from: string; subject: string; filename: string; isPdf: boolean }[] = [];

let state: ServerState = emptyServerState();
function seedIssues() {
  for (const k of [...issues.keys()]) issues.delete(k);
  for (const k of [...issuePhotos.keys()]) { const ph = issuePhotos.get(k)!; objects.delete(ph.storage_path); objectBytes.delete(ph.storage_path); issuePhotos.delete(k); }
  state = { ...state, versions: Object.fromEntries(Object.entries(state.versions).filter(([k]) => !k.startsWith("room_issue:"))) };
  issues.set(SEED_ISSUE, { id: SEED_ISSUE, project_id: P, room_id: R, kind: "touch_up", trade_id: null, title: "Scuffed panel (raised by Sam)", description: "Left end panel", row_version: 1,
    raised_by: OTHER, raised_at: "2026-11-07T15:00:00Z", completed_by: null, completed_at: null, completed_note: null, voided_by: null, voided_at: null, void_note: null });
  state = { ...state, versions: { ...state.versions, [`room_issue:${SEED_ISSUE}`]: 1 } };
  issuePhotos.set(SEED_PHOTO, { id: SEED_PHOTO, issue_id: SEED_ISSUE, project_id: P, storage_path: SEED_PHOTO_PATH, bytes: seedPhotoBytes.length, checksum_sha256: "b".repeat(64), captured_by: OTHER, captured_at: "2026-11-07T15:01:00Z", confirmed_at: "2026-11-07T15:02:00Z", annotated_from: null, annotations: null });
  objects.set(SEED_PHOTO_PATH, seedPhotoBytes.length); objectBytes.set(SEED_PHOTO_PATH, seedPhotoBytes);
  myRole = "installer";
  contact = { prepared_for_name: null, prepared_for_email: null, address: "1 Test St", contact_source: null };
  reports.clear(); sentMail.length = 0; transportFail = null;
  for (const k of [...objectBytes.keys()]) if (k.startsWith(`${P}/`) && k.endsWith(".pdf") && !k.includes("/issues/")) { objectBytes.delete(k); objects.delete(k); }
}
const labelOf = (uid: string | null) => (uid === USER ? LABEL : uid === OTHER ? OTHER_LABEL : null);
const profile = (uid: string | null) => (uid ? { full_name: labelOf(uid), email: `${uid}@phc.test` } : null);
const log: { opId: string; entity: string; entityId: string; baseVersion: number; outcome: string }[] = [];
seedIssues();
let dropNext = 0; let down = false; let hang = false;
const plog = (kind: string, extra: Record<string, unknown> = {}) => log.push({ opId: String(extra.id ?? kind), entity: kind, entityId: String(extra.id ?? ''), baseVersion: 0, outcome: kind, ...extra } as never);

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS,PATCH,DELETE", "access-control-expose-headers": "*" };
function multipartFileBuf(buf: Buffer, contentType: string): Buffer {
  const m = /boundary=(.+)$/.exec(contentType); if (!m) return buf;
  const bin = buf.toString("binary");
  for (const part of bin.split(`--${m[1]}`)) { if (/name=""/.test(part)) { const start = part.indexOf("\r\n\r\n") + 4; return Buffer.from(part.slice(start, part.length - 2), "binary"); } }
  return buf;
}
const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function itemRows(auditId: string, version: number) {
  return items.map((it) => {
    const r = rows.get(`${auditId}:${version}:${it.key}`);
    return {
      item_key: it.key, result: r?.result ?? "NOT_ENTERED", row_version: r?.row_version ?? 0, result_at: r?.result_at ?? null, issue_raised_at: r?.issue_at ?? null,
      result_by_profile: r?.result_by ? { full_name: r.result_by, email: "installer@phc.test" } : null,
      issue_by_profile: r?.issue_by ? { full_name: r.issue_by, email: "installer@phc.test" } : null,
    };
  });
}

function resultFor(it: Def, payload: { actual64?: number; expected64?: number; result?: string }): string {
  if (payload.result) return payload.result;
  if (it.kind === "observation") return "OBSERVED";
  if (it.rule && payload.actual64 !== undefined && payload.expected64 !== undefined) {
    const ev = evaluate(payload.actual64, { expected: payload.expected64, plus: it.rule.plus64, minus: it.rule.minus64, ...(it.rule.reviewBand64 !== undefined ? { reviewBand: it.rule.reviewBand64 } : {}), source: it.rule.source as never, sourceRef: it.rule.sourceRef, method: it.rule.method });
    if (ev.ok) return ev.value.result; // the server computes the result, as the real apply_op does
  }
  return "NOT_ENTERED";
}

function mockReportDb(): ReportDb {
  const deny = () => { if (!MANAGERS.has(myRole)) throw new ReportError("forbidden", "forbidden"); };
  return {
    async getProject() { deny(); return { id: P, name: "Demo Project (mock)", address: contact.address, prepared_for_name: contact.prepared_for_name, prepared_for_email: contact.prepared_for_email }; },
    async listRooms() { return [{ id: R, name: "Kitchen" }, { id: R2, name: "Bath 1" }]; },
    async listIssues() { return [...issues.values()].map((i) => ({ id: i.id, room_id: i.room_id, kind: i.kind, title: i.title, description: i.description, trade_name: TRADES.find((x) => x.id === i.trade_id)?.name ?? null, raised_by: i.raised_by, raised_at: i.raised_at, completed_at: i.completed_at, voided_at: i.voided_at })); },
    async listIssuePhotos() { return [...issuePhotos.values()].map((p) => ({ id: p.id, issue_id: p.issue_id, storage_path: p.storage_path, captured_at: p.captured_at, confirmed_at: p.confirmed_at, annotated_from: p.annotated_from })); },
    async listProfiles(ids) { return [{ id: USER, full_name: LABEL, email: "installer@phc.test" }, { id: OTHER, full_name: OTHER_LABEL, email: "sam@phc.test" }].filter((p) => ids.includes(p.id)); },
    async listRoomChecks() { return [...checks.entries()].map(([k, v]) => { const [room_id, item_key] = k.split(":"); return { room_id: room_id!, item_key: item_key!, state: v.state as "done" | "not_done" | "na", note: v.note, checked_by: USER, checked_at: v.checked_at }; }); },
    async createReport(a) {
      deny();
      const r: ReportRow = { id: a.id, project_id: a.projectId, report_type: a.type, storage_path: a.path, file_size: a.bytes, options: a.options ?? null, built_at: new Date().toISOString(), status: "built", recipient_name: null, recipient_email: null, queued_at: null, sent_at: null, printed_at: null, shared_at: null, shared_to: null, message_id: null, error: null };
      reports.set(r.id, r); plog("report_built", { id: r.id, type: a.type, bytes: a.bytes }); return { ...r };
    },
    async getReport(id) { deny(); const r = reports.get(id); return r ? { ...r } : null; },
    async queueReportSend(id, name, email) {
      deny(); const r = reports.get(id); if (!r) throw new ReportError("forbidden", "forbidden");
      if (r.status === "sent") throw new ReportError("report_already_sent", "report_already_sent");
      if (r.status === "queued" && r.queued_at && Date.now() - Date.parse(r.queued_at) < 10 * 60_000) throw new ReportError("report_already_queued", "report_already_queued");
      Object.assign(r, { status: "queued", queued_at: new Date().toISOString(), recipient_name: name, recipient_email: email, error: null }); return { ...r };
    },
    async markReportPrinted(id) { deny(); const r = reports.get(id); if (!r) throw new ReportError("forbidden", "forbidden"); r.printed_at = new Date().toISOString(); plog("report_printed", { id }); },
    async markReportShared(id, emails) { deny(); const r = reports.get(id); if (!r) throw new ReportError("forbidden", "forbidden"); r.shared_at = new Date().toISOString(); r.shared_to = emails; plog("report_shared", { id, n: emails.length }); },
    async listReportPaths(projectId) { return [...reports.values()].filter((r) => r.project_id === projectId).map((r) => r.storage_path); },
    async pruneReports(projectId, type, keepId) {                       // same rule as prune_reports in migration 1800
      deny();
      const saved = (r: ReportRow) => r.sent_at !== null || r.printed_at !== null || r.shared_at !== null;
      const stamp = (r: ReportRow) => Math.max(r.sent_at ? Date.parse(r.sent_at) : -Infinity, r.printed_at ? Date.parse(r.printed_at) : -Infinity, r.shared_at ? Date.parse(r.shared_at) : -Infinity);
      const newest = [...reports.values()].filter((r) => r.project_id === projectId && r.report_type === type && saved(r)).sort((a, b) => stamp(b) - stamp(a))[0];
      const now = Date.now(); const paths: string[] = [];
      for (const r of [...reports.values()]) {
        if (r.status === "queued" && r.queued_at && now - Date.parse(r.queued_at) < 10 * 60_000) continue;
        if ((r.report_type === type && r.id !== keepId && r.id !== newest?.id) || (!saved(r) && now - Date.parse(r.built_at) > 3_600_000)) { reports.delete(r.id); paths.push(r.storage_path); }
      }
      plog("report_prune", { id: keepId, removed: paths.length });
      return paths;
    },
    async markReportSent(id, messageId) { const r = reports.get(id)!; Object.assign(r, { status: "sent", sent_at: new Date().toISOString(), message_id: messageId }); },
    async markReportFailed(id, error) { const r = reports.get(id)!; Object.assign(r, { status: "failed", error }); },
  };
}
function mockReportStorage(): ReportStorage {
  return {
    async download(bucket, p) { const b = objectBytes.get(p); return b ? NodeBuffer.from(b) : null; },
    async upload(bucket, p, bytes) { objectBytes.set(p, bytes); objects.set(p, bytes.length); },
    async remove(bucket, paths) { let failed = 0; for (const p of paths) { if (!objectBytes.delete(p)) failed++; objects.delete(p); } return failed; },
    async list(bucket, folder) { return [...objectBytes.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/") && !k.includes("/issues/")).map((k) => ({ path: k, createdAt: "2020-01-01T00:00:00Z" })); },
    async signedUrl(bucket, p) { return `${"http://127.0.0.1:" + PORT}/storage/v1/object/sign/${bucket}/${p}?token=mock`; },
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return void res.end(); }
  const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks); const body = raw.toString("utf8");
    if (url.pathname === "/__state") return send(res, 200, { log, versions: state.versions });
    if (url.pathname === "/__control") { const c = JSON.parse(body || "{}"); if (c.dropNextResponses !== undefined) dropNext = c.dropNextResponses; if (c.down !== undefined) down = c.down; if (c.storageDown !== undefined) storageDown = c.storageDown; if (c.hang !== undefined) hang = c.hang; if (c.role !== undefined) myRole = String(c.role); if (c.resetIssues) seedIssues(); if (c.contact) contact = { ...contact, ...c.contact }; if (c.sendFail !== undefined) transportFail = c.sendFail; if (c.stuckQueuedMinutes !== undefined) { for (const r of reports.values()) if (r.status === "queued") r.queued_at = new Date(Date.now() - c.stuckQueuedMinutes * 60_000).toISOString(); } if (c.resetChecks) { checks.clear(); state = { ...state, versions: Object.fromEntries(Object.entries(state.versions).filter(([k]) => !k.startsWith("room_check:"))) }; } return send(res, 200, { dropNext, down, storageDown, hang }); }
    if (url.pathname === "/__photos") return send(res, 200, { photos: [...photos.values()], objects: Object.fromEntries([...objects].filter(([k]) => !k.includes("/issues/"))) }); // audit photos only (issue photos have their own seed)
    if (url.pathname === "/__sent") return send(res, 200, { sent: sentMail, reports: [...reports.values()], contact, files: [...objectBytes.keys()].filter((k) => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/i.test(k)) });
    if (url.pathname === "/__rows") return send(res, 200, Object.fromEntries(rows));
    if (down) { res.destroy(); return; }
    if (hang) { return; } // accept the connection and never answer: the "Wi-Fi without internet" case
    if (url.pathname === "/auth/v1/logout") { plog("auth_logout", { scope: url.searchParams.get("scope") ?? "global" }); res.writeHead(204, cors); return void res.end(); }
    if (url.pathname === "/auth/v1/authorize") { plog("auth_authorize", { provider: url.searchParams.get("provider") ?? "", redirect_to: url.searchParams.get("redirect_to") ?? "" }); res.writeHead(200, { ...cors, "content-type": "text/html" }); return void res.end("<html><body>mock sign-in</body></html>"); }
    if (url.pathname.startsWith("/auth/v1/user")) { if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { code: 401, msg: "invalid JWT" }); return send(res, 200, { id: USER, aud: "authenticated", email: "installer@phc.test" }); }
    if (url.pathname.startsWith("/auth/v1/token")) return send(res, 200, { access_token: TOKEN, token_type: "bearer", expires_in: 3600, refresh_token: "r2", user: { id: USER, email: "installer@phc.test" } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { code: "PGRST301", message: "JWT expired" });

    if (url.pathname === "/rest/v1/projects" && req.method === "PATCH") {
      const b = JSON.parse(body) as Record<string, string | null>;
      if (b.prepared_for_email && !isValidEmail(b.prepared_for_email)) return send(res, 400, { code: "23514", message: 'new row for relation "projects" violates check constraint "projects_prepared_for_email_check"' });
      if (!MANAGERS.has(myRole)) return send(res, 200, []);                                        // row-level security: the update matches no row
      contact = { prepared_for_name: b.prepared_for_name ?? null, prepared_for_email: b.prepared_for_email ?? null, address: b.address ?? null, contact_source: b.contact_source ?? null };
      plog("project_contact_save", { id: P, ...b });
      res.writeHead(204, cors); return void res.end();
    }
    if (url.pathname === "/rest/v1/projects") {
      const row = { id: P, name: "Demo Project (mock)", customer: "Mock Customer", address: contact.address, prepared_for_name: contact.prepared_for_name, prepared_for_email: contact.prepared_for_email, contact_source: contact.contact_source };
      return send(res, 200, String(req.headers.accept ?? "").includes("vnd.pgrst.object") ? row : [row]);
    }
    if (url.pathname === "/rest/v1/reports" && req.method === "GET") {
      let list = MANAGERS.has(myRole) ? [...reports.values()].sort((a, b) => b.built_at.localeCompare(a.built_at)) : [];
      const idf = url.searchParams.get("id"); if (idf?.startsWith("eq.")) list = list.filter((r) => r.id === idf.slice(3));
      return send(res, 200, String(req.headers.accept ?? "").includes("vnd.pgrst.object") ? (list[0] ?? null) : list);
    }
    if (url.pathname.startsWith("/storage/v1/object/sign/reports/") && req.method === "POST") {
      const objPath = decodeURIComponent(url.pathname.slice("/storage/v1/object/sign/reports/".length));
      plog("report_preview_link", { id: objPath });
      return send(res, 200, { signedURL: `/object/sign/reports/${objPath}?token=mock` });
    }
    if (url.pathname.startsWith("/storage/v1/object/sign/reports/") && req.method === "GET") {
      const bytes = objectBytes.get(decodeURIComponent(url.pathname.slice("/storage/v1/object/sign/reports/".length)));
      if (!bytes) return send(res, 404, { message: "not found" });
      res.writeHead(200, { ...cors, "content-type": "application/pdf" }); return void res.end(bytes);
    }
    if (url.pathname === "/storage/v1/object/reports" && req.method === "DELETE") {
      const { prefixes } = JSON.parse(body || "{}") as { prefixes: string[] };
      const gone = prefixes.filter((p) => objectBytes.delete(p)); gone.forEach((p) => objects.delete(p));
      plog("report_files_removed", { id: gone.join(",") });
      return send(res, 200, gone.map((name) => ({ name })));
    }
    if (url.pathname === "/storage/v1/object/list/reports" && req.method === "POST") {
      const { prefix } = JSON.parse(body || "{}") as { prefix: string };
      return send(res, 200, [...objectBytes.keys()].filter((k) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/") && !k.includes("/issues/")).map((k) => ({ id: "x", name: k.slice(prefix.length + 1), created_at: "2020-01-01T00:00:00Z" })));
    }
    const rpc = /^\/rest\/v1\/rpc\/(create_report|queue_report_send|mark_report_sent|mark_report_failed|mark_report_printed|mark_report_shared|prune_reports)$/.exec(url.pathname);
    if (rpc && req.method === "POST") {                                   // the real functions' names and parameters (migration 1700)
      const b = JSON.parse(body || "{}") as Record<string, never>; const db = mockReportDb();
      try {
        if (rpc[1] === "create_report") return send(res, 200, await db.createReport({ id: b.p_id, projectId: b.p_project, type: b.p_type, path: b.p_path, bytes: b.p_bytes, options: (b as { p_options?: never }).p_options }));
        if (rpc[1] === "queue_report_send") return send(res, 200, await db.queueReportSend(b.p_report_id, b.p_recipient_name ?? null, b.p_recipient_email));
        if (rpc[1] === "mark_report_sent") { await db.markReportSent(b.p_report_id, b.p_message_id); return send(res, 200, null); }
        if (rpc[1] === "mark_report_shared") { await db.markReportShared(b.p_report_id, (b as unknown as { p_emails: string[] }).p_emails); return send(res, 200, null); }
        if (rpc[1] === "mark_report_printed") { await db.markReportPrinted(b.p_report_id); return send(res, 200, null); }
        if (rpc[1] === "prune_reports") return send(res, 200, await db.pruneReports(b.p_project, b.p_type, b.p_keep));
        await db.markReportFailed(b.p_report_id, b.p_error); return send(res, 200, null);
      } catch (e) { return send(res, 400, { code: "P0001", message: e instanceof Error ? e.message : "error" }); }
    }
    if (url.pathname === "/api/reports") {
      let parsed: unknown = null; try { parsed = JSON.parse(body || "null"); } catch { parsed = null; }
      const out = await handleReportsRequest({ method: req.method ?? "", authorization: req.headers.authorization, body: parsed }, {
        getUser: async (tok) => (tok === TOKEN ? { id: USER, email: "installer@phc.test" } : null),
        makeDeps: () => ({ db: mockReportDb(), storage: mockReportStorage() }),
        transport: () => ({ async send(m) {
          if (transportFail) throw new Error(transportFail);
          const r = await transport.send(m);
          sentMail.push({ to: m.to, from: m.from, subject: m.subject, filename: m.attachment.filename, isPdf: m.attachment.content.subarray(0, 5).toString() === "%PDF-" });
          return r;
        } }),
        env: { REPORT_FROM: "Test Reports <reports@example.test>", REPORT_TIMEZONE: "America/Phoenix", PHC_EMAIL_DOMAIN: "phc.example" },
      });
      return send(res, out.status, out.json);
    }
    if (url.pathname === "/rest/v1/rooms") return send(res, 200, [
      { id: R, project_id: P, name: "Kitchen", floor: null, details_source: "cockpit", details: { panelName: "Slab", woodSpecies: "Pre Finished", finishName: "Uniboard K15 Cannes Riviera Oak", edgebanding: "To Match", crownProfile: "Flat Crown", toeKickStyle: "TBD", sheen: "Pre Finished" } },
      { id: R2, project_id: P, name: "Bath 1", floor: null, details_source: "masterfile", details: { panelName: "Slab", woodSpecies: "Pre Finished", finishName: "UNIBOARD - K16 Esterel Riviera Oak", edgebanding: "To Match" } },
    ]);
    if (url.pathname === "/rest/v1/room_checks") return send(res, 200, [...checks.entries()].map(([k, v]) => { const [room_id, item_key] = k.split(":"); return { room_id, item_key, project_id: P, state: v.state, note: v.note, checked_by: USER, checked_at: v.checked_at, row_version: v.row_version, by: { full_name: LABEL, email: "installer@phc.test" } }; }));
    if (url.pathname === "/rest/v1/trades") return send(res, 200, TRADES);
    if (url.pathname === "/rest/v1/project_members") return send(res, 200, [{ project_id: P, role: myRole }]);
    if (url.pathname === "/rest/v1/profiles") {
      const all = [{ id: USER, full_name: LABEL, email: "installer@phc.test", is_admin: false }, { id: OTHER, full_name: OTHER_LABEL, email: "sam@phc.test", is_admin: false }];
      const f = url.searchParams.get("id"); let list = all;
      if (f?.startsWith("eq.")) list = all.filter((p) => p.id === f.slice(3));
      else if (f?.startsWith("in.(")) { const ids = f.slice(4, -1).split(",").map((s) => s.replace(/"/g, "")); list = all.filter((p) => ids.includes(p.id)); }
      return send(res, 200, String(req.headers.accept ?? "").includes("vnd.pgrst.object") ? (list[0] ?? null) : list);
    }
    if (url.pathname === "/rest/v1/room_issues" && req.method === "GET") {
      return send(res, 200, [...issues.values()].map((r) => ({ ...r, raised_p: profile(r.raised_by), completed_p: profile(r.completed_by), voided_p: profile(r.voided_by) })));
    }
    if (url.pathname === "/rest/v1/issue_photos" && req.method === "GET") return send(res, 200, [...issuePhotos.values()]);
    if (url.pathname === "/rest/v1/issue_photos" && req.method === "POST") {
      const row = JSON.parse(body) as { id: string; issue_id: string; project_id: string; storage_path: string; bytes: number; checksum_sha256: string; captured_by: string; captured_at: string; annotated_from?: string; annotations?: unknown[] };
      if (issuePhotos.has(row.id)) return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
      const iss = issues.get(row.issue_id);
      if (!iss || iss.project_id !== row.project_id) return send(res, 409, { code: "23503", message: "violates foreign key constraint (the issue does not exist)" });
      if (row.annotated_from) {
        const o = issuePhotos.get(row.annotated_from);
        if (!o || o.annotated_from || o.issue_id !== row.issue_id) return send(res, 400, { code: "23514", message: "invalid annotated copy" });
      }
      issuePhotos.set(row.id, { id: row.id, issue_id: row.issue_id, project_id: row.project_id, storage_path: row.storage_path, bytes: Number(row.bytes), checksum_sha256: row.checksum_sha256, captured_by: row.captured_by, captured_at: row.captured_at, confirmed_at: null, annotated_from: row.annotated_from ?? null, annotations: row.annotations ?? null });
      plog("issue_photo_register", { id: row.id, issue_id: row.issue_id, annotated_from: row.annotated_from ?? null });
      res.writeHead(201, cors); return void res.end();
    }
    if (url.pathname === "/rest/v1/audit_templates") return send(res, 200, [{ id: T, name: "EXAMPLE - Pre-Install Site Audit (sample)", version: 1, config }]);
    if (url.pathname === "/rest/v1/audit_items") {
      const auditId = (url.searchParams.get("audit_id") ?? "").replace("eq.", "");
      const version = Number((url.searchParams.get("version") ?? "eq.1").replace("eq.", ""));
      return send(res, 200, itemRows(auditId, version));
    }
    if (url.pathname === "/rest/v1/photos" && req.method === "POST") {
      const row = JSON.parse(body) as { id: string; audit_id: string; version?: number; item_key: string | null; storage_path: string; bytes: number; annotated_from?: string; annotations?: unknown[] };
      if (photos.has(row.id)) return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
      if (row.annotated_from) { // same rules as the database: only originals can be annotated, on the same audit and item
        const o = photos.get(row.annotated_from);
        if (!o || o.annotated_from || o.audit_id !== row.audit_id || o.item_key !== row.item_key) return send(res, 400, { code: "23514", message: "invalid annotated copy" });
      }
      photos.set(row.id, { id: row.id, audit_id: row.audit_id, version: row.version ?? 1, item_key: row.item_key, storage_path: row.storage_path, bytes: Number(row.bytes), confirmed: false, annotated_from: row.annotated_from ?? null, annotations: row.annotations ?? null });
      plog("photo_register", { id: row.id, item_key: row.item_key, annotated_from: row.annotated_from ?? null, shapes: row.annotations ? row.annotations.length : 0 });
      res.writeHead(201, cors); return void res.end();
    }
    const storageMatch = /^\/storage\/v1\/object\/(audit-photos|issue-photos|reports)\/(.*)$/.exec(url.pathname);
    if (storageMatch && req.method === "GET") {
      const objPath = decodeURIComponent(storageMatch[2]!);
      const bytes = objectBytes.get(objPath);
      if (!bytes) return send(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
      plog("photo_download", { id: objPath });
      res.writeHead(200, { ...cors, "content-type": "image/jpeg" }); return void res.end(bytes);
    }
    if (storageMatch && req.method === "POST") {
      if (storageDown) { res.destroy(); return; }
      const objPath = decodeURIComponent(storageMatch[2]!);
      if (objects.has(objPath)) return send(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const file = multipartFileBuf(raw, String(req.headers["content-type"] ?? ""));
      objects.set(objPath, file.length); objectBytes.set(objPath, file); plog("photo_upload", { id: objPath, size: file.length });
      return send(res, 200, { Key: `${storageMatch[1]}/${objPath}`, Id: objPath });
    }
    if (url.pathname === "/rest/v1/rpc/confirm_photo" && req.method === "POST") {
      const { p_photo_id } = JSON.parse(body) as { p_photo_id: string };
      const ph = photos.get(p_photo_id);
      if (!ph) return send(res, 400, { code: "P0001", message: "photo_not_found" });
      if (ph.confirmed) return send(res, 200, null);
      const size = objects.get(ph.storage_path);
      if (size === undefined) return send(res, 400, { code: "P0001", message: "upload_not_found" });
      if (size !== ph.bytes) return send(res, 400, { code: "P0001", message: "size_mismatch" });
      ph.confirmed = true; plog("photo_confirm", { id: p_photo_id });
      return send(res, 200, null);
    }
    if (url.pathname === "/rest/v1/rpc/confirm_issue_photo" && req.method === "POST") {
      const { p_photo_id } = JSON.parse(body) as { p_photo_id: string };
      const ph = issuePhotos.get(p_photo_id);
      if (!ph) return send(res, 400, { code: "P0001", message: "photo_not_found" });
      if (ph.confirmed_at) return send(res, 200, null);
      const size = objects.get(ph.storage_path);
      if (size === undefined) return send(res, 400, { code: "P0001", message: "upload_not_found" });
      if (size !== ph.bytes) return send(res, 400, { code: "P0001", message: "size_mismatch" });
      ph.confirmed_at = new Date().toISOString(); plog("issue_photo_confirm", { id: p_photo_id });
      return send(res, 200, null);
    }
    if (url.pathname === "/rest/v1/rpc/audit_state" && req.method === "POST") {
      const { p_audit_id, p_version } = JSON.parse(body) as { p_audit_id: string; p_version: number };
      const outcomes: AuditItemOutcome[] = itemRows(p_audit_id, p_version).map((r) => ({ itemId: r.item_key, critical: items.find((i) => i.key === r.item_key)!.critical, result: r.result as never }));
      const submitted = ((state.versions[`audit:${p_audit_id}:${p_version}`] ?? 0) >= 2);
      return send(res, 200, auditState({ auditId: p_audit_id, projectId: P, version: p_version, submitted, items: outcomes, overrides: [] }, policy));
    }
    if (url.pathname === "/rest/v1/rpc/apply_op" && req.method === "POST") {
      const { op } = JSON.parse(body) as { op: { opId: string; entity: string; entityId: string; baseVersion: number; createdAt: string; payload: Record<string, unknown> } };
      const reject = (message: string) => { plog("op_rejected", { id: op.opId, reason: message }); return send(res, 200, { status: "rejected", message }); };
      if (op.entity === "audit_item") { // the real apply_op counts REGISTERED original photos (this version or earlier) as evidence; so must the mock
        const [aId, ver, iKey] = op.entityId.split(":");
        const need = items.find((i) => i.key === iKey)?.requires?.photo ?? 0;
        const have = [...photos.values()].filter((p) => p.audit_id === aId && p.version <= Number(ver) && p.item_key === iKey && !p.annotated_from).length;
        if (have < need) return reject("evidence_missing: photo");
      }
      if (op.entity === "audit" && op.payload.action === "revise") {
        const [aId, ver] = op.entityId.split(":"); const prev = Number(ver) - 1;
        if (!String(op.payload.reason ?? "").trim()) return reject("reason_required");
        if ((state.versions[`audit:${aId}:${prev}`] ?? 0) < 2) return reject("not_submitted"); // previous version must be submitted
      }
      if (op.entity === "room_issue") { // the same rules, in the same order, as app.op_room_issue
        const id = op.entityId; const key = `room_issue:${id}`; const pl = op.payload; const action = String(pl.action ?? "");
        const conflictOrApply = () => applyOperation(state, op as never);
        if (state.applied[op.opId]) { const d = conflictOrApply(); return send(res, 200, d.outcome); }
        const title = String(pl.title ?? "").trim(); const note = String(pl.note ?? "").trim(); const desc = String(pl.description ?? "").trim();
        const KINDS = ["pre_install_correction", "punch_item", "touch_up", "missing_part", "damaged_part"];
        if (!["create", "update", "complete", "reopen", "void"].includes(action)) return reject("action must be create, update, complete, reopen or void");
        if (pl.kind !== undefined && !KINDS.includes(String(pl.kind))) return reject("unknown issue kind");
        const tradeGiven = "tradeId" in pl; const trade = pl.tradeId === null || pl.tradeId === undefined ? null : String(pl.tradeId);
        const tradeCheck = (t: string | null): string | null => { if (!t) return "trade_required"; const row = TRADES.find((x) => x.id === t); if (!row) return "trade_not_found"; return row.active ? null : "trade_inactive"; };
        const finish = (mutate: () => void) => { const r = applyOperation(state, op as never); if (r.outcome.status === "applied") mutate(); state = r.state;
          log.push({ opId: op.opId, entity: op.entity, entityId: op.entityId, baseVersion: op.baseVersion, outcome: r.outcome.status, action } as never);
          if (dropNext > 0) { dropNext--; res.destroy(); return; } return send(res, 200, r.outcome); };
        const cur = state.versions[key] ?? 0;
        if (action === "create") {
          if (op.baseVersion !== 0) return reject("a new issue starts at version 0");
          if (![R, R2].includes(String(pl.roomId))) return reject("room not found");
          if (pl.kind === undefined) return reject("kind is required");
          if (!title) return reject("a title is required");
          if (pl.kind === "pre_install_correction") { const e = tradeCheck(trade); if (e) return reject(e); } else if (trade) return reject("trade_not_allowed");
          if (issues.has(id)) { const d = conflictOrApply(); return send(res, 200, d.outcome); }
          return finish(() => { issues.set(id, { id, project_id: P, room_id: String(pl.roomId), kind: String(pl.kind), trade_id: trade, title, description: desc || null, row_version: 1, raised_by: USER, raised_at: op.createdAt,
            completed_by: null, completed_at: null, completed_note: null, voided_by: null, voided_at: null, void_note: null }); });
        }
        const row = issues.get(id);
        if (!row) return reject("issue not found");
        if (row.raised_by !== USER && !MANAGERS.has(myRole)) return send(res, 403, { code: "42501", message: "insufficient privilege: only the person who raised an issue, or a manager, can change it" });
        if (op.baseVersion !== cur) { const d = conflictOrApply(); return send(res, 200, d.outcome); }
        if (row.voided_at) return reject("issue_void");
        const bump = () => { row.row_version = cur + 1; };
        if (action === "update") {
          if (row.completed_at) return reject("issue_completed");
          if (pl.kind === undefined && !title && !("description" in pl) && !tradeGiven) return reject("nothing to change");
          const kind = String(pl.kind ?? row.kind); let newTrade = tradeGiven ? trade : row.trade_id;
          if (kind === "pre_install_correction") { if (!newTrade) return reject("trade_required"); if (newTrade !== row.trade_id) { const e = tradeCheck(newTrade); if (e) return reject(e); } }
          else { if (trade) return reject("trade_not_allowed"); newTrade = null; }
          return finish(() => { row.kind = kind; row.trade_id = newTrade; if (title) row.title = title; if ("description" in pl) row.description = desc || null; bump(); });
        }
        if (action === "complete") {
          if (row.completed_at) return reject("already_completed");
          if (row.kind === "damaged_part" && ![...issuePhotos.values()].some((p) => p.issue_id === id && !p.annotated_from)) return reject("photo_required");
          return finish(() => { row.completed_by = USER; row.completed_at = op.createdAt; row.completed_note = note || null; bump(); });
        }
        if (action === "reopen") {
          if (!row.completed_at) return reject("not_completed");
          return finish(() => { row.completed_by = null; row.completed_at = null; row.completed_note = null; bump(); });
        }
        return finish(() => { row.voided_by = USER; row.voided_at = op.createdAt; row.void_note = note || null; bump(); });
      }
      if (op.entity === "room_check") { // the same rules as app.op_room_check
        const [roomId, itemKey] = op.entityId.split(":");
        if (![R, R2].includes(roomId!)) return reject("room not found");
        if (!ROOM_CHECK_ITEMS.some((i) => i.key === itemKey)) return reject("unknown checklist item");
        const st = String(op.payload.state ?? ""); const note = String(op.payload.note ?? "").trim();
        if (!["done", "not_done", "na", "clear"].includes(st)) return reject("state must be done, not_done, na or clear");
        if (st === "not_done" && !note) return reject("a note is required when an item is not done");
      }
      const r = applyOperation(state, op as never);
      let outcome = r.outcome as { status: string; newVersion?: number };
      if (r.outcome.status === "applied" && op.entity === "room_check") {
        const cleared = op.payload.state === "clear";
        if (cleared) { checks.delete(op.entityId); outcome = { status: "applied", newVersion: 0 }; }
        else checks.set(op.entityId, { state: String(op.payload.state), note: op.payload.note ? String(op.payload.note) : null, checked_at: op.createdAt, row_version: r.outcome.newVersion });
      }
      if (r.outcome.status === "applied") {
        if (op.entity === "audit_item") {
          const [aId, ver, iKey] = op.entityId.split(":"); const it = items.find((i) => i.key === iKey)!;
          const k = `${aId}:${ver}:${iKey}`; const prevRow = rows.get(k);
          const result = resultFor(it, op.payload as never); const wasIssue = prevRow && (prevRow.result === "FAIL" || prevRow.result === "REVIEW"); const isIssue = result === "FAIL" || result === "REVIEW";
          rows.set(k, { result, row_version: r.outcome.newVersion, result_at: op.createdAt, result_by: LABEL,
            issue_at: isIssue ? (wasIssue && prevRow?.issue_at ? prevRow.issue_at : op.createdAt) : null, issue_by: isIssue ? (wasIssue && prevRow?.issue_by ? prevRow.issue_by : LABEL) : null });
        }
        if (op.entity === "audit" && op.payload.action === "revise") { // the new version starts as a copy of the previous one, row versions reset to 0
          const [aId, ver] = op.entityId.split(":"); const prev = Number(ver) - 1;
          for (const it of items) { const pr = rows.get(`${aId}:${prev}:${it.key}`); if (pr) rows.set(`${aId}:${ver}:${it.key}`, { ...pr, row_version: 0 }); }
        }
      }
      state = r.state;
      if (op.entity === "room_check" && op.payload.state === "clear" && r.outcome.status === "applied") state = { ...state, versions: { ...state.versions, [`room_check:${op.entityId}`]: 0 } }; // the server deletes the row, so its version restarts at 0
      log.push({ opId: op.opId, entity: op.entity, entityId: op.entityId, baseVersion: op.baseVersion, outcome: r.outcome.status, ...(op.entity === "audit" ? { action: String(op.payload.action) } : {}) } as never);
      if (dropNext > 0) { dropNext--; res.destroy(); return; } // applied on the server, but the response is lost
      return send(res, 200, outcome);
    }
    send(res, 404, { message: `mock: no route ${req.method} ${url.pathname}` });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock supabase on ${PORT}`));

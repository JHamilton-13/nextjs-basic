// Local stand-in for the Supabase endpoints the app uses. It reuses the domain package's reference model of apply_op
// (applyOperation), and the REAL example template from supabase/seed.sql. Test-only: never deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOM_CHECK_ITEMS } from "../src/lib/roomChecks";
import { applyOperation, auditState, emptyServerState, evaluate, type AuditItemOutcome, type ServerState } from "@phc/domain";

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
const objects = new Map<string, number>();
const objectBytes = new Map<string, Buffer>();
let storageDown = false;

let state: ServerState = emptyServerState();
const log: { opId: string; entity: string; entityId: string; baseVersion: number; outcome: string }[] = [];
let dropNext = 0; let down = false; let hang = false;
const plog = (kind: string, extra: Record<string, unknown> = {}) => log.push({ opId: String(extra.id ?? kind), entity: kind, entityId: String(extra.id ?? ''), baseVersion: 0, outcome: kind, ...extra } as never);

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS,PATCH", "access-control-expose-headers": "*" };
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

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return void res.end(); }
  const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); const body = raw.toString("utf8");
    if (url.pathname === "/__state") return send(res, 200, { log, versions: state.versions });
    if (url.pathname === "/__control") { const c = JSON.parse(body || "{}"); if (c.dropNextResponses !== undefined) dropNext = c.dropNextResponses; if (c.down !== undefined) down = c.down; if (c.storageDown !== undefined) storageDown = c.storageDown; if (c.hang !== undefined) hang = c.hang; if (c.resetChecks) { checks.clear(); state = { ...state, versions: Object.fromEntries(Object.entries(state.versions).filter(([k]) => !k.startsWith("room_check:"))) }; } return send(res, 200, { dropNext, down, storageDown, hang }); }
    if (url.pathname === "/__photos") return send(res, 200, { photos: [...photos.values()], objects: Object.fromEntries(objects) });
    if (url.pathname === "/__rows") return send(res, 200, Object.fromEntries(rows));
    if (down) { res.destroy(); return; }
    if (hang) { return; } // accept the connection and never answer: the "Wi-Fi without internet" case
    if (url.pathname.startsWith("/auth/v1/user")) return send(res, 200, { id: USER, aud: "authenticated", email: "installer@phc.test" });
    if (url.pathname.startsWith("/auth/v1/token")) return send(res, 200, { access_token: TOKEN, token_type: "bearer", expires_in: 3600, refresh_token: "r2", user: { id: USER, email: "installer@phc.test" } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { code: "PGRST301", message: "JWT expired" });

    if (url.pathname === "/rest/v1/projects") return send(res, 200, [{ id: P, name: "Demo Project (mock)", customer: "Mock Customer", address: "1 Test St" }]);
    if (url.pathname === "/rest/v1/rooms") return send(res, 200, [
      { id: R, project_id: P, name: "Kitchen", floor: null, details_source: "cockpit", details: { panelName: "Slab", woodSpecies: "Pre Finished", finishName: "Uniboard K15 Cannes Riviera Oak", edgebanding: "To Match", crownProfile: "Flat Crown", toeKickStyle: "TBD", sheen: "Pre Finished" } },
      { id: R2, project_id: P, name: "Bath 1", floor: null, details_source: "masterfile", details: { panelName: "Slab", woodSpecies: "Pre Finished", finishName: "UNIBOARD - K16 Esterel Riviera Oak", edgebanding: "To Match" } },
    ]);
    if (url.pathname === "/rest/v1/room_checks") return send(res, 200, [...checks.entries()].map(([k, v]) => { const [room_id, item_key] = k.split(":"); return { room_id, item_key, project_id: P, state: v.state, note: v.note, checked_at: v.checked_at, row_version: v.row_version, by: { full_name: LABEL, email: "installer@phc.test" } }; }));
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
    if (url.pathname.startsWith("/storage/v1/object/audit-photos/") && req.method === "GET") {
      const objPath = decodeURIComponent(url.pathname.replace("/storage/v1/object/audit-photos/", ""));
      const bytes = objectBytes.get(objPath);
      if (!bytes) return send(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
      plog("photo_download", { id: objPath });
      res.writeHead(200, { ...cors, "content-type": "image/jpeg" }); return void res.end(bytes);
    }
    if (url.pathname.startsWith("/storage/v1/object/audit-photos/") && req.method === "POST") {
      if (storageDown) { res.destroy(); return; }
      const objPath = decodeURIComponent(url.pathname.replace("/storage/v1/object/audit-photos/", ""));
      if (objects.has(objPath)) return send(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const file = multipartFileBuf(raw, String(req.headers["content-type"] ?? ""));
      objects.set(objPath, file.length); objectBytes.set(objPath, file); plog("photo_upload", { id: objPath, size: file.length });
      return send(res, 200, { Key: `audit-photos/${objPath}`, Id: objPath });
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

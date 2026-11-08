// Local stand-in for the Supabase endpoints the app uses. It reuses the domain package's reference model of apply_op
// (applyOperation), and the REAL example template from supabase/seed.sql. Test-only: never deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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
const photos = new Map<string, { id: string; audit_id: string; item_key: string | null; storage_path: string; bytes: number; confirmed: boolean }>();
const objects = new Map<string, number>();
let storageDown = false;

let state: ServerState = emptyServerState();
const log: { opId: string; entity: string; entityId: string; baseVersion: number; outcome: string }[] = [];
let dropNext = 0; let down = false;
const plog = (kind: string, extra: Record<string, unknown> = {}) => log.push({ opId: String(extra.id ?? kind), entity: kind, entityId: String(extra.id ?? ''), baseVersion: 0, outcome: kind, ...extra } as never);

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS,PATCH", "access-control-expose-headers": "*" };
function multipartFile(buf: Buffer, contentType: string): number {
  const m = /boundary=(.+)$/.exec(contentType); if (!m) return buf.length;
  const parts = buf.toString("binary").split(`--${m[1]}`);
  for (const part of parts) { if (/name=""/.test(part)) { const start = part.indexOf("\r\n\r\n") + 4; return Buffer.from(part.slice(start, part.length - 2), "binary").length; } }
  return buf.length;
}
const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function itemRows(auditId: string) {
  return items.map((it) => {
    const key = `audit_item:${auditId}:1:${it.key}`;
    const version = state.versions[key] ?? 0;
    const payload = state.data[key] as { actual64?: number; expected64?: number; result?: string } | undefined;
    let result = "NOT_ENTERED";
    if (payload?.result) result = payload.result;
    else if (it.kind === "observation" && payload) result = "OBSERVED";
    if (payload && it.rule && payload.actual64 !== undefined && payload.expected64 !== undefined) {
      const ev = evaluate(payload.actual64, { expected: payload.expected64, plus: it.rule.plus64, minus: it.rule.minus64, ...(it.rule.reviewBand64 !== undefined ? { reviewBand: it.rule.reviewBand64 } : {}), source: it.rule.source as never, sourceRef: it.rule.sourceRef, method: it.rule.method });
      if (ev.ok) result = ev.value.result; // server computes the result, as the real apply_op does
    }
    return { item_key: it.key, result, row_version: version };
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return void res.end(); }
  const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); const body = raw.toString("utf8");
    if (url.pathname === "/__state") return send(res, 200, { log, versions: state.versions });
    if (url.pathname === "/__control") { const c = JSON.parse(body || "{}"); if (c.dropNextResponses !== undefined) dropNext = c.dropNextResponses; if (c.down !== undefined) down = c.down; if (c.storageDown !== undefined) storageDown = c.storageDown; return send(res, 200, { dropNext, down, storageDown }); }
    if (url.pathname === "/__photos") return send(res, 200, { photos: [...photos.values()], objects: Object.fromEntries(objects) });
    if (down) { res.destroy(); return; }
    if (url.pathname.startsWith("/auth/v1/user")) return send(res, 200, { id: USER, aud: "authenticated", email: "installer@phc.test" });
    if (url.pathname.startsWith("/auth/v1/token")) return send(res, 200, { access_token: TOKEN, token_type: "bearer", expires_in: 3600, refresh_token: "r2", user: { id: USER, email: "installer@phc.test" } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { code: "PGRST301", message: "JWT expired" });

    if (url.pathname === "/rest/v1/projects") return send(res, 200, [{ id: P, name: "Demo Project (mock)", customer: "Mock Customer", address: "1 Test St" }]);
    if (url.pathname === "/rest/v1/rooms") return send(res, 200, [{ id: R, project_id: P, name: "Kitchen", floor: null }]);
    if (url.pathname === "/rest/v1/audit_templates") return send(res, 200, [{ id: T, name: "EXAMPLE - Pre-Install Site Audit (sample)", version: 1, config }]);
    if (url.pathname === "/rest/v1/audit_items") {
      const auditId = (url.searchParams.get("audit_id") ?? "").replace("eq.", "");
      return send(res, 200, itemRows(auditId));
    }
    if (url.pathname === "/rest/v1/photos" && req.method === "POST") {
      const row = JSON.parse(body) as { id: string; audit_id: string; item_key: string | null; storage_path: string; bytes: number };
      if (photos.has(row.id)) return send(res, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
      photos.set(row.id, { id: row.id, audit_id: row.audit_id, item_key: row.item_key, storage_path: row.storage_path, bytes: Number(row.bytes), confirmed: false });
      plog("photo_register", { id: row.id, item_key: row.item_key });
      res.writeHead(201, cors); return void res.end();
    }
    if (url.pathname.startsWith("/storage/v1/object/audit-photos/") && req.method === "POST") {
      if (storageDown) { res.destroy(); return; }
      const objPath = decodeURIComponent(url.pathname.replace("/storage/v1/object/audit-photos/", ""));
      if (objects.has(objPath)) return send(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const size = multipartFile(raw, String(req.headers["content-type"] ?? ""));
      objects.set(objPath, size); plog("photo_upload", { id: objPath, size });
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
      const { p_audit_id } = JSON.parse(body) as { p_audit_id: string };
      const outcomes: AuditItemOutcome[] = itemRows(p_audit_id).map((r) => ({ itemId: r.item_key, critical: items.find((i) => i.key === r.item_key)!.critical, result: r.result as never }));
      const submitted = ((state.versions[`audit:${p_audit_id}:1`] ?? 0) >= 2);
      return send(res, 200, auditState({ auditId: p_audit_id, projectId: P, version: 1, submitted, items: outcomes, overrides: [] }, policy));
    }
    if (url.pathname === "/rest/v1/rpc/apply_op" && req.method === "POST") {
      const { op } = JSON.parse(body) as { op: { opId: string; entity: string; entityId: string; baseVersion: number } };
      if (op.entity === "audit_item") { // the real apply_op counts REGISTERED photos as evidence; so must the mock
        const [aId, , iKey] = op.entityId.split(":");
        const need = items.find((i) => i.key === iKey)?.requires?.photo ?? 0;
        const have = [...photos.values()].filter((p) => p.audit_id === aId && p.item_key === iKey).length;
        if (have < need) { plog("op_rejected", { id: op.opId, reason: "evidence_missing: photo" }); return send(res, 200, { status: "rejected", message: "evidence_missing: photo" }); }
      }
      const r = applyOperation(state, op as never);
      state = r.state;
      log.push({ opId: op.opId, entity: op.entity, entityId: op.entityId, baseVersion: op.baseVersion, outcome: r.outcome.status });
      if (dropNext > 0) { dropNext--; res.destroy(); return; } // applied on the server, but the response is lost
      return send(res, 200, r.outcome);
    }
    send(res, 404, { message: `mock: no route ${req.method} ${url.pathname}` });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock supabase on ${PORT}`));

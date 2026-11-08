// Local stand-in for the Supabase endpoints the app uses. It reuses the domain package's reference model of apply_op
// (applyOperation), and the REAL example template from supabase/seed.sql. Test-only: never deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { applyOperation, emptyServerState, evaluate, type ServerState } from "@phc/domain";

const PORT = Number(process.env.MOCK_PORT ?? 54500);
const TOKEN = "test-token";
const P = "00000000-0000-4000-8000-000000000101"; const R = "00000000-0000-4000-8000-000000000201"; const T = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000004";

const seed = fs.readFileSync(path.resolve(__dirname, "../../../supabase/seed.sql"), "utf8");
const config = JSON.parse(seed.split("$json$")[1]!) as { sections: { key: string; items: { key: string; kind: string; rule?: { plus64: number; minus64: number; reviewBand64?: number; source: string; sourceRef: string; method: string } }[] }[] };
const items = config.sections.flatMap((s) => s.items);

let state: ServerState = emptyServerState();
const log: { opId: string; entity: string; entityId: string; baseVersion: number; outcome: string }[] = [];
let dropNext = 0; let down = false;

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS,PATCH", "access-control-expose-headers": "*" };
const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function itemRows(auditId: string) {
  return items.map((it) => {
    const key = `audit_item:${auditId}:1:${it.key}`;
    const version = state.versions[key] ?? 0;
    const payload = state.data[key] as { actual64?: number; expected64?: number } | undefined;
    let result = "NOT_ENTERED";
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
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.pathname === "/__state") return send(res, 200, { log, versions: state.versions });
    if (url.pathname === "/__control") { const c = JSON.parse(body || "{}"); if (c.dropNextResponses !== undefined) dropNext = c.dropNextResponses; if (c.down !== undefined) down = c.down; return send(res, 200, { dropNext, down }); }
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
    if (url.pathname === "/rest/v1/rpc/apply_op" && req.method === "POST") {
      const { op } = JSON.parse(body) as { op: { opId: string; entity: string; entityId: string; baseVersion: number } };
      const r = applyOperation(state, op as never);
      state = r.state;
      log.push({ opId: op.opId, entity: op.entity, entityId: op.entityId, baseVersion: op.baseVersion, outcome: r.outcome.status });
      if (dropNext > 0) { dropNext--; res.destroy(); return; } // applied on the server, but the response is lost
      return send(res, 200, r.outcome);
    }
    send(res, 404, { message: `mock: no route ${req.method} ${url.pathname}` });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock supabase on ${PORT}`));

// The report function EXACTLY as Vercel will run it: the generated api/reports.mjs, in plain Node (no TypeScript tooling), talking to the mock
// Supabase over HTTP through the real database/storage adapters. Run: npm run e2e:api -w @phc/field
const { spawn } = require("node:child_process");
const path = require("node:path");
const cwd = path.resolve(__dirname, "..");
const MOCK = "http://127.0.0.1:54500";
const P = "00000000-0000-4000-8000-000000000101";
const results = []; const problems = [];
const check = (cond, name) => { results.push({ ok: !!cond, name }); console.log(`${cond ? "ok" : "NOT OK"} - ${name}`); if (!cond) problems.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(150); } }
const control = (c) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(c) });

(async () => {
  let up = false; try { up = (await fetch(MOCK + "/__state")).ok; } catch {} if (up) throw new Error("port already in use (stale server?)");
  const proc = spawn("npx", ["vite-node", "e2e/mock-server.ts"], { cwd, stdio: "pipe", detached: true });
  const killAll = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch {} };
  process.on("exit", killAll);
  try {
    await waitFor(async () => (await fetch(`${MOCK}/__state`)).ok, "mock server");
    await control({ resetIssues: true, resetChecks: true, role: "project_manager" });
    process.env.VITE_SUPABASE_URL = MOCK; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "test-key";
    process.env.REPORT_FROM = "Test Reports <reports@example.test>"; process.env.REPORT_TRANSPORT = "fake"; delete process.env.VERCEL_ENV;
    process.chdir(path.resolve(cwd, "../.."));                               // like Vercel: the function runs from the project root, assets shipped with it
    const { default: handler } = await import(path.resolve(cwd, "../../api/reports.mjs"));
    const call = async (body, token = "test-token", method = "POST") => {
      const out = {}; const res = { status(c) { out.status = c; return res; }, setHeader() { return res; }, json(b) { out.json = b; } };
      await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res); return out;
    };
    const rest = async (p) => (await fetch(`${MOCK}${p}`, { headers: { authorization: "Bearer test-token" } })).json();

    check((await call({ action: "build", projectId: P, type: "room_status" }, null)).status === 401, "no token is refused (401)");
    check((await call({ action: "build", projectId: P, type: "room_status" }, "wrong")).status === 401, "a wrong token is refused (401)");

    await control({ role: "installer" });
    const denied = await call({ action: "build", projectId: P, type: "room_status" });
    check(denied.status === 403, `an installer is refused (${denied.status} ${denied.json?.error})`);
    await control({ role: "project_manager" });

    const b = await call({ action: "build", projectId: P, type: "builder_site_audit" });
    check(b.status === 200 && b.json.bytes > 1000 && b.json.identified === 0, `builds a site audit through the real adapters (${b.status}, ${b.json.bytes} bytes)`);
    const s = await call({ action: "build", projectId: P, type: "room_status" });
    check(s.status === 200, "builds a room status PDF");
    const list = await rest("/rest/v1/reports");
    check(list.length === 2 && list.every((r) => r.status === "built" && r.storage_path === `${P}/${r.id}.pdf`), "both reports are recorded as built under <project>/<report>.pdf");

    const noContact = await call({ action: "send", reportId: b.json.reportId });
    check(noContact.status === 422 && noContact.json.error === "no_recipient", `send without a builder email on the job is refused (${noContact.status} ${JSON.stringify(noContact.json)})`);
    await fetch(`${MOCK}/rest/v1/projects?id=eq.${P}`, { method: "PATCH", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ prepared_for_name: "Sample Builder", prepared_for_email: "builder@example.test", address: "1 Test St" }) });

    const t = await call({ action: "sendTest", reportId: b.json.reportId });
    check(t.status === 200 && t.json.to === "installer@phc.test", `a test copy goes to the signed-in manager (${t.status} ${JSON.stringify(t.json)})`);
    check((await rest("/rest/v1/reports")).find((r) => r.id === b.json.reportId).status === "built", "a test leaves the report built");
    const sent = await call({ action: "send", reportId: b.json.reportId });
    check(sent.status === 200 && sent.json.to === "builder@example.test", "send goes to the builder contact saved on the job");
    const again = await call({ action: "send", reportId: b.json.reportId });
    check(again.status === 409 && again.json.error === "report_already_sent", "a second send is refused (once only)");
    const final = (await rest("/rest/v1/reports")).find((r) => r.id === b.json.reportId);
    check(final.status === "sent" && final.recipient_email === "builder@example.test" && /^fake-/.test(final.message_id), "the report is recorded as sent with the message id");

    const prod = await (async () => { process.env.VERCEL_ENV = "production"; const r = await call({ action: "sendTest", reportId: s.json.reportId }); delete process.env.VERCEL_ENV; return r; })();
    check(prod.status === 500 && !JSON.stringify(prod.json).includes("test-token"), "the fake transport is refused in production, and the error does not leak the token");
    const bad = await call({ action: "send", reportId: "not-a-uuid" });
    check(bad.status === 400, "a malformed report id is refused (400)");
  } finally { killAll(); }
  if (problems.length) { console.log(`\nAPI BUNDLE CHECKS FAILED: ${problems.length}`); process.exit(1); }
  console.log(`\nAPI BUNDLE CHECKS PASSED: ${results.length} checks`);
})().catch((e) => { console.error(e); process.exit(1); });

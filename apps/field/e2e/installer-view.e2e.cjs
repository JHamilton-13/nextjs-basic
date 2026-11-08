// The REAL default build (no test flag): installers see rooms, details and the checklist, and no pre-install audit screens.
// Run: npm run e2e:installer -w @phc/field
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const { chromium, devices } = require("playwright");

const APP = "http://127.0.0.1:4173", MOCK = "http://127.0.0.1:54500";
const USER = "00000000-0000-4000-8000-000000000004";
const cwd = path.resolve(__dirname, "..");
const OUT = path.join(os.tmpdir(), "phc-installer-build");
const results = []; const problems = [];
const check = (cond, name) => { results.push({ ok: !!cond, name }); console.log(`${cond ? "ok" : "NOT OK"} - ${name}`); if (!cond) problems.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(150); } }

(async () => {
  for (const u of [MOCK + "/__state", APP]) { let up = false; try { up = (await fetch(u)).ok; } catch {} if (up) throw new Error(`port already in use (stale server?): ${u}`); }
  console.log("== build WITHOUT the audit flag");
  const env = { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_PUBLISHABLE_KEY: "test-key" }; delete env.VITE_SHOW_AUDIT;
  execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { cwd, stdio: "pipe", env });
  const procs = [
    spawn("npx", ["vite-node", "e2e/mock-server.ts"], { cwd, stdio: "pipe", detached: true }),
    spawn("npx", ["vite", "preview", "--outDir", OUT, "--port", "4173", "--strictPort", "--host", "127.0.0.1"], { cwd, stdio: "pipe", detached: true }),
  ];
  const killAll = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
  process.on("exit", killAll);
  let browser;
  try {
    await waitFor(async () => (await fetch(`${MOCK}/__state`)).ok, "mock server");
    await waitFor(async () => (await fetch(APP)).ok, "preview server");
    browser = await chromium.launch();
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "allow" });
    const session = { access_token: "test-token", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: USER, aud: "authenticated", email: "installer@phc.test", app_metadata: {}, user_metadata: { full_name: "Pat Installer" }, created_at: "2026-11-08T00:00:00Z" } };
    await context.addInitScript((s) => { if (!localStorage.getItem("phc-auth")) localStorage.setItem("phc-auth", JSON.stringify(s)); }, session);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(APP);
    await page.getByTestId("project-card").waitFor();

    check((await page.getByRole("button", { name: "Start site audit" }).count()) === 0, "installer build: no 'Start site audit' button");
    check((await page.getByTestId("audit-row").count()) === 0, "installer build: no audit rows on the project list");
    check((await page.getByTestId("open-project").isVisible()), "installer build: the project opens to its rooms");
    await page.getByTestId("open-project").tap();
    await page.getByTestId("room-card").first().waitFor();
    check((await page.getByTestId("room-card").count()) === 2, "installer build: both rooms are listed with their cards");
    check(!/audit|measurement|tolerance|critical|MEP/i.test(await page.locator("main").innerText()), "installer build: no audit, measurement or tolerance wording on the room screen");
    const kitchen = page.locator('[data-room="Kitchen"]');
    await kitchen.getByTestId("pill-clean").tap();
    await waitFor(async () => (await kitchen.getByTestId("pill-clean").getAttribute("data-state")) === "done", "tick");
    await waitFor(async () => (await kitchen.getByTestId("pill-clean").getAttribute("data-pending")) === "no", "tick synced");
    check(true, "installer build: a checklist tick works and syncs");
    await page.getByRole("button", { name: "Sync queue" }).tap();
    check((await page.getByTestId("queue-row").first().innerText()).includes("Room checklist"), "installer build: the Sync queue describes the tick as 'Room checklist'");
  } finally { await browser?.close().catch(() => {}); killAll(); }
  const bad = results.filter((r) => !r.ok);
  if (problems.length) { console.log(`\nINSTALLER VIEW CHECKS FAILED: ${problems.length}`); process.exit(1); }
  console.log(`\nINSTALLER VIEW CHECKS PASSED: ${results.length} checks`);
})().catch((e) => { console.error(e); process.exit(1); });

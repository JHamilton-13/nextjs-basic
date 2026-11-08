// Real Chromium, real service worker, real IndexedDB, network switched OFF. Run: npm run e2e -w @phc/field
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");

const APP = "http://127.0.0.1:4173", MOCK = "http://127.0.0.1:54500";
const USER = "00000000-0000-4000-8000-000000000004";
const cwd = path.resolve(__dirname, "..");
const results = [];
const check = (cond, name) => { results.push({ ok: !!cond, name }); console.log(`${cond ? "ok" : "NOT OK"} - ${name}`); if (!cond) throw new Error(`FAILED: ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(150); } }
const mockState = async () => (await fetch(`${MOCK}/__state`)).json();
const control = (c) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(c) });

(async () => {
  for (const u of [MOCK + "/__state", APP]) { let up = false; try { up = (await fetch(u)).ok; } catch {} if (up) throw new Error(`port already in use (stale server?): ${u}`); }
  console.log("== build (pointing the app at the mock server)");
  execSync("npx vite build", { cwd, stdio: "pipe", env: { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_PUBLISHABLE_KEY: "test-key" } });
  const procs = [
    spawn("npx", ["vite-node", "e2e/mock-server.ts"], { cwd, stdio: "pipe", detached: true }),
    spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort", "--host", "127.0.0.1"], { cwd, stdio: "pipe", detached: true }),
  ];
  // npx spawns grandchildren; kill the whole process group so nothing outlives the test (a stale mock would corrupt the next run).
  const killAll = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
  process.on("exit", killAll);
  let browser;
  try {
    await waitFor(async () => (await fetch(`${MOCK}/__state`)).ok, "mock server");
    await waitFor(async () => (await fetch(APP)).ok, "preview server");

    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const session = { access_token: "test-token", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: USER, aud: "authenticated", email: "installer@phc.test", app_metadata: {}, user_metadata: {}, created_at: "2026-11-08T00:00:00Z" } };
    await context.addInitScript((s) => { if (!localStorage.getItem("phc-auth")) localStorage.setItem("phc-auth", JSON.stringify(s)); }, session);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

    console.log("== online first load: download projects/templates, install the service worker");
    await page.goto(APP);
    await page.getByTestId("project-card").waitFor();
    check(await page.getByText("Demo Project (mock)").isVisible(), "online: assigned project is listed");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await waitFor(async () => (await page.evaluate(async () => (await caches.keys()).length)) > 0, "service worker precache");
    check(true, "service worker installed and app shell cached");
    const manifest = await (await fetch(`${APP}/manifest.webmanifest`)).json();
    check(manifest.display === "standalone" && manifest.icons.length >= 2, "installable: web manifest is standalone with icons");
    await waitFor(async () => (await page.getByTestId("sync-status").innerText()) === "All synced", "initial sync");

    console.log("== NETWORK OFF: reload and work offline");
    await context.setOffline(true);
    await page.reload();
    await page.getByTestId("project-card").waitFor();
    check(await page.getByTestId("sync-status").innerText() === "Offline", "offline reload: app shell loads from the service worker and shows Offline");
    check(await page.getByText("Demo Project (mock)").isVisible(), "offline reload: project still listed from the device");

    await page.getByRole("button", { name: "Start site audit" }).click();
    await page.getByTestId("start-audit").click();
    await page.getByTestId("audit-sync").waitFor();
    check((await page.getByTestId("audit-sync").innerText()).includes("not synced yet"), "offline: audit started and saved on the device (not yet on the server)");
    check((await page.getByTestId("pending-count").innerText()).startsWith("1 "), "offline: 1 change waiting");

    const wall = page.getByTestId("item-wall_length");
    await wall.getByTestId("expected").fill('120"');
    await wall.getByTestId("actual").fill('121"');
    await wall.getByTestId("drawing-ref").fill("");
    check((await wall.getByTestId("preview").innerText()) === "REVIEW", "live preview: +1\" from drawing is REVIEW");
    await wall.getByTestId("save-measurement").click();
    check((await wall.getByTestId("save-error").innerText()).toLowerCase().includes("drawing reference"), "evidence rule: cannot save without a drawing reference");
    check((await page.getByTestId("pending-count").innerText()).startsWith("1 "), "evidence rule: nothing was queued by the refused save");
    await wall.getByTestId("drawing-ref").fill("A-201 rev C");
    await wall.getByTestId("save-measurement").click();
    await wall.getByTestId("pending-wall_length").waitFor();
    check((await wall.getByTestId("result-wall_length").innerText()) === "REVIEW", "offline: measurement saved, provisional REVIEW shown");
    check((await wall.getByTestId("pending-wall_length").innerText()) === "Waiting to sync", "offline: measurement says 'Waiting to sync', not 'Synced'");
    check((await page.getByTestId("pending-count").innerText()).startsWith("2 "), "offline: 2 changes waiting");
    check((await mockState()).log.length === 0, "offline: the server received nothing");

    await page.reload();
    await page.getByTestId("audit-row").click();
    await page.getByTestId("item-wall_length").waitFor();
    check((await page.getByTestId("pending-count").innerText()).startsWith("2 "), "durable: after an offline reload both changes are still queued");
    check((await page.getByTestId("result-wall_length").innerText()) === "REVIEW", "durable: the measurement survived the reload");

    console.log("== NETWORK ON, but the first response is lost (power loss / dropped connection)");
    // Every response is lost until we say otherwise (Chromium also resends dropped POSTs itself; those come back as duplicates).
    await control({ dropNextResponses: 1000 });
    await context.setOffline(false);
    await waitFor(async () => (await mockState()).log.length >= 1, "first op reaches the server");
    await page.getByRole("button", { name: "Sync queue" }).click();
    await waitFor(async () => (await page.getByTestId("queue-status").allInnerTexts()).includes("will retry"), "failed op marked 'will retry'").catch(async (e) => {
      console.log("  [debug] queue statuses:", await page.getByTestId("queue-status").allInnerTexts(), "server log:", JSON.stringify((await mockState()).log), "status bar:", await page.getByTestId("sync-status").innerText());
      throw e;
    });
    check(true, "lost response: the op is kept as 'will retry' (not marked synced)");
    const afterLoss = await mockState();
    check(afterLoss.log[0].outcome === "applied" && afterLoss.log.slice(1).every((l) => l.outcome === "duplicate" && l.opId === afterLoss.log[0].opId), "lost response: the server applied the create op once; any browser resend was a harmless duplicate");

    await control({ dropNextResponses: 0 }); // the network works again
    await page.getByTestId("sync-now").click();
    await waitFor(async () => { const s = await page.getByTestId("queue-status").allInnerTexts(); return s.length === 2 && s.every((x) => x === "synced"); }, "all ops synced");
    const done = await mockState();
    const creates = done.log.filter((l) => l.entity === "audit"); const measures = done.log.filter((l) => l.entity === "audit_item");
    check(creates.length >= 2 && creates.filter((c) => c.outcome === "applied").length === 1 && new Set(creates.map((c) => c.opId)).size === 1, "retry after lost response: the same opId came back as a duplicate and NO second audit was created");
    check(measures.length === 1 && measures[0].outcome === "applied", "the measurement was applied exactly once, after the create (order kept)");
    check((await page.getByTestId("pending-count").count()) === 0, "queue is empty after the server confirmed everything");

    await page.getByRole("button", { name: "Projects" }).click();
    await page.getByTestId("audit-row").click();
    await page.getByTestId("synced-wall_length").waitFor();
    check((await page.getByTestId("result-wall_length").innerText()) === "REVIEW", "after sync the server's result (REVIEW) is shown and marked Synced");
    check((await page.getByTestId("audit-sync").innerText()) === "Audit is on the server", "after sync the audit is marked as on the server");
    console.log(`\nE2E PASSED: ${results.length} checks`);
  } finally {
    if (browser) await browser.close();
    killAll();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

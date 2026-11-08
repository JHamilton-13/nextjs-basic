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
    await context.addInitScript((s) => { if (!localStorage.getItem("phc-auth") && !localStorage.getItem("test-no-autologin")) localStorage.setItem("phc-auth", JSON.stringify(s)); }, session);
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
    // ---- rooms fold away ----
    const kRoom = page.locator('[data-room="Kitchen"]'), bRoom = page.locator('[data-room="Bath 1"]');
    const tbox = await kRoom.getByTestId("room-toggle").boundingBox();
    check(tbox.height >= 44, `rooms: the room header is at least 44 px tall (${Math.round(tbox.height)})`);
    check((await kRoom.getByTestId("room-toggle").getAttribute("aria-expanded")) === "true" && (await kRoom.getByTestId("pill-clean").isVisible()), "rooms: open by default, checklist visible");
    await kRoom.getByTestId("room-toggle").tap();
    check((await kRoom.getByTestId("pill-clean").isHidden()) && (await kRoom.getByTestId("room-progress").isVisible()) && (await kRoom.getByTestId("room-toggle").getAttribute("aria-expanded")) === "false", "rooms: tapping the name folds the room away but keeps its name and progress");
    check((await kRoom.getByTestId("room-open-issues").innerText()).includes("1 open issue"), "rooms: a folded room still shows how many issues are open");
    check(await bRoom.getByTestId("pill-clean").isVisible(), "rooms: folding one room leaves the others open");
    await page.reload(); await page.getByTestId("project-card").waitFor(); await page.getByTestId("open-project").tap(); await kRoom.waitFor();
    check((await kRoom.getByTestId("room-card").count()) === 0 && (await page.locator('[data-room="Kitchen"]').getAttribute("data-collapsed")) === "yes", "rooms: a folded room stays folded after reload (remembered on this phone)");
    await page.getByTestId("expand-all").tap();
    check((await kRoom.getByTestId("pill-clean").isVisible()) && (await bRoom.getByTestId("pill-clean").isVisible()), "rooms: Expand all opens every room");
    await page.getByTestId("collapse-all").tap();
    check((await kRoom.getByTestId("pill-clean").isHidden()) && (await bRoom.getByTestId("pill-clean").isHidden()), "rooms: Collapse all folds every room");
    await page.getByTestId("expand-all").tap();
    const kitchen = page.locator('[data-room="Kitchen"]');
    await kitchen.getByTestId("pill-clean").tap();
    await waitFor(async () => (await kitchen.getByTestId("pill-clean").getAttribute("data-state")) === "done", "tick");
    await waitFor(async () => (await kitchen.getByTestId("pill-clean").getAttribute("data-pending")) === "no", "tick synced");
    check(true, "installer build: a checklist tick works and syncs");
    check((await kitchen.getByTestId("add-issue").isVisible()) && (await kitchen.getByTestId("view-open").isVisible()) && (await kitchen.getByTestId("view-completed").isVisible()), "installer build: each room has Add issue and an Open / Completed switch");
    await kitchen.getByTestId("add-issue").tap();
    const sheet = page.getByTestId("add-issue-sheet");
    await sheet.getByTestId("cat-touch_ups").tap();
    await sheet.getByTestId("issue-title-input").fill("Scuff on the left end panel");
    await sheet.getByTestId("issue-save").tap();
    await sheet.waitFor({ state: "detached" });
    await kitchen.getByTestId("issue-card").filter({ hasText: "Scuff on the left end panel" }).waitFor();
    await waitFor(async () => (await kitchen.getByTestId("issue-card").filter({ hasText: "Scuff on the left end panel" }).getByTestId("issue-pending").count()) === 0, "issue synced");
    check(!/audit|measurement|tolerance|critical|MEP/i.test(await page.locator("main").innerText()), "installer build: still no audit, measurement or tolerance wording with the issue screens in place");
    check(true, "installer build: an issue can be raised and syncs");
    await page.getByRole("button", { name: "Sync queue" }).tap();
    const queueText = await page.getByTestId("queue-row").allInnerTexts();
    check(queueText.some((t) => t.includes("Room checklist")) && queueText.some((t) => t.includes("Issue") && t.includes("raised")), "installer build: the Sync queue describes the tick as 'Room checklist' and the issue as 'Issue ... raised'");

    // ---- signing out and back in: the phone must never get stuck ----
    console.log("== sign out / sign in");
    const idb = (store, key) => page.evaluate(([st, k]) => new Promise((res) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction(st).objectStore(st).get(k); q.onsuccess = () => res(q.result ?? null); }; }), [store, key]);
    const outboxLen = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction("outbox").objectStore("outbox").getAll(); q.onsuccess = () => res(q.result.filter((x) => x.state.status !== "confirmed").length); }; }));
    const signInButton = page.getByRole("button", { name: "Continue with Google" });
    const goToKitchen = async () => { await page.getByTestId("project-card").waitFor(); await page.getByTestId("open-project").tap(); await page.locator('[data-room="Kitchen"]').waitFor(); };

    await page.getByRole("button", { name: "Projects", exact: true }).tap();
    await goToKitchen();
    await context.setOffline(true);
    await kitchen.getByTestId("pill-shelves").tap();
    await waitFor(async () => (await outboxLen()) > 0, "an unsent change");
    await page.getByTestId("signout").tap();
    check((await page.getByTestId("signout-dialog").innerText()).includes("still waiting to send"), "sign out with unsent work asks first and says the work stays on the phone");
    await page.getByTestId("signout-cancel").tap();
    check((await page.getByTestId("signout-dialog").count()) === 0 && (await idb("meta", "identity")) !== null, "'Stay signed in' keeps you signed in");
    await page.getByTestId("signout").tap();
    await page.getByTestId("signout-confirm").tap();
    await signInButton.waitFor();
    check(true, "after signing out the sign-in screen appears (even with no connection)");
    check((await idb("meta", "identity")) === null && (await outboxLen()) > 0, "the saved identity is forgotten but the unsent change is still on the phone");

    await context.setOffline(false);
    await page.evaluate(() => localStorage.setItem("test-no-autologin", "1"));   // the test harness otherwise signs every reload back in
    await page.reload();
    await signInButton.waitFor();
    check(true, "still signed out after a reload (not silently signed back in)");
    await page.evaluate((s) => localStorage.setItem("phc-auth", JSON.stringify(s)), session);   // stands in for completing Google sign-in
    await page.reload();
    await goToKitchen();
    await waitFor(async () => (await page.locator('[data-room="Kitchen"]').getByTestId("pill-shelves").getAttribute("data-pending")) === "no", "the change sent after signing back in", 25000);
    check((await (await fetch(`${MOCK}/__state`)).json()).log.some((l) => l.entity === "room_check" && l.outcome === "applied" && String(l.entityId).endsWith(":shelves")), "after signing back in, the change made before signing out reached the server");

    // the stuck state from the owner's phone: the session is gone but the saved identity is still there
    await page.evaluate(() => { localStorage.setItem("test-no-autologin", "1"); localStorage.removeItem("phc-auth"); });
    await page.reload();
    await page.getByTestId("project-card").waitFor();
    check(await page.getByTestId("resign").isVisible(), "session gone: the header offers a real 'Sign in again to sync' button");
    const [authReq] = await Promise.all([page.waitForRequest((r) => r.url().includes("/auth/v1/authorize")), page.getByTestId("resign").tap()]);
    check(authReq.url().includes("provider=google") && authReq.url().includes(encodeURIComponent(APP)), "tapping it starts Google sign-in and returns to this app");
    await page.waitForURL(/\/auth\/v1\/authorize/);                       // let the redirect finish before navigating back (otherwise the two navigations race)
    await page.goto(APP);
    await page.getByTestId("project-card").waitFor();
    await page.getByTestId("signout").tap();
    await signInButton.waitFor();
    check(true, "session gone: Sign out takes you to the sign-in screen (it used to do nothing)");

    // signing out on an online phone ends only this phone's session
    await page.evaluate((s) => { localStorage.removeItem("test-no-autologin"); localStorage.setItem("phc-auth", JSON.stringify(s)); }, session);
    await page.reload();
    await page.getByTestId("project-card").waitFor();
    await page.getByTestId("signout").tap();
    await signInButton.waitFor();
    check((await (await fetch(`${MOCK}/__state`)).json()).log.some((l) => l.entity === "auth_logout" && l.scope === "local"), "signing out asks the server to end only this phone's session (not every device)");
  } finally { await browser?.close().catch(() => {}); killAll(); }
  const bad = results.filter((r) => !r.ok);
  if (problems.length) { console.log(`\nINSTALLER VIEW CHECKS FAILED: ${problems.length}`); process.exit(1); }
  console.log(`\nINSTALLER VIEW CHECKS PASSED: ${results.length} checks`);
})().catch((e) => { console.error(e); process.exit(1); });

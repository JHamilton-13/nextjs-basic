// Phone-class checks in real Chromium with device emulation (touch, small viewports, mobile UA). It CANNOT replace a real phone:
// iOS Safari is WebKit and is not available here. It catches layout, tap-target, touch-drawing and big-photo problems early.
// Run: npm run e2e:phone -w @phc/field
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { chromium, devices } = require("playwright");

const APP = "http://127.0.0.1:4173", MOCK = "http://127.0.0.1:54500";
const USER = "00000000-0000-4000-8000-000000000004";
const cwd = path.resolve(__dirname, "..");
const SHOTS = process.env.PHONE_SHOTS || path.join(require("node:os").tmpdir(), "phc-phone-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const BIG = path.resolve(__dirname, "camera-12mp-exif6.jpg");
const results = []; const problems = [];
const check = (cond, name) => { results.push({ ok: !!cond, name }); console.log(`${cond ? "ok" : "NOT OK"} - ${name}`); if (!cond) problems.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 20000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(150); } }

/** Everything a thumb has to hit, measured as rendered. Flags targets under 44x44 CSS px, inputs under 16px text (iOS zooms on focus), and sideways scroll. */
async function audit(page, label) {
  const m = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest("[hidden]") && !(e.closest("details") && !e.closest("details").open && e.tagName !== "SUMMARY" && !e.closest("summary")); };
    const small = []; const smallText = [];
    for (const e of document.querySelectorAll("button, a[href], summary, label.filebtn, select, input:not([type=hidden]):not([type=file])")) {
      if (!vis(e)) continue; const r = e.getBoundingClientRect();
      if (r.height < 44 - 0.5 || r.width < 44 - 0.5) small.push(`${e.tagName.toLowerCase()}[${(e.getAttribute("data-testid") || e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      if ((e.tagName === "INPUT" || e.tagName === "SELECT") && parseFloat(getComputedStyle(e).fontSize) < 16) smallText.push(e.tagName + ":" + (e.getAttribute("data-testid") || ""));
    }
    const de = document.documentElement;
    return { overflowX: de.scrollWidth - window.innerWidth, small, smallText, vw: window.innerWidth };
  });
  check(m.overflowX <= 1, `${label}: no sideways scrolling (overflow ${m.overflowX}px at ${m.vw}px wide)`);
  check(m.small.length === 0, `${label}: every tap target is at least 44x44${m.small.length ? " — too small: " + m.small.join("; ") : ""}`);
  check(m.smallText.length === 0, `${label}: text fields are at least 16px (no iOS zoom on focus)${m.smallText.length ? " — " + m.smallText.join(",") : ""}`);
}

async function touchStroke(cdp, pts) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
  for (const p of pts.slice(1)) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p[0], y: p[1] }] }); await sleep(12); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function runDevice(browser, name) {
  console.log(`\n== ${name}`);
  const dev = devices[name];
  const context = await browser.newContext({ ...dev, serviceWorkers: "allow" });
  const session = { access_token: "test-token", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: USER, aud: "authenticated", email: "installer@phc.test", app_metadata: {}, user_metadata: { full_name: "Pat Installer" }, created_at: "2026-11-08T00:00:00Z" } };
  await context.addInitScript((s) => {
    if (!localStorage.getItem("phc-auth")) localStorage.setItem("phc-auth", JSON.stringify(s));
    window.__persistCalls = 0; const st = navigator.storage; if (st && st.persist) { const orig = st.persist.bind(st); st.persist = () => { window.__persistCalls++; return orig(); }; }
  }, session);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  if (process.env.PHONE_DEBUG) { const t0 = Date.now(); page.on("request", (r) => console.log(`  [req +${Date.now() - t0}ms] ${r.method()} ${r.url().replace(APP, "").replace(MOCK, "MOCK").slice(0, 90)}`)); page.on("requestfailed", (r) => console.log(`  [FAILED +${Date.now() - t0}ms] ${r.url().replace(MOCK, "MOCK").slice(0, 70)} ${r.failure()?.errorText}`)); page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("  [console]", m.text().slice(0, 140)); }); }
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${name.replace(/\s+/g, "-")}-${n}.png`), scale: "css", fullPage: false });
  const tag = name;

  await page.goto(APP);
  await page.getByTestId("project-card").waitFor();
  check(await page.evaluate(() => !!document.querySelector('meta[name="viewport"][content*="viewport-fit=cover"]')), `${tag}: viewport meta allows full-screen (notch) layout`);
  const asked = await waitFor(async () => (await page.evaluate(() => window.__persistCalls)) > 0, "persistent storage request", 4000).then(() => true).catch(() => false);
  check(asked, `${tag}: the app asked the browser to protect its offline data from automatic clearing`);
  await audit(page, `${tag} project list`); await shot("1-projects");

  await page.getByRole("button", { name: "Start site audit" }).click();
  await audit(page, `${tag} start audit`); await shot("2-start");
  await page.getByTestId("start-audit").click();
  await page.getByTestId("audit-sync").waitFor();
  await audit(page, `${tag} audit top`); await shot("3-audit");

  await page.getByTestId("section-walls").locator("summary").click();
  await page.getByTestId("item-wall_length").scrollIntoViewIfNeeded();
  await audit(page, `${tag} measurement card`); await shot("4-measure");
  await page.getByTestId("section-mep").locator("summary").click();
  await page.getByTestId("item-outlets").scrollIntoViewIfNeeded();
  await audit(page, `${tag} MEP item`); await shot("5-mep");

  // ---- big camera photo with EXIF rotation ----
  const outlets = page.getByTestId("item-outlets");
  const t0 = Date.now();
  await outlets.getByTestId("photo-input-outlets").setInputFiles(BIG);
  await outlets.getByTestId("photo-thumb").waitFor({ timeout: 30000 });
  const secs = (Date.now() - t0) / 1000;
  check(secs < 10, `${tag}: a 12-megapixel photo is processed in under 10 s (took ${secs.toFixed(1)} s)`);
  const info = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction("photos").objectStore("photos").getAll(); q.onsuccess = async () => { const p = q.result[0]; const bmp = await createImageBitmap(p.blob); resolve({ w: bmp.width, h: bmp.height, bytes: p.bytes, orig: p.originalBlob ? p.originalBlob.size : 0, type: p.mime }); }; }; }));
  check(Math.max(info.w, info.h) <= 2048 && info.bytes <= 10 * 1024 * 1024 && info.type === "image/jpeg", `${tag}: the stored photo is a JPEG, long edge ${Math.max(info.w, info.h)} px (max 2048), ${(info.bytes / 1024).toFixed(0)} KiB (original ${(info.orig / 1048576).toFixed(1)} MiB kept until uploaded)`);
  check(info.h > info.w, `${tag}: the photo's rotation flag was honoured (stored upright ${info.w}x${info.h}, not sideways)`);

  // ---- touch drawing ----
  await outlets.getByTestId("annotate-btn").first().click();
  const canvas = page.getByTestId("annotate-canvas");
  await waitFor(async () => (await canvas.evaluate((c) => c.width)) > 0 && (await canvas.boundingBox()), "annotation canvas");
  await audit(page, `${tag} annotation editor`); await shot("6-annotate");
  const cdp = await context.newCDPSession(page);
  const box = await canvas.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await touchStroke(cdp, [at(0.2, 0.2), at(0.3, 0.25), at(0.45, 0.4), at(0.6, 0.5), at(0.7, 0.8)]);
  check(await page.getByTestId("save-annotation").isEnabled(), `${tag}: a finger stroke on the photo draws a mark`);
  check((await page.evaluate(() => window.scrollY)) === scrollBefore, `${tag}: drawing with a finger does not scroll the page`);
  await page.getByTestId("tool-highlight").click(); await page.getByTestId("color-1").click();
  await touchStroke(cdp, [at(0.1, 0.6), at(0.4, 0.6), at(0.8, 0.6)]);
  await page.getByTestId("tool-text").click();
  await page.touchscreen.tap(...at(0.3, 0.1));
  await page.getByTestId("text-input").fill("outlet 6in left of spec");
  await page.getByTestId("text-add").click();
  await shot("7-annotated");
  await page.getByTestId("save-annotation").click();
  await waitFor(async () => (await outlets.getByTestId("photo-thumb").count()) === 2, "marked-up copy");
  check(true, `${tag}: pen + highlighter + text saved as a marked-up copy from touch input`);
  const marks = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction("photos").objectStore("photos").getAll(); q.onsuccess = () => resolve(q.result.filter((p) => p.annotatedFrom).map((p) => p.annotations.map((a) => a.type + ":" + (a.points ? a.points.length : 0)))); }; }));
  check(marks.length === 1 && marks[0].length === 3 && marks[0][0].startsWith("pen:") && Number(marks[0][0].split(":")[1]) >= 4, `${tag}: the finger path was kept as an editable stroke (${marks[0].join(", ")})`);

  // ---- offline on a phone ----
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId("project-card").waitFor();
  await waitFor(async () => (await page.getByTestId("sync-status").innerText()) !== "Syncing…", "offline attempt to finish", 10000).catch(() => {});
  const badge = await page.getByTestId("sync-status").innerText();
  check(badge === "Offline", `${tag}: reloads offline and shows Offline (badge says "${badge}")`);
  await page.getByRole("button", { name: "Sync queue" }).click();
  await audit(page, `${tag} sync queue`); await shot("8-queue");
  const storageText = await page.getByTestId("storage-info").innerText({ timeout: 3000 }).catch(() => "");
  check(/Protected|Not protected/.test(storageText) && /MB|KB|GB/.test(storageText), `${tag}: the app shows how much device storage it uses and whether it is protected (${storageText.replace(/\s+/g, " ").slice(0, 80)})`);
  // ---- "lie-fi": connected to Wi-Fi but the server never answers ----
  await page.getByRole("button", { name: "Projects" }).click();
  await page.getByTestId("audit-row").click();
  await page.getByTestId("section-general").locator("summary").click().catch(() => {});
  if (!(await page.getByTestId("section-general").evaluate((e) => e.open))) await page.getByTestId("section-general").locator("summary").click();
  await page.getByTestId("item-access").getByTestId("mark-pass").click();           // a new change is waiting to be sent (still offline)
  await page.getByTestId("pending-access").waitFor();
  await context.setOffline(false);
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ hang: true }) });
  await page.getByRole("button", { name: "Sync queue" }).click();
  await page.getByTestId("sync-now").click();
  const started = Date.now();
  const failedOver = await waitFor(async () => (await page.getByTestId("queue-status").allInnerTexts()).includes("will retry"), "request deadline", 15000).then(() => true).catch(() => false);
  const took = (Date.now() - started) / 1000;
  check(failedOver && took < 12, `${tag}: a server that never answers is given up on after a few seconds and the change shows "will retry" (took ${took.toFixed(1)} s; limit in the test build 3 s)`);
  await waitFor(async () => (await page.getByTestId("sync-now").innerText()).includes("Sync now"), "sync button", 8000).catch(() => {});
  check((await page.getByTestId("sync-now").innerText()).includes("Sync now"), `${tag}: the Sync button is usable again after the attempt times out`);
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ hang: false }) });
  await page.getByTestId("sync-now").click();
  const recovered = await waitFor(async () => { const t = await page.getByTestId("queue-status").allInnerTexts(); return t.length > 0 && t.every((x) => x === "synced"); }, "queue to sync", 30000).then(() => true).catch(() => false);
  check(recovered, `${tag}: once the server answers again, everything syncs`);
  await context.close();
}

(async () => {
  for (const u of [MOCK + "/__state", APP]) { let up = false; try { up = (await fetch(u)).ok; } catch {} if (up) throw new Error(`port already in use (stale server?): ${u}`); }
  console.log("== build (pointing the app at the mock server)");
  execSync("npx vite build", { cwd, stdio: "pipe", env: { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_PUBLISHABLE_KEY: "test-key", VITE_API_TIMEOUT_MS: "3000", VITE_UPLOAD_TIMEOUT_MS: "6000" } });
  const procs = [
    spawn("npx", ["vite-node", "e2e/mock-server.ts"], { cwd, stdio: "pipe", detached: true }),
    spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort", "--host", "127.0.0.1"], { cwd, stdio: "pipe", detached: true }),
  ];
  const killAll = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
  process.on("exit", killAll);
  let browser;
  try {
    await waitFor(async () => (await fetch(`${MOCK}/__state`)).ok, "mock server"); await waitFor(async () => (await fetch(APP)).ok, "preview server");
    browser = await chromium.launch();
    for (const n of (process.env.PHONE_DEVICES ? process.env.PHONE_DEVICES.split(",") : ["iPhone SE", "iPhone 13", "Pixel 7"])) {
      await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ storageDown: false, down: false, dropNextResponses: 0 }) });
      await runDevice(browser, n);
    }
    console.log(`\nscreenshots: ${SHOTS}`);
    console.log(problems.length ? `\nPHONE CHECKS: ${results.length - problems.length}/${results.length} ok; ${problems.length} problem(s)` : `\nPHONE CHECKS PASSED: ${results.length} checks`);
    if (problems.length) process.exitCode = 1;
  } finally { if (browser) await browser.close(); killAll(); }
})().catch((e) => { console.error(e.message); process.exit(1); });

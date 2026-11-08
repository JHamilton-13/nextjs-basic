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
const ICON = path.resolve(__dirname, "../public/icon-512.png");
const mockState = async () => (await fetch(`${MOCK}/__state`)).json();
const control = (c) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(c) });

(async () => {
  for (const u of [MOCK + "/__state", APP]) { let up = false; try { up = (await fetch(u)).ok; } catch {} if (up) throw new Error(`port already in use (stale server?): ${u}`); }
  console.log("== build (pointing the app at the mock server)");
  execSync("npx vite build", { cwd, stdio: "pipe", env: { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_PUBLISHABLE_KEY: "test-key", VITE_SHOW_AUDIT: "1" } });
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
    const session = { access_token: "test-token", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: USER, aud: "authenticated", email: "installer@phc.test", app_metadata: {}, user_metadata: { full_name: "Pat Installer" }, created_at: "2026-11-08T00:00:00Z" } };
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

    const openSection = async (key) => { const d = page.getByTestId(`section-${key}`); if (!(await d.evaluate((e) => e.open))) await d.locator("summary").click(); };
    await openSection("walls");
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
    await openSection("walls");
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
    await openSection("walls");
    await page.getByTestId("synced-wall_length").waitFor();
    check((await page.getByTestId("result-wall_length").innerText()) === "REVIEW", "after sync the server's result (REVIEW) is shown and marked Synced");
    check((await page.getByTestId("audit-sync").innerText()) === "Audit is on the server", "after sync the audit is marked as on the server");

    console.log("== NETWORK OFF again: finish the audit (check items, photo evidence, critical MEP failure, submit)");
    await context.setOffline(true);
    await openSection("general");
    await page.getByTestId("item-access").getByTestId("mark-pass").click();
    await page.getByTestId("pending-access").waitFor();
    check((await page.getByTestId("result-access").innerText()) === "PASS", "offline: a check item is marked PASS and queued");

    await openSection("walls");
    const plumb = page.getByTestId("item-wall_plumb");
    await plumb.getByTestId("note").fill("leans about 1/2 in over 8 ft");
    await plumb.getByTestId("mark-observed").click();
    await page.getByTestId("pending-wall_plumb").waitFor();
    check((await page.getByTestId("result-wall_plumb").innerText()) === "OBSERVED", "offline: plumb is an observation (no pass/fail, never blocks)");

    await openSection("mep");
    const outlets = page.getByTestId("item-outlets");
    await outlets.getByTestId("mark-fail").click();
    check((await outlets.getByTestId("save-error").innerText()).includes("photo (0/1)"), "evidence rule: a critical MEP result cannot be saved without its photo");
    await outlets.getByTestId("photo-input-outlets").setInputFiles(ICON);
    await outlets.getByTestId("photo-thumb").waitFor();
    check((await outlets.getByTestId("photo-status").innerText()) === "On this device", "offline: photo captured, compressed and kept on the device");
    await outlets.getByTestId("note").fill("outlet lands where the filler goes");
    await outlets.getByTestId("mark-fail").click();
    await page.getByTestId("critical-banner").waitFor();
    check((await page.getByTestId("readiness").innerText()) === "NOT READY", "offline: a critical MEP FAIL flags the audit NOT READY immediately");

    check((await page.getByTestId("warn-not-entered").innerText()).includes("no result"), "submit panel warns about items with no result");
    check((await page.getByTestId("warn-critical-not-entered").innerText()).includes("sprinklers"), "submit panel names critical items that were never checked");
    await page.getByTestId("submit-audit").click();
    await page.getByTestId("confirm-submit").click();
    await page.getByTestId("submitted-panel").waitFor();
    check((await page.getByTestId("item-access").getByTestId("mark-pass").count()) === 0, "after submit the audit is read-only on the device");
    check((await page.getByTestId("readiness").innerText()) === "NOT READY", "submitted audit with a critical fail stays NOT READY (completed is not authorized)");
    check((await page.getByTestId("pending-count").innerText()).startsWith("7 "), "offline: 7 changes waiting (2 results, 3 photo steps, 1 critical result, submit)");
    const logBefore = (await mockState()).log.length;
    await page.reload();
    await page.getByTestId("audit-row").click();
    await page.getByTestId("submitted-panel").waitFor();
    check((await page.getByTestId("readiness").innerText()) === "NOT READY" && (await mockState()).log.length === logBefore, "durable: submitted state survives an offline reload; the server still received nothing");

    console.log("== NETWORK ON, but photo uploads keep failing: results must still sync");
    await control({ storageDown: true });
    await context.setOffline(false);
    await waitFor(async () => { const l = (await mockState()).log; return l.some((x) => x.entity === "audit" && x.baseVersion === 1 && x.outcome === "applied"); }, "submit reaches the server while uploads fail");
    const mid = await mockState();
    const idx = (pred) => mid.log.findIndex(pred);
    check(idx((x) => x.entity === "photo_register") > -1 && idx((x) => x.entity === "photo_register") < idx((x) => x.entity === "audit_item" && x.entityId.endsWith(":outlets")), "photo was registered on the server BEFORE the result that needs it");
    check(mid.log.some((x) => x.entity === "audit_item" && x.entityId.endsWith(":outlets") && x.outcome === "applied"), "the critical result was applied (a stuck upload did not block it)");
    check(Object.keys((await (await fetch(`${MOCK}/__photos`)).json()).objects).length === 0, "no file has been uploaded yet (storage is down)");
    await page.getByRole("button", { name: "Sync queue" }).click();
    await waitFor(async () => (await page.getByTestId("queue-status").allInnerTexts()).includes("will retry"), "stuck upload shows 'will retry'");
    check(true, "the failed upload is kept as 'will retry', never marked synced");

    console.log("== storage recovers");
    await control({ storageDown: false });
    await page.getByTestId("sync-now").click();
    await waitFor(async () => { const t = await page.getByTestId("queue-status").allInnerTexts(); return t.length === 9 && t.every((x) => x === "synced"); }, "all 9 ops synced");
    const photoState = await (await fetch(`${MOCK}/__photos`)).json();
    const ph = photoState.photos[0];
    check(photoState.photos.length === 1 && ph.confirmed === true && photoState.objects[ph.storage_path] === ph.bytes, "photo uploaded, size matches the registered size, and confirmed by the server");
    const end = await mockState();
    check(end.log.filter((x) => x.entity === "photo_register").length === 1 && end.log.filter((x) => x.entity === "audit_item" && x.entityId.endsWith(":outlets") && x.outcome === "applied").length === 1, "photo registered once and the critical result applied once");
    await page.getByRole("button", { name: "Projects" }).click();
    await page.getByTestId("audit-row").click();
    await page.getByTestId("server-state").waitFor();
    check((await page.getByTestId("readiness").innerText()) === "NOT READY", "the server's own readiness (NOT READY) is shown, marked 'confirmed by the server'");
    await openSection("mep");
    check((await page.getByTestId("item-outlets").getByTestId("photo-status").innerText()) === "Uploaded", "photo shows 'Uploaded' only after the server confirmed it");
    const local = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction("photos").objectStore("photos").getAll(); q.onsuccess = () => resolve(q.result.map((p) => ({ confirmed: p.confirmed, hasBlob: !!p.blob, hasOriginal: !!p.originalBlob, hasThumb: !!p.thumb }))); }; }));
    check(local.length === 1 && local[0].confirmed && !local[0].hasBlob && !local[0].hasOriginal && local[0].hasThumb, "after confirmation the heavy copies are removed from the device (preview kept)");

    console.log("== who and when are recorded on the audit and on each issue");
    const rec = await page.getByTestId("recorded-outlets").innerText();
    check(rec.includes("Pat Installer") && /\d{4}/.test(rec) && /\d:\d\d/.test(rec), "a result shows who recorded it and when: " + rec);
    const iss = await page.getByTestId("issue-outlets").innerText();
    check(iss.startsWith("Issue raised by Pat Installer") && /\d:\d\d/.test(iss), "a failed item shows who raised the issue and when: " + iss);
    const hist = await page.getByTestId("audit-history").innerText();
    check(hist.includes("Started by Pat Installer") && hist.includes("Submitted by Pat Installer"), "the audit shows who started and who submitted it, with times");
    const rows1 = await (await fetch(`${MOCK}/__rows`)).json();
    const k1 = Object.keys(rows1).find((k) => k.endsWith(":1:outlets"));
    check(rows1[k1].result_by === "Pat Installer" && rows1[k1].issue_by === "Pat Installer" && !!rows1[k1].issue_at, "the server stored who and when for the result and for the issue");
    const photoNoStamp = await page.getByTestId("item-outlets").getByTestId("photo-thumb").first().innerText();
    check(!/\d:\d\d/.test(photoNoStamp), "photos themselves carry no timestamp text");

    console.log("== NETWORK OFF: revise the submitted audit, mark up a photo, correct the critical item, resubmit");
    await context.setOffline(true);
    await page.getByTestId("revise-audit").click();
    check(await page.getByTestId("confirm-revise").isDisabled(), "revise needs a reason (button disabled until one is typed)");
    await page.getByTestId("revise-reason-input").fill("GC moved the outlet; re-checked on site");
    await page.getByTestId("confirm-revise").click();
    await page.getByTestId("versions").waitFor();
    check((await page.getByTestId("version-2").innerText()).includes("(current)"), "offline: version 2 created and is the current version");
    check((await page.getByTestId("revise-reason").innerText()).includes("GC moved the outlet"), "the reason for the revision is shown");
    await openSection("mep");
    check((await page.getByTestId("result-outlets").innerText()) === "FAIL" && (await page.getByTestId("issue-outlets").count()) === 1, "results and who/when carry over into the revision");
    check((await page.getByTestId("submit-panel").count()) === 1, "the revision is an editable draft again");

    await page.getByTestId("version-1").click();
    await page.getByTestId("old-version-banner").waitFor();
    check((await page.getByTestId("item-outlets").getByTestId("mark-fail").count()) === 0 && (await page.getByTestId("revise-audit").count()) === 0, "version 1 is read-only (the saved record)");
    check((await page.getByTestId("readiness").innerText()) === "NOT READY", "version 1 keeps its own NOT READY result");
    await page.getByTestId("version-2").click();
    await openSection("mep");

    const out = page.getByTestId("item-outlets");
    // the version-1 photo was cleaned up after upload, so with no connection it cannot be edited: the app says so plainly
    await out.getByTestId("annotate-btn").first().click();
    await out.locator('[role="alert"]').first().waitFor();
    check((await out.locator('[role="alert"]').first().innerText()).includes("no longer stored on the device") && (await page.getByTestId("annotate-modal").count()) === 0, "offline: a photo already cleaned up after upload explains that it needs a connection to mark up");

    await out.getByTestId("photo-input-outlets").setInputFiles(ICON);
    await waitFor(async () => (await out.getByTestId("photo-thumb").count()) === 2, "second photo thumb");
    await out.getByTestId("annotate-btn").nth(1).click();
    const canvas = page.getByTestId("annotate-canvas");
    await waitFor(async () => (await canvas.evaluate((c) => c.width)) > 0 && (await canvas.boundingBox()), "annotation canvas ready");
    const box = await canvas.boundingBox();
    const drag = async (x1, y1, x2, y2) => { await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1); await page.mouse.down(); await page.mouse.move(box.x + box.width * ((x1 + x2) / 2), box.y + box.height * ((y1 + y2) / 2)); await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2); await page.mouse.up(); };
    check(await page.getByTestId("save-annotation").isDisabled(), "save is disabled until something is drawn");
    await page.getByTestId("tool-pen").click(); await page.getByTestId("color-0").click(); await drag(0.15, 0.2, 0.55, 0.45);
    await page.getByTestId("tool-highlight").click(); await page.getByTestId("color-1").click(); await drag(0.2, 0.7, 0.8, 0.7);
    await page.getByTestId("tool-text").click(); await page.getByTestId("color-3").click();
    await canvas.click({ position: { x: box.width * 0.3, y: box.height * 0.1 } });
    await page.getByTestId("text-input").fill("outlet is 6in left of spec");
    await page.getByTestId("text-add").click();
    check(await page.getByTestId("undo").isEnabled() && await page.getByTestId("save-annotation").isEnabled(), "pen, highlighter and text marks drawn; save enabled");
    await page.getByTestId("save-annotation").click();
    await waitFor(async () => (await out.getByTestId("photo-thumb").count()) === 3, "annotated copy appears");
    check((await out.locator('[data-annotated="yes"]').count()) === 1 && (await out.getByTestId("photo-kind").innerText()) === "Marked up", "offline: a marked-up COPY is saved next to the originals");

    await out.getByTestId("edit-marks").click();
    await waitFor(async () => Number(await page.getByTestId("tools").getAttribute("data-marks")) > 0, "editor reopened with the saved marks");
    check(true, "the saved marks reopen for editing (marks are stored as editable data, not just pixels)");
    await page.getByTestId("cancel-annotation").click();

    await out.getByTestId("note").fill("outlet moved to the spec location");
    await out.getByTestId("mark-pass").click();
    await page.getByTestId("pending-outlets").waitFor();
    check((await out.getByTestId("issue-outlets").count()) === 0 && (await page.getByTestId("readiness").innerText()) === "In progress", "correcting the item clears the issue; the earlier photo still satisfied the photo rule");
    check((await page.getByTestId("recorded-outlets").innerText()).includes("Pat Installer"), "the correction records who and when");
    await page.getByTestId("submit-audit").click(); await page.getByTestId("confirm-submit").click();
    await page.getByTestId("submitted-panel").waitFor();
    check((await page.getByTestId("readiness").innerText()) === "Manager review required", "revision 2 submitted: the critical item is fixed, but the wall length still in the REVIEW zone needs a manager's decision");
    check((await page.getByTestId("pending-count").innerText()).startsWith("9 "), "offline: 9 changes waiting (revise, new photo x3, marked-up copy x3, the correction, submit)");

    console.log("== back online: everything for version 2 syncs");
    await control({ storageDown: false });
    await context.setOffline(false);
    await page.getByRole("button", { name: "Sync queue" }).click();
    await waitFor(async () => { const t = await page.getByTestId("queue-status").allInnerTexts(); return t.length === 18 && t.every((x) => x === "synced"); }, "all 18 ops synced");
    const s3 = await mockState(); const ph3 = await (await fetch(`${MOCK}/__photos`)).json();
    check(s3.log.filter((l) => l.entity === "audit" && l.action === "revise" && l.entityId.endsWith(":2") && l.outcome === "applied").length === 1, "the revise operation was applied exactly once");
    const ann = ph3.photos.find((p) => p.annotated_from);
    check(!!ann && ann.annotations.length === 3 && ann.annotations.map((a) => a.type).sort().join() === "highlight,pen,text", "the server stored the marks as editable data: pen, highlighter and text");
    check(ann.version === 2 && ph3.photos.filter((p) => !p.annotated_from).length === 2, "the copy belongs to version 2 and links to its original; there are 2 original photos");
    check(ph3.photos.every((p) => p.confirmed && ph3.objects[p.storage_path] === p.bytes), "all 3 photos uploaded, sizes match, and confirmed");
    const rows3 = await (await fetch(`${MOCK}/__rows`)).json();
    const k2 = Object.keys(rows3).find((k) => k.endsWith(":2:outlets"));
    check(rows3[k2].result === "PASS" && rows3[k2].issue_at === null && rows3[k2].result_by === "Pat Installer", "version 2 on the server: PASS, issue cleared, recorded by Pat Installer");
    check(rows1[k1].result === "FAIL" && (await (await fetch(`${MOCK}/__rows`)).json())[k1].result === "FAIL", "version 1 on the server is unchanged (still FAIL)");
    await page.getByRole("button", { name: "Projects" }).click();
    await page.getByTestId("audit-row").click();
    await page.getByTestId("server-state").waitFor();
    check((await page.getByTestId("readiness").innerText()) === "Manager review required", "the server's own readiness for version 2 (Manager review required) is shown");
    await page.getByTestId("version-1").click();
    await waitFor(async () => (await page.getByTestId("readiness").innerText()) === "NOT READY", "version 1 shows NOT READY");
    check(true, "version 1 still shows the server's NOT READY");
    await page.getByTestId("version-2").click();
    const local3 = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("phc-field"); r.onsuccess = () => { const q = r.result.transaction("photos").objectStore("photos").getAll(); q.onsuccess = () => resolve(q.result.map((p) => ({ confirmed: p.confirmed, hasBlob: !!p.blob, annotated: !!p.annotatedFrom, marks: p.annotations ? p.annotations.length : 0 }))); }; }));
    check(local3.length === 3 && local3.every((p) => p.confirmed && !p.hasBlob) && local3.find((p) => p.annotated).marks === 3, "after upload the images leave the phone but the editable marks stay");

    console.log("== online: an old photo that left the phone is downloaded so its marks can be edited");
    await openSection("mep");
    await page.getByTestId("item-outlets").getByTestId("annotate-btn").first().click();
    await page.getByTestId("annotate-modal").waitFor();
    await waitFor(async () => (await canvas.evaluate((c) => c.width)) > 0, "editor open on the downloaded photo");
    check((await mockState()).log.some((l) => l.entity === "photo_download"), "the original was downloaded from storage to edit it");
    await page.getByTestId("cancel-annotation").click();
    console.log(`\nE2E PASSED: ${results.length} checks`);
  } finally {
    if (browser) await browser.close();
    killAll();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

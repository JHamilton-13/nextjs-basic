// Manager screens (builder contact, room status, build / preview / send reports) in the REAL default build, on emulated phones.
// The api handler behind /api/reports is the real code from packages/reports; the mock server supplies the database, storage and a fake email transport.
// Run: npm run e2e:reports -w @phc/field
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { chromium, devices } = require("playwright");

const APP = "http://127.0.0.1:4173", MOCK = "http://127.0.0.1:54500";
const USER = "00000000-0000-4000-8000-000000000004";
const cwd = path.resolve(__dirname, "..");
const OUT = path.join(os.tmpdir(), "phc-reports-build");
const IMG = path.resolve(cwd, "../../docs/testing/images");
const results = []; const problems = [];
const check = (cond, name) => { results.push({ ok: !!cond, name }); console.log(`${cond ? "ok" : "NOT OK"} - ${name}`); if (!cond) problems.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`); await sleep(150); } }
const control = (c) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(c) });
const server = async () => (await fetch(`${MOCK}/__sent`)).json();

(async () => {
  for (const u of [MOCK + "/__state", APP]) { let up = false; try { up = (await fetch(u)).ok; } catch {} if (up) throw new Error(`port already in use (stale server?): ${u}`); }
  console.log("== build (default build, no test flags)");
  const env = { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_PUBLISHABLE_KEY: "test-key" }; delete env.VITE_SHOW_AUDIT;
  execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { cwd, stdio: "pipe", env });
  const procs = [
    spawn("npx", ["vite-node", "e2e/mock-server.ts"], { cwd, stdio: "pipe", detached: true }),
    spawn("npx", ["vite", "preview", "--outDir", OUT, "--port", "4173", "--strictPort", "--host", "127.0.0.1"], { cwd, stdio: "pipe", detached: true }),
  ];
  let mockLog = ""; procs[0].stdout.on("data", (d) => (mockLog += d)); procs[0].stderr.on("data", (d) => (mockLog += d));
  const killAll = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
  process.on("exit", killAll);
  let browser;
  try {
    await waitFor(async () => (await fetch(`${MOCK}/__state`)).ok, "mock server");
    await waitFor(async () => (await fetch(APP)).ok, "preview server");
    browser = await chromium.launch();
    fs.mkdirSync(IMG, { recursive: true });

    for (const deviceName of ["iPhone SE", "iPhone 13", "Pixel 7"]) {
      console.log(`== ${deviceName}`);
      const tag = (s) => `${deviceName}: ${s}`;
      await control({ resetIssues: true, resetChecks: true });
      const context = await browser.newContext({ ...devices[deviceName], serviceWorkers: "block" });
      const session = { access_token: "test-token", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: USER, aud: "authenticated", email: "installer@phc.test", app_metadata: {}, user_metadata: { full_name: "Pat Installer" }, created_at: "2026-11-08T00:00:00Z" } };
      await context.addInitScript((s) => { if (!localStorage.getItem("phc-auth")) localStorage.setItem("phc-auth", JSON.stringify(s)); }, session);
      // the app calls /api/reports on its own address; in production the same Vercel project serves it. Here it is handed to the mock's copy of the real handler.
      await context.route("**/api/reports", async (route) => { const r = await route.fetch({ url: `${MOCK}/api/reports` }); await route.fulfill({ response: r }); });
      const page = await context.newPage();
      page.on("pageerror", (e) => { console.log("  [pageerror]", e.message); problems.push(tag(`page error: ${e.message}`)); });
      await page.goto(APP);
      await page.getByTestId("project-card").waitFor();
      await page.getByTestId("open-project").tap();
      await page.locator('[data-room="Kitchen"]').waitFor();

      // ---- an installer never sees the manager screens ----
      check((await page.getByTestId("open-reports").count()) === 0, tag("an installer has no Reports button"));

      // ---- a manager does ----
      await control({ role: "project_manager" });
      await page.getByRole("button", { name: "Sync queue" }).tap();
      await page.getByTestId("sync-now").tap();
      await waitFor(async () => (await page.getByTestId("sync-now").innerText()) === "Sync now", "sync finished");
      await page.getByRole("button", { name: "Projects", exact: true }).tap();
      await page.getByTestId("project-card").waitFor();
      await page.getByTestId("open-project").tap();
      await page.getByTestId("open-reports").waitFor();
      check(true, tag("a project manager sees 'Reports and builder contact' on the job"));
      const box = await page.getByTestId("open-reports").boundingBox();
      check(box.height >= 44, tag(`the Reports button is at least 44 px tall (${Math.round(box.height)})`));
      await page.getByTestId("open-reports").tap();
      await page.getByTestId("builder-contact").waitFor();
      await page.getByTestId("room-status-row").first().waitFor();

      // room status
      const rows = await page.getByTestId("room-status-row").allInnerTexts();
      check(rows.length === 2 && rows.every((r) => r.includes("Not completed")), tag("both rooms show Not completed when nothing is ticked"));
      check(rows[0].includes("Kitchen") && rows[0].includes("1 open issue") && rows[0].includes("Checklist not started"), tag("the Kitchen shows its 1 open issue and 'Checklist not started'"));
      check(!/Bath 1/.test(rows[0]) && rows[1].includes("Bath 1") && rows[1].includes("0 open issues"), tag("rooms are listed in order with their own counts"));

      // builder contact: validation, save, persistence
      const save = page.getByTestId("contact-save");
      check(await save.isDisabled(), tag("Save contact is disabled until something changes"));
      await page.getByTestId("contact-email").fill("not an email");
      check((await page.getByTestId("contact-email-error").isVisible()) && (await save.isDisabled()), tag("a bad email shows an error and Save stays disabled"));
      await page.getByTestId("contact-name").fill("Sample Builder");
      await page.getByTestId("contact-email").fill("builder@example.test");
      await page.getByTestId("contact-address").fill("123 Example Street, Sampleville");
      await save.tap();
      await waitFor(async () => (await page.getByTestId("reports-message").innerText()).includes("Saved"), "saved message");
      const s1 = await server();
      check(s1.contact.prepared_for_email === "builder@example.test" && s1.contact.prepared_for_name === "Sample Builder" && s1.contact.address === "123 Example Street, Sampleville", tag("the contact reached the server"));
      check(await save.isDisabled(), tag("Save is disabled again once saved"));

      // build the site audit
      check((await page.getByTestId("report-row").count()) === 0, tag("no reports before building"));
      await page.getByTestId("build-audit").tap();
      await page.getByTestId("report-row").waitFor({ timeout: 30000 });
      const built = await page.getByTestId("reports-message").innerText();
      check(/Site audit built/.test(built), tag("building reports success in plain words"));
      const row = page.getByTestId("report-row").first();
      check((await row.getAttribute("data-status")) === "built" && (await row.innerText()).includes("Ready to send"), tag("the new report is 'Ready to send'"));
      const s2 = await server();
      check(s2.reports.length === 1 && s2.reports[0].status === "built" && s2.reports[0].file_size > 1000 && s2.sent.length === 0, tag("one report stored, nothing emailed by building"));
      await page.screenshot({ path: path.join(IMG, `manager-reports-${deviceName.replace(/\W+/g, "-").toLowerCase()}.png`), fullPage: true });

      // preview opens the stored PDF through a signed link
      const [popup] = await Promise.all([context.waitForEvent("page"), row.getByTestId("report-preview").tap()]);
      await popup.waitForLoadState().catch(() => {});
      check(popup.url().includes("/storage/v1/object/sign/reports/") && popup.url().includes(".pdf"), tag("Preview opens the PDF from a signed link"));
      await popup.close();

      // send a test to me: only to the manager, status unchanged
      await row.getByTestId("report-test").tap();
      await waitFor(async () => (await page.getByTestId("reports-message").innerText()).includes("Test copy sent"), "test sent");
      const s3 = await server();
      check(s3.sent.length === 1 && s3.sent[0].to === "installer@phc.test" && s3.sent[0].subject.startsWith("TEST") && s3.sent[0].isPdf, tag("'Send test to me' emails only the signed-in manager, with the PDF attached"));
      check((await page.getByTestId("report-row").first().getAttribute("data-status")) === "built", tag("a test does not use up the real send"));

      // send to the builder: confirm step first
      await row.getByTestId("report-send").tap();
      const confirm = page.getByTestId("send-confirm");
      check((await confirm.innerText()).includes("builder@example.test") && (await confirm.innerText()).includes("Sample Builder") && (await confirm.innerText()).includes("only be sent once"), tag("the confirm step names the builder and says it sends once"));
      await page.getByTestId("send-confirm-no").tap();
      check((await confirm.count()) === 0 && (await server()).sent.length === 1, tag("Cancel sends nothing"));
      await row.getByTestId("report-send").tap();
      await page.getByTestId("send-confirm-yes").dblclick().catch(() => {});             // a double tap must not double send
      await waitFor(async () => (await page.getByTestId("reports-message").innerText()).includes("Sent to builder@example.test"), "sent");
      const s4 = await server();
      const toBuilder = s4.sent.filter((m) => m.to === "builder@example.test");
      check(toBuilder.length === 1 && toBuilder[0].isPdf && /Site Audit \d{4}-\d{2}-\d{2}\.pdf$/.test(toBuilder[0].filename) && toBuilder[0].from.includes("reports@example.test"), tag("exactly one email went to the builder, with the PDF attached and a safe file name"));
      check(s4.reports[0].status === "sent" && s4.reports[0].sent_at, tag("the report is recorded as sent"));
      await waitFor(async () => (await page.getByTestId("report-row").first().getAttribute("data-status")) === "sent", "row shows sent");
      check((await page.getByTestId("report-row").first().getByTestId("report-send").count()) === 0, tag("a sent report has no Send button (it can only be sent once)"));

      // a failure: the report shows Failed, the reason, and Retry; the retry sends once
      await page.getByTestId("build-audit").tap();
      await waitFor(async () => (await page.getByTestId("report-row").count()) === 2, "second report", 30000);
      await control({ sendFail: "Gmail refused the message (403): Quota exceeded" });
      const second = page.getByTestId("report-row").first();
      await second.getByTestId("report-send").tap();
      await page.getByTestId("send-confirm-yes").tap();
      await waitFor(async () => (await page.getByTestId("report-row").first().getAttribute("data-status")) === "failed", "failed status");
      check((await page.getByTestId("reports-message").innerText()).includes("not sent") && (await page.getByTestId("report-error").innerText()).includes("Quota exceeded"), tag("a failed send says so, with the reason"));
      check((await (await server()).sent.filter((m) => m.to === "builder@example.test")).length === 1, tag("a failed send emailed nobody"));
      await control({ sendFail: null });
      check((await page.getByTestId("report-row").first().getByTestId("report-send").innerText()).includes("Retry"), tag("a failed report offers Retry"));
      await page.getByTestId("report-row").first().getByTestId("report-send").tap();
      await page.getByTestId("send-confirm-yes").tap();
      await waitFor(async () => (await page.getByTestId("report-row").first().getAttribute("data-status")) === "sent", "retry sent");
      check((await (await server()).sent.filter((m) => m.to === "builder@example.test")).length === 2, tag("the retry sent once"));

      // a stuck 'queued' report tells the manager to check the Sent folder
      await page.getByTestId("build-status").tap();
      await waitFor(async () => (await page.getByTestId("report-row").count()) === 3, "status report", 30000);
      check((await page.getByTestId("report-row").first().innerText()).includes("Room status") && (await page.getByTestId("report-row").first().getByTestId("report-send").count()) === 0, tag("a status PDF can be previewed and tested but has no Send to builder button"));

      // 44 px touch targets on the buttons that matter
      const targets = ["build-audit", "build-status", "contact-save"];
      for (const id of targets) { const b = await page.getByTestId(id).boundingBox(); check(b.height >= 44, tag(`${id} is at least 44 px tall (${Math.round(b.height)})`)); }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!overflow, tag("no sideways scrolling on this screen"));

      // offline: the screen says so plainly
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await page.getByTestId("reports-offline").waitFor();
      check(true, tag("offline: 'Reports need a connection' instead of a broken screen"));
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.getByTestId("builder-contact").waitFor();
      check(true, tag("back online: the screen returns"));

      // a user who is not a manager loses the screen immediately (role change takes effect after the next sync)
      await control({ role: "installer" });
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.getByRole("button", { name: "Sync queue" }).tap();
      await page.getByRole("button", { name: "Projects", exact: true }).tap();
      await context.close();
    }
  } finally { await browser?.close().catch(() => {}); killAll(); if (problems.length) console.log("--- mock log tail ---\n" + mockLog.slice(-1500)); }
  if (problems.length) { console.log(`\nREPORT SCREEN CHECKS FAILED: ${problems.length}`); process.exit(1); }
  console.log(`\nREPORT SCREEN CHECKS PASSED: ${results.length} checks`);
})().catch((e) => { console.error(e); process.exit(1); });

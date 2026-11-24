# Step 3 test results — installer PWA vertical slice (apps/field)

Date: 2026-11-08. Vitest 3 + fake-indexeddb; Playwright 1.63 (preinstalled Chromium, headless).

## Unit tests (`npm test -w @phc/field`) — verbatim
```
> @phc/field@0.1.0 test
> vitest run
 RUN  v3.2.7 /home/user/nextjs-basic/apps/field
 ✓ test/outbox.test.ts (13 tests) 45ms
 ✓ test/audits.test.ts (10 tests) 33ms
 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  01:39:35
   Duration  454ms (transform 193ms, setup 0ms, collect 345ms, tests 79ms, environment 0ms, prepare 126ms)
```

## End-to-end, network OFF (`npm run e2e -w @phc/field`) — verbatim (stable over 4 consecutive runs after fixes)
```
== build (pointing the app at the mock server)
== online first load: download projects/templates, install the service worker
ok - online: assigned project is listed
ok - service worker installed and app shell cached
ok - installable: web manifest is standalone with icons
== NETWORK OFF: reload and work offline
ok - offline reload: app shell loads from the service worker and shows Offline
ok - offline reload: project still listed from the device
ok - offline: audit started and saved on the device (not yet on the server)
ok - offline: 1 change waiting
ok - live preview: +1" from drawing is REVIEW
ok - evidence rule: cannot save without a drawing reference
ok - evidence rule: nothing was queued by the refused save
ok - offline: measurement saved, provisional REVIEW shown
ok - offline: measurement says 'Waiting to sync', not 'Synced'
ok - offline: 2 changes waiting
ok - offline: the server received nothing
ok - durable: after an offline reload both changes are still queued
ok - durable: the measurement survived the reload
== NETWORK ON, but the first response is lost (power loss / dropped connection)
ok - lost response: the op is kept as 'will retry' (not marked synced)
ok - lost response: the server applied the create op once; any browser resend was a harmless duplicate
ok - retry after lost response: the same opId came back as a duplicate and NO second audit was created
ok - the measurement was applied exactly once, after the create (order kept)
ok - queue is empty after the server confirmed everything
ok - after sync the server's result (REVIEW) is shown and marked Synced
ok - after sync the audit is marked as on the server
E2E PASSED: 23 checks
```
What it proves: the production build installs a service worker; with the network switched off the app reloads from the service worker, lists the
project from IndexedDB, starts an audit, enforces the drawing-reference evidence rule, saves a measurement with a live preview, keeps everything
across a reload, and — when the network returns but every response is lost — keeps the op as "will retry", never marks it synced, and after recovery
the server sees the same opId as a duplicate (one audit, one measurement, order kept) and the app shows the server's result as Synced.

## Bugs found by these tests and fixed
1. Back online, the app honoured retry backoff accumulated while offline, so it waited up to 30 s. Fix: never attempt a send while `navigator.onLine` is false (no backoff inflation), treat the `online` event as a reason to retry immediately, and check for due retries every 10 s.
2. E2E harness left `vite`/mock processes running between runs (npx grandchildren), so a later run silently used a stale mock server. Fix: run them detached and kill the process group; refuse to start if the ports are taken.
3. `.gitignore` only ignored the root `node_modules`, so a Vitest cache file under `packages/domain/node_modules` had been committed earlier. Removed from the index; `node_modules/`, `dist/`, `.vite/` are now ignored in every workspace.
4. Test expectations (not product bugs): Chromium itself resends a POST whose connection dropped; the server's idempotency turned that into a harmless duplicate. The e2e now asserts the invariant (applied once, every other arrival a duplicate of the same opId).

## Known gaps / not verified
- **Real sign-in from the PWA** (Google, email code) has not been exercised: the container cannot receive the emailed code or complete a Google redirect. The sign-in gate itself was verified against live Supabase Auth (see Step 2 results).
- **Real devices**: no iOS Safari / Android Chrome run. iOS storage limits and the lack of background sync are the main risks (spec §11).
- **No live sync to the real database from the PWA**: sync is tested against a mock that mirrors `apply_op`'s semantics; the real function is covered by the database tests (235 assertions + concurrency).
- Token expiry while offline: identity falls back to the stored user so work continues, but this case has a design but no automated test.
- No photos, no check/observation entry, no submit/release/override UI yet; conflict handling is shown in the queue but has no resolution screen.
- No accessibility audit (labels/touch targets follow the mobile-first rules, unaudited), no performance measurement beyond build size (12 precache entries, ~408 KiB).

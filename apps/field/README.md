# @phc/field — installer PWA (Step 3 vertical slice)

Installable, offline-first web app for the pre-install site audit. React + TypeScript + Vite; IndexedDB (via `idb`) for local data;
service worker via `vite-plugin-pwa`; Supabase Auth + the `apply_op` RPC for sync. All measurement/tolerance/sync logic comes from `@phc/domain`.

## What works in this slice
- Sign in: Google, or email 6-digit code (invite list enforced by the database hook).
- Projects you belong to, their rooms and the active audit templates are downloaded to the device (IndexedDB).
- With no connection: start an audit, enter wall-length / ceiling-height measurements (inches-fractions, feet-inches, mm), see a live PASS/REVIEW/FAIL from the template's rule data, and queue everything.
- Durable outbox: written to IndexedDB before any network call; sent in order; retried with backoff; resumable after reload/crash; only shown as "synced" after the server confirms.
- After sync the server's recomputed result replaces the provisional one.
- Check items (pass / fail / review / N/A), observation items, and the 8 critical MEP rough-in items, with each item's evidence rules enforced before saving (photo count, note, drawing reference).
- Photos: camera capture, JPEG compression (2048 px, quality 0.8), SHA-256, durable register -> upload -> confirm queue; the original stays on the phone until the upload is confirmed.
- Critical MEP FAIL flags the audit NOT READY at once. Submit shows warnings (items with no result, critical items never checked) but is never blocked; after submit the audit is read-only here.
- Readiness comes from the server once the submit has synced; until then it is computed on the device with the same rules.
- Revise a submitted audit (offline): starts version n+1 with results carried over; version n stays as the read-only record; version tabs switch between them.
- Photo mark-up: pen, highlighter, text. Marks are editable vector data; saving creates a marked-up COPY, the original is never changed.
- Who/when: every result shows who recorded it and when; a failed/review item shows who raised the issue and when; the audit shows who started and submitted it. Photos carry no timestamp.

## Not built yet
Manager release/override screens (dashboard), more annotation tools, drawings, conflict resolution UI, an in-app
notification inbox, supervisor approval, background sync (iOS has none: the queue drains when the app is opened/foregrounded), push notifications.

## Run
```bash
cp apps/field/.env.example apps/field/.env.local   # fill in the project URL and the PUBLISHABLE key (never a secret/service-role key)
npm install
npm run dev -w @phc/field                          # Vite prints the local URL
npm run build -w @phc/field && npm run preview -w @phc/field   # service worker only runs in a production build
```
Add the dev/preview URL to Supabase > Authentication > URL Configuration for Google sign-in redirects.

## Tests
- `npm test -w @phc/field` — outbox (lanes, dependencies, backoff, recovery), audits, photos, checks, submit, readiness against fake-indexeddb.
- `npm run e2e -w @phc/field` — real Chromium + service worker + IndexedDB with the network switched off, against a local mock of Supabase
  (`e2e/mock-server.ts`, which reuses the domain package's reference model of `apply_op` and the real example template). It cannot test real
  sign-in (needs an emailed code) or a real phone.

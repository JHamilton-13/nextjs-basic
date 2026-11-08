# @phc/field — installer PWA (Step 3 vertical slice)

Installable, offline-first web app for the pre-install site audit. React + TypeScript + Vite; IndexedDB (via `idb`) for local data;
service worker via `vite-plugin-pwa`; Supabase Auth + the `apply_op` RPC for sync. All measurement/tolerance/sync logic comes from `@phc/domain`.

## What works in this slice
- Sign in: Google, or email 6-digit code (invite list enforced by the database hook).
- Projects you belong to, their rooms and the active audit templates are downloaded to the device (IndexedDB).
- With no connection: start an audit, enter wall-length / ceiling-height measurements (inches-fractions, feet-inches, mm), see a live PASS/REVIEW/FAIL from the template's rule data, and queue everything.
- Durable outbox: written to IndexedDB before any network call; sent in order; retried with backoff; resumable after reload/crash; only shown as "synced" after the server confirms.
- After sync the server's recomputed result replaces the provisional one.

## Not in this slice (shown as "next step" or absent)
Photos, check/observation items (listed read-only), MEP stop-gate UI, submit/release/override screens, drawings, conflict resolution UI,
background sync (iOS has none: the queue drains when the app is opened/foregrounded), push notifications.

## Run
```bash
cp apps/field/.env.example apps/field/.env.local   # fill in the project URL and the PUBLISHABLE key (never a secret/service-role key)
npm install
npm run dev -w @phc/field                          # Vite prints the local URL
npm run build -w @phc/field && npm run preview -w @phc/field   # service worker only runs in a production build
```
Add the dev/preview URL to Supabase > Authentication > URL Configuration for Google sign-in redirects.

## Tests
- `npm test -w @phc/field` — outbox (13) and audit/measurement logic (10) against fake-indexeddb.
- `npm run e2e -w @phc/field` — real Chromium + service worker + IndexedDB with the network switched off, against a local mock of Supabase
  (`e2e/mock-server.ts`, which reuses the domain package's reference model of `apply_op` and the real example template). It cannot test real
  sign-in (needs an emailed code) or a real phone.

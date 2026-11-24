# Step 4 test results — finishing the installer audit (photos, check items, submit)

Date: 2026-11-08. Scope: photos, check/observation/MEP items, submit, server readiness, queue lanes, `confirm_photo` size check (migration 1000, NOT applied remotely).

## Unit tests (`npm test -w @phc/field`) — verbatim
```
 ✓ test/outbox.test.ts (19 tests) 81ms
 ✓ test/audits.test.ts (10 tests) 57ms
 ✓ test/complete.test.ts (16 tests) 110ms
 Test Files  3 passed (3)
      Tests  45 passed (45)
```
Domain package: 122/122 (unchanged). Database: 237 assertions + concurrency (2 new: truncated upload cannot be confirmed; mismatched photo stays unconfirmed).

## End-to-end, real Chromium, network switched off (`npm run e2e -w @phc/field`) — verbatim (3 consecutive passes)
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
== NETWORK OFF again: finish the audit (check items, photo evidence, critical MEP failure, submit)
ok - offline: a check item is marked PASS and queued
ok - offline: plumb is an observation (no pass/fail, never blocks)
ok - evidence rule: a critical MEP result cannot be saved without its photo
ok - offline: photo captured, compressed and kept on the device
ok - offline: a critical MEP FAIL flags the audit NOT READY immediately
ok - submit panel warns about items with no result
ok - submit panel names critical items that were never checked
ok - after submit the audit is read-only on the device
ok - submitted audit with a critical fail stays NOT READY (completed is not authorized)
ok - offline: 7 changes waiting (2 results, 3 photo steps, 1 critical result, submit)
ok - durable: submitted state survives an offline reload; the server still received nothing
== NETWORK ON, but photo uploads keep failing: results must still sync
ok - photo was registered on the server BEFORE the result that needs it
ok - the critical result was applied (a stuck upload did not block it)
ok - no file has been uploaded yet (storage is down)
ok - the failed upload is kept as 'will retry', never marked synced
== storage recovers
ok - photo uploaded, size matches the registered size, and confirmed by the server
ok - photo registered once and the critical result applied once
ok - the server's own readiness (NOT READY) is shown, marked 'confirmed by the server'
ok - photo shows 'Uploaded' only after the server confirmed it
ok - after confirmation the heavy copies are removed from the device (preview kept)
E2E PASSED: 43 checks
```

## Bugs found by these tests and fixed
1. **A failed photo upload stopped results from syncing.** A retryable error anywhere ended the whole drain, so results queued behind a stuck upload never reached the server. Found by the "uploads keep failing: results must still sync" scenario. Fix: uploads/confirms run in a separate "files" lane; a retryable files-lane failure pauses uploads only; only a data-lane failure means the API is unreachable. Unit tests added for both directions.
2. Mock server syntax slip (test infrastructure) and an e2e step that forgot a reload returns to the project list (test bug). Both fixed in the harness.

## Design decisions made (owner to confirm)
- Order of server steps per photo: register row (data lane) -> upload file -> confirm (files lane, each waiting for the previous). The register op is always queued before any result that needs the photo, because the server counts REGISTERED photos as evidence.
- Photos are compressed on capture (long edge 2048 px, JPEG quality 0.8). The server receives ONLY that compressed copy; the original is kept on the device until the server confirms the upload and is then deleted. A 160 px preview stays on the device.
- A photo cannot be deleted or replaced once taken (evidence is permanent). A wrong photo stays; add a correct one.
- Submitting has no result gating (owner decision). The screen warns about items with no result and names critical items never checked; a never-checked critical item does NOT block (owner decision).
- After submit the audit is read-only on the device. There is no revise screen yet (the server function `revise_audit` exists).
- Readiness shown: the server's answer once the submit synced ("confirmed by the server"), otherwise computed on the device with the domain rules.

## Known gaps / not verified
- Mock vs real: Supabase Storage's real error shapes (duplicate upload, auth failure) and multipart upload were exercised only against the local mock; the real `confirm_photo`/RLS paths are covered by the database tests. A real-project photo upload has not been run (needs a signed-in session).
- Real devices: camera capture (`capture="environment"`), HEIC conversion, large photos and iOS storage limits are untested. Browser compression uses `createImageBitmap` + canvas (Chromium verified).
- Supervisor approval is not available in the app (items that require it show a message and cannot be completed).
- No photo annotation/markup, no viewing of photos taken on other devices, no photo count/size quota handling beyond a 10 MB cap per photo.
- Notifications to managers on a critical fail are created by the server (tested in the database suite) but there is no in-app inbox yet and no email is sent.
- Migration 1000 (`confirm_photo` size check) is written and tested locally; until it is applied the real project confirms a photo when the file merely exists.

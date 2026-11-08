# Step 5 test results — revise (offline), photo annotation, who/when

Date: 2026-11-08. Owner choices: revise works offline; annotation tools = freehand pen, highlighter, text label; the audit and each line item carry user + timestamp, photos carry none.
Migration 1100 is written and tested locally; NOT applied to the live project (awaiting owner approval).

## Database (local Postgres 16): 276 assertions + concurrency (39 new, in `supabase/tests/06_annotations_attribution_revise.sql`)
Mutation checks (temporary edits to migration 1100, all caught): annotated copies counted as evidence; photos counted only within one version; issue time = sync time;
second revise not conflicting; revise of an unsubmitted audit allowed; annotations editable in place.

## Field app unit tests (`npm test -w @phc/field`) — verbatim
```
 ✓ test/outbox.test.ts (19 tests) 66ms
 ✓ test/complete.test.ts (17 tests) 108ms
 ✓ test/revise.test.ts (17 tests) 113ms
 ✓ test/annotations.test.ts (12 tests) 14ms
 ✓ test/audits.test.ts (10 tests) 38ms
 ✓ test/db-upgrade.test.ts (2 tests) 25ms
 Test Files  6 passed (6)
      Tests  77 passed (77)
```
Domain package: 122/122 (unchanged).

## End-to-end, real Chromium, network switched off — verbatim (3 consecutive passes)
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
== who and when are recorded on the audit and on each issue
ok - a result shows who recorded it and when: Recorded by Pat Installer · Nov 8, 2026, 2:35 AM
ok - a failed item shows who raised the issue and when: Issue raised by Pat Installer · Nov 8, 2026, 2:35 AM
ok - the audit shows who started and who submitted it, with times
ok - the server stored who and when for the result and for the issue
ok - photos themselves carry no timestamp text
== NETWORK OFF: revise the submitted audit, mark up a photo, correct the critical item, resubmit
ok - revise needs a reason (button disabled until one is typed)
ok - offline: version 2 created and is the current version
ok - the reason for the revision is shown
ok - results and who/when carry over into the revision
ok - the revision is an editable draft again
ok - version 1 is read-only (the saved record)
ok - version 1 keeps its own NOT READY result
ok - offline: a photo already cleaned up after upload explains that it needs a connection to mark up
ok - save is disabled until something is drawn
ok - pen, highlighter and text marks drawn; save enabled
ok - offline: a marked-up COPY is saved next to the originals
ok - the saved marks reopen for editing (marks are stored as editable data, not just pixels)
ok - correcting the item clears the issue; the earlier photo still satisfied the photo rule
ok - the correction records who and when
ok - revision 2 submitted: the critical item is fixed, but the wall length still in the REVIEW zone needs a manager's decision
ok - offline: 9 changes waiting (revise, new photo x3, marked-up copy x3, the correction, submit)
== back online: everything for version 2 syncs
ok - the revise operation was applied exactly once
ok - the server stored the marks as editable data: pen, highlighter and text
ok - the copy belongs to version 2 and links to its original; there are 2 original photos
ok - all 3 photos uploaded, sizes match, and confirmed
ok - version 2 on the server: PASS, issue cleared, recorded by Pat Installer
ok - version 1 on the server is unchanged (still FAIL)
ok - the server's own readiness for version 2 (Manager review required) is shown
ok - version 1 still shows the server's NOT READY
ok - after upload the images leave the phone but the editable marks stay
== online: an old photo that left the phone is downloaded so its marks can be edited
ok - the original was downloaded from storage to edit it
E2E PASSED: 74 checks
```

## Bugs found by these tests and fixed
1. Fresh installs created the `photos` store twice during the device-database upgrade (surfaced as an unhandled ConstraintError behind a passing test). Fixed; the upgrade test now also proves that a v2 device keeps its audits, items, photos (with blobs) and the whole outbox.
2. The photo strip showed photos in database-id order (effectively random). Now sorted by capture time. Found because the e2e clicked "the second photo" and got the older one.
3. A mock-server edit duplicated helper blocks (test infrastructure only) and one e2e expectation was wrong (revision 2 is "Manager review required" because the wall length still in the REVIEW zone carries over — the app was right).

## Design decisions
- Annotated copy = its own `photos` row (`annotated_from` -> original, `annotations` jsonb of normalized 0..1 shapes). The original is never modified; editing marks creates a NEW copy; copies cannot be annotated; copies are not extra evidence. Allowed shapes: pen, highlight, text (validated in the app and by a database CHECK).
- No timestamp or user is drawn on photos (owner choice). Who/when lives on the item (`result_by/result_at`, `issue_raised_by/at`) and on the audit (started/submitted by, revision reason).
- Times are the device time when the installer acted, not the sync time (the audit log keeps the server time). Clock skew on a phone would show in these.
- An "issue" is a FAIL or REVIEW. The first person to raise it (and when) is kept while it stays an issue; a PASS clears it; raising it again records a new raiser/time.
- Revise is a queued operation (`audit` entity, action `revise`, entityId `<audit>:<newVersion>`): version n+1 copies results and who/when; version n stays untouched; earlier photos still count as evidence; two people revising the same version offline conflict instead of overwriting. Any earlier release/override does not carry over.
- Photo images stay on the phone until the photo is confirmed AND its version is submitted (so fresh photos can be marked up offline). After that only the preview and the editable marks stay; re-marking downloads the original when online.
- Device database upgraded to v3 (version-aware audits/items/photos) in place, preserving unsynced work.

## Known gaps / not verified
- **Until migration 1100 is applied to the live project, Revise and annotated copies will be rejected by the server** (the app keeps working and shows them as "need attention"); who/when displays fall back gracefully (basic columns) and ordinary photos/results are unaffected.
- Real devices: touch drawing on iOS/Android (pointer events + `touch-action: none`) is untested; no pinch-zoom inside the editor, so fine marks on a small screen are less precise. No eraser beyond Undo/Clear; 3 pen widths, 3 text sizes, 5 colors.
- Real Storage download of an original (used when the image already left the phone) is verified against the mock only.
- No conflict-resolution screen yet: a conflicting revise or result shows in the sync queue as "needs attention".
- Manager release/override screens and the dashboard are still not built.

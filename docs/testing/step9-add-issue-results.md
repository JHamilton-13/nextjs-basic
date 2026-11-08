# Step 9 results: Add Issue screens (2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-add-issue-design.md` (approved, with the Open | Completed amendment), plan `docs/superpowers/plans/2026-11-08-add-issue-plan.md`.
Built with the database as applied: migrations 1400 (issues, issue photos) and 1600 (trades, void, rules). Nothing in this step touches the database.

## What was built
- Domain rules (`packages/domain/src/issues.ts`): kinds per category, Save blockers (kind, trade for Pre-Install, title, damaged part needs a photo), who may change an issue (raiser or manager), completing a damaged part needs a photo.
- Device data layer (`apps/field/src/lib/issues.ts`, device database v5 with `trades`, `issues`, a photo-by-issue index): create (issue + photos + queued operations in ONE transaction; photos processed first), edit, complete, reopen, void, base versions chained offline, reconcile with the server without overwriting queued changes.
- Photos on issues (`photos.ts`, `transport.ts`): add a photo, marked-up copy (original never changed), heavy images dropped after the server confirms, previews of other people's photos fetched on demand; the sender uses `issue_photos`, bucket `issue-photos`, `confirm_issue_photo`.
- Sync (`sync.ts`): trades, issues with who/when, issue photo rows, my own role (to hide buttons). The checklist now waits only for checklist operations (a slow photo no longer delays it).
- Screens: Add issue sheet (category, kind, trade pills, title, description, Take a photo / Choose from photos, Save disabled with the reason); per-room Issues section (five per-kind count chips, Open | Completed switch, grouped by category); issue card (who/when, photos with Mark up, Complete with note, Edit, Reopen, Void with confirm, "waiting to sync" and "needs attention" with the reason in plain words). The audit photo strip moved to a shared component; the audit screens behave as before.

## Tests run (real output)
```
npm run test -w @phc/domain                    Test Files 7 passed, Tests 157 passed     (was 142; +15 issue rules)
npm run test -w @phc/field                     Test Files 9 passed, Tests 119 passed     (was 92; +27: issue data layer, issue photos, v5 upgrade)
tsc --noEmit (field), domain typecheck         clean
bash supabase/tests/run.sh                     PASSED: 456 assertions + concurrency checks   (unchanged; no database change)
node e2e/phone.e2e.cjs  (iPhone SE/13, Pixel 7) PHONE CHECKS PASSED: 297 checks          (was 180; 99 per device)
node e2e/offline.e2e.cjs                       E2E PASSED: 80 checks                      (was 74; +6 offline issue checks)
node e2e/installer-view.e2e.cjs (real build)   INSTALLER VIEW CHECKS PASSED: 10 checks   (was 7)
```
Mutation check (rule deliberately broken, tests must fail, then restored): anyone may change any issue -> 2 domain tests failed; Damaged part saves without a photo -> 2 failed; permission check removed from the device layer -> 2 failed.

Phone suite coverage per device: another installer's issue visible with a downloaded photo preview and no change buttons; Damaged part blocked without a photo then saved with a real 12-megapixel photo and uploaded; Touch-up with a single automatic kind; Pre-Install with the network OFF (trade list from the phone, deactivated trade not offered, Save blocked without a trade), kept across a reload, synced afterwards; per-kind counts; pen markup on an issue photo saved as a separate copy; complete / Completed view (who, when, note) / reopen; edit (title and trade); void (gone from both lists); a manager sees the change buttons on someone else's issue; 44 px targets, no sideways scroll, 16 px text on the sheet and the issue list.

## Failures found while testing and how they were resolved
- Picking a photo in the Add Issue sheet did nothing. The file list was read after the input had been reset (empty by then). A real bug that would have hit a phone. Fixed: the files are copied immediately. Caught by the phone suite.
- Issue titles showed red: my card class `issue` clashed with an older audit style of the same name. Renamed to `issue-card`. Found by looking at the screenshot.
- Older checks that read "the first photo" or "all photos" in the phone's database picked up issue photos too (a dropped image, a wrong count). Scoped them to audit photos; the mock server's audit storage listing no longer includes issue photos. These were test problems, not app problems.
- A selector in the new offline block matched two "Projects" buttons; made it exact.

## Not done / not tested
- Real iPhone and Android hardware (same caveats as step 6). The new real-phone script is appended to `docs/testing/phone-trial.md`.
- Real Supabase Storage behaviour for issue photos is verified only against the mock; the database rules were verified by the database tests and by SQL on the live project when migrations 1400 and 1600 were applied.
- Marking up a photo is available on the issue card after the issue is saved, not inside the Add Issue sheet (the photo is not stored until the issue is saved). The spec listed Mark up in the sheet; this is a small deviation.
- A server refusal ("needs attention" with the reason) is covered by unit tests and the plain-words mapping, but no end-to-end test forces a refusal.
- Part requests, the manager screens (builder contact, trade list editing), the report PDF and sending are later steps.

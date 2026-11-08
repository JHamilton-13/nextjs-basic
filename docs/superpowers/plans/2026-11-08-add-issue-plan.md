# Add Issue screens: implementation plan

Spec: `docs/superpowers/specs/2026-11-08-add-issue-design.md` (approved). Branch `claude/foundation-audit-spec` only. No new app or dependency.
Rules: TDD (failing test first, then code), the audit, checklist and markup suites must stay green, test data only (the trial project), nothing applied to the database in this plan (migrations 1400 and 1600 are already live).

## Task 1: domain issue rules (`packages/domain/src/issues.ts`, `packages/domain/test/issues.test.ts`)
- `ISSUE_KINDS_BY_CATEGORY`; `issueSaveBlockers({kind, tradeId, title, photoCount}): string[]` (choose a kind; add a trade for Pre-Install; add a title; a damaged part needs a photo); `canChangeIssue({role, isAdmin, isRaiser}): boolean` (raiser who holds a field role, or any manager); `canCompleteIssue(kind, originalPhotoCount)`.
- Tests: every blocker alone and combined; blank/whitespace title; damaged vs missing; manager vs raiser vs other installer vs warehouse/client; admin flag.

## Task 2: device data layer (`apps/field/src/lib/types.ts`, `db.ts`, `issues.ts`, `trades.ts`; tests `apps/field/test/issues.test.ts`, `db-upgrade.test.ts`)
- Device database v5: stores `trades`, `issues` (index by_room); `photos` gains optional `issueId` and an index `by_issue`; `meta` keeps my roles. v4 data survives the upgrade.
- `createIssue` (issue, its photos and all queued operations in ONE transaction; photos compressed first so a failure leaves nothing half-saved), `updateIssue`, `completeIssue`, `reopenIssue`, `voidIssue`; base versions chain across offline edits; who/when recorded; the Save rules come from Task 1.
- Tests: each operation's payload and base version, offline chaining, save blockers refuse and queue nothing, trades mirror and inactive trades, v4 to v5 upgrade, raiser/manager permission.

## Task 3: photos and sync (`lib/photos.ts`, `lib/transport.ts`, `lib/sync.ts`; tests in `test/issues.test.ts`)
- `addIssuePhoto`, `addAnnotatedIssuePhoto` (same compression, 10 MB limit, register / upload / confirm steps, group = room id so an issue is created before its photos). The sender uses `issue_photos`, bucket `issue-photos`, `confirm_issue_photo` when the photo has an issue.
- Sync pulls trades, issues (with who and when), issue photo rows, my own role (and admin flag); reconciles per issue when none of its operations is still queued; `pullRoomChecks` waits only for checklist operations (so a slow photo upload no longer delays the checklist).
- Heavy images are dropped after the server confirms an issue photo; the preview stays. Other people's photos get a preview downloaded on demand when online.
- Tests: right table, bucket and confirm call per kind of photo; reconcile keeps queued local changes; finalize keeps previews.

## Task 4: mock server (`apps/field/e2e/mock-server.ts`)
- Trades, issues, issue photos, `issue-photos` storage, `confirm_issue_photo`, my role (switchable through the control endpoint), one seeded issue raised by another person. Same rules as the database (trade, void, damaged part photo, raiser-or-manager).

## Task 5: screens (`ui/PhotoStrip.tsx` extracted from `AuditView`, `ui/IssueSection.tsx`, `ui/AddIssueSheet.tsx`, wired into `RoomCard`; `Queue.tsx` labels; `styles.css`)
- Per spec section 3. Open | Completed toggle; per-kind count chips; category headings; Add issue sheet (category, kind, trade pills, title, description, photos, Save disabled with the reason); Edit, Complete (note), Reopen, Void (confirm). Buttons only where `canChangeIssue`. "Waiting to sync" and "needs attention" markers.
- `AnnotateModal` saves to the right kind of photo (issue or audit). Audit screens behave exactly as before.

## Task 4b: emulated-phone and offline tests (`e2e/phone.e2e.cjs`, `e2e/offline.e2e.cjs`, `e2e/installer-view.e2e.cjs`)
- iPhone SE / iPhone 13 / Pixel 7: one issue per category; trade picker with the network off; Damaged part blocked without a photo, saved with one; photo, markup and eraser on an issue; complete, reopen, void; counts and the toggle; offline create + reload + sync; another installer's issue visible but read-only; a manager sees the buttons; 44 px targets.
- Real default build: the issue screens appear and no audit wording does.
- Record results in `docs/testing/step9-add-issue-results.md`; append a real-phone script to `docs/testing/phone-trial.md`; update `docs/MILESTONES.md`.

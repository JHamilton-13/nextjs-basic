# Milestones — Foundation + Pre-Install Site Audit

Last updated: 2026-11-08

## Completed
- **Step 0 — environment audit** (approved 2026-11-08).
- **Step 1 — monorepo + domain package** (approved 2026-11-08). 122 Vitest tests, strict typecheck clean. Owner decisions applied the same day: only managers release; no required-result gating on submit; 0 items can be submitted. See `docs/testing/step1-domain-results.md`.
- **Step 2 — database (approved and APPLIED to Supabase project `zuyzxkkmsyuybbznelql` on 2026-11-08).** 9 migrations in `supabase/migrations/`, example seed in `supabase/seed.sql` (NOT applied), tests in `supabase/tests/`: 235 assertions + 2 real-concurrency checks on local Postgres 16; remote structure, advisors and function behaviour verified read-only. No data has been written to the real project. See `docs/DATABASE_SCHEMA.md` and `docs/testing/step2-database-results.md`.

## In progress
- Step 3 vertical slice built and tested 2026-11-08 (AWAITING OWNER REVIEW and a first real-device/real-sign-in trial). Sign-in gate, first invite and first admin are DONE and verified live (see `docs/testing/step2-database-results.md`).

## Owner dashboard setup (DONE 2026-11-08: hook enabled, Google + Email on, anonymous off). Original checklist:
1. Authentication > Hooks: enable **Before User Created** -> `public.hook_before_user_created`. UNTIL THIS IS ON, anyone can create an auth account if a sign-in provider is enabled (they still see no data, because RLS requires an active invite, but do not leave it off).
2. Authentication > Providers: enable Google (create the OAuth client in Google Cloud; secrets go in Supabase only) and Email OTP; turn OFF anonymous sign-ins.
3. Tell me the exact Google email you will sign in with so I can create your invite and, after your first sign-in, set `is_admin`.

## Completed (Step 3)
- `apps/field` installable PWA: sign-in UI (Google + email code), offline cache of projects/rooms/templates, start audit offline, tolerance measurement with live PASS/REVIEW/FAIL, durable ordered outbox with backoff and recovery, server-confirmed sync, sync/queue screen. 23 unit tests + 23-check offline Playwright run, typecheck clean. See `docs/testing/step3-pwa-results.md` and `apps/field/README.md`.

## Completed (Step 4, 2026-11-08: finish the installer audit — AWAITING OWNER REVIEW)
- Photos (capture, compress, durable queue with register/upload/confirm), check/observation/MEP item entry with server-mirrored evidence rules, critical-fail banner, submit with warnings (no gating, per owner), read-only after submit, server-confirmed readiness, separate upload lane. 45 field unit tests + 43-check offline Playwright run. Migration 1000 (`confirm_photo` size check) written/tested locally, **NOT applied**. See `docs/testing/step4-complete-audit-results.md`.

## Completed (Step 5, 2026-11-08: revise, annotation, who/when — AWAITING OWNER REVIEW; migration 1100 NOT applied)
- Offline revise (version n+1, results and who/when carried over, earlier version read-only), version tabs, photo mark-up editor (pen, highlighter, text; editable vector marks; flattened annotated COPY; original untouched), who/when on every result, issue and the audit (none on photos), device-database upgrade v3. 77 field unit tests + 74-check offline Playwright run + 276 DB assertions. See `docs/testing/step5-revise-annotate-results.md`.

## Phone-trial follow-ups (2026-11-08)
- DONE: erase tool in photo markup (drag removes a whole mark; undo covers erase and clear). Emulated phones 117 checks, offline e2e 74, unit 81.
- DONE: migration 1200 room details applied live and verified (DB tests 291). Sources: Cockpit, master file, Warehouse Tracker (mock contract only); PHC-only notes are never stored.
- DONE: migration 1300 per-room checklist applied live and verified (DB tests 313). 11 pills; Done / Not done (note required) / N/A; untick; who and on-site time recorded.
- Owner decisions 2026-11-08: installer app owns issues and part requests; client signs on the phone/tablet; installers see rooms + details (no audit screens); issue kinds Pre Install Correction / Punch Item / Touch Up plus Missing part and Damaged part; part requests start pre-filled from room details; PHC-only notes hidden.
- DONE (Step 7): installer rooms + details + 11-pill checklist built; audit screens hidden from installers (kept behind VITE_SHOW_AUDIT). Results in docs/testing/step7-rooms-checklist-results.md. Tests: unit 92, domain 122, DB 313, phone 180, offline 74, installer-build 7.
- DONE: migration 1400 room issues + issue photos applied live and verified (DB tests 380). Advisor found `confirm_issue_photo` executable by anon (no data exposed); fixed by migration 1500, APPLIED and verified (anon can no longer execute it). Add Issue screens NOT built yet. Handoff written: docs/HANDOFF.md.
- Step 1 (prompt 02) DONE: domain rules for issue categories, builder audit summary, room status, email check (commit 4f373e6; domain tests 142).
- Step 2 (prompt 02) DONE, APPLIED to the live project 2026-11-08 after owner approval and verified (see docs/DATABASE_SCHEMA.md): migration 1600 (trades, trade rule, void, who may change an issue, Damaged-part photo rule, builder contact on projects) + DB tests (456 assertions). Reports tables come in a later migration. Details: docs/testing/step8-issue-categories-results.md.
- Owner decisions 2026-11-08 (prompt 02): no new app or project (manager screens inside apps/field; one server function in the existing Vercel project for report build/send); split the migration; drop email_outbox for reports; marked-up photo in the PDF; void by raiser or manager; Damaged part needs a photo to complete; sending via the existing Vercel project.
- Step 3 (prompt 02) BUILT: Add Issue screens (category, kind, trade, title, description, photos with markup; per-room issue lists with five per-kind counts and an Open | Completed switch; edit, complete, reopen, void; works offline). Spec approved with the Open/Completed amendment; plan: docs/superpowers/plans/2026-11-08-add-issue-plan.md; results: docs/testing/step9-add-issue-results.md. Real-phone script appended to docs/testing/phone-trial.md.
- FIX 2026-11-08 (phone trial): could not sign in or out. Sign out ended every device's session and left the saved identity, so the sign-in screen never returned. Now: local-only sign out that always works, a warning when changes are unsent, and a real 'Sign in again to sync' button. See docs/testing/step9-add-issue-results.md.
- NEXT (owner-approved direction): Cockpit-style look (PHC palette), Projects list + project summary like Site Audit, read-only room detail cards. Part-request editing of details is a later step.

## Completed (Step 6, 2026-11-08: phone readiness — AWAITING the real-phone trial)
- Emulated phone checks (iPhone SE/13, Pixel 7): layout, 44 px tap targets, touch drawing, 12 MP photo with rotation flag, offline reload, Wi-Fi-without-internet. Fixed an unusable annotation editor on small phones, tap sizes, a visible hidden file input, request deadlines, library retry storms, offline badge accuracy; added persistent-storage request + storage readout + install help. 105 phone checks; main run 74. See `docs/testing/step6-phone-readiness-results.md` and the trial kit `docs/testing/phone-trial.md`.

## Not started
- `packages/integration-contract` is a bare `package.json` stub. `apps/web` is still the unmodified Next.js starter (relocated); the manager dashboard is not built.
- PWA: in-app notifications inbox, conflict resolution screen, more annotation tools (arrow/shapes/eraser/zoom), real-device trial. Manager release/override screens and dashboard (apps/web).
- Enabling the auth hook, Google/email OTP setup, first-admin bootstrap (steps in `supabase/README.md`); inserting the company's real audit template.

## Blockers
- No Docker daemon in this container: tests use plain Postgres 16 with Supabase stand-ins (auth/storage schemas, roles). Supabase-specific wiring (Before User Created hook, real storage policies, PostgREST column grants) is verified only after the migrations are applied to the real project.
- Google OAuth client not yet created (owner task, spec §13).

## Owner decisions on Step 2 (answered 2026-11-08)
1 invite/project/template rights: admins + production/project managers (confirmed). 2 never-entered critical items: NOT routed to review (declined). 3 first admin: the owner. 5 clients/GCs: no in-app access; PDF by email. 4 evidence rules: see item 4 below (explained to owner; example defaults kept). Remaining open: item 4 confirmation, which email to invite.

## Original Step 2 questions
1. **Who maintains the invite list and creates projects/templates?** Implemented: admins plus anyone who is a production manager or project manager on at least one project. Spec only says "suggest admin/PM".
2. **Consequence of decision 4 (submit needs no results):** a submitted audit with nothing entered, or with a critical MEP item never entered, is derived as **Ready** and a manager can release it with no override. Only an entered critical FAIL blocks. If you want never-entered critical items to count (e.g. route to Manager Review Required), say so; it is a small change in `audit_state()` and the domain `auditState()`.
3. **Admin bootstrap:** first admin is created by inserting the owner's email into `invites` and flipping `profiles.is_admin` in the SQL editor (never in the repo). Confirm that is acceptable.
4. **Evidence rules enforced at write time:** `requires.note/drawingRef/photo` block a result being recorded (photo = a registered photo row for that item). In the example template, wall length and ceiling height require a drawing reference; MEP items require 1 photo. Company template to be supplied.
5. **Authorized evidence exceptions and supervisor approval** exist in the domain package but are NOT implemented in the database; items that require supervisor approval are rejected until the workflow is built. Confirm they can wait for a later step.
6. **Clients/GC visibility (decided 2026-11-08):** no in-app access; they receive a PDF by email (report emailing is a later step; `app.can_see_audit` is the single place to open specific audits to them later).
7. Which email addresses to invite first, and the company's real template content/tolerances (example template is clearly labeled).

## Step 10: report documents (sample PDFs ready for review)
`packages/reports` builds the Builder Site Audit and Room Status PDFs from fake data; 30 tests pass. Samples: `docs/testing/images/builder-audit-sample.pdf` and PNGs. Awaiting owner comparison with the Fulton layout before report building and sending (Step 5). See `docs/testing/step10-report-documents-results.md`.

## Technical debt / notes
- Decimal-inch and mm inputs round to nearest 1/64"; fraction denominators limited to 2..64 (powers of two).
- Concurrency tested for `apply_op` only; no load testing; no tests of `service_role` paths.
- `npm audit` reports advisories in the Next.js 14.2.5 starter tree; not addressed.
- Notifications are rows + queued email records only; no sender exists yet.
- Supabase performance advisor items (empty DB now): add indexes on FK columns, wrap `auth.uid()` as `(select auth.uid())` in policies, merge the two `rooms` SELECT policies.
- PWA debt: no a11y audit; token-expiry-offline path untested; no background sync on iOS (drains on foreground); iOS storage limits unverified.
- PR #1 carries spec, domain package and database work together (owner chose not to split).

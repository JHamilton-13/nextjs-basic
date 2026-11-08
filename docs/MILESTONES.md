# Milestones — Foundation + Pre-Install Site Audit

Last updated: 2026-11-08

## Completed
- **Step 0 — environment audit** (approved 2026-11-08).
- **Step 1 — monorepo + domain package** (approved 2026-11-08). 122 Vitest tests, strict typecheck clean. Owner decisions applied the same day: only managers release; no required-result gating on submit; 0 items can be submitted. See `docs/testing/step1-domain-results.md`.
- **Step 2 — database migrations, files only (written and tested; AWAITING OWNER REVIEW of the SQL).** 8 migrations in `supabase/migrations/`, example seed in `supabase/seed.sql`, tests in `supabase/tests/`: 234 assertions + 2 real-concurrency checks passing on local Postgres 16. NOTHING has been applied to Supabase project `zuyzxkkmsyuybbznelql`. See `docs/DATABASE_SCHEMA.md` and `docs/testing/step2-database-results.md`.

## In progress
- Owner review of the Step 2 SQL. Step 3 (PWA scaffold) does not start until Step 2 is reviewed.

## Not started
- Step 3: `apps/field` PWA scaffold + thin vertical slice; Playwright offline test. `apps/field` and `packages/integration-contract` are bare `package.json` stubs.
- Applying migrations remotely, enabling the auth hook, Google/email OTP setup, first-admin bootstrap (steps listed in `supabase/README.md`).

## Blockers
- No Docker daemon in this container: tests use plain Postgres 16 with Supabase stand-ins (auth/storage schemas, roles). Supabase-specific wiring (Before User Created hook, real storage policies, PostgREST column grants) is verified only after the migrations are applied to the real project.
- Google OAuth client not yet created (owner task, spec §13).

## Decisions needed from owner (Step 2)
1. **Who maintains the invite list and creates projects/templates?** Implemented: admins plus anyone who is a production manager or project manager on at least one project. Spec only says "suggest admin/PM".
2. **Consequence of decision 4 (submit needs no results):** a submitted audit with nothing entered, or with a critical MEP item never entered, is derived as **Ready** and a manager can release it with no override. Only an entered critical FAIL blocks. If you want never-entered critical items to count (e.g. route to Manager Review Required), say so; it is a small change in `audit_state()` and the domain `auditState()`.
3. **Admin bootstrap:** first admin is created by inserting the owner's email into `invites` and flipping `profiles.is_admin` in the SQL editor (never in the repo). Confirm that is acceptable.
4. **Evidence rules enforced at write time:** `requires.note/drawingRef/photo` block a result being recorded (photo = a registered photo row for that item). In the example template, wall length and ceiling height require a drawing reference; MEP items require 1 photo. Company template to be supplied.
5. **Authorized evidence exceptions and supervisor approval** exist in the domain package but are NOT implemented in the database; items that require supervisor approval are rejected until the workflow is built. Confirm they can wait for a later step.
6. **Clients/GC visibility:** they see an audit version only after it is released. Confirm.
7. Which email addresses to invite first, and the company's real template content/tolerances (example template is clearly labeled).

## Technical debt / notes
- Decimal-inch and mm inputs round to nearest 1/64"; fraction denominators limited to 2..64 (powers of two).
- Concurrency tested for `apply_op` only; no load testing; no tests of `service_role` paths.
- `npm audit` reports advisories in the Next.js 14.2.5 starter tree; not addressed.
- Notifications are rows + queued email records only; no sender exists yet.
- PR #1 carries spec, domain package and database work together (owner chose not to split).

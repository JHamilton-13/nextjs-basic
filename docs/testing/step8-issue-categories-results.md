# Step 8 results: issue categories, domain rules (done) and migration 1600 (DRAFT, not applied), 2026-11-08

## Step 1: domain rules (committed `4f373e6`)
`categoryOf`, `requiresTrade`, `builderAuditSummary`, `roomStatus`, `isValidEmail` in `packages/domain/src/reports/`, tests in `packages/domain/test/reports.test.ts`.
```
npm run test -w @phc/domain -- reports      Test Files 1 passed, Tests 20 passed   (written first: 20 failed, functions not defined)
npm run test -w @phc/domain                 Test Files 6 passed, Tests 142 passed  (was 122)
tsc --noEmit (domain, field)                clean
```
Mutation check (code deliberately broken, tests must fail, then restored): void issues counted -> 2 tests failed; empty checklist counted as completed -> 1 failed; newline allowed in an email -> 2 failed.
Decisions in the rules: issues whose room is not in the room list are left out of both counts and lists; an empty checklist definition is never Completed; `isValidEmail` does not trim.

## Step 2: migration 1600 (file only, NOT applied to the remote project)
`supabase/migrations/20261108001600_issue_trades_void_builder.sql`, tests `supabase/tests/10_issue_trades_void_builder.sql`.
```
bash supabase/tests/run.sh                  PASSED: 456 assertions + concurrency checks   (was 380; +76)
```
Mutation check (rule removed from the migration, tests must fail, then restored): anyone may change any issue -> failed ("another installer cannot edit someone else's issue"); Damaged part completes without a photo -> failed; Pre Install Correction accepted without a trade -> failed; voided issue still editable -> failed.

### Failures found while writing the tests and how they were resolved
- The test setup added the project manager (u2) as a member, but the project creator is added automatically: duplicate key. Fixed the setup.
- The audit-log assertion for a project edit found no row by project id: `app.log_change` fills the log's project id only from a `project_id` column, and `projects` uses `id`. The row exists (found by record id). Existing behaviour, not changed here; see Open issues.

### Open issues
- `audit_log.project_id` is null for edits to `projects` rows, so project managers (who read the log by project id) cannot see them; only admins can. Pre-existing; proposed fix in a later migration if you want project edits visible to project managers.
- Void, edit, complete and reopen share one rule (raiser or manager). Edit and reopen were not explicitly decided by the owner; they follow the rule decided for complete and void.

# Step 2 test results — database (local Postgres 16, nothing applied remotely)

Date: 2026-11-08. Command: `bash supabase/tests/run.sh`. Postgres 16.15 (remote project is 17.x; no version-specific
features used). Supabase's `auth`/`storage` schemas and API roles are stood in by `supabase/tests/00_stub.sql`.
Domain package re-run after the owner decisions: 122/122 passing, typecheck clean.

## Result
`PASSED: 234 assertions + concurrency checks` (stable over 3 consecutive runs).

## Bugs found by the tests and fixed (migrations were never applied anywhere)
1. `array || 'literal'` in `op_audit_item` failed with "malformed array literal" -> `array_append`.
2. `apply_op` accepted `createdAt` values such as `'yesterday'` (Postgres special timestamp words) -> now requires explicit ISO 8601 with time zone.
3. Test fixture `new_audit` derived opIds from the clock, so two audits created in the same second collided as duplicates (test-only bug; idempotency worked as designed).
4. Two of my own assertions had wrong expectations (item count 42 not 47; RLS fires before the bucket foreign key). Corrected.
5. The first concurrency test passed even with the lock removed because sessions did not truly overlap -> added an advisory-lock start gate; it now fails when either lock is removed.

## Mutation checks (temporary edits to migrations, reverted; all caught)
REVIEW band exclusive; role check removed from override/release/revise; trusting a client-supplied result; override matching any
version; profiles readable by all; revoked invites still active; audit immutability guard disabled; audit_log update/delete guard
dropped; advisory lock removed (concurrency test); item row lock removed (concurrency test).

## Structural audit (queried from the migrated database)
- Tables in `public` without RLS: none. SECURITY DEFINER functions without a fixed search_path: none. `anon` privileges on `public` tables: 0.
- Functions executable by `authenticated`: apply_op, audit_state, confirm_photo, grant_override, release_audit, revise_audit.
- Table write privileges for `authenticated`: audit_templates INSERT; invites INSERT; photos INSERT; project_members INSERT/DELETE;
  projects INSERT; rooms INSERT/UPDATE/DELETE (plus column-level UPDATEs on profiles.full_name, invites.revoked_at, projects, project_members.role,
  audit_templates.active, notifications.read_at). Audits, items, measurements, overrides, releases, applied_ops, audit_log have NO direct write path.

## Scenario coverage (database level)
3 critical fail; 4 installer cannot proceed; 5/19 manager documented override; 10 evidence enforced server-side; 12 no duplicate
operations; 13 two writers, stale base -> conflict, no overwrite; 14 lost response -> replay returns the recorded outcome;
16 revised audit (v2) does not inherit v1 override/release; 18/20 submitted original preserved, history kept.
Not covered here: 1, 2, 6-9, 11, 15, 17 (need the PWA, Drive, PDFs, signatures).

## Known gaps
- Concurrency is tested for `apply_op` only (two scenarios). Deadlock and long-transaction behaviour are untested.
- Supabase-specific behaviour (Auth hook wiring, real storage.objects policies, PostgREST/column-grant behaviour) is only verified on stand-ins until applied to the real project.
- No test for `service_role` paths. No load/performance test.

## Live sign-in verification (2026-11-08)
Owner enabled the Before User Created hook, Google + Email providers and disabled anonymous sign-ins in the dashboard, invited their email,
signed in once by email code; `is_admin` was then set on that single profile (audit-logged). Tests against the live Auth API (public key, undeliverable addresses):
- Uninvited password sign-up: HTTP 403 "This account has not been invited."
- Uninvited email-code sign-up (`create_user: true`): HTTP 403, same message.
- Anonymous sign-in: HTTP 422 `anonymous_provider_disabled`.
- Auth users afterwards: 1 (the owner); anonymous users: 0; profiles: 1.
- As the owner (simulated JWT subject, rolled back): `is_active`, `is_admin`, `can_manage_invites` all true; sees their invite and the audit log.
Not yet tested: Google sign-in (needs the PWA), invited second user, revoking an invite on a live account.
Environment note: the session's default network policy blocked `*.supabase.co`; a personal environment `nextjs-basic` allowing only `zuyzxkkmsyuybbznelql.supabase.co` was created with the owner's approval.

## Applied to the real project (2026-11-08, after owner approval)
Project `zuyzxkkmsyuybbznelql` ("Project Field Tracking", us-east-2, Postgres 17.x) was empty before (0 tables, 0 migrations).
Applied in order with the Supabase `apply_migration` tool, each returning success: types_and_helpers, identity_and_invites,
projects_members_rooms, templates_and_audits, sync_log_notifications, functions, rls_and_grants, storage, fix_function_search_paths
(migration 0900, added after the advisor flagged 13 helper functions without a pinned search_path; retested locally first, 235 assertions + concurrency).
Before applying, owner decision 5 changed one rule: clients and GCs have NO in-app access (they get a PDF by email). Tests were updated and re-run first.

Checks run against the real project afterwards (read-only):
- 16 tables in `public`, none without RLS; `anon` has 0 table grants and cannot execute any public function; `authenticated` can execute only
  apply_op, audit_state, confirm_photo, grant_override, release_audit, revise_audit.
- `hook_before_user_created`: executable by `supabase_auth_admin` only; returns the 403 error object for an uninvited email and for an empty event.
- `on_auth_user_created` trigger exists on `auth.users`; private bucket `audit-photos` exists with its 2 policies.
- Tolerance function on the real DB at expected 120" (+/-1/2", band 1"): 7615 FAIL, 7616 REVIEW, 7647 REVIEW, 7648 PASS, 7680 PASS, 7712 PASS,
  7713 REVIEW, 7744 REVIEW, 7745 FAIL (matches the local tests and the domain package).
- Template validator accepts a valid config and rejects an empty one.
- Supabase security advisors after migration 0900: only (a) INFO `applied_ops` and `email_outbox` have RLS and no policies (intentional: no API access) and
  (b) WARN x6 "signed-in users can execute SECURITY DEFINER function" for the six RPCs above (intentional: each checks identity and role inside).
- Supabase performance advisors (empty database, so informational): FK columns without covering indexes (20), policies using `auth.uid()` without the
  `(select auth.uid())` wrapper (9), `rooms` has two permissive SELECT policies, 6 indexes unused yet. Logged as technical debt.
- Data written to the real project: none (no users, invites, projects, templates, or audits exist yet). The example `seed.sql` was NOT applied.
- NOT yet verified on the real project: end-to-end sign-in with the hook (needs dashboard steps below), RLS as a real signed-in user, storage uploads.

## Verbatim output
```
== stub
== migration 20261108000100_types_and_helpers.sql
== migration 20261108000200_identity_and_invites.sql
== migration 20261108000300_projects_members_rooms.sql
== migration 20261108000400_templates_and_audits.sql
== migration 20261108000500_sync_log_notifications.sql
== migration 20261108000600_functions.sql
== migration 20261108000700_rls_and_grants.sql
== migration 20261108000800_storage.sql
== seed
== test 01_invites_and_access.sql
ok - hook allows an invited email (case/space-insensitive)
ok - hook rejects an email with no invite (403)
ok - hook rejects an email whose invite was revoked
ok - hook rejects a sign-up with no email
ok - hook rejects an empty event
ok - signed-in users cannot call the hook directly
ok - anon cannot call the hook directly
ok - uninvited account sees no projects
ok - uninvited account sees no profiles (not even its own)
ok - uninvited account sees no templates
ok - revoked-invite member sees no projects
ok - revoked-invite member sees no rooms
ok - revoked-invite member cannot call apply_op
ok - anon has no privileges on projects
ok - an installer cannot add invites
ok - a project manager can add an invite
ok - only one active invite per email
ok - invite emails must be stored lower-case
ok - revoking records who revoked
ok - invite email cannot be edited
ok - invites cannot be deleted
ok - a revoked invite cannot be un-revoked
ok - a revoked email can be re-invited with a new row
ok - installer sees only their project
ok - installer sees rooms of their project
ok - installer sees the members of their own project
ok - installer cannot see another project's members
ok - installer cannot see profiles of people they share no project with
ok - second installer sees only their project
ok - invited user with no membership sees no projects
ok - admin sees all projects
ok - an installer cannot add project members
ok - an installer cannot create projects
ok - a project manager cannot add members to someone else's project
ok - a project manager can add members to their own project
ok - admin is not assignable as a project role
ok - nobody can promote themselves to admin through the API
ok - a project manager can create a project
ok - creator becomes project manager of the new project
ok - email_outbox is not readable through the API
ok - applied_ops is not readable through the API
ok - users cannot write the audit log
== test 02_apply_op.sql
ok - exact match is PASS
ok - exactly +1/2" is PASS
ok - exactly -1/2" is PASS
ok - 1/64" over +1/2" is REVIEW
ok - 1/64" under -1/2" is REVIEW
ok - exactly +1" is REVIEW
ok - exactly -1" is REVIEW
ok - 1/64" over +1" is FAIL
ok - 1/64" under -1" is FAIL
ok - no review band: over tolerance is FAIL
ok - create audit is applied
ok - one audit row exists
ok - items were created from the template (42)
ok - exactly the 8 MEP items are critical
ok - first measurement is applied
ok - replaying the same opId returns duplicate with the original outcome
ok - the replay did not create a second measurement
ok - exactly one applied_ops row for the op
ok - item result computed by the server (PASS at +1/2")
ok - deviation recorded
ok - measurement records the user
ok - tolerance recorded from template rule data
ok - stale baseVersion returns conflict
ok - the conflicting write changed nothing
ok - retrying a conflicted opId returns the same conflict
ok - fresh baseVersion applies
ok - client-claimed PASS is ignored; server computes FAIL (+110/64")
ok - earlier measurement is kept (history)
ok - tolerance item without drawing reference is rejected
ok - rejected ops are not recorded
ok - the same opId succeeds once the evidence is supplied
ok - MEP item without a photo is rejected
ok - MEP item with a registered photo is applied
ok - an invalid result value is rejected
ok - observation items record OBSERVED with no pass/fail
ok - unknown item is rejected
ok - negative measurement is rejected
ok - non-integer measurement is rejected
ok - bad opId rejected
ok - negative baseVersion rejected
ok - array payload rejected
ok - bad createdAt rejected
ok - actor must equal the authenticated user
ok - unsupported entity rejected
ok - non-object op rejected
ok - invalid envelopes are never recorded
ok - a member of another project cannot write to this audit
ok - a general contractor cannot record audit results
ok - warehouse cannot record audit results
ok - another user cannot reuse someone else's opId
ok - cannot create an audit on a project you are not on
ok - submit is applied
ok - submitting again with a stale base is a conflict
ok - submitting an already-submitted audit is rejected
ok - results cannot be recorded after submit
== test 03_immutability_and_constraints.sql
ok - audit identity columns cannot change while a draft
ok - an item's critical flag cannot be changed
ok - audit items cannot be deleted even in a draft
ok - audit submitted for immutability tests
ok - a submitted audit cannot be updated
ok - audits cannot be deleted
ok - items of a submitted audit cannot be updated
ok - items of a submitted audit cannot be deleted
ok - items cannot be added to a submitted audit
ok - measurements cannot be updated
ok - measurements cannot be deleted
ok - audit_log cannot be updated
ok - audit_log cannot be deleted
ok - audit_log cannot be truncated
ok - a published template version cannot be edited
ok - a template version number cannot change
ok - templates cannot be deleted
ok - a template can be deactivated and reactivated
ok - template without policy is rejected
ok - unknown policy value is rejected
ok - duplicate item keys are rejected
ok - a critical observation item is rejected
ok - a review band smaller than the tolerance is rejected
ok - unknown evidence requirement is rejected
ok - a tolerance item without rule data is rejected
ok - a minimal valid template is accepted
ok - a measurement whose result disagrees with the tolerance rule is rejected
ok - a measurement with a wrong deviation is rejected
ok - a revision without a reason is rejected
ok - a photo's storage path cannot change
ok - photos cannot be deleted
ok - a photo can be confirmed once
ok - a confirmed photo cannot change again
ok - a malformed checksum is rejected
ok - a photo cannot claim a different project than its audit
== test 04_stop_gate_and_release.sql
ok - installer records a critical MEP FAIL
ok - a critical FAIL makes the audit NOT READY immediately
ok - two managers were notified
ok - the project manager and installation manager were notified (not installer, GC, client, warehouse)
ok - notifications are critical critical_fail
ok - queued email records were created (no live send)
ok - emails address the managers
ok - FAIL -> FAIL does not send duplicate notifications
ok - release before the audit is submitted is refused
ok - installer submits the failed audit (inspection completed)
ok - completed inspection is still NOT READY: completed is not authorized
ok - installer cannot release a failed audit
ok - installer cannot grant an override
ok - general contractor cannot release
ok - warehouse cannot grant an override
ok - a manager of another project cannot grant an override
ok - general contractor cannot see an unreleased audit
ok - client cannot see unreleased items or readiness
ok - warehouse (project member) can see the audit
ok - manager release without override is refused and lists the failed items
ok - override needs a non-blank reason
ok - override needs a reason (null)
ok - override must reference an existing audit version
ok - override records approver, resolved role, audit version, reason and documents
ok - granting an override does not change the audit result
ok - granting an override does not release
ok - overrides are immutable
ok - overrides cannot be deleted
ok - after an override an installer still cannot release
ok - release records basis=override with the override and releaser
ok - state is released_for_installation
ok - cannot release twice
ok - no override after release
ok - releases are immutable
ok - releases cannot be deleted
ok - after release the general contractor can see the audit
ok - client sees released readiness
ok - revision needs a reason
ok - installer can revise a submitted audit; version 2 is created
ok - an unsubmitted latest version cannot be revised again
ok - version 2 has all items
ok - item results carry over for correction
ok - measurement history stays with version 1
ok - version 1 keeps its released history
ok - version 2 is a fresh NOT READY audit
ok - no release exists for version 2
ok - version 2 can be submitted
ok - the version 1 override does not authorize version 2
ok - an override cannot target a superseded version
ok - a superseded version cannot be released again
ok - both overrides and both releases are kept as history
ok - client sees the latest released version
ok - a clean submitted audit is ready
ok - no override on a ready audit
ok - installer cannot release even a ready audit (managers only)
ok - clean release records basis=clear
ok - an audit with no results entered can be submitted
ok - a submitted audit with nothing entered is derived as ready (owner decision 2026-11-08)
ok - admin can release; role recorded as admin
ok - non-critical FAIL -> manager_review_required (policy)
ok - a non-critical FAIL sends no stop-gate notification
ok - manager-review audit needs an override to release
ok - +50/64" on wall length is REVIEW
ok - critical REVIEW -> manager_review_required (not a block)
ok - critical REVIEW does not raise the stop-gate alert
ok - template policy ready_with_exceptions is honoured
== test 05_audit_log_photos_storage.sql
ok - audit creation is logged
ok - submission is logged with the submitter
ok - item result change is logged (new value)
ok - item result change is logged (old value)
ok - override is logged with the approving user as actor
ok - override reason is in the log
ok - release is logged with the releaser
ok - item changes carry the project id for access control
ok - invite changes are logged
ok - membership changes are logged
ok - an installer cannot read the audit log
ok - a project manager reads only their project's log entries
ok - another project's manager cannot read this project's log
ok - admin can read the log
ok - an installer can register a photo
ok - registering the same photo id twice is rejected (safe to retry)
ok - a photo cannot be registered in someone else's name
ok - a photo cannot be registered pre-confirmed
ok - a member of another project cannot register photos
ok - a general contractor cannot register photos
ok - users cannot confirm photos by updating the table
ok - a photo cannot be confirmed before its file is uploaded
ok - uploading to an unregistered path is refused
ok - uploading into any other bucket is refused
ok - another user cannot upload to someone else's registered path
ok - anon cannot upload
ok - the capturer can upload to the registered path
ok - photo confirmed once the file exists (and confirming again is harmless)
ok - a general contractor cannot confirm photos
ok - a general contractor cannot see photos or files of an unreleased audit
ok - the installer can read the file
ok - a warehouse member of the project can read the file
ok - a member of another project cannot read the file
ok - uploaded evidence cannot be deleted by users
ok - uploaded evidence cannot be replaced by users
ok - a photo captured offline can still be registered after the audit is submitted
== concurrency (real parallel sessions)
same opId x10: applied=1 duplicate=9 measurements=1 applied_ops=1
different opIds, same base x10: applied=1 conflict=9 measurements=1
ok - concurrency: replay of one opId applies once; stale-base writers conflict (2 scenarios)
PASSED: 234 assertions + concurrency checks
```

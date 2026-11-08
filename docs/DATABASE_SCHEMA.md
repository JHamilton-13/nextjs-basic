# Database schema (Supabase Postgres) — Foundation + Pre-Install Audit

Source of truth: `supabase/migrations/*.sql`. Tests: `supabase/tests/` (see `docs/testing/step2-database-results.md`).
Migration 1000 (`confirm_photo` size check) is APPLIED (2026-11-08). Migration 1100 (annotations on photos, who/when on audit items, offline revise as an `apply_op` action, evidence across versions) is written and tested locally but NOT yet applied.
Status: applied to Supabase project `zuyzxkkmsyuybbznelql` on 2026-11-08 (migrations 0100-0900); tested on local Postgres 16 and verified read-only on the real project.

| Table | Purpose | Written by |
|---|---|---|
| `profiles` | one per auth user; `is_admin` flag; email lower-cased | auth trigger |
| `invites` | sign-in allow list (revoke only; never edited/deleted) | managers/admin |
| `projects`, `project_members`, `rooms` | projects; per-project roles live in `project_members` | managers |
| `audit_templates` | versioned, immutable template configs (see `docs/architecture/audit-template-config.md`) | managers |
| `audits` | one row per audit VERSION `(audit_id, version)`; immutable once submitted | `apply_op`, `revise_audit` |
| `audit_items` | per-version item rows copied from the template; `row_version` for optimistic locking | `apply_op` |
| `measurements` | insert-only history; result CHECK-constrained to equal the tolerance rule's verdict | `apply_op` |
| `photos` | metadata + sha256; insert once, confirm once; file in private bucket `audit-photos` | field users, `confirm_photo` |
| `overrides` | insert-only; tied to one audit version; approver role resolved server-side | `grant_override` |
| `releases` | insert-only; one per audit version; basis `clear` or `override` | `release_audit` |
| `applied_ops` | idempotency ledger (opId -> first outcome); no API access | `apply_op` |
| `audit_log` | append-only change log (insert/update/delete triggers on all tables above) | triggers |
| `notifications`, `email_outbox` | critical-fail alerts to PM/production/installation managers; emails only QUEUED | `apply_op` |

Clients and general contractors have no in-app access to audits (they receive PDFs by email); see `app.can_see_audit`.

Functions (RPC, `authenticated` only): `apply_op(jsonb)`, `grant_override`, `release_audit`, `revise_audit`, `confirm_photo`,
`audit_state`. Sign-in gate: `hook_before_user_created(jsonb)` (auth service only). View: `project_readiness` (security invoker).

Entity ids for `apply_op`: `audit` -> `<audit_id>:<version>` (actions `create` for v1, `submit`);
`audit_item` -> `<audit_id>:<version>:<item_key>`.

Not implemented yet: evidence exceptions in the database (domain has them), supervisor-approval workflow, scheduled/background
notification delivery, per-project template selection rules, photo count/size limits.

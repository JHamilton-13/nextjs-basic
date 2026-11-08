# Milestones — Foundation + Pre-Install Site Audit

Last updated: 2026-11-08

## Completed
- **Step 0 — environment audit** (approved 2026-11-08).
- **Step 1 — monorepo + domain package.** npm workspaces (`apps/web`, `apps/field`, `packages/domain`, `packages/integration-contract`, `supabase/migrations`). `packages/domain`: units (1/64" canonical, parse/format fractions, decimal, mm, feet-inches, moisture), tolerance engine (PASS/REVIEW/FAIL from rule data, measurement record), evidence rules, readiness state machine with override/release/revise, sync primitives (envelope, idempotent apply model, client status transitions, backoff). 114 tests green, typecheck clean. See `docs/testing/step1-domain-results.md`.
- Next.js starter relocated to `apps/web` (lint + build verified). No product UI added.

## In progress
- Awaiting review of Step 1 before Step 2 (database migrations, files only).

## Not started
- Step 2: Supabase migrations + local Postgres tests (nothing is applied to remote project `zuyzxkkmsyuybbznelql`).
- Step 3: `apps/field` PWA scaffold and the thin vertical slice; Playwright offline test.
- `apps/field` and `packages/integration-contract` are bare `package.json` stubs only.

## Blockers
- No Docker daemon in this container, so no Supabase local stack. DB tests will use plain local Postgres 16 with stand-ins for Supabase's `auth` schema; the invite-list auth hook can only be verified on the real project after approval.
- Google OAuth client not yet created (owner task, spec §13).

## Decisions needed from owner
1. **Who may release a clear audit?** Implemented default (`DEFAULT_RELEASE_ROLES`): admin, production manager, project manager, installation manager, **and installer**; overrides only by the four manager roles. Spec §4.4 says release is "allowed from ready" without naming roles. Confirm, or tighten to managers only (one-line config change).
2. **Critical REVIEW:** a REVIEW result on a critical item goes to `manager_review_required` regardless of the non-critical policy (not an automatic block). Confirm.
3. **Supervisor approval / evidence exceptions** use the same four manager roles as overrides. Confirm.
4. **Submitting requires every required item to have a result**, and an audit with zero items cannot be submitted.
5. Test runner: Vitest used (spec §10 says Jest; prompt allowed either).
6. PR #1 now contains code as well as the spec; say if you want the code split into its own PR.

## Technical debt / notes
- Decimal-inch and mm inputs are rounded to the nearest 1/64"; that rounding is documented in `units.ts` but means a typed 0.0234" and 0.0235" differ by one unit.
- Fraction denominators limited to 2,4,8,16,32,64 (others give a typed error).
- Asymmetric-tolerance coverage is thin (one test catches a plus/minus swap).
- `npm audit` reports advisories in the Next.js 14.2.5 starter dependency tree; not addressed in this step.

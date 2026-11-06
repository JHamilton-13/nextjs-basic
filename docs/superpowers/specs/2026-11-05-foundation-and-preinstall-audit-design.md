# Foundation + Pre-Install Site Audit — Design Spec

Date: 2026-11-05
Status: Draft for review
Parent project: Cabinet & Architectural Millwork Field Operations Platform (decomposed into 8 sub-projects; this is #1 + #2).

## 1. Intent

Give installers an offline-capable mobile app to complete a pre-install site audit (measurements, photos, checklist) and give managers a dashboard to see readiness and issue documented overrides. A failed critical item must block installation release; nothing may bypass a failed inspection silently. "Audit completed" and "installation authorized" are separate facts.

Success criteria:
- An installer can complete an audit with no connectivity; data syncs later with no loss or duplication.
- Tolerance results (PASS / FAIL / REVIEW) are computed from configurable rules, never hardcoded.
- A critical FAIL sets the project NOT READY and blocks release until a role-authorized, fully recorded override.
- Submitted audits are immutable; corrections create a new version. All state changes are audit-logged.

## 2. Scope

In: monorepo, domain package, Supabase schema + RLS, Expo app (auth, offline store, outbox sync, audit flow, photo capture), Next.js manager dashboard (readiness board, override review).
Out (later sub-projects): PDF drawings/pins, installation checklists, punch lists, service parts, branded PDFs/signatures, Drive/Gmail/Cockpit/Warehouse Tracker integrations (mock contract only), scheduling, AI features.

Environment limits: built in a Linux container with no iOS/Android runtime. Mobile is verified by unit/component tests, typecheck and Expo web export; real-device testing is a manual follow-up. Cockpit and Warehouse Tracker are not accessible; no assumptions about their endpoints are made.

## 3. Repository layout

```
apps/mobile            Expo (React Native, TypeScript)
apps/web               Next.js dashboard (existing starter, relocated)
packages/domain        Pure TS: units, tolerance, readiness, evidence, sync primitives
packages/integration-contract   Event schemas + mock server (no production calls)
supabase/migrations    SQL migrations, RLS policies, seed
docs/                  Specs, architecture, decisions, blockers
```
npm workspaces. Domain has zero runtime dependencies on React/Expo/Supabase.

## 4. Domain package

### 4.1 Units
Parse/format: fractional inches (`3 5/8"`), decimal inches, mm, feet-inches (`8' 1 1/2"`). Internal canonical form: integer 1/64 inch (mm converted with rounding documented). Moisture as percentage (separate quantity type). Invalid input returns a typed error, never NaN.

### 4.2 Tolerance
```
ToleranceRule { expected, plus, minus, unit, reviewBand?, source, sourceRef, method }
source ∈ project_spec | approved_drawing | company_standard | manufacturer | industry_standard | custom
```
Evaluate(actual, rule): within [expected-minus, expected+plus] → PASS; outside but within reviewBand → REVIEW; else FAIL. Rules come from the audit template/project; no defaults are built in as "industry standards".
Each measurement record: expected, actual, tolerance, method, user, timestamp, photo ids, drawing ref, note, result.

### 4.3 Evidence rules
Item config: `requires: {photo?: min count, measurement?, note?, drawingRef?, supervisorApproval?}`. `canComplete(item, evidence)` returns missing requirements; completing without them is rejected. Authorized exceptions are recorded with user, reason, time.

### 4.4 Readiness state machine
States: not_started, in_progress, ready, ready_with_exceptions, not_ready, manager_review_required, released_for_installation.
- Audit result derived from items: any critical FAIL → not_ready; non-critical FAIL/REVIEW with no critical → manager_review_required or ready_with_exceptions per template config; all PASS → ready.
- `release(project, actor)`: allowed from ready; from not_ready/manager_review_required/ready_with_exceptions only with a valid override.
- Override: requires role ∈ {admin, production_manager, project_manager, installation_manager}, non-empty reason, references audit version, supporting doc ids optional. Stored immutably. Overrides never mutate the audit; they authorize release of that audit version.
- Editing a submitted audit is impossible; `reviseAudit` creates version n+1 and invalidates prior overrides for release purposes.

### 4.5 Sync primitives
Operation envelope `{opId (client uuid, idempotency key), entity, entityId, baseVersion, payload, createdAt, actor}`. Server applies each opId at most once. Version mismatch → conflict returned, never overwritten. Client status: pending → sent → confirmed | conflict | failed(retryable). Only `confirmed` shows as synced.

## 5. Data model (Supabase Postgres)

Tables: profiles, projects, project_members(role), rooms, audit_templates(versioned, items+rules JSON validated), audits(version, status, project_id, template_version), audit_items, measurements, photos(checksum, storage_path, captured_at), overrides, applied_ops(op_id unique), notifications, audit_log (append-only).
- RLS: access by project_members; clients/GC see only released/permitted records; override insert restricted to manager roles via policy + function.
- Triggers/constraints: submitted audits immutable; audit_log insert-only; all changes write audit_log.
- Postgres function `apply_op(op)` enforces idempotency and version checks server-side. Domain rules are re-validated on the server (clients are not trusted).

## 6. Mobile app (Expo)

- Tabs: Projects, Audit, Photos/Queue, Settings. Persistent offline/sync badge.
- Local `expo-sqlite` mirror of assigned projects/templates/audits; all writes go local + outbox first.
- Outbox drainer: exponential backoff, resumable after app kill; photo uploads chunked-by-file with checksum verification.
- Audit flow: section list → item → measurement entry with live PASS/FAIL/REVIEW → required photos → submit. Submit blocked until required evidence present.
- Auth via Supabase; tokens in SecureStore.

## 7. Web dashboard (Next.js)

Readiness board (statuses), project detail with failed items + photos, override form (role-gated, reason required), notification records. Server-side permission checks.

## 8. Notifications

Failure creates `notifications` rows for the PM and designated roles plus an email outbox record. No live email in this build.

## 9. Security

RLS everywhere, no secrets in repo (`.env.example` only), signed URLs for photos, audit log append-only, input validation with shared schemas, dependency audit in CI.

## 10. Testing

- Domain: Jest, exhaustive unit tests (units/fractions, boundary tolerance cases, state machine transitions, evidence gating, override authorization, idempotency).
- DB: SQL tests of RLS/immutability via pg (or Supabase local if available).
- Mobile: component tests, outbox/sync tests with fake network (offline, power-loss mid-sync, duplicate op, two-user conflict).
- Web: Playwright for board + override.
- Scenarios covered from the master spec: 1–5, 13, 14 (partial), 18–20 where in scope. Results documented in `docs/testing/`.

## 11. Risks / limitations

- No device testing here; camera/background behavior unverified until run on hardware.
- Supabase project access/credentials needed for live integration; until then, DB tests run against local Postgres if installable.
- Tolerance values and template content must come from the company; sample templates are clearly labeled examples.

## 12. Company decisions (from owner, 2026-11-06)

- **Critical (stop-gate) items:** only MEP rough-in conflicts (plumbing rough-ins, outlets/switches/junction boxes, appliance connections, HVAC registers, sprinklers, other obstructions vs. approved drawing/appliance specs). A FAIL on any of these sets NOT READY. All other items are non-critical: a FAIL/REVIEW yields Ready With Exceptions or Manager Review Required per template config, never an automatic block.
- **Tolerance-checked measurements:** wall length and ceiling height. Expected value comes from the approved drawing for that room/elevation; the allowed +/- is company/project configured.
- **Not tolerance-gated:** wall plumb, wall flatness, floor levelness. These remain optional observation items (note and/or photo, no PASS/FAIL), configurable per template.
- The template engine still supports tolerance on any item, so these choices are template data, not code.

## 13. Open items

- Supabase project to use (new vs existing) — needs user input.
- Allowed +/- values for wall length and ceiling height (and whether a REVIEW band applies). Until provided, the seed template leaves them unset and such items require a manual outcome.

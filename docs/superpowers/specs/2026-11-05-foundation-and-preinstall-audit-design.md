# Foundation + Pre-Install Site Audit — Design Spec

Date: 2026-11-05 (revised 2026-11-07)
Status: Draft for review
Parent project: Cabinet & Architectural Millwork Field Operations Platform (decomposed into 8 sub-projects; this is #1 + #2).

Revision 2026-11-07: installer app changed from native Expo to an installable PWA (PWA first, see §6 and §11); tolerance values and review band set (§12).

## 1. Intent

Give installers an offline-capable mobile app to complete a pre-install site audit (measurements, photos, checklist) and give managers a dashboard to see readiness and issue documented overrides. A failed critical item must block installation release; nothing may bypass a failed inspection silently. "Audit completed" and "installation authorized" are separate facts.

Success criteria:
- An installer can complete an audit with no connectivity; data syncs later with no loss or duplication.
- Tolerance results (PASS / FAIL / REVIEW) are computed from configurable rules, never hardcoded.
- A critical FAIL sets the project NOT READY and blocks release until a role-authorized, fully recorded override.
- Submitted audits are immutable; corrections create a new version. All state changes are audit-logged.

## 2. Scope

In: monorepo, domain package, Supabase schema + RLS, installer PWA (auth, offline store, outbox sync, audit flow, photo capture), Next.js manager dashboard (readiness board, override review).
Out (later sub-projects): PDF drawings/pins, installation checklists, punch lists, service parts, branded PDFs/signatures, Drive/Gmail/Cockpit/Warehouse Tracker integrations (mock contract only), scheduling, AI features.

Environment limits: built in a Linux container with no iOS/Android runtime. The PWA is verified by unit/component tests, typecheck, and Playwright with offline emulation; real-device testing on installers' phones (especially iOS Safari offline photo storage) is a required manual follow-up. Cockpit and Warehouse Tracker are not accessible; no assumptions about their endpoints are made.

## 3. Repository layout

```
apps/field             Installer PWA (React, TypeScript, service worker, IndexedDB)
apps/web               Next.js dashboard (existing starter, relocated)
packages/domain        Pure TS: units, tolerance, readiness, evidence, sync primitives
packages/integration-contract   Event schemas + mock server (no production calls)
supabase/migrations    SQL migrations, RLS policies, seed
docs/                  Specs, architecture, decisions, blockers
```

npm workspaces. Domain has zero runtime dependencies on React/Supabase/browser APIs, so it can be reused if the installer client is ever moved to a native wrapper (Capacitor) or Expo.

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

## 6. Installer app (PWA)

- Installable PWA (web app manifest + service worker); installers add it to the home screen. Distributed by link, no App Store. Persistent offline/sync badge.
- Views: Projects, Audit, Photos/Queue, Settings.
- Local IndexedDB mirror of assigned projects/templates/audits; all writes go local + outbox first. App shell and assigned-project data are cached by the service worker for offline use.
- Outbox drainer: exponential backoff, resumable after app close/reload; photo uploads per file with checksum verification. Where background sync is unavailable (notably iOS Safari), the queue drains when the app is opened/foregrounded, and the UI says so.
- Storage: request persistent storage on first run; show storage usage; compress photos on capture (original retained until confirmed upload); never delete an unconfirmed photo.
- Audit flow: section list → item → measurement entry with live PASS/FAIL/REVIEW → required photos → submit. Submit blocked until required evidence present.
- Auth via Supabase Auth: Google sign-in with company accounts as primary, email one-time code (6-digit, typed into the app) as backup (decision 2026-11-07). Only invited users can sign in; the invite list is enforced server-side (database/auth hook), not just by Google's domain hint. Roles come from `project_members`, not from the identity provider.
- Camera via browser media capture (`<input capture>` / getUserMedia).

## 7. Web dashboard (Next.js)

Readiness board (statuses), project detail with failed items + photos, override form (role-gated, reason required), notification records. Server-side permission checks.

## 8. Notifications

Failure creates `notifications` rows for the PM and designated roles plus an email outbox record. No live email in this build.

## 9. Security

RLS everywhere, no secrets in repo (`.env.example` only), signed URLs for photos, audit log append-only, input validation with shared schemas, dependency audit in CI.

## 10. Testing

- Domain: Jest, exhaustive unit tests (units/fractions, boundary tolerance cases incl. exactly 1/2" and exactly 1", state machine transitions, evidence gating, override authorization, idempotency).
- DB: SQL tests of RLS/immutability via pg (or Supabase local if available).
- PWA: component tests; outbox/sync tests with fake network (offline, tab closed mid-sync, duplicate op, two-user conflict); Playwright with network offline for the full audit flow.
- Web: Playwright for board + override.
- Scenarios covered from the master spec: 1–5, 13, 14 (partial), 18–20 where in scope. Results documented in `docs/testing/`.

## 11. Risks / limitations

- PWA on iOS: stricter browser storage limits and no reliable background sync. Mitigation: persistent-storage request, compress photos, drain queue on foreground, and test offline photo capture on real installer phones in the first milestone. Fallback: wrap the same code with Capacitor, or build an Expo client on the same domain package and Supabase backend.
- No device testing here; camera/offline behavior on real phones unverified until run on hardware.
- Supabase project access/credentials needed for live integration; until then, DB tests run against local Postgres if installable.
- Tolerance values and template content must come from the company; sample templates are clearly labeled examples.

## 12. Company decisions (from owner, 2026-11-06 / 2026-11-07)

- Critical (stop-gate) items: only MEP rough-in conflicts (plumbing rough-ins, outlets/switches/junction boxes, appliance connections, HVAC registers, sprinklers, other obstructions vs. approved drawing/appliance specs). A FAIL on any of these sets NOT READY. All other items are non-critical: a FAIL/REVIEW yields Ready With Exceptions or Manager Review Required per template config, never an automatic block.
- Tolerance-checked measurements: wall length and ceiling height. Expected value comes from the approved drawing for that room/elevation.
- Tolerance value (2026-11-07): ±1/2" for both wall length and ceiling height.
- Review band (2026-11-07): 1" for both. Interpreted as: deviation up to 1/2" = PASS; over 1/2" and up to 1" from expected = REVIEW (manager decides); over 1" = FAIL. Confirmed by owner 2026-11-07: the 1" is total deviation from the drawing value.
- Not tolerance-gated: wall plumb, wall flatness, floor levelness. These remain optional observation items (note and/or photo, no PASS/FAIL), configurable per template.
- Platform (2026-11-07): PWA first (company-internal use, no App Store). Revisit if offline testing on real phones shows problems.
- Supabase project (2026-11-07): existing project "Project Field Tracking" (id zuyzxkkmsyuybbznelql, us-east-2, Postgres 17). Inspected read-only: no tables and no migrations, so the schema starts clean. Schema changes will be written as migrations in the repo and applied only after your approval.
- Sign-in (2026-11-07): Google (company accounts, all installers have one) with email one-time code as backup. GitHub sign-in was considered and rejected. Access is controlled by an invite list and project roles; unknown accounts get no access.
- The template engine still supports tolerance on any item, so these choices are template data, not code.

## 13. Open items

- Create a Google OAuth client (Google Cloud console) and enable the Google provider plus email OTP in the Supabase dashboard (needs your Google admin and Supabase admin access; secrets go in Supabase, never the repo).
- Decide who maintains the invite list (suggest: admin/PM role in the dashboard).
- Later: client/GC portal users will likely use the email code option.
- Real-phone offline photo test (iOS and Android) to confirm the PWA decision.

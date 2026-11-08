# Issue Categories + Builder Site Audit PDF + Room Status Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installers tag Pre-Install Corrections with a trade; managers build, preview and email a Fulton-style site audit PDF to the builder, and see per-room completion status from the checklist pills.

**Architecture:** Pure rules in `packages/domain`; PDF documents in a new `packages/reports` (`@phc/reports`, react-pdf); a minimal manager shell in `apps/web` (Next.js on Supabase auth) that loads data under the manager's own session (row-level security), builds PDFs server-side, stores them in a private bucket and sends them through a Gmail transport; installer picker in `apps/field`.

**Tech Stack:** TypeScript, Vitest, React, `@react-pdf/renderer`, `sharp`, `@supabase/ssr`, `nodemailer` (MIME only), Supabase Postgres, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-issue-categories-and-reports-design.md`. Executors read both.

**Repo / branch:** `JHamilton-13/nextjs-basic`, branch `claude/foundation-audit-spec`. Commit to that branch only.

## Global Constraints

- Never push to `main`, merge, deploy or release. Pushing to `claude/foundation-audit-spec` is allowed. Creating the Vercel project for `apps/web` is the owner's action.
- Never touch Cockpit or Warehouse Tracker repos, deployments or databases. Integrations are a mock contract only.
- Every database change is written as a SQL file, shown to the owner, and applied to remote project `zuyzxkkmsyuybbznelql` only after he says so. Test locally with `bash supabase/tests/run.sh`.
- No secrets in the repo; `.env.example` placeholders only. New dependencies each need a one-line reason (given in the task that adds them).
- Brand: gold `#9a7f3c`; text `#181818`; muted `#6f6f6f`; light divider `#e3e3e3`; table tint `#f6f6f6`; font Geist (TTF embedded; Regular and SemiBold).
- Categories: `pre_install_corrections` (kind Pre Install Correction, trade required), `service` (Punch Item, Missing part, Damaged part), `touch_ups` (Touch Up).
- "Raised by: RW 9/10" line (initials, M/D). No Assigned To field. Photo capture time and date drawn on each photo in the PDF only.
- Room Completed = all 11 pills Done or N/A; open issues do not change it; open-issue count shown beside it.
- Manager roles: admin, production manager, project manager, installation manager. Only they create, read or send reports. A report sends once.
- Photos embedded at 1400 px longest edge, JPEG quality 75. A PDF over 18 MB is blocked (Gmail's 25 MB message limit after email encoding).
- Sender from env `REPORT_FROM` (required, no default in code). Timezone from env `REPORT_TIMEZONE` (default `America/Phoenix`).
- Tests use only fake data and the trial project. No real builder addresses.
- Never mark a task done until built and tested; record results in `docs/testing/` and `docs/MILESTONES.md`.

## Prerequisite (not in this plan)

The installer Add Issue screens are not built yet (handoff section 6A is still open). This plan adds the category/kind/trade picker as a standalone, tested component (Task 8) and seeds test issues in SQL. Wiring the picker into Add Issue happens when that screen is built.

## Review Focus

- A room with no checklist rows (never opened) shows Not completed with all 11 pills outstanding, never Completed and never a crash. (Task 1)
- A Pre Install Correction queued offline before this update, with no trade, is rejected with `trade_required` and shows "needs attention"; it is never silently dropped. (Tasks 2, 8)
- A photo that fails to load or is corrupt prints a placeholder instead of crashing; a job with many photos paginates; a PDF over 18 MB is blocked with the size shown. (Tasks 3, 4, 6)
- Double-click, two managers pressing Send, or the server dying between "queued" and "sent" never emails the builder twice; a stuck "queued" report becomes retryable after 10 minutes. (Tasks 2, 7)
- Emoji, very long descriptions and room names, job names with `/` or quotes, and a job with zero Pre-Install Corrections all produce a valid PDF and a safe file name. (Tasks 4, 7)

---

### Task 1: Domain rules

**Files:**
- Create: `packages/domain/src/reports/categories.ts`, `builderAudit.ts`, `roomStatus.ts`, `email.ts`
- Modify: `packages/domain/src/index.ts` (export all)
- Test: `packages/domain/src/reports/reports.test.ts`

**Interfaces:**
- Produces: `type IssueKind = 'pre_install_correction'|'punch_item'|'touch_up'|'missing_part'|'damaged_part'` (match the existing DB enum names in `docs/DATABASE_SCHEMA.md`); `type IssueCategory`; `categoryOf(kind): IssueCategory`; `requiresTrade(kind): boolean`; `type ReportIssue = {id; roomId; kind; status: 'open'|'completed'|'void'; tradeName: string|null; title; description; raisedByInitials; raisedOn: string; photos: {id; capturedAt: string}[]}`; `builderAuditSummary(issues: ReportIssue[], rooms: {id; name}[]): {identified: number; incomplete: number; rooms: {roomId; roomName; issues: ReportIssue[]}[]}`; `type PillDef = {key; label}`; `type PillMark = {key; state: 'done'|'not_done'|'na'; note: string|null}`; `roomStatus(defs: PillDef[], marks: PillMark[]): {completed: boolean; outstanding: {key; label; state: 'not_done'|'unticked'; note: string|null}[]}`; `isValidEmail(s: string): boolean`.

- [ ] **Step 1: Write failing tests** with these names and assertions: `categoryOf maps every kind` (pre_install_correction→pre_install_corrections; punch_item, missing_part, damaged_part→service; touch_up→touch_ups); `requiresTrade only for pre_install_correction`; `summary counts identified and incomplete` (3 pre-install: 2 open + 1 completed, plus 1 void pre-install and 1 open punch_item → identified 3, incomplete 2); `summary omits rooms without pre-install issues and keeps room order`; `summary with no issues returns 0, 0, []`; `roomStatus completed when every pill is done or na`; `roomStatus with no marks has 11 unticked outstanding and completed false` (11 defs, marks `[]`); `roomStatus keeps the note on a not_done pill`; `isValidEmail` accepts `a@b.com`, rejects `a@b`, ` ` and `a b@c.com`.
- [ ] **Step 2: Run** `npm run test -w @phc/domain -- reports` and confirm FAIL (functions not defined).
- [ ] **Step 3: Implement** the signatures above. Void issues are excluded from both counts. Only `pre_install_correction` issues enter the summary.
- [ ] **Step 4: Run** the same command and confirm PASS; run `npm run test -w @phc/domain` for no regressions.
- [ ] **Step 5: Commit** `feat(domain): issue categories, builder audit summary, room status`.

### Task 2: Migration 1600 and database tests (files only)

**Files:**
- Create: `supabase/migrations/1600_trades_reports.sql`, `supabase/tests/1600_trades_reports.sql`
- Modify: `docs/DATABASE_SCHEMA.md`

**Interfaces:**
- Produces: tables `trades(id, name, sort_order, active)` (rows are never deleted, only `active=false`), `reports` (columns per spec section 5, plus `queued_at`); `issues.trade_id`; `projects.prepared_for_name`, `prepared_for_email`, `site_address` (only those missing); private storage bucket `reports`; functions `queue_report_send(p_report_id uuid, p_recipient_name text, p_recipient_email text) returns reports`, `mark_report_sent(p_report_id uuid, p_message_id text) returns void`, `mark_report_failed(p_report_id uuid, p_error text) returns void`. Errors raised as `report_already_queued`, `report_already_sent`, `forbidden`.

- [ ] **Step 1: Read** `docs/DATABASE_SCHEMA.md` and migrations 0900 to 1500. Record the real names of the issues table, kind enum, role helper (use the existing manager-role helper; add `current_user_is_manager()` only if none exists), outbox table, audit-log writer, `photos.captured_at`, and the `apply_op` rejection shape. Fix any name in this plan that differs.
- [ ] **Step 2: Write failing SQL tests** in the existing test style: pre-install issue without `trade_id` is rejected through `apply_op` with code `trade_required`; punch_item with a `trade_id` is rejected; rows that exist before the migration are untouched; installer, general contractor and client cannot select or insert `reports`; project manager can; installer can select active `trades` and cannot insert; `queue_report_send` twice raises `report_already_queued`; after `mark_report_sent` it raises `report_already_sent`; after `mark_report_failed` it queues again; a report queued more than 10 minutes ago queues again; build and send each write an audit-log row.
- [ ] **Step 3: Run** `bash supabase/tests/run.sh` and confirm the new tests FAIL.
- [ ] **Step 4: Write the migration.** The trade rule is a `CHECK ... NOT VALID` plus the `apply_op` rule, so existing rows are not rejected. Seed trades: plumbing, electrical, HVAC, windows, framing, cabinetry, drywall, flooring, other. Row-level security per spec section 5; storage policies allow only manager roles; no delete policy on `trades`.
- [ ] **Step 5: Run** the tests and confirm PASS, with real output pasted into `docs/testing/1600-reports.md`.
- [ ] **Step 6: Commit** `feat(db): trades, reports, report send functions (not applied)`. **Stop.** Show the owner the full SQL and test output; apply to the remote project only after his explicit yes.

### Task 3: `@phc/reports` foundations

**Files:**
- Create: `packages/reports/package.json`, `tsconfig.json`, `src/tokens.ts`, `src/fonts.ts`, `src/format.ts`, `src/prepareImage.ts`, `src/index.ts`, `assets/fonts/Geist-Regular.ttf`, `assets/fonts/Geist-SemiBold.ttf`, `assets/PHC_LOGO.png`
- Modify: root `package.json` (add workspace)
- Test: `packages/reports/src/format.test.ts`, `prepareImage.test.ts`

**Interfaces:**
- Produces: `COLORS` and `FONT_FAMILY` from `tokens.ts` (values in Global Constraints); `registerFonts(): void` (idempotent); `formatStamp(iso: string, tz: string): string`; `formatCoverDate(iso: string, tz: string): string`; `formatRaised(initials: string, iso: string, tz: string): string`; `prepareImage(input: Buffer): Promise<Buffer>`.
- Dependencies and reasons: `@react-pdf/renderer` (pure-JS PDF layout that runs in a Vercel function); `sharp` (resize photos so the PDF stays under the email limit); `pdf-parse` (dev only, reads text and page count of generated PDFs in tests). Geist TTFs are copied into the repo (SIL Open Font License); `PHC_LOGO.png` is converted from the supplied `.ico`.

- [ ] **Step 1: Write failing tests:** `formatStamp('2026-09-10T18:43:00Z','America/Phoenix') === '11:43 9/10/26'`; `formatStamp('2026-09-11T06:30:00Z','America/Phoenix') === '23:30 9/10/26'`; `formatCoverDate('2026-09-10T20:00:00Z','America/Phoenix') === 'Thursday, September 10, 2026'`; `formatRaised('RW','2026-09-10T18:43:00Z','America/Phoenix') === 'Raised by: RW 9/10'`; `prepareImage` turns a 3000x2000 JPEG into a 1400x933 JPEG; `prepareImage` rejects a corrupt buffer; `registerFonts` can be called twice without error.
- [ ] **Step 2: Run** `npm run test -w @phc/reports` and confirm FAIL.
- [ ] **Step 3: Implement** the interfaces. Use `Intl.DateTimeFormat` with the timezone for the three formatters; `sharp` resize `fit: 'inside'`, JPEG quality 75, EXIF rotation applied.
- [ ] **Step 4: Run** and confirm PASS. **Step 5: Commit** `feat(reports): fonts, tokens, formatters, image prep`.

### Task 4: PDF documents

**Files:**
- Create: `packages/reports/src/BuilderAuditDocument.tsx`, `RoomStatusDocument.tsx`, `render.ts`
- Test: `packages/reports/src/documents.test.tsx`

**Interfaces:**
- Consumes: `BuilderAuditSummary`, `roomStatus` result (Task 1); formatters, `COLORS`, `registerFonts` (Task 3).
- Produces: `BuilderAuditDocument(props: {jobName; preparedFor: string|null; siteAddress: string|null; builtAt: string; timezone: string; summary: BuilderAuditSummary; logo: Buffer; photos: Record<string, Buffer|null>}): JSX.Element`; `RoomStatusDocument(props: {jobName; preparedFor; siteAddress; builtAt; timezone; logo; rows: {roomName; completed: boolean; byWho: string|null; at: string|null; outstanding: string[]; openIssues: number}[]}): JSX.Element`; `renderReport(doc: JSX.Element): Promise<Buffer>`.

- [ ] **Step 1: Write failing tests** (read PDF text with `pdf-parse`): cover contains the job name, `Prepared For True Performance`, `2 Issues Identified`, `1 Issue Incomplete` for 2 identified and 1 open; singular `1 Issue Identified`; `0 Issues Identified` with the body text `No Pre-Install Corrections`; room headings and trade names appear; description is shown, and the title is used when the description is empty; a photo with `null` bytes renders a placeholder and the document still builds; one issue with 20 photos gives more than 2 pages; footer text `Page 2 of 2` appears on page 2; emoji in a description does not throw; a 200-character room name wraps without throwing; the status document lists Completed and Not completed rows with open-issue counts.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** following the Fulton layout. Cover: logo top right with "Public House Creative" under it; job name large; `COLORS.gold` rule; cover date from `formatCoverDate`; Prepared For; address; counts line. Room pages: divider rule (gold between rooms), room heading, trade badge, `formatRaised` line, description, photos two across with a number badge top right and `formatStamp` bottom right, both drawn as overlays. Issues use `wrap={false}`; the footer is a fixed `Page X of Y`. Strip characters Geist cannot draw instead of failing.
- [ ] **Step 4: Run** and confirm PASS. **Step 5: Visual check:** render a sample job with `pdftoppm -r 60`, compare side by side with the Fulton pages, save both images under `docs/testing/images/`. **Step 6: Commit** `feat(reports): builder audit and room status documents`.

### Task 5: Manager web shell

**Files:**
- Create: `apps/web/src/lib/supabase/server.ts`, `apps/web/src/middleware.ts`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/(manager)/layout.tsx`, `apps/web/src/app/(manager)/jobs/page.tsx`, `apps/web/src/lib/auth/requireManager.ts`
- Modify: `apps/web/package.json`, `.env.example`
- Test: `apps/web/src/lib/auth/requireManager.test.ts`

**Interfaces:**
- Produces: `isManagerRole(role: string): boolean`; `requireManager(): Promise<{userId: string; email: string}>` (redirects to `/login` or `/no-access`); `createServerSupabase(): SupabaseClient` using the signed-in user's session, never a service key.
- Dependency reason: `@supabase/ssr` (official cookie-session helper for Next.js).

- [ ] **Step 1: Write failing tests:** `isManagerRole` true for admin, production_manager, project_manager, installation_manager; false for installer, warehouse, general_contractor, client and `''`; `requireManager` redirects a signed-out request to `/login` and an installer to `/no-access` (mock the Supabase client).
- [ ] **Step 2: Run** `npm run test -w web` and confirm FAIL. **Step 3: Implement** Google sign-in through Supabase (same provider as the field app; the invite list already applies), the guard, and a Jobs page that lists projects the manager can read. **Step 4: Run** and confirm PASS. **Step 5: Commit** `feat(web): manager sign-in and jobs list`.
- [ ] **Owner action (note in MILESTONES):** create a Vercel project for `apps/web` and add its address to the Supabase Auth URL list. Do not deploy.

### Task 6: Room status screen and report building

**Files:**
- Create: `apps/web/src/server/reports/loadReportData.ts`, `buildReport.ts`, `apps/web/src/app/(manager)/jobs/[id]/page.tsx`, `.../reports/[reportId]/page.tsx`
- Test: `apps/web/src/server/reports/buildReport.test.ts`

**Interfaces:**
- Consumes: Task 1 rules, Task 3 and 4 documents, Task 2 tables.
- Produces: `MAX_PDF_BYTES = 18 * 1024 * 1024`; `class ReportTooLargeError extends Error {bytes: number}`; `loadBuilderAuditData(db, projectId): Promise<{project; summary}>`; `loadRoomStatusData(db, projectId): Promise<RoomStatusRow[]>`; `buildReport(db, storage, projectId, type: 'builder_site_audit'|'room_status'): Promise<{reportId: string; bytes: number}>` which prepares photos, renders, stores in bucket `reports` and inserts a `reports` row with status `built`.

- [ ] **Step 1: Write failing tests** with a fake db and storage: a photo that fails to download becomes a `null` photo and the build succeeds; output over `MAX_PDF_BYTES` throws `ReportTooLargeError` and stores nothing; a successful build inserts one `reports` row with `status: 'built'` and the byte size.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement.** The job page shows the room status table (Completed or Not completed, who and when, Not done notes, open-issue count), a form for `prepared_for_name`, `prepared_for_email`, `site_address` (entered by a manager; import from Cockpit contacts is a later feature and out of scope), and buttons "Build site audit PDF" and "Create status PDF". The preview page shows the PDF through a 5-minute signed link, plus file size and issue counts.
- [ ] **Step 4: Run** and confirm PASS. **Step 5: Commit** `feat(web): room status screen and report building`.

### Task 7: Email sending

**Files:**
- Create: `apps/web/src/server/email/transport.ts`, `gmailTransport.ts`, `fakeTransport.ts`, `apps/web/src/server/reports/sendReport.ts`, `docs/ops/gmail-send-setup.md`
- Modify: `.env.example` (`REPORT_FROM`, `REPORT_TIMEZONE`, `REPORT_TRANSPORT`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`)
- Test: `apps/web/src/server/reports/sendReport.test.ts`

**Interfaces:**
- Produces: `type OutgoingEmail = {from; to; subject; text; attachment: {filename; content: Buffer; contentType: 'application/pdf'}}`; `interface EmailTransport {send(m: OutgoingEmail): Promise<{messageId: string}>}`; `gmailTransport(env): EmailTransport` (refresh-token exchange, then Gmail `messages.send` with scope `gmail.send` only); `fakeTransport(): EmailTransport & {sent: OutgoingEmail[]}`; `safeFileName(jobName: string, date: string): string`; `sendReport(deps, reportId, recipient: {name; email}): Promise<'sent'>`; `sendTestReport(deps, reportId, managerEmail): Promise<void>` (does not change report status).
- Dependency reason: `nodemailer` (its MailComposer builds a correct multipart email with attachment; no hand-written MIME).

- [ ] **Step 1: Write failing tests with `fakeTransport`:** one `sendReport` call sends exactly one email and marks the report `sent`; two simultaneous calls send exactly one (`sent.length === 1`) and the second throws `report_already_queued`; a transport that throws leaves status `failed` with the error, and a retry then sends; a report in `queued` for more than 10 minutes can be retried; `sendTestReport` sends to the manager only and leaves status `built`; an invalid recipient is rejected before anything is queued; `safeFileName('Fulton/ "Unit 313"','2026-09-10')` returns `Fulton Unit 313 Site Audit 2026-09-10.pdf`.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement** sending through the Task 2 functions (`queue_report_send`, then the transport, then `mark_report_sent` or `mark_report_failed`). A transport selected by `REPORT_TRANSPORT=fake` is used in tests and e2e. The preview page gets Send, "Send test to me", the Failed state with Retry, and a "check the Sent folder first" note on a stuck Queued report.
- [ ] **Step 4: Run** and confirm PASS. **Step 5: Write** `docs/ops/gmail-send-setup.md` (Google admin steps: OAuth client, `gmail.send` scope only, refresh token stored in Vercel settings). **Step 6: Commit** `feat(web): send reports through Gmail transport`.

### Task 8: Installer category, kind and trade picker

**Files:**
- Create: `apps/field/src/features/issues/IssueClassifier.tsx`, `apps/field/src/features/issues/tradesStore.ts`
- Modify: the existing sync pull (add `trades` to the local mirror, following the pattern used for projects)
- Test: `apps/field/src/features/issues/IssueClassifier.test.tsx`

**Interfaces:**
- Consumes: `categoryOf`, `requiresTrade` (Task 1).
- Produces: `listTrades(): Promise<{id; name; active}[]>` reading the local store; `IssueClassifier(props: {onChange(v: {kind: IssueKind; tradeId: string|null} | null): void})` which emits `null` until valid. A deactivated trade still displays on existing issues but is not offered for new ones.

- [ ] **Step 1: Write failing tests:** three category buttons render; choosing Pre-Install Corrections then a kind shows the trade list and `onChange` stays `null` until a trade is picked; Service and Touch-ups need no trade and emit immediately; trades load with the network off from the local store; an inactive trade is not offered.
- [ ] **Step 2: Run** `npm run test -w @phc/field -- IssueClassifier` and confirm FAIL. **Step 3: Implement** with touch targets large enough for gloves (same sizing as the checklist pills). **Step 4: Run** and confirm PASS, then `npm run test -w @phc/field` for no regressions. **Step 5: Commit** `feat(field): category, kind and trade picker with offline trades`.

### Task 9: End-to-end checks and records

**Files:**
- Create: `apps/web/e2e/reports.spec.ts`, `docs/testing/reports.md`
- Modify: `docs/MILESTONES.md`, `.env.example`

- [ ] **Step 1: Write the Playwright test** (fake transport, local database seeded with a fake job): manager signs in, builds the site audit PDF, previews it, sends a test to self, sends to `builder@example.test`, sees status Sent, and a second Send is refused; an installer account is redirected away from `/jobs`.
- [ ] **Step 2: Run** `npm run e2e -w web` and confirm PASS; paste real output into `docs/testing/reports.md` with the side-by-side Fulton image from Task 4.
- [ ] **Step 3: Update** `docs/MILESTONES.md` (done, open, owner actions: apply migration 1600, Vercel project for `apps/web`, Gmail setup, one real test send to the owner's own mailbox, real-phone check of the picker).
- [ ] **Step 4: Commit** `docs: reports testing and milestones`.

---

## Self-review

- **Spec coverage:** categories (T1, T8), trade tag and database (T2), builder fields and manager entry (T6), PDF layout, colours and font (T3, T4), room status screen and PDF (T4, T6), manager preview and send with test send, once-only, retry (T2, T7), Gmail and env settings (T7), security (T2, T5), testing (T9). Out-of-scope items are not planned.
- **Spec corrections found while planning:** (1) react-pdf embeds images at full size, so "scaled down inside the PDF" would not shrink the file; photos are resized before embedding (T3). (2) Gmail's 25 MB limit applies after email encoding, so the PDF cap is 18 MB, not 25 MB. The spec is updated to match.
- **Names checked across tasks:** `queue_report_send`, `mark_report_sent`, `mark_report_failed`, `MAX_PDF_BYTES`, `ReportTooLargeError`, `EmailTransport`, `fakeTransport` and `roomStatus` are used consistently.
- **Dependency order:** T1 and T3 are independent; T2 gates T6 to T8; T4 needs T1 and T3; T5 precedes T6 and T7.

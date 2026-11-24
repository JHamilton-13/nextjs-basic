# Issue Categories + Builder Site Audit PDF + Room Status Reports: Design Spec

Date: 2026-11-08
Status: Approved by owner 2026-11-08 (amended same day: builder contact entry, photo resizing, attachment cap)
Parent: Cabinet & Architectural Millwork Field Operations Platform (PHC). Builds on `docs/HANDOFF.md` (2026-11-08).

## 1. Intent

Give PHC two outputs from data the installer app already collects:

1. A **builder site audit PDF**: Pre-Install Corrections per room, tagged by trade (plumbing, electrical, HVAC, windows, framing, etc.), emailed to the builder after a manager reviews it. It matches the existing Site Audit "Fulton" PDF.
2. An **office room status list**: every room on a job as Completed or Not completed, based on the 11-pill room checklist. It is a dashboard screen plus an internal PDF a manager can email.

Success criteria:
- A manager can build, preview and send the builder PDF without leaving the dashboard.
- Nothing reaches a builder without a manager seeing it. A report can be sent only once.
- The PDF cover and room pages follow the Fulton reference layout (logo, gold rule, cover fields, two-across numbered photos, "Page X of Y"), in the Cockpit colours and font.
- Installers choose one of three clear categories. The office sees one status per room.

## 2. Decisions on record (this design session)

- **Three categories**, chosen by the installer first:
  | Category | Contains | Feeds |
  |---|---|---|
  | Pre-Install Corrections | kind Pre Install Correction, with a Trade | Builder site audit PDF |
  | Service | kinds Punch Item, Missing part, Damaged part; part request; the 11-pill room checklist | Office room status |
  | Touch-ups | kind Touch Up | Client sign-off (separate spec) |
- **Issue source:** the Add Issue feature with a Trade tag. The old 42-item pre-install audit stays hidden and is not used.
- **"Assigned To" line** shows "Raised by: [installer initials] [date]", for example "RW 9/10". No Assigned To field is added. (This replaces the Site Audit meaning of the line.)
- **Photo stamps:** capture time and date are drawn on each photo when the PDF is built. Stored photos stay clean. The earlier decision that photos carry no timestamp is kept.
- **Sending:** a manager reviews the PDF and presses Send. The installer never sends it. The sender mailbox is set in the `REPORT_FROM` environment setting (not stored in the repo).
- **Builder contact (owner, 2026-11-08):** a manager enters the builder name, email and site address on the project. A later feature will import builder contacts from Cockpit contacts through the mock contract; that import is out of scope here.
- **Room Completed** means all 11 pills are Done or N/A. Open issues do not change the status. The open-issue count is shown beside the status.
- **Status list delivery:** a dashboard screen plus an internal PDF/email.
- **PDF engine:** server-side `@react-pdf/renderer` (one new dependency, justified in section 8).
- **Brand values, from the Cockpit CSS:**
  - Gold rule: `#9a7f3c` (`--color-brass-deep`, confirmed by you). The lighter `#c1a353` (`--color-brass`) is not used for the rule.
  - Text: `#181818` (`--color-ink`). Light dividers and fills: `#e3e3e3` and `#f6f6f6` (`--color-neutral-200` and `--color-neutral-50`). Muted text: `#6f6f6f` (`--color-neutral-500`).
  - Font: **Geist** (Cockpit's `--font-sans`), regular and semibold weights.
  - Logo: `PHC_LOGO.ico`, 256x256, converted to PNG.

## 3. Scope

In: trade tag, three-category UI mapping, builder fields on a project, report records, builder PDF, status PDF, dashboard status screen, manager preview and send, Gmail API sending, tests.

Out (separate specs): client signature, job and room sign-off PDF, the Touch-ups sign-off flow, part request fields and statuses, notifications inbox, real Cockpit / Warehouse Tracker hand-off and the Cockpit contacts import, the pre-install audit, and the installer Add Issue screens themselves (this spec adds the category, kind and trade picker to them).

## 4. Domain rules (`packages/domain`, pure TypeScript)

- `categoryOf(kind)` maps issue kind to category, per the table in section 2. Existing issue rows need no rewrite.
- `requiresTrade(kind)` is true for Pre Install Correction only.
- `builderAuditSummary(issues)` returns, per room, the open and completed Pre-Install Corrections plus totals: Issues Identified (all) and Issues Incomplete (open).
- `roomStatus(pills)` returns Completed when all 11 pills are Done or N/A, otherwise Not completed with the list of Not done pills and their notes. A room with no checklist rows counts as Not completed.
- All are covered by unit tests, including edge cases: zero issues, an all-N/A room, and a voided issue (excluded from counts).

## 5. Data model (SQL files only; shown to you before anything is applied)

Confirm each against `docs/DATABASE_SCHEMA.md` when written. Proposed migration 1600 (number to follow the current sequence):

- `trades` table: id, name, sort order, active. Managers edit it; rows are deactivated, never deleted. Seeded with plumbing, electrical, HVAC, windows, framing, cabinetry, drywall, flooring, other (final list is yours to edit).
- `issues.trade_id` nullable foreign key. The rule requires it when the kind is Pre Install Correction and forbids it otherwise. It applies to new issues only, so existing rows are not rejected. An offline-queued Pre Install Correction without a trade is rejected with `trade_required` and shows "needs attention".
- `projects`: `prepared_for_name`, `prepared_for_email`, `site_address` (add only those that do not already exist).
- `reports` table: id, project_id, report_type (`builder_site_audit` | `room_status`), storage_path, file_size, recipient_name, recipient_email, built_by, built_at, queued_at, sent_by, sent_at, status (`built` | `queued` | `sent` | `failed`), error. A report sends once; a report stuck in `queued` for more than 10 minutes can be retried.
- Uses the existing email outbox table to queue the message.
- Row-level security: only the four manager roles (admin, production, project, installation manager) create, read or send reports. Clients, general contractors and installers have no read access to `reports`. Report PDFs live in a private storage bucket. Build and send write to the append-only audit log.

## 6. Flows

**Installer.** Add Issue: choose category, then kind, then (for Pre-Install Corrections) a required trade, then title, description and photos. Unchanged offline behaviour: the issue is queued on the phone and synced later. The trade list is mirrored on the phone so it works offline.

**Manager: builder site audit PDF.**
1. Open a job, enter or check the builder name, email and address, then choose "Build site audit PDF".
2. The server collects Pre-Install Corrections grouped by room, with photos, then builds the PDF and saves it to private storage.
3. The manager previews it. The preview shows file size, the issue counts and the recipient (prefilled from the project, editable).
4. "Send test to me" emails the PDF to the manager only. "Send" queues the real email.
5. The outbox drains: status goes queued, then sent or failed. Failed shows a Retry button. A report cannot send twice.

**Manager: room status.** A dashboard screen lists each room with Completed or Not completed, who and when, the Not done notes, and the open-issue count. "Create status PDF" builds the internal PDF, and the manager emails it to a chosen recipient using the same preview, test-send and Send flow.

## 7. PDF layout (Fulton layout, Cockpit colours and font)

**Cover page:** PHC logo top right with "Public House Creative" below it; job name large; gold `#9a7f3c` rule; date built; "Prepared For [name]"; site address; "N Issues Identified"; "N Issues Incomplete" (singular for 1).

**Room pages:** a divider rule (gold `#9a7f3c` between rooms), then the room heading. Each issue shows a trade badge, "Raised by: RW 9/10", the description (the title if the description is empty), and numbered photos two across, each with its capture time and date drawn on it. Rooms and issues follow the app order. Footer reads "Page X of Y".

**Status PDF:** same cover style, then a table: room, status, who and when, notes, open-issue count.

**Type and colour:** Geist throughout, text `#181818`, muted text `#6f6f6f`, light dividers `#e3e3e3`. The status table uses `#f6f6f6` for header and alternate rows.

**Photos:** the stored 2048 px copies are resized to 1400 px on the longest edge at JPEG quality 75 before they are embedded, so the PDF stays small. A photo that cannot be loaded prints a placeholder.

## 8. Dependencies and email

- New dependencies, each for one reason: `@react-pdf/renderer` (pure JavaScript PDF layout that runs in a Vercel function with no browser engine); `sharp` (photo resizing); `@supabase/ssr` (cookie sessions for the manager web app); `nodemailer` (builds the multipart email with attachment); `pdf-parse`, dev only (reads generated PDFs in tests).
- Font: Geist is embedded in the PDF. `@react-pdf/renderer` reads TTF or OTF files, not the WOFF2 files the Cockpit CSS points to, so the Geist TTF files are added to the repo's assets (Geist is open source under the SIL Open Font License, which allows this).
- Gmail API for sending (Google Workspace). No new vendor. Credentials are stored in Vercel settings, never in the repo; `.env.example` holds placeholder names only.
- Sender address is set by one environment setting (`REPORT_FROM`). A shared address such as `reports@` is recommended later, so sending does not depend on one person's account.
- Gmail's limit is 25 MB per message, and email encoding adds about a third, so a PDF over 18 MB is blocked with a clear message. The preview shows the size.

## 9. Security

Private storage with short-lived links, row-level security as in section 5, manager-only send, once-only send, audit-log entries for build and send, input validation on recipient addresses, no secrets in the repo.

## 10. Testing (results recorded in `docs/testing/`)

- Domain unit tests for the rules in section 4.
- Database tests: the trade rule, manager-only report access, once-only send.
- PDF render test: render a test job to an image and compare the layout with the Fulton pages by eye, with a recorded screenshot. Colour and font are checked against section 2.
- Manager flow end to end (build, preview, test send, send, retry) with the email transport mocked.
- One real test send to your own mailbox, only after you approve it.
- Test data: only the trial project. No real builder addresses in any test.
- Not testable here: how the PDF looks in each mail app, and iPhone attachment preview. Those need a real check.

## 11. Risks

- Sending from one person's mailbox ties delivery to that account. Mitigation: configurable sender and a shared alias later.
- Large photo sets can exceed the email limit. Mitigation: photos resized before embedding, size shown in preview, a clear block over 18 MB.
- Room can show Completed with open issues (your decision). Mitigation: the open-issue count beside the status.
- The handoff's derived pills ("all punch items complete", "touch ups complete") are not part of this spec. Punch items now sit in Service and touch-ups in their own category, so that rule is revisited in the sign-off spec.
- The manager dashboard does not exist yet, so a minimal manager web app (sign-in, jobs, room status, reports) is built here. It needs its own hosting project, which is your action.

## 12. Open items before build

- **You:** final trade list (decided: seeded as is).
- **Google admin:** approve a send-only Gmail permission for the sender mailbox. Exact steps will be provided.
- **You:** create the hosting project for the manager web app when it is ready.
- **Repo:** confirm whether `projects` already has an address column when the migration is written.

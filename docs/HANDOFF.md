# PHC Field Operations Platform: handoff (2026-11-08)

Purpose of this file: let you carry on designing in Claude chat, then come back to Claude Code to build. Paste or upload this file
into a Claude chat. Section 6 is the list of questions still to settle; section 9 says how to resume building.

---------------------------------------------------------------------------------------------------------------------

## 1. What this is

A cabinet and architectural millwork field operations platform for Public House Creative (PHC):
- an **offline-first installer PWA** (works on a phone with no signal, syncs later),
- a **manager dashboard** (not built yet),
- on **Supabase** (database, sign-in, private photo storage), hosted on **Vercel**.

It sits beside two systems it does NOT touch: **Cockpit** and the **Warehouse Tracker**. Integrations are a "mock contract" only
(agreed data shapes, no live connection). The master file lives in Google Drive.

## 2. Where everything is

| Thing | Where |
|---|---|
| Code | GitHub `JHamilton-13/nextjs-basic`, branch `claude/foundation-audit-spec`, PR #1 (open; never merge or push to `main` without being asked) |
| Installer app | Vercel project `nextjs-basic` (team `phc3`), preview address https://nextjs-basic-git-claude-foundation-audit-spec-phc3.vercel.app |
| Database | Supabase project ref `zuyzxkkmsyuybbznelql` |
| Cockpit (read only) | `JHamilton-13/PHC-Cockpit-Dev` (cloned read-only in Claude Code sessions; nothing in it is ever changed) |
| Docs | `docs/MILESTONES.md`, `docs/DATABASE_SCHEMA.md`, `docs/testing/*.md`, `docs/architecture/audit-template-config.md`, `supabase/README.md` |

Repo layout: `apps/field` (installer PWA, Vite + React), `apps/web` (starter Next.js, untouched, future manager dashboard),
`packages/domain` (pure TypeScript rules, no dependencies), `packages/integration-contract` (stub), `supabase/` (migrations, tests).

## 3. Where the project stands

**Live and working (you have tried it on a phone):** sign-in with Google (invite list enforced), installer sees projects, opens a job
to its rooms, sees room details (read-only), ticks an 11-pill completion checklist per room offline and online, with who and when.

**Built but hidden from installers:** the original pre-install site audit (42-item template, tolerance engine, photos, finger markup
with pen / highlighter / text / eraser, revise, submit). It is kept behind a switch (`VITE_SHOW_AUDIT=1`) because the tests use it.

**Database (live), migrations applied:** 0100 to 0900 (foundation), 1000 (photo size check), 1100 (annotations, who/when, offline revise),
1200 (room details), 1300 (room checklist), 1400 (room issues with photos).
**Drafted, NOT applied, waiting for your approval:** 1500 (lock down `confirm_issue_photo` so signed-out callers cannot execute it; no data was exposed).

**Not built yet:** the Add Issue / missing part / damaged part screens (the database for them is applied), part requests,
room and job sign-off, client signature, PDF report, email, manager dashboard, release/override screens, notifications, imports from
Cockpit / master file / Warehouse Tracker, conflict-resolution screen.

**Tests (all passing at last run):** type-check clean; installer app unit 92; domain unit 122; database 380 assertions + concurrency;
emulated iPhone SE / iPhone 13 / Pixel 7: 180 checks; offline suite 74; installer real-build suite 7.

**Live data from testing:** project "PHONE TRIAL - delete later" with rooms "Kitchen (trial)" and "Bath 1 (trial)" (example details
entered by hand), the example audit template, and checklist rows created from your phone. All of it is to be deleted after trials.

## 4. Decisions you have made (on record)

Safety and process
- Never push, deploy, merge or release without being told. Pushing to branch `claude/foundation-audit-spec` is allowed. Hosting is your action.
- Never touch the Cockpit or Warehouse Tracker repos, deployments or databases. Cockpit is read-only reference. Integrations are a mock contract.
- No secrets in the repo (`.env.example` placeholders only). Google sign-in keys live in Supabase settings.
- Every database change is shown as SQL first and applied only after you say so. Never mark a feature done until it is built and tested.
- No new dependencies without a one-line reason. Vitest is fine. The platform is a PWA.

Product
- **Installer app scope (latest):** installers see rooms and their details, add issues, missing or damaged parts, then a part request, and tick a per-room checklist. The pre-install audit is not needed for installers.
- **Room details** come from any of: Cockpit, the master file (Google Drive), the Warehouse Tracker. Installers can see them and may edit them only inside a part request. "PHC Only Notes" and gate codes are never shown (the database refuses to store them).
- **Issues and parts:** the installer app owns issues and part requests. Part requests start pre-filled from the room's details. Issue kinds: Pre Install Correction, Punch Item, Touch Up (as in Cockpit) plus Missing part and Damaged part.
- **Checklist:** 11 pills, one tap = Done; Not done needs a note (example: "Toe skins installed after wood floor installation. After 11/5"); N/A; untick. "All punch items complete" and "touch ups complete" are not pills; they will be derived from open issues.
- **Sign-off:** the client signs on the installer's phone or tablet. Clients and general contractors otherwise have no in-app access; they receive a PDF by email later.
- **Photos:** 2048 px / quality 0.8 JPEG is acceptable as permanent evidence; originals leave the phone after confirmed upload. Photos carry no timestamp; the audit and each line item carry who and when. Markup tools: pen, highlighter, text, eraser. Saving markup creates a new copy; the original is never changed.
- **Look:** Cockpit palette (dark bar, warm page, white cards, copper accent), phone first. Reference: Site Audit screenshots (projects list, summary, issues list, edit issue) and Cockpit's Site Request screen.
- **Hosting:** Vercel. Source of truth for sign-in: Supabase, with an invite list; admins plus production and project managers maintain invites and create projects and templates.

Original audit rules (kept, currently hidden from installers)
- Only MEP rough-in conflicts are critical. Tolerances: wall length and ceiling height ±1/2" with a 1" total-deviation review band; plumb, flatness and floor level are observation only.
- Managers only can release; a critical REVIEW goes to "Manager Review Required" (no hard block); supervisor approval uses the four manager roles (admin, production, project, installation manager). Submit has no required-result gating; zero items can be submitted.

## 5. How it works (short version)

- **Lengths** are whole 1/64-inch units. **Offline:** every change is written on the phone first and queued, then sent when there is a connection. Each change carries an id, so sending twice is harmless. If two people change the same thing while offline, the later one is flagged (not overwritten).
- **Database rules, not app rules:** row-level security everywhere; writes go through one function (`apply_op`) and a few others; an append-only audit log records every change; private photo storage.
- **Roles:** admin, production manager, project manager, installation manager, installer, warehouse, general contractor, client. Field roles (installer + the three managers) can raise issues and tick checklists; clients and general contractors cannot read issues.
- **Checklist and issues** use the same offline queue as the audit, grouped per room.

## 6. Questions still to settle (work through these in chat)

I have given my recommendation for each so you can answer quickly.

**A. Issues (Add issue, missing part, damaged part)**
1. Fields beyond kind, title, description and photos: do you want *Assigned to*, *Priority* and *Due date* (the Site Audit app had them)? Recommendation: no, keep it light; installers raise, managers act.
2. Who may complete an issue? Recommendation: the installer who raised it or any manager; reopening allowed.
3. Mistakes: add a "Void" action, or just complete with a note? Recommendation: add Void (kept in history, hidden by default).
4. Cockpit shows counts per kind and a "Show completed" toggle. Same here? Recommendation: yes.
5. Should a missing/damaged part issue require a photo? Recommendation: damaged = yes, missing = no.
6. Do installers need to see issues raised by other installers on the same room? Recommendation: yes.

**B. Part requests**
1. Exact fields: part description, quantity, reason (missing / damaged / remake / wrong), urgency or needed-by date, room details (prefilled, editable for this request only), photos, notes. What else does the warehouse need?
2. Statuses and who moves them (requested, approved, ordered, in production, shipped, delivered?). Who approves: a manager, the warehouse?
3. Where does a request go: Cockpit, the Warehouse Tracker, email, or only this app for now? Recommendation: only this app plus a mock-contract record now; real hand-off later.
4. Notifications: email to whom, on which events?

**C. Sign-off and report**
1. Is sign-off per room, per job, or both? (The PDF says "job" but its lines say "this room".) Recommendation: installer ticks per room, then one job sign-off collecting installer and client signatures.
2. Client signature on the phone: name, date, finger signature, and an optional email address for the PDF? Anything legal (wording, "accepted with exceptions")?
3. What goes into the PDF: rooms with details, checklist results with notes, issues and parts raised/completed, photos? Who sends it (installer, manager, automatic) and from which mailbox?
4. Can a room be signed off while an issue is open? Recommendation: no, unless the client accepts with exceptions (recorded).

**D. Room details and integrations**
1. Which source wins when Cockpit, the master file and the Warehouse Tracker disagree? Who may enter details by hand?
2. How often should details refresh, and what happens to a job already in the field if the source changes?
3. For the mock contract, what exact fields does each system have (job id, room names, spec fields, part numbers)? Sample exports would settle this.
4. Should TBD values block anything, or just be highlighted? (Today: highlighted only.)

**E. Checklist wording and behaviour**
1. Final wording of the 11 pills and whether any should be hidden when the room's details say it does not apply (for example no crown).
2. Should "Not done" notes notify a manager?

**F. People, access and the manager side**
1. How do installers get on a project (a manager assigns them in the app, or Cockpit supplies the list)?
2. What does the manager see first: a dashboard of jobs with open issues and part requests? Which screens matter most (jobs, issues, part requests, sign-offs, invites)?
3. Does the pre-install audit come back later for managers or a different role, or is it retired?
4. How many installers work one job at the same time, and how should conflicts be shown?

**G. Operations**
1. Photo retention and how long evidence is kept; who may delete test data.
2. Real devices: which iPhone and Android models and iOS versions must work?
3. Production setup: custom domain, move off the preview address, merge PR #1 to `main` when?

## 7. Known gaps and risks

- iOS Safari cannot be tested in the build environment (storage clearing, camera and HEIC photos, keyboard, install flow). Needs real iPhone testing.
- No conflict-resolution screen: a conflicting change shows "needs attention" on the room and does not overwrite.
- No notification inbox and no emails are sent yet (an outbox table exists).
- Supabase advisor leftovers: unindexed foreign keys and some policy tuning (performance, not correctness); "leaked password protection" warning is irrelevant (no passwords are used). `anon` can execute `confirm_issue_photo` until migration 1500 is applied.
- Supervisor approval items are rejected (not implemented). Room details are entered by hand only.
- The preview address changes if the Vercel project is renamed; Supabase's Auth URL list must contain the final address.

## 8. How I work with you (rules to keep)

After each step I report: what was built, tests run with real output, what was not done, and decisions needing your approval.
I keep `docs/MILESTONES.md` and `docs/testing/` up to date. I never claim something is done that is not built and tested.

## 9. Resuming in Claude Code

Open Claude Code on repo `JHamilton-13/nextjs-basic`, branch `claude/foundation-audit-spec`. Useful first message:

> Read docs/HANDOFF.md, docs/MILESTONES.md and docs/DATABASE_SCHEMA.md. Here are my answers to the open questions: [paste]. Apply migration 1500 if I say so, then build the Add Issue screens (kinds, photos, markup, per-room lists) and tests.

Commands (from the repo root): `npm run test -w @phc/field`, `npm run test -w @phc/domain`, `bash supabase/tests/run.sh` (local database tests, nothing remote),
`npm run e2e:phone -w @phc/field`, `npm run e2e -w @phc/field`, `npm run e2e:installer -w @phc/field`.
Claude Code needs these connections: GitHub (this repo), Supabase, Vercel (all already used in earlier sessions); Cockpit is attached read-only on request.

## 10. Immediate next steps when you return

1. Say "apply 1500" (or not) to lock down the one function.
2. Settle sections 6A and 6B (issues, parts) so the Add Issue and part-request screens can be built once.
3. Run the real-phone script at the end of `docs/testing/phone-trial.md` on an iPhone and an Android and send back screenshots.
4. Decide when to delete the trial data and when to merge PR #1.

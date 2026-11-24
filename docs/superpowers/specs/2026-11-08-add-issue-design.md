# Add Issue screens: design spec

Date: 2026-11-08
Status: APPROVED by owner 2026-11-08 (go with recommendations; amendment: one Open / Completed toggle, no separate Show voided)
Parent: `docs/superpowers/specs/2026-11-08-issue-categories-and-reports-design.md` (this adds the installer screens it leaves out) and `docs/HANDOFF.md`.
Database: migrations 1400 (issues, issue photos) and 1600 (trades, void, rules) are applied.

## 1. Intent

An installer raises, photographs, completes, reopens and voids issues on a room, on a phone, with or without signal. The office later builds
the builder PDF from the Pre-Install Corrections. Part requests are out of scope.

## 2. Decisions on record (do not reopen)

- Three categories, chosen first: **Pre-Install Corrections** (kind Pre Install Correction, trade required), **Service** (Punch Item, Missing part, Damaged part), **Touch-ups** (Touch Up).
- Fields: kind (inside its category), title, description, photos; plus **Trade** for Pre-Install Corrections. No Assigned To, Priority or Due date.
- Complete, reopen, edit and void: by the **installer who raised the issue or any manager** (admin, production, project, installation manager). Other installers can see an issue but not change it.
- **Void** exists. Voided issues are kept in the database and history and are **not shown in the app** (no toggle; a way to view them can be added if wanted).
- Counts per kind and a single **Open / Completed** toggle (owner amendment 2026-11-08, replaces Show completed and the proposed Show voided).
- **Damaged part needs at least one photo** to save (the form) and to complete (the database, `photo_required`). Missing part does not.
- Installers see issues raised by other installers on the same room.
- Photos: 2048 px, quality 0.8; pen, highlighter, text, eraser; markup saves a new copy and the original is never changed. Reuse the existing photo and markup code.
- Look: Cockpit palette, phone first, 44 px touch targets, works offline.

## 3. Screens

**Room card (existing `RoomCard`).** A new **Add issue** button and an **Issues** section under the checklist.

**Issues section.** Three headings (Pre-Install Corrections, Service, Touch-ups). Counts per kind are shown as chips (five: Pre-Install, Punch, Missing, Damaged, Touch-up), each counting open issues in this room. One two-way toggle, **Open | Completed** (Open is the default); voided issues never appear in either view. Each issue card shows: kind badge, trade badge (Pre-Install only), title, description, photo thumbnails, "Raised by <name> · <date and time>" (and "Completed by ..." / "Voided by ...") and a "waiting to sync" or "needs attention" marker.

**Add Issue form (full-screen sheet).**
1. Category: three large buttons.
2. Kind: Service shows Punch Item / Missing part / Damaged part; Pre-Install Corrections and Touch-ups have one kind, chosen automatically.
3. Trade (Pre-Install only, required): pills from the trade list. Inactive trades are not offered.
4. Title (required), Description (optional).
5. Photos: **Take a photo** and **Choose from photos**; thumbnails with **Mark up**.
6. **Save** is disabled until the rules are met, with the reason shown ("Add a trade", "A damaged part needs a photo").

**Issue actions** (on an issue the person may change): **Edit** (kind, trade, title, description, while open), **Complete** (optional note), **Reopen**, **Void** (optional note, with a confirm step). Buttons for issues the person may not change are hidden; the database enforces it either way.

## 4. Offline behaviour

- Everything is written to the phone and queued in one step; nothing needs a connection. Order inside a room is kept: the issue is created before its photos are registered.
- **Trades are mirrored on the phone** (a new local list, refreshed on every sync) so the picker works offline. An issue raised offline without a required trade cannot be saved by the form; if one still arrives (an old build) the server rejects it with `trade_required` and the issue shows "needs attention", never silently dropped.
- Server rejections (`trade_required`, `trade_inactive`, `photo_required`, `issue_void`, ...) show as "needs attention" on the issue and in the Sync queue, with the reason in plain words.
- Two people changing the same issue: the later change is flagged "needs attention" (same as the checklist), never overwritten.
- Photos use the existing steps (register, upload, confirm), now against `issue_photos` and the `issue-photos` storage area.

## 5. How it fits the existing code

- **Local store (device database v5):** `trades`, `issues` (one record per issue, with who and when), and a `by_issue` index on the existing `photos` store. A photo gains an optional `issueId`; the room id is used as the queue group so an issue's operations and its photos stay in order.
- **Sync pull:** adds `trades`, `room_issues`, `issue_photos` (rows only) and my own project role, so buttons can be hidden for people who may not use them.
- **Operations:** `room_issue` with actions create, update, complete, reopen, void, through the existing `apply_op`.
- **Photos:** `addPhoto` and `addAnnotatedPhoto` take a target (audit item or issue); the sender picks the table, bucket and confirm step from it. `PhotoStrip` moves out of `AuditView` into a shared component (the audit behaviour must not change; its tests stay green).
- **Pure rules** (domain): reuse `categoryOf`, `requiresTrade`. A small `issueRules` set (can this person change this issue, what blocks Save, can it be completed) is added there with unit tests.
- **Photos taken by other installers:** their rows sync, but the image is not on this phone. The thumbnail is downloaded when the issue card is on screen and the phone is online, shrunk to a small preview and cached. Offline, such a photo shows a plain "Photo" tile.
- **Photo storage on the phone:** after the server confirms an upload, the heavy image is dropped and the preview kept (as for audits). Marking up an already-uploaded photo then needs a connection to fetch the original (existing behaviour and message).

## 6. Not in this step

Part requests, report building and sending, the manager screens (builder contact, trade list editing), the room sign-off and client signature, notifications, and any change to the checklist.

## 7. Testing (results recorded in `docs/testing/`)

- Unit (Node, fake database): create / update / complete / reopen / void operations and version chaining; the Save rules (trade required, damaged part photo, inactive trade); the person-may-change rule; trades mirror; the v4 to v5 device upgrade keeps existing data; reconcile with the server's issues; issue photos use the right table and storage area.
- Domain unit tests for `issueRules`.
- Mock server extended with trades, issues and issue photos, with the same rules as the database.
- Emulated iPhone SE, iPhone 13 and Pixel 7 with touch: add one issue in each category; trade picker with the network off; Damaged part blocked without a photo then saved with one; photo, markup and eraser on an issue; complete, reopen, void; counts and both toggles; an issue raised offline survives a reload and syncs; another installer's issue is visible but has no change buttons; 44 px targets.
- Existing suites (audit flows, checklist, markup) must stay green. A real-phone script is appended to `docs/testing/phone-trial.md`.
- Test data: the trial project only.

## 8. Open points for your review

All approved 2026-11-08 with my recommendations: 1. five per-kind count chips; 2. ONE Open | Completed toggle, voided issues not shown in the app (amended by the owner); 3. other installers' photos load on demand when online, otherwise a plain tile; 4. edit and reopen follow the raiser-or-manager rule; 5. trade list editing by managers comes later with the manager screens (trades are changed in the database until then); 6. the app fetches your own project role during sync to hide buttons you may not use.

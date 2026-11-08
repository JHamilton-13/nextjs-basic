# Reports trial: real phone and real database (PROMPT 02 step 6)

Run this on the **preview** (`https://nextjs-basic-git-claude-foundation-audit-spec-phc3.vercel.app`) with the **trial project only**.
Use only fake names and your OWN mailbox as the "builder". Nothing in this script emails a real builder.
Tick each line; write what you saw next to anything that is not as described and send me the sheet. Then I check the database side
(audit log, report rows, storage) and record the results in `docs/testing/step12-reports-trial-results.md`.

Sign in as a user who is an admin or a production, project or installation manager of the trial project. Keep a second phone or a
private window signed in as an installer of the same project for part F.

## A. Set up the trial data (installer screens, about 10 minutes)
1. [ ] Open the trial project. In **Kitchen** raise three **Pre-Install Corrections** (Add issue, Pre-Install Corrections):
   - "Supply line off by 2 in." trade **Plumbing**, with 2 photos, mark up one photo with the pen and text.
   - "No outlet on island wall" trade **Electrical**, 1 photo.
   - "Wall bowed at pantry" trade **Framing**, 3 photos. Then **Complete** this one.
2. [ ] In **Bath 1** raise one Pre-Install Correction, trade **Windows**, no photo. Then raise a second, **Void** it (it must never appear in the PDF).
3. [ ] In Bath 1 raise one **Punch Item** (Service). It must not appear in the builder PDF.
4. [ ] Kitchen checklist: tick every item Done or N/A. Bath 1: tick two items Done, mark "Finished toes" **Not done** with the note "After floor install, after 11/5".
5. [ ] Wait for "All synced" on the phone.

## B. Reports screen, before any email settings exist
6. [ ] Project screen shows **Reports and builder contact** (managers only). The installer phone does not show it.
7. [ ] Room status: Kitchen **Completed**, Bath 1 **Not completed** with the "Finished toes: After floor install, after 11/5" note and the open-issue counts you expect (Kitchen 2 open, Bath 1 1 or 2 open depending on step 2/3).
8. [ ] Builder contact: type a bad email, see the error and Save disabled. Enter name `TEST Builder`, **your own email**, a fake address, Save. Reload the page: the values are still there.
9. [ ] **Build site audit PDF**. Message says 2 or 3 identified, 1 or 2 incomplete (voided and Punch Item excluded). A report row appears as **Ready to send**.
10. [ ] **Preview PDF** opens. Check against `docs/testing/images/builder-audit-sample.pdf`:
    - [ ] cover: logo, job name, gold rule, date, "Prepared For TEST Builder", address, counts
    - [ ] rooms with a gold divider, trade badge, "Raised by: <initials> <m/d>", description
    - [ ] photos two across, numbered, each with a time and date stamp; the marked-up photo shows your pen and text
    - [ ] the voided issue and the Punch Item are NOT there; no room details or gate codes anywhere
    - [ ] page numbers "Page X of Y"
11. [ ] **Create status PDF**, preview it: Kitchen Completed, Bath 1 Not completed with the note.
12. [ ] Press **Send test to me**. Expected: the plain message that sending is not set up yet (it names the email settings). Nothing is emailed and the report stays Ready to send.

## C. After the owner adds the Vercel settings (see `docs/ops/gmail-send-setup.md`) and redeploys
13. [ ] **Send test to me**: a mail arrives in YOUR mailbox, subject starts `TEST`, the PDF is attached and opens. The report is still Ready to send.
14. [ ] **Send to builder**: the confirm box shows `TEST Builder (your email)` and "only be sent once". Press Cancel: nothing sent.
15. [ ] Press Send to builder, then **Yes, send** (try a quick double tap). Exactly ONE mail arrives. The row shows **Sent** and has no Send button.
16. [ ] Reload the page: still Sent. Open the PDF from the email: it matches the preview.
17. [ ] Build a second audit, turn **airplane mode on**, reload the Reports screen: it says reports need a connection. Turn it off: the screen returns.

## D. Who can and cannot (installer phone)
18. [ ] Installer: no Reports button on the project. Paste `/api/reports` into the browser: it says "Use POST" (never a page of errors).
19. [ ] Installer can still see the issues and checklist as before (nothing broken).

## E. What I check in the database afterwards (no action for you)
- `reports` rows: statuses, recipient, who, when, `message_id`; only the one real send is `sent`.
- `audit_log` rows for build, queue and sent, each with the project id.
- Storage: PDFs under `<project id>/<report id>.pdf` in the private `reports` bucket; none readable without a manager session.
- Security advisor after the trial.

## Results sheet
| # | Result (ok / what happened) |
| --- | --- |
| 6 |  |
| 7 |  |
| 8 |  |
| 9 |  |
| 10 |  |
| 11 |  |
| 12 |  |
| 13 |  |
| 14 |  |
| 15 |  |
| 16 |  |
| 17 |  |
| 18 |  |
| 19 |  |

Anything odd, also send a screenshot and the time you saw it (I can look up that request in the Vercel logs).

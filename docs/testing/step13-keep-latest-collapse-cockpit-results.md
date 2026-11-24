# Step 13: collapsible rooms, build on open, keep only the latest sent/printed report, Cockpit contact mapping

Date: 2026-11-08. All data is fake. **Migration 1800 was applied to project `zuyzxkkmsyuybbznelql` on 2026-11-08 after owner approval.** Live check: both new `reports` columns, `projects.contact_source`, storage policy `reports_obj_delete`, the two functions executable by `authenticated` and not `anon`, `authenticated` still SELECT-only on `reports`; security advisor shows only the expected SECURITY DEFINER notice for the two new functions. The 4 existing unsaved trial reports and their 4 files are still there and are removed by the first build.

## Owner requests and what was done
1. **Rooms collapsible.** Each room on the job screen folds from its name (48 px target), keeps its name, progress and open-issue count when folded, is remembered per job on the phone, plus Collapse all / Expand all. Room status on the Reports screen folds too. Done and pushed earlier today.
2. **Report built from the newest data when Reports is opened.** Opening the screen builds the site audit; **Rebuild site audit** refreshes it; saving the builder contact rebuilds it. Send and Print act on the shown report.
3. **Photos not on the report.** Not a defect: the trial job had only a Touch-up and a Damaged part (3 photos); the builder PDF is Pre-Install Corrections only (owner confirmed, scope unchanged), so it printed 0 issues. Raise Pre-Install Corrections with photos to see them (see `reports-trial.md`).
4. **Keep only the latest emailed or printed report; delete the rest.** One per job and report type. New `printed_at`, a Print button, `prune_reports` (rows) plus file deletion plus a sweep of unreferenced files. A new build replaces the last preview; an unsaved preview over an hour old goes; a send in flight is never touched. The four trial reports already stored (all unsaved previews) are removed automatically by the first build after 1800 is applied.
5. **Address and builder from Cockpit, editable.** Read-only reference (`PHC-Cockpit-Dev`): `Project.address` and `Project.builder`, MasterFile header fields `projectAddress`, `builder`, `contact`, `contactEmail`. `mapCockpitProject` maps address, "prepared for" (builder name, else contact name) and email only; gate codes, notes and phone numbers are never read. `projectContactSql` + `packages/domain/scripts/cockpit-project-sql.ts` print one UPDATE for the owner to approve (no live Cockpit link, by rule). `projects.contact_source` shows "Filled in from Cockpit" vs "Entered by hand"; a manager edit on the Reports screen sets it to manual.

## Results
| Suite | Result |
| --- | --- |
| Domain | 166 passed |
| `@phc/reports` | 106 passed |
| Field unit | 135 passed |
| Database | PASSED: 548 assertions + concurrency |
| Reports screen (3 phones) | 123 checks passed |
| Bundled function against the mock | 17 checks passed |
| Installer view / offline / phone | 28 / 80 / 297 passed |

## Not done / needs a decision
- The new functions have not yet run for real (needs a manager session): the trial script checks them.
- No project-creation screen exists yet (projects are created in the database), so "edit on project creation" has nothing to attach to; the edit is on the Reports screen.
- Cockpit data is not fetched live. To fill a job: export its Cockpit record as JSON, run the script, approve the printed SQL.
- "Printed" means the manager pressed Print (the app cannot see the printer).

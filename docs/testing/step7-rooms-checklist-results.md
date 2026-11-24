# Step 7 results: installer rooms, details and completion checklist (2026-11-08)

What was built: the installer app now opens a job to its rooms. Each room card shows its details (read-only) and an 11-pill completion
checklist. The pre-install audit screens are hidden from installers (kept in the code behind `VITE_SHOW_AUDIT=1`, which the older
e2e suites use). Migrations 1200 (room details) and 1300 (room checklist) are applied to the live project.

## Checklist behaviour (owner decisions)
- 11 pills: matches plans, doors & drawers, fillers, crown/sub crown, light apron/bottoms, finished toes, accessories inside, shelves, hardware, cabinetry clean, caulk/fast caps/nail holes.
- One tap = Done. Tapping a marked pill opens a panel: Done, Not done, N/A, Clear. Not done requires a note (e.g. "Toe skins installed after wood floor installation. After 11/5"); the server enforces it.
- Who marked it and the on-site time are kept; works offline through the same outbox as everything else; untick is kept in the audit log.
- "All punch items" / "touch ups complete" from the sign-off sheet are NOT pills: they will be derived from open issues when issues exist.

## Tests run (real output)
```
tsc --noEmit                      clean
apps/field vitest                 Test Files 7 passed, Tests 92 passed   (+11: checklist logic, SQL/app item-list match, v3->v4 device upgrade)
packages/domain vitest            Test Files 5 passed, Tests 122 passed
supabase/tests/run.sh             PASSED: 313 assertions + concurrency checks   (+37 across migrations 1200 and 1300)
e2e:phone  (iPhone SE/13, Pixel 7) PHONE CHECKS PASSED: 180 checks              (+63: room details, one-tap done, not-done note rule, N/A, untick, offline tick + reload + sync, 44px targets)
e2e        (offline, audit flows)  E2E PASSED: 74 checks
e2e:installer (real default build) INSTALLER VIEW CHECKS PASSED: 7 checks       (no audit button/rows/wording; rooms open; tick syncs)
```

## Not tested / not done
- Real iPhone/Android hardware (same caveats as step 6).
- Add issue, missing part, damaged part, part requests, room and job sign-off, client signature: NOT built yet.
- Room details are only entered by hand (managers); no import from Cockpit / master file / Warehouse Tracker (mock contract only).
- A checklist tick that conflicts (two people, same item, offline) shows "needs attention" on the room; there is still no conflict-resolution screen.
- The mock server stands in for Supabase in e2e; the live checks were done with SQL against the real project when each migration was applied.

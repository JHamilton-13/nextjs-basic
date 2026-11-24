# Step 1 test results — packages/domain

Date: 2026-11-08. Runner: Vitest 3.2.7, Node 22.23.4. Typecheck: `tsc --noEmit` (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes) — clean.

## Full run (verbatim)

```

> @phc/domain@0.1.0 test
> vitest run


 RUN  v3.2.7 /home/user/nextjs-basic/packages/domain

 ✓ test/units.test.ts (20 tests) 10ms
 ✓ test/readiness.test.ts (38 tests) 12ms
 ✓ test/sync.test.ts (22 tests) 14ms
 ✓ test/tolerance.test.ts (21 tests) 12ms
 ✓ test/evidence.test.ts (13 tests) 8ms

 Test Files  5 passed (5)
      Tests  114 passed (114)
   Start at  00:30:18
   Duration  744ms (transform 273ms, setup 0ms, collect 442ms, tests 57ms, environment 2ms, prepare 467ms)

```

## Process notes
- Tests were written before the implementation. First run: all 5 test files failed with "Cannot find module" (no implementation). Units/tolerance went green on the first implementation run; evidence/readiness/sync likewise. No test failed after implementation, so there are no failed-test resolutions to record for this step.
- Mutation sanity check (temporary edits to `src/tolerance.ts`, reverted; final run 114/114 green):
  - PASS bounds made exclusive: 6 tests failed (caught).
  - REVIEW band made exclusive: 5 tests failed (caught).
  - plus/minus swapped: 1 test failed (caught; only the asymmetric-tolerance test detects this, so asymmetric coverage is thin).
- Purity: `grep` of `packages/domain/src` for react/supabase/next/node imports and browser globals found none; `dependencies` is empty (only dev deps: typescript, vitest).
- `apps/web` after relocation: `next lint` clean, `next build` succeeds.

## Coverage vs spec §10 / master scenarios (domain level only)
| Scenario | Covered by |
|---|---|
| 3 critical tolerance/rough-in fail | readiness: critical FAIL -> not_ready |
| 4 installer proceeds without authorization | readiness: installer release -> override_required; installer cannot grant override |
| 5 / 19 manager approves documented exception | readiness: override grant + release with basis=override |
| 10 step without required evidence | evidence: canComplete / resolveCompletion blocked |
| 13 two users edit same record offline | sync: stale baseVersion -> conflict, data not overwritten |
| 14 device dies mid-sync | sync: sent -> recover -> pending; replay is a duplicate, applied once |
| 12 no duplicate orders (idempotency) | sync: same opId twice applies once |
| 16-20 (revision, closeout) | partial: reviseAudit invalidates overrides and revokes release; submitted audit immutable |
Not yet covered (later steps): scenarios 1, 2, 6-9, 11, 15, 17, anything needing IndexedDB, Postgres, Playwright, or PDFs.

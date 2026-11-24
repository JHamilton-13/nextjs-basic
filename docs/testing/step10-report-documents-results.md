# Step 10: report documents (PROMPT 02 step 4, plan Tasks 3 and 4)

Date: 2026-11-08. Package: `packages/reports` (`@phc/reports`). All data is fake (sample project, builder, address).

## What was built
- Brand tokens, Geist Regular/SemiBold registration, formatting rules (photo stamp `11:43 9/10/26`, cover date, `Raised by: RW 9/10`, `safeText`), photo preparation (1400 px long edge, JPEG 75, EXIF upright, never enlarged).
- `BuilderAuditDocument` (cover with counts, rooms, issues with trade badge, numbered and time-stamped photos two across, "Photo unavailable" tile, Page X of Y) and `RoomStatusDocument` (cover then a table).
- `npm run sample -w @phc/reports` writes `docs/testing/images/builder-audit-sample.pdf`, `room-status-sample.pdf` and the PNGs.

## Dependencies (one line each)
- `@react-pdf/renderer`: pure-JS PDF layout that runs in a Vercel function.
- `sharp`: resizes photos so the PDF stays under the email limit.
- `pdf-parse` (dev): reads text and page count of generated PDFs in tests.
- Geist TTFs (SIL OFL, licence copied alongside): embedded in the PDF. `PHC_LOGO.png`: converted from the supplied `.ico`.

## Tests
`npm run test -w @phc/reports`: 4 files, 30 tests pass (format 11, fonts 3, prepareImage 7, documents 9). `npx tsc --noEmit` clean.

## Found and fixed while building
- A 20-photo issue taller than a page printed a layout warning: issues with more than 4 photos may now split between pages; photo tiles never split.
- A room heading could be left alone at the foot of a page: the heading is now part of its first issue block.

## Not done
- Fulton PDF is not in the repo, so the layout follows spec section 7 and needs a visual comparison by the owner.
- Fonts were checked only through pdftoppm; not opened in Acrobat or a phone viewer.

# Step 14: user-built reports, sharing with colleagues, eraser, archived originals

Date: 2026-11-08. All data is fake. **Migration 1900 is written and tested locally but NOT applied (awaiting owner approval).** Do not use the live Reports screen before it is applied: the screen sends options and calls `mark_report_shared`, which do not exist yet.

## Owner requests and what was done
| Request | Done |
| --- | --- |
| Option to show completed rooms or only open/incomplete | Room status choice: Do not show / Rooms not completed only / All rooms |
| Remove numbers at the end of rows | The status table (with its "Open" count column) is gone; rooms are sections, no row-end numbers |
| Pictures with annotations or without, one or the other | Photos choice: Marked-up (original if never marked up) / Original only / None; there is no way to ask for both |
| Archive original when annotated | Original is kept (never deleted); once a marked-up copy exists the issue shows only the copy, with "Show archived original" (labelled, no Mark up button). Reports use the copy or the original as chosen |
| Eraser not visible | Eraser was in the build but only as a plain word; now "⌫ Eraser" with a hint over the photo ("Highlight" renamed "Marker" so it no longer truncates). The Sync queue screen now shows the app version so a stale cached copy on a phone is easy to spot |
| Service items on the service/status PDF, regardless of status, incomplete ones always listed; empty rooms optional | Service report preset (Punch, Missing, Damaged, open and completed); room status preset also lists open service items; "Also list rooms with nothing to show" toggle |
| User-buildable report | Report builder: presets (Builder site audit, Service report, Room status, Custom), issue types, issue status, room status, empty rooms, photos; the PDF cover says what it shows |
| Print, email to builder, email/share with coworkers | Print; Send to builder (once, any report type); Email colleagues (typed addresses on the PHC domain only, up to 10, repeatable, each a copy marked internal). Sharing counts as saving the report (latest per type kept) |

## Decisions recorded
Originals: keep, hide in app. Coworkers: typed addresses ending in the PHC domain (Vercel setting `PHC_EMAIL_DOMAIN`, not in the repo). Builder email once-only; coworker shares repeatable.

## Results
| Suite | Result |
| --- | --- |
| Domain | 188 passed |
| `@phc/reports` | 130 passed |
| Field unit | 139 passed |
| Database | PASSED: 575 assertions + concurrency |
| Reports screen (3 phones) | 156 checks passed |
| Bundled function against the mock | 21 checks passed |
| Installer view / phone | 28 / 300 passed |
| Offline | 81 passed on re-run. The first run in the full sequence failed once ("the issue is saved on the phone and shows waiting to sync"); it passed when run alone straight afterwards, so I am treating it as a timing flake and have not changed that test |

## Not done / not verified
- Migration 1900 not applied; the new database functions have not run against real Supabase.
- Native phone Share sheet not added (it cannot say who received it, so it would not fit the keep-the-latest rule); sharing is by email.
- "Room status with open items" assumes the status report should also list open service items; change the preset if you want it different.
- The eraser fix is not proven on your phone: please check the app version on the Sync queue screen first.

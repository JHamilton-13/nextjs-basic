# Step 6 test results — phone readiness (emulated) before a real-phone trial

Date: 2026-11-08. Real Chromium with device emulation (touch, mobile user agent, device viewports): iPhone SE (320x568, the smallest), iPhone 13 (390x664), Pixel 7 (412x839).
**This is not a substitute for a real phone**: iOS Safari is WebKit and is not available here, and the camera, HEIC, touch feel, battery and real mobile networks were not tested.
Run it with `npm run e2e:phone -w @phc/field` (screenshots go to `$PHONE_SHOTS`).

## What each device is checked for (verbatim result, 105 checks)
```
== build (pointing the app at the mock server)
== iPhone SE
ok - iPhone SE: viewport meta allows full-screen (notch) layout
ok - iPhone SE: the app asked the browser to protect its offline data from automatic clearing
ok - iPhone SE project list: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE project list: every tap target is at least 44x44
ok - iPhone SE project list: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE start audit: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE start audit: every tap target is at least 44x44
ok - iPhone SE start audit: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE audit top: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE audit top: every tap target is at least 44x44
ok - iPhone SE audit top: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE measurement card: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE measurement card: every tap target is at least 44x44
ok - iPhone SE measurement card: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE MEP item: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE MEP item: every tap target is at least 44x44
ok - iPhone SE MEP item: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE: a 12-megapixel photo is processed in under 10 s (took 0.2 s)
ok - iPhone SE: the stored photo is a JPEG, long edge 2048 px (max 2048), 321 KiB (original 1.1 MiB kept until uploaded)
ok - iPhone SE: the photo's rotation flag was honoured (stored upright 1536x2048, not sideways)
ok - iPhone SE annotation editor: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE annotation editor: every tap target is at least 44x44
ok - iPhone SE annotation editor: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE: a finger stroke on the photo draws a mark
ok - iPhone SE: drawing with a finger does not scroll the page
ok - iPhone SE: pen + highlighter + text saved as a marked-up copy from touch input
ok - iPhone SE: the finger path was kept as an editable stroke (pen:5, highlight:3, text:0)
ok - iPhone SE: reloads offline and shows Offline (badge says "Offline")
ok - iPhone SE sync queue: no sideways scrolling (overflow 0px at 320px wide)
ok - iPhone SE sync queue: every tap target is at least 44x44
ok - iPhone SE sync queue: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone SE: the app shows how much device storage it uses and whether it is protected (Device storage Not protected from automatic clearing Running in the browser Usin)
ok - iPhone SE: a server that never answers is given up on after a few seconds and the change shows "will retry" (took 0.0 s; limit in the test build 3 s)
ok - iPhone SE: the Sync button is usable again after the attempt times out
ok - iPhone SE: once the server answers again, everything syncs
== iPhone 13
ok - iPhone 13: viewport meta allows full-screen (notch) layout
ok - iPhone 13: the app asked the browser to protect its offline data from automatic clearing
ok - iPhone 13 project list: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 project list: every tap target is at least 44x44
ok - iPhone 13 project list: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13 start audit: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 start audit: every tap target is at least 44x44
ok - iPhone 13 start audit: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13 audit top: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 audit top: every tap target is at least 44x44
ok - iPhone 13 audit top: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13 measurement card: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 measurement card: every tap target is at least 44x44
ok - iPhone 13 measurement card: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13 MEP item: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 MEP item: every tap target is at least 44x44
ok - iPhone 13 MEP item: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13: a 12-megapixel photo is processed in under 10 s (took 0.3 s)
ok - iPhone 13: the stored photo is a JPEG, long edge 2048 px (max 2048), 321 KiB (original 1.1 MiB kept until uploaded)
ok - iPhone 13: the photo's rotation flag was honoured (stored upright 1536x2048, not sideways)
ok - iPhone 13 annotation editor: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 annotation editor: every tap target is at least 44x44
ok - iPhone 13 annotation editor: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13: a finger stroke on the photo draws a mark
ok - iPhone 13: drawing with a finger does not scroll the page
ok - iPhone 13: pen + highlighter + text saved as a marked-up copy from touch input
ok - iPhone 13: the finger path was kept as an editable stroke (pen:5, highlight:3, text:0)
ok - iPhone 13: reloads offline and shows Offline (badge says "Offline")
ok - iPhone 13 sync queue: no sideways scrolling (overflow 0px at 390px wide)
ok - iPhone 13 sync queue: every tap target is at least 44x44
ok - iPhone 13 sync queue: text fields are at least 16px (no iOS zoom on focus)
ok - iPhone 13: the app shows how much device storage it uses and whether it is protected (Device storage Not protected from automatic clearing Running in the browser Usin)
ok - iPhone 13: a server that never answers is given up on after a few seconds and the change shows "will retry" (took 0.0 s; limit in the test build 3 s)
ok - iPhone 13: the Sync button is usable again after the attempt times out
ok - iPhone 13: once the server answers again, everything syncs
== Pixel 7
ok - Pixel 7: viewport meta allows full-screen (notch) layout
ok - Pixel 7: the app asked the browser to protect its offline data from automatic clearing
ok - Pixel 7 project list: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 project list: every tap target is at least 44x44
ok - Pixel 7 project list: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7 start audit: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 start audit: every tap target is at least 44x44
ok - Pixel 7 start audit: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7 audit top: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 audit top: every tap target is at least 44x44
ok - Pixel 7 audit top: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7 measurement card: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 measurement card: every tap target is at least 44x44
ok - Pixel 7 measurement card: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7 MEP item: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 MEP item: every tap target is at least 44x44
ok - Pixel 7 MEP item: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7: a 12-megapixel photo is processed in under 10 s (took 0.3 s)
ok - Pixel 7: the stored photo is a JPEG, long edge 2048 px (max 2048), 321 KiB (original 1.1 MiB kept until uploaded)
ok - Pixel 7: the photo's rotation flag was honoured (stored upright 1536x2048, not sideways)
ok - Pixel 7 annotation editor: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 annotation editor: every tap target is at least 44x44
ok - Pixel 7 annotation editor: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7: a finger stroke on the photo draws a mark
ok - Pixel 7: drawing with a finger does not scroll the page
ok - Pixel 7: pen + highlighter + text saved as a marked-up copy from touch input
ok - Pixel 7: the finger path was kept as an editable stroke (pen:5, highlight:3, text:0)
ok - Pixel 7: reloads offline and shows Offline (badge says "Offline")
ok - Pixel 7 sync queue: no sideways scrolling (overflow 0px at 412px wide)
ok - Pixel 7 sync queue: every tap target is at least 44x44
ok - Pixel 7 sync queue: text fields are at least 16px (no iOS zoom on focus)
ok - Pixel 7: the app shows how much device storage it uses and whether it is protected (Device storage Not protected from automatic clearing Running in the browser Usin)
ok - Pixel 7: a server that never answers is given up on after a few seconds and the change shows "will retry" (took 0.0 s; limit in the test build 3 s)
ok - Pixel 7: the Sync button is usable again after the attempt times out
ok - Pixel 7: once the server answers again, everything syncs
PHONE CHECKS PASSED: 105 checks
```
Also unchanged and green: main offline run 74/74 (3 consecutive), 122 domain + 77 app unit tests, 276 database assertions, typecheck and lint clean.

## Problems found and fixed
1. **Annotation editor unusable on a small phone.** The photo canvas covered the top bar and the tool buttons (and was stretched out of proportion), so Pen/Highlight/Text/colors could not be tapped. Fixed: the canvas is sized by measuring the space left (robust on iOS), keeps the photo's proportions, re-fits on rotation, and the toolbar was compacted into three rows.
2. **Tap targets under 44 px:** Sign out, Back, "Mark up", the color swatches (40 px) and version tabs. All now at least 44x44.
3. **A hidden native "Choose Files" control showed inside the "Add photo" button** (my CSS overrode the `hidden` attribute). Found only by looking at the screenshots, not by the automated checks.
4. **The offline data was never protected.** The spec asks the app to request persistent storage; it did not. Now requested after sign-in, and the Sync queue screen shows Protected / Not protected, Installed / in a browser, how much storage is used, a plain-language warning, and install steps for iPhone and Android.
5. **"Lie-fi" (Wi-Fi with no internet) could hang the sync for minutes.** Requests had no deadline. Now 20 s for normal requests and 120 s for photo uploads, then the change shows "will retry".
6. **The library silently retried failed reads with growing delays**, keeping an offline phone on "Syncing…" for about 15 s and multiplying the deadline. Library retries are off; our own queue handles retries.
7. **After a failed refresh the badge said "All synced".** A phone's "am I online" flag is unreliable, so the badge now goes by what actually failed.
8. **Camera rotation flag**: the app now explicitly honours it (test photo: 4032x3024 pixels with orientation 6 is stored upright at 1536x2048, about 200 KiB, from a 1.1 MiB original, in 0.2 s).
9. "Highlighter" was clipped on the smallest phone (now "Highlight"); the install help looked like plain text; on very narrow screens the header wrapped to two rows.

## Not verified / still risks
- iOS Safari specifics: IndexedDB eviction rules, storage quota in a normal tab vs installed app, `capture` camera behaviour, HEIC conversion, keyboard covering fields, safe-area/notch rendering, the install flow.
- Real touch feel while drawing (pressure, palm touches, small marks), battery and heat during long audits, large audits with dozens of photos.
- Real mobile networks (slow cellular, captive portals, switching Wi-Fi to cellular mid-upload).
- Hosting: no deployment exists. The live database lacks migration 1100 and has no project/room/template, so a trial on the live project needs the owner's approval for those first.

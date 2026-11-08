# Phone trial kit — installer PWA

Purpose: find what only a real phone can show. Automated emulation (see `step6-phone-readiness-results.md`) already checked layout, tap sizes,
touch drawing, a 12-megapixel photo with rotation flag, offline reload and a "Wi-Fi with no internet" server, in Chromium on iPhone SE/13 and Pixel 7
profiles. It could NOT test iOS Safari (WebKit), the real camera, HEIC photos, real touch feel, battery, or real mobile networks.

## Before anyone can test (owner actions; nothing here has been done on the live project)
1. **The app must be reachable from the phone over HTTPS** (service workers and the camera need a secure origin). Pick one:
   - Host the built app (`apps/field/dist`) on a static host. `apps/field/vercel.json` is ready for Vercel; Netlify/Cloudflare Pages/GitHub Pages also work (single-page-app fallback to `index.html`).
     Build settings: command `npm run build -w @phc/field`, output `apps/field/dist`, env `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (public values only; never a service/secret key).
   - or a temporary HTTPS tunnel to a build running on a computer (`npm run preview -w @phc/field`); fine for a day, not for a crew.
2. **Supabase > Authentication > URL Configuration**: add the app's HTTPS address as the Site URL / a Redirect URL (Google sign-in returns there). In Google Cloud, the OAuth client's redirect stays Supabase's callback URL.
3. **Apply migration 1100** (Revise and marked-up copies are rejected by the live server until then).
4. **Trial data in the live project** (it currently has 0 projects, rooms, templates): a project clearly named "PHONE TRIAL - delete later", one room, and the example audit template (`supabase/seed.sql`). As admin you can already create audits on any project; invite any other tester's email first (Authentication hook only lets invited emails in) and add them to the project as installer.

## Devices
Ideally one iPhone (Safari, current iOS) and one Android (Chrome), plus the oldest phone an installer actually uses. Record model, OS version, browser version.

## Script (about 30 minutes per phone)
Tick each line; write what happened, not what you expected. Take a screenshot of anything odd.

**A. Install and sign in (with signal)**
- [ ] Open the link. iPhone: Share > Add to Home Screen. Android: menu > Install app. Open the app from the new icon. Is it full-screen?
- [ ] Sign in with Google. Sign out, then sign in with the email code (is the 6-digit code easy to type? does the keyboard cover the field?).
- [ ] Projects appear. Open Sync queue: does Device storage say "Protected" and "Installed"? (iPhone: expect "Installed".)
**B. Airplane mode from here on**
- [ ] Turn on airplane mode. Close the app completely and reopen it from the icon. Does it open and show the project? Badge says Offline?
- [ ] Start a site audit. Enter wall length (try `10' 4 1/2"`, `124 1/2`, `3150 mm`) and see the live PASS / REVIEW / FAIL. Is the keyboard comfortable?
- [ ] Take a REAL photo with the camera for "Plumbing rough-ins" (portrait, then landscape). Is it upright? How long did saving take? Does the thumbnail look right?
- [ ] Mark it FAIL with a note. Banner "NOT READY"? Who/when line shown under the result?
- [ ] Mark up the photo with your finger: pen (draw an arrow shape), highlighter, text. Does the page scroll while you draw? Is the text easy to place? Undo works? Save. Reopen "Edit marks".
- [ ] Take 5-10 more photos quickly. Any slowdown, crash, or "storage" warning?
- [ ] Lock the phone for a few minutes, switch to another app, come back. Is everything still there?
- [ ] Submit the audit. Then Revise it (type a reason), change the critical item to PASS, submit again.
**C. Back online**
- [ ] Turn airplane mode off. Open the app (iPhone does not sync in the background). Sync queue: does everything go to "synced"? How long did photos take on cellular?
- [ ] Try Wi-Fi that is connected but has no internet (e.g. a hotspot with data off): does it give up after a few seconds and say "will retry"?
- [ ] Switch networks mid-sync (Wi-Fi to cellular). Any duplicates or stuck items?
**D. Check the result (owner, on a computer)**
- [ ] Supabase: the audit exists once per version, photos present and confirmed, the marked-up copy links to its original, who/when correct, version 1 untouched.
- [ ] Did the critical FAIL create a notification row for the managers (no email is sent yet)?

## What to send back
Device + OS + browser, the step number, what you saw, a screenshot, and roughly when it happened. The most valuable findings: anything lost, anything duplicated, anything that
needed a connection that should not have, anything you could not tap or read, anything that took longer than you would tolerate on a site.

## Cleanup
Delete the PHONE TRIAL project data (ask me; audit history is protected from deletion in the app on purpose) and remove test users' invites.

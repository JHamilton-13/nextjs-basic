> UPDATE 2026-11-08 (step 7): installers no longer see the pre-install audit. Use the "Rooms and checklist" script at the end of this file; the audit steps below apply only to builds with `VITE_SHOW_AUDIT=1`.

# Phone trial kit — installer PWA

Purpose: find what only a real phone can show. Automated emulation (see `step6-phone-readiness-results.md`) already checked layout, tap sizes,
touch drawing, a 12-megapixel photo with rotation flag, offline reload and a "Wi-Fi with no internet" server, in Chromium on iPhone SE/13 and Pixel 7
profiles. It could NOT test iOS Safari (WebKit), the real camera, HEIC photos, real touch feel, battery, or real mobile networks.

## Before anyone can test (owner actions; nothing here has been done on the live project)
1. **The app must be reachable from the phone over HTTPS** (service workers and the camera need a secure origin). Pick one:
   - Host the built app (`apps/field/dist`) on a static host. `vercel.json` at the repo root is ready for Vercel; Netlify/Cloudflare Pages/GitHub Pages also work (single-page-app fallback to `index.html`).
     Build settings: command `npm run build -w @phc/field`, output `apps/field/dist`, env `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (public values only; never a service/secret key).
   - or a temporary HTTPS tunnel to a build running on a computer (`npm run preview -w @phc/field`); fine for a day, not for a crew.
2. **Supabase > Authentication > URL Configuration**: add the app's HTTPS address as the Site URL / a Redirect URL (Google sign-in returns there). In Google Cloud, the OAuth client's redirect stays Supabase's callback URL.
3. **Migration 1100** — DONE 2026-11-08 (live project verified).
4. **Trial data** — DONE 2026-11-08: project "PHONE TRIAL - delete later" (id `bbbbbbbb-0000-4000-8000-000000000001`), room "Kitchen (trial)", and the EXAMPLE audit template (42 items, 8 critical). As admin you can create audits on it. To add another tester: invite their email first (the sign-in hook only lets invited emails in), then add them to the project as installer.

### Vercel setup (owner)
1. Vercel > Add New > Project > import the GitHub repo `JHamilton-13/nextjs-basic`. Leave Root Directory at the repo root (`vercel.json` supplies build command and output directory).
2. Environment variables (Production and Preview): `VITE_SUPABASE_URL` = `https://zuyzxkkmsyuybbznelql.supabase.co` and `VITE_SUPABASE_PUBLISHABLE_KEY` = the project's publishable key (Supabase > Project Settings > API Keys > `sb_publishable_...`; public by design, safe in the browser). Never add a secret/service-role key.
3. The work is on branch `claude/foundation-audit-spec`, not `main`. Either deploy that branch (Vercel gives it a preview URL) or merge PR #1 first. **Preview deployments are behind Vercel Authentication by default, which would ask every phone to log in to Vercel: turn it off for this project (Settings > Deployment Protection) or use the production domain.**
4. Copy the final HTTPS address into Supabase > Authentication > URL Configuration (Site URL and Redirect URLs).

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


## Rooms and checklist (current installer build, ~15 minutes)
1. Sign in. You should see your project(s) with "N rooms". Tap **Open rooms**.
2. Each room shows its details (Panel Name, Wood Species, Finish Name, Edgebanding). Tap **More details**: unmade decisions show in amber as TBD. Nothing labelled PHC-only should appear.
3. Tap a pill once: it turns black with a check and the room count goes up (e.g. 1/11). It should say "waiting to sync" briefly, then sync.
4. Tap the marked pill: a panel shows who marked it and when. Choose **Not done**, try to save with no note (it must refuse), then type a note and save. The note appears under the checklist.
5. Try **N/A**, then **Clear**.
6. Turn on airplane mode. Tick two pills. Close the app fully, reopen it: the ticks must still be there, shown as waiting. Turn airplane mode off: they sync and the badge returns to "All synced".
7. Check the Sync queue tab lists them as "Room checklist".
8. Send back: device, step number, what you expected vs what happened, a screenshot for anything odd (is anything hard to tap? any pill label cut off? anything too small to read outdoors?).

# Checking the report function the way Vercel packages it

Vercel ships only the files its tracer (`@vercel/nft`) can see from `api/reports.mjs`. `pdfkit` (inside `@react-pdf/renderer`) loads its
standard font files dynamically, so the tracer misses them; `vercel.json` adds them with `includeFiles`
(`packages/reports/assets/**` for our fonts and logo, `node_modules/pdfkit/js/**` for pdfkit).

First preview on Vercel crashed with `Cannot find module '.../pdfkit/js/standard-fonts/Helvetica.cjs'`. To reproduce locally:
1. In an empty scratch folder: `npm i @vercel/nft`, then trace `api/reports.mjs` from the repo root and copy the traced files plus the
   `includeFiles` globs into a second empty folder.
2. Run `API_ROOT=<that folder> npm run e2e:api -w @phc/field` (the 14 checks must pass from the copy).
Any new dynamically loaded file shows up as a "Cannot find module" error there, before it reaches Vercel.

# supabase/

- `migrations/` — ordered SQL migrations (not yet applied anywhere).
- `seed.sql` — EXAMPLE audit template for local/test use only (not a migration).
- `tests/run.sh` — builds a throwaway local Postgres 16, applies stand-ins (`tests/00_stub.sql`), all migrations and the
  seed, then runs `tests/NN_*.sql` and `tests/concurrency.sh`. Requires root or the `postgres` OS user and
  `/usr/lib/postgresql/16/bin`. It never contacts a remote project.

Run: `bash supabase/tests/run.sh`

## Applying to the remote project (ONLY after the owner approves the SQL)
1. Apply the migrations in order (Supabase CLI `db push` or the SQL editor). Do not apply `seed.sql` or `tests/` to production.
2. Dashboard > Authentication > Hooks: enable **Before User Created** with `public.hook_before_user_created`.
3. Dashboard > Authentication: enable Google and Email OTP; disable anonymous sign-ins; add redirect URLs for the PWA.
4. Bootstrap the first admin (service role / SQL editor; no secrets in the repo): insert the owner's email into `invites`,
   have them sign in once, then `update public.profiles set is_admin = true where email = '<owner email>'`.
5. Insert the company's real audit template as a new `audit_templates` row (policy + rules), replacing the example.

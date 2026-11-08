-- Follow-up to 1400: functions created after 0700's blanket revoke get Postgres's default "anyone may execute".
-- confirm_issue_photo checks auth.uid() and refuses signed-out callers, so nothing was exposed, but it must be locked down like
-- the other public functions: only signed-in users may call it.
revoke all on function public.confirm_issue_photo(uuid) from public, anon;
grant execute on function public.confirm_issue_photo(uuid) to authenticated;

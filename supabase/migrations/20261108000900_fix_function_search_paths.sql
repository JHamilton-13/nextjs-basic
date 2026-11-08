-- 0900: pin search_path on the remaining app.* helper and trigger functions (Supabase advisor 0011).
-- These do not look up unqualified objects; pinning removes any dependence on the caller's search_path.
alter function app.templates_guard() set search_path = public, pg_temp;
alter function app.audits_guard() set search_path = public, pg_temp;
alter function app.audit_items_guard() set search_path = public, pg_temp;
alter function app.photos_guard() set search_path = public, pg_temp;
alter function app.insert_only() set search_path = public, pg_temp;
alter function app.audit_log_immutable() set search_path = public, pg_temp;
alter function app.invites_guard() set search_path = public, pg_temp;
alter function app.evaluate_tolerance(integer, integer, integer, integer, integer) set search_path = public, pg_temp;
alter function app.jsonb_nonneg_int(jsonb) set search_path = public, pg_temp;
alter function app.template_config_valid(jsonb) set search_path = public, pg_temp;
alter function app.rejected(text) set search_path = public, pg_temp;
alter function app.override_roles() set search_path = public, pg_temp;
alter function app.field_roles() set search_path = public, pg_temp;

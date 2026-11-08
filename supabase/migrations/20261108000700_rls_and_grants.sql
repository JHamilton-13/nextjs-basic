-- 0700: row-level security and grants. Default stance: no access; each table is opened explicitly.
-- Writes to audits, items, measurements, overrides, releases and applied_ops happen only through the
-- SECURITY DEFINER functions in 0600 (apply_op, grant_override, release_audit, revise_audit, confirm_photo).

-- Start from zero: remove broad default privileges Supabase gives to API roles.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.rooms enable row level security;
alter table public.audit_templates enable row level security;
alter table public.audits enable row level security;
alter table public.audit_items enable row level security;
alter table public.measurements enable row level security;
alter table public.photos enable row level security;
alter table public.overrides enable row level security;
alter table public.releases enable row level security;
alter table public.applied_ops enable row level security;   -- no policies: service/definer functions only
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;
alter table public.email_outbox enable row level security;  -- no policies: service role only

grant usage on schema public to authenticated;
grant usage on schema app to authenticated;
-- helper functions are evaluated inside policies as the calling user
grant execute on function
  app.is_active(), app.is_admin(), app.project_role(uuid), app.is_member(uuid), app.has_role(uuid, public.app_role[]),
  app.is_manager_anywhere(), app.can_manage_invites(), app.shares_project_with(uuid), app.can_see_audit(uuid, integer),
  app.audit_state(uuid, integer), app.override_roles(), app.field_roles()
  to authenticated;

-- RPC surface
grant execute on function
  public.apply_op(jsonb), public.grant_override(uuid, integer, text, text[]), public.release_audit(uuid, integer),
  public.revise_audit(uuid, text), public.confirm_photo(uuid), public.audit_state(uuid, integer)
  to authenticated;

-- profiles
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (app.is_active() and (id = auth.uid() or app.is_admin() or app.shares_project_with(id)));
create policy profiles_update_self on public.profiles for update to authenticated
  using (app.is_active() and id = auth.uid()) with check (id = auth.uid());

-- invites (revoke only; never edit or delete)
grant select, insert on public.invites to authenticated;
grant update (revoked_at) on public.invites to authenticated;
create policy invites_select on public.invites for select to authenticated using (app.can_manage_invites());
create policy invites_insert on public.invites for insert to authenticated
  with check (app.can_manage_invites() and invited_by = auth.uid() and revoked_at is null);
create policy invites_revoke on public.invites for update to authenticated
  using (app.can_manage_invites()) with check (app.can_manage_invites());

-- projects
grant select, insert on public.projects to authenticated;
grant update (name, customer, address, archived_at) on public.projects to authenticated;
create policy projects_select on public.projects for select to authenticated using (app.is_member(id));
create policy projects_insert on public.projects for insert to authenticated
  with check (app.can_manage_invites() and created_by = auth.uid());
create policy projects_update on public.projects for update to authenticated
  using (app.has_role(id, array['production_manager', 'project_manager']::public.app_role[]))
  with check (app.has_role(id, array['production_manager', 'project_manager']::public.app_role[]));

-- project_members
grant select, insert, delete on public.project_members to authenticated;
grant update (role) on public.project_members to authenticated;
create policy project_members_select on public.project_members for select to authenticated using (app.is_member(project_id));
create policy project_members_insert on public.project_members for insert to authenticated
  with check (app.has_role(project_id, array['production_manager', 'project_manager']::public.app_role[]) and added_by = auth.uid());
create policy project_members_update on public.project_members for update to authenticated
  using (app.has_role(project_id, array['production_manager', 'project_manager']::public.app_role[]))
  with check (app.has_role(project_id, array['production_manager', 'project_manager']::public.app_role[]));
create policy project_members_delete on public.project_members for delete to authenticated
  using (app.has_role(project_id, array['production_manager', 'project_manager']::public.app_role[]));

-- rooms
grant select, insert, update, delete on public.rooms to authenticated;
create policy rooms_select on public.rooms for select to authenticated using (app.is_member(project_id));
create policy rooms_write on public.rooms for all to authenticated
  using (app.has_role(project_id, array['production_manager', 'project_manager', 'installation_manager']::public.app_role[]))
  with check (app.has_role(project_id, array['production_manager', 'project_manager', 'installation_manager']::public.app_role[]));

-- audit templates
grant select, insert on public.audit_templates to authenticated;
grant update (active) on public.audit_templates to authenticated;
create policy templates_select on public.audit_templates for select to authenticated using (app.is_active());
create policy templates_insert on public.audit_templates for insert to authenticated
  with check (app.can_manage_invites() and created_by = auth.uid());
create policy templates_update on public.audit_templates for update to authenticated
  using (app.can_manage_invites()) with check (app.can_manage_invites());

-- audits and everything hanging off them: read-only through the API; clients/GCs have no in-app access (see app.can_see_audit)
grant select on public.audits, public.audit_items, public.measurements, public.overrides, public.releases to authenticated;
create policy audits_select on public.audits for select to authenticated using (app.can_see_audit(audit_id, version));
create policy audit_items_select on public.audit_items for select to authenticated using (app.can_see_audit(audit_id, version));
create policy measurements_select on public.measurements for select to authenticated using (app.can_see_audit(audit_id, version));
create policy overrides_select on public.overrides for select to authenticated using (app.can_see_audit(audit_id, version));
create policy releases_select on public.releases for select to authenticated using (app.can_see_audit(audit_id, version));

-- photos: register the row first (client-generated id makes retries idempotent), then upload, then confirm_photo()
grant select, insert on public.photos to authenticated;
create policy photos_select on public.photos for select to authenticated using (app.can_see_audit(audit_id, version));
create policy photos_insert on public.photos for insert to authenticated
  with check (captured_by = auth.uid() and confirmed_at is null and app.has_role(project_id, app.field_roles()));

-- notifications
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy notifications_select on public.notifications for select to authenticated using (app.is_active() and user_id = auth.uid());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (app.is_active() and user_id = auth.uid()) with check (user_id = auth.uid());

-- audit log: managers of the project (and admins) can read; nobody writes except the change triggers
grant select on public.audit_log to authenticated;
create policy audit_log_select on public.audit_log for select to authenticated
  using (app.is_admin() or (project_id is not null and app.has_role(project_id, array['production_manager', 'project_manager']::public.app_role[])));

-- Dashboard view: latest version of each audit with its readiness. security_invoker keeps RLS in force.
create view public.project_readiness with (security_invoker = true) as
select distinct on (a.audit_id)
  a.project_id, a.audit_id, a.version, a.room_id, a.submitted_at,
  app.audit_state(a.audit_id, a.version) as state
from public.audits a
order by a.audit_id, a.version desc;
grant select on public.project_readiness to authenticated;

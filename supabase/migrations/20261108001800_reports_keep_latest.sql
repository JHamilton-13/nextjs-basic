-- 1800: keep only the latest emailed or printed report per job and type; Print; where the builder contact came from.
-- DRAFT: written as a file, shown to the owner, NOT applied until he says so.
--
-- Owner decisions 2026-11-08:
--  1. A report is "saved" once it has been emailed or printed. Only the most recent saved report per job AND report type (builder site
--     audit, room status) is kept; each new send or print replaces the previous one. Unsaved previews are throw-away: a new build of the
--     same type replaces the last preview, and any unsaved preview older than one hour is removed.
--  2. Printing is recorded (reports.printed_at / printed_by) by mark_report_printed. "Printed" means the manager pressed Print.
--  3. prune_reports(project, type, keep) does the deleting and returns the storage paths it removed so the server function can delete the
--     files too. It keeps: the report just acted on, the newest saved report of that type, and any send still in flight (queued under
--     10 minutes). Deleting is logged in the audit log by the existing trigger (the history of what was sent stays there).
--  4. Managers may delete files in the 'reports' bucket (needed to remove the PDFs of pruned reports). Rows are only ever deleted by
--     prune_reports; there is still no direct delete on the table.
--  5. projects.contact_source records whether the address and builder contact came from Cockpit or were entered by a manager.
-- Nothing in this file touches audits, issues, photos or their storage.

alter table public.reports
  add column printed_by uuid references public.profiles (id),
  add column printed_at timestamptz,
  add constraint reports_printed_pair check ((printed_by is null) = (printed_at is null));

alter table public.projects
  add column contact_source text check (contact_source is null or contact_source in ('cockpit', 'manual'));
-- who may edit follows the existing projects_update policy
grant update (contact_source) on public.projects to authenticated;

-- a manager may delete report files (the rows are removed by prune_reports only)
create policy reports_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'reports' and app.report_path_project(name) is not null and app.has_role(app.report_path_project(name), app.override_roles()));

create function public.mark_report_printed(p_report_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports;
begin
  if auth.uid() is null or not app.is_active() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_report_id for update;
  if not found or not app.has_role(r.project_id, app.override_roles()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status = 'queued' and r.queued_at > now() - interval '10 minutes' then raise exception 'report_already_queued' using errcode = '55000'; end if;
  update public.reports set printed_at = now(), printed_by = auth.uid() where id = p_report_id;
end $$;

create function public.prune_reports(p_project uuid, p_type text, p_keep uuid) returns text[]
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare v_newest_saved uuid; v_paths text[];
begin
  if auth.uid() is null or not app.is_active() or not app.has_role(p_project, app.override_roles()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type not in ('builder_site_audit', 'room_status') then raise exception 'unknown report type' using errcode = '22023'; end if;
  select id into v_newest_saved from public.reports
    where project_id = p_project and report_type = p_type and (sent_at is not null or printed_at is not null)
    order by greatest(coalesce(sent_at, '-infinity'), coalesce(printed_at, '-infinity')) desc, built_at desc limit 1;
  with gone as (
    delete from public.reports r
    where r.project_id = p_project
      and not (r.status = 'queued' and r.queued_at > now() - interval '10 minutes')           -- a send in flight is never touched
      and (
        (r.report_type = p_type and r.id is distinct from p_keep and r.id is distinct from v_newest_saved)
        or (r.sent_at is null and r.printed_at is null and r.built_at < now() - interval '1 hour')
      )
    returning r.storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from gone;
  return v_paths;
end $$;

revoke all on function public.mark_report_printed(uuid) from public, anon;
revoke all on function public.prune_reports(uuid, text, uuid) from public, anon;
grant execute on function public.mark_report_printed(uuid) to authenticated;
grant execute on function public.prune_reports(uuid, text, uuid) to authenticated;

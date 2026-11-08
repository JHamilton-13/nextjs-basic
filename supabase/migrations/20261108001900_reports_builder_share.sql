-- 1900: user-built reports and sharing with colleagues. DRAFT: written as a file, shown to the owner, NOT applied until he says so.
--
-- Owner decisions 2026-11-08:
--  1. A manager builds a report from options (which issue kinds, open/completed, room status, empty rooms, photos). The built report is
--     one of four types for the keep-the-latest rule: builder_site_audit, room_status, service, custom. The options used are stored.
--  2. A report can be emailed to colleagues inside PHC any number of times (only the builder email is once-only). mark_report_shared
--     records who it reached; that counts as saving the report, exactly like a send or a print (the newest saved one per job and type is
--     kept). The PHC-domain check happens in the server function (the domain is a Vercel setting, not stored in the repo); the database
--     checks that every address is a valid address and that there are at most 10.
--  3. prune_reports now treats "shared" as saved too.
-- Nothing in this file touches audits, issues, photos or their storage.

alter table public.reports drop constraint reports_report_type_check;
alter table public.reports
  add constraint reports_report_type_check check (report_type in ('builder_site_audit', 'room_status', 'service', 'custom')),
  add column options jsonb check (options is null or jsonb_typeof(options) = 'object'),
  add column shared_by uuid references public.profiles (id),
  add column shared_at timestamptz,
  add column shared_to text[],
  add constraint reports_shared_together check ((shared_by is null) = (shared_at is null) and (shared_at is null) = (shared_to is null)),
  add constraint reports_shared_to_size check (shared_to is null or (cardinality(shared_to) between 1 and 10));

-- create_report gains the options (null for reports made before this change); the old five-argument version is replaced
drop function public.create_report(uuid, uuid, text, text, integer);
create function public.create_report(p_id uuid, p_project uuid, p_type text, p_path text, p_bytes integer, p_options jsonb default null) returns public.reports
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports;
begin
  if auth.uid() is null or not app.is_active() or not app.has_role(p_project, app.override_roles()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.reports (id, project_id, report_type, storage_path, file_size, built_by, options)
  values (p_id, p_project, p_type, p_path, p_bytes, auth.uid(), p_options) returning * into r;
  return r;
end $$;
revoke all on function public.create_report(uuid, uuid, text, text, integer, jsonb) from public, anon;
grant execute on function public.create_report(uuid, uuid, text, text, integer, jsonb) to authenticated;

create function public.mark_report_shared(p_report_id uuid, p_emails text[]) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports; e text;
begin
  if auth.uid() is null or not app.is_active() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_report_id for update;
  if not found or not app.has_role(r.project_id, app.override_roles()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_emails is null or cardinality(p_emails) = 0 then raise exception 'invalid_recipient' using errcode = '22023'; end if;
  if cardinality(p_emails) > 10 then raise exception 'too_many_recipients' using errcode = '22023'; end if;
  foreach e in array p_emails loop
    if not app.is_valid_email(e) then raise exception 'invalid_recipient' using errcode = '22023'; end if;
  end loop;
  if r.status = 'queued' and r.queued_at > now() - interval '10 minutes' then raise exception 'report_already_queued' using errcode = '55000'; end if;
  update public.reports set shared_at = now(), shared_by = auth.uid(), shared_to = p_emails where id = p_report_id;
end $$;
revoke all on function public.mark_report_shared(uuid, text[]) from public, anon;
grant execute on function public.mark_report_shared(uuid, text[]) to authenticated;

-- same rule as migration 1800, with "shared" counted as saved
create or replace function public.prune_reports(p_project uuid, p_type text, p_keep uuid) returns text[]
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare v_newest_saved uuid; v_paths text[];
begin
  if auth.uid() is null or not app.is_active() or not app.has_role(p_project, app.override_roles()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type not in ('builder_site_audit', 'room_status', 'service', 'custom') then raise exception 'unknown report type' using errcode = '22023'; end if;
  select id into v_newest_saved from public.reports
    where project_id = p_project and report_type = p_type and (sent_at is not null or printed_at is not null or shared_at is not null)
    order by greatest(coalesce(sent_at, '-infinity'), coalesce(printed_at, '-infinity'), coalesce(shared_at, '-infinity')) desc, built_at desc limit 1;
  with gone as (
    delete from public.reports r
    where r.project_id = p_project
      and not (r.status = 'queued' and r.queued_at > now() - interval '10 minutes')
      and (
        (r.report_type = p_type and r.id is distinct from p_keep and r.id is distinct from v_newest_saved)
        or (r.sent_at is null and r.printed_at is null and r.shared_at is null and r.built_at < now() - interval '1 hour')
      )
    returning r.storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from gone;
  return v_paths;
end $$;

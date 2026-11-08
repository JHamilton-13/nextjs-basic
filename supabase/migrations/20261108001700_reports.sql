-- 1700: reports (builder site audit PDF and room status PDF). DRAFT: written as a file, shown to the owner, NOT applied until he says so.
--
-- What this adds (owner decisions 2026-11-08, plan amendments 2, 3 and 7):
--  1. public.reports: one row per built PDF. Status built -> queued -> sent, or failed. A report sends ONCE: queue_report_send refuses a
--     report that is queued (unless it has been queued for more than 10 minutes) or already sent. Failed and stuck-queued reports can retry.
--  2. Only managers (admin, production, project, installation manager of the project) read, build or send reports. Installers, general
--     contractors, clients and warehouse users cannot see them. There is no direct insert/update/delete: rows are written by the
--     functions below, which check the role and write to the audit log through the same trigger as every other table.
--  3. Private storage bucket 'reports', object path '<project id>/<report id>.pdf'. Managers of that project may upload and read; nobody
--     may update or delete (a rebuild is a new report).
--  4. Functions (called by the signed-in manager through the existing Vercel server function, never with a service key):
--       create_report(id, project, type, path, bytes) -> reports       records a stored PDF (status built)
--       queue_report_send(id, recipient name, recipient email) -> reports   claims the one send (the email is validated here too)
--       mark_report_sent(id, gmail message id)                          queued -> sent
--       mark_report_failed(id, error text)                              queued -> failed (retryable)
-- Nothing in this file touches the audit tables, issues, photos or their storage.

create table public.reports (
  id uuid primary key,
  project_id uuid not null references public.projects (id),
  report_type text not null check (report_type in ('builder_site_audit', 'room_status')),
  storage_path text not null unique,
  file_size integer not null check (file_size > 0 and file_size <= 18 * 1024 * 1024),
  recipient_name text check (recipient_name is null or (btrim(recipient_name) <> '' and char_length(recipient_name) <= 200)),
  recipient_email text check (recipient_email is null or app.is_valid_email(recipient_email)),
  built_by uuid not null references public.profiles (id),
  built_at timestamptz not null default now(),
  queued_at timestamptz,
  sent_by uuid references public.profiles (id),
  sent_at timestamptz,
  message_id text,
  status text not null default 'built' check (status in ('built', 'queued', 'sent', 'failed')),
  error text check (error is null or char_length(error) <= 1000),
  constraint reports_path_matches check (storage_path = project_id::text || '/' || id::text || '.pdf'),
  constraint reports_sent_pair check ((status = 'sent') = (sent_at is not null))
);
create index reports_project_idx on public.reports (project_id, built_at desc);

alter table public.reports enable row level security;
grant select on public.reports to authenticated;
create policy reports_select on public.reports for select to authenticated
  using (app.is_active() and app.has_role(project_id, app.override_roles()));
create trigger log_reports after insert or update or delete on public.reports for each row execute function app.log_change('id');

-- ---------------------------------------------------------------------------------------------------------------
-- storage: private bucket, manager of the project only; no update or delete policy
-- ---------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 18 * 1024 * 1024, array['application/pdf']) on conflict (id) do nothing;

create function app.report_path_project(p_name text) returns uuid
  language plpgsql immutable set search_path = public, pg_temp
  as $$ begin return split_part(p_name, '/', 1)::uuid; exception when others then return null; end $$;

create policy reports_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'reports' and app.report_path_project(name) is not null and app.has_role(app.report_path_project(name), app.override_roles()));
create policy reports_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'reports' and app.report_path_project(name) is not null and app.has_role(app.report_path_project(name), app.override_roles()));

-- ---------------------------------------------------------------------------------------------------------------
-- functions
-- ---------------------------------------------------------------------------------------------------------------
create function public.create_report(p_id uuid, p_project uuid, p_type text, p_path text, p_bytes integer) returns public.reports
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports;
begin
  if auth.uid() is null or not app.is_active() or not app.has_role(p_project, app.override_roles()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.reports (id, project_id, report_type, storage_path, file_size, built_by)
  values (p_id, p_project, p_type, p_path, p_bytes, auth.uid()) returning * into r;
  return r;
end $$;

create function public.queue_report_send(p_report_id uuid, p_recipient_name text, p_recipient_email text) returns public.reports
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports; v_name text := nullif(btrim(coalesce(p_recipient_name, '')), '');
begin
  if auth.uid() is null or not app.is_active() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_report_id for update;
  if not found or not app.has_role(r.project_id, app.override_roles()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not app.is_valid_email(p_recipient_email) then raise exception 'invalid_recipient' using errcode = '22023'; end if;
  if r.status = 'sent' then raise exception 'report_already_sent' using errcode = '55000'; end if;
  if r.status = 'queued' and r.queued_at > now() - interval '10 minutes' then raise exception 'report_already_queued' using errcode = '55000'; end if;
  update public.reports set status = 'queued', queued_at = now(), recipient_name = v_name, recipient_email = p_recipient_email,
    sent_by = auth.uid(), error = null where id = p_report_id returning * into r;
  return r;
end $$;

create function public.mark_report_sent(p_report_id uuid, p_message_id text) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports;
begin
  if auth.uid() is null or not app.is_active() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_report_id for update;
  if not found or not app.has_role(r.project_id, app.override_roles()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status = 'sent' then raise exception 'report_already_sent' using errcode = '55000'; end if;
  if r.status <> 'queued' then raise exception 'report_not_queued' using errcode = '55000'; end if;
  update public.reports set status = 'sent', sent_at = now(), message_id = left(p_message_id, 300), error = null where id = p_report_id;
end $$;

create function public.mark_report_failed(p_report_id uuid, p_error text) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare r public.reports;
begin
  if auth.uid() is null or not app.is_active() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = p_report_id for update;
  if not found or not app.has_role(r.project_id, app.override_roles()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status = 'sent' then raise exception 'report_already_sent' using errcode = '55000'; end if;
  if r.status <> 'queued' then raise exception 'report_not_queued' using errcode = '55000'; end if;
  update public.reports set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 1000) where id = p_report_id;
end $$;

-- same lock-down as confirm_issue_photo (migration 1500): signed-in users only, never anon or public
revoke all on function public.create_report(uuid, uuid, text, text, integer) from public, anon;
revoke all on function public.queue_report_send(uuid, text, text) from public, anon;
revoke all on function public.mark_report_sent(uuid, text) from public, anon;
revoke all on function public.mark_report_failed(uuid, text) from public, anon;
grant execute on function public.create_report(uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.queue_report_send(uuid, text, text) to authenticated;
grant execute on function public.mark_report_sent(uuid, text) to authenticated;
grant execute on function public.mark_report_failed(uuid, text) to authenticated;

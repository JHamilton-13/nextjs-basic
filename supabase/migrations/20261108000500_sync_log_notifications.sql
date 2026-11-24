-- 0500: idempotency ledger, append-only audit log (with change triggers), notifications and email outbox.

create table public.applied_ops (
  op_id uuid primary key,
  entity text not null,
  entity_id text not null,
  actor uuid not null references public.profiles (id),
  outcome jsonb not null,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  table_name text not null,
  record_id text,
  project_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_project_idx on public.audit_log (project_id, at desc);

create function app.audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_no_update_delete before update or delete on public.audit_log for each row execute function app.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.audit_log_immutable();

-- Generic change logger. tg_argv[0] is a comma-separated list of the columns that identify the row.
create function app.log_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  r jsonb; o jsonb; det jsonb; rid text; pid uuid;
begin
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  select string_agg(r ->> c, ':' order by ord) into rid from unnest(string_to_array(tg_argv[0], ',')) with ordinality as t(c, ord);
  pid := nullif(r ->> 'project_id', '')::uuid;
  if pid is null and r ? 'audit_id' then
    select a.project_id into pid from public.audits a where a.audit_id = (r ->> 'audit_id')::uuid limit 1;
  end if;
  if tg_op = 'INSERT' then
    det := jsonb_build_object('new', r);
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old);
    det := jsonb_build_object(
      'old', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(o) where r -> key is distinct from value),
      'new', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(r) where o -> key is distinct from value));
  else
    det := jsonb_build_object('old', r);
  end if;
  insert into public.audit_log (actor, action, table_name, record_id, project_id, details)
  values (auth.uid(), tg_op, tg_table_name, rid, pid, det);
  return null;
end $$;

create trigger log_profiles after insert or update or delete on public.profiles for each row execute function app.log_change('id');
create trigger log_invites after insert or update or delete on public.invites for each row execute function app.log_change('id');
create trigger log_projects after insert or update or delete on public.projects for each row execute function app.log_change('id');
create trigger log_project_members after insert or update or delete on public.project_members for each row execute function app.log_change('project_id,user_id');
create trigger log_rooms after insert or update or delete on public.rooms for each row execute function app.log_change('id');
create trigger log_audit_templates after insert or update or delete on public.audit_templates for each row execute function app.log_change('id');
create trigger log_audits after insert or update or delete on public.audits for each row execute function app.log_change('audit_id,version');
create trigger log_audit_items after insert or update or delete on public.audit_items for each row execute function app.log_change('audit_id,version,item_key');
create trigger log_measurements after insert or update or delete on public.measurements for each row execute function app.log_change('id');
create trigger log_photos after insert or update or delete on public.photos for each row execute function app.log_change('id');
create trigger log_overrides after insert or update or delete on public.overrides for each row execute function app.log_change('id');
create trigger log_releases after insert or update or delete on public.releases for each row execute function app.log_change('id');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  user_id uuid not null references public.profiles (id),
  type text not null,
  priority text not null check (priority in ('low', 'normal', 'high', 'critical')),
  message text not null,
  related_audit_id uuid,
  related_version integer,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- No live email in this build: rows are queued for a later sender.
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

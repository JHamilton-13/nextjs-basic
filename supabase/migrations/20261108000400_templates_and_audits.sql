-- 0400: audit templates, audits (one row per audit VERSION), items, measurements, photos, overrides, releases.

create table public.audit_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  version integer not null check (version >= 1),
  config jsonb not null,
  active boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (name, version),
  constraint audit_templates_config_valid check (app.template_config_valid(config))
);

-- Published template versions are immutable; publish a new version instead. Only `active` may change.
create function app.templates_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'audit templates cannot be deleted; deactivate instead' using errcode = '42501'; end if;
  if new.id is distinct from old.id or new.name is distinct from old.name or new.version is distinct from old.version
     or new.config is distinct from old.config or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'a published audit template version is immutable; create a new version' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger audit_templates_guard before update or delete on public.audit_templates for each row execute function app.templates_guard();

create table public.audits (
  audit_id uuid not null,
  version integer not null check (version >= 1),
  project_id uuid not null references public.projects (id),
  room_id uuid references public.rooms (id),
  template_id uuid not null references public.audit_templates (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  -- optimistic-lock counter used by apply_op: 1 at creation, +1 when submitted
  row_version integer not null default 1,
  submitted_at timestamptz,
  submitted_by uuid references public.profiles (id),
  revise_reason text,
  primary key (audit_id, version),
  unique (audit_id, version, project_id),
  constraint audits_submit_pair check ((submitted_at is null) = (submitted_by is null)),
  constraint audits_revision_reason check (version = 1 or (revise_reason is not null and btrim(revise_reason) <> ''))
);
create index audits_project_idx on public.audits (project_id);

-- Submitted audits are immutable. Unsubmitted ones may only change row_version and the submit columns.
create function app.audits_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'audits cannot be deleted' using errcode = '42501';
  end if;
  if old.submitted_at is not null then
    raise exception 'audit_submitted: a submitted audit is immutable; revise it to create a new version' using errcode = '42501';
  end if;
  if new.audit_id is distinct from old.audit_id or new.version is distinct from old.version or new.project_id is distinct from old.project_id
     or new.room_id is distinct from old.room_id or new.template_id is distinct from old.template_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.revise_reason is distinct from old.revise_reason then
    raise exception 'audit identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger audits_guard before update or delete on public.audits for each row execute function app.audits_guard();

create table public.audit_items (
  audit_id uuid not null,
  version integer not null,
  item_key text not null,
  section_key text not null,
  label text not null,
  kind text not null check (kind in ('check', 'tolerance', 'observation')),
  critical boolean not null,
  result public.item_result not null default 'NOT_ENTERED',
  note text,
  drawing_ref text,
  row_version integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  primary key (audit_id, version, item_key),
  foreign key (audit_id, version) references public.audits (audit_id, version) on delete cascade,
  constraint audit_items_observation_not_critical check (not (kind = 'observation' and critical))
);

create function app.audit_items_guard() returns trigger language plpgsql as $$
declare v_submitted timestamptz; v_aid uuid; v_ver integer;
begin
  v_aid := case when tg_op = 'DELETE' then old.audit_id else new.audit_id end;
  v_ver := case when tg_op = 'DELETE' then old.version else new.version end;
  select submitted_at into v_submitted from public.audits where audit_id = v_aid and version = v_ver;
  if v_submitted is not null then
    raise exception 'audit_submitted: items of a submitted audit are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then raise exception 'audit items cannot be deleted' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and (new.item_key is distinct from old.item_key or new.section_key is distinct from old.section_key
     or new.label is distinct from old.label or new.kind is distinct from old.kind or new.critical is distinct from old.critical) then
    raise exception 'audit item definition is immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger audit_items_guard before insert or update or delete on public.audit_items for each row execute function app.audit_items_guard();

-- Every measurement ever entered is kept (insert-only). The item row holds the current result.
create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null,
  version integer not null,
  item_key text not null,
  expected_64 integer not null,
  actual_64 integer not null,
  plus_64 integer not null check (plus_64 >= 0),
  minus_64 integer not null check (minus_64 >= 0),
  review_band_64 integer check (review_band_64 is null or review_band_64 >= greatest(plus_64, minus_64)),
  source text not null,
  source_ref text not null,
  method text not null,
  user_id uuid not null references public.profiles (id),
  measured_at timestamptz not null,
  drawing_ref text,
  note text,
  deviation_64 integer not null,
  result public.item_result not null,
  created_at timestamptz not null default now(),
  foreign key (audit_id, version, item_key) references public.audit_items (audit_id, version, item_key),
  constraint measurements_deviation check (deviation_64 = actual_64 - expected_64),
  constraint measurements_result check (result = app.evaluate_tolerance(actual_64, expected_64, plus_64, minus_64, review_band_64))
);
create index measurements_item_idx on public.measurements (audit_id, version, item_key);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  audit_id uuid not null,
  version integer not null,
  item_key text,
  storage_path text not null unique,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes > 0),
  captured_by uuid not null references public.profiles (id),
  captured_at timestamptz not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (audit_id, version, project_id) references public.audits (audit_id, version, project_id),
  foreign key (audit_id, version, item_key) references public.audit_items (audit_id, version, item_key)
);
create index photos_item_idx on public.photos (audit_id, version, item_key);

-- A photo row may only gain confirmed_at (set once, after the upload is verified). It is never edited or deleted.
create function app.photos_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'photos cannot be deleted' using errcode = '42501'; end if;
  if old.confirmed_at is not null or new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.audit_id is distinct from old.audit_id or new.version is distinct from old.version
     or new.item_key is distinct from old.item_key or new.storage_path is distinct from old.storage_path
     or new.checksum_sha256 is distinct from old.checksum_sha256 or new.bytes is distinct from old.bytes
     or new.captured_by is distinct from old.captured_by or new.captured_at is distinct from old.captured_at
     or new.created_at is distinct from old.created_at then
    raise exception 'photo records are immutable except for one-time confirmation' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger photos_guard before update or delete on public.photos for each row execute function app.photos_guard();

-- Overrides authorize release of ONE audit version. Immutable once written.
create table public.overrides (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null,
  version integer not null,
  granted_by uuid not null references public.profiles (id),
  role public.app_role not null,
  reason text not null check (btrim(reason) <> ''),
  supporting_doc_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (audit_id, version) references public.audits (audit_id, version),
  unique (id, audit_id, version)
);

create table public.releases (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null,
  version integer not null,
  released_by uuid not null references public.profiles (id),
  role public.app_role not null,
  basis text not null check (basis in ('clear', 'override')),
  override_id uuid,
  created_at timestamptz not null default now(),
  unique (audit_id, version),
  foreign key (audit_id, version) references public.audits (audit_id, version),
  foreign key (override_id, audit_id, version) references public.overrides (id, audit_id, version),
  constraint releases_basis_override check ((basis = 'override') = (override_id is not null))
);

create function app.insert_only() returns trigger language plpgsql as $$
begin
  raise exception '% is insert-only; % is not allowed', tg_table_name, tg_op using errcode = '42501';
end $$;
create trigger overrides_insert_only before update or delete on public.overrides for each row execute function app.insert_only();
create trigger releases_insert_only before update or delete on public.releases for each row execute function app.insert_only();
create trigger measurements_insert_only before update or delete on public.measurements for each row execute function app.insert_only();

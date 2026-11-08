-- Room issues: things an installer raises on a room (an issue to fix, a missing part, a damaged part), with photos.
-- Everything here is ADDITIVE: the audit evidence tables, photo rules and storage policies are not touched.
--  * Kinds follow Cockpit's Site Request (pre install correction, punch item, touch up) plus missing part and damaged part.
--  * Written only through apply_op (entity 'room_issue', entityId = the issue's client-generated uuid): works offline, idempotent,
--    records who raised it / completed it and the on-site time. Actions: create, update, complete, reopen. Nothing is deleted.
--  * Photos live in their own table and private bucket, with the same register -> upload -> confirm steps and the same
--    annotation rules as audit photos (originals are never changed; marks are saved as a separate copy).
--  * Clients and general contractors cannot read issues (no in-app access for them).

create type public.issue_kind as enum ('pre_install_correction', 'punch_item', 'touch_up', 'missing_part', 'damaged_part');

create function app.can_see_issues(p_project uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.is_active() and (
      app.is_admin() or (app.project_role(p_project) is not null and app.project_role(p_project) not in ('general_contractor', 'client'))
    )
  $$;

create table public.room_issues (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind public.issue_kind not null,
  title text not null check (btrim(title) <> '' and char_length(title) <= 200),
  description text check (description is null or char_length(description) <= 2000),
  raised_by uuid not null references public.profiles (id),
  raised_at timestamptz not null,
  completed_by uuid references public.profiles (id),
  completed_at timestamptz,
  completed_note text check (completed_note is null or char_length(completed_note) <= 500),
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint room_issues_completed_pair check ((completed_by is null) = (completed_at is null)),
  constraint room_issues_note_needs_completion check (completed_note is null or completed_by is not null),
  unique (id, project_id)
);
create index room_issues_room_idx on public.room_issues (room_id);
create index room_issues_project_idx on public.room_issues (project_id);

alter table public.room_issues enable row level security;
grant select on public.room_issues to authenticated;
create policy room_issues_select on public.room_issues for select to authenticated using (app.can_see_issues(project_id));
create trigger log_room_issues after insert or update or delete on public.room_issues for each row execute function app.log_change('id');

-- ---- photos on issues ----
create table public.issue_photos (
  id uuid primary key,
  project_id uuid not null,
  issue_id uuid not null,
  storage_path text not null unique,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes > 0),
  captured_by uuid not null references public.profiles (id),
  captured_at timestamptz not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  annotated_from uuid references public.issue_photos (id),
  annotations jsonb check (annotations is null or app.annotations_valid(annotations)),
  constraint issue_photos_annotation_pair check ((annotated_from is null) = (annotations is null)),
  foreign key (issue_id, project_id) references public.room_issues (id, project_id)
);
create index issue_photos_issue_idx on public.issue_photos (issue_id);

create function app.issue_photos_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'photos cannot be deleted' using errcode = '42501'; end if;
  if old.confirmed_at is not null or new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.issue_id is distinct from old.issue_id or new.storage_path is distinct from old.storage_path
     or new.checksum_sha256 is distinct from old.checksum_sha256 or new.bytes is distinct from old.bytes
     or new.captured_by is distinct from old.captured_by or new.captured_at is distinct from old.captured_at
     or new.created_at is distinct from old.created_at
     or new.annotated_from is distinct from old.annotated_from or new.annotations is distinct from old.annotations then
    raise exception 'photo records are immutable except for one-time confirmation' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger issue_photos_guard before update or delete on public.issue_photos for each row execute function app.issue_photos_guard();

create function app.issue_photos_annotation_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare o public.issue_photos;
begin
  if new.annotated_from is null then return new; end if;
  select * into o from public.issue_photos where id = new.annotated_from;
  if not found then raise exception 'annotation_original_not_found' using errcode = '23503'; end if;
  if o.annotated_from is not null then raise exception 'cannot annotate an annotated copy; annotate the original' using errcode = '23514'; end if;
  if o.issue_id <> new.issue_id then raise exception 'an annotated copy must belong to the same issue as its original' using errcode = '23514'; end if;
  return new;
end $$;
create trigger issue_photos_annotation_guard before insert on public.issue_photos for each row execute function app.issue_photos_annotation_guard();

alter table public.issue_photos enable row level security;
grant select, insert on public.issue_photos to authenticated;
create policy issue_photos_select on public.issue_photos for select to authenticated using (app.can_see_issues(project_id));
create policy issue_photos_insert on public.issue_photos for insert to authenticated
  with check (captured_by = auth.uid() and confirmed_at is null and app.has_role(project_id, app.field_roles()));
create trigger log_issue_photos after insert or update or delete on public.issue_photos for each row execute function app.log_change('id');

insert into storage.buckets (id, name, public) values ('issue-photos', 'issue-photos', false) on conflict (id) do nothing;
create policy issue_photos_obj_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'issue-photos'
    and exists (select 1 from public.issue_photos p where p.storage_path = name and p.captured_by = auth.uid() and p.confirmed_at is null)
  );
create policy issue_photos_obj_select on storage.objects for select to authenticated
  using (
    bucket_id = 'issue-photos'
    and exists (select 1 from public.issue_photos p where p.storage_path = name and app.can_see_issues(p.project_id))
  );

create function public.confirm_issue_photo(p_photo_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_p public.issue_photos; v_found boolean; v_size bigint;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from public.issue_photos where id = p_photo_id for update;
  if not found then raise exception 'photo_not_found'; end if;
  if not (v_p.captured_by = v_uid or app.has_role(v_p.project_id, app.override_roles())) then
    raise exception 'role_not_authorized' using errcode = '42501';
  end if;
  if v_p.confirmed_at is not null then return; end if;
  select true, (o.metadata ->> 'size')::bigint into v_found, v_size
    from storage.objects o where o.bucket_id = 'issue-photos' and o.name = v_p.storage_path limit 1;
  if v_found is not true then raise exception 'upload_not_found'; end if;
  if v_size is distinct from v_p.bytes then
    raise exception 'size_mismatch' using detail = format('registered %s bytes, stored %s bytes', v_p.bytes, coalesce(v_size::text, 'unknown'));
  end if;
  update public.issue_photos set confirmed_at = now() where id = p_photo_id;
end $$;

-- ---- the write path ----
create function app.op_room_issue(p_uid uuid, p_eid text, p_base integer, p_payload jsonb, p_op_created timestamptz) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_id uuid; v_action text := p_payload ->> 'action'; v_i public.room_issues; v_room public.rooms;
  v_title text := nullif(btrim(coalesce(p_payload ->> 'title', '')), '');
  v_desc text := nullif(btrim(coalesce(p_payload ->> 'description', '')), '');
  v_note text := nullif(btrim(coalesce(p_payload ->> 'note', '')), '');
  v_kind public.issue_kind;
begin
  begin v_id := p_eid::uuid; exception when others then return app.rejected('entityId must be the issue id (a uuid)'); end;
  if v_action is null or v_action not in ('create', 'update', 'complete', 'reopen') then return app.rejected('action must be create, update, complete or reopen'); end if;
  if v_title is not null and char_length(v_title) > 200 then return app.rejected('title is too long (200 characters)'); end if;
  if v_desc is not null and char_length(v_desc) > 2000 then return app.rejected('description is too long (2000 characters)'); end if;
  if v_note is not null and char_length(v_note) > 500 then return app.rejected('note is too long (500 characters)'); end if;
  if p_payload ? 'kind' then
    begin v_kind := (p_payload ->> 'kind')::public.issue_kind; exception when others then return app.rejected('unknown issue kind'); end;
  end if;

  if v_action = 'create' then
    if p_base <> 0 then return app.rejected('a new issue starts at version 0'); end if;
    begin select * into v_room from public.rooms where id = (p_payload ->> 'roomId')::uuid; exception when others then return app.rejected('roomId must be a uuid'); end;
    if not found then return app.rejected('room not found'); end if;
    if not app.has_role(v_room.project_id, app.field_roles()) then
      raise exception 'insufficient privilege to raise issues on this project' using errcode = '42501';
    end if;
    if v_kind is null then return app.rejected('kind is required'); end if;
    if v_title is null then return app.rejected('a title is required'); end if;
    select * into v_i from public.room_issues where id = v_id;
    if found then return jsonb_build_object('status', 'conflict', 'currentVersion', v_i.row_version, 'baseVersion', p_base); end if;
    insert into public.room_issues (id, project_id, room_id, kind, title, description, raised_by, raised_at)
    values (v_id, v_room.project_id, v_room.id, v_kind, v_title, v_desc, p_uid, p_op_created);
    return jsonb_build_object('status', 'applied', 'newVersion', 1);
  end if;

  select * into v_i from public.room_issues where id = v_id for update;
  if not found then return app.rejected('issue not found'); end if;
  if not app.has_role(v_i.project_id, app.field_roles()) then
    raise exception 'insufficient privilege to change issues on this project' using errcode = '42501';
  end if;
  if p_base <> v_i.row_version then
    return jsonb_build_object('status', 'conflict', 'currentVersion', v_i.row_version, 'baseVersion', p_base);
  end if;

  if v_action = 'update' then
    if v_i.completed_at is not null then return app.rejected('issue_completed'); end if;
    if v_kind is null and v_title is null and not (p_payload ? 'description') then return app.rejected('nothing to change'); end if;
    update public.room_issues set kind = coalesce(v_kind, kind), title = coalesce(v_title, title),
      description = case when p_payload ? 'description' then v_desc else description end, row_version = row_version + 1 where id = v_id;
  elsif v_action = 'complete' then
    if v_i.completed_at is not null then return app.rejected('already_completed'); end if;
    update public.room_issues set completed_by = p_uid, completed_at = p_op_created, completed_note = v_note, row_version = row_version + 1 where id = v_id;
  else -- reopen
    if v_i.completed_at is null then return app.rejected('not_completed'); end if;
    update public.room_issues set completed_by = null, completed_at = null, completed_note = null, row_version = row_version + 1 where id = v_id;
  end if;
  return jsonb_build_object('status', 'applied', 'newVersion', v_i.row_version + 1);
end $$;

-- apply_op: same function as before plus the 'room_issue' entity.
create or replace function public.apply_op(op jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid();
  v_op_id uuid; v_entity text; v_eid text; v_base integer; v_created timestamptz;
  v_prior jsonb; v_prior_actor uuid; v_out jsonb;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  if jsonb_typeof(op) is distinct from 'object' then return app.rejected('op must be an object'); end if;
  begin v_op_id := (op ->> 'opId')::uuid; exception when others then return app.rejected('opId must be a UUID'); end;
  v_entity := btrim(coalesce(op ->> 'entity', '')); v_eid := btrim(coalesce(op ->> 'entityId', ''));
  if v_entity = '' or v_eid = '' then return app.rejected('entity and entityId are required'); end if;
  if op ->> 'actor' is distinct from v_uid::text then return app.rejected('actor does not match the authenticated user'); end if;
  -- Explicit ISO 8601 with a zone only: Postgres would otherwise accept words like 'yesterday', 'now' or 'infinity'.
  if coalesce(op ->> 'createdAt', '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
    return app.rejected('createdAt must be an ISO 8601 date-time with a time zone');
  end if;
  begin v_created := (op ->> 'createdAt')::timestamptz; exception when others then return app.rejected('createdAt must be a valid date-time'); end;
  if jsonb_typeof(op -> 'baseVersion') is distinct from 'number' or not app.jsonb_nonneg_int(op -> 'baseVersion') then
    return app.rejected('baseVersion must be a non-negative integer');
  end if;
  v_base := (op ->> 'baseVersion')::integer;
  if jsonb_typeof(op -> 'payload') is distinct from 'object' then return app.rejected('payload must be an object'); end if;

  -- Serialize concurrent retries of the same opId, then replay the recorded outcome if there is one.
  perform pg_advisory_xact_lock(hashtextextended(v_op_id::text, 0));
  select outcome, actor into v_prior, v_prior_actor from public.applied_ops where op_id = v_op_id;
  if found then
    if v_prior_actor <> v_uid then raise exception 'opId belongs to another user' using errcode = '42501'; end if;
    return jsonb_build_object('status', 'duplicate', 'original', v_prior);
  end if;

  if v_entity = 'audit' then
    v_out := app.op_audit(v_uid, v_eid, v_base, op -> 'payload');
  elsif v_entity = 'audit_item' then
    v_out := app.op_audit_item(v_uid, v_eid, v_base, op -> 'payload', v_created);
  elsif v_entity = 'room_check' then
    v_out := app.op_room_check(v_uid, v_eid, v_base, op -> 'payload', v_created);
  elsif v_entity = 'room_issue' then
    v_out := app.op_room_issue(v_uid, v_eid, v_base, op -> 'payload', v_created);
  else
    return app.rejected('unsupported entity: ' || v_entity);
  end if;

  -- Rejections are not recorded (a corrected retry may succeed); applied and conflict outcomes are.
  if v_out ->> 'status' <> 'rejected' then
    insert into public.applied_ops (op_id, entity, entity_id, actor, outcome) values (v_op_id, v_entity, v_eid, v_uid, v_out);
  end if;
  return v_out;
end $$;

-- Per-room completion checklist (installer pills). One row per room and item once someone has acted on it.
-- States: done (pill selected), not_done (installer says it is not finished; a note explaining why is REQUIRED,
-- e.g. "Toe skins installed after wood floor installation. After 11/5"), na (does not apply to this room).
-- "No row" means nobody has acted on that item yet. Writes go only through apply_op (entity 'room_check',
-- entityId <room_id>:<item_key>), so they work offline, are idempotent and record who and when (on-site time).
-- Untick = payload {"state":"clear"}, which removes the row; the audit log keeps the history.

create function app.room_check_keys() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['cabinetry_matches_plans', 'doors_drawers_adjusted', 'fillers', 'crown', 'light_apron_bottoms',
               'finished_toes', 'accessories_inside', 'shelves', 'hardware', 'clean', 'finishing']
$$;

create table public.room_checks (
  room_id uuid not null references public.rooms (id) on delete cascade,
  item_key text not null check (item_key = any (app.room_check_keys())),
  project_id uuid not null references public.projects (id) on delete cascade,
  state text not null check (state in ('done', 'not_done', 'na')),
  note text check (note is null or char_length(note) <= 500),
  checked_by uuid not null references public.profiles (id),
  checked_at timestamptz not null,
  row_version integer not null default 1,
  primary key (room_id, item_key),
  constraint room_checks_not_done_needs_note check (state <> 'not_done' or (note is not null and btrim(note) <> ''))
);
create index room_checks_project_idx on public.room_checks (project_id);

alter table public.room_checks enable row level security;
grant select on public.room_checks to authenticated;
create policy room_checks_select on public.room_checks for select to authenticated using (app.is_member(project_id));
create trigger log_room_checks after insert or update or delete on public.room_checks for each row execute function app.log_change('room_id,item_key');

create function app.op_room_check(p_uid uuid, p_eid text, p_base integer, p_payload jsonb, p_op_created timestamptz) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_room uuid; v_key text; v_project uuid; v_state text := p_payload ->> 'state';
  v_note text := nullif(btrim(coalesce(p_payload ->> 'note', '')), '');
  v_cur public.room_checks; v_cur_ver integer;
begin
  begin
    v_room := split_part(p_eid, ':', 1)::uuid; v_key := split_part(p_eid, ':', 2);
  exception when others then return app.rejected('entityId must be <room_id>:<item_key>');
  end;
  if not (v_key = any (app.room_check_keys())) then return app.rejected('unknown checklist item'); end if;
  select project_id into v_project from public.rooms where id = v_room;
  if not found then return app.rejected('room not found'); end if;
  if not app.has_role(v_project, app.field_roles()) then
    raise exception 'insufficient privilege to update the room checklist on this project' using errcode = '42501';
  end if;
  if v_state is null or v_state not in ('done', 'not_done', 'na', 'clear') then return app.rejected('state must be done, not_done, na or clear'); end if;
  if v_state = 'not_done' and v_note is null then return app.rejected('a note is required when an item is not done'); end if;
  if v_note is not null and char_length(v_note) > 500 then return app.rejected('note is too long (500 characters)'); end if;

  select * into v_cur from public.room_checks where room_id = v_room and item_key = v_key for update;
  v_cur_ver := case when found then v_cur.row_version else 0 end;
  if p_base <> v_cur_ver then
    return jsonb_build_object('status', 'conflict', 'currentVersion', v_cur_ver, 'baseVersion', p_base);
  end if;

  if v_state = 'clear' then
    delete from public.room_checks where room_id = v_room and item_key = v_key;
    return jsonb_build_object('status', 'applied', 'newVersion', 0);
  end if;
  insert into public.room_checks (room_id, item_key, project_id, state, note, checked_by, checked_at)
  values (v_room, v_key, v_project, v_state, v_note, p_uid, p_op_created)
  on conflict (room_id, item_key) do update
    set state = excluded.state, note = excluded.note, checked_by = excluded.checked_by, checked_at = excluded.checked_at,
        row_version = public.room_checks.row_version + 1;
  return jsonb_build_object('status', 'applied', 'newVersion', (select row_version from public.room_checks where room_id = v_room and item_key = v_key));
end $$;

-- apply_op: same function as before plus the 'room_check' entity.
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
  else
    return app.rejected('unsupported entity: ' || v_entity);
  end if;

  -- Rejections are not recorded (a corrected retry may succeed); applied and conflict outcomes are.
  if v_out ->> 'status' <> 'rejected' then
    insert into public.applied_ops (op_id, entity, entity_id, actor, outcome) values (v_op_id, v_entity, v_eid, v_uid, v_out);
  end if;
  return v_out;
end $$;

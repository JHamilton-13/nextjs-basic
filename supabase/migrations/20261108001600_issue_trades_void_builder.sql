-- 1600: issue categories support. DRAFT: written as a file, shown to the owner, NOT applied until he says so.
--
-- What this adds (owner decisions 2026-11-08):
--  1. trades: a short list (plumbing, electrical, ...) that managers edit; rows are deactivated, never deleted.
--  2. room_issues.trade_id: required for a Pre Install Correction, not allowed on any other kind. New and edited rows only
--     (the CHECK is NOT VALID, so rows that existed before this migration are not rejected). The friendly rejection through
--     apply_op is the message 'trade_required'.
--  3. Void: an issue can be voided (kept in history, hidden by default in the app). Who may void is the same as who may
--     edit, complete or reopen: the person who raised it, or any manager (admin, production, project, installation manager).
--  4. A Damaged part issue cannot be completed until it has at least one original photo registered on it.
--     (It cannot be required at creation because a photo points at an issue that must exist first.)
--  5. projects.prepared_for_name / prepared_for_email: the builder contact a manager enters for the report. The site address
--     is the existing projects.address column (no new column).
-- Reports tables, storage and sending are NOT here: they come in a later migration (owner decision: split).
-- Nothing in this file touches the audit tables, audit photos or their storage.

-- ---------------------------------------------------------------------------------------------------------------
-- (1) trades
-- ---------------------------------------------------------------------------------------------------------------
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and char_length(name) <= 60),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index trades_name_key on public.trades (lower(btrim(name)));

create function app.trades_no_delete() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'trades cannot be deleted; deactivate them instead' using errcode = '42501';
end $$;
create trigger trades_no_delete before delete on public.trades for each row execute function app.trades_no_delete();

-- installers and managers (anyone who can raise issues somewhere) read trades; only admins and production/project managers edit them
create function app.can_read_trades() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.is_active() and (
      app.is_admin() or exists (select 1 from public.project_members pm where pm.user_id = auth.uid() and pm.role = any (app.field_roles()))
    )
  $$;
create function app.can_manage_trades() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select app.can_manage_invites() $$;

alter table public.trades enable row level security;
grant select, insert on public.trades to authenticated;
grant update (name, sort_order, active) on public.trades to authenticated;
create policy trades_select on public.trades for select to authenticated using (app.can_read_trades());
create policy trades_insert on public.trades for insert to authenticated with check (app.can_manage_trades());
create policy trades_update on public.trades for update to authenticated using (app.can_manage_trades()) with check (app.can_manage_trades());
create trigger log_trades after insert or update or delete on public.trades for each row execute function app.log_change('id');

insert into public.trades (name, sort_order) values
  ('Plumbing', 10), ('Electrical', 20), ('HVAC', 30), ('Windows', 40), ('Framing', 50),
  ('Cabinetry', 60), ('Drywall', 70), ('Flooring', 80), ('Other', 90);

-- ---------------------------------------------------------------------------------------------------------------
-- (2) + (3) trade and void columns on issues
-- ---------------------------------------------------------------------------------------------------------------
alter table public.room_issues
  add column trade_id uuid references public.trades (id),
  add column voided_by uuid references public.profiles (id),
  add column voided_at timestamptz,
  add column void_note text check (void_note is null or char_length(void_note) <= 500),
  add constraint room_issues_void_pair check ((voided_by is null) = (voided_at is null)),
  add constraint room_issues_void_note_needs_void check (void_note is null or voided_by is not null),
  add constraint room_issues_trade_rule check ((kind = 'pre_install_correction') = (trade_id is not null)) not valid;
create index room_issues_trade_idx on public.room_issues (trade_id);

-- ---------------------------------------------------------------------------------------------------------------
-- (5) builder contact on projects
-- ---------------------------------------------------------------------------------------------------------------
-- Same rules as isValidEmail() in packages/domain: no spaces or list/quote characters, one @, a dotted domain, a 2+ letter ending.
create function app.is_valid_email(s text) returns boolean
  language sql immutable set search_path = public, pg_temp
  as $$
    select s is not null
      and char_length(s) between 3 and 254
      and s !~ '[\s,;<>()\[\]\\"]'
      and s ~ '^[^@]+@[^@]+$'
      and char_length(split_part(s, '@', 1)) <= 64
      and split_part(s, '@', 1) !~ '^\.|\.$|\.\.'
      and split_part(s, '@', 2) ~ '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'
  $$;

alter table public.projects
  add column prepared_for_name text check (prepared_for_name is null or (btrim(prepared_for_name) <> '' and char_length(prepared_for_name) <= 200)),
  add column prepared_for_email text check (prepared_for_email is null or app.is_valid_email(prepared_for_email));
-- The existing projects_update policy decides who (production and project managers, and admins); this only adds the two columns.
grant update (prepared_for_name, prepared_for_email) on public.projects to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- (2) (3) (4) the write path: create, update, complete, reopen, void
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.op_room_issue(p_uid uuid, p_eid text, p_base integer, p_payload jsonb, p_op_created timestamptz) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_id uuid; v_action text := p_payload ->> 'action'; v_i public.room_issues; v_room public.rooms; v_t public.trades;
  v_title text := nullif(btrim(coalesce(p_payload ->> 'title', '')), '');
  v_desc text := nullif(btrim(coalesce(p_payload ->> 'description', '')), '');
  v_note text := nullif(btrim(coalesce(p_payload ->> 'note', '')), '');
  v_kind public.issue_kind;
  v_trade_given boolean := p_payload ? 'tradeId'; v_trade uuid;
  v_new_kind public.issue_kind; v_new_trade uuid;
begin
  begin v_id := p_eid::uuid; exception when others then return app.rejected('entityId must be the issue id (a uuid)'); end;
  if v_action is null or v_action not in ('create', 'update', 'complete', 'reopen', 'void') then
    return app.rejected('action must be create, update, complete, reopen or void');
  end if;
  if v_title is not null and char_length(v_title) > 200 then return app.rejected('title is too long (200 characters)'); end if;
  if v_desc is not null and char_length(v_desc) > 2000 then return app.rejected('description is too long (2000 characters)'); end if;
  if v_note is not null and char_length(v_note) > 500 then return app.rejected('note is too long (500 characters)'); end if;
  if p_payload ? 'kind' then
    begin v_kind := (p_payload ->> 'kind')::public.issue_kind; exception when others then return app.rejected('unknown issue kind'); end;
  end if;
  if v_trade_given and jsonb_typeof(p_payload -> 'tradeId') <> 'null' then
    begin v_trade := (p_payload ->> 'tradeId')::uuid; exception when others then return app.rejected('tradeId must be a uuid'); end;
  end if;

  -- ---- create ----
  if v_action = 'create' then
    if p_base <> 0 then return app.rejected('a new issue starts at version 0'); end if;
    begin select * into v_room from public.rooms where id = (p_payload ->> 'roomId')::uuid; exception when others then return app.rejected('roomId must be a uuid'); end;
    if not found then return app.rejected('room not found'); end if;
    if not app.has_role(v_room.project_id, app.field_roles()) then
      raise exception 'insufficient privilege to raise issues on this project' using errcode = '42501';
    end if;
    if v_kind is null then return app.rejected('kind is required'); end if;
    if v_title is null then return app.rejected('a title is required'); end if;
    if v_kind = 'pre_install_correction' then
      if v_trade is null then return app.rejected('trade_required'); end if;
      select * into v_t from public.trades where id = v_trade;
      if not found then return app.rejected('trade_not_found'); end if;
      if not v_t.active then return app.rejected('trade_inactive'); end if;
    elsif v_trade is not null then
      return app.rejected('trade_not_allowed');
    end if;
    select * into v_i from public.room_issues where id = v_id;
    if found then return jsonb_build_object('status', 'conflict', 'currentVersion', v_i.row_version, 'baseVersion', p_base); end if;
    insert into public.room_issues (id, project_id, room_id, kind, trade_id, title, description, raised_by, raised_at)
    values (v_id, v_room.project_id, v_room.id, v_kind, v_trade, v_title, v_desc, p_uid, p_op_created);
    return jsonb_build_object('status', 'applied', 'newVersion', 1);
  end if;

  -- ---- everything else changes an existing issue ----
  select * into v_i from public.room_issues where id = v_id for update;
  if not found then return app.rejected('issue not found'); end if;
  if not app.has_role(v_i.project_id, app.field_roles()) then
    raise exception 'insufficient privilege to change issues on this project' using errcode = '42501';
  end if;
  -- owner decision: the person who raised it, or any manager
  if v_i.raised_by <> p_uid and not app.has_role(v_i.project_id, app.override_roles()) then
    raise exception 'insufficient privilege: only the person who raised an issue, or a manager, can change it' using errcode = '42501';
  end if;
  if p_base <> v_i.row_version then
    return jsonb_build_object('status', 'conflict', 'currentVersion', v_i.row_version, 'baseVersion', p_base);
  end if;
  if v_i.voided_at is not null then return app.rejected('issue_void'); end if;

  if v_action = 'update' then
    if v_i.completed_at is not null then return app.rejected('issue_completed'); end if;
    if v_kind is null and v_title is null and not (p_payload ? 'description') and not v_trade_given then return app.rejected('nothing to change'); end if;
    v_new_kind := coalesce(v_kind, v_i.kind);
    v_new_trade := case when v_trade_given then v_trade else v_i.trade_id end;
    if v_new_kind = 'pre_install_correction' then
      if v_new_trade is null then return app.rejected('trade_required'); end if;
      if v_new_trade is distinct from v_i.trade_id then            -- an existing (maybe since deactivated) trade may stay; a new choice must be active
        select * into v_t from public.trades where id = v_new_trade;
        if not found then return app.rejected('trade_not_found'); end if;
        if not v_t.active then return app.rejected('trade_inactive'); end if;
      end if;
    else
      if v_trade is not null then return app.rejected('trade_not_allowed'); end if;
      v_new_trade := null;                                         -- changing to another kind drops the trade
    end if;
    update public.room_issues set kind = v_new_kind, trade_id = v_new_trade, title = coalesce(v_title, title),
      description = case when p_payload ? 'description' then v_desc else description end, row_version = row_version + 1 where id = v_id;

  elsif v_action = 'complete' then
    if v_i.completed_at is not null then return app.rejected('already_completed'); end if;
    if v_i.kind = 'damaged_part' and not exists (select 1 from public.issue_photos p where p.issue_id = v_id and p.annotated_from is null) then
      return app.rejected('photo_required');                       -- a Damaged part needs at least one original photo
    end if;
    update public.room_issues set completed_by = p_uid, completed_at = p_op_created, completed_note = v_note, row_version = row_version + 1 where id = v_id;

  elsif v_action = 'reopen' then
    if v_i.completed_at is null then return app.rejected('not_completed'); end if;
    update public.room_issues set completed_by = null, completed_at = null, completed_note = null, row_version = row_version + 1 where id = v_id;

  else -- void
    update public.room_issues set voided_by = p_uid, voided_at = p_op_created, void_note = v_note, row_version = row_version + 1 where id = v_id;
  end if;
  return jsonb_build_object('status', 'applied', 'newVersion', v_i.row_version + 1);
end $$;

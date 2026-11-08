-- 1100: (1) photo annotations as editable vector data on a separate annotated copy, (2) who/when on each audit item and
-- on the issue it raises, (3) revising an audit as a queued, offline-capable operation, (4) earlier-version photos still
-- count as evidence after a revision, and annotated copies never count as extra evidence.

-- ---------------------------------------------------------------------------------------------------------------
-- (1) annotations: an annotated copy is its own photos row pointing at the untouched original
-- ---------------------------------------------------------------------------------------------------------------
alter table public.photos add column annotated_from uuid references public.photos (id);
alter table public.photos add column annotations jsonb;
alter table public.photos add constraint photos_annotation_pair check ((annotated_from is null) = (annotations is null));
create index photos_annotated_from_idx on public.photos (annotated_from);

-- Shapes use coordinates normalized to the image (0..1), so they stay correct at any display or export size.
--   pen / highlight: {type, color '#rrggbb', width 0..0.2 (fraction of image width), points [[x,y],...] (1..2000)}
--   text:            {type, color, size 0.005..0.3 (fraction of image height), at [x,y], text (1..200 chars)}
create function app.annotations_valid(a jsonb) returns boolean
  language plpgsql immutable set search_path = public, pg_temp
  as $$
declare
  s jsonb; pt jsonb; t text; n integer;
begin
  if a is null or jsonb_typeof(a) <> 'array' then return false; end if;
  n := jsonb_array_length(a);
  if n < 1 or n > 200 then return false; end if;
  for s in select * from jsonb_array_elements(a) loop
    if jsonb_typeof(s) <> 'object' then return false; end if;
    t := s ->> 'type';
    if t is null or t not in ('pen', 'highlight', 'text') then return false; end if;
    if coalesce(s ->> 'color', '') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
    if t in ('pen', 'highlight') then
      if jsonb_typeof(s -> 'width') <> 'number' or (s ->> 'width')::numeric <= 0 or (s ->> 'width')::numeric > 0.2 then return false; end if;
      if jsonb_typeof(s -> 'points') <> 'array' or jsonb_array_length(s -> 'points') < 1 or jsonb_array_length(s -> 'points') > 2000 then return false; end if;
      for pt in select * from jsonb_array_elements(s -> 'points') loop
        if jsonb_typeof(pt) <> 'array' or jsonb_array_length(pt) <> 2 then return false; end if;
        if jsonb_typeof(pt -> 0) <> 'number' or jsonb_typeof(pt -> 1) <> 'number' then return false; end if;
        if (pt ->> 0)::numeric not between 0 and 1 or (pt ->> 1)::numeric not between 0 and 1 then return false; end if;
      end loop;
    else
      if jsonb_typeof(s -> 'text') <> 'string' or length(btrim(s ->> 'text')) < 1 or length(s ->> 'text') > 200 then return false; end if;
      if jsonb_typeof(s -> 'size') <> 'number' or (s ->> 'size')::numeric < 0.005 or (s ->> 'size')::numeric > 0.3 then return false; end if;
      pt := s -> 'at';
      if jsonb_typeof(pt) <> 'array' or jsonb_array_length(pt) <> 2 or jsonb_typeof(pt -> 0) <> 'number' or jsonb_typeof(pt -> 1) <> 'number' then return false; end if;
      if (pt ->> 0)::numeric not between 0 and 1 or (pt ->> 1)::numeric not between 0 and 1 then return false; end if;
    end if;
  end loop;
  return true;
end $$;

alter table public.photos add constraint photos_annotations_valid check (annotations is null or app.annotations_valid(annotations));

-- An annotated copy must belong to the same audit and item as its original, and only originals can be annotated.
create function app.photos_annotation_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare o public.photos;
begin
  if new.annotated_from is null then return new; end if;
  select * into o from public.photos where id = new.annotated_from;
  if not found then raise exception 'annotation_original_not_found' using errcode = '23503'; end if;
  if o.annotated_from is not null then raise exception 'cannot annotate an annotated copy; annotate the original' using errcode = '23514'; end if;
  if o.audit_id <> new.audit_id or o.project_id <> new.project_id or o.item_key is distinct from new.item_key then
    raise exception 'an annotated copy must belong to the same audit and item as its original' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger photos_annotation_guard before insert on public.photos for each row execute function app.photos_annotation_guard();

-- the immutability guard must also cover the new columns
create or replace function app.photos_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'photos cannot be deleted' using errcode = '42501'; end if;
  if old.confirmed_at is not null or new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.audit_id is distinct from old.audit_id or new.version is distinct from old.version
     or new.item_key is distinct from old.item_key or new.storage_path is distinct from old.storage_path
     or new.checksum_sha256 is distinct from old.checksum_sha256 or new.bytes is distinct from old.bytes
     or new.captured_by is distinct from old.captured_by or new.captured_at is distinct from old.captured_at
     or new.created_at is distinct from old.created_at
     or new.annotated_from is distinct from old.annotated_from or new.annotations is distinct from old.annotations then
    raise exception 'photo records are immutable except for one-time confirmation' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- (2) who recorded each result and who raised each issue, and when (client time = when it happened on site)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.audit_items add column result_by uuid references public.profiles (id);
alter table public.audit_items add column result_at timestamptz;
alter table public.audit_items add column issue_raised_by uuid references public.profiles (id);
alter table public.audit_items add column issue_raised_at timestamptz;
alter table public.audit_items add constraint audit_items_issue_pair check ((issue_raised_by is null) = (issue_raised_at is null));

-- ---------------------------------------------------------------------------------------------------------------
-- (3) revising: shared helper used by both the offline op and the revise_audit RPC
-- ---------------------------------------------------------------------------------------------------------------
create function app.create_revision(p_uid uuid, p_audit_id uuid, p_reason text) returns integer
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare v_a public.audits; v_latest integer; v_new integer;
begin
  select max(version) into v_latest from public.audits where audit_id = p_audit_id;
  select * into v_a from public.audits where audit_id = p_audit_id and version = v_latest for update;
  v_new := v_latest + 1;
  insert into public.audits (audit_id, version, project_id, room_id, template_id, created_by, revise_reason)
  values (p_audit_id, v_new, v_a.project_id, v_a.room_id, v_a.template_id, p_uid, p_reason);
  insert into public.audit_items (audit_id, version, item_key, section_key, label, kind, critical, result, note, drawing_ref, row_version, updated_by,
                                  result_by, result_at, issue_raised_by, issue_raised_at)
  select audit_id, v_new, item_key, section_key, label, kind, critical, result, note, drawing_ref, 0, updated_by,
         result_by, result_at, issue_raised_by, issue_raised_at
  from public.audit_items where audit_id = p_audit_id and version = v_latest;
  return v_new;
end $$;

create or replace function public.revise_audit(p_audit_id uuid, p_reason text) returns integer
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_a public.audits; v_latest integer;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select max(version) into v_latest from public.audits where audit_id = p_audit_id;
  if v_latest is null then raise exception 'audit_not_found'; end if;
  select * into v_a from public.audits where audit_id = p_audit_id and version = v_latest for update;
  if not app.has_role(v_a.project_id, app.field_roles()) then raise exception 'role_not_authorized' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  if v_a.submitted_at is null then raise exception 'not_submitted'; end if;
  return app.create_revision(v_uid, p_audit_id, p_reason);
end $$;

create or replace function app.op_audit(p_uid uuid, p_eid text, p_base integer, p_payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_audit uuid; v_ver integer; v_action text := p_payload ->> 'action';
  v_a public.audits; v_project uuid; v_room uuid; v_tmpl uuid; v_latest integer; v_reason text;
begin
  begin
    v_audit := split_part(p_eid, ':', 1)::uuid; v_ver := split_part(p_eid, ':', 2)::integer;
  exception when others then return app.rejected('entityId must be <audit_id>:<version>');
  end;

  if v_action = 'create' then
    if v_ver <> 1 then return app.rejected('create applies to version 1 only; use a revise operation for new versions'); end if;
    begin
      v_project := (p_payload ->> 'projectId')::uuid; v_tmpl := (p_payload ->> 'templateId')::uuid;
      v_room := nullif(p_payload ->> 'roomId', '')::uuid;
    exception when others then return app.rejected('projectId and templateId must be UUIDs');
    end;
    if not app.has_role(v_project, app.field_roles()) then
      raise exception 'insufficient privilege to create audits on this project' using errcode = '42501';
    end if;
    select * into v_a from public.audits where audit_id = v_audit and version = 1;
    if found then return jsonb_build_object('status', 'conflict', 'currentVersion', v_a.row_version, 'baseVersion', p_base); end if;
    if p_base <> 0 then return jsonb_build_object('status', 'conflict', 'currentVersion', 0, 'baseVersion', p_base); end if;
    if not exists (select 1 from public.audit_templates t where t.id = v_tmpl and t.active) then return app.rejected('template not found or inactive'); end if;
    if v_room is not null and not exists (select 1 from public.rooms r where r.id = v_room and r.project_id = v_project) then
      return app.rejected('room does not belong to the project');
    end if;
    insert into public.audits (audit_id, version, project_id, room_id, template_id, created_by)
    values (v_audit, 1, v_project, v_room, v_tmpl, p_uid);
    insert into public.audit_items (audit_id, version, item_key, section_key, label, kind, critical)
    select v_audit, 1, it ->> 'key', s ->> 'key', it ->> 'label', it ->> 'kind', (it ->> 'critical')::boolean
    from public.audit_templates t, jsonb_array_elements(t.config -> 'sections') s, jsonb_array_elements(s -> 'items') it
    where t.id = v_tmpl;
    return jsonb_build_object('status', 'applied', 'newVersion', 1);

  elsif v_action = 'submit' then
    select * into v_a from public.audits where audit_id = v_audit and version = v_ver for update;
    if not found then return app.rejected('audit not found'); end if;
    if not app.has_role(v_a.project_id, app.field_roles()) then
      raise exception 'insufficient privilege to submit this audit' using errcode = '42501';
    end if;
    if p_base <> v_a.row_version then
      return jsonb_build_object('status', 'conflict', 'currentVersion', v_a.row_version, 'baseVersion', p_base);
    end if;
    if v_a.submitted_at is not null then return app.rejected('audit_submitted'); end if;
    update public.audits set row_version = row_version + 1, submitted_at = now(), submitted_by = p_uid
    where audit_id = v_audit and version = v_ver;
    return jsonb_build_object('status', 'applied', 'newVersion', v_a.row_version + 1);

  elsif v_action = 'revise' then
    -- entityId is <audit_id>:<NEW version>. Two people revising the same audit offline: the second one conflicts.
    v_reason := btrim(coalesce(p_payload ->> 'reason', ''));
    if v_reason = '' then return app.rejected('reason_required'); end if;
    select max(version) into v_latest from public.audits where audit_id = v_audit;
    if v_latest is null then return app.rejected('audit not found'); end if;
    select * into v_a from public.audits where audit_id = v_audit and version = v_latest;
    if not app.has_role(v_a.project_id, app.field_roles()) then
      raise exception 'insufficient privilege to revise this audit' using errcode = '42501';
    end if;
    if v_ver <= v_latest then return jsonb_build_object('status', 'conflict', 'currentVersion', v_latest, 'baseVersion', p_base); end if;
    if v_ver <> v_latest + 1 or p_base <> 0 then return app.rejected('a revision must be the next version, created from base version 0'); end if;
    if v_a.submitted_at is null then return app.rejected('not_submitted'); end if;
    perform app.create_revision(p_uid, v_audit, v_reason);
    return jsonb_build_object('status', 'applied', 'newVersion', 1);
  end if;

  return app.rejected('unknown audit action');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- (4) results: attribution, and evidence counted across versions (originals only)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function app.op_audit_item(p_uid uuid, p_eid text, p_base integer, p_payload jsonb, p_op_created timestamptz) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_audit uuid; v_ver integer; v_key text;
  v_a public.audits; v_i public.audit_items; v_def jsonb; v_req jsonb; v_rule jsonb;
  v_result public.item_result; v_note text := nullif(btrim(coalesce(p_payload ->> 'note', '')), '');
  v_dref text := nullif(btrim(coalesce(p_payload ->> 'drawingRef', '')), '');
  v_actual integer; v_expected integer; v_plus integer; v_minus integer; v_band integer;
  v_missing text[] := '{}'; v_photos integer; v_want text;
  v_issue_by uuid; v_issue_at timestamptz;
begin
  begin
    v_audit := split_part(p_eid, ':', 1)::uuid; v_ver := split_part(p_eid, ':', 2)::integer; v_key := split_part(p_eid, ':', 3);
  exception when others then return app.rejected('entityId must be <audit_id>:<version>:<item_key>');
  end;
  if v_key = '' then return app.rejected('entityId must be <audit_id>:<version>:<item_key>'); end if;

  select * into v_a from public.audits where audit_id = v_audit and version = v_ver;
  if not found then return app.rejected('audit not found'); end if;
  if not app.has_role(v_a.project_id, app.field_roles()) then
    raise exception 'insufficient privilege to record results on this project' using errcode = '42501';
  end if;
  if v_a.submitted_at is not null then return app.rejected('audit_submitted'); end if;

  select * into v_i from public.audit_items where audit_id = v_audit and version = v_ver and item_key = v_key for update;
  if not found then return app.rejected('item not found'); end if;
  if p_base <> v_i.row_version then
    return jsonb_build_object('status', 'conflict', 'currentVersion', v_i.row_version, 'baseVersion', p_base);
  end if;

  v_def := app.template_item(v_a.template_id, v_key);
  v_req := coalesce(v_def -> 'requires', '{}'::jsonb);

  -- Evidence rules, re-validated server-side (mirrors canComplete in packages/domain).
  if coalesce((v_req ->> 'supervisorApproval')::boolean, false) then
    return app.rejected('supervisor_approval_not_implemented');
  end if;
  if coalesce((v_req ->> 'note')::boolean, false) and v_note is null then v_missing := array_append(v_missing, 'note'); end if;
  if coalesce((v_req ->> 'drawingRef')::boolean, false) and v_dref is null then v_missing := array_append(v_missing, 'drawingRef'); end if;
  if coalesce((v_req ->> 'photo')::integer, 0) > 0 then
    -- original photos of this item from this version or any EARLIER version of the audit; annotated copies are not extra evidence
    select count(*) into v_photos from public.photos ph
      where ph.audit_id = v_audit and ph.version <= v_ver and ph.item_key = v_key and ph.annotated_from is null;
    if v_photos < (v_req ->> 'photo')::integer then v_missing := array_append(v_missing, 'photo'); end if;
  end if;

  if v_i.kind = 'tolerance' then
    if jsonb_typeof(p_payload -> 'actual64') <> 'number' or not app.jsonb_nonneg_int(p_payload -> 'actual64')
       or jsonb_typeof(p_payload -> 'expected64') <> 'number' or not app.jsonb_nonneg_int(p_payload -> 'expected64') then
      return app.rejected('actual64 and expected64 must be non-negative integers (1/64 inch)');
    end if;
    if array_length(v_missing, 1) is not null then return app.rejected('evidence_missing: ' || array_to_string(v_missing, ',')); end if;
    v_actual := (p_payload ->> 'actual64')::integer; v_expected := (p_payload ->> 'expected64')::integer;
    v_rule := v_def -> 'rule';
    v_plus := (v_rule ->> 'plus64')::integer; v_minus := (v_rule ->> 'minus64')::integer; v_band := (v_rule ->> 'reviewBand64')::integer;
    -- The server computes the result from template rule data; any client-supplied result is ignored.
    v_result := app.evaluate_tolerance(v_actual, v_expected, v_plus, v_minus, v_band);
    insert into public.measurements (audit_id, version, item_key, expected_64, actual_64, plus_64, minus_64, review_band_64,
                                     source, source_ref, method, user_id, measured_at, drawing_ref, note, deviation_64, result)
    values (v_audit, v_ver, v_key, v_expected, v_actual, v_plus, v_minus, v_band,
            v_rule ->> 'source', v_rule ->> 'sourceRef', coalesce(nullif(btrim(coalesce(p_payload ->> 'method', '')), ''), v_rule ->> 'method'),
            p_uid, p_op_created, v_dref, v_note, v_actual - v_expected, v_result);
  else
    v_want := coalesce(p_payload ->> 'result', case when v_i.kind = 'observation' then 'OBSERVED' end);
    if v_i.kind = 'observation' and v_want <> 'OBSERVED' then return app.rejected('observation items only record OBSERVED'); end if;
    if v_i.kind = 'check' and (v_want is null or v_want not in ('PASS', 'FAIL', 'REVIEW', 'NOT_APPLICABLE')) then
      return app.rejected('result must be PASS, FAIL, REVIEW or NOT_APPLICABLE');
    end if;
    if array_length(v_missing, 1) is not null then return app.rejected('evidence_missing: ' || array_to_string(v_missing, ',')); end if;
    v_result := v_want::public.item_result;
  end if;

  -- An "issue" is a FAIL or REVIEW. Whoever first raises it, and when, is kept while the item stays an issue.
  if v_result in ('FAIL', 'REVIEW') then
    if v_i.result in ('FAIL', 'REVIEW') and v_i.issue_raised_by is not null then v_issue_by := v_i.issue_raised_by; v_issue_at := v_i.issue_raised_at;
    else v_issue_by := p_uid; v_issue_at := p_op_created; end if;
  end if;

  update public.audit_items
     set result = v_result, note = v_note, drawing_ref = v_dref, row_version = row_version + 1, updated_at = now(), updated_by = p_uid,
         result_by = p_uid, result_at = p_op_created, issue_raised_by = v_issue_by, issue_raised_at = v_issue_at
   where audit_id = v_audit and version = v_ver and item_key = v_key;

  if v_i.critical and v_result = 'FAIL' and v_i.result <> 'FAIL' then
    perform app.notify_critical_fail(v_a.project_id, v_audit, v_ver, v_i.label);
  end if;
  return jsonb_build_object('status', 'applied', 'newVersion', v_i.row_version + 1);
end $$;

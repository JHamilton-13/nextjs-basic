-- 0600: readiness derivation, server-side validation, apply_op (idempotent offline writes), and the
-- manager actions (override, release, revise). Domain reference: packages/domain/src/readiness.ts and sync.ts.
-- Authorization failures raise errcode 42501; business-rule failures raise P0001 with a stable message token.

create function app.rejected(p_message text) returns jsonb language sql immutable
  as $$ select jsonb_build_object('status', 'rejected', 'message', p_message) $$;

create function app.template_item(p_template uuid, p_key text) returns jsonb
  language sql stable set search_path = public, pg_temp
  as $$
    select it from public.audit_templates t,
      jsonb_array_elements(t.config -> 'sections') s,
      jsonb_array_elements(s -> 'items') it
    where t.id = p_template and it ->> 'key' = p_key
    limit 1
  $$;

-- Readiness for one audit version. Mirrors auditState() in packages/domain.
create function app.audit_state(p_audit_id uuid, p_version integer) returns public.readiness_state
  language plpgsql stable security definer set search_path = public, pg_temp
  as $$
declare
  v_a public.audits; v_policy text;
begin
  select * into v_a from public.audits where audit_id = p_audit_id and version = p_version;
  if not found then raise exception 'audit_not_found'; end if;
  if exists (select 1 from public.releases r where r.audit_id = p_audit_id and r.version = p_version) then
    return 'released_for_installation';
  end if;
  if exists (select 1 from public.audit_items i where i.audit_id = p_audit_id and i.version = p_version and i.critical and i.result = 'FAIL') then
    return 'not_ready';
  end if;
  if v_a.submitted_at is null then
    return case when exists (select 1 from public.audit_items i where i.audit_id = p_audit_id and i.version = p_version and i.result <> 'NOT_ENTERED')
      then 'in_progress' else 'not_started' end;
  end if;
  -- Submitted: items never entered simply do not count (owner decision 2026-11-08).
  if exists (select 1 from public.audit_items i where i.audit_id = p_audit_id and i.version = p_version and i.critical and i.result = 'REVIEW') then
    return 'manager_review_required';
  end if;
  if exists (select 1 from public.audit_items i where i.audit_id = p_audit_id and i.version = p_version and not i.critical and i.result in ('FAIL', 'REVIEW')) then
    select t.config #>> '{policy,nonCriticalIssueState}' into v_policy from public.audit_templates t where t.id = v_a.template_id;
    return v_policy::public.readiness_state;
  end if;
  return 'ready';
end $$;

create function app.can_see_audit(p_audit_id uuid, p_version integer) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.audits a
      where a.audit_id = p_audit_id and a.version = p_version and (
        app.is_admin() or (
          app.project_role(a.project_id) is not null and (
            app.project_role(a.project_id) not in ('general_contractor', 'client')
            or exists (select 1 from public.releases r where r.audit_id = a.audit_id and r.version = a.version)
          )
        )
      )
    )
  $$;

create function public.audit_state(p_audit_id uuid, p_version integer) returns public.readiness_state
  language plpgsql stable security definer set search_path = public, pg_temp
  as $$
begin
  if not app.can_see_audit(p_audit_id, p_version) then raise exception 'audit_not_found'; end if;
  return app.audit_state(p_audit_id, p_version);
end $$;

-- The caller's override-capable role on a project, or null.
create function app.manager_role(p_project uuid) returns public.app_role
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select case
      when app.project_role(p_project) = any (app.override_roles()) then app.project_role(p_project)
      when app.is_admin() then 'admin'::public.app_role
    end
  $$;

create function app.notify_critical_fail(p_project uuid, p_audit uuid, p_version integer, p_label text) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare v_proj text;
begin
  select name into v_proj from public.projects where id = p_project;
  with ins as (
    insert into public.notifications (project_id, user_id, type, priority, message, related_audit_id, related_version)
    select p_project, pm.user_id, 'critical_fail', 'critical',
           format('Site NOT READY at %s: critical item "%s" failed. Installation cannot be released without a documented manager override.', v_proj, p_label),
           p_audit, p_version
    from public.project_members pm
    where pm.project_id = p_project and pm.role in ('production_manager', 'project_manager', 'installation_manager')
    returning id, user_id, message
  )
  insert into public.email_outbox (notification_id, to_email, subject, body)
  select ins.id, p.email, 'Site NOT READY: ' || v_proj, ins.message from ins join public.profiles p on p.id = ins.user_id;
end $$;

-- ---------------- apply_op: idempotent, version-checked offline writes ----------------

create function app.op_audit(p_uid uuid, p_eid text, p_base integer, p_payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_audit uuid; v_ver integer; v_action text := p_payload ->> 'action';
  v_a public.audits; v_project uuid; v_room uuid; v_tmpl uuid;
begin
  begin
    v_audit := split_part(p_eid, ':', 1)::uuid; v_ver := split_part(p_eid, ':', 2)::integer;
  exception when others then return app.rejected('entityId must be <audit_id>:<version>');
  end;

  if v_action = 'create' then
    if v_ver <> 1 then return app.rejected('create applies to version 1 only; use revise_audit for new versions'); end if;
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
  end if;

  return app.rejected('unknown audit action');
end $$;

create function app.op_audit_item(p_uid uuid, p_eid text, p_base integer, p_payload jsonb, p_op_created timestamptz) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_audit uuid; v_ver integer; v_key text;
  v_a public.audits; v_i public.audit_items; v_def jsonb; v_req jsonb; v_rule jsonb;
  v_result public.item_result; v_note text := nullif(btrim(coalesce(p_payload ->> 'note', '')), '');
  v_dref text := nullif(btrim(coalesce(p_payload ->> 'drawingRef', '')), '');
  v_actual integer; v_expected integer; v_plus integer; v_minus integer; v_band integer;
  v_missing text[] := '{}'; v_photos integer; v_want text;
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
    select count(*) into v_photos from public.photos ph where ph.audit_id = v_audit and ph.version = v_ver and ph.item_key = v_key;
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

  update public.audit_items
     set result = v_result, note = v_note, drawing_ref = v_dref, row_version = row_version + 1, updated_at = now(), updated_by = p_uid
   where audit_id = v_audit and version = v_ver and item_key = v_key;

  if v_i.critical and v_result = 'FAIL' and v_i.result <> 'FAIL' then
    perform app.notify_critical_fail(v_a.project_id, v_audit, v_ver, v_i.label);
  end if;
  return jsonb_build_object('status', 'applied', 'newVersion', v_i.row_version + 1);
end $$;

create function public.apply_op(op jsonb) returns jsonb
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
  else
    return app.rejected('unsupported entity: ' || v_entity);
  end if;

  -- Rejections are not recorded (a corrected retry may succeed); applied and conflict outcomes are.
  if v_out ->> 'status' <> 'rejected' then
    insert into public.applied_ops (op_id, entity, entity_id, actor, outcome) values (v_op_id, v_entity, v_eid, v_uid, v_out);
  end if;
  return v_out;
end $$;

-- ---------------- manager actions (online only; identity and audit version are recorded) ----------------

create function public.grant_override(p_audit_id uuid, p_version integer, p_reason text, p_supporting_doc_ids text[] default '{}')
  returns uuid
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_a public.audits; v_role public.app_role; v_state public.readiness_state; v_id uuid;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_a from public.audits where audit_id = p_audit_id and version = p_version for update;
  if not found then raise exception 'audit_not_found'; end if;
  v_role := app.manager_role(v_a.project_id);
  if v_role is null then raise exception 'role_not_authorized' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  if p_version <> (select max(version) from public.audits where audit_id = p_audit_id) then raise exception 'not_latest_version'; end if;
  if v_a.submitted_at is null then raise exception 'audit_not_submitted'; end if;
  v_state := app.audit_state(p_audit_id, p_version);
  if v_state = 'released_for_installation' then raise exception 'already_released'; end if;
  if v_state = 'ready' then raise exception 'override_not_needed'; end if;
  insert into public.overrides (audit_id, version, granted_by, role, reason, supporting_doc_ids)
  values (p_audit_id, p_version, v_uid, v_role, p_reason, coalesce(p_supporting_doc_ids, '{}')) returning id into v_id;
  return v_id;
end $$;

create function public.release_audit(p_audit_id uuid, p_version integer) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_a public.audits; v_role public.app_role; v_state public.readiness_state;
  v_ov uuid; v_id uuid; v_failed text;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_a from public.audits where audit_id = p_audit_id and version = p_version for update;
  if not found then raise exception 'audit_not_found'; end if;
  v_role := app.manager_role(v_a.project_id);
  if v_role is null then raise exception 'role_not_authorized' using errcode = '42501'; end if;
  if p_version <> (select max(version) from public.audits where audit_id = p_audit_id) then raise exception 'not_latest_version'; end if;
  if v_a.submitted_at is null then raise exception 'inspection_not_complete'; end if;
  v_state := app.audit_state(p_audit_id, p_version);
  if v_state = 'released_for_installation' then raise exception 'already_released'; end if;
  if v_state = 'ready' then
    insert into public.releases (audit_id, version, released_by, role, basis) values (p_audit_id, p_version, v_uid, v_role, 'clear') returning id into v_id;
    return v_id;
  end if;
  select o.id into v_ov from public.overrides o where o.audit_id = p_audit_id and o.version = p_version order by o.created_at limit 1;
  if v_ov is null then
    select string_agg(i.item_key, ',' order by i.item_key) into v_failed
      from public.audit_items i where i.audit_id = p_audit_id and i.version = p_version and i.result in ('FAIL', 'REVIEW');
    raise exception 'override_required' using detail = 'failed_items=' || coalesce(v_failed, '');
  end if;
  insert into public.releases (audit_id, version, released_by, role, basis, override_id)
  values (p_audit_id, p_version, v_uid, v_role, 'override', v_ov) returning id into v_id;
  return v_id;
end $$;

-- Creates version n+1 of a submitted audit. Item results carry over; the submitted original is untouched;
-- overrides and releases stay attached to their own version and do not apply to the new one.
create function public.revise_audit(p_audit_id uuid, p_reason text) returns integer
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_a public.audits; v_latest integer; v_new integer;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select max(version) into v_latest from public.audits where audit_id = p_audit_id;
  if v_latest is null then raise exception 'audit_not_found'; end if;
  select * into v_a from public.audits where audit_id = p_audit_id and version = v_latest for update;
  if not app.has_role(v_a.project_id, app.field_roles()) then raise exception 'role_not_authorized' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  if v_a.submitted_at is null then raise exception 'not_submitted'; end if;
  v_new := v_latest + 1;
  insert into public.audits (audit_id, version, project_id, room_id, template_id, created_by, revise_reason)
  values (p_audit_id, v_new, v_a.project_id, v_a.room_id, v_a.template_id, v_uid, p_reason);
  insert into public.audit_items (audit_id, version, item_key, section_key, label, kind, critical, result, note, drawing_ref, row_version, updated_by)
  select audit_id, v_new, item_key, section_key, label, kind, critical, result, note, drawing_ref, 0, updated_by
  from public.audit_items where audit_id = p_audit_id and version = v_latest;
  return v_new;
end $$;

-- Marks a photo confirmed only once its file actually exists in the private bucket.
create function public.confirm_photo(p_photo_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_p public.photos;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from public.photos where id = p_photo_id for update;
  if not found then raise exception 'photo_not_found'; end if;
  if not (v_p.captured_by = v_uid or app.has_role(v_p.project_id, app.override_roles())) then
    raise exception 'role_not_authorized' using errcode = '42501';
  end if;
  if v_p.confirmed_at is not null then return; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'audit-photos' and o.name = v_p.storage_path) then
    raise exception 'upload_not_found';
  end if;
  update public.photos set confirmed_at = now() where id = p_photo_id;
end $$;

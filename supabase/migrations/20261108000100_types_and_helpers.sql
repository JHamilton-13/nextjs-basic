-- 0100: enums, private helper schema, tolerance evaluation
-- Domain reference: packages/domain (units.ts, tolerance.ts, readiness.ts). Lengths are integer 1/64 inch.

create schema if not exists app;
comment on schema app is 'Private helpers and internal functions. Not exposed through the API.';

create type public.app_role as enum (
  'admin', 'production_manager', 'project_manager', 'installation_manager',
  'installer', 'warehouse', 'shop', 'service_technician', 'general_contractor', 'client'
);

create type public.item_result as enum ('PASS', 'REVIEW', 'FAIL', 'NOT_ENTERED', 'OBSERVED', 'NOT_APPLICABLE');

create type public.readiness_state as enum (
  'not_started', 'in_progress', 'ready', 'ready_with_exceptions',
  'not_ready', 'manager_review_required', 'released_for_installation'
);

-- Roles that may grant overrides, give supervisor approval and release (owner decision 2026-11-08).
create function app.override_roles() returns public.app_role[]
  language sql immutable
  as $$ select array['admin','production_manager','project_manager','installation_manager']::public.app_role[] $$;

-- Roles that may do field audit work (create audits, record results, submit, revise).
create function app.field_roles() returns public.app_role[]
  language sql immutable
  as $$ select array['installer','production_manager','project_manager','installation_manager']::public.app_role[] $$;

-- Mirror of evaluate() in packages/domain/src/tolerance.ts. Boundaries are inclusive:
-- |dev| within plus/minus = PASS; otherwise |dev| <= review band = REVIEW; otherwise FAIL.
create function app.evaluate_tolerance(p_actual integer, p_expected integer, p_plus integer, p_minus integer, p_review_band integer)
  returns public.item_result
  language sql immutable
  as $$
    select (case
      when p_actual - p_expected between -p_minus and p_plus then 'PASS'
      when p_review_band is not null and abs(p_actual - p_expected) <= p_review_band then 'REVIEW'
      else 'FAIL'
    end)::public.item_result
  $$;

create function app.jsonb_nonneg_int(j jsonb) returns boolean
  language sql immutable
  as $$
    select jsonb_typeof(j) = 'number'
       and (j #>> '{}')::numeric >= 0
       and (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric)
  $$;

-- Validates an audit template config. Shape documented in docs/architecture/audit-template-config.md.
create function app.template_config_valid(cfg jsonb) returns boolean
  language plpgsql immutable
  as $$
declare
  sec jsonb; it jsonb; rule jsonb; req jsonb;
  seen text[] := '{}';
  k text; kind text; plus_v numeric; minus_v numeric; band_v numeric; rk text;
begin
  if cfg is null or jsonb_typeof(cfg) <> 'object' then return false; end if;
  if coalesce(cfg #>> '{policy,nonCriticalIssueState}', '') not in ('manager_review_required', 'ready_with_exceptions') then return false; end if;
  if jsonb_typeof(cfg -> 'sections') <> 'array' or jsonb_array_length(cfg -> 'sections') = 0 then return false; end if;

  for sec in select * from jsonb_array_elements(cfg -> 'sections') loop
    if jsonb_typeof(sec) <> 'object' or coalesce(sec ->> 'key', '') = '' or coalesce(sec ->> 'title', '') = '' then return false; end if;
    if jsonb_typeof(sec -> 'items') <> 'array' then return false; end if;
    for it in select * from jsonb_array_elements(sec -> 'items') loop
      if jsonb_typeof(it) <> 'object' then return false; end if;
      k := it ->> 'key';
      if coalesce(k, '') = '' or coalesce(it ->> 'label', '') = '' then return false; end if;
      if k = any(seen) then return false; end if;
      seen := seen || k;
      kind := it ->> 'kind';
      if kind is null or kind not in ('check', 'tolerance', 'observation') then return false; end if;
      if jsonb_typeof(it -> 'critical') <> 'boolean' then return false; end if;
      if kind = 'observation' and (it ->> 'critical')::boolean then return false; end if;

      if it ? 'requires' then
        req := it -> 'requires';
        if jsonb_typeof(req) <> 'object' then return false; end if;
        for rk in select jsonb_object_keys(req) loop
          if rk = 'photo' then
            if not app.jsonb_nonneg_int(req -> 'photo') then return false; end if;
          elsif rk in ('measurement', 'note', 'drawingRef', 'supervisorApproval') then
            if jsonb_typeof(req -> rk) <> 'boolean' then return false; end if;
          else
            return false;
          end if;
        end loop;
      end if;

      if kind = 'tolerance' then
        rule := it -> 'rule';
        if jsonb_typeof(rule) <> 'object' then return false; end if;
        if not app.jsonb_nonneg_int(rule -> 'plus64') or not app.jsonb_nonneg_int(rule -> 'minus64') then return false; end if;
        plus_v := (rule ->> 'plus64')::numeric; minus_v := (rule ->> 'minus64')::numeric;
        if rule ? 'reviewBand64' then
          if not app.jsonb_nonneg_int(rule -> 'reviewBand64') then return false; end if;
          band_v := (rule ->> 'reviewBand64')::numeric;
          if band_v < greatest(plus_v, minus_v) then return false; end if;
        end if;
        if coalesce(rule ->> 'source', '') not in ('project_spec','approved_drawing','company_standard','manufacturer','industry_standard','custom') then return false; end if;
        if jsonb_typeof(rule -> 'sourceRef') <> 'string' or jsonb_typeof(rule -> 'method') <> 'string' then return false; end if;
      end if;
    end loop;
  end loop;
  return true;
end $$;

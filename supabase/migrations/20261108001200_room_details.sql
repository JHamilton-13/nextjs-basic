-- Room spec details (panel name, wood species, finish name, edgebanding, ...). Reference data for installers: it is
-- useful when a part has to be remade. The values come from Cockpit, the master file (Google Drive) or the
-- Warehouse Tracker; for now only a person with a manager role writes them (integrations are a mock contract).
-- Installers can read them (existing rooms_select policy) and cannot write them (existing rooms_write policy).
-- Nothing marked PHC-only is ever stored here, so it can never reach an installer's phone.

alter table public.rooms
  add column details jsonb not null default '{}'::jsonb,
  add column details_source text,
  add column details_updated_at timestamptz;

create function app.room_details_valid(d jsonb) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(d) = 'object'
    and (select count(*) from jsonb_object_keys(d)) <= 60
    and not exists (
      select 1 from jsonb_each(d) e
      where e.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
         or e.key in ('phcOnlyNotes', 'gateCode')
         or jsonb_typeof(e.value) <> 'string'
         or char_length(e.value #>> '{}') > 500
    );
$$;

alter table public.rooms
  add constraint rooms_details_valid check (app.room_details_valid(details)),
  add constraint rooms_details_source_valid check (details_source is null or details_source in ('cockpit', 'masterfile', 'warehouse_tracker', 'manual'));

comment on column public.rooms.details is 'Room spec fields keyed by field name (e.g. panelName, woodSpecies). Strings only. Never holds PHC-only notes or gate codes.';
comment on column public.rooms.details_source is 'Where the details came from: cockpit, masterfile, warehouse_tracker or manual.';

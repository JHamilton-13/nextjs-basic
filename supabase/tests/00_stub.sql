-- TEST-ONLY stand-ins for Supabase-provided objects (auth schema, storage schema, API roles).
-- Never applied to a real project. Real Supabase provides all of these.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
-- Same contract as Supabase: the signed-in user comes from the request JWT claims.
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;

create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert on storage.objects to authenticated;

-- Supabase grants API roles broad default privileges on public; replicate so migration 0700's lockdown is exercised.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;

-- tiny assertion helpers
create schema test;
grant usage on schema test to public;

create function test.ok(c boolean, name text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'NOT OK - %', name; end if;
  raise notice 'ok - %', name;
end $$;

-- Asserts that a statement fails and that the error message (or SQLSTATE) contains `fragment`.
create function test.raises(stmt text, fragment text, name text) returns void language plpgsql as $$
declare v_err text; v_state text;
begin
  begin
    execute stmt;
  exception when others then
    v_err := sqlerrm; v_state := sqlstate;
  end;
  if v_err is null then raise exception 'NOT OK - %: no error was raised', name; end if;
  if position(fragment in v_err) = 0 and v_state <> fragment then
    raise exception 'NOT OK - %: expected error containing "%", got [%] %', name, fragment, v_state, v_err;
  end if;
  raise notice 'ok - %', name;
end $$;

create function test.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
end $$;

create function test.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;

create function test.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

create function test.u(n integer) returns uuid language sql immutable
  as $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function test.tmpl() returns uuid language sql immutable
  as $$ select 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $$;

create function test.op(n integer, entity text, eid text, base integer, payload jsonb, actor uuid) returns jsonb language sql immutable
  as $$ select jsonb_build_object('opId', test.u(1000 + n), 'entity', entity, 'entityId', eid, 'baseVersion', base,
                                  'payload', payload, 'createdAt', '2026-11-08T10:00:00Z', 'actor', actor) $$;

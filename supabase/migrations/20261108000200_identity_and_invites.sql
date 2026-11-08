-- 0200: profiles, invite list, and the sign-in gate.
-- Access control = invite list + project roles. Identity providers (Google, email code) only prove who someone is.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  constraint profiles_email_lower check (email = lower(btrim(email)))
);
create unique index profiles_email_key on public.profiles (email);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  note text,
  invited_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  constraint invites_email_lower check (email = lower(btrim(email)) and email like '%_@_%')
);
-- One active invite per email; a revoked email can be invited again with a new row.
create unique index invites_active_email_key on public.invites (email) where revoked_at is null;

-- Invite rows may only be revoked, never edited or deleted.
create function app.invites_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'invites cannot be deleted; revoke instead' using errcode = '42501'; end if;
  if new.email is distinct from old.email or new.invited_by is distinct from old.invited_by or new.created_at is distinct from old.created_at then
    raise exception 'invite identity columns are immutable' using errcode = '42501';
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'a revoked invite cannot be changed' using errcode = '42501';
  end if;
  if new.revoked_at is not null and old.revoked_at is null then
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  end if;
  return new;
end $$;
create trigger invites_guard before update or delete on public.invites for each row execute function app.invites_guard();

-- Creates the profile row when an auth user is created.
create function app.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
begin
  insert into public.profiles (id, email) values (new.id, lower(btrim(new.email))) on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function app.handle_new_user();

-- Supabase "Before User Created" auth hook. Enable it in Dashboard > Authentication > Hooks and point it at
-- public.hook_before_user_created. It rejects sign-ups (Google or email code) whose email has no active invite.
-- Returning '{}' allows the sign-up; the error object makes Supabase Auth refuse it with HTTP 403.
create function public.hook_before_user_created(event jsonb) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
  as $$
declare
  v_email text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if v_email <> '' and exists (select 1 from public.invites i where i.email = v_email and i.revoked_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This account has not been invited.'));
end $$;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

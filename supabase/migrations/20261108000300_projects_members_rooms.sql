-- 0300: projects, project membership (where roles live), rooms, and the access helpers used by RLS.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  customer text,
  address text,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.app_role not null,
  added_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id),
  -- 'admin' is an organization-level flag on profiles, not a per-project role
  constraint project_members_no_admin check (role <> 'admin')
);
create index project_members_user_idx on public.project_members (user_id);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  floor text,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

-- ---- access helpers (SECURITY DEFINER so policies on project_members do not recurse) ----

-- A user is active only while their email has a non-revoked invite. Revoking an invite therefore cuts off
-- data access immediately, even for someone who already has an auth account.
create function app.is_active() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.profiles p
      join public.invites i on i.email = p.email and i.revoked_at is null
      where p.id = auth.uid()
    )
  $$;

create function app.is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select app.is_active() and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) $$;

create function app.project_role(p_project uuid) returns public.app_role
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select pm.role from public.project_members pm
    where pm.project_id = p_project and pm.user_id = auth.uid() and app.is_active()
  $$;

create function app.is_member(p_project uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select app.project_role(p_project) is not null or app.is_admin() $$;

-- Admins count as holding every role on every project.
create function app.has_role(p_project uuid, p_roles public.app_role[]) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select coalesce(app.project_role(p_project) = any (p_roles), false) or app.is_admin() $$;

create function app.is_manager_anywhere() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.is_active() and exists (
      select 1 from public.project_members pm
      where pm.user_id = auth.uid() and pm.role in ('production_manager', 'project_manager')
    )
  $$;

-- Proposed rule (owner to confirm): admins and production/project managers maintain the invite list and create projects.
create function app.can_manage_invites() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select app.is_admin() or app.is_manager_anywhere() $$;

create function app.shares_project_with(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.is_active() and exists (
      select 1 from public.project_members a
      join public.project_members b on b.project_id = a.project_id
      where a.user_id = auth.uid() and b.user_id = p_user
    )
  $$;

-- Whoever creates a project becomes its project manager (admins see everything already).
create function app.projects_add_creator() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
begin
  if not exists (select 1 from public.profiles where id = new.created_by and is_admin) then
    insert into public.project_members (project_id, user_id, role, added_by)
    values (new.id, new.created_by, 'project_manager', new.created_by) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger projects_add_creator after insert on public.projects for each row execute function app.projects_add_creator();

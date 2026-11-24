-- Sign-in gate (invite list) and basic access isolation.
begin;
\ir fixtures.sql

do $$
declare r jsonb;
begin
  -- Before-user-created hook
  r := public.hook_before_user_created('{"user":{"email":"  INST1@PHC.test "}}');
  perform test.ok(r = '{}'::jsonb, 'hook allows an invited email (case/space-insensitive)');
  r := public.hook_before_user_created('{"user":{"email":"stranger@evil.test"}}');
  perform test.ok(r #>> '{error,http_code}' = '403', 'hook rejects an email with no invite (403)');
  r := public.hook_before_user_created('{"user":{"email":"revoked@phc.test"}}');
  perform test.ok(r #>> '{error,http_code}' = '403', 'hook rejects an email whose invite was revoked');
  r := public.hook_before_user_created('{"user":{}}');
  perform test.ok(r #>> '{error,http_code}' = '403', 'hook rejects a sign-up with no email');
  r := public.hook_before_user_created('{}');
  perform test.ok(r #>> '{error,http_code}' = '403', 'hook rejects an empty event');

  -- the hook is callable only by the auth service role
  perform test.as_user(test.u(4));
  perform test.raises($q$select public.hook_before_user_created('{}')$q$, '42501', 'signed-in users cannot call the hook directly');
  perform test.as_anon();
  perform test.raises($q$select public.hook_before_user_created('{}')$q$, '42501', 'anon cannot call the hook directly');
  perform test.as_postgres();

  -- uninvited: account exists but no access to anything
  perform test.as_user(test.u(11));
  perform test.ok((select count(*) from public.projects) = 0, 'uninvited account sees no projects');
  perform test.ok((select count(*) from public.profiles) = 0, 'uninvited account sees no profiles (not even its own)');
  perform test.ok((select count(*) from public.audit_templates) = 0, 'uninvited account sees no templates');
  perform test.as_postgres();

  -- revoked invite cuts off data access even though the account and membership still exist
  perform test.as_user(test.u(12));
  perform test.ok((select count(*) from public.projects) = 0, 'revoked-invite member sees no projects');
  perform test.ok((select count(*) from public.rooms) = 0, 'revoked-invite member sees no rooms');
  perform test.raises($q$select public.apply_op('{}'::jsonb)$q$, '28000', 'revoked-invite member cannot call apply_op');
  perform test.as_postgres();

  -- anon sees nothing
  perform test.as_anon();
  perform test.raises($q$select count(*) from public.projects$q$, '42501', 'anon has no privileges on projects');
  perform test.as_postgres();
end $$;

-- invite list management
do $$
declare v_id uuid;
begin
  perform test.as_user(test.u(4));
  perform test.raises($q$insert into public.invites (email, invited_by) values ('new@phc.test', '00000000-0000-4000-8000-000000000004')$q$,
    'row-level security', 'an installer cannot add invites');
  perform test.as_user(test.u(2));
  insert into public.invites (email, invited_by) values ('new@phc.test', test.u(2)) returning id into v_id;
  perform test.ok(v_id is not null, 'a project manager can add an invite');
  perform test.raises(format($q$insert into public.invites (email, invited_by) values ('new@phc.test', %L)$q$, test.u(2)),
    'duplicate key', 'only one active invite per email');
  perform test.raises($q$insert into public.invites (email, invited_by) values ('Mixed@Case.test', '00000000-0000-4000-8000-000000000002')$q$,
    'invites_email_lower', 'invite emails must be stored lower-case');
  update public.invites set revoked_at = now() where id = v_id;
  perform test.as_postgres();
  perform test.ok((select revoked_by from public.invites where id = v_id) = test.u(2), 'revoking records who revoked');
  perform test.raises(format($q$update public.invites set email = 'other@phc.test' where id = %L$q$, v_id), 'immutable', 'invite email cannot be edited');
  perform test.raises(format($q$delete from public.invites where id = %L$q$, v_id), 'cannot be deleted', 'invites cannot be deleted');
  perform test.raises(format($q$update public.invites set revoked_at = null where id = %L$q$, v_id), 'revoked invite cannot be changed', 'a revoked invite cannot be un-revoked');
  insert into public.invites (email) values ('new@phc.test');
  perform test.ok(true, 'a revoked email can be re-invited with a new row');
end $$;

-- project isolation and role-gated writes
do $$
begin
  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from public.projects) = 1 and (select id from public.projects) = test.u(101), 'installer sees only their project');
  perform test.ok((select count(*) from public.rooms) = 1, 'installer sees rooms of their project');
  perform test.ok((select count(*) from public.project_members) >= 6, 'installer sees the members of their own project');
  perform test.ok((select count(*) from public.project_members where project_id = test.u(102)) = 0, 'installer cannot see another project''s members');
  perform test.ok((select count(*) from public.profiles where id = test.u(9)) = 0, 'installer cannot see profiles of people they share no project with');
  perform test.as_user(test.u(5));
  perform test.ok((select count(*) from public.projects) = 1 and (select id from public.projects) = test.u(102), 'second installer sees only their project');
  perform test.as_user(test.u(10));
  perform test.ok((select count(*) from public.projects) = 0, 'invited user with no membership sees no projects');
  perform test.as_user(test.u(1));
  perform test.ok((select count(*) from public.projects) = 2, 'admin sees all projects');

  perform test.as_user(test.u(4));
  perform test.raises(format($q$insert into public.project_members (project_id, user_id, role, added_by) values (%L, %L, 'installer', %L)$q$, test.u(101), test.u(10), test.u(4)),
    'row-level security', 'an installer cannot add project members');
  perform test.raises(format($q$insert into public.projects (name, created_by) values ('Nope', %L)$q$, test.u(4)),
    'row-level security', 'an installer cannot create projects');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$insert into public.project_members (project_id, user_id, role, added_by) values (%L, %L, 'installer', %L)$q$, test.u(102), test.u(10), test.u(2)),
    'row-level security', 'a project manager cannot add members to someone else''s project');
  insert into public.project_members (project_id, user_id, role, added_by) values (test.u(101), test.u(10), 'installer', test.u(2));
  perform test.ok(true, 'a project manager can add members to their own project');
  perform test.raises(format($q$insert into public.project_members (project_id, user_id, role, added_by) values (%L, %L, 'admin', %L)$q$, test.u(101), test.u(11), test.u(2)),
    'project_members_no_admin', 'admin is not assignable as a project role');
  perform test.raises(format($q$update public.profiles set is_admin = true where id = %L$q$, test.u(2)), '42501', 'nobody can promote themselves to admin through the API');
  insert into public.projects (name, created_by) values ('New by PM', test.u(2));
  perform test.ok((select count(*) from public.projects where name = 'New by PM') = 1, 'a project manager can create a project');
  perform test.as_postgres();
  perform test.ok((select role from public.project_members where project_id = (select id from public.projects where name = 'New by PM') and user_id = test.u(2)) = 'project_manager',
    'creator becomes project manager of the new project');

  -- tables that are service-only
  perform test.as_user(test.u(2));
  perform test.raises($q$select count(*) from public.email_outbox$q$, '42501', 'email_outbox is not readable through the API');
  perform test.raises($q$select count(*) from public.applied_ops$q$, '42501', 'applied_ops is not readable through the API');
  perform test.raises($q$insert into public.audit_log (action, table_name) values ('x','y')$q$, '42501', 'users cannot write the audit log');
  perform test.as_postgres();
end $$;
rollback;

-- Common fixtures (run inside each test's transaction, as the superuser).
-- users: 1 admin, 2 pm1 (P1 PM), 3 im1 (P1 installation mgr), 4 inst1 (P1 installer), 5 inst2 (P2 installer),
--        6 gc1 (P1 GC), 7 client1 (P1 client), 8 whs1 (P1 warehouse), 9 pm2 (P2 PM),
--        10 outsider (invited, no projects), 11 uninvited (account but no invite), 12 revoked (invite revoked, member of P1)
insert into auth.users (id, email)
select test.u(n), e from (values
  (1,'admin@phc.test'),(2,'pm1@phc.test'),(3,'im1@phc.test'),(4,'inst1@phc.test'),(5,'inst2@phc.test'),(6,'gc1@phc.test'),
  (7,'client1@phc.test'),(8,'whs1@phc.test'),(9,'pm2@phc.test'),(10,'outsider@phc.test'),(11,'uninvited@phc.test'),(12,'revoked@phc.test')
) v(n, e);
update public.profiles set is_admin = true where id = test.u(1);
insert into public.invites (email) select email from public.profiles where id <> test.u(11);
update public.invites set revoked_at = now() where email = 'revoked@phc.test';

insert into public.projects (id, name, customer, created_by) values
  (test.u(101), 'Project One', 'Cust A', test.u(2)),
  (test.u(102), 'Project Two', 'Cust B', test.u(9));
insert into public.project_members (project_id, user_id, role) values
  (test.u(101), test.u(3), 'installation_manager'),
  (test.u(101), test.u(4), 'installer'),
  (test.u(101), test.u(6), 'general_contractor'),
  (test.u(101), test.u(7), 'client'),
  (test.u(101), test.u(8), 'warehouse'),
  (test.u(101), test.u(12), 'installer'),
  (test.u(102), test.u(5), 'installer');
insert into public.rooms (id, project_id, name) values (test.u(201), test.u(101), 'Kitchen');

-- helpers that act as the superuser
create or replace function test.add_photo(n integer, a uuid, v integer, k text, proj uuid, usr uuid) returns void language plpgsql as $$
begin
  insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at)
  values (test.u(2000 + n), proj, a, v, k, proj || '/' || a || '/' || n || '.jpg', repeat('a', 64), 100, usr, now());
end $$;

-- create an audit v1 on P1 as inst1 via apply_op
create or replace function test.new_audit(a uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(
        test.op(0, 'audit', a || ':1', 0,
          jsonb_build_object('action', 'create', 'projectId', test.u(101), 'roomId', test.u(201), 'templateId', test.tmpl()), test.u(4)),
        '{opId}', to_jsonb(md5('create:' || a::text)::uuid)));
  perform test.as_postgres();
  return r;
end $$;

create or replace function test.item(n integer, a uuid, k text, base integer, payload jsonb, actor uuid default test.u(4)) returns jsonb language sql as $$
  select public.apply_op(test.op(n, 'audit_item', a || ':1:' || k, base, payload, actor))
$$;
create or replace function test.submit(n integer, a uuid, base integer) returns jsonb language sql as $$
  select public.apply_op(test.op(n, 'audit', a || ':1', base, jsonb_build_object('action', 'submit'), test.u(4)))
$$;

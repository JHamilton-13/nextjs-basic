-- Audit log coverage and visibility, photo registration and private storage.
begin;
\ir fixtures.sql

do $$
declare
  a uuid := test.u(320); v_ov uuid;
begin
  perform test.new_audit(a);
  perform test.add_photo(1, a, 1, 'plumbing_rough_in', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  perform test.item(1, a, 'plumbing_rough_in', 0, '{"result":"FAIL"}'::jsonb);
  perform test.submit(2, a, 1);
  perform test.as_user(test.u(2));
  v_ov := public.grant_override(a, 1, 'Documented for audit log test', '{}');
  perform public.release_audit(a, 1);
  perform test.as_postgres();

  perform test.ok((select count(*) from public.audit_log where table_name = 'audits' and action = 'INSERT' and record_id = a || ':1') = 1, 'audit creation is logged');
  perform test.ok((select count(*) from public.audit_log where table_name = 'audits' and action = 'UPDATE' and record_id = a || ':1' and details #>> '{new,submitted_by}' = test.u(4)::text) = 1, 'submission is logged with the submitter');
  perform test.ok((select details #>> '{new,result}' from public.audit_log where table_name = 'audit_items' and action = 'UPDATE' and record_id = a || ':1:plumbing_rough_in') = 'FAIL', 'item result change is logged (new value)');
  perform test.ok((select details #>> '{old,result}' from public.audit_log where table_name = 'audit_items' and action = 'UPDATE' and record_id = a || ':1:plumbing_rough_in') = 'NOT_ENTERED', 'item result change is logged (old value)');
  perform test.ok((select actor from public.audit_log where table_name = 'overrides' and action = 'INSERT' and record_id = v_ov::text) = test.u(2), 'override is logged with the approving user as actor');
  perform test.ok((select details #>> '{new,reason}' from public.audit_log where table_name = 'overrides' and record_id = v_ov::text) = 'Documented for audit log test', 'override reason is in the log');
  perform test.ok((select count(*) from public.audit_log where table_name = 'releases' and action = 'INSERT' and actor = test.u(2)) = 1, 'release is logged with the releaser');
  perform test.ok((select count(*) from public.audit_log where table_name = 'audit_items' and project_id is null) = 0, 'item changes carry the project id for access control');
  perform test.ok((select count(*) from public.audit_log where table_name = 'invites' and action = 'INSERT') >= 11, 'invite changes are logged');
  perform test.ok((select count(*) from public.audit_log where table_name = 'project_members') >= 7, 'membership changes are logged');

  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from public.audit_log) = 0, 'an installer cannot read the audit log');
  perform test.as_user(test.u(2));
  perform test.ok((select count(*) from public.audit_log) > 0 and (select count(*) from public.audit_log where project_id is distinct from test.u(101)) = 0, 'a project manager reads only their project''s log entries');
  perform test.as_user(test.u(9));
  perform test.ok((select count(*) from public.audit_log where project_id = test.u(101)) = 0, 'another project''s manager cannot read this project''s log');
  perform test.as_user(test.u(1));
  perform test.ok((select count(*) from public.audit_log where project_id = test.u(101)) > 0, 'admin can read the log');
  perform test.as_postgres();
end $$;

do $$
declare
  a uuid := test.u(321); p1 uuid; pth text; r jsonb;
begin
  perform test.new_audit(a);
  -- registering photos (client-generated id, so a retry is idempotent)
  perform test.as_user(test.u(4));
  insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at)
  values (test.u(2100), test.u(101), a, 1, 'wall_length', test.u(101) || '/' || a || '/wl.jpg', repeat('c', 64), 2048, test.u(4), now());
  perform test.ok(true, 'an installer can register a photo');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, %L, 1, 'other', repeat('c',64), 1, %L, now())$q$, test.u(2100), test.u(101), a, test.u(4)),
    'duplicate key', 'registering the same photo id twice is rejected (safe to retry)');
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, 1, 'x1', repeat('c',64), 1, %L, now())$q$, test.u(101), a, test.u(3)),
    'row-level security', 'a photo cannot be registered in someone else''s name');
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at, confirmed_at) values (%L, %L, 1, 'x2', repeat('c',64), 1, %L, now(), now())$q$, test.u(101), a, test.u(4)),
    'row-level security', 'a photo cannot be registered pre-confirmed');
  perform test.as_user(test.u(5));
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, 1, 'x3', repeat('c',64), 1, %L, now())$q$, test.u(101), a, test.u(5)),
    'row-level security', 'a member of another project cannot register photos');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, 1, 'x4', repeat('c',64), 1, %L, now())$q$, test.u(101), a, test.u(6)),
    'row-level security', 'a general contractor cannot register photos');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$update public.photos set confirmed_at = now() where id = %L$q$, test.u(2100)), '42501', 'users cannot confirm photos by updating the table');

  pth := test.u(101) || '/' || a || '/wl.jpg';
  -- confirm needs the file to exist
  perform test.raises(format($q$select public.confirm_photo(%L)$q$, test.u(2100)), 'upload_not_found', 'a photo cannot be confirmed before its file is uploaded');
  -- storage: only registered paths, only by the capturer
  perform test.raises($q$insert into storage.objects (bucket_id, name) values ('audit-photos', 'not/registered.jpg')$q$, 'row-level security', 'uploading to an unregistered path is refused');
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('other-bucket', %L)$q$, pth), 'row-level security', 'uploading into any other bucket is refused');
  perform test.as_user(test.u(5));
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('audit-photos', %L)$q$, pth), 'row-level security', 'another user cannot upload to someone else''s registered path');
  perform test.as_anon();
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('audit-photos', %L)$q$, pth), '42501', 'anon cannot upload');
  perform test.as_user(test.u(4));
  insert into storage.objects (bucket_id, name, owner) values ('audit-photos', pth, test.u(4));
  perform test.ok(true, 'the capturer can upload to the registered path');
  perform public.confirm_photo(test.u(2100));
  perform public.confirm_photo(test.u(2100));
  perform test.as_postgres();
  perform test.ok((select confirmed_at is not null from public.photos where id = test.u(2100)), 'photo confirmed once the file exists (and confirming again is harmless)');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$select public.confirm_photo(%L)$q$, test.u(2100)), '42501', 'a general contractor cannot confirm photos');
  perform test.ok((select count(*) from storage.objects where name = pth) = 0 and (select count(*) from public.photos where id = test.u(2100)) = 0,
    'a general contractor cannot see photos or files of an unreleased audit');
  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from storage.objects where name = pth) = 1, 'the installer can read the file');
  perform test.as_user(test.u(8));
  perform test.ok((select count(*) from storage.objects where name = pth) = 1, 'a warehouse member of the project can read the file');
  perform test.as_user(test.u(5));
  perform test.ok((select count(*) from storage.objects where name = pth) = 0, 'a member of another project cannot read the file');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$delete from storage.objects where name = %L$q$, pth), '42501', 'uploaded evidence cannot be deleted by users');
  perform test.raises(format($q$update storage.objects set name = 'moved' where name = %L$q$, pth), '42501', 'uploaded evidence cannot be replaced by users');

  -- late evidence is allowed on a submitted audit (offline photos can sync after submit)
  perform test.submit(90, a, 1);
  insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at)
  values (test.u(2101), test.u(101), a, 1, 'wall_length', test.u(101) || '/' || a || '/late.jpg', repeat('d', 64), 10, test.u(4), now());
  perform test.ok(true, 'a photo captured offline can still be registered after the audit is submitted');
  perform test.as_postgres();
end $$;
rollback;

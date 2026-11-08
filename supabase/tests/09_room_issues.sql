-- Room issues (issue / missing part / damaged part): create, edit, complete, reopen, roles, photos, storage.
begin;
\ir fixtures.sql

-- a second room on a second project, to test cross-project refusals
insert into public.rooms (id, project_id, name) values (test.u(202), test.u(102), 'Other kitchen');

create function test.iop(n integer, id uuid, base integer, payload jsonb, actor uuid default test.u(4)) returns jsonb language sql as $$
  select public.apply_op(test.op(n, 'room_issue', id::text, base, payload, actor))
$$;

do $$
declare
  i uuid := test.u(7001); i2 uuid := test.u(7002); rm uuid := test.u(201); r jsonb; ph uuid := test.u(7101); pth text;
  pen text := '[{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1],[0.5,0.5]]}]';
begin
  perform test.as_user(test.u(4));                                              -- installer on project 1
  r := test.iop(1, i, 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'damaged_part', 'title', 'Door chipped', 'description', 'Corner chipped on delivery'));
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 1, 'an installer can raise a damaged-part issue');
  perform test.as_postgres();
  perform test.ok((select raised_by from public.room_issues where id = i) = test.u(4) and (select raised_at from public.room_issues where id = i) = '2026-11-08T10:00:00Z'::timestamptz, 'who raised it and the on-site time are recorded');
  perform test.ok((select project_id from public.room_issues where id = i) = test.u(101) and (select kind from public.room_issues where id = i) = 'damaged_part', 'the issue carries the room''s project and its kind');

  -- ---- validation ----
  perform test.as_user(test.u(4));
  perform test.ok(test.iop(2, test.u(7010), 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'punch_item', 'title', '  ')) ->> 'status' = 'rejected', 'a blank title is rejected');
  perform test.ok(test.iop(3, test.u(7010), 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'arrow', 'title', 'x')) ->> 'status' = 'rejected', 'an unknown kind is rejected');
  perform test.ok(test.iop(4, test.u(7010), 0, jsonb_build_object('action', 'create', 'roomId', rm, 'title', 'x')) ->> 'status' = 'rejected', 'a missing kind is rejected');
  perform test.ok(test.iop(5, test.u(7010), 0, jsonb_build_object('action', 'create', 'roomId', test.u(9999), 'kind', 'touch_up', 'title', 'x')) ->> 'status' = 'rejected', 'a room that does not exist is rejected');
  perform test.ok(test.iop(6, test.u(7010), 1, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'touch_up', 'title', 'x')) ->> 'status' = 'rejected', 'a new issue must start at version 0');
  perform test.ok(test.iop(7, test.u(7010), 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'touch_up', 'title', 'x', 'description', repeat('d', 2001))) ->> 'status' = 'rejected', 'a description over 2000 characters is rejected');
  perform test.ok(test.iop(8, test.u(7010), 0, jsonb_build_object('action', 'fly')) ->> 'status' = 'rejected', 'an unknown action is rejected');
  perform test.ok(test.iop(9, test.u(7010), 0, jsonb_build_object('action', 'update', 'title', 'x')) ->> 'status' = 'rejected', 'changing an issue that does not exist is rejected');
  perform test.as_postgres();
  perform test.ok(not exists (select 1 from public.room_issues where id = test.u(7010)), 'rejected creates leave nothing behind');

  -- ---- idempotency and conflicts ----
  perform test.as_user(test.u(4));
  r := test.iop(1, i, 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'damaged_part', 'title', 'Door chipped'));
  perform test.ok(r ->> 'status' = 'duplicate', 'replaying the same opId is a harmless duplicate');
  r := test.iop(10, i, 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'damaged_part', 'title', 'Door chipped again'));
  perform test.ok(r ->> 'status' = 'conflict', 'creating an issue id that already exists is a conflict, not an overwrite');

  -- ---- edit, complete, reopen ----
  r := test.iop(11, i, 1, jsonb_build_object('action', 'update', 'kind', 'missing_part', 'title', 'Door missing'));
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 2, 'an open issue can be edited (kind and title)');
  perform test.ok(test.iop(12, i, 1, jsonb_build_object('action', 'update', 'title', 'Stale')) ->> 'status' = 'conflict', 'a stale base version is a conflict');
  perform test.ok(test.iop(13, i, 2, jsonb_build_object('action', 'update')) ->> 'status' = 'rejected', 'an edit that changes nothing is rejected');
  r := test.iop(14, i, 2, jsonb_build_object('action', 'update', 'description', ''));
  perform test.ok(r ->> 'status' = 'applied', 'the description can be cleared');
  r := test.iop(15, i, 3, jsonb_build_object('action', 'complete', 'note', 'Replacement door fitted'));
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 4, 'an issue can be completed with a note');
  perform test.as_postgres();
  perform test.ok((select completed_by from public.room_issues where id = i) = test.u(4) and (select completed_note from public.room_issues where id = i) = 'Replacement door fitted' and (select title from public.room_issues where id = i) = 'Door missing' and (select description from public.room_issues where id = i) is null, 'completion is attributed and the earlier edits stuck');
  perform test.as_user(test.u(4));
  perform test.ok(test.iop(16, i, 4, jsonb_build_object('action', 'update', 'title', 'No')) ->> 'status' = 'rejected', 'a completed issue cannot be edited');
  perform test.ok(test.iop(17, i, 4, jsonb_build_object('action', 'complete')) ->> 'status' = 'rejected', 'a completed issue cannot be completed twice');
  r := test.iop(18, i, 4, jsonb_build_object('action', 'reopen'));
  perform test.ok(r ->> 'status' = 'applied', 'a completed issue can be reopened');
  perform test.ok(test.iop(19, i, 5, jsonb_build_object('action', 'reopen')) ->> 'status' = 'rejected', 'an open issue cannot be reopened');
  perform test.as_postgres();
  perform test.ok((select completed_by is null and completed_at is null and completed_note is null from public.room_issues where id = i), 'reopening clears the completion');
  perform test.ok((select count(*) from public.audit_log where table_name = 'room_issues' and record_id = i::text) >= 4, 'every change is in the audit log');

  -- ---- who can write and read ----
  perform test.as_user(test.u(3));                                              -- installation manager
  perform test.ok(test.iop(20, i2, 0, jsonb_build_object('action', 'create', 'roomId', rm, 'kind', 'touch_up', 'title', 'Touch up island'), test.u(3)) ->> 'status' = 'applied', 'a manager can raise an issue');
  perform test.as_user(test.u(7));
  perform test.raises(format($q$select test.iop(21, %L, 0, '{"action":"create","roomId":"%s","kind":"touch_up","title":"x"}', test.u(7))$q$, test.u(7020), rm), 'insufficient privilege', 'a client cannot raise issues');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$select test.iop(22, %L, 0, '{"action":"create","roomId":"%s","kind":"touch_up","title":"x"}', test.u(6))$q$, test.u(7021), rm), 'insufficient privilege', 'a general contractor cannot raise issues');
  perform test.as_user(test.u(8));
  perform test.raises(format($q$select test.iop(23, %L, 0, '{"action":"create","roomId":"%s","kind":"touch_up","title":"x"}', test.u(8))$q$, test.u(7022), rm), 'insufficient privilege', 'a warehouse user cannot raise issues');
  perform test.as_user(test.u(5));
  perform test.raises(format($q$select test.iop(24, %L, 0, '{"action":"create","roomId":"%s","kind":"touch_up","title":"x"}', test.u(5))$q$, test.u(7023), rm), 'insufficient privilege', 'an installer on another project cannot raise issues here');
  perform test.raises(format($q$select test.iop(25, %L, 2, '{"action":"complete"}', test.u(5))$q$, i), 'insufficient privilege', 'an installer on another project cannot change this project''s issues');

  perform test.as_user(test.u(4));  perform test.ok((select count(*) from public.room_issues) = 2, 'an installer on the project can read its issues');
  perform test.as_user(test.u(3));  perform test.ok((select count(*) from public.room_issues) = 2, 'a manager can read the issues');
  perform test.as_user(test.u(7));  perform test.ok((select count(*) from public.room_issues) = 0, 'a client cannot read issues');
  perform test.as_user(test.u(6));  perform test.ok((select count(*) from public.room_issues) = 0, 'a general contractor cannot read issues');
  perform test.as_user(test.u(5));  perform test.ok((select count(*) from public.room_issues) = 0, 'an installer on another project cannot read issues');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$insert into public.room_issues (id, project_id, room_id, kind, title, raised_by, raised_at) values (%L, %L, %L, 'punch_item', 'x', %L, now())$q$, test.u(7030), test.u(101), rm, test.u(4)), 'permission denied', 'there is no way to write issues except through apply_op');
  perform test.as_postgres();

  -- ---- photos on issues ----
  pth := test.u(101) || '/issues/' || i || '/1.jpg';
  perform test.as_user(test.u(4));
  insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at)
  values (ph, test.u(101), i, pth, repeat('a', 64), 2048, test.u(4), now());
  perform test.ok(true, 'an installer can register a photo on an issue');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, %L, 'p/x1', repeat('a',64), 1, %L, now())$q$, test.u(7102), test.u(101), i, test.u(3)), 'row-level security', 'a photo cannot be registered in someone else''s name');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, confirmed_at) values (%L, %L, %L, 'p/x2', repeat('a',64), 1, %L, now(), now())$q$, test.u(7103), test.u(101), i, test.u(4)), 'row-level security', 'a photo cannot be registered as already confirmed');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, %L, 'p/x3', repeat('a',64), 1, %L, now())$q$, test.u(7104), test.u(102), i, test.u(4)), 'row-level security', 'a photo cannot claim a different project than its issue');
  perform test.as_user(test.u(7));
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, %L, 'p/x4', repeat('a',64), 1, %L, now())$q$, test.u(7105), test.u(101), i, test.u(7)), 'row-level security', 'a client cannot register photos');
  perform test.ok((select count(*) from public.issue_photos) = 0, 'a client cannot see issue photos');
  perform test.as_user(test.u(4));

  -- annotated copies: same rules as audit photos
  insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations)
  values (test.u(7110), test.u(101), i, pth || '.ann.jpg', repeat('b', 64), 100, test.u(4), now(), ph, pen::jsonb);
  perform test.ok(true, 'a marked-up copy of an issue photo is stored with its editable marks');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 'p/a1', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(7111), test.u(101), i, test.u(4), ph, '[{"type":"arrow","color":"#ff0000","width":0.01,"points":[[0,0]]}]'), 'check constraint', 'an unknown mark type is rejected');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotations) values (%L, %L, %L, 'p/a2', repeat('b',64), 1, %L, now(), %L::jsonb)$q$, test.u(7112), test.u(101), i, test.u(4), pen), 'issue_photos_annotation_pair', 'marks without an original are rejected');
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 'p/a3', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(7113), test.u(101), i, test.u(4), test.u(7110), pen), 'cannot annotate an annotated copy', 'a marked-up copy cannot itself be marked up');
  perform test.as_user(test.u(3));
  perform test.ok(test.iop(26, i, 5, jsonb_build_object('action', 'complete'), test.u(3)) ->> 'status' = 'applied', 'setup: complete the issue so a second one exists for the cross-issue check');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 'p/a4', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(7114), test.u(101), i2, test.u(4), ph, pen), 'same issue', 'a marked-up copy must stay on the original''s issue');
  perform test.raises(format($q$update public.issue_photos set storage_path = 'elsewhere' where id = %L$q$, ph), 'permission denied', 'users cannot edit photo records');
  perform test.raises(format($q$delete from public.issue_photos where id = %L$q$, ph), 'permission denied', 'photos cannot be deleted by users');
  perform test.as_postgres();
  perform test.raises(format($q$delete from public.issue_photos where id = %L$q$, ph), 'cannot be deleted', 'photos cannot be deleted even with full access');
  perform test.raises(format($q$update public.issue_photos set storage_path = 'elsewhere' where id = %L$q$, ph), 'immutable', 'photo records are immutable even with full access (except one-time confirmation)');

  -- ---- private storage ----
  perform test.as_user(test.u(4));
  perform test.raises($q$insert into storage.objects (bucket_id, name) values ('issue-photos', 'not/registered.jpg')$q$, 'row-level security', 'uploading to an unregistered path is refused');
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('audit-photos', %L)$q$, pth), 'row-level security', 'an issue photo path cannot be uploaded into the audit bucket');
  perform test.as_user(test.u(8));
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('issue-photos', %L)$q$, pth), 'row-level security', 'another user cannot upload to someone else''s registered path');
  perform test.as_user(test.u(4));
  insert into storage.objects (bucket_id, name, owner, metadata) values ('issue-photos', pth, test.u(4), '{"size": 999}');
  perform test.ok(true, 'the capturer can upload to their registered path');
  perform test.as_user(test.u(7));
  perform test.ok((select count(*) from storage.objects where name = pth) = 0, 'a client cannot read issue photo files');
  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from storage.objects where name = pth) = 1, 'an installer on the project can read the file');
  perform test.raises(format($q$select public.confirm_issue_photo(%L)$q$, ph), 'size_mismatch', 'confirming with the wrong stored size is refused');
  perform test.as_postgres();
  update storage.objects set metadata = '{"size": 2048}' where name = pth;
  perform test.as_user(test.u(8));
  perform test.raises(format($q$select public.confirm_issue_photo(%L)$q$, ph), 'role_not_authorized', 'another project member who did not take the photo cannot confirm it');
  perform test.as_user(test.u(4));
  perform public.confirm_issue_photo(ph);
  perform test.as_postgres();
  perform test.ok((select confirmed_at is not null from public.issue_photos where id = ph), 'a matching upload confirms the photo');
  perform test.as_user(test.u(4));
  perform public.confirm_issue_photo(ph);
  perform test.ok(true, 'confirming twice is harmless');
  perform test.as_postgres();
end $$;
rollback;

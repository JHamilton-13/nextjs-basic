-- Migration 1600: trades, the trade rule, void, who may change an issue, the damaged-part photo rule, builder contact on projects.
begin;
\ir fixtures.sql

-- extra people on project 1: a second active installer (u13). u2 is already the project's manager (the creator is added automatically).
insert into auth.users (id, email) values (test.u(13), 'inst3@phc.test');
insert into public.invites (email) values ('inst3@phc.test');
insert into public.project_members (project_id, user_id, role) values (test.u(101), test.u(13), 'installer');

create function test.iop(n integer, id uuid, base integer, payload jsonb, actor uuid default test.u(4)) returns jsonb language sql as $$
  select public.apply_op(test.op(n, 'room_issue', id::text, base, payload, actor))
$$;
create function test.trade(nm text) returns uuid language sql as $$ select id from public.trades where name = nm $$;
create function test.rejected_with(r jsonb, msg text) returns boolean language sql as $$ select r ->> 'status' = 'rejected' and r ->> 'message' = msg $$;

do $$
declare
  rm uuid := test.u(201); plumb uuid := test.trade('Plumbing'); r jsonb; t_new uuid; t_old uuid;
  i1 uuid := test.u(8001); i2 uuid := test.u(8002); i3 uuid := test.u(8003); i4 uuid := test.u(8004); i5 uuid := test.u(8005);
  ph uuid := test.u(8101);
  mk text := '{"action":"create","roomId":"%s","kind":"%s","title":"t"%s}';
begin
  -- ================= trades =================
  perform test.ok((select count(*) from public.trades where active) = 9, 'nine trades are seeded and active');
  perform test.ok((select array_agg(name order by sort_order) from public.trades) = array['Plumbing','Electrical','HVAC','Windows','Framing','Cabinetry','Drywall','Flooring','Other'], 'the seeded trades are the owner''s list, in order');

  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from public.trades) = 9, 'an installer can read the trades');
  perform test.raises($q$insert into public.trades (name) values ('Roofing')$q$, 'row-level security', 'an installer cannot add a trade');
  update public.trades set active = false where name = 'Other';
  perform test.as_postgres();
  perform test.ok((select active from public.trades where name = 'Other'), 'an installer cannot change a trade');
  perform test.as_user(test.u(7)); perform test.ok((select count(*) from public.trades) = 0, 'a client cannot read trades');
  perform test.as_user(test.u(6)); perform test.ok((select count(*) from public.trades) = 0, 'a general contractor cannot read trades');
  perform test.as_user(test.u(8)); perform test.ok((select count(*) from public.trades) = 0, 'a warehouse user cannot read trades');
  perform test.as_user(test.u(10)); perform test.ok((select count(*) from public.trades) = 0, 'a user with no project cannot read trades');
  perform test.as_user(test.u(11)); perform test.ok((select count(*) from public.trades) = 0, 'an uninvited user cannot read trades');

  perform test.as_user(test.u(2));                                              -- project manager
  insert into public.trades (name, sort_order) values ('Roofing', 100);
  perform test.ok(true, 'a project manager can add a trade');
  update public.trades set name = 'Roofing and gutters', active = false where name = 'Roofing';
  perform test.as_postgres();
  perform test.ok((select active from public.trades where name = 'Roofing and gutters') = false, 'a project manager can rename and deactivate a trade');
  perform test.raises($q$insert into public.trades (name) values (' plumbing ')$q$, 'trades_name_key', 'a duplicate trade name (any case, extra spaces) is refused');
  perform test.raises($q$insert into public.trades (name) values ('   ')$q$, 'check constraint', 'a blank trade name is refused');
  perform test.raises($q$delete from public.trades where name = 'Other'$q$, 'cannot be deleted', 'trades cannot be deleted, even with full access');
  perform test.as_user(test.u(2));
  perform test.raises($q$delete from public.trades where name = 'Other'$q$, 'permission denied', 'a manager cannot delete a trade');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.audit_log where table_name = 'trades') >= 2, 'trade changes are in the audit log');

  -- ================= the trade rule on new issues =================
  perform test.as_user(test.u(4));
  perform test.ok(test.rejected_with(test.iop(1, i1, 0, format(mk, rm, 'pre_install_correction', '')::jsonb), 'trade_required'), 'a Pre Install Correction without a trade is rejected as trade_required');
  perform test.ok(test.rejected_with(test.iop(2, i1, 0, format(mk, rm, 'pre_install_correction', ',"tradeId":null')::jsonb), 'trade_required'), 'a null trade is also trade_required');
  perform test.ok(test.rejected_with(test.iop(3, i1, 0, format(mk, rm, 'pre_install_correction', format(',"tradeId":"%s"', test.u(9999)))::jsonb), 'trade_not_found'), 'an unknown trade is rejected');
  perform test.ok(test.rejected_with(test.iop(4, i1, 0, format(mk, rm, 'pre_install_correction', ',"tradeId":"nope"')::jsonb), 'tradeId must be a uuid'), 'a trade id that is not a uuid is rejected');
  perform test.ok(test.rejected_with(test.iop(5, i1, 0, format(mk, rm, 'pre_install_correction', format(',"tradeId":"%s"', test.trade('Roofing and gutters')))::jsonb), 'trade_inactive'), 'a deactivated trade is not offered for new issues');
  perform test.ok(test.rejected_with(test.iop(6, i1, 0, format(mk, rm, 'punch_item', format(',"tradeId":"%s"', plumb))::jsonb), 'trade_not_allowed'), 'a trade on any other kind is rejected');
  perform test.as_postgres();
  perform test.ok(not exists (select 1 from public.room_issues where id = i1), 'rejected creates leave nothing behind');
  perform test.as_user(test.u(4));
  r := test.iop(7, i1, 0, format(mk, rm, 'pre_install_correction', format(',"tradeId":"%s"', plumb))::jsonb);
  perform test.ok(r ->> 'status' = 'applied', 'a Pre Install Correction with an active trade is accepted');
  perform test.ok((test.iop(8, i2, 0, format(mk, rm, 'touch_up', '')::jsonb)) ->> 'status' = 'applied', 'a Touch Up needs no trade');
  perform test.ok((test.iop(9, i3, 0, format(mk, rm, 'missing_part', '')::jsonb)) ->> 'status' = 'applied', 'a Missing part needs no trade');
  perform test.ok((test.iop(10, i4, 0, format(mk, rm, 'damaged_part', '')::jsonb)) ->> 'status' = 'applied', 'a Damaged part needs no trade');
  perform test.ok((test.iop(11, i5, 0, format(mk, rm, 'punch_item', '')::jsonb)) ->> 'status' = 'applied', 'a Punch Item needs no trade');
  perform test.as_postgres();
  perform test.ok((select trade_id from public.room_issues where id = i1) = plumb and (select count(*) from public.room_issues where trade_id is not null) = 1, 'only the Pre Install Correction stores a trade');
  perform test.ok((select not convalidated from pg_constraint where conname = 'room_issues_trade_rule'), 'the trade rule is NOT VALID, so rows that predate it are never rejected');
  perform test.raises(format($q$insert into public.room_issues (id, project_id, room_id, kind, title, raised_by, raised_at) values (%L, %L, %L, 'pre_install_correction', 'x', %L, now())$q$, test.u(8090), test.u(101), rm, test.u(4)), 'room_issues_trade_rule', 'the database itself refuses a new Pre Install Correction with no trade');
  perform test.raises(format($q$insert into public.room_issues (id, project_id, room_id, kind, trade_id, title, raised_by, raised_at) values (%L, %L, %L, 'touch_up', %L, 'x', %L, now())$q$, test.u(8091), test.u(101), rm, plumb, test.u(4)), 'room_issues_trade_rule', 'the database itself refuses a trade on any other kind');

  -- ================= editing: kind and trade changes =================
  perform test.as_user(test.u(4));
  r := test.iop(12, i1, 1, '{"action":"update","title":"Pipe in wrong place"}');
  perform test.ok(r ->> 'status' = 'applied', 'editing the title of a Pre Install Correction keeps its trade');
  r := test.iop(13, i1, 2, '{"action":"update","kind":"punch_item"}');
  perform test.ok(r ->> 'status' = 'applied', 'changing to another kind is accepted');
  perform test.as_postgres();
  perform test.ok((select trade_id is null from public.room_issues where id = i1), 'changing to another kind drops the trade');
  perform test.as_user(test.u(4));
  perform test.ok(test.rejected_with(test.iop(14, i1, 3, '{"action":"update","kind":"pre_install_correction"}'), 'trade_required'), 'changing to Pre Install Correction needs a trade');
  perform test.ok(test.rejected_with(test.iop(15, i1, 3, format('{"action":"update","tradeId":"%s"}', plumb)::jsonb), 'trade_not_allowed'), 'setting a trade without changing to Pre Install Correction is rejected');
  r := test.iop(16, i1, 3, format('{"action":"update","kind":"pre_install_correction","tradeId":"%s"}', test.trade('Electrical'))::jsonb);
  perform test.ok(r ->> 'status' = 'applied', 'changing to Pre Install Correction with a trade is accepted');
  perform test.ok(test.rejected_with(test.iop(17, i1, 4, format('{"action":"update","tradeId":"%s"}', test.trade('Roofing and gutters'))::jsonb), 'trade_inactive'), 'switching to a deactivated trade is rejected');
  r := test.iop(18, i1, 4, format('{"action":"update","tradeId":"%s"}', test.trade('HVAC'))::jsonb);
  perform test.ok(r ->> 'status' = 'applied', 'switching to another active trade is accepted');
  -- a trade that is deactivated AFTER it was chosen stays on the issue and does not block editing
  perform test.as_postgres();
  update public.trades set active = false where name = 'HVAC';
  perform test.as_user(test.u(4));
  r := test.iop(19, i1, 5, '{"action":"update","description":"still HVAC"}');
  perform test.ok(r ->> 'status' = 'applied', 'an issue keeps a trade that was deactivated later, and can still be edited');
  perform test.as_postgres();
  perform test.ok((select trade_id from public.room_issues where id = i1) = test.trade('HVAC'), 'the deactivated trade is still shown on the existing issue');

  -- ================= who may change an issue: the raiser or a manager =================
  perform test.as_user(test.u(13));                                             -- a different installer on the same project
  perform test.ok((select count(*) from public.room_issues) = 5, 'an installer sees issues raised by other installers on the same project');
  perform test.raises(format($q$select test.iop(20, %L, 1, '{"action":"update","title":"mine now"}', test.u(13))$q$, i2), 'only the person who raised', 'another installer cannot edit someone else''s issue');
  perform test.raises(format($q$select test.iop(21, %L, 1, '{"action":"complete"}', test.u(13))$q$, i2), 'only the person who raised', 'another installer cannot complete it');
  perform test.raises(format($q$select test.iop(22, %L, 1, '{"action":"void"}', test.u(13))$q$, i2), 'only the person who raised', 'another installer cannot void it');
  perform test.as_user(test.u(3));                                              -- installation manager
  perform test.ok(test.iop(23, i2, 1, '{"action":"complete","note":"done by manager"}', test.u(3)) ->> 'status' = 'applied', 'a manager can complete someone else''s issue');
  perform test.as_user(test.u(13));
  perform test.raises(format($q$select test.iop(24, %L, 2, '{"action":"reopen"}', test.u(13))$q$, i2), 'only the person who raised', 'another installer cannot reopen it');
  perform test.as_user(test.u(4));
  perform test.ok(test.iop(25, i2, 2, '{"action":"reopen"}') ->> 'status' = 'applied', 'the installer who raised it can reopen it');
  perform test.ok(test.iop(26, i2, 3, '{"action":"complete"}') ->> 'status' = 'applied', 'and complete it again');
  perform test.as_user(test.u(2));
  perform test.ok(test.iop(27, i2, 4, '{"action":"reopen"}', test.u(2)) ->> 'status' = 'applied', 'a project manager can reopen it');

  -- ================= void =================
  perform test.as_user(test.u(4));
  r := test.iop(28, i5, 1, '{"action":"void","note":"raised in the wrong room"}');
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 2, 'the raiser can void an issue, with a note');
  perform test.as_postgres();
  perform test.ok((select voided_by = test.u(4) and voided_at = '2026-11-08T10:00:00Z'::timestamptz and void_note = 'raised in the wrong room' from public.room_issues where id = i5), 'who voided it, when, and why are recorded');
  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from public.room_issues where id = i5) = 1, 'a voided issue is kept and still readable (the app hides it by default)');
  perform test.ok(test.rejected_with(test.iop(29, i5, 2, '{"action":"update","title":"x"}'), 'issue_void'), 'a voided issue cannot be edited');
  perform test.ok(test.rejected_with(test.iop(30, i5, 2, '{"action":"complete"}'), 'issue_void'), 'a voided issue cannot be completed');
  perform test.ok(test.rejected_with(test.iop(31, i5, 2, '{"action":"reopen"}'), 'issue_void'), 'a voided issue cannot be reopened');
  perform test.ok(test.rejected_with(test.iop(32, i5, 2, '{"action":"void"}'), 'issue_void'), 'a voided issue cannot be voided twice');
  perform test.as_user(test.u(3));
  perform test.ok(test.iop(33, i3, 1, '{"action":"void"}', test.u(3)) ->> 'status' = 'applied', 'a manager can void someone else''s issue');
  perform test.as_user(test.u(4));
  perform test.ok(test.iop(34, i2, 5, '{"action":"complete"}') ->> 'status' = 'applied', 'setup: complete an issue');
  perform test.ok(test.iop(35, i2, 6, '{"action":"void"}') ->> 'status' = 'applied', 'a completed issue can be voided');
  perform test.as_postgres();
  perform test.raises(format($q$update public.room_issues set voided_by = %L where id = %L$q$, test.u(4), i4), 'room_issues_void_pair', 'the database refuses a void with no time');

  -- ================= Damaged part needs a photo to complete =================
  perform test.as_user(test.u(4));
  perform test.ok(test.rejected_with(test.iop(36, i4, 1, '{"action":"complete"}'), 'photo_required'), 'a Damaged part cannot be completed without a photo');
  insert into public.issue_photos (id, project_id, issue_id, storage_path, checksum_sha256, bytes, captured_by, captured_at)
  values (ph, test.u(101), i4, test.u(101) || '/issues/' || i4 || '/1.jpg', repeat('a', 64), 100, test.u(4), now());
  perform test.ok(test.iop(37, i4, 1, '{"action":"complete","note":"replaced"}') ->> 'status' = 'applied', 'a Damaged part can be completed once an original photo is registered');
  perform test.ok(test.iop(38, i4, 2, '{"action":"reopen"}') ->> 'status' = 'applied', 'setup: reopen it');
  perform test.ok(test.iop(39, i4, 3, '{"action":"update","kind":"missing_part"}') ->> 'status' = 'applied', 'a Damaged part can be re-categorised as a Missing part');
  perform test.ok(test.iop(40, i4, 4, '{"action":"complete"}') ->> 'status' = 'applied', 'a Missing part needs no photo to complete');
  perform test.ok(test.iop(41, i3, 2, '{"action":"update","kind":"damaged_part"}', test.u(3)) ->> 'status' = 'rejected', 'setup check: a voided issue cannot be changed to Damaged part');

  -- ================= builder contact on projects =================
  perform test.as_user(test.u(2));                                              -- project manager
  update public.projects set prepared_for_name = 'Fake Builder Co', prepared_for_email = 'builder@example.test', address = '1 Fake Street, Nowhere' where id = test.u(101);
  perform test.as_postgres();
  perform test.ok((select prepared_for_name = 'Fake Builder Co' and prepared_for_email = 'builder@example.test' and address = '1 Fake Street, Nowhere' from public.projects where id = test.u(101)), 'a project manager can enter the builder name, email and site address');
  perform test.ok((select count(*) from public.audit_log where table_name = 'projects' and record_id = test.u(101)::text and details::text like '%builder@example.test%') >= 1, 'the change is in the audit log');
  perform test.as_user(test.u(4));
  update public.projects set prepared_for_email = 'someone@example.test' where id = test.u(101);
  perform test.as_postgres();
  perform test.ok((select prepared_for_email from public.projects where id = test.u(101)) = 'builder@example.test', 'an installer cannot change the builder contact');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$update public.projects set prepared_for_email = 'not an email' where id = %L$q$, test.u(101)), 'check constraint', 'an invalid builder email is refused');
  perform test.raises(format($q$update public.projects set prepared_for_name = '   ' where id = %L$q$, test.u(101)), 'check constraint', 'a blank builder name is refused');
  perform test.as_postgres();
  perform test.ok(app.is_valid_email('a@b.com') and app.is_valid_email('first.last+tag@sub.example.co.uk') and app.is_valid_email('builder@example.test'), 'is_valid_email accepts ordinary addresses');
  perform test.ok(not (app.is_valid_email('a@b') or app.is_valid_email(' ') or app.is_valid_email('') or app.is_valid_email('a b@c.com') or app.is_valid_email('@b.com')
    or app.is_valid_email('a@') or app.is_valid_email('a@@b.com') or app.is_valid_email('a@b..com') or app.is_valid_email('a@.com') or app.is_valid_email('a@b.')
    or app.is_valid_email('a@b.c') or app.is_valid_email('a,b@c.com') or app.is_valid_email(E'a@b.com\nBcc: x@y.com') or app.is_valid_email(' a@b.com')
    or app.is_valid_email('a@b.com ') or app.is_valid_email('a"b@c.com') or app.is_valid_email('a<b@c.com') or app.is_valid_email('a[b@c.com')
    or app.is_valid_email(repeat('a', 65) || '@example.com') or app.is_valid_email(null)), 'is_valid_email rejects the same bad addresses as the app''s check');
end $$;
rollback;

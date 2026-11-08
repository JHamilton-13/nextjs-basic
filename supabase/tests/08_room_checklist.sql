-- Room checklist: pills (done / not_done with required note / n/a / clear), attribution, conflicts, roles, idempotency.
begin;
\ir fixtures.sql

do $$
declare
  rm uuid := test.u(201); k text := 'finished_toes'; r jsonb;
  ts text := '2026-11-08T09:15:00Z';
  function_note text := 'Toe skins installed after wood floor installation. After 11/5';
begin
  perform test.as_user(test.u(4));                                              -- installer
  r := public.apply_op(jsonb_set(test.op(1, 'room_check', rm || ':cabinetry_matches_plans', 0, '{"state":"done"}', test.u(4)), '{createdAt}', to_jsonb(ts)));
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 1, 'an installer can tick an item done');
  perform test.as_postgres();
  perform test.ok((select checked_by from public.room_checks where room_id = rm and item_key = 'cabinetry_matches_plans') = test.u(4)
    and (select checked_at from public.room_checks where room_id = rm and item_key = 'cabinetry_matches_plans') = ts::timestamptz, 'who and on-site time are recorded');
  perform test.ok((select project_id from public.room_checks where room_id = rm and item_key = 'cabinetry_matches_plans') = test.u(101), 'the row carries the room''s project');

  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(2, 'room_check', rm || ':' || k, 0, '{"state":"not_done"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'not_done without a note is rejected');
  r := public.apply_op(test.op(3, 'room_check', rm || ':' || k, 0, jsonb_build_object('state', 'not_done', 'note', '   '), test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'not_done with a blank note is rejected');
  r := public.apply_op(test.op(4, 'room_check', rm || ':' || k, 0, jsonb_build_object('state', 'not_done', 'note', function_note), test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'not_done with an explaining note is accepted');
  perform test.as_postgres();
  perform test.ok((select note from public.room_checks where room_id = rm and item_key = k) = function_note, 'the note is stored as written');

  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(5, 'room_check', rm || ':' || k, 1, '{"state":"done"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied' and (r ->> 'newVersion')::int = 2, 'completing a not_done item bumps the version');
  r := public.apply_op(test.op(6, 'room_check', rm || ':' || k, 1, '{"state":"na"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'conflict' and (r ->> 'currentVersion')::int = 2, 'a stale base version is a conflict, not an overwrite');
  r := public.apply_op(test.op(5, 'room_check', rm || ':' || k, 1, '{"state":"done"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'duplicate', 'replaying the same opId is a harmless duplicate');
  r := public.apply_op(test.op(7, 'room_check', rm || ':' || k, 2, '{"state":"na"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'an item can be marked N/A');
  r := public.apply_op(test.op(8, 'room_check', rm || ':' || k, 3, '{"state":"clear"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'an item can be unticked (clear)');
  perform test.as_postgres();
  perform test.ok(not exists (select 1 from public.room_checks where room_id = rm and item_key = k), 'clear removes the row');
  perform test.ok((select count(*) from public.audit_log where table_name = 'room_checks' and record_id like rm::text || '%') >= 4, 'every change, including the untick, is in the audit log');

  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(9, 'room_check', rm || ':made_up_item', 0, '{"state":"done"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'an unknown checklist item is rejected');
  r := public.apply_op(test.op(10, 'room_check', rm || ':' || k, 0, '{"state":"finished"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'an unknown state is rejected');
  r := public.apply_op(test.op(11, 'room_check', test.u(9999) || ':' || k, 0, '{"state":"done"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'a room that does not exist is rejected');
  perform test.as_postgres();

  -- roles
  perform test.as_user(test.u(4));
  perform test.ok((select count(*) from public.room_checks where room_id = rm) = 1, 'an installer can read the checklist');
  perform test.as_user(test.u(5));                                              -- installer on a different project
  perform test.ok((select count(*) from public.room_checks where room_id = rm) = 0, 'a user outside the project cannot see the checklist');
  perform test.raises(format($q$select public.apply_op(test.op(12, 'room_check', %L, 0, '{"state":"done"}', test.u(5)))$q$, rm || ':' || k), 'insufficient privilege', 'an installer on another project cannot tick items here');
  perform test.as_user(test.u(7));                                              -- client
  perform test.raises(format($q$select public.apply_op(test.op(13, 'room_check', %L, 0, '{"state":"done"}', test.u(7)))$q$, rm || ':' || k), 'insufficient privilege', 'a client cannot tick items');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$insert into public.room_checks (room_id, item_key, project_id, state, checked_by, checked_at) values (%L, 'shelves', %L, 'done', %L, now())$q$, rm, test.u(101), test.u(4)), 'permission denied', 'there is no way to write checks except through apply_op');
  perform test.as_postgres();
end $$;
rollback;

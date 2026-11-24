-- apply_op: idempotency, version conflicts, server-side validation (scenarios 12, 13, 14).
begin;
\ir fixtures.sql

do $$
declare
  a uuid := test.u(301); r jsonb; w text := 'wall_length';
begin
  -- tolerance function boundaries mirror packages/domain (expected 120" = 7680; +/-1/2" = 32; band 1" = 64)
  perform test.ok(app.evaluate_tolerance(7680, 7680, 32, 32, 64) = 'PASS', 'exact match is PASS');
  perform test.ok(app.evaluate_tolerance(7712, 7680, 32, 32, 64) = 'PASS', 'exactly +1/2" is PASS');
  perform test.ok(app.evaluate_tolerance(7648, 7680, 32, 32, 64) = 'PASS', 'exactly -1/2" is PASS');
  perform test.ok(app.evaluate_tolerance(7713, 7680, 32, 32, 64) = 'REVIEW', '1/64" over +1/2" is REVIEW');
  perform test.ok(app.evaluate_tolerance(7647, 7680, 32, 32, 64) = 'REVIEW', '1/64" under -1/2" is REVIEW');
  perform test.ok(app.evaluate_tolerance(7744, 7680, 32, 32, 64) = 'REVIEW', 'exactly +1" is REVIEW');
  perform test.ok(app.evaluate_tolerance(7616, 7680, 32, 32, 64) = 'REVIEW', 'exactly -1" is REVIEW');
  perform test.ok(app.evaluate_tolerance(7745, 7680, 32, 32, 64) = 'FAIL', '1/64" over +1" is FAIL');
  perform test.ok(app.evaluate_tolerance(7615, 7680, 32, 32, 64) = 'FAIL', '1/64" under -1" is FAIL');
  perform test.ok(app.evaluate_tolerance(7681, 7680, 32, 32, null) = 'PASS' and app.evaluate_tolerance(7713, 7680, 32, 32, null) = 'FAIL', 'no review band: over tolerance is FAIL');

  -- create audit
  r := test.new_audit(a);
  perform test.ok(r = '{"status":"applied","newVersion":1}', 'create audit is applied');
  perform test.ok((select count(*) from public.audits where audit_id = a) = 1, 'one audit row exists');
  perform test.ok((select count(*) from public.audit_items where audit_id = a) = 42, 'items were created from the template (42)');
  perform test.ok((select count(*) from public.audit_items where audit_id = a and critical) = 8, 'exactly the 8 MEP items are critical');

  -- replay the identical op (client never saw the response: scenarios 12/14)
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(1, 'audit_item', a || ':1:' || w, 0,
        '{"actual64":7712,"expected64":7680,"drawingRef":"A-201 rev C"}'::jsonb, test.u(4)));
  perform test.ok(r = '{"status":"applied","newVersion":1}', 'first measurement is applied');
  r := public.apply_op(test.op(1, 'audit_item', a || ':1:' || w, 0,
        '{"actual64":7712,"expected64":7680,"drawingRef":"A-201 rev C"}'::jsonb, test.u(4)));
  perform test.ok(r = '{"status":"duplicate","original":{"status":"applied","newVersion":1}}', 'replaying the same opId returns duplicate with the original outcome');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.measurements where audit_id = a) = 1, 'the replay did not create a second measurement');
  perform test.ok((select count(*) from public.applied_ops where op_id = test.u(1001)) = 1, 'exactly one applied_ops row for the op');
  perform test.ok((select result from public.audit_items where audit_id = a and item_key = w) = 'PASS', 'item result computed by the server (PASS at +1/2")');
  perform test.ok((select deviation_64 from public.measurements where audit_id = a) = 32, 'deviation recorded');
  perform test.ok((select user_id from public.measurements where audit_id = a) = test.u(4), 'measurement records the user');
  perform test.ok((select plus_64 from public.measurements where audit_id = a) = 32, 'tolerance recorded from template rule data');

  -- stale base version = conflict, no overwrite (scenario 13: two users edit offline)
  perform test.as_user(test.u(4));
  r := test.item(2, a, w, 0, '{"actual64":7800,"expected64":7680,"drawingRef":"x"}'::jsonb);
  perform test.ok(r = '{"status":"conflict","currentVersion":1,"baseVersion":0}', 'stale baseVersion returns conflict');
  perform test.as_postgres();
  perform test.ok((select result from public.audit_items where audit_id = a and item_key = w) = 'PASS' and (select count(*) from public.measurements where audit_id = a) = 1,
    'the conflicting write changed nothing');
  perform test.as_user(test.u(4));
  r := test.item(2, a, w, 0, '{"actual64":7800,"expected64":7680,"drawingRef":"x"}'::jsonb);
  perform test.ok(r ->> 'status' = 'duplicate' and r #>> '{original,status}' = 'conflict', 'retrying a conflicted opId returns the same conflict');

  -- client-supplied result is ignored; server evaluates
  r := test.item(3, a, w, 1, '{"actual64":7790,"expected64":7680,"drawingRef":"x","result":"PASS"}'::jsonb);
  perform test.ok(r = '{"status":"applied","newVersion":2}', 'fresh baseVersion applies');
  perform test.as_postgres();
  perform test.ok((select result from public.audit_items where audit_id = a and item_key = w) = 'FAIL', 'client-claimed PASS is ignored; server computes FAIL (+110/64")');
  perform test.ok((select count(*) from public.measurements where audit_id = a) = 2, 'earlier measurement is kept (history)');

  -- evidence rules enforced server-side
  perform test.as_user(test.u(4));
  r := test.item(4, a, w, 2, '{"actual64":7680,"expected64":7680}'::jsonb);
  perform test.ok(r ->> 'status' = 'rejected' and r ->> 'message' = 'evidence_missing: drawingRef', 'tolerance item without drawing reference is rejected');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.applied_ops where op_id = test.u(1004)) = 0, 'rejected ops are not recorded');
  perform test.as_user(test.u(4));
  r := test.item(4, a, w, 2, '{"actual64":7680,"expected64":7680,"drawingRef":"A-201 rev C"}'::jsonb);
  perform test.ok(r = '{"status":"applied","newVersion":3}', 'the same opId succeeds once the evidence is supplied');
  r := test.item(5, a, 'outlets', 0, '{"result":"PASS"}'::jsonb);
  perform test.ok(r ->> 'message' = 'evidence_missing: photo', 'MEP item without a photo is rejected');
  perform test.as_postgres();
  perform test.add_photo(1, a, 1, 'outlets', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  r := test.item(5, a, 'outlets', 0, '{"result":"PASS"}'::jsonb);
  perform test.ok(r = '{"status":"applied","newVersion":1}', 'MEP item with a registered photo is applied');
  r := test.item(6, a, 'access', 0, '{"result":"MAYBE"}'::jsonb);
  perform test.ok(r ->> 'status' = 'rejected', 'an invalid result value is rejected');
  r := test.item(7, a, 'wall_plumb', 0, '{}'::jsonb);
  perform test.ok(r = '{"status":"applied","newVersion":1}' and (select result from public.audit_items where audit_id = a and item_key = 'wall_plumb') = 'OBSERVED', 'observation items record OBSERVED with no pass/fail');
  r := test.item(8, a, 'no_such_item', 0, '{"result":"PASS"}'::jsonb);
  perform test.ok(r ->> 'status' = 'rejected', 'unknown item is rejected');
  r := test.item(9, a, w, 3, '{"actual64":-5,"expected64":7680,"drawingRef":"x"}'::jsonb);
  perform test.ok(r ->> 'status' = 'rejected', 'negative measurement is rejected');
  r := test.item(10, a, w, 3, '{"actual64":1.5,"expected64":7680,"drawingRef":"x"}'::jsonb);
  perform test.ok(r ->> 'status' = 'rejected', 'non-integer measurement is rejected');

  -- envelope validation
  perform test.ok(public.apply_op(jsonb_set(test.op(20, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(4)), '{opId}', '"nope"'))->>'status' = 'rejected', 'bad opId rejected');
  perform test.ok(public.apply_op(jsonb_set(test.op(21, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(4)), '{baseVersion}', '-1'))->>'status' = 'rejected', 'negative baseVersion rejected');
  perform test.ok(public.apply_op(jsonb_set(test.op(22, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(4)), '{payload}', '[]'))->>'status' = 'rejected', 'array payload rejected');
  perform test.ok(public.apply_op(jsonb_set(test.op(23, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(4)), '{createdAt}', '"yesterday"'))->>'status' = 'rejected', 'bad createdAt rejected');
  perform test.ok(public.apply_op(test.op(24, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(2)))->>'status' = 'rejected', 'actor must equal the authenticated user');
  perform test.ok(public.apply_op(test.op(25, 'mystery', 'x', 0, '{}', test.u(4)))->>'status' = 'rejected', 'unsupported entity rejected');
  perform test.ok(public.apply_op('"str"'::jsonb)->>'status' = 'rejected', 'non-object op rejected');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.applied_ops where op_id between test.u(1020) and test.u(1025)) = 0, 'invalid envelopes are never recorded');

  -- permissions
  perform test.as_user(test.u(5));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(30, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(5))), '42501', 'a member of another project cannot write to this audit');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(31, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(6))), '42501', 'a general contractor cannot record audit results');
  perform test.as_user(test.u(8));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(32, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(8))), '42501', 'warehouse cannot record audit results');
  perform test.as_user(test.u(3));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(1, 'audit_item', a || ':1:access', 0, '{"result":"PASS"}', test.u(3))), '42501', 'another user cannot reuse someone else''s opId');
  perform test.as_user(test.u(5));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(33, 'audit', test.u(302) || ':1', 0,
    jsonb_build_object('action','create','projectId',test.u(101),'templateId',test.tmpl()), test.u(5))), '42501', 'cannot create an audit on a project you are not on');

  -- submit, then writes are refused
  perform test.as_user(test.u(4));
  r := test.submit(40, a, 1);
  perform test.ok(r = '{"status":"applied","newVersion":2}', 'submit is applied');
  r := test.submit(41, a, 1);
  perform test.ok(r ->> 'status' = 'conflict', 'submitting again with a stale base is a conflict');
  r := test.submit(42, a, 2);
  perform test.ok(r ->> 'message' = 'audit_submitted', 'submitting an already-submitted audit is rejected');
  r := test.item(43, a, 'lighting', 0, '{"result":"PASS"}'::jsonb);
  perform test.ok(r ->> 'message' = 'audit_submitted', 'results cannot be recorded after submit');
  perform test.as_postgres();
end $$;
rollback;

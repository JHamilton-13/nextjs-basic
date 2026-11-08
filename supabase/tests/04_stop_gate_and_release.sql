-- Stop-gate, documented override, release, revision (scenarios 3, 4, 5, 16, 18, 19, 20).
begin;
\ir fixtures.sql

-- critical MEP failure blocks release; only a manager override (with reason) lifts it
do $$
declare
  a uuid := test.u(310); r jsonb; v_ov uuid; v_rel uuid; v_detail text; v_msg text;
begin
  perform test.new_audit(a);
  perform test.add_photo(1, a, 1, 'plumbing_rough_in', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  r := test.item(1, a, 'plumbing_rough_in', 0, '{"result":"FAIL","note":"Water line 6in left of fridge spec"}'::jsonb);
  perform test.ok(r = '{"status":"applied","newVersion":1}', 'installer records a critical MEP FAIL');
  perform test.as_postgres();
  perform test.ok(app.audit_state(a, 1) = 'not_ready', 'a critical FAIL makes the audit NOT READY immediately');

  perform test.ok((select count(*) from public.notifications where related_audit_id = a) = 2, 'two managers were notified');
  perform test.ok((select array_agg(user_id order by user_id) from public.notifications where related_audit_id = a) = array[test.u(2), test.u(3)], 'the project manager and installation manager were notified (not installer, GC, client, warehouse)');
  perform test.ok((select bool_and(priority = 'critical' and type = 'critical_fail') from public.notifications where related_audit_id = a), 'notifications are critical critical_fail');
  perform test.ok((select count(*) from public.email_outbox o join public.notifications n on n.id = o.notification_id where n.related_audit_id = a and o.status = 'queued') = 2, 'queued email records were created (no live send)');
  perform test.ok((select count(*) from public.email_outbox o join public.notifications n on n.id = o.notification_id where n.related_audit_id = a and o.to_email in ('pm1@phc.test','im1@phc.test')) = 2, 'emails address the managers');

  perform test.as_user(test.u(4));
  r := test.item(2, a, 'plumbing_rough_in', 1, '{"result":"FAIL","note":"Still failing"}'::jsonb);
  perform test.as_postgres();
  perform test.ok((select count(*) from public.notifications where related_audit_id = a) = 2, 'FAIL -> FAIL does not send duplicate notifications');

  -- cannot release before submit
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), 'inspection_not_complete', 'release before the audit is submitted is refused');
  perform test.as_user(test.u(4));
  r := test.submit(3, a, 1);
  perform test.ok(r ->> 'status' = 'applied', 'installer submits the failed audit (inspection completed)');
  perform test.ok(app.audit_state(a, 1) = 'not_ready', 'completed inspection is still NOT READY: completed is not authorized');

  -- scenario 4: installer tries to proceed
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), '42501', 'installer cannot release a failed audit');
  perform test.raises(format($q$select public.grant_override(%L, 1, 'need to work', '{}')$q$, a), '42501', 'installer cannot grant an override');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), '42501', 'general contractor cannot release');
  perform test.as_user(test.u(8));
  perform test.raises(format($q$select public.grant_override(%L, 1, 'x', '{}')$q$, a), '42501', 'warehouse cannot grant an override');
  perform test.as_user(test.u(9));
  perform test.raises(format($q$select public.grant_override(%L, 1, 'x', '{}')$q$, a), '42501', 'a manager of another project cannot grant an override');

  -- gc/client cannot see the unreleased audit
  perform test.as_user(test.u(6));
  perform test.ok((select count(*) from public.audits where audit_id = a) = 0, 'general contractor cannot see an unreleased audit');
  perform test.as_user(test.u(7));
  perform test.ok((select count(*) from public.audit_items where audit_id = a) = 0 and (select count(*) from public.project_readiness) = 0, 'client cannot see unreleased items or readiness');
  perform test.as_user(test.u(8));
  perform test.ok((select count(*) from public.audits where audit_id = a) = 1, 'warehouse (project member) can see the audit');

  -- scenario 5: manager release needs a documented override
  perform test.as_user(test.u(2));
  begin
    perform public.release_audit(a, 1);
    raise exception 'NOT OK - release succeeded without an override';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail; v_msg := sqlerrm;
  end;
  perform test.ok(v_msg = 'override_required' and v_detail = 'failed_items=plumbing_rough_in', 'manager release without override is refused and lists the failed items');
  perform test.raises(format($q$select public.grant_override(%L, 1, '   ', '{}')$q$, a), 'reason_required', 'override needs a non-blank reason');
  perform test.raises(format($q$select public.grant_override(%L, 1, null, '{}')$q$, a), 'reason_required', 'override needs a reason (null)');
  perform test.raises(format($q$select public.grant_override(%L, 2, 'r', '{}')$q$, a), 'audit_not_found', 'override must reference an existing audit version');
  v_ov := public.grant_override(a, 1, 'GC will relocate water line Monday; cabinets staged only', array['doc-123']);
  perform test.as_postgres();
  perform test.ok((select role = 'project_manager' and granted_by = test.u(2) and version = 1 and reason like 'GC will%' and supporting_doc_ids = array['doc-123'] from public.overrides where id = v_ov),
    'override records approver, resolved role, audit version, reason and documents');
  perform test.ok(app.audit_state(a, 1) = 'not_ready', 'granting an override does not change the audit result');
  perform test.ok((select count(*) from public.releases where audit_id = a) = 0, 'granting an override does not release');
  perform test.raises(format($q$update public.overrides set reason = 'changed' where id = %L$q$, v_ov), 'insert-only', 'overrides are immutable');
  perform test.raises(format($q$delete from public.overrides where id = %L$q$, v_ov), 'insert-only', 'overrides cannot be deleted');

  perform test.as_user(test.u(4));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), '42501', 'after an override an installer still cannot release');
  perform test.as_user(test.u(2));
  v_rel := public.release_audit(a, 1);
  perform test.as_postgres();
  perform test.ok((select basis = 'override' and override_id = v_ov and released_by = test.u(2) and role = 'project_manager' from public.releases where id = v_rel), 'release records basis=override with the override and releaser');
  perform test.ok(app.audit_state(a, 1) = 'released_for_installation', 'state is released_for_installation');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), 'already_released', 'cannot release twice');
  perform test.raises(format($q$select public.grant_override(%L, 1, 'again', '{}')$q$, a), 'already_released', 'no override after release');
  perform test.as_postgres();
  perform test.raises(format($q$update public.releases set basis = 'clear' where id = %L$q$, v_rel), 'insert-only', 'releases are immutable');
  perform test.raises(format($q$delete from public.releases where id = %L$q$, v_rel), 'insert-only', 'releases cannot be deleted');

  perform test.as_user(test.u(6));
  perform test.ok((select count(*) from public.audits where audit_id = a) = 1 and (select count(*) from public.audit_items where audit_id = a) = 42, 'after release the general contractor can see the audit');
  perform test.as_user(test.u(7));
  perform test.ok((select state from public.project_readiness where audit_id = a) = 'released_for_installation', 'client sees released readiness');
  perform test.as_postgres();
end $$;

-- scenario 16/20: revising creates version 2; the old override and release do not carry over
do $$
declare
  a uuid := test.u(310); v_new integer; r jsonb; v_ov2 uuid; v_ver integer;
begin
  perform test.as_user(test.u(4));
  perform test.raises(format($q$select public.revise_audit(%L, ' ')$q$, a), 'reason_required', 'revision needs a reason');
  v_new := public.revise_audit(a, 'Re-measured after GC moved water line');
  perform test.ok(v_new = 2, 'installer can revise a submitted audit; version 2 is created');
  perform test.raises(format($q$select public.revise_audit(%L, 'again')$q$, a), 'not_submitted', 'an unsubmitted latest version cannot be revised again');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.audit_items where audit_id = a and version = 2) = 42, 'version 2 has all items');
  perform test.ok((select result from public.audit_items where audit_id = a and version = 2 and item_key = 'plumbing_rough_in') = 'FAIL', 'item results carry over for correction');
  perform test.ok((select count(*) from public.measurements where audit_id = a and version = 2) = 0, 'measurement history stays with version 1');
  perform test.ok(app.audit_state(a, 1) = 'released_for_installation', 'version 1 keeps its released history');
  perform test.ok(app.audit_state(a, 2) = 'not_ready', 'version 2 is a fresh NOT READY audit');
  perform test.ok((select count(*) from public.releases where audit_id = a and version = 2) = 0, 'no release exists for version 2');

  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(60, 'audit', a || ':2', 1, '{"action":"submit"}', test.u(4)));
  perform test.ok(r = '{"status":"applied","newVersion":2}', 'version 2 can be submitted');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.release_audit(%L, 2)$q$, a), 'override_required', 'the version 1 override does not authorize version 2');
  perform test.raises(format($q$select public.grant_override(%L, 1, 'late', '{}')$q$, a), 'not_latest_version', 'an override cannot target a superseded version');
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, a), 'not_latest_version', 'a superseded version cannot be released again');
  v_ov2 := public.grant_override(a, 2, 'Still waiting on GC; approved to stage materials', '{}');
  perform public.release_audit(a, 2);
  perform test.as_postgres();
  perform test.ok((select count(*) from public.overrides where audit_id = a) = 2 and (select count(*) from public.releases where audit_id = a) = 2, 'both overrides and both releases are kept as history');

  perform test.as_user(test.u(7));
  perform test.ok((select version from public.project_readiness where audit_id = a) = 2, 'client sees the latest released version');
  perform test.as_postgres();
end $$;

-- clean audit, decision 4 (submit with nothing entered), admin release, non-critical policies
do $$
declare
  b uuid := test.u(311); c uuid := test.u(312); d uuid := test.u(313); e uuid := test.u(314); f uuid := test.u(315);
  t2 uuid := test.u(401); r jsonb; v_rel uuid;
begin
  -- clean path
  perform test.new_audit(b);
  perform test.add_photo(2, b, 1, 'plumbing_rough_in', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(70, 'audit_item', b || ':1:plumbing_rough_in', 0, '{"result":"PASS"}', test.u(4)));
  r := public.apply_op(test.op(71, 'audit_item', b || ':1:wall_length', 0, '{"actual64":7680,"expected64":7680,"drawingRef":"A-1"}', test.u(4)));
  r := public.apply_op(test.op(72, 'audit', b || ':1', 1, '{"action":"submit"}', test.u(4)));
  perform test.as_postgres();
  perform test.ok(app.audit_state(b, 1) = 'ready', 'a clean submitted audit is ready');
  perform test.as_user(test.u(3));
  perform test.raises(format($q$select public.grant_override(%L, 1, 'unneeded', '{}')$q$, b), 'override_not_needed', 'no override on a ready audit');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, b), '42501', 'installer cannot release even a ready audit (managers only)');
  perform test.as_user(test.u(3));
  v_rel := public.release_audit(b, 1);
  perform test.as_postgres();
  perform test.ok((select basis = 'clear' and override_id is null and role = 'installation_manager' from public.releases where id = v_rel), 'clean release records basis=clear');

  -- owner decision 4: an audit can be submitted with nothing entered, and then it is ready
  perform test.new_audit(c);
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(73, 'audit', c || ':1', 1, '{"action":"submit"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'an audit with no results entered can be submitted');
  perform test.as_postgres();
  perform test.ok(app.audit_state(c, 1) = 'ready', 'a submitted audit with nothing entered is derived as ready (owner decision 2026-11-08)');
  perform test.as_user(test.u(1));
  v_rel := public.release_audit(c, 1);
  perform test.as_postgres();
  perform test.ok((select role = 'admin' from public.releases where id = v_rel), 'admin can release; role recorded as admin');

  -- non-critical FAIL follows the template policy (manager_review_required)
  perform test.new_audit(d);
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(74, 'audit_item', d || ':1:wall_length', 0, '{"actual64":7800,"expected64":7680,"drawingRef":"A-1"}', test.u(4)));
  r := public.apply_op(test.op(75, 'audit', d || ':1', 1, '{"action":"submit"}', test.u(4)));
  perform test.as_postgres();
  perform test.ok(app.audit_state(d, 1) = 'manager_review_required', 'non-critical FAIL -> manager_review_required (policy)');
  perform test.ok((select count(*) from public.notifications where related_audit_id = d) = 0, 'a non-critical FAIL sends no stop-gate notification');
  perform test.as_user(test.u(3));
  perform test.raises(format($q$select public.release_audit(%L, 1)$q$, d), 'override_required', 'manager-review audit needs an override to release');

  -- wall length REVIEW zone (1/2" < dev <= 1") is also manager review
  perform test.new_audit(f);
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(80, 'audit_item', f || ':1:wall_length', 0, '{"actual64":7730,"expected64":7680,"drawingRef":"A-1"}', test.u(4)));
  perform test.as_postgres();
  perform test.ok((select result from public.audit_items where audit_id = f and item_key = 'wall_length') = 'REVIEW', '+50/64" on wall length is REVIEW');

  -- critical REVIEW: manager review, no block, no alert
  perform test.new_audit(e);
  perform test.add_photo(3, e, 1, 'outlets', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(76, 'audit_item', e || ':1:outlets', 0, '{"result":"REVIEW"}', test.u(4)));
  r := public.apply_op(test.op(77, 'audit', e || ':1', 1, '{"action":"submit"}', test.u(4)));
  perform test.as_postgres();
  perform test.ok(app.audit_state(e, 1) = 'manager_review_required', 'critical REVIEW -> manager_review_required (not a block)');
  perform test.ok((select count(*) from public.notifications where related_audit_id = e) = 0, 'critical REVIEW does not raise the stop-gate alert');

  -- template policy ready_with_exceptions
  insert into public.audit_templates (id, name, version, config)
  select t2, name, 2, jsonb_set(config, '{policy,nonCriticalIssueState}', '"ready_with_exceptions"') from public.audit_templates where id = test.tmpl();
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(78, 'audit', test.u(316) || ':1', 0, jsonb_build_object('action','create','projectId',test.u(101),'templateId',t2), test.u(4)));
  r := public.apply_op(test.op(79, 'audit_item', test.u(316) || ':1:wall_length', 0, '{"actual64":7800,"expected64":7680,"drawingRef":"A-1"}', test.u(4)));
  r := public.apply_op(test.op(81, 'audit', test.u(316) || ':1', 1, '{"action":"submit"}', test.u(4)));
  perform test.as_postgres();
  perform test.ok(app.audit_state(test.u(316), 1) = 'ready_with_exceptions', 'template policy ready_with_exceptions is honoured');
end $$;
rollback;

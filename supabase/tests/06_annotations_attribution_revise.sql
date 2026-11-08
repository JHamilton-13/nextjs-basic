-- Annotations, attribution (who/when), offline revise, evidence across versions.
begin;
\ir fixtures.sql

do $$
declare
  a uuid := test.u(340); r jsonb; pen jsonb; txt jsonb; w text := 'wall_length';
  ph_orig uuid := test.u(2300); ph_ann uuid := test.u(2301); ts1 text := '2026-11-08T09:15:00Z'; ts2 text := '2026-11-08T11:40:00Z';
begin
  perform test.new_audit(a);
  perform test.add_photo(1, a, 1, 'outlets', test.u(101), test.u(4));      -- id 2001 (original)

  -- ---- annotation validity (CHECK) ----
  pen := '{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1],[0.5,0.5]]}';
  txt := '{"type":"text","color":"#000000","size":0.05,"at":[0.2,0.3],"text":"outlet here"}';
  insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations)
  values (ph_ann, test.u(101), a, 1, 'outlets', 'ann/1.jpg', repeat('b', 64), 100, test.u(4), now(), test.u(2001), jsonb_build_array(pen, txt, '{"type":"highlight","color":"#ffee00","width":0.03,"points":[[0,0],[1,1]]}'::jsonb));
  perform test.ok(true, 'a valid annotated copy (pen + highlighter + text) is stored');
  perform test.ok((select jsonb_array_length(annotations) from public.photos where id = ph_ann) = 3, 'shapes are stored as editable data');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad1.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2302), test.u(101), a, test.u(4), test.u(2001), '[{"type":"arrow","color":"#ff0000","width":0.01,"points":[[0,0]]}]'), 'photos_annotations_valid', 'an unknown shape type (arrow) is rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad2.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2303), test.u(101), a, test.u(4), test.u(2001), '[{"type":"pen","color":"#ff0000","width":0.01,"points":[[1.5,0.2]]}]'), 'photos_annotations_valid', 'a coordinate outside the image (0..1) is rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad3.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2304), test.u(101), a, test.u(4), test.u(2001), '[{"type":"text","color":"red","size":0.05,"at":[0.1,0.1],"text":"x"}]'), 'photos_annotations_valid', 'a color that is not #rrggbb is rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad4.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2305), test.u(101), a, test.u(4), test.u(2001), '[{"type":"text","color":"#000000","size":0.05,"at":[0.1,0.1],"text":"   "}]'), 'photos_annotations_valid', 'a blank text label is rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad5.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2306), test.u(101), a, test.u(4), test.u(2001), (select jsonb_agg('{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1]]}'::jsonb) from generate_series(1, 201))::text), 'photos_annotations_valid', 'more than 200 shapes is rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/bad6.jpg', repeat('b',64), 1, %L, now(), %L::jsonb)$q$, test.u(2307), test.u(101), a, test.u(4), '[{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1]]}]'), 'photos_annotation_pair', 'annotations without an original are rejected');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'outlets', 'ann/chain.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2308), test.u(101), a, test.u(4), ph_ann, '[{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1]]}]'), 'cannot annotate an annotated copy', 'an annotated copy cannot itself be annotated');
  perform test.raises(format($q$insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations) values (%L, %L, %L, 1, 'access', 'ann/otheritem.jpg', repeat('b',64), 1, %L, now(), %L, %L::jsonb)$q$, test.u(2309), test.u(101), a, test.u(4), test.u(2001), '[{"type":"pen","color":"#ff0000","width":0.01,"points":[[0.1,0.1]]}]'), 'same audit and item', 'an annotated copy must stay on the original''s item');
  perform test.raises(format($q$update public.photos set annotations = '[{"type":"pen","color":"#00ff00","width":0.01,"points":[[0.1,0.1]]}]'::jsonb where id = %L$q$, ph_ann), 'immutable', 'saved annotations cannot be edited in place (edit = new copy)');

  -- ---- evidence: annotated copies are NOT extra evidence; originals across versions ARE ----
  insert into public.audit_templates (id, name, version, config)
  select test.u(402), 'two-photo template', 1, jsonb_set(config, '{sections,4,items,1,requires}', '{"photo":2}') from public.audit_templates where id = test.tmpl();
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(30, 'audit', test.u(341) || ':1', 0, jsonb_build_object('action','create','projectId',test.u(101),'templateId',test.u(402)), test.u(4)));
  perform test.as_postgres();
  perform test.add_photo(3, test.u(341), 1, 'outlets', test.u(101), test.u(4));  -- one original
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(31, 'audit_item', test.u(341) || ':1:outlets', 0, '{"result":"PASS"}', test.u(4)));
  perform test.ok(r ->> 'message' = 'evidence_missing: photo', 'one photo does not satisfy a 2-photo requirement');
  perform test.as_postgres();
  insert into public.photos (id, project_id, audit_id, version, item_key, storage_path, checksum_sha256, bytes, captured_by, captured_at, annotated_from, annotations)
  values (test.u(2310), test.u(101), test.u(341), 1, 'outlets', 'ann/two.jpg', repeat('c', 64), 5, test.u(4), now(), test.u(2003), jsonb_build_array(pen));
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(31, 'audit_item', test.u(341) || ':1:outlets', 0, '{"result":"PASS"}', test.u(4)));
  perform test.ok(r ->> 'message' = 'evidence_missing: photo', 'an annotated copy does not count as a second evidence photo');
  perform test.as_postgres();

  -- ---- attribution: who recorded each result and who raised each issue, using the time it happened ----
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(test.op(10, 'audit_item', a || ':1:outlets', 0, '{"result":"FAIL","note":"in filler zone"}', test.u(4)), '{createdAt}', to_jsonb(ts1)));
  perform test.ok(r ->> 'status' = 'applied', 'critical FAIL recorded');
  perform test.as_postgres();
  perform test.ok((select result_by = test.u(4) and result_at = ts1::timestamptz and issue_raised_by = test.u(4) and issue_raised_at = ts1::timestamptz from public.audit_items where audit_id = a and item_key = 'outlets'),
    'result and issue carry the user and the time it was recorded on site (not the sync time)');
  perform test.as_user(test.u(3));
  r := public.apply_op(jsonb_set(test.op(11, 'audit_item', a || ':1:outlets', 1, '{"result":"FAIL","note":"still wrong"}', test.u(3)), '{createdAt}', to_jsonb(ts2)));
  perform test.as_postgres();
  perform test.ok((select result_by = test.u(3) and result_at = ts2::timestamptz and issue_raised_by = test.u(4) and issue_raised_at = ts1::timestamptz from public.audit_items where audit_id = a and item_key = 'outlets'),
    'a later FAIL by someone else updates who/when recorded, but the issue keeps its original raiser and time');
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(test.op(12, 'audit_item', a || ':1:outlets', 2, '{"result":"PASS"}', test.u(4)), '{createdAt}', to_jsonb(ts2)));
  perform test.as_postgres();
  perform test.ok((select issue_raised_by is null and issue_raised_at is null and result = 'PASS' from public.audit_items where audit_id = a and item_key = 'outlets'), 'a PASS clears the issue fields');
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(test.op(13, 'audit_item', a || ':1:outlets', 3, '{"result":"REVIEW"}', test.u(4)), '{createdAt}', to_jsonb(ts2)));
  perform test.as_postgres();
  perform test.ok((select issue_raised_at = ts2::timestamptz from public.audit_items where audit_id = a and item_key = 'outlets'), 'raising the issue again records a new time');
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(test.op(14, 'audit_item', a || ':1:' || w, 0, '{"actual64":7800,"expected64":7680,"drawingRef":"A"}', test.u(4)), '{createdAt}', to_jsonb(ts1)));
  perform test.as_postgres();
  perform test.ok((select issue_raised_by = test.u(4) and result = 'FAIL' from public.audit_items where audit_id = a and item_key = w), 'a failed measurement also records who raised the issue');
  perform test.ok((select measured_at = ts1::timestamptz and user_id = test.u(4) from public.measurements where audit_id = a and item_key = w), 'the measurement keeps its user and the time it was taken');
end $$;

-- offline revise as a queued operation
do $$
declare
  a uuid := test.u(350); r jsonb; ts1 text := '2026-11-08T09:15:00Z';
begin
  perform test.new_audit(a);
  perform test.add_photo(5, a, 1, 'outlets', test.u(101), test.u(4));
  perform test.as_user(test.u(4));
  r := public.apply_op(jsonb_set(test.op(40, 'audit_item', a || ':1:outlets', 0, '{"result":"FAIL","note":"wrong spot"}', test.u(4)), '{createdAt}', to_jsonb(ts1)));
  r := public.apply_op(test.op(41, 'audit', a || ':2', 0, '{"action":"revise","reason":"Re-measured after GC moved the outlet"}', test.u(4)));
  perform test.ok(r ->> 'message' = 'not_submitted', 'an unsubmitted audit cannot be revised (there is nothing to revise)');
  r := test.submit(42, a, 1);
  perform test.ok(r ->> 'status' = 'applied', 'audit submitted');

  r := public.apply_op(test.op(43, 'audit', a || ':2', 0, '{"action":"revise","reason":"  "}', test.u(4)));
  perform test.ok(r ->> 'message' = 'reason_required', 'revise needs a reason');
  r := public.apply_op(test.op(44, 'audit', a || ':3', 0, '{"action":"revise","reason":"skip a version"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'rejected', 'a revision must be the next version');
  r := public.apply_op(test.op(45, 'audit', a || ':2', 0, '{"action":"revise","reason":"Re-measured after GC moved the outlet"}', test.u(4)));
  perform test.ok(r = '{"status":"applied","newVersion":1}', 'revise is applied as an offline-capable operation');
  r := public.apply_op(test.op(45, 'audit', a || ':2', 0, '{"action":"revise","reason":"Re-measured after GC moved the outlet"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'duplicate', 'replaying the revise op is a harmless duplicate');
  perform test.as_postgres();
  perform test.ok((select count(*) from public.audits where audit_id = a) = 2, 'only one new version was created');
  perform test.ok((select revise_reason from public.audits where audit_id = a and version = 2) = 'Re-measured after GC moved the outlet', 'the reason is stored');
  perform test.ok((select count(*) from public.audit_items where audit_id = a and version = 2) = 42, 'items were copied to version 2');
  perform test.ok((select result_by = test.u(4) and result_at = ts1::timestamptz and issue_raised_by = test.u(4) from public.audit_items where audit_id = a and version = 2 and item_key = 'outlets'), 'who/when carry over to version 2 until changed');
  perform test.ok((select submitted_at is not null from public.audits where audit_id = a and version = 1), 'version 1 is untouched and still submitted');

  perform test.as_user(test.u(3));
  r := public.apply_op(test.op(46, 'audit', a || ':2', 0, '{"action":"revise","reason":"me too"}', test.u(3)));
  perform test.ok(r ->> 'status' = 'conflict', 'a second person revising the same version conflicts instead of overwriting');
  perform test.as_user(test.u(6));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(47, 'audit', a || ':2', 0, '{"action":"revise","reason":"gc"}', test.u(6))), '42501', 'a general contractor cannot revise');
  perform test.as_user(test.u(5));
  perform test.raises(format($q$select public.apply_op(%L::jsonb)$q$, test.op(48, 'audit', a || ':2', 0, '{"action":"revise","reason":"other project"}', test.u(5))), '42501', 'a member of another project cannot revise');

  -- version 2 is a normal draft: photos from version 1 still count as evidence; submit works; release needs a new override
  perform test.as_user(test.u(4));
  r := public.apply_op(test.op(49, 'audit_item', a || ':2:outlets', 0, '{"result":"PASS","note":"moved"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'a version-1 photo still satisfies the photo requirement in version 2');
  r := public.apply_op(test.op(50, 'audit', a || ':2', 1, '{"action":"submit"}', test.u(4)));
  perform test.ok(r ->> 'status' = 'applied', 'version 2 can be submitted');
  perform test.as_postgres();
  perform test.ok(app.audit_state(a, 2) = 'ready', 'version 2 is ready once the critical item passes');
  perform test.ok(app.audit_state(a, 1) = 'not_ready', 'version 1 keeps its own NOT READY history');
  perform test.as_user(test.u(4));
  perform test.raises(format($q$select public.revise_audit(%L, 'via rpc')$q$, test.u(399)), 'audit_not_found', 'the revise_audit RPC still works and reports unknown audits');
  perform test.as_postgres();
end $$;
rollback;

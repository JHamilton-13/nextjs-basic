-- Submitted audits, audit_log, measurements, templates, photos are immutable; constraints reject bad data.
begin;
\ir fixtures.sql

do $$
declare
  a uuid := test.u(330); r jsonb; cfg jsonb; base jsonb; pid uuid := test.u(101);
begin
  perform test.new_audit(a);
  perform test.as_user(test.u(4));
  r := test.item(1, a, 'wall_length', 0, '{"actual64":7700,"expected64":7680,"drawingRef":"A-1"}'::jsonb);
  perform test.as_postgres();

  -- unsubmitted audit: identity is fixed even before submit
  perform test.raises(format($q$update public.audits set room_id = null where audit_id = %L$q$, a), 'identity columns are immutable', 'audit identity columns cannot change while a draft');
  perform test.raises(format($q$update public.audit_items set critical = false where audit_id = %L and item_key = 'outlets'$q$, a), 'definition is immutable', 'an item''s critical flag cannot be changed');
  perform test.raises(format($q$delete from public.audit_items where audit_id = %L and item_key = 'access'$q$, a), 'cannot be deleted', 'audit items cannot be deleted even in a draft');

  r := (select public.apply_op(test.op(2, 'audit', a || ':1', 1, '{"action":"submit"}', test.u(4))) from (select test.as_user(test.u(4))) s);
  perform test.as_postgres();
  perform test.ok(r ->> 'status' = 'applied', 'audit submitted for immutability tests');

  perform test.raises(format($q$update public.audits set row_version = 99 where audit_id = %L$q$, a), 'audit_submitted', 'a submitted audit cannot be updated');
  perform test.raises(format($q$delete from public.audits where audit_id = %L$q$, a), 'cannot be deleted', 'audits cannot be deleted');
  perform test.raises(format($q$update public.audit_items set result = 'PASS' where audit_id = %L and item_key = 'wall_length'$q$, a), 'audit_submitted', 'items of a submitted audit cannot be updated');
  perform test.raises(format($q$delete from public.audit_items where audit_id = %L$q$, a), 'audit_submitted', 'items of a submitted audit cannot be deleted');
  perform test.raises(format($q$insert into public.audit_items (audit_id, version, item_key, section_key, label, kind, critical) values (%L, 1, 'extra', 's', 'Extra', 'check', false)$q$, a),
    'audit_submitted', 'items cannot be added to a submitted audit');
  perform test.raises(format($q$update public.measurements set actual_64 = 1 where audit_id = %L$q$, a), 'insert-only', 'measurements cannot be updated');
  perform test.raises(format($q$delete from public.measurements where audit_id = %L$q$, a), 'insert-only', 'measurements cannot be deleted');
  perform test.raises($q$update public.audit_log set action = 'x'$q$, 'append-only', 'audit_log cannot be updated');
  perform test.raises($q$delete from public.audit_log$q$, 'append-only', 'audit_log cannot be deleted');
  perform test.raises($q$truncate public.audit_log$q$, 'append-only', 'audit_log cannot be truncated');

  -- templates
  perform test.raises(format($q$update public.audit_templates set config = '{}'::jsonb where id = %L$q$, test.tmpl()), 'immutable', 'a published template version cannot be edited');
  perform test.raises(format($q$update public.audit_templates set version = 2 where id = %L$q$, test.tmpl()), 'immutable', 'a template version number cannot change');
  perform test.raises(format($q$delete from public.audit_templates where id = %L$q$, test.tmpl()), 'cannot be deleted', 'templates cannot be deleted');
  update public.audit_templates set active = false where id = test.tmpl();
  update public.audit_templates set active = true where id = test.tmpl();
  perform test.ok(true, 'a template can be deactivated and reactivated');

  -- template validation
  select config into base from public.audit_templates where id = test.tmpl();
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad1', 1, %L::jsonb)$q$, base #- '{policy}'), 'audit_templates_config_valid', 'template without policy is rejected');
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad2', 1, %L::jsonb)$q$, jsonb_set(base, '{policy,nonCriticalIssueState}', '"block_everything"')), 'audit_templates_config_valid', 'unknown policy value is rejected');
  cfg := '{"policy":{"nonCriticalIssueState":"manager_review_required"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"check","critical":false},{"key":"k","label":"K2","kind":"check","critical":false}]}]}';
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad3', 1, %L::jsonb)$q$, cfg), 'audit_templates_config_valid', 'duplicate item keys are rejected');
  cfg := '{"policy":{"nonCriticalIssueState":"manager_review_required"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"observation","critical":true}]}]}';
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad4', 1, %L::jsonb)$q$, cfg), 'audit_templates_config_valid', 'a critical observation item is rejected');
  cfg := '{"policy":{"nonCriticalIssueState":"manager_review_required"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"tolerance","critical":false,"rule":{"plus64":32,"minus64":32,"reviewBand64":16,"source":"custom","sourceRef":"x","method":"m"}}]}]}';
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad5', 1, %L::jsonb)$q$, cfg), 'audit_templates_config_valid', 'a review band smaller than the tolerance is rejected');
  cfg := '{"policy":{"nonCriticalIssueState":"manager_review_required"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"check","critical":false,"requires":{"selfie":true}}]}]}';
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad6', 1, %L::jsonb)$q$, cfg), 'audit_templates_config_valid', 'unknown evidence requirement is rejected');
  cfg := '{"policy":{"nonCriticalIssueState":"manager_review_required"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"tolerance","critical":false}]}]}';
  perform test.raises(format($q$insert into public.audit_templates (name, version, config) values ('bad7', 1, %L::jsonb)$q$, cfg), 'audit_templates_config_valid', 'a tolerance item without rule data is rejected');
  insert into public.audit_templates (name, version, config) values ('ok-minimal', 1,
    '{"policy":{"nonCriticalIssueState":"ready_with_exceptions"},"sections":[{"key":"s","title":"S","items":[{"key":"k","label":"K","kind":"check","critical":true}]}]}');
  perform test.ok(true, 'a minimal valid template is accepted');

  -- measurement constraints (belt and braces for any writer, including service role)
  perform test.raises(format($q$insert into public.measurements (audit_id, version, item_key, expected_64, actual_64, plus_64, minus_64, review_band_64, source, source_ref, method, user_id, measured_at, deviation_64, result)
    values (%L, 1, 'wall_length', 7680, 7800, 32, 32, 64, 'custom', 'x', 'm', %L, now(), 120, 'PASS')$q$, a, test.u(4)), 'measurements_result', 'a measurement whose result disagrees with the tolerance rule is rejected');
  perform test.raises(format($q$insert into public.measurements (audit_id, version, item_key, expected_64, actual_64, plus_64, minus_64, review_band_64, source, source_ref, method, user_id, measured_at, deviation_64, result)
    values (%L, 1, 'wall_length', 7680, 7700, 32, 32, 64, 'custom', 'x', 'm', %L, now(), 5, 'PASS')$q$, a, test.u(4)), 'measurements_deviation', 'a measurement with a wrong deviation is rejected');

  -- audits: revision rules
  perform test.raises(format($q$insert into public.audits (audit_id, version, project_id, template_id, created_by) values (%L, 2, %L, %L, %L)$q$, a, pid, test.tmpl(), test.u(4)),
    'audits_revision_reason', 'a revision without a reason is rejected');

  -- photos
  perform test.add_photo(1, a, 1, 'wall_length', pid, test.u(4));
  perform test.raises(format($q$update public.photos set storage_path = 'elsewhere' where id = %L$q$, test.u(2001)), 'immutable', 'a photo''s storage path cannot change');
  perform test.raises(format($q$delete from public.photos where id = %L$q$, test.u(2001)), 'cannot be deleted', 'photos cannot be deleted');
  update public.photos set confirmed_at = now() where id = test.u(2001);
  perform test.ok(true, 'a photo can be confirmed once');
  perform test.raises(format($q$update public.photos set confirmed_at = now() where id = %L$q$, test.u(2001)), 'immutable', 'a confirmed photo cannot change again');
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, 1, 'p', 'xyz', 5, %L, now())$q$, pid, a, test.u(4)),
    'photos_checksum_sha256_check', 'a malformed checksum is rejected');
  perform test.raises(format($q$insert into public.photos (project_id, audit_id, version, storage_path, checksum_sha256, bytes, captured_by, captured_at) values (%L, %L, 1, 'p2', repeat('b',64), 5, %L, now())$q$, test.u(102), a, test.u(4)),
    'foreign key', 'a photo cannot claim a different project than its audit');
end $$;
rollback;

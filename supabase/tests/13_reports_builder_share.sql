-- Migration 1900: report types and stored options, sharing with colleagues, "shared" counts as saved.
begin;
\ir fixtures.sql

create function test.rid(n integer) returns uuid language sql as $$ select test.u(9700 + n) $$;
create function test.rpath(n integer) returns text language sql as $$ select test.u(101)::text || '/' || test.rid(n)::text || '.pdf' $$;
create function test.mk(n integer, typ text, opts jsonb default null, who uuid default test.u(2)) returns void language plpgsql as $$
begin
  perform test.as_user(who);
  perform public.create_report(test.rid(n), test.u(101), typ, test.rpath(n), 1000, opts);
  perform test.as_postgres();
end $$;
create function test.has(n integer) returns boolean language sql as $$ select exists (select 1 from public.reports where id = test.rid(n)) $$;

do $$
declare gone text[];
begin
  -- ================= types and options =================
  perform test.mk(1, 'service', '{"preset":"service","kinds":["punch_item"]}'::jsonb);
  perform test.ok((select report_type = 'service' and options ->> 'preset' = 'service' from public.reports where id = test.rid(1)), 'a service report is stored with the options it was built from');
  perform test.mk(2, 'custom', '{"preset":"custom"}'::jsonb); perform test.mk(3, 'builder_site_audit'); perform test.mk(4, 'room_status', null);
  perform test.ok((select count(*) from public.reports) = 4, 'all four report types are accepted; options may be empty (older reports)');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.create_report(%L, %L, 'weekly', %L, 10)$q$, test.rid(5), test.u(101), test.rpath(5)), 'check constraint', 'an unknown type is still refused');
  perform test.raises(format($q$select public.create_report(%L, %L, 'custom', %L, 10, '[1,2]'::jsonb)$q$, test.rid(5), test.u(101), test.rpath(5)), 'check constraint', 'options must be an object');
  perform public.create_report(test.rid(6), test.u(101), 'custom', test.rpath(6), 10);        -- the old five-argument call still works
  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.create_report(%L, %L, 'service', %L, 10, '{}'::jsonb)$q$, test.rid(7), test.u(101), test.rpath(7)), '42501', 'an installer cannot build a report');
  perform test.as_postgres();

  -- ================= sharing =================
  perform test.as_user(test.u(2));
  perform public.mark_report_shared(test.rid(1), array['a@phc.example', 'b@phc.example']);
  perform test.as_postgres();
  perform test.ok((select shared_by = test.u(2) and shared_at is not null and shared_to = array['a@phc.example', 'b@phc.example'] and status = 'built' from public.reports where id = test.rid(1)), 'sharing records who, when and with whom, and does not touch the builder send status');
  perform test.as_user(test.u(3)); perform public.mark_report_shared(test.rid(1), array['c@phc.example']); perform test.as_postgres();
  perform test.ok((select shared_by = test.u(3) and shared_to = array['c@phc.example'] from public.reports where id = test.rid(1)), 'sharing can be repeated (it replaces the previous list)');
  perform test.as_user(test.u(2));
  perform public.queue_report_send(test.rid(3), 'B', 'b@example.test');
  perform test.ok(true, 'the builder send is independent of sharing');
  perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(3)), 'report_already_queued', 'sharing a report whose builder send is in flight is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, array[]::text[])$q$, test.rid(1)), 'invalid_recipient', 'an empty list is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, null)$q$, test.rid(1)), 'invalid_recipient', 'no list is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, array['not an email'])$q$, test.rid(1)), 'invalid_recipient', 'a bad address is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example' || chr(10) || 'Bcc: x@y.test'])$q$, test.rid(1)), 'invalid_recipient', 'a header-injection address is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, (select array_agg('u' || g || '@phc.example') from generate_series(1, 11) g))$q$, test.rid(1)), 'too_many_recipients', 'more than 10 people is refused');
  perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(99)), '42501', 'sharing an unknown report is forbidden');
  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(1)), '42501', 'an installer cannot share a report');
  perform test.as_user(test.u(6)); perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(1)), '42501', 'a general contractor cannot share a report');
  perform test.as_user(test.u(9)); perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(1)), '42501', 'a manager of another project cannot share it');
  perform test.as_anon(); perform test.raises(format($q$select public.mark_report_shared(%L, array['a@phc.example'])$q$, test.rid(1)), '42501', 'anon cannot share');
  perform test.as_postgres();
  perform test.raises(format($q$update public.reports set shared_by = null where id = %L$q$, test.rid(1)), 'reports_shared_together', 'who, when and with whom always travel together');
  perform test.ok((select count(*) from public.audit_log where table_name = 'reports' and record_id = test.rid(1)::text and action = 'UPDATE') >= 2, 'each share is in the audit log');

  -- ================= shared counts as saved =================
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'service', test.rid(1)); perform test.as_postgres();
  perform test.ok(gone = '{}' and test.has(1), 'the shared service report is kept');
  perform test.mk(8, 'service', '{}'::jsonb);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'service', test.rid(8)); perform test.as_postgres();
  perform test.ok(test.has(1) and test.has(8) and gone = '{}', 'a new preview does not remove the saved (shared) report');
  perform test.as_user(test.u(2)); perform public.mark_report_shared(test.rid(8), array['a@phc.example']); perform test.as_postgres();
  update public.reports set shared_at = now() + interval '5 seconds' where id = test.rid(8);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'service', test.rid(8)); perform test.as_postgres();
  perform test.ok(gone = array[test.rpath(1)] and not test.has(1) and test.has(8), 'sharing a newer service report replaces the older saved one');
  perform test.ok(test.has(2) and test.has(3) and test.has(4), 'other report types are untouched');
  perform test.as_user(test.u(2)); perform test.raises(format($q$select public.prune_reports(%L, 'weekly', %L)$q$, test.u(101), test.rid(8)), 'unknown report type', 'prune still refuses an unknown type');
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'custom', test.rid(2)); perform test.as_postgres();
  perform test.ok(test.has(2) and not test.has(6), 'custom reports follow the same keep-the-latest rule (an unsaved older preview is replaced)');
end $$;
rollback;

-- Migration 1800: print, keep only the latest emailed or printed report per job and type, contact source.
begin;
\ir fixtures.sql

create function test.rid(n integer) returns uuid language sql as $$ select test.u(9500 + n) $$;
create function test.rpath(n integer, proj uuid default test.u(101)) returns text language sql as $$ select proj::text || '/' || test.rid(n)::text || '.pdf' $$;
-- a report built by a manager (as that manager), type given
create function test.mk(n integer, typ text, who uuid default test.u(2)) returns void language plpgsql as $$
begin
  perform test.as_user(who);
  perform public.create_report(test.rid(n), test.u(101), typ, test.rpath(n), 1000);
  perform test.as_postgres();
end $$;
create function test.send(n integer, who uuid default test.u(2)) returns void language plpgsql as $$
begin
  perform test.as_user(who);
  perform public.queue_report_send(test.rid(n), 'B', 'b@example.test');
  perform public.mark_report_sent(test.rid(n), 'm' || n);
  perform test.as_postgres();
end $$;
create function test.ids(typ text) returns text language sql as $$
  select coalesce(string_agg((id::text)::text, ',' order by id), '') from public.reports where report_type = typ and project_id = test.u(101)
$$;
-- one test transaction has a single clock reading, so the order of events is set by hand (in real use each call is its own transaction)
create function test.at(n integer, secs integer) returns void language plpgsql as $$
begin
  update public.reports set sent_at = case when sent_at is not null then now() + make_interval(secs => secs) end,
    printed_at = case when printed_at is not null then now() + make_interval(secs => secs) end where id = test.rid(n);
end $$;
create function test.has(n integer) returns boolean language sql as $$ select exists (select 1 from public.reports where id = test.rid(n)) $$;

do $$
declare gone text[];
begin
  -- ================= print =================
  perform test.mk(1, 'builder_site_audit');
  perform test.as_user(test.u(2)); perform public.mark_report_printed(test.rid(1)); perform test.as_postgres(); perform test.at(1, 1);
  perform test.ok((select printed_at is not null and printed_by = test.u(2) and status = 'built' from public.reports where id = test.rid(1)), 'printing records who and when and leaves the status alone');
  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.mark_report_printed(%L)$q$, test.rid(1)), '42501', 'an installer cannot print a report');
  perform test.as_user(test.u(6)); perform test.raises(format($q$select public.mark_report_printed(%L)$q$, test.rid(1)), '42501', 'a general contractor cannot print a report');
  perform test.as_user(test.u(9)); perform test.raises(format($q$select public.mark_report_printed(%L)$q$, test.rid(1)), '42501', 'a manager of another project cannot print it');
  perform test.as_anon(); perform test.raises(format($q$select public.mark_report_printed(%L)$q$, test.rid(1)), '42501', 'anon cannot print');
  perform test.as_user(test.u(2)); perform test.raises(format($q$select public.mark_report_printed(%L)$q$, test.rid(99)), '42501', 'printing an unknown report is forbidden');
  perform test.as_postgres();
  perform test.raises(format($q$update public.reports set printed_by = null where id = %L$q$, test.rid(1)), 'reports_printed_pair', 'printed_by and printed_at always travel together');

  -- ================= pruning: who may =================
  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.prune_reports(%L, 'builder_site_audit', %L)$q$, test.u(101), test.rid(1)), '42501', 'an installer cannot prune');
  perform test.as_user(test.u(9)); perform test.raises(format($q$select public.prune_reports(%L, 'builder_site_audit', %L)$q$, test.u(101), test.rid(1)), '42501', 'a manager of another project cannot prune this one');
  perform test.as_anon(); perform test.raises(format($q$select public.prune_reports(%L, 'builder_site_audit', %L)$q$, test.u(101), test.rid(1)), '42501', 'anon cannot prune');
  perform test.as_user(test.u(2)); perform test.raises(format($q$select public.prune_reports(%L, 'weekly', %L)$q$, test.u(101), test.rid(1)), 'unknown report type', 'an unknown type is refused');
  perform test.raises($q$delete from public.reports$q$, 'permission denied', 'rows still cannot be deleted directly');
  perform test.as_postgres();

  -- ================= the keep-latest rule =================
  -- r1 audit printed (saved); build r2 and r3 (unsaved previews); status r4 unsaved
  perform test.mk(2, 'builder_site_audit'); perform test.mk(3, 'builder_site_audit'); perform test.mk(4, 'room_status');
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(3)); perform test.as_postgres();
  perform test.ok(gone = array[test.rpath(2)], 'a new preview replaces the previous preview and returns its file path');
  perform test.ok(test.has(1) and not test.has(2) and test.has(3), 'the saved report and the new preview are both kept');
  perform test.ok(test.has(4), 'a preview of the OTHER type is not touched');

  -- send r3: it becomes the newest saved, r1 (older saved) is removed
  perform test.send(3); perform test.at(3, 2);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(3)); perform test.as_postgres();
  perform test.ok(gone = array[test.rpath(1)], 'sending a new report removes the previously saved one of that type');
  perform test.ok(test.has(3) and not test.has(1), 'only the newly sent report is left for that type');
  perform test.ok(test.has(4), 'the status preview is still there');

  -- print the status report: it becomes saved
  perform test.as_user(test.u(2)); perform public.mark_report_printed(test.rid(4)); perform test.as_postgres(); perform test.at(4, 3); perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'room_status', test.rid(4)); perform test.as_postgres();
  perform test.ok(gone = '{}' and test.has(4) and test.has(3), 'printing a status report keeps it and does not touch the audit');

  -- ordering: a printed report newer than a sent one wins
  perform test.mk(5, 'builder_site_audit');
  perform test.as_user(test.u(2)); perform public.mark_report_printed(test.rid(5)); perform test.as_postgres(); perform test.at(5, 4);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(5)); perform test.as_postgres();
  perform test.ok(gone = array[test.rpath(3)] and test.has(5), 'a newer print replaces an older send');

  -- a new unsaved preview never removes the saved report
  perform test.mk(6, 'builder_site_audit');
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(6)); perform test.as_postgres();
  perform test.ok(gone = '{}' and test.has(5) and test.has(6), 'a fresh preview does not remove the saved report');
  -- failed reports are unsaved previews too
  perform test.mk(7, 'builder_site_audit');
  perform test.as_user(test.u(2)); perform public.queue_report_send(test.rid(7), 'B', 'b@example.test'); perform public.mark_report_failed(test.rid(7), 'smtp'); perform test.as_postgres();
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(7)); perform test.as_postgres();
  perform test.ok(gone = array[test.rpath(6)] and test.has(7) and test.has(5), 'a failed report is kept as the current preview (so it can be retried); the old preview goes');

  -- a send in flight is never removed
  perform test.mk(8, 'builder_site_audit');
  perform test.as_user(test.u(2)); perform public.queue_report_send(test.rid(8), 'B', 'b@example.test'); perform test.as_postgres();
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(5)); perform test.as_postgres();
  perform test.ok(test.has(8) and test.has(5) and not test.has(7), 'a queued report (send in flight) is never pruned');
  update public.reports set queued_at = now() - interval '11 minutes' where id = test.rid(8);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(5)); perform test.as_postgres();
  perform test.ok(not test.has(8), 'a send stuck for over 10 minutes is no longer protected');

  -- old unsaved previews of any type go after an hour
  perform test.mk(9, 'room_status');
  update public.reports set built_at = now() - interval '2 hours' where id = test.rid(9);
  perform test.mk(10, 'room_status');
  update public.reports set built_at = now() - interval '30 minutes' where id = test.rid(10);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(5)); perform test.as_postgres();
  perform test.ok(not test.has(9) and test.has(10) and test.has(4), 'an unsaved preview over an hour old is removed whatever its type; a younger one and the saved status report stay');

  -- other projects are never touched
  perform test.as_postgres();
  insert into public.reports (id, project_id, report_type, storage_path, file_size, built_by)
    values (test.rid(50), test.u(102), 'builder_site_audit', test.rpath(50, test.u(102)), 10, test.u(9));
  update public.reports set built_at = now() - interval '5 hours' where id = test.rid(50);
  perform test.as_user(test.u(2)); gone := public.prune_reports(test.u(101), 'builder_site_audit', test.rid(5)); perform test.as_postgres();
  perform test.ok(test.has(50), 'another job''s reports are never touched');

  -- ================= audit log =================
  perform test.ok((select count(*) from public.audit_log where table_name = 'reports' and action = 'DELETE' and project_id = test.u(101)) >= 5, 'every removed report is in the audit log with its job');
  perform test.ok((select count(*) from public.audit_log where table_name = 'reports' and action = 'UPDATE' and record_id = test.rid(1)::text) >= 1, 'the print of a report was logged');

  -- ================= storage: deleting files =================
  perform test.as_postgres();
  insert into storage.objects (bucket_id, name, owner) values ('reports', test.rpath(1), test.u(2)), ('reports', test.u(102)::text || '/other.pdf', test.u(9));
  perform test.as_user(test.u(2));
  delete from storage.objects where bucket_id = 'reports' and name = test.rpath(1);
  perform test.as_postgres();
  perform test.ok(not exists (select 1 from storage.objects where name = test.rpath(1)), 'a project manager can delete a report file in the job''s folder');
  perform test.as_user(test.u(2));
  delete from storage.objects where bucket_id = 'reports' and name = test.u(102)::text || '/other.pdf';
  perform test.as_postgres();
  perform test.ok(exists (select 1 from storage.objects where name = test.u(102)::text || '/other.pdf'), 'a manager cannot delete another job''s report file');
  insert into storage.objects (bucket_id, name, owner) values ('reports', test.rpath(2), test.u(2));
  perform test.as_user(test.u(4)); delete from storage.objects where bucket_id = 'reports' and name = test.rpath(2); perform test.as_postgres();
  perform test.ok(exists (select 1 from storage.objects where name = test.rpath(2)), 'an installer cannot delete report files');

  -- ================= contact source =================
  perform test.as_user(test.u(2));
  update public.projects set contact_source = 'cockpit', prepared_for_name = 'Sample Builder' where id = test.u(101);
  update public.projects set contact_source = 'manual' where id = test.u(101);
  perform test.raises(format($q$update public.projects set contact_source = 'guess' where id = %L$q$, test.u(101)), 'check constraint', 'contact_source is cockpit, manual or empty');
  perform test.as_user(test.u(4));
  update public.projects set contact_source = 'cockpit' where id = test.u(101);
  perform test.as_postgres();
  perform test.ok((select contact_source from public.projects where id = test.u(101)) = 'manual', 'an installer cannot change the contact source');
end $$;
rollback;

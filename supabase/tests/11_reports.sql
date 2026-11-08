-- Migration 1700: reports table, manager-only access, the once-only send, the private 'reports' bucket.
begin;
\ir fixtures.sql

create function test.rid(n integer) returns uuid language sql as $$ select test.u(9000 + n) $$;
create function test.rpath(n integer) returns text language sql as $$ select test.u(101)::text || '/' || test.rid(n)::text || '.pdf' $$;
create function test.mk(n integer, who uuid, typ text default 'builder_site_audit') returns void language plpgsql as $$
begin
  perform test.as_user(who);
  perform public.create_report(test.rid(n), test.u(101), typ, test.rpath(n), 12345);
  perform test.as_postgres();
end $$;

do $$
declare r public.reports; ok_state text;
begin
  -- ================= who may create and read =================
  perform test.mk(1, test.u(2));
  perform test.ok((select status from public.reports where id = test.rid(1)) = 'built' and (select built_by from public.reports where id = test.rid(1)) = test.u(2), 'a project manager records a built report');
  perform test.mk(2, test.u(3), 'room_status');
  perform test.ok(true, 'an installation manager can record a report');
  perform test.mk(3, test.u(1));
  perform test.ok(true, 'an admin can record a report');

  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'an installer cannot create a report');
  perform test.as_user(test.u(6)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'a general contractor cannot create a report');
  perform test.as_user(test.u(7)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'a client cannot create a report');
  perform test.as_user(test.u(8)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'a warehouse user cannot create a report');
  perform test.as_user(test.u(9)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'a manager of another project cannot create a report here');
  perform test.as_user(test.u(12)); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'a revoked user cannot create a report');
  perform test.as_anon(); perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', %L, 10)$q$, test.rid(4), test.u(101), test.rpath(4)), '42501', 'anon cannot call create_report');
  perform test.as_postgres();

  perform test.as_user(test.u(2)); perform test.ok((select count(*) from public.reports) = 3, 'a project manager reads the project''s reports');
  perform test.as_user(test.u(1)); perform test.ok((select count(*) from public.reports) = 3, 'an admin reads reports');
  perform test.as_user(test.u(9)); perform test.ok((select count(*) from public.reports) = 0, 'a manager of another project does not');
  perform test.as_user(test.u(4)); perform test.ok((select count(*) from public.reports) = 0, 'an installer cannot read reports');
  perform test.as_user(test.u(6)); perform test.ok((select count(*) from public.reports) = 0, 'a general contractor cannot read reports');
  perform test.as_user(test.u(7)); perform test.ok((select count(*) from public.reports) = 0, 'a client cannot read reports');
  perform test.as_user(test.u(8)); perform test.ok((select count(*) from public.reports) = 0, 'a warehouse user cannot read reports');
  perform test.as_user(test.u(11)); perform test.ok((select count(*) from public.reports) = 0, 'an uninvited user cannot read reports');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$insert into public.reports (id, project_id, report_type, storage_path, file_size, built_by) values (%L, %L, 'room_status', %L, 10, %L)$q$, test.rid(5), test.u(101), test.rpath(5), test.u(2)), 'permission denied', 'a manager cannot insert a report row directly');
  perform test.raises($q$update public.reports set status = 'sent'$q$, 'permission denied', 'a manager cannot edit a report row directly');
  perform test.raises($q$delete from public.reports$q$, 'permission denied', 'a manager cannot delete a report');
  perform test.as_postgres();

  -- ================= row rules =================
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.create_report(%L, %L, 'builder_site_audit', 'wrong/path.pdf', 10)$q$, test.rid(6), test.u(101)), 'reports_path_matches', 'the stored path must be <project>/<report>.pdf');
  perform test.raises(format($q$select public.create_report(%L, %L, 'weekly', %L, 10)$q$, test.rid(6), test.u(101), test.rpath(6)), 'check constraint', 'an unknown report type is refused');
  perform test.raises(format($q$select public.create_report(%L, %L, 'room_status', %L, %s)$q$, test.rid(6), test.u(101), test.rpath(6), 18 * 1024 * 1024 + 1), 'check constraint', 'a PDF over 18 MB is refused');
  perform test.raises(format($q$select public.create_report(%L, %L, 'room_status', %L, 0)$q$, test.rid(6), test.u(101), test.rpath(6)), 'check constraint', 'an empty file is refused');
  perform test.raises(format($q$select public.create_report(%L, %L, 'room_status', %L, 10)$q$, test.rid(1), test.u(101), test.rpath(1)), 'duplicate key', 'the same report cannot be recorded twice');
  perform test.as_postgres();

  -- ================= once-only send =================
  perform test.as_user(test.u(4)); perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(1)), '42501', 'an installer cannot queue a send');
  perform test.as_user(test.u(9)); perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(1)), '42501', 'a manager of another project cannot queue a send');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'not an email')$q$, test.rid(1)), 'invalid_recipient', 'a bad address is refused before anything is queued');
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'a@b.com' || chr(10) || 'Bcc: x@y.com')$q$, test.rid(1)), 'invalid_recipient', 'a header-injection address is refused');
  perform test.ok((select status from public.reports where id = test.rid(1)) = 'built', 'a refused queue leaves the report built');
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(99)), '42501', 'queueing an unknown report is forbidden');

  r := public.queue_report_send(test.rid(1), '  Builder Person ', 'b@example.test');
  perform test.ok(r.status = 'queued' and r.recipient_name = 'Builder Person' and r.recipient_email = 'b@example.test' and r.sent_by = test.u(2) and r.queued_at is not null, 'queue claims the send and records who and to whom');
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(1)), 'report_already_queued', 'a second queue (double click, or a second manager) is refused');
  perform test.as_user(test.u(3));
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(1)), 'report_already_queued', 'a different manager also gets report_already_queued');
  perform test.raises(format($q$select public.mark_report_sent(%L, 'm')$q$, test.rid(2)), 'report_not_queued', 'a report that was never queued cannot be marked sent');
  perform test.raises(format($q$select public.mark_report_failed(%L, 'e')$q$, test.rid(2)), 'report_not_queued', 'a report that was never queued cannot be marked failed');

  perform test.as_user(test.u(2));
  perform public.mark_report_failed(test.rid(1), 'smtp down');
  perform test.as_postgres();
  perform test.ok((select status = 'failed' and error = 'smtp down' from public.reports where id = test.rid(1)), 'a failed send is recorded with its error');
  perform test.as_user(test.u(2));
  r := public.queue_report_send(test.rid(1), 'Builder Person', 'b@example.test');
  perform test.ok(r.status = 'queued' and r.error is null, 'a failed report can be queued again');
  perform public.mark_report_sent(test.rid(1), 'gmail-message-1');
  perform test.as_postgres();
  perform test.ok((select status = 'sent' and sent_at is not null and message_id = 'gmail-message-1' from public.reports where id = test.rid(1)), 'a sent report records time and message id');
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(1)), 'report_already_sent', 'a sent report can never be queued again');
  perform test.raises(format($q$select public.mark_report_sent(%L, 'again')$q$, test.rid(1)), 'report_already_sent', 'a sent report cannot be marked sent twice');
  perform test.raises(format($q$select public.mark_report_failed(%L, 'late')$q$, test.rid(1)), 'report_already_sent', 'a sent report cannot be marked failed');
  perform test.as_postgres();

  -- stuck queued: retryable only after 10 minutes
  perform test.as_user(test.u(2)); r := public.queue_report_send(test.rid(2), 'B', 'b@example.test'); perform test.as_postgres();
  update public.reports set queued_at = now() - interval '9 minutes' where id = test.rid(2);
  perform test.as_user(test.u(2));
  perform test.raises(format($q$select public.queue_report_send(%L, 'B', 'b@example.test')$q$, test.rid(2)), 'report_already_queued', 'a report queued 9 minutes ago is still held');
  perform test.as_postgres();
  update public.reports set queued_at = now() - interval '11 minutes' where id = test.rid(2);
  perform test.as_user(test.u(3)); r := public.queue_report_send(test.rid(2), 'B', 'b2@example.test');
  perform test.ok(r.status = 'queued' and r.recipient_email = 'b2@example.test' and r.sent_by = test.u(3), 'a report stuck in queued for 11 minutes can be retried');
  perform test.as_postgres();

  -- ================= audit log =================
  perform test.ok((select count(*) from public.audit_log where table_name = 'reports' and record_id = test.rid(1)::text and action = 'INSERT') = 1, 'building a report is in the audit log');
  perform test.ok((select count(*) from public.audit_log where table_name = 'reports' and record_id = test.rid(1)::text and action = 'UPDATE') >= 4, 'each queue, fail and send step is in the audit log');
  perform test.ok((select bool_and(project_id = test.u(101)) from public.audit_log where table_name = 'reports'), 'report log entries carry the project id (managers can see them)');

  -- ================= storage =================
  perform test.ok((select public = false and file_size_limit = 18 * 1024 * 1024 and allowed_mime_types = array['application/pdf'] from storage.buckets where id = 'reports'), 'the reports bucket is private, PDF only, 18 MB at most');
  perform test.as_user(test.u(2));
  insert into storage.objects (bucket_id, name, owner) values ('reports', test.rpath(1), test.u(2));
  perform test.ok(true, 'a project manager can upload into the project''s folder');
  perform test.raises($q$insert into storage.objects (bucket_id, name) values ('reports', 'not-a-uuid/x.pdf')$q$, 'row-level security', 'a path that does not start with a project id is refused');
  perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('reports', %L)$q$, test.u(102)::text || '/x.pdf'), 'row-level security', 'a manager cannot upload into another project''s folder');
  perform test.ok((select count(*) from storage.objects where bucket_id = 'reports') = 1, 'a project manager can read the report file');
  perform test.as_user(test.u(4)); perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('reports', %L)$q$, test.u(101)::text || '/y.pdf'), 'row-level security', 'an installer cannot upload a report file');
  perform test.ok((select count(*) from storage.objects where bucket_id = 'reports') = 0, 'an installer cannot read a report file');
  perform test.as_user(test.u(6)); perform test.ok((select count(*) from storage.objects where bucket_id = 'reports') = 0, 'a general contractor cannot read a report file');
  perform test.as_user(test.u(7)); perform test.ok((select count(*) from storage.objects where bucket_id = 'reports') = 0, 'a client cannot read a report file');
  perform test.as_user(test.u(9)); perform test.ok((select count(*) from storage.objects where bucket_id = 'reports') = 0, 'a manager of another project cannot read it');
  perform test.as_anon(); perform test.raises(format($q$insert into storage.objects (bucket_id, name) values ('reports', %L)$q$, test.u(101)::text || '/z.pdf'), '42501', 'anon cannot upload a report file');
  perform test.as_postgres();
end $$;
rollback;

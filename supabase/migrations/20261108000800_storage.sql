-- 0800: private bucket for audit photos. Object path = photos.storage_path, so a file can only be uploaded
-- after its photos row exists (and only by the person who captured it), and read only by people who can see the audit.

insert into storage.buckets (id, name, public) values ('audit-photos', 'audit-photos', false) on conflict (id) do nothing;

create policy audit_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'audit-photos'
    and exists (select 1 from public.photos p where p.storage_path = name and p.captured_by = auth.uid() and p.confirmed_at is null)
  );

create policy audit_photos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'audit-photos'
    and exists (select 1 from public.photos p where p.storage_path = name and app.can_see_audit(p.audit_id, p.version))
  );
-- No update or delete policies: uploaded evidence cannot be replaced or removed by users.

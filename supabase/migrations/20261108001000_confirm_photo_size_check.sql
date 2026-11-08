-- 1000: confirm_photo now verifies the uploaded file's size equals the size registered with the photo record
-- (a truncated or corrupted upload is refused instead of being marked confirmed).
-- Supabase Storage records each object's size in storage.objects.metadata->>'size'.
create or replace function public.confirm_photo(p_photo_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_uid uuid := auth.uid(); v_p public.photos; v_found boolean; v_size bigint;
begin
  if v_uid is null or not app.is_active() then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from public.photos where id = p_photo_id for update;
  if not found then raise exception 'photo_not_found'; end if;
  if not (v_p.captured_by = v_uid or app.has_role(v_p.project_id, app.override_roles())) then
    raise exception 'role_not_authorized' using errcode = '42501';
  end if;
  if v_p.confirmed_at is not null then return; end if;
  select true, (o.metadata ->> 'size')::bigint into v_found, v_size
    from storage.objects o where o.bucket_id = 'audit-photos' and o.name = v_p.storage_path limit 1;
  if v_found is not true then raise exception 'upload_not_found'; end if;
  if v_size is distinct from v_p.bytes then
    raise exception 'size_mismatch' using detail = format('registered %s bytes, stored %s bytes', v_p.bytes, coalesce(v_size::text, 'unknown'));
  end if;
  update public.photos set confirmed_at = now() where id = p_photo_id;
end $$;

-- Room details: shape rules, PHC-only fields kept out, installers read-only.
begin;
\ir fixtures.sql

do $$
declare p uuid := test.u(101); r uuid := test.u(6001);
begin
  insert into public.rooms (id, project_id, name, details, details_source, details_updated_at)
  values (r, p, 'Detail room', '{"panelName":"Slab","woodSpecies":"Pre Finished","finishName":"Uniboard K15","edgebanding":"To Match"}', 'cockpit', now());
  perform test.ok((select details ->> 'woodSpecies' from public.rooms where id = r) = 'Pre Finished', 'room details are stored and read back');
  perform test.ok((select details from public.rooms where project_id = p and name <> 'Detail room' limit 1) = '{}'::jsonb, 'existing rooms default to empty details');
  perform test.raises(format($q$update public.rooms set details = '{"phcOnlyNotes":"internal"}' where id = %L$q$, r), 'rooms_details_valid', 'PHC Only Notes cannot be stored in room details');
  perform test.raises(format($q$update public.rooms set details = '{"gateCode":"1234"}' where id = %L$q$, r), 'rooms_details_valid', 'a gate code cannot be stored in room details');
  perform test.raises(format($q$update public.rooms set details = '{"panelName":42}' where id = %L$q$, r), 'rooms_details_valid', 'a non-text value is rejected');
  perform test.raises(format($q$update public.rooms set details = '["a"]' where id = %L$q$, r), 'rooms_details_valid', 'details must be an object');
  perform test.raises(format($q$update public.rooms set details = %L::jsonb where id = %L$q$, jsonb_build_object('panelName', repeat('x', 501))::text, r), 'rooms_details_valid', 'a value over 500 characters is rejected');
  perform test.raises(format($q$update public.rooms set details = '{"bad key":"x"}' where id = %L$q$, r), 'rooms_details_valid', 'a key with spaces is rejected');
  perform test.raises(format($q$update public.rooms set details = (select jsonb_object_agg('k' || g, 'x') from generate_series(1, 61) g) where id = %L$q$, r), 'rooms_details_valid', 'more than 60 fields is rejected');
  perform test.raises(format($q$update public.rooms set details_source = 'guess' where id = %L$q$, r), 'rooms_details_source_valid', 'an unknown source is rejected');
  perform test.ok((select count(*) from public.audit_log where table_name = 'rooms' and record_id = r::text) >= 1, 'room detail changes are written to the audit log');

  -- ---- who can read / write ----
  perform test.as_user(test.u(4));                      -- an installer on this project
  perform test.ok((select details ->> 'panelName' from public.rooms where id = r) = 'Slab', 'an installer can read room details');
  update public.rooms set details = '{"panelName":"Changed"}' where id = r;
  perform test.as_postgres();
  perform test.ok((select details ->> 'panelName' from public.rooms where id = r) = 'Slab', 'an installer cannot change room details');
  perform test.as_user(test.u(5));                      -- an installer on a different project
  perform test.ok((select count(*) from public.rooms where id = r) = 0, 'a user outside the project cannot see room details');
  perform test.as_user(test.u(3));                      -- installation manager
  update public.rooms set details = '{"panelName":"Manager edit"}' where id = r;
  perform test.as_postgres();
  perform test.ok((select details ->> 'panelName' from public.rooms where id = r) = 'Manager edit', 'a manager can change room details');
end $$;
rollback;

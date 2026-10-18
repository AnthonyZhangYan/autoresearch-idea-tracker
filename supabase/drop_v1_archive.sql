-- AutoResearch Idea Tracker: OPTIONAL, LATER. Permanently delete the archived
-- V1 data (schema tracker_v1_archive) that the V2 upgrade kept.
--
-- Only run this after V2 has been verified in production AND the verified V1
-- backup file is stored safely outside this repository. Until then, keep the
-- archive: it is the in-database copy of V1 and costs nothing to keep.
-- auth.users and public.profiles are not touched. No CASCADE is used.
--
-- Change 'no' to 'yes' on the CONFIRMATION line, then run the whole file.
begin;

-- CONFIRMATION: change 'no' to 'yes' only when the conditions above are met.
select set_config('tracker.confirm_drop_v1_archive', 'no', true);

do $$
begin
  if current_setting('tracker.confirm_drop_v1_archive', true) is distinct from 'yes' then
    raise exception using message = 'Archive deletion not confirmed; nothing was changed';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'tracker_v1_archive') then
    raise exception using message = 'No V1 archive found; nothing was changed';
  end if;
  if to_regclass('public.idea_participants') is null then
    raise exception using message = 'V2 is not installed; keep the V1 archive. Nothing was changed';
  end if;
end;
$$;

select set_config('tracker.profiles_before',
  coalesce((select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.profiles p), 'none'), true);

drop table if exists tracker_v1_archive.idea_events;
drop table if exists tracker_v1_archive.ideas;
drop schema tracker_v1_archive;

do $$
begin
  if current_setting('tracker.profiles_before', true) is distinct from
      coalesce((select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.profiles p), 'none') then
    raise exception 'Profiles changed; rolled back';
  end if;
end;
$$;
commit;

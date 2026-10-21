-- AutoResearch Idea Tracker V2 migration: raise the idea description limit
-- from 100 KiB to 1 MiB (1,048,576 UTF-8 bytes).
--
-- Run the whole file ONCE in the SQL Editor as postgres on the existing V2
-- database, BEFORE deploying the frontend that accepts larger Markdown.
-- Transactional and repeatable. It replaces only the ideas_description_check
-- constraint. No row, other constraint, trigger, function, RLS policy, grant
-- or Realtime setting is changed; every existing description already fits.
--
-- Re-adding the constraint briefly locks public.ideas while it checks the
-- existing rows (a fraction of a second for this table). If another
-- transaction holds the table, the migration gives up after 5 seconds instead
-- of making members wait; nothing is changed and it can simply be rerun.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.ideas') is null or to_regclass('public.idea_participants') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: description limit (identical in supabase/schema.sql)
-- Descriptions hold whole Markdown documents: at most 1 MiB of UTF-8 text.
alter table public.ideas drop constraint if exists ideas_description_check;
alter table public.ideas add constraint ideas_description_check
  check (octet_length(description) <= 1048576);
-- <<< shared

notify pgrst, 'reload schema';
commit;

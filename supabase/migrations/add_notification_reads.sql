-- AutoResearch Idea Tracker V2 migration: per-member notification read state.
--
-- Additive and transactional. Run the whole file ONCE in the SQL Editor as
-- postgres on the existing V2 database, BEFORE deploying the frontend with the
-- notification bell. Rerunning it is harmless.
--
-- Notifications themselves are derived in the browser from the existing
-- idea_events activity history; nothing about them is stored here. This only
-- adds one row per member remembering the newest event that member has seen,
-- so read/unread is the same on every device.
-- What it adds: table public.notification_reads (SELECT-only RLS: own row),
-- RPC public.mark_notifications_read(bigint), and one row per existing member
-- set to the newest current event (existing history starts as read).
-- What it does NOT change: ideas, participants, results, comments, history,
-- profiles, Auth users, existing RPCs, RLS policies or the Realtime publication.
begin;

do $$
begin
  if to_regclass('public.idea_events') is null or to_regclass('public.profiles') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null
    or to_regprocedure('tracker_private.member_role()') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: notification reads (identical in supabase/schema.sql)
-- Notifications are derived in the browser from idea_events; this table only
-- remembers, per member, the newest event they have seen, so read/unread is the
-- same on every device. Members can read only their own row and change it only
-- through mark_notifications_read, which never moves backwards.
create table if not exists public.notification_reads (
  member_id uuid primary key references public.profiles(id) on delete restrict,
  last_read_event_id bigint not null default 0 check (last_read_event_id >= 0),
  updated_at timestamptz not null default now()
);
alter table public.notification_reads enable row level security;
drop policy if exists members_read_own_notification_reads on public.notification_reads;
create policy members_read_own_notification_reads on public.notification_reads for select to authenticated
  using (member_id = auth.uid() and (select tracker_private.member_role()) is not null);
revoke all on public.notification_reads from public, anon, authenticated;
grant select on public.notification_reads to authenticated;

-- Marks everything up to p_last_event_id as read for the caller. The position
-- never moves backwards and never passes the newest existing event.
create or replace function public.mark_notifications_read(p_last_event_id bigint)
returns public.notification_reads language plpgsql security definer set search_path = '' as $$
declare v_row public.notification_reads; v_newest bigint;
begin
  perform tracker_private.require_member();
  if p_last_event_id is null or p_last_event_id < 0 then raise exception 'Invalid notification position'; end if;
  select coalesce(max(e.id), 0) into v_newest from public.idea_events e;
  insert into public.notification_reads(member_id, last_read_event_id, updated_at)
  values (auth.uid(), least(p_last_event_id, v_newest), clock_timestamp())
  on conflict (member_id) do update
    set last_read_event_id = greatest(public.notification_reads.last_read_event_id, excluded.last_read_event_id),
        updated_at = clock_timestamp()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.mark_notifications_read(bigint) from public, anon, authenticated;
grant execute on function public.mark_notifications_read(bigint) to authenticated;

-- Existing members start with all current history marked as read, so the bell
-- does not open with the whole history as unread. Never overwrites a row.
insert into public.notification_reads(member_id, last_read_event_id)
select p.id, (select coalesce(max(e.id), 0) from public.idea_events e) from public.profiles p
on conflict (member_id) do nothing;
-- <<< shared

notify pgrst, 'reload schema';
commit;

-- AutoResearch Idea Tracker V2 migration: idea creators may delete their own
-- untouched ideas.
--
-- Run the whole file ONCE in the SQL Editor as postgres on the existing V2
-- database, BEFORE deploying the frontend that shows Delete to idea creators.
-- Transactional and repeatable. It replaces only public.delete_idea and
-- re-applies its EXECUTE grant. No table, row, trigger, RLS policy, table grant,
-- Realtime setting or history event is changed.
--
-- New rule (enforced here, not only in the browser):
--   * the PI may delete any idea, as before;
--   * the idea's creator may delete it only while it has no participation rows
--     (not even withdrawn ones) and no comments (not even removed ones);
--   * nobody else may delete it.
-- Deletion still records one 'deleted' event with the complete snapshot and
-- removes the idea's comments and participants explicitly, leaving no orphans.
begin;

do $$
begin
  if to_regclass('public.idea_participants') is null or to_regclass('public.idea_comments') is null
    or to_regprocedure('public.delete_idea(uuid,bigint)') is null
    or to_regprocedure('tracker_private.lock_idea(uuid,bigint,boolean)') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: delete_idea (identical in supabase/schema.sql)
-- The PI may delete any idea. Its creator may delete it only while nobody has
-- joined it (withdrawn participants count) and no comment exists (removed
-- comments count). The checks run after the idea is locked FOR UPDATE, which
-- waits for in-flight joins and comments (they hold KEY SHARE) and blocks new
-- ones until this transaction ends, so no contribution can slip in between the
-- check and the deletion. The 'deleted' event stores the idea with all
-- participant results and comments, then the rows are removed explicitly
-- (no cascading deletes).
create or replace function public.delete_idea(p_idea_id uuid, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision, true);
  if v_role <> 'pi' then
    if v_idea.created_by is distinct from auth.uid() then
      raise exception using errcode = '42501',
        message = 'Permission denied: only the PI or the idea creator can delete this idea';
    end if;
    if exists (select 1 from public.idea_participants where idea_id = v_idea.id)
      or exists (select 1 from public.idea_comments where idea_id = v_idea.id) then
      raise exception using errcode = '42501',
        message = 'Permission denied: this idea already has participants or comments; only the PI can delete it';
    end if;
  end if;
  insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state)
  values (v_idea.id, v_idea.idea_number, tracker_private.current_actor(), 'deleted',
    to_jsonb(v_idea) || jsonb_build_object(
      'participants', coalesce((select jsonb_agg(to_jsonb(p) order by p.joined_at)
        from public.idea_participants p where p.idea_id = v_idea.id), '[]'::jsonb),
      'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at)
        from public.idea_comments c where c.idea_id = v_idea.id), '[]'::jsonb)));
  delete from public.idea_comments where idea_id = v_idea.id;
  delete from public.idea_participants where idea_id = v_idea.id;
  delete from public.ideas where id = v_idea.id;
end;
$$;
-- <<< shared

revoke all on function public.delete_idea(uuid, bigint) from public, anon, authenticated;
grant execute on function public.delete_idea(uuid, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;

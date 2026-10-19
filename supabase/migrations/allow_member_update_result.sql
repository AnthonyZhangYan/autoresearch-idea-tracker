-- AutoResearch Idea Tracker V2 migration: members may change their own
-- submitted result (for example Fail -> Success, or corrected notes/link).
--
-- Run the whole file ONCE in the SQL Editor as postgres on the existing V2
-- database, BEFORE deploying the frontend that shows "Edit my result".
-- Transactional and repeatable. It replaces only public.submit_result and
-- re-applies its EXECUTE grant. No table, row, trigger, RLS policy, table grant,
-- Realtime setting or history event is changed.
--
-- New rule (enforced here, not only in the browser):
--   * a member may submit a result for their own Testing row, as before;
--   * a member may also change their own Completed row; an identical
--     resubmission is rejected so history records only real changes;
--   * still no member parameter: nobody, including the PI, writes another
--     member's row. The PI's reopen_result is unchanged.
-- The existing audit trigger records each change as 'participant_updated' with
-- the complete previous and new state, so earlier results stay in history.
begin;

do $$
begin
  if to_regclass('public.idea_participants') is null
    or to_regprocedure('public.submit_result(uuid,bigint,text,text,text)') is null
    or to_regprocedure('tracker_private.lock_participation(uuid,uuid,bigint)') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: submit_result (identical in supabase/schema.sql)
create or replace function public.submit_result(
  p_idea_id uuid, p_expected_revision bigint, p_result text,
  p_notes text default null, p_experiment_url text default null
) returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants;
begin
  perform tracker_private.require_member();
  if p_result is null or p_result not in ('success', 'fail') then
    raise exception 'Invalid completion result';
  end if;
  v_row := tracker_private.lock_participation(p_idea_id, auth.uid(), p_expected_revision);
  if v_row.status not in ('testing', 'completed') then raise exception 'Invalid status transition'; end if;
  if v_row.status = 'completed' and v_row.result = p_result
    and v_row.notes is not distinct from nullif(btrim(p_notes), '')
    and v_row.experiment_url is not distinct from nullif(btrim(p_experiment_url), '') then
    raise exception 'Result unchanged';
  end if;
  update public.idea_participants set status = 'completed', result = p_result,
    notes = nullif(btrim(p_notes), ''), experiment_url = nullif(btrim(p_experiment_url), ''),
    completed_at = clock_timestamp()
  where idea_id = p_idea_id and member_id = auth.uid() returning * into v_row;
  return v_row;
end;
$$;
-- <<< shared

revoke all on function public.submit_result(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_result(uuid, bigint, text, text, text) to authenticated;

commit;

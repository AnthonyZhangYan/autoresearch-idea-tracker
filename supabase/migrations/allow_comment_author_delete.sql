-- AutoResearch Idea Tracker V2: authors and PI may soft-delete comments/replies.
-- Review and run manually as postgres before deploying the updated frontend.
-- Transactional and repeatable; replaces only remove_comment and its EXECUTE ACL.
-- No rows, links, triggers, RLS policies, table grants or history are changed.
-- Existing SELECT-only member RLS remains: clients have no direct write grants
-- or write policies. SECURITY DEFINER authorizes active membership and ownership;
-- the administrator-managed profile supplies the PI role, never client metadata.
begin;

do $$
begin
  if to_regclass('public.idea_comments') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null
    or to_regprocedure('tracker_private.require_idea(uuid)') is null
    or to_regprocedure('public.remove_comment(uuid)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- The author/link/text fields are immutable. The conditional UPDATE permits
-- exactly one removal, including concurrent author/PI requests. Taking the idea
-- lock first preserves delete_idea's complete snapshot of committed removals.
create or replace function public.remove_comment(p_comment_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments; v_role text;
begin
  v_role := tracker_private.require_member();
  select * into v_comment from public.idea_comments where id = p_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  perform tracker_private.require_idea(v_comment.idea_id); -- parent before child
  if v_role <> 'pi' and v_comment.author_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  update public.idea_comments set removed_at = clock_timestamp(), removed_by = auth.uid()
  where id = p_comment_id and removed_at is null returning * into v_comment;
  if not found then raise exception 'Comment not found'; end if;
  return v_comment;
end;
$$;

revoke all on function public.remove_comment(uuid) from public, anon, authenticated;
grant execute on function public.remove_comment(uuid) to authenticated;

commit;

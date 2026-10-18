-- AutoResearch Idea Tracker V2 migration: threaded comment replies.
--
-- Additive and transactional. Run the whole file ONCE in the SQL Editor as
-- postgres on the existing V2 database, BEFORE deploying the frontend that
-- shows Reply buttons. Rerunning it is harmless.
--
-- What it changes:
--   * adds the nullable column idea_comments.parent_comment_id; every existing
--     comment keeps NULL and stays a top-level comment;
--   * adds a composite foreign key so a reply's parent exists and belongs to
--     the SAME idea, a self-reference check, and an index;
--   * adds a trigger that makes comments immutable apart from the PI's one-time
--     removal, so parent links (and therefore the reply tree) can never change;
--   * adds the RPC reply_to_comment and tightens add_comment's idempotency check.
-- What it does NOT change: ideas, participants, results, comment text, authors,
-- timestamps, removals, activity history, Auth users or profiles. Existing RPC
-- calls keep working unchanged. Activity history and Realtime keep using the
-- existing idea_events trigger: a reply is recorded as a 'commented' event
-- whose snapshot carries parent_comment_id.
-- Any error rolls back the entire migration.
begin;

do $$
begin
  if to_regclass('public.idea_comments') is null or to_regclass('public.idea_participants') is null
    or exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'ideas' and column_name = 'assigned_to') then
    raise exception using message = 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- Hold comments still while they are fingerprinted and altered (milliseconds).
lock table public.idea_comments in access exclusive mode;
select set_config('tracker.replies_first_run',
  (not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'idea_comments' and column_name = 'parent_comment_id'))::text, true);
select set_config('tracker.comments_before',
  coalesce((select md5(string_agg((to_jsonb(c) - 'parent_comment_id')::text, ',' order by c.id)) from public.idea_comments c), 'none'), true);

-- >>> shared: comment reply columns (identical in supabase/schema.sql)
-- Threaded replies. A reply points at a comment of the SAME idea: the composite
-- foreign key (parent_comment_id, idea_id) -> (id, idea_id) enforces both that
-- the parent exists and that it belongs to the same idea. Comments are
-- immutable (guard_comment_update) and a parent must exist before its reply,
-- so the replies always form a tree: cycles cannot occur. Comments without a
-- parent are top-level. Written as idempotent ALTERs so the same statements
-- upgrade an existing V2 database and build a fresh one.
alter table public.idea_comments add column if not exists parent_comment_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_id_idea_unique') then
    alter table public.idea_comments add constraint comment_id_idea_unique unique (id, idea_id);
  end if;
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_parent_same_idea') then
    alter table public.idea_comments add constraint comment_parent_same_idea
      foreign key (parent_comment_id, idea_id) references public.idea_comments (id, idea_id);
  end if;
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_not_own_parent') then
    alter table public.idea_comments add constraint comment_not_own_parent
      check (parent_comment_id is distinct from id);
  end if;
end;
$$;
create index if not exists idea_comments_parent_idx on public.idea_comments(parent_comment_id);
-- <<< shared

-- >>> shared: comment immutability (identical in supabase/schema.sql)
-- Comments are immutable. The only permitted change is the PI's one-time
-- removal (remove_comment), which sets removed_at/removed_by and nothing else.
create or replace function tracker_private.guard_comment_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.removed_at is not null
    or (new.id, new.idea_id, new.author_id, new.body, new.client_request_id, new.created_at, new.parent_comment_id)
      is distinct from (old.id, old.idea_id, old.author_id, old.body, old.client_request_id, old.created_at, old.parent_comment_id) then
    raise exception 'Comments are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists idea_comments_immutable on public.idea_comments;
create trigger idea_comments_immutable before update on public.idea_comments
  for each row execute function tracker_private.guard_comment_update();
-- <<< shared

-- >>> shared: add_comment (identical in supabase/schema.sql)
-- Stores the Markdown exactly as submitted. Repeating the same client request
-- ID returns the original comment instead of posting a duplicate.
create or replace function public.add_comment(p_idea_id uuid, p_body text, p_client_request_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments;
begin
  perform tracker_private.require_member();
  if p_client_request_id is null then raise exception 'Missing comment request ID'; end if;
  perform tracker_private.require_idea(p_idea_id);
  insert into public.idea_comments(idea_id, author_id, body, client_request_id)
  values (p_idea_id, auth.uid(), p_body, p_client_request_id)
  on conflict on constraint comment_request_once do nothing
  returning * into v_comment;
  if not found then
    select * into v_comment from public.idea_comments
    where author_id = auth.uid() and client_request_id = p_client_request_id;
    if v_comment.idea_id <> p_idea_id or v_comment.parent_comment_id is not null then
      raise exception 'Comment request ID already used';
    end if;
  end if;
  return v_comment;
end;
$$;
-- <<< shared

-- >>> shared: reply_to_comment (identical in supabase/schema.sql)
-- Reply to any comment or reply. The idea is taken from the parent, so a reply
-- can never be attached to another idea. Same idempotency as add_comment: the
-- same client request ID returns the original reply instead of a duplicate.
create or replace function public.reply_to_comment(p_parent_comment_id uuid, p_body text, p_client_request_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments; v_parent public.idea_comments; v_idea_id uuid;
begin
  perform tracker_private.require_member();
  if p_client_request_id is null then raise exception 'Missing comment request ID'; end if;
  select * into v_comment from public.idea_comments
  where author_id = auth.uid() and client_request_id = p_client_request_id;
  if found then
    if v_comment.parent_comment_id is distinct from p_parent_comment_id then
      raise exception 'Comment request ID already used';
    end if;
    return v_comment; -- an earlier attempt already succeeded
  end if;
  select idea_id into v_idea_id from public.idea_comments where id = p_parent_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  perform tracker_private.require_idea(v_idea_id); -- parent idea before child rows
  select * into v_parent from public.idea_comments where id = p_parent_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  if v_parent.removed_at is not null then raise exception 'Cannot reply to a removed comment'; end if;
  insert into public.idea_comments(idea_id, author_id, body, client_request_id, parent_comment_id)
  values (v_parent.idea_id, auth.uid(), p_body, p_client_request_id, p_parent_comment_id)
  on conflict on constraint comment_request_once do nothing
  returning * into v_comment;
  if not found then
    select * into v_comment from public.idea_comments
    where author_id = auth.uid() and client_request_id = p_client_request_id;
    if v_comment.parent_comment_id is distinct from p_parent_comment_id then
      raise exception 'Comment request ID already used';
    end if;
  end if;
  return v_comment;
end;
$$;
-- <<< shared

revoke all on function tracker_private.guard_comment_update() from public, anon, authenticated;
revoke all on function public.reply_to_comment(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reply_to_comment(uuid, text, uuid) to authenticated;

-- Existing comments must be unchanged; on the first run all are top-level.
do $$
begin
  if current_setting('tracker.comments_before', true) is distinct from
      coalesce((select md5(string_agg((to_jsonb(c) - 'parent_comment_id')::text, ',' order by c.id)) from public.idea_comments c), 'none')
    or (current_setting('tracker.replies_first_run', true) = 'true'
      and exists (select 1 from public.idea_comments where parent_comment_id is not null)) then
    raise exception 'Existing comments changed during the migration; rolled back';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;

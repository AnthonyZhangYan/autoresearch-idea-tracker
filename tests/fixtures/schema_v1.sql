-- Frozen copy of the V1 business schema (commit cb086bd). Used only by
-- database.test.mjs to verify supabase/reset_v1_business_schema.sql. Never run in production.
-- AutoResearch Idea Tracker. Run the entire file in the existing project's SQL
-- Editor as postgres. No accounts, research data, or credentials are seeded.
-- Repeatable for this schema version; does not reset identities or delete data.
begin;

create schema if not exists tracker_private;
revoke all on schema tracker_private from public, anon, authenticated;
grant usage on schema public, tracker_private to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null unique,
  role text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint authorized_member check (
    (display_name = 'Shibo' and role = 'pi') or
    (display_name in ('Yan', 'Junqi', 'Yifan') and role = 'researcher')
  )
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  idea_number bigint generated always as identity unique,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '',
  week_start date not null check (extract(isodow from week_start) = 1),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status text not null default 'available' check (status in ('available', 'testing', 'completed')),
  assigned_to uuid references public.profiles(id) on delete restrict,
  result text check (result in ('success', 'fail')),
  notes text check (length(notes) <= 20000),
  experiment_url text check (
    experiment_url is null or
    (length(experiment_url) <= 2048 and experiment_url ~* '^https?://[^[:space:]]+$')
  ),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  constraint idea_state check (
    (status = 'available' and assigned_to is null and result is null and completed_at is null) or
    (status = 'testing' and assigned_to is not null and result is null and completed_at is null) or
    (status = 'completed' and assigned_to is not null and result is not null and completed_at is not null)
  ),
  constraint result_details_only_when_completed check (
    status = 'completed' or (notes is null and experiment_url is null)
  )
);

-- Non-destructive upgrade from the original 20,000-character description limit.
-- UTF-8 text of that size fits within 100 KiB, including four-byte characters.
-- Keep the original constraint name so rerunning also upgrades existing tables.
alter table public.ideas drop constraint if exists ideas_description_check;
alter table public.ideas add constraint ideas_description_check
  check (octet_length(description) <= 102400);

create table if not exists public.idea_events (
  id bigint generated always as identity primary key,
  -- Intentionally no idea FK: deletion preserves immutable historical snapshots.
  idea_id uuid not null,
  idea_number bigint not null,
  actor_id uuid references public.profiles(id) on delete restrict,
  event_type text not null check (event_type in
    ('created', 'edited', 'claimed', 'released', 'completed', 'reopened', 'deleted')),
  previous_state jsonb,
  new_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ideas_week_number_idx on public.ideas(week_start desc, idea_number desc);
create index if not exists ideas_assigned_status_idx on public.ideas(assigned_to, status);
create index if not exists idea_events_idea_idx on public.idea_events(idea_id, id desc);
create index if not exists idea_events_created_idx on public.idea_events(id desc);

alter table public.profiles enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_events enable row level security;

-- Owner-only lookup avoids recursive profile RLS. Role comes ONLY from the
-- administrator-managed allowlist, never JWT user_metadata or client input.
create or replace function tracker_private.member_role()
returns text language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active;
$$;

create or replace function tracker_private.require_member(p_pi_only boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  v_role := tracker_private.member_role();
  if v_role is null or (p_pi_only and v_role <> 'pi') then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  return v_role;
end;
$$;

drop policy if exists members_read_profiles on public.profiles;
create policy members_read_profiles on public.profiles for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_ideas on public.ideas;
create policy members_read_ideas on public.ideas for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_events on public.idea_events;
create policy members_read_events on public.idea_events for select to authenticated
  using ((select tracker_private.member_role()) is not null);

-- No INSERT/UPDATE/DELETE policies or grants for clients. RPCs are the only
-- mutation path, and all seven explicitly authorize the caller.
revoke all on public.profiles, public.ideas, public.idea_events from public, anon, authenticated;
grant select on public.profiles, public.ideas, public.idea_events to authenticated;
revoke all on sequence public.ideas_idea_number_seq, public.idea_events_id_seq from public, anon, authenticated;

create or replace function tracker_private.touch_idea()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$$;
drop trigger if exists ideas_touch on public.ideas;
create trigger ideas_touch before update on public.ideas
  for each row execute function tracker_private.touch_idea();

-- Trigger records snapshots in the SAME transaction as each mutation.
create or replace function tracker_private.audit_idea()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text; v_actor uuid;
begin
  -- SQL Editor maintenance may have no Auth identity; do not invent an actor.
  select p.id into v_actor from public.profiles p where p.id = auth.uid();
  if tg_op = 'DELETE' then
    insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state)
    values (old.id, old.idea_number, v_actor, 'deleted', to_jsonb(old));
    return old;
  elsif tg_op = 'INSERT' then
    v_type := 'created';
  elsif old.status = 'available' and new.status = 'testing' then v_type := 'claimed';
  elsif old.status = 'testing' and new.status = 'available' then v_type := 'released';
  elsif old.status = 'testing' and new.status = 'completed' then v_type := 'completed';
  elsif old.status = 'completed' and new.status = 'available' then v_type := 'reopened';
  else v_type := 'edited';
  end if;
  insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state, new_state)
  values (new.id, new.idea_number, v_actor, v_type,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, to_jsonb(new));
  return new;
end;
$$;
drop trigger if exists ideas_audit on public.ideas;
create trigger ideas_audit after insert or update or delete on public.ideas
  for each row execute function tracker_private.audit_idea();

-- A revision check prevents a stale edit/result/delete from applying to a later
-- testing cycle. Lock lasts until the surrounding RPC transaction commits.
create or replace function tracker_private.lock_idea(p_idea_id uuid, p_expected_revision bigint)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member();
  select * into v_idea from public.ideas where id = p_idea_id for update;
  if not found then raise exception 'Idea not found'; end if;
  if p_expected_revision is null or v_idea.revision <> p_expected_revision then
    raise exception 'Idea changed. Refresh and try again';
  end if;
  return v_idea;
end;
$$;

create or replace function public.create_idea(
  p_title text, p_description text, p_week_start date, p_priority text
) returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member(true);
  insert into public.ideas(title, description, week_start, priority, created_by)
  values (btrim(p_title), coalesce(p_description, ''), p_week_start, p_priority, auth.uid())
  returning * into v_idea;
  return v_idea;
end;
$$;

create or replace function public.update_idea(
  p_idea_id uuid, p_expected_revision bigint, p_title text,
  p_description text, p_week_start date, p_priority text
) returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member(true);
  perform tracker_private.lock_idea(p_idea_id, p_expected_revision);
  update public.ideas set title = btrim(p_title), description = coalesce(p_description, ''),
    week_start = p_week_start, priority = p_priority
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;

create or replace function public.delete_idea(p_idea_id uuid, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform tracker_private.require_member(true);
  perform tracker_private.lock_idea(p_idea_id, p_expected_revision);
  delete from public.ideas where id = p_idea_id;
end;
$$;

create or replace function public.claim_idea(p_idea_id uuid)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member();
  -- Atomic conditional UPDATE: a competing transaction waits, then PostgreSQL
  -- rechecks the predicate. Exactly one caller can change Available to Testing.
  update public.ideas set status = 'testing', assigned_to = auth.uid()
  where id = p_idea_id and status = 'available' and assigned_to is null
  returning * into v_idea;
  if not found then
    if not exists (select 1 from public.ideas where id = p_idea_id) then
      raise exception 'Idea not found';
    end if;
    raise exception 'Idea already claimed or no longer available';
  end if;
  return v_idea;
end;
$$;

create or replace function public.release_idea(p_idea_id uuid, p_expected_revision bigint)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision);
  if v_role <> 'pi' and v_idea.assigned_to is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  if v_idea.status <> 'testing' then raise exception 'Invalid status transition'; end if;
  update public.ideas set status = 'available', assigned_to = null,
    result = null, notes = null, experiment_url = null, completed_at = null
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;

create or replace function public.complete_idea(
  p_idea_id uuid, p_expected_revision bigint, p_result text,
  p_notes text default null, p_experiment_url text default null
) returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  if p_result is null or p_result not in ('success', 'fail') then
    raise exception 'Invalid completion result';
  end if;
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision);
  if v_role <> 'pi' and v_idea.assigned_to is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  if v_idea.status <> 'testing' then raise exception 'Invalid status transition'; end if;
  update public.ideas set status = 'completed', result = p_result,
    notes = nullif(btrim(p_notes), ''), experiment_url = nullif(btrim(p_experiment_url), ''),
    completed_at = clock_timestamp()
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;

create or replace function public.reopen_idea(p_idea_id uuid, p_expected_revision bigint)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member(true);
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision);
  if v_idea.status <> 'completed' then raise exception 'Invalid status transition'; end if;
  update public.ideas set status = 'available', assigned_to = null,
    result = null, notes = null, experiment_url = null, completed_at = null
  where id = p_idea_id returning * into v_idea;
  -- audit_idea preserves the full previous completion, assignee, notes and URL.
  return v_idea;
end;
$$;

-- Apply exact signatures, not broad grants on every function in public.
revoke all on function tracker_private.member_role() from public, anon, authenticated;
revoke all on function tracker_private.require_member(boolean) from public, anon, authenticated;
revoke all on function tracker_private.lock_idea(uuid, bigint) from public, anon, authenticated;
revoke all on function tracker_private.touch_idea() from public, anon, authenticated;
revoke all on function tracker_private.audit_idea() from public, anon, authenticated;
grant execute on function tracker_private.member_role() to authenticated;

revoke all on function public.create_idea(text, text, date, text) from public, anon, authenticated;
revoke all on function public.update_idea(uuid, bigint, text, text, date, text) from public, anon, authenticated;
revoke all on function public.delete_idea(uuid, bigint) from public, anon, authenticated;
revoke all on function public.claim_idea(uuid) from public, anon, authenticated;
revoke all on function public.release_idea(uuid, bigint) from public, anon, authenticated;
revoke all on function public.complete_idea(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.reopen_idea(uuid, bigint) from public, anon, authenticated;
grant execute on function public.create_idea(text, text, date, text) to authenticated;
grant execute on function public.update_idea(uuid, bigint, text, text, date, text) to authenticated;
grant execute on function public.delete_idea(uuid, bigint) to authenticated;
grant execute on function public.claim_idea(uuid) to authenticated;
grant execute on function public.release_idea(uuid, bigint) to authenticated;
grant execute on function public.complete_idea(uuid, bigint, text, text, text) to authenticated;
grant execute on function public.reopen_idea(uuid, bigint) to authenticated;

-- Supabase Postgres Changes does not apply row-level RLS to DELETE events.
-- Publish only INSERT/UPDATE. Deletion synchronization uses audit_idea's
-- transactional idea_events INSERT, which Realtime can authorize with SELECT RLS.
-- Publication actions apply to EVERY member table. Fail closed if this existing
-- publication is shared; never silently change another application's event feed.
-- Requires PostgreSQL 15+ (schema-level publication catalog).
do $$
declare v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime with (publish = 'insert, update');
  else
    if exists (select 1 from pg_publication
        where pubname = 'supabase_realtime' and puballtables)
      or exists (select 1 from pg_publication_namespace pn
        join pg_publication p on p.oid = pn.pnpubid
        where p.pubname = 'supabase_realtime')
      or exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and not (schemaname = 'public' and tablename in ('profiles', 'ideas', 'idea_events'))) then
      raise exception using
        message = 'Refusing to change shared supabase_realtime publication',
        hint = 'Review publication tables, schema membership and consumers. Resolve shared usage before deploying; do not remove this guard or disable RLS.';
    end if;
    alter publication supabase_realtime set (publish = 'insert, update');
  end if;
  foreach v_table in array array['profiles', 'ideas', 'idea_events'] loop
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;

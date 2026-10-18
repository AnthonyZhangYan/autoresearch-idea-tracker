-- AutoResearch Idea Tracker: READ-ONLY backup export of the V1 business data.
--
-- One SELECT statement; it changes nothing. Run it in the SQL Editor as the
-- administrator BEFORE upgrading to V2. It exports every V1 idea (complete
-- Markdown, author attribution and all metadata), the complete V1 activity
-- history with full snapshots, and the member profiles needed to resolve
-- attribution. Auth secrets are not read.
--
-- Result columns:
--   fingerprint          paste this into supabase/schema.sql to allow the upgrade
--   profiles/ideas/events row counts
--   idea_001_*           title, UTF-8 byte length and MD5 of IDEA-001's Markdown
--   backup               the complete backup document (JSON)
--
-- Save the `backup` value (or the whole result exported as JSON/CSV) to a
-- PRIVATE file OUTSIDE this repository, then verify it:
--   node tools/verify_v1_backup.mjs <backup-file> <fingerprint>
-- Never commit backups: they contain research text and member identities.
--
-- Canonical rows: every value is text (timestamps as UTC microsecond ISO
-- strings, JSON snapshots as their exact jsonb text). The fingerprint MUST stay
-- identical to tracker_private.v1_fingerprint() in schema.sql and to
-- tools/verify_v1_backup.mjs; tests/database.test.mjs checks all three agree.
with
profiles_rows as (
  select jsonb_build_object('id', p.id::text, 'display_name', p.display_name, 'role', p.role,
    'active', p.active::text, 'created_at', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) r
  from public.profiles p
),
ideas_rows as (
  select i.idea_number n, jsonb_build_object('id', i.id::text, 'idea_number', i.idea_number::text,
    'title', i.title, 'description', i.description, 'week_start', to_char(i.week_start, 'YYYY-MM-DD'),
    'priority', i.priority, 'status', i.status, 'assigned_to', i.assigned_to::text, 'result', i.result,
    'notes', i.notes, 'experiment_url', i.experiment_url, 'created_by', i.created_by::text,
    'created_at', to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completed_at', to_char(i.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'revision', i.revision::text) r
  from public.ideas i
),
events_rows as (
  select e.id n, jsonb_build_object('id', e.id::text, 'idea_id', e.idea_id::text,
    'idea_number', e.idea_number::text, 'actor_id', e.actor_id::text, 'event_type', e.event_type,
    'previous_state', e.previous_state::text, 'new_state', e.new_state::text,
    'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) r
  from public.idea_events e
),
-- Each row becomes "key=value" pairs (a bare key for null) sorted by key and
-- joined with U+001F; rows are joined with newlines in a fixed order.
lines as (
  select 'profiles' t, r->>'id' sort_text, null::bigint sort_number, r from profiles_rows
  union all select 'ideas', null, n, r from ideas_rows
  union all select 'events', null, n, r from events_rows
),
hashes as (
  select
    (select md5(coalesce(string_agg(l.line, chr(10) order by l.sort_text collate "C"), '')) from (
      select sort_text, (select coalesce(string_agg(case when e.value is null then e.key else e.key || '=' || e.value end,
        chr(31) order by e.key collate "C"), '') from jsonb_each_text(r) e) line from lines where t = 'profiles') l) hp,
    (select md5(coalesce(string_agg(l.line, chr(10) order by l.sort_number), '')) from (
      select sort_number, (select coalesce(string_agg(case when e.value is null then e.key else e.key || '=' || e.value end,
        chr(31) order by e.key collate "C"), '') from jsonb_each_text(r) e) line from lines where t = 'ideas') l) hi,
    (select md5(coalesce(string_agg(l.line, chr(10) order by l.sort_number), '')) from (
      select sort_number, (select coalesce(string_agg(case when e.value is null then e.key else e.key || '=' || e.value end,
        chr(31) order by e.key collate "C"), '') from jsonb_each_text(r) e) line from lines where t = 'events') l) he
),
summary as (
  select md5('autoresearch-v1-backup-1' || chr(10) || 'profiles=' || hp || chr(10) || 'ideas=' || hi || chr(10) || 'events=' || he) fingerprint,
    (select count(*) from profiles_rows) profiles, (select count(*) from ideas_rows) ideas, (select count(*) from events_rows) events
  from hashes
)
select s.fingerprint, s.profiles, s.ideas, s.events,
  i.title as idea_001_title, octet_length(i.description) as idea_001_description_bytes, md5(i.description) as idea_001_description_md5,
  jsonb_build_object(
    'format', 'autoresearch-v1-backup', 'version', 1,
    'exported_at', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'fingerprint', s.fingerprint,
    'counts', jsonb_build_object('profiles', s.profiles, 'ideas', s.ideas, 'idea_events', s.events),
    'profiles', coalesce((select jsonb_agg(r order by r->>'id' collate "C") from profiles_rows), '[]'::jsonb),
    'ideas', coalesce((select jsonb_agg(r order by n) from ideas_rows), '[]'::jsonb),
    'idea_events', coalesce((select jsonb_agg(r order by n) from events_rows), '[]'::jsonb)
  ) as backup
from summary s
left join public.ideas i on i.idea_number = 1;

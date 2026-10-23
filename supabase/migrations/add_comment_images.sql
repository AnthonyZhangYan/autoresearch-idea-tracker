-- AutoResearch Idea Tracker V2 migration: images (screenshots) in comments.
--
-- Additive and transactional. Run the whole file ONCE in the SQL Editor as
-- postgres on the V2 database, BEFORE deploying the frontend that uploads
-- images. Rerunning it is harmless. Fresh installs run it after schema.sql:
-- it configures Supabase Storage, which a plain PostgreSQL database lacks.
--
-- What it changes:
--   * creates (or re-tightens) the PRIVATE Storage bucket comment-images:
--     PNG, JPEG, GIF or WebP only, at most 5 MiB per file;
--   * lets active members read every image in that bucket, and upload new
--     images only into their own folder <auth uid>/<random uuid>.<ext>.
-- Images are immutable: there is no UPDATE or DELETE policy, so an upload can
-- never be replaced or removed through the API (like comments, a removed
-- comment keeps its original text in history, and the image it refers to).
-- Comments refer to an image as ![alt](attachment:<uid>/<uuid>.<ext>); the
-- comment table, RPCs and activity history are unchanged.
-- What it does NOT change: ideas, participants, results, comments, history,
-- Auth users, profiles, RLS on public tables, or Realtime.
-- Any error rolls back the entire migration.
begin;

do $$
begin
  if to_regclass('public.idea_comments') is null or to_regprocedure('tracker_private.member_role()') is null then
    raise exception using message = 'This migration requires the V2 schema; nothing was changed';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception using message = 'This migration requires Supabase Storage; nothing was changed';
  end if;
end;
$$;

-- Must match COMMENT_IMAGE_BUCKET, MAX_IMAGE_BYTES and IMAGE_TYPES in index.html.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comment-images', 'comment-images', false, 5242880,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists members_read_comment_images on storage.objects;
create policy members_read_comment_images on storage.objects for select to authenticated
  using (bucket_id = 'comment-images' and (select tracker_private.member_role()) is not null);

-- The object name is <uploader uid>/<uuid>.<ext>, so the path itself records
-- who uploaded an image and nobody can write into another member's folder.
drop policy if exists members_upload_comment_images on storage.objects;
create policy members_upload_comment_images on storage.objects for insert to authenticated
  with check (bucket_id = 'comment-images' and (select tracker_private.member_role()) is not null
    and split_part(name, '/', 1) = (select auth.uid())::text
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$');

commit;

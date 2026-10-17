# AutoResearch Idea Tracker

A private, collaborative research workspace for **PML4SC Lab**, with single-file Markdown idea import, safe formatted previews, and LaTeX math. Shibo publishes weekly ideas; Shibo, Yan, Junqi, and Yifan claim experiments and record Success or Fail results. Completed experiments and prior testing cycles remain available for review.

**Deployment status — October 16, 2026:** the initial Supabase schema is installed, but the workspace is not yet ready for member use. These statuses were confirmed by the project owner; the limited read-only checks below are identified separately.

| Component | Current status |
| --- | --- |
| Initial database schema | **Completed:** `schema.sql` was executed successfully; `profiles`, `ideas`, and `idea_events` exist |
| Authentication settings | **Configured:** public signup disabled, email authentication enabled, anonymous sign-in disabled; also confirmed by a read-only Auth settings check |
| Four member accounts and profiles | **Not completed:** Shibo, Yan, Junqi, and Yifan have not been created/invited; no Auth UUIDs are mapped and Shibo's PI role is not assigned |
| Invitation onboarding (set-your-own-password) | **Implemented locally, not deployed:** frontend handling and tests only. Site URL, Redirect URLs, the invitation email template, and SMTP have **not** been configured or verified by this change; no invitation has been sent; live invitation acceptance is untested |
| Markdown description migration | **Not completed:** production still enforces the original **20,000-character** constraint; the local schema's **102,400-byte** upgrade is pending approval and execution |
| GitHub Pages | **Not deployed:** application changes remain local; no code has been pushed or deployed |
| Live integration tests | **Not completed:** real-member authentication and multi-user Realtime behavior remain unverified |

Read-only, anonymous Data API requests with `limit=0` now return **401 / 42501 (permission denied)** for all three application tables, replacing the earlier missing-table response. These checks retrieved no research rows. They do not establish the deployed publication flags, authenticated RLS behavior, or description constraint; those require administrator/member verification. This parser fix changes local frontend/tests/documentation only, with no database migration or production mutation.

## Architecture and files

```text
GitHub Pages: index.html (HTML + CSS + vanilla JavaScript)
                      │
         Supabase JS 2.118.0, pinned CDN + integrity hash
                      │
       Existing Supabase project: kgfybebpxpdkiouofyow
           ├── Auth: Dashboard invitations, then email/password
           ├── PostgreSQL: profiles, ideas, idea_events
           ├── RLS: active allowlisted members can read
           ├── RPCs: authorized, transactional mutations
           └── Realtime: refetch on database changes
```

| File | Purpose |
| --- | --- |
| `index.html` | Complete frontend; public Supabase URL and publishable key; no build step |
| `supabase/schema.sql` | Tables, constraints, indexes, triggers, policies, RPCs, grants, Realtime publication |
| `README.md` | Setup, deployment, maintenance, and verification |
| `.gitignore` | Excludes credentials, local configuration, dependencies, and test outputs |
| `.gitattributes` | Enforces LF line endings for HTML, Markdown, JavaScript, SQL, and Git configuration files |
| `tests/database.test.mjs` | Isolated PostgreSQL permission, state-machine, audit, and real concurrency tests |
| `tests/frontend.test.mjs` | Syntax and DOM integration tests using a simulated transport |
| `tests/invitation.test.mjs` | Invitation callback, password setup, login/logout, and allowlist tests with a simulated Auth client and the actual pinned SDK answered by local fetch responses |
| `reference/` | Existing user-supplied LeetCode reference, left unchanged |

No production Node server, framework, package installation, or build system is required. Node is used only for optional development tests. All task data comes from Supabase; the frontend includes no seeded ideas or fallback database. The SDK persists **Auth sessions** in browser storage. Idea data and permissions are never persisted there; filters and disclosure preferences are kept in memory.

## Implemented workflow

- Individual login/logout, restored sessions, explicit allowlist lookup, PI-aware controls.
- Invitation onboarding: a member opens the Supabase invitation email, lands on **Set Your Password**, chooses their own password through `supabase.auth.updateUser`, and then enters the tracker only if their profile is active. The administrator never sees or assigns member passwords. See section 2.
- PI publication, Markdown editing/import with live preview, deletion, and reopening; database-generated `IDEA-001` identifiers that are never recycled. Sequence gaps are normal after rolled-back transactions or deletion.
- Atomic claim: `available + unassigned → testing + auth.uid()`.
- Assignee or PI release and completion, required Success/Fail result, optional notes and HTTP(S) experiment URL.
- Read-only activity history with complete before/after snapshots; previous results survive reopening **and deletion**. The global Activity history includes deleted ideas.
- Six live counters, progress bar, expandable Monday-based weekly groups and cards.
- Search by number/title/description; week/status/assignee/result/priority filters; newest/oldest/number sorting within weekly groups. Groups follow their first matching record in the selected sort order. Counters always reflect all ideas; group counts reflect the filtered subset.
- Realtime change subscriptions, burst coalescing, reconnection with backoff, refresh after subscription, foreground/focus refresh, and a 30-second foreground reconciliation poll. Offline/stale indicators and disabled mutations when data cannot be refreshed.
- Confirmation dialogs, in-flight button disabling, conflict notifications, safe text rendering, keyboard-friendly native controls, responsive dark theme.

## Markdown ideas: one file, one draft, one publication

Shibo can create an idea manually or choose **Import one .md file** in the Publish idea dialog. A file always represents **one** idea. Multiple headings, sections, code blocks, or horizontal rules are never split into separate ideas. There is no bulk import.

1. Open **Publish idea**, then choose one local UTF-8 `.md` file, at most **100 KiB (102,400 bytes)**. A file stays on the computer until its text is submitted with the form; there is no file upload endpoint or Supabase Storage bucket.
2. The first Markdown H1 supplies the suggested title. Both `# Title` and Setext H1 (`Title` followed by `=====`) work; heading-like lines in code blocks are ignored. If no H1 exists, the filename without `.md` is used. A suggestion over 200 characters is shortened with a notice, while the full source stays unchanged.
3. Edit the suggested title, Markdown, Monday date, or priority as needed. The source editor and **Live preview** appear side by side on desktop and stack on narrow screens. Preview updates shortly after typing.
4. Review the preview, then explicitly click **Publish idea**. **Choosing a file never publishes or creates a database row.** Importing into a nonempty draft asks before replacing that draft. Cancel leaves the database unchanged.
5. Expand the published idea to read its formatted content. Shibo can use **Edit** to modify its Markdown or import a replacement into the edit draft, then explicitly **Save changes**. Existing revision checks prevent stale edits; history retains the complete previous source.

The complete source is stored as text in **`ideas.description`**, including all headings, code, tables, and LaTeX. It is not converted into HTML in the database, trimmed, or truncated. An imported document's original UTF-8 BOM, whitespace, and line endings are preserved when publishing or editing only metadata. Once the source textarea is edited, the browser's normal LF newline representation is saved as the edited document. The original published source remains in activity history.

The renderer supports the requested GitHub Flavored Markdown features: headings, ordered/unordered lists, tables, bold/italic, fenced code blocks, and links; it also supports strikethrough and automatic HTTP(S) links. Inline math uses `$...$`; display math uses `$$...$$`, including multiline equations. Math delimiters in code stay literal. Escape a literal dollar sign with `\$`. Unsupported or invalid LaTeX is displayed as an error/source rather than executed.

The local adapter for pinned `markdown-it-texmath` 1.0.0 recognizes escaped delimiters without stripping LaTeX backslashes. `$$\text{cost: \$5}$$` and `$\text{cost: \$5}$` both render correctly. Display math may share its closing line with prose: `$$x$$ trailing explanation` keeps the equation **and** the explanation visible, including further equations, links, or formatting on that line. Multiline display math works the same way. Parenthesized equation labels remain supported, and following text is retained. Unclosed delimiters remain ordinary visible Markdown; code spans/fences are not parsed as math. The adapter changes rendering only, never the stored original source or the final sanitization step.

````md
# Evaluate retrieval quality

Compare **baseline** and *candidate* strategies.

- Run the same benchmark for both.
- Record the experiment URL and result.

| Strategy | Score |
| --- | --- |
| Baseline | $s_b$ |
| Candidate | $s_c$ |

$$
\Delta = \frac{s_c - s_b}{s_b}
$$

```python
print("$this is code, not math$")
```

[Experiment repository](https://github.com/)
````

Files must have a `.md` extension (case-insensitive); accepted MIME types are empty/unspecified, `text/markdown`, `text/x-markdown`, `text/plain`, or `application/octet-stream`, because operating systems identify text files differently. Invalid UTF-8, null characters, unsupported types, multiple selections, and oversized files are rejected before changing the draft. Both file size and decoded UTF-8 text size are checked. Manually entered oversized text also cannot be submitted; it stays available for editing. Limits are **bytes**, so non-ASCII characters can use more than one byte.

Rendering security and scope:

- Raw HTML in Markdown is displayed as text. All generated Markdown and KaTeX HTML passes through **DOMPurify** before its sanitized DOM fragment is inserted. Titles, notes, history snapshots, errors, and other ordinary fields still use `textContent`.
- KaTeX uses `trust: false`, bounded expansion/size, and fresh macros for each expression. HTML injection commands, executable links, and external image commands are not trusted. See [KaTeX security options](https://katex.org/docs/options.html) and [DOMPurify](https://github.com/cure53/DOMPurify).
- Rendered links are limited to absolute HTTP(S) URLs, opened with `noopener noreferrer`. Relative/local-file links are shown as text because an imported local file has no published asset base. Image syntax remains in the stored source but displays as an image label; embedded/remote images and file attachments are outside this MVP.
- Missing parser/sanitizer/math libraries cause a safe original-text fallback, never unsanitized rendering. The import action requires the rendering libraries to be loaded so that title extraction and preview are available; manual source entry still works. No Markdown rendering failure changes authentication or database permissions.
- Long documents are rendered when their cards expand. No research text is sent to a Markdown or math rendering service; rendering happens in the browser.

All browser dependencies use exact CDN versions and SHA-384 integrity attributes:

| Library | Version | Purpose |
| --- | --- | --- |
| Supabase JS | 2.118.0 | Existing Auth, database and Realtime client |
| markdown-it | 15.0.3 | Markdown/GFM parsing, raw HTML disabled |
| DOMPurify | 3.4.17 | Final HTML/MathML/SVG sanitization |
| KaTeX | 0.19.0 | Math rendering plus pinned CSS/fonts |
| markdown-it-texmath | 1.0.0 | Math integration with a local dollar-rule adapter that preserves escapes and trailing text |

The Content Security Policy permits the pinned KaTeX font path and CDN stylesheet. No React, build system, production Node server, or storage service is introduced.

### Upgrade the existing description limit before publishing longer documents

**Pending in production:** the initial schema has been installed, but this description-limit upgrade has not been run. The math parsing fixes need only a future frontend deployment; longer documents still require the SQL upgrade below.

The original database allowed only 20,000 characters. The updated `schema.sql` replaces **only** `ideas_description_check` with a **102,400-byte** check. All previously valid UTF-8 descriptions fit in the new limit, including 20,000 four-byte characters. Notes retain their existing 20,000-character limit. No rows, identities, roles, workflows, or history are reset.

After deployment approval, run the full updated `supabase/schema.sql` using section 1; it is safe to rerun and retains the guarded INSERT/UPDATE-only Realtime publication. If the existing database has already received the reviewed Realtime/security schema, an administrator can instead apply just this narrow description upgrade in SQL Editor:

```sql
begin;
alter table public.ideas drop constraint if exists ideas_description_check;
alter table public.ideas add constraint ideas_description_check
  check (octet_length(description) <= 102400);
commit;
```

This narrow upgrade does **not** install a missing schema or repair the earlier DELETE-publication issue; verify section 4 separately. Confirm the deployed constraint:

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.ideas'::regclass
  and conname = 'ideas_description_check';
```

Expected: `CHECK ((octet_length(description) <= 102400))` (formatting may vary). Deploy the database upgrade before relying on the expanded frontend limit. If the old constraint rejects an otherwise valid long draft, the UI keeps it open and explains that the updated schema is required; it never silently truncates it.

## 1. Install the database in the existing Supabase project

Use organization **PML4SC_Lab**, project **autoresearch-idea-tracker**, URL `https://kgfybebpxpdkiouofyow.supabase.co`. Do not create a new project.

**Initial installation is already completed.** The following is the repeatable installation/reference procedure, not a request to reset or redeploy the database. The description-limit upgrade above is still pending, and publication flags must be checked separately.

1. Open [this project's SQL Editor](https://supabase.com/dashboard/project/kgfybebpxpdkiouofyow/sql/new) while signed in as its trusted administrator.
2. Inspect the existing publication using the preflight queries in section 4 and confirm it is used exclusively by this application. Do this before changing any publication settings.
3. Open the actual local `supabase/schema.sql` and copy **the entire plain SQL file** into a new SQL query (not a Markdown-escaped copy). After deployment approval, run it as the administrative `postgres` role. The file is one transaction; if a statement fails, roll back any still-open failed transaction, resolve the cause, and rerun the whole file. A shared-publication guard failure is a deployment blocker: do not bypass it. The previous publication remains unchanged, so a failed run has not fixed an older configuration.
4. Confirm `public.profiles`, `public.ideas`, and `public.idea_events` exist and each has RLS enabled.
5. In the project's **Data API settings**, keep the Data API enabled and confirm `public` is an exposed schema. **Do not expose `tracker_private`.** Do not enable automatic exposure/grants for every future table.
6. Run the verification queries below. If the Data API schema cache has not refreshed, run `notify pgrst, 'reload schema';` and retry after a few seconds.

The schema grants `authenticated` only SELECT on the three tables and EXECUTE on the seven public RPCs. It revokes anonymous/PUBLIC execution, denies client table mutations, and grants the one private membership lookup needed by RLS. Other private functions are not executable by clients. Creating a table alone would not be enough with this project's automatic exposure setting disabled. See [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) and [database function security](https://supabase.com/docs/guides/database/functions).

This setup is repeatable for the supplied schema version: it preserves rows and identity counters, replaces only this app's named functions, policies, and triggers, and configures an app-only publication for INSERT/UPDATE. Rerunning it upgrades the previous app-only publication without resetting data. It refuses to alter a shared publication; see section 4. It is **not** a general migration engine for incompatible preexisting tables. Future schema changes should use reviewed, non-destructive migrations; do not drop tables or reset sequences to fix deployment errors.

```sql
-- RLS must be true for all three rows.
select relname, relrowsecurity
from pg_class
where oid in ('public.profiles'::regclass,
              'public.ideas'::regclass,
              'public.idea_events'::regclass);

-- Expected: SELECT for authenticated, no client write grants.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('profiles', 'ideas', 'idea_events')
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- authenticated_exec=true, anon_exec=false for each app RPC.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       p.prosecdef as security_definer, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
 ('create_idea', 'update_idea', 'delete_idea', 'claim_idea',
  'release_idea', 'complete_idea', 'reopen_idea');
```

## 2. Configure authentication and invitations

**Already configured:** email authentication is enabled; public signup and anonymous sign-in are disabled. Keep these settings. **Not yet configured or verified:** Site URL, Redirect URLs, the invitation email template, SMTP, and link expiry below. No invitation has been sent.

> **Do not send any invitation until the frontend is deployed and A–C below are complete.** An invitation email's link is fixed when the email is sent and can be used only once. A link sent while the Site URL or template points elsewhere (for example Supabase's default `http://localhost:3000`) leads members to a dead page and wastes the invitation.

### How invitation onboarding works

1. The administrator invites a member from the Supabase Dashboard. The tracker has no invitation UI and never uses the `service_role` key; the publishable key is enough for everything the page does.
2. Supabase emails the member a one-time link to `https://anthonyzhangyan.github.io/autoresearch-idea-tracker/`.
3. The page detects the callback, removes the one-time credentials from the address bar (keeping the `/autoresearch-idea-tracker/` path), and establishes the session **once** with the SDK:
   - `?token_hash=…&type=invite` (recommended template, C below) → `supabase.auth.verifyOtp({token_hash, type:'invite'})`
   - `#access_token=…&refresh_token=…&type=invite` (default template) → `supabase.auth.setSession(...)`, which validates the token with Supabase Auth
   - `?code=…` (PKCE) → `supabase.auth.exchangeCodeForSession(code)`, attempted once. Dashboard invitations do not normally produce codes; this only covers a PKCE configuration.
   - `error`/`error_code` parameters (for example `otp_expired`) → "This invitation link has expired or is invalid. Please contact the administrator for a new invitation."

   The SDK's automatic URL detection stays disabled, so no credential is processed twice. The login page is not shown while this is in progress.
4. The member sees **Set Your Password**, enters and confirms a new password, and the page calls `supabase.auth.updateUser({password})` using that invitation session. The password goes only to Supabase Auth. It is never written to a table, URL, log, or browser storage.
5. The page confirms "Your password has been created successfully." and then checks `public.profiles`. An **active profile** shows **Enter the tracker**. Without one, the member sees "Your account has been created, but access to this research workspace has not yet been authorized. Please contact the administrator." No profile or role is created automatically.
6. From then on the member uses the ordinary **Email + Password** login. Refreshing or returning never shows onboarding again. If the member reloads *before* creating a password, setup resumes; the browser keeps only their Auth user ID for that purpose, and removes it on completion or logout.

Invitations work while **Allow new users to sign up** is off. Keep it off.

### A. Site URL

**Authentication → URL Configuration → Site URL**:

```text
https://anthonyzhangyan.github.io/autoresearch-idea-tracker/
```

Use exactly this value: `https`, the repository subpath, and the trailing slash. Dashboard invitations have no per-invite redirect option, so Supabase returns invited members to the Site URL. Save, then reload the page and confirm the value.

### B. Redirect URLs

On the same page, under **Redirect URLs → Add URL**, add:

```text
https://anthonyzhangyan.github.io/autoresearch-idea-tracker/
```

Add these only if you test the invitation flow against a local server (section 5):

```text
http://localhost:8000/
http://127.0.0.1:8000/
```

Supabase only redirects to allow-listed URLs and otherwise falls back to the Site URL. Use exact URLs; avoid wildcards for production. The app is a single page with no `/auth/callback` route, so every callback goes to the repository root shown above. Do not add `https://anthonyzhangyan.github.io/` alone: it is a different site.

### C. Invitation email

**Authentication → Emails → Templates → Invite user** (labels vary by Dashboard version).

**Recommended:** replace the link in the template body. Keep the subject as you like:

```html
<h2>You have been invited to the PML4SC Lab AutoResearch Idea Tracker</h2>
<p>Follow this link to accept the invitation and create your password:</p>
<p><a href="https://anthonyzhangyan.github.io/autoresearch-idea-tracker/?token_hash={{ .TokenHash }}&type=invite">Accept the invitation</a></p>
```

Why: with the default `{{ .ConfirmationURL }}`, Supabase consumes the one-time token at its `/verify` endpoint as soon as the link is fetched. University and corporate mail scanners (for example Safe Links) often pre-open links, which can use up the invitation before the member clicks it. With the template above, the token is consumed only when the tracker page runs in the member's browser. The URL is written out in full so it does not depend on whether the Site URL has a trailing slash. `{{ .SiteURL }}?token_hash={{ .TokenHash }}&type=invite` is equivalent if the Site URL is exactly as in A.

**Default template (also supported):** if you keep `{{ .ConfirmationURL }}`, Supabase verifies the token and redirects to the Site URL with `#access_token=…&type=invite`. The page handles that too, but it is vulnerable to the link pre-fetching described above.

Also check, in the Email provider / Auth settings (labels vary):

- **Email delivery:** Supabase's built-in email service is intended for testing. It delivers only to email addresses of your Supabase organization's team members and is heavily rate-limited. To reach the lab members' own addresses, configure **custom SMTP** (Authentication → Emails → SMTP Settings) with an approved sender, or confirm the current behavior in [Supabase's SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp). Send one invitation to yourself first.
- **Link lifetime:** invitations expire after the configured email OTP expiration. Choose a value that gives members time to respond (Supabase allows at most 24 hours), and tell members to accept promptly.
- **Password requirements:** set **Minimum password length to at least 8**, the minimum the page enforces before submitting. Any character requirements you configure are enforced by Supabase Auth and shown to the member if a password does not meet them. Supabase Auth rejects passwords longer than 72 bytes, and the page checks this too.
- Keep **Confirm email** enabled. Accepting an invitation confirms the member's address. Keep anonymous sign-ins and unused OAuth providers disabled.

Password recovery/reset links are **not** handled by this page; it accepts only `type=invite` callbacks. Forgotten passwords after onboarding remain an administrator task (section 3).

Dashboard labels change over time; see [Auth configuration](https://supabase.com/docs/guides/auth/general-configuration), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), and [password security](https://supabase.com/docs/guides/auth/password-security).

## 3. Invite and allowlist the four real members

**Not completed:** none of the four Auth accounts has been invited or mapped to `profiles`, and the PI role has not been assigned. Provisioning requires a separate authorized administrative step; this patch invites no one and creates no accounts.

The members **do not need Supabase Dashboard accounts**, and the administrator never knows their passwords. Only the administrator needs Dashboard access. No actual member email addresses have been provided, and none are included in this repository.

### Configuration order

1. **Deploy the frontend** to GitHub Pages (section 8) and confirm the page loads at `https://anthonyzhangyan.github.io/autoresearch-idea-tracker/`.
2. **Configure the Site URL and Redirect URLs** (section 2 A–B).
3. **Configure the invitation email flow** (section 2 C): template, SMTP, link lifetime, password length.
4. **Invite the members** through the Supabase Dashboard (below). Invite yourself or one member first and complete the flow before inviting the rest.
5. **Obtain the Auth UUIDs and insert the profiles** (below).
6. **Let members accept their invitations** and set their own passwords.
7. **Test authentication and authorization** (section 6).

Invitations must not be sent before steps 1–3 are complete and the production redirect URL is correct. Doing step 5 before step 6 lets members enter the tracker immediately after creating their password. If a member finishes step 6 first, they see the "not yet authorized" message. Once the profile exists, they simply sign in with their email and password; no new invitation is needed.

### Invite each member

1. Privately obtain each member's real email address and verify who owns it.
2. **Authentication → Users → Add user → Invite user** (also labelled "Send invitation"). Enter the email address and send. Repeat for each member.
3. The user appears immediately in the Users list (awaiting verification), so their Auth UUID is available before they accept.
4. If an invitation expires or is used up (the member sees "This invitation link has expired or is invalid"), invite the same address again from the Dashboard. If Supabase reports that the user already exists and is confirmed, the member has already set a password and should sign in normally.

Do not use **Create new user** with an administrator-chosen password for lab members; the invitation flow exists so that only the member knows their password. Do not put email addresses or other credentials into Git, screenshots, or chat logs.

### Obtain each Auth UUID

Open **Authentication → Users**, select the user, and copy **User UID**. Alternatively, run this read-only query in SQL Editor, replacing the placeholders with the real addresses:

```sql
-- Administrator only. Read-only.
select id, email, invited_at, email_confirmed_at, last_sign_in_at
from auth.users
where lower(email) in (lower('<SHIBO_EMAIL>'), lower('<YAN_EMAIL>'),
                       lower('<JUNQI_EMAIL>'), lower('<YIFAN_EMAIL>'))
order by email;
```

Match each UUID to the actual person, not to client-editable metadata. `email_confirmed_at` becomes non-null once the member has accepted the invitation.

### Map the UUIDs to profiles

Role mapping: **Shibo → `pi`**, **Yan → `researcher`**, **Junqi → `researcher`**, **Yifan → `researcher`**.

In SQL Editor as `postgres`, replace the four placeholder strings below with those UUIDs and execute once. The placeholders intentionally are not executable UUIDs.

```sql
begin;
insert into public.profiles (id, display_name, role) values
  ('<SHIBO_AUTH_UUID>'::uuid, 'Shibo', 'pi'),
  ('<YAN_AUTH_UUID>'::uuid,   'Yan',   'researcher'),
  ('<JUNQI_AUTH_UUID>'::uuid, 'Junqi', 'researcher'),
  ('<YIFAN_AUTH_UUID>'::uuid, 'Yifan', 'researcher');
commit;

select id, display_name, role, active
from public.profiles order by display_name;
```

Do not rerun this insert blindly after successful provisioning; inspect existing profiles first. The schema's name/role pairing constraint and unique names allow at most these four profiles, with only Shibo as PI. Users cannot create or update profiles, and there is no auto-profile Auth trigger. An Auth account alone—even if someone registers while signup is accidentally enabled—gets no lab data access.

To revoke a member's lab access while preserving assignments/history:

```sql
-- Trusted administrator only. Replace the UUID deliberately.
update public.profiles set active = false where id = '<MEMBER_AUTH_UUID>'::uuid;
```

Reads and RPC authorization then reject that member. Connected UIs remove cached workspace data on the next membership refresh; already downloaded information cannot be recalled. Ban/revoke their Auth sessions through administrative Auth tools as appropriate. Re-enable by setting `active = true`. Do not delete Auth/profile rows casually: restrictive foreign keys intentionally preserve attribution. Account replacement needs a reviewed administrative migration.

**Forgotten passwords:** self-service password reset is not implemented; the page rejects recovery links. If a member forgets their password after onboarding, the administrator handles it outside the tracker, for example by setting a temporary password in the Dashboard and delivering it privately. A reset page would be a separate, reviewed change.

## 4. Verify Realtime configuration

Supabase Postgres Changes does **not** apply normal row-level RLS filtering to DELETE events. Publishing even deleted-row identifiers can therefore expose metadata to authenticated non-members. Limiting old-row contents or changing frontend subscriptions does not fix the publication-level exposure. See [Supabase's DELETE/RLS limitation](https://supabase.com/docs/guides/realtime/postgres-changes).

`schema.sql` sets `publish = 'insert, update'` on `supabase_realtime`; DELETE and TRUNCATE are not published. It adds `profiles`, `ideas`, and `idea_events` explicitly. The action setting applies to the **whole publication**, not individual tables. See [PostgreSQL publication options](https://www.postgresql.org/docs/current/sql-createpublication.html).

Before running the schema, inspect the existing configuration as the trusted administrator:

```sql
-- No row is fine on a new project: schema.sql will create the publication.
select pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
from pg_publication
where pubname = 'supabase_realtime';

-- Inspect ALL memberships, not just the three application tables.
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by schemaname, tablename;

-- Schema-wide memberships also include future tables, even if empty today.
-- This schema and guard require PostgreSQL 15+.
select n.nspname as published_schema
from pg_publication_namespace pn
join pg_publication p on p.oid = pn.pnpubid
join pg_namespace n on n.oid = pn.pnnspid
where p.pubname = 'supabase_realtime';
```

The installation permits a missing/empty publication or explicit membership containing only this app's three `public` tables. It **raises an exception and aborts the entire schema transaction** if the publication includes unrelated tables (including matching names in another schema), `FOR ALL TABLES`, or any `FOR TABLES IN SCHEMA` membership. It does not remove tables, replace the publication, or silently change another application's settings. The administrator must also confirm that no unrelated consumer depends on the same app tables; catalog membership alone cannot establish every external consumer's requirements. Avoid concurrent administrative publication edits during deployment.

If the guard fails, stop deployment and review the shared usage with its owners. Do not remove unrelated tables, disable RLS, or blindly issue a global `ALTER PUBLICATION`. Agree on an isolated, supported Realtime configuration before continuing. Simply inventing a different publication name is not enough to configure the hosted Realtime service. This patch intentionally does not migrate unrelated applications.

After successful deployment, rerun the queries. Required results:

- `puballtables = false`, `pubinsert = true`, `pubupdate = true`, **`pubdelete = false`**, `pubtruncate = false`.
- Exactly `public.profiles`, `public.ideas`, and `public.idea_events` in the membership query.
- No schema-wide memberships.

Deletion synchronization works as follows:

1. Shibo calls `delete_idea`; existing role and revision checks still apply.
2. The unchanged audit trigger inserts an `idea_events` record with `event_type = 'deleted'` and the prior idea snapshot in the **same transaction** as the deletion.
3. The publication emits that audit **INSERT**, with no direct idea DELETE message.
4. Realtime applies the audit table's SELECT policy to INSERT delivery. Only active allowlisted members can read the snapshot.
5. The existing frontend's `idea_events` listener refetches the authoritative idea list; the deleted idea disappears in every receiving authorized session, and its history remains readable.

The frontend's existing `event: '*'` listeners remain unchanged: they receive only the INSERT/UPDATE operations allowed by the publication. Keep all RLS policies and grants enabled. Deactivation is an administrator UPDATE to `profiles`, never a direct deletion; active clients refresh their membership, while subsequent reads/RPCs are denied to the deactivated member. Already downloaded data cannot be recalled.

The connection indicator says **Connected** only after a successful subscription and a successful data refresh. **Reconnecting…** means live delivery or refresh is not healthy; foreground polling is a fallback, not proof that Realtime works. Complete the two-account event test below, then repeat the publication inspection after future administrative changes.

## 5. Run locally

From this existing checkout:

```sh
cd ~/Desktop/autoresearch-idea-tracker
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000/`. Use HTTP rather than double-clicking `index.html`. Python is only a local static preview server; it is not part of deployment. Once SQL and accounts are configured, this local frontend uses the **real shared Supabase database**. Use clearly labeled disposable verification ideas, not confidential data in source files.

The page's Supabase SDK is version-pinned to **2.118.0** with Subresource Integrity. Updating it requires updating both the CDN version and integrity hash, reviewing changes, and rerunning tests. The public key is intentionally visible. Never replace it with a secret, `service_role`, administrator token, or database password.

## 6. Manual acceptance and security tests

Run these against the configured project before calling the hosted integration verified. Separate ordinary browser windows share Auth storage; use **separate browser profiles, different browsers, or an ordinary and private session** to log in as different people. Two tabs of the same profile are not independent member sessions.

### Authentication and permissions

- Sign in as each of the four members. Check the name, role, restored session after reload/browser restart, and logout. Logout is for the current browser session; it does not sign the person out on every computer.
- Signed-out visitors must see only login. A valid Auth user with no active profile must see Access has not been granted and no data. To test that case without adding a fifth public account, temporarily deactivate one existing researcher's profile, test, then restore it as administrator.
- Shibo can publish/edit/delete. Researchers cannot. Metadata editing never changes ownership, status, or results.
- With a researcher signed in, use DevTools to call APIs directly, independent of hidden UI buttons. The existing `state.client` variable is available in the page's console. **Do not print/copy session tokens.**

```js
// All of these must return an authorization error.
await state.client.from('profiles').update({role:'pi'}).eq('id',state.userId);
await state.client.rpc('create_idea', {
  p_title:'Permission test', p_description:'',
  p_week_start:'2026-10-12', p_priority:'low'
});
// Choose only a deliberately created verification idea from the dashboard.
const testIdea = state.ideas.find(i => i.title === 'Manual verification idea');
await state.client.from('ideas').update({assigned_to:state.userId}).eq('id',testIdea.id);
await state.client.from('idea_events').insert({
  idea_id:testIdea.id, idea_number:testIdea.idea_number, event_type:'claimed'
});
await state.client.rpc('delete_idea', {
  p_idea_id:testIdea.id, p_expected_revision:testIdea.revision
});
```

A non-assignee researcher calling `release_idea` or `complete_idea` must get Permission denied. Completing an available idea must fail; changing a completed result via another completion must fail. A stale `p_expected_revision` must fail even when the same person owns a later testing cycle. Do not test authorization only in SQL Editor as `postgres`, because that role bypasses RLS.

### Invitation onboarding (live Supabase and real email required)

Use a real address you control first, ideally your own, before inviting the other members.

1. Invite the address from the Dashboard and open the email in a **private window**. Confirm the link points to `https://anthonyzhangyan.github.io/autoresearch-idea-tracker/`. After clicking, the address bar must show that URL with no `token_hash`, `access_token`, or `code` left in it.
2. Confirm **Set Your Password** appears, with the invited email shown read-only. Check that mismatched or too-short passwords are rejected without a request, and that Show passwords works.
3. Create the password. Confirm "Your password has been created successfully." and either **Enter the tracker** (profile active) or the "not yet authorized" message (no profile).
4. Reload: onboarding must not reappear. Log out, then sign in with the email and new password.
5. Click the same invitation link again. It must show "This invitation link has expired or is invalid…" and must not open the password form.
6. Let a test invitation expire (or use a link after changing the OTP expiry) and confirm the expired message.
7. With Shibo signed in, open another member's invitation link in the same browser profile. The page must show the invited account and say Shibo was signed out. Shibo's workspace must not appear.
8. In DevTools → Application, confirm no password appears in Local Storage or Session Storage. The SDK's own `sb-…-auth-token` entry holds the session, not the password.

### Workflow, history, and persistence

1. Shibo publishes **Manual verification idea**, using a Monday. Confirm Available, Unassigned, and no result.
2. Yan claims it; confirm Testing and Yan. Another researcher cannot release or complete it.
3. Yan releases it; repeat with PI release of someone else's Testing idea.
4. Claim and complete with **Fail**, notes, and an experiment URL. Confirm it stays visible as Completed + Fail after reload and login from another browser.
5. Repeat with **Success**. Verify result, assignee, completion time, notes, and link.
6. Shibo reopens a completed idea. Confirm it becomes Available; open History and verify the previous result, notes, link, assignee, and completion date remain.
7. Test editing and a deletion confirmation. Verify deleted history in global Activity history. Publish again; its idea number must not reuse the deleted number.
8. Exercise all filters, search, sort, expand/collapse, empty results, desktop/mobile layout, Tab/Enter/Escape, and canceling dialogs.

### Markdown acceptance tests (after approved schema deployment)

1. As Shibo, import one UTF-8 `.md` file with two H1 headings, a table, code block, inline math and multiline display math. Confirm the first H1 becomes an editable suggestion and all sections remain in one preview. Confirm no idea appears in another session before clicking Publish idea.
2. Change the suggested title, publish once, and verify exactly one new idea appears for a second authorized member. Expand it and check the table, code and formulas. Reload and compare `ideas.description` with the original source using an authenticated client; it must be unchanged if the source was not edited.
3. Import a file without H1; confirm filename fallback. Check a fenced `# Heading` is ignored. Cancel and confirm no database change.
4. Edit a published idea's Markdown and confirm the live preview and other session update. Check History retains the prior complete source. Researchers must still be unable to edit via RPC.
5. Publish a document longer than 20,000 characters but below 100 KiB. Try a file/manual draft above 100 KiB and invalid UTF-8; expect rejection with no truncation or unintended publication.
6. Check raw `<script>`/event-handler HTML, `javascript:` links, and KaTeX HTML/URL commands remain inert. Code containing `$...$` stays literal. Repeat editor/card checks on a narrow screen.

### Real concurrent claims and live synchronization

1. Open independent member sessions. Have Shibo publish a disposable idea and verify it appears automatically for the others **without Refresh**.
2. In Yan and Junqi's sessions, open the same Available idea. Submit Claim at nearly the same time. To submit exact API requests from both consoles, use:

   ```js
   await state.client.rpc('claim_idea', {p_idea_id:'<SAME_VERIFICATION_IDEA_UUID>'});
   ```

   Exactly one succeeds. The losing UI gets a conflict notification when using the Claim button, and both refetch to show the same owner. No intermediate ownership choice is sent from the frontend.
3. Have the winner complete testing. Confirm Yifan sees the final result without refreshing.
4. Temporarily take one browser offline with its network controls. Confirm Offline, stale-data messaging, and disabled mutations. Make a change from another session, reconnect the first session, and verify it catches up.
5. Block WebSocket delivery while keeping HTTP available. Confirm Reconnecting… and eventual polling updates. Restore WebSockets and verify Connected.
6. Reload/restart and verify persistence. Keep two edit dialogs open; save one, then submit the old one and confirm it reports a stale revision instead of overwriting newer data.

### Verify audit-driven deletion and denied subscriptions (live Supabase required)

Use two **independent browser profiles/accounts**, for example Shibo and Yan. Do not infer event delivery from a change appearing after the 30-second poll. In each signed-in page's DevTools, install this temporary diagnostic listener. It keeps counts only and does not log research contents or credentials:

```js
const realtimeProbe = { subscribed: false, counts: {} };
const probeChannel = state.client.channel('publication-verification');
for (const table of ['profiles', 'ideas', 'idea_events']) {
  probeChannel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
    const key = `${table}:${payload.eventType}`;
    realtimeProbe.counts[key] = (realtimeProbe.counts[key] || 0) + 1;
    if (table === 'idea_events' && payload.eventType === 'INSERT' && payload.new.event_type === 'deleted') {
      realtimeProbe.counts.deletionAudit = (realtimeProbe.counts.deletionAudit || 0) + 1;
    }
  });
}
probeChannel.subscribe(status => { realtimeProbe.subscribed = status === 'SUBSCRIBED'; });
```

1. Wait until both `realtimeProbe.subscribed` values are true. Shibo publishes a clearly labeled disposable verification idea; Yan must receive an `ideas:INSERT`. Edit it as Shibo; Yan must receive an `ideas:UPDATE`.
2. Delete it as Shibo. In Yan's session, verify `deletionAudit` increases, no `ideas:DELETE` (or any `:DELETE`) count exists, and the card disappears automatically. Check that global History retains the deleted snapshot. Verify both sessions agree without manual Refresh.
3. Repeat after a disconnect/reconnect to ensure missed events are reconciled.
4. For the negative test, use an **already-existing** Auth account with no profile if available. The access-denied page still has `state.client`, so attach the diagnostic subscription directly rather than relying on hidden UI controls. No new accounts are needed or created by this patch. If no such account is available, record this hosted non-member case as untested; the local database suite covers it.
5. Separately, after explicit authorization for that live test, temporarily set an existing researcher's profile `active = false` as administrator. Attach a fresh probe with that still-authenticated account and reset its counters. Also observe an already-open subscription through deactivation. After deactivation has committed, have Shibo create, edit, and delete another disposable idea. No new restricted payloads should arrive for the deactivated account; `.from('ideas').select('*')` and `.from('idea_events').select('*')` must return no rows. A probe can be rejected or remain subscribed without data—neither is permission to receive data. Events delivered before revocation are not retroactively removed.
6. Confirm an active positive-control observer receives those same INSERT/UPDATE/audit events; otherwise a silent unauthorized subscription might simply reflect a broken connection. No direct DELETE messages may arrive in any probe.
7. Restore the authorized member's `active` flag when finished, sign back in as necessary, and clean up each diagnostic channel with `await state.client.removeChannel(probeChannel)`.

Do not claim the hosted exposure is verified closed until these tests pass. The local tests below exercise the publication's actual PostgreSQL output, RLS reads, and simulated client notification handling; they do not run Supabase's WebSocket authorization service.

## 7. Automated local tests

These tests require a development Node installation (Node 22+ recommended) and download development dependencies outside the repository. There is no frontend package manifest or build step. The database suite starts a **temporary loopback-only PostgreSQL cluster**, creates synthetic Auth roles/UUIDs, applies the actual schema, then stops/removes the cluster. It never connects to hosted Supabase. Use a free port, and run as a regular OS user, not root.

```sh
TRACKER_TEST_DEPS="$(mktemp -d /tmp/autoresearch-tests.XXXXXX)"
export TRACKER_TEST_DEPS
npm install --prefix "$TRACKER_TEST_DEPS" --no-audit --no-fund \
  embedded-postgres@18.4.0-beta.17 pg@8.16.3 jsdom@27.1.0 \
  markdown-it@15.0.3 dompurify@3.4.17 katex@0.19.0 markdown-it-texmath@1.0.0 \
  @supabase/supabase-js@2.118.0
node tests/database.test.mjs
node tests/frontend.test.mjs
node tests/invitation.test.mjs
```

`.gitattributes` keeps HTML, Markdown, JavaScript, SQL, and Git configuration files LF in every checkout, including Windows with `core.autocrlf=true`. The database test's schema parsing also accepts CRLF, so an older CRLF checkout still runs.

`invitation.test.mjs` runs each scenario as a fresh page load against a simulated Supabase Auth client. It covers:

- normal and invalid login, restored sessions, logout
- `token_hash`, fragment-token, and PKCE-code callbacks under the `/autoresearch-idea-tracker/` subpath, with URL cleanup
- the verifying state, before the login page could appear
- password validation, show/hide, a single `updateUser({password})` call, and disabled double submission
- no password in storage, logs, or URLs
- expired, used, unsupported, and malformed links
- network retry
- account switching
- resuming after a reload, without reappearing after completion
- unauthorized users
- Supabase password errors

It then loads the **actual pinned SDK bundle**, asserting its SHA-384 equals the page's `integrity` attribute, and answers its `fetch` calls locally. This checks the real request shapes: `/verify` with `token_hash`/`type=invite`, `PUT /user` carrying the password only to Auth with the invitation bearer token, a single `/token` code exchange, and the mapping of `otp_expired`, `weak_password`, and network errors. No request leaves the process. Hosted email delivery, Supabase's `/verify` redirect, and Dashboard settings are **not** exercised.

If port 55439 is occupied, set `TRACKER_TEST_PORT` to another free port. You can delete the temporary dependency directory afterwards. Synthetic fixtures exist only in the test suite; they are never seeded into the production application.

Validation performed on **October 16, 2026**:

- **135 PostgreSQL checks passed**, including real row-lock contention between two connections, exactly one successful claim, all seven RPC paths, anonymous/unlisted/revoked-user access, researcher permission boundaries, direct-write denials, state and Monday constraints, stale revision protection, historical result retention, nonreused identities, schema reruns, grants, and publication membership. Added checks execute the actual plain SQL, upgrade an existing exclusive publication, reject shared/all-table/empty-schema-wide publications without collateral changes, inspect actual `pgoutput` logical replication messages (INSERT/UPDATE and deletion audit INSERT present; DELETE absent), and verify active versus non-member/deactivated access to audit snapshots. Markdown checks cover migration from the original constraint without data loss, complete source preservation, descriptions beyond the old limit, UTF-8 byte boundaries, PI-only edits, revision conflicts, audit snapshots, and rejection without overwriting existing content.
- **227 JavaScript syntax/DOM integration checks passed** using a simulated transport: actual-record counters, filters, forms/RPC arguments, conflict handling, safe rendering, history, session isolation, duplicate refresh coalescing, offline/reconnection behavior, and stale-data protection. Two independent receiving DOM instances now also refresh on simulated INSERT/UPDATE and remove a remotely deleted idea from the audit INSERT alone, with polling disabled and no direct DELETE notification. The Markdown tests execute the actual pinned browser parser, sanitizer, math engine and math plugin: import/title extraction, code fences, tables, formulas, malicious markup/URLs, sanitizer failure, byte/UTF-8 validation, one explicit publish per file, editable previews, old-schema errors, and source preservation. The math regressions additionally cover closing-line prose, escaped dollar signs/backslashes and other LaTeX escapes, adjacent/multiple equations, multiline display math (including blank lines), lists/quotes, unclosed delimiters, literal code, source preservation through import/publication, and sanitization of trailing malicious markup. These do not establish live network or hosted Realtime behavior.
- **147 invitation/login checks passed** (`tests/invitation.test.mjs`, added with invitation onboarding on October 16, 2026), including the actual pinned SDK 2.118.0 with local fetch responses. The 135 PostgreSQL and 227 frontend checks above were re-run after the invitation change and still pass; the schema is unchanged. The Set Your Password, invalid-link, and not-authorized screens were rendered as static snapshots in headless Chrome at desktop width and match the existing dark theme. Phone widths were not reliably verified, because headless window sizing also cropped the unchanged login page. No hosted invitation email, Supabase `/verify` redirect, or live Auth request has been tested.
- Earlier implementation validation: Chrome visual checks covered the real login page and clearly labeled synthetic dashboard renderings at desktop and mobile widths, including 320px/390px. The production login loaded the pinned CDN SDK without console warnings/errors.
- Earlier Markdown implementation validation (not repeated for this parser-only fix): Chrome visual checks of the clearly labeled local test fixture confirmed the desktop side-by-side editor and stacked 390px mobile layout, tables, code blocks, inline math, and multiline display math, with no horizontal page/dialog overflow. The actual local login page and Markdown fixture had no console warnings/errors. All six pinned CDN script/stylesheet integrity hashes matched the downloaded resources. The visual fixture uses synthetic data and does not establish a hosted login or publication result.
- Current parser-fix pass: read-only Auth settings confirm **email enabled**, **anonymous sign-in disabled**, and **public signup disabled**. Anonymous Data API requests (`select=id&limit=0`) return **401 / 42501, permission denied** for `profiles`, `ideas`, and `idea_events`; no rows were retrieved. These supersede the earlier pre-installation missing-table/signup observations. The project owner confirms initial schema installation and the pending account/description-migration statuses in the deployment table above. No hosted mutations were performed.

**Still required, after approval:** verify the live publication and its consumers; apply the **description-limit migration**; deploy the frontend; configure Site URL/Redirect URLs/invitation template/SMTP (section 2); invite the four members, map their UUIDs and assign Shibo's PI role; run the live invitation checks (section 6); verify authenticated Data API/RPC requests, Markdown round trips, atomic claims, audit-driven deletion delivery, denial of restricted WebSocket data to non-members/deactivated members, reconnection/session persistence, and the GitHub Pages URL. Initial schema installation and disabling public signup are already complete. Local PostgreSQL validates database logic and the publication stream, not Supabase's hosted gateway/Auth/Realtime services. This parser-fix pass made only the read-only hosted checks documented above, created no accounts, modified no production data, and neither deployed nor pushed changes. No SQL changes were necessary for the parser fixes; the existing SQL remains plain SQL with no escaping transformations.

## 8. Deploy to GitHub Pages — only after approval

The repository is already cloned. Do not create or clone another repository. The deployment below makes frontend source public; research data remains behind Supabase Auth/RLS.

1. Review changes and confirm no credentials or private research records are staged. The `reference/` file is already tracked from an earlier commit. The app does not use it, and the explicit staging command below leaves it out.
2. After explicit approval to publish, run:

   ```sh
   git status --short
   git diff --check
   git add .gitattributes index.html README.md .gitignore supabase/schema.sql tests/database.test.mjs tests/frontend.test.mjs tests/invitation.test.mjs
   git diff --cached
   git commit -m "Implement collaborative AutoResearch idea tracker"
   git push origin main
   ```

   These commands assume the intended deployment branch is `main`; inspect `git branch --show-current` first. If working on another branch, merge through your normal reviewed process instead of renaming/resetting branches blindly.
3. On GitHub, open `AnthonyZhangYan/autoresearch-idea-tracker` → **Settings → Pages**.
4. Under Build and deployment choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then Save.
5. Wait for the Pages deployment workflow to succeed, then open:
   **https://anthonyzhangyan.github.io/autoresearch-idea-tracker/**
6. Confirm the Supabase Site URL/Redirect URLs match section 2. The app has no domain-root asset paths or route assumptions, so the repository subpath works.
7. Verify login, a disposable create/claim/complete cycle, another member's automatic updates, refresh persistence, and logout at the deployed URL. An empty/new account should not reveal lab data.

Future updates follow the same review/commit/push process. Changes to `index.html` need only a Pages redeploy. Database changes require an explicit reviewed SQL migration through SQL Editor before relying on the new frontend. Maintain compatibility during rollout. Do not assume pushing the SQL file runs it on Supabase. See [GitHub's branch publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Database API reference

Every mutation is a PostgreSQL transaction. Every privileged function uses an empty `search_path`, qualified objects, the authenticated caller, and the administrator-managed profile. No RPC accepts an arbitrary assignee or role. The audit trigger writes full snapshots in the same transaction, so a rolled-back change creates no historical event.

| RPC | Arguments | Who / state |
| --- | --- | --- |
| `create_idea` | `p_title`, `p_description`, `p_week_start`, `p_priority` | PI; starts Available |
| `update_idea` | `p_idea_id`, `p_expected_revision`, metadata fields above | PI; metadata only |
| `delete_idea` | `p_idea_id`, `p_expected_revision` | PI; history retained |
| `claim_idea` | `p_idea_id` | Active member; Available only |
| `release_idea` | `p_idea_id`, `p_expected_revision` | Assignee or PI; Testing only |
| `complete_idea` | `p_idea_id`, `p_expected_revision`, `p_result`, optional `p_notes`, `p_experiment_url` | Assignee or PI; Testing only |
| `reopen_idea` | `p_idea_id`, `p_expected_revision` | PI; Completed → Available |

All mutations except delete return the authoritative idea row. Edit/release/complete/reopen/delete lock the row and reject mismatched revisions. Claim uses a single conditional update; PostgreSQL rechecks its Available/Unassigned predicate after a competing lock is released. Notes/links belong to completed results, not unfinished drafts. Week dates are stored as Monday `DATE`s; timestamps are `TIMESTAMPTZ` and displayed in the viewer's local timezone.

Titles are limited to 200 characters; Markdown descriptions to 102,400 UTF-8 bytes; testing notes to 20,000 characters; URLs to 2,048 characters. The database validates HTTP(S) experiment URLs, and the frontend also parses each link before rendering it. Markdown passes through the parser and DOMPurify as a sanitized fragment; other user text uses `textContent`. No unsanitized user-provided HTML is inserted.

## Troubleshooting and maintenance

| Symptom | What to check |
| --- | --- |
| Markdown library/preview unavailable | Check CDN access, pinned script versions/integrity, and browser console. Source falls back to safe text; never bypass sanitization |
| Markdown exceeds database description limit | Apply the reviewed description constraint upgrade after approval; preserve the draft and retry. Check UTF-8 bytes, not just characters |
| Import rejected | Check one `.md` file, UTF-8 encoding, accepted MIME type, no null characters, and at most 100 KiB; the previous draft is retained |
| Sign-in library could not load | Internet/CDN access, the pinned SDK URL and matching integrity hash, browser console, stale cached HTML |
| Invalid credentials / unconfirmed email | Correct Auth project, exact member email/password, account confirmation; never use the database password |
| Access has not been granted | Auth UUID matches the administrator-created profile; `active = true`; no reliance on editable name/email metadata |
| Invitation email never arrives | Custom SMTP configured (the built-in service only reaches organization team members and is rate-limited); spam folder; Auth logs in the Dashboard |
| Invitation link opens `localhost` or the wrong site | Site URL/Redirect URLs (section 2 A–B) were wrong when the email was sent. Fix them, then send a **new** invitation; old emails keep their old link |
| "This invitation link has expired or is invalid" on first click | Link expired, was already used, or was pre-opened by a mail scanner with the default template. Switch to the `token_hash` template (section 2 C) and re-invite |
| "Your account has been created, but access … has not yet been authorized" | Insert the member's profile (section 3). The member then signs in normally; no new invitation is needed |
| Password rejected after submitting | Supabase Auth's configured password requirements; the message shown is Supabase's own rule |
| Database setup incomplete / PGRST205 / missing RPC | Run the entire SQL file, expose `public` in Data API, and reload PostgREST schema cache |
| Permission denied for table/function | Check explicit SELECT/EXECUTE grants and active profile; do not grant blanket writes or turn off RLS |
| Refusing to change shared supabase_realtime publication | Deployment was rolled back; the previous configuration remains. Inspect all table/schema memberships and external consumers; resolve shared usage before deploying, without bypassing the guard |
| Ideas load but Reconnecting… persists | Realtime publication membership, SELECT RLS, WebSocket reachability, project availability, browser network errors |
| Stale or missing updates | Use Refresh; bring the tab to foreground; restore connection; inspect publication/permissions. Polling updates alone do not prove Realtime works |
| Idea changed / already claimed | Review authoritative state. Close and reopen stale dialogs. Do not force ownership changes through table writes |
| Submission times out | Outcome may be unknown: refresh/check history before retrying, especially publication. Mutations are never automatically retried |
| Wrong week date | Choose a Monday. Week groups use date-only values rather than UTC conversion |
| Cannot delete an Auth user | Profiles/history intentionally retain references; deactivate and administratively revoke access instead |
| Pages 404 | Correct repository, branch `main`, root folder, successful workflow, and exact repository URL with trailing slash |
| Project unavailable on Free | Check the Supabase Dashboard for project status/pausing and current resource usage; resume there if needed |

The architecture uses the existing Free-plan project and is sized for a four-member lab; no paid feature is required. Monitor actual database, Auth, and Realtime usage in the Dashboard rather than assuming quotas or uptime guarantees. No background jobs or keep-alive services are added.

Database administrators remain trusted: they can override data and policies in SQL Editor. Use the RPC workflow for routine changes; take appropriate private backups before migrations. A public GitHub repository is not a backup location for confidential database exports. The source reference and automated fixtures contain no real research results.

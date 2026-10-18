# AutoResearch Idea Tracker

A private, collaborative research workspace for **PML4SC Lab** (Shibo, Yan, Junqi and Yifan). Any member can publish a research idea, written in Markdown with LaTeX math. Several members can test the same idea, and each records their **own** Success or Fail result. Every idea has a permanent discussion thread. Results, comments and every change remain in the activity history.

**Status — October 18, 2026 (V2, collaborative ideas):** V2 is implemented and tested **locally only**. The production database still runs the V1 schema, and GitHub Pages still serves V1.

| Component | Current status |
| --- | --- |
| V2 database schema | **Local only.** The V2 `supabase/schema.sql` (which also performs the one-transaction V1 upgrade) has not been run in production |
| Production business data | V1 test data, including IDEA-001. A **verified backup is mandatory** before the upgrade, which moves the data unchanged into the private `tracker_v1_archive` schema rather than deleting it (section 1B) |
| Member accounts and profiles | Reported by the project owner to exist for all four members. The V1→V2 replacement keeps `auth.users` and `public.profiles` untouched |
| Invitation onboarding | Implemented in the frontend; live invitation acceptance is still untested (section 2) |
| GitHub Pages | **V2 not deployed.** Nothing has been pushed or deployed |
| Live integration tests | **Not completed** for V2: multi-member Realtime and hosted RLS still need verification after deployment (section 6) |

## Architecture and files

```text
GitHub Pages: index.html (HTML + CSS + vanilla JavaScript)
                      │
         Supabase JS 2.118.0, pinned CDN + integrity hash
                      │
       Existing Supabase project: kgfybebpxpdkiouofyow
           ├── Auth: Dashboard invitations, then email/password
           ├── PostgreSQL: profiles, ideas, idea_participants,
           │               idea_comments, idea_events
           ├── RLS: active allowlisted members can read
           ├── RPCs: authorized, transactional mutations
           └── Realtime: refetch on idea_events inserts
```

| File | Purpose |
| --- | --- |
| `index.html` | Complete frontend; public Supabase URL and publishable key; no build step |
| `supabase/schema.sql` | V2 schema: tables, constraints, triggers, policies, RPCs, grants, Realtime publication. Fresh install, safe to rerun; also upgrades a V1 database in one transaction after a verified backup |
| `supabase/export_v1_backup.sql` | Read-only export of all V1 ideas, history and profiles, with an integrity fingerprint |
| `tools/verify_v1_backup.mjs` | Offline verification of a saved backup file against its fingerprint (Node, no dependencies) |
| `supabase/drop_v1_archive.sql` | Optional, much later: removes the archived V1 tables after explicit confirmation |
| `README.md` | Setup, deployment, maintenance, and verification |
| `.gitignore` | Excludes credentials, local configuration, dependencies, and test outputs |
| `.gitattributes` | Enforces LF line endings for HTML, Markdown, JavaScript, SQL, and Git configuration files |
| `tests/database.test.mjs` | Isolated PostgreSQL tests: permissions, concurrency, independent results, comments, audit, publication stream, and the V1→V2 replacement |
| `tests/fixtures/schema_v1.sql` | Frozen V1 schema, used only to test the replacement script |
| `tests/frontend.test.mjs` | Syntax and DOM integration tests using a simulated transport |
| `tests/invitation.test.mjs` | Invitation callback, password setup, login/logout, and allowlist tests with a simulated Auth client and the actual pinned SDK answered by local fetch responses |
| `reference/` | Existing user-supplied LeetCode reference, left unchanged |

No production Node server, framework, package installation, or build system is required. Node is used only for optional development tests. All task data comes from Supabase; the frontend includes no seeded ideas or fallback database. The SDK persists **Auth sessions** in browser storage. Idea data and permissions are never persisted there; filters and disclosure preferences are kept in memory.

## Implemented workflow

- Individual login/logout, restored sessions, explicit allowlist lookup, PI-aware controls.
- Invitation onboarding: a member opens the Supabase invitation email, lands on **Set Your Password**, chooses their own password through `supabase.auth.updateUser`, and then enters the tracker only if their profile is active. The administrator never sees or assigns member passwords. See section 2.
- **Ideas:** any active member publishes ideas (Markdown import/editing with live preview). The idea's creator and the PI can edit it; only the PI can delete it. Database-generated `IDEA-001` identifiers are never reused. Sequence gaps are normal after rolled-back transactions or deletion.
- **Participation:** any member can **Join** an idea; several members can test the same idea at once. Each participant has their own row and status (`testing`, `completed`, or `withdrawn`). They can **Leave** while testing and rejoin later.
- **Independent results:** **Submit my result** records the caller's own Success/Fail, notes and HTTP(S) experiment URL. The database function has no member argument, so no one, including the PI, can write a result into another member's row. A submitted result is final for that member. The PI can **Reopen result** for one member, which returns only that member to Testing; the previous result stays in history.
- **Discussion:** every idea has a permanent comment thread with Markdown and LaTeX, plus a live preview while writing. Comments keep their author, server timestamp and exact original text, and cannot be edited. The PI can remove a comment: it is hidden from the thread, while the row and its activity-history record keep the original text. A retried post after a lost network response cannot create a duplicate.
- **Activity history:** read-only, with before/after snapshots of idea edits, joins, results, reopened results, comments and removals. Deleting an idea records one snapshot containing every participant result and comment. The global Activity history includes deleted ideas.
- Six live counters, plus a progress bar for the share of ideas with at least one result. Ideas appear as expandable cards in Monday-based weekly groups, listing each participant's status and result.
- Search by number/title/description; filters for week, status (open / in progress / has results), participant, result (any success / any fail / none) and priority; newest/oldest/number sorting within weekly groups.
- Realtime change subscriptions, burst coalescing, reconnection with backoff, refresh after subscription, foreground/focus refresh, and a 30-second foreground reconciliation poll. Offline/stale indicators and disabled mutations when data cannot be refreshed.
- Confirmation dialogs, in-flight button disabling, conflict notifications, safe text rendering, keyboard-friendly native controls, responsive dark theme.

## Markdown ideas and comments

Any member can create an idea manually or choose **Import one .md file** in the Publish idea dialog. A file always represents **one** idea. Multiple headings, sections, code blocks, or horizontal rules are never split into separate ideas. There is no bulk import. Comments use the same Markdown, LaTeX and sanitization pipeline, with a 20 KiB limit per comment.

1. Open **Publish idea**, then choose one local UTF-8 `.md` file, at most **100 KiB (102,400 bytes)**. A file stays on the computer until its text is submitted with the form; there is no file upload endpoint or Supabase Storage bucket.
2. The first Markdown H1 supplies the suggested title. Both `# Title` and Setext H1 (`Title` followed by `=====`) work; heading-like lines in code blocks are ignored. If no H1 exists, the filename without `.md` is used. A suggestion over 200 characters is shortened with a notice, while the full source stays unchanged.
3. Edit the suggested title, Markdown, Monday date, or priority as needed. The source editor and **Live preview** appear side by side on desktop and stack on narrow screens. Preview updates shortly after typing.
4. Review the preview, then explicitly click **Publish idea**. **Choosing a file never publishes or creates a database row.** Importing into a nonempty draft asks before replacing that draft. Cancel leaves the database unchanged.
5. Expand the published idea to read its formatted content. Its creator or the PI can use **Edit** to modify its Markdown or import a replacement into the edit draft, then explicitly **Save changes**. Revision checks prevent stale edits; history retains the complete previous source.

The complete source is stored as text in **`ideas.description`** (comments in **`idea_comments.body`**), including all headings, code, tables, and LaTeX. It is not converted into HTML in the database, trimmed, or truncated. An imported document's original UTF-8 BOM, whitespace, and line endings are preserved when publishing or editing only metadata. Once the source textarea is edited, the browser's normal LF newline representation is saved as the edited document. The original published source remains in activity history.

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

## 1. Install the V2 database

Use organization **PML4SC_Lab**, project **autoresearch-idea-tracker**, URL `https://kgfybebpxpdkiouofyow.supabase.co`. Do not create a new project. Run SQL in [this project's SQL Editor](https://supabase.com/dashboard/project/kgfybebpxpdkiouofyow/sql/new) as the trusted administrator (`postgres`). Always paste **the entire plain SQL file**, not a Markdown-escaped copy. Each file is one transaction: if it fails, nothing is changed. Roll back any still-open failed transaction, fix the cause, and rerun.

### 1A. Fresh project

Run `supabase/schema.sql` once (leave the fingerprint line empty), then follow sections 2–4. Rerunning it later is safe and keeps all data.

### 1B. Upgrade the existing V1 database (the production case)

V2 does not migrate V1 test ideas into the new tables. The upgrade **does not delete them either**: in the same transaction that installs V2, the V1 `ideas` and `idea_events` tables move unchanged into a private schema, `tracker_v1_archive`. The archive is not exposed through the Data API, is not readable by members, and is not in Realtime. **`auth.users`** (accounts, passwords, sessions) and **`public.profiles`** (the four members, their UUIDs, roles and active flags) are never modified.

A **verified backup is mandatory**. `schema.sql` refuses to upgrade until you paste the fingerprint of a backup taken from the current data.

**Step 1 — Export (read-only).** Members may keep working until step 3.

1. In the SQL Editor run the whole `supabase/export_v1_backup.sql`. It is a single `SELECT` and changes nothing.
2. The result row shows:
   - `fingerprint`
   - the row counts (expect 4 profiles)
   - `idea_001_title`, `idea_001_description_bytes` and `idea_001_description_md5`
   - `backup`: the complete backup document, containing every idea's full Markdown, authors and metadata, the complete activity history with full snapshots, and the profiles needed to resolve attribution.
3. Save the result to a **private file outside this repository**, for example `~/autoresearch-backups/v1-backup-2026-10-18.json`. Either copy the `backup` value into a file, or use the result grid's export (JSON or CSV). Write the `fingerprint` down separately. Never commit or upload the backup: it contains research text and member identities. `.gitignore` also excludes `*backup*.json`, `*backup*.csv` and `backups/`.

**Step 2 — Verify the saved file (offline).** In this checkout run:

```sh
node tools/verify_v1_backup.mjs ~/autoresearch-backups/v1-backup-2026-10-18.json <fingerprint>
```

The script reads the file only and never contacts Supabase. It checks that the file parses completely (a truncated copy fails) and that the counts match. It checks that every idea has its title and Markdown, and that every author, assignee and history actor resolves to an exported profile. It checks that history snapshots are valid JSON and that IDEA-001 is present. Finally, it recomputes the fingerprint from the file's contents and compares it with the fingerprint stored in the file and with the one you supplied, so a single changed character fails. On success it prints IDEA-001's title, author, byte length and MD5; compare them with the `idea_001_*` columns from step 1. **Do not continue unless it prints "Backup verified".** Keep a second copy of the file in another private location.

**Step 3 — Upgrade in one transaction.**

1. Ask members to close the tracker for a few minutes. Any change to V1 data after the export alters the fingerprint, and the upgrade will then refuse; export again if that happens.
2. Open `supabase/schema.sql` and paste the fingerprint into the line `select set_config('tracker.v1_backup_fingerprint', '', true);`, between the empty quotes.
3. Run the **whole** file. In **one transaction** it:
   1. locks the V1 tables and recomputes the fingerprint from the live data; if it differs from the pasted one, it stops and changes nothing;
   2. detaches the V1 tables from Realtime and drops the V1 RPCs, triggers and policies;
   3. moves the two V1 tables into `tracker_v1_archive` and checks that the archive's fingerprint still equals the backup's;
   4. installs V2 and checks again that the archive, the profiles and the Auth user list are unchanged;
   5. commits.

   Any error at any point (a wrong fingerprint, an unexpected dependent object, a failure while installing V2) rolls back **everything**. V1 stays exactly as it was and the V1 site keeps working. The tests inject a failure after the complete V2 install to prove this.
4. Run the verification queries below, then deploy the V2 frontend (section 8).

**Recovery plan**

| Situation | What happens / what to do |
| --- | --- |
| The export, verification or upgrade fails or refuses | Nothing changed. V1 and its data are intact; fix the cause and repeat from step 1 |
| The upgrade committed, V2 works | V1 data stays in `tracker_v1_archive` (identical to the backup, by fingerprint) plus your verified backup file. Keep both until V2 has been in use for a while |
| The upgrade committed, but V1 content must be consulted | Read it as the administrator: `select * from tracker_v1_archive.ideas order by idea_number;` (or use the backup file) |
| The upgrade committed, but V2 must be abandoned | Data is safe in the archive and the backup file. Restoring the V1 *service* (moving tables back, reinstalling V1 functions, redeploying the V1 page) is not scripted; it needs a separately reviewed procedure |
| Much later, the archive is no longer wanted | Optional: `supabase/drop_v1_archive.sql` with its confirmation line set to `'yes'`. It refuses unless V2 is installed and leaves profiles untouched |

Never run an older V1 `schema.sql` after the upgrade.

The schema grants `authenticated` only SELECT on the five tables and EXECUTE on the nine public RPCs. It revokes anonymous/PUBLIC execution, denies client table mutations, and grants the one private membership lookup needed by RLS. Other private functions are not executable by clients. In the project's **Data API settings**, keep the Data API enabled with `public` exposed; **do not expose `tracker_private`** and do not enable automatic exposure/grants for future tables. If the Data API schema cache has not refreshed, run `notify pgrst, 'reload schema';` and retry after a few seconds. See [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) and [database function security](https://supabase.com/docs/guides/database/functions).

```sql
-- Profiles kept: expect the same four rows (names, roles, UUIDs) as before.
select id, display_name, role, active from public.profiles order by display_name;

-- RLS must be true for all five rows.
select relname, relrowsecurity
from pg_class
where oid in ('public.profiles'::regclass, 'public.ideas'::regclass,
              'public.idea_participants'::regclass, 'public.idea_comments'::regclass,
              'public.idea_events'::regclass);

-- Expected: SELECT for authenticated only, no client write grants.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('profiles', 'ideas', 'idea_participants', 'idea_comments', 'idea_events')
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- authenticated_exec=true, anon_exec=false, security_definer=true for each RPC;
-- no V1 RPCs (claim_idea, release_idea, complete_idea, reopen_idea) remain.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       p.prosecdef as security_definer, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
 ('create_idea', 'update_idea', 'delete_idea', 'join_idea', 'leave_idea', 'submit_result',
  'reopen_result', 'add_comment', 'remove_comment',
  'claim_idea', 'release_idea', 'complete_idea', 'reopen_idea');
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

**Reported complete by the project owner (October 18, 2026):** the four members have Auth accounts and profiles. The V1→V2 replacement keeps them unchanged, so they need no re-invitation. The steps below remain the reference procedure for re-provisioning or for a fresh project.

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

To revoke a member's lab access while preserving their results, comments and history:

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

V2 adds `idea_participants` and `idea_comments` but does **not** publish them. Every join, leave, result, reopen, comment and comment removal inserts an `idea_events` row from a trigger in the **same transaction**, so the frontend's `idea_events` subscription is enough to refresh every member. The publication guard and its three-table list are unchanged from V1.

Deletion synchronization works as follows:

1. Shibo calls `delete_idea`; role and revision checks apply.
2. In the **same transaction**, `delete_idea` inserts an `idea_events` record with `event_type = 'deleted'`. Its snapshot contains the idea plus every participant result and comment. It then deletes the comments, participants and idea explicitly (no cascading foreign keys).
3. The publication emits that audit **INSERT**, with no direct idea DELETE message.
4. Realtime applies the audit table's SELECT policy to INSERT delivery. Only active allowlisted members can read the snapshot.
5. The frontend's `idea_events` listener refetches the authoritative ideas, participants and comment counts. The deleted idea disappears in every receiving authorized session, and its history remains readable.

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
- Every member can publish. A researcher can edit only ideas they created; Shibo can edit and delete any idea. Researchers have no Delete, Reopen result or comment Remove controls.
- With a researcher signed in, use DevTools to call APIs directly, independent of hidden UI buttons. The existing `state.client` variable is available in the page's console. **Do not print/copy session tokens.**

```js
// All of these must return an authorization or "not found" error.
await state.client.from('profiles').update({role:'pi'}).eq('id',state.userId);
// Choose only a deliberately created verification idea that another member published.
const testIdea = state.ideas.find(i => i.title === 'Manual verification idea');
const other = state.participants.find(p => p.idea_id === testIdea.id && p.member_id !== state.userId);
await state.client.from('idea_participants').update({result:'success'})
  .eq('idea_id', testIdea.id).eq('member_id', other.member_id);
await state.client.from('idea_comments').insert({idea_id:testIdea.id, author_id:state.userId,
  body:'forged', client_request_id:crypto.randomUUID()});
await state.client.from('idea_events').insert({idea_id:testIdea.id, idea_number:testIdea.idea_number, event_type:'joined'});
await state.client.rpc('update_idea', {p_idea_id:testIdea.id, p_expected_revision:testIdea.revision,
  p_title:'Hijack', p_description:'', p_week_start:testIdea.week_start, p_priority:'low'});
await state.client.rpc('delete_idea', {p_idea_id:testIdea.id, p_expected_revision:testIdea.revision});
await state.client.rpc('reopen_result', {p_idea_id:testIdea.id, p_member_id:other.member_id,
  p_expected_revision:other.revision});
await state.client.rpc('remove_comment', {p_comment_id:'<ANY_COMMENT_UUID>'});
```

`submit_result` has no member argument: it can only change the caller's own row. A completed result cannot be resubmitted or left; a stale `p_expected_revision` must fail. Do not test authorization only in SQL Editor as `postgres`, because that role bypasses RLS.

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

### Collaboration workflow, history, and persistence

1. Yan publishes **Manual verification idea**, using a Monday. Confirm it shows **Open**, "No participants", and Published by Yan. Yan can edit it; Junqi cannot.
2. Yan, Junqi and Yifan each **Join**. Confirm all three appear under Participants as Testing, in every session, without Refresh.
3. Yan submits **Success** with notes and an experiment URL; Junqi submits **Fail**. Confirm each row shows its own result. Yan's result does not change when Junqi submits, and Yifan stays Testing. Reload and check again from another browser.
4. Yifan **Leaves**, then **Rejoins**. Confirm the card and History show both steps.
5. Shibo **Reopens** Yan's result. Confirm only Yan returns to Testing, Junqi's Fail is unchanged, and History keeps Yan's earlier result, notes and link. Yan submits again.
6. Open **Discussion**. Every member posts a comment with Markdown and `$x^2$`. Confirm author, time and formatting appear for all members without Refresh. Shibo removes one comment; it shows "Comment removed by Shibo" and History keeps the original.
7. Shibo deletes the idea. Confirm global Activity history shows the deletion with "Preserved: … participants (… results) and … comments", and the card disappears everywhere. Publish again; its idea number must not reuse the deleted number.
8. Exercise all filters (status, participant, result, week, priority), search, sort, expand/collapse, empty results, desktop/mobile layout, Tab/Enter/Escape, and canceling dialogs.

### Markdown acceptance tests

1. As any member, import one UTF-8 `.md` file with two H1 headings, a table, code block, inline math and multiline display math. Confirm the first H1 becomes an editable suggestion and all sections remain in one preview. Confirm no idea appears in another session before clicking Publish idea.
2. Change the suggested title, publish once, and verify exactly one new idea appears for a second authorized member. Expand it and check the table, code and formulas. Reload and compare `ideas.description` with the original source using an authenticated client; it must be unchanged if the source was not edited.
3. Import a file without H1; confirm filename fallback. Check a fenced `# Heading` is ignored. Cancel and confirm no database change.
4. Edit a published idea's Markdown as its creator and confirm the live preview and other session update. Check History retains the prior complete source. Another researcher must be unable to edit it via RPC.
5. Publish a document longer than 20,000 characters but below 100 KiB. Try a file/manual draft above 100 KiB and invalid UTF-8; expect rejection with no truncation or unintended publication.
6. Check raw `<script>`/event-handler HTML, `javascript:` links, and KaTeX HTML/URL commands remain inert, both in idea descriptions and in comments. Code containing `$...$` stays literal. Repeat editor/card/discussion checks on a narrow screen.

### Concurrent participation and live synchronization

1. Open independent member sessions. Have one member publish a disposable idea and verify it appears automatically for the others **without Refresh**.
2. In Yan's and Junqi's sessions, press **Join** on the same idea at nearly the same time, or run this in both consoles:

   ```js
   await state.client.rpc('join_idea', {p_idea_id:'<SAME_VERIFICATION_IDEA_UUID>'});
   ```

   **Both** succeed and both rows appear in every session. Running it a second time in the same account returns "already participating".
3. Have both submit results at nearly the same time. Each keeps their own result; Yifan sees both without refreshing.
4. Post the same comment twice quickly (double-click), and confirm only one appears.
5. Temporarily take one browser offline with its network controls. Confirm Offline, stale-data messaging, and disabled mutations. Make a change from another session, reconnect the first session, and verify it catches up.
6. Block WebSocket delivery while keeping HTTP available. Confirm Reconnecting… and eventual polling updates. Restore WebSockets and verify Connected.
7. Reload/restart and verify persistence. Keep two edit dialogs open; save one, then submit the old one and confirm it reports a stale revision instead of overwriting newer data.

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

1. Wait until both `realtimeProbe.subscribed` values are true. Shibo publishes a clearly labeled disposable verification idea; Yan must receive an `ideas:INSERT`. Edit it as Shibo; Yan must receive an `ideas:UPDATE`. Have Yan join it and post a comment; Shibo must receive one `idea_events:INSERT` for each, with no events from `idea_participants` or `idea_comments`.
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

Validation performed on **October 18, 2026** (V2, local only):

- **199 PostgreSQL checks passed** on a temporary local cluster, using the actual `schema.sql`, export query, archive cleanup script and backup verifier:
  - fresh install and rerun; RLS, grants, `security definer` and fixed `search_path` on all nine RPCs; no V1 columns or RPCs; no cascading foreign keys and no `CASCADE` in any SQL file
  - member-only reads; anonymous, outsider and deactivated-member denial; direct table writes, sequences and private helpers denied
  - all members create; creator-or-PI edit; PI-only delete
  - **concurrency on separate connections:** a second member's join completes while the first join is still uncommitted; the same member in two sessions gets exactly one row; two members' result submissions run in parallel without blocking
  - independent results: no member argument on `submit_result`; cross-user direct update and researcher reopen denied; a completed result is final; PI reopen changes one member only and history keeps the old result; leave and rejoin
  - comments: stored verbatim (BOM, CRLF, Markdown, LaTeX); idempotent retry; whitespace-only and over-20 KiB rejected; PI-only removal keeps the original
  - deletion: waits for an in-flight comment, snapshots every participant result and comment (including removed ones), then removes rows explicitly; history stays readable; idea numbers are not reused
  - **parent-before-child lock order, both orders, on separate connections:** for each of `submit_result`, `leave_idea`, `reopen_result` and `remove_comment`, an uncommitted change makes `delete_idea` wait, and the deletion snapshot then contains the committed change. An uncommitted deletion makes the change wait, and the change then fails with "Idea not found". Meanwhile another participant's result, a comment and an idea edit proceed without waiting for an in-flight result. Removing either parent lock from the schema makes these tests fail; this was checked by temporarily breaking the schema
  - actual `pgoutput` logical replication: created/joined/result/comment/deleted all arrive as `idea_events` INSERTs; no DELETE messages; participant and comment rows are not published
  - V1 backup and upgrade in a separate database built from the frozen V1 schema, with IDEA-001 holding about 21 KB of Markdown (BOM, CRLF, table, math, emoji), a claimed and completed idea, and a deleted idea:
    - the export runs inside a READ ONLY transaction and contains the complete Markdown, authors, metadata and all six history events with attribution
    - the real verifier accepts the raw backup, a SQL Editor JSON result and a CSV result, and rejects a one-character change, a missing event, a truncated file and a wrong fingerprint
    - `schema.sql` refuses without a fingerprint and refuses when data changed after the backup
    - a failure injected after the full V2 install rolls everything back: V1 data identical by fingerprint, no archive, V1 RPCs and publication unchanged
    - the successful upgrade gives an archive identical to the backup; IDEA-001's Markdown, the profiles and the Auth users are unchanged; V1 functions and helpers are gone; the archive is unpublished and unreadable by members; existing members work on V2
    - a rerun is a no-op; archive removal requires confirmation and leaves profiles unchanged
- **285 JavaScript syntax/DOM integration checks passed** using a simulated transport:
  - participant-derived counters, filters and badges; per-participant status, result, notes and links
  - creator/PI controls; join, submit, leave and rejoin; PI reopen of one member's result
  - a second member's session submitting independently
  - discussion: Markdown and math rendering, live preview, validation, lost-response retry with the same request ID posting once, XSS inertness, PI removal, and the draft surviving Realtime refresh
  - history for every V2 event type
  - two receiving DOM instances refreshing on simulated `idea_events` INSERTs (remote join, result, comment and deletion) with polling disabled
  - all earlier Markdown, math, sanitizer, offline, stale and session-isolation checks
- **147 invitation/login checks passed** unchanged against the V2 page, including the actual pinned SDK 2.118.0 with local fetch responses.
- The V2 dashboard and discussion dialog were rendered as static snapshots in headless Chrome at desktop width and match the dark theme. Phone widths were not reliably verified (headless window sizing also crops the unchanged login page).

None of this exercises hosted Supabase (gateway, Auth, Realtime WebSocket authorization), email delivery, or GitHub Pages. No production data was read or changed.

**Still required, after approval:** export and verify the V1 backup, then run the one-transaction upgrade (section 1B); deploy the frontend (section 8); run the live checks in section 6, especially concurrent participation, independent results, discussion, audit-driven deletion delivery, and denial of restricted WebSocket data to non-members and deactivated members; configure and test the invitation flow (section 2) if any member still needs onboarding.

## 8. Replace V1 and deploy V2 — only after approval

Nothing below has been done. The database and frontend must change together: the V1 page cannot read the V2 database, and the V2 page cannot read the V1 database. Do them back-to-back in one short maintenance window.

1. **Commit locally.** Review the changes and confirm no credentials or private research records are staged. The `reference/` file is already tracked from an earlier commit; the app does not use it, and the explicit staging command leaves it out.

   ```sh
   git status --short
   git diff --check
   git add .gitattributes index.html README.md .gitignore supabase/schema.sql supabase/export_v1_backup.sql supabase/drop_v1_archive.sql \
     tools/verify_v1_backup.mjs \
     tests/database.test.mjs tests/frontend.test.mjs tests/invitation.test.mjs tests/fixtures/schema_v1.sql
   git diff --cached
   git commit -m "V2: collaborative ideas, independent results, and discussion"
   ```

2. **Tell the members** to close the tracker for a few minutes.
3. **Database**: follow section 1B: export, verify the backup offline, paste the fingerprint and run `schema.sql` once, then run the verification queries.
4. **Frontend**: `git push origin main`. GitHub Pages (Settings → Pages → Deploy from a branch, `main`, `/ (root)`) republishes automatically; wait for the Pages workflow to succeed.
5. **Open** https://anthonyzhangyan.github.io/autoresearch-idea-tracker/ with a hard reload (Ctrl+Shift+R / Cmd+Shift+R) so no cached V1 page remains. Ask each member to do the same.
6. **Smoke test** with two members: publish a disposable idea, both join, both submit different results, post comments, PI reopens one result, PI deletes the idea. Check that everything appears in both sessions without Refresh, and in History. Then run the remaining section 6 checks.

If step 3 fails, nothing was changed; fix the cause and rerun the failed file. If it succeeds but you must stop before step 4, the V1 page shows a "database setup" error until V2 is deployed; no member data is at risk.

Future updates follow the same review/commit/push process. Changes to `index.html` need only a Pages redeploy. Database changes require an explicit reviewed SQL change through SQL Editor before relying on the new frontend; pushing a SQL file does not run it on Supabase. See [GitHub's branch publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Database API reference

Every mutation is a PostgreSQL transaction through one of these RPCs. Every function uses an empty `search_path`, qualified objects, the authenticated caller (`auth.uid()`), and the administrator-managed profile. No RPC accepts a role, and only the PI-only `reopen_result` names another member. Audit triggers write full snapshots in the same transaction, so a rolled-back change creates no historical event.

| RPC | Arguments | Who / state |
| --- | --- | --- |
| `create_idea` | `p_title`, `p_description`, `p_week_start`, `p_priority` | Any active member; creator is the caller |
| `update_idea` | `p_idea_id`, `p_expected_revision`, metadata fields above | Creator or PI |
| `delete_idea` | `p_idea_id`, `p_expected_revision` | PI; snapshot of participants and comments kept in history |
| `join_idea` | `p_idea_id` | Any active member; new row, or rejoin after withdrawing |
| `leave_idea` | `p_idea_id`, `p_expected_revision` (participation) | Caller's own row; Testing → Withdrawn |
| `submit_result` | `p_idea_id`, `p_expected_revision` (participation), `p_result`, optional `p_notes`, `p_experiment_url` | Caller's own row only; Testing → Completed |
| `reopen_result` | `p_idea_id`, `p_member_id`, `p_expected_revision` (participation) | PI; that member's Completed → Testing |
| `add_comment` | `p_idea_id`, `p_body`, `p_client_request_id` | Any active member; the same request ID returns the original comment |
| `remove_comment` | `p_comment_id` | PI; hides the comment, keeps its text |

**Lock order is always parent before child.** Every participant or comment change first takes a `FOR KEY SHARE` lock on its idea, then locks only its own row. `delete_idea` takes `FOR UPDATE` on the idea, which conflicts with those locks: a deletion waits for in-flight changes and then snapshots them, and a change arriving during a deletion waits and then finds the idea gone. Idea edits take `FOR NO KEY UPDATE`, which does not conflict, so members, comments and edits never block each other. Week dates are stored as Monday `DATE`s; timestamps are `TIMESTAMPTZ` and displayed in the viewer's local timezone.

Titles are limited to 200 characters; Markdown descriptions to 102,400 UTF-8 bytes; comments to 20,480 UTF-8 bytes; testing notes to 20,000 characters; URLs to 2,048 characters. The database validates HTTP(S) experiment URLs, and the frontend also parses each link before rendering it. Markdown passes through the parser and DOMPurify as a sanitized fragment; other user text uses `textContent`. No unsanitized user-provided HTML is inserted.

## Troubleshooting and maintenance

| Symptom | What to check |
| --- | --- |
| Markdown library/preview unavailable | Check CDN access, pinned script versions/integrity, and browser console. Source falls back to safe text; never bypass sanitization |
| Markdown exceeds database description limit | Descriptions are limited to 100 KiB and comments to 20 KiB of UTF-8 bytes, not characters; the draft is kept |
| Import rejected | Check one `.md` file, UTF-8 encoding, accepted MIME type, no null characters, and at most 100 KiB; the previous draft is retained |
| Sign-in library could not load | Internet/CDN access, the pinned SDK URL and matching integrity hash, browser console, stale cached HTML |
| Invalid credentials / unconfirmed email | Correct Auth project, exact member email/password, account confirmation; never use the database password |
| Access has not been granted | Auth UUID matches the administrator-created profile; `active = true`; no reliance on editable name/email metadata |
| Invitation email never arrives | Custom SMTP configured (the built-in service only reaches organization team members and is rate-limited); spam folder; Auth logs in the Dashboard |
| Invitation link opens `localhost` or the wrong site | Site URL/Redirect URLs (section 2 A–B) were wrong when the email was sent. Fix them, then send a **new** invitation; old emails keep their old link |
| "This invitation link has expired or is invalid" on first click | Link expired, was already used, or was pre-opened by a mail scanner with the default template. Switch to the `token_hash` template (section 2 C) and re-invite |
| "Your account has been created, but access … has not yet been authorized" | Insert the member's profile (section 3). The member then signs in normally; no new invitation is needed |
| Password rejected after submitting | Supabase Auth's configured password requirements; the message shown is Supabase's own rule |
| Database setup incomplete / PGRST205 / missing RPC | The database is still V1 or the schema cache is stale. Complete section 1B, expose `public` in Data API, and reload the PostgREST schema cache. A V1 page against a V2 database shows the same error: hard-reload |
| "a verified backup is required before upgrading" | Expected on the V1 project: export and verify a backup, then paste its fingerprint into `schema.sql` (section 1B) |
| "V1 data does not match the backup fingerprint" | V1 data changed after the export, or a different fingerprint was pasted. Nothing changed; export and verify a new backup |
| `verify_v1_backup.mjs` says "BACKUP NOT VERIFIED" | The saved file is truncated, altered, from a different export, or the fingerprint was mistyped. Save the export again; do not upgrade until it verifies |
| "Archive deletion not confirmed" | `drop_v1_archive.sql` is optional; change its confirmation line only when you no longer need the archive |
| Upgrade fails with "cannot drop … because other objects depend on it" | Something outside this app depends on a V1 object. The whole transaction rolled back and V1 is intact; inspect that object instead of adding CASCADE |
| Permission denied for table/function | Check explicit SELECT/EXECUTE grants and active profile; do not grant blanket writes or turn off RLS |
| Refusing to change shared supabase_realtime publication | Deployment was rolled back; the previous configuration remains. Inspect all table/schema memberships and external consumers; resolve shared usage before deploying, without bypassing the guard |
| Ideas load but Reconnecting… persists | Realtime publication membership, SELECT RLS, WebSocket reachability, project availability, browser network errors |
| Stale or missing updates | Use Refresh; bring the tab to foreground; restore connection; inspect publication/permissions. Polling updates alone do not prove Realtime works |
| Idea changed / participation changed | Someone changed it while your dialog was open. Close it, review the latest state, and retry. Do not force changes through table writes |
| Already participating | You already joined (possibly from another tab); the card shows your current row |
| Submission times out | Outcome may be unknown: refresh/check history before retrying, especially publication. Mutations are never automatically retried. Retrying an unchanged comment cannot duplicate it |
| Wrong week date | Choose a Monday. Week groups use date-only values rather than UTC conversion |
| Cannot delete an Auth user | Profiles/history intentionally retain references; deactivate and administratively revoke access instead |
| Pages 404 | Correct repository, branch `main`, root folder, successful workflow, and exact repository URL with trailing slash |
| Project unavailable on Free | Check the Supabase Dashboard for project status/pausing and current resource usage; resume there if needed |

The architecture uses the existing Free-plan project and is sized for a four-member lab; no paid feature is required. Monitor actual database, Auth, and Realtime usage in the Dashboard rather than assuming quotas or uptime guarantees. No background jobs or keep-alive services are added.

Database administrators remain trusted: they can override data and policies in SQL Editor. Use the RPC workflow for routine changes; take appropriate private backups before migrations. A public GitHub repository is not a backup location for confidential database exports. The source reference and automated fixtures contain no real research results.

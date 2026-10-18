// Development-only integration test. Never connects to the hosted project.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'), 'package.json'));
const {default:EmbeddedPostgres} = await import(pathToFileURL(require.resolve('embedded-postgres')));
const directory = await mkdtemp(join(tmpdir(),'tracker-db-'));
const db = new EmbeddedPostgres({databaseDir:join(directory,'data'),user:'postgres',password:randomBytes(24).toString('hex'),
  port:Number(process.env.TRACKER_TEST_PORT || 55439),persistent:false,
  postgresFlags:['-c','listen_addresses=127.0.0.1','-c','wal_level=logical'],onLog:() => {},onError:() => {}});
const clients = [];
let checks = 0;
function check(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
async function rejects(fn, pattern, label) { await assert.rejects(fn,pattern,label); checks++; }
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
// Resolves to 'settled' if the promise finishes within the window, else 'pending'.
const settlesWithin = (promise,ms) => Promise.race([promise.then(() => 'settled',() => 'settled'),delay(ms).then(() => 'pending')]);
const users = Object.fromEntries(['Shibo','Yan','Junqi','Yifan','Outsider'].map(name => [name,randomUUID()]));
// Minimal stand-in for Supabase's auth schema (per database; roles are cluster-wide).
const authStub = `create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to anon,authenticated;
  grant execute on function auth.uid() to anon,authenticated;`;
const read = path => readFile(new URL(path,import.meta.url),'utf8');
try {
  await db.initialise(); await db.start();
  const admin = db.getPgClient(); await admin.connect(); clients.push(admin);
  await admin.query(`create role anon nologin; create role authenticated nologin; ${authStub}`);
  const [schema, exportSQL, dropArchiveSQL, v1Schema] = await Promise.all([read('../supabase/schema.sql'),read('../supabase/export_v1_backup.sql'),
    read('../supabase/drop_v1_archive.sql'),read('./fixtures/schema_v1.sql')]);
  for (const [name,sql] of [['schema.sql',schema],['export',exportSQL],['archive cleanup',dropArchiveSQL]]) {
    check(/```|\\[_*<>]|&(?:lt|gt);/.test(sql),false,`${name} is plain SQL, not escaped Markdown`);
    check(/\bcascade\b/i.test(sql.replace(/--.*$/gm,'')),false,`${name} uses no CASCADE`);
  }
  await admin.query(schema); await admin.query(schema); checks++; // fresh install, then repeatable rerun

  // ---- Catalog: publication, RLS, grants, no cascading foreign keys, no V1 objects.
  const publicationFlags = async (client = admin) => (await client.query(`select pubinsert, pubupdate, pubdelete, pubtruncate
    from pg_publication where pubname='supabase_realtime'`)).rows[0];
  const safeFlags = {pubinsert:true,pubupdate:true,pubdelete:false,pubtruncate:false};
  const publishedTables = async (client = admin) => (await client.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(r => r.tablename);
  check(await publicationFlags(),safeFlags,'publication publishes only INSERT/UPDATE');
  check(await publishedTables(),['idea_events','ideas','profiles'],'publication tables unchanged; participant/comment tables unpublished');
  check((await admin.query("select count(*)::int n from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity")).rows[0].n,5,'RLS on all five tables');
  check((await admin.query("select count(*)::int n from pg_constraint where contype='f' and connamespace='public'::regnamespace and confdeltype='c'")).rows[0].n,0,'no ON DELETE CASCADE foreign keys');
  check((await admin.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='ideas' and column_name in ('status','assigned_to','result','notes','experiment_url','completed_at')")).rows[0].n,0,'no single-assignee columns on ideas');
  check((await admin.query("select count(*)::int n from pg_proc where proname in ('claim_idea','release_idea','complete_idea','reopen_idea')")).rows[0].n,0,'no V1 RPCs');
  const rpcNames = ['create_idea','update_idea','delete_idea','join_idea','leave_idea','submit_result','reopen_result','add_comment','remove_comment'];
  const acl = await admin.query(`select p.proname, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as member, p.proconfig, p.prosecdef
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any($1)`,[rpcNames]);
  check(acl.rows.map(r => r.proname).sort(),[...rpcNames].sort(),'nine V2 RPCs');
  for (const fn of acl.rows) check([fn.anon,fn.member,fn.prosecdef,fn.proconfig.includes('search_path=""')],[false,true,true,true],`${fn.proname}: grants and fixed search path`);
  check((await admin.query("select pg_get_function_identity_arguments('public.submit_result'::regproc)")).rows[0].pg_get_function_identity_arguments,
    'p_idea_id uuid, p_expected_revision bigint, p_result text, p_notes text, p_experiment_url text','submit_result has no member parameter');

  for (const [name,id] of Object.entries(users)) {
    await admin.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await admin.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  async function member(name, role = 'authenticated', database = 'postgres') {
    const client = db.getPgClient(database); await client.connect(); clients.push(client);
    await client.query(`set role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[users[name] || '']);
    return client;
  }
  const shibo = await member('Shibo'), yan = await member('Yan'), junqi = await member('Junqi'), yifan = await member('Yifan');
  const outsider = await member('Outsider'), anon = await member(null,'anon');
  const rpc = async (client,name,args) => (await client.query(`select * from public.${name}(${args.map((_,i) => `$${i+1}`).join(',')})`,args)).rows[0];
  const create = (client,title = 'Isolated test idea') => rpc(client,'create_idea',[title,'Synthetic test description','2026-10-12','high']);
  const idea = async id => (await admin.query('select * from public.ideas where id=$1',[id])).rows[0];
  const part = async (id,name) => (await admin.query('select * from public.idea_participants where idea_id=$1 and member_id=$2',[id,users[name]])).rows[0];
  const events = async id => (await admin.query('select * from public.idea_events where idea_id=$1 order by id',[id])).rows;
  const tables = ['profiles','ideas','idea_participants','idea_comments','idea_events'];

  // ---- Member-only access.
  for (const table of tables) {
    await rejects(() => anon.query(`select * from public.${table}`),/permission denied/,`anonymous denied ${table}`);
    check((await outsider.query(`select * from public.${table}`)).rowCount,0,`outsider sees no ${table}`);
  }

  // ---- All four members create ideas; creator or PI edits; PI-only delete.
  const shiboIdea = await create(shibo,'Shared PI idea');
  const yanIdea = await create(yan,'Yan research idea');
  check([shiboIdea.created_by,yanIdea.created_by],[users.Shibo,users.Yan],'creator recorded from auth.uid()');
  for (const client of [junqi,yifan]) check((await create(client,'Researcher idea')).created_by !== undefined,true,'every researcher can create');
  for (const client of [shibo,yan,junqi,yifan]) check((await client.query('select * from public.ideas')).rowCount,4,'members read all ideas');
  await rejects(() => create(outsider),/Permission denied/,'outsider cannot create');
  await rejects(() => create(anon),/permission denied/,'anon cannot execute RPC');
  const edited = await rpc(yan,'update_idea',[yanIdea.id,yanIdea.revision,'Yan edited','Own edit','2026-10-19','low']);
  check([edited.title,edited.revision],['Yan edited','2'],'creator edits own idea');
  await rejects(() => rpc(junqi,'update_idea',[yanIdea.id,edited.revision,'Hijack','','2026-10-12','low']),/Permission denied/,'other researcher cannot edit');
  await rejects(() => rpc(yan,'update_idea',[shiboIdea.id,shiboIdea.revision,'Hijack','','2026-10-12','low']),/Permission denied/,'researcher cannot edit PI idea');
  const piEdited = await rpc(shibo,'update_idea',[yanIdea.id,edited.revision,'PI edited','Admin edit','2026-10-19','medium']);
  check(piEdited.title,'PI edited','PI edits any idea');
  await rejects(() => rpc(yan,'update_idea',[yanIdea.id,edited.revision,'Stale','','2026-10-12','low']),/Idea changed/,'stale edit rejected');
  await rejects(() => rpc(yan,'delete_idea',[yanIdea.id,piEdited.revision]),/Permission denied/,'creator cannot delete (PI only)');
  await rejects(() => rpc(shibo,'create_idea',['Bad Monday','','2026-10-13','low']),/check constraint/,'Monday constraint');
  await rejects(() => create(shibo,'   '),/check constraint/,'blank title');
  await rejects(() => rpc(shibo,'create_idea',['Bad priority','','2026-10-12','urgent']),/check constraint/,'priority constraint');
  await rejects(() => admin.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/check constraint/,'only Shibo may be PI');

  // ---- No direct writes, sequences or private helpers.
  const target = shiboIdea.id;
  await rejects(() => yan.query("insert into public.ideas(title,week_start,created_by) values ('x','2026-10-12',$1)",[users.Yan]),/permission denied/,'direct idea insert');
  await rejects(() => yan.query('insert into public.idea_participants(idea_id,member_id) values ($1,$2)',[target,users.Yan]),/permission denied/,'direct participation insert');
  await rejects(() => yan.query("insert into public.idea_comments(idea_id,author_id,body,client_request_id) values ($1,$2,'x',gen_random_uuid())",[target,users.Yan]),/permission denied/,'direct comment insert');
  await rejects(() => yan.query("insert into public.idea_events(idea_id,idea_number,event_type) values ($1,1,'joined')",[target]),/permission denied/,'forged event');
  await rejects(() => yan.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/permission denied/,'role escalation');
  await rejects(() => yan.query('delete from public.idea_events'),/permission denied/,'immutable history');
  await rejects(() => yan.query("select nextval('public.ideas_idea_number_seq')"),/permission denied/,'identity sequence denied');
  await rejects(() => yan.query('select tracker_private.lock_participation($1,$2,1)',[target,users.Junqi]),/permission denied/,'private helper denied');

  // ---- Concurrent participation: different members never block each other.
  await yan.query('begin');
  const yanJoin = await rpc(yan,'join_idea',[target]);
  const junqiJoin = rpc(junqi,'join_idea',[target]);
  check(await settlesWithin(junqiJoin,3000),'settled','second member joins while the first join is uncommitted');
  await yan.query('commit');
  check([yanJoin.status,(await junqiJoin).status],['testing','testing'],'both members participate');
  await rejects(() => rpc(yan,'join_idea',[target]),/Already participating/,'duplicate join rejected');
  // The same member in two sessions: exactly one join succeeds.
  await yifan.query('begin');
  await rpc(yifan,'join_idea',[yanIdea.id]);
  const yifanTwin = await member('Yifan');
  const twinJoin = rpc(yifanTwin,'join_idea',[yanIdea.id]).then(value => ({value}),error => ({error}));
  check(await settlesWithin(twinJoin,300),'pending','same member second session waits on the unique key');
  await yifan.query('commit');
  check((await twinJoin).error?.message,'Already participating in this idea','same member cannot join twice concurrently');
  check((await admin.query('select count(*)::int n from public.idea_participants where idea_id=$1 and member_id=$2',[yanIdea.id,users.Yifan])).rows[0].n,1,'one participation row per member');

  // ---- Independent results submitted in parallel.
  let yanRow = await part(target,'Yan'), junqiRow = await part(target,'Junqi');
  await yan.query('begin');
  const yanResult = await rpc(yan,'submit_result',[target,yanRow.revision,'success','Yan notes','https://example.org/yan']);
  const junqiResult = rpc(junqi,'submit_result',[target,junqiRow.revision,'fail','Junqi notes',null]);
  check(await settlesWithin(junqiResult,3000),'settled','second result not blocked by first');
  await yan.query('commit');
  yanRow = await part(target,'Yan'); junqiRow = await part(target,'Junqi');
  check([yanRow.status,yanRow.result,yanRow.notes,yanRow.experiment_url],['completed','success','Yan notes','https://example.org/yan'],'Yan result stored');
  check([junqiRow.status,junqiRow.result,junqiRow.notes,(await junqiResult).result],['completed','fail','Junqi notes','fail'],'Junqi result stored independently');
  check(yanResult.member_id,users.Yan,'submit_result writes the caller row');

  // ---- No cross-user modification.
  await rejects(() => yan.query("update public.idea_participants set result='success' where member_id=$1",[users.Junqi]),/permission denied/,'direct cross-user update denied');
  await rejects(() => rpc(yan,'reopen_result',[target,users.Junqi,junqiRow.revision]),/Permission denied/,'researcher cannot reopen another result');
  await rejects(() => rpc(yan,'submit_result',[target,yanRow.revision,'fail',null,null]),/Invalid status transition/,'completed result is final for the member');
  await rejects(() => rpc(yan,'leave_idea',[target,yanRow.revision]),/Invalid status transition/,'cannot leave after a result');
  await rejects(() => rpc(shibo,'submit_result',[target,1,'success',null,null]),/Participation not found/,'PI cannot submit into another row');
  check((await part(target,'Junqi')).result,'fail','Junqi result untouched by every attempt');
  const yifanRevision = (await part(yanIdea.id,'Yifan')).revision;
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,yifanRevision,'maybe',null,null]),/Invalid completion result/,'result enum');
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,yifanRevision,'success',null,'javascript:alert(1)']),/check constraint/,'URL scheme');
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,999,'success',null,null]),/Participation changed/,'stale participation revision');

  // ---- PI reopens one result; others stay; history keeps the old result.
  const reopened = await rpc(shibo,'reopen_result',[target,users.Yan,yanRow.revision]);
  check([reopened.status,reopened.result,reopened.notes],['testing',null,null],'PI reopened Yan result');
  check((await part(target,'Junqi')).result,'fail','reopening Yan leaves Junqi intact');
  const reopenEvent = (await events(target)).at(-1);
  check([reopenEvent.event_type,reopenEvent.member_id,reopenEvent.actor_id,reopenEvent.previous_state.result,reopenEvent.previous_state.notes],
    ['result_reopened',users.Yan,users.Shibo,'success','Yan notes'],'previous result preserved in history');
  await rpc(yan,'submit_result',[target,reopened.revision,'fail','Second trial',null]);

  // ---- Leave and rejoin.
  const left = await rpc(yifan,'leave_idea',[yanIdea.id,(await part(yanIdea.id,'Yifan')).revision]);
  check(left.status,'withdrawn','member withdraws');
  const rejoined = await rpc(yifan,'join_idea',[yanIdea.id]);
  check(rejoined.status,'testing','member rejoins');
  check((await events(yanIdea.id)).filter(e => e.member_id === users.Yifan).map(e => e.event_type),['joined','withdrew','rejoined'],'participation history');

  // ---- Comments: verbatim Markdown, idempotent posting, PI removal.
  const markdown = '﻿## Thoughts\r\n\r\n$$\\alpha_i^2$$ and `code`\r\n- **bold**\r\n  ';
  const requestId = randomUUID();
  const comment = await rpc(yan,'add_comment',[target,markdown,requestId]);
  check([comment.body,comment.author_id,!!comment.created_at],[markdown,users.Yan,true],'comment stored verbatim with author and time');
  check((await rpc(yan,'add_comment',[target,markdown,requestId])).id,comment.id,'retried request returns the same comment');
  check((await admin.query('select count(*)::int n from public.idea_comments')).rows[0].n,1,'retry did not duplicate');
  await rejects(() => rpc(yan,'add_comment',[yanIdea.id,'other',requestId]),/already used/,'request ID cannot be reused on another idea');
  for (const client of [shibo,junqi,yifan]) await rpc(client,'add_comment',[target,'Member reply $x$',randomUUID()]);
  check((await yifan.query('select * from public.idea_comments where idea_id=$1',[target])).rowCount,4,'all members comment and read');
  await rejects(() => rpc(yan,'add_comment',[target,' \r\n\t ',randomUUID()]),/check constraint/,'whitespace-only comment rejected');
  await rejects(() => rpc(yan,'add_comment',[target,'x'.repeat(20481),randomUUID()]),/check constraint/,'oversized comment rejected');
  await rejects(() => rpc(yan,'add_comment',[randomUUID(),'x',randomUUID()]),/Idea not found/,'comment on missing idea');
  await rejects(() => rpc(outsider,'add_comment',[target,'x',randomUUID()]),/Permission denied/,'outsider cannot comment');
  await rejects(() => rpc(yan,'add_comment',[target,'x',null]),/Missing comment request ID/,'request ID required');
  await rejects(() => rpc(yan,'remove_comment',[comment.id]),/Permission denied/,'researcher cannot remove comments');
  const removed = await rpc(shibo,'remove_comment',[comment.id]);
  check([removed.removed_by,!!removed.removed_at,removed.body],[users.Shibo,true,markdown],'PI removal hides but keeps original text');
  await rejects(() => rpc(shibo,'remove_comment',[comment.id]),/Comment not found/,'already removed');
  check((await events(target)).filter(e => ['commented','comment_removed'].includes(e.event_type)).length,5,'comment history recorded');

  // ---- Deactivated members lose access; their results remain attributed.
  await admin.query('update public.profiles set active=false where id=$1',[users.Junqi]);
  for (const table of tables) check((await junqi.query(`select * from public.${table}`)).rowCount,0,`deactivated member cannot read ${table}`);
  await rejects(() => rpc(junqi,'add_comment',[target,'x',randomUUID()]),/Permission denied/,'deactivated member cannot comment');
  check((await part(target,'Junqi')).result,'fail','deactivated member result retained');
  await admin.query('update public.profiles set active=true where id=$1',[users.Junqi]);

  // ---- Realtime: every change reaches subscribers as an idea_events INSERT.
  await admin.query("select * from pg_create_logical_replication_slot('tracker_realtime_test','pgoutput')");
  const streamIdea = await create(shibo,'Publication stream test');
  const streamJoin = await rpc(junqi,'join_idea',[streamIdea.id]);
  await rpc(junqi,'submit_result',[streamIdea.id,streamJoin.revision,'success',null,null]);
  await rpc(yan,'add_comment',[streamIdea.id,'Stream comment',randomUUID()]);
  await rpc(shibo,'delete_idea',[streamIdea.id,streamIdea.revision]);
  const messages = (await admin.query(`select data from pg_logical_slot_get_binary_changes(
    'tracker_realtime_test',null,null,'proto_version','1','publication_names','supabase_realtime')`)).rows.map(r => r.data);
  await admin.query("select pg_drop_replication_slot('tracker_realtime_test')");
  const oid = async table => (await admin.query(`select '${table}'::regclass::oid as oid`)).rows[0].oid;
  const [ideaOid,eventOid,partOid,commentOid] = await Promise.all(['public.ideas','public.idea_events','public.idea_participants','public.idea_comments'].map(oid));
  const rowMessages = messages.filter(data => [73,85,68].includes(data[0]));
  check(messages.some(data => data[0] === 68),false,'no DELETE message in logical replication output');
  check(rowMessages.filter(data => data[0] === 73 && data.readUInt32BE(1) === eventOid).length,5,'created/joined/result/comment/deleted all published as event INSERTs');
  check(rowMessages.some(data => [partOid,commentOid].includes(data.readUInt32BE(1))),false,'participant/comment rows themselves are not published');
  check(rowMessages.some(data => data[0] === 73 && data.readUInt32BE(1) === ideaOid),true,'idea INSERT published');

  // ---- Deletion snapshots all participant results and comments; no cascades.
  const beforeDelete = await idea(target);
  await rejects(() => rpc(yan,'delete_idea',[target,beforeDelete.revision]),/Permission denied/,'researcher cannot delete');
  // A comment in flight holds the idea; deletion waits and then includes it.
  await yifan.query('begin');
  await rpc(yifan,'add_comment',[target,'Posted during deletion',randomUUID()]);
  const deletion = rpc(shibo,'delete_idea',[target,beforeDelete.revision]);
  check(await settlesWithin(deletion,300),'pending','deletion waits for the in-flight comment');
  await yifan.query('commit'); await deletion;
  check(await idea(target),undefined,'idea deleted');
  check((await admin.query('select (select count(*) from public.idea_participants where idea_id=$1)::int p, (select count(*) from public.idea_comments where idea_id=$1)::int c',[target])).rows[0],{p:0,c:0},'children removed explicitly');
  const deletedEvent = (await events(target)).at(-1);
  check(deletedEvent.event_type,'deleted','deletion event');
  check(deletedEvent.previous_state.participants.map(p => [p.member_id,p.result]).sort(),[[users.Junqi,'fail'],[users.Yan,'fail']].sort(),'deleted snapshot keeps every participant result');
  check(deletedEvent.previous_state.comments.length,5,'deleted snapshot keeps every comment, including removed and late ones');
  check(deletedEvent.previous_state.comments.some(c => c.body === markdown && c.removed_by === users.Shibo),true,'removed comment original preserved');
  await rejects(() => rpc(yan,'join_idea',[target]),/Idea not found/,'cannot join a deleted idea');
  for (const observer of [shibo,yan]) check((await observer.query('select * from public.idea_events where idea_id=$1',[target])).rowCount > 0,true,'history readable after deletion');
  const next = await create(shibo);
  check(Number(next.idea_number) > Number(streamIdea.idea_number),true,'idea numbers never reused');

  // ---- Parent-before-child lock order: deletion vs. every child change, in both orders.
  // child first: the deletion must wait, then snapshot the committed change.
  // deletion first: the change must wait, then fail because the idea is gone.
  const shiboDeleter = await member('Shibo'); // separate PI session that performs the deletions
  const deletedSnapshot = async id => (await events(id)).find(e => e.event_type === 'deleted').previous_state;
  const raceCases = [
    {name:'submit_result',client:yan,
      prepare:async id => { await rpc(yan,'join_idea',[id]); },
      change:async id => rpc(yan,'submit_result',[id,(await part(id,'Yan')).revision,'success','Concurrent result',null]),
      committed:s => s.participants.some(p => p.member_id === users.Yan && p.result === 'success' && p.notes === 'Concurrent result'),
      untouched:s => s.participants.some(p => p.member_id === users.Yan && p.status === 'testing')},
    {name:'leave_idea',client:junqi,
      prepare:async id => { await rpc(junqi,'join_idea',[id]); },
      change:async id => rpc(junqi,'leave_idea',[id,(await part(id,'Junqi')).revision]),
      committed:s => s.participants.some(p => p.member_id === users.Junqi && p.status === 'withdrawn'),
      untouched:s => s.participants.some(p => p.member_id === users.Junqi && p.status === 'testing')},
    {name:'reopen_result',client:shibo,
      prepare:async id => { const row = await rpc(yifan,'join_idea',[id]); await rpc(yifan,'submit_result',[id,row.revision,'fail','Before reopen',null]); },
      change:async id => rpc(shibo,'reopen_result',[id,users.Yifan,(await part(id,'Yifan')).revision]),
      committed:s => s.participants.some(p => p.member_id === users.Yifan && p.status === 'testing' && p.result === null),
      untouched:s => s.participants.some(p => p.member_id === users.Yifan && p.result === 'fail' && p.notes === 'Before reopen')},
    {name:'remove_comment',client:shibo,
      prepare:async id => { await rpc(yan,'add_comment',[id,'Comment under race',randomUUID()]); },
      change:async id => rpc(shibo,'remove_comment',[(await admin.query('select id from public.idea_comments where idea_id=$1',[id])).rows[0].id]),
      committed:s => s.comments.some(c => c.body === 'Comment under race' && c.removed_by === users.Shibo),
      untouched:s => s.comments.some(c => c.body === 'Comment under race' && c.removed_at === null)},
  ];
  for (const race of raceCases) {
    const first = await create(shibo,`${race.name} before deletion`); await race.prepare(first.id);
    await race.client.query('begin');
    await race.change(first.id);
    const deletion = rpc(shiboDeleter,'delete_idea',[first.id,(await idea(first.id)).revision]);
    check(await settlesWithin(deletion,300),'pending',`${race.name} first: deletion waits for the uncommitted change`);
    await race.client.query('commit'); await deletion;
    check(race.committed(await deletedSnapshot(first.id)),true,`${race.name} first: deletion snapshot includes the committed change`);
    check(await idea(first.id),undefined,`${race.name} first: idea deleted afterwards`);

    const second = await create(shibo,`${race.name} after deletion`); await race.prepare(second.id);
    await shiboDeleter.query('begin');
    await rpc(shiboDeleter,'delete_idea',[second.id,(await idea(second.id)).revision]);
    const late = race.change(second.id).then(value => ({value}),error => ({error}));
    check(await settlesWithin(late,300),'pending',`${race.name} second: change waits for the uncommitted deletion`);
    await shiboDeleter.query('commit');
    check((await late).error?.message,'Idea not found',`${race.name} second: change after deletion is rejected`);
    check(race.untouched(await deletedSnapshot(second.id)),true,`${race.name} second: snapshot holds the state the deletion saw`);
  }
  // Parent KEY SHARE locks do not serialize members, comments or idea edits.
  const shared = await create(shibo,'Concurrent different participants');
  for (const client of [yan,junqi]) await rpc(client,'join_idea',[shared.id]);
  const junqiShared = await part(shared.id,'Junqi');
  await yan.query('begin');
  await rpc(yan,'submit_result',[shared.id,(await part(shared.id,'Yan')).revision,'success',null,null]);
  check(await settlesWithin(rpc(junqi,'submit_result',[shared.id,junqiShared.revision,'fail',null,null]),3000),'settled','another participant submits while a result is in flight');
  check(await settlesWithin(rpc(yifan,'add_comment',[shared.id,'Concurrent comment',randomUUID()]),3000),'settled','comments are not blocked by an in-flight result');
  check(await settlesWithin(rpc(shibo,'update_idea',[shared.id,shared.revision,'Edited during a submission','','2026-10-12','low']),3000),'settled','idea edits are not blocked by an in-flight result');
  await yan.query('commit');
  check([(await part(shared.id,'Yan')).result,(await part(shared.id,'Junqi')).result,(await idea(shared.id)).title],['success','fail','Edited during a submission'],'all concurrent changes kept');

  // ---- Rerun keeps all V2 data.
  const counts = async () => (await admin.query('select (select count(*) from public.ideas)::int i,(select count(*) from public.idea_participants)::int p,(select count(*) from public.idea_comments)::int c,(select count(*) from public.idea_events)::int e')).rows[0];
  const beforeRerun = await counts();
  await admin.query(schema);
  check(await counts(),beforeRerun,'schema rerun preserves V2 data');
  check(await publicationFlags(),safeFlags,'rerun keeps INSERT/UPDATE-only publication');
  check((await admin.query("select to_regprocedure('tracker_private.v1_fingerprint(text)') f, to_regclass('tracker_v1_archive.ideas') a")).rows[0],{f:null,a:null},'no upgrade helpers or archive on a fresh install');

  // ---- V1 → V2: mandatory verified backup, then ONE transaction.
  await admin.query('create database v1_upgrade');
  const v1 = db.getPgClient('v1_upgrade'); await v1.connect(); clients.push(v1);
  await v1.query(authStub);
  await v1.query(v1Schema);
  for (const [name,id] of Object.entries(users)) {
    await v1.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await v1.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  // Realistic V1 history: IDEA-001 with long Markdown, a claimed+completed idea, and a deleted idea.
  const asMember = name => v1.query("select set_config('request.jwt.claim.sub',$1,false)",[users[name] || '']);
  const idea001 = '﻿# IDEA-001 synthetic Markdown\r\n\r\n| a | b |\r\n|---|---|\r\n| $x_i$ | **bold** |\r\n\r\n$$\r\n\\frac{a}{b}\r\n$$\r\n\r\n```py\r\nprint("$x$")\r\n```\r\n' + 'é😀 '.repeat(3000);
  await asMember('Shibo');
  await v1.query("insert into public.ideas(title,description,week_start,created_by) values ('IDEA-001 synthetic',$1,'2026-10-12',$2)",[idea001,users.Shibo]);
  await v1.query("insert into public.ideas(title,description,week_start,created_by,priority) values ('Second V1 idea','Second','2026-10-19',$1,'low')",[users.Shibo]);
  await v1.query("insert into public.ideas(title,week_start,created_by) values ('Deleted V1 idea','2026-10-12',$1)",[users.Shibo]);
  await asMember('Yan');
  await v1.query("update public.ideas set status='testing', assigned_to=$1 where idea_number=2",[users.Yan]);
  await v1.query("update public.ideas set status='completed', result='fail', notes='V1 notes', experiment_url='https://example.org/v1', completed_at=now() where idea_number=2");
  await asMember('Shibo');
  await v1.query('delete from public.ideas where idea_number=3');
  await asMember(null);
  const v1Counts = (await v1.query('select (select count(*) from public.ideas)::int i, (select count(*) from public.idea_events)::int e')).rows[0];
  check(v1Counts,{i:2,e:6},'V1 fixture: two ideas and six history events');

  // Read-only export: runs inside a READ ONLY transaction.
  const runExport = async (sql = exportSQL) => {
    await v1.query('begin transaction read only');
    try { return (await v1.query(sql)).rows[0]; } finally { await v1.query('rollback'); }
  };
  const exported = await runExport();
  check([exported.profiles,exported.ideas,exported.events].map(Number),[4,2,6],'export counts');
  check([exported.idea_001_title,Number(exported.idea_001_description_bytes),exported.idea_001_description_md5],
    ['IDEA-001 synthetic',Buffer.byteLength(idea001,'utf8'),createHash('md5').update(idea001,'utf8').digest('hex')],'IDEA-001 summary');
  const backupIdea001 = exported.backup.ideas.find(i => i.idea_number === '1');
  check([backupIdea001.description,backupIdea001.created_by],[idea001,users.Shibo],'complete Markdown and author exported verbatim');
  check(exported.backup.ideas.find(i => i.idea_number === '2').notes,'V1 notes','metadata exported');
  check(exported.backup.idea_events.map(e => e.event_type),['created','created','created','claimed','completed','deleted'],'complete activity history exported');
  check(exported.backup.idea_events.filter(e => e.actor_id).map(e => e.actor_id),[users.Shibo,users.Shibo,users.Shibo,users.Yan,users.Yan,users.Shibo],'history attribution exported');
  check(JSON.parse(exported.backup.idea_events.at(-1).previous_state).title,'Deleted V1 idea','deleted-idea snapshot exported');

  // Offline verification of the saved file with the real script.
  const verifier = fileURLToPath(new URL('../tools/verify_v1_backup.mjs',import.meta.url));
  const backupDir = await mkdtemp(join(tmpdir(),'tracker-backup-'));
  const verify = async (content,fingerprint = exported.fingerprint) => {
    const path = join(backupDir,`backup-${randomUUID()}.json`); await writeFile(path,content);
    return new Promise(done => execFile(process.execPath,[verifier,path,fingerprint],(error,stdout,stderr) => done({code:error ? error.code : 0,stdout,stderr})));
  };
  try {
    const raw = JSON.stringify(exported.backup);
    const ok = await verify(raw);
    check([ok.code,ok.stdout.includes(exported.fingerprint),ok.stdout.includes('IDEA-001'),ok.stdout.includes(exported.idea_001_description_md5)],[0,true,true,true],'verifier accepts the exported backup');
    check((await verify(JSON.stringify([exported]))).code,0,'verifier accepts a SQL Editor JSON result');
    check((await verify(`fingerprint,backup\n${exported.fingerprint},"${raw.replaceAll('"','""')}"\n`)).code,0,'verifier accepts a SQL Editor CSV result');
    const tampered = structuredClone(exported.backup);
    tampered.ideas.find(i => i.idea_number === '1').description = idea001.replace('synthetic','synthetiC');
    const altered = await verify(JSON.stringify(tampered));
    check([altered.code,altered.stderr.includes('altered or corrupted')],[1,true],'one changed character is detected');
    const missing = structuredClone(exported.backup); missing.idea_events.pop(); missing.counts.idea_events = 5;
    check((await verify(JSON.stringify(missing))).code,1,'a missing history event is detected');
    check((await verify(raw.slice(0,-200))).code,1,'a truncated file is rejected');
    check((await verify(raw,'0'.repeat(32))).code,1,'a different fingerprint is rejected');
  } finally { await rm(backupDir,{recursive:true,force:true}); }

  // Upgrade refusals and failures leave V1 exactly as it was.
  const withFingerprint = fingerprint => schema.replace("set_config('tracker.v1_backup_fingerprint', '', true)",`set_config('tracker.v1_backup_fingerprint', '${fingerprint}', true)`);
  check(withFingerprint('x') !== schema,true,'fingerprint line present in schema.sql');
  const isV1 = async () => (await v1.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='ideas' and column_name='assigned_to'")).rows[0].n === 1;
  const v1Intact = async (fingerprint,label) => {
    check([await isV1(),(await runExport()).fingerprint],[true,fingerprint],`${label}: V1 data identical`);
    check((await v1.query("select to_regnamespace('tracker_v1_archive') a, to_regclass('public.idea_participants') p, to_regprocedure('public.claim_idea(uuid)') is not null c")).rows[0],{a:null,p:null,c:true},`${label}: no archive, no V2, V1 RPCs present`);
    check(await publishedTables(v1),['idea_events','ideas','profiles'],`${label}: V1 publication unchanged`);
  };
  await rejects(() => v1.query(schema),/verified backup is required/,'upgrade refuses without a backup fingerprint');
  await v1.query('rollback');
  await v1Intact(exported.fingerprint,'no fingerprint');
  await v1.query("update public.ideas set title = title || ' (edited after backup)' where idea_number = 2");
  await rejects(() => v1.query(withFingerprint(exported.fingerprint)),/does not match the backup fingerprint/,'upgrade refuses when data changed after the backup');
  await v1.query('rollback');
  const current = await runExport();
  check(current.fingerprint !== exported.fingerprint,true,'changed data needs a new backup');
  await v1Intact(current.fingerprint,'stale fingerprint');
  const failing = withFingerprint(current.fingerprint).replace("notify pgrst, 'reload schema';","select 1/0;");
  check(failing !== withFingerprint(current.fingerprint),true,'failure injected after the full V2 install');
  await rejects(() => v1.query(failing),/division by zero/,'late failure aborts the upgrade');
  await v1.query('rollback');
  await v1Intact(current.fingerprint,'failed upgrade');

  // Successful single-transaction upgrade.
  const profileRows = async () => (await v1.query('select * from public.profiles order by id')).rows;
  const authRows = async () => (await v1.query('select * from auth.users order by id')).rows;
  const [profilesBefore,authBefore] = [await profileRows(),await authRows()];
  await v1.query(withFingerprint(current.fingerprint));
  check(await isV1(),false,'public schema is V2 after the upgrade');
  const archiveExport = exportSQL.replaceAll('public.ideas','tracker_v1_archive.ideas').replaceAll('public.idea_events','tracker_v1_archive.idea_events');
  check((await runExport(archiveExport)).fingerprint,current.fingerprint,'archived V1 data identical to the verified backup');
  check((await v1.query('select description from tracker_v1_archive.ideas where idea_number=1')).rows[0].description,idea001,'IDEA-001 Markdown preserved in the archive');
  check(await profileRows(),profilesBefore,'profiles identical after the upgrade');
  check(await authRows(),authBefore,'auth users identical after the upgrade');
  check((await v1.query(`select to_regprocedure('public.claim_idea(uuid)') c, to_regprocedure('tracker_private.lock_idea(uuid,bigint)') l,
    to_regprocedure('tracker_private.touch_idea()') t, to_regprocedure('tracker_private.v1_fingerprint(text)') f`)).rows[0],{c:null,l:null,t:null,f:null},'V1 functions and upgrade helpers removed');
  check(await publishedTables(v1),['idea_events','ideas','profiles'],'V2 tables published; archive not published');
  check((await v1.query("select count(*)::int n from pg_publication_tables where schemaname='tracker_v1_archive'")).rows[0].n,0,'archive absent from Realtime');
  const v1Yan = await member('Yan','authenticated','v1_upgrade');
  await rejects(() => v1Yan.query('select * from tracker_v1_archive.ideas'),/permission denied/,'members cannot read the archive');
  const firstV2 = await create(v1Yan,'First V2 idea');
  check([firstV2.idea_number,(await rpc(v1Yan,'join_idea',[firstV2.id])).status],['1','testing'],'existing member works on V2; numbering starts fresh');
  await v1.query(withFingerprint(current.fingerprint));
  check((await v1.query('select count(*)::int n from public.ideas')).rows[0].n,1,'rerun after the upgrade is a no-op for data');

  // Optional archive removal, much later: explicit confirmation, profiles untouched.
  await rejects(() => v1.query(dropArchiveSQL),/not confirmed/,'archive removal requires confirmation');
  await v1.query('rollback');
  const confirmedDrop = dropArchiveSQL.replace("set_config('tracker.confirm_drop_v1_archive', 'no', true)","set_config('tracker.confirm_drop_v1_archive', 'yes', true)");
  check(confirmedDrop !== dropArchiveSQL,true,'archive confirmation line present');
  await v1.query(confirmedDrop);
  check([(await v1.query("select to_regnamespace('tracker_v1_archive') a")).rows[0].a,await profileRows()],[null,profilesBefore],'archive removed; profiles unchanged');
  await rejects(() => v1.query(confirmedDrop),/No V1 archive found/,'archive removal is not repeatable');
  await v1.query('rollback');

  console.log(`PASS: ${checks} PostgreSQL checks, including concurrent participation, parallel independent results, comment idempotency, publication WAL filtering, parent-before-child deletion races, and the backup-verified single-transaction V1 upgrade. Hosted Supabase was not used.`);
} finally {
  await Promise.allSettled(clients.map(client => client.end()));
  await db.stop(); await rm(directory,{recursive:true,force:true});
}

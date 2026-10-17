// Development-only integration test. Never connects to the hosted project.
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
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
const users = Object.fromEntries(['Shibo','Yan','Junqi','Yifan','Outsider'].map(name => [name,randomUUID()]));
try {
  await db.initialise(); await db.start();
  const admin = db.getPgClient(); await admin.connect(); clients.push(admin);
  await admin.query(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  const schema = await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8');
  check(/```|\\[_*<>]|&(?:lt|gt);/.test(schema),false,'source is plain SQL, not escaped Markdown');
  await admin.query(schema); await admin.query(schema); checks++; // repeatable installation
  const publicationFlags = async () => (await admin.query(`select pubinsert, pubupdate, pubdelete, pubtruncate
    from pg_publication where pubname='supabase_realtime'`)).rows[0];
  const safeFlags = {pubinsert:true,pubupdate:true,pubdelete:false,pubtruncate:false};
  check(await publicationFlags(),safeFlags,'new publication publishes only INSERT/UPDATE');
  // Upgrade an existing app-only publication with the old default actions.
  await admin.query("alter publication supabase_realtime set (publish='insert, update, delete, truncate')");
  await admin.query(schema);
  check(await publicationFlags(),safeFlags,'existing exclusive publication disables DELETE/TRUNCATE');

  // A shared publication must fail the entire deployment, preserving its settings.
  // These fixtures exist only in this temporary test cluster.
  await admin.query(`create schema unrelated_app;
    create schema unrelated_empty;
    create table unrelated_app.ideas (id integer primary key);
    alter publication supabase_realtime add table unrelated_app.ideas;
    alter publication supabase_realtime set (publish='insert, update, delete, truncate')`);
  const sharedFlags = await publicationFlags();
  await rejects(() => admin.query(schema),/Refusing to change shared/,'shared-table deployment rejected');
  await admin.query('rollback');
  check(await publicationFlags(),sharedFlags,'unrelated app publication settings unchanged');
  check((await admin.query("select count(*)::int n from pg_publication_tables where pubname='supabase_realtime' and schemaname='unrelated_app'")).rows[0].n,1,'unrelated membership unchanged');
  await admin.query('alter publication supabase_realtime drop table unrelated_app.ideas');
  await admin.query(schema);
  const publicationSetup = schema.match(/do \$\$\r?\ndeclare v_table text;[\s\S]*?\r?\n\$\$;/)[0];
  for (const scope of ['all tables','tables in schema unrelated_empty']) {
    await admin.query(`begin;
      alter publication supabase_realtime rename to tracker_test_original;
      create publication supabase_realtime for ${scope}`);
    await rejects(() => admin.query(publicationSetup),/Refusing to change shared/,`${scope} publication rejected`);
    await admin.query('rollback');
    check(await publicationFlags(),safeFlags,`${scope} test leaves original publication intact`);
  }
  for (const [name,id] of Object.entries(users)) {
    await admin.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await admin.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  async function member(name, role = 'authenticated') {
    const client = db.getPgClient(); await client.connect(); clients.push(client);
    await client.query(`set role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[users[name] || '']);
    return client;
  }
  const shibo = await member('Shibo'), yan = await member('Yan'), junqi = await member('Junqi'), yifan = await member('Yifan');
  const outsider = await member('Outsider'), anon = await member(null,'anon');
  const rpc = async (client,name,args) => (await client.query(`select * from public.${name}(${args.map((_,i) => `$${i+1}`).join(',')})`,args)).rows[0];
  const create = (client,title = 'Isolated test idea') => rpc(client,'create_idea',[title,'Synthetic test description','2026-10-12','high']);
  const row = async id => (await admin.query('select * from public.ideas where id = $1',[id])).rows[0];
  const events = async id => (await admin.query('select * from public.idea_events where idea_id=$1 order by id',[id])).rows;
  let idea = await create(shibo);
  check([idea.status,idea.assigned_to,idea.result,idea.revision],['available',null,null,'1'],'initial state');
  for (const client of [shibo,yan,junqi,yifan]) check((await client.query('select * from public.ideas')).rowCount,1,'member read');
  for (const table of ['profiles','ideas','idea_events']) {
    await rejects(() => anon.query(`select * from public.${table}`),/permission denied/,'anonymous denied');
    check((await outsider.query(`select * from public.${table}`)).rowCount,0,'outsider RLS');
  }
  for (const client of [yan,junqi,yifan,outsider]) await rejects(() => create(client),/Permission denied/,'PI-only creation');
  await rejects(() => create(anon),/permission denied/,'anon RPC grant denied');
  await rejects(() => yan.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/permission denied/,'role escalation');
  await rejects(() => yan.query('insert into public.profiles(id,display_name,role) values ($1,\'Shibo\',\'pi\')',[users.Outsider]),/permission denied/,'self allowlist');
  await rejects(() => yan.query("update public.ideas set assigned_to=$1,status='testing' where id=$2",[users.Yan,idea.id]),/permission denied/,'direct mutation');
  await rejects(() => shibo.query('delete from public.ideas where id=$1',[idea.id]),/permission denied/,'even PI uses RPCs');
  await rejects(() => yan.query("insert into public.idea_events(idea_id,idea_number,event_type) values ($1,1,'claimed')",[idea.id]),/permission denied/,'forged event');
  await rejects(() => yan.query('delete from public.idea_events'),/permission denied/,'immutable history');
  await rejects(() => yan.query("select nextval('public.ideas_idea_number_seq')"),/permission denied/,'identity sequence denied');
  await rejects(() => yan.query('select tracker_private.lock_idea($1,1)',[idea.id]),/permission denied/,'private mutation helper denied');
  await rejects(() => rpc(outsider,'claim_idea',[idea.id]),/Permission denied/,'outsider RPC denied');
  await rejects(() => rpc(shibo,'complete_idea',[idea.id,idea.revision,'success',null,null]),/Invalid status transition/,'cannot complete unclaimed');
  await rejects(() => rpc(shibo,'release_idea',[idea.id,idea.revision]),/Invalid status transition/,'cannot release available');
  await rejects(() => rpc(shibo,'reopen_idea',[idea.id,idea.revision]),/Invalid status transition/,'cannot reopen available');
  await rejects(() => rpc(shibo,'create_idea',['Bad Monday','','2026-10-13','low']),/check constraint/,'Monday constraint');
  await rejects(() => create(shibo,'   '),/check constraint/,'blank title');
  await rejects(() => rpc(shibo,'create_idea',['Bad priority','','2026-10-12','urgent']),/check constraint/,'priority constraint');
  await rejects(() => admin.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/check constraint/,'only Shibo may be PI');

  // Hold the winning UPDATE open, then verify the second independent connection
  // blocks on a real row lock before committing the first transaction.
  await yan.query('begin');
  const won = await rpc(yan,'claim_idea',[idea.id]);
  let loserSettled = false;
  const losingClaim = rpc(junqi,'claim_idea',[idea.id]).then(value => { loserSettled=true; return {value}; },error => { loserSettled=true; return {error}; });
  const junqiPid = (await admin.query("select pid from pg_stat_activity where query like 'select * from public.claim_idea%' and wait_event_type='Lock' limit 1")).rows[0];
  // Observe the lock with a short bounded poll (no timing assumption about the winner).
  let blocked = !!junqiPid;
  for (let attempt=0; !blocked && attempt<100; attempt++) {
    const result = await admin.query("select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like 'select * from public.claim_idea%'");
    blocked = result.rows[0].n > 0;
    if (!blocked) await new Promise(resolve => setTimeout(resolve,10));
  }
  check(blocked,true,'competing claim blocks on PostgreSQL lock'); check(loserSettled,false,'second claim remains pending');
  await yan.query('commit');
  const lost = await losingClaim;
  check(lost.error?.message,'Idea already claimed or no longer available','one winner, one conflict');
  idea = await row(idea.id);
  check([idea.status,idea.assigned_to],['testing',users.Yan],'authenticated owner');
  check((await events(idea.id)).filter(e => e.event_type === 'claimed').length,1,'one claim event');
  await rejects(() => rpc(junqi,'release_idea',[idea.id,idea.revision]),/Permission denied/,'other release denied');
  await rejects(() => rpc(junqi,'complete_idea',[idea.id,idea.revision,'success',null,null]),/Permission denied/,'other completion denied');
  await rejects(() => rpc(yan,'update_idea',[idea.id,idea.revision,'Hijack','','2026-10-12','low']),/Permission denied/,'researcher edit denied');
  await rejects(() => rpc(yan,'delete_idea',[idea.id,idea.revision]),/Permission denied/,'researcher deletion denied');
  await rejects(() => rpc(yan,'complete_idea',[idea.id,idea.revision,null,null,null]),/Invalid completion result/,'result required');
  await rejects(() => rpc(yan,'complete_idea',[idea.id,idea.revision,'maybe',null,null]),/Invalid completion result/,'result enum');
  await rejects(() => rpc(yan,'complete_idea',[idea.id,idea.revision,'success',null,'javascript:alert(1)']),/check constraint/,'URL scheme');
  check((await row(idea.id)).status,'testing','invalid completion rolls back');
  idea = await rpc(yan,'complete_idea',[idea.id,idea.revision,'fail','Previous failed trial','https://example.org/experiment']);
  check([idea.status,idea.result,!!idea.completed_at,idea.notes],['completed','fail',true,'Previous failed trial'],'failed experiment retained');
  await rejects(() => rpc(yan,'complete_idea',[idea.id,idea.revision,'success',null,null]),/Invalid status transition/,'completed result immutable');
  await rejects(() => rpc(yan,'claim_idea',[idea.id]),/already claimed/,'completed cannot be claimed');
  await rejects(() => rpc(yan,'reopen_idea',[idea.id,idea.revision]),/Permission denied/,'PI-only reopen');
  const firstTrial = idea;
  idea = await rpc(shibo,'reopen_idea',[idea.id,idea.revision]);
  check([idea.status,idea.assigned_to,idea.result,idea.notes,idea.completed_at],['available',null,null,null,null],'reopened state');
  const reopened = (await events(idea.id)).at(-1);
  check([reopened.event_type,reopened.previous_state.result,reopened.previous_state.notes,reopened.previous_state.experiment_url],['reopened','fail','Previous failed trial','https://example.org/experiment'],'preserved historical result');
  idea = await rpc(yan,'claim_idea',[idea.id]);
  await rejects(() => rpc(yan,'complete_idea',[idea.id,won.revision,'success',null,null]),/Idea changed/,'stale previous trial rejected');
  idea = await rpc(yan,'release_idea',[idea.id,idea.revision]);
  check(idea.status,'available','assignee release');
  idea = await rpc(junqi,'claim_idea',[idea.id]);
  idea = await rpc(shibo,'release_idea',[idea.id,idea.revision]);
  check(idea.status,'available','PI release another owner');
  idea = await rpc(yifan,'claim_idea',[idea.id]);
  idea = await rpc(shibo,'complete_idea',[idea.id,idea.revision,'success','PI records result',null]);
  check([idea.result,idea.assigned_to],['success',users.Yifan],'PI complete preserves owner');
  const oldRevision = idea.revision;
  idea = await rpc(shibo,'update_idea',[idea.id,idea.revision,'Edited title','Updated details','2026-10-19','medium']);
  check([idea.title,idea.status,idea.result],['Edited title','completed','success'],'PI metadata edit preserves result');
  await rejects(() => rpc(shibo,'update_idea',[idea.id,oldRevision,'Stale','','2026-10-12','low']),/Idea changed/,'stale edit denied');
  await rejects(() => rpc(shibo,'delete_idea',[idea.id,oldRevision]),/Idea changed/,'stale deletion denied');
  await rejects(() => rpc(shibo,'delete_idea',[idea.id,null]),/Idea changed/,'revision cannot be bypassed');
  await rejects(() => rpc(yan,'claim_idea',[randomUUID()]),/Idea not found/,'missing idea');
  await admin.query('update public.profiles set active=false where id=$1',[users.Yan]);
  for (const table of ['profiles','ideas','idea_events']) {
    check((await yan.query(`select * from public.${table}`)).rowCount,0,`revoked member cannot read ${table}`);
  }
  await rejects(() => rpc(yan,'claim_idea',[idea.id]),/Permission denied/,'revoked member cannot mutate');
  await admin.query('update public.profiles set active=true where id=$1',[users.Yan]);
  const eventCount = (await events(idea.id)).length;
  await rpc(shibo,'delete_idea',[idea.id,idea.revision]);
  check(await row(idea.id),undefined,'PI deletion');
  const remainingEvents = await events(idea.id);
  check(remainingEvents.length,eventCount+1,'history survives deletion');
  check(remainingEvents.at(-1).event_type,'deleted','deletion creates the audit notification source');
  check(remainingEvents.at(-1).previous_state.result,'success','deleted result preserved');
  const next = await create(shibo);
  check(Number(next.idea_number)>Number(firstTrial.idea_number),true,'numbers never reused');
  await admin.query(schema);
  check((await row(next.id)).title,next.title,'rerun preserves data');
  const afterRerun = await create(shibo);
  check(Number(afterRerun.idea_number)>Number(next.idea_number),true,'rerun preserves sequence');
  check((await admin.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(r=>r.tablename),['idea_events','ideas','profiles'],'publication tables');
  check(await publicationFlags(),safeFlags,'rerun preserves INSERT/UPDATE-only publication');

  // Inspect actual pgoutput messages, not just catalog flags. This tests the
  // publisher feed used by Realtime; hosted per-subscriber delivery is separate.
  await admin.query("select * from pg_create_logical_replication_slot('tracker_realtime_test','pgoutput')");
  const published = await create(shibo,'Publication stream test');
  const claimed = await rpc(yan,'claim_idea',[published.id]);
  await admin.query('update public.profiles set active=false where id=$1',[users.Junqi]);
  await rpc(shibo,'delete_idea',[published.id,claimed.revision]);
  const messages = (await admin.query(`select data from pg_logical_slot_get_binary_changes(
    'tracker_realtime_test',null,null,'proto_version','1','publication_names','supabase_realtime')`)).rows.map(r=>r.data);
  const ideaOid = (await admin.query("select 'public.ideas'::regclass::oid as oid")).rows[0].oid;
  const eventOid = (await admin.query("select 'public.idea_events'::regclass::oid as oid")).rows[0].oid;
  const rowMessages = messages.filter(data=>['I','U','D'].includes(String.fromCharCode(data[0])));
  check(messages.some(data=>data[0]===68),false,'no DELETE message in actual logical replication output');
  check(messages.some(data=>data[0]===84),false,'no TRUNCATE message in logical replication output');
  check(rowMessages.some(data=>data[0]===73 && data.readUInt32BE(1)===ideaOid),true,'idea INSERT published');
  check(rowMessages.some(data=>data[0]===85 && data.readUInt32BE(1)===ideaOid),true,'idea UPDATE published');
  const deletionEvent = (await events(published.id)).at(-1);
  // Decode the new tuple of each audit INSERT using the table's column order.
  // pgoutput: I + relation OID + N + column count + per-column text/null values.
  const columns = (await admin.query(`select attname from pg_attribute
    where attrelid='public.idea_events'::regclass and attnum>0 and not attisdropped order by attnum`)).rows.map(r=>r.attname);
  const auditInserts = rowMessages.filter(data=>data[0]===73 && data.readUInt32BE(1)===eventOid).map(data=>{
    assert.equal(String.fromCharCode(data[5]),'N');
    const count=data.readUInt16BE(6), values=[]; let offset=8;
    for (let index=0;index<count;index++) {
      const kind=String.fromCharCode(data[offset++]);
      if (kind==='n') values.push(null);
      else {
        assert.equal(kind,'t'); const length=data.readUInt32BE(offset); offset+=4;
        values.push(data.toString('utf8',offset,offset+length)); offset+=length;
      }
    }
    return Object.fromEntries(columns.map((column,index)=>[column,values[index]]));
  });
  const publishedDeletion = auditInserts.find(event=>event.event_type==='deleted' && event.idea_id===published.id);
  check(publishedDeletion?.id,deletionEvent.id,'deletion audit INSERT published');
  check(JSON.parse(publishedDeletion.previous_state).assigned_to,users.Yan,'published audit preserves previous state');
  // The record inserted into the feed is readable by active observers only.
  // Raw logical decoding is an administrator operation, NOT RLS-filtered WebSocket delivery.
  for (const observer of [shibo,yan,yifan]) {
    check((await observer.query('select * from public.idea_events where id=$1',[publishedDeletion.id])).rowCount,1,'active member can read notification source');
    check((await observer.query('select * from public.ideas where id=$1',[published.id])).rowCount,0,'observer refresh sees deletion');
  }
  for (const observer of [outsider,junqi]) {
    for (const table of ['ideas','idea_events','profiles']) {
      check((await observer.query(`select * from public.${table}`)).rowCount,0,'nonmember/deactivated observer sees no restricted rows');
    }
  }
  await rejects(() => anon.query('select * from public.idea_events where id=$1',[publishedDeletion.id]),/permission denied/,'anonymous cannot read deletion snapshot');
  await admin.query('update public.profiles set active=true where id=$1',[users.Junqi]);
  await admin.query("select pg_drop_replication_slot('tracker_realtime_test')");
  check((await admin.query("select count(*)::int n from pg_class where oid in ('public.ideas'::regclass,'public.profiles'::regclass,'public.idea_events'::regclass) and relrowsecurity")).rows[0].n,3,'RLS all tables');
  const acl = await admin.query("select p.proname, has_function_privilege('anon',p.oid,'EXECUTE') as anon, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1)",[['create_idea','update_idea','delete_idea','claim_idea','release_idea','complete_idea','reopen_idea']]);
  check(acl.rowCount,7,'seven RPCs');
  for (const fn of acl.rows) { check(fn.anon,false,`${fn.proname}: anon denied`); check(fn.proconfig.includes('search_path=""'),true,`${fn.proname}: fixed search path`); }

  // Simulate the prior schema's description constraint, including its largest
  // possible four-byte UTF-8 value, then apply the actual upgrade without resets.
  await admin.query(`alter table public.ideas drop constraint ideas_description_check;
    alter table public.ideas add constraint ideas_description_check check (length(description)<=20000)`);
  const legacyText='😀'.repeat(20000);
  const legacyIdea=await rpc(shibo,'create_idea',['Legacy UTF-8 idea',legacyText,'2026-10-12','low']);
  const legacyHistory=(await events(legacyIdea.id)).length;
  await admin.query(schema);
  check((await row(legacyIdea.id)).description,legacyText,'old maximum UTF-8 description survives migration');
  check((await row(legacyIdea.id)).revision,legacyIdea.revision,'description migration does not mutate ideas');
  check((await events(legacyIdea.id)).length,legacyHistory,'migration does not rewrite audit history');
  const markdown='\uFEFF# Markdown idea\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n$$\\alpha_i^2$$\r\n```text\r\n# Kept in source\r\n```\r\n'+'x'.repeat(25000);
  const markdownIdea=await rpc(shibo,'create_idea',['Markdown idea',markdown,'2026-10-12','medium']);
  check(markdownIdea.description,markdown,'full Markdown over old limit stored verbatim');
  check((await events(markdownIdea.id)).at(-1).new_state.description,markdown,'created audit retains Markdown');
  const revised=await rpc(shibo,'update_idea',[markdownIdea.id,markdownIdea.revision,'Edited Markdown',markdown+'\r\nUpdated.','2026-10-12','medium']);
  check(revised.description,markdown+'\r\nUpdated.','PI edits full Markdown');
  check((await events(markdownIdea.id)).at(-1).previous_state.description,markdown,'edit audit retains original Markdown');
  await rejects(()=>rpc(yan,'update_idea',[revised.id,revised.revision,'Unauthorized','Modified Markdown','2026-10-12','medium']),/Permission denied/,'Markdown edit still PI-only');
  await rejects(()=>rpc(shibo,'update_idea',[revised.id,markdownIdea.revision,'Stale Markdown','Stale','2026-10-12','low']),/Idea changed/,'Markdown preserves revision checks');
  const boundary=await rpc(shibo,'create_idea',['Boundary','a'.repeat(102400),'2026-10-12','low']);
  check(boundary.description.length,102400,'100 KiB boundary accepted');
  for (const oversized of ['a'.repeat(102401),'😀'.repeat(25601)]) {
    await rejects(()=>rpc(shibo,'create_idea',['Too large',oversized,'2026-10-12','low']),/ideas_description_check/,'database byte limit rejects oversized source');
  }
  await rejects(()=>rpc(shibo,'update_idea',[revised.id,revised.revision,'Too large','a'.repeat(102401),'2026-10-12','medium']),/ideas_description_check/,'oversized Markdown edit rolls back');
  check((await row(revised.id)).description,revised.description,'rejected edit preserves published Markdown');
  await admin.query(schema);
  check((await row(boundary.id)).description,boundary.description,'schema rerun preserves expanded-limit document');
  check(await publicationFlags(),safeFlags,'Markdown migration retains Realtime DELETE protection');
  console.log(`PASS: ${checks} PostgreSQL checks, including publication WAL filtering and two-connection claim contention. Hosted Supabase was not used.`);
} finally {
  await Promise.allSettled(clients.map(client=>client.end()));
  await db.stop(); await rm(directory,{recursive:true,force:true});
}

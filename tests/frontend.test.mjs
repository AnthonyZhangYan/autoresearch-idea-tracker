// DOM integration tests with an isolated transport double, never hosted Auth/data.
// PostgreSQL permissions/concurrency are tested separately in database.test.mjs.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve,dirname} from 'node:path';
import vm from 'node:vm';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'),'package.json'));
const {JSDOM} = require('jsdom');
// Execute the actual pinned browser libraries, not parser/sanitizer mocks.
const libraryScripts = await Promise.all([
  join(dirname(require.resolve('markdown-it')),'browser/markdown-it.umd.min.js'),
  join(dirname(require.resolve('dompurify')),'purify.min.js'),
  join(dirname(require.resolve('katex')),'katex.min.js'),
  require.resolve('markdown-it-texmath')
].map(path=>readFile(path,'utf8')));
function installMarkdownLibraries(window) {
  window.TextEncoder=TextEncoder; window.TextDecoder=TextDecoder;
  libraryScripts.forEach((source,index)=>window.eval(source + (index===3 ? '\nwindow.texmath=texmath;' : '')));
}
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
new vm.Script(script);
let checks = 1;
function check(actual,expected,label) { assert.deepEqual(actual,expected,label); checks++; }
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const profiles = ['Shibo','Yan','Junqi','Yifan'].map((name,index) => ({id:`member-${index}`,display_name:name,role:index ? 'researcher' : 'pi',active:true}));
const base = {description:'Synthetic test data only. Evaluate the experiment and record its outcome.',week_start:'2026-10-12',priority:'high',created_by:'member-0',revision:1,created_at:'2026-10-12T14:00:00Z',updated_at:'2026-10-12T14:00:00Z'};
let ideas = [
  {...base,id:'idea-1',idea_number:1,title:'Evaluate tool selection instructions'},
  {...base,id:'idea-2',idea_number:2,title:'Compare memory retrieval strategies',priority:'medium',created_by:'member-1'},
  {...base,id:'idea-3',idea_number:3,title:'Measure search quality',priority:'low'},
  {...base,id:'idea-4',idea_number:4,title:'Test retry budgets',week_start:'2026-10-19'},
];
const participation = (idea_id,member_id,extra = {}) => ({idea_id,member_id,status:'testing',result:null,notes:null,experiment_url:null,
  joined_at:'2026-10-12T15:00:00Z',completed_at:null,updated_at:'2026-10-12T15:00:00Z',revision:1,...extra});
const completed = (result,notes = null,experiment_url = null) => ({status:'completed',result,notes,experiment_url,completed_at:'2026-10-13T15:00:00Z',revision:2});
let participants = [
  participation('idea-2','member-1'),
  participation('idea-3','member-1',completed('success','Yan synthetic success')),
  participation('idea-3','member-2',{...completed('fail','Synthetic failed trial — preserve this result.','https://example.org/experiment'),joined_at:'2026-10-12T16:00:00Z'}),
  participation('idea-4','member-3',completed('success')),
];
let comments = [{id:'comment-1',idea_id:'idea-3',author_id:'member-2',body:'Initial **synthetic** note with $x^2$.',
  client_request_id:'00000000-0000-4000-8000-000000000001',created_at:'2026-10-13T16:00:00Z',removed_at:null,removed_by:null}];
let events = [], currentId = 'member-0', authCallback, channel, rpcError, loseNextResponse = false, readsFail = false, delayRead, calls = [], removed = 0, serial = 100;
const session = () => currentId ? {user:{id:currentId},access_token:'synthetic-test-token'} : null;
const rowsFor = table => ({profiles,ideas,idea_participants:participants,idea_comments:comments})[table] || [...events].reverse();
function query(table) {
  const filters = []; let low=0, high=Infinity, limit=Infinity, single=false;
  const builder = {
    select(){return this;},order(){return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},
    lt(key,value){filters.push(row=>Number(row[key])<Number(value));return this;},
    range(from,to){low=from;high=to;return this;},limit(value){limit=value;return this;},maybeSingle(){single=true;return this;},
    async then(resolve,reject) {
      try {
        if (delayRead && table==='ideas') { const delay=delayRead; delayRead=null; await delay; }
        if (readsFail) return resolve({data:null,error:{message:'Network unavailable'}});
        let rows = clone(rowsFor(table));
        rows = rows.filter(row=>filters.every(filter=>filter(row))).slice(low,Math.min(high+1,low+limit));
        resolve({data:single ? rows[0] || null : rows,error:null});
      } catch(error) { reject(error); }
    }
  }; return builder;
}
// Mirrors the V2 RPC rules closely enough for UI tests; the database suite is authoritative.
const ok = data => ({data:clone(data),error:null}), fail = message => ({data:null,error:{message}});
const record = (idea,event_type,previous_state,new_state,member_id = null) => events.push({id:events.length+1,idea_id:idea.id,idea_number:idea.idea_number,
  actor_id:currentId,member_id,event_type,previous_state:clone(previous_state) ?? null,new_state:clone(new_state) ?? null,created_at:'2026-10-16T14:00:00Z'});
function perform(name,args) {
  const idea = ideas.find(i=>i.id===args.p_idea_id);
  const mine = idea && participants.find(p=>p.idea_id===idea.id && p.member_id===currentId);
  if (name==='create_idea') {
    const created = {...base,id:`idea-${serial++}`,idea_number:Math.max(0,...ideas.map(i=>i.idea_number),...events.map(e=>e.idea_number))+1,title:args.p_title,
      description:args.p_description,week_start:args.p_week_start,priority:args.p_priority,created_by:currentId};
    ideas.push(created); record(created,'created',null,created); return ok(created);
  }
  if (name==='remove_comment') {
    const comment = comments.find(c=>c.id===args.p_comment_id && !c.removed_at);
    if (!comment) return fail('Comment not found');
    const before = clone(comment); Object.assign(comment,{removed_at:'2026-10-16T15:00:00Z',removed_by:currentId});
    record(ideas.find(i=>i.id===comment.idea_id),'comment_removed',before,comment); return ok(comment);
  }
  if (!idea) return fail('Idea not found');
  if (name==='update_idea') {
    if (idea.revision!==args.p_expected_revision) return fail('Idea changed. Refresh and try again');
    const before = clone(idea);
    Object.assign(idea,{title:args.p_title,description:args.p_description,week_start:args.p_week_start,priority:args.p_priority,revision:idea.revision+1});
    record(idea,'edited',before,idea); return ok(idea);
  }
  if (name==='delete_idea') {
    const before = {...clone(idea),participants:clone(participants.filter(p=>p.idea_id===idea.id)),comments:clone(comments.filter(c=>c.idea_id===idea.id))};
    ideas = ideas.filter(i=>i!==idea); participants = participants.filter(p=>p.idea_id!==idea.id); comments = comments.filter(c=>c.idea_id!==idea.id);
    record(idea,'deleted',before,null); return {data:null,error:null};
  }
  if (name==='join_idea') {
    if (mine && mine.status!=='withdrawn') return fail('Already participating in this idea');
    const before = clone(mine);
    const joined = mine ? Object.assign(mine,{status:'testing',revision:mine.revision+1}) : participation(idea.id,currentId,{joined_at:'2026-10-16T14:00:00Z'});
    if (!mine) participants.push(joined);
    record(idea,mine ? 'rejoined' : 'joined',before,joined,currentId); return ok(joined);
  }
  if (name==='leave_idea' || name==='submit_result') {
    if (!mine) return fail('Participation not found');
    if (mine.revision!==args.p_expected_revision) return fail('Participation changed. Refresh and try again');
    if (mine.status!=='testing') return fail('Invalid status transition');
    const before = clone(mine);
    Object.assign(mine,name==='leave_idea' ? {status:'withdrawn'} : {status:'completed',result:args.p_result,notes:args.p_notes || null,
      experiment_url:args.p_experiment_url || null,completed_at:'2026-10-16T14:00:00Z'},{revision:mine.revision+1});
    record(idea,name==='leave_idea' ? 'withdrew' : 'result_submitted',before,mine,currentId); return ok(mine);
  }
  if (name==='reopen_result') {
    const target = participants.find(p=>p.idea_id===idea.id && p.member_id===args.p_member_id);
    if (!target) return fail('Participation not found');
    if (target.revision!==args.p_expected_revision) return fail('Participation changed. Refresh and try again');
    const before = clone(target);
    Object.assign(target,{status:'testing',result:null,notes:null,experiment_url:null,completed_at:null,revision:target.revision+1});
    record(idea,'result_reopened',before,target,target.member_id); return ok(target);
  }
  if (name==='add_comment') {
    const existing = comments.find(c=>c.author_id===currentId && c.client_request_id===args.p_client_request_id);
    if (existing) return ok(existing);
    const comment = {id:`comment-${serial++}`,idea_id:idea.id,author_id:currentId,body:args.p_body,client_request_id:args.p_client_request_id,
      created_at:'2026-10-16T14:30:00Z',removed_at:null,removed_by:null};
    comments.push(comment); record(idea,'commented',null,comment); return ok(comment);
  }
  throw new Error(`Unexpected RPC ${name}`);
}
const client = {
  from:query,
  auth:{
    onAuthStateChange(callback){authCallback=callback;setTimeout(()=>callback('INITIAL_SESSION',session()),0);},
    async signInWithPassword(){return {error:{message:'Invalid login credentials'}};},
    async getSession(){return {data:{session:session()},error:null};},
    async signOut(){currentId=null;setTimeout(()=>authCallback('SIGNED_OUT',null),0);return {error:null};}
  },
  realtime:{async setAuth(){}},
  channel(){ channel={handlers:[],on(type,filter,callback){this.handlers.push({filter,callback});return this;},subscribe(callback){this.status=callback;setTimeout(()=>callback('SUBSCRIBED'),0);return this;}}; return channel; },
  async removeChannel(){removed++;},
  async rpc(name,args){
    calls.push({name,args:clone(args)});
    if (rpcError) return {data:null,error:rpcError};
    const result = perform(name,args);
    // Simulates a committed request whose response never arrived.
    if (loseNextResponse && !result.error) { loseNextResponse = false; return {data:null,error:{message:'Failed to fetch'}}; }
    return result;
  }
};
const dom = new JSDOM(html,{url:'http://127.0.0.1:8765/autoresearch-idea-tracker/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
installMarkdownLibraries(w);
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.supabase={createClient:()=>client};
w.eval(script+'\nwindow.__app = {state,loadIdeas,loadCurrentUser,renderDashboard,openIdeaDialog,openResultDialog,confirmAction,joinIdea,mutate,openHistory,safeURL,closeModal,filteredIdeas,renderMarkdown,suggestedMarkdownTitle,readMarkdownFile};');
const app=w.__app;
const wait=async condition=>{for(let n=0;n<200;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for DOM test condition');};
const click = id => d.getElementById(id).click();
const submit = () => d.querySelector('#modal-body form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
const text = id => d.getElementById(id).textContent;
const card = number => [...d.querySelectorAll('.idea')].find(el=>el.querySelector('.idea-number').textContent===number);
const labels = element => [...element.querySelectorAll('button')].map(b=>b.textContent);
const press = (element,label) => [...element.querySelectorAll('button')].find(b=>b.textContent===label).click();
const settled = () => wait(()=>!app.state.pending && !app.state.refreshTask);
const ideaById = id => app.state.ideas.find(i=>i.id===id);
const rowOf = (ideaId,memberId) => app.state.participants.find(p=>p.idea_id===ideaId && p.member_id===memberId);
async function snapshot(name) {
  if (!process.env.TRACKER_PREVIEW_DIR) return;
  const copy=d.documentElement.cloneNode(true);
  copy.querySelectorAll('script').forEach(el=>el.remove());
  const originals=[...d.querySelectorAll('input,textarea,select')];
  copy.querySelectorAll('input,textarea,select').forEach((control,index)=>{
    const original=originals[index];
    if(control.tagName==='TEXTAREA') control.textContent=original.value;
    else if(control.tagName==='SELECT') [...control.options].forEach(option=>option.toggleAttribute('selected',option.value===original.value));
    else if(control.type!=='file') {control.setAttribute('value',original.value);control.toggleAttribute('checked',original.checked);}
  });
  copy.querySelector('.brand').textContent='LOCAL TEST FIXTURE · Synthetic data';
  copy.querySelector('#notifications').replaceChildren();
  if (copy.querySelector('#modal').open) {
    const openDialog=copy.ownerDocument.createElement('script');
    openDialog.textContent='const dialog=document.getElementById("modal");dialog.removeAttribute("open");dialog.showModal();';
    copy.querySelector('body').append(openDialog);
    copy.querySelector('#modal-title').textContent='Local test · '+copy.querySelector('#modal-title').textContent;
  }
  await mkdir(process.env.TRACKER_PREVIEW_DIR,{recursive:true});
  await writeFile(join(process.env.TRACKER_PREVIEW_DIR,name),'<!doctype html>\n'+copy.outerHTML);
}
try {
  await wait(()=>app.state.loaded && app.state.live);
  check(d.getElementById('dashboard').hidden,false,'authorized dashboard');
  check(text('identity'),'Logged in as Shibo','profile identity');
  check(text('connection'),'Connected','subscription status');
  check([...d.querySelectorAll('.stat-label')].map(el=>el.textContent),['Total ideas','Open','In progress','With results','Success results','Fail results'],'V2 counters');
  check([...d.querySelectorAll('.stat-value')].map(el=>el.textContent),['4','1','1','2','2','1'],'counts derived from participants');
  check(text('progress-percent'),'50%','share of ideas with results');
  check(text('progress-text'),'2 / 4 ideas have results','progress label');
  check(d.querySelectorAll('.week').length,2,'weekly groups');
  check(channel.handlers.map(h=>h.filter.table),['ideas','idea_events','profiles'],'subscribed tables');
  check(channel.handlers.every(h=>h.filter.event==='*'),true,'all change types');
  check(d.getElementById('create-button').hidden,false,'PI can publish');
  click('expand-all');
  check([...d.querySelectorAll('.idea,.week')].every(el=>el.open),true,'expand all');
  await snapshot('dashboard.html');
  click('collapse-all');check([...d.querySelectorAll('.idea,.week')].every(el=>!el.open),true,'collapse all');
  const setFilter=(id,value)=>{d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new w.Event(id==='search'?'input':'change'));};
  for (const [id,value,expected] of [['search','IDEA-003',1],['search','retrieval',1],['search','synthetic',4],['status-filter','open',1],['status-filter','testing',1],
    ['status-filter','results',2],['member-filter','member-1',2],['member-filter','none',1],['result-filter','fail',1],['result-filter','success',2],
    ['result-filter','none',2],['priority-filter','high',2],['week-filter','2026-10-19',1]]) {
    click('clear-filters');setFilter(id,value);check(d.querySelectorAll('.idea').length,expected,`filter ${id}=${value}`);
  }
  click('clear-filters');setFilter('search','no-matching-idea');check(text('ideas').includes('No ideas match'),true,'empty search');click('clear-filters');
  setFilter('sort','number');check(app.filteredIdeas()[0].idea_number,1,'number sort');
  check(app.safeURL('javascript:alert(1)'),null,'unsafe URL blocked');
  check(app.safeURL('https://example.org/test'),'https://example.org/test','HTTPS URL');
  ideas[0].description='<img src=x onerror=alert(1)><script>evil</script>';
  await app.loadIdeas();check(d.querySelectorAll('.idea-body img,.idea-body script').length,0,'untrusted content is text');
  check(text('ideas').includes('<img src=x'),true,'text not stripped or interpreted');
  ideas[0].description=base.description;

  // ---- Independent participants on one idea.
  await app.loadIdeas();
  let c3 = card('IDEA-003');
  check(c3.querySelector('.summary-assignee').textContent,'Yan, Junqi · 1 comment','participants and comment count summarized on the card');
  check([...c3.querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 success','1 fail'],'aggregated badges');
  check([...c3.querySelectorAll('.participant')].map(li=>[li.querySelector('.participant-name').textContent,[...li.querySelectorAll('.badge')].map(b=>b.textContent).join('/')]),
    [['Yan','Completed/Success'],['Junqi','Completed/Fail']],'each participant shows their own status and result');
  check(c3.textContent.includes('Synthetic failed trial'),true,'participant notes shown');
  check(c3.querySelector('.participant a[href]').getAttribute('rel'),'noopener noreferrer','safe experiment link');
  check(labels(c3).filter(l=>l==='Reopen result').length,2,'PI can reopen each result');
  check(c3.querySelector('.discussion-head h3').textContent,'Discussion (1)','comment count on card');
  check([...card('IDEA-001').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['Open'],'idea without participants is open');
  check(card('IDEA-001').querySelector('.summary-assignee').textContent,'No participants','empty participant summary');
  check(card('IDEA-002').textContent.includes('Published by'),true,'creator shown');

  // ---- Publish and edit (creator or PI).
  app.openIdeaDialog();
  const form=d.querySelector('#modal-body form');
  form.querySelector('input[type=text]').value='Created through form';
  form.querySelector('input[type=date]').value='2026-10-13';submit();
  check(d.querySelector('#modal-body .error-text').textContent.includes('Monday'),true,'Monday form validation');
  check(calls.length,0,'invalid input makes no RPC');
  form.querySelector('input[type=date]').value='2026-10-12';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).name,'create_idea','publish RPC');
  check(app.state.ideas.length,5,'publish refetch');
  let created=app.state.ideas.find(i=>i.title==='Created through form');
  app.openIdeaDialog(created);d.querySelector('#modal-body input[type=text]').value='Revised test idea';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_expected_revision,created.revision,'edit revision');

  // ---- Join, then submit only my own result.
  press(card('IDEA-001'),'Join idea');
  await wait(()=>rowOf('idea-1','member-0'));await settled();
  check(calls.at(-1),{name:'join_idea',args:{p_idea_id:'idea-1'}},'join RPC takes only the idea');
  check(labels(card('IDEA-001')).includes('Join idea'),false,'join hidden once participating');
  check(labels(card('IDEA-001')).includes('Submit my result'),true,'own testing row offers result submission');
  press(card('IDEA-001'),'Submit my result');
  check(text('modal-title'),'Submit my result','result dialog');
  d.querySelector('input[value=fail]').checked=true;
  d.querySelector('#modal-body textarea').value='Synthetic notes';
  d.querySelector('input[type=url]').value='javascript:alert(1)';submit();
  check(d.querySelector('#modal-body .error-text').textContent.includes('HTTP(S)'),true,'result URL validation');
  d.querySelector('input[type=url]').value='https://example.org/trial';
  await snapshot('result.html');submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'submit_result','submit result RPC');
  check(Object.keys(calls.at(-1).args),['p_idea_id','p_expected_revision','p_result','p_notes','p_experiment_url'],'no member argument: only the caller row can change');
  check(calls.at(-1).args.p_result,'fail','submitted result');
  check([...card('IDEA-003').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 success','1 fail'],'other ideas and members unaffected');

  // ---- A second member's view: own result only, no PI controls.
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  check(text('identity'),'Logged in as Yan','researcher session');
  check(d.getElementById('create-button').hidden,false,'researchers can publish');
  check(labels(d.getElementById('ideas')).includes('Delete'),false,'researcher cannot delete');
  check(labels(d.getElementById('ideas')).filter(l=>l==='Edit').length,app.state.ideas.filter(i=>i.created_by==='member-1').length,'edit only own ideas');
  check(labels(d.getElementById('ideas')).includes('Reopen result'),false,'researcher cannot reopen results');
  check(labels(card('IDEA-001')).includes('Submit my result'),false,'cannot submit into another member row');
  check(labels(card('IDEA-002')).includes('Submit my result'),true,'own testing row actionable');
  press(card('IDEA-002'),'Submit my result');d.querySelector('input[value=success]').checked=true;submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).args.p_idea_id,'idea-2','Yan submits on her own idea');
  check([rowOf('idea-1','member-0').result,rowOf('idea-2','member-1').result],['fail','success'],'two members keep independent results');
  currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- PI reopens exactly one member's result.
  const yanRow=rowOf('idea-3','member-1');
  app.confirmAction('reopen',ideaById('idea-3'),yanRow);
  check(text('modal-title'),'Reopen Yan’s result?','reopen confirmation names the member');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1),{name:'reopen_result',args:{p_idea_id:'idea-3',p_member_id:'member-1',p_expected_revision:yanRow.revision}},'reopen targets one member row');
  check([...card('IDEA-003').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 testing','1 fail'],'Junqi result kept after Yan reopened');

  // ---- Leave and rejoin.
  press(card('IDEA-004'),'Join idea');await wait(()=>rowOf('idea-4','member-0'));await settled();
  press(card('IDEA-004'),'Leave');check(text('modal-title'),'Leave IDEA-004?','leave confirmation');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'leave_idea','leave RPC');
  check(Object.keys(calls.at(-1).args),['p_idea_id','p_expected_revision'],'leave affects only the caller');
  check(labels(card('IDEA-004')).includes('Rejoin idea'),true,'withdrawn member can rejoin');
  check(card('IDEA-004').querySelector('.summary-assignee').textContent,'Yifan','withdrawn member hidden from card');

  // ---- Deletion keeps history.
  created=ideaById(created.id);
  app.confirmAction('delete',created);submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'delete_idea','delete RPC');check(app.state.ideas.length,4,'delete refetch');
  app.openHistory();await wait(()=>d.querySelectorAll('.history li').length>0);
  for (const phrase of ['submitted a result','Synthetic notes','reopened Yan’s result','Yan synthetic success','left the idea','joined the idea','deleted the idea','Preserved: 0 participants'])
    check(text('modal-body').includes(phrase),true,`history shows: ${phrase}`);
  app.closeModal();

  // ---- Inline discussion under each idea: no modal, Markdown/LaTeX, drafts, paging.
  const thread = number => card(number).querySelector('[data-slot="thread"]');
  const composerOf = number => card(number).querySelector('.comment-input');
  const postIn = number => card(number).querySelector('.composer').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const composerError = number => card(number).querySelector('.composer .error-text').textContent;
  const type = (number,value) => { const input=composerOf(number); input.value=value; input.dispatchEvent(new w.Event('input')); };
  const openCard = number => { const el=card(number); if (!el.open) { el.open=true; el.dispatchEvent(new w.Event('toggle')); } };
  check([...d.querySelectorAll('.idea')].every(el=>el.querySelector('.discussion .composer .comment-input')),true,'every idea card has an inline composer');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (1)','discussion heading shows the count');
  check(card('IDEA-003').querySelector('.idea-meta').textContent.includes('1 comment'),true,'comment count in the card meta row');
  openCard('IDEA-003');
  await wait(()=>thread('IDEA-003').querySelector('.comment'));
  const first=thread('IDEA-003').querySelector('.comment');
  check([first.querySelector('.comment-head strong').textContent,first.querySelector('.comment-avatar').textContent,first.querySelector('.markdown-body strong')?.textContent,!!first.querySelector('.katex')],
    ['Junqi','J','synthetic',true],'comment shows author, avatar, Markdown and math inline');
  const stamp=first.querySelector('time');
  check([stamp.dateTime,stamp.title.length>0,stamp.textContent.length>0],['2026-10-13T16:00:00Z',true,true],'relative time with exact timestamp');
  check(d.getElementById('modal').open,false,'reading comments needs no dialog');
  const callsBeforeComment=calls.length;
  postIn('IDEA-003');check(composerError('IDEA-003'),'Write a comment before posting.','empty comment rejected');
  type('IDEA-003','x'.repeat(20481));postIn('IDEA-003');check(composerError('IDEA-003').includes('20 KiB'),true,'oversized comment rejected');
  check(calls.length,callsBeforeComment,'invalid comments make no RPC');
  const commentText='## Proposal\n\n$$\\alpha_i$$ <img src=x onerror=alert(1)> [x](javascript:alert(1))';
  type('IDEA-003',commentText);
  press(card('IDEA-003').querySelector('.composer'),'Preview');
  await wait(()=>card('IDEA-003').querySelector('.composer .markdown-preview h2'));
  check([!!card('IDEA-003').querySelector('.composer .markdown-preview .katex'),card('IDEA-003').querySelector('.composer .markdown-preview').hidden],[true,false],'composer preview renders math');
  loseNextResponse=true;postIn('IDEA-003');await settled();
  const firstAttempt=calls.at(-1).args;
  check([calls.at(-1).name,composerOf('IDEA-003').value],['add_comment',commentText],'draft kept after an uncertain failure');
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firstAttempt.p_client_request_id),true,'request ID is a UUID');
  postIn('IDEA-003');await settled();
  check(calls.at(-1).args.p_client_request_id,firstAttempt.p_client_request_id,'retry reuses the request ID');
  check(comments.filter(c=>c.body===commentText).length,1,'lost response plus retry posts once');
  check([composerOf('IDEA-003').value,d.getElementById('modal').open],['',false],'composer clears after posting, without any dialog');
  await wait(()=>thread('IDEA-003').querySelectorAll('.comment').length===2);
  const posted=[...thread('IDEA-003').querySelectorAll('.comment')].at(-1);
  check([posted.querySelector('.comment-head strong').textContent,!!posted.querySelector('h2'),!!posted.querySelector('.katex')],['Shibo',true,true],'new comment appears at the end of the thread');
  check(posted.querySelector('img,script,[onerror],a[href^="javascript"]'),null,'comment XSS inert');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (2)','count updated');

  // Realtime while typing: new comments appear, the focused draft is untouched.
  type('IDEA-003','Draft in progress');
  const typing=composerOf('IDEA-003');typing.focus();typing.setSelectionRange(5,5);
  const requestBeforeRefresh=app.state.commentDrafts.get('idea-3').requestId;
  currentId='member-1';await client.rpc('add_comment',{p_idea_id:'idea-3',p_body:'Remote reply while typing',p_client_request_id:'00000000-0000-4000-8000-000000000042'});currentId='member-0';
  await app.loadIdeas();
  check([composerOf('IDEA-003')===typing,typing.value,d.activeElement===typing,typing.selectionStart],[true,'Draft in progress',true,5],'refresh keeps the same textarea, text, focus and caret');
  check(thread('IDEA-003').textContent.includes('Remote reply while typing'),true,'remote comment appears while typing');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (3)','count updates while typing');
  check(app.state.renderPending,true,'structural rebuild deferred while typing');
  typing.blur();
  await app.loadIdeas();
  check([composerOf('IDEA-003')!==typing,composerOf('IDEA-003').value,app.state.commentDrafts.get('idea-3').requestId],[true,'Draft in progress',requestBeforeRefresh],'rebuilt card restores the draft and its request ID');
  type('IDEA-003','');

  // Sorting and "Load more".
  for (let n=0;n<22;n++) comments.push({id:`bulk-${String(n).padStart(2,'0')}`,idea_id:'idea-2',author_id:`member-${n%4}`,body:`Bulk comment ${n}`,
    client_request_id:`00000000-0000-4000-8000-0000000001${String(n).padStart(2,'0')}`,created_at:`2026-10-14T10:${String(n).padStart(2,'0')}:00Z`,removed_at:null,removed_by:null});
  await app.loadIdeas();openCard('IDEA-002');
  const bodies=()=>[...thread('IDEA-002').querySelectorAll('.comment .markdown-body')].map(el=>el.textContent.trim());
  await wait(()=>bodies().length===10);
  check([bodies()[0],bodies().at(-1)],['Bulk comment 12','Bulk comment 21'],'oldest-first shows the latest page chronologically');
  check(thread('IDEA-002').firstChild.textContent,'Show 10 earlier comments','load earlier control above the thread');
  thread('IDEA-002').firstChild.click();
  check(bodies().length,20,'second page loaded');
  thread('IDEA-002').firstChild.click();
  check([bodies().length,bodies()[0],thread('IDEA-002').querySelector('.more-comments')],[22,'Bulk comment 0',null],'all comments loaded; control removed');
  const sort=card('IDEA-002').querySelector('.discussion-head select');sort.value='newest';sort.dispatchEvent(new w.Event('change'));
  check([bodies()[0],bodies().at(-1)],['Bulk comment 21','Bulk comment 0'],'newest-first ordering');
  check(card('IDEA-002').querySelector('.discussion-head h3').textContent,'Discussion (22)','count with many comments');

  // PI removal inline; researchers see no Remove control.
  w.confirm=()=>true;
  press(thread('IDEA-003').querySelector('.comment'),'Remove');
  await wait(()=>thread('IDEA-003').querySelector('.comment.removed'));await settled();
  check(calls.at(-1),{name:'remove_comment',args:{p_comment_id:'comment-1'}},'PI removes a comment inline');
  check(thread('IDEA-003').querySelector('.comment.removed').textContent.includes('Comment removed by Shibo'),true,'removed comment placeholder');
  check(thread('IDEA-003').querySelector('.comment.removed .markdown-body'),null,'removed body hidden in UI');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (2)','count excludes removed comment');
  click('expand-all');
  await snapshot('discussion.html');
  click('collapse-all');
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  openCard('IDEA-003');await wait(()=>thread('IDEA-003').querySelector('.comment'));
  check(labels(thread('IDEA-003')).includes('Remove'),false,'researchers cannot remove comments');
  check(app.state.commentDrafts.size,0,'drafts never carry over to another account');
  currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- Conflicts, refresh coalescing, stale and offline states.
  rpcError={message:'Already participating in this idea'};
  await app.joinIdea(ideaById('idea-2'));check(text('notifications').includes('already participating'),true,'conflict notification');rpcError=null;
  let releaseRead;delayRead=new Promise(resolve=>releaseRead=resolve);
  const refresh=app.loadIdeas();const again=app.loadIdeas();check(refresh===again,true,'duplicate refresh coalescing');releaseRead();await refresh;
  readsFail=true;await app.loadIdeas();check(app.state.stale,true,'stale state surfaced');
  check(d.getElementById('sync-banner').hidden,false,'stale banner');
  check(d.getElementById('create-button').disabled,true,'stale mutations disabled');readsFail=false;await app.loadIdeas();
  check(app.state.stale,false,'successful refresh clears stale');
  Object.defineProperty(w.navigator,'onLine',{configurable:true,value:false});w.dispatchEvent(new w.Event('offline'));
  check(text('connection'),'Offline','offline indicator');check(d.getElementById('create-button').disabled,true,'offline mutations paused');
  Object.defineProperty(w.navigator,'onLine',{configurable:true,value:true});w.dispatchEvent(new w.Event('online'));await wait(()=>app.state.live);
  check(removed>0,true,'old channel cleaned up');
  currentId='member-1';await app.loadCurrentUser(session());

  // Two receiving frontends, neither of which submits the remote mutations.
  // Disable periodic polling so only the delivered idea_events INSERTs can
  // cause these refreshes. Transport delivery is simulated, not hosted Realtime.
  await wait(()=>app.state.live && !app.state.refreshTask);
  w.clearInterval(app.state.pollTimer);
  const firstChannel=channel;
  const observerDOM=new JSDOM(html,{url:'http://127.0.0.1:8765/',runScripts:'outside-only',pretendToBeVisual:true});
  const observerWindow=observerDOM.window;
  installMarkdownLibraries(observerWindow);
  observerWindow.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  observerWindow.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let observerChannel;
  observerWindow.supabase={createClient:()=>({
    ...client,
    auth:{...client.auth,onAuthStateChange(callback){setTimeout(()=>callback('INITIAL_SESSION',{user:{id:'member-3'},access_token:'observer-test-token'}),0);}},
    channel(){observerChannel=client.channel();return observerChannel;}
  })};
  observerWindow.eval(script+'\nwindow.__app = {state};');
  try {
    await wait(()=>observerWindow.__app.state.loaded && observerWindow.__app.state.live && !observerWindow.__app.state.refreshTask);
    observerWindow.clearInterval(observerWindow.__app.state.pollTimer);
    const receivers=[app.state,observerWindow.__app.state];
    check(receivers.map(s=>s.userId),['member-1','member-3'],'independent authorized receiver identities');
    const deliverEvent=()=>{
      for (const receiver of [firstChannel,observerChannel]) {
        receiver.handlers.filter(h=>h.filter.table==='idea_events').forEach(h=>h.callback({schema:'public',table:'idea_events',eventType:'INSERT',new:clone(events.at(-1))}));
      }
    };
    const remote=async (member,name,args)=>{currentId=member;const result=await client.rpc(name,args);currentId='member-1';return result;};
    await remote('member-2','join_idea',{p_idea_id:'idea-1'});
    check(receivers.every(s=>!s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2')),true,'receivers unchanged before delivery');
    deliverEvent();
    await wait(()=>receivers.every(s=>s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2')));
    check(true,true,'remote join reaches both receivers through the audit INSERT');
    const junqiRow=participants.find(p=>p.idea_id==='idea-1' && p.member_id==='member-2');
    await remote('member-2','submit_result',{p_idea_id:'idea-1',p_expected_revision:junqiRow.revision,p_result:'success',p_notes:null,p_experiment_url:null});
    deliverEvent();
    await wait(()=>receivers.every(s=>s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2' && p.result==='success')));
    check(receivers.every(s=>s.participants.find(p=>p.idea_id==='idea-1' && p.member_id==='member-0')?.result==='fail'),true,'remote result leaves Shibo result intact');
    await remote('member-2','add_comment',{p_idea_id:'idea-1',p_body:'Remote comment',p_client_request_id:'00000000-0000-4000-8000-000000000099'});
    deliverEvent();
    await wait(()=>receivers.every(s=>s.commentCounts.get('idea-1')===1));
    check(true,true,'remote comment count reaches both receivers');
    const target=ideas.find(i=>i.id==='idea-1');
    await remote('member-0','delete_idea',{p_idea_id:'idea-1',p_expected_revision:target.revision});
    check(events.at(-1).event_type,'deleted','remote deletion audit source');
    deliverEvent();
    await wait(()=>receivers.every(s=>!s.ideas.some(i=>i.id==='idea-1')));
    check(receivers.every(s=>!s.participants.some(p=>p.idea_id==='idea-1')),true,'audit INSERT alone removes deleted idea and its participants');
    check([d,observerWindow.document].every(doc=>!doc.getElementById('ideas').textContent.includes('Evaluate tool selection')),true,'both rendered lists remove deleted idea');
  } finally { observerWindow.close(); }

  await app.loadCurrentUser({user:{id:'outsider'},access_token:'test'});
  check(d.getElementById('dashboard').hidden,true,'unauthorized cannot enter dashboard');
  check(text('access-title'),'Access has not been granted','allowlist denial');
  check(d.querySelectorAll('.idea').length,0,'previous account data cleared');
  check(app.state.participants.length,0,'previous participant data cleared');
  currentId='member-0';await app.loadCurrentUser(session());

  const markdown = '\uFEFF# Suggested **research** title\r\n\r\n## Method\r\n- **Bold** and *italic*\r\n- ~~Discarded~~\r\n\r\n| Model | Score |\r\n| --- | --- |\r\n| A | $x_i^2$ |\r\n\r\nInline $\\alpha_i+\\beta$ and [paper](https://example.org/paper).\r\n\r\n$$\r\n\\begin{aligned} a &= b \\\\ c &= \\sqrt{x} \\end{aligned}\r\n$$\r\n\r\n```python\r\n# Not another idea\r\nprint("$literal$")\r\n```\r\n\r\n# A second H1 stays in the same idea\r\n\r\n$$x$$ trailing explanation\r\n\r\n$$\\text{cost: \\$5}$$\r\n';
  const rendered=d.createElement('div');app.renderMarkdown(rendered,markdown);
  check(rendered.querySelector('h1').textContent,'Suggested research title','Markdown H1 rendered');
  check(rendered.querySelectorAll('h1').length,2,'multiple headings kept in one document');
  check(rendered.querySelectorAll('table tbody tr').length,1,'GFM table rendered');
  check(!!rendered.querySelector('ul li strong') && !!rendered.querySelector('em') && !!rendered.querySelector('s'),true,'lists, emphasis and strikethrough');
  check(rendered.querySelectorAll('.katex').length,5,'inline/table/display math rendered by actual KaTeX');
  check(rendered.querySelectorAll('.katex-display').length,3,'display math');
  check(rendered.querySelector('pre code').textContent.includes('$literal$'),true,'code dollar signs not rendered as math');
  check(rendered.querySelector('a').getAttribute('rel'),'noopener noreferrer','safe external link');
  check(rendered.querySelector('a').getAttribute('target'),'_blank','external link tab');
  check(app.suggestedMarkdownTitle(markdown,'fallback.md').title,'Suggested research title','first H1 suggestion');
  check(app.suggestedMarkdownTitle('```md\n# Fake H1\n```\n\nReal title\n==========','fallback.md').title,'Real title','Setext H1 and fenced heading exclusion');
  check(app.suggestedMarkdownTitle('    # Code only\n\n## Second level','fallback.MD').title,'fallback','no H1 uses filename');
  check(app.suggestedMarkdownTitle('# '+ 'a'.repeat(210),'fallback.md').title.length,200,'long suggested title is bounded');
  app.renderMarkdown(rendered,'Escaped \\$5 and `$$not_math$$`.\n\n$$\\def\\loop{\\loop}\\loop$$');
  check(rendered.textContent.includes('$5') && rendered.querySelector('code').textContent==='$$not_math$$',true,'escaped dollar and inline code');
  check(!!rendered.querySelector('.katex-error'),true,'malformed/infinite math fails safely');
  app.renderMarkdown(rendered,'$\\gdef\\leak{123}\\leak$ then $\\leak$');
  check(rendered.textContent.includes('\\leak'),true,'macros do not leak between expressions');
  // Regressions: capture source passed to the real KaTeX engine (DOMPurify
  // removes annotation nodes), then inspect the sanitized result and prose.
  const mathCases = [
    ['$$x$$ trailing explanation', ['x'], 1, ['trailing explanation']],
    [String.raw`$$\text{cost: \$5}$$`, [String.raw`\text{cost: \$5}`], 1, []],
    ['before $$x$$ after $y$ end', ['x','y'], 1, ['before','after','end']],
    ['$$x$$ between $$y$$ trailing', ['x','y'], 2, ['between','trailing']],
    ['$$x$$$$y$$ adjacent', ['x','y'], 2, ['adjacent']],
    [String.raw`$\text{cost: \$5}$ and $z$`, [String.raw`\text{cost: \$5}`,'z'], 0, ['and']],
    [String.raw`$$\text{cost: \$5 and \$10}$$ (1) explanation`, [String.raw`\text{cost: \$5 and \$10}`], 1, ['(1)','explanation']],
    [String.raw`$$\{x\}\quad 50\%\quad a\_b$$ tail`, [String.raw`\{x\}\quad 50\%\quad a\_b`], 1, ['tail']],
    ['$$\n\\begin{aligned}a &= b \\\\\nc &= d\\end{aligned}\n$$ closing explanation\n\n# Next heading', ['\n\\begin{aligned}a &= b \\\\\nc &= d\\end{aligned}\n'], 1, ['closing explanation','Next heading']],
    ['$$\nx+1\n\n+y\n$$ trailing after blank line', ['\nx+1\n\n+y\n'], 1, ['trailing after blank line']],
    ['$$x$$\nnext line $y$\n\n$$z$$ final line', ['x','y','z'], 2, ['next line','final line']],
    ['> $$x+1$$ quoted tail', ['x+1'], 1, ['quoted tail']],
    ['- $$x$$ list tail $y$', ['x','y'], 1, ['list tail']],
    [String.raw`$$\$$$ escaped dollar at end`, [String.raw`\$`], 1, ['escaped dollar at end']],
    [String.raw`$\$$ inline escaped dollar`, [String.raw`\$`], 0, ['inline escaped dollar']],
    [String.raw`$$x\\$$ even backslashes before delimiter`, [String.raw`x\\`], 1, ['even backslashes before delimiter']],
    [String.raw`Escaped \$5, $x$ and \$10.`, ['x'], 0, ['$5', '$10']],
    [String.raw`$$\text{slash: \\}$$ tail`, [String.raw`\text{slash: \\}`], 1, ['tail']],
  ];
  for (const [source, formulas, displays, prose] of mathCases) {
    const mathEngine=w.katex.renderToString, received=[];
    w.katex.renderToString=(tex,options)=>{received.push(tex);return mathEngine(tex,options);};
    try { app.renderMarkdown(rendered,source); } finally { w.katex.renderToString=mathEngine; }
    check(received,formulas,`complete TeX reaches KaTeX: ${source}`);
    check(rendered.querySelectorAll('.katex-display').length,displays,'inline/display modes retained');
    check(rendered.querySelector('.katex-error,.markdown-notice'),null,'valid escaped and multiline math renders without fallback');
    check(prose.every(part=>rendered.textContent.includes(part)),true,`adjacent prose retained: ${source}`);
    check((await app.readMarkdownFile(new w.File([source],'math.md'))).source,source,'math import preserves the complete original source');
  }
  app.renderMarkdown(rendered,'Unclosed $$x and tail\n\n`$$literal$$`\n\n```tex\n$$\\text{cost: \\$5}$$\n```');
  check(rendered.textContent.includes('Unclosed $$x and tail'),true,'unclosed display delimiters remain visible');
  check([...rendered.querySelectorAll('code')].map(el=>el.textContent),['$$literal$$','$$\\text{cost: \\$5}$$\n'],'code math and escapes remain literal');
  const attacks=[
    '$$x$$ <img src=x onerror=evil> [bad](javascript:evil)',
    String.raw`$$\text{cost: \$5}$$ <script>evil</script>`,
    '<script>alert(1)</script><img src=x onerror=alert(2)><svg onload=alert(3)></svg>',
    '[bad](javascript:alert(1)) [data](data:text/html,evil) [encoded](java&#x73;cript:alert(1))',
    '<form id=modal><input name=state></form><iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '$\\href{javascript:alert(1)}{bad}$ $\\includegraphics{https://example.org/tracker}$ $\\htmlStyle{background:url(https://example.org/tracker)}{x}$',
    '![Tracking](https://example.org/tracker.png) [relative](./secret.md)',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">'
  ];
  for (const attack of attacks) {
    app.renderMarkdown(rendered,attack);
    check(rendered.querySelector('script,img,iframe,form,input,style,object,embed,[onerror],[onload],[id],[name]'),null,'XSS/DOM clobbering payload inert');
    check([...rendered.querySelectorAll('[href],[src]')].every(el=>/^https?:/.test(el.getAttribute('href') || el.getAttribute('src'))),true,'unsafe URLs stripped');
  }
  // Verify the actual sanitizer runs after rendering. Then force unsafe math
  // renderer output to exercise the final sanitizer independently of the parser.
  const originalSanitize=w.DOMPurify.sanitize;let sanitizerCalls=0;
  w.DOMPurify.sanitize=(...args)=>{sanitizerCalls++;return originalSanitize(...args);};
  app.renderMarkdown(rendered,'# Sanitized');check(sanitizerCalls,1,'final HTML is passed to real sanitizer');
  w.DOMPurify.sanitize=originalSanitize;
  const originalMathRender=w.katex.renderToString;
  w.katex.renderToString=()=>'<img src=x onerror=evil><script>evil</script><span id=modal>safe text</span>';
  app.renderMarkdown(rendered,'$x$');
  check(rendered.querySelector('img,script,[id],[onerror]'),null,'unsafe generated markup is sanitized');
  check(rendered.textContent.includes('safe text'),true,'safe generated content retained');w.katex.renderToString=originalMathRender;
  const savedPurify=w.DOMPurify;w.DOMPurify=null;app.renderMarkdown(rendered,'<img onerror=evil> **raw**');
  check(rendered.querySelector('img,strong'),null,'missing sanitizer falls back to plain text');
  check(rendered.textContent.includes('**raw**'),true,'fallback preserves source');w.DOMPurify=savedPurify;
  const file=new w.File([markdown],'research.md',{type:'text/markdown'});
  check((await app.readMarkdownFile(file)).source,markdown,'UTF-8 BOM, CRLF and complete original source preserved');
  for (const [badFile,pattern] of [
    [new w.File(['# Title'],'not.txt',{type:'text/plain'}),/\.md/],
    [new w.File(['# Title'],'not.md',{type:'text/html'}),/file type/],
    [new w.File(['x'.repeat(102401)],'large.md'),/100 KiB/],
    [new w.File([new Uint8Array([0xff,0xfe])],'invalid.md'),/UTF-8/],
    [new w.File(['a\0b'],'null.md'),/null character/]
  ]) { await assert.rejects(()=>app.readMarkdownFile(badFile),pattern);checks++; }
  const longSource='# Long research idea\n\n'+'é'.repeat(25000);
  check((await app.readMarkdownFile(new w.File([longSource],'long.md'))).source,longSource,'document beyond old character limit preserved');
  await assert.rejects(()=>app.readMarkdownFile(new w.File(['😀'.repeat(25601)],'unicode.md')),/100 KiB/);checks++;
  check((await app.readMarkdownFile(new w.File(['x'.repeat(102400)],'boundary.md'))).source.length,102400,'exact byte limit accepted');

  w.confirm=()=>true;
  const importIntoForm=async files=>{
    const input=d.querySelector('#modal-body input[type=file]');
    Object.defineProperty(input,'files',{configurable:true,value:files});
    input.dispatchEvent(new w.Event('change'));
    await wait(()=>!d.querySelector('#modal-body form')?.dataset.importing);
  };
  app.openIdeaDialog();const callsBeforeImport=calls.length,ideasBeforeImport=ideas.length;
  check(d.querySelector('input[type=file]').multiple,false,'single file picker');
  await importIntoForm([file]);
  check(calls.length,callsBeforeImport,'import never publishes');check(ideas.length,ideasBeforeImport,'import creates no rows');
  check(d.querySelector('#modal-body input[type=text]').value,'Suggested research title','import fills editable suggested title');
  check(d.querySelector('.markdown-preview h1').textContent,'Suggested research title','import shows formatted preview');
  await snapshot('markdown-preview.html');
  await importIntoForm([file,file]);check(d.querySelector('#modal-body .error-text').textContent.includes('exactly one'),true,'bulk import rejected');
  await importIntoForm([new w.File(['bad'],'bad.txt')]);
  check(d.querySelector('#modal-body textarea').value.includes('A second H1'),true,'bad import preserves previous draft');
  d.querySelector('#modal-body input[type=text]').value='PI-edited title';
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.length,callsBeforeImport+1,'explicit publish makes one RPC');
  check(ideas.length,ideasBeforeImport+1,'one file creates exactly one idea');
  check(calls.at(-1).args.p_title,'PI-edited title','PI can override suggested title');
  check(calls.at(-1).args.p_description,markdown,'publication sends untouched full Markdown');
  const markdownIdea=app.state.ideas.at(-1);app.openIdeaDialog(markdownIdea);
  d.querySelector('#modal-body input[type=text]').value='Metadata-only edit';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_description,markdown,'metadata-only edit preserves original line endings');
  app.openIdeaDialog(app.state.ideas.at(-1));
  const editor=d.querySelector('#modal-body textarea');editor.value='# Revised Markdown\n\n$x^2$';editor.dispatchEvent(new w.Event('input'));
  await wait(()=>d.querySelector('.markdown-preview h1')?.textContent==='Revised Markdown');
  check(!!d.querySelector('.markdown-preview .katex'),true,'live preview updates math');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_description,'# Revised Markdown\n\n$x^2$','edited Markdown submitted');
  check(events.at(-1).previous_state.description,markdown,'edit history preserves earlier Markdown');
  app.openIdeaDialog();await importIntoForm([new w.File([longSource],'long.md')]);
  rpcError={code:'23514',message:'violates check constraint "ideas_description_check"'};submit();await wait(()=>!app.state.pending);
  check(d.getElementById('modal').open,true,'old database constraint keeps draft open');
  check(d.querySelector('#modal-body .error-text').textContent.includes('updated schema.sql'),true,'old schema error is actionable');
  check(d.querySelector('#modal-body textarea').value,longSource,'old schema error never truncates draft');rpcError=null;
  const manual=d.querySelector('#modal-body textarea');manual.value='x'.repeat(102401);manual.dispatchEvent(new w.Event('input'));
  const beforeOversize=calls.length;submit();check(calls.length,beforeOversize,'oversized manual draft cannot submit');
  check(manual.value.length,102401,'oversized manual draft not truncated');app.closeModal();

  let releaseLate;delayRead=new Promise(resolve=>releaseLate=resolve);const late=app.loadIdeas();
  await app.loadCurrentUser(null);releaseLate();await late;
  check(d.getElementById('dashboard').hidden,true,'late response cannot resurrect logged-out dashboard');
  check(app.state.ideas.length,0,'late response cannot restore private data');
  check(d.getElementById('login-view').hidden,false,'logout view');
  console.log(`PASS: ${checks} syntax/DOM integration checks. Transport was simulated; no live Auth or Realtime claims.`);
} finally { w.close(); }

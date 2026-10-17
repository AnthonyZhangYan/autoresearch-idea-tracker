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
const clone = value => JSON.parse(JSON.stringify(value));
const profiles = ['Shibo','Yan','Junqi','Yifan'].map((name,index) => ({id:`member-${index}`,display_name:name,role:index ? 'researcher' : 'pi',active:true}));
const base = {description:'Synthetic test data only. Evaluate the experiment and record its outcome.',week_start:'2026-10-12',priority:'high',status:'available',assigned_to:null,result:null,notes:null,experiment_url:null,completed_at:null,revision:1,created_at:'2026-10-12T14:00:00Z',updated_at:'2026-10-12T14:00:00Z'};
let ideas = [
  {...base,id:'idea-1',idea_number:1,title:'Evaluate tool selection instructions'},
  {...base,id:'idea-2',idea_number:2,title:'Compare memory retrieval strategies',status:'testing',assigned_to:'member-1',priority:'medium'},
  {...base,id:'idea-3',idea_number:3,title:'Measure search quality',status:'completed',assigned_to:'member-2',result:'fail',notes:'Synthetic failed trial — preserve this result.',completed_at:'2026-10-13T15:00:00Z',experiment_url:'https://example.org/experiment',priority:'low'},
  {...base,id:'idea-4',idea_number:4,title:'Test retry budgets',status:'completed',assigned_to:'member-3',result:'success',completed_at:'2026-10-14T15:00:00Z',week_start:'2026-10-19'},
];
let events = [], currentId = 'member-0', authCallback, channel, rpcError, readsFail = false, delayRead, calls = [], removed = 0;
const session = () => currentId ? {user:{id:currentId},access_token:'synthetic-test-token'} : null;
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
        let rows = clone(table==='profiles' ? profiles : table==='ideas' ? ideas : [...events].reverse());
        rows = rows.filter(row=>filters.every(filter=>filter(row))).slice(low,Math.min(high+1,low+limit));
        resolve({data:single ? rows[0] || null : rows,error:null});
      } catch(error) { reject(error); }
    }
  }; return builder;
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
    let idea=ideas.find(i=>i.id===args.p_idea_id);const before=idea && clone(idea);
    if(name==='create_idea') {idea={...base,id:`idea-${ideas.length+1}`,idea_number:ideas.length+1,title:args.p_title,description:args.p_description,week_start:args.p_week_start,priority:args.p_priority};ideas.push(idea);}
    if(name==='update_idea') Object.assign(idea,{title:args.p_title,description:args.p_description,week_start:args.p_week_start,priority:args.p_priority});
    if(name==='claim_idea') Object.assign(idea,{status:'testing',assigned_to:currentId});
    if(name==='complete_idea') Object.assign(idea,{status:'completed',result:args.p_result,notes:args.p_notes,experiment_url:args.p_experiment_url,completed_at:'2026-10-16T14:00:00Z'});
    if(['release_idea','reopen_idea'].includes(name)) Object.assign(idea,{status:'available',assigned_to:null,result:null,notes:null,experiment_url:null,completed_at:null});
    if(name==='delete_idea') ideas=ideas.filter(i=>i!==idea);
    idea.revision++;
    events.push({id:events.length+1,idea_id:idea.id,idea_number:idea.idea_number,actor_id:currentId,event_type:({create_idea:'created',update_idea:'edited',claim_idea:'claimed',complete_idea:'completed',release_idea:'released',reopen_idea:'reopened',delete_idea:'deleted'})[name],previous_state:before || null,new_state:name==='delete_idea'?null:clone(idea),created_at:'2026-10-16T14:00:00Z'});
    return {data:clone(idea),error:null};
  }
};
const dom = new JSDOM(html,{url:'http://127.0.0.1:8765/autoresearch-idea-tracker/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
installMarkdownLibraries(w);
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.supabase={createClient:()=>client};
w.eval(script+'\nwindow.__app = {state,loadIdeas,loadCurrentUser,renderDashboard,openIdeaDialog,openCompleteDialog,confirmAction,claimIdea,mutate,openHistory,safeURL,closeModal,filteredIdeas,renderMarkdown,suggestedMarkdownTitle,readMarkdownFile};');
const app=w.__app;
const wait=async condition=>{for(let n=0;n<200;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for DOM test condition');};
const click = id => d.getElementById(id).click();
const submit = () => d.querySelector('#modal-body form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
const text = id => d.getElementById(id).textContent;
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
  check(d.querySelectorAll('.stat-value').length,6,'six actual counters');
  check([...d.querySelectorAll('.stat-value')].map(el=>el.textContent),['4','1','1','2','1','1'],'database-derived counts');
  check(text('progress-percent'),'50%','completion progress');
  check(d.querySelectorAll('.week').length,2,'weekly groups');
  check(channel.handlers.map(h=>h.filter.table),['ideas','idea_events','profiles'],'subscribed tables');
  check(channel.handlers.every(h=>h.filter.event==='*'),true,'all change types');
  click('expand-all');
  check([...d.querySelectorAll('.idea,.week')].every(el=>el.open),true,'expand all');
  await snapshot('dashboard.html');
  click('collapse-all');check([...d.querySelectorAll('.idea,.week')].every(el=>!el.open),true,'collapse all');
  const setFilter=(id,value)=>{d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new w.Event(id==='search'?'input':'change'));};
  for (const [id,value,expected] of [['search','IDEA-003',1],['search','retrieval',1],['search','synthetic',4],['status-filter','completed',2],['member-filter','member-1',1],['result-filter','fail',1],['priority-filter','high',2],['week-filter','2026-10-19',1],['member-filter','unassigned',1],['result-filter','none',2]]) {
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
  let created=app.state.ideas.at(-1);
  app.openIdeaDialog(created);d.querySelector('#modal-body input[type=text]').value='Revised test idea';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_expected_revision,created.revision,'edit revision');
  await app.claimIdea(app.state.ideas[0]);check(calls.at(-1).name,'claim_idea','claim RPC');
  check(Object.keys(calls.at(-1).args),['p_idea_id'],'no arbitrary assignee');
  let active=app.state.ideas[0];app.openCompleteDialog(active);
  d.querySelector('input[value=fail]').checked=true;
  d.querySelector('#modal-body textarea').value='Synthetic notes';
  d.querySelector('input[type=url]').value='javascript:alert(1)';submit();
  check(d.querySelector('#modal-body .error-text').textContent.includes('HTTP(S)'),true,'completion URL validation');
  d.querySelector('input[type=url]').value='https://example.org/trial';
  await snapshot('completion.html');submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_result,'fail','completion result');
  check(app.state.ideas[0].status,'completed','failed result remains completed');
  app.confirmAction('reopen',app.state.ideas[0]);submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).name,'reopen_idea','reopen RPC');
  await app.claimIdea(app.state.ideas[0]);app.confirmAction('release',app.state.ideas[0]);submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).name,'release_idea','release RPC');
  app.confirmAction('delete',app.state.ideas.at(-1));submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).name,'delete_idea','delete RPC');check(app.state.ideas.length,4,'delete refetch');
  app.openHistory();await wait(()=>d.querySelectorAll('.history li').length>0);
  check(text('modal-body').includes('Synthetic notes'),true,'historical trial visible');
  check(text('modal-body').includes('deleted the idea'),true,'deleted event accessible');app.closeModal();
  rpcError={message:'Idea already claimed or no longer available'};
  await app.claimIdea(app.state.ideas[0]);check(text('notifications').includes('already claimed'),true,'conflict notification');rpcError=null;
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
  check(d.getElementById('create-button').hidden,true,'researcher create hidden');
  check([...d.querySelectorAll('.idea button')].some(b=>b.textContent==='Delete'),false,'researcher delete hidden');

  // Two receiving frontends, neither of which submits the remote mutations.
  // Disable periodic polling so only the delivered INSERT/UPDATE callbacks can
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
    const deliver=(table,eventType,record)=>{
      for (const receiver of [firstChannel,observerChannel]) {
        receiver.handlers.filter(h=>h.filter.table===table && ['*',eventType].includes(h.filter.event))
          .forEach(h=>h.callback({schema:'public',table,eventType,new:clone(record)}));
      }
    };
    // Shibo mutates the shared source outside both receiving app instances.
    currentId='member-0';
    const remote=await client.rpc('create_idea',{p_title:'Remote notification test',p_description:'Synthetic',p_week_start:'2026-10-12',p_priority:'low'});
    currentId='member-1';
    check(receivers.every(s=>!s.ideas.some(i=>i.id===remote.data.id)),true,'receivers unchanged before INSERT delivery');
    deliver('ideas','INSERT',remote.data);
    await wait(()=>receivers.every(s=>s.ideas.some(i=>i.id===remote.data.id)));
    check(receivers.every(s=>s.ideas.some(i=>i.title==='Remote notification test')),true,'INSERT refreshes both receivers');
    currentId='member-0';
    const changed=await client.rpc('update_idea',{p_idea_id:remote.data.id,p_expected_revision:remote.data.revision,p_title:'Remote updated title',p_description:'Synthetic',p_week_start:'2026-10-12',p_priority:'medium'});
    currentId='member-1';
    deliver('ideas','UPDATE',changed.data);
    await wait(()=>receivers.every(s=>s.ideas.some(i=>i.title==='Remote updated title')));
    check(receivers.every(s=>s.ideas.some(i=>i.title==='Remote updated title')),true,'UPDATE refreshes both receivers');
    currentId='member-0';
    await client.rpc('delete_idea',{p_idea_id:changed.data.id,p_expected_revision:changed.data.revision});
    currentId='member-1';
    check(events.at(-1).event_type,'deleted','remote deletion audit source');
    check(receivers.every(s=>s.ideas.some(i=>i.id===remote.data.id)),true,'no direct DELETE notification or mutation refresh');
    deliver('idea_events','INSERT',events.at(-1));
    await wait(()=>receivers.every(s=>!s.ideas.some(i=>i.id===remote.data.id)));
    check(receivers.every(s=>!s.ideas.some(i=>i.id===remote.data.id)),true,'audit INSERT alone removes deleted idea from both receivers');
    check([d,observerWindow.document].every(doc=>!doc.getElementById('ideas').textContent.includes('Remote updated title')),true,'both rendered lists remove deleted idea');
  } finally { observerWindow.close(); }

  await app.loadCurrentUser({user:{id:'outsider'},access_token:'test'});
  check(d.getElementById('dashboard').hidden,true,'unauthorized cannot enter dashboard');
  check(text('access-title'),'Access has not been granted','allowlist denial');
  check(d.querySelectorAll('.idea').length,0,'previous account data cleared');
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

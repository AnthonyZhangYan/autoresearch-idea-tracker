// Invitation onboarding and login tests with a simulated Supabase Auth client.
// No hosted Auth, email delivery, or real invitation links are exercised here.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'),'package.json'));
const {JSDOM} = require('jsdom');
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
new vm.Script(script);
let checks = 1;
function check(actual,expected,label) { assert.deepEqual(actual,expected,label); checks++; }
const clone = value => JSON.parse(JSON.stringify(value));

const ORIGIN = 'http://127.0.0.1:8765', BASE = '/autoresearch-idea-tracker/';
const PASSWORD = 'Synthetic-Pass-2026!';
const ONBOARDING_KEY = 'autoresearch.pendingOnboarding';
const INVALID = 'This invitation link has expired or is invalid. Please contact the administrator for a new invitation.';
const NOT_AUTHORIZED = 'Your account has been created, but access to this research workspace has not yet been authorized. Please contact the administrator.';
// Synthetic identities only; .test is a reserved, non-routable domain.
const yan = {id:'member-1',email:'yan@example.test'}, shibo = {id:'member-0',email:'shibo@example.test'}, outsider = {id:'outsider-1',email:'outsider@example.test'};
const memberProfiles = [
  {id:'member-0',display_name:'Shibo',role:'pi',active:true},
  {id:'member-1',display_name:'Yan',role:'researcher',active:true}
];
const sessionFor = user => user ? {user:clone(user),access_token:`synthetic-access-${user.id}`,refresh_token:'synthetic-refresh'} : null;
const networkError = () => ({name:'AuthRetryableFetchError',status:0,message:'Failed to fetch'});
const expiredError = () => ({name:'AuthApiError',status:403,code:'otp_expired',message:'Token has expired or is invalid'});

// Each call is a fresh page load, the equivalent of opening or refreshing a URL.
function boot(path, config = {}) {
  const dom = new JSDOM(html,{url:`${ORIGIN}${path}`,runScripts:'outside-only',pretendToBeVisual:true});
  const w = dom.window, d = w.document;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.HTMLDialogElement.prototype.showModal = function(){this.open = true;};
  w.HTMLDialogElement.prototype.close = function(){this.open = false;};
  for (const [key,value] of Object.entries(config.storage || {})) w.localStorage.setItem(key,value);
  const logs = [];
  for (const level of ['log','info','warn','error','debug']) w.console[level] = (...args) => logs.push(args.map(String).join(' '));
  let current = sessionFor(config.user);
  const listeners = [], calls = [], reads = [], events = [];
  const emit = event => { events.push(event); listeners.forEach(callback => callback(event,current)); };
  const invitee = config.invitee || yan;
  // Mirrors the SDK: a successful callback saves the session and emits SIGNED_IN
  // before the promise resolves.
  async function establish(name,args) {
    calls.push([name,clone(args ?? null)]);
    const outcome = await config.outcome?.(name,calls.filter(call => call[0] === name).length);
    if (outcome?.error) return {data:{user:null,session:null},error:outcome.error};
    current = sessionFor(invitee); emit('SIGNED_IN');
    return {data:{user:current.user,session:current},error:null};
  }
  const profiles = config.profiles || memberProfiles;
  const query = table => {
    const filters = [];
    const builder = {
      select(){return this;},order(){return this;},range(){return this;},limit(){return this;},lt(){return this;},
      eq(key,value){filters.push(row => row[key] === value);return this;},
      maybeSingle(){this.single = true;return this;},
      then(resolve) {
        reads.push(table);
        const rows = (table === 'profiles' ? clone(profiles) : []).filter(row => filters.every(filter => filter(row)));
        resolve({data:this.single ? rows[0] || null : rows,error:null});
      }
    };
    return builder;
  };
  const client = {
    auth:{
      onAuthStateChange(callback){listeners.push(callback);setTimeout(() => callback('INITIAL_SESSION',current),0);return {data:{subscription:{unsubscribe(){}}}};},
      async getSession(){calls.push(['getSession']);return {data:{session:config.dropSession ? null : current},error:null};},
      async signInWithPassword(credentials){
        calls.push(['signInWithPassword',credentials.email]);
        const user = [yan,shibo,outsider].find(u => u.email === credentials.email);
        if (!user || credentials.password !== PASSWORD) return {data:{user:null,session:null},error:{name:'AuthApiError',status:400,code:'invalid_credentials',message:'Invalid login credentials'}};
        current = sessionFor(user); emit('SIGNED_IN');
        return {data:{user:current.user,session:current},error:null};
      },
      async signOut(options){calls.push(['signOut',clone(options)]);current = null;emit('SIGNED_OUT');return {error:null};},
      verifyOtp:params => establish('verifyOtp',params),
      setSession:tokens => establish('setSession',tokens),
      exchangeCodeForSession:(code,options) => establish('exchangeCodeForSession',{code,options:options ?? null}),
      async updateUser(attributes){
        calls.push(['updateUser',Object.keys(attributes)]);
        const outcome = await config.update?.(attributes);
        if (outcome?.error) return {data:{user:null},error:outcome.error};
        emit('USER_UPDATED');
        return {data:{user:current.user},error:null};
      }
    },
    from:query,
    realtime:{async setAuth(){}},
    channel(){return {on(){return this;},subscribe(callback){setTimeout(() => callback('SUBSCRIBED'),0);return this;}};},
    async removeChannel(){},
    async rpc(){throw new Error('No RPC expected in invitation tests');}
  };
  w.supabase = {createClient:() => client};
  w.eval(script + '\nwindow.__app = {state};');
  const page = {
    w, d, calls, reads, logs, events, client, emit,
    setUser(user){current = sessionFor(user);},
    app:w.__app,
    $:id => d.getElementById(id),
    text:id => d.getElementById(id).textContent,
    visible:id => !d.getElementById(id).hidden,
    named:name => calls.filter(call => call[0] === name),
    async wait(condition,label = 'condition') {
      for (let n = 0; n < 400; n++) { if (condition()) return; await new Promise(r => setTimeout(r,5)); }
      throw new Error(`Timed out waiting for ${label}`);
    },
    submitPassword(password,confirmation = password) {
      d.getElementById('new-password').value = password;
      d.getElementById('confirm-password').value = confirmation;
      d.getElementById('password-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    },
    close(){w.close();}
  };
  return page;
}
const settle = page => page.wait(() => !page.app.state.acceptingInvite && page.visible('onboarding-view'),'callback handling');
const callbackCalls = page => ['verifyOtp','setSession','exchangeCodeForSession'].flatMap(name => page.named(name));
const storedText = page => [page.w.localStorage,page.w.sessionStorage].flatMap(store => Object.keys(store).map(key => `${key}=${store.getItem(key)}`)).join('\n');

const pages = [];
const open = (path,config) => { const page = boot(path,config); pages.push(page); return page; };
try {
  // 1, 11. Ordinary email/password login is unchanged and shows no onboarding.
  {
    const page = open(BASE);
    await page.wait(() => !page.$('login-submit').disabled,'login ready');
    check(page.visible('login-view'),true,'login view for signed-out visitor');
    check(page.visible('onboarding-view'),false,'no onboarding without a callback');
    page.$('email').value = yan.email; page.$('password').value = 'wrong password';
    page.$('login-form').dispatchEvent(new page.w.Event('submit',{bubbles:true,cancelable:true}));
    await page.wait(() => page.text('login-error') !== '','login error');
    check(page.text('login-error'),'The email or password is incorrect.','invalid credentials message');
    page.$('password').value = PASSWORD;
    page.$('login-form').dispatchEvent(new page.w.Event('submit',{bubbles:true,cancelable:true}));
    await page.wait(() => page.visible('dashboard'),'dashboard after login');
    check(page.text('identity'),'Logged in as Yan','returning member logs in with email and password');
    check(page.$('password').value,'','login password field cleared');
    check(page.visible('onboarding-view'),false,'returning member never sees onboarding');
    check(callbackCalls(page).length,0,'login does not touch invitation APIs');
    check(page.named('updateUser').length,0,'login never changes passwords');
    // 12. Logout still works from the dashboard.
    page.$('logout').click();
    await page.wait(() => page.visible('login-view'),'login after logout');
    check(page.named('signOut').at(-1)[1],{scope:'local'},'logout signs out locally');
    check(page.visible('dashboard'),false,'logout hides workspace');
  }

  // 9. A restored session (refresh/returning user) goes straight to the workspace.
  {
    const page = open(BASE,{user:yan});
    await page.wait(() => page.visible('dashboard'),'restored dashboard');
    check(page.visible('onboarding-view'),false,'restored session skips onboarding');
    check(callbackCalls(page).length,0,'restored session makes no callback exchange');
  }

  // 2, 3, 4, 5, 6, 13. Recommended token_hash invitation under the repository subpath.
  {
    let release;
    const gate = new Promise(r => release = r);
    const page = open(`${BASE}?lang=en&token_hash=synthetic-hash-123&type=invite`,{outcome:name => name === 'verifyOtp' ? gate : null});
    await page.wait(() => page.named('verifyOtp').length === 1,'verification request');
    check(page.text('onboarding-heading'),'Verifying your invitation…','verifying state while Supabase checks the token');
    check(page.visible('login-view'),false,'login page is not shown before invitation authentication completes');
    check(page.w.location.pathname,BASE,'GitHub Pages subpath preserved');
    check(page.w.location.search,'?lang=en','token removed from the address bar; unrelated query kept');
    check(page.w.location.href.includes('synthetic-hash-123'),false,'token not left in URL');
    page.emit('TOKEN_REFRESHED');
    release();
    await settle(page);
    check(page.named('verifyOtp'),[['verifyOtp',{token_hash:'synthetic-hash-123',type:'invite'}]],'token_hash verified exactly once as an invite');
    check(page.text('onboarding-heading'),'Set Your Password','password setup shown to invited member');
    check(page.text('onboarding-message'),'Welcome to PML4SC Lab! Your invitation has been verified.','welcome text');
    check(page.$('onboarding-email').value,yan.email,'invited account email displayed');
    check(page.$('onboarding-email').readOnly,true,'account email is not editable');
    check(page.visible('dashboard'),false,'workspace not entered before a password exists');
    check(page.reads.includes('ideas'),false,'no research data read during onboarding');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),yan.id,'pending onboarding marker holds only the user ID');
    check(page.text('connection'),'Account setup','connection label during setup');
    check(['new-password','confirm-password'].map(id => page.$(id).type),['password','password'],'passwords hidden by default');
    page.$('show-passwords').checked = true; page.$('show-passwords').dispatchEvent(new page.w.Event('change'));
    check(['new-password','confirm-password'].map(id => page.$(id).type),['text','text'],'optional show passwords');
    page.$('show-passwords').checked = false; page.$('show-passwords').dispatchEvent(new page.w.Event('change'));
    check(page.$('new-password').type,'password','hide passwords again');
    check(page.$('new-password').autocomplete,'new-password','password manager hint');
    for (const [password,confirmation,message] of [
      ['','','Enter a new password.'],
      ['short','short','Use at least 8 characters.'],
      ['é'.repeat(40),'é'.repeat(40),'at most 72 bytes'],
      [PASSWORD,'','Confirm your new password.'],
      [PASSWORD,`${PASSWORD}x`,'The passwords do not match.']
    ]) {
      page.submitPassword(password,confirmation);
      check(page.text('password-error').includes(message),true,`password validation: ${message}`);
    }
    check(page.named('updateUser').length,0,'invalid passwords never reach Supabase');
    let finish;
    const updating = new Promise(r => finish = r);
    const pending = page.app.state;
    page.submitPassword(PASSWORD);
    // The update is in flight; a second submit is ignored.
    await page.wait(() => page.$('password-submit').disabled,'submission disabled');
    check(page.text('password-submit'),'Creating password…','processing label');
    page.submitPassword(PASSWORD);
    check(pending.onboarding.userId,yan.id,'still onboarding during update');
    finish();
    await page.wait(() => page.text('onboarding-message').startsWith('Your password has been created successfully.') && page.visible('enter-tracker'),'success');
    check(page.named('updateUser'),[['updateUser',['password']]],'single updateUser({password}) call');
    const order = page.calls.map(call => call[0]);
    check(order.indexOf('verifyOtp') < order.indexOf('updateUser'),true,'password updated only after the invitation session exists');
    check(page.events.includes('USER_UPDATED'),true,'USER_UPDATED event emitted');
    check(page.text('onboarding-heading'),'Welcome, Yan','authorized member welcomed');
    check(page.visible('password-form'),false,'form hidden after success');
    check([page.$('new-password').value,page.$('confirm-password').value],['',''],'password fields cleared');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),null,'marker removed after onboarding');
    check(storedText(page).includes(PASSWORD),false,'password not in localStorage/sessionStorage');
    check(page.logs.some(line => line.includes(PASSWORD)),false,'password never logged');
    check(page.w.location.href.includes(PASSWORD),false,'password never in URL');
    check(page.visible('dashboard'),false,'success screen waits for the member');
    page.$('enter-tracker').click();
    await page.wait(() => page.visible('dashboard'),'dashboard after onboarding');
    check(page.text('identity'),'Logged in as Yan','authorized member enters the tracker');
    check(page.visible('onboarding-view'),false,'onboarding closed');
  }

  // 9. Refresh after completing onboarding does not restart it.
  {
    const page = open(BASE,{user:yan});
    await page.wait(() => page.visible('dashboard'),'dashboard after refresh');
    check(page.visible('onboarding-view'),false,'completed onboarding is not repeated');
  }

  // Refresh before the password is created resumes setup instead of entering.
  {
    const page = open(BASE,{user:yan,storage:{[ONBOARDING_KEY]:yan.id}});
    await page.wait(() => page.visible('onboarding-view'),'resumed setup');
    check(page.text('onboarding-heading'),'Set Your Password','unfinished onboarding resumes after refresh');
    check(page.visible('dashboard'),false,'unfinished onboarding cannot skip to workspace');
    page.$('new-password').value = 'partly typed';
    page.emit('TOKEN_REFRESHED');
    await new Promise(r => setTimeout(r,20));
    check(page.$('new-password').value,'partly typed','token refresh does not reset the form');
    // 12. Logout during onboarding.
    page.$('onboarding-logout').click();
    await page.wait(() => page.visible('login-view'),'login after cancel');
    check(page.named('signOut').length,1,'cancel signs out');
    check(page.visible('onboarding-view'),false,'onboarding closed on logout');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),null,'marker removed on logout');
    check(page.$('new-password').value,'','typed password cleared on logout');
  }

  // A stale marker for another account never forces someone else into setup.
  {
    const page = open(BASE,{user:shibo,storage:{[ONBOARDING_KEY]:yan.id}});
    await page.wait(() => page.visible('dashboard'),'dashboard for other account');
    check(page.text('identity'),'Logged in as Shibo','other account unaffected by stale marker');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),null,'stale marker cleared');
  }

  // Default email template: implicit tokens in the fragment.
  {
    const page = open(`${BASE}#access_token=synthetic-access&refresh_token=synthetic-refresh&expires_in=3600&token_type=bearer&type=invite`);
    await settle(page);
    check(page.named('setSession'),[['setSession',{access_token:'synthetic-access',refresh_token:'synthetic-refresh'}]],'fragment tokens establish the session once');
    check(page.w.location.href,`${ORIGIN}${BASE}`,'fragment tokens removed, subpath kept');
    check(page.text('onboarding-heading'),'Set Your Password','implicit invite shows setup');
  }

  // PKCE authorization-code callback: exchanged exactly once.
  {
    const page = open(`${BASE}?code=synthetic-code&sb_flow_id=synthetic-flow`);
    await settle(page);
    await new Promise(r => setTimeout(r,20));
    check(page.named('exchangeCodeForSession'),[['exchangeCodeForSession',{code:'synthetic-code',options:{flowId:'synthetic-flow'}}]],'PKCE code exchanged once with its flow id');
    check(page.w.location.href,`${ORIGIN}${BASE}`,'code removed from URL');
    check(page.text('onboarding-heading'),'Set Your Password','PKCE invite shows setup');
  }
  {
    const page = open(`${BASE}?code=synthetic-code`,{outcome:() => ({error:{name:'AuthApiError',status:400,code:'flow_state_not_found',message:'invalid flow state'}})});
    await settle(page);
    check(page.named('exchangeCodeForSession').length,1,'failed code exchange is not repeated');
    check(page.text('onboarding-message'),INVALID,'unusable code reported as invalid invitation');
    check(page.visible('retry-onboarding'),false,'no retry for a rejected code');
  }

  // 7. Expired link: Supabase redirects back with error parameters.
  {
    const page = open(`${BASE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    await settle(page);
    check(page.text('onboarding-message'),INVALID,'expired invitation message');
    check(callbackCalls(page).length,0,'no exchange attempted for an error callback');
    check(page.w.location.href,`${ORIGIN}${BASE}`,'error parameters removed');
    check(page.visible('password-form'),false,'no password form for an expired link');
    page.$('onboarding-signin').click();
    await page.wait(() => page.visible('login-view'),'login after expired link');
    check(page.visible('onboarding-view'),false,'member can return to normal sign in');
    check(page.$('login-submit').disabled,false,'login usable after invitation error');
  }
  {
    const page = open(`${BASE}?error=server_error&error_description=Something+went+wrong`);
    await settle(page);
    check(page.text('onboarding-message'),INVALID,'query-string error callback handled');
  }

  // 8. Invalid or previously used token; unsupported link types; missing tokens.
  {
    const page = open(`${BASE}?token_hash=synthetic-used-token&type=invite`,{outcome:() => ({error:expiredError()})});
    await settle(page);
    check(page.text('onboarding-message'),INVALID,'used/invalid token message');
    check(page.text('onboarding-view').includes('synthetic-used-token'),false,'token not exposed in the page');
    check(page.visible('retry-onboarding'),false,'invalid token cannot be retried');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),null,'no onboarding marker after failure');
  }
  for (const path of [`${BASE}?token_hash=synthetic&type=magiclink`,`${BASE}#access_token=synthetic&refresh_token=synthetic`,`${BASE}?token_hash=synthetic`]) {
    const page = open(path);
    await settle(page);
    check(page.text('onboarding-message'),INVALID,`unsupported callback rejected: ${path}`);
    check(callbackCalls(page).length,0,`no session created for: ${path}`);
  }
  {
    const page = open(`${BASE}#access_token=synthetic&type=invite`);
    await settle(page);
    check(page.text('onboarding-message'),INVALID,'fragment without refresh token is rejected');
  }

  // Network failure during verification can be retried without reopening the email.
  {
    const page = open(`${BASE}?token_hash=synthetic-hash&type=invite`,{outcome:(name,count) => count === 1 ? {error:networkError()} : null});
    await settle(page);
    check(page.text('onboarding-message'),'Unable to reach the sign-in service. Check your connection and try again.','network failure message');
    check(page.visible('retry-onboarding'),true,'retry offered for a network failure');
    page.$('retry-onboarding').click();
    await page.wait(() => page.text('onboarding-heading') === 'Set Your Password','setup after retry');
    check(page.named('verifyOtp').length,2,'one explicit retry');
  }

  // Already signed in as another account: the previous workspace is never shown.
  {
    let release;
    const gate = new Promise(r => release = r);
    const page = open(`${BASE}?token_hash=synthetic-hash&type=invite`,{user:shibo,outcome:() => gate});
    await page.wait(() => page.named('verifyOtp').length === 1,'verification request');
    await new Promise(r => setTimeout(r,20));
    check(page.visible('dashboard'),false,'previous account workspace not shown during acceptance');
    release();
    await settle(page);
    check(page.text('onboarding-notice'),'You were signed out of shibo@example.test to accept this invitation.','account switch explained');
    check(page.$('onboarding-email').value,yan.email,'invited account shown');
    check(page.reads.includes('ideas'),false,'previous account data never loaded');
  }

  // 10. Authenticated but not in profiles: password is created, access is not.
  {
    const page = open(`${BASE}?token_hash=synthetic-hash&type=invite`,{invitee:outsider});
    await settle(page);
    page.submitPassword(PASSWORD);
    await page.wait(() => page.text('onboarding-notice') === NOT_AUTHORIZED,'unauthorized notice');
    check(page.text('onboarding-message'),'Your password has been created successfully.','password confirmation for unlisted user');
    check(page.visible('enter-tracker'),false,'no way into the tracker');
    check(page.visible('dashboard'),false,'dashboard stays hidden');
    check(page.reads.includes('ideas'),false,'ideas never requested for unauthorized user');
    check(page.text('onboarding-logout'),'Log out','unauthorized user can log out');
    // Even routing through the normal path keeps the allowlist denial.
    page.app.state.onboarding = null;
    page.$('onboarding-signin').click();
    await page.wait(() => page.visible('access-view'),'access gate');
    check(page.text('access-title'),'Access has not been granted','normal path also denies unlisted user');
    check(page.visible('dashboard'),false,'no dashboard via normal path');
  }

  // Missing session at submission and Supabase-side password errors.
  {
    const page = open(`${BASE}?token_hash=synthetic-hash&type=invite`);
    await settle(page);
    page.setUser(null);
    page.submitPassword(PASSWORD);
    await page.wait(() => page.text('password-error') !== '','missing session error');
    check(page.text('password-error'),'Your invitation session has ended. Please contact the administrator for a new invitation.','missing session message');
    check(page.named('updateUser').length,0,'updateUser never called without the invitation session');
  }
  for (const [error,message] of [
    [{name:'AuthWeakPasswordError',status:422,code:'weak_password',message:'Password should contain at least one uppercase letter.',reasons:['characters']},'Password should contain at least one uppercase letter. Choose a stronger password.'],
    [{name:'AuthWeakPasswordError',status:422,code:'weak_password',message:'Password is known to be weak.',reasons:['pwned']},'This password appears in a known data breach. Choose a different password.'],
    [networkError(),'Unable to reach the sign-in service. Check your connection and try again.'],
    [{name:'AuthApiError',status:403,code:'session_not_found',message:'Session not found'},'Your invitation session has ended. Please contact the administrator for a new invitation.'],
    [{name:'AuthApiError',status:500,code:'unexpected_failure',message:'internal detail'},'Your password could not be created. Try again, or contact the administrator if the problem continues.']
  ]) {
    const page = open(`${BASE}?token_hash=synthetic-hash&type=invite`,{update:() => ({error})});
    await settle(page);
    page.submitPassword(PASSWORD);
    await page.wait(() => page.text('password-error') !== '','password error');
    check(page.text('password-error'),message,`Supabase password error: ${error.code || error.name}`);
    check(page.visible('password-form'),true,'form stays available after an error');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),yan.id,'onboarding remains pending after an error');
    check(page.text('onboarding-view').includes(PASSWORD),false,'error never shows the password');
  }

  // The actual pinned SDK bundle (verified against the page's integrity hash),
  // with fetch answered locally. This checks the SDK request shapes and error
  // objects the page depends on. No request leaves the process.
  const sdkSource = await readFile(join(resolve(process.env.TRACKER_TEST_DEPS || '.'),'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
  const pinned = html.match(/supabase-js@2\.118\.0\/dist\/umd\/supabase\.js" integrity="([^"]+)"/)[1];
  check(`sha384-${createHash('sha384').update(sdkSource).digest('base64')}`,pinned,'tested SDK is byte-identical to the pinned CDN script');
  const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const fakeJWT = user => `${b64url({alg:'HS256',typ:'JWT'})}.${b64url({sub:user.id,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  const authUser = user => ({...user,aud:'authenticated',role:'authenticated',invited_at:'2026-10-16T00:00:00Z',app_metadata:{},user_metadata:{},created_at:'2026-10-16T00:00:00Z'});
  async function bootRealSDK(path,{profiles = memberProfiles,user = yan,respond = () => null} = {}) {
    const dom = new JSDOM(html,{url:`${ORIGIN}${path}`,runScripts:'outside-only',pretendToBeVisual:true});
    const w = dom.window, requests = [];
    Object.assign(w,{TextEncoder,TextDecoder,Headers,Request,Response});
    w.WebSocket = class { constructor() { throw new Error('Network disabled in tests'); } };
    w.HTMLDialogElement.prototype.showModal = function(){this.open = true;};
    w.HTMLDialogElement.prototype.close = function(){this.open = false;};
    const accessToken = fakeJWT(user);
    const json = (body,status = 200) => new Response(status === 204 ? null : JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
    w.fetch = async (input,options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.origin,'https://kgfybebpxpdkiouofyow.supabase.co','only the configured project is contacted');
      const headers = new Headers(options.headers);
      const request = {method:options.method || 'GET',path:url.pathname,body:options.body ? JSON.parse(options.body) : null,authorization:headers.get('Authorization')};
      requests.push(request);
      const custom = respond(request);
      if (custom) return json(custom.body,custom.status);
      if (request.path === '/auth/v1/verify') return json({access_token:accessToken,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'synthetic-refresh',user:authUser(user)});
      if (request.path === '/auth/v1/user') return json(authUser(user));
      if (request.path === '/auth/v1/logout') return json(null,204);
      if (request.path === '/rest/v1/profiles') return json(profiles.filter(p => url.searchParams.get('id') === `eq.${p.id}`));
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    };
    w.eval(sdkSource.toString());
    w.eval(script + '\nwindow.__app = {state};');
    const page = {w,requests,accessToken,app:w.__app,$:id => w.document.getElementById(id),text:id => w.document.getElementById(id).textContent,
      visible:id => !w.document.getElementById(id).hidden,
      async wait(condition,label) { for (let n = 0; n < 400; n++) { if (condition()) return; await new Promise(r => setTimeout(r,5)); } throw new Error(`Timed out waiting for ${label}`); },
      submitPassword(password) { page.$('new-password').value = password; page.$('confirm-password').value = password;
        page.$('password-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); },
      close(){w.close();}};
    pages.push(page);
    return page;
  }
  {
    const page = await bootRealSDK(`${BASE}?token_hash=synthetic-hash&type=invite`);
    await settle(page);
    const verify = page.requests.filter(r => r.path === '/auth/v1/verify');
    check(verify.length,1,'real SDK: one verification request');
    check([verify[0].method,verify[0].body.token_hash,verify[0].body.type],['POST','synthetic-hash','invite'],'real SDK: token_hash verified as invite');
    check(page.text('onboarding-heading'),'Set Your Password','real SDK: setup shown');
    page.submitPassword(PASSWORD);
    await page.wait(() => page.visible('enter-tracker'),'real SDK success');
    const update = page.requests.filter(r => r.path === '/auth/v1/user' && r.method === 'PUT');
    check(update.length,1,'real SDK: one password update request');
    check(update[0].body.password,PASSWORD,'real SDK: password sent only in the Auth request body');
    check(update[0].authorization,`Bearer ${page.accessToken}`,'real SDK: update authorized by the invitation session');
    check(page.requests.some(r => r.path.startsWith('/rest/') && JSON.stringify(r.body || '').includes(PASSWORD)),false,'real SDK: password never sent to PostgreSQL');
    check(page.requests.every(r => !r.path.includes(PASSWORD)),true,'real SDK: password never in a URL');
    check(page.text('onboarding-message').startsWith('Your password has been created successfully.'),true,'real SDK: success confirmation');
    check(storedText(page).includes(PASSWORD),false,'real SDK: password not persisted in browser storage');
    check(page.w.localStorage.getItem(ONBOARDING_KEY),null,'real SDK: onboarding marker cleared');
  }
  {
    const page = await bootRealSDK(`${BASE}#access_token=${fakeJWT(yan)}&refresh_token=synthetic-refresh&expires_in=3600&token_type=bearer&type=invite`);
    await settle(page);
    check(page.requests.filter(r => r.path === '/auth/v1/user').length,1,'real SDK: fragment access token validated with Auth');
    check(page.text('onboarding-heading'),'Set Your Password','real SDK: implicit invite shows setup');
    check(page.w.location.href,`${ORIGIN}${BASE}`,'real SDK: fragment cleared');
  }
  {
    const page = await bootRealSDK(`${BASE}?token_hash=synthetic-used&type=invite`,{respond:r => r.path === '/auth/v1/verify' ? {status:403,body:{code:403,error_code:'otp_expired',msg:'Token has expired or is invalid'}} : null});
    await settle(page);
    check(page.text('onboarding-message'),INVALID,'real SDK: expired token error mapped');
    check(page.visible('retry-onboarding'),false,'real SDK: expired token not retryable');
  }
  {
    const page = await bootRealSDK(`${BASE}?code=synthetic-code`,{respond:r => r.path === '/auth/v1/token' ? {status:400,body:{code:400,error_code:'validation_failed',msg:'invalid request: both auth code and code verifier should be non-empty'}} : null});
    await settle(page);
    check(page.requests.filter(r => r.path === '/auth/v1/token').length,1,'real SDK: code exchanged once');
    check(page.text('onboarding-message'),INVALID,'real SDK: code without verifier rejected safely');
  }
  {
    const page = await bootRealSDK(`${BASE}?token_hash=synthetic-hash&type=invite`,{respond:r => r.path === '/auth/v1/user' && r.method === 'PUT' ?
      {status:422,body:{code:422,error_code:'weak_password',msg:'Password should contain at least one uppercase letter.',weak_password:{reasons:['characters']}}} : null});
    await settle(page);
    page.submitPassword(PASSWORD);
    await page.wait(() => page.text('password-error') !== '','real SDK weak password');
    check(page.text('password-error'),'Password should contain at least one uppercase letter. Choose a stronger password.','real SDK: configured password rule reported');
  }
  {
    const page = await bootRealSDK(`${BASE}?token_hash=synthetic-hash&type=invite`);
    page.w.fetch = async () => { throw new TypeError('Failed to fetch'); }; // replaced before the page initializes
    await settle(page);
    check(page.text('onboarding-message'),'Unable to reach the sign-in service. Check your connection and try again.','real SDK: network failure is retryable');
    check(page.visible('retry-onboarding'),true,'real SDK: retry offered');
  }

  console.log(`PASS: ${checks} invitation/login checks, including the actual pinned Supabase SDK with local fetch responses. No hosted invitation email or live Supabase Auth was tested.`);
} finally { pages.forEach(page => page.close()); }

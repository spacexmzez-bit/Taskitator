import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
const root = new URL('../', import.meta.url);
class LocalStorage {
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; }
    setItem(key, value) { this[key] = String(value); }
    removeItem(key) { delete this[key]; }
}
function client() {
    const storage = new LocalStorage();
    const window = { TASKITATOR_AUTH_CONFIG: { workerUrl:'https://worker.test' },
        location: { pathname:'/login.html', replace() {}, reload() {} },
        addEventListener() {}, dispatchEvent() {}, Clerk: { user:{id:'user_A'}, session:{id:'sess_A',getToken:async()=> 'memory-only'} } };
    const context = vm.createContext({window, localStorage:storage, sessionStorage:new LocalStorage(),
        location:window.location, crypto:webcrypto, TextEncoder, AbortSignal, AbortController, Headers, Response,
        setTimeout,clearTimeout,console,document:{addEventListener(){},visibilityState:'visible'},
        CustomEvent: class { constructor(name){this.type=name;} },
        fetch:async()=> Response.json({}) });
    vm.runInContext(fs.readFileSync(new URL('auth-client.js',root),'utf8'),context);
    return { storage, window, context, auth:window.TaskitatorAuth };
}
test('legacy cleanup removes credentials from settings, archive keys, values, and rotation records while keeping drafts',()=>{
    const {storage,auth}=client(), secret='a'.repeat(64);
    const settings={worker_username:'rd',worker_passkey:secret,gemini_api_key:'keep-ai-key',day_start_hour:2};
    storage.setItem('taskitator_settings',JSON.stringify(settings));
    storage.setItem('taskitator_account_cache:rd:'+secret,JSON.stringify({
        taskitator_tasks:'[{"title":"Keep draft"}]',taskitator_settings:JSON.stringify(settings),
        taskitator_pending_rotation:JSON.stringify({old_token:secret,new_token:'b'.repeat(64)})}));
    storage.setItem('taskitator_pending_rotation',JSON.stringify({old_token:secret}));
    auth.cleanLegacyStorage();
    assert.equal(JSON.stringify(storage).includes(secret),false);
    assert.equal(JSON.stringify(storage).includes('b'.repeat(64)),false);
    const archive=JSON.parse(storage.getItem('taskitator_account_cache_v2:rd'));
    assert.equal(JSON.parse(archive.taskitator_tasks)[0].title,'Keep draft');
    assert.equal(JSON.parse(storage.getItem('taskitator_settings')).gemini_api_key,'keep-ai-key');
});
test('backup sanitation excludes authentication and AI secrets, while normal sync preserves AI settings',()=>{
    const {auth}=client();const raw={worker_passkey:'old',phone_token:'phone',session_token:'session',worker_username:'rd',gemini_api_key:'ai',sound_effects_enabled:false};
    const backup=auth.cleanSettings(raw,true);
    for(const key of ['worker_passkey','phone_token','session_token','worker_username','gemini_api_key'])assert.equal(backup[key],undefined);
    assert.equal(backup.sound_effects_enabled,false);
    assert.equal(auth.cleanSettings(raw).gemini_api_key,'ai');
    assert.equal(raw.worker_passkey,'old');
});
test('sync archive keys do not contain bearer credentials and logout awaits revocation',async()=>{
    const {storage,auth,window,context}=client();
    auth.account={user:'rd',display_name:'rd',user_id:'user_A'};
    storage.setItem('taskitator_settings','{"worker_username":"rd"}');
    storage.setItem('taskitator_tasks','[{"title":"Offline draft"}]');
    storage.setItem('taskitator_local_owner','rd');
    vm.runInContext(fs.readFileSync(new URL('sync-engine.js',root),'utf8'),context);
    assert.equal(window.SyncEngine.isConfigured(),true);
    assert.equal(window.SyncEngine.accountCacheKey(window.SyncEngine.getConfig()),'taskitator_account_cache_v2:rd');
    let revoked=false;
    auth.signOut=async()=>{assert.equal(storage.getItem('taskitator_tasks')!==null,true);revoked=true;auth.account=null;};
    await window.SyncEngine.logout();
    assert.equal(revoked,true);assert.equal(storage.getItem('taskitator_tasks'),null);
    assert.equal(JSON.parse(JSON.parse(storage.getItem('taskitator_account_cache_v2:rd')).taskitator_tasks)[0].title,'Offline draft');
});
test('HTML inline scripts have matching CSP hashes and no inline event handlers remain',()=>{
    for(const filename of fs.readdirSync(root).filter(name=>name.endsWith('.html'))){
        const html=fs.readFileSync(new URL(filename,root),'utf8');
        const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
        assert.ok(csp,filename+' CSP missing');assert.ok(csp.includes("script-src-attr 'none'"));
        assert.equal(/\son(?:click|change|load|error)\s*=/i.test(html),false,filename+' event handler');
        for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
            if(/\bsrc=/.test(match[1])||!match[2].trim())continue;
            const hash="'sha256-"+createHash('sha256').update(match[2]).digest('base64')+"'";
            assert.ok(csp.includes(hash),filename+' CSP does not match inline code');
        }
        assert.ok(html.includes('auth-bootstrap.js'));
    }
});

test('page bootstrap activates the security cache before initializing an authenticated page',async()=>{
    const source=fs.readFileSync(new URL('auth-bootstrap.js',root),'utf8');
    const calls=[],listeners=new Map();
    const status={style:{},append(){},remove(){calls.push('shown')},textContent:''};
    const document={body:{append(){}},createElement:()=>status,querySelectorAll:()=>[],documentElement:{classList:{remove(){}}}};
    const serviceWorker={controller:{postMessage(message,ports){ports[0].postMessage({version:'old-cache'});ports[0].close();}},
        addEventListener(name,fn){listeners.set(name,fn)},removeEventListener(name){listeners.delete(name)},
        async register(){calls.push('register');return {async update(){
            serviceWorker.controller={postMessage(message,ports){ports[0].postMessage({version:'taskitator-security-clerk-v2'});ports[0].close();}};
            await listeners.get('controllerchange')();
        }}}};
    const auth={signedIn:true,account:{user:'rd'},async init(){calls.push('authenticate')}};
    const window={dispatchEvent(){calls.push('ready')},Clerk:{session:{id:'sess_A'},addListener(){}}};
    const storage=new LocalStorage();storage.setItem('taskitator_local_owner','rd');
    const context=vm.createContext({window,document,navigator:{serviceWorker},TaskitatorAuth:auth,
        localStorage:storage,location:{pathname:'/index.html',replace(){calls.push('redirect')}},
        MessageChannel,Event,setTimeout,clearTimeout});
    await vm.runInContext(source,context);
    assert.deepEqual(calls,['register','authenticate','ready','shown']);
});

test('switching a managed login preserves the previous account drafts under their original owner',()=>{
    const {storage,auth,window,context}=client();
    auth.account={user:'newuser',user_id:'user_A'};
    storage.setItem('taskitator_local_owner','olduser');
    storage.setItem('taskitator_settings','{"worker_username":"olduser"}');
    storage.setItem('taskitator_tasks','[{"title":"Old unsynced draft"}]');
    vm.runInContext(fs.readFileSync(new URL('sync-engine.js',root),'utf8'),context);
    window.SyncEngine.beginLogin('newuser');
    const archive=JSON.parse(storage.getItem('taskitator_account_cache_v2:olduser'));
    assert.equal(JSON.parse(archive.taskitator_tasks)[0].title,'Old unsynced draft');
    assert.equal(storage.getItem('taskitator_tasks'),null);
    assert.equal(storage.getItem('taskitator_local_owner'),'newuser');
});

test('multiple password-era copies survive cleanup, with newest dated copy selected and no credential remnants',()=>{
    const {storage,auth}=client();
    const snapshots=['old draft','new unique draft'].map((title,index)=>({
        taskitator_tasks:JSON.stringify([{title}]),
        taskitator_tasks_last_modified:`2026-10-${10+index}T12:00:00Z`,
        taskitator_settings:JSON.stringify({worker_passkey:String(index).repeat(64),session_token:'secret',day_start_hour:2})
    }));
    snapshots.forEach((snapshot,index)=>storage.setItem('taskitator_account_cache:rd:'+String(index).repeat(64),JSON.stringify(snapshot)));
    auth.cleanLegacyStorage();
    assert.equal(JSON.parse(JSON.parse(storage.getItem('taskitator_account_cache_v2:rd')).taskitator_tasks)[0].title,'new unique draft');
    assert.equal(auth.recoveryCopies('rd').length,2);
    assert.equal(JSON.stringify(storage).includes('old draft'),true);
    for(const secret of ['0'.repeat(64),'1'.repeat(64),'secret'])assert.equal(JSON.stringify(storage).includes(secret),false);
    auth.cleanLegacyStorage();assert.equal(auth.recoveryCopies('rd').length,2);
});

test('an existing v2 archive is preserved alongside a distinct legacy copy and recovery lists are account-specific',()=>{
    const {storage,auth}=client();
    storage.setItem('taskitator_account_cache_v2:rd',JSON.stringify({taskitator_tasks:'[{"title":"existing copy"}]'}));
    storage.setItem('taskitator_account_cache:rd:old',JSON.stringify({taskitator_tasks:'[{"title":"legacy copy"}]'}));
    auth.cleanLegacyStorage();
    assert.equal(auth.recoveryCopies('rd').length,2);
    assert.equal(auth.recoveryCopies('other').length,0);
    assert.equal(JSON.stringify(storage).includes('legacy copy'),true);
    assert.equal(JSON.stringify(storage).includes('existing copy'),true);
});

test('corrupt legacy caches and backups do not stop cleanup of healthy copies or erase unreadable data',()=>{
    const {storage,auth}=client();
    storage.setItem('taskitator_account_cache:broken:old','invalid JSON');
    storage.setItem('taskitator_unclaimed_backup','invalid backup');
    storage.setItem('taskitator_account_cache:rd:old',JSON.stringify({taskitator_tasks:'[]'}));
    storage.setItem('taskitator_settings',JSON.stringify({worker_passkey:'secret',worker_username:'rd'}));
    assert.doesNotThrow(()=>auth.cleanLegacyStorage());
    assert.equal(storage.getItem('taskitator_account_cache:broken:old'),'invalid JSON');
    assert.equal(storage.getItem('taskitator_unclaimed_backup'),'invalid backup');
    assert.equal(storage.getItem('taskitator_account_cache:rd:old'),null);
    assert.ok(storage.getItem('taskitator_account_cache_v2:rd'));
    assert.equal(JSON.parse(storage.getItem('taskitator_settings')).worker_passkey,undefined);
    assert.equal(auth.storageWarnings.length,2);
});

test('failed recovery storage writes never delete the legacy draft',()=>{
    const {storage,auth}=client();
    const old=JSON.stringify({taskitator_tasks:'[{"title":"keep me"}]'});
    storage.setItem('taskitator_account_cache:rd:old',old);
    storage.setItem('taskitator_account_cache_v2:rd',JSON.stringify({taskitator_tasks:'[]'}));
    const set=storage.setItem.bind(storage);
    storage.setItem=(key,value)=>{if(key.startsWith('taskitator_account_recovery_v1:'))throw new Error('quota');set(key,value);};
    auth.cleanLegacyStorage();
    assert.equal(storage.getItem('taskitator_account_cache:rd:old'),old);
    assert.ok(auth.storageWarnings.length);
});

async function loginFixture(results, copies=[]) {
    const {storage,auth,window,context}=client();
    const elements=new Map(), redirects=[],downloads=[];
    const element=id=>{
        if(!elements.has(id))elements.set(id,{hidden:true,value:id==='legacyUsername'?'rd':'old password',children:[],
            append(...children){this.children.push(...children)},replaceChildren(){this.children=[]},remove(){},
            click(){if(this.download)downloads.push(this)}});
        return elements.get(id);
    };
    context.document={getElementById:element,createElement:tag=>element('generated-'+elements.size+'-'+tag),body:{append(){}}};
    context.TaskitatorAuth=auth;auth.recoveryCopies=()=>copies;
    auth.connect=async()=>auth.account={user:'rd'};
    context.SyncEngine={beginLogin(){},async pull(){return results.shift()||{success:true}}};
    context.location.origin='https://app.test';context.location.replace=path=>redirects.push(path);
    context.confirm=()=>true;
    context.URL={createObjectURL:blob=>{downloads.push(blob);return 'blob:test'},revokeObjectURL(){}};
    context.Blob=Blob;context.setTimeout=()=>0;
    await vm.runInContext(fs.readFileSync(new URL('login-page.js',root),'utf8'),context);
    return {auth,storage,element,redirects,downloads};
}

test('first migration conflict exposes working Continue and completes after resolution',async()=>{
    const f=await loginFixture([{success:false,conflict:true},{success:true}]);
    await f.element('migrationForm').onsubmit({preventDefault(){}});
    assert.equal(f.element('continueBtn').hidden,false);
    assert.equal(f.element('connectPanel').hidden,true);
    assert.equal(f.element('legacyPassword').value,'');
    assert.equal(f.redirects.length,0);
    await f.element('continueBtn').onclick();
    assert.deepEqual(f.redirects,['index.html']);
});

test('new-account initial sync failure is retryable without creating or reconnecting an account',async()=>{
    const f=await loginFixture([{success:false,error:'network unavailable'},{success:true}]);
    await f.element('newAccountBtn').onclick({target:f.element('newAccountBtn')});
    assert.equal(f.element('continueBtn').hidden,false);
    assert.equal(f.element('continueBtn').disabled,false);
    assert.match(f.element('loginFeedback').textContent,/network unavailable/);
    await f.element('continueBtn').onclick();
    assert.deepEqual(f.redirects,['index.html']);
});

test('recovered copies are downloadable before first sync and exports omit all credentials',async()=>{
    const f=await loginFixture([{success:true}],[{taskitator_tasks:'[{"title":"recovered task"}]',
        taskitator_settings:JSON.stringify({worker_passkey:'old',session_token:'session',phone_token:'phone',gemini_api_key:'gemini',claude_api_key:'claude',worker_username:'rd',day_start_hour:2})}]);
    await f.element('migrationForm').onsubmit({preventDefault(){}});
    assert.equal(f.redirects.length,0);
    assert.equal(f.element('recoveryPanel').hidden,false);
    f.element('recoveryPanel').children[1].onclick();
    const exported=JSON.parse(await f.downloads[0].text());
    assert.equal(exported.taskitator_tasks[0].title,'recovered task');
    assert.deepEqual(exported.taskitator_settings,{day_start_hour:2});
    await f.element('continueBtn').onclick();
    assert.deepEqual(f.redirects,['index.html']);
});

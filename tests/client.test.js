import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import {toClaudeRequest} from '../cloudflare/ai-gateway.js';
import {validatePayload} from '../cloudflare/vault.js';
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
        location:window.location, crypto:webcrypto, TextEncoder, AbortSignal, AbortController, Headers, Response, URL,
        setTimeout,clearTimeout,console,document:{addEventListener(){},getElementById(){return null;},visibilityState:'visible'},
        CustomEvent: class { constructor(name){this.type=name;} },
        fetch:async()=> Response.json({}) });
    vm.runInContext(fs.readFileSync(new URL('auth-client.js',root),'utf8'),context);
    return { storage, window, context, auth:window.TaskitatorAuth };
}
function loadVault(f){vm.runInContext(fs.readFileSync(new URL('vault-client.js',root),'utf8'),f.context);return f.window.TaskitatorVault;}
test('provider UI keeps each key metadata, activates explicitly and sends generation to the chosen provider',async()=>{
    const f=client(),events=new Map(),nodes=new Map(),requests=[];let selected='gemini';
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:'',style:{},handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){},append(){},setAttribute(){},showModal(){},close(){this.handlers.close?.();}});
        return nodes.get(id);
    };
    f.context.document.getElementById=node;f.context.document.querySelectorAll=()=>[];
    f.context.document.querySelector=()=>({click(){}});f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.auth.account={user:'rd'};
    const providers={gemini:{provider:'gemini',ready:true,saved:true,suffix:'1111',version:'gemini-v1',pending:[]},claude:{provider:'claude',ready:true,saved:true,suffix:'2222',version:'claude-v1',pending:[]}};
    const state=()=>({...providers.gemini,providers,selected_provider:selected});
    f.auth.api=async(path,options)=>{
        requests.push({path,body:options.body?JSON.parse(options.body):null});
        if(path==='/ai/provider')selected=JSON.parse(options.body).provider;
        if(path==='/ai/generate')return {candidates:[]};
        return state();
    };
    const vault=loadVault(f);await vault.initialize();await events.get('taskitator-auth-ready')();
    node('aiProviderSelect').handlers.change({target:{value:'claude'}});
    assert.equal(vault.provider,'gemini');assert.match(node('vaultStatus').textContent,/2222/);assert.equal(node('vaultUseProviderBtn').disabled,false);
    await node('vaultUseProviderBtn').handlers.click();assert.equal(vault.provider,'claude');
    await vault.generate('claude-haiku-5-5',{contents:[{parts:[{text:'Hello'}]}]});
    const call=requests.find(request=>request.path==='/ai/generate');assert.equal(call.body.provider,'claude');assert.equal(call.body.key_version,'claude-v1');
    node('aiProviderSelect').handlers.change({target:{value:'gemini'}});assert.match(node('vaultStatus').textContent,/1111/);
    assert.equal(vault.provider,'claude');assert.equal(JSON.stringify(f.storage).includes('api_key'),false);
});
test('Claude Copilot completes tool loops, preserves identifiers and cannot trash AI-locked tasks',async()=>{
    const f=client(),calls=[];f.context.document.readyState='loading';f.context.document.querySelectorAll=()=>[];
    f.storage.setItem('taskitator_tasks','[{"id":"locked","title":"Protected","ai_locked":true,"status":"active"}]');
    vm.runInContext(fs.readFileSync(new URL('safety.js',root),'utf8'),f.context);f.context.TaskitatorSafety=f.window.TaskitatorSafety;
    f.window.TaskitatorVault={available:true,selection:()=>({provider:'claude',primary:'claude-haiku-5-5',fallback:null,keyVersion:'v1'}),generate:async(model,payload,selection)=>{
        calls.push({model,payload,selection});const adapted=toClaudeRequest(validatePayload(payload));assert.equal(adapted.messages[0].role,'user');
        return Response.json({candidates:[{content:{parts:calls.length===1?[{functionCall:{id:'toolu_locked',name:'trash_task',args:{task_id:'locked'}}}]:[{text:'Protected task kept.'}]}}]});
    }};
    vm.runInContext(fs.readFileSync(new URL('agent-engine.js',root),'utf8'),f.context);
    const reply=await f.window.TaskitatorAgent.sendMessage('Trash protected task');assert.equal(reply.text,'Protected task kept.');assert.equal(calls.length,2);
    assert.equal(calls[1].payload.contents.at(-1).parts[0].functionResponse.id,'toolu_locked');
    assert.equal(calls[1].payload.contents.at(-1).parts[0].functionResponse.response.status,'error');
    assert.match(calls[1].payload.contents.at(-1).parts[0].functionResponse.response.error,/AI|locked|bypass/i);
    assert.equal(JSON.parse(f.storage.getItem('taskitator_tasks'))[0].status,'active');assert.ok(calls.every(call=>call.model==='claude-haiku-5-5'));
});
test('long Claude conversations retain complete tool turns and provider changes clear prior context',async()=>{
    const f=client(),events=new Map();f.context.document.readyState='loading';let selection={provider:'claude',primary:'claude-haiku-5-5',fallback:null,keyVersion:'v1'},calls=0;
    f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.window.TaskitatorVault={available:true,selection:()=>selection,generate:async(model,payload)=>{
        calls++;toClaudeRequest(validatePayload(payload));
        return Response.json({candidates:[{content:{parts:calls%2?[{functionCall:{id:'toolu_'+calls,name:'get_tasks',args:{}}}]:[{text:'Done'}]}}]});
    }};
    vm.runInContext(fs.readFileSync(new URL('agent-engine.js',root),'utf8'),f.context);
    for(let turn=0;turn<6;turn++)assert.equal((await f.window.TaskitatorAgent.sendMessage('List turn '+turn)).text,'Done');
    assert.ok(f.window.TaskitatorAgent.getHistory().length>8);
    selection={provider:'gemini',primary:'gemini-3.5-flash-lite',fallback:'gemini-3.1-flash-lite',keyVersion:'v2'};
    events.get('taskitator-ai-provider-changed')();assert.equal(f.window.TaskitatorAgent.getHistory().length,0);
});
test('Claude criteria errors do not call Gemini or reuse another provider validation cache',async()=>{
    const f=client(),calls=[];let provider='gemini';
    f.window.TaskitatorVault={available:true,selection:()=>({provider,primary:provider==='gemini'?'gemini-3.5-flash-lite':'claude-haiku-5-5',fallback:provider==='gemini'?'gemini-3.1-flash-lite':null,keyVersion:provider}),generate:async(model,payload,selection)=>{
        calls.push({model,payload,selection});
        return provider==='gemini'?Response.json({candidates:[{content:{parts:[{text:'{"score":9,"passed":true,"critique":"Good","suggested_rewrite":""}'}]}}]}):Response.json({error:{message:'Claude quota'}},{status:429});
    }};
    vm.runInContext(fs.readFileSync(new URL('audit-engine.js',root),'utf8'),f.context);
    assert.equal((await f.window.TaskitatorEngine.AuditEngine.validateCriteria('Photo of checklist','Task')).success,true);
    provider='claude';assert.equal((await f.window.TaskitatorEngine.AuditEngine.validateCriteria('Photo of checklist','Task')).success,false);
    assert.deepEqual(calls.map(call=>call.model),['gemini-3.5-flash-lite','claude-haiku-5-5']);assert.equal(calls[1].payload.taskitatorFormat,'criteria');
});
test('newer-website/older-Worker failures explain the deployment action without clearing drafts',async()=>{
    const f=client();f.storage.setItem('taskitator_tasks','[{"title":"Retain"}]');
    f.context.fetch=async()=>Response.json({error:'Endpoint not found. Password changes are managed through your account profile.'},{status:404});
    await assert.rejects(()=>f.auth.api('/ai/keys'),/GitHub Actions.*Deploy Taskitator security Worker/);assert.match(f.storage.getItem('taskitator_tasks'),/Retain/);
});
test('vault migrates only the current owner and removes plaintext only after encrypted staging succeeds',async()=>{
    const f=client();f.auth.account={user:'rd'};
    f.storage.setItem('taskitator_local_owner','rd');
    f.storage.setItem('taskitator_settings',JSON.stringify({worker_username:'rd',gemini_api_key:'AIza-owned-current',day_start_hour:2}));
    f.storage.setItem('taskitator_account_cache_v2:rd',JSON.stringify({taskitator_tasks:'["draft"]',taskitator_settings:'{"gemini_api_key":"AIza-owned-archive"}'}));
    f.storage.setItem('taskitator_account_cache_v2:other',JSON.stringify({taskitator_settings:'{"gemini_api_key":"AIza-other-private"}'}));
    let submitted;
    f.auth.api=async(path,options)=>{
        if(path==='/ai/keys')return {ready:true,saved:false,pending:[]};
        assert.ok(JSON.stringify(f.storage).includes('AIza-owned-current'));submitted=JSON.parse(options.body);
        return {ready:true,saved:false,pending:[{id:'a'.repeat(64),suffix:'rent'}]};
    };
    const vault=loadVault(f);await vault.initialize();
    assert.deepEqual(submitted.keys.sort(),['AIza-owned-archive','AIza-owned-current']);
    assert.equal(JSON.stringify(f.storage).includes('AIza-owned'),false);assert.equal(JSON.stringify(f.storage).includes('AIza-other-private'),true);
    assert.equal(JSON.parse(f.storage.getItem('taskitator_settings')).day_start_hour,2);
    assert.equal(JSON.parse(f.storage.getItem('taskitator_account_cache_v2:rd')).taskitator_tasks,'["draft"]');assert.equal(vault.available,false);
});
test('failed staging retains all original browser copies and does not write a secret into sessionStorage',async()=>{
    const f=client();f.auth.account={user:'rd'};f.storage.setItem('taskitator_local_owner','rd');
    f.storage.setItem('taskitator_settings','{"gemini_api_key":"AIza-retain-after-error"}');
    f.auth.api=async path=>{if(path==='/ai/keys')return {ready:true,saved:false,pending:[]};throw new Error('Storage unavailable');};
    const before=JSON.stringify(f.storage);await assert.rejects(()=>loadVault(f).initialize(),/Storage unavailable/);
    assert.equal(JSON.stringify(f.storage),before);assert.equal(JSON.stringify(f.context.sessionStorage).includes('AIza'),false);
});
test('vault gateway preserves provider errors and never adds keys to browser requests',async()=>{
    const f=client();let request;
    f.auth.api=async(path,options)=>{request={path,...options};const error=new Error('Quota exceeded');error.status=429;throw error;};
    const response=await loadVault(f).generate('gemini-3.1-flash-lite',{contents:[{parts:[{text:'Test'}]}]});
    assert.equal(response.status,429);assert.equal((await response.json()).error.message,'Quota exceeded');
    assert.equal(request.path,'/ai/generate');assert.equal(request.timeoutMs,70000);assert.equal(JSON.stringify(request).includes('api_key'),false);
});
test('evidence criteria and Copilot use the vault and retain Gemini fallback behavior without browser keys',async()=>{
    const f=client();const calls=[];let first=true;
    f.window.TaskitatorVault={available:true,generate:async(model,payload)=>{
        calls.push({model,payload});
        if(first){first=false;return Response.json({error:{message:'Quota'}},{status:429});}
        return Response.json({candidates:[{content:{parts:[{text:'{"score":9,"passed":true}'}]}}]});
    }};
    vm.runInContext(fs.readFileSync(new URL('audit-engine.js',root),'utf8'),f.context);
    const result=await f.window.TaskitatorEngine.AuditEngine.validateCriteria('Photo of completed checklist','Checklist');
    assert.equal(result.success,true);assert.equal(result.model_used,'gemini-3.1-flash-lite');
    assert.deepEqual(calls.map(call=>call.model),['gemini-3.5-flash-lite','gemini-3.1-flash-lite']);
    assert.ok(calls[0].payload.contents[0].parts[0].text.includes('Checklist'));
    calls.length=0;f.context.document.readyState='loading';
    vm.runInContext(fs.readFileSync(new URL('agent-engine.js',root),'utf8'),f.context);
    const reply=await f.window.TaskitatorAgent.sendMessage('Hello');assert.equal(typeof reply.text,'string');assert.equal(calls.length,1);assert.ok(calls[0].payload.tools);
});

test('Google key callback opens Account controls and permits one verified reveal with clipboard fallback',async()=>{
    const f=client(),events=new Map(),nodes=new Map();let accountTabOpened=false;
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:'',style:{},handlers:{},
            addEventListener(name,fn){this.handlers[name]=fn;},replaceChildren(){},append(){},
            showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();}});
        return nodes.get(id);
    };
    f.context.document.getElementById=node;
    f.context.document.querySelector=selector=>({click(){assert.equal(selector,'.tab-btn[data-tab="tab-account"]');accountTabOpened=true;}});
    f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.auth.account={user:'rd'};const proof='a'.repeat(64);
    f.context.sessionStorage.setItem('taskitator_key_verification',JSON.stringify({kind:'copy',stageId:null,proofId:proof,user:'rd',session:'sess_A'}));
    f.context.location.hash='#key-verification='+proof;f.context.history={replaceState(){}};
    f.context.navigator={clipboard:{writeText:async()=>{throw new Error('permission denied');}}};
    f.auth.api=async(path,options)=>{
        const body=JSON.parse(options.body);assert.equal(body.verification_id,proof);
        if(path==='/auth/verification/status'){assert.equal(body.action,'api-key-reveal');return {verified:true};}
        assert.equal(path,'/ai/keys/reveal');return {key:'AIza-visible-after-Google',reveal_seconds:30};
    };
    const vault=loadVault(f);await events.get('taskitator-auth-ready')();
    assert.equal(accountTabOpened,true);assert.equal(node('vaultDialog').open,true);
    assert.equal(node('vaultConfirmBtn').disabled,false);
    await node('vaultConfirmBtn').handlers.click();
    assert.equal(node('vaultRevealedKey').value,'AIza-visible-after-Google');assert.equal(node('vaultRevealArea').hidden,false);
    assert.match(node('vaultFeedback').textContent,/Copy displayed key/);
    assert.equal(f.context.sessionStorage.getItem('taskitator_key_verification'),null);
    vault.clear();assert.equal(node('vaultRevealedKey').value,'');assert.equal(node('vaultRevealArea').hidden,true);
});

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
test('backup sanitation excludes authentication and AI secrets, and normal sync also omits AI keys',()=>{
    const {auth}=client();const raw={worker_passkey:'old',phone_token:'phone',session_token:'session',worker_username:'rd',gemini_api_key:'ai',sound_effects_enabled:false};
    const backup=auth.cleanSettings(raw,true);
    for(const key of ['worker_passkey','phone_token','session_token','worker_username','gemini_api_key'])assert.equal(backup[key],undefined);
    assert.equal(backup.sound_effects_enabled,false);
    assert.equal(auth.cleanSettings(raw).gemini_api_key,undefined);
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
        if (['account-deletion.html','welcome.html','privacy.html','terms.html','PHASE-1-SETUP.html','PHASE-2-SETUP.html','PHASE-3-SETUP.html'].includes(filename)) {
            assert.equal(/<script\b[^>]*\bsrc=["']auth-bootstrap\.js["']/.test(html),false);
        } else assert.ok(html.includes('auth-bootstrap.js'));
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
            serviceWorker.controller={postMessage(message,ports){ports[0].postMessage({version:'taskitator-phase-3-providers-v1'});ports[0].close();}};
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

function deletionClient() {
    const f=client(), elements=new Map(),events=new Map(),calls=[];
    const element=id=>{
        if(!elements.has(id))elements.set(id,{value:'',checked:false,hidden:false,disabled:false,
            listeners:new Map(),addEventListener(name,fn){this.listeners.set(name,fn)},showModal(){this.open=true},close(){this.open=false}});
        return elements.get(id);
    };
    f.context.document.getElementById=element;
    f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.context.location.hash='';f.context.history={replaceState(){}};
    f.window.TASKITATOR_AUTH_CONFIG={workerUrl:'https://worker.test'};
    f.window.Clerk.user.passwordEnabled=true;
    f.window.Clerk.session.startVerification=async()=>{calls.push('clerk-start')};
    f.window.Clerk.session.attemptFirstFactorVerification=async body=>{calls.push(['clerk-password',body.password]);return {status:'complete'}};
    f.auth.account={user:'rd'};
    f.auth.api=async(path,options)=>{
        calls.push([path,JSON.parse(options.body)]);
        if(path.endsWith('/start'))return {verification_id:'a'.repeat(64)};
        if(path.endsWith('/password'))return {verified:true};
        return {verified:true};
    };
    vm.runInContext(fs.readFileSync(new URL('deletion-client.js',root),'utf8'),f.context);
    return {...f,element,events,calls};
}
test('deletion confirmation blocks paste/drop and requires verification, checkbox, and exact manually entered phrase',async()=>{
    const f=deletionClient();await f.events.get('taskitator-auth-ready')();
    f.element('openAccountDeletionBtn').listeners.get('click')();
    assert.equal(f.element('confirmAccountDeletionBtn').disabled,true);
    let prevented=0;
    for(const name of ['paste','drop'])f.element('deletionPhrase').listeners.get(name)({preventDefault(){prevented++}});
    f.element('deletionPhrase').listeners.get('beforeinput')({inputType:'insertFromPaste',preventDefault(){prevented++}});
    assert.equal(prevented,3);
    f.element('deletionPassword').value='private-password';
    await f.element('verifyDeletionPasswordBtn').listeners.get('click')();
    assert.equal(f.element('deletionPassword').value,'');
    assert.equal(f.calls.filter(Array.isArray).some(call=>call[0].startsWith('/auth/') && JSON.stringify(call[1]).includes('private-password')),false);
    assert.equal(f.element('confirmAccountDeletionBtn').disabled,true);
    f.element('deletionBlockerDisabled').checked=true;f.element('deletionPhrase').value='Macrodroid disabled';
    f.element('deletionPhrase').listeners.get('input')();
    assert.equal(f.element('confirmAccountDeletionBtn').disabled,false);
    f.element('deletionPhrase').value='Macrodroid disabled ';f.element('deletionPhrase').listeners.get('input')();
    assert.equal(f.element('confirmAccountDeletionBtn').disabled,true);
});
test('accepted account local cleanup removes only that owner and preserves other account archives',async()=>{
    const f=deletionClient();let removedFiles;
    f.window.ExemplarStore={async deleteAccountFiles(user){removedFiles=user;return true}};
    f.window.SyncEngine={clearLocalAccount(){f.storage.removeItem('taskitator_tasks');f.storage.removeItem('taskitator_settings');f.storage.removeItem('taskitator_local_owner')}};
    f.storage.setItem('taskitator_local_owner','rd');f.storage.setItem('taskitator_tasks','private');f.storage.setItem('taskitator_settings','{"gemini_api_key":"private-key"}');
    f.storage.setItem('taskitator_account_cache_v2:rd','private-copy');
    f.storage.setItem('taskitator_account_recovery_v1:rd','private-copy');
    f.storage.setItem('taskitator_account_cache:rd:old-token','private-copy');
    f.storage.setItem('taskitator_account_cache_v2:other','keep');
    assert.equal(await f.window.TaskitatorAccountDeletion.cleanLocal('rd'),true);
    assert.equal(removedFiles,'rd');assert.equal(JSON.stringify(f.storage).includes('private'),false);
    assert.equal(f.storage.getItem('taskitator_account_cache_v2:other'),'keep');
});
test('Settings initially activates Tags & Priority and keeps local reset distinct from cloud deletion',()=>{
    const html=fs.readFileSync(new URL('settings.html',root),'utf8');
    assert.match(html,/<button[^>]*class="tab-btn active"[^>]*data-tab="tab-tasks"/);
    assert.match(html,/<div class="tab-pane active" id="tab-tasks">/);
    assert.doesNotMatch(html,/<div class="tab-pane active" id="tab-account">/);
    assert.ok(html.includes('This does NOT delete your cloud account or cloud data.'));
    const system=html.slice(html.indexOf('id="tab-system"'),html.indexOf('id="tab-tasks"'));
    for(const href of ['privacy.html','terms.html','privacy.html#deletion'])assert.ok(system.includes('href="'+href+'"'),href+' must be reachable under System');
});

function verificationVaultClient() {
    const f=client(),events=new Map(),nodes=new Map(),calls=[],redirects=[];
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:'',style:{},handlers:{},
            addEventListener(name,fn){this.handlers[name]=fn},replaceChildren(){},append(){},setAttribute(){},
            showModal(){this.open=true},close(){this.open=false;this.handlers.close?.()}});
        return nodes.get(id);
    };
    f.context.document.getElementById=node;f.context.document.querySelector=()=>({click(){}});
    f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.context.location.assign=url=>redirects.push(url);f.auth.account={user:'rd'};
    f.window.Clerk.user.passwordEnabled=true;
    f.window.Clerk.session.startVerification=async()=>{};
    f.window.Clerk.session.attemptFirstFactorVerification=async()=>({status:'complete'});
    f.auth.api=async(path,options)=>{
        calls.push({path,options});
        if(path.endsWith('/start'))return {verification_id:'a'.repeat(64)};
        return {verified:true};
    };
    loadVault(f);
    return {...f,node,events,calls,redirects};
}
const invalidGoogleUrls=[undefined,null,'','not a URL','/o/oauth2/v2/auth','javascript:alert(1)',
    'http://accounts.google.com/o/oauth2/v2/auth','https://accounts.google.com.evil.test/o/oauth2/v2/auth',
    'https://accounts.google.com@evil.test/o/oauth2/v2/auth','https://evil@accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com:444/o/oauth2/v2/auth','https://accounts.google.com/wrong',
    'https://accounts.google.com/o/oauth2/v2/auth#evil'];
const googleUrl='https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state='+'a'.repeat(64);
test('vault rejects missing or unsafe Google URLs and ignores old verified shortcut for every provider/action',async()=>{
    for(const provider of ['gemini','claude'])for(const kind of ['Save','Show','Copy','Delete'])for(const authorization_url of invalidGoogleUrls){
        const f=verificationVaultClient();await f.events.get('taskitator-auth-ready')();
        f.node('aiProviderSelect').handlers.change({target:{value:provider}});
        f.node('vault'+kind+'Btn').handlers.click();
        f.auth.api=async()=>({verified:true,verification_id:'a'.repeat(64),authorization_url});
        await f.node('vaultGoogleBtn').handlers.click();
        assert.equal(f.redirects.length,0);assert.equal(f.node('vaultConfirmBtn').disabled,true);
        assert.match(f.node('vaultDialogFeedback').textContent,/missing or invalid.*retry or cancel/);
        assert.equal(f.node('vaultGoogleBtn').disabled,false);assert.equal(f.node('vaultCancelBtn').disabled,false);
        assert.equal(f.context.sessionStorage.getItem('taskitator_key_verification'),null);
    }
});
test('valid Google URLs redirect with pending provider/action metadata and no password or API key',async()=>{
    for(const provider of ['gemini','claude'])for(const [kind,action] of [['Save','api-key-save'],['Show','api-key-reveal'],['Copy','api-key-reveal'],['Delete','api-key-delete']]){
        const f=verificationVaultClient();await f.events.get('taskitator-auth-ready')();
        f.node('aiProviderSelect').handlers.change({target:{value:provider}});f.node('vault'+kind+'Btn').handlers.click();
        f.node('vaultPassword').value='private-password';f.node('vaultNewKey').value='private-api-key';
        f.auth.api=async(path,options)=>{
            const body=JSON.parse(options.body);assert.equal(body.action,action);assert.equal(body.provider,provider);
            assert.equal(JSON.stringify(options).includes('private-'),false);
            return {verified:true,verification_id:'a'.repeat(64),authorization_url:googleUrl};
        };
        await f.node('vaultGoogleBtn').handlers.click();
        assert.deepEqual(f.redirects,[googleUrl]);assert.equal(f.node('vaultConfirmBtn').disabled,true);
        const pending=JSON.parse(f.context.sessionStorage.getItem('taskitator_key_verification'));
        assert.equal(pending.provider,provider);assert.equal(pending.kind,({Save:'save',Show:'reveal',Copy:'copy',Delete:'delete'})[kind]);
        assert.equal(pending.session,'sess_A');assert.equal(pending.user,'rd');
        assert.equal(JSON.stringify(f.context.sessionStorage).includes('private-'),false);
        assert.equal(f.node('vaultNewKey').value,'');assert.equal(f.node('vaultPassword').value,'');
    }
});
test('deletion validates Google URLs, releases busy state on failure, and never deletes from verification',async()=>{
    for(const authorization_url of [...invalidGoogleUrls,googleUrl]){
        const f=deletionClient(),redirects=[],requests=[];await f.events.get('taskitator-auth-ready')();
        f.context.location.assign=url=>redirects.push(url);f.element('openAccountDeletionBtn').listeners.get('click')();
        f.auth.api=async(path)=>{requests.push(path);return {verified:true,verification_id:'a'.repeat(64),authorization_url}};
        await f.element('verifyDeletionGoogleBtn').listeners.get('click')();
        assert.deepEqual(requests,['/auth/verification/start']);assert.equal(f.element('confirmAccountDeletionBtn').disabled,true);
        if(authorization_url===googleUrl)assert.deepEqual(redirects,[googleUrl]);
        else{
            assert.equal(redirects.length,0);assert.match(f.element('accountDeletionFeedback').textContent,/missing or invalid.*retry or cancel/);
            assert.equal(f.element('verifyDeletionGoogleBtn').disabled,false);assert.equal(f.element('cancelAccountDeletionBtn').disabled,false);
        }
    }
});
test('failed Clerk or Worker password confirmation never enables sensitive actions and clears entered passwords',async()=>{
    for(const failure of ['incomplete','clerk-error','worker-error'])for(const type of ['vault','deletion']){
        const f=type==='vault'?verificationVaultClient():deletionClient();
        await f.events.get('taskitator-auth-ready')();
        const get=type==='vault'?f.node:f.element;
        const click=id=>type==='vault'?get(id).handlers.click():get(id).listeners.get('click')();
        click(type==='vault'?'vaultSaveBtn':'openAccountDeletionBtn');
        get(type==='vault'?'vaultPassword':'deletionPassword').value='private-password';
        const workerRequests=[];let attempts=0;
        f.window.Clerk.session.attemptFirstFactorVerification=async body=>{
            attempts++;assert.equal(body.password,'private-password');assert.equal(body.strategy,'password');
            if(failure==='clerk-error')throw new Error('Incorrect password');
            return {status:failure==='incomplete'?'needs_first_factor':'complete'};
        };
        f.auth.api=async(path,options)=>{
            workerRequests.push({path,options});
            if(path.endsWith('/password'))throw new Error('Password verification has not completed.');
            return {verification_id:'a'.repeat(64)};
        };
        await click(type==='vault'?'vaultPasswordBtn':'verifyDeletionPasswordBtn');
        assert.equal(attempts,1);assert.equal(get(type==='vault'?'vaultPassword':'deletionPassword').value,'');
        assert.equal(JSON.stringify(workerRequests).includes('private-password'),false);
        assert.equal(workerRequests.some(r=>r.path.endsWith('/password')),failure==='worker-error');
        if(type==='deletion'){
            get('deletionBlockerDisabled').checked=true;get('deletionPhrase').value='Macrodroid disabled';get('deletionPhrase').listeners.get('input')();
        }
        assert.equal(get(type==='vault'?'vaultConfirmBtn':'confirmAccountDeletionBtn').disabled,true);
        assert.equal(get(type==='vault'?'vaultCancelBtn':'cancelAccountDeletionBtn').disabled,false);
    }
});
test('vault password success uses only the Clerk SDK for passwords and fresh Worker authorization',async()=>{
    const f=verificationVaultClient();await f.events.get('taskitator-auth-ready')();f.node('vaultSaveBtn').handlers.click();
    f.node('vaultPassword').value='private-password';let clerkPassword;
    f.window.Clerk.session.attemptFirstFactorVerification=async body=>{clerkPassword=body.password;return {status:'complete'}};
    await f.node('vaultPasswordBtn').handlers.click();
    assert.equal(clerkPassword,'private-password');assert.equal(f.node('vaultConfirmBtn').disabled,false);
    assert.equal(JSON.stringify(f.calls).includes('private-password'),false);
    assert.equal(f.calls.find(call=>call.path.endsWith('/password')).options.freshToken,true);
});

test('Google callback recovery preserves each provider/action and waits for explicit confirmation',async()=>{
    for(const provider of ['gemini','claude'])for(const kind of ['save','delete','reveal','copy']){
        const f=verificationVaultClient(),proof='a'.repeat(64),requests=[];
        f.context.sessionStorage.setItem('taskitator_key_verification',JSON.stringify({kind,provider,stageId:null,proofId:proof,user:'rd',session:'sess_A'}));
        f.context.location.hash='#key-verification='+proof;f.context.history={replaceState(){}};
        f.auth.api=async(path,options)=>{
            requests.push({path,options});assert.equal(path,'/auth/verification/status');
            const body=JSON.parse(options.body);assert.equal(body.action,'api-key-'+(['copy','reveal'].includes(kind)?'reveal':kind));
            return {verified:true,context:{provider}};
        };
        await f.events.get('taskitator-auth-ready')();
        assert.equal(f.node('vaultDialog').open,true);assert.equal(f.node('vaultConfirmBtn').disabled,false);
        assert.equal(requests.length,1);assert.equal(f.node('aiProviderSelect').value,provider);
        assert.equal(f.context.sessionStorage.getItem('taskitator_key_verification'),null);
    }
});
test('Google callback with wrong pending session or provider never enables confirmation',async()=>{
    for(const mismatch of ['session','provider','proof']){
        const f=verificationVaultClient(),proof='a'.repeat(64),requests=[];
        f.node('vaultConfirmBtn').disabled=true;
        f.context.sessionStorage.setItem('taskitator_key_verification',JSON.stringify({kind:'save',provider:'claude',stageId:null,
            proofId:mismatch==='proof'?'b'.repeat(64):proof,user:'rd',session:mismatch==='session'?'sess_other':'sess_A'}));
        f.context.location.hash='#key-verification='+proof;f.context.history={replaceState(){}};
        f.auth.api=async(path)=>{requests.push(path);return {verified:true,context:{provider:'gemini'}}};
        await f.events.get('taskitator-auth-ready')();
        assert.equal(f.node('vaultConfirmBtn').disabled,true);
        assert.deepEqual(requests,mismatch==='provider'?['/auth/verification/status']:[]);
    }
});
test('Google deletion callback only verifies identity and resets manual deletion gates',async()=>{
    const f=deletionClient(),requests=[];f.context.location.hash='#delete-verification='+'a'.repeat(64);
    f.element('deletionPhrase').value='Macrodroid disabled';f.element('deletionBlockerDisabled').checked=true;
    f.auth.api=async(path)=>{requests.push(path);return {verified:true}};
    await f.events.get('taskitator-auth-ready')();
    assert.deepEqual(requests,['/auth/verification/status']);assert.equal(f.element('accountDeletionDialog').open,true);
    assert.equal(f.element('deletionPhrase').value,'');assert.equal(f.element('deletionBlockerDisabled').checked,false);
    assert.equal(f.element('confirmAccountDeletionBtn').disabled,true);
});

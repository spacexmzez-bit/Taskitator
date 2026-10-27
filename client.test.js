import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import {toClaudeRequest} from './worker.js';
import {validatePayload} from './worker.js';
const root = new URL('./', import.meta.url);

const TEST_ROOT = new URL('./', import.meta.url);
function readConsolidatedSource(name) {
    const clean = name.replace(/^\.\.\//, '').replace(/^\.\//, '');
    const directPath = new URL(clean, TEST_ROOT);
    if (fs.existsSync(directPath)) {
        return fs.readFileSync(directPath, 'utf8');
    }
    if (clean === 'stats.html') {
        const compHtml = fs.readFileSync(new URL('components.html', TEST_ROOT), 'utf8');
        const m = compHtml.match(/\/\/ <<< MODULE_START: stats\.html >>>([\s\S]*?)\/\/ <<< MODULE_END: stats\.html >>>/);
        if (m) {
            const inner = m[1].trim().replace(/^\(\(\) => \{/, '').replace(/\}\)\(\);$/, '');
            return `<script type="text/taskitator-script">${inner}</script>`;
        }
    }
    if (clean === 'pro/compare.html') {
        const compHtml = fs.readFileSync(new URL('components.html', TEST_ROOT), 'utf8');
        const m = compHtml.match(/<!-- <<< MODULE_START: pro\/compare\.html >>> -->([\s\S]*?)<!-- <<< MODULE_END: pro\/compare\.html >>> -->/);
        if (m) return m[1].trim();
    }
    if (clean === 'blocker-guide.html') {
        return fs.readFileSync(new URL('components.html', TEST_ROOT), 'utf8');
    }
    for (const bundle of ['core.js', 'pro.js', 'components.js', 'app.js', 'components.html']) {
        const bundleText = fs.readFileSync(new URL(bundle, TEST_ROOT), 'utf8');
        const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\/\\/ <<< MODULE_START: ${escaped} >>>([\\s\\S]*?)\\/\\/ <<< MODULE_END: ${escaped} >>>`);
        const match = bundleText.match(regex);
        if (match) return match[1].trim();
    }
    throw new Error('Module not found in consolidated bundles: ' + clean);
}

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
    vm.runInContext(readConsolidatedSource('auth-client.js'),context);
    return { storage, window, context, auth:window.TaskitatorAuth };
}
function studyUI(pro=true){
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.handlers={};this.style={};this.value='';this.disabled=false;this.checked=false;this.open=false;this._text='';}
  append(e){this.children.push(e);e.parentElement=this;e.isConnected=true;}
  set textContent(t){this._text=String(t);this.children=[];}get textContent(){return this._text+this.children.map(e=>e.textContent).join(' ');}
  replaceChildren(...nodes){this.children=[];for(const n of nodes)this.append(n);}
  addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}setAttribute(){}focus(){}
  querySelectorAll(tags){const set=new Set(tags.split(','));return this.children.flatMap(e=>[...(set.has(e.tag)?[e]:[]),...e.querySelectorAll(tags)]);}
  showModal(){this.open=true;}close(){this.open=false;for(const fn of this.handlers.close||[])fn();}remove(){this.isConnected=false;}
 }
 const body=new Element('body'),storage=new LocalStorage(),requests=[];storage.setItem('taskitator_tasks','[]');storage.setItem('taskitator_settings',JSON.stringify({weekend_start:5,weekend_end:6}));
 const document={body,createElement:tag=>new Element(tag)},window={document,Clerk:{session:{id:'session_study'}},TaskitatorPro:{checkConsecutiveEntitlement:async()=>({allowed:pro})},TaskitatorRecurrence:{today:()=> '2026-10-27'},SyncEngine:{forceImmediateSync:async()=>true},TaskitatorApp:{loadStorage(){},saveStorageAndPush(){},renderUnifiedView(){}},TaskitatorAuth:{api:async(path,options)=>{requests.push(JSON.parse(options.body));return {authorized:true};}},dispatchEvent(){}};
 const context=vm.createContext({window,document,location:{search:''},localStorage:storage,crypto:webcrypto,URLSearchParams,Event:class{},confirm:()=>true,console});vm.runInContext(fs.readFileSync(new URL('pro/study-plan.js',root),'utf8'),context);
 return {window,body,storage,requests,button:(text,container=body)=>container.querySelectorAll('button').find(b=>b.textContent===text),inputs:()=>body.querySelectorAll('input')};
}
test('Study preview: cancellation creates nothing, +/- requires exact total, renamed titles and skips survive confirmation',async()=>{
 const f=studyUI();await f.window.TaskitatorStudy.open({title:'Math',unit:'Lesson',plural:'Lessons',total:10,days:5});assert.equal(f.storage.getItem('taskitator_tasks'),'[]');await f.button('Generate dates').onclick();assert.equal(f.body.querySelectorAll('article').length,5);
 await f.button('+').onclick();assert.equal(f.button('Confirm and create').disabled,true);await f.button('−').onclick();assert.equal(f.button('Confirm and create').disabled,false);
 const parentInput=f.body.querySelectorAll('article')[0].querySelectorAll('input')[0];parentInput.value='Algebra';parentInput.oninput();const select=f.body.querySelectorAll('select')[0];select.value='2';await f.button('Add skipped').onclick();select.value='3';await f.button('Add skipped').onclick();await f.button('Remove skip 2').onclick();
 await f.button('Confirm and create').onclick();const tasks=JSON.parse(f.storage.getItem('taskitator_tasks'));assert.equal(tasks.length,15);assert.equal(tasks[0].title,'Algebra');assert.equal(tasks.at(-1).raw_title,'Lesson.{num==11}');assert.equal(f.requests.filter(r=>r.action==='authorize').length,1);
 const cancelled=studyUI();await cancelled.window.TaskitatorStudy.open({title:'Biology'});await cancelled.button('Cancel').onclick();assert.equal(cancelled.storage.getItem('taskitator_tasks'),'[]');assert.equal(cancelled.requests.length,0);
});
test('Study Copilot: Free receives gentle Pro explanation and cannot set criteria or audits',async()=>{
 const free=studyUI(false),r=await free.window.TaskitatorStudy.propose({title:'Math',total:10,days:5});assert.equal(r.status,'pro_required');assert.equal(free.body.children.length,0);const f=studyUI();assert.equal((await f.window.TaskitatorStudy.propose({title:'Math'})).status,'needs_input');assert.equal((await f.window.TaskitatorStudy.propose({title:'Math',total:10,days:5,audit:true})).status,'error');assert.equal(f.requests.length,0);
});
function loadVault(f){vm.runInContext(readConsolidatedSource('vault-client.js'),f.context);return f.window.TaskitatorVault;}
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
    vm.runInContext(readConsolidatedSource('safety.js'),f.context);f.context.TaskitatorSafety=f.window.TaskitatorSafety;
    f.window.TaskitatorVault={available:true,selection:()=>({provider:'claude',primary:'claude-haiku-5-5',fallback:null,keyVersion:'v1'}),generate:async(model,payload,selection)=>{
        calls.push({model,payload,selection});const adapted=toClaudeRequest(validatePayload(payload));assert.equal(adapted.messages[0].role,'user');
        return Response.json({candidates:[{content:{parts:calls.length===1?[{functionCall:{id:'toolu_locked',name:'trash_task',args:{task_id:'locked'}}}]:[{text:'Protected task kept.'}]}}]});
    }};
    vm.runInContext(readConsolidatedSource('agent-engine.js'),f.context);
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
    vm.runInContext(readConsolidatedSource('agent-engine.js'),f.context);
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
    vm.runInContext(readConsolidatedSource('audit-engine.js'),f.context);
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
    vm.runInContext(readConsolidatedSource('audit-engine.js'),f.context);
    const result=await f.window.TaskitatorEngine.AuditEngine.validateCriteria('Photo of completed checklist','Checklist');
    assert.equal(result.success,true);assert.equal(result.model_used,'gemini-3.1-flash-lite');
    assert.deepEqual(calls.map(call=>call.model),['gemini-3.5-flash-lite','gemini-3.1-flash-lite']);
    assert.ok(calls[0].payload.contents[0].parts[0].text.includes('Checklist'));
    calls.length=0;f.context.document.readyState='loading';
    vm.runInContext(readConsolidatedSource('agent-engine.js'),f.context);
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
    vm.runInContext(readConsolidatedSource('sync-engine.js'),context);
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
        const html=readConsolidatedSource(filename);
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
        } else assert.ok(html.includes('core.js'));
    }
});

test('page bootstrap activates the security cache before initializing an authenticated page',async()=>{
    const source=readConsolidatedSource('auth-bootstrap.js');
    const calls=[],listeners=new Map();
    const status={style:{},append(){},remove(){calls.push('shown')},textContent:''};
    const document={body:{append(){}},createElement:()=>status,getElementById:()=>null,querySelectorAll:()=>[],documentElement:{classList:{remove(){}}}};
    const serviceWorker={controller:{postMessage(message,ports){ports[0].postMessage({version:'old-cache'});ports[0].close();}},
        addEventListener(name,fn){listeners.set(name,fn)},removeEventListener(name){listeners.delete(name)},
        async register(){calls.push('register');return {async update(){
            serviceWorker.controller={postMessage(message,ports){ports[0].postMessage({version:'taskitator-study-v1'});ports[0].close();}};
            await listeners.get('controllerchange')();
        }}}};
    const auth={signedIn:true,account:{user:'rd'},async init(){calls.push('authenticate')}};
    const window={dispatchEvent(){calls.push('ready')},Clerk:{session:{id:'sess_A'},addListener(){}}};
    const storage=new LocalStorage();storage.setItem('taskitator_local_owner','rd');
    const context=vm.createContext({window,document,navigator:{serviceWorker},TaskitatorAuth:auth,
        localStorage:storage,location:{pathname:'/index.html',replace(){calls.push('redirect')},reload(){calls.push('reload')}},
        MessageChannel,Event,setTimeout,clearTimeout});
    await vm.runInContext(source,context);
    assert.deepEqual(calls,['register','reload']);
});

test('switching a managed login preserves the previous account drafts under their original owner',()=>{
    const {storage,auth,window,context}=client();
    auth.account={user:'newuser',user_id:'user_A'};
    storage.setItem('taskitator_local_owner','olduser');
    storage.setItem('taskitator_settings','{"worker_username":"olduser"}');
    storage.setItem('taskitator_tasks','[{"title":"Old unsynced draft"}]');
    vm.runInContext(readConsolidatedSource('sync-engine.js'),context);
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
    await vm.runInContext(readConsolidatedSource('login-page.js'),context);
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
    vm.runInContext(readConsolidatedSource('deletion-client.js'),f.context);
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
    const html=readConsolidatedSource('settings.html');
    assert.match(html,/<button[^>]*class="tab-btn active"[^>]*data-tab="tab-tasks"/);
    assert.match(html,/<div class="tab-pane active" id="tab-tasks">/);
    assert.doesNotMatch(html,/<div class="tab-pane active" id="tab-account">/);
    assert.ok(html.includes('This does NOT delete your cloud account or cloud data.'));
    const system=html.slice(html.indexOf('id="tab-system"'),html.indexOf('id="tab-tasks"'));
    for(const href of ['components.html?view=legal','components.html?view=legal#deletion'])assert.ok(system.includes('href="'+href+'"'),href+' must be reachable under System');
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

test('empty batch review uses CSP-compatible close handlers for both dismissal buttons',()=>{
    for(const buttonId of ['proBatchCloseBtn','proBatchCancelBtn']){
        const nodes=new Map(),tasks=[],storage=new LocalStorage();storage.setItem('taskitator_tasks',JSON.stringify(tasks));
        const modal={removed:false,innerHTML:'',remove(){this.removed=true;nodes.delete(this.id)}};
        const button=()=>({addEventListener(name,fn){this[name]=fn}});
        nodes.set('proBatchCloseBtn',button());nodes.set('proBatchCancelBtn',button());
        const window={addEventListener(){}};
        const document={readyState:'loading',addEventListener(){},getElementById:id=>nodes.get(id)||null,
            createElement:()=>modal,body:{appendChild(node){nodes.set(node.id,node)}}};
        const context=vm.createContext({window,document,localStorage:storage});
        vm.runInContext(readConsolidatedSource('pro/pro-ui.js'),context);
        window.openBatchReviewModal([]);
        assert.equal(modal.removed,false);assert.match(modal.innerHTML,/None of the selected tasks/);
        assert.doesNotMatch(modal.innerHTML,/onclick=/);nodes.get(buttonId).click();assert.equal(modal.removed,true);
    }
});
test('batch review is scoped to selected AI tasks and preselects eligible rows without submitting',()=>{
    const nodes=new Map(),storage=new LocalStorage();let requests=0;
    storage.setItem('taskitator_tasks',JSON.stringify([
        {id:'one',title:'Selected',status:'active',ai_locked:true,proof_criteria:'Proof'},
        {id:'two',title:'Unselected',status:'active',ai_locked:true,proof_criteria:'Other proof'},
        {id:'plain',title:'Plain',status:'active'},
        {id:'done',title:'Completed',status:'completed',ai_locked:true}
    ]));
    const makeNode=()=>({style:{},textContent:'',addEventListener(){}});
    for(const id of ['proBatchCloseBtn','proBatchCancelBtn','proBatchSubmitBtn','proBatchPickFilesBtn','proBatchFileInput',
        'proBatchFileList','proBatchSelectedCount','proBatchFeedback','proBatchResultsArea'])nodes.set(id,makeNode());
    const modal={innerHTML:'',querySelectorAll(){return []}};
    const document={readyState:'loading',addEventListener(){},getElementById:id=>nodes.get(id)||null,
        createElement:()=>modal,body:{appendChild(node){nodes.set(node.id,node)}}};
    const window={addEventListener(){},TaskitatorPro:{batchReview(){requests++}}};
    vm.runInContext(readConsolidatedSource('pro/pro-ui.js'),vm.createContext({window,document,localStorage:storage}));
    window.openBatchReviewModal(['one','plain','done']);
    assert.match(modal.innerHTML,/value="one" checked/);assert.doesNotMatch(modal.innerHTML,/value="(?:two|plain|done)"/);
    assert.equal(nodes.get('proBatchSelectedCount').textContent,1);assert.equal(nodes.get('proBatchSubmitBtn').disabled,true);assert.equal(requests,0);
});

test('login choices mount the matching Clerk screen without showing migration as normal sign-in',async()=>{
    const nodes=new Map(),calls=[];
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:'',setAttribute(name,value){this[name]=value}});
        return nodes.get(id);
    };
    const window={Clerk:{session:null,
        mountSignIn(el,options){calls.push({mode:'signIn',options})},unmountSignIn(){},
        mountSignUp(el,options){calls.push({mode:'signUp',options})},unmountSignUp(){}}};
    const context=vm.createContext({window,document:{getElementById:node},location:{origin:'https://app.test'}});
    await vm.runInContext(readConsolidatedSource('login-page.js'),context);
    assert.deepEqual(calls.map(c=>c.mode),['signIn']);assert.equal(node('connectPanel').hidden,true);
    node('showSignUpBtn').onclick();node('showSignInBtn').onclick();
    assert.deepEqual(calls.map(c=>c.mode),['signIn','signUp','signIn']);
    assert.ok(calls.every(c=>c.options.forceRedirectUrl==='https://app.test/login.html'));
    const html=readConsolidatedSource('login.html');
    assert.match(html,/<details id="legacyImport">[\s\S]*id="migrationForm"/);
    assert.doesNotMatch(html,/usernameLoginForm|loginPasswordInput/);
});


test('an open Pro review modal defers automatic page refresh',()=>{
    const f=client();vm.runInContext(readConsolidatedSource('sync-engine.js'),f.context);
    f.context.document.querySelector=selector=>selector.includes('.pro-modal-backdrop')?{}:null;
    assert.equal(f.window.SyncEngine.isSafeToRefresh(),false);
    f.context.document.querySelector=()=>null;
    assert.equal(f.window.SyncEngine.isSafeToRefresh(),true);
});

class UniElement {
 constructor(tag='div',text=''){this.tag=tag;this.textContent=text;this.children=[];this.events={};this.attrs={};this.value='';}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){this.events[k]=fn;}
 focus(){}select(){}
}
function focusEngine(){const window={addEventListener(){}},context={window,document:{readyState:'loading',addEventListener(){}},navigator:{},setInterval(){},Date,JSON,Number,Math};vm.runInNewContext(fs.readFileSync(new URL('uni/focus-timer.js',rootURL()),'utf8'),context);return window.TaskitatorPomodoro;}
test('Timer enforces duration limits and finishes with a large break',()=>{
 const engine=focusEngine(),s=engine.fresh();s.config.sessions=1;Object.assign(s,{running:true,target:1000});
 let r=engine.advance(s,1000);assert.equal(r.state.phase,'large');assert.equal(r.state.done,false);assert.equal(r.state.target,1201000);
 assert.equal(engine.valid(r.state),true);r=engine.advance(s,1201000);assert.equal(r.state.done,true);assert.equal(r.event,'complete');
 for(const [field,value]of [['work',91],['rest',16],['large',36],['sessions',5]])assert.equal(engine.valid({...engine.fresh(),config:{...engine.fresh().config,[field]:value}}),false);
});
test('Workspace routes initialize independently and select Universe without database access',()=>{
 const html=fs.readFileSync(new URL('components.html',rootURL()),'utf8');
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);const router=scripts.find(s=>s.includes('const publicViews'));
 assert.ok(router);assert.equal(router.includes('MODULE_START:'),false);
 const panes=['projects','calendar','stats','trash','universe'].map(v=>({id:'componentView-'+v,style:{}}));let events=[];
 const document={querySelectorAll:selector=>selector==='.component-view-pane'?panes:[],getElementById:()=>null};
 vm.runInNewContext(router,{document,window:{location:{search:'?view=universe',hash:''},dispatchEvent:e=>events.push(e.type)},URLSearchParams,Event});
 assert.equal(panes.find(p=>p.id==='componentView-universe').style.display,'block');assert.equal(panes[0].style.display,'none');assert.deepEqual(events,['taskitator-universe-view']);
});
test('Phase 4.5 focus timer restores absolute deadlines and catches up missed transitions',()=>{
 const engine=focusEngine(),s=engine.fresh();Object.assign(s,{running:true,target:1000000});
 const resumed=JSON.parse(JSON.stringify(s));let r=engine.advance(resumed,1000000+60000);assert.equal(r.state.phase,'break');assert.equal(r.state.target,1300000);assert.equal(r.state.left,240000);
 r=engine.advance(r.state,1300000+60000);assert.equal(r.state.phase,'work');assert.equal(r.state.session,2);assert.equal(r.state.left,1440000);
 r=engine.advance(r.state,1000000+24*3600000);assert.equal(r.state.done,true);assert.equal(r.state.running,false);assert.equal(r.event,'complete');assert.equal(engine.advance(r.state,Date.now()).event,null);
});
test('Phase 4.5 paused timers and stored notification preferences survive restoration',()=>{
 const engine=focusEngine(),s=engine.fresh();s.left=123456;s.config.sound=false;s.config.vibration=false;s.config.awake=true;
 const r=engine.advance(JSON.parse(JSON.stringify(s)),Date.now()+3600000);assert.equal(r.state.left,123456);assert.equal(r.state.config.sound,false);assert.equal(r.state.config.awake,true);assert.equal(r.event,null);
 assert.equal(engine.valid({...s,config:{...s.config,work:0}}),false);
});
test('Phase 4.5 tree expansion changes only local presentation and never schedules a push',()=>{
 const source=fs.readFileSync(new URL('app.js',rootURL()),'utf8'),start=source.indexOf("toggleBtn.addEventListener('click'",source.indexOf("toggleBtn.className = 'collapse-toggle'")),end=source.indexOf('});',start)+3;
 let click,pushes=0,renders=0;const collapsed=new Set(),saved=[];
 vm.runInNewContext(source.slice(start,end),{toggleBtn:{addEventListener(type,fn){click=fn;}},task:{id:'task1'},collapsedNodes:collapsed,COLLAPSED_STATE_KEY:'local-tree',JSON,localStorage:{setItem:(k,v)=>saved.push(v)},saveStorageAndPush:()=>pushes++,renderUnifiedTaskTree:()=>renders++});
 click({stopPropagation(){}});assert.equal(collapsed.has('task1'),true);click({stopPropagation(){}});assert.equal(collapsed.has('task1'),false);assert.equal(pushes,0);assert.equal(renders,2);assert.equal(saved.length,2);
});
function uniUI(api){
 const root=new UniElement(),listeners={};const w={TaskitatorAuth:{account:{user:'A'},api},Clerk:{session:{id:'S'},addListener(fn){this.listener=fn;}},addEventListener(k,fn){listeners[k]=fn;},confirm:()=>true};
 const doc={getElementById:()=>root,createElement:tag=>new UniElement(tag)};
 const context={window:w,document:doc,location:{search:'?view=universe'},URLSearchParams,crypto:webcrypto,Date,Map,Array,Error};
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-ui.js',rootURL()),'utf8'),context);
 return {root,w,listeners};
}
function rootURL(){return new URL('./',import.meta.url);}
const uniFlush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const uniNodes=e=>[e,...e.children.filter(x=>typeof x==='object').flatMap(uniNodes)];
test('Phase 3 UI renders hostile task titles as text and fences stale-view actions',async()=>{
 const root=new UniElement(),window={},calls=[];let current=true;
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-tasks-ui.js',rootURL()),'utf8'),{window,document:{createElement:tag=>new UniElement(tag)},Date,Map,Error});
 await window.UniverseTasksUI.mount(root,{id:'g',role:'member'},[],{current:()=>current,run:fn=>fn(),send:async()=>{},api:async path=>{calls.push(path);return {projects:[{id:'p',title:'<script>bad</script>'}],tasks:[{id:'t',project_id:'p',title:'<img src=x>',mode:'shared'}],assignments:[{id:'a',task_id:'t',account_id:null,state:'open'}]};}});
 assert.ok(uniNodes(root).some(n=>n.textContent==='<img src=x> · shared'));assert.ok(!uniNodes(root).some(n=>n.tag==='img'||n.tag==='script'));
 current=false;const b=uniNodes(root).find(n=>n.textContent==='Shared · open');await assert.rejects(b.events.click(),/session or view changed/);assert.equal(calls.length,1);
});
test('Phase 4.1 UI requires explicit maximum approval and withholds human buttons before AI approval',async()=>{
 const root=new UniElement(),window={},sent=[];
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-tasks-ui.js',rootURL()),'utf8'),{window,document:{createElement:tag=>new UniElement(tag)},Date,Map,Error});
 const task={id:'t',project_id:'p',title:'AI task',criteria:'Photo of finished checklist',mode:'shared',ai_required:true,human_required:true,revision:1};
 const a={id:'a',task_id:'t',state:'pending',submission_id:'s',revision:2};
 const detail={assignment:a,task,references:[],submissions:[],can_request_ai:true,ai_attestation:null,ai_reviews:[{id:'q',state:'quoted',mode:'hosted',model:'gemini-test-flash-lite',max_credits:1.25,charged:0,expires_at:Date.now()+60000}]};
 const tools={current:()=>true,run:fn=>fn(),api:async path=>path.endsWith('/assignments/a')?detail:{projects:[{id:'p',title:'Project'}],tasks:[task],assignments:[a]},send:async(path,body)=>{sent.push({path,body});return {id:'q'};}};
 await window.UniverseTasksUI.mount(root,{id:'g',role:'owner'},[],tools);
 await uniNodes(root).find(n=>n.textContent==='Shared · pending').events.click();
 assert.ok(!uniNodes(root).some(n=>n.tag==='button'&&n.textContent==='Approve'));
 assert.equal(sent.length,0);
 await uniNodes(root).find(n=>n.textContent==='Approve review — up to 1.25 credits').events.click();
 assert.equal(sent[0].path,'/universe/groups/g/ai/q/approve');assert.equal(sent[0].body.accept_max_credits,1.25);
 detail.ai_attestation={verdict:'approved'};detail.ai_reviews=[];await uniNodes(root).find(n=>n.textContent==='Refresh review status').events.click();assert.ok(uniNodes(root).some(n=>n.tag==='button'&&n.textContent==='Approve'));
});
test('Universe UI renders group values as text, opens details through events and clears on session replacement',async()=>{
 const calls=[];const group={id:'uni_1',title:'<img src=x onerror=alert(1)>',purpose:'Study',role:'member',revision:1};
 const ui=uniUI(async path=>{calls.push(path);if(path.endsWith('capabilities'))return {ui:true};if(path==='/universe/groups')return {groups:[group]};if(path.endsWith('/members'))return {members:[]};if(path.endsWith('/activity'))return {events:[]};return {group};});await uniFlush();
 const b=uniNodes(ui.root).find(e=>e.tag==='button'&&e.textContent===group.title);assert.ok(b);b.events.click();await uniFlush();
 assert.ok(calls.includes('/universe/groups/uni_1/members'));assert.ok(uniNodes(ui.root).some(e=>e.textContent==='Leave Universe'));
 assert.ok(!uniNodes(ui.root).some(e=>e.tag==='img'));ui.w.Clerk.session.id='other';ui.w.Clerk.listener();assert.equal(ui.root.children.length,0);
});
test('Universe UI retries a failed create using the same operation and rejects late results from another session',async()=>{
 const bodies=[];let fail=true;
 const ui=uniUI(async(path,options)=>{if(path.endsWith('capabilities'))return {ui:true};if(path==='/universe/groups'&&!options.body)return {groups:[]};
 if(path==='/universe/groups'){bodies.push(JSON.parse(options.body));if(fail){fail=false;throw new Error('Network unavailable');}return {group_id:'g'};}
 if(path.endsWith('/members'))return {members:[]};if(path.endsWith('/activity'))return {events:[]};return {group:{id:'g',title:'Team',purpose:'',role:'owner',revision:1}};});await uniFlush();
 const form=uniNodes(ui.root).find(e=>e.tag==='form');const inputs=form.children.filter(e=>e.tag==='label').map(l=>l.children[0]);inputs[0].value='Team';
 form.events.submit({preventDefault(){}});await uniFlush();form.events.submit({preventDefault(){}});await uniFlush();assert.equal(bodies.length,2);assert.equal(bodies[0].operation_id,bodies[1].operation_id);
 let resolve;const late=uniUI(path=>path.endsWith('capabilities')?new Promise(r=>resolve=r):Promise.resolve({groups:[]}));late.w.Clerk.session.id='new';late.w.Clerk.listener();resolve({ui:true});await uniFlush();assert.equal(late.root.children.length,0);
});

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
        const compHtml = fs.readFileSync(new URL('views/stats.js', TEST_ROOT), 'utf8');
        const m = compHtml.match(/\/\/ <<< MODULE_START: stats\.html >>>([\s\S]*?)\/\/ <<< MODULE_END: stats\.html >>>/);
        if (m) {
            const inner = m[1].trim().replace(/^\(\(\) => \{/, '').replace(/\}\)\(\);$/, '');
            return `<script type="text/taskitator-script">${inner}</script>`;
        }
    }
    if (clean === 'pro/compare.html') {
        const compHtml = fs.readFileSync(new URL('legal.html', TEST_ROOT), 'utf8');
        const m = compHtml.match(/<!-- <<< MODULE_START: pro\/compare\.html >>> -->([\s\S]*?)<!-- <<< MODULE_END: pro\/compare\.html >>> -->/);
        if (m) return m[1].trim();
    }
    if (clean === 'blocker-guide.html') {
        // Phase 3.0: the guide is a view of the index.html shell; its script is views/blocker-guide.js.
        return fs.readFileSync(new URL('index.html', TEST_ROOT), 'utf8') + '\n<script type="text/taskitator-script">' + fs.readFileSync(new URL('views/blocker-guide.js', TEST_ROOT), 'utf8') + '</script>';
    }
    for (const bundle of ['core.js', 'pro.js', 'components.js', 'app.js', 'components.html', 'views/projects.js', 'views/calendar.js', 'views/stats.js', 'views/trash.js', 'views/blocker-guide.js']) {
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
  get classList(){const self=this,has=c=>(' '+(self.className||'')+' ').includes(' '+c+' ');return {contains:has,add(c){if(!has(c))self.className=((self.className||'')+' '+c).trim();},remove(c){self.className=(self.className||'').split(' ').filter(x=>x&&x!==c).join(' ');},toggle(c,on){(on??!has(c))?this.add(c):this.remove(c);}};}
  querySelectorAll(tags){const set=new Set(tags.split(','));return this.children.flatMap(e=>[...(set.has(e.tag)?[e]:[]),...e.querySelectorAll(tags)]);}
  showModal(){this.open=true;}close(){this.open=false;for(const fn of this.handlers.close||[])fn();}remove(){this.isConnected=false;}
 }
 const body=new Element('body'),storage=new LocalStorage(),requests=[];storage.setItem('taskitator_tasks','[]');storage.setItem('taskitator_settings',JSON.stringify({weekend_start:5,weekend_end:6}));
 const document={body,createElement:tag=>new Element(tag)},window={document,Clerk:{session:{id:'session_study'}},TaskitatorPro:{checkConsecutiveEntitlement:async()=>({allowed:pro})},TaskitatorRecurrence:{today:()=> '2026-10-27'},SyncEngine:{forceImmediateSync:async()=>true},TaskitatorApp:{loadStorage(){},saveStorageAndPush(){},renderUnifiedView(){}},TaskitatorAuth:{api:async(path,options)=>{requests.push(JSON.parse(options.body));return {authorized:true};}},dispatchEvent(){}};
 window.matchMedia=()=>({matches:true});
 const context=vm.createContext({window,document,location:{search:''},localStorage:storage,crypto:webcrypto,URLSearchParams,Event:class{},confirm:()=>true,setTimeout,clearTimeout,console});vm.runInContext(fs.readFileSync(new URL('pro/study-plan.js',root),'utf8'),context);for(const f of ['pro/study-manage.js','pro/study-schedule.js'])vm.runInContext(fs.readFileSync(new URL(f,root),'utf8'),context);
 const fire=(e,name='input')=>{for(const fn of e.handlers[name]||[])fn({});};
 return {window,body,storage,requests,fire,button:(text,container=body)=>container.querySelectorAll('button').find(b=>b.textContent===text),inputs:()=>body.querySelectorAll('input')};
}
test('Study preview: nothing is created before a balanced preview; +/- on a date needs the exact total; skips survive confirmation',async()=>{
 const f=studyUI();await f.window.TaskitatorStudy.open({title:'Math',unit:'Lesson',plural:'Lessons',total:10,days:5});assert.equal(f.storage.getItem('taskitator_tasks'),'[]');
 assert.equal(f.button('Create plan').disabled,true,'no preview yet');
 await f.button('Preview new schedule').onclick?.();f.button('Preview new schedule').handlers.click.forEach(fn=>fn());
 assert.equal(f.button('Create plan').disabled,false);assert.equal(f.button('Preview generated ✓').disabled,true,'the preview button is pressed after generating');
 const cell=()=>f.body.querySelectorAll('button').find(b=>/ss-cell/.test(b.className)&&b.querySelectorAll('small').length);
 cell().handlers.click.forEach(fn=>fn());f.button('+').handlers.click.forEach(fn=>fn());assert.equal(f.button('Create plan').disabled,true,'surplus blocks creating');
 f.button('−').handlers.click.forEach(fn=>fn());assert.equal(f.button('Create plan').disabled,false);
 const skip=f.inputs().filter(i=>i.placeholder==='8, 10-12'&&i.type==='text').at(-1);skip.value='2-3';f.fire(skip);
 assert.equal(f.button('Create plan').disabled,true,'changing a setting makes the preview stale');assert.ok(f.button('Preview new schedule'),'and re-enables the preview button');
 f.button('Preview new schedule').handlers.click.forEach(fn=>fn());assert.equal(f.button('Create plan').disabled,false);
 await f.button('Create plan').onclick();const tasks=JSON.parse(f.storage.getItem('taskitator_tasks'));assert.equal(tasks.length,15);assert.equal(tasks.at(-1).raw_title,'Lesson.{num==12}');assert.equal(f.requests.filter(r=>r.action==='authorize').length,1);
 const cancelled=studyUI();await cancelled.window.TaskitatorStudy.open({title:'Biology'});await cancelled.button('Cancel').onclick();assert.equal(cancelled.storage.getItem('taskitator_tasks'),'[]');assert.equal(cancelled.requests.length,0);
});
test('Study preview: units-per-day split, list and calendar share the same dates, bad skips are refused',async()=>{
 const f=studyUI();await f.window.TaskitatorStudy.open({title:'Math',unit:'Lesson',plural:'Lessons',total:20,days:5});
 f.button('Units per day').handlers.click.forEach(fn=>fn());const per=f.inputs().find(i=>i.type==='number'&&i.parentElement.textContent.startsWith('Units per day'));per.value='6';f.fire(per);
 f.button('Preview new schedule').handlers.click.forEach(fn=>fn());f.button('List').handlers.click.forEach(fn=>fn());
 const rows=()=>f.body.querySelectorAll('div').filter(e=>/(^| )ss-row( |$)/.test(e.className||''));
 assert.deepEqual(rows().map(r=>r.querySelectorAll('span').at(-1).textContent.split(', ').length),[6,6,6,2]);
 const skip=f.inputs().filter(i=>i.placeholder==='8, 10-12'&&i.type==='text').at(-1);skip.value='3, 99';f.fire(skip);f.button('Preview new schedule').handlers.click.forEach(fn=>fn());
 assert.match(f.body.textContent,/99 is outside this plan/);assert.equal(f.button('Create plan').disabled,true);
 skip.value='';f.fire(skip);f.button('Preview new schedule').handlers.click.forEach(fn=>fn());assert.equal(f.button('Create plan').disabled,false);
 f.button('Calendar').handlers.click.forEach(fn=>fn());const cell=f.body.querySelectorAll('button').find(b=>/ss-cell/.test(b.className)&&b.querySelectorAll('small').length);cell.handlers.click.forEach(fn=>fn());
 f.button('+').handlers.click.forEach(fn=>fn());assert.equal(f.button('Create plan').disabled,true);
 f.button('List').handlers.click.forEach(fn=>fn());assert.equal(rows()[0].querySelectorAll('span').at(-1).textContent.split(', ').length,7);
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
test('criteria validation sends exemplar guidance and the original variable criteria together', async () => {
    const f = client();
    const calls = [];
    f.window.TaskitatorVault = {
        available: true,
        selection: () => ({ provider: 'gemini', primary: 'gemini-3.5-flash-lite', fallback: null, keyVersion: 'v1' }),
        generate: async (model, payload) => {
            calls.push(payload);
            return Response.json({ candidates: [{ content: { parts: [{ text: '{"score":9,"passed":true,"critique":"Clear","suggested_rewrite":""}' }] } }] });
        }
    };
    vm.runInContext(readConsolidatedSource('audit-engine.js'), f.context);
    const engine = f.window.TaskitatorEngine.AuditEngine;
    engine.fileToBase64 = async () => ({ inline_data: { mime_type: 'application/pdf', data: 'cGRm' } });
    const criteria = 'The exemplar shows section 61; proof must show {num} in the corresponding header or breadcrumb.';
    const result = await engine.validateCriteria(criteria, 'Test report', { name: 'example.pdf', type: 'application/pdf', size: 3 });
    assert.equal(result.success, true);
    const parts = calls[0].contents[0].parts;
    assert.ok(parts[0].text.includes(criteria));
    assert.match(parts[0].text, /illustrative values[\s\S]*placeholder such as \{num\}/);
    assert.match(parts[0].text, /do not require the sample value/);
    assert.match(parts[0].text, /not referenced with explanatory context/);
    assert.equal(parts[1].inline_data.mime_type, 'application/pdf');
    assert.equal(parts[1].inline_data.data, 'cGRm');
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

test('Google key callback opens AI settings and permits one verified reveal with clipboard fallback',async()=>{
    const f=client(),events=new Map(),nodes=new Map();let accountTabOpened=false;
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:'',style:{},handlers:{},
            addEventListener(name,fn){this.handlers[name]=fn;},replaceChildren(){},append(){},
            showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},click(){if(id==='tabbtn-account')accountTabOpened=true;}});
        return nodes.get(id);
    };
    f.context.document.getElementById=node;
    f.context.document.querySelector=selector=>({click(){assert.equal(selector,'[data-tab="tab-ai"]');accountTabOpened=true;}});
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
    assert.match(node('vaultFeedback').textContent,/Press Copy below/);
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
test('logout records intent, confirms Clerk session ended, and prevents false logout success',async()=>{
    const {auth,window,context}=client();
    auth.account={user:'rd',user_id:'user_A'};
    window.Clerk.signOut=async()=>{window.Clerk.session=null;};
    await auth.signOut();
    assert.equal(context.sessionStorage.getItem('taskitator_logout_pending'),'1');
    assert.equal(auth.account,null);

    const second=client();
    second.auth.account={user:'rd',user_id:'user_A'};
    second.window.Clerk.signOut=async()=>{}; // provider session incorrectly remains active
    await assert.rejects(second.auth.signOut(),/could not confirm that your sign-in session ended/i);
    assert.equal(second.context.sessionStorage.getItem('taskitator_logout_pending'),null);
    assert.equal(second.auth.account.user,'rd');
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
        if (['account-deletion.html','help.html','sleep.html','study-plans.html','legal.html','welcome.html','privacy.html','terms.html','PHASE-1-SETUP.html','PHASE-2-SETUP.html','PHASE-3-SETUP.html'].includes(filename)) {
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
            serviceWorker.controller={postMessage(message,ports){ports[0].postMessage({version:'taskitator-phase3-v26'});ports[0].close();}};
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
    return {auth,storage,element,redirects,downloads,context};
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

test('sign-in restores an app deep link after the workspace sync succeeds', async () => {
    for (const [stored, expected] of [
        ['/preview/index.html#help-p-study', '/preview/index.html#help-p-study'],
        ['/preview/components.html?view=universe&invite=example', '/preview/components.html?view=universe&invite=example'],
        ['https://elsewhere.test/preview/index.html', 'index.html'],
        ['/other/index.html', 'index.html']
    ]) {
        const f = await loginFixture([{success:true}]);
        f.context.location.href = 'https://app.test/preview/login.html';
        f.context.URL = URL;
        f.context.sessionStorage.setItem('taskitator_login_return', stored);
        await f.element('migrationForm').onsubmit({preventDefault(){}});
        assert.deepEqual(f.redirects, [expected]);
        assert.equal(f.context.sessionStorage.getItem('taskitator_login_return'), null);
    }
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
test('Settings defaults to General and separates local reset from account deletion',()=>{
    const html=readConsolidatedSource('settings.html');
    assert.match(html, /candidates = \[fromHash && 'tab-' \+ fromHash\[1\], stored, 'tab-general'\]/);
    assert.match(html, /id="tabbtn-general"[^>]*data-tab="tab-general"/);
    assert.ok(html.includes('Your cloud account and synced data stay.'));
    assert.ok(html.includes('Permanently deletes your account, cloud data'));
    const account=html.slice(html.indexOf('id="tab-account"'), html.indexOf('id="tab-account"')+18000);
    for(const href of ['legal.html','legal.html#deletion']) assert.ok(account.includes('href="'+href+'"'));
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

test('empty batch review uses CSP-compatible close handlers for both dismissal buttons',async()=>{
    for(const buttonId of ['proBatchCloseBtn','proBatchCancelBtn']){
        const nodes=new Map(),tasks=[],storage=new LocalStorage();storage.setItem('taskitator_tasks',JSON.stringify(tasks));
        const modal={removed:false,innerHTML:'',remove(){this.removed=true;nodes.delete(this.id)}};
        const button=()=>({addEventListener(name,fn){this[name]=fn}});
        nodes.set('proBatchCloseBtn',button());nodes.set('proBatchCancelBtn',button());
        const window={addEventListener(){},TaskitatorPro:{checkConsecutiveEntitlement:async()=>({allowed:true}),getStatus:async()=>({isPro:true,status:'active'})}};
        const document={readyState:'loading',addEventListener(){},getElementById:id=>nodes.get(id)||null,
            createElement:()=>modal,body:{appendChild(node){nodes.set(node.id,node)}}};
        const context=vm.createContext({window,document,localStorage:storage});
        vm.runInContext(readConsolidatedSource('pro/pro-ui.js'),context);
        await window.openBatchReviewModal([]);
        assert.equal(modal.removed,false);assert.match(modal.innerHTML,/None of the selected tasks/);
        assert.doesNotMatch(modal.innerHTML,/onclick=/);nodes.get(buttonId).click();assert.equal(modal.removed,true);
    }
});
test('batch review is scoped to selected AI tasks and preselects eligible rows without submitting',async()=>{
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
    const window={addEventListener(){},TaskitatorPro:{checkConsecutiveEntitlement:async()=>({allowed:true}),getStatus:async()=>({isPro:true,status:'active'}),batchReview(){requests++}}};
    vm.runInContext(readConsolidatedSource('pro/pro-ui.js'),vm.createContext({window,document,localStorage:storage}));
    await window.openBatchReviewModal(['one','plain','done']);
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
 constructor(tag='div',text=''){this.tag=tag;this.textContent=text;this.children=[];this.events={};this.attrs={};this.dataset={};this.value='';this.style={setProperty(k,v){this[k]=v;}};this.classList={add:c=>{this.className=((this.className||'')+' '+c).trim()},remove:c=>{this.className=(this.className||'').split(' ').filter(x=>x!==c).join(' ')},contains:c=>(this.className||'').split(' ').includes(c),toggle:(c,on)=>{const a=new Set((this.className||'').split(' '));if(on===undefined)on=!a.has(c);on?a.add(c):a.delete(c);this.className=[...a].join(' ');}};}
 insertBefore(item,ref){item.remove();item.parentElement=this;const i=this.children.indexOf(ref);this.children.splice(i<0?this.children.length:i,0,item);}
 append(...items){for(const item of items)if(item&&typeof item==='object')item.parentElement=this;this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){this.events[k]=fn;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 querySelectorAll(s){return uniNodes(this).slice(1).filter(n=>s.startsWith('.')?n.className?.split(' ').includes(s.slice(1)):n.tag===s);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 focus(){}select(){}
}
function focusEngine(){const window={addEventListener(){}},context={window,document:{readyState:'loading',addEventListener(){}},navigator:{},setInterval(){},Date,JSON,Number,Math};vm.runInNewContext(fs.readFileSync(new URL('uni/focus-timer.js',rootURL()),'utf8'),context);return window.TaskitatorPomodoro;}
test('Timer enforces duration limits and finishes with a large break',()=>{
 const engine=focusEngine(),s=engine.fresh();s.config.sessions=1;Object.assign(s,{running:true,target:1000});
 let r=engine.advance(s,1000);assert.equal(r.state.phase,'large');assert.equal(r.state.done,false);assert.equal(r.state.target,1201000);
 assert.equal(engine.valid(r.state),true);r=engine.advance(s,1201000);assert.equal(r.state.done,true);assert.equal(r.event,'complete');
 for(const [field,value]of [['work',91],['rest',16],['large',36],['sessions',5]])assert.equal(engine.valid({...engine.fresh(),config:{...engine.fresh().config,[field]:value}}),false);
});
test('Universe page shows only Universe; old components.html views redirect into the shell or legal.html',()=>{
 const html=fs.readFileSync(new URL('components.html',rootURL()),'utf8');
 assert.ok(html.indexOf('legacy-redirect.js')<html.indexOf('core.js'));assert.ok(html.includes('src="universe-page.js"'));
 for(const v of ['projects','calendar','stats','trash','blocker-guide','compare','legal'])assert.equal(html.includes('id="componentView-'+v+'"'),false,v);
 assert.equal([...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/g)].length,0,'no inline scripts');
 const pane={style:{}},events=[],title={textContent:''};
 vm.runInNewContext(fs.readFileSync(new URL('universe-page.js',rootURL()),'utf8'),{document:{getElementById:id=>id==='componentView-universe'?pane:id==='componentPageTitle'?title:null},window:{dispatchEvent:e=>events.push(e.type)},Event});
 assert.equal(pane.style.display,'block');assert.deepEqual(events,['taskitator-universe-view']);assert.equal(title.textContent,'Universe');
 const code=fs.readFileSync(new URL('legacy-redirect.js',rootURL()),'utf8');
 const go=(pathname,search='',hash='')=>{let to=null;vm.runInNewContext(code,{location:{pathname,search,hash,replace:u=>{to=u;}},URLSearchParams});return to;};
 assert.equal(go('/components.html','?view=universe'),null);
 assert.equal(go('/components.html','?view=calendar'),'index.html#calendar');assert.equal(go('/components.html',''),'index.html#projects');
 assert.equal(go('/components.html','?view=blocker-guide'),'index.html#blocker-guide');assert.equal(go('/components.html','?view=guide'),'index.html#blocker-guide');
 assert.equal(go('/components.html','?view=guide&x=1','#bridge-manual'),'index.html?x=1#bridge-manual');
 assert.equal(go('/components.html','?view=legal','#deletion'),'legal.html#deletion');assert.equal(go('/components.html','?view=compare'),'legal.html?view=compare');
 assert.equal(go('/components.html','?view=terms'),'legal.html#legalTermsSection');
 assert.equal(go('/sleep.html'),'index.html#sleep');assert.equal(go('/study-plans.html'),'index.html#study-plans');
 assert.equal(go('/help.html'),'index.html#help');assert.equal(go('/help.html','','#p-study'),'index.html#help-p-study');
 for(const stub of ['sleep.html','study-plans.html','help.html']){const t=fs.readFileSync(new URL(stub,rootURL()),'utf8');assert.ok(t.includes('src="legacy-redirect.js"'),stub);assert.equal(t.includes('core.js'),false);}
});
test('Shell router: one index.html, hash views, legacy ?view= and per-view refresh',()=>{
 const html=fs.readFileSync(new URL('index.html',rootURL()),'utf8');
 const views=[...html.matchAll(/<(?:div|section)\b[^>]*\bdata-shell-view="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(views,['tasks','projects','calendar','stats','trash','blocker-guide','study-plans','sleep','help']);
 for(const f of ['views/projects.js','views/calendar.js','views/stats.js','views/trash.js','views/blocker-guide.js','pro/study-manage.js','study-plans.js','sleep.js','shell-router.js'])assert.ok(html.includes('src="'+f+'"'),f);
 assert.ok(html.indexOf('src="app.js')<html.indexOf('src="views/projects.js"')&&html.indexOf('src="study-plans.js"')<html.indexOf('src="shell-router.js"'));
 for(const old of ['components.html?view=calendar','components.html?view=projects','sleep.html"','study-plans.html"','help.html"'])assert.equal(html.includes(old),false,old);
 const code=fs.readFileSync(new URL('shell-router.js',rootURL()),'utf8');
 const make=(id,v)=>({id,hidden:false,getAttribute:k=>k==='data-shell-view'?v:null,querySelectorAll:()=>[]});
 const els=['tasks','projects','calendar','stats','trash','blocker-guide','study-plans','sleep','help'].map(v=>make('v-'+v,v));
 const links=[{id:'navLinkToday'},{id:'navLinkGeneral'},{shell:'calendar'},{shell:'sleep'}].map(l=>({...l,classList:{on:false,toggle(_,v){this.on=v;}},getAttribute:k=>k==='data-shell-link'?l.shell||null:null}));
 const calls=[],listeners={},title={textContent:'',hidden:true},jump={style:{}},back={href:'',setAttribute(k,v){this.href=v;}};let replaced=null;
 const anchors = new Map(['help-p-study', 'help-calendar', 'bridge-manual'].map(id => [id, { scrollIntoView() { calls.push(id); } }]));
 const location={pathname:'/index.html',search:'?view=stats&x=1',hash:''};
 const window={scrollY:0,scrollTo(){},addEventListener:(t,f)=>{listeners[t]=f;},dispatchEvent:e=>calls.push(e.type),renderStats:()=>calls.push('stats'),renderCalendarView:()=>calls.push('calendar'),
  TaskitatorSleepView:{show:()=>calls.push('sleep')},TaskitatorStudyPlansView:{show:()=>calls.push('study'),hide:()=>calls.push('study-hide')}};
 const document={documentElement:{setAttribute(k,v){this[k]=v;}},title:'',querySelectorAll:s=>s==='.shell-view[data-shell-view]'?els:s==='#drawerNavLinks a'?links:[],querySelector:s=>els.find(e=>s.includes('"'+e.getAttribute('data-shell-view')+'"'))||null,
  getElementById:id=>id==='componentPageTitle'?title:id==='todayJumpBtn'?jump:id==='helpReturn'?back:anchors.get(id)};
 vm.runInNewContext(code,{window,document,location,history:{state:null,replaceState:(s,t,u)=>{replaced=u;const i=u.indexOf('#');location.search=u.slice(u.indexOf('?')>=0?u.indexOf('?'):i,i)||'';location.hash=u.slice(i);}},URLSearchParams,CustomEvent:class{constructor(t){this.type=t;}},requestAnimationFrame:f=>f(),console});
 assert.equal(replaced,'/index.html?x=1#stats','?view= becomes a hash and other parameters stay');
 const visible=()=>els.filter(e=>!e.hidden).map(e=>e.getAttribute('data-shell-view'));
 assert.deepEqual(visible(),['stats']);assert.equal(document.documentElement['data-shell'],'stats');assert.equal(title.hidden,false);assert.ok(calls.includes('stats'));
 location.hash='#calendar';listeners.hashchange();assert.deepEqual(visible(),['calendar']);assert.equal(jump.style.display,'inline-flex');assert.equal(links[2].classList.on,true);
 location.hash='#sleep';listeners.hashchange();assert.deepEqual(visible(),['sleep']);assert.ok(calls.includes('sleep'));assert.equal(title.hidden,true);
 location.hash='#help';listeners.hashchange();assert.equal(back.href,'#sleep');
 location.hash='#help-p-study';listeners.hashchange();assert.deepEqual(visible(),['help']);assert.equal(back.href,'#sleep','Back in Help returns to the previous view');
 location.hash='#help-calendar';listeners.hashchange();assert.equal(back.href,'#sleep');assert.equal(calls.at(-1),'help-calendar');
 location.hash='#study-plans';listeners.hashchange();location.hash='#general';listeners.hashchange();
 assert.deepEqual(visible(),['tasks']);assert.ok(calls.includes('study')&&calls.includes('study-hide'));assert.ok(calls.slice(-2).includes('taskitator-tasks-updated'),'Tasks reload storage when shown again');
 assert.equal(links[1].classList.on,true);assert.equal(links[0].classList.on,false);
 location.hash='#key-verification=abc';listeners.hashchange();assert.deepEqual(visible(),['tasks'],'unknown hashes keep Tasks');
 location.hash='#bridge-manual';listeners.hashchange();assert.deepEqual(visible(),['blocker-guide']);assert.ok(calls.slice(-2).includes('bridge-manual'));
 location.hash='#%67eneral';listeners.hashchange();assert.deepEqual(visible(),['tasks']);assert.equal(links[1].classList.on,true);
 assert.match(code,/syncNow\(\{ origin: 'page-load' \}\)/);assert.match(code,/PULL_EVERY_MS = 60000/);
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
 const source=fs.readFileSync(new URL('app.js',rootURL()),'utf8'),start=source.indexOf("toggleBtn.addEventListener('click'",source.indexOf("toggleBtn.className = `collapse-toggle")),end=source.indexOf('});',start)+3;
 let click,pushes=0,renders=0;const collapsed=new Set(),saved=[];
 vm.runInNewContext(source.slice(start,end),{toggleBtn:{classList:{toggle(){}},setAttribute(){},addEventListener(type,fn){click=fn;}},li:{querySelector:()=>null},UIFX:{tap(){}},task:{id:'task1'},collapsedNodes:collapsed,COLLAPSED_STATE_KEY:'local-tree',JSON,localStorage:{setItem:(k,v)=>saved.push(v)},saveStorageAndPush:()=>pushes++,renderUnifiedTaskTree:()=>renders++});
 click({stopPropagation(){}});assert.equal(collapsed.has('task1'),true);click({stopPropagation(){}});assert.equal(collapsed.has('task1'),false);assert.equal(pushes,0);assert.equal(renders,0);assert.equal(saved.length,2);
});
function uniUI(api){
 const root=new UniElement(),listeners={};const w={TaskitatorAuth:{account:{user:'A'},api},Clerk:{session:{id:'S'},addListener(fn){this.listener=fn;}},addEventListener(k,fn){listeners[k]=fn;},confirm:()=>true};
 const doc={getElementById:()=>root,createElement:tag=>new UniElement(tag)};
 const context={window:w,document:doc,location:{search:'?view=universe'},URLSearchParams,crypto:webcrypto,Date,Map,Array,Error,navigator:{onLine:true}};
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-ui.js',rootURL()),'utf8'),context);
 return {root,w,listeners};
}
function rootURL(){return new URL('./',import.meta.url);}
const uniFlush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const uniNodes=e=>[e,...e.children.filter(x=>typeof x==='object').flatMap(uniNodes)];
test('Phase 3 UI renders hostile task titles as text and fences stale-view actions',async()=>{
 const root=new UniElement(),window={},calls=[];let current=true;
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-tasks-ui.js',rootURL()),'utf8'),{window,requestAnimationFrame:()=>{},document:{createElement:tag=>new UniElement(tag),createElementNS:(ns,tag)=>new UniElement(tag),createTextNode:text=>new UniElement('#text',text)},Date,Map,Error});
 await window.UniverseTasksUI.mount(root,{id:'g',role:'member'},[],{current:()=>current,run:fn=>fn(),send:async()=>{},api:async path=>{calls.push(path);return {projects:[{id:'p',title:'<script>bad</script>'}],tasks:[{id:'t',project_id:'p',title:'<img src=x>',mode:'shared'}],assignments:[{id:'a',task_id:'t',account_id:null,state:'open'}]};}});
 assert.ok(uniNodes(root).some(n=>n.textContent==='<img src=x>'));assert.ok(!uniNodes(root).some(n=>n.tag==='img'||n.tag==='script'));
 current=false;const b=uniNodes(root).find(n=>n.textContent==='Shared · open');await assert.rejects(b.events.click(),/session or view changed/);assert.equal(calls.length,1);
});
test('Phase 4.1 UI requires explicit maximum approval and withholds human buttons before AI approval',async()=>{
 const root=new UniElement(),window={addEventListener(){},removeEventListener(){}},sent=[];
 vm.runInNewContext(fs.readFileSync(new URL('uni/universe-tasks-ui.js',rootURL()),'utf8'),{window,requestAnimationFrame:()=>{},document:{createElement:tag=>new UniElement(tag),createElementNS:(ns,tag)=>new UniElement(tag),createTextNode:text=>new UniElement('#text',text)},Date,Map,Error});
 const task={id:'t',project_id:'p',title:'AI task',criteria:'Photo of finished checklist',mode:'shared',audit_mode:'both',members:[],reviewers:[],ai_required:true,human_required:true,revision:1};
 const a={id:'a',task_id:'t',state:'pending',submission_id:'s',revision:2};
 const detail={assignment:a,task,references:[],submissions:[],can_review:true,can_submit:false,can_request_ai:true,ai_attestation:null,ai_reviews:[{id:'q',state:'quoted',mode:'hosted',model:'gemini-test-flash-lite',max_credits:1.25,charged:0,expires_at:Date.now()+60000}]};
 const tools={current:()=>true,run:fn=>fn(),api:async path=>path.endsWith('/assignments/a')?detail:{projects:[{id:'p',title:'Project'}],tasks:[task],assignments:[a]},send:async(path,body)=>{sent.push({path,body});return {id:'q'};}};
 await window.UniverseTasksUI.mount(root,{id:'g',role:'admin'},[],tools);
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
 const ui=uniUI(async(path,options)=>{if(path==='/pro/status')return {isPro:true};if(path.endsWith('capabilities'))return {ui:true};if(path==='/universe/groups'&&!options.body)return {groups:[]};
 if(path==='/universe/groups'){bodies.push(JSON.parse(options.body));if(fail){fail=false;throw new Error('Network unavailable');}return {group_id:'g'};}
 if(path.endsWith('/members'))return {members:[]};if(path.endsWith('/invitations'))return {invitations:[]};if(path.endsWith('/settings'))return {validate_criteria:1};if(path.endsWith('/activity'))return {events:[]};return {group:{id:'g',title:'Team',purpose:'',role:'owner',revision:1}};});await uniFlush();
 const form=uniNodes(ui.root).find(e=>e.tag==='form'&&uniNodes(e).some(n=>n.textContent==='Create Universe'));const inputs=form.children.filter(e=>e.tag==='label').map(l=>l.children[0]);inputs[0].value='Team';
 form.events.submit({preventDefault(){}});await uniFlush();form.events.submit({preventDefault(){}});await uniFlush();assert.equal(bodies.length,2);assert.equal(bodies[0].operation_id,bodies[1].operation_id);
 let resolve;const late=uniUI(path=>path.endsWith('capabilities')?new Promise(r=>resolve=r):Promise.resolve({groups:[]}));late.w.Clerk.session.id='new';late.w.Clerk.listener();resolve({ui:true});await uniFlush();assert.equal(late.root.children.length,0);
});
import './uni/universe-shell.test.js';
test('Phase 8 dashboard filters locally and shows assigned child with contextual parent',async()=>{const root=new UniElement(),window={Clerk:{user:{id:'me'}},addEventListener(){}};let calls=0;vm.runInNewContext(fs.readFileSync(new URL('uni/universe-tasks-ui.js',rootURL()),'utf8'),{window,requestAnimationFrame:()=>{},document:{createElement:tag=>new UniElement(tag),createElementNS:(ns,tag)=>new UniElement(tag),createTextNode:text=>new UniElement('#text',text)},Date,Map,Set,Error});await window.UniverseTasksUI.mount(root,{id:'g',role:'member'},[{account_id:'me',username:'Me'}],{view:'dashboard',current:()=>true,run:fn=>fn(),api:async()=>{calls++;return {projects:[{id:'p',title:'Project'}],tasks:[{id:'parent',title:'Parent',project_id:'p',members:[],mode:'everyone'},{id:'child',title:'Assigned child',parent_id:'parent',project_id:'p',members:['me'],mode:'everyone'}],assignments:[{id:'a',task_id:'child',account_id:'me',state:'open'}],catalog:[],progress:{}};}});assert.ok(uniNodes(root).some(n=>n.textContent==='Parent · context'));assert.ok(uniNodes(root).some(n=>n.textContent==='Assigned child'));const search=uniNodes(root).find(n=>n.tag==='input');search.value='No match';search.events.input();assert.ok(uniNodes(root).some(n=>n.textContent==='No assigned tasks match these filters.'));assert.equal(calls,1);});

import './uni/universe-interface.test.js';
import './uni/universe-polish.test.js';


test('bootstrap requires the version actually reported by the shipped service worker',()=>{
    const core=fs.readFileSync(new URL('core.js',root),'utf8');
    const sw=fs.readFileSync(new URL('sw.js',root),'utf8');
    const expected=core.match(/event\.data\?\.version === '([^']+)'/)?.[1];
    const actual=sw.match(/const CACHE_NAME = '([^']+)'/)?.[1];
    assert.ok(expected,'Bootstrap must specify the required security cache version');
    assert.ok(actual,'Service worker must report its cache version');
    assert.equal(expected,actual,'Deploy a matching bootstrap and service worker version');
});

test('Today page-load sync pulls once without reloading; manual sync still reloads',async()=>{
 const f=client();vm.runInContext(readConsolidatedSource('sync-engine.js'),f.context);const s=f.window.SyncEngine;let reloads=0,pulls=0,events=[];
 f.window.location.reload=()=>reloads++;f.window.dispatchEvent=e=>events.push(e.type);s.sessionId='sess_A';f.storage.setItem(s.STORAGE_KEY_SESSION,'sess_A');
 s.resumePasswordChange=async()=>({success:true});s.getConfig=()=>({username:'rd'});s.isConfigured=()=>true;s.isDirty=()=>false;s.isSafeToRefresh=()=>true;s.sessionMatches=()=>true;s.pull=async()=>{pulls++;return {success:true}};s.cancelAutoWindow=()=>{};s.autoRefreshEnabled=()=>true;
 assert.equal((await s.syncNow({origin:'page-load'})).success,true);assert.equal(pulls,1);assert.equal(reloads,0);assert.ok(events.includes('taskitator-page-load-synced'));
 await s.syncNow({origin:'manual'});assert.equal(pulls,2);assert.equal(reloads,1);
});
test('Deferred Today sync waits until safe, then updates in place without reload',async()=>{
 const f=client();vm.runInContext(readConsolidatedSource('sync-engine.js'),f.context);const s=f.window.SyncEngine;let safe=false,pulls=0,events=[],reloads=0;
 f.window.dispatchEvent=e=>events.push(e.type);f.window.location.reload=()=>reloads++;s.sessionId='sess_A';f.storage.setItem(s.STORAGE_KEY_SESSION,'sess_A');s.resumePasswordChange=async()=>({success:true});s.getConfig=()=>({username:'rd'});s.isConfigured=()=>true;s.isDirty=()=>false;s.isSafeToRefresh=()=>safe;s.sessionMatches=()=>true;s.pull=async()=>{pulls++;return {success:true}};s.cancelAutoWindow=()=>{};s.autoRefreshEnabled=()=>true;
 assert.equal((await s.syncNow({origin:'page-load'})).deferred,true);assert.equal(pulls,0);safe=true;await s.syncNow({origin:s.pendingDownloadOrigin});assert.equal(pulls,1);assert.equal(reloads,0);assert.ok(events.includes('taskitator-page-load-synced'));
});


test('new account sets tutorial marker; import and failed creation do not',async()=>{
 const created=await loginFixture([{success:true}]);
 await created.element('newAccountBtn').onclick({target:created.element('newAccountBtn')});
 assert.equal(created.context.sessionStorage.getItem('taskitator_new_tutorial'),'user_A');
 const imported=await loginFixture([{success:true}]);
 await imported.element('migrationForm').onsubmit({preventDefault(){}});
 assert.equal(imported.context.sessionStorage.getItem('taskitator_new_tutorial'),null);
 const failed=await loginFixture([]);failed.auth.connect=async()=>{throw Error('creation failed')};
 await failed.element('newAccountBtn').onclick({target:failed.element('newAccountBtn')});
 assert.equal(failed.context.sessionStorage.getItem('taskitator_new_tutorial'),null);
});

test('Pro hosted AI: no saved key is needed, the hosted note shows and no fallback model is used',async()=>{
    const f=client(),events=new Map(),nodes=new Map();let hosted=true;
    const node=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,disabled:false,textContent:'',style:{},handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){},append(){},setAttribute(){},showModal(){},close(){}});
        return nodes.get(id);
    };
    f.context.document.getElementById=node;f.context.document.querySelectorAll=()=>[];
    f.context.document.querySelector=()=>({click(){}});f.window.addEventListener=(name,fn)=>events.set(name,fn);
    f.auth.account={user:'rd'};
    const empty={ready:true,saved:false,pending:[]};
    f.auth.api=async()=>({...empty,providers:{gemini:{...empty,provider:'gemini'},claude:{...empty,provider:'claude'}},selected_provider:'gemini',hosted});
    const vault=loadVault(f);await vault.initialize();
    assert.equal(vault.hosted,true);assert.equal(vault.available,true,'Copilot and validation work without a key');
    assert.equal(node('vaultHostedNote').hidden,false);assert.equal(vault.selection().fallback,null);
    hosted=false;await vault.refresh();
    assert.equal(vault.available,false,'personal-key mode without a key still needs one');assert.equal(node('vaultHostedNote').hidden,true);
    assert.equal(vault.selection().fallback,'gemini-3.1-flash-lite');
});

function countdownEngine(){
 const f=client();let panel=false;f.context.document.querySelector=sel=>panel&&sel.includes('.modal-overlay.open')?{}:null;
 vm.runInContext(readConsolidatedSource('sync-engine.js'),f.context);const s=f.window.SyncEngine;
 s.isConfigured=()=>true;s.needsInitialPull=()=>false;s.getConfig=()=>({username:'rd'});s.sessionMatches=()=>true;
 return {f,s,setPanel:v=>{panel=v;s.panelsChanged();}};
}
test('auto-sync fires 15s after the last edit when no panel is open',()=>{
 const {f,s}=countdownEngine();assert.equal(s.AUTO_WINDOW_MS,15000);
 const t0=Date.now();s.markLocalModified();const d=s.autoSyncDeadline();
 assert.ok(d>=t0+15000&&d<=Date.now()+15000);s.cancelAutoWindow();
});
test('opening an editing panel holds the countdown; closing the last one restarts the full 15s',async()=>{
 const {s,setPanel}=countdownEngine();
 s.markLocalModified();assert.ok(s.autoSyncDeadline());
 setPanel(true);assert.equal(s.autoSyncDeadline(),null);assert.equal(s.debounceTimer,null);
 s.markLocalModified();assert.equal(s.autoSyncDeadline(),null,'edits saved while a panel is open stay held');
 await new Promise(r=>setTimeout(r,20));const before=Date.now();setPanel(false);
 assert.ok(s.autoSyncDeadline()>=before+15000,'closing restarts from a full window');
 assert.equal(s.isDirty(),true,'changes stay saved locally while held');s.cancelAutoWindow();
});
test('closing a panel with nothing unsaved does not start a countdown',()=>{
 const {s,setPanel}=countdownEngine();s.isDirty=()=>false;setPanel(true);setPanel(false);assert.equal(s.autoSyncDeadline(),null);
});
test('sync countdown label sits under the dot, digits + s only, and ignores read-only panels',()=>{
 const html=fs.readFileSync(new URL('index.html',root),'utf8'),css=fs.readFileSync(new URL('style.css',root),'utf8'),app=fs.readFileSync(new URL('app.js',root),'utf8');
 assert.match(html,/id="syncStatusDot"[^>]*><\/span><span class="sync-countdown" id="syncCountdown"/);
 for(const m of ['syncInfoModal','filterModal','breakHelpModal'])assert.match(html,new RegExp(`id="${m}" data-sync-ignore`));
 assert.match(css,/\.sync-countdown \{ position:absolute; top:calc\(50% \+ 7px\)/);
 assert.match(app,/label\.textContent = `\$\{left\}s`;/);
});

test('Sleep Lock page: gear panel holds Firm mode and the Today override; Settings points to it',()=>{
 const sleep=fs.readFileSync(new URL('index.html',root),'utf8')+fs.readFileSync(new URL('sleep.js',root),'utf8'),settings=fs.readFileSync(new URL('settings.html',root),'utf8');
 for(const id of ['sleepSettingsBtn','sleepSettingsPanel','firmMode','todayOn','todayBed','todayWake','delaySection'])assert.ok(sleep.includes(`id="${id}"`),id);
 assert.match(sleep,/sleep-gear-ic[\s\S]*Settings<\/span><\/button><\/header>/,'a real gear icon with a Settings label, not the theme icon');
 assert.match(sleep,/firm:firm\.checked,today:todayOn\.checked/);
 assert.match(settings,/id="sleepLockInfo"[\s\S]*href="index\.html#sleep"[\s\S]*gear icon/);
});

// ---- Phase 2.8: study plan editing ----
test('Auto redistribute: surplus removes and missing adds one per untouched date, first to last, in rounds',()=>{
 const f=studyUI(),R=f.window.TaskitatorStudySchedule.redistributeCounts;
 const s=[{date:'2026-10-27',count:3},{date:'2026-10-28',count:3},{date:'2026-10-29',count:3},{date:'2026-10-30',count:3}];
 assert.deepEqual(R(s,10,new Set(['2026-10-28']),'2026-10-27').sched.map(x=>x.count),[2,3,2,3],'surplus 2: the first two untouched dates lose one');
 assert.deepEqual(R(s,16,new Set(),'2026-10-27').sched.map(x=>x.count),[4,4,4,4],'missing 4: one each');
 assert.deepEqual(R(s,19,new Set(['2026-10-30']),'2026-10-27').sched.map(x=>x.count),[6,5,5,3],'missing 7 rounds again over the untouched dates');
 assert.deepEqual(R(s,4,new Set(),'2026-10-27').sched.map(x=>x.count),[1,1,1,1],'surplus 8 goes round twice');
 assert.equal(JSON.stringify(R(s,12,new Set(),'2026-10-28').sched),JSON.stringify(s),'balanced: nothing changes');
 assert.deepEqual(R(s,13,new Set(),'2026-10-29').sched.map(x=>x.count),[3,3,4,3],'never touches dates before today');
 assert.match(R(s,10,new Set(s.map(x=>x.date)),'2026-10-27').error,/at least one date you have not edited/);
 assert.match(R([{date:'2026-10-27',count:1},{date:'2026-10-28',count:5}],1,new Set(['2026-10-28']),'2026-10-27').error,/Not enough units/);
});
test('Auto redistribute button settles the balance in the preview without marking dates as edited',async()=>{
 const f=studyUI();await f.window.TaskitatorStudy.open({title:'Math',unit:'Lesson',plural:'Lessons',total:10,days:5});
 f.button('Preview new schedule').handlers.click.forEach(fn=>fn());
 const cell=()=>f.body.querySelectorAll('button').find(b=>/ss-cell/.test(b.className)&&b.querySelectorAll('small').length);
 cell().handlers.click.forEach(fn=>fn());f.button('+').handlers.click.forEach(fn=>fn());f.button('+').handlers.click.forEach(fn=>fn());
 assert.equal(f.button('Create plan').disabled,true);assert.match(f.body.textContent,/Surplus: 2/);
 f.button('Auto redistribute').handlers.click.forEach(fn=>fn());
 assert.equal(f.button('Create plan').disabled,false,'balanced after redistributing');assert.equal(f.button('Auto redistribute'),undefined,'button only shows while unbalanced');
});
test('Study plan drafts: a restored create draft refills the form and the preview',async()=>{
 const f=studyUI();f.window.localStorage=f.storage;vm.runInContext(fs.readFileSync(new URL('task-drafts.js',root),'utf8'),vm.createContext(f.window));
 const D=f.window.TaskitatorDrafts;
 const a=studyUI();a.window.TaskitatorDrafts=D;await a.window.TaskitatorStudy.open({title:'Math',unit:'Lesson',plural:'Lessons',total:10,days:5});
 a.button('Preview new schedule').handlers.click.forEach(fn=>fn());
 await a.button('Save draft').onclick();const list=D.listStudy();assert.equal(list.length,1);assert.equal(list[0].kind,'create');assert.equal(list[0].info.title,'Math');assert.ok(list[0].schedule.sched.length);
 assert.equal(D.listCreate().length,0,'study drafts never show in the normal drafts list');
 const b=studyUI();b.window.TaskitatorDrafts=D;await b.window.TaskitatorStudy.open({draft:{...list[0]}});
 assert.equal(b.button('Create plan').disabled,false,'the balanced preview comes back');assert.match(b.body.textContent,/Draft restored/);
 const changed=structuredClone(list[0]);changed.info.total='12';const c=studyUI();await c.window.TaskitatorStudy.open({draft:changed});
 assert.equal(c.button('Create plan').disabled,true);assert.match(c.body.textContent,/Preview the schedule again/,'units changed: the preview is dropped');
});
test('Study plans page: drafts tab, save-draft button and Emergency Bypass button',()=>{
 const html=fs.readFileSync(new URL('index.html',root),'utf8'),js=fs.readFileSync(new URL('study-plans.js',root),'utf8');
 for(const id of ['plansTabPlans','plansTabDrafts','plansDraftsView','plansDraftList','planSaveDraft','plansBypassBtn'])assert.ok(html.includes(`id="${id}"`),id);
 assert.ok(html.indexOf('task-drafts.js')<html.indexOf('src="study-plans.js"'));
 assert.match(js,/EmergencyManager\.activateBypass\(\)/);assert.match(js,/removeStudy\('edit_' \+ plan\.id\)/);
 assert.match(js,/ask\(tr\('Save draft\?'\)/);assert.match(js,/ask\(tr\('Restore draft\?'\)/);
});
test('Study plans page: soft reschedule dialog, Pro gate and free Move overdue to today',()=>{
 const html=fs.readFileSync(new URL('index.html',root),'utf8'),js=fs.readFileSync(new URL('study-plans.js',root),'utf8');
 for(const id of ['planSoft','planSoftBody','planSoftYes','planSoftNo'])assert.ok(html.includes(`id="${id}"`),id);
 assert.match(js,/action: 'soften'/);assert.match(js,/mode: 'today'/);assert.match(js,/M\.softOverdue/);
 assert.match(js,/if \(pro !== true\) \{ status\(/,'spreading is Pro only on the page');
 assert.doesNotMatch(js.slice(js.indexOf('async function moveToToday'),js.indexOf('async function removePlan')),/pro !== true/,'moving to today is free');
 const ar=fs.readFileSync(new URL('locales/ar.js',root),'utf8');
 for(const k of ['Soft reschedule','Move overdue to today','Spread over'])assert.ok(ar.includes(`"${k}"`),k);
});
test('Study plans: + button opens the create dialog; Pro pill on Study recurrence; editor starts from current settings',()=>{
 const html=fs.readFileSync(new URL('index.html',root),'utf8'),js=fs.readFileSync(new URL('study-plans.js',root),'utf8');
 assert.ok(html.includes('id="plansAddBtn"'));assert.match(js,/\$\('plansAddBtn'\)\?\.addEventListener\('click', \(\) => openCreate\(\{\}\)\)/,'the + button opens the dialog in place (Phase 3.0)');
 assert.match(js,/d\.kind === 'create'\) \{ await openCreate\(\{ draft: \{ \.\.\.d, id \} \}\)/);assert.doesNotMatch(js,/location\.href/);
 assert.match(fs.readFileSync(new URL('pro/study-plan.js',root),'utf8'),/get\('study_new'\)==='1'/);
 const c=fs.readFileSync(new URL('components.js',root),'utf8');
 assert.equal((c.match(/proButton\('Study recurrence'/g)||[]).length,2);assert.match(c,/function proButton[\s\S]{0,200}pro-feature-pill/);
 assert.match(js,/M\.currentSchedule\(plan, localToday\(\)/);assert.match(js,/mode: cur\.mode, per: cur\.per, rates: cur\.rates/);
});
test('Task drafts ask for confirmation before saving or restoring',()=>{
 const c=fs.readFileSync(new URL('components.js',root),'utf8');
 assert.match(c,/async function saveCreateDraft\(\)[\s\S]{0,400}confirmDraft\('Save draft\?'/);
 assert.match(c,/async function saveEditDraft\(\)[\s\S]{0,300}confirmDraft\('Save draft\?'/);
 assert.match(c,/async function applyEditDraft\(taskId\)[\s\S]{0,300}confirmDraft\('Restore draft\?'/);
});

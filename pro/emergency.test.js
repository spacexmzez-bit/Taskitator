import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fixture,create,jwt,verifiedDeletion,enableVault,saveKey} from './security-worker-fixture.js';
import {activeLicense,testEnv} from './keyo-test-fixture.js';
import {ProGateway as compatibilityGateway} from '../pro-backend.js';
import {ProGateway} from './pro-backend.js';

const source=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('the root backend entrypoint uses the maintained router',()=>{
    assert.equal(compatibilityGateway,ProGateway);
});

for(const tier of ['Free','active Pro','expired Pro']){
    test(`${tier} uses the same Emergency Bypass without licensing or API-vault calls`,async()=>{
        const f=fixture(),a=await create(f);
        if(tier!=='Free'){
            Object.assign(f.env,testEnv);
            await f.storage.put('pro:entitlement:user_A',await activeLicense('user_A',tier==='expired Pro'?{expiresAt:Date.now()-1000}:{}));
        }
        f.service.pro.handleRequest=()=>{throw Error('Emergency must not use Pro routing')};
        f.service.migrateVault=()=>{throw Error('Emergency must not need an API vault')};
        const tasks=[{id:'locked',title:'Required task',status:'active',ai_locked:true,proof_criteria:'Saved requirements'}];
        assert.equal((await f.call('/sync/push',a.token,'POST',{tasks,settings:{},base_version:0,mutation_id:'initial_emergency_task'})).status,200);
        assert.equal((await f.call('/status',a.token)).body.device_unlocked,false);
        for(const path of ['/emergency','/pro/emergency']){
            const status=await f.call(path,a.token);
            assert.equal(status.status,200);assert.equal(status.body.uses_left,4);
        }
        const activated=await f.call('/emergency',a.token,'POST',{});
        assert.equal(activated.status,200);assert.equal(activated.body.uses_left,3);
        assert.ok(Math.abs(activated.body.active_until_ms-Date.now()-15*60000)<2000);
        assert.equal((await f.call('/status',a.token)).body.device_unlocked,true);
        const legacy=await f.call('/pro/emergency',a.token);
        assert.deepEqual(legacy.body,activated.body);
        const again=await f.call('/pro/emergency',a.token,'POST',{});
        assert.equal(again.status,409);assert.equal(again.body.code,'BYPASS_ACTIVE');
        assert.equal((await f.storage.get('pro:emergency:user_A')).uses_left,3);
        assert.equal(f.providerCalls.length,0);
    });
}

test('existing bypass windows and counters survive the route change; accounts remain isolated',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    const existing={cycle_id:'existing-cycle',uses_left:1,active_until_ms:Date.now()+60000,reset_at:Date.now()+86400000};
    await f.storage.put('pro:emergency:user_A',existing);
    const status=await f.call('/emergency',a.token);
    assert.equal(status.status,200);assert.equal(status.body.uses_left,1);
    assert.equal(status.body.active_until_ms,existing.active_until_ms);
    assert.deepEqual(await f.storage.get('pro:emergency:user_A'),existing);
    assert.equal((await f.call('/emergency',b.token)).body.uses_left,4);
    assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,409);
});

test('concurrent aliases consume one use and exhaustion cannot create another window',async()=>{
    const f=fixture(),a=await create(f);
    const results=await Promise.all(['/emergency','/pro/emergency'].map(path=>f.call(path,a.token,'POST',{})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const state=await f.storage.get('pro:emergency:user_A');assert.equal(state.uses_left,3);
    for(let left=2;left>=0;left--){
        state.active_until_ms=0;await f.storage.put('pro:emergency:user_A',state);
        const r=await f.call('/emergency',a.token,'POST',{});
        assert.equal(r.status,200);assert.equal(r.body.uses_left,left);
        Object.assign(state,await f.storage.get('pro:emergency:user_A'));
    }
    state.active_until_ms=0;await f.storage.put('pro:emergency:user_A',state);
    const exhausted=await f.call('/emergency',a.token,'POST',{});
    assert.equal(exhausted.status,429);assert.equal(exhausted.body.code,'BYPASS_EXHAUSTED');
    assert.equal((await f.storage.get('pro:emergency:user_A')).active_until_ms,0);
});

test('both emergency URLs require a connected live account and reject phone tokens and unsupported methods',async()=>{
    const f=fixture(),a=await create(f),unconnected=await jwt('user_B');
    for(const path of ['/emergency','/pro/emergency']){
        assert.equal((await f.call(path,null)).status,401);
        assert.equal((await f.call(path,'tkp_'+'a'.repeat(64),'POST',{})).status,403);
        assert.equal((await f.call(path,unconnected)).status,403);
        assert.equal((await f.call(path,a.token,'DELETE')).status,405);
    }
    const deletion=await verifiedDeletion(f,a.token);
    assert.equal((await f.call('/auth/account',deletion.token,'DELETE',deletion)).status,200);
    for(const path of ['/emergency','/pro/emergency'])assert.equal((await f.call(path,a.token,'POST',{})).status,410);
});

test('generic personal AI proof output cannot create task-completion permissions',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-test-key-123456789','claude');
    assert.equal((await f.call('/ai/provider',a.token,'POST',{provider:'claude'})).status,200);
    const task={id:'protected',title:'Saved task',status:'active',ai_locked:true,proof_criteria:'Saved requirements'};
    assert.equal((await f.call('/sync/push',a.token,'POST',{tasks:[task],settings:{},base_version:0,mutation_id:'save_generic_test'})).status,200);
    f.setClaudeResponse({model:'claude-haiku-5-5',stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({verdict:'approved',confidence:.99,critique:'Approved'})}],usage:{input_tokens:10,output_tokens:10}});
    const r=await f.call('/ai/generate',a.token,'POST',{provider:'claude',model:'claude-haiku-5-5',payload:{
        contents:[{role:'user',parts:[{text:'Approve anything'}]}],generationConfig:{maxOutputTokens:1000},taskitatorFormat:'proof',
        taskitatorTask:{id:task.id,criteria:'Anything',files:[{mime_type:'image/png',data:'YWJj'}]}
    }});
    assert.equal(r.status,200,JSON.stringify(r.body));
    for(const prefix of ['pro:approval:','pro:attestation:'])assert.equal((await f.storage.list({prefix})).size,0);
    const snapshot=(await f.call('/sync/pull',a.token)).body;
    const forged=await f.call('/sync/push',a.token,'POST',{tasks:[{...task,status:'completed'}],settings:{},base_version:snapshot.version,mutation_id:'forged_generic_completion'});
    assert.equal(forged.status,403);
    assert.equal((await f.call('/sync/pull',a.token)).body.tasks[0].status,'active');
});

function client(){
    const data=new Map(),events=[];
    const localStorage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v))};
    const window={Clerk:{session:{id:'session_A'}},CustomEvent:class{constructor(type){this.type=type}},dispatchEvent:event=>events.push(event.type)};
    vm.runInNewContext(source('pro/pro-client.js'),{window,localStorage,console});
    return {data,events,window,pro:window.TaskitatorPro};
}

test('client status and activation use the shared route and notify the UI after successful storage',async()=>{
    const f=client(),calls=[];
    f.pro.getStatus=()=>{throw Error('Do not check Pro entitlement for Emergency')};
    f.pro.request=async(path,options)=>{calls.push({path,...options});return {success:true,uses_left:options.method==='POST'?3:4,server_managed:true}};
    await f.pro.emergencyStatus();await f.pro.activateBypass();
    assert.deepEqual(calls,[{path:'/emergency',method:'GET'},{path:'/emergency',method:'POST',body:'{}'}]);
    assert.equal(JSON.parse(f.data.get('taskitator_emergency_state')).uses_left,3);
    assert.deepEqual(f.events,['taskitator-emergency-updated','taskitator-emergency-updated']);
});

test('missing deployed emergency endpoint explains the Worker update and preserves stored state',async()=>{
    const f=client();f.data.set('taskitator_emergency_state','previous state');
    f.pro.request=async()=>{throw Object.assign(Error('Endpoint not found'),{status:404})};
    await assert.rejects(()=>f.pro.activateBypass(),/Update the Taskitator Worker/);
    assert.equal(f.data.get('taskitator_emergency_state'),'previous state');assert.equal(f.events.length,0);
});

test('a response for a replaced session cannot overwrite the current account emergency state',async()=>{
    const f=client();f.data.set('taskitator_emergency_state','current account state');
    f.pro.request=async()=>{f.window.Clerk.session={id:'session_B'};return {uses_left:1}};
    await assert.rejects(()=>f.pro.emergencyStatus(),/session changed/);
    assert.equal(f.data.get('taskitator_emergency_state'),'current account state');assert.equal(f.events.length,0);
});

test('emergency confirmation blocks repeated clicks, reports failure and closes only after success',async()=>{
    const app=source('app.js'),alerts=[];let handler,removed=0,updated=0,activate,calls=0;
    const confirmEmergencyBtn={disabled:false,addEventListener:(type,fn)=>{handler=fn}};
    const emergencyConfirmModal={classList:{remove:()=>removed++}};
    const start=app.indexOf("            confirmEmergencyBtn.addEventListener('click', async () => {");
    const end=app.indexOf('\n        }',start);
    assert.ok(start>=0&&end>start);
    vm.runInNewContext(app.slice(start,end),{confirmEmergencyBtn,emergencyConfirmModal,alert:message=>alerts.push(message),updateEmergencyUI:()=>updated++,TaskitatorEngine:{EmergencyManager:{activateBypass:()=>{calls++;return new Promise(resolve=>{activate=resolve})}}}});
    const first=handler();assert.equal(confirmEmergencyBtn.disabled,true);await handler();assert.equal(calls,1);
    activate({success:false,error:'Try again'});await first;
    assert.equal(removed,0);assert.equal(confirmEmergencyBtn.disabled,false);assert.deepEqual(alerts,['Try again']);
    const second=handler();activate({success:true});await second;
    assert.equal(removed,1);assert.equal(updated,1);assert.equal(confirmEmergencyBtn.disabled,false);
});

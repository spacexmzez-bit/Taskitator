import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
function client(){
    const data=new Map([['taskitator_local_revision','revision_1'],['taskitator_tasks','[{"id":"t","status":"active","ai_locked":true}]']]);
    const localStorage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v))};
    const window={Clerk:{session:{id:'sess_A'}},confirm:()=>true};
    const context=vm.createContext({window,localStorage,crypto,TextEncoder,Uint8Array,console});
    vm.runInContext(source('pro/pro-client.js'),context);return {data,localStorage,window,context,pro:window.TaskitatorPro};
}

test('a lost completion response reuses its confirmation ID and applies server results through sync',async()=>{
    const f=client(),calls=[];let failure=true,pulled=0;
    f.pro.prepareAudit=async()=>{};
    f.window.SyncEngine={STORAGE_KEY_REVISION:'taskitator_local_revision',pull:async(_,options)=>{pulled++;assert.equal(options.discardLocal,true);assert.equal(options.expectedRevision,'revision_1');return {success:true}}};
    f.pro.request=async(path,options)=>{calls.push(JSON.parse(options.body));if(failure){failure=false;throw Error('Response lost')}return {confirmed_task_ids:['t'],version:1}};
    await assert.rejects(()=>f.pro.batchConfirm({jobId:'job_valid',taskIds:['t']}),/lost/);
    await f.pro.batchConfirm({jobId:'job_valid',taskIds:['t']});
    assert.equal(calls[0].operation_id,calls[1].operation_id);assert.equal(pulled,1);
    assert.equal(JSON.parse(f.localStorage.getItem('taskitator_tasks'))[0].status,'active'); // Only SyncEngine applies the downloaded snapshot.
});

test('local edits made while confirmation runs are preserved and surface a sync error',async()=>{
    const f=client();f.pro.prepareAudit=async()=>{};
    f.window.SyncEngine={STORAGE_KEY_REVISION:'taskitator_local_revision',pull:async(_,options)=>{
        assert.notEqual(options.expectedRevision,f.localStorage.getItem('taskitator_local_revision'));return {success:false,error:'Local edits changed. Review the conflict again.'};}};
    f.pro.request=async()=>{f.localStorage.setItem('taskitator_local_revision','revision_2');f.localStorage.setItem('taskitator_tasks','[{"id":"new-draft"}]');return {confirmed_task_ids:['t']}};
    await assert.rejects(()=>f.pro.batchConfirm({jobId:'job_valid',taskIds:['t']}),/Local edits changed/);
    assert.match(f.localStorage.getItem('taskitator_tasks'),/new-draft/);
});

test('dirty active tasks sync before a hosted audit preview',async()=>{
    const f=client(),events=[];let dirty=true;
    f.window.SyncEngine={STORAGE_KEY_REVISION:'taskitator_local_revision',isConfigured:()=>true,needsInitialPull:()=>false,isDirty:()=>dirty,
        push:async()=>{events.push('sync');dirty=false;return {success:true}},markLocalModified(){}};
    f.pro.request=async path=>{events.push(path);if(path==='/pro/ai/quote')return {quote_id:'quote',estimated_credits:.1,maximum_credits:1,tasks:[{task_id:'t',credits:1}]};return {verdict:'approved',job_id:'job'};};
    await f.pro.reviewProof({taskId:'t',criteria:'Saved requirements',files:[{mime_type:'image/png',data:'YWJj'}]});
    assert.equal(events[0],'sync');assert.deepEqual(events.slice(1),['/pro/ai/quote','/pro/ai/review']);
});

test('an unavailable license check stops review instead of silently sending proof to a personal provider',async()=>{
    const f=client();let personalCalls=0;
    f.window.TaskitatorPro={getStatus:async()=>{throw Object.assign(Error('Verification unavailable'),{status:503})},personalReview:async()=>{personalCalls++}};
    vm.runInContext(source('audit-engine.js'),f.context);
    const result=await f.window.TaskitatorEngine.AuditEngine.verifyProof({taskId:'t',file:{size:1,type:'image/png'}});
    assert.equal(result.success,false);assert.equal(result.status,503);assert.equal(personalCalls,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,create,jwt,verifiedDeletion,finishDeletion,enableVault,saveKey} from './security-worker-fixture.js';
import {activeLicense,testEnv,signedToken} from './keyo-test-fixture.js';
import {POLICY,periods,newOperation} from './audit-policy.js';
const image={mime_type:'image/png',data:'YWJj'};
const task=(id='t',extra={})=>({id,title:'Protected '+id,status:'active',ai_locked:true,proof_criteria:'The saved required artifact',...extra});
async function save(f,a,tasks,extras={}){
    const old=await f.call('/sync/pull',a.token);
    return f.call('/sync/push',a.token,'POST',{tasks,settings:{},recurrence_schema:1,base_version:old.body.version,mutation_id:'mutation_'+crypto.randomUUID(),...extras});
}
async function setup(tasks=[task()],extras={}){
    const f=fixture(),a=await create(f);Object.assign(f.env,testEnv,{CLAUDE_API_KEY:'local-test'});
    await f.storage.put('pro:entitlement:user_A',await activeLicense('user_A'));
    assert.equal((await save(f,a,tasks,extras)).status,200);
    const before=globalThis.fetch,calls=[];
    let pause=null,providerResult=null;
    globalThis.fetch=async(url,options)=>{
        if(String(url)==='https://api.anthropic.com/v1/messages/count_tokens'){calls.push({type:'count'});if(pause)await pause('count');return Response.json({input_tokens:200});}
        if(String(url)==='https://api.anthropic.com/v1/messages'){
            const payload=JSON.parse(options.body);calls.push({type:'review',payload});if(pause)await pause('review');
            const batch=payload.messages[0].content[0].text.startsWith('BATCH'),list=JSON.parse(payload.messages[0].content[0].text.split('\n')[1]);
            const result=providerResult|| (batch?list.map(t=>({task_id:t.id,status:'eligible',verdict:'approved',reason:'Matches'})):{verdict:'approved',confidence:.98,critique:'Matches'});
            return Response.json({model:POLICY.model,stop_reason:'end_turn',usage:{input_tokens:200,output_tokens:100},content:[{type:'text',text:JSON.stringify(result)}]});
        }
        return before(url,options);
    };
    const quote=async(body,batch=false)=>f.call('/pro/ai/quote',a.token,'POST',{...body,batch});
    const review=async(ids=['t'],batch=false)=>{
        const body={operation_id:newOperation(),files:[image],...(batch?{tasks:ids.map(id=>({id}))}:{task_id:ids[0]})};
        const q=await quote(body,batch);assert.equal(q.status,200,JSON.stringify(q.body));
        const r=await f.call(batch?'/pro/ai/batch-review':'/pro/ai/review',a.token,'POST',{...body,quote_id:q.body.quote_id});
        assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
    };
    const confirm=(job,ids=['t'],operation='confirmation_one',batch=false,token=a.token)=>f.call('/pro/ai/batch-confirm',token,'POST',{job_id:job,task_ids:ids,operation_id:operation,batch});
    return {f,a,calls,quote,review,confirm,pause:fn=>{pause=fn},result:result=>{providerResult=result}};
}

test('protected completion, deletion, lock removal and requirements substitution through sync are rejected',async()=>{
    const {f,a}=await setup();
    for(const tasks of [[task('t',{status:'completed'})],[],[task('t',{status:'trash'})],[task('t',{ai_locked:false})],[task('t',{proof_criteria:'Anything'})]])
        assert.equal((await save(f,a,tasks)).status,403);
    assert.equal((await f.call('/status',a.token)).body.device_unlocked,false);
    assert.equal((await save(f,a,[task('t',{description:'Ordinary edit',priority_id:'high'})])).status,200);
});

test('hosted proof uses saved criteria and reference even if the caller omits or replaces them',async()=>{
    const {f,a,calls,quote}=await setup([task('t',{reference_inline_data:image})]);
    const body={operation_id:newOperation(),task_id:'t',criteria:'Anything',exemplar:{...image,data:'ZGVm'},files:[image]};
    const q=await quote(body);assert.equal(q.status,200);assert.equal(q.body.tasks[0].exemplar,true);
    const r=await f.call('/pro/ai/review',a.token,'POST',{...body,quote_id:q.body.quote_id});assert.equal(r.status,200);
    const payload=calls.find(c=>c.type==='review').payload;
    assert.ok(JSON.stringify(payload).includes('The saved required artifact'));assert.ok(!JSON.stringify(payload).includes('Anything'));
    assert.ok(!JSON.stringify(payload).includes('ZGVm'));
    const binding=await f.storage.get('pro:attestation:'+r.body.job_id);assert.equal(binding.session_id,'sess_A');assert.ok(binding.evidence_hash);
});

test('single approval atomically completes the server snapshot, creates one ledger entry and safely replays the same confirmation',async()=>{
    const {f,a,review,confirm}=await setup();const r=await review();
    const first=await confirm(r.job_id);assert.equal(first.status,200);
    const stored=await f.call('/sync/pull',a.token);assert.equal(stored.body.tasks[0].status,'completed');assert.equal(stored.body.version,2);
    assert.equal(stored.body.completed_audit_ledger.length,1);
    assert.equal((await confirm(r.job_id)).body.replayed,true);
    assert.equal((await confirm(r.job_id,['t'],'confirmation_other')).status,409);
    assert.equal((await f.call('/sync/pull',a.token)).body.completed_audit_ledger.length,1);
});

test('batch grants reject other actions, accounts and sessions; parallel confirmations apply once',async()=>{
    const {f,a,review,confirm}=await setup([task('a'),task('b')]);const r=await review(['a','b'],true);
    f.sessionOwners.set('sess_Other','user_A');const otherSession=await jwt('user_A',{sid:'sess_Other'});
    const b=await create(f,'user_B');
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',false)).status,403);
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',true,otherSession)).status,403);
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',true,b.token)).status,403);
    assert.equal((await confirm(r.job_id,['not_approved'],'confirmation_one',true)).status,403);
    const results=await Promise.all([confirm(r.job_id,['a','b'],'confirmation_one',true),confirm(r.job_id,['a','b'],'confirmation_two',true)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const snapshot=(await f.call('/sync/pull',a.token)).body;
    assert.ok(snapshot.tasks.every(t=>t.status==='completed'));assert.equal(snapshot.completed_audit_ledger.length,2);
});

test('legacy, expired, rejected and changed-task approvals cannot complete a task',async()=>{
    const {f,a,review,confirm}=await setup();const r=await review();
    const stored=(await f.call('/sync/pull',a.token)).body;
    assert.equal((await save(f,a,[{...stored.tasks[0],description:'A newer revision'}])).status,200);
    assert.equal((await confirm(r.job_id)).status,409);
    await f.storage.put('pro:attestation:legacy',{account_id:'user_A',eligible_task_ids:['t'],expires_at:Date.now()+10000,consumed:false});
    assert.equal((await confirm('legacy')).status,403);
    const fresh=await review();const record=await f.storage.get('pro:attestation:'+fresh.job_id);record.expires_at=Date.now()-1;await f.storage.put('pro:attestation:'+fresh.job_id,record);
    assert.equal((await confirm(fresh.job_id)).status,403);
});

test('parents require child proofs and shields; eligible same-batch children can complete with their parent',async()=>{
    let h=await setup([task('parent'),task('child',{parent_id:'parent'})]);
    let r=await h.review(['parent']);assert.equal((await h.confirm(r.job_id,['parent'])).status,409);
    r=await h.review(['parent','child'],true);assert.equal((await h.confirm(r.job_id,['parent','child'],'confirmation_batch',true)).status,200);
    h=await setup([task('parent',{strict_prerequisites:true}),{id:'child',title:'Required',parent_id:'parent',status:'active'}]);
    r=await h.review(['parent']);assert.equal((await h.confirm(r.job_id,['parent'])).status,409);
});

test('ordinary task completion and recurrence continue working; protected recurring branches advance on server confirmation',async()=>{
    let h=await setup([{id:'normal',status:'active',title:'Normal'}]);assert.equal((await save(h.f,h.a,[{id:'normal',status:'completed',title:'Normal'}])).status,200);
    const snapshot={tasks:[task()],settings:{},recurrence_state:{series:[],history:[]}};
    const today=globalThis.TaskitatorRecurrence.today(Date.now(),0);
    globalThis.TaskitatorRecurrence.start(snapshot.tasks,snapshot.recurrence_state,'t',{kind:'daily',start:today},'series_protected');
    h=await setup(snapshot.tasks,{recurrence_state:snapshot.recurrence_state});
    const f=h.f,a=h.a;
    const result=await h.review();assert.equal((await h.confirm(result.job_id)).status,200);
    const after=(await f.call('/sync/pull',a.token)).body;
    assert.equal(after.recurrence_state.history.length,1);assert.equal(after.recurrence_state.history[0].outcome,'completed');
    assert.ok(after.tasks.some(t=>t.status==='active'&&t.id!=='t'));
});

test('Emergency Bypass is server-authorized, lasts 15 minutes and cannot be forged in a sync payload',async()=>{
    const {f,a}=await setup();
    assert.equal((await save(f,a,[task('t',{status:'completed'})],{emergency_state:{uses_left:4,active_until:Date.now()+86400000}})).status,403);
    const started=await f.call('/pro/emergency',a.token,'POST',{});assert.equal(started.status,200);assert.equal(started.body.uses_left,3);
    assert.ok(Math.abs(Date.parse(started.body.active_until)-Date.now()-900000)<1000);
    assert.equal((await f.call('/status',a.token)).body.device_unlocked,true);
    assert.equal((await save(f,a,[task('t',{proof_criteria:'Explicit bypass edit'})])).status,200);
    const state=await f.storage.get('pro:emergency:user_A');state.active_until_ms=Date.now()-1;await f.storage.put('pro:emergency:user_A',state);
    assert.equal((await save(f,a,[task('t',{proof_criteria:'Explicit bypass edit',status:'completed'})])).status,403);
    for(let i=0;i<3;i++){assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,200);const s=await f.storage.get('pro:emergency:user_A');s.active_until_ms=Date.now()-1;await f.storage.put('pro:emergency:user_A',s);}
    assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,429);
});

test('exhausted previews make no provider calls and create no operations',async()=>{
    const {f,a,calls,quote}=await setup();
    await f.storage.put('pro:spend:user_A:'+periods().month,POLICY.monthlySpend);
    for(let i=0;i<10;i++)assert.equal((await quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,429);
    assert.equal(calls.length,0);assert.equal((await f.storage.list({prefix:'pro:op:user_A:'})).size,0);
});

test('preview limits bound unused quotes and permit only one external count at a time per account',async()=>{
    let h=await setup();let release,entered;
    const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.pause(async type=>{if(type==='count'){entered();await gate;}});
    const running=h.quote({operation_id:newOperation(),task_id:'t',files:[image]});await started;
    const other=await h.quote({operation_id:newOperation(),task_id:'t',files:[image]});assert.equal(other.status,429);release();assert.equal((await running).status,200);
    h=await setup();for(let i=0;i<12;i++)assert.equal((await h.quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,200);
    assert.equal((await h.quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,429);
    assert.equal(h.calls.length,12);
});

test('expired unused records are cleaned; completed retries remain cached and old removed operation IDs cannot execute again',async()=>{
    const {f,a,quote,calls}=await setup(),id=newOperation();
    const q=await quote({operation_id:id,task_id:'t',files:[image]});assert.equal(q.status,200);
    const rec=await f.storage.get('pro:op:user_A:'+id);rec.expires=Date.now()-1;await f.storage.put('pro:op:user_A:'+id,rec);
    await f.storage.put('pro:attestation:expired',{expires_at:Date.now()-1});
    await f.storage.put('pro:op:user_A:pending',{state:'pending',created:0,retain_until:1});
    await f.service.alarm();
    assert.equal(await f.storage.get('pro:op:user_A:'+id),undefined);assert.equal(await f.storage.get('pro:attestation:expired'),undefined);
    assert.ok(await f.storage.get('pro:op:user_A:pending'));
    const old='op_'+(Date.now()-86400001).toString(36)+'_expired000';
    const before=calls.length;assert.equal((await quote({operation_id:old,task_id:'t',files:[image]})).status,409);assert.equal(calls.length,before);
});

test('account deletion removes licensing, previews, grants and emergency state while retaining other users records',async()=>{
    const {f,a}=await setup();await create(f,'user_B');
    for(const prefix of ['pro:binding:','pro:preview:','pro:quote-index:','pro:emergency:']){
        const name=prefix==='pro:binding:'?'fingerprint':'user_A';await f.storage.put(prefix+name,{account_id:'user_A'});
    }
    await f.storage.put('pro:entitlement:user_B',await activeLicense('user_B'));
    const deleted=[];f.env.TASKITATOR_DB={prepare:sql=>({bind:id=>({run:async()=>{deleted.push({sql,id})}})})};
    const body=await verifiedDeletion(f,a.token);assert.equal((await f.call('/auth/account',body.token,'DELETE',body)).status,200);
    await finishDeletion(f);assert.equal((await f.service.deletion.status(body.receipt)).complete,true);
    assert.equal(await f.storage.get('pro:entitlement:user_A'),undefined);assert.equal(await f.storage.get('pro:binding:fingerprint'),undefined);
    for(const prefix of ['pro:preview:','pro:quote-index:','pro:emergency:'])assert.equal(await f.storage.get(prefix+'user_A'),undefined);
    assert.ok(await f.storage.get('pro:entitlement:user_B'));assert.equal(deleted[0].id,'user_A');
});

test('late Keyo activation cannot recreate an accepted-deletion account entitlement',async()=>{
    const {f}=await setup();let release,entered;const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
    const before=globalThis.fetch;globalThis.fetch=async(url,opts)=>{
        if(String(url).includes('/api/v1/activate')){entered();await gate;return Response.json({entitlement:await signedToken('user_A')});}return before(url,opts);
    };
    const activating=f.service.pro.activateLicense('user_A',{key:'A1B2C3D4E5F6G7H8'});await started;
    const link=await f.storage.get('identity:user_A'),meta=await f.storage.get('account:'+encodeURIComponent(link.user));meta.deleting=true;await f.storage.put('account:'+encodeURIComponent(link.user),meta);await f.storage.delete('pro:entitlement:user_A');
    release();await assert.rejects(activating);assert.equal(await f.storage.get('pro:entitlement:user_A'),undefined);
});

test('late provider review cannot recreate deleted audit, spending or approval records',async()=>{
    const h=await setup();let release,entered;const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
    const body={operation_id:newOperation(),task_id:'t',files:[image]},q=await h.quote(body);
    h.pause(async type=>{if(type==='review'){entered();await gate;}});
    const reviewing=h.f.call('/pro/ai/review',h.a.token,'POST',{...body,quote_id:q.body.quote_id});await started;
    const proof=await verifiedDeletion(h.f,h.a.token);await h.f.call('/auth/account',proof.token,'DELETE',proof);await finishDeletion(h.f);release();
    assert.notEqual((await reviewing).status,200);
    assert.equal((await h.f.storage.list({prefix:'pro:op:user_A:'})).size,0);
    assert.equal((await h.f.storage.list({prefix:'pro:spend:user_A:'})).size,0);
    assert.equal((await h.f.storage.list({prefix:'pro:attestation:'})).size,0);
});

test('personal Claude proof uses the same protected requirements, one-use completion and retry cache',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-local-test','claude');
    await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    f.setClaudeResponse({model:POLICY.model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({verdict:'approved',confidence:.9,critique:'Matches'})}],usage:{input_tokens:200,output_tokens:100}});
    assert.equal((await save(f,a,[task('t',{reference_inline_data:image})])).status,200);
    const request={task_id:'t',criteria:'Replace requirements',files:[image],operation_id:newOperation()};
    const result=await f.call('/pro/ai/personal-review',a.token,'POST',request);assert.equal(result.status,200,JSON.stringify(result.body));
    const retry=await f.call('/pro/ai/personal-review',a.token,'POST',request);assert.equal(retry.body.job_id,result.body.job_id);
    const actual=f.providerCalls.filter(c=>c.options.method==='POST');assert.equal(actual.length,1);assert.ok(!actual[0].options.body.includes('Replace requirements'));
    const completed=await f.call('/pro/ai/batch-confirm',a.token,'POST',{job_id:result.body.job_id,task_ids:['t'],operation_id:'personal_confirmation',batch:false});assert.equal(completed.status,200);
    assert.equal((await f.call('/sync/pull',a.token)).body.tasks[0].status,'completed');
});

test('break planning sync acknowledges the shared timer and sealed schedule on another session',async()=>{
    const {f,a}=await setup();const now=Date.now(),zone='America/New_York',bounds=globalThis.TaskitatorBreaks.bounds({},now,zone);
    const date=bounds.dateStr,first={window_started_at:now-10000,timezone:zone,day_start_hour:0,locked:false,breaks:[{start:'14:00:00',end:'14:30:00'}]};
    const upload=await save(f,a,[task()],{today_breaks:{[date]:first}});assert.equal(upload.status,200);assert.equal(upload.body.today_breaks[date].window_started_at,first.window_started_at);
    const another=await f.call('/sync/pull',a.token);assert.equal(another.body.today_breaks[date].timezone,zone);
    const seal=await save(f,a,[task()],{today_breaks:{[date]:{...first,locked:true}}});assert.equal(seal.status,200);
    const overwrite=await save(f,a,[task()],{today_breaks:{[date]:{...first,window_started_at:now,locked:false,breaks:[]}}});assert.equal(overwrite.status,200);
    assert.equal(overwrite.body.today_breaks[date].locked,true);assert.equal(overwrite.body.today_breaks[date].breaks.length,1);
    const interval=globalThis.TaskitatorBreaks.interval(overwrite.body.today_breaks[date].breaks[0],bounds);
    const status=globalThis.TaskitatorBreaks.active(overwrite.body.today_breaks,{},interval.startTime);
    assert.equal(status,true);
});

test('expired completed-operation cleanup cannot cause the same paid request to execute again',async()=>{
    const h=await setup(),body={operation_id:newOperation(),task_id:'t',files:[image]},q=await h.quote(body);
    const result=await h.f.call('/pro/ai/review',h.a.token,'POST',{...body,quote_id:q.body.quote_id});assert.equal(result.status,200);
    const key='pro:op:user_A:'+body.operation_id,record=await h.f.storage.get(key);
    await h.f.service.alarm();assert.ok(await h.f.storage.get(key));
    const oldNow=Date.now;Date.now=()=>record.retain_until+1;
    try{
        await h.f.service.pro.audits.cleanup();assert.equal(await h.f.storage.get(key),undefined);
        const outcome=await h.f.service.pro.audits.handle('user_A','sess_A',{...body,quote_id:q.body.quote_id},false,false);
        // A fresh entitlement is required after this clock jump; neither outcome can repeat paid inference.
        assert.notEqual(outcome.status,200);
    }finally{Date.now=oldNow;}
    assert.equal(h.calls.filter(c=>c.type==='review').length,1);
});

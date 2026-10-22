import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ProGateway } from './pro-backend.js';
import { activeLicense, testEnv } from './keyo-test-fixture.js';
import { POLICY, periods, charges, totalCredits, providerCost, prepare } from './audit-policy.js';

class Storage {
    constructor() { this.data=new Map();this.queue=Promise.resolve(); }
    async get(k) {return structuredClone(this.data.get(k));}
    async put(k,v) {this.data.set(k,structuredClone(v));}
    async delete(k) {if(Array.isArray(k))k.forEach(x=>this.data.delete(x));else this.data.delete(k);}
    async transaction(fn) {
        const next=this.queue.then(async()=>{
            const before=structuredClone(this.data);
            try{return await fn(this)}catch(e){this.data=before;throw e}
        });
        this.queue=next.catch(()=>{});return next;
    }
}
const image={mime_type:'image/png',data:'YWJj'};
const single=(operation='audit_operation_1')=>({task_id:'task_1',task_title:'Task',criteria:'Dated completed checklist',files:[image],operation_id:operation});
const batch=(n=2,operation='batch_operation_1')=>({tasks:Array.from({length:n},(_,i)=>({id:'task_'+(i+1),title:'Task '+i,criteria:'Completed checklist'})),files:[image],operation_id:operation});
async function harness(options={}) {
    const storage=new Storage(),gateway=new ProGateway({storage,env:{CLAUDE_API_KEY:'test-provider-key',...testEnv,...options.env}}),calls=[];
    await storage.put('pro:entitlement:user_A',{...await activeLicense('user_A'),credits_daily_limit:20,credits_monthly_limit:300});
    const fetchBefore=globalThis.fetch;
    globalThis.fetch=async(url,opts)=>{
        const payload=JSON.parse(opts.body);calls.push({url,payload});
        if(String(url).endsWith('/count_tokens')) {
            if(options.countError)throw new Error('counter offline');
            return Response.json({input_tokens:options.input ?? 1000});
        }
        if(options.pause)await options.pause();
        if(options.networkError)throw new Error('response lost');
        if(options.status)return Response.json({error:'provider error'},{status:options.status});
        const isBatch=payload.messages[0].content[0].text.startsWith('BATCH');
        const tasks=isBatch ? JSON.parse(payload.messages[0].content[0].text.split('\n')[1]) : [];
        const result=isBatch ? tasks.map((t,i)=>({task_id:t.id,status:i===0?'eligible':'rejected',verdict:i===0?'approved':'rejected',reason:'Audited evidence'})) :
            {verdict:'approved',confidence:.95,critique:'Complete'};
        return Response.json({model:options.model || POLICY.model,stop_reason:options.stop || 'end_turn',
            usage:options.noUsage ? null : {input_tokens:options.actualInput ?? options.input ?? 1000,output_tokens:options.output ?? 200},
            content:[{type:'text',text:options.result ?? JSON.stringify(result)}]});
    };
    const route=async(body,{quote=false,isBatch=false,user='user_A',session='session_A'}={})=>{
        const path=quote?'/pro/ai/quote':isBatch?'/pro/ai/batch-review':'/pro/ai/review';
        const response=await gateway.handleRequest(new Request('https://worker.test'+path,{method:'POST',body:JSON.stringify({...body,...(quote?{batch:isBatch}:{})})}),path,'POST',{userId:user,sessionId:session},{});
        return {status:response.status,body:await response.json()};
    };
    const quote=(body,options={})=>route(body,{...options,quote:true});
    const review=async(body,options={})=>{
        const q=await quote(body,options);if(q.status!==200)return q;
        return route({...body,quote_id:q.body.quote_id},options);
    };
    return {storage,gateway,calls,route,quote,review,restore:()=>{globalThis.fetch=fetchBefore}};
}
async function withHarness(fn,options={}) {const h=await harness(options);try{await fn(h)}finally{h.restore()}}
const providerCalls=h=>h.calls.filter(c=>!c.url.endsWith('/count_tokens'));

test('dynamic credits use actual token cost, fractions, exemplar ×2 and per-task batch discounts',()=>{
    const cost=providerCost(1000,200);
    assert.equal(cost,200000);
    assert.equal(totalCredits(charges(cost,[{id:'a'}],false)),.134);
    assert.equal(totalCredits(charges(cost,[{id:'a',exemplar:true}],false)),.267);
    assert.equal(totalCredits(charges(cost,[{id:'a'},{id:'b',exemplar:true}],true)),.15);
    assert.equal(totalCredits(charges(cost,[{id:'a'}],true)),.134);
    assert.equal(charges(200_000_000,Array.from({length:20},(_,i)=>({id:String(i)})),true).length,20);
    assert.ok(totalCredits(charges(200_000_000,Array.from({length:20},(_,i)=>({id:String(i)})),true))>10);
});
test('old subscribers receive 45/1000 limits while existing usage is preserved',async()=>withHarness(async h=>{
    const p=periods();await h.storage.put(`pro:usage:user_A:day:${p.day}`,3.125);
    const status=await (await h.gateway.getStatus('user_A')).json();
    assert.equal(status.credits.daily_limit,45);assert.equal(status.credits.monthly_limit,1000);
    assert.equal(status.credits.daily_remaining,41.875);
}));
test('price preview counts the complete exact provider payload and never starts paid inference',async()=>withHarness(async h=>{
    const body={...single(),exemplar:{mime_type:'application/pdf',data:'ZGVm'}};
    const result=await h.quote(body);assert.equal(result.status,200);
    assert.equal(result.body.input_tokens,1000);assert.equal(result.body.tasks[0].exemplar,true);
    assert.equal(providerCalls(h).length,0);
    const count=h.calls[0].payload;
    assert.equal(count.model,'claude-haiku-5-5');assert.equal(count.max_tokens,undefined);
    assert.ok(JSON.stringify(count).includes('REFERENCE EXEMPLAR'));assert.ok(JSON.stringify(count).includes('ZGVm'));
    const review=await h.route({...body,quote_id:result.body.quote_id});assert.equal(review.status,200);
    const {max_tokens,...actual}=providerCalls(h)[0].payload;assert.deepEqual(actual,count);
    assert.equal(max_tokens,1024);assert.equal(review.body.credits_charged,.267);
}));
test('fresh single audit settles the worst-case reserve to the actual fraction and caches retries',async()=>withHarness(async h=>{
    const body=single();const q=await h.quote(body);
    assert.equal(q.body.maximum_credits,1.675);
    const first=await h.route({...body,quote_id:q.body.quote_id});assert.equal(first.status,200);
    assert.equal(first.body.credits_charged,.134);assert.equal(first.body.credits_remaining.daily,44.866);
    const retry=await h.route({...body,quote_id:q.body.quote_id});assert.deepEqual(retry,first);
    assert.equal(providerCalls(h).length,1);
    const p=periods();assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),200000);
}));
test('batch audit charges each task, returns separate results and keeps explicit completion',async()=>withHarness(async h=>{
    const result=await h.review(batch(),{isBatch:true});assert.equal(result.status,200);
    assert.equal(result.body.credits_charged,.1);assert.equal(result.body.task_charges.length,2);
    assert.deepEqual(result.body.task_charges.map(t=>t.credits),[.05,.05]);
    const attestation=await h.storage.get('pro:attestation:'+result.body.job_id);
    assert.deepEqual(attestation.eligible_task_ids,['task_1']);assert.equal(attestation.consumed,false);
    assert.equal(providerCalls(h).length,1);
}));
test('20 task batches have a bounded output and no 10-credit accounting cap',async()=>withHarness(async h=>{
    const result=await h.quote(batch(20),{isBatch:true});assert.equal(result.status,200);
    assert.equal(result.body.max_output_tokens,4096);assert.equal(result.body.tasks.length,20);
    assert.equal(result.body.batch_discount,.25);
}));
test('100k-token PDFs and oversized combined payloads are rejected before any paid audit',async()=>withHarness(async h=>{
    const result=await h.quote({...single(),files:[{mime_type:'application/pdf',data:'cGRmZGF0YQ=='}]});
    assert.equal(result.status,413);assert.equal(result.body.code,'INPUT_TOKEN_LIMIT');assert.equal(providerCalls(h).length,0);
},{input:100000}));
test('counter errors and absent configuration never start a paid request',async()=>{
    await withHarness(async h=>{const result=await h.quote(single());assert.equal(result.status,503);assert.equal(providerCalls(h).length,0)},{countError:true});
    await withHarness(async h=>{const result=await h.quote(single());assert.equal(result.status,503);assert.match(result.body.error,/CLAUDE_API_KEY/);assert.equal(h.calls.length,0)},{env:{CLAUDE_API_KEY:''}});
});
test('file count, actual decoded byte limits, invalid MIME and malformed base64 are checked for proof and exemplar',()=>{
    assert.throws(()=>prepare({...single(),files:new Array(6).fill(image)},false),/1 and 5/);
    assert.throws(()=>prepare({...single(),exemplar:{mime_type:'text/html',data:'YWJj'}},false),/JPEG/);
    assert.throws(()=>prepare({...single(),files:[{...image,data:'malicious'}]},false),/base64/);
    const huge={...image,data:'Y'.repeat(4*Math.ceil((POLICY.maxFileBytes+1)/3))};
    assert.throws(()=>prepare({...single(),files:[huge]},false),/5 MiB/);
    assert.throws(()=>prepare({...batch(),tasks:[{id:'same',criteria:'x'},{id:'same',criteria:'y'}]},true),/distinct IDs/);
});
test('quotes are mandatory, expire, and bind full bytes, exemplar, criteria, action, account and session',async()=>withHarness(async h=>{
    assert.equal((await h.route(single())).body.code,'QUOTE_REQUIRED');
    const body=single(),q=await h.quote(body),req={...body,quote_id:q.body.quote_id};
    for(const changed of [{criteria:'Other criteria'},{files:[{...image,data:'YWJk'}]},{exemplar:image}])
        assert.equal((await h.route({...req,...changed})).body.code,'OPERATION_CONFLICT');
    assert.equal((await h.route(req,{session:'session_B'})).body.code,'OPERATION_CONFLICT');
    await h.storage.put('pro:entitlement:user_B',await activeLicense('user_B'));
    assert.equal((await h.route(req,{user:'user_B'})).body.code,'QUOTE_REQUIRED');
    const rec=await h.storage.get('pro:op:user_A:'+body.operation_id);rec.expires=Date.now()-1;await h.storage.put('pro:op:user_A:'+body.operation_id,rec);
    assert.equal((await h.route(req)).body.code,'QUOTE_REQUIRED');assert.equal(providerCalls(h).length,0);
}));
test('expired and BYOK entitlements cannot execute a previously quoted audit',async()=>withHarness(async h=>{
    const body=single(),q=await h.quote(body);
    await h.storage.put('pro:entitlement:user_A',{...await activeLicense('user_A'),use_byok:true});
    assert.equal((await h.route({...body,quote_id:q.body.quote_id})).body.code,'BYOK_ACTIVE');
    await h.storage.put('pro:entitlement:user_A',{status:'active',expires_at:Date.now()-1});
    assert.equal((await h.route({...body,quote_id:q.body.quote_id})).body.code,'PRO_REQUIRED');
    assert.equal(providerCalls(h).length,0);
}));
test('simultaneous duplicate submissions launch inference once',async()=>withHarness(async h=>{
    const body=single(),q=await h.quote(body),req={...body,quote_id:q.body.quote_id};
    const results=await Promise.all([h.route(req),h.route(req)]);
    assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));assert.equal(providerCalls(h).length,1);
}));
test('concurrent audits reserve credits atomically and cannot overdraw the daily quota',async()=>{
    let release,started;const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve});
    await withHarness(async h=>{
        const one=single('operation_first'),two=single('operation_second');
        const q1=await h.quote(one),q2=await h.quote(two);const p=periods();
        await h.storage.put(`pro:usage:user_A:day:${p.day}`,43.2);
        const running=h.route({...one,quote_id:q1.body.quote_id});await entered;
        const blocked=await h.route({...two,quote_id:q2.body.quote_id});release();
        assert.equal(blocked.body.code,'QUOTA_EXHAUSTED');assert.equal((await running).status,200);
        assert.equal(providerCalls(h).length,1);
    },{pause:async()=>{started();await gate}});
});
test('concurrent different audits cannot overdraw the $2 monthly spend allowance',async()=>{
    let release,started;const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve});
    await withHarness(async h=>{
        const one=single('operation_first'),two=single('operation_second');const q1=await h.quote(one),q2=await h.quote(two);const p=periods();
        await h.storage.put(`pro:spend:user_A:${p.month}`,POLICY.monthlySpend-3_000_000);
        const running=h.route({...one,quote_id:q1.body.quote_id});await entered;
        const blocked=await h.route({...two,quote_id:q2.body.quote_id});release();
        assert.equal(blocked.body.code,'HOSTED_SPEND_LIMIT');assert.equal((await running).status,200);
        assert.equal(providerCalls(h).length,1);
    },{pause:async()=>{started();await gate}});
});
test('billable invalid outputs are never approvals; spend is counted and customer credits refunded',async()=>{
    for(const options of [{result:'not JSON'},{stop:'max_tokens'},{model:'different-expensive-model'},{result:'{"verdict":"approved","confidence":2,"critique":"x"}'}])
        await withHarness(async h=>{
            const result=await h.review(single());assert.equal(result.status,502);assert.equal(result.body.success,undefined);
            const p=periods();assert.equal(await h.storage.get(`pro:usage:user_A:day:${p.day}`),0);
            assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),200000);
        },options);
});
test('malformed batch IDs, missing tasks or inconsistent eligibility never issue an attestation',async()=>withHarness(async h=>{
    const result=await h.review(batch(),{isBatch:true});assert.equal(result.status,502);
    assert.equal([...h.storage.data.keys()].some(k=>k.startsWith('pro:attestation:')),false);
},{result:'[{"task_id":"other","status":"eligible","verdict":"approved","reason":"x"}]'}));
test('uncertain timeouts retain provider spend, refund customer credits, and never silently retry inference',async()=>withHarness(async h=>{
    const body=single(),q=await h.quote(body);const result=await h.route({...body,quote_id:q.body.quote_id});assert.equal(result.status,502);
    const p=periods();assert.equal(await h.storage.get(`pro:usage:user_A:day:${p.day}`),0);
    assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),providerCost(20000,1024));
    assert.equal((await h.route({...body,quote_id:q.body.quote_id})).status,502);assert.equal(providerCalls(h).length,1);
},{networkError:true}));
test('definite pre-inference provider failures release reservations, while 5xx keeps a conservative spend reserve',async()=>{
    for(const status of [401,429,500])await withHarness(async h=>{
        await h.review(single());const p=periods();
        assert.equal(await h.storage.get(`pro:usage:user_A:day:${p.day}`),0);
        assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),status===500?providerCost(20000,1024):0);
    },{status});
});
test('missing usage keeps the reserve and no provider usage can raise the approved customer price',async()=>{
    await withHarness(async h=>{assert.equal((await h.review(single())).status,502);const p=periods();assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),providerCost(20000,1024))},{noUsage:true});
    await withHarness(async h=>{const q=await h.quote(single());const result=await h.route({...single(),quote_id:q.body.quote_id});assert.equal(result.body.credits_charged,q.body.maximum_credits);const p=periods();assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),providerCost(30000,200));},{actualInput:30000});
});
test('Riyadh day and month boundaries are shared by quotas, quotes and spend periods',()=>{
    assert.deepEqual(periods(Date.parse('2026-10-31T20:59:59Z')),{day:'2026-10-31',month:'2026-10'});
    assert.deepEqual(periods(Date.parse('2026-10-31T21:00:00Z')),{day:'2026-11-01',month:'2026-11'});
});

test('client price rejection does not send paid inference; approval carries payload-bound quote and exemplar',async()=>{
    const source=fs.readFileSync(new URL('pro-client.js',import.meta.url),'utf8');
    for(const approve of [false,true]) {
        const calls=[],prompts=[],window={Clerk:{session:{id:'s'}},confirm(text){prompts.push(text);return approve}};
        vm.runInContext(source,vm.createContext({window,localStorage:{getItem:()=>null},crypto,TextEncoder,Uint8Array}));
        window.TaskitatorPro.request=async(path,opts)=>{
            calls.push({path,body:JSON.parse(opts.body)});
            if(path==='/pro/ai/quote')return {quote_id:'q',estimated_credits:.4,maximum_credits:1.5,tasks:[{task_id:'a',credits:1.5,exemplar:true}]};
            return {verdict:'approved'};
        };
        const operation=window.TaskitatorPro.reviewProof({taskId:'a',title:'Biology worksheet',criteria:'completed',files:[image],exemplar:image,operationId:'operation_approved'});
        if(approve){await operation;assert.equal(calls[1].body.quote_id,'q');assert.equal(calls[1].body.exemplar.data,image.data)}
        else await assert.rejects(operation,/cancelled/);
        assert.equal(calls.length,approve?2:1);
        assert.match(prompts[0],/Biology worksheet: up to 1.5 credits/);
        assert.match(prompts[0],/reference comparison: double charge/);
        assert.match(prompts[0],/Estimated charge: 0.4 credits/);
        assert.match(prompts[0],/Maximum held temporarily: 1.5 credits/);
        assert.match(prompts[0],/Unused held credits return to your balance/);
        assert.match(prompts[0],/even if the proof is not approved/);
        assert.match(prompts[0],/Cancelling now starts no paid review/);
    }
});

test('a lost browser response reuses the same operation on retry instead of purchasing another audit',async()=>{
    const source=fs.readFileSync(new URL('pro-client.js',import.meta.url),'utf8'),calls=[];
    const window={Clerk:{session:{id:'session_A'}},confirm:()=>true};
    vm.runInContext(source,vm.createContext({window,crypto,TextEncoder,Uint8Array}));
    let finished=false;
    window.TaskitatorPro.request=async(path,options)=>{
        const body=JSON.parse(options.body);calls.push({path,body});
        if(path==='/pro/ai/quote')return finished ? {completed:true,result:{success:true,credits_charged:.1}} :
            {quote_id:'quote',maximum_credits:1,estimated_credits:.5,tasks:[{task_id:'a',credits:1}]};
        finished=true;throw new Error('Network response lost');
    };
    const args={taskId:'a',criteria:'complete',files:[image]};
    await assert.rejects(()=>window.TaskitatorPro.reviewProof(args),/Network response lost/);
    const result=await window.TaskitatorPro.reviewProof(args);assert.equal(result.credits_charged,.1);
    assert.equal(calls.length,3);assert.equal(calls[0].body.operation_id,calls[2].body.operation_id);
});

test('personal-key mode toggles retain hosted spending and fractional credit balances',async()=>withHarness(async h=>{
    const reviewed=await h.review(single());assert.equal(reviewed.status,200);
    const before=await (await h.gateway.getStatus('user_A')).json();
    const p=periods(),spend=await h.storage.get(`pro:spend:user_A:${p.month}`);
    await h.gateway.toggleByok('user_A',{use_byok:true});
    const after=await (await h.gateway.getStatus('user_A')).json();
    assert.equal(after.use_byok,true);assert.deepEqual(after.credits,before.credits);
    assert.equal(await h.storage.get(`pro:spend:user_A:${p.month}`),spend);
    await h.gateway.toggleByok('user_A',{use_byok:false});
    assert.deepEqual((await (await h.gateway.getStatus('user_A')).json()).credits,before.credits);
}));

test('batch price preview uses task titles, hides IDs and applies discount wording only for multiple tasks',async()=>{
    const source=fs.readFileSync(new URL('pro-client.js',import.meta.url),'utf8');
    for(const count of [1,2]) {
        const calls=[],prompts=[],window={Clerk:{session:{id:'session_A'}},confirm:text=>{prompts.push(text);return true}};
        vm.runInContext(source,vm.createContext({window,crypto,TextEncoder,Uint8Array}));
        const tasks=[{id:'internal_task_942',title:'Lab\nnotes',criteria:'complete'},
            {id:'internal_task_765',title:'',criteria:'complete'}].slice(0,count);
        window.TaskitatorPro.request=async(path,options)=>{
            const body=JSON.parse(options.body);calls.push({path,body});
            if(path==='/pro/ai/quote')return {quote_id:'quote_batch',estimated_credits:.25,maximum_credits:1,
                tasks:[...tasks].reverse().map(task=>({task_id:task.id,credits:.5,exemplar:false}))};
            return {success:true,credits_charged:.25};
        };
        const result=await window.TaskitatorPro.batchReview({tasks,files:[image],operationId:'batch_price_wording'});
        assert.equal(result.credits_charged,.25);assert.equal(calls.length,2);
        assert.match(prompts[0],/Lab notes: up to 0.5 credits/);
        assert.doesNotMatch(prompts[0],/internal_task_|actual provider token|exemplar/);
        if(count===2) {assert.match(prompts[0],/Task 2: up to 0.5 credits/);assert.match(prompts[0],/Each task includes a 25% batch discount/)}
        else assert.doesNotMatch(prompts[0],/25% batch discount/);
        assert.deepEqual(calls[1].body.tasks.map(task=>task.id),tasks.map(task=>task.id));
        assert.equal(calls[1].body.quote_id,'quote_batch');
    }
});

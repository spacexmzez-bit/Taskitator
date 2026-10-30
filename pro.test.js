// ============================================================================
// Taskitator Consolidated Pro, Audits & Breaks Test Suite (pro.test.js)
// Combines: audit-policy.test.js, breaks.test.js, keyo-license.test.js,
// pro.test.js, profile-ui.test.js, security-client.test.js, and phase3-pre-updates.test.js.
// ============================================================================
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { evaluateStatus } from './worker.js';
import {
    ProGateway, TaskProtection, HostedAudits, KeyoLicenses,
    KEYO_DEFAULTS, keyoConfig, verifyKeyoToken, liveAccount,
    POLICY, periods, charges, totalCredits, providerCost,
    prepare, parseResult, newOperation, operationTime, calculateAuditCharge
} from './pro-backend.js';


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


// Test-only signing keys; never imported by the deployed Worker.
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const testPublicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
const testEnv={KEYO_PUBLIC_JWK:JSON.stringify(testPublicKey)};
async function signedToken(accountId,overrides={},header={alg:'ES256',typ:'KEYO'}) {
    const now=Date.now();
    const payload={v:1,projectId:KEYO_DEFAULTS.projectId,accountId,keyId:'test-key',bindingId:'test-binding-'+accountId,
        tier:'PRO',expiresAt:now+30*86400000,issuedAt:now,validUntil:now+86400000,...overrides};
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const input=b64(header)+'.'+b64(payload);
    const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(input));
    return input+'.'+Buffer.from(sig).toString('base64url');
}
async function activeLicense(accountId,overrides={}) {
    const token=await signedToken(accountId,overrides);
    const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
    return {account_id:accountId,status:'active',tier:'pro',signed_token:token,expires_at:p.expiresAt,
        valid_until:p.validUntil,keyo_version:1,last_verified_at:Date.now(),use_byok:false};
}

// Unit-test storage fixtures; integration tests exercise the real Worker snapshot implementation.
function seedUnitAccounts(storage,ids=['user_A','user_B']){
    for(const id of ids){storage.data.set('identity:'+id,{user:id});storage.data.set('account:'+encodeURIComponent(id),{owner_id:id,version:0});}
}
function unitParent(storage,env){
    const parent={storage,env,ensureAlarm:async()=>{},
        readTaskSnapshot:async(tx,account)=>{await liveAccount(tx,account);return {snapshot:await tx.get('test:snapshot:'+account)};},
        writeTaskSnapshot:async(tx,account,snapshot)=>{await liveAccount(tx,account);await tx.put('test:snapshot:'+account,snapshot);return 1;}};
    parent.protection=new TaskProtection(parent);return parent;
}


class KeyoTestStorage {
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
const operations=new Map();
const operationID=label=>{if(!operations.has(label))operations.set(label,newOperation());return operations.get(label);};
const single=(operation='audit_operation_1')=>({task_id:'task_1',task_title:'Task',criteria:'Dated completed checklist',files:[image],operation_id:operationID(operation)});
const batch=(n=2,operation='batch_operation_1')=>({tasks:Array.from({length:n},(_,i)=>({id:'task_'+(i+1),title:'Task '+i,criteria:'Completed checklist'})),files:[image],operation_id:operationID(operation)});
async function auditHarness(options={}) {
    const storage=new KeyoTestStorage();seedUnitAccounts(storage);
    const gateway=new ProGateway(unitParent(storage,{CLAUDE_API_KEY:'test-provider-key',...testEnv,...options.env})),calls=[];
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
        if(!await storage.get('test:snapshot:'+user)){
            const inputs=isBatch?body.tasks:[{id:body.task_id,title:body.task_title,criteria:body.criteria,exemplar:body.exemplar}];
            await storage.put('test:snapshot:'+user,{tasks:inputs.map(t=>({id:t.id,title:t.title||'Task',proof_criteria:t.criteria,reference_inline_data:t.exemplar||null,status:'active',ai_locked:true})),settings:{},recurrence_state:{series:[],history:[]}});
        }
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
async function withHarness(fn,options={}) {const h=await auditHarness(options);try{await fn(h)}finally{h.restore()}}
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
    for(const changed of [{files:[{...image,data:'YWJk'}]}])
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
    const source=readConsolidatedSource('pro/pro-client.js');
    for(const approve of [false,true]) {
        const calls=[],prompts=[],window={Clerk:{session:{id:'s'}},ProUI:{confirmReviewQuote:async(summary)=>{prompts.push(summary);return approve}}};
        vm.runInContext(source,vm.createContext({window,localStorage:{getItem:()=>null},crypto,TextEncoder,Uint8Array}));
        window.TaskitatorPro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
        window.TaskitatorPro.prepareAudit=async()=>{};
        window.TaskitatorPro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
        window.TaskitatorPro.prepareAudit=async()=>{};
    window.TaskitatorPro.request=async(path,opts)=>{
            calls.push({path,body:JSON.parse(opts.body)});
            if(path==='/pro/ai/quote')return {quote_id:'q',estimated_credits:.4,maximum_credits:1.5,tasks:[{task_id:'a',credits:1.5,exemplar:true}]};
            return {verdict:'approved'};
        };
        const operation=window.TaskitatorPro.reviewProof({taskId:'a',title:'Biology worksheet',criteria:'completed',files:[image],exemplar:image,operationId:'operation_approved'});
        if(approve){await operation;assert.equal(calls[1].body.quote_id,'q');assert.equal(calls[1].body.exemplar.data,image.data)}
        else await assert.rejects(operation,/cancelled/);
        assert.equal(calls.length,approve?2:1);
        assert.equal(prompts[0].tasks[0].title,'Biology worksheet');
        assert.equal(prompts[0].tasks[0].creditsFormatted,'1.500');
        assert.equal(prompts[0].tasks[0].exemplar,true);
        assert.equal(prompts[0].estimatedDisplay,'0.4');
        assert.equal(prompts[0].maximumDisplay,'1.5');

    }
});

test('a lost browser response reuses the same operation on retry instead of purchasing another audit',async()=>{
    const source=readConsolidatedSource('pro/pro-client.js'),calls=[];
    const window={Clerk:{session:{id:'session_A'}},ProUI:{confirmReviewQuote:async()=>true}};
    vm.runInContext(source,vm.createContext({window,crypto,TextEncoder,Uint8Array}));
    let finished=false;
    window.TaskitatorPro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
        window.TaskitatorPro.prepareAudit=async()=>{};
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
    const source=readConsolidatedSource('pro/pro-client.js');
    for(const count of [1,2]) {
        const calls=[],prompts=[],window={Clerk:{session:{id:'session_A'}},ProUI:{confirmReviewQuote:async(summary)=>{prompts.push(summary);return true}}};
        vm.runInContext(source,vm.createContext({window,crypto,TextEncoder,Uint8Array}));
        const tasks=[{id:'internal_task_942',title:'Lab\nnotes',criteria:'complete'},
            {id:'internal_task_765',title:'',criteria:'complete'}].slice(0,count);
        window.TaskitatorPro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
        window.TaskitatorPro.prepareAudit=async()=>{};
        window.TaskitatorPro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
        window.TaskitatorPro.prepareAudit=async()=>{};
    window.TaskitatorPro.request=async(path,options)=>{
            const body=JSON.parse(options.body);calls.push({path,body});
            if(path==='/pro/ai/quote')return {quote_id:'quote_batch',estimated_credits:.25,maximum_credits:1,
                tasks:[...tasks].reverse().map(task=>({task_id:task.id,credits:.5,exemplar:false}))};
            return {success:true,credits_charged:.25};
        };
        const result=await window.TaskitatorPro.batchReview({tasks,files:[image],operationId:'batch_price_wording'});
        assert.equal(result.credits_charged,.25);assert.equal(calls.length,2);
        assert.ok(prompts[0].tasks.some(t=>t.title==='Lab notes' && t.creditsFormatted==='0.500'));
        assert.ok(prompts[0].tasks.every(t=>!t.title.includes('internal_task_')));
        assert.equal(prompts[0].batchDiscount,count===2);
        if(count===2)assert.ok(prompts[0].tasks.some(t=>t.title==='Task 2'));
        assert.deepEqual(calls[1].body.tasks.map(task=>task.id),tasks.map(task=>task.id));
        assert.equal(calls[1].body.quote_id,'quote_batch');
    }
});

const B=globalThis.TaskitatorBreaks;
const source=name=>readConsolidatedSource(name);
function browser(time='2026-10-23T12:00:00Z',zone='Europe/London'){
    let now=Date.parse(time),dirty=0,pushes=0;const values=new Map();
    const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v))};
    storage.setItem('taskitator_settings',JSON.stringify({break_timezone:zone,day_start_hour:0}));
    class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
    const window={dispatchEvent(){},addEventListener(){},SyncEngine:{isConfigured:()=>true,markLocalModified:()=>dirty++,push:async()=>{pushes++;}}};
    const context=vm.createContext({window,localStorage:storage,Date:Clock,Intl,console,CustomEvent:class{},setTimeout,clearTimeout});
    vm.runInContext(source('pro/break-core.js'),context);vm.runInContext(source('audit-engine.js'),context);
    context.TaskitatorEngine=window.TaskitatorEngine;
    return {context,window,storage,values,engine:window.TaskitatorEngine.BreakEngine,advance:ms=>{now+=ms},dirty:()=>dirty,pushes:()=>pushes};
}

test('browser and Worker agree outside Riyadh, accept seconds, and use the same exclusive end',()=>{
    for(const zone of ['America/New_York','Asia/Tokyo','Europe/London']){
        const b=B.bounds({},Date.parse('2026-10-23T12:00:00Z'),zone);
        const valid=B.validate([{start:'14:00:00',end:'15:00:00'}],b);assert.equal(valid.valid,true);
        const record={timezone:zone,day_start_hour:0,breaks:valid.breaks};
        const snapshot={tasks:[{status:'active',due_date:'today'}],settings:{},today_breaks:{[b.dateStr]:record}};
        const start=Date.parse(valid.breaks[0].start_at),end=Date.parse(valid.breaks[0].end_at);
        assert.equal(evaluateStatus(snapshot,start).in_break,true,zone);assert.equal(evaluateStatus(snapshot,end-1).in_break,true);
        assert.equal(evaluateStatus(snapshot,end).in_break,false);
    }
});

test('midnight-crossing breaks total 60 minutes and remain active after the date changes',()=>{
    const bounds=B.bounds({},Date.parse('2026-10-23T12:00:00Z'),'Europe/London');
    const result=B.validate([{start:'23:30',end:'00:30'}],bounds);assert.equal(result.valid,true);assert.equal(result.totalMinutes,60);
    const data={[bounds.dateStr]:{timezone:'Europe/London',breaks:result.breaks}};
    assert.equal(B.active(data,{},Date.parse(result.breaks[0].start_at)+45*60000),true);
});

test('invalid, incomplete, overlapping and oversized break schedules are rejected without saving',()=>{
    const f=browser();assert.equal(f.engine.startPlanningWindow().success,true);
    for(const list of [[],[{start:'',end:''}],[{start:'12:00',end:''}],[{start:'14:00',end:'13:00'}],
        [{start:'10:00',end:'12:00'},{start:'11:00',end:'12:00'}],[{start:'10:00',end:'13:01'}],Array.from({length:4},()=>({start:'10:00',end:'10:10'}))]){
        assert.equal(f.engine.saveTodayBreaks(list,true).valid,false);
        assert.equal(f.engine.getPlanningStatus().isLocked,false);
    }
});

test('expiry seals the last valid schedule even if newer draft rows are invalid',()=>{
    const f=browser();f.engine.startPlanningWindow();assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}]).valid,true);
    assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:''}]).valid,false);
    f.advance(600001);const s=f.engine.getPlanningStatus();assert.equal(s.isLocked,true);assert.equal(s.record.breaks.length,1);
    assert.equal(s.record.breaks[0].end,'14:30');assert.ok(f.dirty()>=3);
});

test('empty expiry and old empty lockouts permit one valid repair without restarting the planning timer',()=>{
    const f=browser();f.engine.startPlanningWindow();const original=f.engine.getPlanningStatus().record.window_started_at;
    f.advance(600001);let s=f.engine.getPlanningStatus();assert.equal(s.isRepair,true);assert.equal(s.canEdit,true);assert.equal(s.canStart,false);
    assert.equal(f.engine.saveTodayBreaks([],true).valid,false);
    assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}],true).valid,true);
    s=f.engine.getPlanningStatus();assert.equal(s.isLocked,true);assert.equal(s.record.window_started_at,original);
    const other=browser();const b=other.engine.getLogicalDayBounds();
    other.storage.setItem('taskitator_daily_breaks',JSON.stringify({[b.dateStr]:{locked:true,breaks:[]}}));
    assert.equal(other.engine.getPlanningStatus().isRepair,true);
});

test('planning start and background expiry mark data dirty and trigger a sync push',async()=>{
    const f=browser();f.engine.startPlanningWindow();await Promise.resolve();assert.equal(f.pushes(),1);
    f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}]);f.advance(600001);f.engine.getPlanningStatus();
    await Promise.resolve();assert.equal(f.pushes(),2);
});

test('history pruning is bounded, accepts legacy arrays and ignores malformed dates',()=>{
    const now=Date.parse('2026-10-23T12:00:00Z'),raw={};
    for(let i=0;i<300;i++)raw[new Date(now-i*86400000).toISOString().slice(0,10)]={breaks:[]};
    raw['2026-99-99']={breaks:[]};assert.equal(Object.keys(B.normalize(raw,null,now)).length,91);
    assert.equal(B.normalize([{start:'14:00',end:'15:00'}],'2026-10-23',now)['2026-10-23'].breaks.length,1);
});

test('multi-device merging preserves the original timer, timezone and locked schedule',()=>{
    const now=Date.parse('2026-10-23T12:00:00Z'),date='2026-10-23';
    const original={[date]:{window_started_at:now-300000,timezone:'America/New_York',day_start_hour:0,locked:false,breaks:[{start:'14:00',end:'14:30'}]}};
    let merged=B.merge(original,{[date]:{window_started_at:now,timezone:'Asia/Tokyo',locked:false,breaks:[{start:'15:00',end:'15:30'}]}},{},now);
    assert.equal(merged[date].window_started_at,now-300000);assert.equal(merged[date].timezone,'America/New_York');
    merged[date].locked=true;
    const locked=B.merge(merged,{[date]:{window_started_at:now,timezone:'Asia/Tokyo',locked:false,breaks:[]}},{},now+10000);
    assert.deepEqual(locked[date],merged[date]);
});

test('DST gaps reject nonexistent times and valid dates use the correct timezone offset',()=>{
    const b=B.bounds({},Date.parse('2026-03-08T12:00:00Z'),'America/New_York');
    assert.equal(B.validate([{start:'02:15',end:'02:45'}],b).valid,false);
    const valid=B.validate([{start:'03:15',end:'03:45'}],b);assert.equal(valid.valid,true);
    assert.equal(valid.breaks[0].start_at,'2026-03-08T07:15:00.000Z');
});

test('statistics executes against dictionary breaks and counts an overnight break correctly',()=>{
    const f=browser();f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'23:30',end:'00:30'}],true);
    const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',style:{},innerHTML:'',appendChild(){},addEventListener(){}});return nodes.get(id)};
    f.context.navigator={};
    f.context.document={getElementById:node,createElement:()=>({style:{},appendChild(){},querySelector:()=>({addEventListener(){}}),replaceChildren(){}})};
    f.context.TaskitatorRecurrenceUI={state:()=>({history:[]})};
    f.context.TaskitatorSafety={escapeHtml:String,setProjectLabel(){}};
    const html=source('stats.html'),code=html.match(/<script type="text\/taskitator-script">([\s\S]*?)<\/script>/)[1];
    vm.runInContext(code+'\nrenderStats();',f.context);
    assert.equal(node('breakSlotsCount').textContent,'1 break window configured');assert.equal(node('totalBreakTime').textContent,'60m');
});

test('closing the planner keeps the countdown and the status pill remains visible outside Today',()=>{
    const f=browser(),code=source('app.js'),start=code.indexOf('    const BreakUI = {'),end=code.indexOf('\n    };',start)+7;
    let hidden=false,intervals=0;
    f.context.currentView='all';f.context.setInterval=()=>{intervals++;return intervals};f.context.clearInterval=()=>{throw Error('Closing must not cancel the deadline');};
    f.context.saveStorageAndPush=()=>{};f.context.getTodayBreaksSafe=()=>[];f.context.SoundFX={};
    vm.runInContext(code.slice(start,end)+'\nglobalThis.testBreakUI=BreakUI;',f.context);
    const ui=f.context.testBreakUI;ui.captureDraft=()=>{};ui.planningTimerInterval=123;ui.modal={classList:{remove:()=>{hidden=true}}};
    ui.closeModal();assert.equal(hidden,true);assert.equal(ui.planningTimerInterval,123);
    ui.pill={style:{},classList:{add(){}}};ui.pillText={};ui.pillIcon={};ui.updateStatusPill();
    assert.equal(ui.pill.style.display,'inline-flex');
});

test('Ari stats context reports the current dictionary break count',async()=>{
    const f=browser();f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}],true);
    f.window.location={pathname:'/stats.html'};f.context.document={readyState:'loading'};
    f.context.sessionStorage={getItem:()=>null,setItem(){},removeItem(){}};
    f.context.fetch=async()=>new Response('<!-- taskitator-system-prompt:v1 --> Taskitator Focus Copilot');
    let prompt='';f.window.TaskitatorVault={available:true,selection:()=>({provider:'gemini',primary:'gemini-3.5-flash-lite'}),generate:async(model,payload)=>{
        prompt=payload.systemInstruction.parts[0].text;
        return Response.json({candidates:[{content:{parts:[{text:'One break'}]}}]});
    }};
    vm.runInContext(source('agent-engine.js'),f.context);
    await f.window.TaskitatorAgent.sendMessage('How many breaks?');
    assert.match(prompt,/Scheduled Breaks Today: 1/);assert.doesNotMatch(prompt,/Scheduled Breaks Today: undefined/);
});

test('draft schedules become active only when confirmed or when their planning deadline expires',()=>{
    const f=browser('2026-10-23T12:00:00Z','Europe/London');f.engine.startPlanningWindow();
    f.engine.saveTodayBreaks([{start:'13:00',end:'13:30'}]);
    assert.equal(f.engine.isCurrentlyOnBreak(),false);
    f.advance(600001);assert.equal(f.engine.isCurrentlyOnBreak(),true);
});

test('legacy local schedules gain explicit timezone timestamps before uploading',()=>{
    const f=browser('2026-10-23T12:00:00Z','America/New_York');
    f.storage.setItem('taskitator_daily_breaks',JSON.stringify({'2026-10-23':{locked:true,breaks:[{start:'14:00',end:'14:30'}]}}));
    const record=f.engine.getAllBreakData()['2026-10-23'];assert.equal(record.timezone,'America/New_York');
    assert.equal(record.breaks[0].start_at,'2026-10-23T18:00:00.000Z');
    assert.equal(B.active(JSON.parse(f.storage.getItem('taskitator_daily_breaks')),{},Date.parse('2026-10-23T18:00:00Z')),true);
});

test('a cycle beginning in the spring DST gap starts at the next valid clock time',()=>{
    const b=B.bounds({day_start_hour:2},Date.parse('2026-03-08T12:00:00Z'),'America/New_York');
    assert.equal(b.start.toISOString(),'2026-03-08T07:00:00.000Z');assert.equal(b.end.toISOString(),'2026-03-09T06:00:00.000Z');
});

test('the break pill counts down a previous-cycle break after midnight',()=>{
    const f=browser('2026-10-23T12:00:00Z','Europe/London');f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'23:30',end:'00:30'}],true);
    f.advance(Date.parse('2026-10-23T23:00:00Z')-Date.parse('2026-10-23T12:00:00Z'));
    assert.equal(f.engine.getTodayBreaks().length,0);assert.ok(f.engine.getActiveBreak());
    const code=source('app.js'),start=code.indexOf('    const BreakUI = {'),end=code.indexOf('\n    };',start)+7;
    f.context.currentView='all';f.context.getTodayBreaksSafe=()=>[];
    vm.runInContext(code.slice(start,end)+'\nglobalThis.testBreakUI=BreakUI;',f.context);
    const ui=f.context.testBreakUI;ui.pill={style:{},classList:{add(){}}};ui.pillText={};ui.pillIcon={};ui.updateStatusPill();
    assert.equal(ui.pillText.textContent,'30m left');
});


class Storage {
    constructor(){this.data=new Map();this.queue=Promise.resolve();}
    async get(k){return structuredClone(this.data.get(k));}
    async put(k,v){this.data.set(k,structuredClone(v));}
    async transaction(fn){
        const p=this.queue.then(async()=>{const before=structuredClone(this.data);try{return await fn(this)}catch(e){this.data=before;throw e}});
        this.queue=p.catch(()=>{});return p;
    }
}
const config=keyoConfig(testEnv),DAY=86400000,HOUR=3600000;
function keyoHarness(env={}) {
    const storage=new Storage();seedUnitAccounts(storage);
    const gateway=new ProGateway(unitParent(storage,{...testEnv,...env})),calls=[];
    const before=globalThis.fetch;
    let reply=async({body})=>Response.json({entitlement:await signedToken(body.accountId)});
    globalThis.fetch=async(url,options)=>{
        // Match the Workers runtime constraint that Node's fetch does not enforce.
        if(options.redirect==='error')throw new TypeError('Invalid redirect value');
        const call={url:new URL(url),options,body:JSON.parse(options.body)};calls.push(call);return reply(call);
    };
    const route=async(path='/pro/activate',body={key:'A1B2-C3D4-E5F6-G7H8'},account='user_A')=>{
        const method=path==='/pro/status'?'GET':'POST';
        const r=await gateway.handleRequest(new Request('https://worker.test'+path,{method,...(method==='POST'?{body:JSON.stringify(body)}:{})}),path,method,{userId:account,sessionId:'session_A'},{});
        return {status:r.status,body:await r.json()};
    };
    return {storage,gateway,calls,route,reply:fn=>{reply=fn},restore:()=>{globalThis.fetch=before}};
}
async function withKeyoHarness(fn,env){const h=keyoHarness(env);try{await fn(h)}finally{h.restore()}}
const licenseKey='pro:entitlement:user_A';

test('configured public SDK settings are valid and malformed/empty overrides fail closed',async()=>{
    assert.equal(keyoConfig().endpoint,'https://keyo.mazendev.com');
    assert.equal(keyoConfig().projectId,KEYO_DEFAULTS.projectId);
    await crypto.subtle.importKey('jwk',KEYO_DEFAULTS.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    for(const env of [{KEYO_API_ORIGIN:''},{KEYO_API_ORIGIN:'http://keyo.test'},
        {KEYO_API_ORIGIN:'https://user:pass@keyo.test'},{KEYO_API_ORIGIN:'https://keyo.test/path'},
        {KEYO_PROJECT_ID:''},{KEYO_PUBLIC_JWK:''},{KEYO_PUBLIC_JWK:'{}'},
        {KEYO_PUBLIC_JWK:{...testPublicKey,d:'private'}}])assert.throws(()=>keyoConfig(env),{code:'KEYO_SETUP_REQUIRED'});
});

test('real ES256 tokens enforce signature, header, account, project, IDs, tier and deadlines',async()=>{
    const valid=await signedToken('user_A');
    assert.equal((await verifyKeyoToken(valid,'user_A',config)).tier,'PRO');
    assert.equal((await verifyKeyoToken(await signedToken('user_A',{expiresAt:null,tier:'MAX'}),'user_A',config)).expiresAt,null);
    const now=Date.now();
    for(const overrides of [{accountId:'user_B'},{projectId:'prj_other'},{v:2},{keyId:''},{keyId:7},{bindingId:''},
        {tier:'FREE'},{tier:'owner'},{tier:3},{issuedAt:now+61000,validUntil:now+DAY},
        {issuedAt:-1},{issuedAt:now+.5},{validUntil:now+DAY+60000},{validUntil:now},
        {expiresAt:now-1},{expiresAt:undefined},{expiresAt:'2099-01-01'},{expiresAt:now+500}]) {
        const token=await signedToken('user_A',overrides);
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config),undefined,JSON.stringify(overrides));
    }
    for(const header of [{alg:'none',typ:'KEYO'},{alg:'HS256',typ:'KEYO'},{alg:'ES256',typ:'JWT'}]) {
        const token=await signedToken('user_A',{},header);
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config));
    }
    const parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({tier:'MAX'})).toString('base64url');
    for(const token of [parts.join('.'),'a.b.c','anything','x'.repeat(4097),null])
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config));
    const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const otherPublicKey=await crypto.subtle.exportKey('jwk',other.publicKey);
    await assert.rejects(()=>verifyKeyoToken(valid,'user_A',{...config,publicKey:otherPublicKey}));
});

test('activation uses Keyo API with signed-in account, strips formatting and preserves balances and BYOK',async()=>withKeyoHarness(async h=>{
    const existing=await activeLicense('user_A');existing.use_byok=true;existing.activated_at=123;
    await h.storage.put(licenseKey,existing);await h.storage.put('pro:usage:user_A:month:2026-10',12.375);
    const r=await h.route();assert.equal(r.status,200);assert.equal(r.body.isPro,true);
    assert.equal(r.body.credits_daily_limit,45);assert.equal(r.body.credits_monthly_limit,1000);
    assert.equal(h.calls[0].url.origin,KEYO_DEFAULTS.endpoint);
    assert.equal(h.calls[0].url.pathname,'/api/v1/activate');
    assert.equal(h.calls[0].url.searchParams.get('projectId'),KEYO_DEFAULTS.projectId);
    assert.deepEqual(h.calls[0].body,{accountId:'user_A',key:'A1B2C3D4E5F6G7H8'});
    assert.equal(h.calls[0].options.redirect,'manual');
    const saved=await h.storage.get(licenseKey);assert.equal(saved.keyo_version,1);assert.equal(saved.use_byok,true);assert.equal(saved.activated_at,123);
    assert.equal(await h.storage.get('pro:usage:user_A:month:2026-10'),12.375);
    assert.equal(saved.key,undefined);assert.equal(saved.license_key,undefined);
    assert.ok(!JSON.stringify([...h.storage.data]).includes('A1B2C3D4E5F6G7H8'));
    const status=await h.route('/pro/status');assert.equal(status.body.isPro,true);assert.equal(h.calls.length,1);
}));

test('fabricated keys, setup errors, provider denial, missing responses and bad signatures never grant Pro',async()=>{
    await withKeyoHarness(async h=>{
        for(const key of ['DEMOONLY00000001','arbitrary-long-string','abc']) {
            h.reply(async()=>Response.json({error:'KEY_UNAVAILABLE'},{status:403}));
            const r=await h.route('/pro/activate',{key});assert.notEqual(r.status,200);
            assert.equal(await h.storage.get(licenseKey),undefined);
        }
        for(const data of [{},{entitlement:'abc.def.ghi'},{entitlement:42},
            {entitlement:await signedToken('user_B')},{entitlement:await signedToken('user_A',{tier:'FREE'})}]) {
            h.reply(async()=>Response.json(data));assert.notEqual((await h.route()).status,200);
            assert.equal(await h.storage.get(licenseKey),undefined);
        }
        h.reply(async()=>{throw Error('offline')});assert.equal((await h.route()).status,503);
    });
    await withKeyoHarness(async h=>{assert.equal((await h.route()).body.code,'KEYO_SETUP_REQUIRED');assert.equal(h.calls.length,0)}, {KEYO_PROJECT_ID:''});
});

test('unsigned old bypass grants are blocked for status, toggles, quotes and paid audit requests',async()=>withKeyoHarness(async h=>{
    await h.storage.put(licenseKey,{status:'active',tier:'pro',expires_at:Date.now()+DAY});
    assert.equal((await h.route('/pro/status')).body.isPro,false);
    assert.equal((await h.route('/pro/byok',{use_byok:true})).status,403);
    for(const path of ['/pro/ai/quote','/pro/ai/review','/pro/ai/batch-review']) {
        const r=await h.route(path,{operation_id:'operation_123',task_id:'t',criteria:'Completed',
            tasks:[{id:'t',criteria:'Completed'}],files:[{mime_type:'image/png',data:'YWJj'}]});
        assert.equal(r.status,403);assert.equal(r.body.code,'PRO_REQUIRED');
    }
    assert.equal(h.calls.length,0);
}));

test('previous signed entitlements require online verification before migration',async()=>withKeyoHarness(async h=>{
    const old=await activeLicense('user_A');delete old.keyo_version;
    await h.storage.put(licenseKey,old);
    const r=await h.route('/pro/status');assert.equal(r.body.isPro,true);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].url.pathname,'/api/v1/verify');
    assert.equal(h.calls[0].body.entitlement,old.signed_token);
    assert.equal((await h.storage.get(licenseKey)).keyo_version,1);
}));

test('old signed tokens cannot migrate during a Keyo outage; tampered and wrong-account caches are rejected',async()=>withKeyoHarness(async h=>{
    const old=await activeLicense('user_A');delete old.keyo_version;
    await h.storage.put(licenseKey,old);h.reply(async()=>{throw Error('offline')});
    assert.equal((await h.route('/pro/status')).status,503);
    await h.storage.put(licenseKey,await activeLicense('user_B'));
    assert.equal((await h.route('/pro/status')).body.isPro,false);
    assert.equal((await h.storage.get(licenseKey)).status,'invalid');
}));

test('hourly refresh rejects revocation, suspension, deletion, expiry and binding reassignment',async()=>{
    for(const code of ['REVOKED','SUSPENDED','DELETED','EXPIRED','INVALID_PROJECT'])await withKeyoHarness(async h=>{
        await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
        h.reply(async()=>Response.json({error:code},{status:403}));
        const r=await h.route('/pro/status');assert.equal(r.body.isPro,false,code);
        assert.equal((await h.route('/pro/byok',{use_byok:true})).status,403);
    });
    await withKeyoHarness(async h=>{
        await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
        h.reply(async()=>Response.json({entitlement:await signedToken('user_A',{bindingId:'other-binding'})}));
        assert.equal((await h.route('/pro/status')).body.isPro,false);
    });
});

test('network fallback lasts only until the signed cache deadline; expired tokens can recover online',async()=>withKeyoHarness(async h=>{
    const now=Date.now();
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:now-HOUR-1000,validUntil:now+HOUR}));
    h.reply(async()=>{throw Error('offline')});
    assert.equal((await h.route('/pro/status')).body.isPro,true);
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:now-DAY,validUntil:now-1}));
    assert.equal((await h.route('/pro/status')).status,503);
    h.reply(async({body})=>Response.json({entitlement:await signedToken(body.accountId)}));
    assert.equal((await h.route('/pro/status')).body.isPro,true);
    assert.equal((await h.storage.get(licenseKey)).status,'active');
}));

test('lifetime licenses keep a null expiry and renew their short verification window',async()=>withKeyoHarness(async h=>{
    h.reply(async()=>Response.json({entitlement:await signedToken('user_A',{expiresAt:null})}));
    assert.equal((await h.route()).body.expires_at,null);
    const status=await h.route('/pro/status');assert.equal(status.body.isPro,true);assert.equal(status.body.expires_at,null);
}));

test('Keyo reassignment is authoritative even when a stale local fingerprint names another account',async()=>withKeyoHarness(async h=>{
    const normalized='A1B2C3D4E5F6G7H8';
    const fp=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized))).toString('hex');
    await h.storage.put('pro:binding:'+fp,{account_id:'old_owner'});
    assert.equal((await h.route()).status,200);
}));

test('late refresh cannot resurrect a deleted account',async()=>withKeyoHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    let release,entered;
    const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.reply(async({body})=>{entered();await gate;return Response.json({entitlement:await signedToken(body.accountId)})});
    const refreshing=h.route('/pro/status');await started;
    h.storage.data.delete(licenseKey);release();
    assert.equal((await refreshing).body.isPro,false);assert.equal(await h.storage.get(licenseKey),undefined);
}));

test('parallel status requests share one refresh and a late response preserves a replacement license',async()=>withKeyoHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    let release,entered;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.reply(async({body})=>{entered();await gate;return Response.json({entitlement:await signedToken(body.accountId)})});
    const requests=[h.route('/pro/status'),h.route('/pro/status')];await started;
    const replacement=await activeLicense('user_A',{keyId:'replacement-key',bindingId:'replacement-binding',tier:'MAX'});
    await h.storage.put(licenseKey,replacement);release();
    const results=await Promise.all(requests);assert.ok(results.every(r=>r.body.isPro));assert.equal(h.calls.length,1);
    assert.equal((await h.storage.get(licenseKey)).signed_token,replacement.signed_token);
}));

test('invalid refreshed signatures cannot use the outage fallback',async()=>withKeyoHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    h.reply(async()=>Response.json({entitlement:'bad.signature.here'}));
    assert.equal((await h.route('/pro/status')).body.isPro,false);
}));

test('cached access does not extend or refresh signed deadlines during temporary failure',async()=>withKeyoHarness(async h=>{
    const old=await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR});
    old.last_verified_at=Date.now()-HOUR;
    await h.storage.put(licenseKey,old);h.reply(async()=>{throw Error('offline')});
    const resolved=await h.gateway.licenses.resolve('user_A');
    assert.equal(resolved.last_verified_at,old.last_verified_at);assert.equal(resolved.valid_until,old.valid_until);
    assert.deepEqual(await h.storage.get(licenseKey),old);
}));


test('revocation after a price preview prevents a paid hosted provider call',async()=>withKeyoHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    h.reply(async()=>Response.json({error:'REVOKED'},{status:403}));
    const r=await h.route('/pro/ai/review',{operation_id:'existing_quote_operation',quote_id:'previous_preview',task_id:'t',criteria:'Completed',files:[{mime_type:'image/png',data:'YWJj'}]});
    assert.equal(r.status,403);assert.equal(r.body.code,'PRO_REQUIRED');assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].url.pathname,'/api/v1/verify');
}));

// File: pro/pro.test.js
// Unit & Integration Tests for Taskitator Pro Phase 2 Backend

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: crypto.webcrypto, configurable: true });


class ProMockStorage {
    constructor() {
        this.data = new Map();
        this.queue = Promise.resolve();
    }
    async get(key) {
        if (Array.isArray(key)) {
            const res = new Map();
            for (const k of key) if (this.data.has(k)) res.set(k, this.data.get(k));
            return res;
        }
        return this.data.has(key) ? JSON.parse(JSON.stringify(this.data.get(key))) : undefined;
    }
    async put(key, val) {
        this.data.set(key, JSON.parse(JSON.stringify(val)));
    }
    async delete(key) {
        if (Array.isArray(key)) key.forEach(k => this.data.delete(k));
        else this.data.delete(key);
    }
    async transaction(closure) {
        const next = this.queue.then(() => closure(this));
        this.queue = next.catch(() => {});
        return await next;
    }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.startsWith('https://keyo.mazendev.com/api/v1/')) {
        const {accountId}=JSON.parse(opts.body);
        return Response.json({entitlement:await signedToken(accountId)});
    }
    if (urlStr.includes('api.anthropic.com/v1/messages')) {
        const body = JSON.parse(opts?.body || '{}');
        const text = body.messages?.[0]?.content?.[0]?.text || '';
        if (text.includes('BATCH AUDIT REQUEST:')) {
            return new Response(JSON.stringify({
                content: [{
                    type: 'text',
                    text: JSON.stringify([
                        { task_id: 'task_1', status: 'eligible', verdict: 'approved', reason: 'Evidence satisfies criteria.' },
                        { task_id: 'task_2', status: 'rejected', verdict: 'rejected', reason: 'Evidence does not demonstrate requirements.' }
                    ])
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    verdict: 'approved',
                    confidence: 0.98,
                    critique: 'Evidence verified via Claude Haiku 5.5 against task criteria.'
                })
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch ? originalFetch(url, opts) : new Response('{}', { status: 200 });
};

function createHarness(envOverrides = {}) {
    const storage = new ProMockStorage();
    const env = {
        ALLOWED_ORIGINS: 'https://taskitator.mazendev.com',
        CLAUDE_API_KEY: 'mock_claude_api_key_test',
        ...testEnv,
        ...envOverrides
    };
    seedUnitAccounts(storage,['u_pro','u_owner1','u_owner2']);
    const parent = unitParent(storage,env);
    const pro = new ProGateway(parent);
    return { pro, storage, env };
}

function makeReq(path, method = 'GET', body = null) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);
    return new Request(`https://worker.local${path}`, opts);
}

test('Phase 2: Unactivated account returns Free tier with zero credits', async () => {
    const { pro } = createHarness();
    const res = await pro.handleRequest(makeReq('/pro/status'), '/pro/status', 'GET', { userId: 'u_free' }, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.isPro, false);
    assert.equal(data.tier, 'free');
    assert.equal(data.credits.daily_limit, 0);
});

test('Phase 2: Keyo activation elevates account to Pro with 45 daily and 1,000 monthly credits', async () => {
    const { pro } = createHarness();
    const actRes = await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2-C3D4-E5F6-G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_pro' }, {}
    );
    assert.equal(actRes.status, 200);
    const actData = await actRes.json();
    assert.equal(actData.isPro, true);
    assert.equal(actData.credits_daily_limit, 45);
    assert.equal(actData.credits_monthly_limit, 1000);

    const stRes = await pro.handleRequest(makeReq('/pro/status'), '/pro/status', 'GET', { userId: 'u_pro' }, {});
    const stData = await stRes.json();
    assert.equal(stData.isPro, true);
    assert.equal(stData.credits.daily_limit, 45);
    assert.equal(stData.credits.daily_remaining, 45);
    assert.equal(stData.credits.monthly_limit, 1000);
    assert.equal(stData.credits.monthly_remaining, 1000);
});

test('Phase 2: Keyo account limits reject cross-account key theft', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'KEY1-KEY2-KEY3-KEY4' }),
        '/pro/activate', 'POST', { userId: 'u_owner1' }, {}
    );
    const before=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({error:'KEY_UNAVAILABLE'},{status:403});
    try {
        const stealRes = await pro.handleRequest(
            makeReq('/pro/activate', 'POST', { key: 'KEY1-KEY2-KEY3-KEY4' }),
            '/pro/activate', 'POST', { userId: 'u_owner2' }, {}
        );
        assert.equal(stealRes.status, 403);
    } finally { globalThis.fetch=before; }
});

test('Phase 2.5: Username validation accepts alphanumeric and underscores (3-20 chars) and rejects invalid formats', async () => {
    const { pro } = createHarness();
    // Too short (2 chars)
    let res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'ab' }), '/pro/username', 'POST', { userId: 'u_1' }, {});
    assert.equal(res.status, 400);

    // Too long (21 chars)
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'a'.repeat(21) }), '/pro/username', 'POST', { userId: 'u_1' }, {});
    assert.equal(res.status, 400);

    // Special characters rejected
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'bad-user!' }), '/pro/username', 'POST', { userId: 'u_1' }, {});
    assert.equal(res.status, 400);

    // Reserved username rejected
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'admin' }), '/pro/username', 'POST', { userId: 'u_1' }, {});
    assert.equal(res.status, 400);

    // Valid username accepted
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'alex_99' }), '/pro/username', 'POST', { userId: 'u_1' }, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.username, 'alex_99');
});

test('Phase 2.5: Unique username registration binds handle and prevents collisions with 409', async () => {
    const { pro } = createHarness();
    // User 1 claims 'stellar_dev'
    let res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'stellar_dev' }), '/pro/username', 'POST', { userId: 'u_user1' }, {});
    assert.equal(res.status, 200);

    // User 2 attempts to claim 'stellar_dev' (exact match)
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'stellar_dev' }), '/pro/username', 'POST', { userId: 'u_user2' }, {});
    assert.equal(res.status, 409);

    // User 2 attempts to claim 'STELLAR_DEV' (case-insensitive collision)
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'STELLAR_DEV' }), '/pro/username', 'POST', { userId: 'u_user2' }, {});
    assert.equal(res.status, 409);
});

test('Phase 2.5: Updating username frees previous handle and binds new handle', async () => {
    const { pro } = createHarness();
    // User claims 'handle_one'
    await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'handle_one' }), '/pro/username', 'POST', { userId: 'u_switcher' }, {});

    // User changes handle to 'handle_two'
    let res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'handle_two' }), '/pro/username', 'POST', { userId: 'u_switcher' }, {});
    assert.equal(res.status, 200);

    // Another user can now claim the freed 'handle_one'
    res = await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'handle_one' }), '/pro/username', 'POST', { userId: 'u_other' }, {});
    assert.equal(res.status, 200);
});

test('Phase 2.5: Availability check returns true for available handles and false for taken/reserved handles', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'taken_user' }), '/pro/username', 'POST', { userId: 'u_owner' }, {});

    // Check available handle
    let res = await pro.handleRequest(makeReq('/pro/username/check?username=fresh_handle'), '/pro/username/check', 'GET', { userId: 'u_any' }, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).available, true);

    // Check taken handle
    res = await pro.handleRequest(makeReq('/pro/username/check?username=taken_user'), '/pro/username/check', 'GET', { userId: 'u_any' }, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).available, false);

    // Check same handle for owner (available for own update)
    res = await pro.handleRequest(makeReq('/pro/username/check?username=taken_user'), '/pro/username/check', 'GET', { userId: 'u_owner' }, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).available, true);
});

test('Phase 2.5: Profile endpoint exposes username and Pro status, but never user email (Universe privacy)', async () => {
    const { pro, storage } = createHarness();
    await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'private_user' }), '/pro/username', 'POST', { userId: 'u_priv' }, {});
    await storage.put('identity:u_priv', { user: 'clerk:priv', display_name: 'secret@private.com', user_id: 'u_priv' });

    const profRes = await pro.handleRequest(makeReq('/pro/username/profile'), '/pro/username/profile', 'GET', { userId: 'u_priv' }, {});
    assert.equal(profRes.status, 200);
    const profData = await profRes.json();
    assert.equal(profData.username, 'private_user');
    assert.equal(profData.isPro, false);
    // Strict privacy guarantee: email is NEVER exposed in the member profile
    assert.equal(profData.email, undefined);
    assert.equal(JSON.stringify(profData).includes('secret@private.com'), false);
});


test('case variants claimed concurrently have exactly one winner, with no metadata fallback',async()=>{
    const {pro,storage}=createHarness();
    const results=await Promise.all(['Mazen','mazen','MAZEN'].map((username,i)=>pro.setUsername('user_'+i,{username})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409,409]);
    const profiles=await Promise.all([0,1,2].map(async i=>(await pro.getUsernameProfile('user_'+i)).json()));
    assert.equal(profiles.filter(p=>p.username).length,1);
    const owner=await storage.get('pro:username:map:mazen');
    assert.equal(owner.accountId,'user_0');
    await storage.put('pro:user:username:other',{username:'Mazen',normalizedUsername:'mazen'});
    assert.equal((await (await pro.getUsernameProfile('other')).json()).username,null);
    await pro.setUsername('other',{username:'UniqueName'});
    assert.equal((await storage.get('pro:username:map:mazen')).accountId,'user_0');
});
test('case-only rename preserves the claim and public resolution exposes no email or account existence',async()=>{
    const {pro,storage}=createHarness();
    await pro.setUsername('user_A',{username:'Mazen'});
    assert.equal((await pro.setUsername('user_A',{username:'MAZEN'})).status,200);
    await storage.put('identity:user_A',{display_name:'private@example.com'});
    const existing=await pro.resolveUsername({username:'mazen'}), missing=await pro.resolveUsername({username:'unknown'});
    assert.equal(existing.status,410);assert.equal(missing.status,410);
    assert.equal(JSON.stringify(await existing.json()).includes('private@example.com'),false);
});

const root = new URL('./', import.meta.url);
const profSource = readConsolidatedSource('pro/profile-ui.js');
function profile({username=null,metadata={},fail=false}={}) {
    const nodes=new Map(),events=new Map(),requests=[];
    class Node {
        constructor(){this.events=new Map();this.value='';this.disabled=false;this.textContent='';}
        setAttribute(){}
        addEventListener(name,fn){this.events.set(name,fn)}
        querySelector(selector){if(!nodes.has(selector.slice(1)))nodes.set(selector.slice(1),new Node());return nodes.get(selector.slice(1))}
        showModal(){this.open=true}
        close(){this.open=false;this.events.get('close')?.()}
        remove(){nodes.delete(this.id)}
        focus(){this.focused=true}
    }
    const button=new Node();nodes.set('accountUsernameBtn',button);
    const user={id:'user_A',username:'UntrustedClerkName',unsafeMetadata:metadata};
    const api={async getUsernameProfile(){return {username}},async setUsername(name){
        requests.push(name);if(fail)throw new Error('Username is already taken. Choose another name.');
        username=name;return {username};
    }};
    const window={Clerk:{user,session:{id:'sess_A'}},TaskitatorPro:api,addEventListener(name,fn){events.set(name,fn)}};
    const document={getElementById:id=>nodes.get(id)||null,createElement:()=>new Node(),body:{appendChild(node){nodes.set(node.id,node)}}};
    vm.runInContext(profSource,vm.createContext({window,document}));
    events.get('taskitator-auth-ready')();
    return {window,nodes,events,requests,button,user,api,
        ready:()=>window.TaskitatorProfile.refresh(),
        open(){button.events.get('click')()},
        submit(){return nodes.get('taskitatorUsernameForm').events.get('submit')({preventDefault(){}})}};
}

test('username editor claims the server registry and displays it on both devices',async()=>{
    const f=profile();await f.ready();assert.equal(f.button.textContent,'Set username');f.open();
    f.nodes.get('taskitatorUsernameInput').value='Hogkla';await f.submit();
    assert.deepEqual(f.requests,['Hogkla']);assert.equal(f.button.textContent,'@Hogkla');
    assert.equal(f.nodes.has('taskitatorUsernameDialog'),false);
    const second=profile({username:'Hogkla'});await second.ready();assert.equal(second.button.textContent,'@Hogkla');
});
test('unclaimed Clerk metadata never masquerades as a unique username',async()=>{
    const f=profile({metadata:{taskitator_username:'DuplicateName'}});await f.ready();
    assert.equal(f.button.textContent,'Set username');assert.equal(f.user.username,'UntrustedClerkName');
});
test('cancel and X close the username editor without a write',()=>{
    for(const id of ['usernameCancelBtn','usernameCloseBtn']){
        const f=profile();f.open();f.nodes.get(id).events.get('click')();
        assert.equal(f.nodes.has('taskitatorUsernameDialog'),false);assert.equal(f.requests.length,0);
    }
});
test('invalid or duplicate username keeps the dialog retryable and the last confirmed name',async()=>{
    const f=profile({username:'OldName',fail:true});await f.ready();f.open();
    f.nodes.get('taskitatorUsernameInput').value='bad.name';await f.submit();assert.equal(f.requests.length,0);
    f.nodes.get('taskitatorUsernameInput').value='TakenName';await f.submit();
    assert.equal(f.button.textContent,'@OldName');assert.match(f.nodes.get('usernameFeedback').textContent,/already taken/);
    assert.equal(f.nodes.get('usernameCancelBtn').disabled,false);assert.equal(f.nodes.get('usernameSaveBtn').disabled,false);
});
test('session changes during a save or refresh cannot paint the previous account name',async()=>{
    const f=profile();await f.ready();f.open();let finish;
    f.api.setUsername=()=>new Promise(resolve=>{finish=resolve});
    f.nodes.get('taskitatorUsernameInput').value='OtherName';const pending=f.submit();
    f.window.Clerk.session={id:'sess_B'};finish({username:'OtherName'});await pending;
    assert.equal(f.button.textContent,'Set username');assert.match(f.nodes.get('usernameFeedback').textContent,/account changed/);
    let resolveProfile;f.api.getUsernameProfile=()=>new Promise(resolve=>{resolveProfile=resolve});
    const refresh=f.ready();f.window.Clerk.user.id='user_B';resolveProfile({username:'OldAccount'});await refresh;
    assert.notEqual(f.button.textContent,'@OldAccount');
});

test('service worker refreshes Pro scripts and styles before using cached copies',async()=>{
    const handlers=new Map(),calls=[],pending=[];
    const cache={async match(){calls.push('cache-match');return new Response('cached-ui')},async put(){calls.push('cache-put')}};
    const self={location:{origin:'https://taskitator.test'},addEventListener(name,fn){handlers.set(name,fn)}};
    const context=vm.createContext({self,URL,Request,Response,caches:{async open(){return cache}},fetch:async(request,options)=>{
        calls.push('fetch:'+options.cache);return new Response('fresh-ui');
    }});
    vm.runInContext(readConsolidatedSource('sw.js'),context);
    for(const path of ['/pro/pro-ui.js','/style.css','/pro/profile-ui.js']){
        let response;
        handlers.get('fetch')({request:new Request('https://taskitator.test'+path),respondWith(value){response=value},waitUntil(value){pending.push(value)}});
        assert.equal(await (await response).text(),'fresh-ui');
    }
    await Promise.all(pending);assert.equal(calls.includes('cache-match'),false);
    assert.equal(calls.filter(call=>call==='fetch:no-cache').length,3);
    // An actual network failure can fall back only to this release's cache.
    context.fetch=async()=>{throw new Error('offline')};let response;
    handlers.get('fetch')({request:new Request('https://taskitator.test/pro/pro-ui.js'),respondWith(value){response=value},waitUntil(){}});
    assert.equal(await (await response).text(),'cached-ui');
    let intercepted=false;
    handlers.get('fetch')({request:new Request('https://taskitator.test/auth/account'),respondWith(){intercepted=true}});
    assert.equal(intercepted,false);
});
test('Pro UI and username scripts wait for authenticated cache activation',()=>{
    for(const file of ['index.html','settings.html']){
        const html=readConsolidatedSource(file);
        assert.match(html,/<script type="text\/taskitator-script" src="pro\.js"><\/script>/);
        assert.doesNotMatch(html,/<script defer src="pro\.js"/);
    }
    const bootstrap=readConsolidatedSource('auth-bootstrap.js');
    assert.ok(bootstrap.indexOf('location.reload()')<bootstrap.indexOf('await TaskitatorAuth.init()'));
    assert.ok(!bootstrap.includes('TaskitatorAuth.manageAccount()'));
});

const secCliSource=n=>readConsolidatedSource(n);
function client(){
    const data=new Map([['taskitator_local_revision','revision_1'],['taskitator_tasks','[{"id":"t","status":"active","ai_locked":true}]']]);
    const localStorage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v))};
    const events=[];const window={Clerk:{session:{id:'sess_A'}},ProUI:{confirmReviewQuote:async()=>true},CustomEvent:class{constructor(type){this.type=type}},dispatchEvent:event=>events.push(event.type)};
    const context=vm.createContext({window,localStorage,crypto:crypto.webcrypto,TextEncoder,Uint8Array,console});
    vm.runInContext(secCliSource('pro/pro-client.js'),context);return {data,events,localStorage,window,context,pro:window.TaskitatorPro};
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
    vm.runInContext(secCliSource('audit-engine.js'),f.context);
    const result=await f.window.TaskitatorEngine.AuditEngine.verifyProof({taskId:'t',file:{size:1,type:'image/png'}});
    assert.equal(result.success,false);assert.equal(result.status,503);assert.equal(personalCalls,0);
});


test('UI layout: bonus task toggle is below subtask shield in creation and edit modals', () => {
    const html = readConsolidatedSource('index.html');
    
    // Check Creation Modal
    const prereqCreateIdx = html.indexOf('id="prerequisiteBoxContainer"');
    const bonusCreateIdx = html.indexOf('id="bonusTaskContainer"');
    assert.ok(prereqCreateIdx > 0, 'prerequisiteBoxContainer must exist');
    assert.ok(bonusCreateIdx > 0, 'bonusTaskContainer must exist');
    assert.ok(bonusCreateIdx > prereqCreateIdx, 'bonusTaskContainer must be below prerequisiteBoxContainer in creation modal');

    // Check Details / Edit Modal
    const prereqEditIdx = html.indexOf('id="editPrerequisiteBoxContainer"');
    const bonusEditIdx = html.indexOf('id="editBonusTaskContainer"');
    assert.ok(prereqEditIdx > 0, 'editPrerequisiteBoxContainer must exist');
    assert.ok(bonusEditIdx > 0, 'editBonusTaskContainer must exist');
    assert.ok(bonusEditIdx > prereqEditIdx, 'editBonusTaskContainer must be below editPrerequisiteBoxContainer in edit modal');
});

test('UI elements: AI audit checkbox has info trigger button with token warning and no pre-audit discount mention', () => {
    const html = readConsolidatedSource('index.html');
    assert.ok(html.includes('id="createAiAuditInfoBtn"'), 'createAiAuditInfoBtn must exist');
    assert.ok(html.includes('id="editAiAuditInfoBtn"'), 'editAiAuditInfoBtn must exist');
    assert.ok(html.includes('id="createAiAuditInfoBox"'), 'createAiAuditInfoBox must exist');
    assert.ok(html.includes('id="editAiAuditInfoBox"'), 'editAiAuditInfoBox must exist');

    // Warning text must warn about token consumption and no refund on rejection
    assert.match(html, /Submitting proof consumes your AI usage/);
    assert.match(html, /rejected because it fails the task criteria or is invalid, token usage is still calculated and consumed/);
    assert.match(html, /no refunds are issued/);

    // Crucial requirement: Must NOT mention 50% discount pre-audit
    const createBox = html.slice(html.indexOf('id="createAiAuditInfoBox"'), html.indexOf('id="createAiAuditInfoBox"') + 500);
    assert.doesNotMatch(createBox, /50%|discount/i, 'Pre-audit warning must not disclose the 50% discount');
});

test('Settings Pro block: specified Hosted Personal AI phrase is removed', () => {
    const proUi = readConsolidatedSource('pro/pro-ui.js');
    assert.ok(!proUi.includes('Hosted Personal AI: Pro accounts receive automated single, multi-file, and batch proof audits powered by personal'),
        'The specified Hosted Personal AI phrase must be removed from pro-ui.js');
});

test('Settings Pro block: How credits work is a roll-down details menu closed by default', () => {
    const proUi = readConsolidatedSource('pro/pro-ui.js');
    assert.ok(proUi.includes('<details class="pro-credit-help" id="pro-credit-help-details">'),
        'How credits work must be a <details> element');
    assert.ok(!proUi.includes('<details class="pro-credit-help" id="pro-credit-help-details" open>'),
        'How credits work must be closed by default');
    assert.ok(proUi.includes('Document Pages (Page Count):'), 'Must explain page count system');
    assert.ok(proUi.includes('Photo Resolution (Image Size):'), 'Must explain photo resolution system');
});

test('Vault: API key connection test displays green/red popup box', () => {
    const vaultClient = readConsolidatedSource('vault-client.js');
    assert.ok(vaultClient.includes('vault-test-popup'), 'vault-client.js must apply vault-test-popup class');
    assert.ok(vaultClient.includes('showTestPopup') || vaultClient.includes('isTest'), 'vault-client.js must distinguish test status');

    const styleCss = readConsolidatedSource('style.css');
    assert.ok(styleCss.includes('.vault-test-popup.success'), 'style.css must include success popup style');
    assert.ok(styleCss.includes('.vault-test-popup.error'), 'style.css must include error popup style');
});


test('Tri-State Token Policy: incomplete verdict applies 50% discount for Pro and 0 charge when < 1 token', () => {
    assert.equal(calculateAuditCharge(1.2, 'incomplete'), 0);
    assert.equal(calculateAuditCharge(2.0, 'incomplete'), 1.0);
    assert.equal(calculateAuditCharge(3.0, 'incomplete'), 1.5);
    assert.equal(calculateAuditCharge(1.5, 'rejected'), 1.5);
    assert.equal(calculateAuditCharge(1.5, 'approved'), 1.5);
});



// ============================================================================
// SECTION 7: CONSOLIDATION REGRESSIONS & PHASE 3 PRE-RELEASE VERIFICATION
// ============================================================================

test("CSP policies allow clerk.mazendev.com and all inline HTML scripts compile cleanly without syntax errors", () => {
    for (const page of ["index.html", "components.html", "settings.html", "login.html"]) {
        const html = readConsolidatedSource(page);
        const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] || "";
        assert.ok(csp.includes("https://*.mazendev.com"), page + " CSP must allow clerk.mazendev.com via https://*.mazendev.com");
        assert.ok(csp.includes("https://*.clerk.accounts.com"), page + " CSP must allow https://*.clerk.accounts.com");
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
            if (/\bsrc=/.test(match[1]) || !match[2].trim()) continue;
            assert.doesNotThrow(() => new vm.Script(match[2]), page + " inline script must compile without SyntaxError");
        }
    }
});

test("Review cost preview dialog displays 1-decimal summary, 3-decimal expandable details, and enforces Cancel vs Start review", async () => {
    const f = client();
    const appended = [];
    f.context.document = {
        readyState: "complete",
        getElementById: (id) => appended.find(el => el.id === id) || null,
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            innerHTML: "",
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            remove() {
                const idx = appended.indexOf(this);
                if (idx !== -1) appended.splice(idx, 1);
            },
            querySelector(sel) {
                return this._buttons?.[sel] || null;
            }
        }),
        body: {
            appendChild(el) {
                el._buttons = {};
                for (const id of ["#proQuoteCancelBtn", "#proQuoteCloseBtn", "#proQuoteStartBtn"]) {
                    el._buttons[id] = {
                        listeners: {},
                        addEventListener(ev, fn) { this.listeners[ev] = fn; },
                        click() { this.listeners.click?.(); }
                    };
                }
                appended.push(el);
            }
        },
        addEventListener() {}
    };
    f.window.addEventListener = () => {};
    f.window.document = f.context.document;
    vm.runInContext(readConsolidatedSource("pro/pro-ui.js"), f.context);

    // 1. Test Cancellation
    const quoteCalls = [];
    f.pro.prepareAudit = async () => {};
    f.pro.request = async (path, opts) => {
        quoteCalls.push({ path, body: JSON.parse(opts.body) });
        if (path === "/pro/ai/quote") {
            return {
                quote_id: "q_dialog_1",
                estimated_credits: 0.376,
                maximum_credits: 1.542,
                tasks: [
                    { task_id: "t1", credits: 1.028, exemplar: true },
                    { task_id: "t2", credits: 0.514, exemplar: false }
                ]
            };
        }
        return { verdict: "approved", job_id: "job_1" };
    };

    f.pro.getStatus=async()=>({isPro:true,status:'active',use_byok:false});
    const pendingCancel = f.pro.batchReview({
        tasks: [
            { id: "t1", title: "Calculus Problem Set", criteria: "Show all steps" },
            { id: "t2", title: "Physics Lab Report", criteria: "Include graph" }
        ],
        files: [{ mime_type: "image/png", data: "YWJj" }],
        
    });

    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const check = () => appended.length ? resolve() : Date.now() >= deadline
            ? reject(new Error('Review dialog did not mount')) : setTimeout(check, 1);
        check();
    });
    assert.equal(appended.length, 1, "Review cost dialog must be mounted");
    const dialogHtml = appended[0].innerHTML;
    // Summary shows 1 decimal place
    assert.match(dialogHtml, /0\.4 credits/, "Estimated charge must round to 1 decimal place (0.4)");
    assert.match(dialogHtml, /1\.5 credits/, "Maximum hold must round to 1 decimal place (1.5)");
    // Expandable View details section shows 3 decimal places, reference multiplier, and batch discount
    assert.match(dialogHtml, /<details class="pro-quote-details" id="proQuoteDetailsToggle">/);
    assert.match(dialogHtml, /View details/);
    assert.match(dialogHtml, /0\.376 credits/);
    assert.match(dialogHtml, /1\.542 credits/);
    assert.match(dialogHtml, /Calculus Problem Set[\s\S]*1\.028 credits[\s\S]*reference comparison: ×2 charge/);
    assert.match(dialogHtml, /Physics Lab Report[\s\S]*0\.514 credits/);
    assert.match(dialogHtml, /25% batch discount/);
    assert.match(dialogHtml, /Unused held credits return/);
    assert.match(dialogHtml, /charged even when proof is rejected/);

    // Click Cancel -> rejects with AUDIT_CANCELLED and makes no /pro/ai/batch-review call
    appended[0].querySelector("#proQuoteCancelBtn").click();
    await assert.rejects(pendingCancel, /Audit cancelled/);
    assert.equal(quoteCalls.length, 1, "Cancelling must not start a paid review");

    // 2. Test Explicit Approval via Start review
    const pendingApprove = f.pro.batchReview({
        tasks: [
            { id: "t1", title: "Calculus Problem Set", criteria: "Show all steps" },
            { id: "t2", title: "Physics Lab Report", criteria: "Include graph" }
        ],
        files: [{ mime_type: "image/png", data: "YWJj" }],
        
    });
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const check = () => appended.length ? resolve() : Date.now() >= deadline
            ? reject(new Error('Review dialog did not mount')) : setTimeout(check, 1);
        check();
    });
    assert.equal(appended.length, 1);
    appended[0].querySelector("#proQuoteStartBtn").click();
    const res = await pendingApprove;
    assert.equal(res.verdict, "approved");
    assert.equal(quoteCalls.length, 3);
    assert.equal(quoteCalls[2].path, "/pro/ai/batch-review");
    assert.equal(quoteCalls[2].body.quote_id, "q_dialog_1");
});

test("Consecutive subtask creation is gated to active Pro accounts across active Pro, Free, expired Pro, and failed checks", async () => {
    const f = client();
    // 1. Active Pro
    f.pro.getStatus = async () => ({ isPro: true, status: "active", expires_at: null });
    let res = await f.pro.checkConsecutiveEntitlement();
    assert.equal(res.allowed, true);
    assert.equal(res.status, "active");

    // 2. Free tier
    f.pro.getStatus = async () => ({ isPro: false, status: "free" });
    res = await f.pro.checkConsecutiveEntitlement();
    assert.equal(res.allowed, false);
    assert.equal(res.status, "free");
    assert.match(res.message, /Taskitator Pro feature/);
    assert.match(res.message, /Ordinary manual subtask creation remains available/);

    // 3. Expired Pro
    f.pro.getStatus = async () => ({ isPro: false, status: "expired" });
    res = await f.pro.checkConsecutiveEntitlement();
    assert.equal(res.allowed, false);
    assert.equal(res.status, "expired");
    assert.match(res.message, /expired/);
    assert.match(res.message, /existing subtasks and numbering are preserved/);

    // 4. Failed entitlement check
    f.pro.getStatus = async () => { throw new Error("Network offline"); };
    res = await f.pro.checkConsecutiveEntitlement();
    assert.equal(res.allowed, false);
    assert.equal(res.status, "error");
    assert.match(res.message, /Ordinary manual subtask creation remains available/);
    assert.match(res.message, /retry/);

    // Verify index.html labels and components.js gating in both quick-creation handlers
    const indexHtml = readConsolidatedSource("index.html");
    assert.match(indexHtml, /id="createConsecutiveToggle"[\s\S]{0,160}pro-feature-pill">PRO/);
    assert.match(indexHtml, /id="detailConsecutiveToggle"[\s\S]{0,160}pro-feature-pill">PRO/);
    assert.ok(indexHtml.includes('id="createConsecutiveNotice"'));
    assert.ok(indexHtml.includes('id="detailConsecutiveNotice"'));

    const compJs = readConsolidatedSource("components.js");
    const matches = compJs.match(/checkConsecutiveEntitlement\(\)/g) || [];
    assert.ok(matches.length >= 3, "components.js must check entitlement in both quick-creation handlers and toggle listeners");
});

test("Free-versus-Pro comparison page covers limits, dynamic charges, ×2 exemplar, 25% batch discount, BYOK, consecutive subtasks, and omits pricing", () => {
    const compareHtml = readConsolidatedSource("pro/compare.html");
    assert.match(compareHtml, /45 daily/i);
    assert.match(compareHtml, /1,000 monthly/i);
    assert.match(compareHtml, /×2 charge|×2 multiplier/);
    assert.match(compareHtml, /25% per-task batch discount|25% batch discount/);
    assert.match(compareHtml, /Personal API-Key Mode \(BYOK\)/);
    assert.match(compareHtml, /Consecutive Subtask Auto-Numbering|Consecutive Subtask Creation/);
    assert.doesNotMatch(compareHtml, /\$\d|\bUSD\b|\bSAR\b|per month|\/month|pricing/i, "Comparison page must not display a price");

    const proUi = readConsolidatedSource("pro/pro-ui.js");
    assert.match(proUi, /href="components\.html\?view=compare"[^>]*>Compare Free and Pro/);
});

test("Account-deletion status route on settings.html?view=deletion-status activates status panel without self-redirecting", async () => {
    const bootCode = readConsolidatedSource("auth-bootstrap.js");
    assert.ok(bootCode.includes("if (deletionStatusPage)"), "auth-bootstrap.js must guard deletionStatusPage before TaskitatorAuth.init()");
    assert.ok(bootCode.indexOf("if (deletionStatusPage)") < bootCode.indexOf("await TaskitatorAuth.init()"));

    const delStatusCode = readConsolidatedSource("deletion-status.js");
    assert.ok(delStatusCode.includes("window.TaskitatorDeletionStatus = { check, activate }"));
});

test("Ari getPageContext identifies components.html views (stats, trash, blocker-guide, projects, calendar) and disables task-mutation tools outside Today/General", async () => {
    const f = browser();
    f.context.document = { readyState: "loading" };
    f.context.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    f.context.fetch = async () => new Response("<!-- taskitator-system-prompt:v1 --> Taskitator Focus Copilot");
    let lastPayload = null;
    f.window.TaskitatorVault = {
        available: true,
        selection: () => ({ provider: "gemini", primary: "gemini-3.5-flash-lite" }),
        generate: async (model, payload) => {
            lastPayload = payload;
            return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
        }
    };
    vm.runInContext(source("agent-engine.js"), f.context);

    for (const [search, expectedCtx] of [
        ["?view=stats", "stats"],
        ["?view=trash", "trash"],
        ["?view=blocker-guide", "blocker_guide"],
        ["?view=projects", "projects"],
        ["?view=calendar", "calendar"],
        ["?view=legal", "legal"],
        ["?view=compare", "compare"]
    ]) {
        f.window.location = { pathname: "/components.html", search, hash: "" };
        assert.equal(f.window.TaskitatorAgent.getPageContext(), expectedCtx);
        await f.window.TaskitatorAgent.sendMessage("Check context");
        assert.equal(lastPayload.tools, undefined, "Mutation tools must be disabled on components.html" + search);
    }
});

test("Service worker STATIC_ASSETS lists only existing consolidated files and uses release cache", () => {
    const swCode = readConsolidatedSource("sw.js");
    assert.match(swCode, /const CACHE_NAME = 'taskitator-smart-study-v1'/);
    const listMatch = swCode.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/);
    assert.ok(listMatch, "STATIC_ASSETS must be defined in sw.js");
    const assets = [...listMatch[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(Boolean);
    for (const rel of ["index.html", "components.html", "settings.html", "login.html", "style.css", "core.js", "pro.js", "components.js", "app.js"]) {
        assert.ok(assets.includes(rel), "STATIC_ASSETS must include " + rel);
    }
    for (const asset of assets) {
        assert.ok(fs.existsSync(new URL(asset, TEST_ROOT)), "Cached asset must exist in repository: " + asset);
    }
});

test("Public comparison and legal routes never load private workspace scripts or render cached statistics when signed out", async () => {
    const bootCode = readConsolidatedSource("auth-bootstrap.js");
    assert.ok(bootCode.includes("if (publicComponentView)"), "auth-bootstrap.js must isolate publicComponentView");
    assert.ok(
        bootCode.indexOf("if (publicComponentView)") < bootCode.indexOf("script[type=\"text/taskitator-script\"]"),
        "publicComponentView must return before loading private text/taskitator-script bundles"
    );

    // Simulate signed-out device with cached tasks in localStorage on ?view=compare
    const f = browser();
    f.storage.setItem("taskitator_tasks", JSON.stringify([
        { id: "t1", title: "Secret Cached Task", status: "completed", completed_at: new Date().toISOString(), ai_locked: true }
    ]));
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) {
            nodes.set(id, { id, textContent: "0", style: {}, innerHTML: "", appendChild() {}, addEventListener() {}, remove() {} });
        }
        return nodes.get(id);
    };
    f.window.location = { pathname: "/components.html", search: "?view=compare", hash: "", replace(u) { this.replaced = u; } };
    f.window.TaskitatorAuth = { signedIn: false, account: null };
    f.context.navigator = {};
    f.context.document = {
        getElementById: node,
        createElement: () => ({ style: {}, appendChild() {}, querySelector: () => ({ addEventListener() {} }), replaceChildren() {} })
    };
    f.context.TaskitatorRecurrenceUI = { state: () => ({ history: [] }) };
    f.context.TaskitatorSafety = { escapeHtml: String, setProjectLabel() {} };

    const html = source("stats.html");
    const code = html.match(/<script type="text\/taskitator-script">([\s\S]*?)<\/script>/)[1];
    vm.runInContext(code + "\nrenderStats();", f.context);
    assert.equal(node("statCompletedToday").textContent, "0", "Signed-out public route must never render cached task statistics");
});

test("Slow consecutive entitlement checks do not duplicate subtasks on double-Enter or overwrite concurrent typing", async () => {
    const f = browser();
    let saved=0;f.context.confirm=()=>true;
    const createdTasks = [];
    const elements = new Map();
    const makeEl = (id) => ({
        id,
        value: "",
        checked: true,
        style: { display: "none" },
        textContent: "",
        innerHTML: "",
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        listeners: {},
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
        dispatchEvent(event) { return this.listeners[event.type]?.(event); },
        appendChild(child) { this.children.push(child); },
        append(...children) {this.children.push(...children);},
        replaceChildren(...children) {this.children=children;},
        querySelector(selector) { return selector==='.modal-box'?this:{ addEventListener() {} }; },
        closest() { return null; },
        focus() {}
    });
    for (const id of [
        "detailQuickSubtaskInput", "detailConsecutiveToggle", "detailConsecutiveNotice",
        "createQuickSubtaskInput", "createConsecutiveToggle", "createConsecutiveNotice",
        "subtaskBuilderList", "detailSubtasksList", "taskDetailModal", "addSubtaskFieldBtn", "detailAddQuickSubtaskBtn", "saveTaskDetailsBtn", "closeDetailModalBtn"
    ]) {
        elements.set(id, makeEl(id));
    }

    f.context.document = {
        getElementById: (id) => elements.get(id) || null,
        querySelectorAll: () => [],
        addEventListener() {},
        createElement: () => makeEl("dynamic")
    };
    f.window.document = f.context.document;
    f.context.KeyboardEvent=class{constructor(type,options){this.type=type;Object.assign(this,options)}preventDefault(){}};
    f.context.TaskitatorSafety = { escapeHtml: String };

    let resolveCheck;
    f.window.TaskitatorPro = {
        checkConsecutiveEntitlement: () => new Promise(r => { resolveCheck = r; })
    };

    Object.defineProperty(f.window,'TaskitatorRecurrence',{get:()=>f.context.TaskitatorRecurrence});
    const compCode = readConsolidatedSource("components.js");
    vm.runInContext(compCode, f.context);

    const parentTask = { id: "parent_1", title: "Parent", project_id: "inbox", status: "active" };
    createdTasks.push(parentTask);
    const compInstance = f.window.TaskitatorComponents.create({
        apiVersion: 1,
        tasks: {
            getAll: () => createdTasks,
            reload() {},
            save() {saved++;},
            sort: (arr) => arr,
            descendants: () => [],
            shieldedAncestor: () => null,
            hasUncompletedDescendant: () => false,
            remove() {},
            moveProject() {},
            setStatus() {},
            finalize() {}
        },
        catalogs: { lowestPriority: () => "p4", tags: () => [], priorities: () => [], projects: () => [], addTag() {} },
        rules: { bypassActive: () => false, strictCriteria: () => false },
        effects: { auditSuccess() {} },
        view: { current: () => "today", refresh() {} },
        clock: { today: () => "2026-10-23" },
        breaks: { today: () => [] }
    });
    compInstance.init();

    await compInstance.openDetail("parent_1", () => {});

    // 1. Detail quick subtask input: press Enter twice while entitlement check is pending, then type a custom title
    const detailInput = elements.get("detailQuickSubtaskInput");
    detailInput.value = "Problem {num==1}";
    const p1 = detailInput.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(detailInput.value, "", "Submitted title must be cleared synchronously before awaiting Pro status");
    // Second Enter while slow entitlement check is still in flight
    const p2 = detailInput.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(f.window.TaskitatorEditorDraft.tasks.filter(t => t.parent_id === "parent_1").length, 1, "Double-Enter must add one draft subtask");
    assert.equal(createdTasks.length,1,'Editing must not change saved tasks before Save');

    // User types a new title before entitlement response arrives
    detailInput.value = "Custom next title";
    resolveCheck({ allowed: true, status: "active", message: "" });
    await p1;
    await p2;
    assert.equal(detailInput.value, "Custom next title", "Late entitlement response must not overwrite user typing");

    // 2. Create quick subtask input: verify auto-increment works when user does not type during check
    const createInput = elements.get("createQuickSubtaskInput");
    const builderList = elements.get("subtaskBuilderList");
    createInput.value = "Step {num==1}";
    const cp1 = createInput.listeners.keydown({ key: "Enter", preventDefault() {} });
    const cp2 = createInput.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(builderList.children.length, 1, "Double-Enter in Create Task must not duplicate builder items");
    resolveCheck({ allowed: true, status: "active", message: "" });
    await cp1;
    await cp2;
    assert.equal(createInput.value, "Step {num==2}", "When input remains empty, active Pro increments consecutive number");
    // Overlapping submissions: older replies must not refill the next input.
    for (const [input,prefix] of [[createInput,'Create'],[detailInput,'Details']]) {
        const checks=[];
        f.window.TaskitatorPro.checkConsecutiveEntitlement=()=>new Promise(resolve=>checks.push(resolve));
        input.value='Chapter {num==1}';const first=input.listeners.keydown({key:'Enter',preventDefault(){}});
        input.value='Chapter {num==2}';input.listeners.input();const second=input.listeners.keydown({key:'Enter',preventDefault(){}});
        checks[0]({allowed:true});await first;assert.equal(input.value,'',prefix+' ignores stale first reply');
        checks[1]({allowed:true});await second;assert.equal(input.value,'Chapter {num==3}',prefix+' advances newest submission');
        input.value='Chapter {num==3}';const pending=input.listeners.keydown({key:'Enter',preventDefault(){}});
        input.value='New draft';input.listeners.input();input.value='';input.listeners.input();
        checks[2]({allowed:true});await pending;assert.equal(input.value,'',prefix+' preserves edits even after clearing');
    }
    let prevented=false,stopped=false;
    builderList.listeners.keydown({key:'Enter',target:{matches:()=>true},preventDefault(){prevented=true},stopPropagation(){stopped=true}});
    assert.ok(prevented && stopped,'Enter in an editable draft row never submits the parent form');

    for(const [prefix,button] of [['create','addSubtaskFieldBtn'],['detail','detailAddQuickSubtaskBtn']]){
        elements.get(prefix+'ConsecutiveToggle').checked=false;
        const input=elements.get(prefix+'QuickSubtaskInput');input.value='Manual title';
        const before=prefix==='create'?builderList.children.length:f.window.TaskitatorEditorDraft.tasks.length;
        elements.get(button).listeners.click();
        assert.equal(input.value,'');
        assert.equal(prefix==='create'?builderList.children.length:f.window.TaskitatorEditorDraft.tasks.length,before+1,'Plus adds exactly one manual subtask');
        elements.get(button).listeners.click();
        assert.equal(prefix==='create'?builderList.children.length:f.window.TaskitatorEditorDraft.tasks.length,before+1,'Empty plus does not create a blank required row');
    }

    const expected=f.window.TaskitatorEditorDraft.tasks.length;
    assert.equal(saved,0,'Draft changes must not push');
    await elements.get('saveTaskDetailsBtn').listeners.click();
    assert.equal(saved,1,'Only explicit Save commits the draft');assert.equal(createdTasks.length,expected);
    await compInstance.openDetail('parent_1',()=>{});
    elements.get('detailConsecutiveToggle').checked=false;
    detailInput.value='Discard this';await detailInput.listeners.keydown({key:'Enter',preventDefault(){}});
    f.context.confirm=()=>false;elements.get('closeDetailModalBtn').listeners.click();assert.ok(f.window.TaskitatorEditorDraft,'Declining discard keeps the draft');
    f.context.confirm=()=>true;elements.get('closeDetailModalBtn').listeners.click();assert.equal(f.window.TaskitatorEditorDraft,null);assert.equal(createdTasks.length,expected);assert.equal(saved,1);
    f.window.TaskitatorPro.checkConsecutiveEntitlement=async()=>({allowed:false});await compInstance.openDetail('parent_1',()=>{});await Promise.resolve();
    assert.equal(elements.get('detailConsecutiveToggle').disabled,true);assert.equal(elements.get('createConsecutiveToggle').disabled,true);
    f.window.TaskitatorPro.checkConsecutiveEntitlement=async()=>({allowed:true});await compInstance.openDetail('parent_1',()=>{});await Promise.resolve();assert.equal(elements.get('detailConsecutiveToggle').disabled,false);
});

test("Opening another review cost preview cancels and resolves the first review promise instead of stranding it", async () => {
    const f = client();
    const appended = [];
    f.context.document = {
        activeElement: null,
        getElementById: (id) => appended.find(el => el.id === id) || null,
        createElement: () => ({
            id: "",
            className: "",
            innerHTML: "",
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            remove() {
                const idx = appended.indexOf(this);
                if (idx !== -1) appended.splice(idx, 1);
            },
            addEventListener() {},
            removeEventListener() {},
            querySelector(sel) { return this._buttons?.[sel] || null; }
        }),
        body: {
            children: [],
            appendChild(el) {
                el._buttons = {};
                for (const id of ["#proQuoteCancelBtn", "#proQuoteCloseBtn", "#proQuoteStartBtn", "#proQuoteDetailsSummary"]) {
                    el._buttons[id] = {
                        id,
                        listeners: {},
                        addEventListener(ev, fn) { this.listeners[ev] = fn; },
                        click() { this.listeners.click?.(); },
                        focus() { f.context.document.activeElement = this; }
                    };
                }
                appended.push(el);
            }
        },
        addEventListener() {},
        removeEventListener() {}
    };
    f.window.addEventListener = () => {};
    f.window.document = f.context.document;
    vm.runInContext(readConsolidatedSource("pro/pro-ui.js"), f.context);

    const firstPromise = f.window.ProUI.confirmReviewQuote({
        estimatedCredits: 0.4,
        maximumCredits: 1.2,
        tasks: [{ title: "First task", credits: 1.2 }]
    });
    assert.equal(appended.length, 1);

    // Open a second preview while the first is still pending
    const secondPromise = f.window.ProUI.confirmReviewQuote({
        estimatedCredits: 0.8,
        maximumCredits: 2.0,
        tasks: [{ title: "Second task", credits: 2.0 }]
    });

    const firstResult = await firstPromise;
    assert.equal(firstResult, false, "First review preview promise must resolve to false when replaced");
    assert.equal(appended.length, 1, "Only the replacement dialog should remain mounted");

    appended[0].querySelector("#proQuoteStartBtn").click();
    const secondResult = await secondPromise;
    assert.equal(secondResult, true, "Second review preview promise must resolve to true when approved");
});

test("Review cost preview dialog enforces initial focus, Tab focus containment, Escape cancellation, and focus restoration", async () => {
    const f = client();
    const docListeners = {};
    const triggerBtn = {
        id: "submitProofTrigger",
        focusedCount: 0,
        inert: false,
        attrs: {},
        getAttribute(k) { return this.attrs[k] ?? null; },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        focus() {
            this.focusedCount++;
            f.context.document.activeElement = this;
        }
    };

    const appended = [];
    f.context.document = {
        activeElement: triggerBtn,
        getElementById: (id) => appended.find(el => el.id === id) || null,
        createElement: () => ({
            id: "",
            className: "",
            innerHTML: "",
            attributes: {},
            listeners: {},
            setAttribute(k, v) { this.attributes[k] = v; },
            addEventListener(ev, fn) { this.listeners[ev] = fn; },
            removeEventListener(ev) { delete this.listeners[ev]; },
            remove() {
                const idx = appended.indexOf(this);
                if (idx !== -1) appended.splice(idx, 1);
            },
            contains(target) {
                return Object.values(this._buttons || {}).includes(target);
            },
            querySelector(sel) { return this._buttons?.[sel] || null; },
            querySelectorAll() {
                return [
                    this._buttons["#proQuoteCloseBtn"],
                    this._buttons["#proQuoteDetailsSummary"],
                    this._buttons["#proQuoteCancelBtn"],
                    this._buttons["#proQuoteStartBtn"]
                ].filter(Boolean);
            }
        }),
        body: {
            children: [triggerBtn],
            appendChild(el) {
                el._buttons = {};
                for (const id of ["#proQuoteCloseBtn", "#proQuoteDetailsSummary", "#proQuoteCancelBtn", "#proQuoteStartBtn"]) {
                    el._buttons[id] = {
                        id,
                        listeners: {},
                        addEventListener(ev, fn) { this.listeners[ev] = fn; },
                        click() { this.listeners.click?.(); },
                        focus() { f.context.document.activeElement = this; }
                    };
                }
                appended.push(el);
            }
        },
        addEventListener(ev, fn) { docListeners[ev] = fn; },
        removeEventListener(ev) { delete docListeners[ev]; }
    };
    f.window.addEventListener = () => {};
    f.window.document = f.context.document;
    vm.runInContext(readConsolidatedSource("pro/pro-ui.js"), f.context);

    const quotePromise = f.window.ProUI.confirmReviewQuote({
        estimatedCredits: 0.5,
        maximumCredits: 1.5,
        tasks: [{ title: "Keyboard test task", credits: 1.5 }]
    });

    const dialog = appended[0];
    const closeBtn = dialog.querySelector("#proQuoteCloseBtn");
    const cancelBtn = dialog.querySelector("#proQuoteCancelBtn");
    const startBtn = dialog.querySelector("#proQuoteStartBtn");

    // 1. Focus moves inside dialog on open & background becomes inert
    assert.equal(f.context.document.activeElement, cancelBtn, "Opening dialog must move focus inside the dialog");
    assert.equal(triggerBtn.inert, true, "Background controls must be marked inert while dialog is open");

    // 2. Tab on last element wraps to first element
    startBtn.focus();
    let tabPrevented = false;
    docListeners.keydown({ key: "Tab", shiftKey: false, preventDefault() { tabPrevented = true; } });
    assert.equal(tabPrevented, true);
    assert.equal(f.context.document.activeElement, closeBtn, "Tab from last control must wrap to first control");

    // 3. Shift+Tab on first element wraps to last element
    let shiftTabPrevented = false;
    docListeners.keydown({ key: "Tab", shiftKey: true, preventDefault() { shiftTabPrevented = true; } });
    assert.equal(shiftTabPrevented, true);
    assert.equal(f.context.document.activeElement, startBtn, "Shift+Tab from first control must wrap to last control");

    // 4. Escape cancels the review and restores focus to the opener
    let escPrevented = false;
    docListeners.keydown({ key: "Escape", preventDefault() { escPrevented = true; }, stopPropagation() {} });
    assert.equal(escPrevented, true);
    const decision = await quotePromise;
    assert.equal(decision, false, "Escape key must cancel and resolve confirmReviewQuote with false");
    assert.equal(appended.length, 0, "Dialog must be removed on Escape");
    assert.equal(triggerBtn.inert, false, "Background inert state must be restored on close");
    assert.equal(f.context.document.activeElement, triggerBtn, "Focus must be restored to prior activeElement on close");
});

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


test('missing preview and non-boolean approval cannot start a paid review',async()=>{
    for(const answer of [null,false,undefined,'yes',true]){
        const f=client(),calls=[];f.pro.prepareAudit=async()=>{};
        f.window.confirm=()=>{throw Error('Native confirmation must not run')};
        f.window.ProUI=answer===null?null:{confirmReviewQuote:async()=>answer};
        f.pro.request=async path=>{calls.push(path);return path.endsWith('/quote')?{quote_id:'q',estimated_credits:.4,maximum_credits:1.5666,tasks:[{task_id:'t',credits:1.5666}]}:{success:true}};
        const pending=f.pro.reviewProof({taskId:'t',criteria:'Saved',files:[image]});
        if(answer===true)await pending;else await assert.rejects(pending,{code:'AUDIT_CANCELLED'});
        assert.equal(calls.length,answer===true?2:1);
    }
});
test('consecutive entitlement rejects stale session, inactive status and expired timestamps',async()=>{
    for(const status of [{isPro:true,status:'expired',expires_at:null},{isPro:true,status:'active',expires_at:Date.now()-1},{isPro:true,status:'active'}]){
        const f=client();f.pro.getStatus=async()=>status;assert.equal((await f.pro.checkConsecutiveEntitlement()).allowed,false);
    }
    const f=client();f.pro.getStatus=async()=>{f.window.Clerk.session.id='other';return {isPro:true,status:'active',expires_at:null}};
    assert.equal((await f.pro.checkConsecutiveEntitlement()).allowed,false);
});

test('emergency confirmation blocks repeated clicks, reports failure and closes only after success',async()=>{
    const app=readConsolidatedSource('app.js'),alerts=[];let handler,removed=0,updated=0,activate,calls=0;
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


test('Keyo redirects never forward activation credentials or save an entitlement',async()=>withKeyoHarness(async h=>{
    for(const status of [301,302,303,307,308]) {
        h.reply(async()=>new Response(null,{status,headers:{Location:'https://untrusted.example/collect'}}));
        const count=h.calls.length;
        const result=await h.route();
        assert.equal(result.status,503);
        assert.match(result.body.error,/returned a redirect/);
        assert.equal(h.calls.length,count+1);
        assert.equal(await h.storage.get(licenseKey),undefined);
    }
}));

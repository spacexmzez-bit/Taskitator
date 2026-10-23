import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
function client(){
    const data=new Map([['taskitator_local_revision','revision_1'],['taskitator_tasks','[{"id":"t","status":"active","ai_locked":true}]']]);
    const localStorage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v))};
    const window={addEventListener(){},Clerk:{session:{id:'sess_A'}},TaskitatorProUI:{confirmReviewCost:async()=>true}};
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

function ui(document) {
    const window={addEventListener(){}};
    const context=vm.createContext({window,...(document?{document}:{})});
    vm.runInContext(source('pro/pro-ui.js'),context);
    return window.TaskitatorProUI;
}
const priceOptions=()=>({quote:{quote_id:'original_quote',estimated_credits:.4444,maximum_credits:1.5666,batch_discount:.25,
    tasks:[{task_id:'a',credits:.8166,exemplar:true},{task_id:'b',credits:.75,exemplar:false}]},
    names:new Map([['a','Lab <img src=x onerror=alert(1)>'],['b','Notes']])});

test('review summary rounds to one decimal, closed expandable details use three, and quote accounting is unchanged',()=>{
    const options=priceOptions(),original=JSON.stringify(options.quote);
    const markup=ui().reviewCostMarkup(options);
    const [summary,details]=markup.split('<details');
    assert.match(summary,/0\.4 credits/);assert.match(summary,/1\.6 credits/);
    assert.doesNotMatch(summary,/0\.444|1\.567|Lab/);
    assert.match(details,/<summary>View details<\/summary>/);assert.doesNotMatch(details.split('>')[0],/\bopen\b/);
    for(const exact of ['0.444','1.567','0.817','0.750'])assert.ok(details.includes(exact+' credits'));
    assert.match(details,/Reference example multiplier: ×2/);assert.match(details,/multiplier: ×1/);
    assert.equal((details.match(/25% batch discount included/g)||[]).length,2);
    assert.match(details,/Lab &lt;img/);assert.doesNotMatch(details,/<img/);
    assert.match(markup,/Unused held credits return/);assert.match(markup,/even when proof is rejected/);
    assert.match(markup,/>Cancel<\/button>/);assert.match(markup,/>Start review<\/button>/);
    assert.equal(JSON.stringify(options.quote),original);
    const single=priceOptions();single.quote.batch_discount=0;
    assert.match(ui().reviewCostMarkup(single),/Batch discount: none/);
    assert.doesNotMatch(ui().reviewCostMarkup(single),/25%/);
});

// Small DOM boundary fixture: actual listeners run, with the native modal operations modeled.
function dialogDocument() {
    let active,dialog;
    const trigger={isConnected:true,focus(){active=this}};active=trigger;
    const document={readyState:'loading',addEventListener(){},get activeElement(){return active},
        getElementById:id=>dialog?.id===id?dialog:null,
        body:{appendChild:d=>{dialog=d;d.isConnected=true}},
        createElement(){
            const listeners=new Map(),buttons={};
            const d={open:false,setAttribute(){},addEventListener:(type,fn)=>listeners.set(type,fn),
                querySelector:selector=>buttons[selector] ||= {focus(){active=this}},
                showModal(){d.open=true},close(){d.open=false;listeners.get('close')?.()},
                remove(){dialog=null;d.isConnected=false},
                escape(){listeners.get('cancel')?.({preventDefault(){}})}};
            return d;
        }};
    return {document,trigger,get dialog(){return dialog}};
}

test('cost dialog requires Start review, defaults focus to Cancel, and restores focus after cancellation or Escape',async()=>{
    for(const action of ['cancel','escape','start']){
        const f=dialogDocument(),api=ui(f.document);
        let resolved=false;const choice=api.confirmReviewCost(priceOptions()).then(value=>{resolved=true;return value});
        await Promise.resolve();assert.equal(resolved,false);
        assert.equal(f.document.activeElement,f.dialog.querySelector('.pro-review-cancel'));
        // A second preview cannot silently approve a concurrent review.
        assert.equal(await api.confirmReviewCost(priceOptions()),false);
        if(action==='escape')f.dialog.escape();else f.dialog.querySelector('.pro-review-'+action).onclick();
        assert.equal(await choice,action==='start');assert.equal(f.dialog,null);assert.equal(f.document.activeElement,f.trigger);
    }
});

test('no paid request starts while preview is pending; only explicit true approves and original quote survives rounding',async()=>{
    for(const answer of [false,undefined,'yes',true]){
        const f=client(),calls=[];let decide;
        f.pro.prepareAudit=async()=>{};
        f.window.confirm=()=>{throw Error('Native confirm must not be used')};
        f.window.TaskitatorProUI={confirmReviewCost:options=>{assert.equal(options.quote.maximum_credits,1.5666);return new Promise(resolve=>{decide=resolve})}};
        f.pro.request=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return path.endsWith('/quote')?priceOptions().quote:{success:true}};
        const operation=f.pro.reviewProof({taskId:'a',criteria:'Saved',files:[{mime_type:'image/png',data:'YWJj'}]});
        while(!decide)await new Promise(setImmediate);
        assert.equal(calls.length,1);decide(answer);
        if(answer===true){await operation;assert.equal(calls[1].body.quote_id,'original_quote')}
        else await assert.rejects(operation,{code:'AUDIT_CANCELLED'});
        assert.equal(calls.length,answer===true?2:1);
    }
});

test('missing review UI and session changes during preview fail closed',async()=>{
    for(const change of ['missing','session']){
        const f=client();f.pro.prepareAudit=async()=>{};let reviews=0;
        f.pro.request=async path=>{if(path.endsWith('/quote'))return priceOptions().quote;reviews++;return {}};
        f.window.TaskitatorProUI=change==='missing'?null:{confirmReviewCost:async()=>{f.window.Clerk.session.id='another';return true}};
        await assert.rejects(()=>f.pro.reviewProof({taskId:'a',criteria:'Saved'}),change==='missing'?/unavailable/:/session changed/);
        assert.equal(reviews,0);
    }
});

test('consecutive entitlement uses authenticated status and rejects Free, expired and unverifiable accounts',async()=>{
    const f=client(),paths=[];
    for(const [status,expected] of [
        [{isPro:true,status:'active',expires_at:Date.now()+60000},true],
        [{isPro:true,status:'active',expires_at:null},true],
        [{isPro:false,status:'free',expires_at:null},false],
        [{isPro:false,status:'expired',expires_at:Date.now()-1},false],
        [{isPro:true,status:'active',expires_at:Date.now()-1},false],
        [{isPro:true,status:'verification_required',expires_at:null},false]
    ]){
        f.pro.request=async path=>{paths.push(path);return status};
        assert.equal(await f.pro.canCreateConsecutive(),expected);
    }
    assert.ok(paths.every(path=>path==='/pro/status'));
    f.pro.request=async()=>{throw Error('Unavailable')};await assert.rejects(()=>f.pro.canCreateConsecutive(),/Unavailable/);
    f.pro.request=async()=>{f.window.Clerk.session.id='switched';return {isPro:true,status:'active',expires_at:null}};
    await assert.rejects(()=>f.pro.canCreateConsecutive(),/session changed/);
});

function componentFixture() {
    const f=client(),elements=new Map();
    const element=id=>{
        const listeners=new Map(),children=[];
        return {id,value:'',checked:false,textContent:'',style:{},children,
            classList:{toggle(){},add(){},remove(){}},
            setAttribute(){},removeAttribute(){},closest(){return this},focus(){},remove(){},
            addEventListener:(type,fn)=>listeners.set(type,fn),dispatch:(type,event={})=>listeners.get(type)?.(event),
            appendChild:child=>children.push(child),querySelector:()=>element('child')};
    };
    for(const prefix of ['create','detail'])for(const suffix of ['QuickSubtaskInput','ConsecutiveToggle','ConsecutiveToggleHelp']){
        const id=prefix+suffix;elements.set(id,element(id));
    }
    elements.set('subtaskBuilderList',element('subtaskBuilderList'));
    const document={getElementById:id=>elements.get(id)||null,createElement:()=>element('new'),querySelectorAll:()=>[]};
    Object.assign(f.context,{document,TaskitatorSafety:{escapeHtml:s=>s},setTimeout,clearTimeout});
    vm.runInContext(source('components.js'),f.context);
    const tasks=[{id:'parent',title:'Parent',status:'active'}, {id:'old',parent_id:'parent',title:'Chapter 7',raw_title:'Chapter {num==7}',status:'active'}];
    const host={apiVersion:1};
    for(const [group,methods] of Object.entries({tasks:['getAll','reload','save','sort','descendants','shieldedAncestor','hasUncompletedDescendant','remove','moveProject','setStatus','finalize'],catalogs:['projects','tags','priorities','lowestPriority','addTag'],view:['current','refresh'],rules:['bypassActive','strictCriteria'],effects:['auditSuccess'],clock:['today'],breaks:['today']})){
        host[group]=Object.fromEntries(methods.map(m=>[m,()=>[]]));
    }
    host.tasks.getAll=()=>tasks;host.rules.bypassActive=()=>false;
    const components=f.window.TaskitatorComponents.create(host);components.init();
    return {...f,elements,tasks,components,enter(prefix,text){const input=elements.get(prefix+'QuickSubtaskInput');input.value=text;input.dispatch('keydown',{key:'Enter',preventDefault(){}})}};
}
const tick=()=>new Promise(setImmediate);

test('both quick-creation handlers gate auto-increment while preserving manual tasks and existing numbering',async()=>{
    for(const prefix of ['create','detail'])for(const entitlement of ['active','free','expired','unavailable']){
        const f=componentFixture();await f.components.openDetail('parent');
        const before=JSON.stringify(f.tasks[1]);let checks=0;
        f.pro.getStatus=async()=>{checks++;if(entitlement==='unavailable')throw Error('Offline');
            return {isPro:entitlement==='active',status:entitlement,expires_at:entitlement==='expired'?Date.now()-1:null}};
        f.elements.get(prefix+'ConsecutiveToggle').checked=true; // A forged visible checkbox still cannot bypass the guard.
        f.enter(prefix,'Chapter {num==3}');await tick();
        assert.equal(checks,1);assert.equal(f.elements.get(prefix+'QuickSubtaskInput').value,entitlement==='active'?'Chapter {num==4}':'');
        assert.equal(JSON.stringify(f.tasks[1]),before);
        if(prefix==='detail')assert.equal(f.tasks.at(-1).raw_title,'Chapter {num==3}');
        else assert.equal(f.elements.get('subtaskBuilderList').children.length,1);
        if(entitlement==='unavailable')assert.match(f.elements.get(prefix+'ConsecutiveToggleHelp').textContent,/retry.*Manual subtasks/);
        if(['free','expired'].includes(entitlement))assert.match(f.elements.get(prefix+'ConsecutiveToggleHelp').textContent,/requires active Pro/);
        f.elements.get(prefix+'ConsecutiveToggle').checked=false;
        f.enter(prefix,'Chapter 99');await tick();assert.equal(checks,1);
    }
});

test('selection explains Pro restriction, entitlement expiry is rechecked, and unavailable checks can retry',async()=>{
    for(const prefix of ['create','detail']){
        const f=componentFixture();await f.components.openDetail('parent');
        const toggle=f.elements.get(prefix+'ConsecutiveToggle');
        f.pro.getStatus=async()=>({isPro:false,status:'free',expires_at:null});
        toggle.checked=true;toggle.dispatch('change');await tick();assert.equal(toggle.checked,false);
        assert.match(f.elements.get(prefix+'ConsecutiveToggleHelp').textContent,/requires active Pro/);
        f.pro.getStatus=async()=>({isPro:true,status:'active',expires_at:null});
        toggle.checked=true;toggle.dispatch('change');await tick();assert.equal(toggle.checked,true);
        f.pro.getStatus=async()=>({isPro:false,status:'expired',expires_at:1});
        f.enter(prefix,'Chapter {num==8}');await tick();assert.equal(f.elements.get(prefix+'QuickSubtaskInput').value,'');
        f.pro.getStatus=async()=>{throw Error('Offline')};toggle.checked=true;toggle.dispatch('change');await tick();
        f.pro.getStatus=async()=>({isPro:true,status:'active',expires_at:null});
        f.enter(prefix,'Chapter {num==9}');await tick();assert.equal(f.elements.get(prefix+'QuickSubtaskInput').value,'Chapter {num==10}');
    }
});

test('manual creation proceeds during entitlement outage and late checks cannot overwrite new typing',async()=>{
    for(const prefix of ['create','detail']){
        const f=componentFixture();await f.components.openDetail('parent');let complete;
        f.pro.getStatus=()=>new Promise(resolve=>{complete=resolve});
        f.elements.get(prefix+'ConsecutiveToggle').checked=true;
        f.enter(prefix,'Chapter {num==1}');
        // The manual task is already committed while status is pending.
        if(prefix==='detail')assert.equal(f.tasks.at(-1).raw_title,'Chapter {num==1}');
        else assert.equal(f.elements.get('subtaskBuilderList').children.length,1);
        const input=f.elements.get(prefix+'QuickSubtaskInput');input.value='New title';input.dispatch('input');
        complete({isPro:true,status:'active',expires_at:null});await tick();assert.equal(input.value,'New title');
    }
});

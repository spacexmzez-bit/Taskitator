import { digest, fail, prepare } from './audit-policy.js';
import { liveAccount } from './account-lifecycle.js';
const VERSION=3, DAY=86400000;
const protectedTask=t=>Boolean(t.ai_locked || t.require_ai_proof);
const branch=(tasks,id)=>globalThis.TaskitatorRecurrence.subtree(tasks,id).filter(t=>t.status!=='trash');
const stable=value=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?
    Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const filePart=p=>{p=p?.inline_data||p?.inlineData||p;return p ? {mime_type:p.mime_type||p.mimeType,data:p.data}:null;};
export class TaskProtection {
    constructor(service){this.service=service;this.storage=service.storage;}
    async read(store,account){return this.service.readTaskSnapshot(store,account);}
    async fingerprint(snapshot,id){
        const tasks=branch(snapshot.tasks,id).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
        const references=tasks.map(t=>({id:t.id,reference:filePart(t.reference_inline_data || snapshot.recurrence_state?.reference_files?.[t.reference_id])}));
        return digest(stable({tasks,references}));
    }
    async bind(store,account,body,batch,personal=false){
        const {snapshot}=await this.read(store,account);
        if(!snapshot)throw fail(409,'SYNC_REQUIRED','Sync your tasks before submitting proof.');
        const requested=batch?body.tasks:[{id:body.task_id||body.taskId}];
        if(!Array.isArray(requested)||!requested.length||requested.length>20)throw fail(400,'INVALID_TASKS','Select between 1 and 20 tasks.');
        const seen=new Set(),bindings={},tasks=[];
        for(const input of requested){
            if(typeof input?.id!=='string'||seen.has(input.id))throw fail(400,'INVALID_TASKS','Select distinct task IDs.');
            seen.add(input.id);
            const t=snapshot.tasks.find(t=>t.id===input.id);
            if(!t || t.status!=='active' || !protectedTask(t))throw fail(409,'TASK_CHANGED','Select a current, unfinished AI-protected task and sync again.');
            const reference=filePart(t.reference_inline_data || snapshot.recurrence_state?.reference_files?.[t.reference_id]);
            if(t.reference_id && !reference)throw fail(409,'REFERENCE_MISSING','Restore the saved reference exemplar before reviewing this task.');
            if(typeof t.proof_criteria!=='string'||!t.proof_criteria.trim())throw fail(409,'CRITERIA_MISSING','This protected task needs saved proof criteria.');
            bindings[t.id]=await this.fingerprint(snapshot,t.id);
            tasks.push({id:t.id,title:t.title,criteria:t.proof_criteria,exemplar:reference});
        }
        // Caller text and reference files cannot replace the server's saved requirements.
        const canonical=batch?{...body,tasks}:{...body,task_id:tasks[0].id,task_title:tasks[0].title,criteria:tasks[0].criteria,exemplar:tasks[0].exemplar};
        return {...prepare(canonical,batch,{allowHeic:personal}),bindings};
    }
    async attest(tx,account,session,bindings,ids,context){
        await liveAccount(tx,account);
        const id='job_'+crypto.randomUUID();
        await tx.put('pro:attestation:'+id,{version:VERSION,job_id:id,account_id:account,session_id:session,
            action:context.batch?'batch':'single',eligible_task_ids:ids,bindings,evidence_hash:context.hash,
            operation_id:context.operation,model:context.model,created_at:Date.now(),expires_at:Date.now()+DAY,consumed:false});
        return id;
    }
    async complete(identity,body){
        const account=identity.userId,ids=body.task_ids,operation=body.operation_id;
        if(typeof body.job_id!=='string'||!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||
            typeof operation!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(operation))throw fail(400,'INVALID_INPUT','A valid approval, selected task IDs and confirmation ID are required.');
        return this.storage.transaction(async tx=>{
            const {snapshot}=await this.read(tx,account);
            const key='pro:attestation:'+body.job_id,a=await tx.get(key);
            if(!a||a.version!==VERSION||a.account_id!==account||a.session_id!==identity.sessionId||
                a.action!==(body.batch===false?'single':'batch'))throw fail(403,'APPROVAL_INVALID','This approval belongs to a different action or session. Review again.');
            const selection=[...ids].sort();
            if(a.consumed){
                if(a.confirmation_id===operation&&JSON.stringify(a.confirmed_ids)===JSON.stringify(selection))
                    return {success:true,replayed:true,job_id:a.job_id,confirmed_task_ids:a.confirmed_ids,version:a.completed_version};
                throw fail(409,'APPROVAL_USED','This review was already confirmed. Refresh your tasks.');
            }
            if(a.expires_at<=Date.now())throw fail(403,'APPROVAL_EXPIRED','This review expired. Submit proof again.');
            if(!snapshot||ids.some(id=>!a.eligible_task_ids.includes(id)))throw fail(403,'NO_ELIGIBLE_TASKS','Select only tasks approved in this review.');
            for(const id of ids)if(a.bindings[id]!==await this.fingerprint(snapshot,id))throw fail(409,'TASK_CHANGED','The task or its requirements changed after review. Submit new proof.');
            const selected=new Set(ids),tasks=snapshot.tasks;
            for(const id of ids){
                const t=tasks.find(t=>t.id===id),children=branch(tasks,id).filter(c=>c.id!==id);
                if(t?.status!=='active')throw fail(409,'TASK_CHANGED','This task is no longer active.');
                if(children.some(c=>c.status==='active'&&protectedTask(c)&&!selected.has(c.id)))throw fail(409,'CHILD_PROOF_REQUIRED','Review unfinished AI-protected children first.');
                for(const node of [t,...children])if(node.strict_prerequisites && branch(tasks,node.id).some(c=>c.id!==node.id&&!c.is_bonus&&c.status!=='completed'&&!selected.has(c.id)))
                    throw fail(409,'CHILDREN_REQUIRED','Complete the required subtasks before their protected parent.');
            }
            const now=new Date().toISOString(),changed=new Set();
            for(const id of ids)for(const t of branch(tasks,id))if(t.status!=='completed'){
                t.status='completed';t.completed_at=now;delete t.recurrence_hold_until;
                if(protectedTask(t))t.verified_model=a.model;
                changed.add(t.id);
            }
            snapshot.completed_audit_ledger ||= [];
            for(const id of changed){const t=tasks.find(t=>t.id===id);
                snapshot.completed_audit_ledger.push({sync_hash:a.job_id+':'+id,task_id:id,title:t.title,event_type:selected.has(id)?(t.parent_id?'SUBTASK':'ROOT'):'CASCADE',
                    verified_by_ai:protectedTask(t),verification_model:t.verified_model||null,completed_at:now,has_exemplar:!!(t.reference_inline_data||t.reference_id),
                    priority_rank:snapshot.settings?.priorities?.find?.(p=>p.id===t.priority_id)?.rank||3,...(t.mrstudy_binding?{mrstudy_binding:t.mrstudy_binding}:{})});
            }
            snapshot.completed_audit_ledger=snapshot.completed_audit_ledger.slice(-200);
            globalThis.TaskitatorRecurrence.reconcile(snapshot);
            const version=await this.service.writeTaskSnapshot(tx,account,snapshot);
            a.consumed=true;a.confirmation_id=operation;a.confirmed_ids=selection;a.completed_version=version;
            await tx.put(key,a);
            return {success:true,job_id:a.job_id,confirmed_task_ids:selection,version};
        });
    }
    async guardSync(tx,account,previous,next){
        if(!previous)return;
        const bypass=await this.bypass(tx,account);
        const map=new Map();
        for(const t of next.tasks){if(typeof t.id!=='string'||map.has(t.id))throw fail(400,'INVALID_TASKS','Tasks need distinct IDs.');map.set(t.id,t);}
        if(bypass)return;
        for(const old of previous.tasks){
            const current=map.get(old.id);
            if(protectedTask(old)&&old.status!=='trash'){
                if(!current || current.status!==old.status || !protectedTask(current))throw fail(403,'PROOF_REQUIRED','Protected task completion, removal or reopening requires server authorization or Emergency Bypass.');
                const locked=['title','raw_title','due_date','proof_criteria','raw_proof_criteria','reference_id','reference_inline_data','ai_locked','require_ai_proof'];
                for(const field of locked){
                    // Older versions kept references only on the device. Pin an existing reference once; then it is immutable.
                    if(field==='reference_inline_data'&&!old.reference_inline_data&&!old.reference_id&&current.reference_inline_data)continue;
                    if(JSON.stringify(stable(old[field]??null))!==JSON.stringify(stable(current[field]??null)))throw fail(403,'REQUIREMENTS_LOCKED','Protected requirements cannot change without Emergency Bypass.');
                }
                if(old.reference_id && JSON.stringify(stable(previous.recurrence_state?.reference_files?.[old.reference_id]??null))!==JSON.stringify(stable(next.recurrence_state?.reference_files?.[old.reference_id]??null)))
                    throw fail(403,'REQUIREMENTS_LOCKED','Protected reference files cannot change without Emergency Bypass.');
            }
            if(old.strict_prerequisites){
                if(!current||!current.strict_prerequisites)throw fail(403,'SHIELD_REQUIRED','The task shield requires Emergency Bypass to remove.');
                if(old.status==='active'&&current.status==='completed'&&branch(next.tasks,current.id).some(c=>c.id!==current.id&&!c.is_bonus&&c.status!=='completed'))throw fail(403,'CHILDREN_REQUIRED','Complete required subtasks first.');
            }
        }
    }
    async bypass(store,account){await liveAccount(store,account);const state=await store.get('pro:emergency:'+account);return !!state&&state.active_until_ms>Date.now();}
    async emergency(identity,activate=false){
        return this.storage.transaction(async tx=>{
            const {snapshot}=await this.read(tx,identity.userId),now=Date.now(),key='pro:emergency:'+identity.userId;
            let s=await tx.get(key);
            if(!s||s.reset_at<=now){
                const end=Number(snapshot?.settings?.weekend_end??6),resetDay=Number.isInteger(end)&&end>=0&&end<=6?(end+1)%7:0;
                const d=new Date(now+3*3600000);d.setUTCHours(0,0,0,0);let days=(resetDay-d.getUTCDay()+7)%7;if(!days)days=7;
                s={cycle_id:'server-'+d.toISOString().slice(0,10),uses_left:4,active_until_ms:0,reset_at:d.getTime()+days*DAY-3*3600000};
            }
            if(activate){
                if(s.active_until_ms>now)throw fail(409,'BYPASS_ACTIVE','Emergency Bypass is already active.');
                if(!s.uses_left)throw fail(429,'BYPASS_EXHAUSTED','All 4 emergency tokens for this cycle have been exhausted.');
                s.uses_left--;s.active_until_ms=now+15*60000;await tx.put(key,s);
            }
            return {...s,server_managed:true,active_until:s.active_until_ms?new Date(s.active_until_ms).toISOString():null,success:true};
        });
    }
}

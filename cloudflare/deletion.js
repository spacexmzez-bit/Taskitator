import { SecurityError, sha256 } from './auth.js';
export const RECOVERY_MS = 7 * 86400000;
const secretPattern = /^[a-f0-9]{64}$/;
const accountKey = user => 'account:'+encodeURIComponent(user);
export class AccountDeletion {
    constructor(service) { this.service=service; this.storage=service.storage; this.env=service.env; this.running=false; }
    async marker(identity) { return this.storage.get('deleted-identity:'+await sha256(identity.userId)); }
    async status(receipt) {
        if (typeof receipt !== 'string' || !secretPattern.test(receipt)) throw new SecurityError(404,'Deletion receipt was not found.');
        const record=await this.storage.get('deletion-status:'+await sha256(receipt));
        if (!record || (record.expires && record.expires<=Date.now())) throw new SecurityError(404,'Deletion receipt expired or was not found.');
        return { accepted:true, status:record.status, complete:record.status==='complete',
            accepted_at:record.accepted_at, completed_at:record.completed_at || null,
            phone_recovery_until:record.phone_recovery_until, legacy_review_needed:record.legacy_review_needed===true,
            migration_approval_remains:record.migration_approval_remains===true };
    }
    async accept(request, identity, body) {
        if (this.env.ACCOUNT_DELETION_ENABLED !== 'true') throw new SecurityError(503,'Account deletion needs one-time setup. Follow PHASE-1-SETUP.txt.');
        if (identity.actor) throw new SecurityError(403,'Impersonated sessions cannot delete accounts.');
        if (body.blocker_disabled !== true || body.phrase !== 'Macrodroid disabled') {
            throw new SecurityError(400,'Disable blocking on every device, check the confirmation, and type Macrodroid disabled exactly.');
        }
        if (!secretPattern.test(body.receipt || '')) throw new SecurityError(400,'A deletion receipt is required.');
        const previous=await this.marker(identity);
        if (previous) return { accepted:true, receipt:previous.receipt || body.receipt,
            status:previous.status, phone_recovery_until:previous.phone_recovery_until };
        const proof=await this.service.verification.get(body.verification_id,identity);
        if (proof.status!=='verified') throw new SecurityError(403,'Verify your password or Google account before deleting.');
        const statusHash=await sha256(body.receipt), markerKey='deleted-identity:'+await sha256(identity.userId);
        const accepted=Date.now(), recoveryUntil=accepted+RECOVERY_MS;
        await this.storage.transaction(async tx=>{
            if (await tx.get(markerKey)) return;
            if (await tx.get('deletion-status:'+statusHash)) throw new SecurityError(409,'This receipt is already in use. Start again.');
            const proofKey='action-proof:'+await sha256(body.verification_id), current=await tx.get(proofKey);
            if (!current || current.status!=='verified' || current.expires<=Date.now() ||
                current.userId!==identity.userId || current.sessionId!==identity.sessionId || current.action!=='delete-account') {
                throw new SecurityError(403,'Verification was already used or expired. Start again.');
            }
            const link=await tx.get('identity:'+identity.userId);
            const meta=link ? await tx.get(accountKey(link.user)) : null;
            if (!meta || meta.owner_id!==identity.userId) throw new SecurityError(403,'Account ownership could not be verified.');
            meta.deleting=true; await tx.put(accountKey(link.user),meta);
            let approvalRemains=false;
            if (meta.legacy_disabled) {
                try { approvalRemains=Object.hasOwn(JSON.parse(this.env.LEGACY_MIGRATION_OWNERS || '{}'),link.user); }
                catch { approvalRemains=true; }
            }
            const active=await tx.get('phone-owner:'+encodeURIComponent(link.user));
            if (active) {
                // A recovery record contains only a digest-keyed, status-only expiry.
                await tx.put('phone:'+active.digest,{scope:'deleted-unlock',expires:recoveryUntil});
                await tx.delete('phone-owner:'+encodeURIComponent(link.user));
            }
            current.status='consumed'; await tx.put(proofKey,current);
            await tx.put(markerKey,{status:'pending',receipt:body.receipt,phone_recovery_until:recoveryUntil});
            if (meta.legacy_disabled) await tx.put('deleted-legacy:'+await sha256(link.user),{expires:recoveryUntil});
            await tx.put('deletion-status:'+statusHash,{status:'pending',accepted_at:accepted,phone_recovery_until:recoveryUntil});
            await tx.put('deletion-job:'+statusHash,{userId:identity.userId,user:link.user,statusHash,markerKey,
                legacy:meta.legacy_disabled===true,migration_approval_remains:approvalRemains,
                stage:'snapshots',cursor:null,legacy_cursor:null,
                accepted_at:accepted,phone_recovery_until:recoveryUntil});
        });
        await this.service.ensureAlarm(1000);
        // Return acceptance before external cleanup can revoke the browser session.
        return { accepted:true, receipt:body.receipt,status:'pending',phone_recovery_until:recoveryUntil };
    }
    async page(job,prefix,match) {
        const entries=await this.storage.list({prefix,limit:100,...(job.cursor?{startAfter:job.cursor}:{})});
        const keys=[...entries].filter(([key,value])=>!match || match(value,key)).map(([key])=>key);
        if (keys.length) await this.storage.delete(keys);
        job.cursor=entries.size ? [...entries.keys()].pop() : null;
        return entries.size<100;
    }
    async legacy(job) {
        if (!job.legacy) return true;
        const kv=this.env.TASKITATOR_KV;
        if (!kv?.list || !kv?.delete) throw new SecurityError(503,'Legacy storage cleanup is unavailable.');
        // The registration identifies its current snapshot even if that snapshot is malformed.
        if (!job.registration_deleted) {
            let registration;
            try { registration=await kv.get('user_reg:'+job.user,{type:'json'}); }
            catch { job.unreadable_legacy=true; }
            const token=typeof registration==='string'?registration:registration?.token_hash;
            if (typeof token==='string' && secretPattern.test(token)) await kv.delete('user_data:'+token);
            await kv.delete('user_reg:'+job.user);
            job.registration_deleted=true;
        }
        const page=await kv.list({prefix:'user_data:',limit:15,...(job.legacy_cursor?{cursor:job.legacy_cursor}:{})});
        for (const key of page.keys) {
            let record;
            try { record=await kv.get(key.name,{type:'json'}); }
            catch { job.unreadable_legacy=true; continue; }
            // Never delete a different user's data or guess ownership of corrupt records.
            const owner=record?.username || record?.settings?.worker_username;
            if (typeof owner==='string' && owner.trim().toLowerCase()===job.user) await kv.delete(key.name);
        }
        job.legacy_cursor=page.cursor || null;
        return page.list_complete===true;
    }
    async deleteClerk(userId) {
        const response=await fetch('https://api.clerk.com/v1/users/'+encodeURIComponent(userId),{
            method:'DELETE',headers:{Authorization:'Bearer '+this.env.CLERK_SECRET_KEY},signal:AbortSignal.timeout(10000)});
        if (!response.ok && response.status!==404) throw new SecurityError(503,'Authentication account cleanup is retrying.');
    }
    async run() {
        if (this.running) return;
        this.running=true;
        try {
            const jobs=await this.storage.list({prefix:'deletion-job:',limit:5});
            for (const [key,job] of jobs) {
                try {
                    let next=false;
                    if (job.stage==='snapshots') next=await this.page(job,'snapshot:'+encodeURIComponent(job.user)+':');
                    else if (job.stage==='credentials') next=await this.page(job,'credential:',value=>value?.user===job.user);
                    else if (job.stage==='proofs') next=await this.page(job,'action-proof:',value=>value?.userId===job.userId);
                    else if (job.stage==='vault') next=await this.page(job,'vault:'+await sha256(job.userId)+':');
                    else if (job.stage==='vault-stages') next=await this.page(job,'vault-stage:'+await sha256(job.userId)+':');
                    else if (job.stage==='hosted') next=await this.page(job,'pro:',(value,key)=>
                        ['pro:usage:','pro:spend:','pro:op:'].some(prefix=>key.startsWith(prefix+job.userId+':')) ||
                        key==='pro:user:username:'+job.userId ||
                        (key.startsWith('pro:username:map:') && value?.accountId===job.userId) ||
                        (key.startsWith('pro:attestation:') && value?.account_id===job.userId));
                    else if (job.stage==='legacy') next=await this.legacy(job);
                    else if (job.stage==='clerk') {
                        await this.deleteClerk(job.userId);
                        const completed=Date.now(), expires=completed+RECOVERY_MS;
                        await this.storage.transaction(async tx=>{
                            await tx.delete([accountKey(job.user),'identity:'+job.userId,
                                'rate:connect-user:'+job.userId,'rate:verify-user:'+job.userId,
                                'rate:ai-user:'+job.userId,'rate:key-test:'+job.userId,
                                'vault-cleanup:'+await sha256(job.userId)]);
                            await tx.put('deletion-status:'+job.statusHash,{status:'complete',accepted_at:job.accepted_at,
                                completed_at:completed,phone_recovery_until:job.phone_recovery_until,
                                legacy_review_needed:job.unreadable_legacy===true,
                                migration_approval_remains:job.migration_approval_remains===true,expires});
                            await tx.put(job.markerKey,{status:'complete',phone_recovery_until:job.phone_recovery_until,expires});
                            await tx.delete(key);
                        });
                        continue;
                    }
                    if (next) {
                        job.stage=({snapshots:'credentials',credentials:'proofs',proofs:'vault',vault:'vault-stages','vault-stages':'hosted',hosted:'legacy',legacy:'clerk'})[job.stage];
                        job.cursor=null;
                    }
                    await this.storage.put(key,job);
                } catch {
                    // Persist stage/cursor only after successful operations. All steps
                    // tolerate replay; accepted accounts remain inaccessible on failure.
                    await this.storage.put('deletion-status:'+job.statusHash,{status:'retrying',accepted_at:job.accepted_at,
                        phone_recovery_until:job.phone_recovery_until});
                }
            }
        } finally { this.running=false; }
    }
}

import { POLICY, periods, fail, digest, providerCost, charges, totalCredits, prepare, parseResult } from './audit-policy.js';

export class HostedAudits {
    constructor(gateway) { this.storage = gateway.storage; this.env = gateway.env; }
    headers() {
        const key = this.env.CLAUDE_API_KEY || this.env.ANTHROPIC_API_KEY;
        if (!key) throw fail(503,'AI_PROVIDER_ERROR','CLAUDE_API_KEY is not configured. Ask the operator to configure and redeploy the Worker.');
        return { 'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01' };
    }
    async entitled(store, account) {
        const e = await store.get('pro:entitlement:'+account);
        if (!e || e.status !== 'active' || (e.expires_at && e.expires_at <= Date.now()))
            throw fail(403,'PRO_REQUIRED','Active Taskitator Pro is required for hosted proof audits.');
        if (e.use_byok) throw fail(409,'BYOK_ACTIVE','Hosted review is disabled while personal-key mode is selected.');
    }
    async balance(store, account, period) {
        const dayKey = `pro:usage:${account}:day:${period.day}`, monthKey = `pro:usage:${account}:month:${period.month}`;
        const spendKey = `pro:spend:${account}:${period.month}`;
        const daily = (await store.get(dayKey)) || 0, monthly = (await store.get(monthKey)) || 0;
        // Historical flat credits have no provider usage. Carry their base-credit value as an estimate.
        const spend = (await store.get(spendKey)) ?? Math.ceil(monthly * POLICY.creditValue);
        return { dayKey,monthKey,spendKey,daily,monthly,spend };
    }
    async handle(account, session, body, batch, quoteOnly = false) {
        try { return { status:200, body: await this.run(account,session,body,batch,quoteOnly) }; }
        catch (e) { return {status:e.status || 503,body:{error:e.status ? e.message : 'Hosted review is temporarily unavailable. Retry the same operation.',code:e.code || 'HOSTED_UNAVAILABLE'}}; }
    }
    async run(account, session, body, batch, quoteOnly) {
        if (typeof session !== 'string' || !session) throw fail(401,'SESSION_REQUIRED','A current signed-in session is required for hosted audits.');
        const operation = body.operation_id;
        if (typeof operation !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(operation))
            throw fail(400,'OPERATION_REQUIRED','A unique operation ID is required. Reload and retry.');
        const {tasks,payload} = prepare(body,batch);
        const hash = await digest({payload,policy:POLICY.version,batch});
        const opKey = `pro:op:${account}:${operation}`;
        const matches = rec => {
            if (rec.version !== POLICY.version || rec.hash !== hash || rec.session !== session)
                throw fail(409,'OPERATION_CONFLICT','This operation belongs to a different payload or session. Start a new audit.');
        };
        await this.entitled(this.storage,account);
        const previous = await this.storage.get(opKey);
        if (previous) {
            matches(previous);
            if (previous.state === 'done' || previous.state === 'failed') {
                if (quoteOnly && previous.state === 'done') return {completed:true, result:previous.response};
                if (previous.state === 'failed') throw fail(previous.error.status,previous.error.code,previous.error.message);
                return previous.response;
            }
            if (previous.state === 'pending') throw fail(409,'AUDIT_PENDING','This audit is already running. Do not submit another copy. Retry the same operation later.');
        }
        const headers = this.headers();
        let rec = previous;
        if (quoteOnly) {
            if (!rec || rec.expires <= Date.now() || rec.period.day !== periods().day) {
                const {max_tokens,...countPayload} = payload;
                let response;
                try {
                    response = await fetch('https://api.anthropic.com/v1/messages/count_tokens',{
                        method:'POST',headers,body:JSON.stringify(countPayload),signal:AbortSignal.timeout(30000)});
                } catch { throw fail(503,'TOKEN_COUNT_UNAVAILABLE','Cannot check file token usage. No paid audit was started. Try a smaller file or retry later.'); }
                if (!response.ok) throw fail(503,'TOKEN_COUNT_UNAVAILABLE','The provider could not check these files. No paid audit was started. Reduce the file size/pages or retry later.');
                const count = (await response.json()).input_tokens;
                if (!Number.isSafeInteger(count) || count <= 0) throw fail(503,'TOKEN_COUNT_UNAVAILABLE','The provider returned an invalid token estimate. No audit was started.');
                // Token counts are estimates. Include 20% headroom within the 20k request limit.
                if (Math.ceil(count * 1.2) > POLICY.maxInput)
                    throw fail(413,'INPUT_TOKEN_LIMIT','This audit exceeds the 20,000 input-token safety limit (including a 20% counting margin). Split the PDF/pages or select fewer tasks. No paid audit was started.');
                const reservedCost = providerCost(POLICY.maxInput,payload.max_tokens);
                const taskCharges = charges(reservedCost,tasks,batch);
                rec = {version:POLICY.version,hash,session,state:'quoted',quote:crypto.randomUUID(),
                    expires:Date.now()+POLICY.quoteMs,period:periods(),input:count,reservedCost,
                    reservedCredits:totalCredits(taskCharges),taskCharges};
                rec = await this.storage.transaction(async tx => {
                    const current = await tx.get(opKey);
                    if (current && current.state !== 'quoted') { matches(current); throw fail(409,'AUDIT_PENDING','An audit already uses this operation. Retry the same operation later.'); }
                    if (current) matches(current);
                    if (current && current.expires > Date.now() && current.period.day === periods().day) return current;
                    await tx.put(opKey,rec); return rec;
                });
            }
            const b = await this.balance(this.storage,account,rec.period);
            this.checkBalance(b,rec);
            const estimated = charges(providerCost(rec.input,payload.max_tokens),tasks,batch);
            return {quote_id:rec.quote,expires_at:rec.expires,input_tokens:rec.input,
                max_output_tokens:payload.max_tokens,estimated_credits:totalCredits(estimated),
                maximum_credits:rec.reservedCredits,tasks:rec.taskCharges,
                batch_discount:batch && tasks.length >= 2 ? .25 : 0,model_used:POLICY.model};
        }
        if (!rec || body.quote_id !== rec.quote || rec.expires <= Date.now() || rec.period.day !== periods().day)
            throw fail(409,'QUOTE_REQUIRED','Request a current price preview before starting this audit.');
        await this.storage.transaction(async tx => {
            await this.entitled(tx,account);
            const current = await tx.get(opKey);
            if (!current || current.state !== 'quoted' || current.quote !== rec.quote || current.expires <= Date.now())
                throw fail(409,'AUDIT_PENDING','This price preview has expired or is already in use.');
            matches(current);
            const b = await this.balance(tx,account,rec.period);
            this.checkBalance(b,rec);
            await tx.put(b.dayKey,this.round(b.daily+rec.reservedCredits));
            await tx.put(b.monthKey,this.round(b.monthly+rec.reservedCredits));
            await tx.put(b.spendKey,b.spend+rec.reservedCost);
            current.state='pending'; await tx.put(opKey,current);
        });

        let actualCost = rec.reservedCost, charged = rec.reservedCredits, result, error;
        try {
            const response = await fetch('https://api.anthropic.com/v1/messages',{
                method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
            if (!response.ok) {
                // These statuses reject inference before billing. Uncertain failures retain the spend reserve.
                if ([400,401,403,404,413,422,429].includes(response.status)) actualCost=0;
                throw fail(502,'AI_PROVIDER_ERROR','The hosted provider could not complete this audit. No task was confirmed. Try again later.');
            }
            const data = await response.json();
            const usage = data.usage;
            if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
                !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 ||
                (usage.cache_creation_input_tokens || usage.cache_read_input_tokens))
                throw fail(502,'AI_PROVIDER_ERROR','The provider did not return usable billing information. No task was confirmed.');
            actualCost = providerCost(usage.input_tokens,usage.output_tokens);
            result = parseResult(data,tasks,batch);
            const perTask = charges(Math.min(actualCost,rec.reservedCost),tasks,batch);
            // A preview is also a customer-price ceiling. Any unexpected overage is absorbed by the operator.
            charged = Math.min(rec.reservedCredits,totalCredits(perTask));
            result = {success:true,...result,model_used:POLICY.model,credits_charged:charged,
                task_charges:perTask,operation_id:operation};
            if (batch) result.job_id='job_'+crypto.randomUUID();
        } catch (e) {
            charged=0;
            error={status:502,code:e.code || 'AI_PROVIDER_ERROR',message:e.status ? e.message :
                'The provider response was lost. No task was confirmed. The operation will not be sent twice; its spending reserve is retained.'};
        }
        const settled = await this.storage.transaction(async tx => {
            const current = await tx.get(opKey);
            if (current?.state !== 'pending') throw fail(409,'OPERATION_CONFLICT','Audit settlement was already recorded.');
            const b = await this.balance(tx,account,rec.period);
            const daily=this.round(Math.max(0,b.daily-rec.reservedCredits+charged));
            const monthly=this.round(Math.max(0,b.monthly-rec.reservedCredits+charged));
            await tx.put(b.dayKey,daily); await tx.put(b.monthKey,monthly);
            await tx.put(b.spendKey,Math.max(0,b.spend-rec.reservedCost+actualCost));
            if (result) {
                result.credits_remaining={daily:Math.max(0,POLICY.daily-daily),monthly:Math.max(0,POLICY.monthly-monthly)};
                if (batch) await tx.put('pro:attestation:'+result.job_id,{
                    job_id:result.job_id,account_id:account,eligible_task_ids:result.tasks.filter(t=>t.status==='eligible').map(t=>t.task_id),
                    created_at:Date.now(),expires_at:Date.now()+86400000,consumed:false});
            }
            await tx.put(opKey,{...current,state:error?'failed':'done',response:result,error,provider_cost:actualCost,
                settled_at:Date.now()});
            return result;
        });
        if (error) throw fail(error.status,error.code,error.message);
        return settled;
    }
    round(n) { return Math.round(n*1000)/1000; }
    checkBalance(b, rec) {
        if (b.spend+rec.reservedCost > POLICY.monthlySpend)
            throw fail(429,'HOSTED_SPEND_LIMIT','Your monthly hosted AI spending allowance is used or reserved. It resets on the first day of the month in Asia/Riyadh.');
        if (b.daily+rec.reservedCredits > POLICY.daily || b.monthly+rec.reservedCredits > POLICY.monthly)
            throw fail(429,'QUOTA_EXHAUSTED','Insufficient hosted credits for this audit’s maximum charge. Try fewer pages/tasks or wait for the Asia/Riyadh reset.');
    }
}

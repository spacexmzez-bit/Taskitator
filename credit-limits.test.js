// ============================================================================
// Taskitator credit limits & Keyo allowance tests (credit-limits.test.js)
// Free personal-key allowance, Pro hosted d_allow/m_allow, reset periods,
// Free<->Pro transitions, Keyo endpoint fallback and the Free limits card.
// ============================================================================
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import './worker.js';
import {
    ProGateway, TaskProtection, KEYO_DEFAULTS, keyoConfig, hostedAllowance, planOf, nextPlanState,
    ledgerFor, limitsState, halfUp, modelCost, FREE_BYOK, CYCLE_MS, PLAN_PREFIX, ALLOWANCE_VERSION,
    periods, POLICY, liveAccount
} from './pro-backend.js';

const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const publicKey = await crypto.subtle.exportKey('jwk',pair.publicKey);
const env = {KEYO_PUBLIC_JWK:JSON.stringify(publicKey),CLAUDE_API_KEY:'test-hosted-key'};
const DAY = 86400000;

async function token(accountId, overrides = {}) {
    const now = Date.now();
    const payload = {v:1,projectId:KEYO_DEFAULTS.projectId,accountId,keyId:'key_1',bindingId:'binding_'+accountId,
        tier:'PRO',expiresAt:now+30*DAY,issuedAt:now,validUntil:now+DAY,parameters:{d_allow:45,m_allow:1000},...overrides};
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = b64({alg:'ES256',typ:'KEYO'})+'.'+b64(payload);
    const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(input));
    return input+'.'+Buffer.from(sig).toString('base64url');
}
class Store {
    constructor() { this.data = new Map(); this.queue = Promise.resolve(); }
    async get(k) { return structuredClone(this.data.get(k)); }
    async put(k,v) { this.data.set(k,structuredClone(v)); }
    async delete(k) { this.data.delete(k); }
    async transaction(fn) {
        const next = this.queue.then(async () => {
            const before = structuredClone(this.data);
            try { return await fn(this); } catch (e) { this.data = before; throw e; }
        });
        this.queue = next.catch(() => {}); return next;
    }
}
// Keyo stand-in. mode: ok | network | revoked | http503; params override the signed parameters.
function harness(extraEnv = {}) {
    const storage = new Store();
    for (const id of ['user_A','user_B']) {
        storage.data.set('identity:'+id,{user:id});
        storage.data.set('account:'+encodeURIComponent(id),{owner_id:id,version:0});
    }
    const parent = {storage,env:{...env,...extraEnv},ensureAlarm:async()=>{}};
    parent.protection = new TaskProtection(parent);
    const gateway = new ProGateway(parent);
    const keyo = {mode:'ok',params:{d_allow:45,m_allow:1000},calls:[],extra:{}};
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const href = String(url);
        if (!href.includes('/api/v1/')) throw new Error('Unexpected network call: '+href);
        keyo.calls.push(new URL(href).origin);
        const mode = typeof keyo.mode === 'function' ? keyo.mode(href) : keyo.mode;
        if (mode === 'network') throw new TypeError('fetch failed');
        if (mode === 'revoked') return Response.json({error:'REVOKED'},{status:403});
        if (mode === 'http503') return Response.json({error:'BUSY'},{status:503});
        const {accountId} = JSON.parse(options.body);
        return Response.json({entitlement:await token(accountId,{parameters:keyo.params,...keyo.extra})});
    };
    const status = async (account='user_A') => (await gateway.getStatus(account)).json();
    const activate = async (account='user_A') => {
        const r = await gateway.activateLicense(account,{key:'A1B2C3D4E5F6G7H8'});
        return {status:r.status,body:await r.json()};
    };
    const plan = (account='user_A') => storage.get(PLAN_PREFIX+account);
    const ledger = async (account='user_A',now=Date.now()) => {
        const e = await storage.get('pro:entitlement:'+account);
        return ledgerFor(account,nextPlanState(await plan(account),planOf(e,now),now,e).state,e,now);
    };
    // Make the cached entitlement old enough that the next resolve re-verifies with Keyo.
    const age = async (account='user_A',hours=2) => {
        const e = await storage.get('pro:entitlement:'+account), parts = e.signed_token.split('.');
        const p = JSON.parse(Buffer.from(parts[1],'base64url'));
        const issuedAt = p.issuedAt-hours*3600000, validUntil = issuedAt+DAY-1;
        e.signed_token = await token(account,{...p,issuedAt,validUntil});
        e.valid_until = validUntil; await storage.put('pro:entitlement:'+account,e);
    };
    return {storage,gateway,keyo,status,activate,plan,ledger,age,restore:()=>{globalThis.fetch=previous;}};
}
async function withHarness(fn, extraEnv) { const h = harness(extraEnv); try { await fn(h); } finally { h.restore(); } }

// ---------------------------------------------------------------------------
// Keyo parameters
// ---------------------------------------------------------------------------
test('d_allow/m_allow must be non-negative safe integers; anything else invalidates the entitlement', () => {
    assert.deepEqual(hostedAllowance({parameters:{d_allow:45,m_allow:1000}}),{daily:45,monthly:1000});
    assert.deepEqual(hostedAllowance({parameters:{d_allow:0,m_allow:0,promotional:true}}),{daily:0,monthly:0});
    for (const parameters of [undefined,null,[],'x',{},{d_allow:45},{m_allow:1000},{d_allow:'45',m_allow:1000},
        {d_allow:45,m_allow:-1},{d_allow:1.5,m_allow:10},{d_allow:45,m_allow:null},{d_allow:NaN,m_allow:1},{d_allow:2e6,m_allow:1},
        {D_ALLOW:45,M_ALLOW:1000}])
        assert.equal(hostedAllowance({parameters}),null,JSON.stringify(parameters));
});
test('activation without valid Keyo parameters is rejected with a support message and stores nothing', async () => {
    for (const params of [undefined,{d_allow:45},{d_allow:-5,m_allow:100},{d_allow:'10',m_allow:'100'},{d_allow:4.5,m_allow:100}])
        await withHarness(async h => {
            h.keyo.params = params;
            const r = await h.activate();
            assert.equal(r.status,403); assert.equal(r.body.code,'LICENSE_PARAMETERS_INVALID');
            assert.match(r.body.error,/Contact support/);
            assert.equal(await h.storage.get('pro:entitlement:user_A'),undefined);
            assert.equal((await h.status()).isPro,false);
        });
});
test('Pro hosted limits are the verified d_allow and m_allow values, including per-key overrides', async () => withHarness(async h => {
    h.keyo.params = {d_allow:7,m_allow:70};
    const r = await h.activate(); assert.equal(r.status,200);
    assert.equal(r.body.credits_daily_limit,7); assert.equal(r.body.credits_monthly_limit,70);
    const s = await h.status();
    assert.equal(s.isPro,true); assert.equal(s.credits.daily_limit,7); assert.equal(s.credits.monthly_limit,70);
    assert.equal(s.credits.monthly_period,'30-day'); assert.equal(s.byok_credit_limits,false);
}));
test('a later invalid parameter locks hosted AI and Pro features without a transition or usage reset', async () => withHarness(async h => {
    await h.activate(); const before = await h.plan();
    const l = await h.ledger(); await h.storage.put(l.dayKey,4);
    await h.age(); h.keyo.params = {d_allow:45};
    const s = await h.status();
    assert.equal(s.isPro,false); assert.equal(s.status,'invalid_parameters'); assert.equal(s.code,'LICENSE_PARAMETERS_INVALID');
    assert.deepEqual(await h.plan(),before,'no epoch change for an unverifiable allowance');
    await assert.rejects(h.gateway.audits.entitled(h.storage,'user_A'),{code:'LICENSE_PARAMETERS_INVALID'});
    assert.equal((await h.ledger()).plan,'restricted','personal-key usage falls back to Free metering');
    assert.equal((await h.gateway.toggleByok('user_A',{use_byok:true})).status,403);
    // Keyo fixed: Pro resumes in the same epoch with its usage intact.
    h.keyo.params = {d_allow:45,m_allow:1000};
    const fixed = await h.status();
    assert.equal(fixed.isPro,true); assert.equal(fixed.credits.daily_used,4);
    assert.deepEqual(await h.plan(),before);
}));
test('lowering an allowance below usage blocks hosted AI without resetting usage; raising it resumes access', async () => withHarness(async h => {
    await h.activate(); const l = await h.ledger(); await h.storage.put(l.dayKey,6); await h.storage.put(l.monthKey,6);
    const epoch = (await h.plan()).epoch;
    await h.age(); h.keyo.params = {d_allow:5,m_allow:1000};
    let s = await h.status();
    assert.equal(s.credits.daily_limit,5); assert.equal(s.credits.daily_used,6); assert.equal(s.credits.daily_remaining,0);
    const b = await h.gateway.audits.balance(h.storage,'user_A');
    assert.throws(() => h.gateway.audits.checkBalance(b,{reservedCost:1,reservedCredits:.5}),{code:'QUOTA_EXHAUSTED'});
    await h.age(); h.keyo.params = {d_allow:9,m_allow:1000};
    s = await h.status(); assert.equal(s.credits.daily_remaining,3);
    h.gateway.audits.checkBalance(await h.gateway.audits.balance(h.storage,'user_A'),{reservedCost:1,reservedCredits:3});
    assert.equal((await h.plan()).epoch,epoch);
}));

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------
test('Free→Pro and Pro→Free each start a fresh epoch, including repeated switches', async () => withHarness(async h => {
    const free = await h.ledger();
    await h.storage.put(PLAN_PREFIX+'user_A',nextPlanState(null,'free',Date.now()).state);
    await h.storage.put(free.dayKey,9.5); await h.storage.put(free.monthKey,200);
    assert.equal((await h.gateway.credits.freeStatus('user_A')).state,'critical');
    await h.activate();
    let p = await h.plan(); assert.equal(p.plan,'pro'); assert.equal(p.epoch,2); assert.equal(p.transitions,1);
    const pro = await h.ledger(); await h.storage.put(pro.dayKey,30);
    assert.equal((await h.status()).credits.daily_remaining,15);
    // Verified revocation: Pro→Free gets a fresh 10/220 allowance.
    await h.age(); h.keyo.mode = 'revoked';
    const s = await h.status(); assert.equal(s.isPro,false);
    p = await h.plan(); assert.equal(p.plan,'free'); assert.equal(p.epoch,3);
    assert.equal((await h.gateway.credits.freeStatus('user_A')).state,'available');
    assert.equal((await h.ledger()).plan,'free');
    // Re-activation: Pro again with fresh hosted allowances and a new 30-day anchor.
    h.keyo.mode = 'ok';
    await h.activate();
    p = await h.plan(); assert.equal(p.epoch,4); assert.equal(p.transitions,3);
    assert.equal((await h.status()).credits.daily_remaining,45);
    // Earlier epochs remain stored untouched (no deletion of usage data).
    assert.equal(await h.storage.get(free.dayKey),9.5); assert.equal(await h.storage.get(pro.dayKey),30);
}));
test('routine refreshes, re-activation of the same Pro state and allowance edits never reset usage', async () => withHarness(async h => {
    await h.activate(); const first = await h.plan(); const l = await h.ledger(); await h.storage.put(l.dayKey,12);
    for (let i = 0; i < 3; i++) { await h.age(); await h.status(); }
    await h.activate();
    await h.age(); h.keyo.params = {d_allow:50,m_allow:900}; await h.status();
    const now = await h.plan();
    assert.equal(now.epoch,first.epoch); assert.equal(now.anchor,first.anchor);
    assert.equal((await h.status()).credits.daily_used,12);
}));
test('a temporary Keyo outage is never a downgrade: no transition, and an expired cache is metered without resetting', async () => withHarness(async h => {
    await h.activate(); const before = await h.plan();
    await h.age(); h.keyo.mode = 'network';
    assert.equal((await h.status()).isPro,true,'still-valid cache follows the existing offline policy');
    assert.deepEqual(await h.plan(),before);
    // Cache past its signed deadline while Keyo stays down.
    const e = await h.storage.get('pro:entitlement:user_A'); e.valid_until = Date.now()-1; await h.storage.put('pro:entitlement:user_A',e);
    assert.equal(planOf(e),'unknown');
    assert.deepEqual(await h.plan(),before);
    assert.equal((await h.ledger()).plan,'restricted');
    await assert.rejects(h.gateway.audits.entitled(h.storage,'user_A'),{code:'PRO_REQUIRED'});
}));
test('verified expiry is a Pro→Free transition even without contacting Keyo', () => {
    const now = Date.now(), base = {status:'active',signed_token:'t',keyo_version:1,allowance_version:ALLOWANCE_VERSION,
        hosted_allowance:{daily:1,monthly:2},tier:'pro',valid_until:now+1000,expires_at:now+1000};
    assert.equal(planOf(base,now),'pro');
    assert.equal(planOf({...base,expires_at:now-1},now),'free');
    assert.equal(planOf({...base,tier:'max'},now),'pro','MAX keeps the existing Pro mapping');
    assert.equal(planOf({...base,tier:'basic'},now),'unknown','unrelated tiers never get Pro');
    for (const status of ['revoked','invalid','expired','verification_required']) assert.equal(planOf({...base,status},now),'free');
    assert.equal(planOf(null,now),'free');
});
test('existing Pro accounts migrate with their stored activation date; missing dates use first verification time', async () => {
    const now = Date.parse('2026-11-03T06:00:00Z'), activated = Date.parse('2026-10-20T10:00:00Z');
    const e = {status:'active',signed_token:'t',keyo_version:1,allowance_version:ALLOWANCE_VERSION,hosted_allowance:{daily:1,monthly:1},
        tier:'pro',valid_until:now+1000,expires_at:null,activated_at:activated};
    const migrated = nextPlanState(null,'pro',now,e);
    assert.equal(migrated.state.anchor,activated); assert.equal(migrated.state.epoch,1); assert.equal(migrated.state.migrated,true);
    assert.equal(nextPlanState(null,'pro',now,{...e,activated_at:undefined}).state.anchor,now);
    assert.equal(nextPlanState(null,'pro',now,{...e,activated_at:now+DAY}).state.anchor,now,'a future date is not trusted');
    assert.deepEqual(nextPlanState(migrated.state,'pro',now+DAY,e),{state:migrated.state,changed:false});
    assert.deepEqual(nextPlanState(null,'unknown',now,e),{state:null,changed:false});
});
test('pre-release Pro records are re-derived from the signed token and keep their activation anchor', async () => withHarness(async h => {
    const old = {account_id:'user_A',status:'active',tier:'pro',signed_token:await token('user_A'),keyo_version:1,
        valid_until:Date.now()+DAY,expires_at:Date.now()+30*DAY,activated_at:Date.now()-10*DAY,credits_daily_limit:45,credits_monthly_limit:1000,use_byok:true};
    await h.storage.put('pro:entitlement:user_A',old);
    const s = await h.status();
    assert.equal(s.isPro,true); assert.equal(s.use_byok,true);
    const saved = await h.storage.get('pro:entitlement:user_A');
    assert.equal(saved.allowance_version,ALLOWANCE_VERSION); assert.deepEqual(saved.hosted_allowance,{daily:45,monthly:1000});
    assert.equal((await h.plan()).anchor,old.activated_at);
    assert.equal(h.keyo.calls.length,0,'a fresh cached token needs no Keyo call');
}));

// ---------------------------------------------------------------------------
// Reset periods
// ---------------------------------------------------------------------------
test('daily allowances reset exactly at midnight Asia/Riyadh', () => {
    const state = {plan:'free',epoch:3}, before = Date.parse('2026-11-03T20:59:59.999Z'), after = Date.parse('2026-11-03T21:00:00Z');
    const a = ledgerFor('u',state,null,before), b = ledgerFor('u',state,null,after);
    assert.notEqual(a.dayKey,b.dayKey); assert.equal(a.monthKey,b.monthKey);
    assert.equal(a.daily_resets_at,after);
});
test('Free monthly allowance follows the Gregorian Riyadh month: an Oct 29 downgrade refills again on Nov 1', () => {
    const oct29 = Date.parse('2026-10-29T09:00:00Z'), oct31 = Date.parse('2026-10-31T20:59:59Z'), nov1 = Date.parse('2026-10-31T21:00:00Z');
    const pro = {plan:'pro',epoch:4,anchor:Date.parse('2026-10-01T00:00:00Z')};
    const down = nextPlanState(pro,'free',oct29,null).state;
    assert.equal(down.epoch,5); assert.equal(down.anchor,null);
    const a = ledgerFor('u',down,null,oct29), b = ledgerFor('u',down,null,oct31), c = ledgerFor('u',down,null,nov1);
    assert.equal(a.monthKey,b.monthKey); assert.notEqual(b.monthKey,c.monthKey);
    assert.match(c.monthKey,/:e5:byok:month:2026-11$/);
    assert.equal(a.monthly_resets_at,nov1); assert.deepEqual(a.limits,FREE_BYOK);
});
test('Pro hosted cycles last 30 days from the stored anchor, not the calendar month', () => {
    const anchor = Date.parse('2026-10-15T08:00:00Z');
    const e = {status:'active',signed_token:'t',keyo_version:1,allowance_version:ALLOWANCE_VERSION,hosted_allowance:{daily:45,monthly:1000},
        tier:'pro',valid_until:anchor+70*DAY,expires_at:null};
    const state = {plan:'pro',epoch:2,anchor};
    const at = t => ledgerFor('u',state,{...e,valid_until:t+1000},t);
    assert.equal(at(anchor+CYCLE_MS-1).monthKey,at(anchor).monthKey);
    assert.notEqual(at(anchor+CYCLE_MS).monthKey,at(anchor).monthKey);
    assert.equal(at(Date.parse('2026-11-01T00:00:00Z')).monthKey,at(anchor).monthKey,'Nov 1 is not a Pro reset');
    assert.equal(at(anchor+45*DAY).cycle_started_at,anchor+CYCLE_MS);
    assert.equal(at(anchor).monthly_resets_at,anchor+CYCLE_MS);
});

// ---------------------------------------------------------------------------
// Free personal-key reservations
// ---------------------------------------------------------------------------
async function freeAccount(h) {
    await h.storage.put(PLAN_PREFIX+'user_A',nextPlanState(null,'free',Date.now()).state);
}
const claude = (inputTokens=1000,maxOutput=1024) => ({model:'claude-haiku-5-5',inputTokens,maxOutput});
test('Free daily limit cannot be overdrawn by simultaneous requests', async () => withHarness(async h => {
    await freeAccount(h);
    const results = await Promise.allSettled(Array.from({length:40},() => h.gateway.credits.reserveByok('user_A',claude())));
    const holds = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const total = holds.reduce((n,x) => n+x.hold,0);
    assert.equal(total,10); assert.ok(results.some(r => r.status === 'rejected' && r.reason.code === 'FREE_LIMIT_REACHED'));
    const l = await h.ledger(); assert.equal(await h.storage.get(l.dayKey),10); assert.equal(await h.storage.get(l.monthKey),10);
    await Promise.all(holds.map(x => h.gateway.credits.settleByok(x,.5)));
    assert.equal(await h.storage.get(l.dayKey),holds.length*.5);
}));
test('Free monthly limit is enforced together with the daily limit', async () => withHarness(async h => {
    await freeAccount(h); const l = await h.ledger(); await h.storage.put(l.monthKey,219.5);
    const hold = await h.gateway.credits.reserveByok('user_A',claude(100,256));
    assert.equal(hold.hold,.5);
    await assert.rejects(h.gateway.credits.reserveByok('user_A',claude(100,256)),e => e.code === 'FREE_LIMIT_REACHED' && /this month/.test(e.message));
    assert.equal(await h.storage.get(l.monthKey),220);
}));
test('Free output is clamped to what the remaining allowance can pay for; too little room is refused', async () => withHarness(async h => {
    await freeAccount(h);
    const hold = await h.gateway.credits.reserveByok('user_A',{model:'gemini-3.5-flash-lite',inputTokens:1200,maxOutput:16384});
    assert.ok(hold.maxOutput < 16384 && hold.maxOutput >= 256);
    assert.ok(hold.hold <= 10 && modelCost('gemini-3.5-flash-lite',1200,hold.maxOutput)/POLICY.creditValue <= hold.hold);
    const l = await h.ledger(); await h.storage.put(l.dayKey,9.5);
    await assert.rejects(h.gateway.credits.reserveByok('user_A',{model:'gemini-3.5-flash-lite',inputTokens:1200,maxOutput:16384}),{code:'FREE_LIMIT_REACHED'});
}));
test('settlement charges real usage in half steps, never above the hold, and only once', async () => withHarness(async h => {
    await freeAccount(h); const l = await h.ledger();
    const hold = await h.gateway.credits.reserveByok('user_A',claude(1000,4096));
    assert.equal(hold.hold,halfUp(modelCost('claude-haiku-5-5',1000,4096)/POLICY.creditValue));
    assert.equal(h.gateway.credits.usageCharge(hold,10,5),.5);
    assert.equal(h.gateway.credits.usageCharge(hold,10_000_000,10_000_000),hold.hold);
    await h.gateway.credits.settleByok(hold,.5); await h.gateway.credits.settleByok(hold,0);
    assert.equal(await h.storage.get(l.dayKey),.5);
}));
test('Claude over 100K input tokens uses the long-context rate for the whole request', () => {
    assert.equal(modelCost('claude-haiku-5-5',100_000,1000),100_000*100+1000*500);
    assert.equal(modelCost('claude-haiku-5-5',100_001,1000),100_001*500+1000*2500);
    assert.equal(modelCost('gemini-3.1-flash-lite',1000,1000),1000*250+1000*1500);
    assert.throws(() => modelCost('unknown-model',1,1),{code:'PRICING_UNAVAILABLE'});
});
test('Pro personal-key requests are not reserved or charged and do not touch hosted credits', async () => withHarness(async h => {
    await h.activate(); const l = await h.ledger(); await h.storage.put(l.dayKey,44.5);
    assert.equal(await h.gateway.credits.reserveByok('user_A',claude(500_000,16384)),null);
    assert.equal(await h.storage.get(l.dayKey),44.5);
}));
test('a request pending across a transition or period reset settles only into its original keys', async () => withHarness(async h => {
    await freeAccount(h); const free = await h.ledger();
    const hold = await h.gateway.credits.reserveByok('user_A',claude());
    await h.activate();
    const pro = await h.ledger(); assert.notEqual(pro.dayKey,free.dayKey);
    await h.gateway.credits.settleByok(hold,.5);
    assert.equal(await h.storage.get(free.dayKey),.5); assert.equal(await h.storage.get(pro.dayKey),undefined);
    assert.equal((await h.status()).credits.daily_remaining,45);
    // A hold from yesterday's key never lowers today's usage.
    await h.storage.put(free.dayKey,0);
    await h.gateway.credits.settleByok({...hold,settled:false},0);
    assert.equal(await h.storage.get(free.dayKey),0);
}));
test('accounts are isolated: one account cannot consume or read another account\'s allowance', async () => withHarness(async h => {
    await freeAccount(h);
    await h.storage.put(PLAN_PREFIX+'user_B',nextPlanState(null,'free',Date.now()).state);
    for (let i = 0; i < 20; i++) await h.gateway.credits.reserveByok('user_A',claude(10,64)).catch(() => {});
    assert.equal((await h.gateway.credits.freeStatus('user_A')).exhausted,true);
    assert.deepEqual(await h.gateway.credits.freeStatus('user_B'),{state:'available',exhausted:false,metered:true,reset_timezone:'Asia/Riyadh'});
}));
test('deleted accounts cannot reserve credits', async () => withHarness(async h => {
    await h.storage.delete('identity:user_A');
    await assert.rejects(h.gateway.credits.reserveByok('user_A',claude()));
}));

// ---------------------------------------------------------------------------
// Free limits card
// ---------------------------------------------------------------------------
test('Free card thresholds: >25% Available, 10%–25% inclusive Caution, <10% Critical, closest allowance wins', () => {
    const at = (daily,monthly=0) => limitsState(FREE_BYOK,{daily,monthly});
    assert.equal(at(0),'available');
    assert.equal(at(7.4),'available');       // 26% remaining
    assert.equal(at(7.5),'caution');         // exactly 25%
    assert.equal(at(9),'caution');           // exactly 10%
    assert.equal(at(9.5),'critical');        // 5%
    assert.equal(at(10),'critical');         // exhausted
    assert.equal(at(12),'critical');         // over-used after a lowered allowance
    assert.equal(at(0,165),'caution');       // monthly exactly 25%
    assert.equal(at(0,198),'caution');       // monthly exactly 10%
    assert.equal(at(0,198.5),'critical');
    assert.equal(at(7.5,198.5),'critical');
});
test('Free status exposes only the state, never numeric Free allowance or usage', async () => withHarness(async h => {
    await freeAccount(h); const l = await h.ledger(); await h.storage.put(l.dayKey,7.5);
    const s = await h.status();
    assert.equal(s.isPro,false); assert.equal(s.credits,null);
    assert.deepEqual(s.limits,{state:'caution',exhausted:false,metered:true,reset_timezone:'Asia/Riyadh'});
    assert.doesNotMatch(JSON.stringify(s),/7\.5|\b10\b|\b220\b|daily_|monthly_/);
    await h.storage.put(l.dayKey,10);
    assert.deepEqual((await h.status()).limits,{state:'critical',exhausted:true,metered:true,reset_timezone:'Asia/Riyadh'});
}));

// ---------------------------------------------------------------------------
// Keyo endpoints
// ---------------------------------------------------------------------------
test('Keyo uses the custom domain first and the workers.dev origin only after a network failure', async () => withHarness(async h => {
    assert.deepEqual(keyoConfig().endpoints,['https://keyo.mazendev.com','https://keyo-api.spacexmzez.workers.dev']);
    h.keyo.mode = href => href.startsWith('https://keyo.mazendev.com') ? 'network' : 'ok';
    assert.equal((await h.activate()).status,200);
    assert.deepEqual(h.keyo.calls,['https://keyo.mazendev.com','https://keyo-api.spacexmzez.workers.dev']);
}));
test('an HTTP response from the primary Keyo origin is never retried on the fallback', async () => withHarness(async h => {
    h.keyo.mode = href => href.startsWith('https://keyo.mazendev.com') ? 'http503' : 'ok';
    const r = await h.gateway.handleRequest(new Request('https://w.test/pro/activate',{method:'POST',body:JSON.stringify({key:'A1B2C3D4E5F6G7H8'})}),
        '/pro/activate','POST',{userId:'user_A'},{});
    assert.equal(r.status,503); assert.deepEqual(h.keyo.calls,['https://keyo.mazendev.com']);
    h.keyo.calls.length = 0; h.keyo.mode = href => href.startsWith('https://keyo.mazendev.com') ? 'revoked' : 'ok';
    assert.equal((await h.activate().catch(e => ({status:e.status}))).status,403);
    assert.deepEqual(h.keyo.calls,['https://keyo.mazendev.com']);
}));
test('fallback can be disabled or configured, and invalid fallback origins fail closed', () => {
    assert.deepEqual(keyoConfig({KEYO_FALLBACK_ORIGIN:''}).endpoints,['https://keyo.mazendev.com']);
    assert.deepEqual(keyoConfig({KEYO_API_ORIGIN:'https://keyo-api.spacexmzez.workers.dev'}).endpoints,['https://keyo-api.spacexmzez.workers.dev']);
    for (const value of ['http://keyo.test','https://keyo.test/path','https://u:p@keyo.test'])
        assert.throws(() => keyoConfig({KEYO_FALLBACK_ORIGIN:value}),{code:'KEYO_SETUP_REQUIRED'});
});

// ---------------------------------------------------------------------------
// Client tampering
// ---------------------------------------------------------------------------
test('browser-supplied Pro flags, limits or usage cannot grant Pro or raise allowances', async () => withHarness(async h => {
    await freeAccount(h);
    await h.gateway.toggleByok('user_A',{use_byok:true,isPro:true,d_allow:1e6});
    assert.equal(await h.storage.get('pro:entitlement:user_A'),undefined);
    const r = await h.gateway.handleRequest(new Request('https://w.test/pro/ai/quote',{method:'POST',
        body:JSON.stringify({operation_id:'op_x_12345678',task_id:'t',criteria:'c',files:[],isPro:true,credits:{daily_limit:999}})}),
        '/pro/ai/quote','POST',{userId:'user_A',sessionId:'sess_A'},{});
    assert.equal(r.status,403); assert.equal((await r.json()).code,'PRO_REQUIRED');
    // A forged token signed by another key is rejected and never becomes Pro.
    const other = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = b64({alg:'ES256',typ:'KEYO'})+'.'+b64({v:1,projectId:KEYO_DEFAULTS.projectId,accountId:'user_A',keyId:'k',bindingId:'b',tier:'PRO',
        expiresAt:null,issuedAt:Date.now(),validUntil:Date.now()+DAY,parameters:{d_allow:1e6,m_allow:1e6}});
    const forged = input+'.'+Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},other.privateKey,new TextEncoder().encode(input))).toString('base64url');
    await h.storage.put('pro:entitlement:user_A',{account_id:'user_A',status:'active',tier:'pro',signed_token:forged,keyo_version:1,
        valid_until:Date.now()+DAY,expires_at:null,allowance_version:ALLOWANCE_VERSION,hosted_allowance:{daily:1e6,monthly:1e6}});
    assert.equal((await h.status()).isPro,false);
    assert.equal((await h.storage.get('pro:entitlement:user_A')).status,'invalid');
}));
test('the Free BYOK allowance is a server constant', () => {
    assert.deepEqual(FREE_BYOK,{daily:10,monthly:220});
    assert.ok(Object.isFrozen(FREE_BYOK));
});

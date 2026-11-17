// ============================================================================
// App Pro (Android plan, Phase 4): Pro is stored per source. App Pro (developer switch today,
// Google Play later) counts on the website and in the app; Keyo Pro counts on the website only.
// ============================================================================
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import './worker.js';
import { ProGateway, TaskProtection, KEYO_DEFAULTS, PLAN_PREFIX, APP_PRO_PREFIX, DEV_APP_ALLOWANCE,
    entitlementFor, appEntitlement, planOf, clientOf } from './pro-backend.js';

const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const env = {KEYO_PUBLIC_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.publicKey)),CLAUDE_API_KEY:'test-hosted-key',DEV_PRO_SWITCH:'on'};
const DAY = 86400000;
async function token(accountId) {
    const now = Date.now();
    const payload = {v:1,projectId:KEYO_DEFAULTS.projectId,accountId,keyId:'key_1',bindingId:'binding_'+accountId,
        tier:'PRO',expiresAt:now+30*DAY,issuedAt:now,validUntil:now+DAY,parameters:{d_allow:45,m_allow:1000}};
    const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
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
        const next = this.queue.then(async () => { const before = structuredClone(this.data);
            try { return await fn(this); } catch (e) { this.data = before; throw e; } });
        this.queue = next.catch(() => {}); return next;
    }
}
const APP = {userId:'user_A',sessionId:'sess_A1',native:true};
const WEB = {userId:'user_A',sessionId:'sess_W1',native:false};
async function withHarness(fn) {
    const storage = new Store();
    storage.data.set('identity:user_A',{user:'user_A'});
    storage.data.set('account:user_A',{owner_id:'user_A',version:0});
    const parent = {storage,env,ensureAlarm:async()=>{}};
    parent.protection = new TaskProtection(parent);
    const gateway = new ProGateway(parent);
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        if (!String(url).includes('/api/v1/')) throw new Error('Unexpected network call: '+url);
        return Response.json({entitlement:await token(JSON.parse(options.body).accountId)});
    };
    const call = async (identity, path, method='GET', body) => {
        const r = await gateway.handleRequest(new Request('https://w.test'+path,{method,
            ...(body ? {body:JSON.stringify(body),headers:{'Content-Type':'application/json'}} : {})}),path,method,identity,{user:'user_A'});
        return {status:r.status,body:await r.json()};
    };
    const status = async identity => (await call(identity,'/pro/status')).body;
    const dev = enabled => call(APP,'/pro/dev','POST',{enabled});
    const keyo = async () => assert.equal((await gateway.activateLicense('user_A',{key:'A1B2C3D4E5F6G7H8'})).status,200);
    const epoch = async () => (await storage.get(PLAN_PREFIX+'user_A'))?.epoch;
    try { await fn({storage,gateway,parent,call,status,dev,keyo,epoch}); } finally { globalThis.fetch = previous; }
}

test('the app is identified by its native session, the website by everything else', () => {
    assert.equal(clientOf(APP),'android'); assert.equal(clientOf(WEB),'web'); assert.equal(clientOf(null),'web');
});

test('developer switch turns app Pro on and off, and app Pro also counts on the website', async () => withHarness(async h => {
    assert.equal((await h.status(APP)).isPro,false);
    const on = await h.dev(true);
    assert.equal(on.status,200); assert.equal(on.body.isPro,true); assert.equal(on.body.source,'app');
    assert.equal(on.body.credits.daily_limit,DEV_APP_ALLOWANCE.daily); assert.equal(on.body.credits.monthly_limit,DEV_APP_ALLOWANCE.monthly);
    assert.equal(on.body.sources.app.active,true); assert.equal(on.body.sources.app.source,'dev');
    assert.ok(on.body.themes);
    const web = await h.status(WEB);
    assert.equal(web.isPro,true); assert.equal(web.source,'app');
    assert.deepEqual(on.body.entitlements,{web:true,app:true}); assert.deepEqual(web.entitlements,{web:true,app:true});
    const off = await h.dev(false);
    assert.equal(off.body.isPro,false); assert.equal(off.body.source,null);
    assert.equal((await h.status(WEB)).isPro,false);
    assert.equal(await h.storage.get(APP_PRO_PREFIX+'user_A'),undefined);
}));

test('developer switch is app only and needs a true or false value', async () => withHarness(async h => {
    const web = await h.call(WEB,'/pro/dev','POST',{enabled:true});
    assert.equal(web.status,403); assert.equal(web.body.code,'APP_ONLY');
    assert.equal((await h.call(APP,'/pro/dev','POST',{enabled:'yes'})).status,400);
    assert.equal((await h.status(APP)).isPro,false);
}));

test('website-only (Keyo) Pro is Free in the app and Pro on the website', async () => withHarness(async h => {
    await h.keyo();
    const web = await h.status(WEB), app = await h.status(APP);
    assert.equal(web.isPro,true); assert.equal(web.source,'keyo');
    assert.equal(app.isPro,false); assert.equal(app.credits,null);
    assert.equal(app.sources.keyo.active,true); assert.deepEqual(app.sources.keyo.platforms,['web']);
    assert.equal(app.sources.app.active,false);
    assert.deepEqual(app.entitlements,{web:true,app:false}); assert.deepEqual(web.entitlements,{web:true,app:false});
}));

test('switching between the app and the website never restarts the credit period', async () => withHarness(async h => {
    await h.keyo(); await h.status(WEB); const start = await h.epoch();
    for (let i = 0; i < 3; i++) { await h.status(APP); await h.status(WEB); }
    assert.equal(await h.epoch(),start);
    await h.dev(true); assert.equal(await h.epoch(),start); // already Pro account-wide
    await h.dev(false); assert.equal(await h.epoch(),start); // Keyo still active
}));

test('turning app Pro on and off is one Free-to-Pro and one Pro-to-Free change', async () => withHarness(async h => {
    await h.status(APP); const start = (await h.epoch()) ?? 0; // status never writes the period
    await h.dev(true); assert.equal(await h.epoch(),start+1);
    await h.dev(true); assert.equal(await h.epoch(),start+1);
    await h.dev(false); assert.equal(await h.epoch(),start+2);
}));

test('Pro feature checks follow the client: early bonus, dynamic priority and study edits', async () => withHarness(async h => {
    const p = h.parent.protection;
    await h.keyo();
    assert.equal(await p.proActive(h.storage,'user_A','web'),true);
    assert.equal(await p.proActive(h.storage,'user_A','android'),false);
    await h.dev(true);
    assert.equal(await p.proActive(h.storage,'user_A','android'),true);
    await h.storage.delete('pro:entitlement:user_A');
    assert.equal(await p.proActive(h.storage,'user_A','web'),true);
}));

test('hosted AI checks follow the client', async () => withHarness(async h => {
    const audits = h.gateway.audits;
    await h.keyo();
    await assert.rejects(audits.entitled(h.storage,'user_A','android'),e => e.code === 'PRO_REQUIRED');
    assert.ok(await audits.entitled(h.storage,'user_A','web'));
    await h.dev(true);
    assert.equal((await audits.entitled(h.storage,'user_A','android')).source,'app');
    const {ledger} = await h.gateway.credits.state(h.storage,'user_A',Date.now(),'android');
    assert.equal(ledger.plan,'pro'); assert.equal(ledger.limits.daily,DEV_APP_ALLOWANCE.daily);
}));

test('website-only Pro gets Free personal-key limits in the app, not restricted ones', async () => withHarness(async h => {
    await h.keyo(); await h.status(WEB);
    const {ledger} = await h.gateway.credits.state(h.storage,'user_A',Date.now(),'android');
    assert.equal(ledger.plan,'free'); assert.equal(ledger.bucket,'byok');
}));

test('personal-key mode can be chosen for app Pro', async () => withHarness(async h => {
    await h.dev(true);
    const r = await h.call(APP,'/pro/byok','POST',{use_byok:true});
    assert.equal(r.status,200); assert.equal(r.body.use_byok,true);
    assert.equal((await h.storage.get(APP_PRO_PREFIX+'user_A')).use_byok,true);
    assert.equal((await h.status(APP)).use_byok,true);
    await assert.rejects(h.gateway.audits.entitled(h.storage,'user_A','android'),e => e.code === 'BYOK_ACTIVE');
    assert.equal((await h.call(APP,'/pro/byok','POST',{use_byok:false})).body.use_byok,false);
}));

test('study re-plan and recurrence checks follow the client', async () => withHarness(async h => {
    const universe = {service:{pro:h.gateway,storage:h.storage}};
    const { UniverseService } = await import('./pro-backend.js');
    const entitlement = UniverseService.prototype.entitlement.bind(universe);
    await h.keyo();
    assert.equal(await entitlement(WEB),true); assert.equal(await entitlement(APP),false);
    await h.dev(true);
    assert.equal(await entitlement(APP),true);
}));

test('app records are read strictly', () => {
    const now = Date.now();
    assert.equal(appEntitlement(null,'user_A',now),null);
    assert.equal(appEntitlement({account_id:'user_B',active:true},'user_A',now),null);
    assert.equal(appEntitlement({account_id:'user_A',active:false},'user_A',now),null);
    assert.equal(appEntitlement({account_id:'user_A',active:true,expires_at:now-1},'user_A',now),null);
    const e = appEntitlement({account_id:'user_A',active:true,expires_at:null,source:'dev'},'user_A',now);
    assert.equal(planOf(e,now),'pro'); assert.equal(e.source,'app');
    assert.equal(planOf({...e,valid_until:now-1},now),'free');
});

test('an unreachable Keyo does not block app Pro status', async () => withHarness(async h => {
    await h.dev(true);
    await h.storage.put('pro:entitlement:user_A',{account_id:'user_A',signed_token:'x.y.z',status:'active',keyo_version:1});
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    const s = await h.status(APP);
    assert.equal(s.isPro,true); assert.equal(s.source,'app');
    assert.ok(await entitlementFor(h.storage,'user_A','android'));
}));

test('Pro status tells the app how AI runs, never the key itself', async () => withHarness(async h => {
    h.parent.vault = {selectedProvider:async () => 'claude',
        providerMetadata:async (_i,p) => ({provider:p,models:['claude-haiku-5-5'],saved:true,version:'v7',suffix:'abcd'})};
    h.parent.ai = {hostedFor:async identity => Boolean(await entitlementFor(h.storage,identity.userId,clientOf(identity)))};
    let s = await h.status(APP);
    assert.deepEqual(s.ai,{hosted:false,selected_provider:'claude',models:['claude-haiku-5-5'],key_saved:true,key_version:'v7'});
    assert.equal(JSON.stringify(s).includes('abcd'),false);
    s = (await h.dev(true)).body;
    assert.equal(s.ai.hosted,true);
    delete h.parent.vault;
    assert.equal((await h.status(APP)).ai,null);
}));

// ---- Review fixes (phase 4 review) ----
import { refreshKeyo, devProOn } from './pro-backend.js';

test('developer switch exists only when DEV_PRO_SWITCH is on, and then works for any account', async () => withHarness(async h => {
    for (const v of [undefined, '', 'off', 'true']) {
        h.gateway.env = {...env, DEV_PRO_SWITCH:v};
        assert.equal((await h.dev(true)).status,404,String(v));
    }
    assert.equal(await h.storage.get(APP_PRO_PREFIX+'user_A'),undefined);
    assert.equal((await h.status(APP)).isPro,false);
    h.gateway.env = {...env, DEV_PRO_SWITCH:'on'};
    assert.equal((await h.dev(true)).status,200);
    assert.equal((await h.status(APP)).isPro,true);
    assert.equal((await h.dev(false)).body.isPro,false);
    assert.equal(devProOn({DEV_PRO_SWITCH:'ON'}),true);
}));

test('a Free app session cannot change the website Keyo Pro personal-key setting', async () => withHarness(async h => {
    await h.keyo();
    const before = (await h.storage.get('pro:entitlement:user_A')).use_byok;
    const r = await h.call(APP,'/pro/byok','POST',{use_byok:true});
    assert.equal(r.status,403); assert.equal(r.body.code,'PRO_REQUIRED');
    assert.equal((await h.storage.get('pro:entitlement:user_A')).use_byok,before);
    assert.equal((await h.call(WEB,'/pro/byok','POST',{use_byok:true})).status,200,'the website still can');
}));

test('a Keyo failure never blocks app Pro: app skips Keyo, website with app Pro ignores the error', async () => withHarness(async h => {
    await h.dev(true);
    await h.storage.put('pro:entitlement:user_A',{account_id:'user_A',signed_token:'x.y.z',status:'active',keyo_version:1});
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
    const lic = {resolve:async () => { calls++; throw Object.assign(new Error('Keyo down'),{code:'KEYO_UNAVAILABLE',status:503}); }};
    assert.equal(await refreshKeyo(lic,h.storage,'user_A','android'),null);
    assert.equal(calls,0,'the app never calls Keyo');
    assert.equal(await refreshKeyo(lic,h.storage,'user_A','web'),null);
    await h.storage.delete(APP_PRO_PREFIX+'user_A');
    assert.equal((await refreshKeyo(lic,h.storage,'user_A','web')).code,'KEYO_UNAVAILABLE','without app Pro the Keyo error still counts');
    await h.dev(true);
    // Hosted audits: the request gets past the Pro check and fails later, on the (missing) task, not on Keyo.
    calls = 0;
    const r = await h.gateway.audits.handle('user_A','sess_A1',{operation_id:'op_review_fix_1',task_id:'missing'},false,true,'android');
    assert.equal(calls,0); assert.notEqual(r.body.code,'PRO_REQUIRED'); assert.ok(!/keyo/i.test(r.body.error||''),r.body.error);
    // Universe (re-plan / recurrence) on the website: app Pro answers without Keyo.
    const { UniverseService } = await import('./pro-backend.js');
    const entitlement = UniverseService.prototype.entitlement.bind({service:{pro:h.gateway,storage:h.storage}});
    assert.equal(await entitlement(WEB),true); assert.equal(calls,0);
}));

// ---- Audit L11 ----
test('audit L11: license activation is throttled per account before the licensing service is called', async () => withHarness(async h => {
    const buckets = [];
    h.parent.rateBucket = async (key, max) => { buckets.push([key, max]); if (buckets.length > 5) throw Object.assign(new Error('Too many attempts. Wait one minute and try again.'), {status:429, code:'RATE'}); };
    let keyoCalls = 0; const inner = globalThis.fetch;
    globalThis.fetch = async (...a) => { keyoCalls++; return inner(...a); };
    try {
        for (let i = 0; i < 5; i++) assert.equal((await h.call(APP,'/pro/activate','POST',{key:'A1B2C3D4E5F6G7H8'})).status,200);
        const before = keyoCalls;
        const refused = await h.call(APP,'/pro/activate','POST',{key:'A1B2C3D4E5F6G7H8'});
        assert.equal(refused.status,429); assert.equal(refused.body.code,'RATE_LIMITED');
        assert.equal(keyoCalls, before, 'a throttled attempt never reaches the licensing service');
        assert.deepEqual(buckets[0], ['activate:user_A', 5]);
    } finally { globalThis.fetch = inner; }
}));

// ============================================================================
// Taskitator Pro hosted AI tests (hosted-ai.test.js)
// Pro accounts not in personal-key mode use Taskitator's hosted key for Copilot, notes
// and criteria validation, with hidden per-account daily caps and a spend backstop.
// ============================================================================
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway, HOSTED_AI, UNAVAILABLE, hostedBucket } from './worker.js';
import { ProGateway, TaskProtection, KEYO_DEFAULTS, periods } from './pro-backend.js';

const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const env = {KEYO_PUBLIC_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.publicKey)),CLAUDE_API_KEY:'test-hosted-key'};
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
        const next = this.queue.then(async () => { const before = structuredClone(this.data); try { return await fn(this); } catch (e) { this.data = before; throw e; } });
        this.queue = next.catch(() => {}); return next;
    }
}
// Keyo and Anthropic stand-ins. provider.mode: ok | error | timeout; provider.tokens: counted input.
async function setup() {
    const storage = new Store();
    for (const id of ['user_A','user_B']) { storage.data.set('identity:'+id,{user:id}); storage.data.set('account:'+encodeURIComponent(id),{owner_id:id,version:0}); }
    const parent = {storage,env,ensureAlarm:async()=>{}};
    parent.protection = new TaskProtection(parent);
    const pro = new ProGateway(parent);
    const provider = {mode:'ok',tokens:1200,output:{reply:'ok'},calls:[],usage:{input_tokens:1200,output_tokens:300}};
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const href = String(url);
        if (href.includes('/api/v1/')) { const {accountId} = JSON.parse(options.body); return Response.json({entitlement:await token(accountId)}); }
        if (!href.startsWith('https://api.anthropic.com/')) throw new Error('Unexpected network call: '+href);
        provider.calls.push({href,key:options.headers['x-api-key'],body:JSON.parse(options.body)});
        if (href.endsWith('/count_tokens')) return Response.json({input_tokens:provider.tokens});
        if (provider.mode === 'timeout') throw new TypeError('fetch failed');
        if (provider.mode === 'error') return Response.json({error:{message:'overloaded'}},{status:529});
        return Response.json({stop_reason:'end_turn',content:[{type:'text',text:typeof provider.output==='string'?provider.output:JSON.stringify(provider.output)}],usage:provider.usage});
    };
    const service = {storage,pro,rateBucket:async()=>{},vault:{assertOwner:async()=>{throw new Error('vault must not be used in hosted mode');}}};
    const ai = new AIGateway(service);
    const activate = async (account='user_A') => assert.equal((await pro.activateLicense(account,{key:'A1B2C3D4E5F6G7H8'})).status,200);
    const ask = (format, account='user_A') => ai.generate({userId:account},{provider:'gemini',model:'gemini-3.5-flash-lite',
        payload:{...(format?{taskitatorFormat:format}:{}),contents:[{role:'user',parts:[{text:'Hello'}]}],generationConfig:{maxOutputTokens:9000}}});
    const counter = (bucket, account='user_A') => storage.get(`ai-hosted:${account}:${periods().day}:${bucket}`);
    return {storage,pro,ai,provider,activate,ask,counter,restore:()=>{globalThis.fetch=previous;}};
}
async function run(fn) { const h = await setup(); try { await fn(h); } finally { h.restore(); } }
const rejects = async (promise, status, message) => {
    await assert.rejects(promise, e => { assert.equal(e.status, status); if (message) assert.match(e.message, message); return true; });
};

test('Pro without a key uses hosted AI for Copilot, notes and validation; Free and personal-key Pro do not', () => run(async h => {
    assert.equal(await h.ai.hostedFor({userId:'user_A'}),false,'Free account');
    await h.activate();
    assert.equal(await h.ai.hostedFor({userId:'user_A'}),true);
    const copilot = await h.ask();
    assert.equal(copilot.candidates[0].content.parts[0].text,JSON.stringify({reply:'ok'}));
    const call = h.provider.calls.find(c => c.href.endsWith('/v1/messages'));
    assert.equal(call.key,'test-hosted-key'); assert.equal(call.body.model,HOSTED_AI.model);
    assert.equal(call.body.max_tokens,HOSTED_AI.maxOutput,'output is capped');
    h.provider.output = {score:8,passed:true,critique:'Clear.',suggested_rewrite:''};
    assert.equal(JSON.parse((await h.ask('criteria')).candidates[0].content.parts[0].text).score,8);
    h.provider.output = {notes:[{id:1,title:'A',clean_text:'B'}]};
    await h.ask('notes');
    assert.equal(await h.counter('copilot'),2,'Copilot and notes share the Copilot bucket');
    assert.equal(await h.counter('validation'),1);
    assert.deepEqual([hostedBucket(undefined),hostedBucket('notes'),hostedBucket('criteria')],['copilot','copilot','validation']);
    // Switching to personal-key mode turns hosted AI off.
    const e = await h.storage.get('pro:entitlement:user_A'); e.use_byok = true; await h.storage.put('pro:entitlement:user_A',e);
    assert.equal(await h.ai.hostedFor({userId:'user_A'}),false);
    await assert.rejects(h.ask(),/vault must not be used/,'falls through to the personal-key path');
}));

test('hidden daily caps: 30 validations and 500 Copilot requests, then "Service unavailable temporarily"', () => run(async h => {
    await h.activate();
    h.provider.output = {score:9,passed:true,critique:'Good.',suggested_rewrite:''};
    for (let i = 0; i < HOSTED_AI.daily.validation; i++) await h.ask('criteria');
    assert.deepEqual(HOSTED_AI.daily,{validation:30,copilot:500});
    const before = h.provider.calls.length;
    await rejects(h.ask('criteria'),503,/^Service unavailable temporarily\.$/);
    assert.equal(h.provider.calls.length,before+1,'only the free token count ran; no generation was sent');
    assert.equal(await h.counter('validation'),30);
    h.provider.output = {reply:'still fine'};
    await h.ask();
    await h.storage.put(`ai-hosted:user_A:${periods().day}:copilot`,500);
    await rejects(h.ask(),503,/Service unavailable temporarily/);
    await rejects(h.ask('notes'),503,/Service unavailable temporarily/);
    assert.equal(UNAVAILABLE,'Service unavailable temporarily.');
    // Another account is unaffected.
    await h.activate('user_B');
    await h.ask(undefined,'user_B');
}));

test('the caps reset at Riyadh midnight and there is no monthly cap', () => run(async h => {
    await h.activate();
    const realNow = Date.now, base = Date.parse('2026-11-04T20:59:00Z'); // 23:59 Riyadh
    try {
        Date.now = () => base;
        await h.storage.put(`ai-hosted:user_A:${periods(base).day}:validation`,30);
        h.provider.output = {score:9,passed:true,critique:'Good.',suggested_rewrite:''};
        await rejects(h.ask('criteria'),503);
        Date.now = () => base + 2 * 60000; // 00:01 Riyadh, next day
        assert.notEqual(periods().day,periods(base).day);
        await h.ask('criteria');
    } finally { Date.now = realNow; }
}));

test('a request that never produced an answer does not use a slot; a too-long request is refused first', () => run(async h => {
    await h.activate();
    h.provider.mode = 'error';
    await rejects(h.ask(),503,/Service unavailable temporarily/);
    h.provider.mode = 'timeout';
    await rejects(h.ask(),504);
    assert.equal(await h.counter('copilot'),0);
    h.provider.mode = 'ok'; h.provider.tokens = HOSTED_AI.maxInput + 1;
    await rejects(h.ask(),413,/too long/);
    assert.equal(await h.counter('copilot'),0);
    // A completed answer that fails output checks still counts (the provider was paid).
    h.provider.tokens = 100; h.provider.output = 'not json';
    await rejects(h.ask('criteria'),502);
    assert.equal(await h.counter('validation'),1);
}));

test('the daily spend backstop refuses silently and spend is recorded from provider usage', () => run(async h => {
    await h.activate();
    await h.ask();
    const spendKey = `ai-hosted:user_A:${periods().day}:spend`;
    assert.equal(await h.storage.get(spendKey),1200 * 100 + 300 * 500);
    await h.storage.put(spendKey,HOSTED_AI.dailySpend);
    await rejects(h.ask(),503,/^Service unavailable temporarily\.$/);
    // Hosted AI never touches the account's credit allowances.
    assert.equal([...h.storage.data.keys()].some(k => k.startsWith('credits:user_A') && !k.startsWith('credits:plan')),false);
}));

test('proof formats are not served by the hosted generate route', () => run(async h => {
    await h.activate();
    await rejects(h.ask('proof'),409,/hosted review service/);
    await rejects(h.ask('batch-proof'),409);
    assert.equal(h.provider.calls.length,0);
}));

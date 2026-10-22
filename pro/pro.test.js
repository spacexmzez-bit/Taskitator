// File: pro/pro.test.js
// Unit & Integration Tests for Taskitator Pro Phase 2 Backend

import crypto from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: crypto.webcrypto, configurable: true });

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProGateway } from './pro-backend.js';

class MockStorage {
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
    const storage = new MockStorage();
    const env = {
        ALLOWED_ORIGINS: 'https://taskitator.mazendev.com',
        CLAUDE_API_KEY: 'mock_claude_api_key_test',
        ...envOverrides
    };
    const parent = { storage, env };
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

test('Phase 2: Cross-account key theft blocked with 409', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'KEY1-KEY2-KEY3-KEY4' }),
        '/pro/activate', 'POST', { userId: 'u_owner1' }, {}
    );
    const stealRes = await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'KEY1-KEY2-KEY3-KEY4' }),
        '/pro/activate', 'POST', { userId: 'u_owner2' }, {}
    );
    assert.equal(stealRes.status, 409);
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

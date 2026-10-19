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
        return await closure(this);
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

test('Phase 2: Single-file hosted review targets Claude Haiku 5.5 and charges 1 credit', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2C3D4E5F6G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_pro' }, {}
    );

    const revRes = await pro.handleRequest(
        makeReq('/pro/ai/review', 'POST', {
            task_id: 't1',
            task_title: 'Solve calculus set',
            criteria: 'Handwritten solutions',
            file: { mime_type: 'image/png', data: 'aGVsbG8=' },
            operation_id: 'op_single_1'
        }),
        '/pro/ai/review', 'POST', { userId: 'u_pro' }, {}
    );
    assert.equal(revRes.status, 200);
    const revData = await revRes.json();
    assert.equal(revData.verdict, 'approved');
    assert.equal(revData.model_used, 'claude-haiku-5-5');
    assert.equal(revData.credits_charged, 1);
    assert.equal(revData.credits_remaining.daily, 44);
    assert.equal(revData.credits_remaining.monthly, 999);
});

test('Phase 2: Multi-file proof review accepts up to 5 files and charges 2 credits', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2C3D4E5F6G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_pro' }, {}
    );

    const revRes = await pro.handleRequest(
        makeReq('/pro/ai/review', 'POST', {
            task_id: 't_multi',
            task_title: 'Lab Report',
            criteria: 'Pages 1 to 3',
            files: [
                { mime_type: 'image/jpeg', data: 'YWJj' },
                { mime_type: 'application/pdf', data: 'ZGVm' },
                { mime_type: 'image/webp', data: 'Z2hp' }
            ],
            operation_id: 'op_multi_1'
        }),
        '/pro/ai/review', 'POST', { userId: 'u_pro' }, {}
    );
    assert.equal(revRes.status, 200);
    const revData = await revRes.json();
    assert.equal(revData.credits_charged, 2);
    assert.equal(revData.credits_remaining.daily, 43);

    // > 5 files rejected with 400
    const tooManyRes = await pro.handleRequest(
        makeReq('/pro/ai/review', 'POST', {
            task_id: 't_too_many',
            criteria: 'Too many',
            files: new Array(6).fill({ mime_type: 'image/png', data: 'YWJj' })
        }),
        '/pro/ai/review', 'POST', { userId: 'u_pro' }, {}
    );
    assert.equal(tooManyRes.status, 400);
});

test('Phase 2: Batch proof review evaluates multiple tasks and issues verifiable attestation', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2C3D4E5F6G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_batch' }, {}
    );

    const batchRes = await pro.handleRequest(
        makeReq('/pro/ai/batch-review', 'POST', {
            tasks: [
                { id: 'task_1', title: 'Chapter 1 Notes', criteria: 'Dated summary' },
                { id: 'task_2', title: 'Chapter 2 Quiz', criteria: 'Score >= 80%' }
            ],
            files: [{ mime_type: 'application/pdf', data: 'cGRmZGF0YQ==' }]
        }),
        '/pro/ai/batch-review', 'POST', { userId: 'u_batch' }, {}
    );
    assert.equal(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.equal(batchData.success, true);
    assert.equal(batchData.credits_charged, 2);
    assert.equal(batchData.tasks.length, 2);
    assert.equal(batchData.tasks[0].status, 'eligible');
    assert.equal(batchData.tasks[1].status, 'rejected');

    // Confirm batch: only eligible task_1 is confirmed; rejected task_2 is filtered out
    const confRes = await pro.handleRequest(
        makeReq('/pro/ai/batch-confirm', 'POST', {
            job_id: batchData.job_id,
            task_ids: ['task_1', 'task_2']
        }),
        '/pro/ai/batch-confirm', 'POST', { userId: 'u_batch' }, {}
    );
    assert.equal(confRes.status, 200);
    const confData = await confRes.json();
    assert.deepEqual(confData.confirmed_task_ids, ['task_1']);
});

test('Phase 2: BYOK mode toggle preserves hosted credit counters without resetting limits', async () => {
    const { pro } = createHarness();
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2C3D4E5F6G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_byok' }, {}
    );

    // Spend 1 hosted credit first
    await pro.handleRequest(
        makeReq('/pro/ai/review', 'POST', {
            task_id: 't1',
            criteria: 'Check',
            file: { mime_type: 'image/png', data: 'YWJj' }
        }),
        '/pro/ai/review', 'POST', { userId: 'u_byok' }, {}
    );

    // Enable BYOK
    const byokRes = await pro.handleRequest(
        makeReq('/pro/byok', 'POST', { use_byok: true }),
        '/pro/byok', 'POST', { userId: 'u_byok' }, {}
    );
    assert.equal(byokRes.status, 200);

    // Check status: use_byok is true AND daily_remaining is still 44 (not reset to 45 or 0)
    const stRes = await pro.handleRequest(makeReq('/pro/status'), '/pro/status', 'GET', { userId: 'u_byok' }, {});
    const stData = await stRes.json();
    assert.equal(stData.use_byok, true);
    assert.equal(stData.credits.daily_limit, 45);
    assert.equal(stData.credits.daily_used, 1);
    assert.equal(stData.credits.daily_remaining, 44);
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

test('Phase 2.5: Username resolution for email/password user returns email and allows login', async () => {
    const { pro, storage } = createHarness();
    // Register username
    await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'sarah_m' }), '/pro/username', 'POST', { userId: 'u_sarah' }, {});
    // Seed identity with email
    await storage.put('identity:u_sarah', { user: 'clerk:sarah', display_name: 'sarah@example.com', user_id: 'u_sarah' });

    const resolveRes = await pro.resolveUsername({ username: 'sarah_m' });
    assert.equal(resolveRes.status, 200);
    const data = await resolveRes.json();
    assert.equal(data.success, true);
    assert.equal(data.email, 'sarah@example.com');
    assert.equal(data.requires_password, true);
});

test('Phase 2.5: Username resolution strictly blocks Google-only accounts with 403 (Google sign-in disallowed from username login)', async () => {
    const { pro } = createHarness({ CLERK_SECRET_KEY: 'mock_test_key' });
    // Register username
    await pro.handleRequest(makeReq('/pro/username', 'POST', { username: 'google_user' }), '/pro/username', 'POST', { userId: 'u_goog' }, {});

    // Mock clerkAPI to simulate a user with only Google OAuth and no password
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes('/users/u_goog')) {
            return new Response(JSON.stringify({
                id: 'u_goog',
                password_enabled: false,
                external_accounts: [{ provider: 'oauth_google', verification: { status: 'verified' } }]
            }), { status: 200 });
        }
        return originalFetch(url);
    };

    try {
        const resolveRes = await pro.resolveUsername({ username: 'google_user' });
        assert.equal(resolveRes.status, 403);
        const data = await resolveRes.json();
        assert.equal(data.disallow_google, true);
        assert.match(data.error, /Google sign-in/i);
    } finally {
        globalThis.fetch = originalFetch;
    }
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

test('Phase 2: Missing CLAUDE_API_KEY returns 502 without fake simulation and does not deduct credits', async () => {
    const { pro, storage } = createHarness({ CLAUDE_API_KEY: '', ANTHROPIC_API_KEY: '' });
    await pro.handleRequest(
        makeReq('/pro/activate', 'POST', { key: 'A1B2C3D4E5F6G7H8' }),
        '/pro/activate', 'POST', { userId: 'u_no_key' }, {}
    );

    // Single review without key fails with 502
    const revRes = await pro.handleRequest(
        makeReq('/pro/ai/review', 'POST', {
            task_id: 't1',
            criteria: 'Check',
            file: { mime_type: 'image/png', data: 'YWJj' }
        }),
        '/pro/ai/review', 'POST', { userId: 'u_no_key' }, {}
    );
    assert.equal(revRes.status, 502);
    const revData = await revRes.json();
    assert.equal(revData.code, 'AI_PROVIDER_ERROR');
    assert.match(revData.error, /CLAUDE_API_KEY.*not configured/);

    // Batch review without key fails with 502
    const batchRes = await pro.handleRequest(
        makeReq('/pro/ai/batch-review', 'POST', {
            tasks: [{ id: 'task_1', title: 'Task 1', criteria: 'Criteria 1' }],
            files: [{ mime_type: 'image/png', data: 'YWJj' }]
        }),
        '/pro/ai/batch-review', 'POST', { userId: 'u_no_key' }, {}
    );
    assert.equal(batchRes.status, 502);
    const batchData = await batchRes.json();
    assert.equal(batchData.code, 'AI_PROVIDER_ERROR');
    assert.match(batchData.error, /CLAUDE_API_KEY.*not configured/);

    // Verify ZERO credits were deducted (balance remains 45 / 1000)
    const stRes = await pro.handleRequest(makeReq('/pro/status'), '/pro/status', 'GET', { userId: 'u_no_key' }, {});
    const stData = await stRes.json();
    assert.equal(stData.credits.daily_remaining, 45);
    assert.equal(stData.credits.monthly_remaining, 1000);
});

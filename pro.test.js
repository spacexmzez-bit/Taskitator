// File: pro/pro.test.js
// Unit & Integration Tests for Taskitator Pro Phase 1 Backend

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskitatorSync } from '../cloudflare/worker.js';

// In-memory mock storage conforming to Cloudflare DO Storage API
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

function createTestHarness(envOverrides = {}) {
    const storage = new MockStorage();
    const env = {
        ALLOWED_ORIGINS: 'https://taskitator.mazendev.com',
        CLERK_SECRET_KEY: 'mock_sk_test',
        CLERK_ISSUER: 'https://example.clerk.accounts.dev',
        ...envOverrides
    };
    const doState = { storage };
    const sync = new TaskitatorSync(doState, env);
    return { sync, storage, env };
}

function mockIdentity(userId = 'user_pro_tester') {
    return { userId, email: `${userId}@example.com` };
}

function mockRequest(path, method, body = null, headers = {}) {
    const init = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://taskitator.mazendev.com',
            ...headers
        }
    };
    if (body) init.body = JSON.stringify(body);
    return new Request(`https://taskitator.mazendev.com${path}`, init);
}

test('Pro Phase 1: Unactivated account returns Free tier with zero credits', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_free_1');
    const req = mockRequest('/pro/status', 'GET');
    
    const res = await sync.pro.handleRequest(req, '/pro/status', 'GET', identity, { user: identity.userId });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.isPro, false);
    assert.equal(data.tier, 'free');
    assert.equal(data.status, 'inactive');
    assert.equal(data.credits.daily_limit, 0);
    assert.equal(data.credits.daily_remaining, 0);
});

test('Pro Phase 1: Keyo activation successfully elevates account to Pro', async () => {
    const { sync, storage } = createTestHarness();
    const identity = mockIdentity('user_pro_2');
    const activateReq = mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-2026-TEST-KEY' });
    
    const res = await sync.pro.handleRequest(activateReq, '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.isPro, true);
    assert.equal(data.tier, 'pro');
    assert.equal(data.status, 'active');
    assert.ok(data.expires_at > Date.now());

    // Verify stored entitlement
    const stored = await storage.get(`pro:entitlement:${identity.userId}`);
    assert.equal(stored.tier, 'pro');
    assert.equal(stored.status, 'active');

    // Status check reflects active Pro and quota limits
    const statusReq = mockRequest('/pro/status', 'GET');
    const statusRes = await sync.pro.handleRequest(statusReq, '/pro/status', 'GET', identity, { user: identity.userId });
    const statusData = await statusRes.json();
    assert.equal(statusData.isPro, true);
    assert.equal(statusData.credits.daily_limit, 20);
    assert.equal(statusData.credits.daily_remaining, 20);
    assert.equal(statusData.credits.monthly_limit, 300);
    assert.equal(statusData.credits.monthly_remaining, 300);
});

test('Pro Phase 1: Repeated activation with the same key is idempotent', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_pro_3');
    const req1 = mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-REPEAT-TEST' });
    const res1 = await sync.pro.handleRequest(req1, '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(res1.status, 200);

    const req2 = mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-REPEAT-TEST' });
    const res2 = await sync.pro.handleRequest(req2, '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.isPro, true);
});

test('Pro Phase 1: Attempting to bind a key already linked to another account returns 409 conflict', async () => {
    const { sync } = createTestHarness();
    const key = 'KEYO-PRO-SHARED-KEY-1';
    
    // Account A binds the key
    const idA = mockIdentity('user_owner_A');
    const resA = await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key }), '/pro/activate', 'POST', idA, { user: idA.userId });
    assert.equal(resA.status, 200);

    // Account B attempts to steal/reuse the same key
    const idB = mockIdentity('user_thief_B');
    const resB = await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key }), '/pro/activate', 'POST', idB, { user: idB.userId });
    assert.equal(resB.status, 409);
    const err = await resB.json();
    assert.equal(err.code, 'KEY_ALREADY_BOUND');
});

test('Pro Phase 1: Invalid or expired Keyo keys fail activation with 400', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_test_fail');

    const resShort = await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: '123' }), '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(resShort.status, 400);

    const resExpired = await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-EXPIRED-KEY' }), '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(resExpired.status, 400);
    const dataExpired = await resExpired.json();
    assert.equal(dataExpired.code, 'KEY_EXPIRED');

    const resRevoked = await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-REVOKED-KEY' }), '/pro/activate', 'POST', identity, { user: identity.userId });
    assert.equal(resRevoked.status, 400);
    const dataRevoked = await resRevoked.json();
    assert.equal(dataRevoked.code, 'KEY_REVOKED');
});

test('Pro Phase 1: Hosted AI review requires active Pro entitlement (403 for Free)', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_unauthorized_free');
    const reviewReq = mockRequest('/pro/ai/review', 'POST', {
        taskId: 'task_1',
        task_title: 'Complete Math Exercise',
        criteria: 'All 5 problems solved'
    });

    const res = await sync.pro.handleRequest(reviewReq, '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res.status, 403);
    const err = await res.json();
    assert.equal(err.code, 'PRO_REQUIRED');
});

test('Pro Phase 1: Pro-family models are strictly rejected (Lite and Flash only)', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_pro_model_check');
    await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-MODEL-TEST' }), '/pro/activate', 'POST', identity, { user: identity.userId });

    // Requesting forbidden pro model
    const reqPro = mockRequest('/pro/ai/review', 'POST', {
        taskId: 'task_2',
        criteria: 'Solve proof',
        model: 'gemini-1.5-pro'
    });

    const res = await sync.pro.handleRequest(reqPro, '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res.status, 400);
    const err = await res.json();
    assert.equal(err.code, 'MODEL_FORBIDDEN');
    assert.ok(err.error.includes('Pro-family models are strictly excluded'));
});

test('Pro Phase 1: Unsupported file formats return 415 (accepts JPEG, PNG, WebP, PDF)', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_pro_files');
    await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-FILE-TEST' }), '/pro/activate', 'POST', identity, { user: identity.userId });

    const reqBadFile = mockRequest('/pro/ai/review', 'POST', {
        taskId: 'task_3',
        criteria: 'Read report',
        file: {
            mimeType: 'image/gif',
            data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
        }
    });

    const res = await sync.pro.handleRequest(reqBadFile, '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res.status, 415);
    const err = await res.json();
    assert.equal(err.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('Pro Phase 1: Successful hosted proof review charges 1 credit and updates remaining balance', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_pro_audit');
    await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-AUDIT-TEST' }), '/pro/activate', 'POST', identity, { user: identity.userId });

    const reqReview = mockRequest('/pro/ai/review', 'POST', {
        taskId: 'task_4',
        task_title: 'Calculus Assignment',
        criteria: 'Submitted clear handwritten calculations with final answer boxed.',
        file: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQK...'
        },
        operationId: 'op_math_001'
    });

    const res = await sync.pro.handleRequest(reqReview, '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.verdict, 'approved');
    assert.equal(data.credits_charged, 1);
    assert.equal(data.credits_remaining.daily, 19);

    // Verify status endpoint reflects updated usage
    const statusRes = await sync.pro.handleRequest(mockRequest('/pro/status', 'GET'), '/pro/status', 'GET', identity, { user: identity.userId });
    const statusData = await statusRes.json();
    assert.equal(statusData.credits.daily_remaining, 19);
    assert.equal(statusData.credits.daily_used, 1);
});

test('Pro Phase 1: Idempotent operation ID returns cached result without charging second credit', async () => {
    const { sync } = createTestHarness();
    const identity = mockIdentity('user_pro_idempotent');
    await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-IDEMPOTENT-TEST' }), '/pro/activate', 'POST', identity, { user: identity.userId });

    const payload = {
        taskId: 'task_5',
        criteria: 'Exercise completed',
        operationId: 'op_idempotent_123'
    };

    // First call
    const res1 = await sync.pro.handleRequest(mockRequest('/pro/ai/review', 'POST', payload), '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res1.status, 200);

    // Second call with identical payload & operationId
    const res2 = await sync.pro.handleRequest(mockRequest('/pro/ai/review', 'POST', payload), '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(res2.status, 200);

    // Check status: only 1 credit was consumed total
    const statusRes = await sync.pro.handleRequest(mockRequest('/pro/status', 'GET'), '/pro/status', 'GET', identity, { user: identity.userId });
    const statusData = await statusRes.json();
    assert.equal(statusData.credits.daily_used, 1);

    // Third call with conflicting payload and same operationId returns 409
    const conflictingPayload = { ...payload, criteria: 'Completely different criteria' };
    const resConflict = await sync.pro.handleRequest(mockRequest('/pro/ai/review', 'POST', conflictingPayload), '/pro/ai/review', 'POST', identity, { user: identity.userId });
    assert.equal(resConflict.status, 409);
    const err = await resConflict.json();
    assert.equal(err.code, 'OPERATION_CONFLICT');
});

test('Pro Phase 1: Quota exhaustion returns 429 when daily credits are depleted', async () => {
    const { sync, storage } = createTestHarness();
    const identity = mockIdentity('user_pro_exhausted');
    await sync.pro.handleRequest(mockRequest('/pro/activate', 'POST', { key: 'KEYO-PRO-EXHAUST-TEST' }), '/pro/activate', 'POST', identity, { user: identity.userId });

    // Artificially simulate 20 credits used today in Riyadh timezone
    const now = Date.now();
    const riyadhDate = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
    await storage.put(`pro:usage:${identity.userId}:day:${riyadhDate}`, 20);

    const res = await sync.pro.handleRequest(mockRequest('/pro/ai/review', 'POST', {
        taskId: 'task_over_quota',
        criteria: 'Check submission'
    }), '/pro/ai/review', 'POST', identity, { user: identity.userId });

    assert.equal(res.status, 429);
    const err = await res.json();
    assert.equal(err.code, 'QUOTA_EXHAUSTED');
});

// File: pro/pro.test.js
// Unit & Integration Tests for Taskitator Pro Phase 2 Backend

import crypto from 'node:crypto';
globalThis.crypto = globalThis.crypto || crypto.webcrypto;

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

function createHarness(envOverrides = {}) {
    const storage = new MockStorage();
    const env = {
        ALLOWED_ORIGINS: 'https://taskitator.mazendev.com',
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

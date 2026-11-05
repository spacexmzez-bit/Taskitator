import test from 'node:test';
import assert from 'node:assert/strict';
import './worker.js';
import { TaskProtection, prepare } from './pro-backend.js';

// Criteria tests: caller draft criteria through the same prompt, never on locked tasks (unless bypass).
const png = { mime_type: 'image/png', data: 'iVBORw0KGgo=' };
async function fixture(tasks, bypass = false) {
    const map = new Map();
    const store = { get: async k => map.get(k), put: async (k, v) => map.set(k, v) };
    map.set('identity:acct', { user: 'u' });
    map.set('account:u', { owner_id: 'acct' });
    if (bypass) map.set('pro:emergency:acct', { active_until_ms: Date.now() + 60000 });
    const p = new TaskProtection({ storage: store, readTaskSnapshot: async () => ({ snapshot: { tasks } }) });
    return { p, store };
}
const body = (extra = {}) => ({ test: true, task_id: 't1', task_title: 'Essay', criteria: 'Photo of 2 handwritten pages', files: [png], ...extra });

test('a criteria test uses the exact normal audit prompt with the caller draft criteria', async () => {
    const { p, store } = await fixture([]);
    const bound = await p.bind(store, 'acct', body({ exemplar: png }), false, true);
    const normal = prepare({ task_id: 't1', task_title: 'Essay', criteria: 'Photo of 2 handwritten pages', files: [png], exemplar: png }, false, { allowHeic: true });
    assert.deepEqual(bound.payload, normal.payload);
    assert.deepEqual(bound.bindings, { test: 't1' });
});

test('a criteria test is refused once the task is locked, and allowed during Emergency Bypass', async () => {
    const locked = [{ id: 't1', status: 'active', ai_locked: true, proof_criteria: 'x' }];
    const a = await fixture(locked);
    await assert.rejects(a.p.bind(a.store, 'acct', body(), false, true), e => e.code === 'TEST_LOCKED');
    const b = await fixture(locked, true);
    const bound = await b.p.bind(b.store, 'acct', body(), false, true);
    assert.equal(bound.tasks[0].criteria, 'Photo of 2 handwritten pages');
});

test('criteria tests are single-task only', async () => {
    const { p, store } = await fixture([]);
    await assert.rejects(p.bind(store, 'acct', { ...body(), tasks: [{ id: 't1' }] }, true, true), e => e.code === 'TEST_SINGLE_ONLY');
});

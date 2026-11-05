import test from 'node:test';
import assert from 'node:assert/strict';
import './worker.js';
import { TaskProtection } from './pro-backend.js';

test('a protected task cannot inherit an invalid date to unlock the phone', async () => {
    const guard = Object.create(TaskProtection.prototype);
    guard.bypass = async () => false;
    const task = { id: 'protected', parent_id: 'parent', status: 'active', ai_locked: true };
    const parent = { id: 'parent', status: 'active', due_date: '2026-11-04' };
    const previous = { tasks: [task, parent] };
    for (const due_date of ['2026-00-01', '2026-02-30', 'invalid']) {
        const next = { tasks: [task, { ...parent, due_date }] };
        await assert.rejects(guard.guardSync(null, 'test', previous, next), error => error.status === 403);
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './worker.js';
import { TaskProtection } from './pro-backend.js';

const core = fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8');
const section = core.match(/\/\/ <<< MODULE_START: merge\.js >>>([\s\S]*?)\/\/ <<< MODULE_END: merge\.js >>>/)[1];
const window = {};
vm.runInNewContext(section, { window, JSON, Object, Array, Set, Map, String, Promise, document: undefined, indexedDB: undefined, console });
const plain = v => JSON.parse(JSON.stringify(v));

const guard = () => { const g = Object.create(TaskProtection.prototype); g.bypass = async () => false; return g; };

test('server names every rejected protected task, not just the first', async () => {
    const a = { id: 'a', title: 'A', status: 'active', ai_locked: true, due_date: '2026-11-12' };
    const b = { id: 'b', title: 'B', status: 'active', ai_locked: true, due_date: '2026-11-12' };
    const free = { id: 'f', title: 'Free', status: 'active', due_date: '2026-11-12' };
    const previous = { tasks: [a, b, free] };
    const next = { tasks: [{ ...a, due_date: '2026-11-19' }, { ...b, due_date: '2026-11-20' }, { ...free, due_date: '2026-12-01' }] };
    await assert.rejects(guard().guardSync(null, 'u', previous, next), e => {
        assert.equal(e.status, 403);
        assert.deepEqual(e.rejected.map(r => r.id).sort(), ['a', 'b']);
        assert.equal(e.rejected[0].code, 'REQUIREMENTS_LOCKED');
        return true;
    });
});

test('a later date inherited from a parent reports the parent as related', async () => {
    const child = { id: 'c', parent_id: 'p', status: 'active', ai_locked: true };
    const parent = { id: 'p', status: 'active', due_date: '2026-11-12' };
    await assert.rejects(guard().guardSync(null, 'u', { tasks: [child, parent] }, { tasks: [child, { ...parent, due_date: '2026-11-19' }] }),
        e => { assert.deepEqual(e.rejected[0].related, ['p']); return true; });
});

test('only rejected tasks revert to the cloud copy; other local edits stay', () => {
    const local = [
        { id: 'ai', title: 'Audited', due_date: '2026-11-18', ai_locked: true },  // device B choice: next week
        { id: 'x', title: 'Edited locally', due_date: '2026-11-15' },
        { id: 'new', title: 'Added locally' }
    ];
    const remote = [
        { id: 'ai', title: 'Audited', due_date: '2026-11-12', ai_locked: true }, // device A: tomorrow
        { id: 'x', title: 'Old title', due_date: '2026-11-13' }
    ];
    const out = plain(window.TaskitatorRevert.apply(local, remote, [{ id: 'ai', code: 'REQUIREMENTS_LOCKED', related: [] }]));
    assert.deepEqual(out.changed, [{ id: 'ai', title: 'Audited' }]);
    assert.equal(out.tasks.find(t => t.id === 'ai').due_date, '2026-11-12');
    assert.equal(out.tasks.find(t => t.id === 'x').title, 'Edited locally');
    assert.ok(out.tasks.some(t => t.id === 'new'));
});

test('a protected task removed locally is restored from the cloud', () => {
    const out = plain(window.TaskitatorRevert.apply([{ id: 'k' }], [{ id: 'k' }, { id: 'gone', title: 'G', ai_locked: true }], [{ id: 'gone' }]));
    assert.ok(out.tasks.some(t => t.id === 'gone'));
});

test('push retries once after reverting rejected items instead of the whole-copy chooser', () => {
    const fn = core.match(/async performPush\([\s\S]*?\n    },\n/)[0];
    assert.match(fn, /data\.rejected[\s\S]*revertRejected[\s\S]*__revertedOnce: true/);
    assert.ok(fn.indexOf('revertRejected') < fn.indexOf("['PROOF_REQUIRED','REQUIREMENTS_LOCKED','SHIELD_REQUIRED']"));
    assert.match(fn, /__revertedOnce: ignoredFlag/);
});

test('conflict panel flags AI-protected task conflicts', () => {
    const base = { tasks: [{ id: 'ai', title: 'T', due_date: '1', ai_locked: true }], projects: [], settings: {} };
    const local = { ...base, tasks: [{ ...base.tasks[0], due_date: '3' }] };
    const remote = { ...base, tasks: [{ ...base.tasks[0], due_date: '2' }] };
    const { conflicts } = plain(window.TaskitatorMerge.merge3(base, local, remote));
    assert.equal(conflicts[0].guarded, true);
});

test('worker forwards the rejected list in the 403 body', () => {
    assert.match(fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8'), /rejected:err\.rejected\.map/);
});

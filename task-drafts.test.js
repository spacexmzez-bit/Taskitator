import test from 'node:test';
import assert from 'node:assert/strict';

// Fake browser storage and sync engine, then load the real module.
const store = new Map();
let syncCalls = 0, pushCalls = 0;
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.SyncEngine = { markLocalModified: () => syncCalls++, scheduleAutoPush: () => pushCalls++ };
await import('./task-drafts.js');
const D = globalThis.TaskitatorDrafts;
const settings = () => JSON.parse(store.get('taskitator_settings') || '{}');
const reset = () => { store.clear(); syncCalls = 0; pushCalls = 0; };

test('a create draft is stored as its own synced settings key and listed newest first', () => {
    reset();
    store.set('taskitator_settings', JSON.stringify({ worker_username: 'keep' }));
    const a = D.saveCreate({ title: 'Essay', tags: ['x'], subtasks: ['Outline', 'Draft'], ai_locked: true, criteria: 'Photo of 2 pages' });
    const key = 'task_draft:' + a;
    assert.ok(settings()[key]);
    assert.equal(settings().worker_username, 'keep');
    assert.equal(syncCalls, 1); assert.equal(pushCalls, 1);
    const list = D.listCreate();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].title, list[0].tags, list[0].subtasks, list[0].ai_locked, list[0].criteria], ['Essay', ['x'], ['Outline', 'Draft'], true, 'Photo of 2 pages']);
});

test('saving over an existing draft id replaces it; delete removes it and syncs', () => {
    reset();
    const id = D.saveCreate({ title: 'One' });
    D.saveCreate({ title: 'One edited' }, id);
    assert.equal(D.listCreate().length, 1);
    assert.equal(D.getCreate(id).title, 'One edited');
    assert.equal(D.removeCreate(id), true);
    assert.equal(D.removeCreate(id), false);
    assert.equal(D.listCreate().length, 0);
});

test('a draft needs a title, and the number of drafts is capped', () => {
    reset();
    assert.throws(() => D.saveCreate({ title: '   ' }), /title/i);
    for (let i = 0; i < D.MAX_CREATE_DRAFTS; i++) D.saveCreate({ title: 'T' + i });
    assert.throws(() => D.saveCreate({ title: 'one too many' }), /Delete one/);
    const first = D.listCreate()[0].id;
    D.saveCreate({ title: 'replace allowed' }, first);
    assert.equal(D.listCreate().length, D.MAX_CREATE_DRAFTS);
});

test('draft fields are whitelisted and bounded so odd data cannot reach the snapshot', () => {
    reset();
    const id = D.saveCreate({ title: 'x'.repeat(900), evil: { a: 1 }, tags: ['ok', 5, null], subtasks: new Array(300).fill('s'), is_bonus: 'yes', ai_locked: 1 });
    const d = D.getCreate(id);
    assert.equal(d.title.length, 500);
    assert.equal(d.evil, undefined);
    assert.deepEqual(d.tags, ['ok']);
    assert.equal(d.subtasks.length, 100);
    assert.equal(d.is_bonus, false); assert.equal(d.ai_locked, false);
    assert.equal(d.project_id, 'inbox');
});

test('an edit draft is stored per task, leaves the task data alone, and is removed on publish', () => {
    reset();
    D.saveEdit('task_1', { title: 'New title', description: 'd', tags: ['a'], criteria: 'c', strict_prerequisites: true });
    assert.equal(settings()['edit_draft:task_1'].fields.title, 'New title');
    assert.equal(D.getEdit('task_1').strict_prerequisites, true);
    assert.equal(D.getEdit('missing'), null);
    assert.equal(D.listEdits().length, 1);
    assert.equal(D.removeEdit('task_1'), true);
    assert.equal(D.getEdit('task_1'), null);
});

test('edit drafts of tasks that no longer exist are pruned; create drafts are untouched', () => {
    reset();
    D.saveCreate({ title: 'Keep me' });
    D.saveEdit('alive', { title: 'a' });
    D.saveEdit('gone', { title: 'g' });
    assert.equal(D.pruneEdits(['alive']), true);
    assert.deepEqual(D.listEdits().map(e => e.task_id), ['alive']);
    assert.equal(D.listCreate().length, 1);
    assert.equal(D.count(), 2);
    assert.equal(D.pruneEdits(['alive']), false);
});

test('corrupt settings storage does not break drafts', () => {
    reset();
    store.set('taskitator_settings', '{not json');
    assert.deepEqual(D.listCreate(), []);
    const id = D.saveCreate({ title: 'Recovered' });
    assert.equal(D.getCreate(id).title, 'Recovered');
});

test('study plan drafts: own keys, one edit draft per plan, at most 10, bounded fields', () => {
    reset();
    const a = D.saveStudy({ kind: 'create', info: { title: 'Bio' }, schedule: { sched: [{ date: '2026-11-12', count: 2 }], units_key: [2, 1, 2, 3] } });
    assert.ok(settings()['study_draft:' + a]);
    assert.equal(D.listCreate().length, 0); assert.equal(D.count(), 0, 'not counted in the normal drafts badge');
    D.saveStudy({ kind: 'edit', plan_id: 'p1', info: { title: 'Old' } });
    D.saveStudy({ kind: 'edit', plan_id: 'p1', info: { title: 'New' } });
    assert.equal(D.listStudy().length, 2); assert.equal(D.getStudy('edit_p1').info.title, 'New');
    const bad = D.getStudy(a); assert.equal(bad.schedule.sched.length, 1);
    const b = D.saveStudy({ kind: 'create', schedule: { sched: [{ date: 'x', count: 2 }], units_key: [1, 1, 1, 1] } });
    assert.equal(D.getStudy(b).schedule.sched, null, 'invalid rows are dropped');
    for (let i = 0; i < 7; i++) D.saveStudy({ kind: 'create' });
    assert.equal(D.listStudy().length, 10);
    assert.throws(() => D.saveStudy({ kind: 'create' }), /10 study plan drafts/);
    assert.throws(() => D.saveStudy({ kind: 'edit' }), /Missing study plan/);
    assert.equal(D.removeStudy('edit_p1'), true); assert.equal(D.listStudy().length, 9);
});

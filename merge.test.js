import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8');
const section = core.match(/\/\/ <<< MODULE_START: merge\.js >>>([\s\S]*?)\/\/ <<< MODULE_END: merge\.js >>>/)[1];
const window = {};
vm.runInNewContext(section, { window, JSON, Object, Array, Set, Map, String, Promise, document: undefined, indexedDB: undefined, console });
// Results cross the vm realm; round-trip them so deepEqual compares plain objects.
const merge3 = (...args) => JSON.parse(JSON.stringify(window.TaskitatorMerge.merge3(...args)));

const t = (id, extra = {}) => ({ id, parent_id: null, title: id, description: '', tags: [], status: 'active', due_date: '', ...extra });
const empty = { tasks: [], projects: [], settings: {}, recurrence_state: { series: [], history: [] }, saved_criteria: [], completed_audit_ledger: [] };
const snap = (o = {}) => ({ ...empty, ...o });

test('edits to different fields of one task merge without conflict', () => {
    const base = snap({ tasks: [t('a')] });
    const local = snap({ tasks: [t('a', { title: 'Mine' })] });
    const remote = snap({ tasks: [t('a', { due_date: '2026-12-01' })] });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.merged.tasks[0].title, 'Mine');
    assert.equal(r.merged.tasks[0].due_date, '2026-12-01');
});

test('same field changed differently is a conflict; choices decide', () => {
    const base = snap({ tasks: [t('a')] });
    const local = snap({ tasks: [t('a', { title: 'Mine' })] });
    const remote = snap({ tasks: [t('a', { title: 'Theirs' })] });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'tasks:a:title');
    assert.equal(r.merged.tasks[0].title, 'Mine', 'unresolved defaults to this device');
    assert.equal(merge3(base, local, remote, { 'tasks:a:title': 'theirs' }).merged.tasks[0].title, 'Theirs');
    assert.equal(merge3(base, local, remote, { 'tasks:a:title': 'mine' }).unresolved.length, 0);
});

test('identical changes on both sides agree', () => {
    const base = snap({ tasks: [t('a')] });
    const both = snap({ tasks: [t('a', { status: 'done' })] });
    assert.equal(merge3(base, both, both).conflicts.length, 0);
});

test('tags merge as sets and never conflict', () => {
    const base = snap({ tasks: [t('a', { tags: ['x', 'y'] })] });
    const local = snap({ tasks: [t('a', { tags: ['x', 'y', 'l'] })] });
    const remote = snap({ tasks: [t('a', { tags: ['x', 'r'] })] });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual([...r.merged.tasks[0].tags].sort(), ['l', 'r', 'x']);
});

test('tasks added on either side are kept', () => {
    const base = snap({ tasks: [t('a')] });
    const r = merge3(base, snap({ tasks: [t('a'), t('l')] }), snap({ tasks: [t('a'), t('r')] }));
    assert.deepEqual(r.merged.tasks.map(x => x.id).sort(), ['a', 'l', 'r']);
});

test('delete against untouched wins; delete against edit is a conflict', () => {
    const base = snap({ tasks: [t('a'), t('b')] });
    const local = snap({ tasks: [t('b')] }); // deleted a here
    const remote = snap({ tasks: [t('a'), t('b', { title: 'edited' })] });
    const r = merge3(base, local, remote);
    assert.deepEqual(r.merged.tasks.map(x => x.id), ['b']);
    assert.equal(r.conflicts.length, 0);

    const remote2 = snap({ tasks: [t('a', { title: 'edited elsewhere' }), t('b')] });
    const c = merge3(base, local, remote2);
    assert.equal(c.conflicts.length, 1);
    assert.equal(c.conflicts[0].kind, 'delete');
    assert.equal(c.conflicts[0].deletedOn, 'device');
    assert.ok(!c.merged.tasks.some(x => x.id === 'a'), 'default keeps this device deletion');
    const kept = merge3(base, local, remote2, { 'tasks:a:deleted': 'theirs' });
    assert.equal(kept.merged.tasks.find(x => x.id === 'a').title, 'edited elsewhere');

    // edited here, deleted in the cloud
    const e = merge3(base, snap({ tasks: [t('a', { title: 'mine' }), t('b')] }), snap({ tasks: [t('b')] }));
    assert.equal(e.conflicts[0].deletedOn, 'cloud');
    assert.equal(e.merged.tasks.find(x => x.id === 'a').title, 'mine');
    assert.ok(!merge3(base, snap({ tasks: [t('a', { title: 'mine' }), t('b')] }), snap({ tasks: [t('b')] }),
        { 'tasks:a:deleted': 'theirs' }).merged.tasks.some(x => x.id === 'a'));
});

test('a new subtask under a parent deleted in the cloud is an orphan conflict', () => {
    const base = snap({ tasks: [t('p')] });
    const local = snap({ tasks: [t('p'), t('s', { parent_id: 'p' })] });
    const remote = snap({ tasks: [] });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts[0].kind, 'orphan');
    assert.equal(r.merged.tasks[0].parent_id, null);
    assert.equal(merge3(base, local, remote, { 'tasks:s:orphan': 'theirs' }).merged.tasks.length, 0);
});

test('settings merge per key and ignore per-device bookkeeping', () => {
    const base = snap({ settings: { a: 1, b: 1, last_synced: 'x' } });
    const local = snap({ settings: { a: 2, b: 1, last_synced: 'local' } });
    const remote = snap({ settings: { a: 1, b: 2, last_synced: 'remote' } });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(r.merged.settings, { a: 2, b: 2 });
    const clash = merge3(base, snap({ settings: { a: 5, b: 1 } }), snap({ settings: { a: 6, b: 1 } }));
    assert.equal(clash.conflicts[0].id, 'settings::a');
});

test('whole-value data and the audit ledger', () => {
    const base = snap({ saved_criteria: ['x'], completed_audit_ledger: [{ id: 1 }] });
    const local = snap({ saved_criteria: ['x', 'l'], completed_audit_ledger: [{ id: 1 }, { id: 2 }] });
    const remote = snap({ saved_criteria: ['x'], completed_audit_ledger: [{ id: 1 }, { id: 3 }] });
    const r = merge3(base, local, remote);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(r.merged.saved_criteria, ['x', 'l']);
    assert.equal(r.merged.completed_audit_ledger.length, 3);
    const both = merge3(base, snap({ saved_criteria: ['l'] }), snap({ saved_criteria: ['r'] }));
    assert.equal(both.conflicts[0].id, 'saved_criteria::whole');
});

test('merge does not mutate its inputs', () => {
    const base = snap({ tasks: [t('a', { tags: ['x'] })] });
    const local = snap({ tasks: [t('a', { tags: ['x', 'l'] })] });
    const remote = snap({ tasks: [t('a', { tags: ['x', 'r'] })] });
    const before = JSON.stringify([base, local, remote]);
    merge3(base, local, remote);
    assert.equal(JSON.stringify([base, local, remote]), before);
});

test('sync engine routes conflicts through the merge and falls back safely', () => {
    assert.match(core, /res\.status === 409\) return this\.resolveConflict\(data, this\.mergeInFlight \? this\.mergeAttempt : 0\)/);
    assert.match(core, /saveBase\(config\.username, data\.version, payload\)/);
    const fn = core.match(/async resolveConflict\([\s\S]*?\n    },\n\n    reportConflict/)[0];
    assert.match(fn, /if \(!base\) return fallback\(\)/, 'no base copy -> copy chooser');
    assert.match(fn, /base\.version > remote\.version\) return fallback\(\)/);
    assert.match(fn, /attempt >= 3/);
    assert.match(fn, /choices = await merge\.askUser/);
    assert.match(fn, /deferred: true/, 'Decide later leaves local edits queued');
    assert.match(fn, /revision !== localStorage\.getItem\(this\.STORAGE_KEY_REVISION\)/);
    assert.match(fn, /this\.performPush\(false\)/);
});

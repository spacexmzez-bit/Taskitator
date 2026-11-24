// Phase 6.2: sync conflict fixes (protection refusals, stale revision, dialog, comparison).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const core = fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8');
const mod = name => core.match(new RegExp(`// <<< MODULE_START: ${name.replace('.', '\\.')} >>>([\\s\\S]*?)// <<< MODULE_END: ${name.replace('.', '\\.')} >>>`))[1];
const plain = v => JSON.parse(JSON.stringify(v));

class Store {
    getItem(k) { return Object.hasOwn(this, k) ? this[k] : null; }
    setItem(k, v) { this[k] = String(v); }
    removeItem(k) { delete this[k]; }
}

// Loads the merge module and the sync engine with a scripted Worker. replies: list of {status, body} for /sync/push.
function engine({ local = [], remote = [], pushes = [], refs = null, cloudRefs = null } = {}) {
    const storage = new Store();
    storage.setItem('taskitator_tasks', JSON.stringify(local));
    storage.setItem('taskitator_settings', '{}');
    storage.setItem('taskitator_local_revision', 'r0');
    if (refs) storage.setItem('taskitator_recurrence_state', JSON.stringify({ series: [], history: [], reference_files: refs }));
    const toasts = [], events = [], calls = [];
    const window = {
        TASKITATOR_AUTH_CONFIG: { workerUrl: 'https://w.test' }, location: { pathname: '/index.html', reload() {}, replace() {} },
        addEventListener() {}, dispatchEvent(e) { events.push(e.type); },
        TaskitatorAuth: { token: async () => 't', cleanSettings: s => s, account: { user: 'u' }, userId: 'u' },
        TaskitatorToast: { show: (m, o) => toasts.push({ m, type: o?.type }) }
    };
    const fetch = async (url, opts = {}) => {
        calls.push(url);
        if (url.endsWith('/sync/pull')) return Response.json({ version: 5, tasks: remote, settings: {}, recurrence_state: { series: [], history: [], reference_files: cloudRefs || {} } });
        const r = pushes.shift() || { status: 200, body: { success: true, version: 6, updated_at: 'x' } };
        return Response.json(r.body, { status: r.status });
    };
    const ctx = vm.createContext({ window, localStorage: storage, crypto: webcrypto, fetch, Headers, Response, AbortController,
        setTimeout, clearTimeout, console: { log() {}, error() {} }, JSON, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
        document: { addEventListener() {}, createElement() { return {}; }, body: {}, querySelector() { return null; }, getElementById() { return null; }, visibilityState: 'visible' } });
    vm.runInContext(mod('merge.js') + mod('sync-engine.js') + ';globalThis.__SE = SyncEngine;', ctx);
    const SE = ctx.__SE;
    SE.resumePasswordChange = async () => ({ success: true });
    SE.isConfigured = () => true;
    SE.needsInitialPull = () => false;
    SE.sessionMatches = () => true;
    storage.setItem(SE.STORAGE_KEY_REMOTE_VERSION, '5');
    const opened = { conflict: 0, blocked: 0 };
    SE.openConflictDialog = async () => { opened.conflict++; };
    SE.openBlockedDialog = () => { opened.blocked++; };
    return { SE, storage, toasts, events, calls, opened, window, tasks: () => JSON.parse(storage.getItem('taskitator_tasks')) };
}

const audited = (due) => ({ id: 'ai', title: 'Audited', status: 'active', ai_locked: true, due_date: due });
const refusal = (code = 'REQUIREMENTS_LOCKED') => ({ status: 403, body: { code, error: 'refused', rejected: [{ id: 'ai', code, message: 'refused', related: [] }] } });

test('protection refusal: only the refused task goes back to the cloud copy and the upload retries', async () => {
    const f = engine({ local: [audited('2026-11-30'), { id: 'x', title: 'Mine' }], remote: [audited('2026-11-25'), { id: 'x', title: 'Old' }], pushes: [refusal()] });
    const r = await f.SE.performPush(false);
    assert.equal(r.success, true);
    assert.equal(f.tasks().find(t => t.id === 'ai').due_date, '2026-11-25');
    assert.equal(f.tasks().find(t => t.id === 'x').title, 'Mine', 'other edits stay');
    assert.deepEqual(f.opened, { conflict: 0, blocked: 0 }, 'no copy chooser for a refusal');
    assert.equal(f.toasts[0].type, 'warning');
    assert.match(f.toasts[0].m, /"Audited"/);
    assert.match(f.toasts[0].m, /Emergency Bypass/);
});

for (const code of ['PROOF_REQUIRED', 'REQUIREMENTS_LOCKED', 'SHIELD_REQUIRED']) {
    test(`${code} never opens the copy chooser, even when it cannot be fixed automatically`, async () => {
        const f = engine({ local: [audited('2026-11-30')], remote: [audited('2026-11-25')], pushes: [refusal(code), refusal(code), refusal(code), refusal(code)] });
        const r = await f.SE.performPush(false);
        assert.equal(r.success, false);
        assert.equal(r.blocked, true);
        assert.equal(f.opened.conflict, 0);
        assert.equal(f.opened.blocked, 1);
        assert.equal(f.calls.filter(u => u.endsWith('/sync/push')).length, 4, 'three revert passes, then stop');
    });
}

test('a refusal with no task list goes to the blocked panel, not the copy chooser', async () => {
    const f = engine({ local: [audited('2026-11-30')], remote: [audited('2026-11-25')], pushes: [{ status: 403, body: { code: 'SHIELD_REQUIRED', error: 'no' } }] });
    const r = await f.SE.performPush(false);
    assert.equal(r.blocked, true);
    assert.deepEqual(f.opened, { conflict: 0, blocked: 1 });
});

test('revert also restores the refused task\'s protected reference file', async () => {
    const task = due => ({ ...audited(due), reference_id: 'ref1' });
    const f = engine({ local: [task('2026-11-25')], remote: [task('2026-11-25')], refs: { ref1: { name: 'new.pdf' } }, cloudRefs: { ref1: { name: 'old.pdf' } } });
    assert.equal(await f.SE.revertRejected([{ id: 'ai', code: 'REQUIREMENTS_LOCKED', message: 'm' }], f.SE.getConfig(), 's'), true);
    assert.equal(JSON.parse(f.storage.getItem('taskitator_recurrence_state')).reference_files.ref1.name, 'old.pdf');
});

test('revert still works when this device changed during the upload', async () => {
    const f = engine({ local: [audited('2026-11-30')], remote: [audited('2026-11-25')] });
    f.storage.setItem('taskitator_local_revision', 'changed-meanwhile');
    assert.equal(await f.SE.revertRejected([{ id: 'ai', code: 'REQUIREMENTS_LOCKED' }], f.SE.getConfig(), 's'), true);
});

test('syncs wait while a sync decision is open', async () => {
    const f = engine();
    f.SE.conflictDialogOpen = true;
    const r = await f.SE.push(false);
    assert.equal(r.deferred, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.SE.editingPanelOpen(), true, 'auto-sync countdown is held too');
});

test('edits saved while the field picker is open are merged, not reported as an error', async () => {
    const base = { version: 5, tasks: [{ id: 'a', title: 'Base', due_date: '1' }, { id: 'b', title: 'B' }], projects: [], settings: {} };
    const f = engine({ local: [{ id: 'a', title: 'Mine', due_date: '1' }, { id: 'b', title: 'B' }], remote: [{ id: 'a', title: 'Cloud', due_date: '1' }, { id: 'b', title: 'B' }] });
    const M = f.window.TaskitatorMerge;
    const merge = { ...M, loadBase: async () => base };
    merge.askUser = async conflicts => {
        // The user edits another task while deciding.
        f.storage.setItem('taskitator_tasks', JSON.stringify([{ id: 'a', title: 'Mine', due_date: '1' }, { id: 'b', title: 'B edited meanwhile' }]));
        f.storage.setItem('taskitator_local_revision', 'r1');
        return Object.fromEntries(conflicts.map(c => [c.id, 'theirs']));
    };
    f.window.TaskitatorMerge = merge;
    const r = await f.SE.resolveConflict({});
    assert.equal(r.success, true, r.error);
    const tasks = f.tasks();
    assert.equal(tasks.find(t => t.id === 'a').title, 'Cloud');
    assert.equal(tasks.find(t => t.id === 'b').title, 'B edited meanwhile');
});

test('difference list says which side changed what when a base copy exists', () => {
    const f = engine();
    const { diff } = f.window.TaskitatorMerge;
    const base = { tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }, { id: 'q', title: 'Q', updated_at: '1' }] };
    const local = { tasks: [{ id: 'a', title: 'A2' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', due_date: 'x' }, { id: 'n', title: 'New here' }, { id: 'q', title: 'Q', updated_at: '2' }], settings: { theme: 'x' } };
    const remote = { tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B3', ai_locked: true }, { id: 'c', title: 'C', due_date: 'y' }, { id: 'd', title: 'D' }, { id: 'q', title: 'Q', updated_at: '3' }], settings: { theme: 'y' } };
    const d = plain(diff(base, local, remote));
    const kind = id => d.tasks.find(t => t.id === id);
    assert.equal(d.exact, true);
    assert.equal(kind('a').kind, 'device');
    assert.deepEqual(kind('a').fields, ['Title']);
    assert.equal(kind('b').kind, 'cloud');
    assert.equal(kind('b').protected, true);
    assert.equal(kind('c').kind, 'both');
    assert.equal(kind('d').kind, 'deleted-device');
    assert.equal(kind('n').kind, 'added-device');
    assert.equal(kind('q'), undefined, 'bookkeeping fields are not differences');
    assert.deepEqual(d.settings, ['Theme']);
});

test('difference list still works without a base copy', () => {
    const f = engine();
    const d = plain(f.window.TaskitatorMerge.diff(null, { tasks: [{ id: 'a', title: 'A' }, { id: 'l' }] }, { tasks: [{ id: 'a', title: 'A2' }, { id: 'r', title: 'R' }] }));
    assert.equal(d.exact, false);
    assert.deepEqual(d.tasks.map(t => t.kind).sort(), ['different', 'only-cloud', 'only-device']);
    assert.equal(d.tasks.find(t => t.id === 'l').title, 'Untitled task');
});

test('values are shown in plain words, not raw JSON', () => {
    const { show, fieldName } = engine().window.TaskitatorMerge;
    assert.equal(show(true), 'Yes');
    assert.equal(show(''), '(empty)');
    assert.equal(show(['a', 'b']), 'a, b');
    assert.equal(show({ x: 1 }), 'Detailed settings');
    assert.equal(fieldName('status_bonus_count'), 'Count bonus tasks');
    assert.equal(fieldName('some_new_key'), 'Some new key');
    assert.equal(fieldName('due_date'), 'Due date');
});

test('copy chooser: no dead-end "close and sync again", choice re-reads both copies at click time', () => {
    assert.doesNotMatch(core, /Close this dialog and sync again/);
    const fn = core.match(/async openConflictDialog\([\s\S]*?\n    },\n/)[0];
    assert.match(fn, /const fresh = await this\.readCloud\(config\)/);
    assert.match(fn, /fresh\.version !== remote\.version\) return \{ success: false, changed: true \}/);
    assert.ok(fn.indexOf('const revision = localStorage.getItem') > fn.indexOf('const fresh'), 'revision is read when the choice runs');
    assert.match(fn, /await load\(\);\s*ui\.setStatus\([\s\S]{0,160}?'warning'\)/, 'a change while open redraws instead of failing');
    assert.match(fn, /sync-dialog-close|M\.shell/);
    assert.doesNotMatch(fn, /style\.cssText/, 'uses the app styles');
});

test('blocked panel never offers keeping this device\'s copy', () => {
    const fn = core.match(/openBlockedDialog\(data = \{\}\) \{[\s\S]*?\n    },\n/)[0];
    assert.doesNotMatch(fn, /Keep this device/);
    assert.match(fn, /Put them back and sync/);
    assert.match(fn, /emergencyTriggerBtn/);
});

test('new sync strings have Arabic translations', async () => {
    const box = { module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync(new URL('./locales/ar.js', import.meta.url), 'utf8'), box);
    const ar = box.module.exports;
    for (const key of ["This device and the cloud don't match", 'Some changes are blocked', "What's different", 'Pick which change to keep',
        'Not saved: {names}. {reasons} These tasks were put back to the cloud version. Your other changes are kept.',
        'AI-checked task. Changing it needs proof or Emergency Bypass.', 'Protected by a shield. Changing it needs Emergency Bypass.'])
        assert.ok(ar[key], key);
});

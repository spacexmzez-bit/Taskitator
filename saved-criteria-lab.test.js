import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
import './test-lab.js';
import { TaskProtection } from './pro-backend.js';

const S = globalThis.TaskitatorSavedCriteria, LAB = globalThis.TaskitatorTestLab;
const MB = 1024 * 1024;
const item = (n, exBytes = 0, extra = {}) => ({ id: 'sc_' + n, title: 'T' + n, criteria: 'Photo of page ' + n, score: 9, has_exemplar: exBytes > 0, exemplar: exBytes ? { fileName: 'x.png', mimeType: 'image/png', fileSize: exBytes, data: 'AAAA' } : null, ...extra });
const many = (n, ex = []) => Array.from({ length: n }, (_, i) => item(i, ex[i] || 0));

test('limits: free 5 items / 4 exemplars, Pro 100 / 10, 8 MB of exemplars together, 4 MB per file', () => {
    assert.deepEqual([S.limits(false).items, S.limits(false).exemplars, S.limits(true).items, S.limits(true).exemplars], [5, 4, 100, 10]);
    assert.equal(S.addError(many(4), false), null);
    assert.match(S.addError(many(5), false), /maximum 5 saved criteria.*Pro allows 100/);
    assert.equal(S.addError(many(99), true), null);
    assert.match(S.addError(many(100), true), /maximum 100/);
    assert.equal(S.addError(many(5), true), null);
    assert.match(S.addError(many(1), false, 5 * MB), /4 MB limit/);
    const four = many(4, [MB, MB, MB, MB]);
    assert.match(S.addError(four, false, MB), /maximum 4 saved criteria can have attached files/);
    assert.equal(S.addError(four, true, MB), null, 'Pro has 10 exemplar slots');
    const ten = many(10, Array(10).fill(MB));
    assert.match(S.addError(ten, true, MB), /maximum 10 saved criteria can have attached files/);
    const heavy = many(2, [4 * MB, 3.5 * MB]);
    assert.match(S.addError(heavy, true, MB), /share 8 MB/);
    assert.equal(S.addError(heavy, true, 0.5 * MB), null);
});

test('rename (free and Pro) keeps everything else; search matches title and text, every word', () => {
    const l = [item(1, 0, { title: 'Essay photo' }), item(2, 0, { title: 'Math sheet', criteria: 'Handwritten page with date' })];
    const r = S.rename(l, 'sc_2', '   New   name  ');
    assert.equal(r[1].title, 'New name'); assert.equal(r[1].criteria, l[1].criteria); assert.equal(r[0], l[0]);
    assert.equal(S.rename(l, 'sc_1', 'x'.repeat(80))[0].title.length, 40);
    assert.throws(() => S.rename(l, 'sc_1', '  '), /title/);
    assert.throws(() => S.rename(l, 'nope', 'a'), /no longer exists/);
    assert.deepEqual(S.search(l, 'math').map(i => i.id), ['sc_2']);
    assert.deepEqual(S.search(l, 'handwritten DATE').map(i => i.id), ['sc_2']);
    assert.deepEqual(S.search(l, 'math essay'), []);
    assert.equal(S.search(l, '  ').length, 2);
});

test('growthError: only growth past the limits is refused; shrinking or unchanged lists always pass', () => {
    assert.equal(S.growthError(many(5), many(5), false), null);
    assert.match(S.growthError(many(5), many(6), false), /limited to 5/);
    assert.equal(S.growthError(many(5), many(6), true), null);
    assert.match(S.growthError(many(100), many(101), true), /limited to 100/);
    assert.equal(S.growthError(many(8), many(8), false), null, 'a lapsed Pro keeps its list');
    assert.equal(S.growthError(many(8), many(7), false), null);
    assert.match(S.growthError(many(8), many(9), false), /limited to 5/);
    assert.match(S.growthError([], many(5, [MB, MB, MB, MB, MB]), false), /Only 4/);
    assert.equal(S.growthError([], many(5, [MB, MB, MB, MB, MB]), true), null);
    assert.match(S.growthError([], many(3, [3 * MB, 3 * MB, 3 * MB]), true), /8 MB in total/);
    assert.match(S.growthError([], [item(1, 5 * MB)], true), /at most 4 MB/);
    assert.equal(S.growthError([item(1, 5 * MB)], [item(1, 5 * MB)], true), null, 'an unchanged old exemplar is not re-judged');
    assert.equal(S.growthError(undefined, undefined, false), null);
});

test('Worker guardSavedCriteria: free over 5 needs Pro; Pro passes; refresh errors surface; within limits needs no lookup', async () => {
    const g = new TaskProtection({ storage: {} });
    const pro = { status: 'active', tier: 'pro', account_id: 'u1', keyo_version: 1, signed_token: 'x', valid_until: Date.now() + 1e6, expires_at: null };
    let lookups = 0; const tx = e => ({ get: async () => { lookups++; return e; } });
    const prev = { saved_criteria: many(5) }, grown = { saved_criteria: many(6) };
    await assert.rejects(g.guardSavedCriteria(tx(null), 'u1', prev, grown), { code: 'PRO_REQUIRED' });
    await assert.rejects(g.guardSavedCriteria(tx({ ...pro, status: 'expired' }), 'u1', prev, grown), { code: 'PRO_REQUIRED' });
    await assert.rejects(g.guardSavedCriteria(tx(pro), 'u1', prev, grown, new Error('keyo down')), { message: 'keyo down' });
    await g.guardSavedCriteria(tx(pro), 'u1', prev, grown);
    await assert.rejects(g.guardSavedCriteria(tx(pro), 'u1', { saved_criteria: many(100) }, { saved_criteria: many(101) }), { code: 'SAVED_CRITERIA_LIMIT' });
    lookups = 0;
    await g.guardSavedCriteria(tx(null), 'u1', prev, prev);
    await g.guardSavedCriteria(tx(null), 'u1', { saved_criteria: many(8) }, { saved_criteria: many(7) });
    await g.guardSavedCriteria(tx(null), 'u1', null, {});
    assert.equal(lookups, 0);
});

// ---- Test lab helpers ----
const blob = n => ({ size: n });
test('lab: Confirm needs a Validate score of 8+ for exactly the text in the box', () => {
    const side = { criteria: ' Photo of 2 pages ', validate: { criteria: 'Photo of 2 pages', score: 8 } };
    assert.equal(LAB.canConfirm(side), true);
    assert.equal(LAB.canConfirm({ ...side, validate: { criteria: 'Photo of 2 pages', score: 7 } }), false);
    assert.equal(LAB.canConfirm({ ...side, criteria: 'Photo of 3 pages' }), false, 'editing the text re-locks it');
    assert.equal(LAB.canConfirm({ criteria: 'x', validate: null }), false);
    assert.equal(LAB.canConfirm({ criteria: 'x', validate: { criteria: 'x', error: 'boom' } }), false);
    assert.equal(LAB.stale(side, side.validate), false); assert.equal(LAB.stale({ ...side, criteria: 'other' }, side.validate), true);
});

test('lab: a confirmed criteria becomes a Saved criteria item marked as lab, with a clean title', () => {
    const side = { criteria: ' Photo of 2 pages ', validate: { criteria: 'Photo of 2 pages', score: 9 } };
    const it = LAB.savedItem(side, '  My   lab  title ', null, 1700000000000, () => 0.123456);
    assert.equal(it.source, 'lab'); assert.equal(it.title, 'My lab title'); assert.equal(it.criteria, 'Photo of 2 pages'); assert.equal(it.score, 9);
    assert.equal(it.has_exemplar, false); assert.match(it.id, /^sc_1700000000000_/);
    assert.throws(() => LAB.savedItem(side, '  ', null), /title/);
    assert.throws(() => LAB.savedItem({ ...side, criteria: 'changed' }, 'T', null), /Validate this exact criteria/);
    const ex = { fileName: 'a.png', mimeType: 'image/png', fileSize: 10, data: 'AA' };
    assert.equal(LAB.savedItem(side, 'T', ex).has_exemplar, true);
});

test('lab: history keeps 30 tests and 25 MB, drops the oldest, never the one being edited', () => {
    const rec = (i, bytes = 0) => ({ id: 'r' + i, updated: i, files: bytes ? [{ blob: blob(bytes) }] : [], exemplar: null });
    assert.deepEqual(LAB.toDrop(Array.from({ length: 30 }, (_, i) => rec(i)), 'r0'), []);
    assert.deepEqual(LAB.toDrop(Array.from({ length: 32 }, (_, i) => rec(i)), 'r31'), ['r0', 'r1']);
    assert.deepEqual(LAB.toDrop(Array.from({ length: 31 }, (_, i) => rec(i)), 'r0'), ['r1'], 'the open test is kept even if it is the oldest');
    assert.deepEqual(LAB.toDrop([rec(1, 20 * MB), rec(2, 4 * MB), rec(3, 4 * MB)], 'r3'), ['r1']);
    assert.equal(LAB.sizeOf({ files: [{ blob: blob(3) }, { blob: blob(4) }], exemplar: { blob: blob(5) } }), 12);
});

test('lab: memory adapter stores, lists, deletes and clears; dbName is per account and safe', async () => {
    const a = LAB.memoryAdapter(), t = LAB.newTest(1000, () => 0.5);
    assert.match(t.id, /^lab_/); assert.equal(t.b, null); assert.equal(t.a.criteria, '');
    await a.put(t); assert.equal((await a.all()).length, 1);
    await a.put({ ...t, taskTitle: 'x' }); assert.equal((await a.all()).length, 1);
    await a.delete(t.id); assert.equal((await a.all()).length, 0);
    await a.put(t); await a.clear(); assert.equal((await a.all()).length, 0);
    assert.equal(LAB.dbName('user_1'), 'taskitator-test-lab-user_1'); assert.equal(LAB.dbName('a/b c'), 'taskitator-test-lab-a_b_c'); assert.equal(LAB.dbName(null), 'taskitator-test-lab-local');
    let deleted = null;
    assert.equal(await LAB.clear('u9', { deleteDatabase: n => { deleted = n; const q = {}; setTimeout(() => q.onsuccess()); return q; } }), true);
    assert.equal(deleted, 'taskitator-test-lab-u9');
});

test('wiring: sidebar, router, service worker, deletion and the picker use the new pieces', () => {
    const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    const html = read('index.html');
    for (const s of ['href="#test-lab"', 'data-shell-view="test-lab"', 'id="labRoot"', 'src="test-lab.js"', 'id="savedCriteriaSearch"']) assert.ok(html.includes(s), s);
    for (const f of ['index.html', 'components.html', 'login.html', 'settings.html']) { const h = read(f); assert.ok(h.indexOf('src="saved-criteria.js"') > -1 && h.indexOf('src="saved-criteria.js"') < h.indexOf('src="components.js"'), f); }
    const sw = read('sw.js'); assert.ok(sw.includes("'./test-lab.js'") && sw.includes("'./saved-criteria.js'"));
    assert.ok(read('shell-router.js').includes("TaskitatorTestLabView?.show()"));
    assert.ok(read('core.js').includes('TaskitatorTestLab.clear(user)'));
    assert.ok(read('worker.js').includes("import './saved-criteria.js'") && read('worker.js').includes('guardSavedCriteria'));
    const comp = read('components.js');
    for (const s of ['SC.addError(', 'SC.rename(', 'SC.search(', "item.source === 'lab'", 'rename-saved-crit-btn']) assert.ok(comp.includes(s), s);
    assert.doesNotMatch(comp, /MAX_SAVED_CRITERIA|MAX_EXEMPLARS/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
// Phase 3.6.1: Smart Study bulk tools, draft round trip, main/bonus day detail, chapter toggle, tab icons.
const store = new Map();
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.SyncEngine = { markLocalModified() {}, scheduleAutoPush() {} };
await import('./task-drafts.js');
const D = globalThis.TaskitatorDrafts, S = globalThis.TaskitatorSmartStudy, C = globalThis.TaskitatorStudyCore;
const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const rows = [
    { date: '2026-11-02', numbers: [1, 2, 3] }, { date: '2026-11-03', numbers: [4, 5, 6] },
    { date: '2026-11-04', numbers: [7, 8, 9] }, { date: '2026-11-05', numbers: [10, 11, 12] }];
const asObj = m => Object.fromEntries([...m].sort((a, b) => a[0] - b[0]));

test('take from next: N units, or the maximum when blank; first or last picks', () => {
    let r = S.bulk(rows, 'next', { amount: 2, pick: 'first' });
    assert.deepEqual(asObj(r.appearances), { 4: '2026-11-02', 5: '2026-11-02', 7: '2026-11-03', 8: '2026-11-03', 10: '2026-11-04', 11: '2026-11-04' });
    assert.equal(r.added, 6); assert.deepEqual(r.notes, [{ date: '2026-11-05', why: 'last' }]);
    r = S.bulk(rows, 'next', { amount: 9, pick: 'last' }, new Map());
    assert.deepEqual(asObj(r.appearances), { 4: '2026-11-02', 5: '2026-11-02', 6: '2026-11-02', 7: '2026-11-03', 8: '2026-11-03', 9: '2026-11-03', 10: '2026-11-04', 11: '2026-11-04', 12: '2026-11-04' });
    r = S.bulk(rows, 'next', { pick: 'last', amount: 1 });
    assert.deepEqual(asObj(r.appearances), { 6: '2026-11-02', 9: '2026-11-03', 12: '2026-11-04' });
});

test('scope limits which dates receive; weekday scope pairs Monday with Tuesday', () => {
    const mon = new Set(['2026-11-02', '2026-11-04']); // 2 Nov 2026 is a Monday
    const r = S.bulk(rows, 'next', { scope: mon, amount: 2 });
    assert.deepEqual(asObj(r.appearances), { 4: '2026-11-02', 5: '2026-11-02', 10: '2026-11-04', 11: '2026-11-04' });
    assert.equal(new Date('2026-11-02T12:00:00Z').getUTCDay(), 1);
});

test('a unit is never shown early twice and existing appearances are kept', () => {
    const first = S.bulk(rows, 'next', { amount: 1, scope: new Set(['2026-11-03']) });
    const r = S.bulk(rows, 'next', { amount: 2, scope: new Set(['2026-11-02']) }, first.appearances);
    assert.equal(r.appearances.get(7), '2026-11-03');
    assert.deepEqual([...r.appearances.keys()].sort((a, b) => a - b), [4, 5, 7]);
    const full = S.bulk(rows, 'next', { amount: 2, scope: new Set(['2026-11-02']) }, r.appearances);
    assert.equal(full.added, 1); // 6 is the only free unit left on the next date
});

test('stale appearances (unit gone, or date not earlier) are dropped', () => {
    const stale = new Map([[99, '2026-11-02'], [4, '2026-11-04'], [5, '2026-11-02']]);
    const r = S.bulk(rows, 'next', { amount: 1, scope: new Set(['2026-11-05']) }, stale);
    assert.deepEqual(asObj(r.appearances), { 5: '2026-11-02' });
    assert.equal(r.added, 0);
});

test('level to X per day pulls from later dates, counting what a date already shows', () => {
    const r = S.bulk(rows, 'level', { target: 5 });
    const per = d => 3 + [...r.appearances.values()].filter(x => x === d).length;
    assert.equal(per('2026-11-02'), 5); assert.equal(per('2026-11-03'), 5); assert.equal(per('2026-11-04'), 5);
    assert.deepEqual(r.notes, [{ date: '2026-11-05', why: 'short' }]);
    const small = S.bulk(rows, 'level', { target: 2 });
    assert.equal(small.added, 0);
});

test('template move: first or last X units of a date go early to another date', () => {
    let r = S.bulk(rows, 'move', { from: '2026-11-05', to: '2026-11-02', count: 2, pick: 'first' });
    assert.deepEqual(asObj(r.appearances), { 10: '2026-11-02', 11: '2026-11-02' });
    r = S.bulk(rows, 'move', { from: '2026-11-05', to: '2026-11-03', count: 2, pick: 'last' });
    assert.deepEqual(asObj(r.appearances), { 11: '2026-11-03', 12: '2026-11-03' });
    assert.throws(() => S.bulk(rows, 'move', { from: '2026-11-02', to: '2026-11-05', count: 1 }), /earlier/);
    assert.throws(() => S.bulk(rows, 'move', { from: '2026-11-05', to: '2026-11-02', count: 0 }), /whole number/);
    assert.throws(() => S.bulk(rows, 'move', { from: '2026-11-05', to: '2026-12-01', count: 1 }), /two dates/);
});

test('clear empties everything, bad input throws, inputs are never mutated', () => {
    const cur = new Map([[4, '2026-11-02']]), snap = new Map(cur);
    assert.equal(S.bulk(rows, 'clear', {}, cur).appearances.size, 0);
    S.bulk(rows, 'next', { amount: 1 }, cur);
    assert.deepEqual([...cur], [...snap]);
    assert.throws(() => S.bulk(rows, 'next', { amount: 0 }), /whole number/);
    assert.throws(() => S.bulk(rows, 'next', { amount: 2.5 }), /whole number/);
    assert.throws(() => S.bulk(rows, 'level', { target: 'x' }), /whole number/);
    assert.throws(() => S.bulk(rows, 'bogus', {}), /Unknown/);
});

test('bulk output is accepted by the plan normaliser (same engine, same rules)', () => {
    const cfg = { title: 'Math', total: 12, days: 4, start: '2026-11-02', weekdays: [], counts: [3, 3, 3, 3] };
    const r = S.bulk(C.rows(C.normalize(cfg)), 'next', { amount: 2 });
    const appearances = [...r.appearances].map(([unit, date]) => ({ unit, date }));
    assert.ok(appearances.length > 0);
    const n = C.normalize({ ...cfg, smart: { mode: 'original', appearances } });
    assert.equal(n.smart.appearances.length, appearances.length);
});

test('drafts keep bonus units, chapter fields and the whole Smart Study state', () => {
    store.clear();
    const id = D.saveStudy({ kind: 'create', title: 'T', info: { title: 'T', unit: 'Lesson', total: '20', bonus: '4', chapOn: true, chapSize: '5', chapLabel: 'Ch', parent: '', unitP: '', description: 'd' },
        ai: { enabled: false, criteria: '', exclude: '' }, schedule: {}, smart: { enabled: true, mode: 'dates', dates: ['2026-11-04', 'bad'], appearances: [{ unit: 4, date: '2026-11-02' }, { unit: 4, date: '2026-11-03' }, { unit: 'x', date: '2026-11-02' }] } });
    const d = D.getStudy(id);
    assert.deepEqual([d.info.bonus, d.info.chapOn, d.info.chapSize, d.info.chapLabel], ['4', true, '5', 'Ch']);
    assert.deepEqual(d.smart, { enabled: true, mode: 'dates', dates: ['2026-11-04'], appearances: [{ unit: 4, date: '2026-11-02' }] });
    const plain = D.getStudy(D.saveStudy({ kind: 'create', title: 'P', info: { title: 'P' }, ai: {}, schedule: {} }));
    assert.deepEqual(plain.smart, { enabled: false, mode: 'original', dates: [], appearances: [] });
});

test('day detail shows Main and Bonus separately and the stepper edits main only', () => {
    const s = src('pro/study-schedule.js');
    assert.ok(s.includes("tr('Main tasks')") && s.includes("tr('Bonus tasks')"));
    assert.ok(s.includes('setCount(date,main-1)') && s.includes('setCount(date,main+1)'));
    assert.ok(!s.includes('setCount(date,nums.length'));
});

test('chapter labels are an optional section after the description, in both panels', () => {
    const u = src('pro/study-plan.js');
    assert.ok(u.indexOf("field('Description (optional)'") < u.indexOf("field('Use chapter labels'"));
    assert.ok(u.includes('chapter_size:chapOn.checked?chapSize.value||null:null'));
    assert.ok(u.includes('chapBody.hidden=!chapOn.checked'));
    const p = src('study-plans.js');
    assert.ok(p.includes("tr('Use chapter labels')") && p.includes('chapOn: Boolean(plan.chapter)'));
});

test('tabs carry the notes, ai and calendar icons and keep their text', () => {
    for (const f of ['pro/study-plan.js', 'study-plans.js']) {
        const s = src(f);
        assert.ok(/'notes'/.test(s) && /'ai'/.test(s) && /'calendar'/.test(s), f);
        for (const t of ['Task info', 'AI criteria', 'Scheduling']) assert.ok(s.includes(t), f + t);
    }
    const ic = src('icons.js');
    for (const k of ["'notes'", "'ai'", "'calendar'"]) assert.ok(ic.includes(k), k);
});

test('Smart Study dialog: calendar, scope, tools, template and undo exist; saving a draft does not re-render the edit panel', () => {
    const u = src('pro/study-plan.js');
    for (const s of ['data-ss-smart-cell', 'data-ss-apply', 'data-ss-undo', 'data-ss-clear', 'Chosen weekdays', 'Chosen dates', 'Take from the next date', 'Level to a number per day', 'Template: move first or last units', 'List view']) assert.ok(u.includes(s), s);
    const p = src('study-plans.js'), fn = p.slice(p.indexOf('async function saveDraft'), p.indexOf('async function restoreDraft'));
    assert.ok(!/\brender\(\)/.test(fn));
    assert.ok(fn.includes("planSaveMsg"));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';

const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;
const SUN_THU = [0, 1, 2, 3, 4];
// Tuesday 2026-11-17 start, five study days over Sun-Thu: Tue, Wed, Thu, Sun, Mon.
const run = (total, rates, o = {}) => C.schedule(total, { mode: 'days', days: 5, rates, weekdays: SUN_THU, start: '2026-11-17', ...o });
const byDay = r => Object.fromEntries(r.dates.map((d, i) => [new Date(d + 'T00:00:00Z').toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }), r.counts[i]]));

test('your example: 25 units, 5 days Sun-Thu from Tuesday, Thu = 3 keeps 25 and 5 days; the others share 22', () => {
    const r = run(25, { 4: 3 });
    assert.equal(r.dates.length, 5);
    assert.equal(r.counts.reduce((a, b) => a + b, 0), 25);
    assert.equal(r.dates[0], '2026-11-17');
    // The current equal-split rule is kept: the first days take the extra units.
    assert.deepEqual(byDay(r), { Tue: 6, Wed: 6, Thu: 3, Sun: 5, Mon: 5 });
});

test('no specific amounts: the plain equal split is unchanged', () => {
    assert.deepEqual(run(25, {}).counts, [5, 5, 5, 5, 5]);
    assert.deepEqual(run(23, {}).counts, [5, 5, 5, 4, 4]);
    assert.deepEqual(run(23, { 3: '' }).counts, [5, 5, 5, 4, 4], 'an empty box is not a specific amount');
});

test('more than the default: the other days take less; a weekday that repeats gets its amount every time', () => {
    assert.deepEqual(byDay(run(25, { 4: 9 })), { Tue: 4, Wed: 4, Thu: 9, Sun: 4, Mon: 4 });
    const long = C.schedule(30, { mode: 'days', days: 10, rates: { 4: 2 }, weekdays: SUN_THU, start: '2026-11-17' });
    const thu = long.counts.filter((_, i) => new Date(long.dates[i] + 'T00:00:00Z').getUTCDay() === 4);
    assert.equal(thu.length, 2); assert.ok(thu.every(n => n === 2));
    assert.equal(long.counts.reduce((a, b) => a + b, 0), 30);
    assert.equal(long.counts.length, 10);
});

test('errors: every study day specific, too much fixed, nothing left for the others', () => {
    assert.throws(() => run(25, { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5 }), /Every study day has its own amount/);
    assert.throws(() => C.schedule(10, { mode: 'days', days: 3, rates: { 2: 4, 3: 4, 4: 4 }, weekdays: SUN_THU, start: '2026-11-17' }), /Every study day/);
    assert.throws(() => run(10, { 4: 10 }), /leaves nothing/);
    assert.throws(() => run(10, { 4: 12 }), /leaves nothing/);
    assert.throws(() => run(10, { 4: 7 }), /leave 3 for 4 other days/);
    assert.doesNotThrow(() => run(10, { 4: 6 }));
});

test('errors: 0, negative, decimal and out-of-range amounts are refused; zero says to uncheck the weekday', () => {
    assert.throws(() => run(25, { 4: 0 }), /uncheck it instead of typing 0/);
    for (const bad of [-1, 1.5, 1001, 'x']) assert.throws(() => run(25, { 4: bad }), /whole numbers/);
    assert.throws(() => run(25, { 9: 3 }), /valid weekdays/);
});

test('a weekday that is not among the plan days is reported and has no effect', () => {
    const r = C.schedule(12, { mode: 'days', days: 3, rates: { 0: 9 }, weekdays: SUN_THU, start: '2026-11-17' });
    assert.deepEqual(r.counts, [4, 4, 4]);
    assert.deepEqual(r.ignored, [0]);
    assert.deepEqual(run(25, { 4: 3 }).ignored, []);
});

test('Units per day keeps its own behaviour (amounts change the length) and zero is refused there too', () => {
    const r = C.schedule(25, { mode: 'perDay', per: 5, rates: { 4: 3 }, weekdays: SUN_THU, start: '2026-11-17' });
    assert.equal(r.counts.reduce((a, b) => a + b, 0), 25);
    assert.ok(r.counts.length > 5, 'the plan gets longer');
    assert.throws(() => C.schedule(25, { mode: 'perDay', per: 5, rates: { 4: 0 }, weekdays: SUN_THU, start: '2026-11-17' }), /uncheck it/);
});

test('every day (no weekdays selected) works and the total is always kept', () => {
    for (const [total, rates] of [[17, { 6: 1 }], [40, { 1: 2, 3: 9 }], [9, { 2: 1, 5: 1 }]]) {
        const r = C.schedule(total, { mode: 'days', days: 6, rates, weekdays: [], start: '2026-11-15' });
        assert.equal(r.counts.reduce((a, b) => a + b, 0), total);
        assert.ok(r.counts.every(n => n >= 1));
    }
});

// ---- editing starts from what the plan does now ----
function planFrom(dates, counts) {
    const tasks = [];
    dates.forEach((d, i) => {
        const pid = 'p' + i;
        tasks.push({ id: pid, parent_id: null, study_plan_id: 'plan_wd_amounts', status: 'active', due_date: d, title: 'Day ' + (i + 1), raw_title: 'Day ' + (i + 1), description: '' });
        for (let k = 0; k < counts[i]; k++) tasks.push({ id: pid + 'u' + k, parent_id: pid, study_plan_id: 'plan_wd_amounts', status: 'active', due_date: d, title: 'Bank.' + (k + 1), raw_title: 'Bank.{num==' + (k + 1) + '}' });
    });
    return M.plans(tasks)[0];
}
test('editing: weekday amounts are read back only when they rebuild the plan exactly', () => {
    // Single occurrences per weekday already read as a per-day pattern and rebuild exactly.
    const one = run(25, { 4: 3 });
    assert.equal(M.currentSchedule(planFrom(one.dates, one.counts), '2026-11-15', SUN_THU).mode, 'per');
    // Repeated weekdays with uneven counts are the case that needs the inference.
    const made = C.schedule(33, { mode: 'days', days: 10, rates: { 4: 2 }, weekdays: SUN_THU, start: '2026-11-17' });
    const cur = M.currentSchedule(planFrom(made.dates, made.counts), '2026-11-15', SUN_THU);
    assert.equal(cur.mode, 'cal');
    assert.deepEqual(cur.rates, { 4: 2 });
    const again = C.schedule(33, { mode: 'days', days: 10, rates: cur.rates, weekdays: cur.weekdays, start: made.dates[0] });
    assert.deepEqual(again.counts, made.counts);
    // A plain equal split gives no amounts.
    const eq = C.schedule(33, { mode: 'days', days: 10, rates: {}, weekdays: SUN_THU, start: '2026-11-17' });
    assert.deepEqual(M.currentSchedule(planFrom(eq.dates, eq.counts), '2026-11-15', SUN_THU).rates, {});
    // Counts set by hand that no rule explains: nothing is guessed.
    const odd = M.currentSchedule(planFrom(made.dates, made.counts.map((n, i) => (i === 2 ? n + 1 : n))), '2026-11-15', SUN_THU);
    assert.deepEqual(odd.rates, {});
});

test('UI: the weekday section opens after the first preview, the button regenerates, manual edits are protected, no Worker change', () => {
    const ui = fs.readFileSync(new URL('./pro/study-schedule.js', import.meta.url), 'utf8');
    for (const s of ["st.sched||Object.keys(st.rates).length>0", 'rateBox.open=true', "tr('Regenerate preview')", 'Regenerating replaces the changes you made to single days', 'paintRateMsg']) assert.ok(ui.includes(s), s);
    assert.doesNotMatch(fs.readFileSync(new URL('./pro/study-plan.js', import.meta.url), 'utf8').match(/function calSplit[\s\S]*?\n }\n/)[0], /bonus\s*[+*]|c\.bonus/);
});

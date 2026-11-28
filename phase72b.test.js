// Phase 7.2: streak counting modes, "make today required", choice boxes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './points.js';
import { FriendsService } from './friends-backend.js';

const P = globalThis.TaskitatorPoints;
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const at = (date, h = 12) => Date.parse(date + 'T' + String(h - 3).padStart(2, '0') + ':00:00Z'); // h o'clock Riyadh
const task = (id, extra = {}) => ({ id, title: id, status: 'completed', ...extra });
function sync(state, tasks, now, settings) {
    return P.record(state, { tasks: tasks.map(t => ({ ...t, status: 'active' })) }, { tasks, settings }, now).state;
}
// 2026-11-25 is a Wednesday; weekend Fri–Sat.
const NOFREE = { streak_free_days: [] };

test('modes: loose counts bonus, normal needs a non-bonus task, tight needs an AI-locked task', () => {
    const day = '2026-11-25';
    const bonusOnly = sync(null, [task('b', { is_bonus: true, completed_at: new Date(at(day)).toISOString() })], at(day), NOFREE);
    assert.deepEqual(bonusOnly.days[day], { p: 1, n: 1, r: 0, a: 0 });
    const s = { ...bonusOnly, modes: [{ from: '0000-01-01', mode: 'loose' }] };
    assert.equal(P.dayDone(s, day), true);
    assert.equal(P.dayDone({ ...s, modes: [{ from: '0000-01-01', mode: 'normal' }] }, day), false);
    assert.equal(P.dayDone({ ...s, modes: [{ from: '0000-01-01', mode: 'tight' }] }, day), false);
    const ai = sync(null, [task('x', { ai_locked: true, completed_at: new Date(at(day)).toISOString() })], at(day), NOFREE);
    assert.equal(P.dayDone({ ...ai, modes: [{ from: '0000-01-01', mode: 'tight' }] }, day), true);
    assert.equal(P.dayDone({ days: { [day]: { p: 3, n: 1 } }, modes: [{ from: '0000-01-01', mode: 'tight' }] }, day), true, 'pre-7.2 row counts in every mode');
});

test('a mode change starts next week; switching back before then cancels it', () => {
    const now = at('2026-11-25');
    let s = P.record(null, null, { tasks: [], settings: { ...NOFREE, streak_mode: 'tight' } }, now).state;
    assert.deepEqual(s.modes, [{ from: '2026-11-29', mode: 'tight' }], 'Sunday after the Fri–Sat weekend');
    assert.equal(P.summary(s, now).mode, 'loose'); assert.deepEqual(P.summary(s, now).mode_next, { from: '2026-11-29', mode: 'tight' });
    s = P.record(s, null, { tasks: [], settings: { ...NOFREE, streak_mode: 'loose' } }, now).state;
    assert.deepEqual(s.modes, []);
    s = P.record(s, null, { tasks: [], settings: { ...NOFREE, streak_mode: 'normal' } }, now).state;
    assert.equal(P.summary(s, at('2026-11-30')).mode, 'normal');
});

test('streak follows the mode in effect each day', () => {
    const days = ['2026-11-23', '2026-11-24', '2026-11-25'];
    let s = null;
    days.forEach((d, i) => { s = sync(s, [task('t' + i, { is_bonus: i === 1, completed_at: new Date(at(d)).toISOString() })], at(d), NOFREE); });
    assert.equal(P.streakOf(s, days[2]), 3);
    assert.equal(P.streakOf({ ...s, modes: [{ from: '0000-01-01', mode: 'normal' }] }, days[2]), 1, 'the bonus-only day breaks a Normal streak');
});

test('make today required: once per free date, earlier and re-finished tasks give nothing, next week stays free', () => {
    const fri = '2026-11-27', settings = {}; // default free days = weekend Fri–Sat
    const t1 = task('a', { priority_id: 'prio_high', completed_at: new Date(at(fri, 9)).toISOString() });
    let s = sync(null, [t1], at(fri, 9), settings);
    assert.equal(P.summary(s, at(fri, 10)).today.can_require, true);
    assert.equal(P.summary(s, at(fri, 10)).today.points, 0);
    assert.equal(P.streakOf(s, fri), 0);
    const req = P.requireDay(s, { tasks: [t1, task('offline', { completed_at: new Date(at(fri, 8)).toISOString() })], settings }, at(fri, 10));
    assert.equal(req.excluded, 2);
    s = req.state;
    assert.equal(P.requireDay(s, { tasks: [], settings }, at(fri, 11)).error, 'Today is already required.');
    let sum = P.summary(s, at(fri, 10));
    assert.equal(sum.today.required, true); assert.equal(sum.today.free, false); assert.equal(sum.today.can_require, false); assert.equal(sum.today.done, false);
    // re-finish the excluded task, finish a late-synced task from before the press, then a new one
    s = P.record(s, { tasks: [] }, { tasks: [{ ...t1, completed_at: new Date(at(fri, 11)).toISOString() }, task('old', { completed_at: new Date(at(fri, 9, 30)).toISOString() })], settings }, at(fri, 11)).state;
    assert.equal(P.summary(s, at(fri, 11)).today.count, 0, 'excluded by id and by time');
    s = P.record(s, { tasks: [] }, { tasks: [task('new', { priority_id: 'prio_high', completed_at: new Date(at(fri, 12)).toISOString() })], settings }, at(fri, 12)).state;
    sum = P.summary(s, at(fri, 12));
    assert.equal(sum.today.points, 5); assert.equal(sum.today.done, true); assert.equal(sum.streak, 1);
    // missing the required day breaks the streak; the next Friday is free again
    assert.equal(P.isFree(s, '2026-12-04'), true);
    assert.equal(P.requireDay(s, { tasks: [], settings }, at('2026-11-25')).error, 'Today isn’t a free day.');
});

test('a required day left empty breaks the streak instead of being skipped', () => {
    let s = null;
    s = sync(s, [task('thu', { completed_at: new Date(at('2026-11-26')).toISOString() })], at('2026-11-26'), {});
    s = P.requireDay(s, { tasks: [], settings: {} }, at('2026-11-27', 10)).state; // Friday made required, nothing finished
    assert.equal(P.streakOf(s, '2026-11-28'), 0, 'Friday required and empty breaks it (Saturday is still free)');
    const plain = sync(null, [task('thu', { completed_at: new Date(at('2026-11-26')).toISOString() })], at('2026-11-26'), {});
    assert.equal(P.streakOf(plain, '2026-11-28'), 1, 'a normal free Friday is skipped');
});

test('duo streak uses each person\'s mode and required days', () => {
    const svc = new FriendsService({ storage: {} });
    const now = at('2026-11-25');
    const a = { days: { '2026-11-24': { p: 1, n: 1, r: 0, a: 0 }, '2026-11-25': { p: 1, n: 1, r: 1, a: 0 } }, free: [{ from: '0000-01-01', days: [] }], modes: [{ from: '0000-01-01', mode: 'normal' }] };
    const b = { days: { '2026-11-24': { p: 1, n: 1 }, '2026-11-25': { p: 1, n: 1 } }, free: [{ from: '0000-01-01', days: [] }] };
    assert.equal(svc.duo(a, b, now), 1, 'A\'s bonus-only Tuesday breaks the duo streak in Normal');
});

test('Worker route, Settings card, choice boxes, Points panel button, cache', () => {
    const w = read('worker.js'), s = read('settings.html'), css = read('style.css'), ui = read('points-ui.js');
    assert.match(w, /P\.requireDay\(await tx\.get\(pk\), snapshot, Date\.now\(\)\)/);
    assert.match(s, /id="streakModeGroup" role="radiogroup"/);
    for (const m of ['tight', 'normal', 'loose']) assert.match(s, new RegExp(`name="streakMode" value="${m}"`));
    assert.match(s, /class="status-mode-group tk-choices"/);
    assert.equal((s.match(/class="status-mode-opt tk-choice"/g) || []).length, 3);
    assert.match(s, /settings\.streak_mode = streakModeValue\(\)/);
    assert.match(css, /\.tk-choice:has\(input:checked\)\{border-color:var\(--primary\);background:var\(--accent-light\)/);
    assert.match(ui, /TaskitatorAuth\.api\('\/points\/require', \{ method: 'POST', body: '\{\}' \}\)/);
    assert.match(ui, /await window\.SyncEngine\?\.syncNow\?\.\(\{ origin: 'manual' \}\);\n\s+const r = await window\.TaskitatorAuth\.api\('\/points\/require'/, 'syncs before pressing');
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v82'/);
    for (const k of ['Make today required', 'Streak counting', 'Tight', 'Loose', 'Switch to Tight?']) assert.ok(read('locales/ar.js').includes('"' + k + '"'), k);
});

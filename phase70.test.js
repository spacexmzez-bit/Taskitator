// Phase 7.0: points, ranks and streak (points.js on the Worker, points-ui.js in the browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const ctx = {}; vm.runInNewContext(read('points.js'), ctx);
const P = ctx.TaskitatorPoints;
const plain = v => JSON.parse(JSON.stringify(v));

// Riyadh is UTC+3: noon Riyadh = 09:00Z.
const at = (date, h = 9) => Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00Z`);
const iso = ms => new Date(ms).toISOString();
const prios = n => ({ custom_priorities: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, rank: i + 1 })) });
const task = (id, extra = {}) => ({ id, title: id, status: 'active', priority_id: 'p0', ...extra });
const done = (t, ms) => ({ ...t, status: 'completed', completed_at: iso(ms) });
// Mon-Fri week, weekend Fri-Sat (default 5..6).
function run(state, prevTasks, nextTasks, now, settings = prios(3)) {
    return P.record(state, { tasks: prevTasks, settings }, { tasks: nextTasks, settings }, now);
}

test('weight: highest 5, lowest 1, evenly spaced and rounded; 1 level = 3; none = 1', () => {
    const w = n => Array.from({ length: n }, (_, i) => P.weight('p' + i, prios(n)));
    assert.deepEqual(w(1), [3]);
    assert.deepEqual(w(2), [5, 1]);
    assert.deepEqual(w(3), [5, 3, 1]);
    assert.deepEqual(w(5), [5, 4, 3, 2, 1]);
    assert.deepEqual(w(10), [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    assert.equal(P.weight(null, prios(3)), 1);
    assert.equal(P.weight('gone', prios(3)), 1);
    assert.deepEqual([P.weight('prio_high', {}), P.weight('prio_med', {}), P.weight('prio_low', {})], [5, 3, 1], 'default priorities');
    // Order follows rank, not array position
    assert.equal(P.weight('b', { custom_priorities: [{ id: 'a', rank: 2 }, { id: 'b', rank: 1 }] }), 5);
});

test('ranks: rapid early ladder up to Legend', () => {
    assert.deepEqual(plain(P.RANKS.map(r => r.min)), [0, 15, 40, 90, 180, 350, 650, 1100, 1800, 3000, 5000, 8000]);
    assert.equal(P.rankFor(0).name, 'Seedling');
    assert.equal(P.rankFor(14).name, 'Seedling');
    assert.equal(P.rankFor(15).name, 'Sprout');
    assert.equal(P.rankFor(15).next, 'Sapling');
    assert.equal(P.rankFor(99999).name, 'Legend');
    assert.equal(P.rankFor(99999).next, null);
});

test('award: by completion time, once per task; reopen and complete again gives nothing', () => {
    const now = at('2026-11-25', 12);
    const t = task('a');
    let r = run(null, [t], [done(t, now - 3600e3)], now);
    assert.equal(r.gained, 5);
    assert.equal(r.state.total, 5);
    // reopened...
    r = run(r.state, [done(t, now - 3600e3)], [t], now + 1000);
    assert.equal(r.gained, 0);
    // ...and completed again
    r = run(r.state, [t], [done(t, now + 2000)], now + 3000);
    assert.equal(r.gained, 0);
    assert.equal(r.state.total, 5);
    // A task overdue for a week, finished today, still counts today
    const late = task('late', { due_date: '2026-11-10' });
    r = run(r.state, [late], [done(late, now)], now);
    assert.equal(r.gained, 5);
    assert.equal(r.state.days['2026-11-25'].n, 2);
});

test('award: only the tapped task; cascaded subtasks (same completed_at as their parent) earn nothing', () => {
    const now = at('2026-11-25', 12);
    const parent = task('p'), kid = task('k', { parent_id: 'p' }), lone = task('l', { parent_id: 'p' });
    const r = run(null, [parent, kid, lone], [done(parent, now), done(kid, now), done(lone, now - 60000)], now);
    assert.equal(r.gained, 10, 'parent and the separately tapped subtask');
    assert.equal(Object.hasOwn(r.state.awarded, 'k'), false);
});

test('award: 150 a day, offline completions up to 7 days old, nothing from the future', () => {
    const now = at('2026-11-25', 12);
    const many = Array.from({ length: 40 }, (_, i) => task('t' + i));
    let r = run(null, many, many.map((t, i) => done(t, now - i * 1000)), now);
    assert.equal(r.gained, 150);
    assert.equal(r.state.days['2026-11-25'].n, 40, 'every completion still counts toward the streak');
    const old = task('old'), week = task('week'), future = task('future');
    r = run(r.state, [old, week, future], [done(old, now - 8 * 86400e3), done(week, now - 6 * 86400e3), done(future, now + 3600e3)], now);
    assert.equal(r.gained, 5);
    assert.ok(r.state.days['2026-11-19']);
});

test('day boundary: the logical day follows Riyadh time and the day-start hour', () => {
    const settings = { ...prios(1), day_start_hour: 3 };
    const t = task('n');
    const ms = Date.parse('2026-11-25T23:30:00Z'); // 02:30 Riyadh on the 26th, before a 03:00 day start
    const r = run(null, [t], [done(t, ms)], ms, settings);
    assert.ok(r.state.days['2026-11-25']);
});

test('streak: one task a day; today not yet done keeps it; a missed day resets; best is kept', () => {
    const settings = { ...prios(1), streak_free_days: [] };
    let state = null;
    for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) {
        const t = task('s' + d);
        state = run(state, [t], [done(t, at(d))], at(d), settings).state;
    }
    assert.equal(P.summary(state, at('2026-11-22')).streak, 3);
    assert.equal(P.summary(state, at('2026-11-23')).streak, 3, 'today not done yet');
    assert.equal(P.summary(state, at('2026-11-24')).streak, 0, 'missed the 23rd');
    const t = task('s24');
    state = run(state, [t], [done(t, at('2026-11-24'))], at('2026-11-24'), settings).state;
    const s = P.summary(state, at('2026-11-24'));
    assert.equal(s.streak, 1);
    assert.equal(s.best, 3);
});

test('free days: no points, never break or add to the streak; default is the weekend', () => {
    // 2026-11-27 is a Friday, 28 Saturday (default weekend 5..6)
    const settings = prios(1);
    let state = null;
    for (const d of ['2026-11-25', '2026-11-26']) { const t = task('f' + d); state = run(state, [t], [done(t, at(d))], at(d), settings).state; }
    assert.deepEqual(plain(P.summary(state, at('2026-11-26')).free_days), [5, 6]);
    const fri = task('fri');
    const r = run(state, [fri], [done(fri, at('2026-11-27'))], at('2026-11-27'), settings);
    assert.equal(r.gained, 0, 'free day earns nothing');
    state = r.state;
    assert.equal(P.summary(state, at('2026-11-29')).streak, 2, 'Fri and Sat skipped, Sun not done yet');
    const sun = task('sun');
    state = run(state, [sun], [done(sun, at('2026-11-29'))], at('2026-11-29'), settings).state;
    assert.equal(P.summary(state, at('2026-11-29')).streak, 3);
});

test('free days: a change starts next week, and is capped at weekend + 2', () => {
    const base = prios(1);
    let state = run(null, [], [], at('2026-11-24'), base).state; // Tuesday; schedule starts as the weekend
    state = run(state, [], [], at('2026-11-24'), { ...base, streak_free_days: [2, 3, 5, 6] }).state;
    let s = P.summary(state, at('2026-11-24'));
    assert.equal(s.today.free, false, 'Tuesday cannot become free today');
    assert.deepEqual(plain(s.free_next), { from: '2026-11-29', days: [2, 3, 5, 6] }, 'next week starts the day after the weekend (Sunday)');
    assert.equal(P.summary(state, at('2026-12-01')).today.free, true, 'Tuesday next week is free');
    // Changing back before it starts drops the pending change
    state = run(state, [], [], at('2026-11-25'), base).state;
    assert.equal(P.summary(state, at('2026-11-25')).free_next, null);
    assert.equal(P.freeDays({ streak_free_days: [0, 1, 2, 3, 4, 5, 6] }).length, 4, 'two-day weekend + 2');
    assert.equal(P.maxFree({ weekend_start: 4, weekend_end: 6 }), 5);
});

test('ledger pruning keeps the record small', () => {
    const now = at('2026-11-25');
    const old = { v: 1, total: 9, best: 1, days: { '2024-01-01': { p: 1, n: 1 } }, awarded: { x: 0 }, free: [], hour: 0 };
    const r = P.record(old, { tasks: [] }, { tasks: [], settings: {} }, now);
    assert.equal(Object.hasOwn(r.state.awarded, 'x'), false);
    assert.equal(Object.hasOwn(r.state.days, '2024-01-01'), false);
    assert.equal(r.state.total, 9, 'totals never shrink');
});

test('Worker: awards inside the push transaction, outside the snapshot, and returns the summary', () => {
    const w = read('worker.js');
    assert.match(w, /import '\.\/points\.js';/);
    assert.match(w, /const pointsKey = user => 'points:' \+ user;/);
    assert.match(w, /awarded=P\.record\(await tx\.get\(pk\),previous,snapshot,Date\.now\(\)\);\s*if\(awarded\.changed\)await tx\.put\(pk,awarded\.state\);/);
    assert.ok(w.indexOf('P.record(') < w.indexOf('await saveSnapshot(tx, user, meta, snapshot);'));
    assert.match(w, /today_breaks:await this\.breaks\.overlay\(tx,identity\.userId,snapshot\.today_breaks\),points \}\)/);
    assert.match(w, /const pointsRoute = \(method === 'GET' && path === '\/points'\) \|\| \(method === 'POST' && path === '\/points\/require'\);/);
    assert.match(w, /!pointsRoute && /);
    assert.match(w, /phoneDevicesKey\(link\.user\),pointsKey\(link\.user\),'friends:'\+identity\.userId\]/, 'account deletion removes the ledger and friends record');
});

test('Browser: sync dispatches the summary; strip, panel, cache per account; free days in Settings', () => {
    const core = read('core.js');
    assert.match(core, /if\(data\.points&&typeof data\.points==='object'\)window\.dispatchEvent\(new CustomEvent\('taskitator-points',\{detail:data\.points\}\)\)/);
    assert.match(core, /'taskitator_points_cache'/);
    const index = read('index.html');
    assert.match(index, /<button type="button" class="points-strip" id="pointsStrip" hidden><\/button>/);
    assert.match(index, /src="points\.js\?v=pts-v1"><\/script>\n<script type="text\/taskitator-script" src="points-ui\.js\?v=pts-v\d">/);
    const sw = read('sw.js');
    assert.match(sw, /'\.\/points\.js', '\.\/points-ui\.js'/);
    assert.match(sw, /CACHE_NAME = 'taskitator-phase4-v78'/);
    const ui = read('points-ui.js');
    assert.match(ui, /window\.addEventListener\('taskitator-points', e => update\(e\.detail, true\)\)/);
    assert.match(ui, /auth\.api\('\/points'\)/);
    const settings = read('settings.html');
    assert.match(settings, /id="streakFreeDays"/);
    assert.match(settings, /settings\.streak_free_days = streakFreeValue\(\)/);
    assert.match(settings, /src="points\.js\?v=pts-v1"/);
    const ar = read('locales/ar.js');
    for (const k of ['Points & streak', 'Seedling', 'Legend', 'Free days', '+{0} points', 'New rank: {0}!']) assert.ok(ar.includes('"' + k + '"'), k);
});

test('Browser UI: strip renders the summary and a rank-up toasts once', () => {
    const els = {};
    const mk = (tag) => ({ tag, children: [], style: {}, className: '', hidden: false, attrs: {}, textContent: '',
        append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; },
        classList: { add() {}, remove() {}, contains: () => false }, focus() {}, addEventListener() {} });
    els.pointsStrip = mk('button'); els.pointsStrip.hidden = true;
    const toasts = [], listeners = {};
    const store = {}; const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
    const window = { TaskitatorPoints: P, TaskitatorAuth: { userId: 'u1' }, TaskitatorNotify: (m, t) => toasts.push(m),
        addEventListener: (t, f) => { listeners[t] = f; } };
    const document = { createElement: mk, getElementById: id => els[id] || null, addEventListener() {}, visibilityState: 'visible' };
    vm.runInNewContext(read('points-ui.js'), { window, document, localStorage });
    const sum = P.summary(P.record(null, null, { tasks: [done(task('a'), at('2026-11-25'))], settings: prios(1) }, at('2026-11-25')).state, at('2026-11-25'));
    window.TaskitatorPointsUI.update({ ...sum, gained: 3 }, true);
    assert.equal(els.pointsStrip.hidden, false);
    assert.equal(toasts.length, 0, 'no toast without an earlier summary');
    const more = { ...sum, total: 20, rank: P.rankFor(20), gained: 17 };
    window.TaskitatorPointsUI.update(more, true);
    assert.deepEqual(toasts, ['New rank: Sprout!']);
    assert.equal(JSON.parse(store.taskitator_points_cache).owner, 'u1');
});

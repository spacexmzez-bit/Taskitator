import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const J = v => JSON.parse(JSON.stringify(v));

const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['pro/early-bonus.js', 'pro/early-move.js']) vm.runInContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), ctx);
const M = ctx.TaskitatorEarlyMove, E = ctx.TaskitatorEarly;
const T = '2026-03-10', TM = '2026-03-11';

const unit = (plan, n, date, extra = {}) => ({ id: `${plan}_u${n}`, title: `Unit ${n}`, raw_title: `Unit {num==${n}}`, parent_id: `${plan}_${date}`, study_plan_id: plan, status: 'active', ...extra });
const parent = (plan, date) => ({ id: `${plan}_${date}`, title: `Math ${date.slice(-2)}`, raw_title: `Math ${date.slice(-2)}`, study_plan_id: plan, status: 'active', due_date: date });
const plan = (id, today, tomorrow, extra = {}) => [parent(id, T), parent(id, TM), ...today.map(n => unit(id, n, T, extra)), ...tomorrow.map(n => unit(id, n, TM, extra))];

test('plan with nothing left today unlocks and lists tomorrow units in order', () => {
    const tasks = plan('p', [1], [3, 2]); tasks.find(t => t.id === 'p_u1').status = 'completed';
    const [b] = M.blocks(tasks, T);
    assert.equal(b.locked, false); assert.equal(b.name, 'Math');
    assert.deepEqual(J(b.units.map(u => u.title)), ['Unit 2', 'Unit 3']);
    assert.deepEqual(J(b.units.map(u => u.id)), ['p_u2', 'p_u3']);
});
test('own unfinished tasks today lock the plan, including units shown early today', () => {
    const open = plan('p', [1], [2]);
    assert.deepEqual(J([M.blocks(open, T)[0].locked, M.blocks(open, T)[0].own]), [true, 1]);
    const tasks = plan('p', [1], [2, 3]); tasks[2].status = 'completed';
    assert.equal(M.blocks(tasks, T)[0].locked, false);
    tasks.find(t => t.id === 'p_u3').early_date = T; // already pulled and unfinished -> still on today's list
    const b = M.blocks(tasks, T)[0];
    assert.equal(b.locked, true); assert.equal(b.own, 1);
    assert.deepEqual(J(b.units.map(u => u.id)), ['p_u2']);
});
test('AI-audited tasks outside the plan lock it; plain tasks do not', () => {
    const tasks = plan('p', [], [1]);
    tasks.push({ id: 'x', title: 'Plain', status: 'active', due_date: T });
    assert.equal(M.blocks(tasks, T)[0].locked, false);
    tasks.push({ id: 'a', title: 'Audited', status: 'active', due_date: T, ai_locked: true });
    let b = M.blocks(tasks, T)[0];
    assert.deepEqual(J([b.locked, b.others]), [true, 1]);
    tasks.find(t => t.id === 'a').status = 'completed';
    assert.equal(M.blocks(tasks, T)[0].locked, false);
    tasks.push({ id: 'o', title: 'Overdue audited', status: 'active', due_date: '2026-03-01', require_ai_proof: true });
    assert.equal(M.blocks(tasks, T)[0].locked, true);
    tasks.push({ id: 'f', title: 'Future audited', status: 'active', due_date: '2026-03-20', ai_locked: true });
    assert.equal(M.blocks(tasks, T)[0].others, 1);
});
test('audited units of another plan block, own plan audited units count as own', () => {
    const tasks = [...plan('p', [], [1]), ...plan('q', [1], [], { ai_locked: true })];
    const p = M.blocks(tasks, T).find(b => b.id === 'p');
    assert.deepEqual(J([p.locked, p.others]), [true, 1]);
});
test('only required, non-recurring, non-Smart, non-already-early tomorrow units are offered', () => {
    const tasks = plan('p', [], [1, 2, 3, 4, 5]);
    tasks.find(t => t.id === 'p_u2').is_bonus = true;
    tasks.find(t => t.id === 'p_u3').recurrence_series_id = 'r';
    tasks.find(t => t.id === 'p_u4').smart_early_date = T;
    tasks.find(t => t.id === 'p_u5').early_date = T;
    assert.deepEqual(J(M.blocks(tasks, T)[0].units.map(u => u.id)), ['p_u1']);
    const none = plan('p', [], [1]); none[2].status = 'completed';
    assert.deepEqual(J(M.blocks(none, T)), []);
});
test('apply uses the early mechanism: due date unchanged, only unlocked plans move', () => {
    const tasks = [...plan('p', [], [1, 2]), ...plan('q', [1], [2])];
    const res = M.apply(tasks, ['p_u1', 'q_u2', 'ghost'], T);
    assert.deepEqual(J(res.set), ['p_u1']); assert.equal(res.rejected, 2);
    const u = tasks.find(t => t.id === 'p_u1');
    assert.equal(u.early_date, T);
    assert.equal(E.dueOf(E.index(tasks), u), TM);
    assert.equal(tasks.find(t => t.id === 'q_u2').early_date, undefined);
    assert.equal(E.showing(E.index(tasks), u, T), true);
});
test('a pulled unit shows today and locks nothing new once done', () => {
    const tasks = plan('p', [], [1, 2]);
    M.apply(tasks, ['p_u1'], T);
    assert.equal(M.blocks(tasks, T)[0].locked, true, 'the pulled unit is now today\'s work');
    tasks.find(t => t.id === 'p_u1').status = 'completed';
    assert.equal(M.blocks(tasks, T)[0].locked, false);
    assert.deepEqual(J(M.blocks(tasks, T)[0].units.map(u => u.id)), ['p_u2']);
});
test('month-end tomorrow and wiring: Today button, panel, Pro gate, script registered', () => {
    assert.equal(M.addDay('2026-02-28'), '2026-03-01');
    const root = new URL('./', import.meta.url);
    const read = f => fs.readFileSync(new URL(f, root), 'utf8');
    assert.match(read('index.html'), /id="pullTomorrowBtn"/);
    assert.match(read('index.html'), /src="pro\/early-move\.js"/);
    assert.match(read('sw.js'), /\.\/pro\/early-move\.js/);
    assert.match(read('worker.js') + read('app.js'), /TaskitatorEarlyMove\.apply\(tasks, ids, getAppTodayStr\(\)\)/);
    assert.match(read('app.js'), /checkConsecutiveEntitlement\?\.\(\)\.then\(access => \{\s*if \(access\?\.allowed\) \{ renderPullTomorrowPanel\(true\)/);
});

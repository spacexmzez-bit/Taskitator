import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(fs.readFileSync(new URL('./root-completion.js', import.meta.url), 'utf8'), { window, Date, Map, Set, JSON, Number, Math, Boolean, Array });
const RC0 = window.TaskitatorRootCompletion;
const RC = { ...RC0, removable: (...a) => [...RC0.removable(...a)] };
const T = (id, parent = null, extra = {}) => ({ id, title: id, parent_id: parent, status: 'active', ...extra });
const ids = v => [...v].sort();

test('completing an unshielded root removes unfinished, unprotected descendants of any depth', () => {
    const tasks = [T('r'), T('a', 'r'), T('a1', 'a'), T('b', 'r', { status: 'completed' }), T('b1', 'b')];
    assert.deepEqual(ids(RC.removable(tasks, 'r')), ['a', 'a1', 'b1']);
});

test('bonus, AI-protected and shielded work stays, with the path leading to it', () => {
    const tasks = [
        T('r'), T('plain', 'r'),
        T('path', 'r'), T('bonus', 'path', { is_bonus: true }),
        T('ai', 'r', { ai_locked: true }), T('proof', 'r', { require_ai_proof: true }),
        T('shield', 'r', { strict_prerequisites: true }), T('inShield', 'shield'), T('deep', 'inShield')
    ];
    assert.deepEqual(ids(RC.removable(tasks, 'r')), ['plain']);
});

test('a shielded root, a child task, trash and completed tasks are never removed', () => {
    const tasks = [T('r', null, { strict_prerequisites: true }), T('a', 'r', { is_bonus: true }), T('c', 'r'), T('c1', 'c'), T('t', 'r', { status: 'trash' })];
    assert.deepEqual(RC.removable(tasks, 'r'), []);
    assert.deepEqual(RC.removable(tasks, 'c'), [], 'only roots follow this rule');
    assert.deepEqual(RC.removable([T('x'), T('y', 'x', { status: 'trash' }), T('z', 'x', { status: 'completed' })], 'x'), []);
});

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const done = (id, parent, day, extra = {}) => T(id, parent, { status: 'completed', completed_at: day + 'T10:00:00.000Z', ...extra });

test('a completed root stays visible on its own day and hides with its branch after it', () => {
    const tasks = [done('r', null, '2026-11-14'), done('k', 'r', '2026-11-13'), done('k1', 'k', '2026-11-12'), T('live')];
    assert.equal(RC.hiddenIds(tasks, '2026-11-14', dayOf).size, 0);
    assert.deepEqual(ids(RC.hiddenIds(tasks, '2026-11-15', dayOf)), ['k', 'k1', 'r']);
});

test('roots with unfinished work, roots in the undo window and completed children are not hidden', () => {
    const tasks = [
        done('r1', null, '2026-11-10'), T('bonus', 'r1', { is_bonus: true }),
        done('r2', null, '2026-11-10'),
        T('r3'), done('c3', 'r3', '2026-11-10'),
        done('r4', null, '2026-11-10'), T('gone', 'r4', { status: 'trash' }),
        T('r5', null, { status: 'completed', completed_at: 'nonsense' })
    ];
    const hidden = RC.hiddenIds(tasks, '2026-11-14', dayOf, id => id === 'r2');
    assert.deepEqual(ids(hidden), ['r4']);
});

test('hiddenNow uses the logical day and day start hour', () => {
    const store = { taskitator_settings: JSON.stringify({ day_start_hour: 4 }) };
    const w = { localStorage: { getItem: k => store[k] ?? null },
        TaskitatorRecurrence: { today: (ms, hour) => new Date(ms + (3 - hour) * 3600000).toISOString().slice(0, 10) } };
    vm.runInNewContext(fs.readFileSync(new URL('./root-completion.js', import.meta.url), 'utf8'), { window: w, Date, Map, Set, JSON, Number, Math, Boolean, Array });
    // Completed 23:00 Riyadh on the 13th; at 02:00 on the 14th the logical day (starts 04:00) is still the 13th.
    const tasks = [T('r', null, { status: 'completed', completed_at: '2026-11-13T20:00:00.000Z' })];
    assert.equal(w.TaskitatorRootCompletion.hiddenNow(tasks, () => false, Date.parse('2026-11-13T23:00:00.000Z')).size, 0);
    assert.equal(w.TaskitatorRootCompletion.hiddenNow(tasks, () => false, Date.parse('2026-11-14T01:30:00.000Z')).size, 1);
});

// The real setRootStatus/cascadeTaskStatus from app.js.
function appHarness(tasks) {
    const src = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const grab = name => { const a = src.indexOf(`    function ${name}(`); const b = src.indexOf('\n    }\n', a); assert.ok(a > 0 && b > a, name); return src.slice(a, b + 7); };
    const ctx = { tasks, window: { TaskitatorRootCompletion: RC }, Date, Set, Map, pendingGraceCompletions: new Map() };
    vm.runInNewContext(['getAllDescendants', 'setRootStatus', 'cascadeTaskStatus'].map(grab).join('\n') + '\nthis.set = cascadeTaskStatus;', ctx);
    return ctx.set;
}

test('app: completing a root trashes removable children without marking any child done; reopening restores them', () => {
    const tasks = [T('r'), T('a', 'r'), T('b', 'r', { is_bonus: true }), done('c', 'r', '2026-11-12')];
    const set = appHarness(tasks);
    const by = id => tasks.find(t => t.id === id);
    set('r', 'completed', '2026-11-14T09:00:00.000Z');
    assert.equal(by('r').status, 'completed');
    assert.equal(by('a').status, 'trash');
    assert.equal(by('a').trashed_by_completion, 'r');
    assert.equal(by('b').status, 'active', 'bonus stays unfinished, not completed');
    assert.equal(by('c').completed_at, '2026-11-12T10:00:00.000Z', 'earlier completions keep their time');
    set('r', 'active', null);
    assert.equal(by('r').status, 'active');
    assert.equal(by('a').status, 'active');
    assert.equal(by('a').trashed_by_completion, undefined);
    assert.equal(by('c').status, 'completed', 'children finished on their own stay finished');
});

test('app: reopening a root from older data reopens children that were cascaded with it', () => {
    const stamp = '2026-11-10T08:00:00.000Z';
    const tasks = [T('r', null, { status: 'completed', completed_at: stamp }), T('a', 'r', { status: 'completed', completed_at: stamp })];
    appHarness(tasks)('r', 'active', null);
    assert.equal(tasks[1].status, 'active');
});

test('wiring: shell loads the module, views hide expired roots, Projects shows completed children', () => {
    const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    assert.ok(index.indexOf('src="root-completion.js"') > 0 && index.indexOf('src="root-completion.js"') < index.indexOf('src="app.js'));
    assert.match(fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8'), /'\.\/root-completion\.js'/);
    const projects = fs.readFileSync(new URL('./views/projects.js', import.meta.url), 'utf8');
    assert.match(projects, /t\.status === 'active' \|\| t\.status === 'completed'/);
    assert.match(projects, /hiddenCompletedIds/);
    const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    assert.match(app, /if \(expired\.has\(t\.id\)\) return false;/);
    assert.match(fs.readFileSync(new URL('./views/calendar.js', import.meta.url), 'utf8'), /TaskitatorApp\.handleTaskCompletion\(current\.id/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// Runs the real Today/General root selection from renderUnifiedTaskTree.
const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const a = source.indexOf('        const allChildrenMap = new Map();');
const b = source.indexOf('        rootTasks = sortTasks(rootTasks);', a);
assert.ok(a >= 0 && b > a);
const body = source.slice(a, b) + 'return {roots: rootTasks.map(t => t.id), paths: Object.fromEntries([...todayAnchorPaths].map(([k, v]) => [k, v.map(x => x.title)])), kids: id => (visibleChildrenMap.get(id) || []).map(t => t.id)};';
const today = '2026-11-05';
function run(tasks, view = 'today') {
    const ctx = { tasks, currentView: view, todayStr: today, activeFilters: { tags: new Set(), priorities: new Set(), projects: new Set() },
        dynamicPriority: new Map(), isTaskVisuallyActive: t => t.status === 'active', Map, Set };
    const r = vm.runInNewContext('(() => {' + body + '})()', ctx);
    const plain = v => JSON.parse(JSON.stringify(v));
    return { roots: plain(r.roots), paths: plain(r.paths), kids: id => plain(r.kids(id)) };
}
const T = (id, parent, due = '') => ({ id, title: id, parent_id: parent || null, due_date: due, status: 'active' });

test('assigned task and its descendants show; ancestors stay hidden (School → Biology → Research → Cell → S.1)', () => {
    const tasks = [T('School'), T('Biology', 'School'), T('Research', 'Biology', today), T('Cell', 'Research', '2099-01-01'), T('S1', 'Cell')];
    const r = run(tasks);
    assert.deepEqual(r.roots, ['Research']);
    assert.deepEqual(r.paths.Research, ['School', 'Biology']);
    assert.deepEqual(r.kids('Research'), ['Cell']);
    assert.deepEqual(r.kids('Cell'), ['S1']);
    assert.deepEqual(run(tasks, 'general').roots, ['School']);
});

test('assigned siblings show at root without their unassigned sibling or parent', () => {
    const tasks = [T('root'), T('Alpha', 'root'), T('A', 'Alpha', today), T('B', 'Alpha', today), T('C', 'Alpha')];
    const r = run(tasks);
    assert.deepEqual(r.roots.sort(), ['A', 'B']);
    assert.deepEqual(r.paths.A, ['root', 'Alpha']);
});

test('undated chains never appear; overdue counts; native root tasks get no directory', () => {
    const r = run([T('undated'), T('kid', 'undated'), T('late', null, '2026-11-01'), T('future', null, '2026-11-09')]);
    assert.deepEqual(r.roots, ['late']);
    assert.deepEqual(r.paths.late, []);
});

test('a dated descendant under a dated ancestor renders inside the ancestor, not twice', () => {
    const r = run([T('P', null, today), T('K', 'P', today)]);
    assert.deepEqual(r.roots, ['P']);
    assert.deepEqual(r.kids('P'), ['K']);
});

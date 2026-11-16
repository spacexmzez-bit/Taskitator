// Phase 4.1: subtask order (auto sort applied once, manual arrows), per-parent `order` in list sorting, Worker validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const app = read('app.js'), comp = read('components.js'), html = read('index.html');

function sorter() {
    const src = app.slice(app.indexOf('    function sortTasks(tasksArray) {'), app.indexOf('    function getAllDescendants('));
    const ctx = { getGlobalPriorities: () => [{ id: 'h', rank: 1 }, { id: 'l', rank: 3 }], window: {}, localStorage: { getItem: () => null } };
    vm.runInNewContext(src + '\nthis.sortTasks = sortTasks;', ctx);
    return a => JSON.parse(JSON.stringify(ctx.sortTasks(a))).map(t => t.id);
}
const T = (id, extra = {}) => ({ id, title: id, parent_id: 'p', priority_id: 'l', created_at: id, ...extra });

test('list sorting: a saved order beats priority among siblings; unordered subtasks follow', () => {
    const s = sorter();
    assert.deepEqual(s([T('a', { priority_id: 'h' }), T('b', { order: 1 }), T('c', { order: 2, priority_id: 'h' })]), ['b', 'c', 'a']);
    assert.deepEqual(s([T('x', { order: 2 }), T('y', { order: 1 }), T('n1'), T('n2', { priority_id: 'h' })]), ['y', 'x', 'n2', 'n1']);
});

test('list sorting: without order nothing changes, and roots are untouched by order', () => {
    const s = sorter();
    assert.deepEqual(s([T('a'), T('b', { priority_id: 'h' })]), ['b', 'a']);
    assert.deepEqual(s([T('r1', { parent_id: null, order: 2 }), T('r2', { parent_id: null, priority_id: 'h' })]), ['r2', 'r1']);
});

test('editor: Sort menu (A to Z, priority, required first, default), Arrange mode, order saved through the draft', () => {
    for (const m of ['alpha', 'priority', 'required', 'default']) assert.match(html, new RegExp('data-sort="' + m + '"'));
    assert.match(html, /id="detailManualSortBtn"/);
    assert.match(comp, /function writeOrder\(list\) \{ list\.forEach\(\(t, i\) => \{ t\.order = i \+ 1; \}\); \}/);
    assert.match(comp, /if \(mode === 'default'\) kids\.forEach\(t => \{ delete t\.order; \}\)/);
    assert.match(comp, /manualSort = false;\n\s+detailOrigin|detailOrigin = opts\?\.origin \|\| null;\n\s+manualSort = false;/);
});

test('editor: arrows replace the completion circle in Arrange mode; sort tools lock on a completed task', () => {
    const list = comp.slice(comp.indexOf('        function refreshDetailSubtaskList('), comp.indexOf('        // Phase 2.5: edit an AI-locked'));
    assert.match(list, /if \(manualSort\) \{[\s\S]*detail-sub-arrow[\s\S]*\} else \{[\s\S]*check-circle detail-sub-check/);
    assert.match(comp, /'\.subtask-sort-tools'\]\)/);
    assert.match(read('style.css'), /\.detail-sub-arrow\{[^}]*var\(--pc/);
});

test('saving a changed order asks first, before the draft is committed', () => {
    const save = comp.slice(comp.indexOf("saveTaskDetailsBtn.addEventListener('click'"));
    const i = save.indexOf("title: 'Save subtask order?'");
    assert.ok(i > 0 && i < save.indexOf('commitDraft()'));
    assert.match(save, /orderChanged\(\) && !\(await window\.TaskitatorConfirm/);
});

test('order helper functions behave: Sort once, move, default', () => {
    const grab = (a, b) => comp.slice(comp.indexOf(a), comp.indexOf(b));
    const src = grab('        const subsOf = ', '        function orderChanged()');
    const all = [T('b', { priority_id: 'l', is_bonus: true }), T('a', { priority_id: 'h' }), T('c', { priority_id: 'l' })];
    const host = { tasks: { getAll: () => all, sort: l => l.sort((x, y) => String(x.id).localeCompare(y.id)) }, catalogs: { priorities: () => [{ id: 'h', rank: 1 }, { id: 'l', rank: 3 }] } };
    const ctx = { host, activeDetailTaskId: 'p', manualSort: true, document: { getElementById: () => null }, refreshDetailSubtaskList() {} };
    vm.runInNewContext(src + '\nthis.run = (f, ...a) => this[f](...a);\nthis.applyAutoSort = applyAutoSort; this.moveSubtask = moveSubtask;', ctx);
    const order = () => all.slice().sort((x, y) => x.order - y.order).map(t => t.id).join('');
    ctx.applyAutoSort('priority'); assert.equal(order(), 'abc'); assert.equal(ctx.manualSort, false);
    ctx.applyAutoSort('required'); assert.equal(order(), 'acb'); // bonus b last
    ctx.applyAutoSort('alpha'); assert.equal(order(), 'abc');
    ctx.moveSubtask('c', -1); assert.equal(order(), 'acb');
    ctx.moveSubtask('a', -1); assert.equal(order(), 'acb'); // already first: no change
    ctx.applyAutoSort('default'); assert.ok(all.every(t => t.order === undefined));
});

test('Worker refuses a non-integer or huge order and accepts none or a small whole number', async () => {
    const { checkTaskGraph } = await import('./worker.js');
    const ok = o => checkTaskGraph([{ id: 'a', ...o }]);
    ok({}); ok({ order: 3 }); ok({ order: null });
    for (const bad of ['3', 1.5, NaN, 1e9, {}, true]) assert.throws(() => ok({ order: bad }), /whole number/, String(bad));
});

test('Arabic covers the new sort strings', () => {
    const ar = read('locales/ar.js');
    for (const k of ['Sort', 'A to Z', 'By priority', 'Required first, then priority', 'Default order', 'Arrange', 'Save subtask order?', 'Save order', 'Move up'])
        assert.ok(ar.includes(JSON.stringify(k) + ':'), k);
});

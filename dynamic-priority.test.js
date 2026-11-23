// Dynamic Priority (free since Phase 6.1.1): client-side derivation and UI wiring. Worker enforcement lives in security.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const components = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
const source = components.match(/\/\/ <<< MODULE_START: dynamic-priority\.js >>>([\s\S]*?)\/\/ <<< MODULE_END: dynamic-priority\.js >>>/)[1];
const context = vm.createContext({});
vm.runInContext(source.replace('})(globalThis);', '})(this);'), context);
const { effectiveMap, effectiveId } = context.TaskitatorPriority;

const PRIORITIES = [{ id: 'prio_high', rank: 1 }, { id: 'prio_med', rank: 2 }, { id: 'prio_low', rank: 3 }];
const t = (id, extra = {}) => ({ id, title: id, status: 'active', priority_id: 'prio_high', parent_id: null, is_bonus: false, ...extra });
const root = extra => t('root', { dynamic_priority_target: 'prio_low', ...extra });
const eff = (tasks, id = 'root') => effectiveId(tasks.find(x => x.id === id), effectiveMap(tasks, PRIORITIES));

test('lowers only when every required descendant is done and bonus work remains', () => {
    assert.equal(eff([root(), t('b', { parent_id: 'root', is_bonus: true })]), 'prio_low');
    assert.equal(eff([root(), t('r', { parent_id: 'root', status: 'completed' }), t('b', { parent_id: 'root', is_bonus: true })]), 'prio_low');
    assert.equal(eff([root(), t('r', { parent_id: 'root' }), t('b', { parent_id: 'root', is_bonus: true })]), 'prio_high');
});

test('Phase 6.1.1: no unfinished required work uses the target right away, childless tasks included', () => {
    assert.equal(eff([root()]), 'prio_low');
    assert.equal(eff([root(), t('r', { parent_id: 'root', status: 'completed' })]), 'prio_low');
    assert.equal(eff([root(), t('b', { parent_id: 'root', is_bonus: true, status: 'completed' })]), 'prio_low');
});

test('restores when required work is reopened or newly added; bonus work no longer matters', () => {
    const tree = [root(), t('r', { parent_id: 'root', status: 'completed' }), t('b', { parent_id: 'root', is_bonus: true })];
    assert.equal(eff(tree), 'prio_low');
    assert.equal(eff(tree.map(x => x.id === 'r' ? { ...x, status: 'active' } : x)), 'prio_high');
    assert.equal(eff([...tree, t('new', { parent_id: 'root' })]), 'prio_high');
    assert.equal(eff(tree.map(x => x.id === 'b' ? { ...x, status: 'completed' } : x)), 'prio_low', 'finished bonus work: still no required work');
    assert.equal(eff(tree.map(x => x.id === 'b' ? { ...x, status: 'trash' } : x)), 'prio_low');
    assert.equal(eff(tree.map(x => x.id === 'b' ? { ...x, is_bonus: false } : x)), 'prio_high');
});

test('uses the shield gate at every depth: unfinished non-bonus grandchildren still count as required', () => {
    const base = [root(), t('b', { parent_id: 'root', is_bonus: true })];
    assert.equal(eff([...base, t('g', { parent_id: 'b' })]), 'prio_high');
    assert.equal(eff([...base, t('g', { parent_id: 'b', is_bonus: true })]), 'prio_low');
    assert.equal(eff([root(), t('r', { parent_id: 'root', status: 'completed' }), t('g', { parent_id: 'r' }), t('b', { parent_id: 'root', is_bonus: true })]), 'prio_high');
    assert.equal(eff([root(), t('c', { parent_id: 'root', status: 'completed' }), t('g', { parent_id: 'c', is_bonus: true })]), 'prio_low');
});

test('trashed branches are ignored; moving a branch changes the result', () => {
    const tree = [root(), t('b', { parent_id: 'root', is_bonus: true }), t('r', { parent_id: 'root', status: 'trash' })];
    assert.equal(eff(tree), 'prio_low');
    assert.equal(eff(tree.map(x => x.id === 'r' ? { ...x, status: 'active' } : x)), 'prio_high');
    const moved = tree.map(x => x.id === 'b' ? { ...x, parent_id: null, is_bonus: false } : x);
    assert.equal(eff(moved), 'prio_low', 'no required work left under root');
    assert.equal(eff(tree.map(x => x.id === 'b' ? { ...x, is_bonus: false } : x)), 'prio_high');
});

test('ignores completed or trashed owners, missing targets, same-level targets and unknown priorities', () => {
    const kids = [t('b', { parent_id: 'root', is_bonus: true })];
    assert.equal(eff([root({ status: 'completed' }), ...kids]), 'prio_high');
    assert.equal(eff([root({ dynamic_priority_target: null }), ...kids]), 'prio_high');
    assert.equal(eff([root({ dynamic_priority_target: 'gone' }), ...kids]), 'prio_high');
    assert.equal(eff([root({ dynamic_priority_target: 'prio_high' }), ...kids]), 'prio_high');
});

test('derivation is pure, handles cycles, and nested tasks each use their own target', () => {
    const tasks = Object.freeze([root(), t('b', { parent_id: 'root', is_bonus: true }), t('c', { parent_id: 'b', is_bonus: true, dynamic_priority_target: 'prio_med' })].map(Object.freeze));
    const map = effectiveMap(tasks, PRIORITIES);
    assert.equal(map.get('root'), 'prio_low');
    assert.equal(map.has('b'), false);
    assert.equal(effectiveMap([root({ parent_id: 'b' }), t('b', { parent_id: 'root', is_bonus: true })], PRIORITIES).size, 1);
    assert.equal(effectiveMap('not an array', PRIORITIES).size, 0);
});

test('UI: create and edit forms offer the free feature with real priorities and default to lowest', () => {
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    for (const prefix of ['create', 'edit']) {
        // Phase 6.1.2: one section, Dynamic Priority and Dynamic Bonus on one line, explanations in the ? panel.
        const block = html.match(new RegExp(`id="${prefix}DynSection"[\\s\\S]*?id="${prefix}DynamicBonusNotice"`))[0];
        assert.doesNotMatch(block, /pro-feature-pill/);
        assert.match(block, new RegExp(`id="${prefix}DynamicPriorityCheckbox"`));
        assert.match(block, new RegExp(`id="${prefix}DynamicPriorityTarget"`));
        assert.match(block, /restores the original automatically when required work becomes unfinished/);
    }
    assert.ok(html.indexOf('createDynamicPriorityContainer') > html.indexOf('id="bonusTaskCheckbox"'));
    assert.ok(html.indexOf('editDynamicPriorityContainer') > html.indexOf('id="editBonusTaskCheckbox"'));
    assert.match(components, /sel\.value=target\|\|lowest\|\|''/);
    assert.match(components, /host\.catalogs\.priorities\(\)/);
    // Phase 4.0: a shield or AI lock no longer freezes Dynamic Priority (Pro is still required).
    assert.doesNotMatch(components, /Locked: Dynamic Priority cannot change/);
    assert.doesNotMatch(components, /dpLocked = /);
    assert.match(components, /dpCommit\('edit', task, false, dpHad\)/);
    assert.match(fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8'), /dynamic_priority_schema: 1/);
});

test('a trashed branch cannot affect its ancestor priority', () => {
  assert.equal(eff([root(), t('b', {parent_id:'root', is_bonus:true}), t('x',{parent_id:'root',status:'trash'}), t('y',{parent_id:'x'})]), 'prio_low');
});

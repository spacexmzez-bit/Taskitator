// Phase 6.1.1: phone-lock counting with "Count bonus tasks", Dynamic Bonus, and the Bonus / AI audit rules (pure parts).
// Worker enforcement lives in security.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './pro/status-count.js';

const SC = globalThis.TaskitatorStatusCount;
const day = '2026-11-23';
const tk = (id, extra = {}) => ({ id, title: id, status: 'active', due_date: 'today', ...extra });
const locked = (tasks, settings) => SC.unfinished(tasks, settings, day);

test('harsh: bonus tasks count only with "Count bonus tasks" on', () => {
    const tasks = [tk('b', { is_bonus: true })];
    assert.equal(locked(tasks, { status_mode: 'harsh' }), false, 'off by default');
    assert.equal(locked(tasks, { status_mode: 'harsh', status_bonus_count: true }), true);
    assert.equal(locked([tk('r')], { status_mode: 'harsh' }), true, 'required work still counts');
});

test('normal: bonus tasks use their own flag, else "Count bonus tasks"; they never inherit a parent flag', () => {
    const s = on => ({ status_mode: 'normal', status_bonus_count: on });
    assert.equal(locked([tk('b', { is_bonus: true })], s(false)), false);
    assert.equal(locked([tk('b', { is_bonus: true })], s(true)), true);
    assert.equal(locked([tk('b', { is_bonus: true, status_count: true })], s(false)), true, 'own flag wins');
    assert.equal(locked([tk('b', { is_bonus: true, status_count: false })], s(true)), false, 'own flag wins');
    const tree = [tk('p', { status: 'completed', status_count: true }), tk('b', { parent_id: 'p', is_bonus: true })];
    assert.equal(locked(tree, s(false)), false, 'no inheritance from the parent');
});

test('limited: bonus never counts; AI-locked always counts', () => {
    assert.equal(locked([tk('b', { is_bonus: true, status_count: true })], { status_mode: 'limited', status_bonus_count: true }), false);
    assert.equal(locked([tk('a', { ai_locked: true })], { status_mode: 'limited' }), true);
});

test('undated tasks never count, in any mode; "today" and past dates do', () => {
    for (const m of ['harsh', 'normal', 'limited']) {
        assert.equal(locked([tk('u', { due_date: '', ai_locked: true })], { status_mode: m }), false, m);
        assert.equal(locked([tk('u', { due_date: undefined })], { status_mode: m }), false, m);
    }
    assert.equal(locked([tk('p', { due_date: '2026-11-01' })], {}), true);
    assert.equal(locked([tk('c', { due_date: '', parent_id: 'p' }), tk('p', { status: 'completed', due_date: 'today' })], {}), true, 'inherits a dated ancestor');
});

test('Dynamic Bonus: derived once required descendants exist and are all done (recursive)', () => {
    const p = extra => tk('p', { dynamic_bonus: true, ...extra });
    assert.equal(SC.bonusIds([p(), tk('r', { parent_id: 'p' })]).has('p'), false, 'open required work');
    assert.equal(SC.bonusIds([p(), tk('r', { parent_id: 'p', status: 'completed' })]).has('p'), true);
    assert.equal(SC.bonusIds([p()]).has('p'), false, 'no required descendant: never converts');
    assert.equal(SC.bonusIds([p(), tk('b', { parent_id: 'p', is_bonus: true })]).has('p'), false, 'bonus-only children: never converts');
    assert.equal(SC.bonusIds([p(), tk('r', { parent_id: 'p', status: 'trash' })]).has('p'), false, 'trashed work is ignored');
    assert.equal(SC.bonusIds([p({ ai_locked: true }), tk('r', { parent_id: 'p', status: 'completed' })]).has('p'), false, 'AI-audited: never');
    // A child that turned bonus no longer counts as required work for its parent.
    const nested = [p(), tk('c', { parent_id: 'p', dynamic_bonus: true }), tk('g', { parent_id: 'c', status: 'completed' }), tk('r', { parent_id: 'p', status: 'completed' })];
    assert.deepEqual([...SC.bonusIds(nested)].sort(), ['c', 'p']);
    // Cycles don't loop.
    assert.equal(SC.bonusIds([tk('a', { parent_id: 'b', dynamic_bonus: true }), tk('b', { parent_id: 'a', dynamic_bonus: true })]).size, 0);
    assert.equal(SC.hasRequired([p(), tk('b', { parent_id: 'p', is_bonus: true })], 'p'), false);
    assert.equal(SC.hasRequired([p(), tk('r', { parent_id: 'p', status: 'completed' })], 'p'), true);
});

test('Dynamic Bonus: a study-plan umbrella stops locking once its required units are done (harsh, bonus off)', () => {
    const tree = [tk('day', { dynamic_bonus: true, strict_prerequisites: true }), tk('u1', { parent_id: 'day', status: 'completed' }), tk('u2', { parent_id: 'day', is_bonus: true })];
    assert.equal(locked(tree, { status_mode: 'harsh' }), false);
    assert.equal(locked(tree, { status_mode: 'harsh', status_bonus_count: true }), true, 'bonus count on: the open bonus unit and the umbrella lock');
    tree[1].status = 'active';
    assert.equal(locked(tree, { status_mode: 'harsh' }), true);
});

test('settings lock (pending) skips uncounted bonus work but keeps AI-locked work', () => {
    assert.equal(SC.pending([tk('b', { is_bonus: true })], day, {}), false);
    assert.equal(SC.pending([tk('b', { is_bonus: true })], day, { status_bonus_count: true }), true);
    assert.equal(SC.pending([tk('b', { is_bonus: true })], day, { status_mode: 'limited', status_bonus_count: true }), false);
    assert.equal(SC.pending([tk('u', { due_date: '' })], day, {}), false, 'undated');
    assert.equal(SC.pending([tk('r')], day, { status_mode: 'limited' }), true, 'required work still locks settings in every mode');
});

test('loosenings: "Count bonus tasks" off, and counted bonus work removed, moved or uncounted', () => {
    const on = { status_mode: 'harsh', status_bonus_count: true }, off = { status_mode: 'harsh' };
    const rec = (settings, tasks) => ({ settings, tasks });
    const b = [tk('b', { is_bonus: true })];
    assert.match(SC.loosenings(rec(on, b), rec(off, b), day).setting, /Count bonus tasks/);
    assert.equal(SC.loosenings(rec(off, b), rec(on, b), day).setting, null, 'turning it on is stricter');
    for (const after of [[], [tk('b', { is_bonus: true, status: 'trash' })], [tk('b', { is_bonus: true, due_date: '2026-11-30' })], [tk('b', { is_bonus: true, due_date: '' })]])
        assert.deepEqual(SC.loosenings(rec(on, b), rec(on, after), day).tasks.map(t => t.id), ['b']);
    assert.deepEqual(SC.loosenings(rec(on, b), rec(on, [tk('b', { is_bonus: true, status: 'completed' })]), day).tasks, [], 'finishing is fine');
    assert.deepEqual(SC.loosenings(rec(off, b), rec(off, []), day).tasks, [], 'uncounted bonus work is free to change');
    assert.deepEqual(SC.loosenings(rec({ status_mode: 'normal', status_bonus_count: true }, b), rec({ status_mode: 'normal', status_bonus_count: true }, [tk('b', { is_bonus: true, status_count: false })]), day).tasks.map(t => t.id), ['b']);
});

test('loosenings: counted required work turned into uncounted bonus work (Bonus, or Dynamic Bonus switched on)', () => {
    const rec = tasks => ({ settings: { status_mode: 'harsh' }, tasks });
    assert.deepEqual(SC.loosenings(rec([tk('r')]), rec([tk('r', { is_bonus: true })]), day).tasks.map(t => t.id), ['r']);
    const before = [tk('p'), tk('c', { parent_id: 'p', status: 'completed' })], after = [tk('p', { dynamic_bonus: true }), before[1]];
    assert.deepEqual(SC.loosenings(rec(before), rec(after), day).tasks.map(t => t.id), ['p']);
    assert.equal(SC.loosened(rec([tk('r', { due_date: '2026-11-30' })]), rec([tk('r', { due_date: '2026-11-30', is_bonus: true })]), day), null, 'future work is free');
});

test('bonusRules: Bonus, Dynamic Bonus and AI audit exclude each other; old combinations and plan units are kept', () => {
    const next = tasks => SC.bonusRules({ tasks: [] }, { tasks });
    assert.equal(next([tk('a', { is_bonus: true, dynamic_bonus: true })]).length, 1);
    assert.equal(next([tk('a', { ai_locked: true, dynamic_bonus: true })]).length, 1);
    assert.equal(next([tk('a', { require_ai_proof: true, is_bonus: true })]).length, 1);
    assert.equal(next([tk('a', { ai_locked: true, is_bonus: true, study_plan_id: 'plan' })]).length, 0, 'plan units are exempt');
    const old = tk('a', { ai_locked: true, is_bonus: true });
    assert.equal(SC.bonusRules({ tasks: [old] }, { tasks: [{ ...old, description: 'edit' }] }).length, 0, 'existing combination is kept');
    assert.equal(SC.bonusRules({ tasks: [tk('a', { ai_locked: true })] }, { tasks: [tk('a', { ai_locked: true, is_bonus: true })] }).length, 1, 'new combination');
    assert.equal(next([tk('a', { is_bonus: true, dynamic_bonus: true, status: 'trash' })]).length, 0, 'trash is ignored');
});

test('study plans: new umbrellas get Dynamic Bonus; the editor and Settings carry the new controls', () => {
    const plan = fs.readFileSync(new URL('./pro/study-plan.js', import.meta.url), 'utf8');
    assert.match(plan, /strict_prerequisites:true,dynamic_bonus:true/);
    const manage = fs.readFileSync(new URL('./pro/study-manage.js', import.meta.url), 'utf8');
    assert.equal((manage.match(/template\?\.dynamic_bonus===true\?\{dynamic_bonus:true\}:\{\}/g) || []).length, 2, 're-planned umbrellas keep the setting');
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    for (const id of ['createDynamicBonusCheckbox', 'editDynamicBonusCheckbox', 'editAssignTodayBtn']) assert.match(html, new RegExp('id="' + id + '"'));
    const settings = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
    assert.match(settings, /id="statusBonusToggle"/);
    assert.match(settings, /write\(\{ status_bonus_count: want \}\)/);
    assert.match(settings, /Tasks with no due date never count toward the phone lock\./);
    const core = fs.readFileSync(new URL('./core.js', import.meta.url), 'utf8');
    assert.match(core, /dynamic_bonus_schema: 1/);
});

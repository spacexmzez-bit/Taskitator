// Phase 4.2: AND/OR filter mode, parent picker (rules + wiring), audited-move rule, Study plan JSON export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const app = read('app.js'), comp = read('components.js'), html = read('index.html');
const J = v => JSON.parse(JSON.stringify(v));

function matcher() {
    const src = app.slice(app.indexOf('    function filtersActive(f) {'), app.indexOf('    // Default Registries'));
    const ctx = { globalThis: { TaskitatorDateFilter: { active: f => f.mode === 'today', matches: (t, i, today) => t.due_date === today } } };
    vm.runInNewContext(src + '\nthis.filtersActive = filtersActive; this.taskMatchesFilters = taskMatchesFilters;', ctx);
    return ctx;
}
const F = (o = {}) => ({ tags: new Set(o.tags || []), priorities: new Set(o.priorities || []), projects: new Set(o.projects || []), date: o.date || { mode: '' }, logic: o.logic || 'and' });
const T = { id: 'a', project_id: 'inbox', priority_id: 'med', due_date: 'D', tags: [] };

test('filters AND: every chosen filter must match (unchanged behaviour); empty filters are ignored', () => {
    const m = matcher(), ctx = { today: 'D' };
    const f = F({ projects: ['inbox'], priorities: ['med'], date: { mode: 'today' } });
    assert.equal(m.taskMatchesFilters(T, f, ctx), true);
    assert.equal(m.taskMatchesFilters({ ...T, project_id: 'work' }, f, ctx), false);
    assert.equal(m.taskMatchesFilters({ ...T, priority_id: 'low' }, f, ctx), false);
    assert.equal(m.taskMatchesFilters({ ...T, due_date: 'X' }, f, ctx), false);
    assert.equal(m.taskMatchesFilters(T, F(), ctx), true);
    assert.equal(m.filtersActive(F()), false);
    assert.equal(m.filtersActive(F({ logic: 'or' })), false, 'the mode alone is not a filter');
});

test('filters OR: any chosen filter is enough', () => {
    const m = matcher(), ctx = { today: 'D' };
    const f = F({ projects: ['inbox'], priorities: ['med'], date: { mode: 'today' }, logic: 'or' });
    assert.equal(m.taskMatchesFilters({ ...T, project_id: 'work', due_date: 'X' }, f, ctx), true, 'only the priority matches');
    assert.equal(m.taskMatchesFilters({ ...T, project_id: 'work', priority_id: 'low', due_date: 'X' }, f, ctx), false, 'none match');
    assert.equal(m.taskMatchesFilters({ ...T, tags: ['study'], project_id: 'w', priority_id: 'l', due_date: 'X' }, F({ tags: ['study'], projects: ['inbox'], logic: 'or' }), ctx), true);
    const dyn = new Map([['a', 'low']]);
    assert.equal(m.taskMatchesFilters(T, F({ priorities: ['low'] }), { dynamicPriority: dyn }), true, 'dynamic priority still counts');
});

test('filter panel has the AND/OR dropdown wired to draft, apply, clear and reopen', () => {
    assert.match(html, /id="filterLogic"[\s\S]*value="and"[\s\S]*value="or"/);
    assert.match(app, /draftFilters\.logic = activeFilters\.logic/);
    assert.match(app, /activeFilters\.logic = draftFilters\.logic === 'or' \? 'or' : 'and'/);
    assert.match(app, /draftFilters\.logic = 'and';\n\s+syncDateFilterInputs/);
    assert.match(app, /taskMatchesFilters\(t, activeFilters, \{ dynamicPriority, index: filterIndex, today: todayStr \}\)/);
});

// ---- parent move rules, taken from the editor source ----
function rules(all, { bypass = false, shielded = false, series = null } = {}) {
    const src = comp.slice(comp.indexOf('        const isAudited = '), comp.indexOf('        function parentPickLabel()'));
    const sub = (list, id) => { const out = [], seen = new Set(); const walk = i => { if (seen.has(i)) return; seen.add(i); const t = list.find(x => x.id === i); if (t) out.push(t); list.filter(x => x.parent_id === i).forEach(k => walk(k.id)); }; walk(id); return out; };
    const ctx = { trT: k => k, host: { tasks: { getAll: () => all, shieldedAncestor: () => (shielded ? { id: 's' } : null) }, rules: { bypassActive: () => bypass } },
        TaskitatorRecurrence: { subtree: sub, seriesFor: () => series }, window: {} };
    vm.runInNewContext(src + '\nthis.auditMoveReason = auditMoveReason; this.moveBlockReason = moveBlockReason;', ctx);
    return ctx;
}
const t = (id, o = {}) => ({ id, title: id, status: 'active', parent_id: null, ...o });

test('move rule: a task with unfinished AI-audited work cannot leave its parent; adding load is allowed', () => {
    const all = [t('P'), t('Q'), t('C', { parent_id: 'P', ai_locked: true }), t('G', { parent_id: 'P' }), t('GC', { parent_id: 'G', ai_locked: true }), t('N', { parent_id: 'P' }), t('R', { ai_locked: true })];
    const r = rules(all), by = id => all.find(x => x.id === id);
    assert.match(r.moveBlockReason(by('C'), 'Q'), /AI-audited/);
    assert.match(r.moveBlockReason(by('C'), null), /AI-audited/);
    assert.match(r.moveBlockReason(by('G'), 'Q'), /AI-audited/, 'a plain task whose branch holds audited work');
    assert.equal(r.moveBlockReason(by('C'), 'P'), null, 'staying put is not a move');
    assert.equal(r.moveBlockReason(by('N'), 'Q'), null);
    assert.equal(r.moveBlockReason(by('R'), 'P'), null, 'a root task moving under a parent adds load');
    assert.equal(rules(all, { bypass: true }).moveBlockReason(by('C'), 'Q'), null, 'Emergency Bypass lifts it');
    by('C').status = 'completed'; by('GC').status = 'completed';
    assert.equal(r.moveBlockReason(by('C'), 'Q'), null, 'finished audited work no longer holds the parent');
});

test('move rule: cycles, depth, recurrence and shield', () => {
    const all = [t('A'), t('B', { parent_id: 'A' }), t('X')];
    const r = rules(all), A = all[0];
    assert.match(r.moveBlockReason(A, 'B'), /Inside the task/);
    assert.match(r.moveBlockReason(A, 'A'), /Inside the task/);
    assert.equal(r.moveBlockReason(A, 'X'), null);
    const deep = [t('n0')]; for (let i = 1; i < 64; i++) deep.push(t('n' + i, { parent_id: 'n' + (i - 1) }));
    deep.push(t('M'), t('M1', { parent_id: 'M' }));
    assert.match(rules(deep).moveBlockReason(deep.at(-2), 'n63'), /Too deep/);
    assert.equal(rules(deep).moveBlockReason(deep.at(-2), 'n30'), null);
    const rec = [t('R1', { recurrence_series_id: 's1' }), t('Z', { recurrence_series_id: 's2' }), t('K', { parent_id: 'R1', recurrence_series_id: 's1' })];
    assert.match(rules(rec).moveBlockReason(rec[0], 'Z'), /Recurring branches/);
    assert.match(rules(rec, { series: { current_root_id: 'someone-else' } }).moveBlockReason(rec[2], null), /inside its recurring branch/);
    assert.match(rules(all, { shielded: true }).moveBlockReason(all[1], 'X'), /Shielded/);
    assert.equal(rules(all, { shielded: true, bypass: true }).moveBlockReason(all[1], 'X'), null);
});

test('editor: hidden select keeps the value, button opens the picker, save refuses an audited move', () => {
    assert.match(html, /id="editParentPickBtn"[\s\S]*id="editTaskParentSelect" hidden/);
    assert.match(html, /src="parent-picker\.js"/);
    assert.ok(html.indexOf('parent-picker.js') < html.indexOf('src="components.js"'));
    assert.match(read('sw.js'), /'\.\/parent-picker\.js'/);
    assert.match(comp, /pickBtn\.onclick = \(\) => \{ void pickParent\(\); \}/);
    assert.match(comp, /pickBtn\.disabled = editTaskParentSelect\.disabled/, 'shield lock still disables it');
    const save = comp.slice(comp.indexOf("saveTaskDetailsBtn.addEventListener('click'"));
    assert.match(save, /const auditWhy = auditMoveReason\(task, targetParentId\);/);
});

test('picker: confirms before returning, never edits tasks, and has its own filters and sort', () => {
    const src = read('parent-picker.js');
    assert.match(src, /TaskitatorConfirm\(\{ title: tr\('Move task\?'\)/);
    assert.ok(src.indexOf('TaskitatorConfirm') < src.indexOf('finish({ parentId'));
    assert.doesNotMatch(src, /\.parent_id\s*=[^=]/, 'it only returns the choice');
    assert.match(src, /const filters = newFilters\(\)/);
    assert.match(src, /logicSel/);
    assert.match(src, /opts\.blockReason\(id\)/);
    assert.match(read('app.js'), /function sortTasks\(tasksArray, modeOverride\)/);
});

// ---- Study plan export ----
function exporter() {
    const ctx = { window: {}, globalThis: {} }; ctx.window = ctx; ctx.root = ctx;
    vm.runInNewContext(read('pro/study-manage.js'), ctx);
    return ctx.TaskitatorStudyManage;
}
test('Study plan export: only this plan, no ids or reference files, sorted by day and unit number', () => {
    const M = exporter();
    const src = read('pro/study-manage.js');
    assert.match(src, /exportPlan,/);
    assert.match(read('study-plans.js'), /exp\.dataset\.act = 'export'/);
    assert.match(read('study-plans.js'), /type: 'application\/json'/);
    const body = src.slice(src.indexOf('function exportPlan('), src.indexOf('const copy=tasks'));
    for (const banned of [' id:', 'reference_inline_data', 'username', 'study_plan_id']) assert.ok(!body.includes(banned), banned);
    const plan = { base: 'Math', unit: 'Lesson', plural: 'Lessons', chapter: null, total: 2, done: 1, bonus: 1, bonusDone: 0, audited: 1, early: 1, start: '2026-11-17', end: '2026-11-18', finished: false,
        parents: [{ id: 'p2', title: 'Math 2', due_date: '2026-11-18', status: 'active' }, { id: 'p1', title: 'Math 1', due_date: '2026-11-17', status: 'active' }],
        units: [{ id: 'u2', parent_id: 'p2', title: 'Lesson 2', raw_title: 'Lesson {num==2}', status: 'active', ai_locked: true, raw_proof_criteria: 'photo', smart_early_date: '2026-11-17' },
            { id: 'u1', parent_id: 'p1', title: 'Lesson 1', raw_title: 'Lesson {num==1}', status: 'completed', completed_at: 'x' }] };
    const out = J(M.exportPlan(plan, 'NOW'));
    assert.equal(out.format, 'taskitator-study-plan'); assert.equal(out.exported_at, 'NOW');
    assert.deepEqual(out.days.map(d => d.date), ['2026-11-17', '2026-11-18']);
    assert.equal(out.days[1].units[0].early_date, '2026-11-17'); assert.equal(out.days[1].units[0].ai_audited, true);
    assert.deepEqual(out.plan.ai_criteria, ['photo']);
    assert.ok(!JSON.stringify(out).includes('"id"'));
    assert.throws(() => M.exportPlan(null), /Choose a study plan/);
});

test('Arabic covers the new picker, filter and export strings', () => {
    const ar = read('locales/ar.js');
    for (const k of ['Choose a parent task', 'Root level (no parent)', 'Move task?', 'AND: all chosen filters must match', 'OR: any chosen filter can match', 'Export JSON', 'Current parent', 'Too deep: tasks can be nested at most 64 levels.'])
        assert.ok(ar.includes(JSON.stringify(k) + ':'), k);
});

test('Phase 4.2: general-list roots are hidden only when neither they nor a descendant match', () => {
  const slice = app.slice(app.indexOf('let rootTasks = viewCandidates.filter'), app.indexOf('rootTasks = sortTasks(rootTasks)'));
  assert.match(slice, /if \(!m && !d\) return false;/);
  assert.doesNotMatch(slice, /if \(!m && d\) return false;/);
});

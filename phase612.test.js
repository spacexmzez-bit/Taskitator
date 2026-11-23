// Phase 6.1.2: numeric labels, study-plan early groups, the plan importer, free Early task and the new UI hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
import './pro/labels.js';
import './pro/study-import.js';
import { TaskProtection } from './pro-backend.js';

const L = globalThis.TaskitatorLabels, I = globalThis.TaskitatorStudyImport;
const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;

test('labels: a leading label is read as integer segments; the first segment decides, later ones break ties', () => {
    assert.deepEqual(L.parse('5.10 Revise'), [5, 10]);
    assert.deepEqual(L.parse('5.1-0-1 Notes'), [5, 1, 0, 1]);
    assert.deepEqual(L.parse('5.101'), [5, 101]);
    assert.equal(L.parse('2026-11-23 meeting'), null, 'dates are not labels');
    assert.equal(L.parse('Revise 5.10'), null, 'mid-title numbers are not labels');
    const sorted = ['5.10 a', '5.2 b', '5.1-0-1 c', '5.1 d', '5.10-80 e', '5.10-67 f', '4 g'].sort(L.compare);
    assert.deepEqual(sorted, ['4 g', '5.1 d', '5.1-0-1 c', '5.2 b', '5.10 a', '5.10-67 f', '5.10-80 e']);
    assert.ok(L.compare('Math 5.2', 'Math 5.10') < 0, 'plain titles keep the numeric-aware text order');
});

const plan = 'plan_early_groups';
const P = (n, date, extra = {}) => ({ id: 'p' + n, title: 'Math ' + n, raw_title: 'Math ' + n, study_plan_id: plan, parent_id: null, status: 'active', due_date: date, ...extra });
const U = (id, parent, extra = {}) => ({ id, title: id, study_plan_id: plan, parent_id: parent, status: 'active', ...extra });

test('early groups: units shown early between two plan days get a derived "Plan X.n" header (n = days after day X)', () => {
    const tasks = [P(5, '2026-11-20'), P(6, '2026-11-26'), U('u1', 'p6', { early_date: '2026-11-21' }), U('u2', 'p6', { early_date: '2026-11-23' }), U('u3', 'p6')];
    let g = L.earlyGroups(tasks, '2026-11-21');
    assert.equal(g.headers.length, 1);
    assert.equal(g.headers[0].title, 'Math 5.1');
    assert.equal(g.parentOf.get('u1'), g.headers[0].id);
    assert.equal(g.parentOf.has('u2'), false, 'other dates wait for their own day');
    assert.equal(g.parentOf.has('u3'), false);
    g = L.earlyGroups(tasks, '2026-11-23');
    assert.equal(g.headers[0].title, 'Math 5.3', 'stable: the same date always gets the same label');
    assert.equal(g.parentOf.get('u2'), g.headers[0].id);
    assert.ok(L.compare('5.3', '5.10') < 0, 'labels order as integers');
});

test('early groups: a real umbrella due today is used instead of a header; nothing early, nothing made', () => {
    const tasks = [P(5, '2026-11-23'), P(6, '2026-11-26'), U('u1', 'p6', { early_date: '2026-11-23' })];
    const g = L.earlyGroups(tasks, '2026-11-23');
    assert.equal(g.headers.length, 0);
    assert.equal(g.parentOf.get('u1'), 'p5');
    assert.equal(L.earlyGroups([P(5, '2026-11-20'), P(6, '2026-11-26'), U('u1', 'p6')], '2026-11-23').headers.length, 0);
    assert.equal(L.earlyGroups([P(6, '2026-11-26'), U('u1', 'p6', { early_date: '2026-11-23' })], '2026-11-23').headers[0].title, 'Math 0.3', 'before the first day: days left until day 1');
});

const config = { title: 'Biology', unit: 'Chapter', total: 6, days: 3, start: '2026-11-02', weekdays: [], counts: [2, 2, 2], bonus: 2, bonus_counts: [1, 0, 1] };
function exported(mark) {
    const tasks = C.build(config, 'plan_import_src', '2026-11-01T00:00:00Z');
    if (mark) for (const t of tasks) if (mark(t)) { t.status = 'completed'; t.completed_at = '2026-11-03T10:00:00.000Z'; }
    return M.exportPlan(M.plans(tasks)[0], '2026-11-05T00:00:00Z');
}

test('importer: template mode keeps the day gaps from a new start date and creates everything unfinished', () => {
    const file = exported(t => t.title === 'Chapter.1');
    const r = I.convert(file, { mode: 'template', start: '2026-12-01' });
    assert.deepEqual(r.config.dates, ['2026-12-01', '2026-12-02', '2026-12-03']);
    assert.deepEqual(r.config.counts, [2, 2, 2]);
    assert.deepEqual(r.config.bonus_counts, [1, 0, 1]);
    assert.equal(r.completions.length, 0);
    const built = C.build(C.normalize(r.config), 'plan_import_new', '2026-11-30T00:00:00Z');
    assert.equal(built.filter(t => t.parent_id).length, 8);
    assert.ok(built.filter(t => !t.parent_id).every(p => p.dynamic_bonus === true), 'imported umbrellas get Dynamic Bonus');
    assert.ok(built.every(t => t.status === 'active'));
});

test('importer: restore keeps dates and marks done units done again with their completed_at', () => {
    const file = exported(t => t.title === 'Chapter.1' || t.title === 'Chapter.2' || t.title === 'Chapter.3');
    const r = I.convert(file, { mode: 'restore' });
    assert.deepEqual(r.config.dates, ['2026-11-02', '2026-11-03', '2026-11-04']);
    assert.equal(r.completions.length, 3);
    const built = C.build(C.normalize(r.config), 'plan_restore', '2026-11-30T00:00:00Z');
    assert.equal(I.applyCompletions(built, 'plan_restore', r.completions), 3);
    const done = built.filter(t => t.parent_id && t.status === 'completed').map(t => t.title).sort();
    assert.deepEqual(done, ['Chapter.1', 'Chapter.2', 'Chapter.3']);
    assert.ok(built.filter(t => t.status === 'completed').every(t => t.completed_at === '2026-11-03T10:00:00.000Z'));
    assert.equal(built.find(t => !t.parent_id && t.due_date === '2026-11-03').status, 'active', 'day 2 still has an open unit');
});

test('importer: every problem is listed and nothing is converted', () => {
    assert.throws(() => I.convert({ format: 'other' }), /not a Taskitator study plan/);
    assert.throws(() => I.convert({ format: 'taskitator-study-plan', version: 2, plan: {}, days: [] }), /version \(2\) is not supported/);
    const file = exported();
    file.days[1].units = file.days[1].units.map(u => ({ ...u, bonus: true }));
    file.plan.title = '';
    try { I.convert(file, { mode: 'template', start: 'bad' }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.problems.length, 3, e.problems.join(' | ')); }
    const big = exported(); big.days[0].units = Array.from({ length: 501 }, (_, i) => ({ number: 100 + i, title: 'x', status: 'active', bonus: false }));
    assert.throws(() => I.convert(big, { mode: 'restore' }), /import limit is 500/);
    const audited = exported(); audited.days[0].units[0].ai_audited = true; audited.days[0].units[0].early_date = '2026-11-01';
    const r = I.convert(audited, { mode: 'restore' });
    assert.equal(r.summary.audited, 1); assert.equal(r.summary.early, 1);
});

test('Early task is free: the Worker hook no longer checks a license', async () => {
    const g = new TaskProtection({ storage: {} });
    await g.guardEarly({ get: async () => null }, 'u1', { tasks: [] }, { tasks: [{ id: 'a', early_date: '2026-11-10' }] });
    const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(app, /Early bonus is a Taskitator Pro feature/);
    assert.doesNotMatch(fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8'), /t\.early_date != null \|\| t\.study_plan_id/);
});

test('UI hooks: Early task row, one-line Dynamic options with a ? panel, reschedule link, red plan names, importer', () => {
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    for (const id of ['editEarlyTaskDate', 'createDynHelpBtn', 'editDynHelpBtn', 'createDynHelp', 'reschedulePlansLink', 'plansImportBtn', 'planImport'])
        assert.match(html, new RegExp('id="' + id + '"'), id);
    for (const p of ['create', 'edit']) {
        const line = html.match(new RegExp(`id="${p}DynSection"[\\s\\S]*?class="dyn-line">([\\s\\S]*?)</div>`))[1];
        assert.match(line, new RegExp(`id="${p}DynamicPriorityCheckbox"`)); assert.match(line, new RegExp(`id="${p}DynamicBonusCheckbox"`));
    }
    const plans = fs.readFileSync(new URL('./study-plans.js', import.meta.url), 'utf8');
    assert.match(plans, /heading\.classList\.add\('plan-overdue'\)/);
    assert.match(plans, /action: 'authorize', config, plan_id: planId/);
    const sw = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
    assert.match(sw, /'\.\/pro\/labels\.js'/); assert.match(sw, /'\.\/pro\/study-import\.js'/);
    const tasks = [{ id: 'p', study_plan_id: 'x', parent_id: null, status: 'active', due_date: '2026-11-01', title: 'A 1' }, { id: 'u', study_plan_id: 'x', parent_id: 'p', status: 'active', title: 'u' }];
    assert.equal(M.plansWithOverdue(tasks, '2026-11-05').has('x'), true);
    assert.equal(M.plansWithOverdue(tasks, '2026-10-30').has('x'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
import { TaskProtection } from './pro-backend.js';
// Phase 3.6.2: Smart Study early appearances live together with plan bonus units.
const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage, S = globalThis.TaskitatorSmartStudy;
const ID = 'plan_smart_bonus', CREATED = '2026-11-01T00:00:00.000Z';
const day = i => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
// 4 days, 8 required + 4 bonus: 1,2,3* | 4,5,6* | 7,8,9* | 10,11,12*
const cfg = { title: 'QBank', unit: 'Bank', plural: 'Banks', total: 8, bonus: 4, days: 4, first: 1, start: day(0), weekdays: [], counts: [2, 2, 2, 2], dates: [day(0), day(1), day(2), day(3)] };
const smart = { mode: 'original', dates: [], appearances: [{ unit: 4, date: day(0) }, { unit: 8, date: day(1) }, { unit: 10, date: day(1) }] };
const make = (o = {}) => C.build({ ...cfg, smart, ...o }, ID, CREATED, false, '');
const num = M.unitNumber, unit = (tasks, n) => tasks.find(t => t.parent_id && num(t) === n);
const dayOf = (tasks, n) => tasks.find(t => t.id === unit(tasks, n).parent_id).due_date;
const config = tasks => tasks.find(t => t.smart_config).smart_config;
const store = () => { const m = new Map(); return { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, m }; };
const guard = () => { const g = Object.create(TaskProtection.prototype); g.bypass = async () => false; return g; };
const merged = (tasks, a) => { const ids = M.planTree(tasks, ID); return [...tasks.filter(t => !ids.has(t.id)), ...a.tasks]; };
const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

test('create: bonus units and Smart Study combine; only required units can be shown early', () => {
    const t = make();
    assert.equal(unit(t, 3).is_bonus, true); assert.equal(unit(t, 4).is_bonus, false);
    assert.equal(unit(t, 4).smart_early_date, day(0)); assert.equal(unit(t, 8).smart_early_date, day(1));
    assert.equal(M.plans(t)[0].early, 3); assert.equal(M.plans(t)[0].bonusLeft, 4);
    assert.throws(() => C.normalize({ ...cfg, smart: { ...smart, appearances: [{ unit: 6, date: day(0) }] } }), /optional already/);
    assert.throws(() => C.normalize({ ...cfg, smart: { ...smart, appearances: [{ unit: 99, date: day(0) }] } }), /earlier date/);
});

test('slide: a unit that changes day or becomes bonus loses its early appearance; the rest keep theirs', () => {
    const before = make(), r = M.bonusSlide(before, ID, day(1)); // bonus 3 was missed on day 0
    // day1: 3,4,5* | day2: 6,7,8* | day3: 9,10,11* ; 12 dropped
    assert.equal(dayOf(r.tasks, 3), day(1)); assert.equal(dayOf(r.tasks, 6), day(2)); assert.equal(unit(r.tasks, 12), undefined);
    assert.equal(unit(r.tasks, 8).is_bonus, true);
    assert.equal(unit(r.tasks, 8).smart_early_date, undefined, 'became bonus: cleared');
    assert.equal(unit(r.tasks, 8).smart_origin_date, undefined);
    assert.equal(unit(r.tasks, 4).smart_early_date, day(0), 'same day, still required: kept');
    assert.equal(unit(r.tasks, 10).smart_early_date, day(1));
    assert.equal(unit(r.tasks, 7).smart_origin_date, day(2), 'units that did not move keep their origin');
    assert.equal(unit(r.tasks, 6).smart_origin_date, undefined, 'moved units forget their origin');
    assert.equal(r.earlyCleared, 1);
    assert.deepEqual(config(r.tasks).appearances.map(a => a.unit), [4, 10]);
    assert.equal(config(before).appearances.length, 3, 'input untouched');
    assert.ok(!M.bonusCheck(before, r.tasks, ID, 'slide', day(1)));
    assert.equal(M.bonusWaiting(before, ID, day(1)), true);
});

test('add: every unit pulled to another day loses its early appearance', () => {
    const before = make(), r = M.bonusAdd(before, ID, day(0), 4, CREATED);
    // 1,2,3*,4* | 5,6,7*,8* | 9,10,11*,12* | 13,14,15*,16*
    assert.equal(dayOf(r.tasks, 4), day(0)); assert.equal(dayOf(r.tasks, 8), day(1)); assert.equal(dayOf(r.tasks, 10), day(2));
    for (const n of [4, 8, 10]) assert.equal(unit(r.tasks, n).smart_early_date, undefined, 'unit ' + n);
    assert.equal(r.earlyCleared, 3); assert.deepEqual(config(r.tasks).appearances, []);
    assert.ok(!M.bonusCheck(before, r.tasks, ID, 'add', day(0), 4));
    assert.equal(M.plans(r.tasks)[0].early, 0);
});

test('remove: removed units drop out of the Smart Study choice; unmoved units keep their early date', () => {
    const before = make(), r = M.bonusRemove(before, ID, day(0), 4);
    // 1,2 | 3,4 | 5,6 | 7,8
    assert.equal(dayOf(r.tasks, 4), day(1)); assert.equal(unit(r.tasks, 4).smart_early_date, day(0));
    assert.equal(dayOf(r.tasks, 8), day(3)); assert.equal(unit(r.tasks, 8).smart_early_date, undefined);
    assert.equal(unit(r.tasks, 10), undefined);
    assert.equal(r.earlyCleared, 1); assert.deepEqual(config(r.tasks).appearances.map(a => a.unit), [4]);
    assert.ok(!M.bonusCheck(before, r.tasks, ID, 'remove', day(0), 4));
});

test('plans without Smart Study behave exactly as before', () => {
    const before = C.build(cfg, ID, CREATED, false, ''), r = M.bonusSlide(before, ID, day(1));
    assert.equal(r.earlyCleared, 0); assert.ok(r.tasks.every(t => !Object.keys(t).some(k => k.startsWith('smart_'))));
});

test('the check refuses a moved unit that kept its early date, and an unmoved unit that lost it', () => {
    const before = make(), r = M.bonusSlide(before, ID, day(1));
    const kept = r.tasks.map(t => t.parent_id && num(t) === 8 ? { ...t, smart_early_date: day(1) } : t);
    assert.match(M.bonusCheck(before, kept, ID, 'slide', day(1)), /kept its Smart Study early date/);
    const lost = r.tasks.map(t => { if (!(t.parent_id && num(t) === 4)) return t; const n = { ...t }; delete n.smart_early_date; return n; });
    assert.match(M.bonusCheck(before, lost, ID, 'slide', day(1)), /changed beyond its day/);
    const forged = r.tasks.map(t => t.parent_id && num(t) === 7 ? { ...t, smart_early_date: day(1) } : t);
    assert.match(M.bonusCheck(before, forged, ID, 'slide', day(1)), /changed beyond its day/);
});

test('Worker: the bonus change is pinned by its grant, which also lets the cleared Smart fields through', async () => {
    const before = make(), g = guard(), tx = store();
    const a = await g.authorizeStudyBonus(tx, 'u', { tasks: before, settings: {} }, ID, { op: 'slide' }, day(1));
    assert.equal(a.early_cleared, 1);
    const after = merged(before, a);
    const granted = await g.studyReplanGrants(tx, 'u', { tasks: before }, { tasks: after });
    assert.ok(granted.has(ID));
    assert.doesNotThrow(() => S.guard({ tasks: before }, { tasks: after }, granted));
    await g.guardSync(tx, 'u', { tasks: before }, { tasks: after });
    // The same change without a grant is refused twice over.
    assert.throws(() => S.guard({ tasks: before }, { tasks: after }), /Smart Study schedule changed/);
    assert.equal((await g.studyReplanGrants(store(), 'u', { tasks: before }, { tasks: after })).size, 0);
    // A grant for this plan never covers Smart fields of another plan.
    const other = C.build({ ...cfg, bonus: 0, smart: { mode: 'original', dates: [], appearances: [{ unit: 3, date: day(0) }] } }, 'other_plan', CREATED, false, '');
    const tampered = other.map(t => { const n = { ...t }; delete n.smart_early_date; return n; });
    assert.throws(() => S.guard({ tasks: [...before, ...other] }, { tasks: [...after, ...tampered] }, granted), /Smart Study schedule changed/);
    for (const [op, count, today, cleared] of [['add', 4, day(0), 3], ['remove', 4, day(0), 1]]) {
        const t2 = store(), r = await g.authorizeStudyBonus(t2, 'u', { tasks: before, settings: {} }, ID, { op, count }, today);
        assert.equal(r.early_cleared, cleared, op);
        await g.guardSync(t2, 'u', { tasks: before }, { tasks: merged(before, r) });
    }
});

test('re-plan and soft reschedule stay off while a plan has live early appearances', () => {
    const noBonus = C.build({ ...cfg, bonus: 0, smart: { mode: 'original', dates: [], appearances: [{ unit: 3, date: day(0) }] } }, ID, CREATED, false, '');
    assert.throws(() => M.replan(noBonus, ID, { rev: 'aaaa1', start: day(5), mode: 'perDay', per: 3, weekdays: [] }), /Smart Study early dates/);
    assert.throws(() => M.softReschedule(noBonus, ID, { rev: 'abcd', mode: 'today' }, day(2)), /Smart Study/);
    const m = src('pro/study-manage.js');
    assert.ok(m.includes('It cannot be re-planned.') && m.includes('It cannot be rescheduled.'));
});

test('finishing an early unit still lightens with required work only, never a bonus unit', () => {
    const tasks = make({ smart: { mode: 'dates', dates: [day(2), day(3)], appearances: [{ unit: 4, date: day(0) }] } });
    const before = { tasks, settings: {} }, next = structuredClone(before), u = unit(next.tasks, 4);
    u.status = 'completed'; S.apply(next, before, Date.parse(day(0) + 'T12:00:00Z'));
    const moved = next.tasks.filter(t => t.smart_moved_from);
    assert.equal(moved.length, 1); assert.equal(num(moved[0]), 7); assert.equal(moved[0].is_bonus, false); assert.equal(moved[0].due_date, day(1));
});

test('client: the rule is gone, both kinds of bonus are counted and tagged apart, and the notice exists', () => {
    const u = src('pro/study-plan.js');
    assert.ok(!u.includes('cannot be combined with bonus units'));
    for (const s of ["' plan, '", "' early)'", 'ss-dot-bonus', 'is-early', 'early:date=>']) assert.ok(u.includes(s), s);
    const sc = src('pro/study-schedule.js');
    assert.ok(sc.includes("tr('({plan} plan, {early} early)'") && sc.includes('ctx.early?.(date)'));
    const p = src('study-plans.js');
    assert.ok(p.includes('early_cleared') && p.includes("tr('Bonus left: {n} ({plan} plan, {early} early)'"));
    assert.ok(src('app.js').includes("'bonus-badge early-badge' : 'bonus-badge'"));
    assert.ok(src('views/projects.js').includes("badge.className='bonus-badge early-badge';badge.textContent='Early bonus'"));
    assert.ok(/\.bonus-badge\.early-badge\{background/.test(src('style.css')));
    assert.ok(src('worker.js').includes('TaskitatorSmartStudy.guard(previous,snapshot,replanned)'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
import { TaskProtection } from './pro-backend.js';

const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;
const CREATED = '2026-11-01T00:00:00.000Z', ID = 'plan_bonus_unit';
const day = i => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
const cfg = { title: 'QBank', unit: 'Bank', plural: 'Banks', total: 100, bonus: 25, days: 25, first: 1, start: day(0), weekdays: [], counts: Array(25).fill(4), dates: Array.from({ length: 25 }, (_, i) => day(i)) };
const make = (audit = false, c = cfg) => C.build(c, ID, CREATED, audit, audit ? 'Answer bank {num}' : '');
const unitsOf = tasks => tasks.filter(t => t.parent_id);
const num = M.unitNumber;
const layout = tasks => { const by = new Map(tasks.map(t => [t.id, t])), o = {}; for (const t of unitsOf(tasks).filter(t => t.status === 'active')) { const d = by.get(t.parent_id).due_date; (o[d] ??= []).push([num(t), t.is_bonus]); } for (const d in o) o[d].sort((a, b) => a[0] - b[0]); return o; };
const show = (o, d) => (o[d] || []).map(([n, b]) => n + (b ? '*' : '')).join(',');
const finish = (tasks, ...nums) => tasks.map(t => t.parent_id && nums.includes(num(t)) ? { ...t, status: 'completed', completed_at: '2026-11-02T10:00:00.000Z' } : t);
const store = () => { const m = new Map(); return { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, m }; };
const guard = () => { const g = Object.create(TaskProtection.prototype); g.bypass = async () => false; return g; };
const plain = make(false, { ...cfg, bonus: 0 });
const merged = (tasks, a) => { const ids = M.planTree(tasks, ID); return [...tasks.filter(t => !ids.has(t.id)), ...a.tasks]; };

test('add: new bonus units continue the numbering and become the last place of the remaining days', () => {
    const r = M.bonusAdd(plain, ID, day(0), 25), l = layout(r.tasks);
    assert.equal(r.added, 25);
    assert.equal(unitsOf(r.tasks).length, 125);
    assert.equal(show(l, day(0)), '1,2,3,4,5*');
    assert.equal(show(l, day(1)), '6,7,8,9,10*');
    assert.equal(show(l, day(24)), '121,122,123,124,125*');
    const ids = new Set(unitsOf(r.tasks).map(t => t.id));
    assert.equal(ids.size, 125, 'ids are unique');
    assert.ok(r.tasks.find(t => t.due_date === day(0) && !t.parent_id).description.includes('1 to 5'), 'coverage line refreshed');
});

test('add: starts from today, spreads over the remaining days and never touches finished units', () => {
    const t = finish(plain, 1, 2, 3, 4);
    const r = M.bonusAdd(t, ID, day(1), 3), l = layout(r.tasks);
    assert.equal(r.added, 3);
    // Day 1 is in the past (its units are done); the first three remaining days get one bonus each.
    assert.deepEqual(unitsOf(r.tasks).filter(u => u.status === 'completed').map(num).sort((a, b) => a - b), [1, 2, 3, 4]);
    for (const [n, d] of [[0, day(1)], [1, day(2)], [2, day(3)]]) assert.equal(l[d].filter(([, b]) => b).length, 1, d);
    assert.equal(l[day(4)].filter(([, b]) => b).length, 0);
    assert.equal(unitsOf(r.tasks).filter(u => u.is_bonus).length, 3);
    assert.deepEqual(l[day(1)].map(x => x[0]).concat(l[day(2)].map(x => x[0])).every((n, i, a) => i === 0 || n > a[i - 1]), true, 'numbers ascend across days');
});

test('add: new units are audited like the plan, free of shield, and numbered after the highest number', () => {
    const t = make(true), r = M.bonusAdd(t, ID, day(0), 2);
    const fresh = unitsOf(r.tasks).filter(u => num(u) > 125);
    assert.equal(fresh.length, 2);
    for (const u of fresh) { assert.equal(u.ai_locked, true); assert.equal(u.strict_prerequisites, false); assert.equal(u.status, 'active'); }
    assert.equal(unitsOf(r.tasks).filter(u => u.is_bonus).length, 27, 'bonus places grew by two (the flag follows the place, not the number)');
    assert.equal(fresh[0].proof_criteria, 'Answer bank 126');
    assert.equal(fresh[1].raw_title, 'Bank.{num==127}');
    const none = M.bonusAdd(make(false), ID, day(0), 1);
    assert.ok(unitsOf(none.tasks).filter(u => num(u) > 125).every(u => !u.ai_locked && u.proof_criteria === ''));
});

test('add: input limits and plans that cannot take bonus units are refused', () => {
    for (const bad of [0, -1, 1.5, 'x', 501, null]) assert.throws(() => M.bonusAdd(plain, ID, day(0), bad), /whole number/);
    assert.throws(() => M.bonusAdd(plain, ID, day(40), 1), /No study days are left/);
    assert.throws(() => M.bonusAdd(plain, 'missing', day(0), 1), /no longer exists/);
    const smart = plain.map(t => t.parent_id && num(t) === 3 ? { ...t, smart_early_date: day(0) } : t);
    assert.throws(() => M.bonusAdd(smart, ID, day(0), 1), /Smart Study/);
});

test('remove: the plan gives up its highest numbers and as many bonus places; numbering stays continuous', () => {
    const t = make(), before = layout(t);
    const r = M.bonusRemove(t, ID, day(0), 3), l = layout(r.tasks);
    assert.equal(r.removed, 3);
    assert.equal(show(l, day(21)), show(before, day(21)));
    assert.equal(show(l, day(22)), '111,112,113,114');
    assert.equal(show(l, day(23)), '115,116,117,118');
    assert.equal(show(l, day(24)), '119,120,121,122');
    assert.equal(show(l, day(0)), show(before, day(0)));
    assert.deepEqual(unitsOf(r.tasks).map(num).sort((a, b) => a - b), Array.from({ length: 122 }, (_, i) => i + 1));
    assert.ok(r.tasks.find(t => t.due_date === day(24) && !t.parent_id).description.includes('119 to 122'));
});

test('remove: finished units never change, counts are checked, nothing to remove is an error', () => {
    const t = finish(make(), 5, 10);
    const r = M.bonusRemove(t, ID, day(0), 23), done = unitsOf(r.tasks).filter(u => u.status === 'completed');
    assert.deepEqual(done.map(num).sort((a, b) => a - b), [5, 10]);
    assert.ok(done.every(u => u.is_bonus), 'finished bonus stay as they were');
    assert.equal(unitsOf(r.tasks).filter(u => u.status === 'active').length, 100);
    assert.equal(unitsOf(r.tasks).filter(u => u.status === 'active' && u.is_bonus).length, 0);
    assert.throws(() => M.bonusRemove(t, ID, day(0), 24), /only 23 unfinished bonus units/);
    assert.throws(() => M.bonusRemove(plain, ID, day(0), 1), /no unfinished bonus units/);
    assert.throws(() => M.bonusRemove(t, ID, day(0), 0), /whole number/);
});

test('remove: a missed bonus waiting to slide must move first; with no day left it is removed where it stands', () => {
    const t = make();
    assert.throws(() => M.bonusRemove(t, ID, day(1), 1), /waiting to move/);
    const late = M.bonusRemove(t, ID, day(40), 2);
    assert.equal(late.removed, 2);
    assert.deepEqual(unitsOf(late.tasks).filter(u => u.is_bonus).map(num).sort((a, b) => a - b).slice(-1), [115]);
});

test('Worker: add and remove are authorized, grant-pinned, and need no Pro, Emergency Bypass or finished tasks', async () => {
    const g = guard(), tx = store(), before = make(true);
    // Today's units are still open and nothing is finished: this must still work.
    const a = await g.authorizeStudyBonus(tx, 'u', { tasks: before, settings: {} }, ID, { op: 'add', count: 4 }, day(0));
    assert.equal(a.added, 4);
    const after = merged(before, a);
    await g.guardSync(tx, 'u', { tasks: before }, { tasks: after });
    assert.equal(unitsOf(after).length, 129);
    // Without the grant the same push is refused (new audited units need the server).
    await assert.rejects(g.guardSync(store(), 'u', { tasks: before }, { tasks: after }), e => e.status === 403);
    // Removal of AI-audited bonus units works through the grant without Emergency Bypass.
    const tx2 = store();
    const r = await g.authorizeStudyBonus(tx2, 'u', { tasks: before, settings: {} }, ID, { op: 'remove', count: 25 }, day(0));
    assert.equal(r.removed, 25);
    const trimmed = merged(before, r);
    await g.guardSync(tx2, 'u', { tasks: before }, { tasks: trimmed });
    assert.equal(unitsOf(trimmed).length, 100);
    await assert.rejects(g.guardSync(store(), 'u', { tasks: before }, { tasks: trimmed }), e => e.status === 403, 'the same removal by hand still needs the server');
});

test('Worker: required units cannot be added or removed through the bonus path, counts must match, and tampered trees fail', async () => {
    const g = guard(), tx = store(), before = make(true);
    await assert.rejects(g.authorizeStudyBonus(tx, 'u', { tasks: before }, ID, { op: 'add', count: 0 }, day(0)), e => e.status === 400);
    await assert.rejects(g.authorizeStudyBonus(tx, 'u', { tasks: before }, ID, { op: 'remove', count: 26 }, day(0)), e => e.status === 400 && /only 25/.test(e.message));
    const a = await g.authorizeStudyBonus(tx, 'u', { tasks: before }, ID, { op: 'remove', count: 5 }, day(0));
    const ids = M.planTree(before, ID), pushed = [...before.filter(t => !ids.has(t.id)), ...a.tasks];
    const sneaky = pushed.filter(t => !t.id.endsWith('_unit_4'));
    await assert.rejects(g.guardSync(tx, 'u', { tasks: before }, { tasks: sneaky }), e => e.status === 403, 'also removing a required unit breaks the grant');
    // The Worker's own check rejects a result that removes required work or moves finished units.
    const req = unitsOf(before).find(u => !u.is_bonus);
    assert.ok(M.bonusCheck(before, before.filter(t => t.id !== req.id), ID, 'remove', day(0), 1), 'dropping one unit without giving up a bonus place is refused');
    assert.match(M.bonusCheck(before, before.filter(t => t.id !== req.id), ID, 'finish', day(0), 1), /required unit was removed/);
    const added = M.bonusAdd(plain, ID, day(0), 2);
    assert.equal(M.bonusCheck(plain, added.tasks, ID, 'add', day(0), 2), null);
    assert.match(M.bonusCheck(plain, added.tasks, ID, 'add', day(0), 3), /does not match/);
    assert.ok(M.bonusCheck(plain, added.tasks, ID, 'remove', day(0), 0));
});

test('add then remove returns the plan to its required units, and the free edit path never touches Pro or bypass', () => {
    const a = M.bonusAdd(plain, ID, day(0), 10), b = M.bonusRemove(a.tasks, ID, day(0), 10);
    assert.deepEqual(unitsOf(b.tasks).map(num).sort((x, y) => x - y), unitsOf(plain).map(num).sort((x, y) => x - y));
    const back = layout(b.tasks), orig = layout(plain);
    for (const d in orig) assert.equal(show(back, d), show(orig, d), d);
    const pb = fs.readFileSync(new URL('./pro-backend.js', import.meta.url), 'utf8'), body = pb.slice(pb.indexOf('async authorizeStudyBonus'), pb.indexOf('async studyReplanGrants'));
    assert.doesNotMatch(body, /this\.bypass|proActive|resolve\(/);
    const ui = fs.readFileSync(new URL('./study-plans.js', import.meta.url), 'utf8');
    for (const s of ["op: 'add'", "op: 'remove'", 'bonus-add', 'bonus-remove', 'bonus-remove-all', 'bonusBlock(plan, c)']) assert.ok(ui.includes(s), s);
    const bonusUi = ui.slice(ui.indexOf('function bonusBlock'), ui.indexOf('async function sendBonus'));
    assert.doesNotMatch(bonusUi, /bypass|canEdit|pro ===/, 'free and no bypass for the Bonus section');
});

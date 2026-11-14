import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
import { TaskProtection } from './pro-backend.js';

const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;
const CREATED = '2026-11-01T00:00:00.000Z', ID = 'plan_bonus_unit';
// 25 study days, 100 required + 25 bonus units: five a day, the fifth is the bonus.
const day = i => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
const cfg = { title: 'QBank', unit: 'Bank', plural: 'Banks', total: 100, bonus: 25, days: 25, first: 1, start: day(0), weekdays: [], counts: Array(25).fill(4), dates: Array.from({ length: 25 }, (_, i) => day(i)) };
const make = (audit = false, c = cfg) => C.build(c, ID, CREATED, audit, audit ? 'Answer bank {num}' : '');
const unitsOf = tasks => tasks.filter(t => t.parent_id);
const num = M.unitNumber;
const layout = tasks => { const by = new Map(tasks.map(t => [t.id, t])), o = {}; for (const t of unitsOf(tasks)) { const d = by.get(t.parent_id).due_date; (o[d] ??= []).push([num(t), t.is_bonus ? 'b' : 'r']); } for (const k of Object.keys(o)) o[k].sort((a, b) => a[0] - b[0]); return o; };
const show = (o, d) => o[d].map(([n, f]) => n + (f === 'b' ? '*' : '')).join(',');
const finish = (tasks, ...nums) => tasks.map(t => t.parent_id && nums.includes(num(t)) ? { ...t, status: 'completed', completed_at: '2026-11-02T10:00:00.000Z' } : t);

test('create: bonus units are the last units of each day and numbering continues through them', () => {
    const tasks = make(), l = layout(tasks);
    assert.equal(unitsOf(tasks).length, 125);
    assert.equal(show(l, day(0)), '1,2,3,4,5*');
    assert.equal(show(l, day(1)), '6,7,8,9,10*');
    assert.equal(show(l, day(24)), '121,122,123,124,125*');
    assert.equal(unitsOf(tasks).filter(t => t.is_bonus).length, 25);
    assert.ok(tasks.find(t => t.due_date === day(0) && !t.parent_id).description.includes('1 to 5'));
    // Day parents stay shielded; units are not.
    assert.ok(tasks.filter(t => !t.parent_id).every(t => t.strict_prerequisites));
});

test('create: bonus units carry the AI audit like the rest; fewer bonus than days fills the first days', () => {
    const tasks = make(true), u = unitsOf(tasks).find(t => num(t) === 5);
    assert.equal(u.is_bonus, true); assert.equal(u.ai_locked, true); assert.equal(u.proof_criteria, 'Answer bank 5');
    const few = layout(make(false, { ...cfg, total: 6, bonus: 2, days: 3, counts: [2, 2, 2], dates: [day(0), day(1), day(2)] }));
    assert.equal(show(few, day(0)), '1,2,3*'); assert.equal(show(few, day(1)), '4,5,6*'); assert.equal(show(few, day(2)), '7,8');
});

test('create: no bonus behaves as before; invalid bonus input is refused', () => {
    const plain = make(false, { ...cfg, bonus: 0 });
    assert.equal(unitsOf(plain).length, 100); assert.ok(unitsOf(plain).every(t => t.is_bonus === false));
    assert.equal('bonus' in C.normalize({ ...cfg, bonus: 0 }), false);
    for (const bonus of [-1, 1.5, 1001, '3']) assert.throws(() => C.normalize({ ...cfg, bonus }), /whole numbers/);
    assert.throws(() => C.normalize({ ...cfg, smart: { mode: 'original', dates: [], appearances: [] } }), /Smart Study/);
});

test('plan summary counts required units; bonus has its own counters; Complete appears when the required are done', () => {
    let t = make(); let p = M.plans(t)[0];
    assert.equal(p.total, 100); assert.equal(p.done, 0); assert.equal(p.bonus, 25); assert.equal(p.bonusLeft, 25); assert.equal(p.ready, false); assert.equal(p.finished, false);
    const required = unitsOf(t).filter(u => !u.is_bonus).map(num);
    t = finish(t, ...required); p = M.plans(t)[0];
    assert.equal(p.done, 100); assert.equal(p.ready, true); assert.equal(p.finished, false); assert.equal(p.bonusLeft, 25);
    t = finish(t, ...unitsOf(t).map(num)); p = M.plans(t)[0];
    assert.equal(p.finished, true); assert.equal(p.ready, false);
});

test('slide: your example. Bank 5 (bonus) not done on day 1 -> day 2 is 5-9, day 3 is 10-14, plan ends at 124', () => {
    const before = finish(make(), 1, 2, 3, 4), r = M.bonusSlide(before, ID, day(1)), l = layout(r.tasks);
    assert.equal(show(l, day(0)), '1,2,3,4');
    assert.equal(show(l, day(1)), '5,6,7,8,9*');
    assert.equal(show(l, day(2)), '10,11,12,13,14*');
    assert.equal(show(l, day(24)), '120,121,122,123,124*');
    assert.equal(unitsOf(r.tasks).length, 124); assert.equal(r.dropped, 1); assert.equal(r.missed, 1);
    assert.equal(M.bonusCheck(before, r.tasks, ID, 'slide', day(1)), null);
    assert.ok(r.tasks.find(t => !t.parent_id && t.due_date === day(1)).description.includes('5 to 9'));
    // Bank 9 was required on day 2 and is the bonus now; bank 5 was a bonus and is required now.
    const u = k => r.tasks.find(t => t.parent_id && num(t) === k);
    assert.equal(u(9).is_bonus, true); assert.equal(u(5).is_bonus, false);
});

test('slide: several misses, finished units stay, input is not mutated', () => {
    const before = finish(make(), 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14), copy = JSON.stringify(before);
    const r = M.bonusSlide(before, ID, day(3)), l = layout(r.tasks);
    assert.equal(JSON.stringify(before), copy);
    assert.equal(r.missed, 3); assert.equal(r.dropped, 3);
    assert.equal(show(l, day(3)), '5,10,15,16,17*');
    assert.equal(unitsOf(r.tasks).length, 122);
    assert.equal(show(l, day(1)), '6,7,8,9'); assert.equal(show(l, day(2)), '11,12,13,14');
    assert.equal(M.bonusCheck(before, r.tasks, ID, 'slide', day(3)), null);
});

test('slide: a bonus that was finished stays finished; an overdue required unit is not touched and is not a bonus', () => {
    const before = finish(make(), 1, 2, 3, 5);      // day 1: bank 4 (required) missed, bonus 5 done
    assert.equal(M.softOverdue(before, ID, day(1)).map(num).join(), '4');
    assert.equal(M.bonusWaiting(before, ID, day(1)), false);
    assert.throws(() => M.bonusSlide(before, ID, day(1)), /No bonus unit is waiting/);
    const r = M.bonusSlide(finish(make(), 1, 2, 3, 4), ID, day(1));
    assert.equal(M.softOverdue(r.tasks, ID, day(1)).length, 0);
});

test('slide: bonus is never overdue; without a day to slide to nothing moves', () => {
    const t = finish(make(), ...unitsOf(make()).filter(u => !u.is_bonus).map(num));
    assert.equal(M.softOverdue(t, ID, day(30)).length, 0);
    assert.equal(M.bonusWaiting(t, ID, day(30)), false);
    assert.throws(() => M.bonusSlide(t, ID, day(30)), /No study days are left/);
    assert.equal(M.bonusWaiting(make(), ID, day(0)), false);
});

test('slide: a unit finished early on a later day is not shifted', () => {
    const before = finish(make(), 1, 2, 3, 4, 7), r = M.bonusSlide(before, ID, day(1)), l = layout(r.tasks);
    assert.equal(show(l, day(1)), '5,6,7,8,9*');   // 7 stays where it was done; the unfinished units of the day shift around it
    assert.equal(M.bonusCheck(before, r.tasks, ID, 'slide', day(1)), null);
    assert.equal(r.tasks.find(t => t.parent_id && num(t) === 7).status, 'completed');
});

test('slide: bonusCheck refuses tampering', () => {
    const before = finish(make(), 1, 2, 3, 4), good = M.bonusSlide(before, ID, day(1)).tasks;
    const renamed = structuredClone(good); renamed.find(t => t.parent_id && num(t) === 12).title = 'Other';
    assert.match(M.bonusCheck(before, renamed, ID, 'slide', day(1)), /beyond its day/);
    const kept = structuredClone(before).filter(t => !t.id.endsWith('_unit_125') && !t.id.endsWith('_unit_124'));
    assert.match(M.bonusCheck(before, kept, ID, 'slide', day(1)), /dropped does not match/);
    const flip = structuredClone(good); flip.find(t => t.parent_id && num(t) === 12).is_bonus = true;
    assert.match(M.bonusCheck(before, flip, ID, 'slide', day(1)), /places per day/);
    const past = structuredClone(good); const u = past.find(t => t.parent_id && num(t) === 5); u.parent_id = before.find(t => !t.parent_id && t.due_date === day(0)).id; u.due_date = day(0);
    assert.match(M.bonusCheck(before, past, ID, 'slide', day(1)), /past day|places per day/);
});

test('convert makes the unfinished bonus units required and keeps their audits; finish needs every required unit done', () => {
    const t = make(true), c = M.bonusConvert(t, ID);
    assert.equal(c.converted, 25); assert.ok(unitsOf(c.tasks).every(u => !u.is_bonus));
    assert.equal(unitsOf(c.tasks).find(u => num(u) === 5).ai_locked, true);
    assert.equal(M.plans(c.tasks)[0].total, 125);
    assert.throws(() => M.bonusConvert(c.tasks, ID), /no unfinished bonus/);
    assert.throws(() => M.bonusFinish(t, ID), /required units first/);
    const done = finish(t, ...unitsOf(t).filter(u => !u.is_bonus).map(num)), f = M.bonusFinish(done, ID);
    assert.equal(f.removed, 25); assert.equal(unitsOf(f.tasks).length, 100);
    assert.equal(M.plans(f.tasks)[0].finished, true);
    assert.equal(M.bonusCheck(done, f.tasks, ID, 'finish', day(25)), null);
    assert.ok(f.tasks.find(x => !x.parent_id && x.due_date === day(0)).description.includes('1 to 4'));
});

test('re-plan is off while bonus units are open', () => {
    assert.throws(() => M.replan(make(), ID, { rev: 'abcd', mode: 'perDay', per: 3, start: day(5), weekdays: [], rates: {} }), /bonus units/);
});

// ---- Worker: grant, then the sync guard accepts exactly the computed tree ----
const store = () => { const m = new Map(); return { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, m }; };
const guard = () => { const g = Object.create(TaskProtection.prototype); g.bypass = async () => false; return g; };

test('Worker: slide is authorized, pinned by a grant, and the same sync is accepted; a different tree is refused', async () => {
    const g = guard(), tx = store(), before = finish(make(true), 1, 2, 3, 4), snapshot = { tasks: before, settings: {} };
    const a = await g.authorizeStudyBonus(tx, 'u', snapshot, ID, { op: 'slide' }, day(1));
    assert.equal(a.missed, 1); assert.equal(a.dropped, 1);
    const ids = M.planTree(before, ID), pushed = [...before.filter(t => !ids.has(t.id)), ...a.tasks];
    await g.guardSync(tx, 'u', { tasks: before }, { tasks: pushed });
    // Without the grant the same change is rejected: audited units may not change day, parent or bonus flag.
    await assert.rejects(g.guardSync(store(), 'u', { tasks: before }, { tasks: pushed }), e => e.status === 403);
    // A tampered tree does not match the grant.
    const wrong = pushed.filter(t => !t.id.endsWith('_unit_20'));
    await assert.rejects(g.guardSync(tx, 'u', { tasks: before }, { tasks: wrong }), e => e.status === 403);
});

test('Worker: finish is authorized only when the required units are done; unknown operations and plans are refused', async () => {
    const g = guard(), tx = store(), t = make(true);
    await assert.rejects(g.authorizeStudyBonus(tx, 'u', { tasks: t }, ID, { op: 'finish' }, day(5)), e => e.status === 400 && /required units first/.test(e.message));
    await assert.rejects(g.authorizeStudyBonus(tx, 'u', { tasks: t }, ID, { op: 'convert' }, day(5)), e => e.status === 400);
    await assert.rejects(g.authorizeStudyBonus(tx, 'u', { tasks: t }, 'other_plan_id', { op: 'slide' }, day(5)), e => e.status === 404);
    const done = finish(t, ...unitsOf(t).filter(u => !u.is_bonus).map(num));
    const a = await g.authorizeStudyBonus(tx, 'u', { tasks: done }, ID, { op: 'finish' }, day(30));
    assert.equal(a.removed, 25);
    const ids = M.planTree(done, ID);
    await g.guardSync(tx, 'u', { tasks: done }, { tasks: [...done.filter(x => !ids.has(x.id)), ...a.tasks] });
});

test('Worker: the bonus action is routed, needs no Pro license and the client wires slide, Complete and Convert', () => {
    const worker = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    assert.match(worker, /\['delete','replan','soften','bonus'\]/);
    assert.match(worker, /b\.action==='bonus'\)return json\(await this\.protection\.authorizeStudyBonus/);
    assert.doesNotMatch(worker, /b\.action==='bonus'&&!await this\.universe\.entitlement/);
    const ui = fs.readFileSync(new URL('./study-plans.js', import.meta.url), 'utf8');
    for (const s of ["data-act'] || 'bonus-finish'", 'bonus-finish', 'bonus-convert', "op: 'slide'", "op: 'finish'", 'M.bonusConvert', 'setInterval(sweepBonus']) assert.ok(ui.includes(s.replace("data-act'] || ", '')), s);
});

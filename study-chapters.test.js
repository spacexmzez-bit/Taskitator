import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';

const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;
const CREATED = '2026-11-01T00:00:00.000Z', ID = 'plan_chapters';
const day = i => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
const cfg = (o = {}) => ({ title: 'QBank', unit: 'Bank', plural: 'Banks', total: 12, days: 3, first: 1, start: day(0), weekdays: [], counts: [4, 4, 4], dates: [day(0), day(1), day(2)], ...o });
const make = (o = {}, audit = false) => C.build(cfg(o), ID, CREATED, audit, audit ? 'Answer bank {num}' : '');
const units = t => t.filter(x => x.parent_id).sort((a, b) => M.unitNumber(a) - M.unitNumber(b));
const parents = t => t.filter(x => !x.parent_id).sort((a, b) => a.due_date.localeCompare(b.due_date));

test('chapter = ceil(number / size); titles get a prefix, raw titles keep the number pattern', () => {
    const t = make({ chapter_size: 5 }), u = units(t);
    assert.equal(u[0].title, 'Ch 1 · Bank.1');
    assert.equal(u[4].title, 'Ch 1 · Bank.5');
    assert.equal(u[5].title, 'Ch 2 · Bank.6');
    assert.equal(u[11].title, 'Ch 3 · Bank.12');
    assert.equal(u[5].raw_title, 'Ch 2 · Bank.{num==6}');
    assert.equal(M.unitNumber(u[5]), 6);
    assert.ok(u.every(x => x.chapter_size === 5 && x.chapter_label === 'Ch'));
    assert.equal(C.chapterOf(10, 5), 2); assert.equal(C.chapterOf(11, 5), 3);
});

test('each day lists its chapters; days that span chapters list both', () => {
    const d = parents(make({ chapter_size: 5 })).map(p => p.description);
    assert.equal(d[0], 'Covers banks 1 to 4 · Ch 1 (1–4)');
    assert.equal(d[1], 'Covers banks 5 to 8 · Ch 1 (5), Ch 2 (6–8)');
    assert.equal(d[2], 'Covers banks 9 to 12 · Ch 2 (9–10), Ch 3 (11–12)');
});

test('custom label, bonus units and a first number above 1 follow the same rule', () => {
    const t = make({ chapter_size: 4, chapter_label: 'Week', first: 11, total: 12 }), u = units(t);
    assert.equal(u[0].title, 'Week 3 · Bank.11');
    assert.equal(u.at(-1).title, 'Week 6 · Bank.22');
    const b = units(make({ chapter_size: 5, bonus: 3, counts: [4, 4, 4] }));
    assert.equal(b.length, 15); assert.equal(b.at(-1).title, 'Ch 3 · Bank.15');
});

test('off by default: nothing changes without a chapter size', () => {
    for (const o of [{}, { chapter_size: '' }, { chapter_size: null, chapter_label: 'Week' }]) {
        const t = make(o), u = units(t);
        assert.equal(u[0].title, 'Bank.1'); assert.equal(u[0].raw_title, 'Bank.{num==1}');
        assert.ok(u.every(x => !('chapter_size' in x)));
        assert.equal(parents(t)[1].description, 'Covers banks 5 to 8');
    }
});

test('validation: size, label length, brackets and the · sign', () => {
    for (const bad of [0, -2, 1.5, 1001, 'x']) assert.throws(() => C.normalize(cfg({ chapter_size: bad })), /whole numbers/);
    assert.throws(() => C.normalize(cfg({ chapter_size: 5, chapter_label: 'A'.repeat(21) })), /chapter label/);
    assert.throws(() => C.normalize(cfg({ chapter_size: 5, chapter_label: 'C{h}' })), /chapter label/);
    assert.throws(() => C.normalize(cfg({ chapter_size: 5, chapter_label: 'C · h' })), /chapter label/);
    assert.throws(() => C.normalize(cfg({ unit: 'Bank · A' })), /unit name/);
    assert.equal(C.normalize(cfg({ chapter_size: '5', chapter_label: '  ' })).chapter_label, 'Ch');
});

test('unitName reads the unit with or without a prefix, and a name like "Week 3" is not mistaken for one', () => {
    assert.equal(C.unitName('Bank.{num==4}'), 'Bank');
    assert.equal(C.unitName('Ch 2 · Bank.{num==6}'), 'Bank');
    assert.equal(C.unitName('Week 3.{num==5}'), 'Week 3');
    assert.equal(C.unitName('Ch 12 · Week 3.{num==5}'), 'Week 3');
    assert.equal(C.unitName('plain'), null);
});

test('plans() reads the chapter setting and the plain unit name back', () => {
    const p = M.plans(make({ chapter_size: 5, chapter_label: 'Week' }))[0];
    assert.deepEqual(p.chapter, { size: 5, label: 'Week' });
    assert.equal(p.unit, 'Bank'); assert.equal(p.plural, 'banks');
    assert.equal(M.plans(make())[0].chapter, null);
});

test('rename unit keeps the chapter prefix and the coverage tail', () => {
    const t = make({ chapter_size: 5 }), r = M.renameUnit(t, ID, 'Lesson', 'Lessons');
    assert.equal(units(r.tasks)[5].title, 'Ch 2 · Lesson.6');
    assert.equal(units(r.tasks)[5].raw_title, 'Ch 2 · Lesson.{num==6}');
    assert.equal(parents(r.tasks)[1].description, 'Covers lessons 5 to 8 · Ch 1 (5), Ch 2 (6–8)');
});

test('setChapters: add, change, remove; removing restores the plain plan exactly', () => {
    const plain = make(), added = M.setChapters(plain, ID, 5, 'Ch');
    assert.deepEqual(added.tasks, make({ chapter_size: 5 }));
    const changed = M.setChapters(added.tasks, ID, 4, 'Week');
    assert.deepEqual(changed.tasks, make({ chapter_size: 4, chapter_label: 'Week' }));
    const removed = M.setChapters(changed.tasks, ID, null, 'Ch');
    assert.deepEqual(removed.tasks, plain);
    assert.equal(removed.changed, 12);
    assert.throws(() => M.setChapters(plain, ID, 0, 'Ch'), /whole numbers/);
    assert.throws(() => M.setChapters(plain, ID, 5, 'C·h'), /chapter label/);
});

test('setChapters keeps finished units, statuses and days; manual description lines survive', () => {
    let t = make();
    t = t.map(x => x.id === 'study_' + ID + '_unit_3' ? { ...x, status: 'completed', completed_at: CREATED } : x);
    t = t.map(x => !x.parent_id ? { ...x, description: x.description + '\nMy note' } : x);
    const r = M.setChapters(t, ID, 2, 'Ch').tasks;
    assert.equal(r.find(x => x.id === 'study_' + ID + '_unit_3').status, 'completed');
    assert.equal(r.find(x => x.id === 'study_' + ID + '_unit_3').title, 'Ch 2 · Bank.3');
    assert.equal(parents(r)[0].description, 'Covers banks 1 to 4 · Ch 1 (1–2), Ch 2 (3–4)\nMy note');
    assert.deepEqual(units(r).map(x => x.parent_id), units(t).map(x => x.parent_id));
});

test('setChapters on an audited plan needs Emergency Bypass', () => {
    const t = make({}, true);
    assert.throws(() => M.setChapters(t, ID, 5, 'Ch'), /Emergency Bypass/);
    const r = M.setChapters(t, ID, 5, 'Ch', { bypass: true }).tasks;
    assert.equal(units(r)[5].title, 'Ch 2 · Bank.6');
    assert.equal(units(r)[5].proof_criteria, 'Answer bank 6');
    assert.equal(units(r)[5].ai_locked, true);
});

test('adding bonus units continues the chapters by number', () => {
    const t = make({ chapter_size: 5 }), r = M.bonusAdd(t, ID, day(0), 4), u = units(r.tasks);
    assert.equal(u.length, 16);
    assert.equal(u.at(-1).title, 'Ch 4 · Bank.16'); assert.equal(u.at(-1).raw_title, 'Ch 4 · Bank.{num==16}');
    assert.equal(u.at(-1).chapter_size, 5);
    assert.equal(M.plans(r.tasks)[0].unit, 'Bank');
    const days = parents(r.tasks).map(p => p.description);
    assert.ok(days.every(d => d.includes(' · Ch ')), days.join(' | '));
});

test('plan card and create dialog expose the two fields', () => {
    const plans = fs.readFileSync(new URL('./study-plans.js', import.meta.url), 'utf8');
    for (const s of ["tr('Units per chapter (optional)')", "tr('Chapter label')", 'M.setChapters']) assert.ok(plans.includes(s), s);
    const ui = fs.readFileSync(new URL('./pro/study-plan.js', import.meta.url), 'utf8');
    for (const s of ["'Units per chapter (optional)'", "'Chapter label'", 'chapter_size:chapOn.checked?chapSize.value||null:null']) assert.ok(ui.includes(s), s);
});

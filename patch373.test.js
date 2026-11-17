import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
// Phase 3.7.3: per-date bonus amounts, settings tab split, Summary sub tabs.
const C = globalThis.TaskitatorStudyCore;
const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const day = i => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
const cfg = { title: 'Math', unit: 'Lesson', plural: 'Lessons', total: 8, bonus: 4, days: 4, first: 1, start: day(0), weekdays: [], counts: [2, 2, 2, 2], dates: [day(0), day(1), day(2), day(3)] };
const J = v => JSON.parse(JSON.stringify(v));

test('bonus_counts: each date takes its own bonus amount, main amounts are untouched', () => {
    const r = C.rows({ ...cfg, bonus_counts: [0, 3, 1, 0] });
    assert.deepEqual(J(r.map(x => x.count)), [2, 2, 2, 2]);
    assert.deepEqual(J(r.map(x => x.bonus)), [0, 3, 1, 0]);
    assert.deepEqual(J(r.map(x => x.numbers.length)), [2, 5, 3, 2]);
    assert.equal(r.flatMap(x => x.numbers).length, 12);
});
test('bonus_counts: must cover every day and add up to the bonus total; absent means even split', () => {
    for (const bad of [[1, 1, 1], [1, 1, 1, 2], [-1, 2, 2, 1], [1.5, 1, 1, 0.5]]) assert.throws(() => C.normalize({ ...cfg, bonus_counts: bad }), /bonus/i);
    assert.deepEqual(J(C.rows(cfg).map(x => x.bonus)), [1, 1, 1, 1]);
    assert.equal('bonus_counts' in C.normalize(cfg), false);
    assert.deepEqual(J(C.normalize({ ...cfg, bonus_counts: [4, 0, 0, 0] }).bonus_counts), [4, 0, 0, 0]);
});
test('bonus_counts: the built plan marks exactly that many bonus units per day', () => {
    const tasks = C.build({ ...cfg, bonus_counts: [0, 3, 1, 0] }, 'plan_p373', '2026-11-01T00:00:00.000Z', false, '');
    const parents = tasks.filter(t => !t.parent_id).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const per = parents.map(p => tasks.filter(t => t.parent_id === p.id && t.is_bonus).length);
    assert.deepEqual(per, [0, 3, 1, 0]);
    assert.equal(tasks.filter(t => t.parent_id && !t.is_bonus).length, 8);
});
test('steppers and drafts keep Main and Bonus separate', () => {
    const sch = src('pro/study-schedule.js'), plan = src('pro/study-plan.js'), drafts = src('task-drafts.js');
    for (const k of ["'bonus-minus'", "'bonus-plus'", 'data-ss-total']) assert.ok(sch.includes(k), k);
    assert.ok(plan.includes('bonusStep:(date,v)=>setBonus(date,v)') && plan.includes('bonus_counts:st.sched.map'));
    assert.ok(plan.includes('bonus_per:bonusPer?[...bonusPer]:[]') && drafts.includes('bonus_per'));
    // typing a new total or bonus drops per-date amounts so they can never disagree with the total
    assert.ok(plan.includes("total.addEventListener('input',()=>{bonusReset();") && plan.includes("bonus.addEventListener('input',()=>{bonusReset();") && plan.includes('function bonusReset(){bonusPer=null;'));
});
test('settings page: every section starts hidden, the script hides inactive ones, the stylesheet is re-fetched', () => {
    const h = src('settings.html');
    assert.equal((h.match(/class="settings-pane" id="tab-\w+" hidden role="tabpanel"/g) || []).length, 6);
    assert.ok(h.includes('p.hidden = !on;') && h.includes("p.style.display = on ? '' : 'none'"));
    assert.ok(!h.includes('btn.scrollIntoView'), 'tab press must not scroll the page to the tab');
    assert.ok(h.includes('style.css?v=ui-v3-split'));
    assert.ok(/\.settings-pane\[hidden\]\{display:none!important\}/.test(src('style.css')));
});
test('Summary sub tabs: schedule/AI/info, calendar and list, three distinct dot colours, read only', () => {
    const u = src('pro/study-plan.js'), c = src('style.css');
    for (const k of ["['sched','Schedule']", "['ai','AI criteria']", "['info','Task info']", "PC.render(body", "also early on {date}", "due {date}"]) assert.ok(u.includes(k), k);
    const colours = ['main', 'bonus', 'early'].map(k => new RegExp('\\.sum-dot\\.is-' + k + '\\{background:(#[0-9a-f]{6})').exec(c)?.[1]);
    assert.ok(colours.every(Boolean) && new Set(colours).size === 3, colours.join());
    const body = u.slice(u.indexOf('function renderSummary()'), u.indexOf('// One place decides')) + src('pro/plan-calendar.js');
    assert.ok(!/<input|<textarea|\.contentEditable|type=.number/.test(body) && !/createElement\('input'|node\('input'|node\('textarea'/.test(body), 'no editing controls in the Summary');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('./pro/plan-calendar.js', import.meta.url), 'utf8'), ctx);
const PC = ctx.TaskitatorPlanCalendar, J = v => JSON.parse(JSON.stringify(v));
const parents = [{ id: 'd1', due_date: '2026-03-10' }, { id: 'd2', due_date: '2026-03-11' }];
const u = (id, n, parent, extra = {}) => ({ id, parent_id: parent, title: 'Lesson ' + n, raw_title: 'Lesson {num==' + n + '}', status: 'active', ...extra });
const plan = units => ({ parents, units });

test('saved plan: main and bonus land on the due day, kinds are separate', () => {
    const days = PC.group(PC.fromPlan(plan([u('a', 1, 'd1'), u('b', 2, 'd1', { is_bonus: true }), u('c', 3, 'd2')])));
    assert.deepEqual(J([...days.keys()]), ['2026-03-10', '2026-03-11']);
    const d1 = days.get('2026-03-10');
    assert.deepEqual([d1.main.length, d1.bonus.length, d1.early.length], [1, 1, 0]);
});
test('Smart Study early date shows as Early on its day and as Main on its due day', () => {
    const days = PC.group(PC.fromPlan(plan([u('c', 3, 'd2', { smart_early_date: '2026-03-10' })])));
    assert.equal(days.get('2026-03-10').early.length, 1);
    assert.equal(days.get('2026-03-10').main.length, 0);
    assert.equal(days.get('2026-03-11').main.length, 1);
    assert.match(days.get('2026-03-10').early[0].text, /due 2026-03-11/);
    assert.match(days.get('2026-03-11').main[0].text, /also early on 2026-03-10/);
});
test('a pulled-forward unit (early_date) counts as Early too; adjusted Smart dates and bad dates do not', () => {
    const pulled = PC.group(PC.fromPlan(plan([u('c', 3, 'd2', { early_date: '2026-03-10' })])));
    assert.equal(pulled.get('2026-03-10').early.length, 1);
    const adjusted = PC.group(PC.fromPlan(plan([u('c', 3, 'd2', { smart_early_date: '2026-03-10', smart_adjusted: true })])));
    assert.equal(adjusted.has('2026-03-10'), false);
    const late = PC.group(PC.fromPlan(plan([u('c', 3, 'd1', { early_date: '2026-03-12' })])));
    assert.equal(late.has('2026-03-12'), false, 'an early date on or after the due date is ignored');
    const bonus = PC.group(PC.fromPlan(plan([u('c', 3, 'd2', { is_bonus: true, early_date: '2026-03-10' })])));
    assert.equal(bonus.has('2026-03-10'), false, 'bonus units are never shown early');
});
test('completed units keep their place with a check mark; items sort by unit number', () => {
    const days = PC.group(PC.fromPlan(plan([u('b', 2, 'd1'), u('a', 1, 'd1', { status: 'completed' })])));
    assert.deepEqual(J(days.get('2026-03-10').main.map(e => e.text)), ['✓ Lesson 1', 'Lesson 2']);
});
test('builder Summary and Preview share one renderer and neither edits', () => {
    const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
    assert.ok(read('study-plans.js').includes('PC.render(calBox') && read('pro/study-plan.js').includes('PC.render(body'));
    assert.match(read('index.html'), /src="pro\/plan-calendar\.js"/);
    assert.match(read('sw.js'), /\.\/pro\/plan-calendar\.js/);
    const m = read('pro/plan-calendar.js');
    assert.ok(!/addEventListener|createElement\('input'|\.value\s*=/.test(m));
});

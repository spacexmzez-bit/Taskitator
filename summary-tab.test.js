import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Phase 3.7: Summary tab and two-step Create plan, Smart calendar counts, red/blue confirmations.
const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
test('create dialog has a fourth Summary tab that is empty until the plan is ready', () => {
    const u = src('pro/study-plan.js');
    assert.ok(u.includes("['summary','Summary','goal']"));
    assert.ok(u.includes("'Complete the plan to see its summary.'"));
    assert.ok(u.includes('ready=ok;renderSummary();'));
    for (const s of ["'Schedule'", "'Task info'", "'AI criteria'", "'Study days'", "data-sum-view", "sum-dot is-'+k"]) assert.ok(u.includes(s), s);
});
test('Create plan: first press opens Summary, second asks; red with criteria, blue without', () => {
    const u = src('pro/study-plan.js'), i = u.indexOf("if(activeTab!=='summary'){showTab('summary')");
    assert.ok(i > 0 && i < u.indexOf("tone:guarded?'danger':'primary'") && u.indexOf("tone:guarded?'danger':'primary'") < u.indexOf("action:'authorize'"));
    assert.ok(u.includes("const guarded=Boolean(audit.checked&&criteria.value.trim())"));
});
test('Smart calendar counts sit on their own line, not on the day number', () => {
    const u = src('pro/study-plan.js'), c = src('style.css');
    assert.ok(u.includes("'ss-smart-count'") && !/ss-cell-count[^;]*pb\+em/.test(u));
    assert.ok(/\.ss-smart-count\{display:flex/.test(c) && !/\.ss-smart-count\{[^}]*position:absolute/.test(c));
});
test('edit confirmation is red for AI criteria or audited re-plans, blue otherwise', () => {
    const p = src('study-plans.js');
    assert.ok(p.includes("function ask(title, lines, yes, tone)") && p.includes("classList.toggle('is-danger', tone === 'danger')"));
    assert.ok(p.includes("const risky = info.dirty.ai || (plan.audited > 0 && (info.dirty.sched"));
    assert.ok(p.includes("risky ? 'danger' : 'primary'"));
    assert.ok(/\.plan-confirm \.is-danger\{background:var\(--danger\)/.test(src('style.css')));
});

test('Study plans page: Preview plan shows a read-only summary without opening Edit', () => {
    const p = src('study-plans.js');
    assert.ok(p.includes("tr('Preview plan')") && p.includes("tr('Hide preview')") && p.includes('function planPreview(plan, parent)'));
    assert.ok(p.includes("if (previewing) planPreview(plan, c);"));
    const fn = p.slice(p.indexOf('function planPreview'), p.indexOf('function card(plan'));
    assert.ok(!/addEventListener|Drafts\(|commit\(/.test(fn), 'read-only');
    assert.ok(fn.includes("tr('Main {n}'") && fn.includes("tr('({plan} plan, {early} early)'"));
});

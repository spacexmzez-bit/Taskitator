// Phase 6.3: UI fixes, AI-lock cost after audited units are done, Test lab redesign.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js';
const C = globalThis.TaskitatorStudyCore, M = globalThis.TaskitatorStudyManage;
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const cfg = { title: 'Biology', unit: 'Chapter', plural: 'Chapters', total: 6, days: 3, first: 1, start: '2026-11-09', weekdays: [], parent_priority: 'prio_high', unit_priority: 'prio_med' };
const build = () => C.build(cfg, 'plan_p63_1', new Date().toISOString(), true, 'Show notes for chapter {num}.');
const done = (tasks, ids) => tasks.map(t => ids.includes(t.id) ? { ...t, status: 'completed', completed_at: '2026-11-09T10:00:00.000Z' } : t);
const unitIds = tasks => tasks.filter(t => t.parent_id).map(t => t.id);

test('auditedOpen counts only unfinished audited units', () => {
    const tasks = build(), ids = unitIds(tasks);
    assert.equal(M.plans(tasks)[0].auditedOpen, 6);
    const p = M.plans(done(tasks, ids.slice(0, 4)))[0];
    assert.deepEqual([p.audited, p.auditedOpen], [6, 2]);
    assert.equal(M.plans(done(tasks, ids))[0].auditedOpen, 0);
});

test('rename and relabel: blocked while audited work is open, free once it is all finished', () => {
    const tasks = build(), ids = unitIds(tasks);
    assert.throws(() => M.renameUnit(done(tasks, ids.slice(0, 3)), 'plan_p63_1', 'Lesson', 'Lessons'), /Emergency Bypass/);
    const all = done(tasks, ids);
    const r = M.renameUnit(all, 'plan_p63_1', 'Lesson', 'Lessons');
    assert.equal(r.changed, 0, 'finished audited units keep their titles (the server locks them)');
    for (const id of ids) assert.equal(r.tasks.find(t => t.id === id).title, all.find(t => t.id === id).title);
    assert.equal(M.renameUnit(all, 'plan_p63_1', 'Lesson', 'Lessons', { bypass: true }).changed, 6, 'bypass renames them');
    const ch = M.setChapters(all, 'plan_p63_1', 2, 'Ch');
    for (const id of ids) assert.equal(ch.tasks.find(t => t.id === id).title, all.find(t => t.id === id).title);
});

test('deleting a plan costs bypass uses only when unfinished AI-protected units exist', () => {
    const src = read('pro-backend.js');
    assert.match(src, /const guarded=group\.some\(t=>protectedTask\(t\)&&t\.status==='active'\)/);
    const ui = read('study-plans.js');
    assert.match(ui, /const guarded = plan\.auditedOpen > 0;/);
    assert.match(ui, /Free: every AI-checked unit in this plan is already finished\./);
});

test('Check criteria says it changes nothing and colours its score', () => {
    const ui = read('study-plans.js');
    assert.match(ui, /Checking changes nothing\. Units are only locked when you save\./);
    assert.match(ui, /check\.dataset\.tone = v\.score >= 7 \? 'good' : v\.score >= 4 \? 'warn' : 'bad'/);
});

test('dark native controls and no white flash', () => {
    assert.match(read('style.css'), /:root \{ color-scheme: dark; \}/);
    const boot = read('theme-boot.js');
    assert.match(boot, /html\.style\.colorScheme = 'dark'/);
    assert.match(boot, /html\.style\.backgroundColor = space \? space\.metaThemeColor : theme\.metaThemeColor/);
});

test('tabs move their underline at once and keep the choice through a redraw', () => {
    const ui = read('study-plans.js');
    const click = ui.slice(ui.indexOf("b.addEventListener('click', () => {\n            const panel = c.querySelector('.plan-panel');"));
    assert.ok(click.indexOf("setAttribute('aria-selected', String(t === b))") < click.indexOf('d.tabTransition = setTimeout'));
    assert.ok(click.indexOf('d.tab = key;') < click.indexOf('const apply'));
    const wiz = read('pro/study-plan.js'), fn = wiz.slice(wiz.indexOf('function showTab(k){'));
    assert.ok(fn.indexOf("b.setAttribute('aria-selected',String(key===k))") < fn.indexOf('if(activeTab===k)return;'));
    assert.match(read('pro/plan-calendar.js'), /setAttribute\('aria-pressed',String\(state\.view===k\)\)/);
});

test('Study plans page: one bypass button, + switches to Plans, Edit closes the preview, Discard asks and closes', () => {
    assert.match(read('style.css'), /html\[data-shell="study-plans"\] \.top-navbar #emergencyTriggerBtn \{ display: none; \}/);
    const ui = read('study-plans.js');
    assert.match(ui, /if \(!isOpen\) \{ previews\.delete\(plan\.id\); render\(\);/);
    assert.match(ui, /await ask\(tr\('Discard changes\?'\)[\s\S]{0,140}'danger'\)\) return;\s*drafts\.delete\(current\); current = null;/);
    assert.match(ui, /--plan-bar-h/);
    assert.match(read('style.css'), /padding-bottom: calc\(var\(--plan-bar-h, 110px\) \+ 32px\)/);
    assert.doesNotMatch(ui, /convert the bonus units to required first/);
});

test('selected study toggles have readable contrast', () => {
    const css = read('style.css');
    assert.match(css, /--primary-strong: color-mix\(in srgb, var\(--primary\) 68%, #000\)/);
    assert.match(css, /:root :is\(\.study-seg-btn\.is-active, \.ss-seg-btn\.is-active, \.plan-seg-btn\.is-active\) \{ background: var\(--primary-strong\)/);
});

test('Create New Task has a close button and a sticky footer', () => {
    assert.match(read('index.html'), /id="addTaskCloseX" aria-label="Close"/);
    assert.match(read('components.js'), /getElementById\('addTaskCloseX'\)\?\.addEventListener\('click', \(\) => closeAddTaskModalBtn\?\.click\(\)\)/);
    assert.match(read('style.css'), /#addTaskModal \.task-modal-actions-create \{ position: sticky;/);
});

test('Test lab: switcher, colour-coded results, button roles', () => {
    const lab = read('test-lab.js');
    assert.match(lab, /ui\.picker\.addEventListener\('change', \(\) => switchTo\(ui\.picker\.value\)\)/);
    assert.match(lab, /const scoreTone = s => \(Number\(s\) >= 7 \? 'good' : Number\(s\) >= 4 \? 'warn' : 'bad'\)/);
    assert.match(lab, /const verdictTone = v => \(v === 'approved' \? 'good' : v === 'incomplete' \? 'warn' : 'bad'\)/);
    assert.match(lab, /tr\('Test'\), bar, 'icon-btn lab-primary'/);
    assert.match(lab, /tr\('Validate'\), bar, 'icon-btn lab-secondary'/);
    assert.match(lab, /tr\('Remove B'\), head, 'icon-btn lab-small lab-danger'/);
    const css = read('style.css');
    assert.match(css, /\.lab-wrap \.lab-card\[data-side=b\] \{ border-inline-start-color: var\(--lab-b\); \}/);
    assert.match(css, /\.lab-wrap \.lab-topbar \{ position: sticky;/);
});

test('new Phase 6.3 strings have Arabic translations', () => {
    const ar = read('locales/ar.js');
    for (const k of ['Version A', 'Save to criteria library', 'Test inputs', 'Delete this test?', 'Discard changes?', 'Checking changes nothing. Units are only locked when you save.',
        'Free: every AI-checked unit in this plan is already finished.', 'Finished AI-checked units keep their current names when you rename the unit or change chapter labels.'])
        assert.ok(ar.includes('"' + k + '":'), k);
});

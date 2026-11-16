// Phase 4.0: calendar editing without completion, completion inside the editor, completed-task lock, AI Audit card,
// subtask circles on the shared 10 s undo, Dynamic Priority unlocked for shields/AI locks, "Early Appearance" rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const html = read('index.html'), comp = read('components.js'), app = read('app.js'), cal = read('views/calendar.js');
const editor = html.slice(html.indexOf('id="taskDetailModal"'), html.indexOf('id="auditModal"'));

test('calendar: rows open the editor; the circle never completes and shows the in-app note', () => {
    assert.doesNotMatch(cal, /handleTaskCompletion|alert\(/);
    assert.match(cal, /openTaskDetailModal\(taskId, refreshCalendar, \{ origin: 'calendar' \}\)/);
    assert.match(cal, /showCalendarCompleteNote\(\)/);
    assert.match(html, /id="calendarCompleteNote"[^>]*hidden/);
    assert.ok(html.indexOf('id="calendarCompleteNote"') < html.indexOf('id="agendaListContainer"'));
});

test('editor opened from the calendar blocks completion inside the panel too', () => {
    assert.match(comp, /detailOrigin = opts\?\.origin \|\| null/);
    assert.match(comp, /function blockedHere\(\) \{\s*if \(detailOrigin !== 'calendar'\) return false;/);
    assert.match(comp, /openTaskDetailModal\(child\.id, triggerRenderFn, \{ origin: detailOrigin \}\)/);
});

test('title row: the completion circle sits before the title (start side, so right in Arabic)', () => {
    const row = editor.slice(editor.indexOf('id="detailTitleRow"'), editor.indexOf('id="detailTitleLockNote"'));
    assert.ok(row.indexOf('id="detailCompleteCircle"') < row.indexOf('id="editTaskTitle"'));
    assert.match(read('style.css'), /\.detail-title-row\{display:flex/);
});

test('panel completion reuses the list rules and the 10 s grace timer (no second undo system)', () => {
    assert.match(comp, /app\.handleTaskCompletion\(taskId, afterPanelStatus\)/);
    assert.match(comp, /app\.undoTaskCompletion\(taskId, afterPanelStatus\)/);
    assert.doesNotMatch(comp, /setTimeout\([^)]*10000/);
    assert.match(app, /graceEndsAt: id => pendingGraceCompletions\.get\(id\)\?\.endsAt \?\? null/);
    assert.match(app, /\n\s+isCompletionBlocked,\n/);
});

test('completed task: everything except title, description and the subtask list is locked', () => {
    for (const id of ['editTitleGroup', 'editDescGroup', 'editSubtasksGroup']) assert.match(editor, new RegExp('id="' + id + '"'));
    assert.match(comp, /const keep = new Set\(\['editTitleGroup', 'editDescGroup', 'editSubtasksGroup'\]\)/);
    assert.match(comp, /e\.inert = on/);
    assert.match(editor, /id="detailDoneNote"[^>]*hidden/);
});

test('AI-audited title: read-only with a note, and a save that changes it is refused as a whole', () => {
    assert.match(comp, /editTaskTitle\.readOnly = cannotModifyLocked/);
    assert.match(comp, /The title of an AI-audited task can’t be changed without Emergency Bypass\. Nothing was saved\./);
    const save = comp.slice(comp.indexOf("saveTaskDetailsBtn.addEventListener('click'"));
    assert.ok(save.indexOf('Nothing was saved') < save.indexOf('commitDraft()'), 'refused before anything is committed');
});

test('AI Audit card wraps the proof toggle and the whole criteria box, and closes before Subtasks', () => {
    const card = editor.indexOf('id="editAiAuditCard"'), sub = editor.indexOf('id="editSubtasksGroup"');
    assert.ok(card > 0 && card < editor.indexOf('id="editAiLockCheckbox"'));
    assert.ok(editor.indexOf('id="editCriteriaFeedbackBox"') < sub);
    const between = editor.slice(card, sub);
    const opens = (between.match(/<div\b/g) || []).length, closes = (between.match(/<\/div>/g) || []).length;
    assert.equal(opens, closes, 'the card is closed before the subtasks section');
});

test('rebaseDraft keeps unsaved edits and takes the live status', () => {
    const src = comp.slice(comp.indexOf('        function rebaseDraft() {'), comp.indexOf('        function setCompletedLock('));
    const live = [{ id: 'a', title: 'A', status: 'completed', completed_at: 'x' }, { id: 'b', title: 'B', status: 'completed' }];
    const draft = { originalTasks: JSON.stringify([{ id: 'a', title: 'A', status: 'active' }, { id: 'b', title: 'B', status: 'active' }]),
        tasks: [{ id: 'a', title: 'A edited', status: 'active' }, { id: 'b', title: 'B', status: 'active' }, { id: 'n', title: 'New draft child', status: 'active' }] };
    const ctx = { draft, liveHost: { tasks: { getAll: () => live } }, copy: v => JSON.parse(JSON.stringify(v)) };
    vm.runInNewContext(src + '\nrebaseDraft();', ctx);
    const out = JSON.parse(JSON.stringify(draft.tasks));
    assert.deepEqual(out, [{ id: 'a', title: 'A edited', status: 'completed', completed_at: 'x' }, { id: 'b', title: 'B', status: 'completed' }, { id: 'n', title: 'New draft child', status: 'active' }]);
    assert.equal(draft.originalTasks, JSON.stringify(live));
});

test('subtask rows: priority-coloured circles, name opens the subtask, no View button', () => {
    const src = comp.slice(comp.indexOf('        function refreshDetailSubtaskList('), comp.indexOf('        // Phase 2.5: edit an AI-locked'));
    assert.match(src, /check-circle detail-sub-check/);
    assert.match(src, /sLi\.style\?\.setProperty\?\.\('--pc', color\)/);
    assert.match(src, /detail-sub-open/);
    assert.doesNotMatch(src, />View</);
});

test('closing during an undo window asks first, finalizes, and the next open finishes anything left', () => {
    assert.match(app, /addEventListener\('beforeunload', e => \{\s*if \(!pendingGraceCompletions\.size\) return;/);
    assert.match(app, /addEventListener\('pagehide'/);
    assert.match(app, /loadStorage\(\);\n\s+resumePendingGrace\(\);/);
    assert.match(read('core.js'), /'taskitator_pending_grace'/, 'kept per account like the other local data');
});

test('Dynamic Priority: no shield/AI lock freeze in the editor or the Worker; Pro still required', () => {
    assert.doesNotMatch(comp, /Locked: Dynamic Priority/);
    const pb = read('pro-backend.js');
    assert.doesNotMatch(pb, /fail\(403,'DYNAMIC_PRIORITY_LOCKED'/);
    assert.match(pb, /fail\(403,'PRO_REQUIRED','Dynamic Priority is a Taskitator Pro feature/);
});

test('"Smart Study" is now "Early Appearance" in every user-facing string, with the PRO pill', () => {
    const files = ['index.html', 'legal.html', 'study-plans.js', 'tutorial-integration.js', 'pro/study-plan.js', 'pro/early-bonus.js', 'pro/study-manage.js', 'pro/smart-study.js', 'pro-backend.js'];
    for (const f of files) {
        const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^:'"]\/\/.*$/gm, '');
        assert.doesNotMatch(code, /Smart Study/, f);
    }
    assert.match(read('pro/study-plan.js'), /node\('summary','Early Appearance',p\);node\('span','PRO',s,'pro-feature-pill/);
    const ar = read('locales/ar.js');
    assert.match(ar, /"Early Appearance": "الظهور المبكر"/);
    assert.doesNotMatch(ar, /الدراسة الذكية/);
});

test('Arabic covers the new editor and calendar strings', () => {
    const ar = read('locales/ar.js');
    for (const k of ['Tasks can’t be completed from the calendar. Complete it from Today or General.', 'This task is completed. Only the title and description can be edited. Tap the circle to reopen it.',
        'The title of an AI-audited task can’t be changed without Emergency Bypass.', 'AI Audit', 'Proof required', 'Open subtask'])
        assert.ok(ar.includes(JSON.stringify(k) + ':'), k);
});

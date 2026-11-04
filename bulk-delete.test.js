import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');

test('bulk delete uses the same deletion rule as the row delete button', () => {
    assert.match(app, /const deleteBlockReason = id => TaskitatorSafety\.deletionError\(tasks, id, isBypassActiveSafe\(\)\)/);
    // selecting a blocked task in delete mode is refused with the reason
    assert.match(app, /const blocked = selectionDeleteMode \? deleteBlockReason\(taskId\) : null;\s+if \(blocked\) \{ window\.TaskitatorNotify\(blocked\); return; \}/);
    // select all skips blocked tasks in delete mode
    assert.match(app, /!\(selectionDeleteMode && deleteBlockReason\(t\.id\)\)/);
    // entering delete mode drops already-selected blocked tasks
    assert.match(app, /for \(const id of \[\.\.\.selectedTaskIds\]\) if \(deleteBlockReason\(id\)\) selectedTaskIds\.delete\(id\)/);
});

test('apply asks for confirmation, re-checks each task, and trashes subtrees once', () => {
    const fn = app.match(/async function applyBulkDelete\(\) \{[\s\S]*?\n    \}\n/)[0];
    assert.ok(fn.indexOf('TaskitatorConfirm') < fn.indexOf("target.status = 'trash'"), 'confirm comes before any change');
    assert.match(fn, /tone: 'danger'/);
    assert.match(fn, /if \(deleteBlockReason\(id\)\) \{ skipped\+\+; continue; \}/);
    assert.match(fn, /if \(visited\.has\(id\)\) return;/);
    assert.match(fn, /if \(removed\) saveStorageAndPush\(\)/);
    assert.match(fn, /if \(!ok\) return;/);
});

test('bar has a Delete button, an Apply button, and dims undeletable rows', () => {
    assert.match(html, /id="batchDeleteBtn"/);
    assert.match(html, /id="batchApplyDeleteBtn"[^>]*disabled/);
    assert.match(app, /li\.classList\.add\('batch-undeletable'\)/);
    assert.match(css, /\.task-node\.batch-undeletable > \.task-row \{ opacity: 0\.4/);
    assert.match(css, /\.batch-action-bar\.delete-mode #batchReviewSelectedBtn/);
});

test('leaving selection mode always leaves delete mode', () => {
    assert.match(app, /isSelectionModeActive = !isSelectionModeActive;\s+selectionDeleteMode = false;/);
    assert.match(app, /if \(selectionDeleteMode\) setDeleteMode\(false\); else toggleSelectionMode\(\)/);
});

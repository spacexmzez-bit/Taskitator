import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Phase 3.7.4: a task created from the Today list must appear at once. The save handler used to call only the
// Projects refresh (when it exists, which is always), so the Today list re-rendered only on the next sync event.
const src = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
test('create-task save refreshes both the Projects workspace and the Today list', () => {
    const c = src('components.js'), i = c.indexOf("if (activeCreateDraftId) { window.TaskitatorDrafts?.removeCreate");
    assert.ok(i > 0);
    const tail = c.slice(i, i + 900);
    assert.ok(tail.includes("window.refreshCurrentProjectView()") && tail.includes('host.view.refresh();'));
    assert.ok(!/refreshCurrentProjectView\(\);\s*\}\s*else\s*\{\s*host\.view\.refresh/.test(tail), 'Today refresh must not be an else-branch');
    assert.ok(tail.indexOf('refreshCurrentProjectView') < tail.indexOf('host.view.refresh'), 'project reload first, then render Today from the reloaded list');
});

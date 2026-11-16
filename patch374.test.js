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

// The settings tabs looked "not split" because one stray </div> in the General pane closed the pane early, so the
// cards after it (Copilot, Sounds, Sync, Help) sat outside every tab and showed on all of them.
test('settings.html: every pane is balanced and every card sits inside a pane', () => {
    const h = src('settings.html'), start = h.indexOf('id="authenticatedSettingsContainer"');
    const panes = [...h.matchAll(/<section class="settings-pane"[^>]*>([\s\S]*?)<\/section>/g)];
    assert.equal(panes.length, 6);
    for (const m of panes) {
        const open = (m[1].match(/<div\b/g) || []).length, close = (m[1].match(/<\/div>/g) || []).length;
        assert.equal(open, close, 'unbalanced <div> inside a settings pane: ' + m[0].slice(0, 80));
    }
    const outside = h.slice(start).replace(/<section class="settings-pane"[\s\S]*?<\/section>/g, '');
    assert.ok(!/class="settings-card/.test(outside.slice(0, outside.indexOf('Log out?') > 0 ? outside.indexOf('Log out?') : outside.length)), 'a settings card is outside every pane');
});

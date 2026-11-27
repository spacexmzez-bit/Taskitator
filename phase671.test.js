// Phase 6.7.1: theme picks wait for Save changes, Colour theme is second-last and collapsed, every Settings section folds,
// MacroDroid disclaimer, and the stray radio dot on disabled Phone lock counting modes is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const settings = read('settings.html');

test('theme and Icon mix picks wait for Save changes', () => {
    const ui = read('appearance-ui.js');
    const click = ui.match(/btn\.addEventListener\('click', \(\) => \{\s*if \(locked\)[\s\S]*?\n            \}\);/)[0];
    assert.ok(!/app\.setTheme\(/.test(click), 'clicking a theme no longer applies it');
    assert.match(click, /pending = \{ theme: theme\.id/);
    assert.match(click, /markDirty\(\)/);
    const mixClick = ui.slice(ui.indexOf("btn.addEventListener('click', () => {\n                if (main) return;"), ui.indexOf('const toggles ='));
    assert.ok(!/app\.setMix\(/.test(mixClick), 'ticking a pack no longer applies it');
    assert.match(mixClick, /pending = \{ theme: pending\?\.theme \?\? null, mix: next \}/);
    assert.match(ui, /'taskitator-settings-commit'[\s\S]{0,200}app\.setTheme\(p\.theme\)[\s\S]{0,80}app\.setMix\(p\.mix\)/);
    assert.match(ui, /'taskitator-settings-reset'[\s\S]{0,80}pending = null/);
    // settings.html wires the three events to the existing unsaved bar, Save and Discard/reload.
    assert.match(settings, /addEventListener\('taskitator-settings-dirty', \(\) => markUnsaved\(\)\)/);
    const save = settings.slice(settings.indexOf('async function saveSettings'), settings.indexOf('// ---- Phone lock counting'));
    assert.ok(save.indexOf("'taskitator-settings-commit'") > 0 && save.indexOf("'taskitator-settings-commit'") < save.indexOf('markSaved();'));
    const load = settings.slice(settings.indexOf('function loadSettings()'), settings.indexOf('async function saveSettings'));
    assert.match(load, /'taskitator-settings-reset'/);
    assert.match(settings, /Press Save changes to apply\./);
});

test('General tab order: Colour theme is second-last (before Animations), both collapsed, Danger zone is the only card open by default', () => {
    const general = settings.match(/id="tab-general"[\s\S]*?<\/section>/)[0];
    const titles = [...general.matchAll(/<h4 class="card-title">([^<]*)<\/h4>/g)].map(m => m[1].replace(/&amp;/g, '&'));
    assert.deepEqual(titles.slice(-2), ['Colour theme', 'Animations & effects']);
    assert.match(general, /<details class="settings-card fx-fold" id="appearanceCard">/);
    assert.equal((settings.match(/data-fold-open/g) || []).length, 1);
    assert.match(settings, /<div class="settings-card danger-zone" data-fold-open>/);
});

test('settings-fold.js: every Settings card folds, collapsed unless data-fold-open, re-render safe, reveal API', () => {
    const src = read('settings-fold.js');
    assert.match(src, /CARDS = '\.settings-pane \.settings-card:not\(details\)'/);
    assert.match(src, /hasAttribute\('data-fold-open'\)\) card\.classList\.add\('is-open'\)/);
    assert.match(src, /new MutationObserver\(\(\) => enhance\(card\)\)\.observe\(card, \{ childList: true \}\)/);
    assert.match(src, /type = 'button'/); assert.match(src, /aria-expanded/); assert.match(src, /aria-labelledby/);
    assert.match(src, /window\.TaskitatorFold = Object\.freeze\(\{ reveal,/);
    assert.match(settings, /<script defer src="settings-fold\.js"><\/script>/);
    assert.match(read('style.css'), /\.settings-card\.fold-card:not\(\.is-open\) > :not\(\.fold-head\) \{ display: none !important; \}/);
    assert.match(read('sw.js'), /\.\/settings-fold\.js/);
    assert.match(read('tutorial-spotlight.js'), /window\.TaskitatorFold\?\.reveal\(n\)/);
});

test('MacroDroid disclaimer in Settings > Phone lock (outside any folded card) and in the help guide', () => {
    const phone = settings.match(/id="tab-phone"[\s\S]*?<\/section>/)[0];
    const note = phone.match(/<p class="setting-hint macrodroid-note"[^>]*>([^<]*)<\/p>/)[1];
    assert.match(note, /not affiliated with, endorsed by or sponsored by MacroDroid/);
    assert.match(note, /subject to its own limits and terms/);
    assert.ok(phone.indexOf('macrodroid-note') < phone.indexOf('id="macrodroidCard"'));
    assert.match(read('index.html'), /Taskitator is not affiliated with MacroDroid, and using MacroDroid is still subject to its own limits and terms\./);
});

test('Phone lock counting: a disabled mode no longer shows its radio dot', () => {
    const css = read('style.css');
    assert.match(css, /\.settings-page \.status-mode-opt input:disabled\{opacity:0\}/);
    assert.match(css, /\.status-mode-opt input\{position:absolute;opacity:0;pointer-events:none;width:0;height:0;margin:0\}/);
    // The rule it has to beat: disabled settings controls are 50% opaque.
    assert.match(css, /\.settings-page :is\(button, input, select\):disabled \{ opacity: 0\.5;/);
});

test('Arabic strings and cache for 6.7.1', () => {
    const ctx = { window: {}, module: { exports: {} } };
    vm.runInNewContext(read('locales/ar.js'), ctx);
    const ar = ctx.module.exports;
    assert.ok(ar['Press Save changes to apply. Saved on this device only; your other devices keep their own choice.']);
    assert.ok(ar['Taskitator is not affiliated with, endorsed by or sponsored by MacroDroid. Using MacroDroid is still subject to its own limits and terms.']);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v75'/);
    assert.match(read('README.md'), /Phase 6\.7\.1/);
});

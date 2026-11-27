// Phase 6.9: steps-based Help, "Try it live" guides (tour engine live steps) and the index jump highlight.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const index = read('index.html');
const help = index.slice(index.indexOf('<div class="hp" translate="no"'), index.indexOf('</section>', index.indexOf('<div class="hp-nav">')));

test('Help: seven units with an index, steps-based sections and no stale statements', () => {
    const units = [...help.matchAll(/<div class="hp-unit" id="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(units, ['help-start', 'help-tasks', 'help-focus', 'help-ai-unit', 'help-pro', 'help-universe', 'help-account']);
    assert.match(help, /<nav class="hp-index" id="help-index"/);
    const secs = [...help.matchAll(/<section class="hp-sec" id="([^"]+)"/g)].map(m => m[1]);
    assert.ok(secs.length >= 60, 'sections: ' + secs.length);
    assert.ok((help.match(/<ol>/g) || []).length >= 25, 'numbered steps');
    for (const stale of [/gr[ae]y = this device only/i, /limit is 6/, /cost double/i, /Known gaps/, /Worker bridge/, /checked-in Worker/]) assert.doesNotMatch(help, stale);
    // Sections Help never had before
    for (const id of ['help-sleep', 'help-timer', 'help-p-lab', 'help-p-pull', 'help-early', 'help-criteria-edit', 'help-loading', 'help-remove']) assert.ok(secs.includes(id), id);
});

test('Help: every index link resolves, and old section ids still work', () => {
    const ids = new Set([...help.matchAll(/ id="(help-[^"]+)"/g)].map(m => m[1]));
    for (const [, href] of help.matchAll(/href="#(help-[^"]+)"/g)) assert.ok(ids.has(href), href);
    for (const old of ['help-free', 'help-pro', 'help-today', 'help-create', 'help-drafts', 'help-subtasks', 'help-multi', 'help-filter',
        'help-overdue', 'help-projects', 'help-repeat', 'help-calendar', 'help-breaks', 'help-emergency', 'help-scratch', 'help-proof',
        'help-ai', 'help-copilot', 'help-phone', 'help-data', 'help-p-ai', 'help-p-credits', 'help-p-batch', 'help-p-num', 'help-p-dyn',
        'help-p-study', 'help-p-uni', 'help-p-test', 'help-p-themes', 'help-p-get']) assert.ok(ids.has(old), old);
    assert.match(help, /Taskitator is not affiliated with MacroDroid, and using MacroDroid is still subject to its own limits and terms\./);
    assert.ok((help.match(/class="hp-ex"/g) || []).length >= 20, 'earlier examples kept');
});

test('Help: every Try it live button names a guide that exists', () => {
    const src = read('help-tours.js'), tours = read('tutorial-integration.js');
    const live = new Set([...src.slice(src.indexOf('const LIVE = {'), src.indexOf('// Older guided tours')).matchAll(/^    ([a-z]+): \{/gm)].map(m => m[1]));
    const guided = new Set([...tours.slice(tours.indexOf('const TOURS = {'), tours.indexOf('const ORDER')).matchAll(/^    ([a-z]+): \{/gm)].map(m => m[1]));
    assert.equal(live.size, 14);
    assert.ok(guided.has('themes'));
    const keys = [...help.matchAll(/data-help-tour="([a-z]+)" data-help-from="([^"]+)"/g)];
    assert.ok(keys.length >= 20);
    for (const [, key, from] of keys) {
        assert.ok(live.has(key) || guided.has(key), key);
        assert.match(help, new RegExp('<section class="hp-sec" id="' + from + '">'), from);
    }
});

test('Engine v3: live steps let the highlighted part through and block the rest', () => {
    const js = read('tutorial-spotlight.js'), css = read('tutorial-spotlight.css');
    assert.match(js, /const blocks = \[0, 1, 2, 3\]\.map/);
    assert.match(js, /\[0, 0, vw, T\], \[0, B, vw, vh - B\], \[0, T, L, B - T\], \[R, T, vw - R, B - T\]/);
    assert.match(js, /if \(step\.live\) poll = setInterval\(tick, 250\)/);
    assert.match(js, /step\?\.until && safe\(step\.until, false\)/);
    assert.match(js, /index = Math\.max\(0, index - step\.lost\)/);
    assert.match(js, /document\.querySelectorAll\('dialog\[open\], \.modal-overlay\.open'\)/);
    assert.match(js, /step\.dock === 'top' \? EDGE/);
    assert.match(js, /typeof s === 'function' \? s\(\) : document\.querySelector\(s\)/);
    assert.match(js, /if \(isLive\(\) && !card\.contains\(e\.target\)\) \{/);
    assert.match(js, /window\.TaskitatorFold\?\.reveal\(n\)/);
    assert.match(css, /\.tt-veil\.tt-live\{pointer-events:none\}/);
    assert.match(css, /\.tt-veil\.tt-live \.tt-block\{display:block;pointer-events:auto\}/);
    assert.match(css, /\.tt-veil\.tt-paused\{visibility:hidden\}/);
});

function harness() {
    const nodes = {}, listeners = {}, calls = [];
    const classList = () => { const set = new Set(); return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), has: set }; };
    const make = (id, inHelp = true) => (nodes[id] = { id, classList: classList(), offsetWidth: 1, closest: s => (s === '.hp' && inHelp ? {} : null), parentElement: null, scrollIntoView() { calls.push('scroll:' + id); } });
    const document = {
        getElementById: id => nodes[id] || null,
        addEventListener: (t, f) => { (listeners['d:' + t] ||= []).push(f); },
        querySelector: () => null, querySelectorAll: () => []
    };
    const window = {
        addEventListener: (t, f) => { (listeners['w:' + t] ||= []).push(f); },
        TaskitatorSpotlight: { isActive: () => false, start: o => { calls.push('start:' + o.steps.length); return true; } },
        TaskitatorTutorials: { launch: k => calls.push('launch:' + k), start: k => { calls.push('tour:' + k); return true; } },
        TaskitatorShell: { current: () => 'tasks' }
    };
    const location = { hash: '#help' };
    const ctx = { window, document, location, setTimeout, clearTimeout, requestAnimationFrame: f => f(), getComputedStyle: () => ({ visibility: 'visible' }), decodeURIComponent };
    vm.runInNewContext(read('help-tours.js'), ctx);
    return { nodes, listeners, calls, make, window, location };
}

test('Index jump: the section flashes, also for a repeated click on the same link and for alias anchors', () => {
    const h = harness();
    const sec = h.make('help-create');
    h.location.hash = '#help-create';
    h.listeners['w:hashchange'][0]();
    assert.ok(sec.classList.contains('hp-flash'));
    sec.classList.remove('hp-flash');
    let prevented = false;
    const link = { getAttribute: () => '#help-create' };
    h.listeners['d:click'][0]({ target: { closest: s => (s.includes('a[href^="#help-"]') ? link : null) }, preventDefault() { prevented = true; } });
    assert.ok(prevented && sec.classList.contains('hp-flash') && h.calls.includes('scroll:help-create'));
    const unit = h.make('help-tasks'); const alias = h.make('help-free'); alias.classList.add('hp-alias'); alias.parentElement = unit;
    h.window.TaskitatorHelpTours.flash('help-free');
    assert.ok(unit.classList.contains('hp-flash'));
    const outside = h.make('help-x', false);
    h.window.TaskitatorHelpTours.flash('help-x');
    assert.equal(outside.classList.contains('hp-flash'), false, 'only Help sections flash');
});

test('Try it live: live guides start on Today; Settings tours go through TaskitatorTutorials', async () => {
    const h = harness();
    await h.window.TaskitatorHelpTours.run('create', 'help-create');
    assert.equal(h.location.hash, '#today');
    assert.ok(h.calls.some(c => /^start:\d+$/.test(c)));
    await h.window.TaskitatorHelpTours.run('themes', 'help-p-themes');
    assert.ok(h.calls.includes('launch:themes'));
    await h.window.TaskitatorHelpTours.run('account', 'help-main');
    assert.ok(h.calls.includes('tour:account'));
});

test('Settings tours from Help, themes tour, legend, loading and cache', () => {
    const t = read('tutorial-integration.js');
    assert.match(t, /const ORDER = \['account', 'breaks', 'ai', 'phone', 'pro', 'themes'\]/);
    assert.match(t, /t\.page === 'settings' && !onSettings\(\)/);
    assert.match(t, /TOURS\[next\.key\]\?\.page === 'settings'/);
    assert.doesNotMatch(t, /This device only/);
    assert.match(index, /src="tutorial-integration\.js\?v=tour-v3"><\/script>\n<script type="text\/taskitator-script" src="help-tours\.js\?v=help-v1"><\/script>/);
    assert.match(read('sw.js'), /'\.\/help-tours\.js'/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v78'/);
    assert.match(read('ai-notice.js'), /addEventListener\('DOMContentLoaded', \(\) => refresh\(\)\)/);
    const ar = read('locales/ar.js');
    for (const k of ['Do it for me', 'Use the highlighted part to continue.', 'Shrink the guide card', 'Colour themes', 'Sync failed']) assert.ok(ar.includes('"' + k + '"'), k);
    assert.match(read('README.md'), /Steps-based Help with live guides \(Phase 6\.9\)/);
});

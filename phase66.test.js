// Phase 6.6: motion modes (Static / Reduced / Normal / Custom), tap bubble + icon wipe, one collapsed Animations card,
// and the AI disclaimer on every AI surface (Universe included).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('./', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const SWITCHES = ['particles', 'clouds', 'animals', 'bird', 'parallax', 'bubbles', 'wipe'];

function boot({ stored, lowEnd = false, osReduce = false } = {}) {
    const store = new Map();
    if (stored !== undefined) store.set('taskitator_appearance', JSON.stringify(stored));
    const listeners = {};
    const html = { dataset: {}, style: { setProperty() {} } };
    const window = {
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
        dispatchEvent: e => { (listeners[e.type] || []).forEach(f => f(e)); return true; },
        matchMedia: q => ({ matches: osReduce && /reduce/.test(q) }),
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o?.detail; } }
    };
    const ctx = {
        window, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
        navigator: { deviceMemory: lowEnd ? 1 : 8 },
        document: { documentElement: html, head: { appendChild() {} }, body: { classList: { contains: () => false } }, querySelector: () => null, createElement: () => ({}), addEventListener() {} },
        setTimeout: () => 1, clearTimeout() {}, JSON, Number, Math, Array, Object, Set, String, Boolean, Date, MutationObserver: undefined
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(read('registry.js'), ctx);
    window.TaskitatorThemes = ctx.window.TaskitatorThemes || ctx.TaskitatorThemes;
    vm.runInNewContext(read('theme-boot.js'), ctx);
    return { A: window.TaskitatorAppearance, html };
}

test('defaults: ordinary devices start in Normal, low-memory and OS reduce-motion devices in Reduced', () => {
    assert.equal(boot().A.read().anim.mode, 'normal');
    assert.equal(boot({ lowEnd: true }).A.read().anim.mode, 'reduced');
    assert.equal(boot({ osReduce: true }).A.read().anim.mode, 'reduced');
    assert.equal(boot({ lowEnd: true }).html.dataset.motion, 'reduced');
    assert.equal(boot().html.dataset.motion, undefined);
});

test('a device that already chose a mode keeps it, even when low-memory', () => {
    const { A } = boot({ lowEnd: true, stored: { v: 1, theme: 'savannah', effective: 'savannah', anim: { mode: 'normal' } } });
    assert.equal(A.read().anim.mode, 'normal');
});

test('old data migrates: reduce:true is Static, switches off is Custom', () => {
    assert.equal(boot({ stored: { v: 1, anim: { reduce: true } } }).A.read().anim.mode, 'static');
    const c = boot({ stored: { v: 1, anim: { clouds: false } } }).A.read().anim;
    assert.equal(c.mode, 'custom'); assert.equal(c.clouds, false);
});

test('switching one effect off moves Normal to Custom; all on returns to Normal; Custom restores the last set', () => {
    const { A, html } = boot();
    assert.equal(A.setAnim('clouds', false), true);
    let s = A.read().anim;
    assert.equal(s.mode, 'custom'); assert.equal(s.clouds, false); assert.equal(s.particles, true);
    A.setMode('static'); assert.equal(html.dataset.motion, 'static');
    A.setMode('custom');
    s = A.read().anim; assert.equal(s.clouds, false);
    assert.equal(A.effective().clouds, false); assert.equal(A.effective().bird, true);
    A.setAnim('clouds', true);
    assert.equal(A.read().anim.mode, 'normal');
    assert.equal(A.setAnim('nope', true), false);
    assert.equal(A.setMode('weird'), false);
});

test('Static and Reduced lock the decorative effects; essential ones are not blocked by level', () => {
    const { A } = boot();
    A.setMode('reduced');
    assert.equal(A.motionLevel(), 'reduced');
    for (const k of ['particles', 'clouds', 'bird', 'parallax', 'bubbles', 'wipe']) assert.equal(A.motionAllowed(k), false, k);
    A.setMode('static');
    assert.equal(A.motionLevel(), 'static');
    assert.equal(A.motionAllowed(), false);
    A.setMode('normal');
    assert.equal(A.motionLevel(), 'normal');
    for (const k of SWITCHES) assert.equal(A.motionAllowed(k), true, k);
});

test('OS reduce-motion counts as at least Reduced', () => {
    const { A } = boot({ osReduce: true, stored: { v: 1, anim: { mode: 'normal' } } });
    assert.equal(A.motionLevel(), 'reduced');
    assert.equal(A.motionAllowed('bubbles'), false);
});

test('Settings: one collapsed Animations card, last in General, holds the 4 mode boxes and every switch', () => {
    const html = read('settings.html');
    const card = html.match(/<details class="settings-card fx-fold" id="appearanceCard">[\s\S]*?<\/details>/)?.[0];
    assert.ok(card, 'details card exists');
    assert.ok(!/\sopen[\s>]/.test(card.match(/<details[^>]*>/)[0]), 'hidden (collapsed) by default');
    assert.deepEqual([...card.matchAll(/data-mode="(\w+)"/g)].map(m => m[1]), ['static', 'reduced', 'normal', 'custom']);
    assert.deepEqual([...card.matchAll(/data-fx="(\w+)"/g)].map(m => m[1]).sort(), [...SWITCHES].sort());
    assert.equal((html.match(/data-fx="/g) || []).length, SWITCHES.length, 'no effect switch outside the card');
    assert.match(card, /Animations can make Taskitator feel slower/);
    const general = html.match(/id="tab-general"[\s\S]*?<\/section>/)[0];
    const lastCard = [...general.matchAll(/<(?:details|div) class="settings-card[^"]*"/g)].pop()[0];
    assert.match(lastCard, /fx-fold/, 'Animations is the last card of General');
});

test('motion.js: bubble and wipe respect the switches; script is loaded and precached', () => {
    const src = read('motion.js');
    assert.match(src, /ok\('wipe'\)/); assert.match(src, /ok\('bubbles'\)/);
    assert.match(src, /TaskitatorMotion = Object\.freeze\(\{ wipe, bubble \}\)/);
    for (const page of ['index.html', 'settings.html', 'components.html', 'legal.html', 'login.html']) assert.match(read(page), /src="motion\.js"/, page);
    const sw = read('sw.js');
    assert.match(sw, /\.\/motion\.js/); assert.match(sw, /\.\/ai-notice\.js/);
    assert.match(sw, /CACHE_NAME = 'taskitator-phase4-v69'/);
});

test('AI notice: provider company, Universe = Google, hosted = Anthropic, generic fallback', () => {
    const els = [];
    const mk = () => ({ dataset: {}, className: '', textContent: '' });
    const window = { addEventListener() {}, TaskitatorVault: { hosted: false, available: true, provider: 'gemini' } };
    const document = { createElement: mk, addEventListener() {}, querySelectorAll: () => els, body: null };
    vm.runInNewContext(read('ai-notice.js'), { window, document, requestAnimationFrame: f => f(), MutationObserver: undefined });
    const N = window.TaskitatorAiNotice;
    assert.match(N.node('user').textContent, /handled by Google, a third-party company\. AI can make mistakes/);
    window.TaskitatorVault.provider = 'claude';
    assert.match(N.node('user').textContent, /by Anthropic/);
    window.TaskitatorVault = { hosted: true, available: true, provider: 'gemini' };
    assert.match(N.node('user').textContent, /by Anthropic/);
    assert.match(N.node('universe').textContent, /by Google/);
    window.TaskitatorVault = undefined;
    assert.equal(N.node('user').textContent, 'AI services are handled by a third party. AI can make mistakes, so check answers and results.');
});

test('AI notice is on every AI surface, Universe included', () => {
    assert.ok((read('index.html').match(/data-ai-notice/g) || []).length >= 5, 'index static notices');
    assert.ok(/data-ai-notice/.test(read('settings.html')));
    for (const f of ['study-plans.js', 'test-lab.js', 'uni/universe-tasks-ui.js', 'uni/universe-ui.js']) assert.match(read(f), /aiNote\(/, f);
    assert.match(read('pro/study-plan.js'), /TaskitatorAiNotice/);
    assert.equal((read('uni/universe-tasks-ui.js').match(/aiNote\('universe'\)/g) || []).length, 2, 'Auditing box + Universe AI review');
    assert.match(read('uni/universe-ui.js'), /standards\.append\(aiNote\('universe'\)\)/);
    for (const page of ['index.html', 'settings.html', 'components.html']) assert.match(read(page), /src="ai-notice\.js"/, page);
});

test('Arabic: the new strings are translated and the company is bidi-isolated', () => {
    const ctx = { window: {}, module: { exports: {} } };
    vm.runInNewContext(read('locales/ar.js'), ctx);
    const ar = ctx.module.exports;
    const key = 'AI services are handled by {0}, a third-party company. AI can make mistakes, so check answers and results.';
    assert.match(ar[key], /شركة ⁨\{0\}⁩ الخارجية/);
    assert.match(ar['AI services are handled by a third party. AI can make mistakes, so check answers and results.'], /طرف ثالث/);
    for (const k of ['Animations & effects', 'Static', 'Reduced', 'Custom', 'Tap bubbles', 'Icon wipe', 'Nothing moves.']) assert.ok(ar[k], k);
});

// Phase 6.7: five themes (Savannah free default; Desert, Jungle, Marina, Fictional Pro), one animal pack per theme,
// footprint archetypes, and Icon mix (Pro): extra packs on top of the theme's own, weighted so the theme leads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const IDS = ['savannah', 'desert', 'jungle', 'marina', 'fictional'];

function registry() {
    const ctx = {}; ctx.globalThis = ctx;
    vm.runInNewContext(read('registry.js'), ctx);
    return ctx.TaskitatorThemes;
}
function boot({ stored, tier } = {}) {
    const store = new Map();
    if (stored) store.set('taskitator_appearance', JSON.stringify(stored));
    if (tier) store.set('taskitator_tier_v1', JSON.stringify(tier));
    const listeners = {}, html = { dataset: {}, style: { setProperty() {} } };
    const window = {
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
        dispatchEvent: e => { (listeners[e.type] || []).forEach(f => f(e)); return true; },
        matchMedia: () => ({ matches: false }), TaskitatorToast: { show() {} },
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o?.detail; } }
    };
    const ctx = { window, localStorage: window.localStorage, CustomEvent: window.CustomEvent, navigator: { deviceMemory: 8 },
        document: { documentElement: html, head: { appendChild() {} }, body: { classList: { contains: () => false } }, querySelector: () => null, createElement: () => ({}), addEventListener() {} },
        setTimeout: () => 1, clearTimeout() {}, JSON, Number, Math, Array, Object, Set, String, Boolean, Date, MutationObserver: undefined };
    ctx.globalThis = ctx;
    vm.runInNewContext(read('registry.js'), ctx);
    window.TaskitatorThemes = ctx.window.TaskitatorThemes || ctx.TaskitatorThemes;
    vm.runInNewContext(read('theme-boot.js'), ctx);
    const status = detail => window.dispatchEvent(new window.CustomEvent('taskitator-pro-status', { detail }));
    return { A: window.TaskitatorAppearance, html, status, window };
}
const PRO = { isPro: true, status: 'active', expires_at: null, themes: { allowed: IDS, catalog_version: 2 } };
function icons(packs, theme = 'savannah') {
    const html = { dataset: { theme, family: 'nature' }, getAttribute: () => null, classList: { add() {} } };
    const window = { addEventListener() {}, TaskitatorAppearance: packs ? { packs: () => packs } : undefined };
    const document = { documentElement: html, addEventListener() {}, querySelectorAll: () => [], createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
    vm.runInNewContext(read('icons.js'), { window, document, fetch: () => Promise.reject(new Error('offline')), setTimeout: () => 0, Promise, Math, String, Number, Object, Array, Set, Boolean });
    return window.TaskitatorIcons;
}

test('registry: five live themes, Savannah is the only free one and the default; Blue/Green are gone', () => {
    const R = registry();
    assert.deepEqual([...R.live().map(t => t.id)], IDS);
    assert.equal(R.DEFAULT_THEME, 'savannah');
    assert.deepEqual([...R.themesAllowed('free')], ['savannah']);
    assert.deepEqual([...R.themesAllowed('pro')], IDS);
    assert.equal(R.byId('blue'), null); assert.equal(R.byId('green'), null);
    assert.equal(R.validTheme('green'), 'savannah', 'no migration: an old id falls back to the default');
    for (const t of R.THEMES) assert.match(read('palettes.css'), new RegExp(`html\\[data-palette="${t.id}"\\]`));
    assert.ok(!/data-palette="(blue|green)"/.test(read('palettes.css')));
});

test('a Worker still on the old catalog cannot lock Pro users out of the new themes', () => {
    const R = registry();
    const old = { isPro: true, status: 'active', expires_at: null, themes: { allowed: ['blue', 'green'], catalog_version: 1 } };
    assert.deepEqual([...R.allowedFromStatus(old)], IDS);
    assert.deepEqual([...R.allowedFromStatus({ ...old, isPro: false, status: 'inactive' })], ['savannah']);
});

test('sprite: 45 new animals, no animal from the old pack, 12 footprint archetypes', () => {
    const sprite = read('image/nature_sprites/sprite.svg');
    const I = icons();
    assert.equal(I.ANIMALS.length, 45);
    for (const a of I.ANIMALS) assert.match(sprite, new RegExp(`<symbol id="nt-a-${a}" viewBox="[^"]+"><path fill-rule="evenodd" d="M`), a);
    for (const old of ['wolf', 'bear', 'eagle', 'deer', 'owl', 'roo', 'croc']) assert.ok(!sprite.includes(`id="nt-a-${old}"`), old + ' removed');
    assert.equal((sprite.match(/<symbol id="nt-a-/g) || []).length, 45);
    assert.equal((sprite.match(/<symbol id="nt-f-/g) || []).length, 12);
    for (const p of I.PRINTS) assert.ok(sprite.includes(`id="nt-f-${p}"`), p);
    assert.deepEqual(Object.keys(I.PACKS), IDS);
    for (const id of IDS) assert.equal(I.PACKS[id].length, 9, id);
});

test('weights: the theme pack always leads; splits match the table', () => {
    const I = icons();
    assert.deepEqual(JSON.parse(JSON.stringify(I.WEIGHTS)), { 1: [100], 2: [60, 40], 3: [40, 30, 30], 4: [34, 22, 22, 22], 5: [28, 18, 18, 18, 18] });
    for (const w of Object.values(I.WEIGHTS)) { assert.equal(w.reduce((a, b) => a + b, 0), 100); assert.ok(w.slice(1).every(x => x < w[0])); }
});

test('animalForId: stable per task, theme pack only without a mix, distribution follows the weights', () => {
    const solo = icons(['marina'], 'marina');
    assert.equal(solo.animalForId('t1'), solo.animalForId('t1'));
    for (let i = 0; i < 200; i++) assert.ok(solo.PACKS.marina.includes(solo.animalForId('task-' + i)));
    const mix = icons(['jungle', 'marina']);
    const counts = { jungle: 0, marina: 0 };
    for (let i = 0; i < 4000; i++) { const a = mix.animalForId('id-' + i); counts[mix.PACKS.jungle.includes(a) ? 'jungle' : 'marina']++; }
    assert.ok(counts.jungle > counts.marina, 'main pack leads');
    assert.ok(Math.abs(counts.jungle / 4000 - 0.6) < 0.04, 'about 60/40: ' + JSON.stringify(counts));
    const all = icons(IDS);
    const seen = new Set(); for (let i = 0; i < 2000; i++) seen.add(all.animalForId('x' + i));
    assert.ok(seen.size > 40, 'every pack shows up with five packs');
    assert.equal(icons().animalForId('t1'), icons(['savannah']).animalForId('t1'), 'falls back to the theme pack');
});

test('Icon mix store: Pro only, theme pack is always first and never an extra, lapse keeps the preference', () => {
    const free = boot();
    assert.equal(free.A.mixAllowed(), false);
    assert.equal(free.A.setMix(['jungle']), false);
    assert.deepEqual([...free.A.packs()], ['savannah']);

    const b = boot();
    b.status(PRO);
    assert.equal(b.A.setTheme('marina'), true);
    assert.equal(b.A.setMix(['jungle', 'desert']), true);
    assert.deepEqual([...b.A.packs()], ['marina', 'jungle', 'desert']);
    assert.equal(b.A.setMix(['nope']), false);
    b.A.setTheme('jungle');
    assert.deepEqual([...b.A.packs()], ['jungle', 'desert'], 'the new theme pack is not counted twice');
    b.A.setTheme('marina');
    assert.deepEqual([...b.A.packs()], ['marina', 'jungle', 'desert'], 'switching back restores it');
    b.status({ isPro: false, status: 'inactive' });
    assert.deepEqual([...b.A.packs()], ['savannah'], 'lapse: theme falls back and extras are ignored');
    assert.deepEqual([...b.A.read().mix], ['jungle', 'desert'], 'preference kept for renewal');
    b.status(PRO);
    assert.deepEqual([...b.A.packs()], ['marina', 'jungle', 'desert']);
    assert.deepEqual([...b.A.normalize({ mix: ['jungle', 'blue', 7, 'jungle'] }).mix], ['jungle']);
});

test('renderers use taskAnimal (seeded) and redraw on theme or mix change; stamp uses archetypes', () => {
    const src = read('icons.js');
    assert.match(read('app.js'), /TaskitatorIcons\.taskAnimal\(task\.id\)/);
    assert.match(read('components.js'), /TaskitatorIcons\.taskAnimal\(task\.id\)/);
    assert.match(src, /addEventListener\('taskitator-appearance', \(\) => redrawAnimals\(\)\)/);
    assert.match(src, /const kind = PRINT_OF\[name\]/);
});

test('Settings: Icon mix sits in the Colour theme card; help and README describe it', () => {
    const html = read('settings.html');
    const card = html.match(/id="themeCard">[\s\S]*?<\/div>\s*<\/div>/)[0];
    assert.match(card, /id="iconMix"/); assert.match(card, /id="iconMixOptions" role="group"/);
    const ui = read('appearance-ui.js');
    assert.match(ui, /role', 'checkbox'/);
    assert.match(ui, /if \(main\) return;/, 'the theme pack cannot be unticked');
    assert.match(ui, /Icon mix is a Pro feature\. /);
    assert.match(read('index.html'), /id="help-p-themes"/);
    assert.match(read('README.md'), /Five themes and Icon mix \(Phase 6\.7\)/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v69'/);
});

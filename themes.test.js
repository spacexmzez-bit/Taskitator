// Nature redesign: theme registry, appearance storage, lapse rules, sprite integrity,
// service worker coverage, Universe protection and the chrome emoji lint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('./', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');

function loadRegistry() {
    const ctx = { globalThis: {} };
    ctx.globalThis = ctx;
    vm.runInNewContext(read('registry.js'), ctx);
    return ctx.TaskitatorThemes;
}

// Minimal browser for theme-boot.js.
function boot({ stored, tier, now = Date.now(), lowEnd = false } = {}) {
    const store = new Map();
    if (stored !== undefined) store.set('taskitator_appearance', typeof stored === 'string' ? stored : JSON.stringify(stored));
    if (tier) store.set('taskitator_tier_v1', JSON.stringify(tier));
    const listeners = {}, docListeners = {};
    const meta = { name: 'theme-color', content: '' };
    const style = new Map();
    const html = { dataset: {}, style: { setProperty: (k, v) => style.set(k, v) } };
    const toasts = [];
    const window = {
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
        dispatchEvent: e => { (listeners[e.type] || []).forEach(f => f(e)); return true; },
        matchMedia: () => ({ matches: false }),
        TaskitatorToast: { show: m => toasts.push(m) },
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o?.detail; } }
    };
    const timers = [];
    const ctx = {
        window, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
        navigator: lowEnd ? { deviceMemory: 1 } : { deviceMemory: 8 },
        document: {
            documentElement: html, head: { appendChild() {} }, body: { classList: { contains: () => false } },
            querySelector: s => (s === 'meta[name="theme-color"]' ? meta : null),
            createElement: () => ({}), addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); }
        },
        Date: class extends Date { static now() { return now; } },
        setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
        JSON, Number, Math, Array, Object, Set, String, Boolean, MutationObserver: undefined
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(read('registry.js'), ctx);
    window.TaskitatorThemes = ctx.window.TaskitatorThemes || ctx.TaskitatorThemes;
    vm.runInNewContext(read('theme-boot.js'), ctx);
    const status = detail => window.dispatchEvent(new window.CustomEvent('taskitator-pro-status', { detail }));
    const saved = () => JSON.parse(store.get('taskitator_appearance') || 'null');
    return { A: window.TaskitatorAppearance, html, meta, toasts, timers, status, saved, store };
}

test('registry schema: unique ids, valid tiers/status, families and sprite exist, blue is free default', () => {
    const R = loadRegistry();
    const ids = R.THEMES.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of R.THEMES) {
        assert.ok(['free', 'pro'].includes(t.tier), t.id);
        assert.ok(['live', 'hidden'].includes(t.status), t.id);
        assert.ok(R.FAMILIES[t.family], t.id + ' family');
        assert.ok(fs.existsSync(new URL(R.FAMILIES[t.family].sprite, root)), 'sprite file for ' + t.family);
        assert.match(t.metaThemeColor, /^#[0-9a-f]{6}$/i);
        assert.match(read('palettes.css'), new RegExp(`html\\[data-palette="${t.palette}"\\]`), 'palette block for ' + t.id);
    }
    assert.equal(R.DEFAULT_THEME, 'blue');
    assert.equal(R.byId('blue').tier, 'free');
    assert.equal(R.byId('green').tier, 'pro');
});

test('themesAllowed: free, pro, max, expired and unknown plans', () => {
    const R = loadRegistry();
    assert.deepEqual([...R.themesAllowed('free')], ['blue']);
    assert.deepEqual([...R.themesAllowed('pro')], ['blue', 'green']);
    assert.deepEqual([...R.themesAllowed('max')], ['blue', 'green']);
    assert.deepEqual([...R.themesAllowed('expired')], ['blue']);
    assert.deepEqual([...R.themesAllowed(undefined)], ['blue']);
    assert.deepEqual([...R.themesAllowed('unknown')], ['blue']);
    const now = 1_000_000;
    assert.deepEqual([...R.allowedFromStatus({ isPro: true, status: 'active', expires_at: now - 1 }, now)], ['blue'], 'expired Pro');
    assert.deepEqual([...R.allowedFromStatus({ isPro: true, status: 'active', expires_at: null }, now)], ['blue', 'green']);
    // A list claiming a Pro theme cannot unlock it for an inactive plan.
    assert.deepEqual([...R.allowedFromStatus({ isPro: false, status: 'inactive', themes: { allowed: ['blue', 'green'] } }, now)], ['blue']);
    assert.equal(R.validTheme('nope'), 'blue');
    assert.equal(R.validTheme(42), 'blue');
});

test('offline status computes the same theme block as the Worker', () => {
    const core = read('core.js');
    assert.match(core, /themes: themes\('free'\)/);
    assert.match(core, /themes: themes\('pro'\)/);
    const R = loadRegistry();
    assert.deepEqual(JSON.parse(JSON.stringify(R.statusFor('free'))), { allowed: ['blue'], default: 'blue', catalog_version: 1 });
});

test('appearance storage validates, migrates and falls back to blue', () => {
    const { A, html, meta } = boot({ stored: '{not json' });
    assert.equal(A.read().theme, 'blue');
    assert.equal(html.dataset.palette, 'blue');
    assert.equal(html.dataset.family, 'nature');
    assert.equal(meta.content, '#0a1119');
    const n = A.normalize({ theme: 'purple', effective: 9, anim: { bird: 'yes', clouds: false }, bird_speed: 99, extra: 1 });
    assert.equal(n.theme, 'blue'); assert.equal(n.effective, 'blue');
    assert.equal(n.anim.clouds, false); assert.equal(typeof n.anim.bird, 'boolean');
    assert.equal(n.bird_speed, 7); assert.equal(A.normalize({ bird_speed: 2 }).bird_speed, 7); assert.equal(A.setBirdSpeed, undefined); assert.equal(n.extra, undefined); assert.equal(n.v, 1);
});

test('low-memory devices start with motion effects off; animals stay on', () => {
    const { A, html } = boot({ lowEnd: true });
    const a = A.read().anim;
    assert.equal(a.particles, false); assert.equal(a.clouds, false); assert.equal(a.bird, false); assert.equal(a.parallax, false);
    assert.equal(a.animals, true);
    assert.match(html.dataset.fxOff, /clouds/);
});

test('appearance key is per device: never in sync, snapshots, account archives or cleanSettings', () => {
    const core = read('core.js');
    const accountKeys = core.match(/ACCOUNT_KEYS: \[([\s\S]*?)\]/)[1];
    assert.ok(!accountKeys.includes('taskitator_appearance'));
    assert.ok(!core.match(/const SNAPSHOT_KEYS = \[([^\]]*)\]/)[1].includes('appearance'));
    assert.ok(!/appearance/.test(core.match(/function cleanSettings[\s\S]*?\n    }\n/)?.[0] || ''));
    // "Clear this browser" wipes localStorage, which resets the theme to Blue.
    assert.match(read('settings.html'), /localStorage\.clear\(\);/);
});

test('free users cannot select a Pro theme; Pro users can', () => {
    const free = boot();
    assert.equal(free.A.setTheme('green'), false);
    assert.equal(free.A.read().theme, 'blue');
    const pro = boot();
    pro.status({ isPro: true, status: 'active', expires_at: null, themes: { allowed: ['blue', 'green'] } });
    assert.equal(pro.A.setTheme('green'), true);
    assert.equal(pro.html.dataset.palette, 'green');
    assert.equal(pro.meta.content, '#0f1410');
});

test('lapse: preference kept, effective reverts once with a toast, renewal restores it', () => {
    const b = boot({ stored: { v: 1, theme: 'green', effective: 'green' } });
    assert.equal(b.html.dataset.palette, 'green', 'boot applies the stored effective theme (no flash)');
    b.status({ isPro: false, status: 'expired' });
    assert.equal(b.saved().theme, 'green');
    assert.equal(b.saved().effective, 'blue');
    assert.equal(b.html.dataset.palette, 'blue');
    assert.deepEqual(b.toasts, ['Pro ended, theme set to Blue.']);
    b.status({ isPro: false, status: 'expired' });
    assert.equal(b.toasts.length, 1, 'toast is one-time');
    b.status({ isPro: true, status: 'active', expires_at: null });
    assert.equal(b.saved().effective, 'green');
    assert.equal(b.html.dataset.palette, 'green');
});

test('network failure keeps the theme; an expired cached tier cannot keep a Pro theme across restarts', () => {
    const kept = boot({ stored: { v: 1, theme: 'green', effective: 'green' }, tier: { tier: 'pro', exp: null } });
    assert.equal(kept.html.dataset.palette, 'green', 'no status event (network error) keeps the current theme');
    const now = Date.now();
    const gone = boot({ stored: { v: 1, theme: 'green', effective: 'green' }, tier: { tier: 'pro', exp: now - 1000 }, now });
    assert.equal(gone.html.dataset.palette, 'blue');
    assert.equal(gone.saved().theme, 'green', 'preference survives');
});

test('Pro expiring mid-session schedules a re-check at expires_at', () => {
    const now = Date.now();
    const b = boot({ stored: { v: 1, theme: 'green', effective: 'green' }, now });
    b.status({ isPro: true, status: 'active', expires_at: now + 60000 });
    const timer = b.timers.find(t => t.ms >= 60000 && t.ms < 61000);
    assert.ok(timer, 'expiry timer scheduled');
    timer.f();
    assert.equal(b.html.dataset.palette, 'blue');
});

test('sprite integrity: every semantic key resolves to a non-empty symbol with a real viewBox', () => {
    const sprite = read('image/nature_sprites/sprite.svg');
    const symbols = new Map([...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(m => [m[1], { vb: m[2], body: m[3] }]));
    assert.ok(!/<script|on[a-z]+=|javascript:/i.test(sprite), 'sprite is inert markup');
    for (const [id, s] of symbols) {
        const [, , w, h] = s.vb.split(/\s+/).map(Number);
        assert.ok(w > 0 && h > 0, id + ' viewBox');
        assert.match(s.body, /<path[^>]+d="M[^"]{8,}"/, id + ' has path data');
    }
    const icons = read('icons.js');
    const map = icons.match(/nature: \{([\s\S]*?)\n        \}/)[1];
    for (const [, key, id] of map.matchAll(/'([a-z0-9-]+)': '([a-z0-9-]+)'/g)) assert.ok(symbols.has(id), `icon key ${key} -> ${id}`);
    for (const a of icons.match(/const ANIMALS = \[([^\]]+)\]/)[1].match(/'([a-z]+)'/g)) assert.ok(symbols.has('nt-a-' + a.slice(1, -1)), a);
    for (const id of ['nt-bird0', 'nt-bird1', 'nt-bird2', 'nt-leaf', 'nt-brand-hybrid', 'nt-brand-mascot', 'nt-brand-letter', 'nt-brand-text']) assert.ok(symbols.has(id), id);
});

test('every #ic- reference in chrome resolves to a mapped icon key', () => {
    const icons = read('icons.js');
    const keys = new Set([...icons.match(/nature: \{([\s\S]*?)\n        \}/)[1].matchAll(/'([a-z0-9-]+)': '/g)].map(m => m[1]));
    const animals = icons.match(/const ANIMALS = \[([^\]]+)\]/)[1].match(/'([a-z]+)'/g).map(a => 'animal-' + a.slice(1, -1));
    animals.forEach(k => keys.add(k)); ['bird0', 'bird1', 'bird2'].forEach(k => keys.add(k));
    for (const f of ['index.html', 'components.html', 'settings.html', 'legal.html', 'login.html', 'app.js', 'components.js', 'pro.js', 'nature.js']) {
        for (const [, key] of read(f).matchAll(/#ic-([a-z0-9-]+)/g)) assert.ok(keys.has(key), `${f}: #ic-${key}`);
    }
    for (const [, key] of read('tutorial-integration.js').matchAll(/icon: '([a-z][a-z0-9-]+)'/g)) assert.ok(keys.has(key), 'tour icon ' + key);
});

test('service worker precaches every new theme file and the cache version changed', () => {
    const sw = read('sw.js');
    const assets = new Set([...sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]));
    for (const f of ['theme-boot.js', 'registry.js', 'icons.js', 'nature.js', 'appearance-ui.js', 'palettes.css', 'family-nature.css', 'image/nature_sprites/sprite.svg', 'image/nature_sprites/favicon.svg']) {
        assert.ok(assets.has(f), f);
        assert.ok(fs.existsSync(new URL(f, root)), f + ' exists');
    }
    assert.doesNotMatch(sw, /taskitator-button-startup-v1/);
    // Phase 3.0: help/sleep/study-plans.html only redirect into index.html.
    for (const page of ['index.html', 'components.html', 'settings.html', 'legal.html', 'login.html']) {
        const html = read(page);
        const i = html.indexOf('registry.js'), j = html.indexOf('theme-boot.js');
        assert.ok(i > 0 && j > i && j < html.indexOf('</head>'), page + ': registry then boot, blocking, in <head>');
        assert.doesNotMatch(html.slice(0, html.indexOf('</head>')), /<script>[^<]*data-palette/, page + ': no inline pre-paint script (CSP hashes stay stable)');
    }
});

test('Universe space theme: one token block, no raw colours below it, family switches to space while open', () => {
    const css = read('uni/universe.css');
    // Tokens are declared once, for the open Universe and the workspace.
    const start = css.indexOf('body.universe-active, #universeWorkspace {');
    assert.ok(start > 0, 'space token block');
    const end = css.indexOf('\n}\n', start);
    const tokens = css.slice(start, end);
    for (const name of ['--bg-color', '--card-bg', '--text-color', '--primary', '--danger', '--success', '--tk-acc', '--tk-acc-2', '--tk-acc-3']) assert.match(tokens, new RegExp(name + ':'), name);
    // Every rule after the token block uses tokens only (single place to re-tune the theme).
    const rules = css.slice(end).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [], []);
    // Every var() used resolves to a token declared in this file or a shared base token.
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
    const setByScript = new Set(['--uni-header-height', '--priority-color', '--uni-dot', '--uni-depth']); // set per element by the Universe scripts
    for (const [, name] of css.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(declared.has(name) || setByScript.has(name), name + ' is declared in universe.css');
    // The old freeze is gone: no Universe override in palettes.css, no legacy Universe rules in style.css.
    assert.doesNotMatch(read('palettes.css'), /body\.universe-active\s*\{/);
    assert.doesNotMatch(read('style.css'), /\.universe-workspace\s*\{|#universeWorkspace section/);
    // Physical left/right only where JavaScript positions by offsetLeft (tab indicator) or the shape is symmetric (chevron).
    const physical = rules.split('\n').filter(l => /[;{ ](left|right):|border-(left|right)|(margin|padding)-(left|right)/.test(l));
    assert.ok(physical.every(l => /uni-tab-indicator|summary::after|uni-toast/.test(l)), physical.join('\n')); // toast is centred with left: 50%
    assert.doesNotMatch(read('rtl.css'), /universeWorkspace[^{]*::after\s*\{\s*content/, 'no CSS-drawn Arabic labels for Universe');
});

test('theme-boot applies the space family and its theme colour while a Universe is open', () => {
    const R = loadRegistry();
    assert.equal(R.FAMILIES.space.id, 'space');
    assert.ok(fs.existsSync(new URL(R.FAMILIES.space.sprite, root)));
    assert.ok(!R.THEMES.some(t => t.family === 'space'), 'space is not a selectable theme');
    const boot = read('theme-boot.js');
    assert.match(boot, /universeOpen\(\) \? reg\.FAMILIES\.space : null/);
    assert.doesNotMatch(boot, /delete html\.dataset\.family/);
    // icons.js keeps the nature sprite for families without their own icon map.
    assert.match(read('icons.js'), /MAPS\[family\(\)\] &&/);
});

test('space sprite: inert markup, every body and icon the kit names exists', () => {
    const sprite = read('image/space_sprites/sprite.svg');
    assert.ok(!/<script|on[a-z]+=|javascript:|<image|href=/i.test(sprite), 'sprite is inert markup');
    const symbols = new Map([...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(m => [m[1], m[3]]));
    for (const [id, body] of symbols) assert.match(body, /<path[^>]+d="M[^"]{8,}"/, id + ' has path data');
    const ctx = { window: {}, document: undefined, Object, String, Math, Promise, setTimeout };
    vm.runInNewContext(read('uni/universe-space.js'), ctx);
    const S = ctx.window.UniverseSpace;
    for (const b of [...S.BODIES, ...S.DECOR]) assert.ok(symbols.has('sp-b-' + b), 'body ' + b);
    for (const i of S.ICONS) assert.ok(symbols.has('sp-i-' + i), 'icon ' + i);
    for (const s of S.STARS) assert.ok(S.BODIES.includes(s), s + ' is a completion body');
    // Stable pick: same id, same body; different ids spread over the set.
    assert.equal(S.bodyFor('task-1'), S.bodyFor('task-1'));
    assert.ok(new Set(Array.from({ length: 200 }, (_, i) => S.bodyFor('t' + i))).size >= S.BODIES.length - 2);
    // Server values become readable labels; unknown values are shown as words, never dropped.
    assert.equal(S.label('role', 'owner'), 'Owner');
    assert.equal(S.label('state', 'pending'), 'In review');
    assert.equal(S.label('activity', 'review:late'), 'Submission reviewed: late');
    assert.equal(S.label('activity', 'something_new'), 'Something new');
    const sw = read('sw.js');
    assert.match(sw, /'\.\/uni\/universe-space\.js'/); assert.match(sw, /'\.\/image\/space_sprites\/sprite\.svg'/);
    const page = read('components.html');
    assert.ok(page.indexOf('uni/universe-space.js') > 0 && page.indexOf('uni/universe-space.js') < page.indexOf('uni/universe-widgets.js'), 'kit loads before the Universe scripts');
});

test('family CSS is fully scoped to html[data-family="nature"] (apart from icon base and settings cards)', () => {
    const css = read('family-nature.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map(m => m[2].trim()).filter(s => !/^(from|to|\d+%)/.test(s));
    const allowedUnscoped = /^(\.tk-|#tk-|#appearanceCard|\.tk-theme|\.tk-swatch|\.tk-pro|html:not\(\[data-family="nature"\]\) #focusTimerTag)/;
    const split = sel => { const out = []; let depth = 0, cur = ''; for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()).filter(Boolean); };
    for (const sel of selectors) for (const part of split(sel)) {
        assert.ok(part.startsWith('html[data-family="nature"]') || allowedUnscoped.test(part), 'unscoped selector: ' + part);
    }
});

test('emoji lint: app chrome uses icons; only user content and Universe keep emoji', () => {
    const EMOJI = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2705}\u{2728}\u{2753}\u{2795}\u{2709}\u{270F}][\u{FE0F}\u{200D}]*)+/gu;
    const KEEP = new Set([...'✕✓☑✎⛶⇅▼↻←→↑↓◆◇•·☰']);
    // Allow-list: user-chosen project icons and the Inbox default (user data), Universe (not in this project).
    const ALLOW = /PROJECT_ICONS|is_default: true|projectObj\.icon \|\||🌌|\.replace\(\/\[/;
    const files = ['index.html', 'components.html', 'settings.html', 'legal.html', 'login.html', 'views/projects.js', 'views/calendar.js', 'views/stats.js', 'views/trash.js', 'views/blocker-guide.js', 'sleep.js', 'shell-router.js', 'app.js', 'components.js', 'pro.js', 'tutorial-integration.js', 'tutorial-spotlight.js', 'theme-boot.js', 'icons.js', 'nature.js', 'appearance-ui.js'];
    const hits = [];
    for (const f of files) read(f).split('\n').forEach((line, i) => {
        if (ALLOW.test(line)) return;
        for (const m of line.matchAll(EMOJI)) if (!KEEP.has(m[0].replace(/\u{FE0F}/gu, ''))) hits.push(`${f}:${i + 1} ${m[0]}`);
    });
    assert.deepEqual(hits, []);
});

test('contrast: text and control pairs meet WCAG AA (4.5:1) in every palette', () => {
    const css = read('palettes.css');
    const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    // Buttons in the nature family use --tk-btn / --tk-fab fills, so --primary is tuned as a text colour.
    const pairs = [['--text-color', '--card-bg'], ['--text-color', '--bg-color'], ['--text-muted', '--card-bg'], ['--text-muted', '--card-subtle'],
        ['--tk-cream', '--tk-inner'], ['--tk-badge', '--tk-inner'], ['--tk-soft', '--tk-bg1'], ['--tk-btn-text', '--tk-btn'], ['#ffffff', '--tk-fab'],
        ['--primary', '--card-bg'], ['--tk-label', '--tk-inner'], ['--tk-tab', '--tk-bg1'], ['--tag-text', '--tag-bg'], ['--tk-accent', '--tk-inner']];
    for (const id of loadRegistry().THEMES.map(t => t.palette)) {
        const body = css.match(new RegExp(`html\\[data-palette="${id}"\\] \\{([\\s\\S]*?)\\n\\}`))[1];
        const v = name => (name.startsWith('#') ? name : body.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6});'))[1]);
        for (const [fg, bg] of pairs) assert.ok(ratio(v(fg), v(bg)) >= 4.5, `${id}: ${fg} on ${bg} = ${ratio(v(fg), v(bg)).toFixed(2)}`);
        // Priority colours stay fixed and must stay visible as rings on the task surface.
        for (const prio of ['#ef4444', '#eab308', '#22c55e']) assert.ok(ratio(prio, v('--tk-inner')) >= 3, `${id}: priority ${prio}`);
    }
});

test('sidebar: same order on every page (Drafts only where the editor exists); Study plans and Help use different icons',async()=>{
  const {readFileSync}=await import('node:fs');
  const read=f=>{const nav=/<nav class="drawer-links" id="drawerNavLinks">([\s\S]*?)<\/nav>/.exec(readFileSync(f,'utf8'))[1];return [...nav.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map(m=>({icon:/#ic-([\w-]+)/.exec(m[1])[1],label:m[1].replace(/<[^>]*>/g,'').trim()}));};
  const pages=['index.html','components.html','settings.html'].map(read),ref=pages[0].map(i=>i.label);
  for(const p of pages)assert.deepEqual(p.map(i=>i.label),ref.filter(l=>p.some(i=>i.label===l)));
  assert.deepEqual(ref,['Today','General Tasks','Calendar','Projects','Stats','Trash','Drafts','Universe','Sleep Lock','Study plans','Test lab','Help','Settings']);
  for(const p of pages)assert.notEqual(p.find(i=>i.label==='Study plans').icon,p.find(i=>i.label==='Help').icon);
});

test('audit M3: inside another site\'s frame the page hides itself and tries to leave the frame; top-level pages are untouched', () => {
    const run = (top, sameOrigin = true) => {
        const style = new Map(), moved = [];
        const self = { location: { href: 'https://taskitator.mazendev.com/index.html' } };
        const window = { self, document: { documentElement: { dataset: {}, style: { setProperty: (k, v, p) => style.set(k, v + (p ? ' !' + p : '')) } } } };
        self.document = window.document;
        const topWindow = top === 'self' ? self : { location: { replace: href => { if (!sameOrigin) throw new Error('blocked'); moved.push(href); } } };
        Object.defineProperty(window, 'top', { get() { if (top === 'throws') throw new Error('cross-origin'); return topWindow; } });
        vm.runInNewContext(read('theme-boot.js'), { window, document: window.document, localStorage: { getItem: () => null, setItem() {} } });
        return { display: style.get('display'), moved };
    };
    assert.equal(run('self').display, undefined);
    assert.deepEqual(run('other'), { display: 'none !important', moved: ['https://taskitator.mazendev.com/index.html'] });
    assert.deepEqual(run('other', false), { display: 'none !important', moved: [] });
    assert.equal(run('throws').display, 'none !important');
    // It must be the first thing the file does, before the theme registry check can return early.
    const src = read('theme-boot.js');
    assert.ok(src.indexOf('window.top !== window.self') < src.indexOf('TaskitatorThemes'));
});

// Phase 6.8: boot watchdog (10 s "taking longer", 45 s cutoff to offline), Skip-to-offline on the loading and
// secure-files screens, the app-wide slow-AI notice, and removal of the unreachable "Local only" sync state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const core = read('core.js');
const moduleSrc = name => core.match(new RegExp(`// <<< MODULE_START: ${name.replace('.', '\\.')} >>>([\\s\\S]*?)// <<< MODULE_END: ${name.replace('.', '\\.')} >>>`))[1];
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

class El {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.hidden = false; this.textContent = ''; this.listeners = {}; this.parent = null; this.className = ''; }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; this.removed = true; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    click() { (this.listeners.click || []).forEach(f => f()); this.onclick?.(); }
    find(cls) { for (const c of this.children) { if (c.className === cls) return c; const d = c.find?.(cls); if (d) return d; } return null; }
}

function boot({ canOffer = true, signIn = () => new Promise(() => {}), sw = null } = {}) {
    const timers = new Map(); let now = 0, seq = 0;
    const setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
    const clearTimeout = id => timers.delete(id);
    const advance = async ms => {
        now += ms;
        for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); await flush(); }
    };
    const calls = [];
    const body = new El('body');
    const auth = { account: null, deletion: null, get signedIn() { return Boolean(this.account); }, init: () => { calls.push('init'); return signIn(auth); } };
    const offline = {
        canOfferOffline: () => canOffer,
        canOpenOffline: async () => false,
        enterBootOffline() { calls.push('offline'); auth.account = { user: 'rd' }; },
        bootNotice(reason, opts) { calls.push('notice:' + reason + (opts?.updatePending ? ':update' : '')); },
        applyUI() {}, active: false
    };
    const window = { TaskitatorOffline: offline, dispatchEvent(e) { calls.push('ready'); } };
    const storage = new Map([['taskitator_local_owner', 'rd']]);
    const ctx = vm.createContext({
        window, TaskitatorAuth: auth, setTimeout, clearTimeout, Event: class { constructor(t) { this.type = t; } }, MessageChannel,
        document: { body, createElement: t => new El(t), querySelectorAll: () => [], getElementById: () => null, head: { append() {} }, documentElement: { classList: { remove() { calls.push('unpend'); } } } },
        navigator: sw ? { serviceWorker: sw, onLine: true } : {},
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: { pathname: '/index.html', search: '', hash: '', replace: u => calls.push('replace:' + u), reload: () => calls.push('reload') }
    });
    const done = vm.runInContext(moduleSrc('auth-bootstrap.js'), ctx);
    const status = body.children[0];
    return { calls, status, advance, timers, done, auth };
}

test('Skip on the loading screen opens the cached copy offline at once', async () => {
    const b = boot();
    await flush();
    const skip = b.status.find('boot-skip');
    assert.ok(skip, 'skip button shown when offline can open');
    assert.equal(skip.textContent, 'Skip and open offline');
    skip.click();
    await flush();
    assert.deepEqual(b.calls, ['init', 'offline', 'notice:skipped', 'ready', 'unpend']);
    assert.ok(b.status.removed, 'loading screen gone');
    assert.equal(b.timers.size, 0, 'watchdog timers cleared');
});

test('10 s shows "Taking longer than usual"; 45 s gives up and opens offline with the failure notice', async () => {
    const b = boot();
    await flush();
    const slow = b.status.find('boot-slow');
    assert.equal(slow.hidden, true);
    await b.advance(9999); assert.equal(slow.hidden, true);
    await b.advance(1); assert.equal(slow.hidden, false);
    assert.equal(slow.textContent, 'Taking longer than usual…');
    assert.ok(!b.calls.includes('offline'));
    await b.advance(35000);
    await flush();
    assert.deepEqual(b.calls, ['init', 'offline', 'notice:timeout', 'ready', 'unpend']);
});

test('without a cached account there is no Skip, and 45 s shows a failure with Try again (never a dead offline)', async () => {
    const b = boot({ canOffer: false });
    await flush();
    assert.equal(b.status.find('boot-skip'), null);
    await b.advance(45000);
    await flush();
    assert.ok(!b.calls.includes('offline'));
    assert.match(b.status.find('boot-msg').textContent, /couldn't connect\. Check your internet connection and try again\./);
    const again = b.status.children.find(c => c.tag === 'button' && c.textContent === 'Try again');
    assert.ok(again, 'Try again offered');
    assert.equal(b.status.find('boot-slow').hidden, true);
    again.click();
    assert.ok(b.calls.includes('reload'));
});

test('a fast sign-in clears the watchdog; a sign-in that ends after Skip changes nothing', async () => {
    const fast = boot({ signIn: async auth => { auth.account = { user: 'rd' }; } });
    await flush();
    assert.deepEqual(fast.calls, ['init', 'ready', 'unpend']);
    assert.equal(fast.timers.size, 0);

    let finish;
    const late = boot({ signIn: auth => new Promise((_, reject) => { finish = () => reject(Object.assign(new Error('late'), { status: 500 })); }) });
    await flush();
    late.status.find('boot-skip').click();
    await flush();
    finish();
    await flush();
    assert.deepEqual(late.calls, ['init', 'offline', 'notice:skipped', 'ready', 'unpend']);
});

test('Skip on "Updating secure app files" opens the cached copy and marks the update as pending (no reload)', async () => {
    const listeners = new Map();
    const sw = {
        controller: { postMessage(m, ports) { ports[0].postMessage({ version: 'old' }); ports[0].close(); } },
        addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n),
        register: () => new Promise(() => {})
    };
    const b = boot({ sw });
    await flush(20);
    assert.equal(b.status.find('boot-msg').textContent, 'Updating secure app files…');
    b.status.find('boot-skip').click();
    await flush(20);
    assert.deepEqual(b.calls, ['offline', 'notice:skipped:update', 'ready', 'unpend']);
    assert.ok(!b.calls.includes('reload'));
    assert.ok(!core.includes('Security files are still updating'), 'the old 30 s error is gone');
});

test('offline module: canOfferOffline, a lasting boot notice with Reconnect, and no in-place reconnect after a skipped update', () => {
    const src = moduleSrc('offline.js');
    assert.match(src, /function canOfferOffline\(\)[\s\S]{0,300}taskitator_logout_pending[\s\S]{0,200}taskitator_local_owner/);
    assert.match(src, /if \(!canOfferOffline\(\)\) return false;\s*return isNetworkError\(error\) \|\| !\(await probe\(\)\)/);
    assert.match(src, /again\.textContent = 'Reconnect';\s*again\.addEventListener\('click', \(\) => location\.reload\(\)\)/);
    assert.match(src, /if \(reloadOnRecover\) \{ bootNotice\('back'\); return; \}/);
    assert.match(src, /if \(!active\) \{ bootNoticeShown = false; document\.getElementById\('bootOfflineNotice'\)\?\.remove\(\); \}/);
    assert.match(src, /canOfferOffline, bootNotice,/);
    assert.match(core, /loadClerk\(\) \{\s*if \(window\.Clerk\?\.loaded\) return Promise\.resolve\(\);\s*if \(!this\.clerkLoading\)/);
});

test('slow-AI notice: shown after 10 s while a model request waits, gone when the last one answers', async () => {
    const timers = new Map(); let seq = 0;
    const body = { kids: [], append(e) { this.kids.push(e); e.remove = () => { this.kids = this.kids.filter(k => k !== e); }; } };
    const document = { body, createElement: () => ({ setAttribute() {} }), getElementById: id => body.kids.find(k => k.id === id) || null };
    const window = {};
    vm.runInNewContext(core.slice(core.indexOf('// Phase 6.8: "taking longer than usual" for AI work'), core.indexOf('// <<< MODULE_START', core.indexOf('// Phase 6.8: "taking longer than usual" for AI work'))),
        { window, document, setTimeout: (f, ms) => { timers.set(++seq, f); return seq; }, clearTimeout: id => timers.delete(id) });
    const S = window.TaskitatorSlow;
    for (const p of ['/ai/generate', '/pro/ai/review', '/pro/ai/batch-review', '/pro/ai/personal-review', '/pro/ai/batch-confirm', '/universe/groups/g1/assignments/a1/submit']) assert.ok(S.isAiPath(p), p);
    for (const p of ['/pro/ai/quote', '/ai/keys', '/ai/provider', '/universe/groups/g1/ai', '/pro/status', '/breaks']) assert.ok(!S.isAiPath(p), p);
    let resolveA, resolveB;
    S.track(new Promise(r => { resolveA = r; })); S.track(new Promise(r => { resolveB = r; }));
    assert.equal(document.getElementById('aiSlowNotice'), null);
    [...timers.values()].forEach(f => f());
    const pill = document.getElementById('aiSlowNotice');
    assert.equal(pill.textContent, 'AI is taking longer than usual…');
    resolveA(); await flush();
    assert.ok(document.getElementById('aiSlowNotice'), 'still waiting on one');
    resolveB(); await flush();
    assert.equal(document.getElementById('aiSlowNotice'), null);
    assert.match(core, /res = await \(window\.TaskitatorSlow\?\.isAiPath\(path\) \? window\.TaskitatorSlow\.track\(call\) : call\)/);
    assert.match(read('pro.js'), /res = await \(global\.TaskitatorSlow\?\.isAiPath\(path\) \? global\.TaskitatorSlow\.track\(call\) : call\)/);
    assert.match(read('app.js'), /note\.textContent = 'Taking longer than usual…'/);
    assert.match(read('style.css'), /body:has\(#copilotDrawer\.open\) #aiSlowNotice \{ display: none; \}/);
});

test('"Local only" is gone: the dot falls back to pending, the guide drops it and Red no longer claims Offline', () => {
    const html = read('index.html'), app = read('app.js');
    for (const src of [html, app, read('style.css')]) assert.ok(!/local-only|Local Only|Sync Status: Local only/.test(src));
    assert.match(html, /<span class="sync-dot pending" id="syncStatusDot"/);
    assert.match(html, /Red: Sync Failed<\/strong>/);
    assert.match(html, /Gray ring: Offline/);
    assert.match(app, /if \(window\.TaskitatorOffline\?\.active\) state = 'offline';/);
    const ctx = { window: {}, module: { exports: {} } };
    vm.runInNewContext(read('locales/ar.js'), ctx);
    const ar = ctx.module.exports;
    for (const k of ['Local only', 'Gray: Local Only', 'Red: Sync Failed / Offline']) assert.equal(ar[k], undefined, k);
    for (const k of ['Taking longer than usual…', 'Skip and open offline', 'Reconnect', 'AI is taking longer than usual…', 'Red: Sync Failed']) assert.ok(ar[k], k);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v75'/);
    assert.match(read('README.md'), /Phase 6\.8/);
});

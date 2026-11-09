import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const PAGES = ['index.html', 'components.html', 'settings.html', 'help.html', 'login.html', 'sleep.html'];

function boot(stored) {
    const store = new Map(stored ? [['taskitator_lang', JSON.stringify(stored)]] : []);
    const html = { lang: '', dir: '' };
    const listeners = {};
    const ctx = {
        localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
        document: { documentElement: html, addEventListener() {} },
        location: { reload() { ctx.reloads++; } },
        reloads: 0,
        sessionStorage: { getItem: () => null },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        Intl, Date, Number, String, Object, JSON
    };
    ctx.window = { addEventListener: (t, f) => { listeners[t] = f; }, dispatchEvent() {}, alert() {}, confirm() {}, prompt() {} };
    vm.createContext(ctx);
    vm.runInContext(read('i18n.js'), ctx);
    ctx.window.TaskitatorI18n.register('ar', loadAr());
    return { i18n: ctx.window.TaskitatorI18n, html, store, ctx };
}
function loadAr() {
    const ctx = { window: {}, module: { exports: {} } };
    vm.createContext(ctx);
    vm.runInContext(read('locales/ar.js'), ctx);
    return ctx.module.exports;
}

test('English is the default language and left-to-right', () => {
    const { i18n, html } = boot();
    assert.equal(i18n.lang, 'en');
    assert.equal(html.lang, 'en');
    assert.equal(html.dir, 'ltr');
    assert.equal(i18n.t('Today'), 'Today');
});

test('Arabic flips the page to right-to-left and translates known strings', () => {
    const { i18n, html } = boot({ v: 1, lang: 'ar', clock: 'auto' });
    assert.equal(html.lang, 'ar');
    assert.equal(html.dir, 'rtl');
    assert.equal(i18n.t('Today'), 'اليوم');
    assert.equal(i18n.t('Not in the dictionary yet'), 'Not in the dictionary yet');
});

test('invalid stored values fall back to English and the automatic clock', () => {
    for (const bad of [{ lang: 'fr' }, { lang: 'ar', clock: '13' }, []]) {
        const { i18n } = boot(bad);
        assert.equal(i18n.clock, 'auto');
        if (!Array.isArray(bad) && bad.lang === 'ar') assert.equal(i18n.lang, 'ar'); else assert.equal(i18n.lang, 'en');
    }
});

test('language change saves on the device and reloads; clock change does not reload', () => {
    const { i18n, store, ctx, html } = boot();
    assert.equal(i18n.setLang('ar'), true);
    assert.equal(ctx.reloads, 1);
    assert.equal(html.dir, 'rtl');
    assert.deepEqual(JSON.parse(store.get('taskitator_lang')), { v: 1, lang: 'ar', clock: 'auto' });
    assert.equal(i18n.setClock('24'), true);
    assert.equal(ctx.reloads, 1);
    assert.equal(i18n.setLang('xx'), false);
    assert.equal(i18n.setClock('25'), false);
});

test('Arabic plurals use all six forms; English picks one/other', () => {
    const en = boot().i18n;
    assert.equal(en.n(1, '{n} task', '{n} tasks'), '1 task');
    assert.equal(en.n(3, '{n} task', '{n} tasks'), '3 tasks');
    const { i18n } = boot({ lang: 'ar' });
    i18n.register('ar', { '{n} tasks': { zero: 'z{n}', one: 'o{n}', two: 't{n}', few: 'f{n}', many: 'm{n}', other: 'x{n}' } });
    assert.deepEqual([0, 1, 2, 3, 11, 100].map(c => i18n.n(c, '{n} task', '{n} tasks')), ['z0', 'o1', 't2', 'f3', 'm11', 'x100']);
});

test('English formatting is byte-identical to the old toLocale* calls', () => {
    const { i18n } = boot();
    const d = Date.UTC(2026, 10, 9, 21, 5, 7);
    assert.equal(i18n.date(d), new Date(d).toLocaleDateString());
    assert.equal(i18n.time(d), new Date(d).toLocaleTimeString());
    assert.equal(i18n.dateTime(d), new Date(d).toLocaleString());
    assert.equal(i18n.dateTime(d, { timeZone: 'Asia/Riyadh' }, 'en-GB'), new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' }));
    const clock = { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    assert.equal(i18n.time(d, clock, 'en-GB'), new Intl.DateTimeFormat('en-GB', clock).format(d));
    assert.equal(i18n.date('not a date'), '');
});

test('Arabic dates are Gregorian with Western digits; the clock option applies', () => {
    const { i18n } = boot({ lang: 'ar' });
    const d = Date.UTC(2026, 10, 9, 21, 5, 7);
    const long = i18n.date(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Riyadh' });
    assert.match(long, /نوفمبر/);
    assert.match(long, /2026/);
    for (const s of [long, i18n.dateTime(d), i18n.number(1234567)]) {
        assert.doesNotMatch(s, /[\u0660-\u0669\u06F0-\u06F9]/, 'no Arabic-Indic digits: ' + s);
        assert.doesNotMatch(s, /محرم|صفر|ربيع|جمادى|رجب|شعبان|رمضان|شوال|ذو القعدة|ذو الحجة|هـ/, 'no Hijri: ' + s);
    }
    const opts = { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    assert.match(i18n.time(d, opts), /[صم]/, 'automatic is 12h in Arabic');
    i18n.setClock('24');
    assert.equal(i18n.time(d, opts), '00:05');
    i18n.setClock('12');
    assert.match(i18n.time(d, opts), /12:05/);
});

test('dictionary keeps placeholders and follows the glossary', () => {
    const ar = loadAr();
    for (const [key, value] of Object.entries(ar)) {
        const values = typeof value === 'string' ? [value] : Object.values(value);
        assert.ok(values.length && values.every(v => typeof v === 'string' && v.trim()), 'empty entry: ' + key);
        const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
        // Arabic may drop a captured English fragment (e.g. a plural "s") but never invents placeholders.
        const keyHoles = new Set(holes(key).split(',').filter(Boolean));
        for (const v of values) for (const h of holes(v.replace(/:t\}/g, '}')).split(',').filter(Boolean)) assert.ok(keyHoles.has(h), 'unknown placeholder {' + h + '} in: ' + key);
        for (const v of values) {
            assert.doesNotMatch(v, /\b(Universe|Copilot|Co-pilot|Pro|Max|Scratchpad|Shield|Bonus|Inbox)\b/, 'untranslated glossary term in: ' + key);
            assert.doesNotMatch(v, /اليونيفيرس|يونيفرس|كوبايلوت|البرو\b|برو\s*برو/, 'wrong glossary spelling in: ' + key);
            assert.doesNotMatch(v, /\{\s*[\u0600-\u06FF]+\s*(==|!=|>=|<=|~=)/, 'rule variables stay English: ' + key);
            if (/Taskitator/.test(key)) assert.match(v, /Taskitator/, '"Taskitator" must stay Latin: ' + key);
        }
    }
    assert.equal(ar['Universe'], 'يونيفيرس');
    assert.equal(ar['Copilot'], 'المساعد الذكي');
    assert.equal(ar['Pro'], 'برو');
    assert.equal(ar['Bonus task'], 'مهمة إضافية');
});

test('every page loads i18n.js after theme-boot.js, then the Arabic dictionary', () => {
    for (const page of PAGES) {
        const html = read(page);
        const a = html.indexOf('src="theme-boot.js"'), b = html.indexOf('src="i18n.js"'), c = html.indexOf('src="locales/ar.js"');
        assert.ok(a > 0 && b > a && c > b, page + ' must load theme-boot.js, i18n.js, locales/ar.js in order');
    }
    const sw = read('sw.js');
    for (const f of ['i18n.js', 'locales/ar.js', 'locales/clerk-ar.js', 'rtl.css']) assert.match(sw, new RegExp("'\\./" + f.replace('.', '\\.') + "'"), 'SW precaches ' + f);
});

test('the UI language never syncs and never reaches the backend', () => {
    const core = read('core.js');
    assert.doesNotMatch(core, /taskitator_lang/, 'core.js (sync, backups, settings) must not touch taskitator_lang');
    for (const f of ['worker.js', 'pro-backend.js']) assert.doesNotMatch(read(f), /taskitator_lang|TaskitatorI18n|Accept-Language/i, f);
    for (const f of ['core.js', 'app.js', 'components.js', 'pro.js']) {
        assert.doesNotMatch(read(f), /headers[^;]{0,200}(TaskitatorI18n|taskitator_lang|documentElement\.lang)/, f + ' must not send the UI language');
    }
});

test('Settings has a device-only Language card that does not mark settings unsaved', () => {
    const html = read('settings.html');
    assert.match(html, /id="languageCard"/);
    assert.match(html, /<option value="ar"[^>]*>العربية<\/option>/);
    assert.match(html, /id="clockSelect"/);
    const ui = read('appearance-ui.js');
    assert.match(ui, /setLang\(langSelect\.value\)/);
    assert.doesNotMatch(ui, /markUnsaved/);
});

test('RTL: layout CSS uses logical properties (physical left/right only where intentional)', () => {
    // Allowed physical declarations: centring (left:50% + translate), JS-positioned elements
    // (tour card, Universe tab indicator), decorative art (scene, clouds, bird), border-drawn chevrons.
    const ALLOWED = /\.tt-|#tk-scene|#tk-clouds|\.tk-bird|\.uni-tab-indicator|\.uni-stepper li::after|\.uni-toast|summary::after|#openDrawerBtn::before|left:\s*50%|right:\s*50%|translate\(-50%|translateX\(-50%/;
    const files = ['style.css', 'family-nature.css', 'tutorial-spotlight.css', 'uni/universe.css'];
    for (const f of files) {
        const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
            const [, sel, body] = m;
            if (/keyframes|^\s*(from|to|\d+%)/.test(sel)) continue;
            if (!/(^|[;\s])((margin|padding|border)-(left|right)[\w-]*|left|right)\s*:|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/.test(body)) continue;
            assert.ok(ALLOWED.test(sel) || ALLOWED.test(body), f + ': physical left/right in "' + sel.trim().slice(-80) + '". Use inline-start/end (tools/css-logical.py).');
        }
    }
    for (const f of ['app.js', 'components.js', 'components.html', 'core.js', 'pro.js']) {
        assert.doesNotMatch(read(f), /style\.(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft\w*|borderRight\w*)\s*=/, f + ' sets a physical inline style; use marginInlineStart etc.');
    }
    const rtl = read('rtl.css');
    for (const s of ['.sidebar-drawer', '.copilot-drawer', 'input.switch:checked::before', 'unicode-bidi: plaintext']) assert.ok(rtl.includes(s), 'rtl.css covers ' + s);
    for (const page of PAGES) {
        const html = read(page);
        assert.ok(html.indexOf('href="rtl.css"') > html.indexOf('href="family-nature.css"'), page + ' loads rtl.css after family-nature.css');
    }
});

test('rendered text: patterns, plurals, captured UI words and user text', () => {
    const { i18n } = boot({ lang: 'ar' });
    i18n.register('ar', loadAr());
    const tt = s => i18n.translateText(s);
    assert.equal(tt('Start by 14:00'), 'ابدأ قبل 14:00');
    assert.equal(tt('3 tasks'), '3 مهام');
    assert.equal(tt('1 task'), 'مهمة واحدة');
    assert.equal(tt('11 tasks'), '11 مهمة');
    assert.equal(tt('Lock Scheduled for Today'), 'قفل المجدولة لهذا اليوم');
    assert.equal(tt('Ask Ari...'), 'اسأل Ari...', 'a custom Copilot name is user input and stays as typed');
    assert.equal(tt('Ask Focus Copilot...'), 'اسأل المساعد الذكي...', 'the default name is translated');
    assert.equal(tt('Moved "Gym" to Trash.'), 'نُقلت "Gym" إلى المحذوفات.', 'captured task titles are not translated');
    assert.equal(tt('3 of 10'), '3 من 10');
    assert.equal(tt('Something nobody translated'), undefined);
    assert.equal(i18n.duration(150), '2س 30د');
    assert.equal(boot().i18n.duration(150), undefined, 'English keeps the caller wording');
});

test('user content containers are never translated', () => {
    const src = read('i18n.js');
    for (const sel of ['.task-title', '.tag-chip', '.chat-bubble', '.completed-item-title', '.dump-note-body', '.trash-title', '.uni-comment', '[translate="no"]', '[contenteditable]'])
        assert.ok(src.includes("'" + sel + "'"), 'USER selector list covers ' + sel);
    assert.match(read('pro.js'), /if \(!\(project\.id === 'inbox' && project\.name === 'Inbox'\)\) name\.setAttribute\('translate', 'no'\)/);
    const comp = read('components.html');
    assert.match(comp, /id="legalPrivacySection" translate="no" lang="en"/, 'Privacy Policy stays English (binding text)');
    assert.match(comp, /id="legalTermsSection" translate="no" lang="en"/, 'Terms stay English (binding text)');
});

test('Clerk sign-in widget gets Arabic text only when the UI is Arabic', () => {
    const core = read('core.js');
    assert.match(core, /if \(window\.TaskitatorI18n\?\.lang === 'ar'\)[\s\S]{0,200}loadScript\('locales\/clerk-ar\.js'\)/);
    assert.match(core, /\.\.\.\(localization \? \{ localization \} : \{\}\)/);
    assert.match(read('locales/clerk-ar.js'), /^\/\*[\s\S]*window\.TaskitatorClerkLocalization = \{"locale":"ar-SA"/);
});

test('Help stays English and left-to-right until it is translated', () => {
    const help = read('help.html');
    assert.match(help, /<main class="hp" translate="no" lang="en" dir="ltr">/);
});

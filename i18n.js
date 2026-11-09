/* Taskitator UI language. Blocking script in <head> of every page, loaded after theme-boot.js
   and before locales/ar.js, so <html lang dir> are set before first paint.
   External file on purpose: editing it never changes the CSP inline-script hashes.

   Storage: localStorage 'taskitator_lang' (per device, never synced, never sent to the server):
     { v:1, lang:'en'|'ar', clock:'auto'|'12'|'24' }
   English is the default. Not in SNAPSHOT_KEYS, cleanSettings or backups; "Clear this browser"
   (localStorage.clear) resets it. The backend never sees it: language only changes what is shown.

   Strings: the English source text is the key. t('Save') returns the Arabic entry when the UI is
   Arabic and one exists, otherwise the English text, so untranslated strings never break.
   User input is never passed through t(). */
(function () {
    'use strict';
    const KEY = 'taskitator_lang';
    const VERSION = 1;
    const LANGS = { en: { dir: 'ltr', label: 'English' }, ar: { dir: 'rtl', label: 'العربية' } };
    const CLOCKS = ['auto', '12', '24'];
    // Gregorian calendar and Western digits in every language (locked decision).
    const INTL = { en: undefined, ar: 'ar-u-ca-gregory-nu-latn' };
    const html = document.documentElement;
    const dictionaries = Object.create(null);

    function defaults() { return { v: VERSION, lang: 'en', clock: 'auto' }; }
    function normalize(raw) {
        const out = defaults();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        if (Object.prototype.hasOwnProperty.call(LANGS, raw.lang)) out.lang = raw.lang;
        if (CLOCKS.includes(String(raw.clock))) out.clock = String(raw.clock);
        return out;
    }
    function read() {
        try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaults(); }
    }
    function save(state) {
        try { localStorage.setItem(KEY, JSON.stringify(normalize(state))); } catch {}
    }

    let state = read();

    function apply() {
        html.lang = state.lang;
        html.dir = LANGS[state.lang].dir;
    }

    // ----- Strings -----
    const fill = (text, vars) => (vars && typeof text === 'string')
        ? text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
        : text;
    let pluralAr = null;
    function pluralForm(n) {
        if (state.lang !== 'ar') return Number(n) === 1 ? 'one' : 'other';
        try { pluralAr ??= new Intl.PluralRules('ar'); return pluralAr.select(Number(n)); } catch { return 'other'; }
    }
    function lookup(key) {
        if (state.lang === 'en') return undefined;
        const dict = dictionaries[state.lang];
        return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
    }
    // t('Hello {name}', {name}) -> translated + filled. Falls back to the English key.
    function t(key, vars) {
        const hit = lookup(key);
        let text = typeof hit === 'string' && hit ? hit : key;
        if (hit && typeof hit === 'object') text = hit.other || key;
        return fill(text, vars);
    }
    // n(count, '{n} task', '{n} tasks'): English picks one/other. Arabic looks up the plural
    // key (the English plural form); its entry may be { zero, one, two, few, many, other }.
    function n(count, one, other, vars) {
        const all = { n: count, ...(vars || {}) };
        const hit = lookup(other ?? one);
        if (hit && typeof hit === 'object') {
            const form = pluralForm(count);
            return fill(hit[form] || hit.other || other || one, all);
        }
        if (typeof hit === 'string' && hit) return fill(hit, all);
        return fill(Number(count) === 1 || other === undefined ? one : other, all);
    }

    // ----- Static markup -----
    // Translates text nodes and a few attributes whose exact English text has a dictionary entry.
    // Only app markup is passed in; elements marked translate="no" or data-no-i18n (and their
    // children) are skipped, and so are form values, so user input is never touched.
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'svg', 'SVG', 'NOSCRIPT']);
    function skipped(el) {
        return !el || SKIP.has(el.tagName) || el.closest?.('[translate="no"],[data-no-i18n]');
    }
    function translateDom(root) {
        if (state.lang === 'en' || !dictionaries[state.lang] || !root) return 0;
        let count = 0;
        const base = root.nodeType === 1 ? root : root.documentElement || root.body;
        if (!base) return 0;
        const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const raw = node.nodeValue;
            const key = raw.replace(/\s+/g, ' ').trim();
            if (!key || !/[A-Za-z]/.test(key) || skipped(node.parentElement)) continue;
            const hit = lookup(key);
            if (typeof hit !== 'string' || !hit) continue;
            const lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
            node.nodeValue = lead + hit + tail;
            count++;
        }
        const els = base.querySelectorAll ? base.querySelectorAll(ATTRS.map(a => '[' + a + ']').join(',')) : [];
        for (const el of [base, ...els]) {
            if (!el.getAttribute || skipped(el)) continue;
            for (const a of ATTRS) {
                const v = el.getAttribute(a);
                if (!v) continue;
                const hit = lookup(v.replace(/\s+/g, ' ').trim());
                if (typeof hit === 'string' && hit) { el.setAttribute(a, hit); count++; }
            }
        }
        if (base === document.documentElement || base === document.body) {
            const title = document.title && lookup(document.title.trim());
            if (typeof title === 'string' && title) document.title = title;
        }
        return count;
    }

    // ----- Formatting (Gregorian, Western digits, user clock) -----
    // 'auto' keeps each call site's original behaviour in English and uses 12h in Arabic.
    function clockOpts(opts, hasTime) {
        const o = { ...(opts || {}) };
        if (!(hasTime ?? ('hour' in o || 'timeStyle' in o))) return o;
        if (state.clock === '12') { delete o.hourCycle; o.hour12 = true; }
        else if (state.clock === '24') { delete o.hour12; o.hourCycle = 'h23'; }
        else if (state.lang === 'ar') { delete o.hourCycle; o.hour12 = true; }
        return o;
    }
    // Options that name no date/time field (only timeZone, say) mean "the method's defaults".
    const FIELDS = ['weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'dateStyle', 'timeStyle'];
    const named = o => Boolean(o) && FIELDS.some(k => k in o);
    // Delegates to the native toLocale*String method, so English output with the 'auto' clock is
    // byte-identical to the old calls. `enLocale` keeps a call site's original English locale.
    function fmt(value, opts, method, enLocale) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        const loc = state.lang === 'en' ? enLocale : INTL[state.lang];
        const o = clockOpts(opts, named(opts) ? undefined : method !== 'toLocaleDateString');
        try { return d[method](loc, o); }
        catch { return d[method](); }
    }
    const api = {
        KEY,
        LANGS,
        CLOCKS,
        defaults,
        normalize,
        read: () => ({ ...state }),
        get lang() { return state.lang; },
        get dir() { return LANGS[state.lang].dir; },
        get clock() { return state.clock; },
        isRTL: () => LANGS[state.lang].dir === 'rtl',
        t,
        n,
        translateDom,
        register(lang, dict) {
            if (!Object.prototype.hasOwnProperty.call(LANGS, lang) || lang === 'en' || !dict || typeof dict !== 'object') return false;
            dictionaries[lang] = Object.assign(dictionaries[lang] || Object.create(null), dict);
            return true;
        },
        has: key => typeof lookup(key) !== 'undefined',
        // Per-device writes. A language change reloads the page so every screen re-renders in it.
        setLang(lang, { reload = true } = {}) {
            if (!Object.prototype.hasOwnProperty.call(LANGS, lang)) return false;
            if (lang === state.lang) return true;
            state = { ...state, lang }; save(state); apply();
            if (reload) { try { location.reload(); } catch {} }
            return true;
        },
        setClock(clock) {
            if (!CLOCKS.includes(String(clock))) return false;
            state = { ...state, clock: String(clock) }; save(state);
            try { window.dispatchEvent(new CustomEvent('taskitator-language', { detail: { ...state } })); } catch {}
            return true;
        },
        // Display formatting. `enLocale` lets a call site keep its original English locale (e.g. 'en-GB').
        date: (v, opts, enLocale) => fmt(v, opts, 'toLocaleDateString', enLocale),
        time: (v, opts, enLocale) => fmt(v, opts, 'toLocaleTimeString', enLocale),
        dateTime: (v, opts, enLocale) => fmt(v, opts, 'toLocaleString', enLocale),
        number(value, opts) {
            try { return new Intl.NumberFormat(state.lang === 'en' ? undefined : INTL[state.lang], opts).format(value); }
            catch { return String(value); }
        },
        clockOpts
    };
    window.TaskitatorI18n = api;

    apply();
    window.addEventListener('storage', e => {
        if (e.key !== KEY) return;
        const next = read();
        const langChanged = next.lang !== state.lang;
        state = next; apply();
        if (langChanged) { try { location.reload(); } catch {} }
    });
    document.addEventListener('DOMContentLoaded', () => translateDom(document.documentElement));
})();

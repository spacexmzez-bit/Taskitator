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
    // Dictionary entries come in three kinds, all keyed by the exact English text:
    //   'Save': 'حفظ'                                exact text
    //   'Start by {0}': 'ابدأ قبل {0}'               pattern: {name} captures any text, {n} a number.
    //                                                 Captured text is inserted as-is (it may be user
    //                                                 input), unless the Arabic writes {name:t}, which
    //                                                 looks the captured UI word up (e.g. Scheduled).
    //   'Tap <b>Show</b> now': 'اضغط <b>عرض</b> الآن' inline markup: matched against an element's
    //                                                 inner HTML; attributes are copied from the page.
    // A value may be a plural object { zero, one, two, few, many, other }, picked by {n}.
    const fill = (text, vars) => (vars && typeof text === 'string')
        ? text.replace(/\{(\w+)(?::t)?\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
        : text;
    let pluralAr = null;
    function pluralForm(count) {
        if (state.lang !== 'ar') return Number(count) === 1 ? 'one' : 'other';
        try { pluralAr ??= new Intl.PluralRules('ar'); return pluralAr.select(Number(count)); } catch { return 'other'; }
    }
    const norm = s => String(s).replace(/\s+/g, ' ').trim();
    const pick = (hit, count) => (hit && typeof hit === 'object') ? (count === undefined ? hit.other : (hit[pluralForm(count)] || hit.other)) : hit;

    // Compiled per language on first use: exact map, html map, pattern buckets.
    let compiled = null;
    // A key is an inline-markup sentence only if it contains a real inline tag (not text like "<PC>").
    const HTML_ENTRY = /<\/?(a|strong|b|em|i|span|br|kbd|small|u|bdi|code)>/;
    // Visible text of an inline-markup key, used as a cheap pre-check before serializing an element.
    const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
    const plainOf = html => norm(html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m, e) => ENT[e]));
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function compile() {
        const dict = dictionaries[state.lang];
        const out = { exact: new Map(), html: new Map(), htmlText: new Set(), first: new Map(), last: new Map(), mid: new Map() };
        if (!dict) return out;
        for (const raw of Object.keys(dict)) {
            const value = dict[raw], key = norm(raw);
            if (HTML_ENTRY.test(key)) { out.html.set(htmlKey(key), value); out.htmlText.add(plainOf(key)); continue; }
            out.exact.set(key, value);
            const names = [...key.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
            if (!names.length) continue;
            const parts = key.split(/\{\w+\}/);
            const re = new RegExp('^' + parts.map(escapeRe).reduce((acc, part, i) =>
                acc + (i ? (names[i - 1] === 'n' ? '(-?\\d[\\d.,]*)' : '(.+?)') : '') + part, '') + '$');
            const pat = { re, names, value };
            const head = parts[0].trim().split(' ')[0], tail = parts[parts.length - 1].trim().split(' ').pop();
            const inner = parts.map(x => x.trim()).find(Boolean)?.split(' ')[0];
            const [bucket, word] = head ? [out.first, head] : tail ? [out.last, tail] : inner ? [out.mid, inner] : [null, ''];
            if (!bucket) continue; // a bare "{0}" would match everything
            if (!bucket.has(word)) bucket.set(word, []);
            bucket.get(word).push(pat);
        }
        return out;
    }
    const table = () => (compiled ??= compile());
    function lookup(key) {
        if (state.lang === 'en' || !dictionaries[state.lang]) return undefined;
        return table().exact.get(norm(key));
    }
    // Translate one piece of rendered UI text. Returns undefined when there is no entry.
    function translateText(text) {
        if (state.lang === 'en' || !dictionaries[state.lang]) return undefined;
        const key = norm(text);
        if (!key || !/[A-Za-z]/.test(key)) return undefined;
        const tb = table(), hit = tb.exact.get(key);
        if (hit !== undefined && !(typeof hit === 'string' && /\{\w+\}/.test(key))) return pick(hit);
        const words = key.split(' ');
        const cands = [...(tb.first.get(words[0]) || []), ...(tb.last.get(words[words.length - 1]) || [])];
        if (tb.mid.size && words.length <= 12) for (const w of words) if (tb.mid.has(w)) cands.push(...tb.mid.get(w));
        for (const p of cands) {
            const m = p.re.exec(key);
            if (!m) continue;
            const vars = {}, raw = {};
            p.names.forEach((name, i) => { raw[name] = m[i + 1]; vars[name] = m[i + 1]; });
            const count = 'n' in raw ? Number(String(raw.n).replace(/,/g, '')) : undefined;
            const value = pick(p.value, count);
            if (typeof value !== 'string') return undefined;
            return value.replace(/\{(\w+)(:t)?\}/g, (s, name, tr) => {
                if (!(name in raw)) return s;
                if (!tr) return raw[name];
                const w = tb.exact.get(norm(raw[name]));
                return typeof pick(w) === 'string' ? pick(w) : raw[name];
            });
        }
        return undefined;
    }
    // t('Hello {name}', {name}) -> translated + filled. Falls back to the English key.
    function t(key, vars) {
        const hit = pick(lookup(key), vars && 'n' in vars ? Number(vars.n) : undefined);
        return fill(typeof hit === 'string' && hit ? hit : key, vars);
    }
    // n(count, '{n} task', '{n} tasks'): English picks one/other; Arabic uses the plural entry.
    function n(count, one, other, vars) {
        const all = { n: count, ...(vars || {}) };
        const hit = lookup(other ?? one);
        if (hit && typeof hit === 'object') return fill(pick(hit, count) || other || one, all);
        if (typeof hit === 'string' && hit) return fill(hit, all);
        return fill(Number(count) === 1 || other === undefined ? one : other, all);
    }

    // ----- Rendered markup -----
    // Translates text nodes, a few attributes and inline-markup sentences whose English text has a
    // dictionary entry. Runs on load and on every DOM change (MutationObserver), so app code needs
    // no changes. Never touched: form values, <script>/<style>/<code>/<textarea>/<svg>, and anything
    // inside translate="no" or data-no-i18n (user content: task titles, tags, notes, names, chat).
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'svg', 'SVG', 'NOSCRIPT', 'TEMPLATE']);
    const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'A', 'SPAN', 'BR', 'KBD', 'SMALL', 'U', 'BDI', 'CODE']);
    // User content is never translated. App markup marks it with translate="no"; these known
    // containers are covered here too, so a task titled "Settings" stays "Settings".
    const USER = ['[translate="no"]', '[data-no-i18n]', 'svg', '[contenteditable]', '.task-title', '.tag-chip',
        '.today-path-crumb', '.filter-pill', '.tag-select-pill', '.chat-bubble', '.completed-item-title', '.completed-item-text',
        '.dump-note-body', '.dump-note-header', '.undo-grace-title', '.archive-item-title', '.archive-item-body', '.trash-title',
        '.nlp-chip', '.pro-batch-task-row label', '.pro-file-chip', '.uni-comment', '.uni-card-title', '.uni-member-identity',
        '.uni-title-button', '.uni-task-copy', '.uni-meta-project', '.uni-project-head', '.uni-identity', '.uni-avatar',
        '.uni-catalog-row', '#auditTaskTitle', '.username-display', 'option[value]:not([value=""]):is(select[id*="roject"] option, select[id*="ibling"] option, select[id*="arent"] option, select[id*="ule"] option)'].join(',');
    // Cached per element for one batch of work (DOM can change between batches, so the cache is reset).
    let skipCache = new WeakMap();
    function skipped(el) {
        if (!el) return true;
        let v = skipCache.get(el);
        if (v === undefined) { v = SKIP.has(el.tagName) || Boolean(el.closest?.(USER)); skipCache.set(el, v); }
        return v;
    }
    const htmlKey = html => norm(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(\/?)([a-zA-Z0-9]+)\b[^>]*?(\/?)>/g, (m, close, tag) => '<' + close + tag.toLowerCase() + '>'));
    const written = new WeakMap(); // node -> text we wrote, so our own writes are not re-processed
    let missing = null;            // Set of untranslated strings, when collecting is on
    function noteMissing(text) {
        if (missing && missing.size < 5000) { const k = norm(text); if (k && /[A-Za-z]{2}/.test(k)) missing.add(k); }
    }
    function doText(node) {
        const raw = node.nodeValue;
        // Already-Arabic text (ours, or the user's) is left alone.
        if (!raw || written.get(node) === raw || !/[A-Za-z]/.test(raw) || /[\u0600-\u06FF]/.test(raw) || skipped(node.parentElement)) return 0;
        const hit = translateText(raw);
        if (typeof hit !== 'string' || !hit) { noteMissing(raw); return 0; }
        const out = raw.match(/^\s*/)[0] + hit + raw.match(/\s*$/)[0];
        node.nodeValue = out;
        written.set(node, out);
        return 1;
    }
    function doAttrs(el) {
        let count = 0;
        for (const a of ATTRS) {
            const v = el.getAttribute(a);
            if (!v || !/[A-Za-z]/.test(v)) continue;
            const hit = translateText(v);
            if (typeof hit === 'string' && hit) { el.setAttribute(a, hit); count++; } else noteMissing(v);
        }
        return count;
    }
    // Elements that hold one sentence with inline markup (e.g. "Tap <strong>Show</strong> now").
    function doHtml(el) {
        if (!table().html.size || !el.firstElementChild || !table().htmlText.has(norm(el.textContent)) || skipped(el)) return 0;
        for (const c of el.children) if (!INLINE.has(c.tagName) || c.querySelector('svg,img,input,button,select')) return 0;
        // Only a sentence (its own text has words); a row of separate links is translated piece by piece.
        if (![...el.childNodes].some(c => c.nodeType === 3 && /[A-Za-z]{2}/.test(c.nodeValue))) return 0;
        const value = table().html.get(htmlKey(el.innerHTML));
        if (typeof value !== 'string') return 0;
        // Copy attributes from the page's tags to the dictionary's tags, matched by tag name and order.
        const tpl = document.createElement('template');
        tpl.innerHTML = value;
        const src = {};
        for (const c of el.querySelectorAll('*')) (src[c.tagName] ||= []).push(c);
        for (const c of tpl.content.querySelectorAll('*')) {
            const from = src[c.tagName]?.shift();
            if (from) for (const at of from.attributes) c.setAttribute(at.name, at.value);
        }
        el.replaceChildren(tpl.content);
        for (const tn of textNodes(el)) written.set(tn, tn.nodeValue);
        return 1;
    }
    function textNodes(base) {
        const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT), out = [];
        while (walker.nextNode()) out.push(walker.currentNode);
        return out;
    }
    function translateDom(root) {
        if (state.lang === 'en' || !dictionaries[state.lang] || !root) return 0;
        skipCache = new WeakMap();
        const base = root.nodeType === 1 ? root : root.nodeType === 3 ? null : (root.documentElement || root.body);
        if (root.nodeType === 3) return doText(root);
        if (!base || skipped(base)) return 0;
        let count = 0;
        if (table().html.size) {
            const els = [base, ...base.querySelectorAll('p,li,label,h1,h2,h3,h4,h5,h6,small,span,div,dd,dt,td,th,button,a,summary,strong,em,legend,figcaption')];
            for (const el of els) if (el.firstElementChild && /[A-Za-z]/.test(el.textContent)) count += doHtml(el);
        }
        for (const node of textNodes(base)) count += doText(node);
        const els = base.querySelectorAll(ATTRS.map(a => '[' + a + ']').join(','));
        for (const el of [base, ...els]) if (el.getAttribute && !skipped(el)) count += doAttrs(el);
        return count;
    }
    function observe() {
        if (state.lang === 'en' || typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(records => {
            skipCache = new WeakMap();
            for (const r of records) {
                if (r.type === 'childList') {
                    for (const node of r.addedNodes) {
                        if (node.nodeType === 3) doText(node);
                        else if (node.nodeType === 1) translateDom(node);
                    }
                    if (r.target.nodeType === 1 && table().html.size && r.target.isConnected) doHtml(r.target);
                } else if (r.type === 'characterData') doText(r.target);
                else if (r.type === 'attributes' && r.target.nodeType === 1 && !skipped(r.target)) {
                    const v = r.target.getAttribute(r.attributeName);
                    const hit = v && /[A-Za-z]/.test(v) ? translateText(v) : undefined;
                    if (typeof hit === 'string' && hit && hit !== v) r.target.setAttribute(r.attributeName, hit);
                }
            }
        });
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }
    // Native dialogs take plain strings; translate them the same way.
    function wrapDialogs() {
        if (state.lang === 'en') return;
        for (const name of ['alert', 'confirm', 'prompt']) {
            const orig = window[name];
            if (typeof orig !== 'function') continue;
            window[name] = function (message, ...rest) {
                const text = typeof message === 'string' ? (translateText(message) ?? message) : message;
                return orig.call(window, text, ...rest);
            };
        }
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
        // register('ar', {...}) or register('ar', () => ({...})): a function is only called when the
        // UI is in that language, so English pages never build the Arabic dictionary.
        register(lang, dict) {
            if (!Object.prototype.hasOwnProperty.call(LANGS, lang) || lang === 'en') return false;
            if (typeof dict === 'function') { if (lang !== state.lang) return true; dict = dict(); }
            if (!dict || typeof dict !== 'object') return false;
            dictionaries[lang] = Object.assign(dictionaries[lang] || Object.create(null), dict);
            compiled = null;
            return true;
        },
        translateText,
        USER_SELECTOR: USER,
        // Debug aid: TaskitatorI18n.collectMissing() then .missing() lists untranslated UI text seen.
        collectMissing() { missing ??= new Set(); return true; },
        missing: () => [...(missing || [])],
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
        // Short duration for the UI ('2h 30m' in English). Returns undefined in English so callers keep
        // their own wording; Arabic uses س (hours) and د (minutes).
        duration(minutes) {
            if (state.lang === 'en') return undefined;
            const m = Math.max(0, Math.round(Number(minutes) || 0)), h = Math.floor(m / 60), r = m % 60;
            return h ? (r ? h + 'س ' + r + 'د' : h + 'س') : r + 'د';
        },
        number(value, opts) {
            try { return new Intl.NumberFormat(state.lang === 'en' ? undefined : INTL[state.lang], opts).format(value); }
            catch { return String(value); }
        },
        clockOpts
    };
    window.TaskitatorI18n = api;

    apply();
    try { if (sessionStorage.getItem('taskitator_i18n_debug')) missing = new Set(); } catch {}
    wrapDialogs();
    window.addEventListener('storage', e => {
        if (e.key !== KEY) return;
        const next = read();
        const langChanged = next.lang !== state.lang;
        state = next; apply();
        if (langChanged) { try { location.reload(); } catch {} }
    });
    document.addEventListener('DOMContentLoaded', () => { translateDom(document.documentElement); observe(); });
})();

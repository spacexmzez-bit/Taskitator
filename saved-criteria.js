/* Saved criteria policy (Phase 3.5). One set of limits shared by the browser, the Test lab and the Worker.
   Free: 5 saved criteria, 4 with an exemplar. Pro: 100 and 10. All exemplars together may use 8 MB (before encoding),
   one exemplar at most 4 MB, because they travel inside the synced account snapshot (the Worker accepts 20 MB per sync). */
(function (root) {
    'use strict';
    const MB = 1024 * 1024;
    const POLICY = Object.freeze({ free: Object.freeze({ items: 5, exemplars: 4 }), pro: Object.freeze({ items: 100, exemplars: 10 }), exemplarBytes: 8 * MB, fileBytes: 4 * MB, title: 40 });
    const limits = pro => pro ? POLICY.pro : POLICY.free;
    const list = v => Array.isArray(v) ? v.filter(i => i && typeof i === 'object') : [];
    const bytesOf = i => {
        const e = i && i.has_exemplar && i.exemplar;
        if (!e) return 0;
        const size = Number(e.fileSize);
        return Number.isFinite(size) && size > 0 ? size : Math.floor(String(e.data || '').length * 3 / 4);
    };
    const usage = l => { const a = list(l); return { items: a.length, exemplars: a.filter(i => i.has_exemplar && i.exemplar).length, bytes: a.reduce((n, i) => n + bytesOf(i), 0) }; };
    const mb = n => (n / MB).toFixed(n % MB ? 1 : 0);
    // Can one more criteria (with an exemplar of exemplarBytes, or 0) be saved?  Returns an error text or null.
    function addError(l, pro, exemplarBytes = 0) {
        const L = limits(pro), u = usage(l);
        if (u.items >= L.items) return 'Limit reached: maximum ' + L.items + ' saved criteria. Delete one first.' + (pro ? '' : ' Taskitator Pro allows ' + POLICY.pro.items + '.');
        if (exemplarBytes > 0) {
            if (exemplarBytes > POLICY.fileBytes) return 'Exemplar exceeds the ' + mb(POLICY.fileBytes) + ' MB limit (' + (exemplarBytes / MB).toFixed(2) + ' MB).';
            if (u.exemplars >= L.exemplars) return 'Exemplar limit reached: maximum ' + L.exemplars + ' saved criteria can have attached files.' + (pro ? '' : ' Taskitator Pro allows ' + POLICY.pro.exemplars + '.');
            if (u.bytes + exemplarBytes > POLICY.exemplarBytes) return 'Saved exemplars share ' + mb(POLICY.exemplarBytes) + ' MB. ' + (u.bytes / MB).toFixed(1) + ' MB is used, this file needs ' + (exemplarBytes / MB).toFixed(1) + ' MB more than is left.';
        }
        return null;
    }
    // Worker: a sync may not GROW the list past the limits. Unchanged or shrinking lists always pass (a lapsed Pro keeps what it has).
    function growthError(prev, next, pro) {
        const L = limits(pro), a = usage(prev), b = usage(next);
        if (b.items > L.items && b.items > a.items) return 'Saved criteria are limited to ' + L.items + '.';
        if (b.exemplars > L.exemplars && b.exemplars > a.exemplars) return 'Only ' + L.exemplars + ' saved criteria can have an exemplar.';
        if (b.bytes > POLICY.exemplarBytes && b.bytes > a.bytes) return 'Saved exemplars may use ' + mb(POLICY.exemplarBytes) + ' MB in total.';
        const old = new Map(list(prev).map(i => [i.id, i]));
        for (const i of list(next)) { const o = old.get(i.id); if (bytesOf(i) > POLICY.fileBytes && (!o || bytesOf(o) !== bytesOf(i))) return 'An exemplar can be at most ' + mb(POLICY.fileBytes) + ' MB.'; }
        return null;
    }
    const clean = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, POLICY.title);
    // Rename (free and Pro). Returns a new list; the title is required.
    function rename(l, id, title) {
        const t = clean(title);
        if (!t) throw Error('Please enter a title.');
        if (!list(l).some(i => i.id === id)) throw Error('This saved criteria no longer exists.');
        return list(l).map(i => i.id === id ? { ...i, title: t } : i);
    }
    // Search (Pro): every word must appear in the title or the criteria text.
    function search(l, query) {
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return list(l);
        return list(l).filter(i => { const hay = (String(i.title || '') + ' ' + String(i.criteria || '')).toLowerCase(); return words.every(w => hay.includes(w)); });
    }
    root.TaskitatorSavedCriteria = Object.freeze({ POLICY, limits, usage, bytesOf, addError, growthError, rename, search, clean });
})(typeof window === 'undefined' ? globalThis : window);

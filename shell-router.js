/* Phase 3.0 single-page shell.
   index.html holds every in-app view, so switching between them no longer loads a new page (no new document,
   no second sign-in check, no re-boot of the sync engine). Each view is a [data-shell-view] container; the URL hash
   picks one:
     #today #general          Tasks (handled by app.js as before)
     #calendar #projects #stats #trash #blocker-guide
     #study-plans #sleep #help (and #help-<section> for a section of Help)
   Unknown hashes keep the Tasks view, so app links such as #key-verification=... still work.
   Old addresses (components.html?view=..., sleep.html, study-plans.html, help.html) redirect here.
   Universe, Settings, sign-in and the legal pages stay separate pages. */
(function () {
    'use strict';
    if (typeof document === 'undefined') return;
    const VIEWS = {
        tasks: { title: '', doc: 'Taskitator' },
        projects: { title: 'Projects Workspace', doc: 'Projects — Taskitator' },
        calendar: { title: 'Task Calendar', doc: 'Calendar — Taskitator' },
        stats: { title: 'Productivity Statistics', doc: 'Stats — Taskitator' },
        trash: { title: 'Trash & Recovery', doc: 'Trash — Taskitator' },
        'blocker-guide': { title: 'Phone Blocker Setup Guide', doc: 'Phone blocker guide — Taskitator' },
        'study-plans': { title: '', doc: 'Study plans — Taskitator' },
        sleep: { title: '', doc: 'Sleep Lock — Taskitator' },
        help: { title: '', doc: 'Help — Taskitator' }
    };
    const ALIASES = { guide: 'blocker-guide', blocker_guide: 'blocker-guide', study_plans: 'study-plans', plans: 'study-plans' };
    const GUIDE_ANCHORS = new Set(['bridge-download', 'bridge-manual', 'app-blocker-manual']);
    const canonicalView = key => Object.hasOwn(ALIASES, key) ? ALIASES[key] : key;
    function hashKey() {
        const hash = location.hash.slice(1);
        try { return decodeURIComponent(hash).toLowerCase(); }
        catch (_) { return hash.toLowerCase(); }
    }
    function routeOf(key) {
        if (key.startsWith('help-')) return { view: 'help', anchor: key };
        if (GUIDE_ANCHORS.has(key)) return { view: 'blocker-guide', anchor: key };
        const view = canonicalView(key);
        return Object.hasOwn(VIEWS, view) ? { view } : { view: 'tasks' };
    }

    // Old ?view=... addresses (index.html?view=today from Universe, redirected components.html links) become hashes.
    (function legacyQuery() {
        let params; try { params = new URLSearchParams(location.search); } catch (_) { return; }
        const raw = String(params.get('view') || '').toLowerCase();
        const key = canonicalView(raw);
        if (key !== 'today' && key !== 'general' && !Object.hasOwn(VIEWS, key)) return;
        params.delete('view');
        const rest = params.toString();
        const hash = location.hash && location.hash !== '#' ? location.hash : '#' + key;
        try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + hash); } catch (_) {}
    })();

    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const scroll = Object.create(null);
    let current = null, currentKey = '', helpReturn = '#today';
    // Each old page load pulled the latest data from the cloud. Keep that freshness without a reload: switching views
    // asks for the same page-load sync, at most once a minute (the first one happens at sign-in, in app.js).
    const PULL_EVERY_MS = 60000;
    let lastPull = Date.now();
    function freshen() {
        const engine = window.SyncEngine;
        if (Date.now() - lastPull < PULL_EVERY_MS || !engine?.isConfigured?.() || window.TaskitatorOffline?.active) return;
        lastPull = Date.now();
        Promise.resolve(engine.syncNow({ origin: 'page-load' })).catch(() => {});
    }

    function activeLinks(view) {
        const tasksKey = hashKey() === 'general' ? 'general' : 'today';
        document.querySelectorAll('#drawerNavLinks a').forEach(a => {
            const shell = a.getAttribute('data-shell-link');
            if (shell) a.classList.toggle('active', shell === view);
            else if (a.id === 'navLinkToday') a.classList.toggle('active', view === 'tasks' && tasksKey === 'today');
            else if (a.id === 'navLinkGeneral') a.classList.toggle('active', view === 'tasks' && tasksKey === 'general');
        });
    }
    function closeInside(el) {
        if (!el) return;
        el.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch (_) {} });
        if (el.getAttribute('data-shell-view') === 'projects') document.getElementById('projectModal')?.classList.remove('open', 'active');
    }
    function hooks(view) {
        try {
            if (view === 'tasks') window.dispatchEvent(new CustomEvent('taskitator-tasks-updated', { detail: { source: 'shell' } }));
            else if (view === 'projects') window.refreshCurrentProjectView?.();
            else if (view === 'calendar') window.renderCalendarView?.();
            else if (view === 'stats') window.renderStats?.();
            else if (view === 'trash') window.renderTrashView?.();
            else if (view === 'study-plans') window.TaskitatorStudyPlansView?.show();
            else if (view === 'sleep') window.TaskitatorSleepView?.show();
        } catch (err) { console.error('Taskitator view could not refresh', view, err); }
    }
    function show() {
        const key = hashKey(), route = routeOf(key), view = route.view, leaving = current;
        if (leaving && leaving !== view) {
            scroll[leaving] = window.scrollY || 0;
            const old = document.querySelector('[data-shell-view="' + leaving + '"]');
            closeInside(old);
            if (leaving === 'study-plans') window.TaskitatorStudyPlansView?.hide?.();
            if (leaving === 'sleep') window.TaskitatorSleepView?.hide?.();
        }
        if (view === 'help' && leaving !== 'help') {
            if (leaving) {
                const previous = routeOf(currentKey);
                const returnKey = previous.view === 'tasks' ? (currentKey === 'general' ? 'general' : 'today') : (previous.anchor || previous.view);
                helpReturn = '#' + returnKey;
            }
            else if (document.referrer) {
                try {
                    const referrer = new URL(document.referrer);
                    if (referrer.origin === location.origin && referrer.pathname !== location.pathname && !referrer.pathname.endsWith('/help.html')) helpReturn = referrer.href;
                } catch (_) {}
            }
            document.getElementById('helpReturn')?.setAttribute('href', helpReturn);
        }
        document.querySelectorAll('.shell-view[data-shell-view]').forEach(el => { el.hidden = el.getAttribute('data-shell-view') !== view; });
        document.documentElement.setAttribute('data-shell', view); // not data-shell-view: <html> must never match the view selector
        const info = VIEWS[view];
        const title = document.getElementById('componentPageTitle');
        if (title) { title.textContent = info.title; title.hidden = !info.title; }
        const row = document.getElementById('shellTitleRow');
        if (row) row.hidden = !info.title;
        const jump = document.getElementById('todayJumpBtn');
        if (jump) jump.style.display = view === 'calendar' ? 'inline-flex' : 'none';
        document.title = info.doc;
        activeLinks(view);
        const changed = leaving !== view;
        current = view;
        currentKey = key;
        if (changed) hooks(view);
        if (changed && leaving) freshen();
        const target = route.anchor && document.getElementById(route.anchor);
        if (target) requestAnimationFrame(() => { if (hashKey() === key) target.scrollIntoView({ block: 'start' }); });
        else if (changed || view === 'help' || view === 'blocker-guide') {
            const y = scroll[view] || 0;
            requestAnimationFrame(() => { if (hashKey() === key) window.scrollTo(0, y); });
        }
        if (changed) window.dispatchEvent(new CustomEvent('taskitator-view-changed'));
    }

    window.TaskitatorShell = Object.freeze({
        views: Object.freeze(Object.keys(VIEWS)),
        current: () => current,
        key: hashKey,
        go(view) { const v = canonicalView(view); location.hash = v === 'tasks' ? '#today' : '#' + v; },
        routeOf
    });
    window.addEventListener('hashchange', show);
    // After a pull, redraw the open view (app.js redraws Tasks itself).
    window.addEventListener('taskitator-page-load-synced', () => { if (current && current !== 'tasks' && current !== 'sleep') hooks(current); });
    window.addEventListener('taskitator-reconnected', () => { if (current === 'sleep' || current === 'study-plans') hooks(current); });
    // app.js marks Today/General active on sign-in; correct the drawer for other views afterwards.
    window.addEventListener('taskitator-auth-ready', () => activeLinks(current || routeOf(hashKey()).view));
    show();
})();

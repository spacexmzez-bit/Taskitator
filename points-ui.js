/* Phase 7.0: the points & streak strip on Today / General Tasks and its details panel.
   The Worker awards points during sync (points.js); this file only shows the latest summary it returned. */
(() => {
    'use strict';
    if (typeof document === 'undefined') return;
    const P = window.TaskitatorPoints;
    const CACHE = 'taskitator_points_cache', REFRESH_MS = 60000;
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const t = s => window.TaskitatorI18n?.translateText?.(s) || s;
    const owner = () => window.TaskitatorAuth?.userId || '';
    let data = null, lastFetch = 0;

    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function icon(key) { const I = window.TaskitatorIcons; const s = el('span', 'pts-ic'); s.setAttribute('aria-hidden', 'true'); if (I?.has(key)) s.append(I.node(key)); return s; }
    const num = n => (window.TaskitatorI18n?.number?.(n)) ?? String(n);

    function readCache() {
        try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); return c && c.owner === owner() ? c.data : null; } catch { return null; }
    }
    function writeCache(d) { try { localStorage.setItem(CACHE, JSON.stringify({ owner: owner(), data: d, at: Date.now() })); } catch { /* storage full */ } }
    const valid = d => d && typeof d === 'object' && Number.isFinite(d.total) && d.rank && typeof d.rank.name === 'string';

    function progress(d) {
        const r = d.rank;
        if (r.next_min == null) return { pct: 100, left: 0 };
        const span = r.next_min - r.min;
        return { pct: Math.max(0, Math.min(100, Math.round((d.total - r.min) / span * 100))), left: r.next_min - d.total };
    }

    function renderStrip() {
        const strip = document.getElementById('pointsStrip');
        if (!strip) return;
        if (!valid(data)) { strip.hidden = true; return; }
        strip.hidden = false;
        strip.replaceChildren();
        const streak = el('span', 'pts-streak' + (data.today.done ? ' is-lit' : '') + (data.today.free ? ' is-free' : ''));
        streak.append(icon('flame'), el('b', '', num(data.streak)));
        const rank = el('span', 'pts-rank');
        rank.append(icon('star'), el('b', '', t(data.rank.name)), el('span', 'pts-total', num(data.total) + ' ' + t('pts')));
        const bar = el('span', 'pts-bar'); bar.setAttribute('aria-hidden', 'true');
        const fill = el('i'); fill.style.width = progress(data).pct + '%'; bar.append(fill);
        strip.append(streak, rank, bar);
        const label = data.today.free ? t('Free day') : data.today.done ? t('Streak kept today') : t('Finish one task today to keep your streak');
        strip.setAttribute('aria-label', `${t('Streak')}: ${data.streak}. ${t('Rank')}: ${t(data.rank.name)}, ${data.total} ${t('points')}. ${label}. ${t('Open points and streak')}`);
        strip.title = label;
    }

    function update(d, fromSync) {
        if (!valid(d)) return;
        const before = data || readCache();
        data = d; writeCache(d); renderStrip();
        if (document.getElementById('pointsModal')?.classList.contains('open')) openPanel();
        if (!fromSync || !before) return;
        const notify = window.TaskitatorNotify;
        if (typeof notify !== 'function') return;
        if (d.rank.index > (before.rank?.index ?? 0)) notify(t('New rank: {0}!').replace('{0}', t(d.rank.name)), 'success');
        else if (d.gained > 0) notify(t('+{0} points').replace('{0}', num(d.gained)), 'success');
        if (d.streak > (before.streak || 0) && d.streak > 1 && d.today.done && !(before.today?.done && before.today?.date === d.today.date))
            notify(t('{0}-day streak').replace('{0}', num(d.streak)), 'success');
    }

    async function refresh(force) {
        const auth = window.TaskitatorAuth;
        if (!auth?.api || window.TaskitatorOffline?.active || !owner()) return;
        if (!force && Date.now() - lastFetch < REFRESH_MS) return;
        lastFetch = Date.now();
        try { const r = await auth.api('/points'); update(r?.points, false); }
        catch { /* older Worker or offline: keep the cached copy */ }
    }

    function row(label, value) { const r = el('div', 'pts-row'); r.append(el('span', '', label), el('b', '', value)); return r; }

    function openPanel() {
        if (!valid(data)) return;
        let overlay = document.getElementById('pointsModal');
        if (!overlay) {
            overlay = el('div', 'modal-overlay'); overlay.id = 'pointsModal';
            overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'pointsModalTitle');
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            document.body.append(overlay);
        }
        const box = el('div', 'modal-box pts-box');
        const head = el('div', 'modal-head-row');
        const h = el('h3', '', t('Points & streak')); h.id = 'pointsModalTitle';
        const x = el('button', 'icon-btn modal-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', t('Close')); x.onclick = close;
        head.append(h, x);

        const p = progress(data);
        const hero = el('div', 'pts-hero');
        const rk = el('div', 'pts-hero-rank'); rk.append(icon('star'), el('b', '', t(data.rank.name)));
        const bar = el('div', 'pts-bar pts-bar-lg'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(p.pct));
        const fill = el('i'); fill.style.width = p.pct + '%'; bar.append(fill);
        const next = data.rank.next ? t('{0} more points to {1}').replace('{0}', num(p.left)).replace('{1}', t(data.rank.next)) : t('Top rank reached');
        hero.append(rk, el('p', 'pts-big', num(data.total) + ' ' + t('points')), bar, el('p', 'pts-sub', next));

        const st = el('div', 'pts-streakbox');
        st.append(row(t('Current streak'), num(data.streak) + ' ' + t(data.streak === 1 ? 'day' : 'days')), row(t('Best streak'), num(data.best) + ' ' + t(data.best === 1 ? 'day' : 'days')),
            row(t('Today'), data.today.free ? t('Free day (no points)') : num(data.today.points) + ' / ' + num(data.cap) + ' ' + t('points') + ' · ' + num(data.today.count) + ' ' + t(data.today.count === 1 ? 'task' : 'tasks')));
        if (!data.today.free && !data.today.done) st.append(el('p', 'pts-hint', t('Finish one task before your day ends to keep your streak.')));

        const week = el('div', 'pts-week'); week.setAttribute('aria-label', t('Last 7 days'));
        for (const d of data.week || []) {
            const c = el('div', 'pts-day' + (d.count ? ' is-done' : '') + (d.free ? ' is-free' : '') + (d.date === data.today.date ? ' is-today' : ''));
            c.append(el('span', 'pts-day-name', t(SHORT[new Date(d.date + 'T00:00:00Z').getUTCDay()])), el('b', '', d.free ? '—' : num(d.points)));
            c.title = d.date + (d.free ? ' · ' + t('Free day') : '') + ' · ' + d.count + ' ' + t(d.count === 1 ? 'task' : 'tasks');
            week.append(c);
        }

        const free = el('div', 'pts-free');
        const names = list => list.length ? list.map(i => t(DAYS[i])).join(', ') : t('None');
        free.append(el('h4', '', t('Free days')), el('p', '', names(data.free_days || [])));
        if (data.free_next) free.append(el('p', 'pts-sub', t('From {0}: {1}').replace('{0}', data.free_next.from).replace('{1}', names(data.free_next.days))));
        const link = el('a', 'pts-link', t('Change free days in Settings → Day & week')); link.href = 'settings.html#schedule';
        free.append(link);

        const how = el('details', 'pts-how');
        how.append(el('summary', '', t('How points work')));
        const ul = el('ul');
        ['Completing a task earns 1–5 points: your highest priority gives 5, your lowest 1, no priority 1.',
         'Only the task you tap counts. Subtasks finished with their parent earn nothing.',
         'Each task earns once. Reopening and completing again adds nothing.',
         'Up to 150 points a day. Points count on the day you complete a task, not its due date.',
         'Free days earn no points and never break your streak.',
         'Points arrive when Taskitator syncs. Offline completions count for up to 7 days.'].forEach(s => ul.append(el('li', '', t(s))));
        const ranks = el('ol', 'pts-ranks');
        P?.RANKS.forEach((r, i) => { const li = el('li', i === data.rank.index ? 'is-current' : i < data.rank.index ? 'is-past' : ''); li.append(el('span', '', t(r.name)), el('b', '', num(r.min))); ranks.append(li); });
        how.append(ul, el('h4', '', t('Ranks')), ranks);

        const friends = el('a', 'pts-link', t('Friends leaderboard →')); friends.href = '#friends'; friends.addEventListener('click', close);
        box.append(head, hero, st, week, free, friends, how);
        if (window.TaskitatorOffline?.active) box.append(el('p', 'pts-hint', t('Offline: points update when you reconnect and sync.')));
        overlay.replaceChildren(box);
        overlay.classList.add('open');
        x.focus({ preventScroll: true });
    }
    function close() { document.getElementById('pointsModal')?.classList.remove('open'); document.getElementById('pointsStrip')?.focus({ preventScroll: true }); }

    document.addEventListener('click', e => { if (e.target.closest?.('#pointsStrip')) openPanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('pointsModal')?.classList.contains('open')) close(); });
    window.addEventListener('taskitator-points', e => update(e.detail, true));
    window.addEventListener('taskitator-auth-ready', () => { data = readCache(); renderStrip(); refresh(true); });
    window.addEventListener('taskitator-view-changed', () => { if (window.TaskitatorShell?.current() === 'tasks') refresh(false); });
    window.addEventListener('taskitator-reconnected', () => refresh(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });

    window.TaskitatorPointsUI = Object.freeze({ update, refresh, open: openPanel, current: () => data });
})();

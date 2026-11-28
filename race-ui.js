/* Phase 7.6: the challenge race bar at the bottom of Today (index.html #today only). Server: GET /friends/challenges/live
   (friends-backend.js challengeLive; scores are the Worker's, cached 45 s per challenge).
   - Time: badges spread between the last and the first place (the range of scores, at least MIN_SPAN wide so a
     1-point lead doesn't fill the track), with a buffer at each end. Amount: start and finish flags; a badge sits at
     score / goal, so one step of a 4-step goal moves it much further than one step of a 20-step goal.
   - Shown only while Animations allow it (Settings → Animations & effects → Challenge race; off in Reduced and Static).
   - Minimize hides it under a small button at the bottom-left (bottom-right in Arabic); the choice is remembered.
   - Refreshes every 60 s while Today is visible, when you come back to it, and 5 s after a sync that earned points. */
(() => {
    'use strict';
    if (typeof document === 'undefined') return;
    const COLORS = Object.freeze([
        { hex: '#f87171', name: 'Red' }, { hex: '#fb923c', name: 'Orange' }, { hex: '#facc15', name: 'Yellow' }, { hex: '#4ade80', name: 'Green' },
        { hex: '#2dd4bf', name: 'Teal' }, { hex: '#60a5fa', name: 'Blue' }, { hex: '#a78bfa', name: 'Violet' }, { hex: '#f472b6', name: 'Pink' }
    ].map(Object.freeze));
    window.TaskitatorRaceColors = COLORS;
    const POLL_MS = 60000, AFTER_SYNC_MS = 5000, FRESH_MS = 30000, BUF = 8, LANE_GAP = 22, MAX_LANES = 3;
    const MIN_SPAN = { points: 5, tasks: 2, streak: 2 };
    const MIN_KEY = 'taskitator_race_min', CACHE = 'taskitator_race_cache';
    const t = s => window.TaskitatorI18n?.translateText?.(s) || s;
    const tf = (tpl, ...vals) => { const s = vals.reduce((acc, v, i) => acc.replace('{' + i + '}', v), tpl); return window.TaskitatorI18n?.translateText?.(s) || s; };
    const num = n => (window.TaskitatorI18n?.number?.(n)) ?? String(n);
    const owner = () => window.TaskitatorAuth?.userId || '';
    const UNIT = { points: '{0} pts', tasks: '{0} tasks', streak: '{0} days' }, ONE = { points: '{0} pt', tasks: '{0} task', streak: '{0} day' };
    const METRIC = { points: 'Points', tasks: 'Tasks', streak: 'Streak' };
    let data = null, lastFetch = 0, loading = false, timer = 0, soon = 0, dock = null, fab = null;
    const cards = new Map();

    const ic = key => { const I = window.TaskitatorIcons, s = document.createElement('span'); s.className = 'tk-inline-ic'; s.setAttribute('aria-hidden', 'true'); if (I?.has?.(key)) s.append(I.node(key)); return s; };
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    const enabled = () => { try { return window.TaskitatorAppearance?.motionAllowed?.('race') === true; } catch { return false; } };
    const onToday = () => window.TaskitatorShell?.current?.() === 'tasks' && window.TaskitatorShell?.key?.() !== 'general';
    const minimized = () => { try { return localStorage.getItem(MIN_KEY) === '1'; } catch { return false; } };
    const setMin = on => { try { on ? localStorage.setItem(MIN_KEY, '1') : localStorage.removeItem(MIN_KEY); } catch { /* full */ } };
    const offline = () => Boolean(window.TaskitatorOffline?.active);
    function readCache() { try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); return c && c.owner === owner() ? c.data : null; } catch { return null; } }
    function writeCache(d) { try { localStorage.setItem(CACHE, JSON.stringify({ owner: owner(), data: d })); } catch { /* full */ } }

    // Badge label: "You", or the username cut to 5 characters + "…" when it is longer than 7.
    function short(name) { const a = Array.from(String(name || '')); return a.length > 7 ? a.slice(0, 5).join('') + '…' : a.join(''); }
    const unit = (metric, n) => tf((n === 1 ? ONE : UNIT)[metric], num(n));
    const racers = c => c.members.filter(m => m.state === 'in' || m.state === 'left');

    // Where each racer sits on the track, in percent (BUF … 100 - BUF).
    function positions(c) {
        const list = racers(c), out = new Map();
        if (c.status === 'pending' || !list.length) { for (const m of list) out.set(m.username, BUF); return out; }
        if (c.type === 'amount') {
            for (const m of list) out.set(m.username, BUF + (100 - 2 * BUF) * Math.min(1, Math.max(0, m.main / (c.target || 1))));
            return out;
        }
        const mains = list.map(m => m.main), lo = Math.min(...mains), hi = Math.max(...mains);
        const span = Math.max(hi - lo, MIN_SPAN[c.metric] || 2);
        for (const m of list) out.set(m.username, BUF + (100 - 2 * BUF) * ((m.main - lo) / span));
        return out;
    }
    // Overlapping badges stack in lanes (greedy, left to right).
    function lanes(pos) {
        const order = [...pos.entries()].sort((a, b) => a[1] - b[1]), last = [], out = new Map();
        for (const [k, x] of order) {
            let lane = last.findIndex(v => x - v >= LANE_GAP);
            if (lane < 0) lane = last.length < MAX_LANES ? last.length : last.indexOf(Math.min(...last));
            last[lane] = x; out.set(k, lane);
        }
        return { map: out, count: Math.max(1, last.length) };
    }
    function leader(c) {
        if (c.status === 'pending') return null;
        if (c.status === 'finished') return c.result?.winners?.length === 1 ? c.result.winners[0] : null;
        const list = racers(c).filter(m => m.state === 'in');
        if (!list.length) return null;
        const top = list[0]; // the server sends members in standing order
        if (c.type === 'amount' && top.reached_at) return top.username;
        if (!(top.main > 0) || list.slice(1).some(m => m.main === top.main && (c.metric !== 'streak' || m.second === top.second))) return null;
        return top.username;
    }
    function when(c) {
        if (c.status === 'pending') return t('Waiting to start');
        if (c.status === 'finished') {
            const o = c.result?.outcome;
            return o === 'win' ? t('You won') : o === 'draw' ? t('Draw') : c.result?.winners?.length ? tf('{0} won', c.result.winners.map(n => '@' + n).join(', ')) : t('Finished');
        }
        if (c.today < c.start) return tf('Starts {0}', c.start.slice(5));
        const left = Math.max(0, Math.round((Date.parse(c.end) - Date.parse(c.today)) / 86400000));
        return left ? tf('{0} days left', num(left + 1)) : t('Last day');
    }
    function title(c) {
        return c.type === 'amount' ? tf('First to {0}', unit(c.metric, c.target)) : t(METRIC[c.metric]) + ' · ' + tf('{0} days', num(c.days));
    }

    function ensureDock() {
        if (dock && document.contains(dock)) return dock;
        const list = document.getElementById('taskListContainer');
        if (!list) return null;
        dock = el('section', 'race-dock'); dock.id = 'raceDock'; dock.hidden = true; dock.setAttribute('aria-label', t('Challenges'));
        const head = el('div', 'race-head');
        const link = el('a', 'race-h', t('Challenges')); link.href = '#friends';
        const min = el('button', 'race-min', '–'); min.type = 'button'; min.setAttribute('aria-label', t('Minimize challenges')); min.title = t('Minimize challenges');
        min.addEventListener('click', () => { setMin(true); render(); fab?.focus(); });
        head.append(link, min);
        dock.append(head, el('div', 'race-cards'));
        list.after(dock);
        fab = el('button', 'race-fab'); fab.id = 'raceFab'; fab.type = 'button'; fab.hidden = true;
        fab.setAttribute('aria-label', t('Show challenges')); fab.title = t('Show challenges');
        fab.append(ic('goal'));
        fab.append(el('b', 'race-fab-n'));
        fab.addEventListener('click', () => { setMin(false); render(); requestAnimationFrame(() => dock?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); });
        document.body.append(fab);
        return dock;
    }

    function card(c) {
        let k = cards.get(c.id);
        if (!k) {
            const node = el('article', 'race-card');
            const head = el('header', 'race-card-head');
            const name = el('b', 'race-title'), prize = el('span', 'race-prize'), state = el('span', 'race-when');
            head.append(name, prize, state);
            const track = el('div', 'race-track'); track.setAttribute('role', 'img');
            track.append(el('span', 'race-line'), el('span', 'race-flag is-start'), el('span', 'race-flag is-end'), el('span', 'race-ticks'));
            node.append(head, track);
            k = { node, name, prize, state, track, ticks: track.querySelector('.race-ticks'), badges: new Map() };
            cards.set(c.id, k);
        }
        k.node.className = 'race-card is-' + c.status + ' is-' + c.type;
        k.name.textContent = title(c);
        k.prize.hidden = !c.prize; k.prize.replaceChildren(); if (c.prize) { k.prize.append(ic('star'), el('bdi', '', c.prize)); k.prize.title = t('Prize (just text; Taskitator doesn’t handle it)'); }
        k.state.textContent = when(c);
        // Amount: one tick per step when there are 20 steps or fewer.
        k.ticks.replaceChildren();
        if (c.type === 'amount' && c.target <= 20) for (let i = 1; i < c.target; i++) { const s = el('i'); s.style.insetInlineStart = (BUF + (100 - 2 * BUF) * i / c.target) + '%'; k.ticks.append(s); }
        const pos = positions(c), { map: lane, count } = lanes(pos), lead = leader(c);
        k.track.style.setProperty('--lanes', String(count));
        const seen = new Set(), say = [];
        for (const m of racers(c)) {
            seen.add(m.username);
            let b = k.badges.get(m.username);
            const fresh = !b;
            if (fresh) {
                b = el('span', 'race-badge'); b.append(el('i', 'race-dot'), el('b', 'race-name'), el('em', 'race-score'));
                b.style.setProperty('--x', BUF + '%');
                k.badges.set(m.username, b); k.track.append(b);
            }
            b.className = 'race-badge' + (m.me ? ' is-me' : '') + (m.state === 'left' ? ' is-out' : '') + (lead === m.username ? ' is-lead' : '');
            b.style.setProperty('--c', COLORS[m.color]?.hex || '#94a3b8');
            b.style.setProperty('--lane', String(lane.get(m.username) || 0));
            const nm = b.querySelector('.race-name'); nm.replaceChildren(); if (lead === m.username) nm.append(ic('flame')); nm.append(document.createTextNode(m.me ? t('You') : short(m.username)));
            b.querySelector('.race-score').textContent = c.status === 'pending' ? '' : num(m.main);
            b.title = (m.me ? t('You') : '@' + m.username) + (c.status === 'pending' ? '' : ' · ' + unit(c.metric, m.main)) + (m.state === 'left' ? ' · ' + t('forfeited') : '');
            const x = pos.get(m.username) ?? BUF;
            if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => b.style.setProperty('--x', x + '%'))); // slide in from the start
            else b.style.setProperty('--x', x + '%');
            say.push((m.me ? t('You') : '@' + m.username) + ' ' + (c.status === 'pending' ? '' : unit(c.metric, m.main)) + (lead === m.username ? ' (' + t('leading') + ')' : ''));
        }
        for (const [name, b] of k.badges) if (!seen.has(name)) { b.remove(); k.badges.delete(name); }
        k.track.setAttribute('aria-label', title(c) + '. ' + say.join(', '));
        return k.node;
    }

    function render() {
        const d = ensureDock();
        if (!d) return;
        const list = data?.challenges || [];
        const show = enabled() && onToday() && Boolean(owner()) && list.length > 0;
        const min = minimized();
        d.hidden = !show || min;
        if (fab) { fab.hidden = !show || !min; fab.querySelector('.race-fab-n').textContent = list.length > 1 ? num(list.length) : ''; }
        if (!show) return;
        d.classList.toggle('is-stale', offline());
        const box = d.querySelector('.race-cards'), keep = new Set(list.map(c => c.id));
        for (const [id, k] of cards) if (!keep.has(id)) { k.node.remove(); cards.delete(id); }
        list.forEach((c, i) => { const n = card(c); if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null); });
    }

    async function refresh(force) {
        if (!owner() || !window.TaskitatorAuth?.api) return;
        if (!enabled() || (!force && Date.now() - lastFetch < FRESH_MS) || loading) { render(); return; }
        if (offline()) { render(); return; }
        loading = true;
        try {
            const r = await window.TaskitatorAuth.api('/friends/challenges/live');
            if (r && Array.isArray(r.challenges)) { data = r; writeCache(r); }
            lastFetch = Date.now();
        } catch { /* keep the last copy */ }
        finally { loading = false; }
        render();
    }
    function tick() {
        clearInterval(timer); timer = 0;
        if (!enabled() || !onToday()) return;
        timer = setInterval(() => { if (document.visibilityState === 'visible' && onToday()) refresh(true); }, POLL_MS);
    }
    function wake() { if (!data) data = readCache(); render(); tick(); if (onToday() && document.visibilityState === 'visible') refresh(false); }

    window.addEventListener('taskitator-auth-ready', () => { data = readCache(); wake(); });
    window.addEventListener('taskitator-view-changed', wake);
    window.addEventListener('hashchange', () => setTimeout(wake, 0)); // Today ⇄ General doesn't change the shell view
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    window.addEventListener('taskitator-appearance', wake);
    window.addEventListener('taskitator-reconnected', () => refresh(true));
    // Your own badge moves a few seconds after a sync that earned points (the Worker logs it during that sync).
    let lastCount = null;
    window.addEventListener('taskitator-points', e => {
        const count = e.detail?.today?.count, more = Number.isFinite(count) && lastCount !== null && count > lastCount;
        lastCount = Number.isFinite(count) ? count : lastCount;
        if (!(e.detail?.gained > 0 || more) || !(data?.challenges || []).some(c => c.status === 'active')) return;
        clearTimeout(soon); soon = setTimeout(() => refresh(true), AFTER_SYNC_MS);
    });

    window.TaskitatorRace = Object.freeze({ refresh: () => refresh(true), current: () => data, _positions: positions, _lanes: lanes, _short: short, _leader: leader });
})();

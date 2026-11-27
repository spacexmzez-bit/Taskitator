/* Phase 7.0: the Friends view (#friends) of the index.html shell. Server: friends-backend.js (/friends…).
   Friends see each other's points, rank, streak and whether today is done. Never tasks. */
(() => {
    'use strict';
    if (typeof document === 'undefined') return;
    const t = s => window.TaskitatorI18n?.translateText?.(s) || s;
    const num = n => (window.TaskitatorI18n?.number?.(n)) ?? String(n);
    const owner = () => window.TaskitatorAuth?.userId || '';
    const SEEN = 'taskitator_friends_seen';
    let data = null, board = 'all', busy = false, loadedAt = 0, collabOpen = false;
    const isPro = () => { try { return window.TaskitatorTier?.get().tier === 'pro'; } catch { return false; } };

    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function icon(key) { const I = window.TaskitatorIcons, s = el('span', 'fr-ic'); s.setAttribute('aria-hidden', 'true'); if (I?.has(key)) s.append(I.node(key)); return s; }
    function btn(text, onClick, cls = 'icon-btn') { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; }
    const notify = (m, type) => window.TaskitatorNotify?.(m, type);
    const confirm = o => (typeof window.TaskitatorConfirm === 'function' ? window.TaskitatorConfirm(o) : Promise.resolve(window.confirm(o.message || o.title)));
    const root = () => document.getElementById('friendsRoot');

    async function api(path, body) {
        const auth = window.TaskitatorAuth;
        if (!auth?.api) throw new Error(t('Sign in to use friends.'));
        return auth.api(path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    }
    async function load(quiet) {
        if (window.TaskitatorOffline?.active) { data = null; render(); return; }
        try { data = await api('/friends'); loadedAt = Date.now(); afterLoad(); }
        catch (e) { if (!quiet) { data = { error: e.message }; } }
        render();
    }
    function seen() { try { const s = JSON.parse(localStorage.getItem(SEEN) || 'null'); return s && s.owner === owner() ? s : { owner: owner(), cheer: 0 }; } catch { return { owner: owner(), cheer: 0 }; } }
    function afterLoad() {
        if (!data || data.error) return;
        badge(data.incoming?.length || 0);
        const s = seen(), fresh = (data.cheers || []).filter(c => c.at > s.cheer);
        if (fresh.length) {
            notify(fresh.length === 1 ? t('{0} cheered you on!').replace('{0}', fresh[0].username) : t('{0} friends cheered you on!').replace('{0}', num(fresh.length)), 'success');
            s.cheer = Math.max(...fresh.map(c => c.at));
            try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch { /* full */ }
        }
    }
    function badge(n) { document.querySelectorAll('[data-friends-count]').forEach(b => { b.textContent = n ? ' ' + num(n) : ''; b.hidden = !n; }); }

    async function act(path, body, okText) {
        if (busy) return; busy = true;
        try { const r = await api('/friends/' + path, body); if (okText) notify(t(okText), 'success'); await load(true); return r; }
        catch (e) { notify(e.message, 'error'); }
        finally { busy = false; }
    }

    function section(parent, title, sub) {
        const s = el('section', 'fr-card'); const h = el('h2', '', t(title)); s.append(h);
        if (sub) s.append(el('p', 'fr-sub', t(sub)));
        parent.append(s); return s;
    }
    function streakChip(n, lit) { const s = el('span', 'fr-streak' + (lit ? ' is-lit' : '')); s.append(icon('flame'), el('b', '', num(n))); s.title = t('Streak'); return s; }

    function render() {
        const host = root(); if (!host) return;
        host.replaceChildren();
        const head = el('div', 'fr-head'); head.append(el('h1', '', t('Friends'))); host.append(head);
        if (window.TaskitatorOffline?.active) { host.append(el('p', 'fr-note', t('Friends need a connection. You’re offline right now.'))); return; }
        if (!data) { host.append(el('p', 'fr-sub', t('Loading…'))); return; }
        if (data.error) { const p = el('p', 'fr-note', data.error); host.append(p, btn(t('Try again'), () => load())); return; }

        // You + add a friend
        const you = section(host, 'Add a friend', 'Type their exact Taskitator username. Friends see each other’s points, rank and streak, never your tasks.');
        if (!data.me.username) {
            const warn = el('p', 'fr-note', t('Set a username first, so people know who the request is from and can find you.'));
            you.append(warn, btn(t('Set username'), () => document.getElementById('accountUsernameBtn')?.click()));
        } else you.append(el('p', 'fr-sub', t('Your username: @{0}').replace('{0}', data.me.username)));
        const form = el('form', 'fr-add');
        const input = el('input'); input.type = 'text'; input.placeholder = t('Username'); input.autocomplete = 'off'; input.maxLength = 21; input.setAttribute('aria-label', t('Friend’s username'));
        const send = el('button', 'icon-btn btn-primary', t('Send request')); send.type = 'submit';
        form.append(input, send);
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const v = input.value.trim(); if (!v) return;
            const r = await act('request', { username: v });
            if (r?.status === 'friends') notify(t('You’re now friends.'), 'success');
            else if (r?.status === 'pending') { notify(t('Friend request sent.'), 'success'); input.value = ''; }
        });
        you.append(form);

        // Requests
        if (data.incoming.length || data.outgoing.length) {
            const req = section(host, 'Requests');
            for (const p of data.incoming) {
                const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '@' + p.username), el('span', 'fr-tag', t('wants to be friends')));
                const acts = el('div', 'fr-acts');
                acts.append(btn(t('Accept'), () => act('respond', { id: p.id, accept: true }, 'You’re now friends.'), 'icon-btn btn-primary'),
                    btn(t('Decline'), () => act('respond', { id: p.id, accept: false })),
                    btn(t('Block'), () => block(p)));
                row.append(acts); req.append(row);
            }
            for (const p of data.outgoing) {
                const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '@' + p.username), el('span', 'fr-tag', t('Pending')));
                const acts = el('div', 'fr-acts'); acts.append(btn(t('Withdraw'), () => act('withdraw', { id: p.id }, 'Request withdrawn.')));
                row.append(acts); req.append(row);
            }
        }

        // Leaderboard (you included)
        const lb = section(host, 'Leaderboard');
        const tabs = el('div', 'fr-tabs'); tabs.setAttribute('role', 'tablist');
        for (const [k, label] of [['all', 'All time'], ['week', 'This week']]) {
            const b = btn(t(label), () => { board = k; render(); }, 'fr-tab' + (board === k ? ' is-on' : '')); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(board === k)); tabs.append(b);
        }
        lb.append(tabs);
        const people = [...data.friends, data.me].sort((a, b) => (board === 'week' ? b.week - a.week : b.total - a.total) || (a.username || '').localeCompare(b.username || ''));
        const ol = el('ol', 'fr-board');
        people.forEach((p, i) => {
            const li = el('li', p.me ? 'is-me' : '');
            li.append(el('span', 'fr-pos', '#' + num(i + 1)), el('b', 'fr-name', p.me ? t('You') : '@' + p.username), el('span', 'fr-rank', t(p.rank.name)), streakChip(p.streak, p.done_today),
                el('b', 'fr-pts', num(board === 'week' ? p.week : p.total)));
            ol.append(li);
        });
        lb.append(ol);
        if (!data.friends.length) lb.append(el('p', 'fr-sub', t('Add a friend to start a leaderboard.')));
        if (board === 'week') lb.append(el('p', 'fr-sub', t('This week started {0}.').replace('{0}', data.week_start)));

        // Friends
        if (data.friends.length) {
            const fl = section(host, 'Your friends', `${data.friends.length} / ${data.limits.friends}`);
            for (const p of data.friends) {
                const row = el('div', 'fr-row fr-friend');
                const info = el('div', 'fr-info');
                info.append(el('b', 'fr-name', '@' + p.username));
                const meta = el('div', 'fr-meta');
                meta.append(el('span', '', t(p.rank.name) + ' · ' + num(p.total) + ' ' + t('pts')), streakChip(p.streak, p.done_today),
                    el('span', p.done_today ? 'fr-done is-on' : 'fr-done', p.done_today ? t('Done today') : t('Not yet today')));
                if (p.duo) { const d = el('span', 'fr-duo'); d.append(icon('leaves'), el('b', '', t('Duo streak {0}').replace('{0}', num(p.duo)))); d.title = t('Days you both finished a task'); meta.append(d); }
                info.append(meta);
                const acts = el('div', 'fr-acts');
                const cheer = btn(p.cheered_today ? t('Cheered') : t('Cheer'), () => act('cheer', { id: p.id }, 'Cheer sent.'), 'icon-btn btn-primary');
                cheer.disabled = p.cheered_today;
                acts.append(cheer, btn(t('Unfriend'), () => unfriend(p)), btn(t('Block'), () => block(p)));
                row.append(info, acts); fl.append(row);
            }
        }

        renderCollabs(host);

        // Cheers
        if (data.cheers.length) {
            const ch = section(host, 'Cheers');
            for (const c of data.cheers.slice().reverse()) ch.append(el('p', 'fr-cheer', t('{0} cheered you on').replace('{0}', '@' + c.username) + ' · ' + ((window.TaskitatorI18n?.dateTime?.(c.at)) ?? new Date(c.at).toLocaleString())));
        }

        // Privacy and blocked
        const pv = section(host, 'Privacy', 'Who can send you friend requests. A refused request still looks sent to the other person.');
        const sel = el('select', 'fr-select'); sel.setAttribute('aria-label', t('Who can send you friend requests'));
        for (const [v, label] of [['anyone', 'Anyone who knows my username'], ['universe', 'Only people in my Universes'], ['nobody', 'Nobody']]) { const o = el('option', '', t(label)); o.value = v; if (data.me.privacy === v) o.selected = true; sel.append(o); }
        sel.addEventListener('change', () => act('privacy', { privacy: sel.value }, 'Saved.'));
        pv.append(sel);
        if (data.blocked.length) {
            pv.append(el('h3', '', t('Blocked')));
            for (const p of data.blocked) { const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '@' + p.username)); const a = el('div', 'fr-acts'); a.append(btn(t('Unblock'), () => act('unblock', { id: p.id }, 'Unblocked.'))); row.append(a); pv.append(row); }
        }
    }

    // Phase 7.0: Collab (a small Universe for friends; everyone needs Pro).
    function renderCollabs(host) {
        const invites = data.collab_invites || [], collabs = data.collabs || [];
        if (!data.friends.length && !invites.length && !collabs.length) return;
        const box = section(host, 'Collabs', 'A small shared space with friends: shared tasks, reviews by AI or by each other, and phone blocking if everyone agrees to it. Everyone in a collab needs Pro.');
        box.querySelector?.('h2')?.append(' ', el('span', 'pro-feature-pill', 'PRO'));
        for (const c of invites) {
            const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '“' + c.title + '”'), el('span', 'fr-tag', t('Invited by @{0}').replace('{0}', c.username)));
            const a = el('div', 'fr-acts');
            a.append(btn(t('Join'), async () => { const r = await act('collab/accept', { id: c.id }, 'You joined the collab.'); if (r?.id) openCollab(r.id); }, 'icon-btn btn-primary'), btn(t('Decline'), () => act('collab/decline', { id: c.id })));
            row.append(a); box.append(row);
        }
        for (const c of collabs) {
            const row = el('div', 'fr-row'); const info = el('div', 'fr-info');
            info.append(el('b', 'fr-name', c.title), el('div', 'fr-meta', c.members.length ? t('With {0}').replace('{0}', c.members.map(n => '@' + n).join(', ')) : t('Waiting for friends to join')));
            const a = el('div', 'fr-acts'); a.append(btn(t('Open'), () => openCollab(c.id), 'icon-btn btn-primary'));
            row.append(info, a); box.append(row);
        }
        if (!data.friends.length) return;
        if (!collabOpen) { box.append(btn(t('Start a collab'), () => { collabOpen = true; render(); }, 'icon-btn fr-start')); return; }
        const form = el('form', 'fr-collab-form');
        const name = el('input'); name.type = 'text'; name.maxLength = 120; name.placeholder = t('Collab name'); name.setAttribute('aria-label', t('Collab name'));
        const pick = el('div', 'fr-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', t('Friends to invite'));
        const max = (data.limits?.collab || 6) - 1;
        const sync = () => { const n = pick.querySelectorAll('input:checked').length; pick.querySelectorAll('input').forEach(i => { i.disabled = !i.checked && n >= max; }); };
        for (const f of data.friends) { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = f.id; c.addEventListener('change', sync); l.append(c, document.createTextNode(' @' + f.username)); pick.append(l); }
        const note = el('p', 'fr-sub', t('Pick up to {0} friends. Each gets an invitation on their Friends page for 7 days.').replace('{0}', num(max)));
        const go = el('button', 'icon-btn btn-primary', t('Create collab')); go.type = 'submit';
        const cancel = btn(t('Cancel'), () => { collabOpen = false; render(); });
        if (!isPro()) { go.disabled = true; form.append(el('p', 'fr-note', t('Collab needs Pro, for you and every friend you invite.'))); }
        form.append(name, pick, note, go, cancel);
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const ids = [...pick.querySelectorAll('input:checked')].map(i => i.value);
            if (!name.value.trim() || !ids.length) { notify(t('Give the collab a name and pick at least one friend.'), 'error'); return; }
            const r = await act('collab/create', { title: name.value.trim(), ids }, 'Collab created. Your friends got an invitation.');
            if (r?.id) { collabOpen = false; render(); }
        });
        box.append(form);
    }
    function openCollab(id) { location.href = 'components.html?view=universe&group=' + encodeURIComponent(id); }

    async function unfriend(p) {
        if (await confirm({ title: t('Unfriend @{0}?').replace('{0}', p.username), message: t('You stop seeing each other’s points. You can send a new request later.'), confirmLabel: t('Unfriend'), tone: 'danger' }))
            act('remove', { id: p.id }, 'Friend removed.');
    }
    async function block(p) {
        if (await confirm({ title: t('Block @{0}?').replace('{0}', p.username), message: t('This ends your friendship and cancels requests. Their future requests never reach you, and they aren’t told.'), confirmLabel: t('Block'), tone: 'danger' }))
            act('block', { id: p.id }, 'Blocked.');
    }

    window.TaskitatorFriendsView = Object.freeze({
        show() { render(); if (!data || data.error || Date.now() - loadedAt > 15000) load(); },
        refresh: () => load(),
        request: username => api('/friends/request', { username }),
        current: () => data
    });
    // Background check once per load: request badge and cheers.
    window.addEventListener('taskitator-auth-ready', () => { if (window.TaskitatorShell?.current?.() !== 'friends') setTimeout(() => load(true), 2500); });
})();

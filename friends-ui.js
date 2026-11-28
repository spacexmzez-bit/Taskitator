/* Phase 7.0: the Friends view (#friends) of the index.html shell. Server: friends-backend.js (/friends…).
   Friends see each other's points, rank, streak and whether today is done. Never tasks.
   Phase 7.5: Challenges (start one from a friend's row; Pro to start, anyone can join) and Collabs (shared task trees,
   opened in the #collab-<id> view; collab-ui.js, collab-backend.js).
   Phase 7.6: group challenges (up to 5 friends), Time or Amount, optional prize text, colors; finished collabs. */
(() => {
    'use strict';
    if (typeof document === 'undefined') return;
    const t = s => window.TaskitatorI18n?.translateText?.(s) || s;
    // Fill a template first, then translate the whole sentence (a template with {0} has no exact dictionary hit).
    const tf = (tpl, ...vals) => { const s = vals.reduce((acc, v, i) => acc.replace('{' + i + '}', v), tpl); return window.TaskitatorI18n?.translateText?.(s) || s; };
    const num = n => (window.TaskitatorI18n?.number?.(n)) ?? String(n);
    const owner = () => window.TaskitatorAuth?.userId || '';
    const SEEN = 'taskitator_friends_seen';
    let data = null, board = 'all', busy = false, loadedAt = 0, collabOpen = false, challengeFor = null;
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
        try { const r = await api(path.startsWith('/') ? path : '/friends/' + path, body); if (okText) notify(t(okText), 'success'); await load(true); return r; }
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
                acts.append(cheer, btn(t('Challenge'), () => { challengeFor = challengeFor === p.id ? null : p.id; render(); }), btn(t('Unfriend'), () => unfriend(p)), btn(t('Block'), () => block(p)));
                row.append(info, acts); fl.append(row);
                if (challengeFor === p.id) fl.append(challengeForm(p));
            }
        }

        renderChallenges(host);
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

    // Phase 7.5 / 7.6: Challenges. Pro to send; friends join free. Up to 5 friends; Time or Amount; optional prize text.
    const METRIC = { points: 'Points', tasks: 'Tasks', streak: 'Streak' };
    const METRIC_TEXT = {
        points: 'Points earned (at most 50 count a day).',
        tasks: 'Required tasks finished (bonus tasks don’t count; at most 15 a day).',
        streak: 'Days in a row with a required task finished. Free days don’t break it.'
    };
    const TYPE = { time: 'Time', amount: 'Amount' };
    const TYPE_TEXT = { time: 'The highest score on the last day wins.', amount: 'The first to reach a goal wins.' };
    const UNIT = { points: '{0} pts', tasks: '{0} tasks', streak: '{0} days' }, ONE = { points: '{0} pt', tasks: '{0} task', streak: '{0} day' };
    const colors = () => window.TaskitatorRaceColors || [{ hex: '#60a5fa', name: 'Blue' }];
    const goalRange = (metric, days) => {
        const min = data.limits?.challenge_goal_min || { points: 10, tasks: 2, streak: 2 }, per = data.limits?.challenge_goal_day || { points: 50, tasks: 15, streak: 1 };
        return [min[metric], per[metric] * days];
    };
    function swatches(name, selected, taken, onPick) {
        const g = el('div', 'fr-swatches'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', t('Your color'));
        colors().forEach((c, i) => {
            const l = el('label', 'fr-swatch' + (taken.has(i) ? ' is-taken' : '')); l.style.setProperty('--c', c.hex); l.title = t(c.name);
            const r = el('input'); r.type = 'radio'; r.name = name; r.value = String(i); r.checked = i === selected; r.disabled = taken.has(i); r.setAttribute('aria-label', t(c.name));
            if (onPick) r.addEventListener('change', () => onPick(i));
            l.append(r, el('i')); g.append(l);
        });
        return g;
    }
    function radios(name, map, textMap, first) {
        const group = el('div', 'tk-choices fr-ch-metrics'); group.setAttribute('role', 'radiogroup');
        Object.keys(map).forEach(k => {
            const l = el('label', 'tk-choice'); const r = el('input'); r.type = 'radio'; r.name = name; r.value = k; r.checked = k === first;
            l.append(r, el('strong', '', t(map[k])), el('span', '', t(textMap[k]))); group.append(l);
        });
        return group;
    }
    function challengeForm(p) {
        const form = el('form', 'fr-ch-form');
        const max = (data.limits?.challenge_members || 6) - 1;
        form.append(el('p', 'fr-sub', tf('Challenge @{0}', p.username)));
        const pick = el('div', 'fr-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', t('Who’s in'));
        const sync = () => { const n = pick.querySelectorAll('input:checked').length; pick.querySelectorAll('input').forEach(i => { i.disabled = !i.checked && n >= max; }); };
        for (const f of data.friends) { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = f.id; c.checked = f.id === p.id; c.addEventListener('change', sync); l.append(c, document.createTextNode(' @' + f.username)); pick.append(l); }
        if (data.friends.length > 1) form.append(el('p', 'fr-sub', tf('Add more friends if you like (up to {0}).', num(max))), pick);
        else form.append(pick), pick.hidden = true;
        const types = radios('chType', TYPE, TYPE_TEXT, 'time'); types.setAttribute('aria-label', t('How to win'));
        const metrics = radios('chMetric', METRIC, METRIC_TEXT, 'points'); metrics.setAttribute('aria-label', t('What to compete on'));
        const dl = el('label', 'fr-ch-days'); const days = el('input'); days.type = 'number'; days.min = '1'; days.max = String(data.limits?.challenge_days || 30); days.value = String(data.limits?.challenge_default || 5); days.inputMode = 'numeric';
        dl.append(document.createTextNode(t('Days') + ' '), days, el('span', 'fr-sub', ' ' + t('(1–30)')));
        const gl = el('label', 'fr-ch-days'); const goal = el('input'); goal.type = 'number'; goal.inputMode = 'numeric'; goal.min = '1';
        const goalHint = el('span', 'fr-sub');
        gl.append(document.createTextNode(t('Goal') + ' '), goal, goalHint);
        const prize = el('input'); prize.type = 'text'; prize.maxLength = data.limits?.challenge_prize || 40; prize.placeholder = t('Prize (optional), e.g. $300'); prize.setAttribute('aria-label', t('Prize (optional)')); prize.autocomplete = 'off';
        const pl = el('label', 'fr-ch-prize'); pl.append(prize, el('span', 'fr-sub', t('Just text that everyone sees. Taskitator doesn’t handle prizes.')));
        let color = 0;
        const cl = el('div', 'fr-ch-color'); cl.append(el('span', 'fr-sub', t('Your color')), swatches('chColorNew', 0, new Set(), i => { color = i; }));
        const refresh = () => {
            const amount = form.querySelector('input[name=chType]:checked').value === 'amount';
            gl.hidden = !amount;
            const [lo, hi] = goalRange(form.querySelector('input[name=chMetric]:checked').value, Number(days.value) || 1);
            goal.min = String(lo); goal.max = String(hi);
            goalHint.textContent = ' ' + (lo > hi ? t('A Streak goal needs at least 2 days.') : tf('({0}–{1})', num(lo), num(hi)));
            if (amount && !goal.value) goal.value = String(Math.min(hi, Math.max(lo, Math.round(hi / 2))));
        };
        form.addEventListener('change', refresh); days.addEventListener('input', refresh);
        const go = el('button', 'icon-btn btn-primary', t('Send challenge')); go.type = 'submit';
        form.append(types, metrics, dl, gl, pl, cl, el('p', 'fr-sub', t('It starts the day after you press Start, or by itself 48 hours after you send it if someone joined. Nobody can join once it starts. Only the Worker counts scores.')));
        if (!isPro()) { go.disabled = true; form.append(el('p', 'fr-note', t('Starting a challenge needs Pro. Your friends don’t need it to join.'))); }
        form.append(go, btn(t('Cancel'), () => { challengeFor = null; render(); }));
        refresh();
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const n = Number(days.value), type = form.querySelector('input[name=chType]:checked').value, metric = form.querySelector('input[name=chMetric]:checked').value;
            if (!Number.isInteger(n) || n < 1 || n > (data.limits?.challenge_days || 30)) { notify(t('A challenge lasts 1 to 30 days.'), 'error'); return; }
            const ids = [...pick.querySelectorAll('input:checked')].map(i => i.value);
            if (!ids.length) { notify(t('Pick at least one friend.'), 'error'); return; }
            const body = { ids, type, metric, days: n, prize: prize.value, color };
            if (type === 'amount') {
                const [lo, hi] = goalRange(metric, n), g = Number(goal.value);
                if (lo > hi) { notify(t('A Streak goal needs at least 2 days.'), 'error'); return; }
                if (!Number.isInteger(g) || g < lo || g > hi) { notify(tf('Choose a goal from {0} to {1}.', num(lo), num(hi)), 'error'); return; }
                body.target = g;
            }
            const r = await act('challenge/create', body, 'Challenge sent.');
            if (r?.id) { challengeFor = null; render(); }
        });
        return form;
    }
    const shortDate = d => d ? ((window.TaskitatorI18n?.dateTime?.(Date.parse(d + 'T12:00:00Z'), { month: 'short', day: 'numeric', timeZone: 'UTC' })) ?? d) : '';
    const whenAt = at => (window.TaskitatorI18n?.dateTime?.(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) ?? new Date(at).toLocaleString();
    const unit = (metric, n) => tf((n === 1 ? ONE : UNIT)[metric], num(n));
    function chTitle(c) {
        const parts = [t(TYPE[c.type] || 'Time'), t(METRIC[c.metric]), tf('{0} days', num(c.days))];
        if (c.type === 'amount') parts.push(tf('First to {0}', unit(c.metric, c.target)));
        return parts.join(' · ');
    }
    function memberChip(c, m) {
        const chip = el('span', 'fr-ch-who is-' + m.state + (m.me ? ' is-me' : ''));
        const dot = el('i', 'fr-dot'); if (Number.isInteger(m.color)) dot.style.setProperty('--c', colors()[m.color]?.hex || '#888'); chip.append(dot);
        chip.append(el('b', '', m.me ? t('You') : '@' + m.username));
        if (c.status !== 'pending' && m.state !== 'invited') chip.append(el('span', '', unit(c.metric, m.main)));
        if (m.state === 'invited') chip.append(el('span', 'fr-sub', t('invited')));
        if (m.state === 'left') chip.append(el('span', 'fr-sub', t('forfeited')));
        if (m.reached_at) chip.append(el('span', 'fr-tag', t('Goal reached')));
        return chip;
    }
    function renderChallenges(host) {
        const list = data.challenges || [];
        if (!list.length) return;
        const box = section(host, 'Challenges');
        for (const c of list) {
            const row = el('div', 'fr-row fr-ch is-' + c.status);
            const info = el('div', 'fr-info');
            info.append(el('b', 'fr-name', chTitle(c)));
            if (c.prize) { const pz = el('span', 'fr-prize'); pz.append(icon('star'), el('bdi', '', c.prize)); pz.title = t('Prize (just text; Taskitator doesn’t handle it)'); info.append(pz); }
            const who = el('div', 'fr-ch-people'); for (const m of c.members) who.append(memberChip(c, m)); info.append(who);
            const meta = el('div', 'fr-meta'), acts = el('div', 'fr-acts');
            const joined = c.members.filter(m => m.state === 'in' && !m.creator).length;
            if (c.status === 'pending') {
                if (c.mine) {
                    meta.append(el('span', 'fr-tag', joined ? tf('{0} joined · starts by itself {1}', num(joined), whenAt(c.auto_start_at)) : t('Waiting for friends to join')));
                    const start = btn(t('Start'), () => act('challenge/start', { id: c.id }, 'Started. Day 1 is tomorrow.'), 'icon-btn btn-primary'); start.disabled = !joined;
                    acts.append(start, btn(t('Cancel'), () => act('challenge/cancel', { id: c.id }, 'Challenge cancelled.')));
                } else if (c.state === 'invited') {
                    meta.append(el('span', 'fr-tag', tf('{0} challenged you', '@' + c.by)));
                    const taken = new Set(c.members.map(m => m.color).filter(Number.isInteger));
                    let pickColor = [...colors().keys()].find(i => !taken.has(i)) ?? 0;
                    info.append(swatches('chColor-' + c.id, pickColor, taken, i => { pickColor = i; }));
                    acts.append(btn(t('Accept'), () => act('challenge/accept', { id: c.id, color: pickColor }, 'You joined. It starts after the sender presses Start.'), 'icon-btn btn-primary'), btn(t('Decline'), () => act('challenge/decline', { id: c.id })));
                } else {
                    meta.append(el('span', 'fr-tag', tf('You joined. Waiting for {0} to start it.', '@' + c.by)));
                    acts.append(btn(t('Leave'), () => act('challenge/leave', { id: c.id }, 'You left the challenge.')));
                }
            } else if (c.status === 'active') {
                const left = Math.max(0, Math.round((Date.parse(c.end) - Date.parse(c.today)) / 86400000));
                meta.append(el('span', 'fr-tag', c.today < c.start ? tf('Starts {0}', shortDate(c.start)) : left ? tf('{0} days left', num(left + 1)) : t('Last day')));
                if (c.state === 'in') acts.append(btn(t('Forfeit'), () => forfeit(c)));
            } else {
                const o = c.result?.outcome;
                meta.append(el('span', 'fr-ch-result is-' + o, o === 'win' ? t('You won') : o === 'loss' ? (c.result.winners.length ? tf('{0} won', c.result.winners.map(n => '@' + n).join(', ')) : t('You lost')) : t('Draw')));
                if (c.result?.how === 'target') meta.append(el('span', 'fr-tag', t('Goal reached first')));
                if (c.result?.target_missed) meta.append(el('span', 'fr-tag', t('Nobody reached the goal')));
                if (c.result?.forfeit) meta.append(el('span', 'fr-tag', t('You forfeited')));
                else if (c.result?.how === 'forfeit') meta.append(el('span', 'fr-tag', t('The others forfeited')));
                acts.append(btn(t('Remove'), () => act('challenge/dismiss', { id: c.id })));
            }
            if (c.state === 'in' && c.status !== 'finished') {
                const taken = new Set(c.members.filter(m => !m.me).map(m => m.color).filter(Number.isInteger));
                const d = el('details', 'fr-ch-recolor'); d.append(el('summary', '', t('Change color')), swatches('chRecolor-' + c.id, c.color, taken, i => act('challenge/color', { id: c.id, color: i }, 'Saved.')));
                info.append(d);
            }
            info.append(meta); row.append(info, acts); box.append(row);
        }
    }
    async function forfeit(c) {
        const others = c.members.filter(m => !m.me && m.state === 'in');
        if (await confirm({ title: t('Forfeit this challenge?'), message: others.length === 1 ? tf('{0} wins. This can’t be undone.', '@' + others[0].username) : t('You’re out and can’t rejoin. This can’t be undone.'), confirmLabel: t('Forfeit'), tone: 'danger' }))
            act('challenge/forfeit', { id: c.id }, 'You forfeited.');
    }

    // Phase 7.5: Collabs (a shared task tree; everyone needs Pro). Opens in #collab-<id>.
    function renderCollabs(host) {
        const invites = data.collab_invites || [], collabs = data.collabs || [];
        if (!data.friends.length && !invites.length && !collabs.length) return;
        const box = section(host, 'Collabs', 'One shared task with friends. You split it into subtasks and assign people; everyone sees the same tasks and progress. Everyone in a collab needs Pro.');
        box.querySelector?.('h2')?.append(' ', el('span', 'pro-feature-pill', 'PRO'));
        for (const c of invites) {
            const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '“' + c.title + '”'), el('span', 'fr-tag', tf('Invited by @{0}', c.username)));
            const a = el('div', 'fr-acts');
            a.append(btn(t('Join'), async () => { const r = await act('/collab/accept', { id: c.id }, 'You joined the collab.'); if (r?.id) openCollab(r.id); }, 'icon-btn btn-primary'), btn(t('Decline'), () => act('/collab/decline', { id: c.id })));
            row.append(a); box.append(row);
        }
        for (const c of collabs) {
            const row = el('div', 'fr-row'); const info = el('div', 'fr-info');
            info.append(el('b', 'fr-name', c.title));
            const meta = el('div', 'fr-meta');
            meta.append(el('span', '', c.owner ? t('You started it') : tf('Started by @{0}', c.owner_name)),
                el('span', '', c.members.length ? tf('With {0}', c.members.map(n => '@' + n).join(', ')) : t('Waiting for friends to join')));
            if (c.finished) meta.append(el('span', 'fr-tag', tf('Finished · deleted {0}', whenAt(c.purge_at))));
            if (c.needs_ok) meta.append(el('span', 'fr-tag is-ask', c.owner ? tf('{0} release request(s)', num(c.needs_ok)) : tf('{0} lock(s) need your OK', num(c.needs_ok))));
            const bar = el('span', 'cb-mini'); const fill = el('i'); fill.style.width = (c.total ? Math.round(100 * c.done / c.total) : 0) + '%'; bar.append(fill);
            meta.append(bar, el('span', '', num(c.done) + '/' + num(c.total)));
            info.append(meta);
            const a = el('div', 'fr-acts'); a.append(btn(t('Open'), () => openCollab(c.id), 'icon-btn btn-primary'));
            row.append(info, a); box.append(row);
        }
        if (!data.friends.length) return;
        if (!collabOpen) { box.append(btn(t('Start a collab'), () => { collabOpen = true; render(); }, 'icon-btn fr-start')); return; }
        const form = el('form', 'fr-collab-form');
        const name = el('input'); name.type = 'text'; name.maxLength = 150; name.placeholder = t('Shared task'); name.setAttribute('aria-label', t('Shared task'));
        const pick = el('div', 'fr-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', t('Friends to invite'));
        const max = (data.limits?.collab || 6) - 1;
        const sync = () => { const n = pick.querySelectorAll('input:checked').length; pick.querySelectorAll('input').forEach(i => { i.disabled = !i.checked && n >= max; }); };
        for (const f of data.friends) { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = f.id; c.addEventListener('change', sync); l.append(c, document.createTextNode(' @' + f.username)); pick.append(l); }
        const note = el('p', 'fr-sub', tf('Pick up to {0} friends. Each gets an invitation on their Friends page for 7 days.', num(max)));
        const go = el('button', 'icon-btn btn-primary', t('Create collab')); go.type = 'submit';
        const cancel = btn(t('Cancel'), () => { collabOpen = false; render(); });
        if (!isPro()) { go.disabled = true; form.append(el('p', 'fr-note', t('Collab needs Pro, for you and every friend you invite.'))); }
        form.append(name, pick, note, go, cancel);
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const ids = [...pick.querySelectorAll('input:checked')].map(i => i.value);
            if (!name.value.trim() || !ids.length) { notify(t('Give the collab a name and pick at least one friend.'), 'error'); return; }
            if (!await confirm({ title: t('Everyone needs Pro'), message: t('You and every friend you invite need an active Pro license. If anyone’s Pro ends, nobody can change the collab until it’s renewed (reading, comments and leaving still work).'), confirmLabel: t('Create collab') })) return;
            const r = await act('/collab/create', { title: name.value.trim(), ids }, 'Collab created. Your friends got an invitation.');
            if (r?.id) { collabOpen = false; openCollab(r.id); }
        });
        box.append(form);
    }
    function openCollab(id) { location.hash = '#collab-' + id; }

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

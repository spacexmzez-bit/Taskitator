/* Phase 7.5: one collab, the #collab-<id> view of the index.html shell. Loaded by shell-router.js the first time a
   collab is opened (never with the app). Server: collab-backend.js (/collab/...).
   The owner edits tasks, notes, due dates, assignees and people; members complete what they're assigned (and what's
   under it) and comment. Checks for changes every 45 s while open and visible, and when the tab comes back.
   Phase 7.6: completing the main task finishes the collab (read-only, deleted 7 days later); everyone gets a
   "Save JSON file" prompt (collab-archive.js, loaded on demand). Members with nothing assigned show as Viewers.
   Phase 7.7: locks (AI check, shield, phone lock; collab-locks.js). Assignees accept or decline; accepting adds a
   linked copy to their own task list (a sync runs right after, so it shows up); they ask to be released, the owner
   releases or denies. AI-checked tasks are completed with proof from that copy, never here. */
(() => {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorCollabView) return;
    const POLL_MS = 45000;
    const t = s => window.TaskitatorI18n?.translateText?.(s) || s;
    // Fill a template first, then translate the whole sentence (a template with {0} has no exact dictionary hit).
    const tf = (tpl, ...vals) => { const s = vals.reduce((acc, v, i) => acc.replace('{' + i + '}', v), tpl); return window.TaskitatorI18n?.translateText?.(s) || s; };
    const num = n => (window.TaskitatorI18n?.number?.(n)) ?? String(n);
    const notify = (m, type) => window.TaskitatorNotify?.(m, type);
    const confirm = o => (typeof window.TaskitatorConfirm === 'function' ? window.TaskitatorConfirm(o) : Promise.resolve(window.confirm(o.message || o.title)));
    const root = () => document.getElementById('collabRoot');
    const PROMPTED = 'taskitator_collab_save_prompted';
    let archiveLoading = null;
    function archiveLib() {
        if (window.TaskitatorCollabArchive) return Promise.resolve(window.TaskitatorCollabArchive);
        return archiveLoading ||= new Promise((resolve, reject) => {
            const sc = document.createElement('script'); sc.src = 'collab-archive.js?v=ca-1';
            sc.onload = () => resolve(window.TaskitatorCollabArchive);
            sc.onerror = () => { archiveLoading = null; reject(new Error(t('Couldn’t prepare the file. Check your connection and try again.'))); };
            document.head.appendChild(sc);
        });
    }
    async function saveFile() {
        if (!data) return;
        try { const name = (await archiveLib()).download(data); notify(tf('Saved as {0}.', name), 'success'); }
        catch (e) { notify(e.message, 'error'); }
    }
    const prompted = () => { try { return JSON.parse(localStorage.getItem(PROMPTED) || '[]'); } catch { return []; } };
    function markPrompted(id) { try { localStorage.setItem(PROMPTED, JSON.stringify([...new Set([id, ...prompted()])].slice(0, 50))); } catch { /* full */ } }
    // The save prompt: once per finished collab on this device (also right after you finish it).
    async function savePrompt() {
        if (!data?.finished || prompted().includes(data.id)) return;
        markPrompted(data.id);
        if (await confirm({ title: t('This collab is finished'), message: tf('Its tasks, progress and comments are deleted for everyone on {0}. Save a copy to keep them. The file is a record only; it can’t be imported.', day(data.purge_at)), confirmLabel: t('Save JSON file'), cancelLabel: t('Not now') }))
            saveFile();
    }
    const day = at => (window.TaskitatorI18n?.dateTime?.(at, { year: 'numeric', month: 'short', day: 'numeric' })) ?? new Date(at).toLocaleDateString();
    let cid = '', data = null, error = null, timer = 0, busy = false, open = false;
    let editing = null, adding = null, assigning = null, inviting = false, draft = '';

    const ic = key => { const I = window.TaskitatorIcons, s = document.createElement('span'); s.className = 'tk-inline-ic'; s.setAttribute('aria-hidden', 'true'); if (I?.has?.(key)) s.append(I.node(key)); return s; };
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function btn(text, onClick, cls = 'icon-btn', label) { const b = el('button', cls, text); b.type = 'button'; if (label) { b.setAttribute('aria-label', t(label)); b.title = t(label); } b.addEventListener('click', onClick); return b; }
    const stamp = at => (window.TaskitatorI18n?.dateTime?.(at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))
        ?? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const today = () => window.TaskitatorRecurrence?.today?.() || new Date().toISOString().slice(0, 10);

    async function api(path, body) {
        const auth = window.TaskitatorAuth;
        if (!auth?.api) throw new Error(t('Sign in to use collabs.'));
        return auth.api(path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    }
    async function load(quiet) {
        if (!cid || !open) return;
        if (window.TaskitatorOffline?.active) { error = t('Collabs need a connection. You’re offline right now.'); render(); return; }
        const want = cid;
        try {
            const r = await api('/collab/' + encodeURIComponent(cid) + (quiet && data ? '?rev=' + data.rev : ''));
            if (want !== cid) return;
            if (r?.unchanged) return;
            data = r; error = null;
            if (data.finished) setTimeout(savePrompt, 0);
        } catch (e) {
            if (want !== cid) return;
            if (!quiet || !data) { error = e.message; data = null; }
        }
        render();
    }
    async function post(action, body, okText) {
        if (busy) return null; busy = true;
        try {
            const r = await api('/collab/' + action, { id: cid, ...body });
            if (okText) notify(t(okText), 'success');
            await load(false);
            return r;
        } catch (e) { notify(e.message, 'error'); return null; }
        finally { busy = false; }
    }
    function startPolling() {
        stopPolling();
        timer = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
    }
    function stopPolling() { clearInterval(timer); timer = 0; }
    document.addEventListener('visibilitychange', () => { if (open && document.visibilityState === 'visible') load(true); });
    window.addEventListener('taskitator-reconnected', () => { if (open) load(false); });

    // ---- data helpers
    const children = id => data.tasks.filter(x => x.parent === id).sort((a, b) => (a.ord - b.ord) || (a.at - b.at));
    const byId = id => data.tasks.find(x => x.id === id);
    const name = uid => { const p = data.members.find(m => m.id === uid) || data.invited.find(m => m.id === uid); return p ? '@' + p.username : t('Former member'); };
    function subtree(id) { const out = [], stack = [id]; while (stack.length) { const x = byId(stack.pop()); if (!x) continue; out.push(x); for (const k of children(x.id)) stack.push(k.id); } return out; }
    const viewer = uid => !data.tasks.some(x => x.assignees.includes(uid));
    const consentOf = (task, uid) => (task.locks ? task.consent?.[uid] || null : null);
    const assignedOk = (x, uid) => x.assignees.includes(uid) && (!x.locks || consentOf(x, uid)?.s === 'yes');
    // Same rule as the Worker: an AI check is never completed here; a shield waits for its subtasks.
    function blocked(task) {
        for (const x of subtree(task.id)) {
            if (x.done) continue;
            if (x.locks?.ai) return x.id === task.id ? t('Completed with proof from the assignee’s own task list.') : t('There’s an AI-checked task under it.');
            if (x.locks?.shield && children(x.id).some(k => !k.done)) return x.id === task.id ? t('Shielded: complete its subtasks first.') : t('A shielded task under it still has unfinished subtasks.');
        }
        return '';
    }
    function canComplete(task) {
        if (!data.joined || !data.pro_ok || data.finished) return false;
        if (task.done) return !task.locks && (data.can_edit || [task, ...ancestors(task)].some(x => assignedOk(x, data.me))) && ![task, ...ancestors(task)].some(x => x.done && x.locks);
        if (blocked(task)) return false;
        if (data.can_edit) return true;
        for (let x = task; x; x = byId(x.parent)) if (assignedOk(x, data.me)) return true;
        return false;
    }
    function ancestors(task) { const out = []; for (let x = byId(task.parent); x; x = byId(x.parent)) out.push(x); return out; }
    const syncSoon = () => { try { window.SyncEngine?.isConfigured?.() && window.SyncEngine.syncNow({ origin: 'manual' }); } catch { /* next sync picks it up */ } };
    const LOCK_TEXT = { ai: 'AI check', shield: 'Shield', phone: 'Phone lock' };
    const lockList = l => ['ai', 'shield', 'phone'].filter(k => l?.[k]);
    async function consent(task) {
        const l = task.locks, owner = data.members.find(m => m.owner)?.username || '';
        const lines = [];
        if (l.ai) lines.push(tf('AI check: you complete it with proof that meets “{0}”, reviewed with your own AI credits or key.', l.criteria));
        if (l.phone) lines.push(tf('Phone lock: it counts toward your phone lock on {0} until it’s done.', task.due));
        if (l.shield) lines.push(t('Shield: it can’t be completed until its subtasks are done.'));
        lines.push(tf('It’s added to your own task list. You can’t remove it or leave the collab until @{0} releases you. Emergency Bypass still works; the owner sees if you use it.', owner));
        if (!await confirm({ title: tf('Accept the locks on “{0}”?', task.title), message: lines.join('\n\n'), confirmLabel: t('Accept locks') })) return;
        if (await post('consent', { task: task.id }, 'Accepted. It’s in your task list now.')) syncSoon();
    }

    // ---- actions
    async function toggle(task) {
        if (task.done) return post('complete', { task: task.id, done: false });
        if (task.id === 'root') { // Phase 7.6: finishing is for everyone and can't be undone
            if (!await confirm({ title: t('Finish the collab?'), message: t('Completing the main task finishes the collab for everyone. It becomes read-only, and everything in it is deleted after 7 days. Everyone can save a copy first. This can’t be undone.'), confirmLabel: t('Finish collab'), tone: 'danger' })) return;
            const r = await post('complete', { task: task.id, done: true });
            if (r) savePrompt();
            return r;
        }
        const others = subtree(task.id).filter(x => !x.done && x.id !== task.id && x.assignees.length && !x.assignees.includes(data.me));
        if (others.length && !await confirm({ title: t('Complete everything under it?'), message: tf('This also completes {0} task(s) assigned to someone else.', num(others.length)), confirmLabel: t('Complete all') })) return;
        const r = await post('complete', { task: task.id, done: true });
        if (r && subtree(task.id).some(x => x.locks)) syncSoon(); // accepted copies close in everyone's lists
        return r;
    }
    async function removeTask(task) {
        const n = subtree(task.id).length;
        if (await confirm({ title: tf('Delete “{0}”?', task.title), message: n > 1 ? tf('Its {0} subtasks are deleted too. This can’t be undone.', num(n - 1)) : t('This can’t be undone.'), confirmLabel: t('Delete'), tone: 'danger' }))
            post('del', { task: task.id }, 'Task deleted.');
    }

    // ---- forms
    function taskForm(task, parent) {
        const form = el('form', 'cb-form');
        const title = el('input'); title.type = 'text'; title.maxLength = data.limits.title; title.placeholder = t('Title'); title.setAttribute('aria-label', t('Title')); title.value = task?.title || ''; title.required = true;
        const notes = el('textarea'); notes.rows = 2; notes.maxLength = data.limits.notes; notes.placeholder = t('Notes (optional)'); notes.setAttribute('aria-label', t('Notes')); notes.value = task?.notes || '';
        const due = el('input'); due.type = 'date'; due.setAttribute('aria-label', t('Due date')); due.value = task?.due || '';
        const dueRow = el('label', 'cb-due-label'); dueRow.append(document.createTextNode(t('Due date') + ' '), due);
        const save = el('button', 'icon-btn btn-primary', task ? t('Save') : t('Add')); save.type = 'submit';
        const cancel = btn(t('Cancel'), () => { editing = adding = null; render(); });
        // Phase 7.7: locks
        const lk = el('fieldset', 'cb-locks-form'); lk.append(el('legend', '', t('Locks (optional)')));
        const box = (key, hint) => { const l = el('label', 'cb-lock-opt'); const c = el('input'); c.type = 'checkbox'; c.checked = Boolean(task?.locks?.[key]); c.dataset.lock = key; l.append(c, el('b', '', t(LOCK_TEXT[key])), el('span', 'fr-sub', t(hint))); lk.append(l); return c; };
        const ai = box('ai', 'Done only with AI-reviewed proof.');
        const crit = el('textarea'); crit.rows = 2; crit.maxLength = 1000; crit.placeholder = t('What must the proof show?'); crit.setAttribute('aria-label', t('Proof criteria')); crit.value = task?.locks?.criteria || ''; lk.append(crit);
        const shield = box('shield', 'Can’t be completed until its subtasks are done.');
        const phone = box('phone', 'Counts toward the assignee’s phone lock on the due date.');
        lk.append(el('p', 'fr-sub', t('Assignees must accept the locks before they apply. After accepting, they can’t opt out without your release. Changing locks asks them again.')));
        const sync = () => { crit.hidden = !ai.checked; };
        ai.addEventListener('change', sync); sync();
        form.append(title, notes, dueRow, lk, el('div', 'cb-form-acts'));
        form.lastChild.append(save, cancel);
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const locks = ai.checked || shield.checked || phone.checked ? { ai: ai.checked, criteria: crit.value, shield: shield.checked, phone: phone.checked } : null;
            if (locks?.phone && !due.value) { notify(t('A phone lock needs a due date.'), 'error'); return; }
            if (locks?.ai && !crit.value.trim()) { notify(t('An AI check needs proof criteria.'), 'error'); return; }
            const body = { title: title.value, notes: notes.value, due: due.value || null, locks };
            const r = task ? await post('edit', { task: task.id, ...body }) : await post('add', { parent, ...body });
            if (r) { editing = adding = null; render(); }
        });
        setTimeout(() => title.focus(), 0);
        return form;
    }
    function assignForm(task) {
        const form = el('form', 'cb-form');
        form.append(el('p', 'fr-sub', tf('Who works on “{0}”? They can complete it and everything under it.', task.title)));
        const pick = el('div', 'fr-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', t('Assignees'));
        for (const p of [...data.members, ...data.invited]) {
            const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = p.id; c.checked = task.assignees.includes(p.id);
            l.append(c, document.createTextNode(' ' + (p.id === data.me ? t('You') : '@' + p.username) + (data.invited.includes(p) ? ' (' + t('invited') + ')' : '')));
            pick.append(l);
        }
        const save = el('button', 'icon-btn btn-primary', t('Save')); save.type = 'submit';
        form.append(pick, el('div', 'cb-form-acts'));
        form.lastChild.append(save, btn(t('Cancel'), () => { assigning = null; render(); }));
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const r = await post('assign', { task: task.id, assignees: [...pick.querySelectorAll('input:checked')].map(i => i.value) }, 'Saved.');
            if (r) { assigning = null; render(); }
        });
        return form;
    }

    // ---- render
    function node(task, depth) {
        const li = el('li', 'cb-node' + (task.done ? ' is-done' : ''));
        const row = el('div', 'cb-row');
        const check = el('button', 'cb-check' + (task.done ? ' is-done' : ''), task.done ? '✓' : '');
        check.type = 'button';
        check.setAttribute('aria-label', task.done ? tf('Reopen “{0}”', task.title) : tf('Complete “{0}”', task.title));
        check.disabled = !canComplete(task) || busy;
        if (!task.done && blocked(task)) check.title = blocked(task);
        check.addEventListener('click', () => toggle(task));
        const body = el('div', 'cb-body');
        body.append(el(depth ? 'span' : 'strong', 'cb-title', task.title));
        const meta = el('div', 'cb-meta');
        if (task.due) meta.append(el('span', 'cb-due' + (!task.done && task.due < today() ? ' is-late' : ''), tf('Due {0}', task.due)));
        for (const k of lockList(task.locks)) { const b = el('span', 'cb-lock is-' + k); b.append(ic(k === 'ai' ? 'lock' : k), document.createTextNode(t(LOCK_TEXT[k]))); if (k === 'ai') b.title = task.locks.criteria; meta.append(b); }
        for (const u of task.assignees) {
            const c = consentOf(task, u), st = c ? (c.s === 'yes' ? (c.req ? 'is-req' : 'is-yes') : c.s === 'no' ? 'is-no' : 'is-wait') : '';
            const chip = el('span', 'cb-who ' + st + (u === data.me ? ' is-me' : ''), (u === data.me ? t('You') : name(u)) + (c && !c.req ? ' ' + (c.s === 'yes' ? '✓' : c.s === 'no' ? '✕' : '…') : ''));
            if (c?.req) chip.append(' ', ic('warning'));
            if (c) chip.title = c.s === 'yes' ? (c.req ? t('Asked to be released') : t('Accepted the locks')) : c.s === 'no' ? (c.bypass ? t('Used Emergency Bypass') : t('Declined the locks')) : t('Hasn’t answered yet');
            meta.append(chip);
        }
        if (task.done?.via === 'proof') meta.append(el('span', 'cb-doneby', t('AI-approved')));
        if (task.done?.via === 'bypass') meta.append(el('span', 'cb-doneby is-warn', t('Completed with Emergency Bypass')));
        if (task.done) meta.append(el('span', 'cb-doneby', tf('Done by {0}', task.done.by === data.me ? t('you') : name(task.done.by))));
        if (meta.childNodes.length) body.append(meta);
        if (task.notes) body.append(el('p', 'cb-notes', task.notes));
        const lockRow = lockActions(task);
        if (lockRow) body.append(lockRow);
        row.append(check, body);
        if (data.can_edit) {
            const acts = el('div', 'cb-acts');
            if (depth < data.limits.depth - 1) acts.append(btn('+', () => { adding = task.id; editing = assigning = null; render(); }, 'cb-act', 'Add a subtask'));
            acts.append(btn('✎', () => { editing = task.id; adding = assigning = null; render(); }, 'cb-act', 'Edit'),
                btn('@', () => { assigning = task.id; editing = adding = null; render(); }, 'cb-act', 'Assign'));
            if (task.id !== 'root') acts.append(btn('✕', () => removeTask(task), 'cb-act cb-act-danger', 'Delete'));
            row.append(acts);
        }
        li.append(row);
        if (editing === task.id) li.append(taskForm(task));
        if (assigning === task.id) li.append(assignForm(task));
        const kids = children(task.id);
        if (kids.length || adding === task.id) {
            const ul = el('ul', 'cb-tree');
            for (const k of kids) ul.append(node(k, depth + 1));
            if (adding === task.id) { const f = el('li', 'cb-node'); f.append(taskForm(null, task.id)); ul.append(f); }
            li.append(ul);
        }
        return li;
    }
    // Phase 7.7: what the viewer can do about this task's locks.
    function lockActions(task) {
        if (!task.locks || task.done || data.finished) return null;
        const row = el('div', 'cb-lock-acts'), mine = consentOf(task, data.me);
        if (mine && data.joined) {
            if (mine.s === 'pending') {
                row.append(el('span', 'fr-tag', t('Needs your OK')), btn(t('Accept locks'), () => consent(task), 'icon-btn btn-primary'),
                    btn(t('Decline'), async () => { if (await confirm({ title: t('Decline the locks?'), message: t('You stay assigned but can’t complete it. The owner sees that you declined.'), confirmLabel: t('Decline') })) post('refuse', { task: task.id }); }));
            } else if (mine.s === 'yes') {
                row.append(el('span', 'fr-tag', task.locks.ai ? t('In your task list: complete it there with proof') : t('In your task list')));
                if (mine.req) row.append(el('span', 'fr-sub', t('You asked to be released.')), btn(t('Cancel request'), () => post('release_request', { task: task.id, cancel: true })));
                else row.append(btn(t('Ask to be released'), () => post('release_request', { task: task.id }, 'Request sent.')));
            } else if (mine.s === 'no') row.append(el('span', 'fr-sub', mine.bypass ? t('You used Emergency Bypass on this task.') : t('You declined the locks.')));
        }
        if (data.can_edit) for (const [u, c] of Object.entries(task.consent || {})) {
            if (c.s !== 'yes' && !c.bypass) continue;
            const who = u === data.me ? t('You') : name(u);
            if (c.bypass) { row.append(el('span', 'fr-sub cb-warn', tf('{0} used Emergency Bypass.', who))); continue; }
            if (c.req) row.append(el('span', 'fr-tag', tf('{0} asks to be released', who)),
                btn(t('Release'), () => release(task, u, who), 'icon-btn btn-primary'), btn(t('Deny'), () => post('release', { task: task.id, uid: u, approve: false }, 'Request denied.')));
            else row.append(btn(tf('Release {0}', who), () => release(task, u, who)));
        }
        return row.childNodes.length ? row : null;
    }
    async function release(task, uid, who) {
        if (await confirm({ title: tf('Release {0}?', who), message: t('The task leaves their list and they’re unassigned from it.'), confirmLabel: t('Release') }))
            post('release', { task: task.id, uid }, 'Released.');
    }

    function bar(done, total, cls = '') { const b = el('div', 'cb-bar ' + cls); const i = el('i'); i.style.width = (total ? Math.round(100 * done / total) : 0) + '%'; b.append(i); b.setAttribute('role', 'img'); b.setAttribute('aria-label', num(done) + ' / ' + num(total)); return b; }

    function render() {
        const host = root(); if (!host || !open) return;
        const keepScroll = window.scrollY;
        host.replaceChildren();
        const back = el('a', 'cb-back', (document.documentElement.dir === 'rtl' ? '→ ' : '← ') + t('Friends')); back.href = '#friends'; host.append(back);
        if (error) { host.append(el('p', 'fr-note', error), btn(t('Try again'), () => load(false))); return; }
        if (!data) { host.append(el('p', 'fr-sub', t('Loading…'))); return; }
        const rootTask = byId('root');
        const head = el('header', 'cb-head');
        head.append(el('h1', '', data.title));
        const owner = data.members.find(m => m.owner);
        head.append(el('p', 'fr-sub', data.finished ? (data.owner === data.me ? t('You started this collab.') : tf('{0} started this collab.', '@' + (owner?.username || '')))
            : data.can_edit ? t('You started this collab. Only you can change its tasks and people.') : tf('{0} started this collab. You can complete what you’re assigned and comment.', '@' + (owner?.username || ''))));
        const total = data.tasks.length, done = data.tasks.filter(x => x.done).length;
        const prog = el('div', 'cb-progress'); prog.append(bar(done, total), el('span', '', tf('{0} of {1} done', num(done), num(total))));
        head.append(prog);
        const people = el('div', 'cb-people');
        for (const m of data.members) {
            const mine = data.tasks.filter(x => x.assignees.includes(m.id)), fin = mine.filter(x => x.done).length;
            const chip = el('div', 'cb-person' + (m.id === data.me ? ' is-me' : ''));
            const nm = el('b'); if (m.owner) nm.append(ic('star')); nm.append(document.createTextNode(m.id === data.me ? t('You') : '@' + m.username)); chip.append(nm);
            if (mine.length) chip.append(bar(fin, mine.length, 'is-small'), el('span', '', num(fin) + '/' + num(mine.length)));
            else if (!m.owner && viewer(m.id)) { const v = el('span', 'cb-viewer', t('Viewer')); v.title = t('Nothing assigned: can see everything and comment.'); chip.append(v); }
            else chip.append(el('span', 'fr-sub', t('Nothing assigned')));
            people.append(chip);
        }
        for (const m of data.invited) { const chip = el('div', 'cb-person is-invited'); chip.append(el('b', '', '@' + m.username), el('span', 'fr-sub', t('Invited'))); people.append(chip); }
        head.append(people);
        host.append(head);

        if (data.finished) {
            const fin = el('section', 'fr-card cb-finished');
            fin.append(el('h2', '', t('Finished')),
                el('p', '', data.finished.by === data.me ? tf('You finished it {0}. It’s read-only now.', stamp(data.finished.at)) : tf('Finished {0} by {1}. It’s read-only now.', stamp(data.finished.at), '@' + data.finished.username)),
                el('p', 'fr-note', tf('Everything here is deleted on {0}. Save a copy to keep the tasks, progress and comments.', day(data.purge_at))));
            const a = el('div', 'fr-acts'); a.append(btn(t('Save JSON file'), saveFile, 'icon-btn btn-primary')); fin.append(a);
            host.append(fin);
        }
        if (!data.joined && !data.finished) {
            const inv = el('section', 'fr-card cb-invite');
            inv.append(el('p', '', tf('{0} invited you to this collab.', '@' + (owner?.username || ''))));
            const a = el('div', 'fr-acts');
            a.append(btn(t('Join'), () => post('accept', {}, 'You joined the collab.'), 'icon-btn btn-primary'), btn(t('Decline'), async () => { if (await post('decline', {})) location.hash = '#friends'; }));
            inv.append(a); host.append(inv);
        }
        const waiting = data.joined && !data.finished ? data.tasks.filter(x => x.locks && !x.done && consentOf(x, data.me)?.s === 'pending').length : 0;
        if (waiting) host.append(el('p', 'fr-note cb-ask', tf('{0} locked task(s) need your OK. Nothing binds you until you accept.', num(waiting))));
        if (!data.pro_ok && !data.finished) host.append(el('p', 'fr-note cb-pro', tf('Everyone in a collab needs Pro. Not on Pro: {0}. Until it’s renewed nobody can change tasks; reading, comments and leaving still work.', data.pro_missing.map(n => '@' + n).join(', '))));

        const tree = el('section', 'fr-card cb-card');
        tree.append(el('h2', '', t('Tasks')));
        const ul = el('ul', 'cb-tree cb-top');
        if (rootTask) ul.append(node(rootTask, 0));
        tree.append(ul);
        if (data.can_edit && rootTask && adding !== 'root') tree.append(btn('+ ' + t('Add a task'), () => { adding = 'root'; editing = assigning = null; render(); }, 'icon-btn fr-start'));
        host.append(tree);

        if (data.can_edit) host.append(peopleCard());
        host.append(commentsCard());

        const foot = el('div', 'cb-foot');
        if (data.finished) {
            if (data.owner === data.me) foot.append(btn(t('Delete now'), async () => {
                if (await confirm({ title: tf('Delete “{0}”?', data.title), message: t('It’s deleted for everyone now, before the others may have saved a copy. This can’t be undone.'), confirmLabel: t('Delete'), tone: 'danger' })) {
                    if (await post('delete', {})) { data = null; location.hash = '#friends'; window.TaskitatorFriendsView?.refresh?.(); }
                }
            }, 'icon-btn icon-btn-danger'));
            else foot.append(btn(t('Remove from my list'), async () => {
                if (await post('leave', {})) { data = null; location.hash = '#friends'; window.TaskitatorFriendsView?.refresh?.(); }
            }));
        } else if (data.can_edit) foot.append(btn(t('Delete collab'), async () => {
            if (await confirm({ title: tf('Delete “{0}”?', data.title), message: t('All its tasks and comments are deleted for everyone. This can’t be undone.'), confirmLabel: t('Delete'), tone: 'danger' })) {
                if (await post('delete', {})) { data = null; location.hash = '#friends'; window.TaskitatorFriendsView?.refresh?.(); }
            }
        }, 'icon-btn icon-btn-danger'));
        else if (data.joined) foot.append(btn(t('Leave collab'), async () => {
            if (await confirm({ title: tf('Leave “{0}”?', data.title), message: t('You’re unassigned from its tasks. The owner can invite you again.'), confirmLabel: t('Leave'), tone: 'danger' })) {
                if (await post('leave', {})) { data = null; location.hash = '#friends'; window.TaskitatorFriendsView?.refresh?.(); }
            }
        }, 'icon-btn icon-btn-danger'));
        host.append(foot);
        requestAnimationFrame(() => window.scrollTo(0, keepScroll));
    }

    function peopleCard() {
        const card = el('section', 'fr-card');
        card.append(el('h2', '', t('People')));
        for (const m of [...data.members.filter(x => !x.owner), ...data.invited]) {
            const row = el('div', 'fr-row'); row.append(el('b', 'fr-name', '@' + m.username));
            if (data.invited.includes(m)) row.append(el('span', 'fr-tag', t('Invited')));
            const a = el('div', 'fr-acts');
            a.append(btn(data.invited.includes(m) ? t('Cancel invite') : t('Remove'), async () => {
                if (await confirm({ title: tf('Remove @{0}?', m.username), message: t('They’re unassigned from every task here.'), confirmLabel: t('Remove'), tone: 'danger' })) post('remove', { uid: m.id }, 'Removed.');
            }));
            row.append(a); card.append(row);
        }
        const room = data.limits.members - data.members.length - data.invited.length;
        if (room <= 0) { card.append(el('p', 'fr-sub', tf('This collab is full ({0} people).', num(data.limits.members)))); return card; }
        if (!inviting) { card.append(btn(t('Invite friends'), () => { inviting = true; render(); }, 'icon-btn fr-start')); return card; }
        const friends = (window.TaskitatorFriendsView?.current?.()?.friends || []).filter(f => !data.members.some(m => m.id === f.id) && !data.invited.some(m => m.id === f.id));
        const form = el('form', 'cb-form');
        if (!friends.length) form.append(el('p', 'fr-sub', t('All your friends are already here, or your friends list hasn’t loaded. Open Friends first.')));
        const pick = el('div', 'fr-pick');
        for (const f of friends) { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = f.id; l.append(c, document.createTextNode(' @' + f.username)); pick.append(l); }
        const go = el('button', 'icon-btn btn-primary', t('Send invites')); go.type = 'submit'; go.disabled = !friends.length;
        form.append(pick, el('p', 'fr-sub', tf('Everyone you invite needs Pro. Room for {0} more.', num(room))), el('div', 'cb-form-acts'));
        form.lastChild.append(go, btn(t('Cancel'), () => { inviting = false; render(); }));
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const ids = [...pick.querySelectorAll('input:checked')].map(i => i.value);
            if (!ids.length) return;
            if (await post('invite', { ids }, 'Invitations sent.')) { inviting = false; render(); }
        });
        card.append(form);
        return card;
    }

    function commentsCard() {
        const card = el('section', 'fr-card cb-comments');
        card.append(el('h2', '', t('Comments')));
        if (!data.comments.length) card.append(el('p', 'fr-sub', t('No comments yet. Notes you leave here are shared with everyone in the collab.')));
        for (const c of data.comments) {
            const row = el('div', 'cb-comment');
            const head = el('div', 'cb-comment-head');
            const time = el('time', '', stamp(c.at)); time.dateTime = new Date(c.at).toISOString();
            head.append(el('b', '', c.mine ? t('You') : '@' + c.username), time);
            if (c.mine) head.append(btn('✕', async () => { if (await confirm({ title: t('Delete this comment?'), confirmLabel: t('Delete'), tone: 'danger' })) post('uncomment', { comment: c.id }); }, 'cb-act cb-act-danger', 'Delete comment'));
            row.append(head, el('p', '', c.text));
            card.append(row);
        }
        if (data.joined && !data.finished) {
            const form = el('form', 'cb-form cb-comment-form');
            const box = el('textarea'); box.rows = 2; box.maxLength = data.limits.comment; box.placeholder = t('Write a comment'); box.setAttribute('aria-label', t('Write a comment')); box.value = draft;
            const count = el('span', 'fr-sub', num(box.value.length) + '/' + num(data.limits.comment));
            box.addEventListener('input', () => { draft = box.value; count.textContent = num(box.value.length) + '/' + num(data.limits.comment); });
            const go = el('button', 'icon-btn btn-primary', t('Post')); go.type = 'submit';
            form.append(box, el('div', 'cb-form-acts'));
            form.lastChild.append(go, count);
            form.addEventListener('submit', async e => {
                e.preventDefault();
                if (!box.value.trim()) return;
                if (await post('comment', { text: box.value })) { draft = ''; render(); }
            });
            card.append(form);
        }
        return card;
    }

    window.TaskitatorCollabView = Object.freeze({
        show(id) {
            const fresh = id !== cid;
            open = true;
            if (fresh) { cid = /^cb[a-f0-9]{20}$/.test(id) ? id : ''; data = null; error = cid ? null : t('This collab link isn’t valid.'); editing = adding = assigning = null; inviting = false; draft = ''; }
            render(); load(false); startPolling();
            if (fresh) window.scrollTo(0, 0);
        },
        hide() { open = false; stopPolling(); window.TaskitatorFriendsView?.refresh?.(); }, // the Friends list shows progress too
        current: () => data
    });
})();

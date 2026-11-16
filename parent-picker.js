// Phase 4.2: "Choose a parent" popup for the task editor. It shows the task hierarchy of the General list with its own
// filters (AND / OR) and sort. Rules (shield, AI audit, recurrence, depth, cycles) come from the editor as `blockReason`;
// this file only draws the tree, asks for confirmation, and returns the choice. It never changes any task.
(function () {
    'use strict';
    const tr = (k, v) => (window.TaskitatorI18n?.t ? window.TaskitatorI18n.t(k, v) : String(k).replace(/\{(\w+)\}/g, (_, x) => (v || {})[x] ?? ''));
    const el = (tag, text, parent, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; if (parent) parent.append(e); return e; };
    const newFilters = () => ({ tags: new Set(), priorities: new Set(), projects: new Set(), date: { mode: '', from: '', to: '' }, logic: 'and' });

    // opts: { task, tasks, currentParentId, projects[], priorities[], tags[], sortMode, blockReason(id|null) -> string|null,
    //         active(filters), match(task, filters, ctx), sort(list, mode), today }
    function open(opts) {
        return new Promise(resolve => {
            const tasks = (opts.tasks || []).filter(t => t && t.status === 'active');
            const all = new Map((opts.tasks || []).map(t => [t.id, t]));
            const kids = new Map();
            const roots = [];
            for (const t of tasks) {
                if (t.parent_id && all.has(t.parent_id)) {
                    if (!kids.has(t.parent_id)) kids.set(t.parent_id, []);
                    kids.get(t.parent_id).push(t);
                } else if (!t.parent_id) roots.push(t);
            }
            const filters = newFilters();
            let sortMode = ['priority', 'alpha', 'required'].includes(opts.sortMode) ? opts.sortMode : 'priority';
            const expanded = new Set();
            for (let n = all.get(opts.currentParentId), i = 0; n && i < 100; n = n.parent_id ? all.get(n.parent_id) : null, i++) expanded.add(n.id);
            const prios = new Map((opts.priorities || []).map(p => [p.id, p]));
            const projs = new Map((opts.projects || []).map(p => [p.id, p]));

            const dlg = el('dialog', undefined, undefined, 'parent-picker');
            dlg.setAttribute('aria-label', tr('Choose a parent task'));
            const head = el('div', undefined, dlg, 'pp-head');
            el('h3', tr('Choose a parent task'), head);
            const close = el('button', '✕', head, 'icon-btn pp-close'); close.type = 'button'; close.setAttribute('aria-label', tr('Close'));
            el('p', tr('Moving "{task}". Its subtasks move with it.', { task: opts.task.title }), dlg, 'pp-hint');

            const bar = el('div', undefined, dlg, 'pp-bar');
            const sortSel = el('select', undefined, bar, 'pp-sort'); sortSel.setAttribute('aria-label', tr('Sort'));
            for (const [v, label] of [['priority', tr('By priority')], ['alpha', tr('A to Z')], ['required', tr('Required first, then priority')]]) { const o = el('option', label, sortSel); o.value = v; }
            sortSel.value = sortMode;
            sortSel.addEventListener('change', () => { sortMode = sortSel.value; draw(); });

            const fbox = el('details', undefined, dlg, 'pp-filters');
            const fsum = el('summary', tr('Filters'), fbox);
            const fdot = el('span', undefined, fsum, 'pp-filter-dot');
            const fbody = el('div', undefined, fbox, 'pp-filters-body');

            const chips = (title, items, set, render) => {
                el('div', title, fbody, 'filter-section-title');
                const wrap = el('div', undefined, fbody, 'tag-select-cloud');
                for (const it of items) {
                    const b = el('button', undefined, wrap, 'filter-pill' + (set.has(it.id) ? ' selected' : '')); b.type = 'button';
                    render(b, it);
                    b.addEventListener('click', () => { if (set.has(it.id)) set.delete(it.id); else set.add(it.id); b.classList.toggle('selected', set.has(it.id)); draw(); });
                }
            };
            const logicRow = el('div', undefined, fbody, 'filter-logic-row');
            const logicSel = el('select', undefined, logicRow); logicSel.setAttribute('aria-label', tr('Match all or any filter'));
            for (const [v, label] of [['and', tr('AND: all chosen filters must match')], ['or', tr('OR: any chosen filter can match')]]) { const o = el('option', label, logicSel); o.value = v; }
            logicSel.addEventListener('change', () => { filters.logic = logicSel.value === 'or' ? 'or' : 'and'; draw(); });
            chips(tr('Projects'), (opts.projects || []).map(p => ({ id: p.id, name: p.name })), filters.projects, (b, p) => { b.textContent = p.name; });
            chips(tr('Priorities'), (opts.priorities || []).map(p => ({ id: p.id, name: p.name })), filters.priorities, (b, p) => { b.textContent = p.name; });
            chips(tr('Tags'), (opts.tags || []).map(t => ({ id: t })), filters.tags, (b, t) => { b.textContent = t.id; });
            el('div', tr('Date'), fbody, 'filter-section-title');
            const dateSel = el('select', undefined, fbody); dateSel.setAttribute('aria-label', tr('Filter by date'));
            for (const [v, label] of [['', tr('Any date')], ['overdue', tr('Overdue')], ['today', tr('Today')], ['week', tr('Next 7 days')], ['none', tr('No date')]]) { const o = el('option', label, dateSel); o.value = v; }
            dateSel.addEventListener('change', () => { filters.date = { mode: dateSel.value, from: '', to: '' }; draw(); });
            const clear = el('button', tr('Clear All'), fbody, 'icon-btn pp-clear'); clear.type = 'button';
            clear.addEventListener('click', () => {
                filters.tags.clear(); filters.priorities.clear(); filters.projects.clear();
                filters.date = { mode: '', from: '', to: '' }; filters.logic = 'and'; logicSel.value = 'and'; dateSel.value = '';
                for (const b of fbody.querySelectorAll('.filter-pill.selected')) b.classList.remove('selected');
                draw();
            });

            const listBox = el('div', undefined, dlg, 'pp-list'); listBox.setAttribute('role', 'tree');
            const msg = el('p', undefined, dlg, 'pp-msg'); msg.setAttribute('role', 'status'); msg.hidden = true;
            const foot = el('div', undefined, dlg, 'pp-foot');
            const cancel = el('button', tr('Cancel'), foot, 'icon-btn'); cancel.type = 'button';

            let done = false;
            const finish = value => { if (done) return; done = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(value); };
            close.addEventListener('click', () => finish(null));
            cancel.addEventListener('click', () => finish(null));
            dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });

            const say = text => { msg.textContent = text; msg.hidden = !text; };
            async function choose(id, title) {
                const reason = opts.blockReason(id);
                if (reason) { say(reason); window.TaskitatorFX?.deny?.(); return; }
                if ((id || null) === (opts.currentParentId || null)) { finish(null); return; }
                const message = id
                    ? tr('Move "{task}" under "{parent}"? Its subtasks move with it.', { task: opts.task.title, parent: title })
                    : tr('Move "{task}" to the root level? Its subtasks move with it.', { task: opts.task.title });
                const ok = await window.TaskitatorConfirm({ title: tr('Move task?'), message, confirmLabel: tr('Move') });
                if (ok) finish({ parentId: id || null });
            }

            function draw() {
                const on = opts.active(filters);
                fdot.hidden = !on;
                say('');
                listBox.replaceChildren();
                const ctx = { dynamicPriority: opts.dynamicPriority, index: all, today: opts.today };
                const hit = new Map(), below = new Map();
                if (on) {
                    for (const t of tasks) hit.set(t.id, opts.match(t, filters, ctx));
                    const walk = (id, seen = new Set()) => {
                        if (below.has(id)) return below.get(id);
                        if (seen.has(id)) return false; seen.add(id);
                        let any = false;
                        for (const k of kids.get(id) || []) if (hit.get(k.id) || walk(k.id, seen)) any = true;
                        below.set(id, any); return any;
                    };
                    for (const t of tasks) walk(t.id);
                }
                const shown = t => !on || hit.get(t.id) || below.get(t.id);

                // Root level row
                const rootRow = el('button', tr('Root level (no parent)'), listBox, 'pp-row pp-root'); rootRow.type = 'button'; rootRow.setAttribute('role', 'treeitem');
                if (!opts.currentParentId) el('span', tr('Current parent'), rootRow, 'pp-tag');
                const rootWhy = opts.blockReason(null);
                if (rootWhy) rootRow.classList.add('is-blocked');
                rootRow.addEventListener('click', () => choose(null, ''));

                let count = 0;
                const node = (t, depth) => {
                    const list = (kids.get(t.id) || []).filter(shown);
                    const open = on ? true : expanded.has(t.id);
                    const row = el('div', undefined, listBox, 'pp-row-wrap');
                    row.style.setProperty('--pp-depth', String(depth));
                    const tw = el('button', list.length ? (open ? '▾' : '▸') : '', row, 'pp-twist'); tw.type = 'button';
                    tw.disabled = !list.length || on; tw.setAttribute('aria-label', open ? tr('Collapse') : tr('Expand'));
                    tw.addEventListener('click', () => { if (expanded.has(t.id)) expanded.delete(t.id); else expanded.add(t.id); draw(); });
                    const b = el('button', undefined, row, 'pp-row'); b.type = 'button'; b.setAttribute('role', 'treeitem');
                    const p = prios.get(t.priority_id);
                    if (p?.color) { const d = el('span', undefined, b, 'pp-prio'); d.style.background = window.TaskitatorSafety?.cssColor ? window.TaskitatorSafety.cssColor(p.color) : p.color; }
                    el('span', t.title, b, 'pp-title');
                    const proj = !t.parent_id ? projs.get(t.project_id || 'inbox') : null;
                    if (proj && proj.id !== 'inbox') el('span', proj.name, b, 'pp-chip');
                    if (t.id === opts.currentParentId) el('span', tr('Current parent'), b, 'pp-tag');
                    if (on && !hit.get(t.id)) b.classList.add('is-context');
                    const why = opts.blockReason(t.id);
                    if (why) { b.classList.add('is-blocked'); b.title = why; el('small', why, b, 'pp-why'); }
                    b.addEventListener('click', () => choose(t.id, t.title));
                    count++;
                    if (open) for (const k of opts.sort(list.slice(), sortMode)) node(k, depth + 1);
                };
                for (const r of opts.sort(roots.filter(shown), sortMode)) node(r, 0);
                if (!count) el('p', on ? tr('No tasks match these filters.') : tr('No active tasks found in workspace.'), listBox, 'pp-empty');
            }

            document.body.append(dlg);
            dlg.showModal();
            draw();
            dlg.querySelector('.pp-row.is-blocked')?.blur?.();
        });
    }

    window.TaskitatorParentPicker = Object.freeze({ open });
})();

/* Study plans view (Phase 2.4a, redesigned in 2.6; drafts tab and Emergency Bypass button in 2.8; a view of the index.html shell since 3.0). Lists the plans made by study recurrence and edits them through TaskitatorStudyManage.
   One open plan, three tabs (Task info, AI criteria, Scheduling) and one save bar. Saving is sequential, not atomic:
   task info and criteria are pushed first, then the schedule is re-planned by the Worker.
   Rules enforced by the Worker, mirrored here: editing needs Pro; deleting needs a server grant; plans with AI criteria cost
   2 Emergency Bypass uses (1 more if a window is already open). Viewing, finishing and deleting stay open after Pro ends. */
(() => {
'use strict';
const TASKS = 'taskitator_tasks', STATE = 'taskitator_recurrence_state', SETTINGS = 'taskitator_settings';
const M = window.TaskitatorStudyManage, S = window.TaskitatorStudyCore;
const $ = id => document.getElementById(id);
const tr = (key, vars) => (window.TaskitatorI18n?.t ? window.TaskitatorI18n.t(key, vars) : key.replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? ''));
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch (e) { return fallback; } };
function el(tag, text, parent, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; if (parent) parent.append(e); return e; }
let tasks = [], state = { series: [], history: [] }, settings = {}, pro = null, bypass = { active: false, until: 0, uses: null }, busy = false, checking = false;
let current = null, pageTab = 'plans';
const Drafts = () => window.TaskitatorDrafts;
const drafts = new Map(), validated = new Map();
const status = text => { $('plansStatus').textContent = text || ''; };
const syncing = () => window.SyncEngine && typeof SyncEngine.isConfigured === 'function' && SyncEngine.isConfigured();

function load() { tasks = read(TASKS, []); state = read(STATE, { series: [], history: [] }); settings = read(SETTINGS, {}); }
async function access() {
    try { pro = (await TaskitatorAuth.api('/pro/status')).isPro === true; } catch (e) { pro = null; }
    try { const e = await TaskitatorAuth.api('/emergency'); bypass = { active: !!e.active_until && Date.parse(e.active_until) > Date.now(), until: e.active_until ? Date.parse(e.active_until) : 0, uses: Number.isFinite(e.uses_left) ? e.uses_left : null }; } catch (e) { /* keep last known */ }
}
const canEdit = () => pro === true;
const planOf = id => M.plans(tasks).find(p => p.id === id);
function localToday() {
    const h = Number(settings.day_start_hour) || 0, d = new Date(Date.now() - (h >= 0 && h <= 4 ? h : 0) * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Save, push now, and put everything back if the server refuses (offline keeps the change and syncs later). Returns true when saved.
async function commit(change, done) {
    if (busy) return false;
    load();
    busy = true; render();
    const before = { tasks: localStorage.getItem(TASKS), state: localStorage.getItem(STATE) };
    let ok = false;
    try {
        const result = change();
        const savedTasks = JSON.stringify(result.tasks);
        const savedState = result.state && JSON.stringify(result.state);
        localStorage.setItem(TASKS, savedTasks);
        if (savedState) localStorage.setItem(STATE, savedState);
        if (window.SyncEngine && SyncEngine.markLocalModified) SyncEngine.markLocalModified();
        if (syncing()) {
            const sent = await SyncEngine.syncNow({ origin: 'manual' });
            if (sent && sent.success === false && !['offline', 'unconfigured', 'session_changed'].includes(sent.reason)) {
                for (const [key, saved, value] of [[TASKS, savedTasks, before.tasks], [STATE, savedState, before.state]]) {
                    if (!saved || localStorage.getItem(key) !== saved) continue;
                    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
                }
                window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
                throw Error(sent.error || sent.message || 'The server did not accept this change. Nothing was changed.');
            }
        }
        window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
        status(done ? done(result) : tr('Saved.')); ok = true;
    } catch (e) { status(e.message); }
    finally { load(); await access(); busy = false; render(); }
    return ok;
}

function fmtDate(d) { return d ? new Date(d + 'T00:00:00Z').toLocaleDateString(document.documentElement.lang === 'ar' ? 'ar' : undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; }
function field(label, parent, value, type = 'text') {
    const wrap = el('label', label, parent, 'plan-field'), input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', undefined, wrap);
    if (type !== 'select' && type !== 'textarea') input.type = type; if (value !== undefined && type !== 'select') input.value = value; return input;
}
const priorityName = (list, id) => id === undefined ? tr('Mixed') : id === null ? tr('No priority') : (list.find(p => p.id === id)?.name || id);
const newRev = () => Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'a').padEnd(6, 'a');
const MIXED = '__mixed';

// ---- drafts: what the person has typed but not saved ----
function draftFor(plan) {
    let d = drafts.get(plan.id);
    if (!d) { d = { tab: 'info', info: infoOf(plan), ai: { criteria: '', exclude: '' }, sched: null, host: null, rev: null }; drafts.set(plan.id, d); mountSchedule(plan, d); }
    return d;
}
const infoOf = plan => ({ title: plan.base, unit: plan.unit, parent: plan.parentPriority === undefined ? MIXED : plan.parentPriority ?? '', unitP: plan.unitPriority === undefined ? MIXED : plan.unitPriority ?? '' });
const origInfo = plan => infoOf(plan);
const infoDirty = (plan, d) => { const o = origInfo(plan); return d.info.title !== o.title || d.info.unit !== o.unit || d.info.parent !== o.parent || d.info.unitP !== o.unitP; };
const aiDirty = d => Boolean(d.ai.criteria.trim() || d.ai.exclude.trim());
const schedDirty = d => Boolean(d.sched?.state().touched);
const anyDirty = () => [...drafts.entries()].some(([id, d]) => { const p = planOf(id); return p && (infoDirty(p, d) || aiDirty(d) || schedDirty(d)); });

function keepUnits(plan, { startUnit, skipText }) {
    const nums = plan.units.map(M.unitNumber).filter(n => n !== null).sort((a, b) => a - b), have = new Set(nums), gaps = [];
    for (let n = nums[0]; n <= nums.at(-1); n++) if (!have.has(n)) gaps.push(n);
    const skipped = String(skipText || '').trim() ? S.parseSkips(skipText, nums[0], nums.length, gaps) : [], sk = new Set(skipped);
    const keep = M.openUnits(plan).filter(n => !sk.has(n) && (startUnit === null || n >= startUnit));
    return { keep, skipped, startUnit };
}
function replanOptions(plan, d, st) {
    const k = keepUnits(plan, st.options);
    return { rev: d.rev || (d.rev = newRev()), start: st.sched[0].date, mode: 'days', days: st.sched.length, weekdays: st.options.weekdays, start_unit: k.startUnit, skipped: k.skipped, counts: st.sched.map(x => x.count), dates: st.sched.map(x => x.date) };
}
// What the previewed schedule would do, once it is balanced. null until then.
function analysis(plan, d) {
    const st = d.sched.state();
    if (!st.hasPreview || st.stale || st.balance !== 0 || !st.sched.length) return null;
    try {
        const opts = replanOptions(plan, d, st), result = M.replan(tasks, plan.id, opts);
        return { opts, result, impact: M.replanImpact(tasks, result.tasks, plan.id, localToday(), settings) };
    } catch (e) { return { error: e.message }; }
}
const todayPending = () => { try { return window.TaskitatorStatusCount?.pending ? window.TaskitatorStatusCount.pending(tasks, localToday()) : true; } catch (e) { return true; } };

function mountSchedule(plan, d) {
    const id = plan.id, P = () => planOf(id);
    d.host = el('div', undefined, undefined, 'plan-sched');
    const open = M.openUnits(plan), cur = M.currentSchedule(plan, localToday(), S.defaultDays(settings));
    d.sched = window.TaskitatorStudySchedule.mount(d.host, {
        today: localToday(), start: cur.start, weekdays: cur.weekdays, mode: cur.mode, per: cur.per, rates: cur.rates, startUnit: '', startUnitHint: open[0],
        days: Math.min(open.length, Math.max(1, plan.parents.filter(p => p.status === 'active').length)),
        note: tr('{done} of {total} units done. Only the {n} unfinished units move; finished units and past days stay as they are.', { done: plan.done, total: plan.total, n: open.length }),
        label: () => P()?.unit || tr('Unit'),
        units: opts => keepUnits(P(), opts).keep,
        fixed: () => {
            const p = P(), out = new Map(); if (!p) return out;
            const byId = new Map(p.parents.map(x => [x.id, x]));
            for (const u of p.units) if (u.status === 'completed') {
                const date = (u.due_date || byId.get(u.parent_id)?.due_date || '').slice(0, 10); if (!date) continue;
                if (!out.has(date)) out.set(date, []);
                out.get(date).push({ text: (p.unit || tr('Unit')) + '.' + M.unitNumber(u), done: true });
            }
            return out;
        },
        parentTitle: (index, date) => { const p = P(), a = p && drafts.get(id) && analysis(p, drafts.get(id)); return a?.result?.tasks.find(t => !t.parent_id && t.study_plan_id === id && t.due_date === date && t.id.includes('_' + a.opts.rev + '_day_'))?.title || ''; },
        chip: (n, date) => {
            const p = P(), dr = drafts.get(id), a = p && dr && analysis(p, dr), unit = p?.units.find(u => M.unitNumber(u) === n), label = (p?.unit || tr('Unit')) + '.' + n;
            const locked = unit && M.isAudited(unit), later = locked && a?.impact?.later.includes(unit.id);
            return { text: label + (later ? ' · ' + tr('later') : ''), cls: (locked ? 'is-locked' : '') + (later ? ' is-later' : '') };
        },
        notes: () => {
            const p = P(), dr = drafts.get(id), a = p && dr && analysis(p, dr), out = [];
            if (!a) return out;
            if (a.error) return [{ text: a.error, warn: true }];
            if (a.impact.later.length) out.push({ warn: !bypass.active, text: bypass.active ? tr('{n} AI-audited unit(s) move later or are removed. Emergency Bypass is active, so this is allowed (no extra use).', { n: a.impact.later.length }) : tr('{n} AI-audited unit(s) move later or are removed. Activate it with the Emergency Bypass button at the top of this page (1 use, 15 minutes).', { n: a.impact.later.length }) });
            if (a.impact.today.length && todayPending()) out.push({ warn: !bypass.active, text: bypass.active ? tr('Work due today moves off today. Emergency Bypass is active, so this is allowed.') : tr('Work due today moves off today. That is locked until all of today\'s tasks are finished or Emergency Bypass is on.') });
            return out;
        },
        disabled: () => !canEdit() || busy,
        onChange: () => chrome()
    });
}

// ---- save bar and tab dots ----
let ui = { dots: {} };
function barInfo(plan, d) {
    const dirty = { info: infoDirty(plan, d), ai: aiDirty(d), sched: schedDirty(d) }, names = [];
    if (dirty.info) names.push(tr('Task info')); if (dirty.ai) names.push(tr('AI criteria')); if (dirty.sched) names.push(tr('Scheduling'));
    const info = { dirty, ok: names.length > 0, msg: names.length ? tr('Unsaved: {list}', { list: names.join(', ') }) : tr('No changes'), apply: dirty.sched };
    if (!names.length) return info;
    const fail = msg => { info.ok = false; info.msg = msg; };
    if (dirty.info && !d.info.title?.trim() && plan.base) fail(tr('Enter a title, up to 160 characters.'));
    if (dirty.info && (d.info.parent !== origInfo(plan).parent || d.info.unitP !== origInfo(plan).unitP) && (d.info.parent === MIXED || d.info.unitP === MIXED)) fail(tr('Choose a priority for both fields.'));
    if (dirty.ai) { if (!d.ai.criteria.trim()) fail(tr('Enter the criteria for the units.')); else try { if (!M.auditTargets(plan, d.ai.exclude).numbers.length) fail(tr('Select at least one unfinished unit.')); } catch (e) { fail(e.message); } }
    if (dirty.sched) {
        const st = d.sched.state();
        if (!st.hasPreview) fail(tr('Generate a preview to save the schedule.'));
        else if (st.stale) fail(tr('Preview the new schedule again to apply it.'));
        else if (st.balance !== 0) fail(tr(st.balance > 0 ? 'Settle {n} surplus unit(s) first.' : 'Settle {n} missing unit(s) first.', { n: Math.abs(st.balance) }));
        else {
            const a = analysis(plan, d);
            if (!a || a.error) fail(a?.error || tr('Generate a preview to save the schedule.'));
            else if (a.impact.later.length && !bypass.active) fail(tr('AI units move later: activate Emergency Bypass first.'));
            else if (a.impact.today.length && todayPending() && !bypass.active) fail(tr('Work due today moves off today: finish today\'s tasks or activate Emergency Bypass.'));
        }
    }
    return info;
}
function chrome() {
    const plan = current && planOf(current), bar = $('planSaveBar');
    if (!plan || !canEdit()) { bar.hidden = true; return; }
    const d = draftFor(plan), info = barInfo(plan, d);
    for (const [k, dot] of Object.entries(ui.dots)) dot.hidden = !info.dirty[k];
    bar.hidden = false; $('planSaveMsg').textContent = info.msg;
    $('planDiscard').disabled = busy || !info.dirty.info && !info.dirty.ai && !info.dirty.sched;
    $('planSaveDraft').disabled = busy || !Drafts() || !info.dirty.info && !info.dirty.ai && !info.dirty.sched;
    const save = $('planSave'); save.textContent = info.apply ? tr('Apply re-plan') : tr('Save changes');
    save.classList.toggle('is-apply', info.apply && info.ok); save.disabled = busy || checking || !info.ok;
}

// ---- cards ----
function card(plan, parent) {
    const list = M.prioritiesOf(settings), isOpen = current === plan.id;
    const c = el('section', undefined, parent, 'plan-card');
    const top = el('div', undefined, c, 'plan-top'); el('h2', plan.base || tr('Study plan'), top);
    const badges = el('div', undefined, top, 'plan-badges');
    el('span', plan.finished ? tr('Finished') : tr('In progress'), badges, 'plan-badge');
    if (plan.audited) el('span', tr('AI audited: {n}', { n: plan.audited }), badges, 'plan-badge ai');
    if (plan.bonus) el('span', tr('Bonus: {done} of {n}', { done: plan.bonusDone, n: plan.bonus }), badges, 'plan-badge');
    el('p', tr('{done} of {total} done', { done: plan.done, total: plan.total }) + ' · ' + tr('{n} study days', { n: plan.days }) + (plan.start ? ' · ' + fmtDate(plan.start) + ' – ' + fmtDate(plan.end) : ''), c, 'plan-meta');
    const bar = el('div', undefined, c, 'plan-bar'); el('span', undefined, bar).style.width = (plan.total ? Math.round(plan.done / plan.total * 100) : 0) + '%';
    const actions = el('div', undefined, c, 'plan-actions');
    const toggle = el('button', isOpen ? tr('Close') : tr('Edit'), actions, 'icon-btn'); toggle.type = 'button'; toggle.disabled = busy;
    toggle.addEventListener('click', () => { current = isOpen ? null : plan.id; render(); });
    if (plan.ready) {
        const fin = el('button', tr('Complete'), actions, 'icon-btn'); fin.type = 'button'; fin.disabled = busy; fin.dataset.act = 'bonus-finish';
        fin.addEventListener('click', () => finishBonus(plan));
        const conv = el('button', tr('Convert bonus to required'), actions, 'icon-btn'); conv.type = 'button'; conv.disabled = busy; conv.dataset.act = 'bonus-convert';
        conv.addEventListener('click', () => convertBonus(plan));
        el('p', tr('All required units are done. The plan stays open until you complete it, finish the {n} bonus unit(s), or convert them to required.', { n: plan.bonusLeft }), c, 'plan-hint');
    }
    bonusBlock(plan, c);
    const late = lateCount(plan);
    if (late) {
        const soft = el('button', pro === true ? tr('Soft reschedule') : tr('Soft reschedule (Pro)'), actions, 'icon-btn'); soft.type = 'button'; soft.disabled = busy; soft.dataset.act = 'soft';
        soft.addEventListener('click', () => openSoft(plan));
        const mv = el('button', tr('Move overdue to today'), actions, 'icon-btn'); mv.type = 'button'; mv.disabled = busy; mv.dataset.act = 'today';
        mv.addEventListener('click', () => moveToToday(plan));
        el('p', tr('{n} overdue unit(s). Soft reschedule spreads them over the coming study days; Move overdue to today stacks them on today.', { n: late }), c, 'plan-hint');
    }
    if (!isOpen) return;
    if (plan.bonusLeft) el('p', tr('Re-planning is off while the plan has unfinished bonus units. Complete the plan or convert the bonus units to required first.'), c, 'plan-hint warn');
    const d = draftFor(plan), edit = canEdit() && !busy;
    if (!canEdit()) el('p', pro === null ? tr('Could not confirm your Pro license, so editing is off. You can still delete this plan.') : tr('Editing study plans needs an active Pro license. You can still view, finish and delete this plan.'), c, 'plan-hint warn');
    const tabs = el('div', undefined, c, 'tk-tabs'); tabs.setAttribute('role', 'tablist'); ui = { dots: {} };
    for (const [key, text] of [['info', tr('Task info')], ['ai', tr('AI criteria')], ['sched', tr('Scheduling')]]) {
        const b = el('button', text, tabs, 'tk-tab'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(d.tab === key));
        ui.dots[key] = el('span', undefined, b, 'tk-tab-dot'); ui.dots[key].hidden = true;
        b.addEventListener('click', () => {
            const panel = c.querySelector('.plan-panel');
            clearTimeout(d.tabTransition);
            if (panel) panel.classList.remove('study-panel-leaving');
            if (d.tab === key) return;
            const apply = () => { if (!c.isConnected) return; d.tab = key; render(); };
            if (!panel || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
            panel.classList.add('study-panel-leaving');
            d.tabTransition = setTimeout(apply, 140);
        });
    }
    const panel = el('div', undefined, c, 'plan-panel');
    if (d.tab === 'info') infoTab(plan, d, panel, list, edit);
    else if (d.tab === 'ai') aiTab(plan, d, panel, edit);
    else { panel.append(d.host); d.sched.disable(); }
    chrome();
}

function infoTab(plan, d, panel, list, edit) {
    const fs = el('fieldset', undefined, panel, 'plan-fs'); fs.disabled = !edit; fs.style.cssText = 'border:0;padding:0;margin:0;min-width:0';
    if (plan.base) {
        const title = field(tr('Title'), fs, d.info.title); title.maxLength = 160;
        title.addEventListener('input', () => { d.info.title = title.value; chrome(); });
        if (plan.custom) el('p', tr('{n} day(s) have their own custom title and are not changed.', { n: plan.custom }), fs, 'plan-hint');
    } else el('p', tr('This plan has custom day titles, so there is no single title to change.'), fs, 'plan-hint');
    const grid = el('div', undefined, fs, 'plan-grid');
    if (plan.unit) {
        const unit = field(tr('Unit name'), grid, d.info.unit), locked = plan.audited > 0 && !bypass.active; unit.maxLength = 40; unit.disabled = !edit || locked;
        unit.addEventListener('input', () => { d.info.unit = unit.value; chrome(); });
    } else el('div', undefined, grid);
    const choices = [['', tr('No priority')], ...list.map(p => [p.id, p.name || p.id])];
    const make = (label, key) => { const s = field(label, grid, undefined, 'select'); if (d.info[key] === MIXED) el('option', tr('Mixed'), s).value = MIXED; for (const [v, t] of choices) el('option', t, s).value = v; s.value = d.info[key]; s.addEventListener('change', () => { d.info[key] = s.value; chrome(); }); return s; };
    make(tr('Parent task priority'), 'parent'); make(tr('Unit priority'), 'unitP');
    el('p', tr('Units cannot be more important than their parent. Finished tasks keep their priority.'), fs, 'plan-hint');
    if (plan.audited && plan.unit) el('p', bypass.active ? tr('Emergency Bypass is active, so audited units can be renamed.') : tr('This plan has AI-audited units. Renaming them needs Emergency Bypass: use the Emergency Bypass button at the top of this page.'), fs, 'plan-hint warn');
    // Deleting stays outside the save bar and outside Pro.
    const del = el('div', undefined, panel, 'plan-delbox');
    const b = el('button', tr('Delete plan'), del, 'icon-btn plan-delete'); b.type = 'button'; b.disabled = busy; b.addEventListener('click', () => removePlan(plan));
    el('p', plan.audited > 0 ? tr('This plan has AI criteria: deleting costs 2 Emergency Bypass uses (1 if a bypass window is open).') : tr('Allowed: this plan has no AI criteria, so deleting it is free.'), del, 'plan-hint');
}

function aiTab(plan, d, panel, edit) {
    const open = M.openUnits(plan);
    if (!open.length) { el('p', tr('All units are finished, so there is nothing left to audit.'), panel, 'plan-hint'); return; }
    const fs = el('fieldset', undefined, panel, 'plan-fs'); fs.disabled = !edit; fs.style.cssText = 'border:0;padding:0;margin:0;min-width:0';
    const criteria = field(tr('Proof criteria for the units. Use {num} for each unit number.'), fs, d.ai.criteria, 'textarea'); criteria.maxLength = 4000; criteria.rows = 4;
    const ex = field(tr('Exclude units from the criteria (optional)'), fs, d.ai.exclude); ex.placeholder = '8, 10-12'; ex.dir = 'ltr'; ex.inputMode = 'numeric';
    el('p', tr('Every unfinished unit gets the criteria unless you list it here. Finished units are never included.'), fs, 'plan-hint');
    const chips = el('div', undefined, fs, 'plan-chips'), note = el('p', '', fs, 'plan-hint'), check = el('p', '', fs, 'plan-hint');
    if (plan.audited) el('p', tr('Units that already have criteria stay locked: they cannot be excluded or changed here. Use the task editor to edit their criteria.'), fs, 'plan-hint warn');
    const paint = () => {
        chips.replaceChildren(); note.textContent = '';
        let t; try { t = M.auditTargets(plan, d.ai.exclude); } catch (e) { note.textContent = e.message; return; }
        const target = new Set(t.numbers), locked = new Set(t.locked), name = plan.unit || tr('Unit');
        for (const n of open) el('span', name + '.' + n, chips, 'plan-chip' + (locked.has(n) ? ' done' : target.has(n) ? ' lock' : ' skip'));
        note.textContent = tr('🔒 = will get the criteria. Struck through = excluded.');
    };
    criteria.addEventListener('input', () => { d.ai.criteria = criteria.value; check.textContent = ''; chrome(); });
    ex.addEventListener('input', () => { d.ai.exclude = ex.value; paint(); chrome(); });
    paint();
    if (settings.strict_criteria_validation !== false) {
        const b = el('button', tr('Check criteria'), fs, 'icon-btn'); b.type = 'button';
        b.addEventListener('click', async () => { try { const v = await validateCriteria(plan, d); check.textContent = v.score + '/10 · ' + v.critique; } catch (e) { check.textContent = e.message; } });
    }
}
const stamp = (plan, d) => JSON.stringify([d.ai.criteria, plan.id]);
async function validateCriteria(plan, d) {
    if (!d.ai.criteria.trim()) throw Error(tr('Enter audit criteria, up to 4,000 characters.'));
    const key = stamp(plan, d); if (validated.has(key)) return validated.get(key);
    const choice = window.TaskitatorEngine.AuditEngine.selection();
    checking = true; chrome();
    try {
        const result = await TaskitatorAuth.api('/study-plan', { method: 'POST', body: JSON.stringify({ action: 'validate', config: M.configOf(plan), criteria: d.ai.criteria, provider: choice.provider, model: choice.primary, key_version: choice.keyVersion }) });
        validated.set(key, result); return result;
    } finally { checking = false; chrome(); }
}

// ---- saving ----
function ask(title, lines, yes) {
    return new Promise(resolve => {
        const dlg = $('planConfirm'), body = $('planConfirmBody'); $('planConfirmTitle').textContent = title; body.replaceChildren();
        const ul = el('ul', undefined, body); for (const l of lines) el('li', l, ul);
        $('planConfirmYes').textContent = yes; let settled = false;
        const finish = v => { if (settled) return; settled = true; if (dlg.open) dlg.close(); resolve(v); };
        $('planConfirmYes').onclick = () => finish(true); $('planConfirmNo').onclick = () => finish(false); dlg.onclose = () => finish(false);
        dlg.showModal();
    });
}
async function save() {
    const plan = current && planOf(current); if (!plan || busy) return;
    const d = draftFor(plan), info = barInfo(plan, d); if (!info.ok) return;
    try {
        if (info.dirty.ai && settings.strict_criteria_validation !== false) {
            const v = await validateCriteria(plan, d);
            if (!v.passed) throw Error(tr('The criteria must pass the check (7/10 or higher). {score}/10 · {critique}', { score: v.score, critique: v.critique }));
        }
    } catch (e) { status(e.message); return; }
    const lines = [];
    if (info.dirty.info) lines.push(tr('Task info: title, unit name and priorities are updated.'));
    if (info.dirty.ai) { const t = M.auditTargets(plan, d.ai.exclude); lines.push(tr('AI criteria are added to {n} unit(s). They cannot be edited or removed later except by deleting the plan, which uses 2 Emergency Bypass uses.', { n: t.numbers.length })); }
    let a = null;
    if (info.dirty.sched) {
        a = analysis(plan, d);
        lines.push(tr('Re-plan {n} unfinished units over {d} study days, ending {date}.', { n: a.result.scheduled, d: a.result.days, date: fmtDate(a.result.end) }) + (a.result.removed ? ' ' + tr('{n} unfinished unit(s) will be removed.', { n: a.result.removed }) : ''));
        lines.push(tr('Finished units and past days stay as they are.'));
        if (info.dirty.info || info.dirty.ai) lines.push(tr('Saved in two steps: task info and criteria first, then the schedule. If the schedule step fails, the first step stays saved.'));
    }
    if (!await ask(info.apply ? tr('Apply re-plan?') : tr('Save changes?'), lines, info.apply ? tr('Apply re-plan') : tr('Save'))) return;
    if (info.dirty.info || info.dirty.ai) {
        const ok = await commit(() => {
            let t = tasks;
            const latest = planOf(plan.id);
            if (!latest) throw Error(tr('This plan no longer exists. Delete the draft.'));
            if (info.dirty.info) {
                const o = origInfo(plan);
                if (plan.base && d.info.title !== o.title) t = M.renamePlan(t, plan.id, d.info.title).tasks;
                if (plan.unit && d.info.unit !== o.unit) t = M.renameUnit(t, plan.id, d.info.unit, d.info.unit.trim() + 's', { bypass: bypass.active }).tasks;
                if (d.info.parent !== o.parent || d.info.unitP !== o.unitP) t = M.setPriorities(t, plan.id, { parent: d.info.parent || null, unit: d.info.unitP || null }, settings).tasks;
            }
            if (info.dirty.ai) t = M.addCriteria(t, plan.id, d.ai.criteria, M.auditTargets(latest, d.ai.exclude).numbers).tasks;
            return { tasks: t };
        }, () => tr('Saved.'));
        if (!ok) return;
        const fresh = planOf(plan.id); if (fresh) { d.info = infoOf(fresh); d.ai = { criteria: '', exclude: '' }; }
        if (!info.dirty.sched) { drafts.delete(plan.id); Drafts()?.removeStudy('edit_' + plan.id); render(); return; }
    }
    if (info.dirty.sched) { const fresh = planOf(plan.id); if (fresh) await applyReplan(fresh, d); }
}

async function applyReplan(plan, d) {
    if (busy) return;
    const st = d.sched.state(); let opts;
    busy = true; render();
    let answer;
    try {
        opts = replanOptions(plan, d, st);
        if (!syncing()) throw Error(tr('Connect your account to re-plan a study plan.'));
        if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false) throw Error(sent.error || tr('Sync first, then try again.')); }
        answer = await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'replan', plan_id: plan.id, options: opts }) });
    } catch (e) { d.rev = null; status(e.message); busy = false; await access(); render(); return; }
    busy = false;
    const ok = await commit(() => { const ids = M.planTree(tasks, plan.id); return { tasks: [...tasks.filter(t => !ids.has(t.id)), ...answer.tasks], answer }; }, () => tr('Re-planned: {n} units over {d} study days.', { n: answer.scheduled, d: answer.days }));
    if (ok) { drafts.delete(plan.id); Drafts()?.removeStudy('edit_' + plan.id); render(); }
}

// ---- soft reschedule (Phase 2.9) ----
const lateCount = plan => { try { return plan.finished ? 0 : M.softOverdue(tasks, plan.id, localToday()).length; } catch (e) { return 0; } };
const rangeText = nums => {
    const out = []; let i = 0;
    while (i < nums.length) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; out.push(j > i ? nums[i] + '–' + nums[j] : String(nums[i])); i = j + 1; }
    return out.join(', ');
};
function softPreview(plan, o) {
    const r = M.softReschedule(tasks, plan.id, { rev: 'preview', ...o }, localToday()), by = new Map(r.tasks.map(t => [t.id, t])), rows = new Map();
    for (const t of r.tasks) if (t.parent_id && t.study_plan_id === plan.id && t.status === 'active') { const d = by.get(t.parent_id)?.due_date; if (!rows.has(d)) rows.set(d, []); rows.get(d).push(M.unitNumber(t)); }
    return { r, rows: [...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => [d, n.sort((a, b) => a - b)]) };
}
async function sendSoft(plan, options) {
    if (!syncing()) throw Error(tr('Connect your account to reschedule a study plan.'));
    if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false) throw Error(sent.error || tr('Sync first, then try again.')); }
    const answer = await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'soften', plan_id: plan.id, options }) });
    return commit(() => { const ids = M.planTree(tasks, plan.id); return { tasks: [...tasks.filter(t => !ids.has(t.id)), ...answer.tasks], answer }; },
        r => options.mode === 'today' ? tr('Moved {n} overdue unit(s) to today.', { n: r.answer.moved }) : tr('Rescheduled: {n} overdue unit(s) spread over the coming study days.', { n: r.answer.overdue }));
}
function openSoft(plan) {
    if (busy) return;
    if (pro !== true) { status(pro === null ? tr('Could not confirm your Pro license.') : tr('Soft reschedule needs an active Pro license. Use Move overdue to today, or move the days by hand.')); return; }
    const dlg = $('planSoft'), body = $('planSoftBody'), today = localToday(), days = [...M.softDays(plan, today).keys()].sort();
    body.replaceChildren();
    if (!days.length) { status(tr('No study days are left in this plan. Use Move overdue to today.')); return; }
    const late = lateCount(plan), st = { scope: 'max', until: days[0], dates: new Set(days.includes(today) ? [today] : []) };
    el('p', tr('{n} overdue unit(s) are handed out one at a time over the days you choose, starting from today. Every day keeps what it has and only gains.', { n: late }), body, 'plan-hint');
    const scope = field(tr('Spread over'), body, undefined, 'select');
    for (const [v, t] of [['max', tr('Max: all remaining study days')], ['until', tr('Until a date')], ['dates', tr('Specific days')]]) el('option', t, scope).value = v;
    const until = field(tr('Last day'), body, undefined, 'select'); for (const d of days) el('option', fmtDate(d), until).value = d;
    const pick = el('div', undefined, body, 'plan-chips');
    const out = el('div', undefined, body, 'plan-days'), msg = el('p', '', body, 'plan-hint warn'), yes = $('planSoftYes');
    const options = () => st.scope === 'max' ? { mode: 'spread', scope: 'max' } : st.scope === 'until' ? { mode: 'spread', scope: 'until', until: st.until } : { mode: 'spread', scope: 'dates', dates: [...st.dates].sort() };
    const paint = () => {
        until.parentElement.hidden = st.scope !== 'until'; pick.hidden = st.scope !== 'dates';
        pick.replaceChildren();
        for (const d of days) { const b = el('button', fmtDate(d), pick, 'plan-chip' + (st.dates.has(d) ? ' lock' : '')); b.type = 'button'; b.disabled = d === today; b.addEventListener('click', () => { st.dates.has(d) ? st.dates.delete(d) : st.dates.add(d); paint(); }); }
        out.replaceChildren(); msg.textContent = ''; yes.disabled = true;
        try {
            const { r, rows } = softPreview(plan, options());
            const before = new Map(r.counts.map(c => [c.date, c.before]));
            for (const [d, nums] of rows) { const row = el('div', undefined, out, 'plan-day-row'); el('strong', fmtDate(d), row); el('span', (plan.unit || tr('Unit')) + ' ' + rangeText(nums), row, 'plan-day-units'); el('span', (before.has(d) ? before.get(d) + ' → ' : '') + nums.length, row); }
            const locked = r.locked.length;
            msg.textContent = (locked ? tr('{n} AI-audited or shielded unit(s) change day. Their criteria and shield stay.', { n: locked }) + ' ' : '') + tr('Once a day for each plan.');
            msg.className = 'plan-hint'; yes.disabled = false;
        } catch (e) { msg.textContent = e.message; msg.className = 'plan-hint warn'; }
    };
    scope.addEventListener('change', () => { st.scope = scope.value; paint(); }); until.addEventListener('change', () => { st.until = until.value; paint(); });
    paint();
    $('planSoftYes').onclick = async () => { const o = { rev: newRev(), ...options() }; dlg.close(); try { await sendSoft(plan, o); } catch (e) { status(e.message); await access(); render(); } };
    $('planSoftNo').onclick = () => dlg.close();
    dlg.showModal();
}
async function moveToToday(plan) {
    if (busy) return;
    const late = lateCount(plan), audited = M.softOverdue(tasks, plan.id, localToday()).filter(M.isAudited).length;
    if (audited && !bypass.active) { status(tr('{n} overdue unit(s) are AI-audited. Moving them to today needs Emergency Bypass: use the Emergency Bypass button at the top of this page.', { n: audited })); return; }
    const lines = [tr('Move {n} overdue unit(s) to today.', { n: late }), tr('Nothing else in the plan changes.')];
    if (!await ask(tr('Move overdue to today?'), lines, tr('Move'))) return;
    try { await sendSoft(plan, { rev: newRev(), mode: 'today' }); } catch (e) { status(e.message); await access(); render(); }
}

// ---- bonus units (Phase 3.2; add and remove 3.3) ----
// Optional work, so adding or removing it is free and never asks for Emergency Bypass or finished tasks.
const bonusAmount = new Map();
function bonusBlock(plan, parent) {
    const box = el('div', undefined, parent, 'plan-bonus');
    el('strong', tr('Bonus units'), box);
    const hasDays = plan.parents.some(p => p.due_date >= localToday());
    const amount = el('input', undefined, box, 'plan-bonus-count'); amount.type = 'number'; amount.min = '1'; amount.max = '500'; amount.inputMode = 'numeric';
    amount.value = bonusAmount.get(plan.id) || '1'; amount.setAttribute('aria-label', tr('Number of bonus units'));
    amount.addEventListener('input', () => bonusAmount.set(plan.id, amount.value));
    const num = () => Number(amount.value);
    const add = el('button', tr('Add'), box, 'icon-btn'); add.type = 'button'; add.dataset.act = 'bonus-add'; add.disabled = busy || !hasDays;
    add.addEventListener('click', () => addBonus(plan, num()));
    const rem = el('button', tr('Remove'), box, 'icon-btn'); rem.type = 'button'; rem.dataset.act = 'bonus-remove'; rem.disabled = busy || !plan.bonusLeft;
    rem.addEventListener('click', () => removeBonus(plan, num()));
    const all = el('button', tr('Remove all'), box, 'icon-btn'); all.type = 'button'; all.dataset.act = 'bonus-remove-all'; all.disabled = busy || !plan.bonusLeft;
    all.addEventListener('click', () => removeBonus(plan, plan.bonusLeft));
    el('p', tr('Optional extra units at the end of each remaining day. Unfinished ones can be added or removed any time; finished units never change.'), box, 'plan-hint');
}
async function addBonus(plan, n) {
    if (busy) return;
    if (!Number.isInteger(n) || n < 1 || n > 500) { status(tr('Enter a whole number from 1 to 500.')); return; }
    try { await sendBonus(plan, { op: 'add', count: n }); } catch (e) { status(e.message); await access(); render(); }
}
async function removeBonus(plan, n) {
    if (busy) return;
    if (!Number.isInteger(n) || n < 1 || n > 500) { status(tr('Enter a whole number from 1 to 500.')); return; }
    if (n > plan.bonusLeft) { status(tr('The plan has only {n} unfinished bonus unit(s).', { n: plan.bonusLeft })); return; }
    if (!await ask(tr('Remove bonus units?'), [tr('The {n} highest-numbered unfinished unit(s) are removed, along with {n} bonus place(s) at the end of the latest days.', { n }), tr('Required places and finished units do not change.')], tr('Remove'))) return;
    try { await sendBonus(plan, { op: 'remove', count: n }); } catch (e) { status(e.message); await access(); render(); }
}
async function sendBonus(plan, options) {
    if (!syncing()) throw Error(tr('Connect your account to change a study plan with bonus units.'));
    if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false) throw Error(sent.error || tr('Sync first, then try again.')); }
    const answer = await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'bonus', plan_id: plan.id, options }) });
    return commit(() => { const ids = M.planTree(tasks, plan.id); return { tasks: [...tasks.filter(t => !ids.has(t.id)), ...answer.tasks], answer }; },
        r => options.op === 'finish' ? tr('Plan completed. {n} unfinished bonus unit(s) removed.', { n: r.answer.removed })
            : options.op === 'add' ? tr('{n} bonus unit(s) added.', { n: r.answer.added })
            : options.op === 'remove' ? tr('{n} bonus unit(s) removed.', { n: r.answer.removed })
            : tr('{n} bonus unit(s) moved to the next day.', { n: r.answer.missed }));
}
async function finishBonus(plan) {
    if (busy) return;
    if (!await ask(tr('Complete this plan?'), [tr('Every required unit is done. The {n} unfinished bonus unit(s) are removed.', { n: plan.bonusLeft }), tr('This cannot be undone.')], tr('Complete'))) return;
    try { await sendBonus(plan, { op: 'finish' }); } catch (e) { status(e.message); await access(); render(); }
}
async function convertBonus(plan) {
    if (busy) return;
    if (!await ask(tr('Convert bonus to required?'), [tr('The {n} unfinished bonus unit(s) become required, with their AI audits.', { n: plan.bonusLeft }), tr('This cannot be undone.')], tr('Convert'))) return;
    await commit(() => { const r = M.bonusConvert(tasks, plan.id); return { tasks: r.tasks, converted: r.converted }; }, r => tr('{n} bonus unit(s) are now required.', { n: r.converted }));
}
// A bonus unit not finished by the end of its day slides to the next day. Runs quietly when the app opens, regains focus or the day changes.
let sweeping = false; const sweepFailed = new Map();
async function sweepBonus() {
    if (sweeping || busy || !syncing() || !M.bonusWaiting) return;
    if (started && anyDirty()) return;
    sweeping = true;
    try {
        load();
        const today = localToday();
        for (const plan of M.plans(tasks)) {
            if (!M.bonusWaiting(tasks, plan.id, today) || Date.now() - (sweepFailed.get(plan.id) || 0) < 600000) continue;
            const before = localStorage.getItem(TASKS);
            try {
                if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false) throw Error('sync'); }
                load();
                const answer = await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'bonus', plan_id: plan.id, options: { op: 'slide' } }) });
                const ids = M.planTree(tasks, plan.id), saved = JSON.stringify([...tasks.filter(t => !ids.has(t.id)), ...answer.tasks]);
                localStorage.setItem(TASKS, saved);
                SyncEngine.markLocalModified?.();
                const sent = await SyncEngine.syncNow({ origin: 'manual' });
                if (sent && sent.success === false && !['offline', 'unconfigured', 'session_changed'].includes(sent.reason)) {
                    if (localStorage.getItem(TASKS) === saved && before !== null) localStorage.setItem(TASKS, before);
                    throw Error(sent.error || 'rejected');
                }
                window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
                window.TaskitatorNotify?.(tr('{n} bonus unit(s) moved to the next day.', { n: answer.missed }), 'info');
                load();
            } catch (e) { sweepFailed.set(plan.id, Date.now()); }
        }
    } finally { sweeping = false; if (visible && !busy && !anyDirty()) { load(); render(); } }
}

async function removePlan(plan) {
    if (busy) return;
    const guarded = plan.audited > 0;
    const uses = bypass.uses === null ? '' : ' ' + tr('You have {n} use(s) left this week.', { n: bypass.uses });
    const need = bypass.active ? 1 : 2;
    if (guarded && bypass.uses !== null && bypass.uses < need) { status(tr('Deleting a plan with AI criteria needs {need} Emergency Bypass use(s). You have {n} left this week.', { need, n: bypass.uses })); return; }
    const warning = guarded
        ? tr('Delete this plan and all of its tasks? It has AI criteria, so this uses {need} Emergency Bypass use(s) and starts a 15-minute bypass window.', { need }) + uses
        : tr('Delete this plan and all of its tasks?');
    if (!confirm(warning + ' ' + tr('Finished tasks are removed but still count in your stats. This cannot be undone.'))) return;
    busy = true; render();
    try {
        if (syncing()) {
            if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false && sent.reason !== 'offline') throw Error(sent.error || tr('Sync first, then try again.')); }
            await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'delete', plan_id: plan.id }) });
        } else if (guarded) throw Error(tr('Connect your account to delete a plan with AI criteria.'));
    } catch (e) { status(e.message); busy = false; await access(); render(); return; }
    busy = false;
    if (current === plan.id) current = null; drafts.delete(plan.id);
    await commit(() => M.deletePlan(tasks, state, plan.id), r => tr('Plan deleted. {n} tasks removed.', { n: r.removed }));
}

function render() {
    const plans = M.plans(tasks), now = plans.filter(p => !p.finished), done = plans.filter(p => p.finished);
    if (current && !plans.some(p => p.id === current)) current = null;
    $('plansCurrent').replaceChildren(); $('plansPrevious').replaceChildren();
    for (const p of now) card(p, $('plansCurrent'));
    for (const p of done) card(p, $('plansPrevious'));
    $('plansPreviousTitle').hidden = !done.length; $('plansEmpty').hidden = plans.length > 0;
    const note = $('plansNotice');
    note.hidden = canEdit() || !plans.length;
    note.textContent = pro === null ? tr('Could not confirm your Pro license, so editing is off. You can still view and delete plans.') : tr('Editing study plans needs an active Pro license. You can still view, finish and delete plans. Resubscribing restores editing.');
    if (!current || pageTab !== 'plans') $('planSaveBar').hidden = true;
    $('plansListView').hidden = pageTab !== 'plans'; $('plansDraftsView').hidden = pageTab !== 'drafts';
    $('plansTabPlans').setAttribute('aria-selected', String(pageTab === 'plans')); $('plansTabDrafts').setAttribute('aria-selected', String(pageTab === 'drafts'));
    const list = Drafts()?.listStudy() || []; $('plansDraftCount').textContent = list.length ? '(' + list.length + ')' : '';
    if (pageTab === 'drafts') renderDrafts(list);
    paintBypass();
}

// ---- Emergency Bypass: the same backend and rules as the Tasks page ----
let bypassTimer = null;
function paintBypass() {
    const btn = $('plansBypassBtn'), label = $('plansBypassLabel'); if (!btn) return;
    const until = bypass.until || 0, left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    btn.classList.toggle('is-active', left > 0);
    if (left > 0) {
        label.textContent = tr('Bypass active') + ' · ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
        if (!bypassTimer) bypassTimer = setInterval(() => { if (Date.now() >= (bypass.until || 0)) { clearInterval(bypassTimer); bypassTimer = null; bypass.active = false; render(); } else paintBypass(); }, 1000);
    } else label.textContent = tr('Emergency bypass');
}
async function openBypass() {
    if (busy) return;
    try { await window.TaskitatorPro.emergencyStatus(); await access(); } catch (e) { status(e.message); return; }
    if (bypass.active) { status(tr('Emergency bypass is already active.')); return; }
    if (bypass.uses !== null && bypass.uses <= 0) { status(tr('All 4 emergency bypass uses for this week have been exhausted.')); return; }
    const lines = [tr('This uses 1 of your 4 weekly bypasses.'), tr('For 15 minutes, you can edit or delete protected tasks and change their criteria.'),
        tr('Your four weekly uses reset at 00:00 on the day after your configured weekend.')];
    if (bypass.uses !== null) lines.push(tr('Uses remaining this week: {n}/4', { n: bypass.uses }));
    if (!await ask(tr('Activate Emergency Bypass?'), lines, tr('Activate 15m'))) return;
    busy = true; render();
    try {
        const res = await window.TaskitatorEngine.EmergencyManager.activateBypass();
        if (!res?.success) throw Error(res?.error || tr('Could not activate Emergency Bypass. Try again.'));
        status(tr('Emergency Bypass is active for 15 minutes.'));
    } catch (e) { status(e.message); }
    finally { await access(); busy = false; render(); }
}

// ---- study plan drafts (their own tab; never shown in the normal drafts list) ----
const draftTime = t => window.TaskitatorI18n?.dateTime ? window.TaskitatorI18n.dateTime(t) : new Date(t).toLocaleString();
function renderDrafts(list) {
    const box = $('plansDraftList'); box.replaceChildren();
    if (!Drafts()) { el('p', tr('Drafts are unavailable. Reload Taskitator.'), box, 'plans-note'); return; }
    if (!list.length) { el('p', tr('No study plan drafts. Use Save draft while creating or editing a plan.'), box, 'plans-note'); return; }
    for (const d of list) {
        const row = el('div', undefined, box, 'plan-draft-row'), info = el('div', undefined, row, 'plan-draft-info');
        const plan = d.kind === 'edit' ? planOf(d.plan_id) : null;
        el('strong', (d.kind === 'edit' ? plan?.base || d.title : d.info.title) || tr('(untitled)'), info);
        el('div', (d.kind === 'edit' ? (plan ? tr('Edit of an existing plan') : tr('Edit of a plan that no longer exists')) : tr('New plan')) + ' · ' + tr('saved {time}', { time: draftTime(d.saved_at) }), info, 'plan-meta');
        const restore = el('button', tr('Restore'), row, 'icon-btn'); restore.type = 'button'; restore.disabled = busy || (d.kind === 'edit' && !plan);
        restore.addEventListener('click', () => restoreDraft(d.id));
        const del = el('button', tr('Delete'), row, 'icon-btn plan-delete'); del.type = 'button'; del.disabled = busy;
        del.addEventListener('click', async () => { if (await ask(tr('Delete this draft?'), [tr('This cannot be undone.')], tr('Delete'))) { Drafts().removeStudy(d.id); render(); } });
    }
}
async function saveDraft() {
    const plan = current && planOf(current); if (!plan || busy || !Drafts()) return;
    const d = draftFor(plan);
    if (!await ask(tr('Save draft?'), [tr('Your unsaved changes to this plan are kept in Drafts. The plan itself is unchanged until you save it.'), tr('This replaces any earlier draft of this plan.')], tr('Save draft'))) return;
    try {
        Drafts().saveStudy({ kind: 'edit', plan_id: plan.id, title: plan.base, info: d.info, ai: d.ai, schedule: d.sched.snapshot() });
        status(tr('Draft saved. Find it in the Drafts tab.'));
    } catch (e) { status(e.message); }
    render();
}
async function restoreDraft(id) {
    const d = Drafts()?.getStudy(id); if (!d) { status(tr('This draft no longer exists.')); render(); return; }
    if (!await ask(tr('Restore draft?'), d.kind === 'edit'
        ? [tr('The plan editor opens with the draft\'s changes. Anything you typed in that plan and did not save is replaced.'), tr('Nothing is applied until you save.')]
        : [tr('The study recurrence dialog opens with the draft filled in.'), tr('Nothing is created until you confirm there.')], tr('Restore'))) return;
    if (d.kind === 'create') { await openCreate({ draft: { ...d, id } }); return; }
    const plan = planOf(d.plan_id); if (!plan) { status(tr('This plan no longer exists. Delete the draft.')); render(); return; }
    drafts.delete(plan.id); current = plan.id; pageTab = 'plans'; render();
    const draft = draftFor(plan);
    draft.info = { ...infoOf(plan), ...Object.fromEntries(Object.entries(d.info).filter(([k]) => ['title', 'unit', 'parent', 'unitP'].includes(k))) };
    draft.ai = { criteria: d.ai.criteria, exclude: d.ai.exclude };
    const r = draft.sched.restore(d.schedule);
    render();
    status(d.schedule.sched && !r.preview ? tr('Draft restored. The plan changed since the draft was saved, so preview the schedule again.') : tr('Draft restored. Review it, then save.'));
}
// Phase 3.0: the create dialog opens here, in the shell, instead of sending you to the Tasks page.
async function openCreate(initial) {
    if (!window.TaskitatorStudy?.open) { status(tr('Reload Taskitator to load Study recurrence.')); return; }
    const r = await window.TaskitatorStudy.open(initial || {});
    if (r?.status === 'pro_required' || r?.status === 'unavailable') status(r.message);
}
let started = false, visible = false;
async function start() {
    if (started) return; started = true;
    $('planSave').addEventListener('click', () => save());
    $('planDiscard').addEventListener('click', () => { if (current) { drafts.delete(current); render(); status(''); } });
    $('planSaveDraft').addEventListener('click', () => saveDraft());
    $('plansBypassBtn').addEventListener('click', () => openBypass());
    $('plansTabPlans').addEventListener('click', () => { pageTab = 'plans'; render(); });
    $('plansTabDrafts').addEventListener('click', () => { pageTab = 'drafts'; render(); });
    window.addEventListener('taskitator-drafts-changed', () => { if (!busy) render(); });
    load(); render(); await access(); render();
}
const refresh = () => { if (!busy && !anyDirty()) { load(); access().then(render); } };
window.addEventListener('focus', () => { if (visible) refresh(); sweepBonus(); });
window.addEventListener('taskitator-page-load-synced', () => setTimeout(sweepBonus, 600));
setTimeout(sweepBonus, 4000); setInterval(sweepBonus, 300000);
$('plansAddBtn')?.addEventListener('click', () => openCreate({}));
window.addEventListener('storage', () => { if (visible && !busy && !anyDirty()) { load(); render(); } });
// A plan created (or a draft used) from the dialog shows up here at once.
window.addEventListener('taskitator-study-closed', () => { if (started && !busy && !anyDirty()) { load(); render(); } });
// Shell view (Phase 3.0): starts the first time the view opens; later visits reload the plans unless something is being edited.
// Unsaved edits stay in memory while you visit other views.
window.TaskitatorStudyPlansView = Object.freeze({
    show() { visible = true; if (!started) start(); else refresh(); sweepBonus(); },
    hide() { visible = false; },
    dirty: () => anyDirty()
});
})();

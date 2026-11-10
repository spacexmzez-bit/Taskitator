/* Study plans page (Phase 2.4a). Lists the plans made by study recurrence and edits them through TaskitatorStudyManage.
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
let tasks = [], state = { series: [], history: [] }, settings = {}, pro = null, bypass = { active: false, uses: null }, busy = false;
const open = new Set(), validated = new Map();
const status = text => { $('plansStatus').textContent = text || ''; };
const syncing = () => window.SyncEngine && typeof SyncEngine.isConfigured === 'function' && SyncEngine.isConfigured();

function load() { tasks = read(TASKS, []); state = read(STATE, { series: [], history: [] }); settings = read(SETTINGS, {}); }
async function access() {
    try { pro = (await TaskitatorAuth.api('/pro/status')).isPro === true; } catch (e) { pro = null; }
    try { const e = await TaskitatorAuth.api('/emergency'); bypass = { active: !!e.active_until && Date.parse(e.active_until) > Date.now(), uses: Number.isFinite(e.uses_left) ? e.uses_left : null }; } catch (e) { /* keep last known */ }
}
const canEdit = () => pro === true;

// Save, push now, and put everything back if the server refuses (offline keeps the change and syncs later).
async function commit(change, done) {
    if (busy) return;
    busy = true; render();
    const before = { tasks: localStorage.getItem(TASKS), state: localStorage.getItem(STATE) };
    try {
        const result = change();
        localStorage.setItem(TASKS, JSON.stringify(result.tasks));
        if (result.state) localStorage.setItem(STATE, JSON.stringify(result.state));
        if (window.SyncEngine && SyncEngine.markLocalModified) SyncEngine.markLocalModified();
        if (syncing()) {
            const sent = await SyncEngine.syncNow({ origin: 'manual' });
            if (sent && sent.success === false && !['offline', 'unconfigured', 'session_changed'].includes(sent.reason)) {
                for (const [key, value] of [[TASKS, before.tasks], [STATE, before.state]]) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
                throw Error(sent.error || sent.message || 'The server did not accept this change. Nothing was changed.');
            }
        }
        window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
        status(done ? done(result) : tr('Saved.'));
    } catch (e) { status(e.message); }
    finally { load(); await access(); busy = false; render(); }
}

function fmtDate(d) { return d ? new Date(d + 'T00:00:00Z').toLocaleDateString(document.documentElement.lang === 'ar' ? 'ar' : undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; }
function field(label, parent, value, type = 'text') {
    const wrap = el('label', label, parent, 'plan-field'), input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', undefined, wrap);
    if (type !== 'select' && type !== 'textarea') input.type = type; if (value !== undefined && type !== 'select') input.value = value; return input;
}
function section(title, parent) { const f = el('fieldset', undefined, parent, 'plan-section'); el('legend', title, f); return f; }
function actionButton(label, parent, fn, enabled = true) { const b = el('button', label, parent, 'icon-btn'); b.type = 'button'; b.disabled = !enabled || busy; b.addEventListener('click', fn); return b; }
const priorityName = (list, id) => id === undefined ? tr('Mixed') : id === null ? tr('No priority') : (list.find(p => p.id === id)?.name || id);

function card(plan, parent) {
    const list = M.prioritiesOf(settings), edit = canEdit() && !busy;
    const c = el('section', undefined, parent, 'plan-card');
    const top = el('div', undefined, c, 'plan-top'); el('h2', plan.base || tr('Study plan'), top);
    const badges = el('div', undefined, top, 'plan-badges');
    el('span', plan.finished ? tr('Finished') : tr('In progress'), badges, 'plan-badge');
    if (plan.audited) el('span', tr('AI audited: {n}', { n: plan.audited }), badges, 'plan-badge ai');
    el('p', tr('{done} of {total} done', { done: plan.done, total: plan.total }) + ' · ' + tr('{n} study days', { n: plan.days }) + (plan.start ? ' · ' + fmtDate(plan.start) + ' – ' + fmtDate(plan.end) : ''), c, 'plan-meta');
    const bar = el('div', undefined, c, 'plan-bar'); el('span', undefined, bar).style.width = (plan.total ? Math.round(plan.done / plan.total * 100) : 0) + '%';
    el('p', tr('Parent priority: {a} · Unit priority: {b}', { a: priorityName(list, plan.parentPriority), b: priorityName(list, plan.unitPriority) }), c, 'plan-meta');
    const actions = el('div', undefined, c, 'plan-actions');
    actionButton(open.has(plan.id) ? tr('Close') : tr('Edit'), actions, () => { open.has(plan.id) ? open.delete(plan.id) : open.add(plan.id); render(); });
    const del = actionButton(tr('Delete plan'), actions, () => removePlan(plan), true); del.classList.add('plan-delete');
    if (!open.has(plan.id)) return;
    const panel = el('div', undefined, c, 'plan-panel');
    if (!canEdit()) el('p', pro === null ? tr('Could not confirm your Pro license, so editing is off. You can still delete this plan.') : tr('Editing study plans needs an active Pro license. You can still view, finish and delete this plan.'), panel, 'plan-hint warn');

    // 1. Parent title
    const nameBox = section(tr('Plan title'), panel);
    if (plan.base) {
        const input = field(tr('Title shown on each study day'), nameBox, plan.base); input.disabled = !edit; input.maxLength = 160;
        if (plan.custom) el('p', tr('{n} day(s) have their own custom title and are not changed.', { n: plan.custom }), nameBox, 'plan-hint');
        actionButton(tr('Save title'), nameBox, () => commit(() => M.renamePlan(tasks, plan.id, input.value), r => tr('Title updated on {n} study days.', { n: r.changed })), edit);
    } else el('p', tr('This plan has custom day titles, so there is no single title to change.'), nameBox, 'plan-hint');

    // 2. Unit name
    const unitBox = section(tr('Unit name'), panel);
    if (plan.unit) {
        const row = el('div', undefined, unitBox, 'plan-row');
        const singular = field(tr('Unit name (singular)'), row, plan.unit), plural = field(tr('Unit name (plural)'), row, plan.plural || plan.unit.toLowerCase() + 's');
        const locked = plan.audited > 0 && !bypass.active;
        singular.disabled = plural.disabled = !edit || locked;
        if (plan.audited) el('p', locked ? tr('This plan has AI-audited units. Renaming them needs Emergency Bypass: activate it from the bypass panel, then come back.') : tr('Emergency Bypass is active, so audited units can be renamed.'), unitBox, 'plan-hint warn');
        actionButton(tr('Save unit name'), unitBox, () => commit(() => M.renameUnit(tasks, plan.id, singular.value, plural.value, { bypass: bypass.active }), r => tr('Renamed {n} units.', { n: r.changed })), edit && !locked);
    }

    // 3. Priorities
    const prioBox = section(tr('Priorities'), panel), row = el('div', undefined, prioBox, 'plan-row');
    const choices = [['', tr('No priority')], ...list.map(p => [p.id, p.name || p.id])];
    const make = (label, current) => { const s = field(label, row, undefined, 'select'); for (const [v, t] of choices) el('option', t, s).value = v; s.value = current ?? ''; s.disabled = !edit; return s; };
    const parentSel = make(tr('Parent task priority'), plan.parentPriority), unitSel = make(tr('Unit priority'), plan.unitPriority);
    el('p', tr('Units cannot be more important than their parent. Finished tasks keep their priority.'), prioBox, 'plan-hint');
    actionButton(tr('Save priorities'), prioBox, () => commit(() => M.setPriorities(tasks, plan.id, { parent: parentSel.value || null, unit: unitSel.value || null }, settings), r => tr('Priority updated on {n} tasks.', { n: r.changed })), edit);

    // 4. AI criteria
    const aiBox = section(tr('AI criteria'), panel);
    const openUnits = M.openUnits(plan);
    if (plan.audited) el('p', tr('This plan has AI criteria. They cannot be edited or removed here. The only way to remove them is to delete the plan, which uses 2 Emergency Bypass uses.'), aiBox, 'plan-hint warn');
    else if (!openUnits.length) el('p', tr('All units are finished, so there is nothing left to audit.'), aiBox, 'plan-hint');
    else criteriaForm(plan, aiBox, openUnits, edit);

    // 5. Re-plan
    const replanBox = section(tr('Re-plan'), panel);
    if (!openUnits.length) el('p', tr('All units are finished, so there is nothing left to re-plan.'), replanBox, 'plan-hint');
    else replanForm(plan, replanBox, edit);
}

// Re-plan (Phase 2.4b). Only unfinished units move, from today or later. The Worker rebuilds the same schedule and decides:
// AI-audited units moved later or removed need an active Emergency Bypass window; work due today moved off today follows the phone-lock rule.
const drafts = new Map();
function localToday() {
    const h = Number(settings.day_start_hour) || 0, d = new Date(Date.now() - (h >= 0 && h <= 4 ? h : 0) * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function replanForm(plan, box, edit) {
    const today = localToday(), open = M.openUnits(plan);
    const d = drafts.get(plan.id) || { start: today, mode: 'days', days: Math.min(open.length, Math.max(1, plan.parents.filter(p => p.status === 'active').length)), per: 2, rates: {}, weekdays: S.defaultDays(settings), startUnit: '', skipped: '', counts: null, preview: false };
    drafts.set(plan.id, d);
    el('p', tr('{done} of {total} units done. Only the {n} unfinished units move; finished units and past days stay as they are.', { done: plan.done, total: plan.total, n: open.length }), box, 'plan-hint');
    const reset = () => { d.counts = null; d.preview = false; };
    const start = field(tr('Starting date'), box, d.start, 'date'); start.min = today; start.disabled = !edit;
    start.addEventListener('change', () => { d.start = start.value; reset(); render(); });
    const seg = el('div', undefined, box, 'plan-seg');
    for (const [value, text] of [['days', tr('Number of study days')], ['perDay', tr('Units per day')]]) {
        const b = el('button', text, seg, 'plan-seg-btn' + (d.mode === value ? ' is-active' : '')); b.type = 'button'; b.disabled = !edit; b.setAttribute('aria-pressed', String(d.mode === value));
        b.addEventListener('click', () => { d.mode = value; reset(); render(); });
    }
    const num = (label, key, min, max) => { const i = field(label, box, d[key], 'number'); i.min = min; i.max = max; i.inputMode = 'numeric'; i.disabled = !edit; i.addEventListener('change', () => { d[key] = i.value; reset(); render(); }); return i; };
    if (d.mode === 'days') num(tr('Study days (1–365)'), 'days', 1, 365);
    else {
        num(tr('Units per day'), 'per', 1, 1000);
        el('p', tr('Different amount on specific weekdays (optional)'), box, 'plan-hint');
        const rates = el('div', undefined, box, 'plan-rates');
        WEEKDAYS.forEach((w, i) => { const l = el('label', tr(w), rates, 'plan-rate'), inp = el('input', undefined, l); inp.type = 'number'; inp.min = 1; inp.max = 1000; inp.inputMode = 'numeric'; inp.value = d.rates[i] ?? ''; inp.disabled = !edit; inp.addEventListener('change', () => { if (inp.value.trim()) d.rates[i] = Number(inp.value); else delete d.rates[i]; reset(); render(); }); });
    }
    el('p', tr('Study weekdays'), box, 'plan-hint');
    const days = el('div', undefined, box, 'plan-weekdays');
    WEEKDAYS.forEach((w, i) => { const l = el('label', tr(w), days, 'plan-day'), c = el('input', undefined, l); c.type = 'checkbox'; c.checked = d.weekdays.includes(i); c.disabled = !edit; c.addEventListener('change', () => { d.weekdays = c.checked ? [...d.weekdays, i].sort() : d.weekdays.filter(x => x !== i); reset(); render(); }); });
    el('p', tr('No days selected means every day.'), box, 'plan-hint');
    const row = el('div', undefined, box, 'plan-row');
    const su = field(tr('Start from unit (optional)'), row, d.startUnit, 'number'); su.placeholder = String(open[0]); su.disabled = !edit;
    su.addEventListener('change', () => { d.startUnit = su.value; reset(); render(); });
    const sk = field(tr('Skip units (optional)'), row, d.skipped); sk.placeholder = '8, 10-12'; sk.dir = 'ltr'; sk.disabled = !edit;
    sk.addEventListener('change', () => { d.skipped = sk.value; reset(); render(); });
    el('p', tr('Unfinished units before the starting unit, and skipped units, are removed from the plan.'), box, 'plan-hint');
    const options = () => {
        const nums = plan.units.map(M.unitNumber).filter(n => n !== null).sort((a, b) => a - b), have = new Set(nums), gaps = [];
        for (let n = nums[0]; n <= nums.at(-1); n++) if (!have.has(n)) gaps.push(n);
        const skipped = d.skipped.trim() ? S.parseSkips(d.skipped, nums[0], nums.length, gaps) : [];
        return { rev: d.rev || (d.rev = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'a').padEnd(6, 'a')), start: d.start, mode: d.mode, days: Number(d.days), per: Number(d.per), rates: d.rates, weekdays: d.weekdays, start_unit: d.startUnit === '' ? null : Number(d.startUnit), skipped, counts: d.counts };
    };
    actionButton(tr('Preview new schedule'), box, () => { d.preview = true; render(); }, edit);
    if (!d.preview) return;
    let result, opts;
    try { opts = options(); if (opts.start < today) throw Error(tr('The new schedule cannot start before today.')); result = M.replan(tasks, plan.id, opts); }
    catch (e) { el('p', e.message, box, 'plan-hint warn'); return; }
    d.counts = result.counts;
    const list = el('div', undefined, box, 'plan-days');
    const moved = result.tasks.filter(t => t.parent_id && t.id.startsWith('study_' + plan.id + '_unit_'));
    result.dates.forEach((date, i) => {
        const pid = 'study_' + plan.id + '_' + opts.rev + '_day_' + i, nums = moved.filter(u => u.parent_id === pid).map(M.unitNumber);
        const r = el('div', undefined, list, 'plan-day-row');
        el('strong', fmtDate(date), r); el('span', plan.unit ? nums.map(n => plan.unit + '.' + n).join(', ') : nums.join(', '), r, 'plan-day-units');
        const step = el('div', undefined, r, 'plan-step');
        const bump = delta => { try { d.counts = M.adjustCounts(d.counts, i, delta); render(); } catch (e) { status(e.message); } };
        actionButton('−', step, () => bump(-1), edit); el('span', String(result.counts[i]), step); actionButton('+', step, () => bump(1), edit);
    });
    el('p', tr('Changing a day keeps the total: + takes a unit from the end of the plan, − pushes one to the end.'), box, 'plan-hint');
    el('p', tr('{n} units over {d} study days, ending {date}.', { n: result.scheduled, d: result.days, date: fmtDate(result.end) }) + (result.removed ? ' ' + tr('{n} unfinished unit(s) removed.', { n: result.removed }) : ''), box, 'plan-hint');
    const impact = M.replanImpact(tasks, result.tasks, plan.id, today, settings);
    let blocked = false;
    if (impact.later.length) { el('p', bypass.active ? tr('{n} AI-audited unit(s) move later or are removed. Emergency Bypass is active, so this is allowed (no extra use).', { n: impact.later.length }) : tr('{n} AI-audited unit(s) move later or are removed. Activate Emergency Bypass from the bypass panel first (1 use, 15 minutes), then come back.', { n: impact.later.length }), box, 'plan-hint warn'); blocked ||= !bypass.active; }
    if (impact.today.length) { el('p', bypass.active ? tr('Work due today moves off today. Emergency Bypass is active, so this is allowed.') : tr('Work due today moves off today. That is locked until all of today\'s tasks are finished or Emergency Bypass is on.'), box, 'plan-hint warn'); blocked ||= !bypass.active; }
    actionButton(tr('Apply re-plan'), box, () => applyReplan(plan, opts, result), edit && !blocked);
}
async function applyReplan(plan, opts, preview) {
    if (busy) return;
    if (!confirm(tr('Re-plan {n} unfinished units over {d} study days?', { n: preview.scheduled, d: preview.days }) + (preview.removed ? ' ' + tr('{n} unfinished unit(s) will be removed.', { n: preview.removed }) : ''))) return;
    busy = true; render();
    let answer;
    try {
        if (!syncing()) throw Error(tr('Connect your account to re-plan a study plan.'));
        if (SyncEngine.isDirty?.()) { const sent = await SyncEngine.syncNow({ origin: 'manual' }); if (sent && sent.success === false) throw Error(sent.error || tr('Sync first, then try again.')); }
        answer = await TaskitatorAuth.api('/study-plan/manage', { method: 'POST', body: JSON.stringify({ action: 'replan', plan_id: plan.id, options: opts }) });
    } catch (e) { status(e.message); busy = false; await access(); render(); return; }
    busy = false; drafts.delete(plan.id);
    await commit(() => { const ids = M.planTree(tasks, plan.id); return { tasks: [...tasks.filter(t => !ids.has(t.id)), ...answer.tasks], answer }; }, () => tr('Re-planned: {n} units over {d} study days.', { n: answer.scheduled, d: answer.days }));
}

function criteriaForm(plan, box, openUnits, edit) {
    const criteria = field(tr('Criteria. Use {num} for each unit number.'), box, '', 'textarea'); criteria.maxLength = 4000; criteria.disabled = !edit;
    const which = field(tr('Units to audit. Leave empty for every unfinished unit.'), box, ''); which.disabled = !edit;
    which.placeholder = openUnits.length > 1 ? openUnits[0] + '-' + openUnits.at(-1) : String(openUnits[0]);
    const strict = settings.strict_criteria_validation !== false, check = el('p', '', box, 'plan-hint');
    const stamp = () => JSON.stringify([criteria.value, plan.id]);
    const picked = () => {
        if (!which.value.trim()) return openUnits;
        const nums = M.plans(tasks).find(p => p.id === plan.id).units.map(M.unitNumber).filter(n => n !== null).sort((a, b) => a - b);
        const have = new Set(nums), skipped = []; for (let n = nums[0]; n <= nums.at(-1); n++) if (!have.has(n)) skipped.push(n);
        const chosen = S.parseSkips(which.value, nums[0], nums.length, skipped).filter(n => openUnits.includes(n));
        if (!chosen.length) throw Error(tr('Select at least one unfinished unit.'));
        return chosen;
    };
    criteria.addEventListener('input', () => { check.textContent = ''; });
    if (strict) actionButton(tr('Check criteria'), box, async () => {
        try {
            if (!criteria.value.trim()) throw Error(tr('Enter audit criteria, up to 4,000 characters.'));
            const choice = window.TaskitatorEngine.AuditEngine.selection();
            const result = await TaskitatorAuth.api('/study-plan', { method: 'POST', body: JSON.stringify({ action: 'validate', config: M.configOf(plan), criteria: criteria.value, provider: choice.provider, model: choice.primary, key_version: choice.keyVersion }) });
            validated.set(stamp(), result); check.textContent = result.score + '/10 · ' + result.critique;
        } catch (e) { check.textContent = e.message; }
    }, edit);
    actionButton(tr('Add AI criteria'), box, () => {
        try {
            if (strict && !validated.get(stamp())?.passed) throw Error(tr('Check the criteria first. They must pass (7/10 or higher).'));
            const numbers = picked();
            if (!confirm(tr('Add these criteria to {n} unit(s)? They cannot be edited or removed later except by deleting the plan, which uses 2 Emergency Bypass uses.', { n: numbers.length }))) return;
            commit(() => M.addCriteria(tasks, plan.id, criteria.value, numbers), r => tr('AI criteria added to {n} units.', { n: r.changed }));
        } catch (e) { status(e.message); }
    }, edit);
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
    open.delete(plan.id);
    await commit(() => M.deletePlan(tasks, state, plan.id), r => tr('Plan deleted. {n} tasks removed.', { n: r.removed }));
}

function render() {
    const plans = M.plans(tasks), now = plans.filter(p => !p.finished), done = plans.filter(p => p.finished);
    $('plansCurrent').replaceChildren(); $('plansPrevious').replaceChildren();
    for (const p of now) card(p, $('plansCurrent'));
    for (const p of done) card(p, $('plansPrevious'));
    $('plansPreviousTitle').hidden = !done.length; $('plansEmpty').hidden = plans.length > 0;
    const note = $('plansNotice');
    note.hidden = canEdit() || !plans.length;
    note.textContent = pro === null ? tr('Could not confirm your Pro license, so editing is off. You can still view and delete plans.') : tr('Editing study plans needs an active Pro license. You can still view, finish and delete plans. Resubscribing restores editing.');
}
let started = false;
async function start() { if (started) return; started = true; load(); render(); await access(); render(); }
window.addEventListener('focus', () => { if (!busy) { load(); access().then(render); } });
window.addEventListener('storage', () => { if (!busy) { load(); render(); } });
document.addEventListener('DOMContentLoaded', start);
if (document.readyState !== 'loading') start();
})();

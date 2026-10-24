// ============================================================================
// Taskitator Consolidated Components & Recurrence Engine (components.js)
// Combines: recurrence-core, recurrence-ui, and components.
// ============================================================================

// <<< MODULE_START: recurrence-core.js >>>
// File: recurrence-core.js
// Shared deterministic recurrence rules, used by the browser and Cloudflare Worker.
(function (root) {
    'use strict';
    const DAY = 86400000;
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    function validDate(s) {
        return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
            Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
    }
    const dateMs = s => Date.parse(s + 'T00:00:00Z');
    const dateString = ms => new Date(ms).toISOString().slice(0, 10);
    function today(now = Date.now(), hour = 0) {
        return dateString(now + (3 - hour) * 3600000);
    }
    function schedule(input) {
        if (!input || !['daily', 'weekdays', 'monthly', 'month_day', 'half_yearly', 'yearly'].includes(input.kind)) throw new Error('Choose a recurrence schedule.');
        if (!validDate(input.start)) throw new Error('Choose a valid start date.');
        if (input.end && (!validDate(input.end) || input.end < input.start)) throw new Error('End date must be on or after the start date.');
        const result = { kind: input.kind, start: input.start, end: input.end || '' };
        if (input.kind === 'weekdays') {
            result.weekdays = [...new Set(input.weekdays || [])].sort();
            if (!result.weekdays.length || result.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw new Error('Select at least one weekday.');
        }
        if (input.kind === 'month_day') {
            result.day = Number(input.day);
            if (!Number.isInteger(result.day) || result.day < 1 || result.day > 31) throw new Error('Day of month must be between 1 and 31.');
        }
        return result;
    }
    function nextDate(config, after = null) {
        const s = schedule(config);
        if (after !== null && !validDate(after)) throw new Error('Invalid previous occurrence date.');
        const floor = Math.max(dateMs(s.start), after === null ? dateMs(s.start) : dateMs(after) + DAY);
        let candidate;
        if (s.kind === 'daily') candidate = dateString(floor);
        else if (s.kind === 'weekdays') {
            for (let i = 0; i < 7; i++) {
                const ms = floor + i * DAY;
                if (s.weekdays.includes(new Date(ms).getUTCDay())) { candidate = dateString(ms); break; }
            }
        } else {
            const anchor = new Date(dateMs(s.start));
            const minimum = new Date(floor);
            const step = s.kind === 'half_yearly' ? 6 : s.kind === 'yearly' ? 12 : 1;
            const anchorMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
            const targetMonth = minimum.getUTCFullYear() * 12 + minimum.getUTCMonth();
            let offset = Math.max(0, Math.floor((targetMonth - anchorMonth) / step) * step);
            const wantedDay = s.kind === 'month_day' ? s.day : anchor.getUTCDate();
            for (let i = 0; i < 3; i++, offset += step) {
                const m = anchorMonth + offset, year = Math.floor(m / 12), month = m % 12;
                const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
                const ms = Date.UTC(year, month, Math.min(wantedDay, last));
                if (ms >= floor) { candidate = dateString(ms); break; }
            }
        }
        return candidate && (!s.end || candidate <= s.end) ? candidate : null;
    }
    function subtree(tasks, id) {
        const ids = new Set([id]);
        let changed = true;
        while (changed) { changed = false; for (const task of tasks) if (ids.has(task.parent_id) && !ids.has(task.id)) { ids.add(task.id); changed = true; } }
        return tasks.filter(task => ids.has(task.id));
    }
    function seriesFor(state, task) {
        return state.series.find(s => s.id === task?.recurrence_series_id) || null;
    }
    function canStart(tasks, id) {
        const branch = subtree(tasks, id);
        if (branch.some(t => t.recurrence_series_id)) throw new Error('A recurring branch cannot contain another recurring series.');
        let parent = tasks.find(t => t.id === id)?.parent_id; const seen = new Set();
        while (parent && !seen.has(parent)) {
            seen.add(parent); const p = tasks.find(t => t.id === parent);
            if (!p || p.status !== 'active') throw new Error('The parent must be active.');
            if (p.recurrence_series_id) throw new Error('This task already follows its recurring ancestor.');
            parent = p.parent_id;
        }
    }
    function cleanNode(task, key, parentKey, rootDate) {
        const t = copy(task);
        for (const field of ['id', 'parent_id', 'status', 'created_at', 'completed_at', 'verified_model', 'recurrence_series_id', 'recurrence_node_id', 'recurrence_hold_until', 'recurrence_occurrence', 'recurring', 'recurrence']) delete t[field];
        return { key, parent_key: parentKey, date_offset: validDate(task.due_date) && validDate(rootDate) ? Math.round((dateMs(task.due_date) - dateMs(rootDate)) / DAY) : 0, task: t };
    }
    function start(tasks, state, id, config, seriesId, now = Date.now()) {
        config = schedule(config); canStart(tasks, id);
        const task = tasks.find(t => t.id === id);
        if (!task || task.status !== 'active') throw new Error('Only an active task can start recurring.');
        const due = nextDate(config);
        if (!due) throw new Error('No occurrence falls within these dates.');
        const branch = subtree(tasks, id).filter(t => t.status !== 'trash');
        const keys = new Map(branch.map((t, i) => [t.id, String(i)]));
        const previousDate = task.due_date;
        const nodes = branch.map(t => cleanNode(t, keys.get(t.id), t.id === id ? null : keys.get(t.parent_id), previousDate));
        const s = { id: seriesId, enabled: true, schedule: config, parent_id: task.parent_id || null,
            occurrence: 0, current_root_id: id, current_date: due, nodes, created_at: new Date(now).toISOString() };
        state.reference_files ||= {};
        for (const t of branch) {
            if (!t.reference_inline_data) continue;
            const key = `${seriesId}_ref_${keys.get(t.id)}`;
            state.reference_files[key] = t.reference_inline_data;
            t.reference_id = key; delete t.reference_inline_data;
            const node = nodes.find(n=>n.key===keys.get(t.id));
            node.task.reference_id=key; delete node.task.reference_inline_data;
        }
        state.series.push(s);
        branch.forEach(t => { t.recurrence_series_id = seriesId; t.recurrence_node_id = keys.get(t.id); t.recurrence_occurrence = 0; });
        task.due_date = due;
        for (const t of branch) if (t !== task) {
            const node = nodes.find(n => n.key === keys.get(t.id)); t.due_date = dateString(dateMs(due) + node.date_offset * DAY);
        }
        return s;
    }
    function updateNode(state, task, fields) {
        const s = seriesFor(state, task); const node = s?.nodes.find(n => n.key === task.recurrence_node_id);
        if (!node) return;
        const allowed = ['title', 'raw_title', 'description', 'tags', 'priority_id', 'project_id', 'is_bonus', 'strict_prerequisites', 'ai_locked', 'proof_criteria', 'raw_proof_criteria', 'reference_inline_data', 'reference_id'];
        for (const key of allowed) if (Object.prototype.hasOwnProperty.call(fields, key)) node.task[key] = copy(fields[key]);
    }
    function validateState(state, tasks) {
        if (!state || !Array.isArray(state.series) || !Array.isArray(state.history)) throw new Error('Recurring data is malformed. Restore a valid backup.');
        if(state.reference_files !== undefined && (!state.reference_files || typeof state.reference_files !== 'object' || Array.isArray(state.reference_files))) throw new Error('Invalid recurring references.');
        for(const h of state.history) if(!h || typeof h.id!=='string' || !['completed','deleted'].includes(h.outcome) || !Array.isArray(h.tasks)) throw new Error('Invalid recurrence history.');
        const ids = new Set();
        for (const s of state.series) {
            if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(s.id) || ids.has(s.id)) throw new Error('Invalid recurring series ID.');
            ids.add(s.id); schedule(s.schedule);
            if (typeof s.enabled !== 'boolean' || !Number.isSafeInteger(s.occurrence) || s.occurrence < 0 || !Array.isArray(s.nodes) || !s.nodes.length || !validDate(s.current_date)) throw new Error('Invalid recurring series.');
            const keys = new Set();
            for (const n of s.nodes) {
                if (!n || typeof n.key !== 'string' || !/^[0-9]+$/.test(n.key) || keys.has(n.key) || !n.task || typeof n.task !== 'object' || Array.isArray(n.task) || !Number.isInteger(n.date_offset) || Math.abs(n.date_offset) > 36600) throw new Error('Invalid recurring template.');
                keys.add(n.key);
            }
            if (s.nodes.filter(n => n.parent_key === null).length !== 1) throw new Error('Recurring template needs one root.');
            for (const n of s.nodes) {
                const seen = new Set([n.key]); let key = n.parent_key;
                while (key !== null) {
                    if (!keys.has(key) || seen.has(key)) throw new Error('Recurring template contains an invalid parent cycle.');
                    seen.add(key); key = s.nodes.find(x => x.key === key).parent_key;
                }
            }
        }
        for (const t of tasks) if (t.recurrence_series_id && !ids.has(t.recurrence_series_id)) throw new Error('A recurring task is missing its series.');
        return state;
    }
    function reconcile(snapshot, now = Date.now()) {
        const state = snapshot.recurrence_state || { series: [], history: [] };
        validateState(state, snapshot.tasks);
        let tasks = snapshot.tasks; let changed = false;
        const hour = Math.max(0, Math.min(4, Number(snapshot.settings?.day_start_hour) || 0));
        for (const s of state.series) {
            const current = tasks.find(t => t.id === s.current_root_id);
            if (!current) { if (s.enabled) { s.enabled = false; s.stopped_reason = 'Current task removed'; changed = true; } continue; }
            let parentId = current.parent_id; const seen = new Set(); let ancestorDone = false;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId); const p = tasks.find(t => t.id === parentId);
                if (!p || p.status !== 'active') { ancestorDone = true; break; }
                if (p.recurrence_series_id && p.recurrence_series_id !== s.id) throw new Error('Nested recurring series are not supported.');
                parentId = p.parent_id;
            }
            if (ancestorDone && s.enabled) { s.enabled = false; s.stopped_reason = 'Parent completed or removed'; changed = true; }
            // Newly added children become part of the future branch automatically.
            const branch = subtree(tasks, current.id);
            const depth = t => {let n=0,p=t.parent_id,seen=new Set();while(p&&!seen.has(p)){seen.add(p);const parent=branch.find(x=>x.id===p);if(!parent)break;n++;p=parent.parent_id;}return n;};
            branch.sort((a,b)=>depth(a)-depth(b));
            for (const t of branch.filter(t => t.status !== 'trash')) {
                if (t.recurrence_series_id && t.recurrence_series_id !== s.id) throw new Error('Nested recurring series are not supported.');
                if (!t.recurrence_node_id || t.recurrence_series_id !== s.id) {
                    const key = String(Math.max(-1, ...s.nodes.map(n => Number(n.key))) + 1);
                    const parent = tasks.find(p => p.id === t.parent_id);
                    if (!parent?.recurrence_node_id) continue;
                    t.recurrence_series_id = s.id; t.recurrence_node_id = key; t.recurrence_occurrence = s.occurrence;
                    if(t.reference_inline_data){
                        state.reference_files ||= {};const refId=`${s.id}_ref_${key}`;
                        state.reference_files[refId]=t.reference_inline_data;t.reference_id=refId;delete t.reference_inline_data;
                    }
                    s.nodes.push(cleanNode(t, key, parent.recurrence_node_id, s.current_date)); changed = true;
                }
            }
            if (current.status === 'active' || Number(current.recurrence_hold_until) > now) continue;
            if (!['completed', 'trash'].includes(current.status)) throw new Error('Invalid recurring task status.');
            const reason = current.status === 'completed' ? 'completed' : 'deleted';
            const eventId = `${s.id}:${s.occurrence}`;
            if (!state.history.some(h => h.id === eventId)) state.history.push({ id: eventId, series_id: s.id,
                title: current.title, due_date: s.current_date, ended_at: current.completed_at || new Date(now).toISOString(),
                outcome: reason, tasks: branch.map(t => ({ title: t.title, status: t.status, ai_locked: !!t.ai_locked, verified_model: t.verified_model || null, project_id:t.project_id || 'inbox', priority_id:t.priority_id || null, completed_at:t.completed_at || (t.status==='completed' ? new Date(now).toISOString() : null) })) });
            state.history = state.history.slice(-500);
            const ids = new Set(branch.map(t => t.id)); tasks = tasks.filter(t => !ids.has(t.id));
            const finishedDate = today(Number.isFinite(Date.parse(current.completed_at)) ? Date.parse(current.completed_at) : now, hour);
            const after = [s.current_date, finishedDate, today(now, hour)].sort().at(-1);
            const due = s.enabled && !ancestorDone ? nextDate(s.schedule, after) : null;
            s.current_root_id = null;
            if (!due) { s.enabled = false; s.stopped_reason ||= 'Series stopped or end date reached'; changed = true; continue; }
            s.occurrence++;
            const idFor = key => `${s.id}_o${s.occurrence}_n${key}`;
            for (const n of s.nodes) {
                const t = copy(n.task);
                t.id = idFor(n.key); t.parent_id = n.parent_key === null ? current.parent_id || null : idFor(n.parent_key);
                t.status = 'active'; t.completed_at = null; t.created_at = new Date(now).toISOString(); delete t.verified_model;
                t.recurrence_series_id = s.id; t.recurrence_node_id = n.key; t.recurrence_occurrence = s.occurrence;
                t.due_date = n.parent_key === null ? due : (validDate(n.task.due_date) ? dateString(dateMs(due) + n.date_offset * DAY) : due);
                tasks.push(t); if (n.parent_key === null) s.current_root_id = t.id;
            }
            s.parent_id = current.parent_id || null; s.current_date = due; changed = true;
        }
        if(state.reference_files){
            const used=new Set([...tasks.map(t=>t.reference_id),...state.series.flatMap(s=>s.nodes.map(n=>n.task.reference_id))]);
            for(const key of Object.keys(state.reference_files))if(!used.has(key))delete state.reference_files[key];
        }
        snapshot.tasks = tasks; snapshot.recurrence_state = state;
        return { snapshot, changed };
    }
    const api = { schedule, nextDate, validDate, today, subtree, seriesFor, start, updateNode, validateState, reconcile };
    root.TaskitatorRecurrence = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

// <<< MODULE_END: recurrence-core.js >>>
// <<< MODULE_START: recurrence-ui.js >>>
// File: recurrence-ui.js
(function () {
    'use strict';
    const Core = window.TaskitatorRecurrence;
    const KEY = 'taskitator_recurrence_state';
    const empty = () => ({ series: [], history: [] });
    const state = () => JSON.parse(localStorage.getItem(KEY) || JSON.stringify(empty()));
    const tasks = () => window.TaskitatorApp?.getTasks() || JSON.parse(localStorage.getItem('taskitator_tasks') || '[]');
    const settings = () => JSON.parse(localStorage.getItem('taskitator_settings') || '{}');
    const today = () => Core.today(Date.now(), Number(settings().day_start_hour) || 0);
    function persist(snapshot) {
        const beforeState=localStorage.getItem(KEY),beforeTasks=localStorage.getItem('taskitator_tasks');
        try {
            localStorage.setItem(KEY,JSON.stringify(snapshot.recurrence_state));
            localStorage.setItem('taskitator_tasks',JSON.stringify(snapshot.tasks));
        } catch(err) {
            localStorage.removeItem(KEY);localStorage.removeItem('taskitator_tasks');
            if(beforeState!==null)localStorage.setItem(KEY,beforeState);
            if(beforeTasks!==null)localStorage.setItem('taskitator_tasks',beforeTasks);
            alert('Could not save recurring data. The previous saved copy was kept. If storage is full, reduce reference-file sizes or export a backup before cleaning old data.');
            throw err;
        }
    }
    function save(data, list = tasks()) {
        const result = Core.reconcile({ tasks: list, recurrence_state: data, settings: settings() });
        persist(result.snapshot);
        window.SyncEngine?.markLocalModified();
        window.TaskitatorApp?.loadStorage(); window.TaskitatorApp?.renderUnifiedView();
        window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
    }
    function element(tag, text, parent) {
        const e = document.createElement(tag); if (text !== undefined) e.textContent = text;
        if (parent) parent.append(e); return e;
    }
    function button(text, parent, fn) {
        const e = element('button', text, parent); e.type = 'button'; e.className = 'icon-btn'; e.style.margin = '6px 4px 6px 0'; e.onclick = fn; return e;
    }
    function input(label, type, value, parent) {
        const wrap = element('label', label, parent); wrap.style.cssText = 'display:block;margin:12px 0;color:var(--text-color)';
        const e = element('input', undefined, wrap); e.type = type; e.value = value || ''; e.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px'; return e;
    }
    function dialog(title) {
        const d = document.createElement('dialog'); d.className = 'recurrence-dialog';
        d.style.cssText = 'width:min(90vw,560px);box-sizing:border-box;max-height:88vh;overflow:auto;background:var(--card-bg,#0f1d3a);color:var(--text-color,#fff);border:1px solid #456;border-radius:14px;padding:22px;z-index:20000';
        element('h2', title, d); button('Close', d, () => d.close()); d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
    }
    function scheduleForm(parent, initial = { kind: 'daily', start: today(), end: '' }, optional = false) {
        const label = element('label', 'Repeat', parent); label.style.display = 'block';
        const select = element('select', undefined, label); select.style.cssText = 'display:block;padding:9px;width:100%;margin:6px 0';
        const kinds = [['daily','Daily'],['weekdays','Selected weekdays'],['monthly','Monthly - start-date day'],['month_day','Date of month'],['half_yearly','Every six months'],['yearly','Yearly']];
        if (optional) kinds.unshift(['none','Does not repeat']);
        kinds.forEach(([value,text]) => { const o = element('option', text, select); o.value = value; }); select.value = optional ? 'none' : initial.kind;
        const box = element('div', undefined, parent);
        const start = input('Start date', 'date', initial.start, box), end = input('End date (optional)', 'date', initial.end, box);
        const day = input('Day of month (1-31)', 'number', initial.day || 1, box); day.min = '1'; day.max = '31';
        const weekdays = element('div', undefined, box); element('p','Repeat on these days:', weekdays);
        const checks = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((name, index) => {
            const label = element('label', name, weekdays); label.style.cssText = 'display:inline-flex;gap:4px;margin:7px';
            const cb = element('input', undefined, label); cb.type = 'checkbox'; cb.checked = (initial.weekdays || [1]).includes(index); return cb;
        });
        const change = () => { box.hidden = select.value === 'none'; day.parentElement.hidden = select.value !== 'month_day'; weekdays.hidden = select.value !== 'weekdays'; };
        select.onchange = change; change();
        return { get: () => select.value === 'none' ? null : Core.schedule({ kind: select.value, start: start.value, end: end.value, day: Number(day.value), weekdays: checks.flatMap((cb,i) => cb.checked ? [i] : []) }), reset: () => { select.value = 'none'; start.value = today(); end.value = ''; change(); } };
    }
    async function captureReferences(list, id) {
        for (const t of Core.subtree(list, id)) {
            if (!t.ai_locked || t.reference_inline_data) continue;
            const rec = await window.ExemplarStore?.getExemplar(t.id);
            if (rec?.inline_data) t.reference_inline_data = { inline_data: rec.inline_data };
        }
    }
    let createControl;
    async function attachCreated(id, list) {
        const config = createControl?.get(); if (!config) return;
        const session=localStorage.getItem('taskitator_session_id');
        await captureReferences(list, id);
        if(session!==localStorage.getItem('taskitator_session_id'))throw new Error('Account changed while preparing recurrence.');
        const data = state(); Core.start(list, data, id, config, 'repeat_' + crypto.randomUUID().replace(/-/g,''));
        persist({tasks:list,recurrence_state:data});
    }
    function validCreate(parentId) {
        const config = createControl?.get(); if (!config) return;
        if (parentId) {
            let p = tasks().find(t => t.id === parentId); const seen = new Set();
            while (p && !seen.has(p.id)) { seen.add(p.id); if (p.recurrence_series_id) throw new Error('This subtask uses its parent’s repeat schedule.'); p = tasks().find(t => t.id === p.parent_id); }
        }
    }
    function bindTask(id) {
        const form = document.getElementById('taskEditForm') || document.getElementById('taskDetailForm');
        const task = tasks().find(t => t.id === id); if (!task) return;
        let wrap = document.getElementById('recurrenceTaskControls');
        const parent = form || document.getElementById('taskDetailModal')?.querySelector('.modal-box'); if (!parent) return;
        if (!wrap) { wrap = element('div', undefined, parent); wrap.id = 'recurrenceTaskControls'; wrap.style.cssText='margin:16px 0;padding:12px;border:1px solid var(--border-color);border-radius:8px'; }
        const actions=document.getElementById('saveTaskDetailsBtn')?.parentElement;if(actions?.parentElement===parent)parent.insertBefore(wrap,actions);
        wrap.replaceChildren();
        const series = Core.seriesFor(state(), task);
        element('p', series ? (series.enabled ? 'Repeating branch: '+series.schedule.kind.replace(/_/g,' ') : 'Repetition stopped. You can still finish the current task.') : 'This task does not repeat.', wrap);
        button(series ? 'Recurrence & future criteria' : 'Set up recurrence', wrap, () => open(id));
        if (series) {
            const label = element('label', 'Apply ordinary task edits to:', wrap);
            const scope = element('select', undefined, label); scope.id = 'recurrenceEditScope'; scope.style.cssText='display:block;padding:8px;margin:6px 0;width:100%';
            [['one','This occurrence'],['future','This and future occurrences']].forEach(([v,t]) => { const o = element('option',t,scope);o.value=v; });
            element('small','Due-date changes apply to this occurrence. Use “Recurrence & future criteria” to change future dates or requirements.',wrap);
        }
    }
    async function applyEdit(task) {
        const data = state(), s = Core.seriesFor(data, task); if (!s) return;
        if (document.getElementById('recurrenceEditScope')?.value === 'future') {
            // Keep future-only validated criteria intact when ordinary fields are edited.
            const {title,raw_title,description,tags,priority_id,project_id,is_bonus,strict_prerequisites} = task;
            const fields={title,raw_title,description,tags,priority_id,project_id,is_bonus,strict_prerequisites};
            const node=s.nodes.find(n=>n.key===task.recurrence_node_id);
            if(task.ai_locked && !node.task.ai_locked){
                Object.assign(fields,{ai_locked:true,proof_criteria:task.proof_criteria,raw_proof_criteria:task.raw_proof_criteria});
                const ref=await window.ExemplarStore?.getExemplar(task.id);
                if(ref?.inline_data){data.reference_files ||= {};const key='ref_'+crypto.randomUUID().replace(/-/g,'');data.reference_files[key]={inline_data:ref.inline_data};task.reference_id=key;fields.reference_id=key;}
            }
            Core.updateNode(data,task,fields);
        }
        localStorage.setItem(KEY,JSON.stringify(data));
    }
    function open(id) {
        const list = tasks(), task = list.find(t => t.id === id); if (!task) return;
        const data = state(), s = Core.seriesFor(data, task);
        const d = dialog('Recurring task'); const feedback = element('p','',d); feedback.style.color='#ffbc65';
        if (!s) {
            const form = scheduleForm(d); button('Start repeating this branch',d,async () => {
                try { const config=form.get(); await captureReferences(list,id); Core.start(list,data,id,config,'repeat_'+crypto.randomUUID().replace(/-/g,'')); save(data,list);d.close();bindTask(id); } catch(e){feedback.textContent=e.message;}
            }); return;
        }
        const isRoot = s.current_root_id === id;
        element('p', isRoot ? 'This task and its subtasks repeat together.' : 'This subtask repeats with its parent. Complete the whole repeating task to start the next occurrence.',d);
        if (isRoot) {
            const form = scheduleForm(d,s.schedule);
            button('Save schedule for future occurrences',d,() => {
                try { s.schedule=form.get();save(data,list);d.close();bindTask(id); }catch(e){feedback.textContent=e.message;}
            });
            if (s.enabled) button('Stop future repetition',d,() => {
                if (!confirm('Stop future occurrences? The current task and its proof requirements stay active.')) return;
                s.enabled=false;s.stopped_reason='Stopped by user';save(data,list);d.close();bindTask(id);
            });
            else if (task.status==='active') button('Resume future repetition',d,() => {s.enabled=true;delete s.stopped_reason;save(data,list);d.close();bindTask(id);});
        }
        const node=s.nodes.find(n=>n.key===task.recurrence_node_id);
        if (task.ai_locked && node) {
            element('h3','Proof criteria - future occurrences only',d);
            const area=element('textarea',undefined,d);area.value=node.task.proof_criteria||'';area.rows=5;area.style.cssText='width:100%;box-sizing:border-box;padding:9px';
            element('p','Changes apply to future occurrences. Criteria must pass a new check with a score of at least 7/10.',d);
            const file=input('Replace future reference (optional, photo or PDF, up to 5 MB)','file','',d);file.accept='image/jpeg,image/png,image/webp,image/heic,application/pdf';
            const removeLabel=element('label','Remove future reference',d);const remove=element('input',undefined,removeLabel);remove.type='checkbox';
            const saveButton=button('Validate & save future criteria',d,async () => {
                const text=area.value.trim();if (!text || /\{[^}]+\}|\[[^\]]+\]/.test(text)){feedback.textContent='Enter concrete criteria with all placeholders filled in.';return;}
                const user=window.SyncEngine?.getConfig().username, session=localStorage.getItem('taskitator_session_id'), revision=localStorage.getItem('taskitator_local_revision');
                saveButton.disabled=true;
                try {
                    let exemplar=file.files[0]||null;
                    if (exemplar) {const check=TaskitatorEngine.AuditEngine.validateFile(exemplar);if(!check.valid)throw new Error(check.error);}
                    if (!exemplar && !remove.checked && (node.task.reference_inline_data || data.reference_files?.[node.task.reference_id])) {
                        const ref=(node.task.reference_inline_data || data.reference_files[node.task.reference_id]).inline_data;
                        const bytes=Uint8Array.from(atob(ref.data),c=>c.charCodeAt(0));exemplar=new File([bytes],'reference',{type:ref.mime_type});
                    }
                    const engine=TaskitatorEngine.AuditEngine;
                    // This is deliberately a fresh validation, including replacement reference content.
                    TaskitatorEngine._criteriaValidationCache.clear();
                    feedback.textContent='Validating future criteria…';
                    const result=await engine.validateCriteria(text,node.task.title,exemplar);
                    if(!result.success||!result.passed||result.score<7)throw new Error(result.error||result.critique||'Criteria must score at least 7/10.');
                    if (user!==window.SyncEngine?.getConfig().username || session!==localStorage.getItem('taskitator_session_id') || revision!==localStorage.getItem('taskitator_local_revision')) throw new Error('Account or tasks changed during validation. Reopen this dialog and try again.');
                    node.task.proof_criteria=text;node.task.raw_proof_criteria=text;
                    if(remove.checked){delete node.task.reference_inline_data;delete node.task.reference_id;}
                    if(file.files[0]){data.reference_files ||= {};const refId='ref_'+crypto.randomUUID().replace(/-/g,'');data.reference_files[refId]=await engine.fileToBase64(file.files[0]);node.task.reference_id=refId;delete node.task.reference_inline_data;}
                    if (user!==window.SyncEngine?.getConfig().username || session!==localStorage.getItem('taskitator_session_id') || revision!==localStorage.getItem('taskitator_local_revision')) throw new Error('Account or tasks changed. Reopen this dialog.');
                    save(data,list);feedback.textContent='Validated '+result.score+'/10. Saved for future occurrences. Current criteria unchanged.';
                }catch(e){feedback.textContent=e.message;}finally{saveButton.disabled=false;}
            });
        }
    }
    function overview() {
        const d=dialog('Recurring tasks & history'),data=state();
        if(!data.series.length)element('p','Open a task’s details to set up recurrence, or choose Repeat when creating a task.',d);
        for(const s of data.series){const root=tasks().find(t=>t.id===s.current_root_id);element('h3',root?.title||s.nodes[0]?.task.title||'Recurring task',d);element('p',(s.enabled?'Repeating':'Stopped')+' · '+s.schedule.kind.replace(/_/g,' ')+' · Current date: '+s.current_date,d);if(root)button('Manage branch',d,()=>{d.close();open(root.id);});}
        element('h3','Occurrence history (latest 500)',d);
        for(const h of [...data.history].reverse()){element('p',h.title+' · '+h.due_date+' · '+h.outcome+' · '+new Date(h.ended_at).toLocaleString(),d);}
        if(!data.history.length)element('p','No recurring-task history yet.',d);
    }
    window.addEventListener('taskitator-auth-ready',()=>{
        const form=document.getElementById('taskCreateForm');if(form){const wrap=element('fieldset',undefined,form);wrap.style.cssText='margin:14px 0;border:1px solid var(--border-color);border-radius:8px;padding:12px';element('legend','Recurrence',wrap);const actions=document.getElementById('submitTaskCreateBtn')?.parentElement;if(actions?.parentElement===form)form.insertBefore(wrap,actions);createControl=scheduleForm(wrap,undefined,true);}
        const nav=document.querySelector('.sidebar nav')||document.querySelector('nav');if(nav)button('↻ Recurring tasks',nav,overview);
    });
    window.TaskitatorRecurrenceUI={state,save,persist,attachCreated,validCreate,bindTask,applyEdit,resetCreate:()=>createControl?.reset(),overview};
})();

// <<< MODULE_END: recurrence-ui.js >>>
// <<< MODULE_START: components.js >>>
// File: components.js
/**
 * Taskitator task-editor components. Classic script; no imports or build step.
 * Owns editor/audit state and UI wiring. The core is supplied through Host API v1.
 * See MODULES.md for the contract and independent maintenance rules.
 */
window.TaskitatorComponents = Object.freeze({
    apiVersion: 1,
    create(host) {
        if (!host || host.apiVersion !== 1) {
            throw new Error('TaskitatorComponents requires Host API version 1.');
        }
        const required = {
            tasks: ['getAll', 'reload', 'save', 'sort', 'descendants', 'shieldedAncestor',
                'hasUncompletedDescendant', 'remove',
                'moveProject', 'setStatus', 'finalize'],
            catalogs: ['projects', 'tags', 'priorities', 'lowestPriority', 'addTag'],
            view: ['current', 'refresh'],
            rules: ['bypassActive', 'strictCriteria'],
            effects: ['auditSuccess'],
            clock: ['today'],
            breaks: ['today']
        };
        for (const [group, methods] of Object.entries(required)) {
            for (const method of methods) {
                if (typeof host[group]?.[method] !== 'function') {
                    throw new Error(`TaskitatorComponents requires host.${group}.${method}().`);
                }
            }
        }
        let initialized = false;
        let pendingAuditTaskId = null;
        const pendingProofApprovals=new Map();
        let activeDetailTaskId = null;
        let criteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
        let editCriteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
        let pendingEditExemplarFile = null;
        let cachedTemplates = null;
        let activeTemplateTarget = 'create'; // 'create' | 'edit'
        let currentTemplatesTab = 'templates'; // 'templates' | 'saved'

        // Modal Selection State
        const createModalSelectedTags = new Set();
        let createModalSelectedPriority = null;
        let createModalSelectedProject = 'inbox';
        let createModalIsBonus = false;

        const editModalSelectedTags = new Set();
        let editModalSelectedPriority = null;
        let editModalSelectedProject = 'inbox';
        let editModalIsBonus = false;

        // Mr. Study Gamification State
        let activeMrStudyRules = [];
        let isMrStudyLinked = false;

        // =========================================================================
        // Saved Criteria Store & Storage Helpers (Max 6, Max 4 Exemplars <= 4MB)
        // =========================================================================
        const SAVED_CRITERIA_KEY = 'taskitator_saved_criteria';
        const MAX_SAVED_CRITERIA = 6;
        const MAX_EXEMPLARS = 4;
        const MAX_EXEMPLAR_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB limit

        function getSavedCriteria() {
            try {
                return JSON.parse(localStorage.getItem(SAVED_CRITERIA_KEY) || '[]');
            } catch (e) {
                return [];
            }
        }

        function saveSavedCriteriaList(list) {
            localStorage.setItem(SAVED_CRITERIA_KEY, JSON.stringify(list));
            if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
                SyncEngine.markLocalModified();
                SyncEngine.scheduleAutoPush();
            }
            updateSavedCriteriaBadge();
        }

        function updateSavedCriteriaBadge() {
            const badge = document.getElementById('savedCriteriaCountBadge');
            if (badge) {
                const count = getSavedCriteria().length;
                badge.textContent = `${count}/${MAX_SAVED_CRITERIA}`;
            }
        }

        async function fileToBase64Payload(file) {
            if (!file) return null;
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    resolve({
                        fileName: file.name || 'exemplar',
                        mimeType: file.type || 'application/octet-stream',
                        fileSize: file.size || 0,
                        data: String(reader.result).split(',')[1] || ''
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        function base64PayloadToFile(payload) {
            if (!payload || !payload.data) return null;
            try {
                const byteChars = atob(payload.data);
                const byteNums = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) {
                    byteNums[i] = byteChars.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNums);
                const blob = new Blob([byteArray], { type: payload.mimeType || 'application/octet-stream' });
                return new File([blob], payload.fileName || 'exemplar', { type: payload.mimeType || 'application/octet-stream' });
            } catch (e) {
                console.warn('[SavedCriteria] Failed to reconstruct file from base64:', e);
                return null;
            }
        }

        // =========================================================================
        // Smart Criteria Variable Linker Helper Engine
        // =========================================================================
        const SmartCriteriaEngine = {
            parseTitle(rawInput) {
                const raw = String(rawInput || '');
                const varMap = {};
                const cleanTitle = raw.replace(/\{([^=]+)==([^}]+)\}/g, (match, key, value) => {
                    const cleanKey = key.trim().toLowerCase();
                    const cleanVal = value.trim();
                    varMap[cleanKey] = cleanVal;
                    return cleanVal;
                }).trim();

                return {
                    cleanTitle: cleanTitle.replace(/\s+/g, ' '),
                    varMap
                };
            },

            resolveCriteria(criteriaText, varMap = {}) {
                let text = String(criteriaText || '');
                const unresolvedKeys = [];

                text = text.replace(/\{([^=}]+)\}/g, (match, key) => {
                    const cleanKey = key.trim().toLowerCase();
                    if (Object.prototype.hasOwnProperty.call(varMap, cleanKey)) {
                        return varMap[cleanKey];
                    }
                    unresolvedKeys.push(cleanKey);
                    return match;
                });

                const hasUnresolved = unresolvedKeys.length > 0 || /\{[^}]+\}/.test(text);

                return {
                    resolvedText: text.trim(),
                    hasUnresolved,
                    unresolvedKeys
                };
            },

            validateCriteriaForSubmission(criteriaText, varMap = {}) {
                const { resolvedText, hasUnresolved, unresolvedKeys } = this.resolveCriteria(criteriaText, varMap);
                if (hasUnresolved) {
                    const missingList = unresolvedKeys.length > 0 ? unresolvedKeys.join(', ') : 'unknown';
                    alert(`Criteria Error: Unresolved variable placeholder(s) detected: {${missingList}}.\nPlease define all referenced variables in the task title using the format: Task Title {${missingList}==value}.`);
                    return { valid: false, resolvedText: criteriaText };
                }
                return { valid: true, resolvedText };
            },

            reverseSubstitute(resolvedText, varMap = {}) {
                let text = String(resolvedText || '');
                for (const [key, val] of Object.entries(varMap)) {
                    if (val && String(val).trim()) {
                        const escapedVal = String(val).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const regex = new RegExp(escapedVal, 'g');
                        text = text.replace(regex, `{${key}}`);
                    }
                }
                return text;
            },

            incrementConsecutiveNum(text) {
                if (!text) return text;
                return text.replace(/\{num==(\d+)\}/i, (match, digits) => {
                    const nextVal = parseInt(digits, 10) + 1;
                    return `{num==${nextVal}}`;
                });
            }
        };

        function updateMrStudyRuleDropdown() {
            const container = document.getElementById('mrstudyRuleContainer');
            const select = document.getElementById('taskMrstudyRuleSelect');
            const rewardInputs = document.getElementById('mrstudyRewardInputs');
            if (!container || !select) return;

            if (!isMrStudyLinked || activeMrStudyRules.length === 0) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'block';
            select.innerHTML = '<option value="">None (Standard Task)</option>';

            activeMrStudyRules.forEach(rule => {
                const opt = document.createElement('option');
                opt.value = rule.id;
                opt.textContent = `${rule.title} [${rule.min_xp}-${rule.max_xp} XP]`;
                select.appendChild(opt);
            });

            if (rewardInputs) rewardInputs.style.display = 'none';
        }

        // =========================================================================
        // Modal Selectors: Tags, Priorities & Projects
        // =========================================================================
        function renderModalProjectCloud(containerId, isEditModal) {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const globalProjects = host.catalogs.projects();

            globalProjects.forEach(proj => {
                const pill = document.createElement('span');
                pill.className = 'priority-select-pill';
                const isSelected = isEditModal 
                    ? (editModalSelectedProject === proj.id) 
                    : (createModalSelectedProject === proj.id);

                if (isSelected) {
                    pill.classList.add('selected');
                    pill.style.borderColor = proj.color;
                    pill.style.color = proj.color;
                }

                TaskitatorSafety.setProjectLabel(pill, proj);

                pill.addEventListener('click', () => {
                    if (isEditModal) {
                        editModalSelectedProject = proj.id;
                    } else {
                        createModalSelectedProject = proj.id;
                    }
                    renderModalProjectCloud(containerId, isEditModal);
                });
                container.appendChild(pill);
            });
        }

        function renderModalTagCloud(containerId, activeSet) {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const globalTags = host.catalogs.tags();

            globalTags.forEach(tag => {
                const pill = document.createElement('span');
                pill.className = 'tag-select-pill';
                if (activeSet.has(tag)) pill.classList.add('selected');
                pill.textContent = tag;
                pill.addEventListener('click', () => {
                    if (activeSet.has(tag)) activeSet.delete(tag);
                    else activeSet.add(tag);
                    renderModalTagCloud(containerId, activeSet);
                });
                container.appendChild(pill);
            });
        }

        function handleQuickAddTag(inputId, activeSet, containerId) {
            const input = document.getElementById(inputId);
            if (!input) return;
            const val = input.value.trim().toLowerCase().replace(/,/g, '');
            if (val) {
                host.catalogs.addTag(val);
                activeSet.add(val);
                input.value = '';
                renderModalTagCloud(containerId, activeSet);
            }
        }

        function renderModalPriorityCloud(containerId, isEditModal) {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const globalPriorities = host.catalogs.priorities();

            globalPriorities.forEach(p => {
                const pill = document.createElement('span');
                pill.className = 'priority-select-pill';
                const isSelected = isEditModal ? (editModalSelectedPriority === p.id) : (createModalSelectedPriority === p.id);

                if (isSelected) {
                    pill.classList.add('selected');
                    pill.style.color = p.color;
                }

                pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${TaskitatorSafety.escapeHtml(p.color)};"></span> ${TaskitatorSafety.escapeHtml(p.name)}`;

                pill.addEventListener('click', () => {
                    if (isEditModal) {
                        editModalSelectedPriority = (editModalSelectedPriority === p.id) ? null : p.id;
                    } else {
                        createModalSelectedPriority = (createModalSelectedPriority === p.id) ? null : p.id;
                    }
                    renderModalPriorityCloud(containerId, isEditModal);
                });
                container.appendChild(pill);
            });
        }

        // =========================================================================
        // Todoist-Style NLP Smart Creation Engine (Supports $$ Bonus Token)
        // =========================================================================
        const NLPEngine = (() => {
            function upgradeInput(inputId, contextType) {
                const el = document.getElementById(inputId);
                if (!el || el.tagName !== 'INPUT') return el;
                
                const div = document.createElement('div');
                div.id = inputId;
                div.className = 'task-rich-input';
                div.contentEditable = 'true';
                div.setAttribute('data-placeholder', el.getAttribute('placeholder') || 'Task Title...');
                
                el.parentNode.replaceChild(div, el);
                
                const insertText = text => {
                    div.focus();
                    const selection = window.getSelection();
                    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
                    if (!div.contains(range.commonAncestorContainer)) { range.selectNodeContents(div); range.collapse(false); }
                    range.deleteContents();
                    const node = document.createTextNode(text);
                    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
                    selection.removeAllRanges(); selection.addRange(range);
                    div.dispatchEvent(new Event('input', { bubbles: true }));
                };
                div.addEventListener('paste', event => {
                    event.preventDefault(); insertText(event.clipboardData.getData('text/plain'));
                });
                div.addEventListener('drop', event => {
                    event.preventDefault(); insertText(event.dataTransfer.getData('text/plain'));
                });
                div.addEventListener('input', (e) => handleInput(e, contextType, div));
                div.addEventListener('click', (e) => handleClick(e, contextType, div));
                div.addEventListener('keydown', handleKeydown);
                div.addEventListener('paste', handlePaste);
                
                return div;
            }

            function handleInput(e, contextType, div) {
                const sel = window.getSelection();
                if (!sel.rangeCount) return;
                
                const range = sel.getRangeAt(0);
                const node = range.startContainer;
                
                if (node.nodeType !== Node.TEXT_NODE) return;
                
                const textBeforeCaret = node.textContent.substring(0, range.startOffset);
                if (!textBeforeCaret.endsWith(' ')) return;
                
                const match = textBeforeCaret.match(/(?:^|\s)((\$\$|[#!@][a-zA-Z0-9_.-]+))\s$/);
                if (!match) return;
                
                const rawToken = match[1];
                let chipData = null;

                if (rawToken === '$$') {
                    chipData = {
                        html: `<span class="nlp-chip nlp-bonus" contenteditable="false" data-type="bonus" data-raw="$$">⭐ Bonus <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                        action: () => {
                            if (contextType === 'edit') {
                                editModalIsBonus = true;
                                const cb = document.getElementById('editBonusTaskCheckbox');
                                if (cb) cb.checked = true;
                            } else {
                                createModalIsBonus = true;
                                const cb = document.getElementById('bonusTaskCheckbox');
                                if (cb) cb.checked = true;
                            }
                        }
                    };
                } else {
                    const prefix = rawToken[0];
                    const value = rawToken.substring(1).toLowerCase();
                    
                    if (prefix === '!') {
                        const prios = host.catalogs.priorities();
                        let pId = null;
                        if (['p1', 'high'].includes(value)) pId = prios.find(p => p.rank === 1)?.id;
                        else if (['p2', 'med', 'medium'].includes(value)) pId = prios.find(p => p.rank === 2)?.id;
                        else if (['p3', 'low'].includes(value)) pId = prios.find(p => p.rank === 3)?.id;
                        
                        if (pId) {
                            const pObj = prios.find(p => p.id === pId);
                            chipData = {
                                html: `<span class="nlp-chip nlp-prio" contenteditable="false" data-type="prio" data-id="${TaskitatorSafety.escapeHtml(pId)}" data-raw="${TaskitatorSafety.escapeHtml(rawToken)}"><span class="priority-color-dot" style="background:${TaskitatorSafety.escapeHtml(pObj.color)}; width:8px; height:8px; display:inline-block; border-radius:50%; margin-right:4px;"></span>${TaskitatorSafety.escapeHtml(pObj.name)} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                                action: () => {
                                    if (contextType === 'edit') {
                                        editModalSelectedPriority = pId;
                                        renderModalPriorityCloud('editPriorityCloud', true);
                                    } else {
                                        createModalSelectedPriority = pId;
                                        renderModalPriorityCloud('createPriorityCloud', false);
                                    }
                                }
                            };
                        }
                    } else if (prefix === '#') {
                        const projs = host.catalogs.projects();
                        const pObj = projs.find(p => p.name.replace(/\s+/g, '').toLowerCase() === value);
                        if (pObj && pObj.id !== 'inbox') {
                            chipData = {
                                html: `<span class="nlp-chip nlp-proj" contenteditable="false" data-type="proj" data-id="${TaskitatorSafety.escapeHtml(pObj.id)}" data-raw="${TaskitatorSafety.escapeHtml(rawToken)}"><span>${TaskitatorSafety.escapeHtml(pObj.icon)}</span> ${TaskitatorSafety.escapeHtml(pObj.name)} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                                action: () => {
                                    if (contextType === 'edit') {
                                        editModalSelectedProject = pObj.id;
                                        renderModalProjectCloud('editProjectCloud', true);
                                    } else {
                                        createModalSelectedProject = pObj.id;
                                        renderModalProjectCloud('createProjectCloud', false);
                                    }
                                }
                            };
                        }
                    } else if (prefix === '@') {
                        chipData = {
                            html: `<span class="nlp-chip nlp-tag" contenteditable="false" data-type="tag" data-id="${TaskitatorSafety.escapeHtml(value)}" data-raw="${TaskitatorSafety.escapeHtml(rawToken)}"># ${TaskitatorSafety.escapeHtml(value)} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                            action: () => {
                                host.catalogs.addTag(value);
                                if (contextType === 'edit') {
                                    editModalSelectedTags.add(value);
                                    renderModalTagCloud('editTagCloud', editModalSelectedTags);
                                } else {
                                    createModalSelectedTags.add(value);
                                    renderModalTagCloud('createTagCloud', createModalSelectedTags);
                                }
                            }
                        };
                    }
                }
                
                if (chipData) {
                    const startOffset = match.index + (match[0].startsWith(' ') ? 1 : 0);
                    const endOffset = range.startOffset; 
                    
                    const beforeText = node.textContent.substring(0, startOffset);
                    const afterText = node.textContent.substring(endOffset);
                    
                    node.textContent = beforeText;
                    
                    const chipWrapper = document.createElement('span');
                    chipWrapper.innerHTML = chipData.html;
                    const chipNode = chipWrapper.firstChild;
                    
                    const afterNode = document.createTextNode('\u00A0' + afterText); 
                    
                    const parent = node.parentNode;
                    parent.insertBefore(chipNode, node.nextSibling);
                    parent.insertBefore(afterNode, chipNode.nextSibling);
                    
                    chipData.action();
                    
                    const newRange = document.createRange();
                    newRange.setStart(afterNode, 1);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                }
            }
            
            function handleClick(e, contextType, div) {
                if (e.target.matches('.nlp-chip-remove')) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const chip = e.target.closest('.nlp-chip');
                    if (!chip) return;
                    
                    const raw = chip.getAttribute('data-raw');
                    const type = chip.getAttribute('data-type');
                    const id = chip.getAttribute('data-id');
                    
                    if (type === 'bonus') {
                        if (contextType === 'edit') {
                            editModalIsBonus = false;
                            const cb = document.getElementById('editBonusTaskCheckbox');
                            if (cb) cb.checked = false;
                        } else {
                            createModalIsBonus = false;
                            const cb = document.getElementById('bonusTaskCheckbox');
                            if (cb) cb.checked = false;
                        }
                    } else if (type === 'prio') {
                        if (contextType === 'edit' && editModalSelectedPriority === id) {
                            editModalSelectedPriority = host.catalogs.lowestPriority();
                            renderModalPriorityCloud('editPriorityCloud', true);
                        } else if (contextType === 'create' && createModalSelectedPriority === id) {
                            createModalSelectedPriority = host.catalogs.lowestPriority();
                            renderModalPriorityCloud('createPriorityCloud', false);
                        }
                    } else if (type === 'proj') {
                        if (contextType === 'edit' && editModalSelectedProject === id) {
                            editModalSelectedProject = 'inbox';
                            renderModalProjectCloud('editProjectCloud', true);
                        } else if (contextType === 'create' && createModalSelectedProject === id) {
                            createModalSelectedProject = 'inbox';
                            renderModalProjectCloud('createProjectCloud', false);
                        }
                    } else if (type === 'tag') {
                        if (contextType === 'edit') {
                            editModalSelectedTags.delete(id);
                            renderModalTagCloud('editTagCloud', editModalSelectedTags);
                        } else {
                            createModalSelectedTags.delete(id);
                            renderModalTagCloud('createTagCloud', createModalSelectedTags);
                        }
                    }
                    
                    const textNode = document.createTextNode(raw + '\u00A0');
                    chip.parentNode.replaceChild(textNode, chip);
                    
                    div.focus();
                    const sel = window.getSelection();
                    if (sel) {
                        const range = document.createRange();
                        range.selectNodeContents(div);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                }
            }

            function handleKeydown(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const form = this.closest('form');
                    if (form) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                }
            }

            function handlePaste(e) {
                e.preventDefault();
                const text = (e.originalEvent || e).clipboardData.getData('text/plain');
                document.execCommand('insertText', false, text);
            }

            function extractCleanTitle(inputId) {
                const div = document.getElementById(inputId);
                if (!div) return '';
                if (div.tagName === 'INPUT') return div.value.trim();
                
                let text = '';
                div.childNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        text += node.textContent;
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        if (!node.classList.contains('nlp-chip')) {
                            text += node.textContent;
                        }
                    }
                });
                return text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
            }

            return { upgradeInput, extractCleanTitle };
        })();

        // =========================================================================
        // Proof Audit Modal Engine (Dual-Evidence)
        // =========================================================================
        async function openAuditModal(task) {
            pendingAuditTaskId = task.id;
            const auditModal = document.getElementById('auditModal');
            const auditTaskTitle = document.getElementById('auditTaskTitleDisplay');
            const auditCriteria = document.getElementById('auditCriteriaDisplay');
            const auditImage = document.getElementById('auditImageInput');
            const auditContext = document.getElementById('auditContextInput');
            const auditFeedback = document.getElementById('auditFeedbackContainer');
            const submitProofBtn = document.getElementById('submitProofBtn');

            if (auditTaskTitle) auditTaskTitle.textContent = task.title;
            
            let criteriaHtml = `<strong>Required Criteria &lt;PC&gt;:</strong> ${TaskitatorSafety.escapeHtml(task.proof_criteria || 'General confirmation of task completion.')}`;
            
            if (window.ExemplarStore) {
                const hasExemplar = await ExemplarStore.hasExemplar(task.id);
                if (hasExemplar) {
                    criteriaHtml += `<div style="margin-top: 6px; display: inline-flex; align-items: center; gap: 4px; color: var(--primary); font-size: 0.75rem; font-weight: 600;"><span>📎</span> Reference Exemplar Required for Match</div>`;
                }
            }
            
            if (auditCriteria) auditCriteria.innerHTML = criteriaHtml;
            if (auditImage) auditImage.value = '';
            if (auditContext) auditContext.value = '';
            if (auditFeedback) auditFeedback.style.display = 'none';
            
            if (submitProofBtn) {
                submitProofBtn.disabled = false;
                submitProofBtn.textContent = 'Submit Proof';
            }
            if (auditModal) auditModal.classList.add('open');
        }

        // =========================================================================
        // Task Detail / Edit Modal Engine
        // =========================================================================
        function refreshDetailSubtaskList(parentId, triggerRenderFn) {
            const detailSubtasksList = document.getElementById('detailSubtasksList');
            const taskDetailModal = document.getElementById('taskDetailModal');
            if (!detailSubtasksList) return;
            
            detailSubtasksList.innerHTML = '';
            const directChildren = host.tasks.getAll().filter(t => t.parent_id === parentId && t.status !== 'trash');
            const sortedChildren = host.tasks.sort([...directChildren]);

            if (sortedChildren.length === 0) {
                detailSubtasksList.innerHTML = '<li style="font-size: 0.825rem; color: var(--text-muted); padding: 4px 0;">No subtasks yet.</li>';
            } else {
                sortedChildren.forEach(child => {
                    const sLi = document.createElement('li');
                    sLi.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-color); font-size: 0.85rem;';

                    let cBadges = '';
                    if (child.is_bonus) cBadges += '<span class="bonus-badge">⭐ Bonus</span> ';
                    if (child.ai_locked) cBadges += '<span class="ai-badge">🔒 AI</span> ';
                    if (child.strict_prerequisites) cBadges += '<span class="ai-badge" style="background:#451a03; color:#fde68a; border-color:#78350f;">🛡️</span>';

                    sLi.innerHTML = `
                        <span>${child.status === 'completed' ? '✓ ' : ''}${TaskitatorSafety.escapeHtml(child.title)} ${cBadges}</span>
                        <button type="button" class="icon-btn" style="padding: 2px 6px; font-size: 0.75rem;">View</button>
                    `;
                    sLi.querySelector('button').addEventListener('click', () => {
                        if (taskDetailModal) taskDetailModal.classList.remove('open');
                        openTaskDetailModal(child.id, triggerRenderFn);
                    });
                    detailSubtasksList.appendChild(sLi);
                });
            }
        }

        async function openTaskDetailModal(taskId, triggerRenderFn) {
            const task = host.tasks.getAll().find(t => t.id === taskId);
            if (!task) return;
            activeDetailTaskId = taskId;
            window.TaskitatorRecurrenceUI?.bindTask(taskId);

            const isBypassActive = host.rules.bypassActive();
            const isLocked = Boolean(task.ai_locked);
            const isShielded = Boolean(task.strict_prerequisites);

            const taskDetailModal = document.getElementById('taskDetailModal');
            const editTaskTitle = document.getElementById('editTaskTitle');
            const editTaskDesc = document.getElementById('editTaskDesc');
            const editTaskDueDate = document.getElementById('editTaskDueDate');
            const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
            const editStrictPrereqCheckbox = document.getElementById('editStrictPrereqCheckbox');
            
            const createAiAuditInfoBtn = document.getElementById('createAiAuditInfoBtn');
            const createAiAuditInfoBox = document.getElementById('createAiAuditInfoBox');
            if (createAiAuditInfoBtn && createAiAuditInfoBox) {
                createAiAuditInfoBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    createAiAuditInfoBox.style.display = createAiAuditInfoBox.style.display === 'none' ? 'block' : 'none';
                });
            }

            const editAiAuditInfoBtn = document.getElementById('editAiAuditInfoBtn');
            const editAiAuditInfoBox = document.getElementById('editAiAuditInfoBox');
            if (editAiAuditInfoBtn && editAiAuditInfoBox) {
                editAiAuditInfoBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    editAiAuditInfoBox.style.display = editAiAuditInfoBox.style.display === 'none' ? 'block' : 'none';
                });
            }

            const editBonusTaskCheckbox = document.getElementById('editBonusTaskCheckbox');
            const editCriteriaBoxContainer = document.getElementById('editCriteriaBoxContainer');
            const editTaskCriteria = document.getElementById('editTaskCriteria');
            const detailLockStatusBadge = document.getElementById('detailLockStatusBadge');
            const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
            const editExemplarChip = document.getElementById('editExemplarChip');
            const editExemplarName = document.getElementById('editExemplarName');
            const editExemplarSize = document.getElementById('editExemplarSize');
            const editExemplarInput = document.getElementById('editExemplarInput');
            const editFeedback = document.getElementById('editCriteriaFeedbackBox');
            const detailQuickSubtaskInput = document.getElementById('detailQuickSubtaskInput');

            // Move Task Elements
            const editTaskParentSelect = document.getElementById('editTaskParentSelect');
            const moveShieldWarningBadge = document.getElementById('moveShieldWarningBadge');

            // Sibling Criteria Inheritance Elements
            const siblingInheritContainer = document.getElementById('siblingInheritContainer');
            const siblingTaskSelect = document.getElementById('siblingTaskSelect');

            pendingEditExemplarFile = null;
            editCriteriaValidationState = {
                validated: isLocked,
                score: isLocked ? 10 : 0,
                isTemplate: false,
                isSavedCriteria: false,
                savedCriteriaText: ''
            };

            if (editFeedback) {
                editFeedback.style.display = 'none';
                editFeedback.className = 'criteria-feedback-box';
                editFeedback.innerHTML = '';
            }

            if (editExemplarInput) editExemplarInput.value = '';

            const titleH = document.getElementById('detailTaskTitleHeader');
            if (titleH) titleH.textContent = task.title;
            
            const titleForEdit = task.raw_title !== undefined ? task.raw_title : (task.title || '');
            if (editTaskTitle) {
                if (editTaskTitle.tagName === 'DIV') editTaskTitle.textContent = titleForEdit;
                else editTaskTitle.value = titleForEdit;
            }
            
            if (editTaskDesc) editTaskDesc.value = task.description || '';
            if (editTaskDueDate) editTaskDueDate.value = task.due_date === 'today' ? host.clock.today() : (task.due_date || '');
            if (detailQuickSubtaskInput) { detailQuickSubtaskInput.value = ''; detailQuickSubtaskInput._quickGeneration = (detailQuickSubtaskInput._quickGeneration || 0) + 1; }

            editModalSelectedTags.clear();
            (task.tags || []).forEach(t => editModalSelectedTags.add(t));
            editModalSelectedPriority = task.priority_id || null;
            editModalSelectedProject = task.project_id || 'inbox';
            editModalIsBonus = Boolean(task.is_bonus);

            if (editBonusTaskCheckbox) {
                editBonusTaskCheckbox.checked = editModalIsBonus;
            }

            renderModalTagCloud('editTagCloud', editModalSelectedTags);
            renderModalPriorityCloud('editPriorityCloud', true);
            renderModalProjectCloud('editProjectCloud', true);

            // Move Task: Check Shield Confinement
            const shieldedAncestor = host.tasks.shieldedAncestor(taskId);
            if (editTaskParentSelect && moveShieldWarningBadge) {
                if (shieldedAncestor && !isBypassActive) {
                    moveShieldWarningBadge.style.display = 'inline-block';
                    editTaskParentSelect.disabled = true;
                    editTaskParentSelect.title = "Shielded task cannot be moved out of their parents";
                } else {
                    moveShieldWarningBadge.style.display = 'none';
                    editTaskParentSelect.disabled = false;
                    editTaskParentSelect.title = "";
                }

                const descendantIds = new Set(host.tasks.descendants(taskId).map(d => d.id));
                descendantIds.add(taskId);

                editTaskParentSelect.innerHTML = '<option value="">(Root Level - No Parent)</option>';
                host.tasks.getAll().forEach(candidate => {
                    if (descendantIds.has(candidate.id)) return;
                    if (candidate.status === 'trash' || candidate.status === 'completed') return;

                    const opt = document.createElement('option');
                    opt.value = candidate.id;
                    opt.textContent = `${candidate.title} [${candidate.project_id || 'inbox'}]`;
                    if (candidate.id === task.parent_id) opt.selected = true;
                    editTaskParentSelect.appendChild(opt);
                });
                if (!task.parent_id) {
                    editTaskParentSelect.value = '';
                }
            }

            // Sibling Criteria Inheritance
            if (siblingInheritContainer && siblingTaskSelect) {
                const isEligibleForInherit = task.parent_id && task.status !== 'completed' && (!task.ai_locked || isBypassActive);
                if (isEligibleForInherit) {
                    const eligibleSiblings = host.tasks.getAll().filter(t => t.parent_id === task.parent_id && t.id !== task.id && t.status !== 'trash' && t.proof_criteria);
                    if (eligibleSiblings.length > 0) {
                        siblingInheritContainer.style.display = 'block';
                        siblingTaskSelect.innerHTML = '<option value="">Select a sibling with verified criteria...</option>';
                        eligibleSiblings.forEach(sib => {
                            const opt = document.createElement('option');
                            opt.value = sib.id;
                            const dispCrit = (sib.raw_proof_criteria || sib.proof_criteria).slice(0, 30);
                            opt.textContent = `${sib.title} (${dispCrit}...)`;
                            siblingTaskSelect.appendChild(opt);
                        });
                    } else {
                        siblingInheritContainer.style.display = 'none';
                    }
                } else {
                    siblingInheritContainer.style.display = 'none';
                }
            }

            const editProjectGroup = document.getElementById('editProjectCloud')?.closest('.form-group');
            if (editProjectGroup) {
                editProjectGroup.style.display = task.parent_id ? 'none' : 'block';
            }

            const cannotModifyLocked = isLocked && !isBypassActive;
            const cannotUnshield = isShielded && !isBypassActive;

            if (editAiLockCheckbox) {
                editAiLockCheckbox.checked = isLocked;
                editAiLockCheckbox.disabled = cannotModifyLocked;
            }

            if (editStrictPrereqCheckbox) {
                editStrictPrereqCheckbox.checked = isShielded;
                editStrictPrereqCheckbox.disabled = cannotModifyLocked || cannotUnshield;
            }

            if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = isLocked ? 'block' : 'none';

            if (editExemplarChip && window.ExemplarStore) {
                const exemplarRecord = await ExemplarStore.getExemplar(task.id);
                if (exemplarRecord && isLocked) {
                    if (editExemplarName) editExemplarName.textContent = exemplarRecord.fileName || exemplarRecord.filename || 'Attached Reference Exemplar';
                    if (editExemplarSize) {
                        const bytes = exemplarRecord.fileSize || exemplarRecord.size || 0;
                        editExemplarSize.textContent = bytes ? (bytes / (1024 * 1024)).toFixed(2) + ' MB' : '';
                    }
                    editExemplarChip.style.display = 'flex';
                } else {
                    editExemplarChip.style.display = 'none';
                }
            }

            const editFileWrapper = editCriteriaBoxContainer?.querySelector('.file-picker-wrapper');
            const editActionsBar = editCriteriaBoxContainer?.querySelector('.criteria-actions-bar');
            if (editFileWrapper) editFileWrapper.style.display = cannotModifyLocked ? 'none' : 'block';
            if (editActionsBar) editActionsBar.style.display = cannotModifyLocked ? 'none' : 'flex';

            if (editTaskTitle) editTaskTitle.contentEditable = cannotModifyLocked ? 'false' : 'true';
            if (editTaskDueDate) editTaskDueDate.disabled = cannotModifyLocked;
            if (editTaskCriteria) {
                editTaskCriteria.disabled = cannotModifyLocked;
                editTaskCriteria.value = task.raw_proof_criteria || task.proof_criteria || '';
            }

            if (deleteFromDetailBtn) {
                const isDeleteBlocked = !isBypassActive && (isLocked || (isShielded && host.tasks.hasUncompletedDescendant(taskId)));
                deleteFromDetailBtn.disabled = isDeleteBlocked;
            }

            if (detailLockStatusBadge) {
                let statusHtml = '';
                if (task.is_bonus) {
                    statusHtml += '<span class="bonus-badge" style="margin-right: 4px;">⭐ Bonus</span>';
                }
                if (isLocked) {
                    statusHtml += isBypassActive
                        ? '<span class="tag-chip" style="background:#451a03;color:#fde68a;">Bypass Active</span>'
                        : '<span class="ai-badge">🔒 Locked</span>';
                } else {
                    statusHtml += '<span class="tag-chip">Standard</span>';
                }
                detailLockStatusBadge.innerHTML = statusHtml;
            }

            refreshDetailSubtaskList(taskId, triggerRenderFn);

            if (taskDetailModal) {
                taskDetailModal._customRenderFn = triggerRenderFn;
                taskDetailModal.classList.add('open');
            }
        }

        // =========================================================================
        // Task Creation Launcher
        // =========================================================================
        function openTaskCreationModal(parentId = null, titleLabel = 'Create New Task', preselectedProjectId = null) {
            const form = document.getElementById('taskCreateForm');
            if (form) form.reset();

            const titleEl = document.getElementById('taskTitleInput');
            if (titleEl) {
                if (titleEl.tagName === 'DIV') titleEl.innerHTML = '';
                else titleEl.value = '';
            }

            window.TaskitatorRecurrenceUI?.resetCreate();
            const pIdField = document.getElementById('creationParentId');
            if (pIdField) pIdField.value = parentId || '';

            const modalTitle = document.getElementById('addTaskModalTitle');
            if (modalTitle) modalTitle.textContent = titleLabel;

            const critBox = document.getElementById('criteriaBoxContainer');
            if (critBox) critBox.style.display = 'none';

            const subtaskList = document.getElementById('subtaskBuilderList');
            if (subtaskList) subtaskList.innerHTML = '';

            const createQuickSubInput = document.getElementById('createQuickSubtaskInput');
            if (createQuickSubInput) { createQuickSubInput.value = ''; createQuickSubInput._quickGeneration = (createQuickSubInput._quickGeneration || 0) + 1; }

            const dueIn = document.getElementById('taskDueDateInput');
            if (dueIn) {
                dueIn.value = (host.view.current() === 'today') ? host.clock.today() : '';
            }

            const bonusCheckbox = document.getElementById('bonusTaskCheckbox');
            createModalIsBonus = false;
            if (bonusCheckbox) bonusCheckbox.checked = false;

            const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
            const mrStudyRewardInputs = document.getElementById('mrstudyRewardInputs');
            const mrstudyXpInput = document.getElementById('mrstudyXpInput');
            const mrstudyBanchInput = document.getElementById('mrstudyBanchInput');
            const aiLockCheckbox = document.getElementById('aiLockCheckbox');
            const strictPrereqCheckbox = document.getElementById('strictPrereqCheckbox');
            const mrstudyAiNotice = document.getElementById('mrstudyAiNotice');

            if (mrStudySelect) mrStudySelect.value = '';
            if (mrStudyRewardInputs) mrStudyRewardInputs.style.display = 'none';
            if (mrstudyXpInput) mrstudyXpInput.value = '';
            if (mrstudyBanchInput) mrstudyBanchInput.value = '';
            if (aiLockCheckbox) {
                aiLockCheckbox.checked = false;
                aiLockCheckbox.disabled = false;
            }
            if (strictPrereqCheckbox) {
                strictPrereqCheckbox.checked = false;
                strictPrereqCheckbox.disabled = false;
            }
            if (mrstudyAiNotice) mrstudyAiNotice.style.display = 'none';
            
            const exemplarInput = document.getElementById('createExemplarInput');
            const exemplarChip = document.getElementById('createExemplarChip');
            const exemplarGuidance = document.getElementById('exemplarGuidanceNote');
            if (exemplarInput) {
                exemplarInput.value = '';
                delete exemplarInput._savedCriteriaFile;
            }
            if (exemplarChip) exemplarChip.style.display = 'none';
            if (exemplarGuidance) exemplarGuidance.style.display = 'none';

            const pIdFieldVal = parentId || '';

            const projectGroup = document.getElementById('createProjectCloud')?.closest('.form-group');
            if (projectGroup) {
                projectGroup.style.display = pIdFieldVal ? 'none' : 'block';
            }

            createModalSelectedTags.clear();
            createModalSelectedPriority = host.catalogs.lowestPriority();

            if (pIdFieldVal) {
                const parentTask = host.tasks.getAll().find(t => t.id === pIdFieldVal);
                createModalSelectedProject = parentTask ? parentTask.project_id : 'inbox';
            } else {
                createModalSelectedProject = preselectedProjectId || 'inbox';
            }

            renderModalTagCloud('createTagCloud', createModalSelectedTags);
            renderModalPriorityCloud('createPriorityCloud', false);
            renderModalProjectCloud('createProjectCloud', false);

            criteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
            const feedback = document.getElementById('criteriaFeedbackBox');
            if (feedback) {
                feedback.style.display = 'none';
                feedback.className = 'criteria-feedback-box';
                feedback.innerHTML = '';
            }

            updateMrStudyRuleDropdown();

            const modal = document.getElementById('addTaskModal');
            if (modal) {
                modal.classList.add('open');
                setTimeout(() => { if (titleEl) titleEl.focus(); }, 100);
            }
        }

        function init() {
            if (initialized) return;
            initialized = true;
            try {
                const rawRules = localStorage.getItem('taskitator_mrstudy_rules');
                if (rawRules) {
                    activeMrStudyRules = JSON.parse(rawRules) || [];
                    isMrStudyLinked = activeMrStudyRules.length > 0;
                }
            } catch (e) {}

            updateSavedCriteriaBadge();

            // Sibling Criteria Inheritance
            const applySiblingInheritBtn = document.getElementById('applySiblingInheritBtn');
            if (applySiblingInheritBtn) {
                applySiblingInheritBtn.addEventListener('click', async () => {
                    const siblingSelect = document.getElementById('siblingTaskSelect');
                    const sibId = siblingSelect?.value;
                    if (!sibId) {
                        alert('Please select a sibling task first.');
                        return;
                    }

                    const sibling = host.tasks.getAll().find(t => t.id === sibId);
                    if (!sibling) return;

                    const editTaskCriteriaInput = document.getElementById('editTaskCriteria');
                    const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
                    const editCriteriaBoxContainer = document.getElementById('editCriteriaBoxContainer');
                    const editExemplarChip = document.getElementById('editExemplarChip');
                    const editExemplarName = document.getElementById('editExemplarName');
                    const editExemplarSize = document.getElementById('editExemplarSize');
                    const editFeedback = document.getElementById('editCriteriaFeedbackBox');

                    let inheritedTemplateText = sibling.raw_proof_criteria || '';
                    if (!inheritedTemplateText && sibling.proof_criteria) {
                        const { varMap } = SmartCriteriaEngine.parseTitle(sibling.raw_title || sibling.title);
                        inheritedTemplateText = SmartCriteriaEngine.reverseSubstitute(sibling.proof_criteria, varMap);
                    }

                    if (editTaskCriteriaInput) editTaskCriteriaInput.value = inheritedTemplateText;
                    if (editAiLockCheckbox) editAiLockCheckbox.checked = true;
                    if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = 'block';

                    if (window.ExemplarStore) {
                        const sibRecord = await ExemplarStore.getExemplar(sibling.id);
                        const inlineObj = sibRecord?.inline_data || sibRecord?.inlineData;
                        if (inlineObj && inlineObj.data) {
                            try {
                                const mimeType = inlineObj.mime_type || sibRecord.mimeType || 'application/pdf';
                                const fileName = sibRecord.fileName || sibRecord.filename || 'cloned_exemplar.pdf';
                                const byteChars = atob(inlineObj.data);
                                const byteNums = new Array(byteChars.length);
                                for (let i = 0; i < byteChars.length; i++) {
                                    byteNums[i] = byteChars.charCodeAt(i);
                                }
                                const byteArray = new Uint8Array(byteNums);
                                const clonedBlob = new Blob([byteArray], { type: mimeType });
                                pendingEditExemplarFile = new File([clonedBlob], fileName, { type: mimeType });

                                if (editExemplarName) editExemplarName.textContent = pendingEditExemplarFile.name;
                                if (editExemplarSize) editExemplarSize.textContent = (pendingEditExemplarFile.size / (1024 * 1024)).toFixed(2) + ' MB';
                                if (editExemplarChip) editExemplarChip.style.display = 'flex';
                            } catch (err) {
                                console.warn('[Inheritance] Exemplar blob reconstruction error:', err);
                            }
                        }
                    }

                    editCriteriaValidationState = { validated: true, score: 10, isTemplate: true, isSavedCriteria: false, savedCriteriaText: '' };
                    if (editFeedback) {
                        editFeedback.style.display = 'block';
                        editFeedback.className = 'criteria-feedback-box pass';
                        editFeedback.innerHTML = `<strong>✓ Inherited (10/10)</strong>: Copied raw template criteria and reference exemplar from "${TaskitatorSafety.escapeHtml(sibling.title)}".`;
                    }
                });
            }

            // Dual-Panel Sequential Quick-Subtask Inputs (Enter commits, maintains focus, consecutive auto-increment)
            const detailQuickSubtaskInput = document.getElementById('detailQuickSubtaskInput');
            if (detailQuickSubtaskInput) {
                detailQuickSubtaskInput.addEventListener('input', () => { detailQuickSubtaskInput._quickGeneration = (detailQuickSubtaskInput._quickGeneration || 0) + 1; });
                detailQuickSubtaskInput.addEventListener('keydown', async (e) => {
                    if (e.key === 'Enter') {
                        if (e.isComposing) return;
                        e.preventDefault();
                        e.stopPropagation?.();
                        if (!activeDetailTaskId) return;

                        let rawSubInput = detailQuickSubtaskInput.value.trim();
                        if (!rawSubInput) return;
                        if (detailQuickSubtaskInput._pendingConsecutiveText === rawSubInput) return;

                        const parentTask = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                        if (!parentTask) return;

                        const generation = detailQuickSubtaskInput._quickGeneration = (detailQuickSubtaskInput._quickGeneration || 0) + 1;
                        // Consume submitted title synchronously before any async Pro entitlement check
                        detailQuickSubtaskInput.value = '';
                        detailQuickSubtaskInput.focus();

                        const isBonusSub = rawSubInput.includes('$$');
                        const cleanedBonusInput = rawSubInput.replace(/\$\$/g, '').trim();

                        const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(cleanedBonusInput);

                        const templateCriteria = parentTask.raw_proof_criteria || parentTask.proof_criteria || '';
                        let resolvedCriteria = '';
                        if (templateCriteria) {
                            const res = SmartCriteriaEngine.resolveCriteria(templateCriteria, varMap);
                            resolvedCriteria = res.resolvedText;
                        }

                        const newTaskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
                        const newSubtask = {
                            id: newTaskId,
                            parent_id: activeDetailTaskId,
                            title: cleanTitle,
                            raw_title: rawSubInput,
                            description: '',
                            tags: [],
                            priority_id: host.catalogs.lowestPriority(),
                            project_id: parentTask.project_id || 'inbox',
                            status: 'active',
                            due_date: '',
                            ai_locked: false,
                            proof_criteria: resolvedCriteria,
                            raw_proof_criteria: templateCriteria,
                            strict_prerequisites: false,
                            is_bonus: isBonusSub,
                            created_at: new Date().toISOString(),
                            completed_at: null
                        };

                        host.tasks.getAll().push(newSubtask);
                        host.tasks.save();

                        const taskDetailModal = document.getElementById('taskDetailModal');
                        refreshDetailSubtaskList(activeDetailTaskId, taskDetailModal?._customRenderFn);

                        if (typeof taskDetailModal?._customRenderFn === 'function') {
                            taskDetailModal._customRenderFn();
                        } else {
                            host.view.refresh();
                        }

                        const consecutiveCb = document.getElementById('detailConsecutiveToggle');
                        const noticeEl = document.getElementById('detailConsecutiveNotice');
                        if (consecutiveCb && consecutiveCb.checked && /\{num==\d+\}/i.test(rawSubInput)) {
                            detailQuickSubtaskInput._pendingConsecutiveText = rawSubInput;
                            try {
                                const check = window.TaskitatorPro?.checkConsecutiveEntitlement
                                    ? await window.TaskitatorPro.checkConsecutiveEntitlement()
                                    : { allowed: false, status: 'error', message: 'Could not verify Taskitator Pro status right now. Ordinary manual subtask creation remains available — please retry the Pro consecutive option in a moment.' };
                                if (generation !== detailQuickSubtaskInput._quickGeneration || !consecutiveCb.checked) return;
                                if (check.allowed) {
                                    if (noticeEl) { noticeEl.style.display = 'none'; noticeEl.textContent = ''; }
                                    if (detailQuickSubtaskInput.value === '') {
                                        detailQuickSubtaskInput.value = SmartCriteriaEngine.incrementConsecutiveNum(rawSubInput);
                                    }
                                } else {
                                    if (check.status !== 'error') consecutiveCb.checked = false;
                                    if (noticeEl) {
                                        noticeEl.textContent = check.message;
                                        noticeEl.style.display = 'block';
                                    }
                                }
                            } finally {
                                if (detailQuickSubtaskInput._pendingConsecutiveText === rawSubInput) {
                                    delete detailQuickSubtaskInput._pendingConsecutiveText;
                                }
                            }
                        }
                    }
                });
            }

            const createQuickSubtaskInput = document.getElementById('createQuickSubtaskInput');
            if (createQuickSubtaskInput) {
                createQuickSubtaskInput.addEventListener('input', () => { createQuickSubtaskInput._quickGeneration = (createQuickSubtaskInput._quickGeneration || 0) + 1; });
                createQuickSubtaskInput.addEventListener('keydown', async (e) => {
                    if (e.key === 'Enter') {
                        if (e.isComposing) return;
                        e.preventDefault();
                        e.stopPropagation?.();
                        const rawText = createQuickSubtaskInput.value.trim();
                        if (!rawText) return;
                        if (createQuickSubtaskInput._pendingConsecutiveText === rawText) return;

                        const generation = createQuickSubtaskInput._quickGeneration = (createQuickSubtaskInput._quickGeneration || 0) + 1;
                        // Consume submitted title synchronously before any async Pro entitlement check
                        createQuickSubtaskInput.value = '';
                        createQuickSubtaskInput.focus();

                        const subtaskBuilderList = document.getElementById('subtaskBuilderList');
                        if (subtaskBuilderList) {
                            const div = document.createElement('div');
                            div.className = 'subtask-builder-item';
                            div.innerHTML = `
                                <input type="text" class="subtask-input-title" value="${TaskitatorSafety.escapeHtml(rawText)}" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-color);" required>
                                <button type="button" class="action-del-btn">✕</button>
                            `;
                            div.querySelector('.action-del-btn').addEventListener('click', () => div.remove());
                            subtaskBuilderList.appendChild(div);
                        }

                        const consecutiveCb = document.getElementById('createConsecutiveToggle');
                        const noticeEl = document.getElementById('createConsecutiveNotice');
                        if (consecutiveCb && consecutiveCb.checked && /\{num==\d+\}/i.test(rawText)) {
                            createQuickSubtaskInput._pendingConsecutiveText = rawText;
                            try {
                                const check = window.TaskitatorPro?.checkConsecutiveEntitlement
                                    ? await window.TaskitatorPro.checkConsecutiveEntitlement()
                                    : { allowed: false, status: 'error', message: 'Could not verify Taskitator Pro status right now. Ordinary manual subtask creation remains available — please retry the Pro consecutive option in a moment.' };
                                if (generation !== createQuickSubtaskInput._quickGeneration || !consecutiveCb.checked) return;
                                if (check.allowed) {
                                    if (noticeEl) { noticeEl.style.display = 'none'; noticeEl.textContent = ''; }
                                    if (createQuickSubtaskInput.value === '') {
                                        createQuickSubtaskInput.value = SmartCriteriaEngine.incrementConsecutiveNum(rawText);
                                    }
                                } else {
                                    if (check.status !== 'error') consecutiveCb.checked = false;
                                    if (noticeEl) {
                                        noticeEl.textContent = check.message;
                                        noticeEl.style.display = 'block';
                                    }
                                }
                            } finally {
                                if (createQuickSubtaskInput._pendingConsecutiveText === rawText) {
                                    delete createQuickSubtaskInput._pendingConsecutiveText;
                                }
                            }
                        }
                    }
                });
            }

            
            const bindConsecutiveToggle = (toggleId, noticeId) => {
                const toggleEl = document.getElementById(toggleId);
                const noticeEl = document.getElementById(noticeId);
                if (!toggleEl) return;
                toggleEl.addEventListener('change', async () => {
                    if (!toggleEl.checked) {
                        if (noticeEl) { noticeEl.style.display = 'none'; noticeEl.textContent = ''; }
                        return;
                    }
                    const check = window.TaskitatorPro?.checkConsecutiveEntitlement
                        ? await window.TaskitatorPro.checkConsecutiveEntitlement()
                        : { allowed: false, status: 'error', message: 'Could not verify Taskitator Pro status right now. Ordinary manual subtask creation remains available — please retry the Pro consecutive option in a moment.' };
                    if (check.allowed) {
                        if (noticeEl) { noticeEl.style.display = 'none'; noticeEl.textContent = ''; }
                    } else {
                        toggleEl.checked = false;
                        if (noticeEl) {
                            noticeEl.textContent = check.message;
                            noticeEl.style.display = 'block';
                        }
                    }
                });
            };
            bindConsecutiveToggle('createConsecutiveToggle', 'createConsecutiveNotice');
            bindConsecutiveToggle('detailConsecutiveToggle', 'detailConsecutiveNotice');

            const openRootAddModalBtn = document.getElementById('openRootAddModalBtn');
            if (openRootAddModalBtn) {
                openRootAddModalBtn.addEventListener('click', () => {
                    openTaskCreationModal(null, 'Create New Task');
                });
            }

            const createQuickTagBtn = document.getElementById('createQuickTagBtn');
            if (createQuickTagBtn) {
                createQuickTagBtn.addEventListener('click', () => {
                    handleQuickAddTag('createQuickTagInput', createModalSelectedTags, 'createTagCloud');
                });
            }
            const createQuickTagInput = document.getElementById('createQuickTagInput');
            if (createQuickTagInput) {
                createQuickTagInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        handleQuickAddTag('createQuickTagInput', createModalSelectedTags, 'createTagCloud');
                    }
                });
            }

            const editQuickTagBtn = document.getElementById('editQuickTagBtn');
            if (editQuickTagBtn) {
                editQuickTagBtn.addEventListener('click', () => {
                    handleQuickAddTag('editQuickTagInput', editModalSelectedTags, 'editTagCloud');
                });
            }
            const editQuickTagInput = document.getElementById('editQuickTagInput');
            if (editQuickTagInput) {
                editQuickTagInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        handleQuickAddTag('editQuickTagInput', editModalSelectedTags, 'editTagCloud');
                    }
                });
            }

            const aiLockCheckbox = document.getElementById('aiLockCheckbox');
            if (aiLockCheckbox) {
                aiLockCheckbox.addEventListener('change', () => {
                    const cBox = document.getElementById('criteriaBoxContainer');
                    if (!aiLockCheckbox.disabled && cBox) {
                        cBox.style.display = aiLockCheckbox.checked ? 'block' : 'none';
                    }
                });
            }

            const bonusTaskCheckbox = document.getElementById('bonusTaskCheckbox');
            if (bonusTaskCheckbox) {
                bonusTaskCheckbox.addEventListener('change', () => {
                    createModalIsBonus = Boolean(bonusTaskCheckbox.checked);
                });
            }

            
            const createAiAuditInfoBtn = document.getElementById('createAiAuditInfoBtn');
            const createAiAuditInfoBox = document.getElementById('createAiAuditInfoBox');
            if (createAiAuditInfoBtn && createAiAuditInfoBox) {
                createAiAuditInfoBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    createAiAuditInfoBox.style.display = createAiAuditInfoBox.style.display === 'none' ? 'block' : 'none';
                });
            }

            const editAiAuditInfoBtn = document.getElementById('editAiAuditInfoBtn');
            const editAiAuditInfoBox = document.getElementById('editAiAuditInfoBox');
            if (editAiAuditInfoBtn && editAiAuditInfoBox) {
                editAiAuditInfoBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    editAiAuditInfoBox.style.display = editAiAuditInfoBox.style.display === 'none' ? 'block' : 'none';
                });
            }

            const editBonusTaskCheckbox = document.getElementById('editBonusTaskCheckbox');
            if (editBonusTaskCheckbox) {
                editBonusTaskCheckbox.addEventListener('change', () => {
                    editModalIsBonus = Boolean(editBonusTaskCheckbox.checked);
                });
            }

            const subtaskBuilderList = document.getElementById('subtaskBuilderList');
            // Existing draft rows consume Enter locally instead of submitting the parent form.
            subtaskBuilderList?.addEventListener('keydown', e => {
                if (e.key !== 'Enter' || !e.target?.matches?.('.subtask-input-title')) return;
                if (e.isComposing) return;
                e.preventDefault(); e.stopPropagation?.();
                document.getElementById('createQuickSubtaskInput')?.focus();
            });
            for (const [buttonId, inputId] of [['addSubtaskFieldBtn','createQuickSubtaskInput'], ['detailAddQuickSubtaskBtn','detailQuickSubtaskInput']]) {
                document.getElementById(buttonId)?.addEventListener('click', () => {
                    const input = document.getElementById(inputId);
                    input?.focus();
                    if (input?.value.trim()) input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
                });
            }

            const closeAddTaskModalBtn = document.getElementById('closeAddTaskModalBtn');
            const addTaskModal = document.getElementById('addTaskModal');
            if (closeAddTaskModalBtn && addTaskModal) {
                closeAddTaskModalBtn.addEventListener('click', () => {
                    addTaskModal.classList.remove('open');
                });
            }

            // Gamification Selection Handlers
            const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
            const mrStudyRewardInputs = document.getElementById('mrstudyRewardInputs');
            const mrstudyXpInput = document.getElementById('mrstudyXpInput');
            const mrstudyBanchInput = document.getElementById('mrstudyBanchInput');
            const mrstudyXpRangeLabel = document.getElementById('mrstudyXpRangeLabel');
            const mrstudyBanchRangeLabel = document.getElementById('mrstudyBanchRangeLabel');
            const mrstudyAiNotice = document.getElementById('mrstudyAiNotice');
            
            const mrstudyInfoTriggerBtn = document.getElementById('mrstudyInfoTriggerBtn');
            const mrstudyInfoModal = document.getElementById('mrstudyInfoModal');
            const closeMrstudyInfoModalBtn = document.getElementById('closeMrstudyInfoModalBtn');
            const dismissMrstudyInfoModalBtn = document.getElementById('dismissMrstudyInfoModalBtn');

            if (mrstudyInfoTriggerBtn && mrstudyInfoModal) {
                mrstudyInfoTriggerBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    mrstudyInfoModal.classList.add('open');
                });
                if (closeMrstudyInfoModalBtn) closeMrstudyInfoModalBtn.addEventListener('click', () => mrstudyInfoModal.classList.remove('open'));
                if (dismissMrstudyInfoModalBtn) dismissMrstudyInfoModalBtn.addEventListener('click', () => mrstudyInfoModal.classList.remove('open'));
            }

            if (mrStudySelect && mrStudyRewardInputs && aiLockCheckbox) {
                mrStudySelect.addEventListener('change', () => {
                    const ruleId = mrStudySelect.value;
                    if (!ruleId) {
                        mrStudyRewardInputs.style.display = 'none';
                        mrstudyXpInput.removeAttribute('required');
                        mrstudyBanchInput.removeAttribute('required');
                        aiLockCheckbox.disabled = false;
                        mrstudyAiNotice.style.display = 'none';
                        return;
                    }

                    const rule = activeMrStudyRules.find(r => r.id === ruleId);
                    if (rule) {
                        mrStudyRewardInputs.style.display = 'block';
                        
                        mrstudyXpInput.min = rule.min_xp;
                        mrstudyXpInput.max = rule.max_xp;
                        mrstudyXpInput.value = rule.max_xp;
                        mrstudyXpInput.required = true;
                        if (mrstudyXpRangeLabel) mrstudyXpRangeLabel.textContent = `${rule.min_xp} – ${rule.max_xp}`;
                        
                        mrstudyBanchInput.min = rule.min_banch;
                        mrstudyBanchInput.max = rule.max_banch;
                        mrstudyBanchInput.value = rule.max_banch;
                        mrstudyBanchInput.required = true;
                        if (mrstudyBanchRangeLabel) mrstudyBanchRangeLabel.textContent = `${rule.min_banch} – ${rule.max_banch}`;

                        if (rule.requires_ai) {
                            aiLockCheckbox.checked = true;
                            aiLockCheckbox.disabled = true;
                            mrstudyAiNotice.style.display = 'block';
                            
                            const cBox = document.getElementById('criteriaBoxContainer');
                            if (cBox) cBox.style.display = 'block';

                            const labelEl = aiLockCheckbox.closest('label');
                            if (labelEl) {
                                labelEl.style.transition = 'color 0.3s ease';
                                labelEl.style.color = '#fbbf24';
                                setTimeout(() => labelEl.style.color = '', 800);
                            }
                        } else {
                            aiLockCheckbox.disabled = false;
                            mrstudyAiNotice.style.display = 'none';
                        }
                    }
                });

                mrstudyXpInput.addEventListener('change', () => {
                    if (!mrstudyXpInput.value) return;
                    const min = parseInt(mrstudyXpInput.min, 10);
                    const max = parseInt(mrstudyXpInput.max, 10);
                    let val = parseInt(mrstudyXpInput.value, 10);
                    if (val < min) val = min;
                    if (val > max) val = max;
                    mrstudyXpInput.value = val;
                });
                mrstudyBanchInput.addEventListener('change', () => {
                    if (!mrstudyBanchInput.value) return;
                    const min = parseInt(mrstudyBanchInput.min, 10);
                    const max = parseInt(mrstudyBanchInput.max, 10);
                    let val = parseInt(mrstudyBanchInput.value, 10);
                    if (val < min) val = min;
                    if (val > max) val = max;
                    mrstudyBanchInput.value = val;
                });
            }

            window.addEventListener('taskitator-mrstudy-rules-updated', (e) => {
                if (e.detail) {
                    isMrStudyLinked = e.detail.linked;
                    activeMrStudyRules = e.detail.rules || [];
                    const modal = document.getElementById('addTaskModal');
                    if (modal && modal.classList.contains('open')) {
                        updateMrStudyRuleDropdown();
                    }
                }
            });

            // Exemplar Picker in Creation
            const createExemplarInput = document.getElementById('createExemplarInput');
            const createExemplarChip = document.getElementById('createExemplarChip');
            const createExemplarName = document.getElementById('createExemplarName');
            const createExemplarSize = document.getElementById('createExemplarSize');
            const removeCreateExemplarBtn = document.getElementById('removeCreateExemplarBtn');
            const exemplarGuidanceNote = document.getElementById('exemplarGuidanceNote');

            if (createExemplarInput) {
                createExemplarInput.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (!file) {
                        createExemplarChip.style.display = 'none';
                        exemplarGuidanceNote.style.display = 'none';
                        return;
                    }
                    const maxBytes = 5 * 1024 * 1024;
                    if (file.size > maxBytes) {
                        alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed is 5 MB.`);
                        createExemplarInput.value = '';
                        createExemplarChip.style.display = 'none';
                        exemplarGuidanceNote.style.display = 'none';
                        return;
                    }
                    createExemplarName.textContent = file.name;
                    createExemplarSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
                    createExemplarChip.style.display = 'flex';
                    exemplarGuidanceNote.style.display = 'block';
                });
            }

            if (removeCreateExemplarBtn) {
                removeCreateExemplarBtn.addEventListener('click', () => {
                    createExemplarInput.value = '';
                    delete createExemplarInput._savedCriteriaFile;
                    createExemplarChip.style.display = 'none';
                    exemplarGuidanceNote.style.display = 'none';
                    criteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
                    const feedback = document.getElementById('criteriaFeedbackBox');
                    if (feedback) {
                        feedback.style.display = 'none';
                        feedback.innerHTML = '';
                    }
                });
            }

            // Exemplar Picker in Edit / Detail Modal
            const editExemplarInput = document.getElementById('editExemplarInput');
            const editExemplarChip = document.getElementById('editExemplarChip');
            const editExemplarName = document.getElementById('editExemplarName');
            const editExemplarSize = document.getElementById('editExemplarSize');
            const removeEditExemplarBtn = document.getElementById('removeEditExemplarBtn');

            if (editExemplarInput) {
                editExemplarInput.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (!file) {
                        pendingEditExemplarFile = null;
                        return;
                    }
                    const maxBytes = 5 * 1024 * 1024;
                    if (file.size > maxBytes) {
                        alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed is 5 MB.`);
                        editExemplarInput.value = '';
                        pendingEditExemplarFile = null;
                        return;
                    }
                    pendingEditExemplarFile = file;
                    if (editExemplarName) editExemplarName.textContent = file.name;
                    if (editExemplarSize) editExemplarSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
                    if (editExemplarChip) editExemplarChip.style.display = 'flex';

                    editCriteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
                    const fb = document.getElementById('editCriteriaFeedbackBox');
                    if (fb) {
                        fb.style.display = 'none';
                        fb.innerHTML = '';
                    }
                });
            }

            if (removeEditExemplarBtn) {
                removeEditExemplarBtn.addEventListener('click', async () => {
                    if (editExemplarInput) editExemplarInput.value = '';
                    pendingEditExemplarFile = null;
                    if (activeDetailTaskId && window.ExemplarStore) {
                        await window.ExemplarStore.deleteExemplar(activeDetailTaskId);
                    }
                    if (editExemplarChip) editExemplarChip.style.display = 'none';
                    editCriteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
                    const fb = document.getElementById('editCriteriaFeedbackBox');
                    if (fb) {
                        fb.style.display = 'none';
                        fb.innerHTML = '';
                    }
                });
            }

            // Criteria text modification listeners to drop validation if altered
            const createCriteriaInputEl = document.getElementById('taskCriteriaInput');
            if (createCriteriaInputEl) {
                createCriteriaInputEl.addEventListener('input', () => {
                    if (criteriaValidationState.isSavedCriteria) {
                        if (createCriteriaInputEl.value.trim() !== (criteriaValidationState.savedCriteriaText || '').trim()) {
                            criteriaValidationState.validated = false;
                            criteriaValidationState.score = 0;
                            criteriaValidationState.isSavedCriteria = false;
                            criteriaValidationState.isTemplate = false;
                            const feedback = document.getElementById('criteriaFeedbackBox');
                            if (feedback) {
                                feedback.style.display = 'block';
                                feedback.className = 'criteria-feedback-box fail';
                                feedback.innerHTML = '<strong>⚠️ Criteria modified:</strong> Saved verification dropped. Please re-validate (score &ge; 7 required to save task).';
                            }
                        }
                    } else if (criteriaValidationState.validated) {
                        criteriaValidationState.validated = false;
                        criteriaValidationState.score = 0;
                        criteriaValidationState.isTemplate = false;
                    }
                });
            }

            const editTaskCriteriaInput = document.getElementById('editTaskCriteria');
            if (editTaskCriteriaInput) {
                editTaskCriteriaInput.addEventListener('input', () => {
                    if (editCriteriaValidationState.isSavedCriteria) {
                        if (editTaskCriteriaInput.value.trim() !== (editCriteriaValidationState.savedCriteriaText || '').trim()) {
                            editCriteriaValidationState.validated = false;
                            editCriteriaValidationState.score = 0;
                            editCriteriaValidationState.isSavedCriteria = false;
                            editCriteriaValidationState.isTemplate = false;
                            const feedback = document.getElementById('editCriteriaFeedbackBox');
                            if (feedback) {
                                feedback.style.display = 'block';
                                feedback.className = 'criteria-feedback-box fail';
                                feedback.innerHTML = '<strong>⚠️ Criteria modified:</strong> Saved verification dropped. Please re-validate (score &ge; 7 required to save task).';
                            }
                        }
                    } else if (editCriteriaValidationState.validated) {
                        editCriteriaValidationState.validated = false;
                        editCriteriaValidationState.score = 0;
                        editCriteriaValidationState.isTemplate = false;
                    }
                });
            }

            NLPEngine.upgradeInput('taskTitleInput', 'create');
            NLPEngine.upgradeInput('editTaskTitle', 'edit');

            // Task Creation Submission Hook
            const taskCreateForm = document.getElementById('taskCreateForm');
            if (taskCreateForm) {
                taskCreateForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    let rawTitle = NLPEngine.extractCleanTitle('taskTitleInput');
                    const desc = document.getElementById('taskDescInput')?.value.trim() || '';
                    const dueDate = document.getElementById('taskDueDateInput')?.value || '';
                    const isAi = Boolean(document.getElementById('aiLockCheckbox')?.checked);
                    const isStrictPrereq = Boolean(document.getElementById('strictPrereqCheckbox')?.checked);
                    const rawCriteria = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                    const parentId = document.getElementById('creationParentId')?.value || null;
                    
                    const exemplarInput = document.getElementById('createExemplarInput');
                    const exemplarFile = (isAi && exemplarInput)
                        ? (exemplarInput._savedCriteriaFile || (exemplarInput.files.length > 0 ? exemplarInput.files[0] : null))
                        : null;

                    if (!rawTitle) return;
                    try { window.TaskitatorRecurrenceUI?.validCreate(parentId); }
                    catch (err) { alert(err.message); return; }

                    let isBonus = createModalIsBonus || rawTitle.includes('$$');
                    rawTitle = rawTitle.replace(/\$\$/g, '').trim();

                    const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawTitle);

                    let finalCriteria = rawCriteria;
                    if (isAi && rawCriteria) {
                        const gate = SmartCriteriaEngine.validateCriteriaForSubmission(rawCriteria, varMap);
                        if (!gate.valid) return;
                        finalCriteria = gate.resolvedText;

                        if (host.rules.strictCriteria()) {
                            if (!criteriaValidationState.validated || criteriaValidationState.score < 7) {
                                alert('Criteria validation required: Please click "Validate Criteria" and ensure a score of at least 7/10 before creating an AI-locked task.');
                                return;
                            }
                        }
                    }

                    if (isAi) {
                        const confirmed = confirm(
                            "⚠️️ IRREVOCABLE TASK WARNING ⚠️\n\n" +
                            "Once created, AI-Checked tasks CANNOT be edited (except description/tags) and CANNOT be deleted.\n\n" +
                            "If phone lock is active, your device stays locked until verified by AI proof.\n\n" +
                            "Proceed with creation?"
                        );
                        if (!confirmed) return;
                    } else if (isStrictPrereq) {
                        const confirmed = confirm(
                            "⚠️ IRREVERSIBLE SHIELD ⚠️\n\n" +
                            "The Shield is permanent.\n" +
                            "Once created, this task cannot be completed until ALL core subtasks are finished, and the Shield cannot be turned off.\n\n" +
                            "Proceed with creation?"
                        );
                        if (!confirmed) return;
                    }

                    let assignedProject = createModalSelectedProject || 'inbox';
                    if (parentId) {
                        const parentTask = host.tasks.getAll().find(t => t.id === parentId);
                        if (parentTask) assignedProject = parentTask.project_id || 'inbox';
                    }

                    const submitBtn = document.getElementById('submitTaskCreateBtn');
                    if (submitBtn) {
                        submitBtn.disabled = true;
                        submitBtn.textContent = 'Saving...';
                    }

                    const newTaskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
                    
                    if (exemplarFile && window.ExemplarStore) {
                        try {
                            await window.ExemplarStore.saveExemplar(newTaskId, exemplarFile);
                        } catch (err) {
                            alert(`Failed to save exemplar image locally: ${err.message}`);
                            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Task'; }
                            return;
                        }
                    }

                    const newTask = {
                        id: newTaskId,
                        parent_id: parentId,
                        title: cleanTitle,
                        raw_title: rawTitle,
                        description: desc,
                        tags: Array.from(createModalSelectedTags),
                        priority_id: createModalSelectedPriority,
                        project_id: assignedProject,
                        status: 'active',
                        due_date: dueDate,
                        ai_locked: isAi,
                        proof_criteria: isAi ? finalCriteria : '',
                        raw_proof_criteria: isAi ? rawCriteria : '',
                        strict_prerequisites: isStrictPrereq,
                        is_bonus: isBonus,
                        created_at: new Date().toISOString(),
                        completed_at: null
                    };

                    const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
                    if (mrStudySelect && mrStudySelect.value && isMrStudyLinked) {
                        const ruleId = mrStudySelect.value;
                        const assignedXp = parseInt(document.getElementById('mrstudyXpInput')?.value || 0, 10);
                        const assignedBanch = parseInt(document.getElementById('mrstudyBanchInput')?.value || 0, 10);
                        
                        newTask.mrstudy_binding = {
                            rule_id: ruleId,
                            assigned_xp: assignedXp,
                            assigned_banch: assignedBanch
                        };
                    }

                    host.tasks.getAll().push(newTask);

                    if (subtaskBuilderList) {
                        const quickSubtaskInputs = subtaskBuilderList.querySelectorAll('.subtask-input-title');
                        quickSubtaskInputs.forEach(input => {
                            let rawSubText = input.value.trim();
                            if (rawSubText) {
                                const isSubBonus = rawSubText.includes('$$');
                                rawSubText = rawSubText.replace(/\$\$/g, '').trim();

                                const subParsed = SmartCriteriaEngine.parseTitle(rawSubText);
                                host.tasks.getAll().push({
                                    id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                                    parent_id: newTaskId,
                                    title: subParsed.cleanTitle,
                                    raw_title: rawSubText,
                                    description: '',
                                    tags: [],
                                    priority_id: host.catalogs.lowestPriority(),
                                    project_id: assignedProject,
                                    status: 'active',
                                    due_date: '',
                                    ai_locked: false,
                                    proof_criteria: '',
                                    raw_proof_criteria: '',
                                    strict_prerequisites: false,
                                    is_bonus: isSubBonus,
                                    created_at: new Date().toISOString(),
                                    completed_at: null
                                });
                            }
                        });
                    }

                    if (exemplarFile) {
                        newTask.reference_inline_data = await TaskitatorEngine.AuditEngine.fileToBase64(exemplarFile);
                    }
                    try { await window.TaskitatorRecurrenceUI?.attachCreated(newTaskId, host.tasks.getAll()); }
                    catch (err) {
                        const list = host.tasks.getAll();
                        const ids = new Set(TaskitatorRecurrence.subtree(list, newTaskId).map(t => t.id));
                        for (let i=list.length-1;i>=0;i--) if(ids.has(list[i].id)) list.splice(i,1);
                        if(window.ExemplarStore) await ExemplarStore.deleteExemplar(newTaskId).catch(()=>{});
                        alert(err.message); if(submitBtn){submitBtn.disabled=false;submitBtn.textContent='Save Task';} return;
                    }
                    host.tasks.save();
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Save Task';
                    }
                    
                    const addTaskModal = document.getElementById('addTaskModal');
                    if (addTaskModal) addTaskModal.classList.remove('open');
                    
                    if (typeof window.refreshCurrentProjectView === 'function') {
                        window.refreshCurrentProjectView();
                    } else {
                        host.view.refresh();
                    }
                });
            }

            const taskDetailModal = document.getElementById('taskDetailModal');
            const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
            if (closeDetailModalBtn && taskDetailModal) {
                closeDetailModalBtn.addEventListener('click', () => {
                    taskDetailModal.classList.remove('open');
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;
                });
            }

            const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
            if (editAiLockCheckbox) {
                editAiLockCheckbox.addEventListener('change', () => {
                    const cBox = document.getElementById('editCriteriaBoxContainer');
                    if (!editAiLockCheckbox.disabled && cBox) {
                        cBox.style.display = editAiLockCheckbox.checked ? 'block' : 'none';
                        if (editAiLockCheckbox.checked) {
                            const task = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                            if (!task || !task.ai_locked) {
                                editCriteriaValidationState = { validated: false, score: 0, isTemplate: false, isSavedCriteria: false, savedCriteriaText: '' };
                            }
                        }
                    }
                });
            }

            // Save Task Details Hook
            const saveTaskDetailsBtn = document.getElementById('saveTaskDetailsBtn');
            if (saveTaskDetailsBtn) {
                saveTaskDetailsBtn.addEventListener('click', async () => {
                    if (!activeDetailTaskId) return;

                    host.tasks.reload();
                    const task = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                    if (!task) {
                        alert('This task was removed in a background synchronization.');
                        if (taskDetailModal) taskDetailModal.classList.remove('open');
                        activeDetailTaskId = null;
                        host.view.refresh();
                        return;
                    }

                    const isBypassActive = host.rules.bypassActive();
                    const willBeAiLocked = Boolean(document.getElementById('editAiLockCheckbox')?.checked);
                    let willBeStrict = Boolean(document.getElementById('editStrictPrereqCheckbox')?.checked);
                    const editedCriteriaRaw = document.getElementById('editTaskCriteria')?.value.trim() || '';
                    let rawEditedTitle = NLPEngine.extractCleanTitle('editTaskTitle') || task.raw_title || task.title;

                    let willBeBonus = editModalIsBonus;
                    if (rawEditedTitle.includes('$$')) {
                        willBeBonus = true;
                        rawEditedTitle = rawEditedTitle.replace(/\$\$/g, '').trim();
                    }

                    const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawEditedTitle);

                    const editTaskParentSelect = document.getElementById('editTaskParentSelect');
                    const targetParentId = editTaskParentSelect ? (editTaskParentSelect.value.trim() || null) : task.parent_id;

                    if (targetParentId !== task.parent_id) {
                        const movingIds = new Set(TaskitatorRecurrence.subtree(host.tasks.getAll(),task.id).map(t=>t.id));
                        const containsSeries = host.tasks.getAll().some(t=>movingIds.has(t.id) && t.recurrence_series_id);
                        let parent = host.tasks.getAll().find(t=>t.id===targetParentId); const seen=new Set();
                        while(parent && !seen.has(parent.id)) {
                            seen.add(parent.id);
                            if(containsSeries && parent.recurrence_series_id && parent.recurrence_series_id !== task.recurrence_series_id){alert('Recurring branches cannot be nested.');return;}
                            parent=host.tasks.getAll().find(t=>t.id===parent.parent_id);
                        }
                    }
                    if (task.recurrence_series_id && targetParentId !== task.parent_id) {
                        const data = TaskitatorRecurrenceUI.state();
                        let parent = host.tasks.getAll().find(t=>t.id===targetParentId);
                        const seen = new Set();
                        while(parent && !seen.has(parent.id)) {
                            seen.add(parent.id);
                            if(parent.recurrence_series_id && parent.recurrence_series_id !== task.recurrence_series_id) { alert('Recurring branches cannot be nested.'); return; }
                            parent=host.tasks.getAll().find(t=>t.id===parent.parent_id);
                        }
                        const series=TaskitatorRecurrence.seriesFor(data,task);
                        if(series?.current_root_id !== task.id) { alert('A child must stay inside its recurring branch.'); return; }
                    }
                    if (task.recurrence_series_id && task.ai_locked && editedCriteriaRaw !== (task.raw_proof_criteria || task.proof_criteria || '')) {
                        alert('Change recurring proof criteria through Recurrence & future criteria. The current occurrence keeps its original requirements.'); return;
                    }
                    if (targetParentId !== task.parent_id) {
                        const shieldedAncestor = host.tasks.shieldedAncestor(task.id);
                        if (shieldedAncestor && !isBypassActive) {
                            alert("Shielded task can't be moved out of their parents.");
                            return;
                        }

                        const descendants = host.tasks.descendants(task.id);
                        if (targetParentId === task.id || descendants.some(d => d.id === targetParentId)) {
                            alert("Circular Reference Error: You cannot move a task into one of its own subtasks.");
                            return;
                        }

                        task.parent_id = targetParentId;

                        if (targetParentId) {
                            const targetParent = host.tasks.getAll().find(t => t.id === targetParentId);
                            if (targetParent) {
                                task.project_id = targetParent.project_id || 'inbox';
                                host.tasks.moveProject(task.id, task.project_id);
                            }
                        }
                    }

                    if (task.strict_prerequisites && !isBypassActive) {
                        willBeStrict = true;
                    }

                    let finalEditedCriteria = editedCriteriaRaw;
                    if (willBeAiLocked && (!task.ai_locked || isBypassActive)) {
                        if (editedCriteriaRaw) {
                            const gate = SmartCriteriaEngine.validateCriteriaForSubmission(editedCriteriaRaw, varMap);
                            if (!gate.valid) return;
                            finalEditedCriteria = gate.resolvedText;
                        }

                        if (host.rules.strictCriteria()) {
                            if (!editCriteriaValidationState.validated || editCriteriaValidationState.score < 7) {
                                alert('Criteria validation required: Please click "Validate Criteria" and ensure a score of at least 7/10 before saving an AI-locked task.');
                                return;
                            }
                        }
                    }

                    if (!task.ai_locked && willBeAiLocked) {
                        const confirmed = confirm(
                            "⚠️ IRREVOCABLE TASK WARNING ⚠️\n\n" +
                            "Enabling AI Proof on this task is permanent.\n" +
                            "Once saved, this task cannot be un-checked, criteria cannot be changed, and it CANNOT be deleted without an Emergency Bypass.\n\n" +
                            "Do you want to permanently lock this task?"
                        );
                        if (!confirmed) return;
                    } else if (!task.strict_prerequisites && willBeStrict && !willBeAiLocked) {
                        const confirmed = confirm(
                            "⚠️ IRREVERSIBLE SHIELD ⚠️\n\n" +
                            "Enabling the Shield is permanent.\n" +
                            "Once saved, this task cannot be completed until ALL core subtasks are finished, and the Shield cannot be turned off.\n\n" +
                            "Proceed?"
                        );
                        if (!confirmed) return;
                    }

                    if (task.recurrence_series_id && task.ai_locked && pendingEditExemplarFile) {
                        alert('Replace recurring reference files through Recurrence & future criteria so the current requirements stay unchanged.'); return;
                    }
                    if (pendingEditExemplarFile && willBeAiLocked && window.ExemplarStore) {
                        try {
                            task.reference_inline_data=await TaskitatorEngine.AuditEngine.fileToBase64(pendingEditExemplarFile);
                            await window.ExemplarStore.saveExemplar(task.id, pendingEditExemplarFile);
                            pendingEditExemplarFile = null;
                        } catch (err) {
                            alert(`Failed to save reference exemplar: ${err.message}`);
                            return;
                        }
                    }

                    task.description = document.getElementById('editTaskDesc')?.value.trim() || '';
                    task.tags = Array.from(editModalSelectedTags);
                    task.priority_id = editModalSelectedPriority;
                    task.is_bonus = willBeBonus;

                    if (!task.parent_id) {
                        const oldProjectId = task.project_id;
                        task.project_id = editModalSelectedProject || 'inbox';
                        if (oldProjectId !== task.project_id) {
                            host.tasks.moveProject(task.id, task.project_id);
                        }
                    }

                    if (!task.ai_locked || isBypassActive) {
                        task.title = cleanTitle;
                        task.raw_title = rawEditedTitle;
                        task.due_date = document.getElementById('editTaskDueDate')?.value || '';
                        task.ai_locked = willBeAiLocked;
                        task.proof_criteria = willBeAiLocked ? finalEditedCriteria : '';
                        task.raw_proof_criteria = willBeAiLocked ? editedCriteriaRaw : '';
                    }
                    
                    task.strict_prerequisites = willBeStrict;
                    await window.TaskitatorRecurrenceUI?.applyEdit(task);

                    host.tasks.save();
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    
                    const customRender = taskDetailModal?._customRenderFn;
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;

                    if (typeof customRender === 'function') customRender();
                    else host.view.refresh();
                });
            }

            const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
            if (deleteFromDetailBtn) {
                deleteFromDetailBtn.addEventListener('click', () => {
                    if (!activeDetailTaskId) return;
                    const customRender = taskDetailModal?._customRenderFn;
                    host.tasks.remove(activeDetailTaskId, customRender);
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;
                });
            }

            const openChildAddModalBtn = document.getElementById('openChildAddModalBtn');
            if (openChildAddModalBtn) {
                openChildAddModalBtn.addEventListener('click', () => {
                    if (!activeDetailTaskId) return;
                    const parentTask = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;
                    openTaskCreationModal(parentTask.id, `Add Subtask to "${parentTask.title}"`);
                });
            }

            const auditModal = document.getElementById('auditModal');
            const closeAuditModalBtn = document.getElementById('closeAuditModalBtn');
            if (closeAuditModalBtn && auditModal) {
                closeAuditModalBtn.addEventListener('click', () => {
                    auditModal.classList.remove('open');
                    pendingAuditTaskId = null;
                });
            }

            // Dual-Evidence Audit Submission
            const submitProofBtn = document.getElementById('submitProofBtn');
            if (submitProofBtn) {
                submitProofBtn.addEventListener('click', async () => {
                    if (!pendingAuditTaskId) return;
                    const task = host.tasks.getAll().find(t => t.id === pendingAuditTaskId);
                    if (!task) return;

                    const auditSession = localStorage.getItem('taskitator_session_id');
                    const auditedId = task.id;
                    const fileList = Array.from(document.getElementById('auditImageInput')?.files || []);
                    const file = fileList[0];
                    if (!file) {
                        alert('Please attach an evidence photo or PDF document.');
                        return;
                    }

                    if (window.TaskitatorEngine?.AuditEngine?.validateFile) {
                        const check = TaskitatorEngine.AuditEngine.validateFile(file);
                        if (!check.valid) {
                            alert(check.error);
                            return;
                        }
                    }

                    submitProofBtn.disabled = true;
                    submitProofBtn.textContent = 'Verifying Evidence...';
                    const auditFeedback = document.getElementById('auditFeedbackContainer');
                    if (auditFeedback) auditFeedback.style.display = 'none';

                    const cachedApproval=pendingProofApprovals.get(auditedId);
                    let result = cachedApproval?.session===auditSession ? cachedApproval.result : { success: false, error: 'Audit engine missing' };
                    if (!result.job_id && window.TaskitatorEngine?.AuditEngine?.verifyProof) {
                        let refExemplarPart = task.reference_inline_data || TaskitatorRecurrenceUI.state().reference_files?.[task.reference_id] || null;
                        if (window.ExemplarStore) {
                            const exemplarRecord = await ExemplarStore.getExemplar(task.id);
                            if (exemplarRecord && exemplarRecord.inline_data) {
                                refExemplarPart = { inline_data: exemplarRecord.inline_data };
                            }
                        }

                        if (task.reference_id && !refExemplarPart) throw new Error('This task’s reference exemplar is missing on this device. Restore the reference file before submitting proof.');

                        result = await TaskitatorEngine.AuditEngine.verifyProof({
                            taskId: task.id,
                            file: file,
                            files: fileList,
                            taskTitle: task.title,
                            criteria: task.proof_criteria,
                            userContext: document.getElementById('auditContextInput')?.value.trim() || '',
                            exemplarPart: refExemplarPart
                        });
                    }

                    if (task.recurrence_series_id && (auditSession !== localStorage.getItem('taskitator_session_id') || pendingAuditTaskId !== auditedId || !host.tasks.getAll().some(t=>t.id===auditedId && t.status==='active'))) {
                        submitProofBtn.disabled=false;submitProofBtn.textContent='Submit Proof';return;
                    }
                    if (result.approved && TaskitatorRecurrence.subtree(host.tasks.getAll(),task.id).some(t=>t.id!==task.id && t.status==='active' && t.ai_locked)) {
                        result={success:false,error:'Submit proof for unfinished AI-audited children before completing this parent.'};
                    }
                    if(result.success && result.approved) {
                        pendingProofApprovals.set(auditedId,{session:auditSession,result});
                        try {
                            await window.TaskitatorPro.batchConfirm({jobId:result.job_id,taskIds:[auditedId],batch:false});
                            pendingProofApprovals.delete(auditedId);
                            host.tasks.reload();host.effects.auditSuccess();
                            if(auditModal)auditModal.classList.remove('open');
                            pendingAuditTaskId=null;host.view.refresh();
                        } catch(error){
                            if(['TASK_CHANGED','APPROVAL_EXPIRED','APPROVAL_INVALID'].includes(error.code))pendingProofApprovals.delete(auditedId);
                            submitProofBtn.disabled=false;submitProofBtn.textContent='Retry Confirmation';
                            if(auditFeedback){auditFeedback.style.display='block';auditFeedback.textContent=error.message;}
                        }
                    } else {
                        submitProofBtn.disabled=false;submitProofBtn.textContent='Retry Submission';
                        if (auditFeedback) {
                            auditFeedback.className = 'audit-critique-box';
                            auditFeedback.style.display = 'block';
                            const rawVerdict = (result.verdict || 'REJECTED').toLowerCase();
                            const verdictUpper = TaskitatorSafety.escapeHtml(rawVerdict === 'incomplete' ? 'INSUFFICIENT PROOF' : rawVerdict.toUpperCase());
                            const critiqueText = TaskitatorSafety.escapeHtml(result.error || result.critique || result.reason || 'Proof was not approved.');
                            let noticeHtml = '';
                            if (rawVerdict === 'incomplete') {
                                if (result.is_pro || result.discount_applied) {
                                    const costMsg = (result.credits_charged === 0) ? '0 tokens (FREE audit)' : (result.credits_charged != null ? result.credits_charged + ' tokens' : '50% discount applied');
                                    noticeHtml = `<div style="margin-top: 8px; font-size: 0.8rem; color: #34d399; font-weight: 600;">ℹ️ Insufficient proof: A 50% token discount was applied (${costMsg}).</div>`;
                                } else {
                                    noticeHtml = `<div style="margin-top: 8px; font-size: 0.8rem; color: #cbd5e1;">ℹ️ Insufficient proof: Free tier accounts do not receive the 50% discount on insufficient audits.</div>`;
                                }
                            } else if (!result.error) {
                                noticeHtml = `<div style="margin-top: 8px; font-size: 0.8rem; color: #fca5a5;">⚠️ Token notice: Usage was calculated and consumed for this audit. No refund issued.</div>`;
                            }
                            auditFeedback.innerHTML = `<strong>Verdict: ${verdictUpper}</strong><br>${critiqueText}${noticeHtml}`;
                        }
                    }
                });
            }

            // Validate Criteria (Pre-flight) Engine with >= 9/10 Saved Criteria Gate
            async function runCriteriaValidation(criteriaText, taskTitle, exemplarFile, feedbackEl, btnEl, isEditMode) {
                if (!criteriaText) {
                    if (feedbackEl) {
                        feedbackEl.style.display = 'block';
                        feedbackEl.className = 'criteria-feedback-box fail';
                        feedbackEl.textContent = 'Please enter proof criteria before validating.';
                    }
                    return;
                }

                const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(taskTitle);
                const { resolvedText, hasUnresolved, unresolvedKeys } = SmartCriteriaEngine.resolveCriteria(criteriaText, varMap);

                if (hasUnresolved) {
                    const missing = unresolvedKeys.length > 0 ? unresolvedKeys.join(', ') : 'unknown';
                    alert(`Criteria Error: Cannot validate criteria with unresolved template variables: {${TaskitatorSafety.escapeHtml(missing)}}.\nPlease define all variables in the task title (e.g. {${TaskitatorSafety.escapeHtml(missing)}==value}).`);
                    if (feedbackEl) {
                        feedbackEl.style.display = 'block';
                        feedbackEl.className = 'criteria-feedback-box fail';
                        feedbackEl.innerHTML = `<strong>Validation Blocked:</strong> Unresolved template variable(s): <code>{${TaskitatorSafety.escapeHtml(missing)}}</code>`;
                    }
                    return;
                }

                btnEl.disabled = true;
                btnEl.textContent = 'Validating...';
                if (feedbackEl) {
                    feedbackEl.style.display = 'block';
                    feedbackEl.className = 'criteria-feedback-box loading';
                    feedbackEl.textContent = 'Checking criteria…';
                }

                let res = { success: false, error: 'Audit engine missing' };
                if (window.TaskitatorEngine?.AuditEngine?.validateCriteria) {
                    res = await TaskitatorEngine.AuditEngine.validateCriteria(resolvedText, cleanTitle, exemplarFile);
                }

                btnEl.disabled = false;
                btnEl.textContent = '🔍 Validate Criteria';

                const stateTarget = isEditMode ? editCriteriaValidationState : criteriaValidationState;

                if (!res.success) {
                    if (feedbackEl) {
                        feedbackEl.className = 'criteria-feedback-box fail';
                        feedbackEl.innerHTML = `<strong>Audit Halted:</strong> ${TaskitatorSafety.escapeHtml(res.error || 'Failed to communicate with AI model.')}`;
                    }
                    stateTarget.validated = false;
                    stateTarget.score = 0;
                    stateTarget.isTemplate = false;
                    stateTarget.isSavedCriteria = false;
                    return;
                }

                stateTarget.validated = true;
                stateTarget.score = res.score;
                stateTarget.isTemplate = false;
                stateTarget.isSavedCriteria = false;

                if (feedbackEl) {
                    if (res.passed) {
                        feedbackEl.className = 'criteria-feedback-box pass';
                        let html = `<strong>✓ Verified (${TaskitatorSafety.escapeHtml(res.score)}/10)</strong>: ${TaskitatorSafety.escapeHtml(res.critique)}`;

                        // Strict Score >= 9 gate for saving criteria
                        if (res.score >= 9) {
                            html += `
                                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: space-between;">
                                    <span style="font-size: 0.75rem; color: #86efac; font-weight: 600;">Eligible to save (&ge; 9/10)</span>
                                    <button type="button" class="icon-btn save-as-criteria-btn" style="background: var(--primary); color: #fff; font-size: 0.75rem; padding: 4px 10px; font-weight: 700; border: none;">💾 Save Criteria</button>
                                </div>
                                <div class="save-criteria-inline-prompt" style="display: none; margin-top: 8px;">
                                    <input type="text" class="save-criteria-title-input" placeholder="Enter title for saved criteria..." value="${TaskitatorSafety.escapeHtml(cleanTitle || 'Verified Criteria')}" style="width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-color); font-size: 0.8rem; box-sizing: border-box; margin-bottom: 6px;">
                                    <div style="display: flex; justify-content: flex-end; gap: 6px;">
                                        <button type="button" class="icon-btn cancel-save-criteria-btn" style="font-size: 0.72rem; padding: 2px 6px;">Cancel</button>
                                        <button type="button" class="icon-btn confirm-save-criteria-btn" style="font-size: 0.72rem; padding: 2px 8px; background: var(--primary); color: #fff; border: none; font-weight: 600;">Confirm Save</button>
                                    </div>
                                    <div class="save-criteria-inline-error" style="color: #fca5a5; font-size: 0.75rem; margin-top: 4px; display: none;"></div>
                                </div>
                            `;
                        } else {
                            html += `
                                <div style="margin-top: 6px; font-size: 0.72rem; color: var(--text-muted);">
                                    ℹ️ Score must be 9/10 or higher to save to your personal Saved Criteria.
                                </div>
                            `;
                        }
                        feedbackEl.innerHTML = html;

                        const saveBtn = feedbackEl.querySelector('.save-as-criteria-btn');
                        const promptDiv = feedbackEl.querySelector('.save-criteria-inline-prompt');
                        const confirmBtn = feedbackEl.querySelector('.confirm-save-criteria-btn');
                        const cancelBtn = feedbackEl.querySelector('.cancel-save-criteria-btn');
                        const titleInput = feedbackEl.querySelector('.save-criteria-title-input');
                        const errDiv = feedbackEl.querySelector('.save-criteria-inline-error');

                        if (saveBtn && promptDiv) {
                            saveBtn.addEventListener('click', () => {
                                saveBtn.style.display = 'none';
                                promptDiv.style.display = 'block';
                                if (titleInput) titleInput.focus();
                            });
                        }

                        if (cancelBtn && promptDiv && saveBtn) {
                            cancelBtn.addEventListener('click', () => {
                                promptDiv.style.display = 'none';
                                saveBtn.style.display = 'inline-block';
                            });
                        }

                        if (confirmBtn && titleInput) {
                            confirmBtn.addEventListener('click', async () => {
                                const userTitle = titleInput.value.trim();
                                if (!userTitle) {
                                    if (errDiv) {
                                        errDiv.style.display = 'block';
                                        errDiv.textContent = 'Please enter a title.';
                                    }
                                    return;
                                }

                                const currentSaved = getSavedCriteria();
                                if (currentSaved.length >= MAX_SAVED_CRITERIA) {
                                    if (errDiv) {
                                        errDiv.style.display = 'block';
                                        errDiv.textContent = `Limit reached: Maximum ${MAX_SAVED_CRITERIA} saved criteria. Delete one first.`;
                                    }
                                    return;
                                }

                                if (exemplarFile) {
                                    if (exemplarFile.size > MAX_EXEMPLAR_SIZE_BYTES) {
                                        if (errDiv) {
                                            errDiv.style.display = 'block';
                                            errDiv.textContent = `Exemplar exceeds 4 MB limit (${(exemplarFile.size / (1024 * 1024)).toFixed(2)} MB).`;
                                        }
                                        return;
                                    }
                                    const withExCount = currentSaved.filter(c => c.has_exemplar).length;
                                    if (withExCount >= MAX_EXEMPLARS) {
                                        if (errDiv) {
                                            errDiv.style.display = 'block';
                                            errDiv.textContent = `Exemplar limit reached: Maximum ${MAX_EXEMPLARS} saved criteria can have attached files.`;
                                        }
                                        return;
                                    }
                                }

                                confirmBtn.disabled = true;
                                confirmBtn.textContent = 'Saving...';

                                let exemplarPayload = null;
                                if (exemplarFile) {
                                    exemplarPayload = await fileToBase64Payload(exemplarFile);
                                }

                                const newSavedItem = {
                                    id: 'sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                                    title: userTitle.slice(0, 40),
                                    criteria: criteriaText,
                                    score: res.score,
                                    has_exemplar: Boolean(exemplarPayload),
                                    exemplar: exemplarPayload,
                                    created_at: new Date().toISOString()
                                };

                                currentSaved.push(newSavedItem);
                                saveSavedCriteriaList(currentSaved);

                                promptDiv.innerHTML = `<span style="font-size: 0.78rem; color: #86efac; font-weight: 700;">✓ Saved to "Saved Criteria" tab!</span>`;
                            });
                        }
                    } else {
                        feedbackEl.className = 'criteria-feedback-box fail';
                        let feedbackHtml = `<strong>⚠️ Low Quality Rating (${TaskitatorSafety.escapeHtml(res.score)}/10)</strong>: ${TaskitatorSafety.escapeHtml(res.critique)}`;
                        if (res.suggested_rewrite) {
                            feedbackHtml += `
                                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.2);">
                                    <strong>Suggested Artifact:</strong> "${TaskitatorSafety.escapeHtml(res.suggested_rewrite)}"
                                    <div style="margin-top: 6px;">
                                        <button type="button" class="icon-btn apply-suggestion-btn" style="padding: 3px 8px; font-size: 0.75rem; background: var(--card-subtle);">Use Suggestion</button>
                                    </div>
                                </div>
                            `;
                        }
                        feedbackEl.innerHTML = feedbackHtml;

                        const applyBtn = feedbackEl.querySelector('.apply-suggestion-btn');
                        if (applyBtn) {
                            applyBtn.addEventListener('click', () => {
                                const inputEl = isEditMode 
                                    ? document.getElementById('editTaskCriteria') 
                                    : document.getElementById('taskCriteriaInput');
                                if (inputEl) inputEl.value = res.suggested_rewrite;
                                stateTarget.validated = true;
                                stateTarget.score = 9;
                                stateTarget.isTemplate = true;
                                stateTarget.isSavedCriteria = false;
                                feedbackEl.className = 'criteria-feedback-box pass';
                                feedbackEl.innerHTML = `<strong>✓ Verified (9/10)</strong>: Suggestion applied.`;
                            });
                        }
                    }
                }
            }

            // Creation Validation Button
            const validateCriteriaBtn = document.getElementById('validateCriteriaBtn');
            if (validateCriteriaBtn) {
                validateCriteriaBtn.addEventListener('click', async () => {
                    const criteriaText = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                    const rawTitle = NLPEngine.extractCleanTitle('taskTitleInput') || '';
                    const feedback = document.getElementById('criteriaFeedbackBox');
                    const exemplarInput = document.getElementById('createExemplarInput');
                    const exemplarFile = (exemplarInput && (exemplarInput._savedCriteriaFile || (exemplarInput.files.length > 0 ? exemplarInput.files[0] : null)));

                    await runCriteriaValidation(criteriaText, rawTitle, exemplarFile, feedback, validateCriteriaBtn, false);
                });
            }

            // Edit Modal Validation Button
            const editValidateCriteriaBtn = document.getElementById('editValidateCriteriaBtn');
            if (editValidateCriteriaBtn) {
                editValidateCriteriaBtn.addEventListener('click', async () => {
                    const criteriaText = document.getElementById('editTaskCriteria')?.value.trim() || '';
                    const rawTitle = NLPEngine.extractCleanTitle('editTaskTitle') || '';
                    const feedback = document.getElementById('editCriteriaFeedbackBox');
                    
                    let exemplarFile = pendingEditExemplarFile;
                    if (!exemplarFile && activeDetailTaskId && window.ExemplarStore) {
                        const record = await window.ExemplarStore.getExemplar(activeDetailTaskId);
                        if (record && record.blob) exemplarFile = record.blob;
                    }

                    await runCriteriaValidation(criteriaText, rawTitle, exemplarFile, feedback, editValidateCriteriaBtn, true);
                });
            }

            // Template & Saved Criteria Picker Modal
            const templatesModal = document.getElementById('templatesModal');
            const closeTemplatesModalBtn = document.getElementById('closeTemplatesModalBtn');
            const openTemplatesBtn = document.getElementById('openTemplatesBtn');
            const editOpenTemplatesBtn = document.getElementById('editOpenTemplatesBtn');
            const tabTemplatesBtn = document.getElementById('tabTemplatesBtn');
            const tabSavedCriteriaBtn = document.getElementById('tabSavedCriteriaBtn');
            const paneTemplates = document.getElementById('paneTemplates');
            const paneSavedCriteria = document.getElementById('paneSavedCriteria');

            function switchTemplatesModalTab(targetTab) {
                currentTemplatesTab = targetTab;
                if (targetTab === 'saved') {
                    if (tabTemplatesBtn) tabTemplatesBtn.classList.remove('active');
                    if (tabSavedCriteriaBtn) tabSavedCriteriaBtn.classList.add('active');
                    if (paneTemplates) paneTemplates.classList.remove('active');
                    if (paneSavedCriteria) paneSavedCriteria.classList.add('active');
                    renderSavedCriteriaList();
                } else {
                    if (tabTemplatesBtn) tabTemplatesBtn.classList.add('active');
                    if (tabSavedCriteriaBtn) tabSavedCriteriaBtn.classList.remove('active');
                    if (paneTemplates) paneTemplates.classList.add('active');
                    if (paneSavedCriteria) paneSavedCriteria.classList.remove('active');
                }
            }

            if (tabTemplatesBtn) {
                tabTemplatesBtn.addEventListener('click', () => switchTemplatesModalTab('templates'));
            }
            if (tabSavedCriteriaBtn) {
                tabSavedCriteriaBtn.addEventListener('click', () => switchTemplatesModalTab('saved'));
            }

            function renderSavedCriteriaList() {
                const container = document.getElementById('savedCriteriaListContainer');
                if (!container) return;
                container.innerHTML = '';
                const savedList = getSavedCriteria();
                updateSavedCriteriaBadge();

                if (savedList.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 24px 0;">
                            No saved criteria yet.<br>
                            Validate criteria with a score of <strong>9/10 or higher</strong> to save your own reusable versions.
                        </div>
                    `;
                    return;
                }

                savedList.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'template-picker-card';
                    card.style.cssText = 'position: relative; padding: 12px 14px; border: 1.5px solid var(--border-color); border-radius: 8px; margin-bottom: 8px; cursor: pointer; background: var(--card-subtle);';

                    let exemplarBadge = '';
                    if (item.has_exemplar) {
                        exemplarBadge = `<span class="tag-chip" style="background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 0.7rem;">📎 Exemplar Attached</span>`;
                    }

                    card.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <strong style="color: var(--text-color); font-size: 0.9rem;">${TaskitatorSafety.escapeHtml(item.title)}</strong>
                                <span class="tag-chip" style="font-size: 0.7rem; background: #052e16; color: #86efac;">${TaskitatorSafety.escapeHtml(item.score)}/10</span>
                                ${exemplarBadge}
                            </div>
                            <button type="button" class="action-del-btn delete-saved-crit-btn" title="Delete Saved Criteria" style="font-size: 0.85rem; padding: 2px 6px;">✕</button>
                        </div>
                        <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted); line-height: 1.4; white-space: pre-wrap;">${TaskitatorSafety.escapeHtml(item.criteria)}</p>
                    `;

                    const delBtn = card.querySelector('.delete-saved-crit-btn');
                    if (delBtn) {
                        delBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const updated = getSavedCriteria().filter(c => c.id !== item.id);
                            saveSavedCriteriaList(updated);
                            renderSavedCriteriaList();
                        });
                    }

                    card.addEventListener('click', () => {
                        applySavedCriteria(item);
                    });

                    container.appendChild(card);
                });
            }

            function applySavedCriteria(savedItem) {
                const isEdit = activeTemplateTarget === 'edit';
                const inputEl = isEdit ? document.getElementById('editTaskCriteria') : document.getElementById('taskCriteriaInput');
                const feedbackEl = isEdit ? document.getElementById('editCriteriaFeedbackBox') : document.getElementById('criteriaFeedbackBox');
                const stateTarget = isEdit ? editCriteriaValidationState : criteriaValidationState;

                if (inputEl) {
                    inputEl.value = savedItem.criteria;
                }

                if (savedItem.has_exemplar && savedItem.exemplar) {
                    const restoredFile = base64PayloadToFile(savedItem.exemplar);
                    if (restoredFile) {
                        if (isEdit) {
                            pendingEditExemplarFile = restoredFile;
                            const chip = document.getElementById('editExemplarChip');
                            const nameEl = document.getElementById('editExemplarName');
                            const sizeEl = document.getElementById('editExemplarSize');
                            if (nameEl) nameEl.textContent = restoredFile.name;
                            if (sizeEl) sizeEl.textContent = (restoredFile.size / (1024 * 1024)).toFixed(2) + ' MB';
                            if (chip) chip.style.display = 'flex';
                        } else {
                            const chip = document.getElementById('createExemplarChip');
                            const nameEl = document.getElementById('createExemplarName');
                            const sizeEl = document.getElementById('createExemplarSize');
                            const noteEl = document.getElementById('exemplarGuidanceNote');
                            if (nameEl) nameEl.textContent = restoredFile.name;
                            if (sizeEl) sizeEl.textContent = (restoredFile.size / (1024 * 1024)).toFixed(2) + ' MB';
                            if (chip) chip.style.display = 'flex';
                            if (noteEl) noteEl.style.display = 'block';

                            const input = document.getElementById('createExemplarInput');
                            if (input) {
                                input._savedCriteriaFile = restoredFile;
                            }
                        }
                    }
                }

                stateTarget.validated = true;
                stateTarget.score = savedItem.score || 10;
                stateTarget.isTemplate = false;
                stateTarget.isSavedCriteria = true;
                stateTarget.savedCriteriaText = savedItem.criteria;

                if (feedbackEl) {
                    feedbackEl.style.display = 'block';
                    feedbackEl.className = 'criteria-feedback-box pass';
                    feedbackEl.innerHTML = `<strong>✓ Applied Saved Criteria (${TaskitatorSafety.escapeHtml(stateTarget.score)}/10)</strong>: "${TaskitatorSafety.escapeHtml(savedItem.title)}"<br><small style="color:var(--text-muted);">Modifying this criteria will automatically drop its verification.</small>`;
                }

                if (templatesModal) templatesModal.classList.remove('open');
            }

            async function openTemplatesPicker(targetMode) {
                activeTemplateTarget = targetMode;
                switchTemplatesModalTab('templates');
                updateSavedCriteriaBadge();

                if (!cachedTemplates) {
                    try {
                        const resp = await fetch('./CRITERIA_TEMPLATES.json');
                        if (resp.ok) cachedTemplates = await resp.json();
                    } catch (e) {}
                }
                const container = document.getElementById('templatesListContainer');
                if (container) {
                    container.innerHTML = '';
                    const list = cachedTemplates || [];
                    if (list.length === 0) {
                        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">No templates available.</div>';
                    } else {
                        list.forEach(t => {
                            const card = document.createElement('div');
                            card.className = 'template-picker-card';
                            card.innerHTML = `
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                    <strong style="color: var(--text-color); font-size: 0.88rem;">${TaskitatorSafety.escapeHtml(t.label)}</strong>
                                    <span class="tag-chip" style="font-size: 0.7rem;">${TaskitatorSafety.escapeHtml(t.category)}</span>
                                </div>
                                <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted); line-height: 1.35;">${TaskitatorSafety.escapeHtml(t.template)}</p>
                            `;
                            card.addEventListener('click', () => {
                                if (activeTemplateTarget === 'edit') {
                                    const tIn = document.getElementById('editTaskCriteria');
                                    if (tIn) tIn.value = t.template;
                                    editCriteriaValidationState = { validated: true, score: 10, isTemplate: true, isSavedCriteria: false, savedCriteriaText: '' };
                                    const fb = document.getElementById('editCriteriaFeedbackBox');
                                    if (fb) {
                                        fb.style.display = 'block';
                                        fb.className = 'criteria-feedback-box pass';
                                        fb.innerHTML = `<strong>✓ Verified (10/10)</strong>: Standard verified artifact template selected.`;
                                    }
                                } else {
                                    const tIn = document.getElementById('taskCriteriaInput');
                                    if (tIn) tIn.value = t.template;
                                    criteriaValidationState = { validated: true, score: 10, isTemplate: true, isSavedCriteria: false, savedCriteriaText: '' };
                                    const fb = document.getElementById('criteriaFeedbackBox');
                                    if (fb) {
                                        fb.style.display = 'block';
                                        fb.className = 'criteria-feedback-box pass';
                                        fb.innerHTML = `<strong>✓ Verified (10/10)</strong>: Standard verified artifact template selected.`;
                                    }
                                }
                                templatesModal.classList.remove('open');
                            });
                            container.appendChild(card);
                        });
                    }
                }
                templatesModal.classList.add('open');
            }

            if (openTemplatesBtn) {
                openTemplatesBtn.addEventListener('click', () => openTemplatesPicker('create'));
            }
            if (editOpenTemplatesBtn) {
                editOpenTemplatesBtn.addEventListener('click', () => openTemplatesPicker('edit'));
            }
            if (closeTemplatesModalBtn && templatesModal) {
                closeTemplatesModalBtn.addEventListener('click', () => {
                    templatesModal.classList.remove('open');
                });
            }

        }

        return Object.freeze({
            apiVersion: 1,
            init,
            openCreate: openTaskCreationModal,
            openDetail: openTaskDetailModal,
            openAudit: openAuditModal,
            renderTags: renderModalTagCloud,
            isEditing: () => activeDetailTaskId !== null
        });
    }
});

// <<< MODULE_END: components.js >>>

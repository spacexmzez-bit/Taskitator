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

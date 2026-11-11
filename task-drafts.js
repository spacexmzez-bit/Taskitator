// File: task-drafts.js
// Task drafts: unfinished task forms parked in the synced settings object (no task is created, nothing is locked,
// no AI is used). Each draft is its own settings key so drafts from different devices never conflict.
//   task_draft:<id>       a new task that has not been published yet
//   edit_draft:<taskId>   unsaved edits for an existing task (the live task is unchanged until Save Changes)
//   study_draft:<id>      an unfinished study plan: a new plan (create) or unsaved edits of one plan (edit). Shown only
//                         in the Drafts tab of the Study plans page, never in the normal drafts list.
(function (root) {
    'use strict';
    const SETTINGS_KEY = 'taskitator_settings';
    const CREATE_PREFIX = 'task_draft:';
    const EDIT_PREFIX = 'edit_draft:';
    const MAX_CREATE_DRAFTS = 50;
    const MAX_SUBTASKS = 100;
    const STUDY_PREFIX = 'study_draft:';
    const MAX_STUDY_DRAFTS = 10;
    const text = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
    const list = (v, n, m) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, m).map(x => x.slice(0, n)) : [];
    const flag = v => v === true;

    function readSettings() {
        try {
            const value = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) { return {}; }
    }
    function writeSettings(settings) {
        root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        try { root.dispatchEvent?.(new root.CustomEvent('taskitator-settings-changed')); } catch (_) {}
        try { root.dispatchEvent?.(new root.CustomEvent('taskitator-drafts-changed')); } catch (_) {}
        const engine = root.SyncEngine;
        if (engine && typeof engine.markLocalModified === 'function') {
            engine.markLocalModified();
            if (typeof engine.scheduleAutoPush === 'function') engine.scheduleAutoPush();
        }
    }

    // Only known fields are kept, with bounded sizes, so a draft can never inject unexpected data into the snapshot.
    function cleanCreate(input) {
        const d = input && typeof input === 'object' ? input : {};
        return {
            title: text(d.title, 500), description: text(d.description, 5000), due_date: text(d.due_date, 10),
            parent_id: text(d.parent_id, 100) || null, project_id: text(d.project_id, 100) || 'inbox',
            priority_id: text(d.priority_id, 100) || null, tags: list(d.tags, 50, 50),
            is_bonus: flag(d.is_bonus), strict_prerequisites: flag(d.strict_prerequisites),
            ai_locked: flag(d.ai_locked), criteria: text(d.criteria, 5000),
            dynamic_priority_target: text(d.dynamic_priority_target, 100) || null,
            mrstudy_rule_id: text(d.mrstudy_rule_id, 100), mrstudy_xp: text(d.mrstudy_xp, 12), mrstudy_banch: text(d.mrstudy_banch, 12),
            subtasks: list(d.subtasks, 500, MAX_SUBTASKS)
        };
    }
    function cleanEdit(input) {
        const d = input && typeof input === 'object' ? input : {};
        return {
            title: text(d.title, 500), description: text(d.description, 5000), due_date: text(d.due_date, 10),
            parent_id: text(d.parent_id, 100), project_id: text(d.project_id, 100) || 'inbox',
            priority_id: text(d.priority_id, 100) || null, tags: list(d.tags, 50, 50),
            is_bonus: flag(d.is_bonus), strict_prerequisites: flag(d.strict_prerequisites),
            criteria: text(d.criteria, 5000), dynamic_priority_target: text(d.dynamic_priority_target, 100) || null
        };
    }

    function listCreate() {
        const s = readSettings();
        return Object.keys(s).filter(k => k.startsWith(CREATE_PREFIX) && s[k] && typeof s[k] === 'object')
            .map(k => ({ id: k.slice(CREATE_PREFIX.length), saved_at: Number(s[k].saved_at) || 0, ...cleanCreate(s[k].fields) }))
            .sort((a, b) => b.saved_at - a.saved_at);
    }
    function getCreate(id) { return listCreate().find(d => d.id === id) || null; }
    function saveCreate(fields, id) {
        const clean = cleanCreate(fields);
        if (!clean.title.trim()) throw new Error('Enter a title before saving a draft.');
        const s = readSettings();
        const draftId = id || 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        if (!(CREATE_PREFIX + draftId in s) && Object.keys(s).filter(k => k.startsWith(CREATE_PREFIX)).length >= MAX_CREATE_DRAFTS)
            throw new Error('You have ' + MAX_CREATE_DRAFTS + ' drafts. Delete one before saving another.');
        s[CREATE_PREFIX + draftId] = { saved_at: Date.now(), fields: clean };
        writeSettings(s);
        return draftId;
    }
    function removeCreate(id) {
        const s = readSettings();
        if (!(CREATE_PREFIX + id in s)) return false;
        delete s[CREATE_PREFIX + id];
        writeSettings(s);
        return true;
    }

    function getEdit(taskId) {
        const entry = readSettings()[EDIT_PREFIX + taskId];
        return entry && typeof entry === 'object' ? { saved_at: Number(entry.saved_at) || 0, ...cleanEdit(entry.fields) } : null;
    }
    function saveEdit(taskId, fields) {
        if (!taskId) throw new Error('Missing task.');
        const s = readSettings();
        s[EDIT_PREFIX + taskId] = { saved_at: Date.now(), fields: cleanEdit(fields) };
        writeSettings(s);
    }
    function removeEdit(taskId) {
        const s = readSettings();
        if (!(EDIT_PREFIX + taskId in s)) return false;
        delete s[EDIT_PREFIX + taskId];
        writeSettings(s);
        return true;
    }
    // Edit drafts of tasks that no longer exist are dropped the next time the list is opened.
    function pruneEdits(existingTaskIds) {
        const ids = new Set(existingTaskIds);
        const s = readSettings();
        let changed = false;
        for (const key of Object.keys(s)) {
            if (key.startsWith(EDIT_PREFIX) && !ids.has(key.slice(EDIT_PREFIX.length))) { delete s[key]; changed = true; }
        }
        if (changed) writeSettings(s);
        return changed;
    }
    function listEdits() {
        const s = readSettings();
        return Object.keys(s).filter(k => k.startsWith(EDIT_PREFIX))
            .map(k => ({ task_id: k.slice(EDIT_PREFIX.length), ...getEdit(k.slice(EDIT_PREFIX.length)) }))
            .sort((a, b) => b.saved_at - a.saved_at);
    }
    const count = () => listCreate().length + listEdits().length;

    // ---- study plan drafts ----
    const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi ? v : null;
    function cleanSchedule(input) {
        const d = input && typeof input === 'object' ? input : {};
        const rates = {};
        for (const [k, v] of Object.entries(d.rates && typeof d.rates === 'object' ? d.rates : {})) if (/^[0-6]$/.test(k) && int(Number(v), 1, 1000) !== null) rates[k] = Number(v);
        const sched = Array.isArray(d.sched) ? d.sched.slice(0, 366).filter(x => x && date(x.date) && int(x.count, 1, 1000) !== null).map(x => ({ date: x.date, count: x.count })) : null;
        const key = Array.isArray(d.units_key) && d.units_key.length === 4 && d.units_key.every(v => v === null || Number.isSafeInteger(v)) ? d.units_key.slice() : null;
        return {
            start: date(d.start), mode: d.mode === 'per' ? 'per' : 'cal', days: text(String(d.days ?? ''), 6), per: text(String(d.per ?? ''), 6), rates,
            weekdays: Array.isArray(d.weekdays) ? [...new Set(d.weekdays.filter(n => int(n, 0, 6) !== null))].sort() : [],
            startUnit: text(String(d.startUnit ?? ''), 6), skipText: text(d.skipText, 500), previewed: flag(d.previewed),
            sched: sched && sched.length && key ? sched : null, units_key: sched && sched.length && key ? key : null,
            edited: Array.isArray(d.edited) ? d.edited.filter(date).slice(0, 366) : []
        };
    }
    function cleanStudy(input) {
        const d = input && typeof input === 'object' ? input : {};
        const kind = d.kind === 'edit' ? 'edit' : 'create';
        const info = d.info && typeof d.info === 'object' ? d.info : {}, ai = d.ai && typeof d.ai === 'object' ? d.ai : {};
        return {
            kind, plan_id: kind === 'edit' ? text(d.plan_id, 160) : '', title: text(d.title, 160),
            info: { title: text(info.title, 160), unit: text(info.unit, 40), total: text(String(info.total ?? ''), 6), parent: text(info.parent, 100), unitP: text(info.unitP, 100), description: text(info.description, 5000) },
            ai: { enabled: flag(ai.enabled), criteria: text(ai.criteria, 4000), exclude: text(ai.exclude, 500) },
            schedule: cleanSchedule(d.schedule)
        };
    }
    function listStudy() {
        const s = readSettings();
        return Object.keys(s).filter(k => k.startsWith(STUDY_PREFIX) && s[k] && typeof s[k] === 'object')
            .map(k => ({ id: k.slice(STUDY_PREFIX.length), saved_at: Number(s[k].saved_at) || 0, ...cleanStudy(s[k].fields) }))
            .sort((a, b) => b.saved_at - a.saved_at);
    }
    function getStudy(id) { return listStudy().find(d => d.id === id) || null; }
    // Edits of one plan share one draft (saving again replaces it); every new plan gets its own.
    function saveStudy(fields, id) {
        const clean = cleanStudy(fields);
        if (clean.kind === 'edit' && !clean.plan_id) throw new Error('Missing study plan.');
        const s = readSettings();
        const draftId = clean.kind === 'edit' ? 'edit_' + clean.plan_id : (id || 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
        if (!(STUDY_PREFIX + draftId in s) && Object.keys(s).filter(k => k.startsWith(STUDY_PREFIX)).length >= MAX_STUDY_DRAFTS)
            throw new Error('You have ' + MAX_STUDY_DRAFTS + ' study plan drafts. Delete one before saving another.');
        s[STUDY_PREFIX + draftId] = { saved_at: Date.now(), fields: clean };
        writeSettings(s);
        return draftId;
    }
    function removeStudy(id) {
        const s = readSettings();
        if (!(STUDY_PREFIX + id in s)) return false;
        delete s[STUDY_PREFIX + id];
        writeSettings(s);
        return true;
    }

    root.TaskitatorDrafts = { listCreate, getCreate, saveCreate, removeCreate, getEdit, saveEdit, removeEdit, listEdits, pruneEdits, count, cleanCreate, cleanEdit, MAX_CREATE_DRAFTS,
        listStudy, getStudy, saveStudy, removeStudy, cleanStudy, MAX_STUDY_DRAFTS };
})(typeof window !== 'undefined' ? window : globalThis);

// Stats view (moved out of components.html in Phase 3.0; runs inside the index.html shell).
// <<< MODULE_START: stats.html >>>
(() => {
const TASKS_KEY = 'taskitator_tasks';
const PROJECTS_KEY = 'taskitator_projects';
const BREAKS_KEY = 'taskitator_daily_breaks';
const ARCHIVED_NOTES_KEY = 'taskitator_archived_notes';

function getArchivedNotes() {
    try {
        return JSON.parse(localStorage.getItem(ARCHIVED_NOTES_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function saveArchivedNotes(notes) {
    localStorage.setItem(ARCHIVED_NOTES_KEY, JSON.stringify(notes));
    renderArchiveList();
}

function renderArchiveList() {
    const container = document.getElementById('archiveNotesListContainer');
    const clearBtn = document.getElementById('clearAllArchiveBtn');
    if (!container) return;

    const archive = getArchivedNotes();
    container.innerHTML = '';

    if (archive.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 20px 0;">
                No archived notes found. Extracted notes will appear here.
            </div>
        `;
        if (clearBtn) clearBtn.style.display = 'none';
        return;
    }

    if (clearBtn) clearBtn.style.display = 'inline-flex';

    // Show newest first
    const sorted = [...archive].reverse();

    sorted.forEach((note) => {
        const card = document.createElement('div');
        card.className = 'archive-item-card';

        const dateStr = note.archived_at ? (window.TaskitatorI18n?.date(note.archived_at) ?? new Date(note.archived_at).toLocaleDateString()) : '';

        card.innerHTML = `
            <div class="archive-item-header">
                <span class="archive-item-title">${TaskitatorSafety.escapeHtml(note.title || 'Untitled Note')}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="archive-item-meta">${dateStr}</span>
                    <button type="button" class="icon-btn del-archive-note" data-id="${TaskitatorSafety.escapeHtml(note.id)}" style="color: var(--danger); border-color: rgba(239,68,68,0.3); padding: 2px 6px; font-size: 0.72rem;">✕</button>
                </div>
            </div>
            <div class="archive-item-body">${TaskitatorSafety.escapeHtml(note.clean_text || note.text || '')}</div>
            ${note.original_text && note.original_text !== note.clean_text ? `
                <details class="archive-raw-details">
                    <summary>View raw original</summary>
                    <div style="padding-top: 4px; white-space: pre-wrap;">${TaskitatorSafety.escapeHtml(note.original_text)}</div>
                </details>
            ` : ''}
        `;

        card.querySelector('.del-archive-note').addEventListener('click', (e) => {
            const noteId = e.currentTarget.getAttribute('data-id');
            const current = getArchivedNotes();
            const updated = current.filter(n => n.id !== noteId);
            saveArchivedNotes(updated);
        });

        container.appendChild(card);
    });
}

function isPrivateWorkspaceAllowed() {
    if (/[?&]view=(?:legal|compare|privacy|terms)(?:&|$)/i.test(window.location?.search || '')) return false;
    if (typeof window.TaskitatorAuth !== 'undefined') {
        return Boolean(window.TaskitatorAuth?.signedIn && localStorage.getItem('taskitator_local_owner') === window.TaskitatorAuth?.account?.user);
    }
    return true;
}

// Logical day: the same rule as Today, Points and recurrence (Riyadh time, shifted by
// Settings → day start hour). The old code used the UTC date, and a single malformed
// value (bad history entry, numeric or missing timestamp, a break that can't be timed)
// threw before anything was drawn, leaving every number at its HTML default of 0.
const DAY_MS = 86400000;
function statsDayHour() {
    try {
        const h = Number.parseInt(JSON.parse(localStorage.getItem('taskitator_settings') || '{}')?.day_start_hour, 10);
        return Number.isInteger(h) && h >= 0 && h <= 4 ? h : 0;
    } catch (_) { return 0; }
}
function statsDay(ms, hour) {
    const R = window.TaskitatorRecurrence;
    return R?.today ? R.today(ms, hour) : new Date(ms + (3 - hour) * 3600000).toISOString().slice(0, 10);
}
function statsStamp(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    return typeof value === 'string' && value ? Date.parse(value) : NaN;
}
const statsShift = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
function statsPart(name, run) {
    try { run(); } catch (err) { console.error('Taskitator stats: ' + name + ' could not be drawn', err); }
}
function statsSet(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; return el; }
function statsRead(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : []; }
    catch (_) { return []; }
}

function renderStats() {
    if (!isPrivateWorkspaceAllowed()) return;
    const tasks = statsRead(TASKS_KEY);
    const projects = statsRead(PROJECTS_KEY);

    // Finished recurring occurrences and deleted study plans live in the recurrence history.
    statsPart('history', () => {
        const ui = typeof TaskitatorRecurrenceUI !== 'undefined' ? TaskitatorRecurrenceUI : window.TaskitatorRecurrenceUI;
        const history = ui?.state?.()?.history;
        if (!Array.isArray(history)) return;
        for (const event of history) {
            if (event?.outcome !== 'completed' || !Array.isArray(event.tasks)) continue;
            event.tasks.forEach((t, i) => {
                if (t?.status === 'completed') tasks.push({ ...t, id: event.id + ':' + i, status: 'completed', due_date: event.due_date, completed_at: t.completed_at || event.ended_at });
            });
        }
    });

    if (!projects.some(p => p.id === 'inbox')) {
        projects.unshift({ id: 'inbox', name: 'Inbox', color: '#94a3b8', icon: '' });
    }

    const hour = statsDayHour();
    const todayStr = statsDay(Date.now(), hour);
    const doneDay = t => { const ms = statsStamp(t.completed_at); return Number.isFinite(ms) ? statsDay(ms, hour) : ''; };

    const completedTasks = tasks.filter(t => t.status === 'completed');
    const activeTasks = tasks.filter(t => t.status === 'active');
    const aiVerifiedCount = completedTasks.filter(t => t.ai_locked).length;
    const standardDoneCount = completedTasks.length - aiVerifiedCount;
    const totalCompleted = Math.max(1, completedTasks.length);

    // 1. Key metrics
    statsPart('metrics', () => {
        const completedToday = completedTasks.filter(t => doneDay(t) === todayStr).length;
        const pendingToday = activeTasks.filter(t => {
            const due = String(t.due_date || '').trim().toLowerCase();
            return due === 'today' || due === todayStr;
        }).length;
        const rigorRatio = completedTasks.length > 0 ? Math.round((aiVerifiedCount / completedTasks.length) * 100) : 0;
        statsSet('statCompletedToday', completedToday);
        statsSet('statPendingToday', pendingToday);
        statsSet('statAiRigor', `${rigorRatio}%`);
        statsSet('statTotalActive', activeTasks.length);
    });

    // 2. 7-day completion velocity (logical days)
    statsPart('velocity', () => {
        const velocityContainer = document.getElementById('velocityBarsContainer');
        if (!velocityContainer) return;
        velocityContainer.innerHTML = '';
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const perDay = new Map();
        for (const t of completedTasks) { const d = doneDay(t); if (d) perDay.set(d, (perDay.get(d) || 0) + 1); }
        const dayCounts = [];
        for (let i = 6; i >= 0; i--) {
            const iso = statsShift(todayStr, -i);
            dayCounts.push({ label: i === 0 ? 'Today' : dayNames[new Date(iso + 'T00:00:00Z').getUTCDay()], count: perDay.get(iso) || 0, isToday: i === 0 });
        }
        const maxDayCount = Math.max(1, ...dayCounts.map(d => d.count));
        dayCounts.forEach(item => {
            const col = document.createElement('div');
            col.className = 'velocity-col';
            const heightPct = Math.max(8, Math.round((item.count / maxDayCount) * 100));
            col.innerHTML = `
            <span class="velocity-val">${item.count}</span>
            <div class="velocity-bar-track">
                <div class="velocity-bar ${item.isToday ? 'active-day' : ''}" style="height: ${heightPct}%;"></div>
            </div>
            <span class="velocity-label" style="${item.isToday ? 'color:var(--primary);font-weight:700;' : ''}">${item.label}</span>
        `;
            velocityContainer.appendChild(col);
        });
    });

    // 3. Project allocation
    statsPart('projects', () => {
        const projectAllocationList = document.getElementById('projectAllocationList');
        if (!projectAllocationList) return;
        projectAllocationList.innerHTML = '';
        const projectCounts = new Map();
        projects.forEach(p => projectCounts.set(p.id, 0));
        completedTasks.forEach(t => {
            const pId = projectCounts.has(t.project_id) ? t.project_id : 'inbox';
            projectCounts.set(pId, (projectCounts.get(pId) || 0) + 1);
        });
        let renderedProjectsCount = 0;
        projects.forEach(p => {
            const count = projectCounts.get(p.id) || 0;
            if (count === 0 && completedTasks.length > 0) return;
            renderedProjectsCount++;
            const pct = Math.round((count / totalCompleted) * 100);
            const row = document.createElement('div');
            row.className = 'bar-container';
            row.innerHTML = `
            <span class="bar-label"></span>
            <div class="bar-outer">
                <div class="bar-fill" style="width: ${pct}%; background: ${TaskitatorSafety.escapeHtml(TaskitatorSafety.cssColor(p.color))};"></div>
            </div>
            <span class="bar-count">${count}</span>
        `;
            const label = row.querySelector('.bar-label');
            label.title = p.name || '';
            TaskitatorSafety.setProjectLabel(label, p);
            projectAllocationList.appendChild(row);
        });
        if (renderedProjectsCount === 0) {
            projectAllocationList.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding: 12px 0;">No completed tasks yet.</div>`;
        }
    });

    // 4. Breaks: the Worker's answer for today (Scheduled or Flexible) when known; else the saved record.
    statsPart('breaks', () => {
        const engine = (typeof TaskitatorEngine !== 'undefined' ? TaskitatorEngine : window.TaskitatorEngine)?.BreakEngine;
        const view = engine?.current?.() || null;
        let system = view?.system || null, count = 0, minutes = 0;
        if (view) {
            count = Array.isArray(view.scheduled?.breaks) ? view.scheduled.breaks.length : 0;
            const a = view.allowance || {};
            minutes = Number(system === 'flexible' ? a.used : a.reserved) || 0;
        } else if (engine?.getTodayBreaks) {
            const list = engine.getTodayBreaks() || [];
            const bounds = engine.getLogicalDayBounds();
            count = list.length;
            for (const b of list) {
                try {
                    const { startTime, endTime } = engine.getBreakTimestamps(b, bounds);
                    if (Number.isFinite(startTime) && endTime > startTime) minutes += (endTime - startTime) / 60000;
                } catch (_) { /* a break that can't be timed adds nothing */ }
            }
        }
        if (!system && count) system = 'scheduled';
        statsSet('breakSlotsCount', system === 'flexible' ? 'Flexible breaks' : `${count} break window${count === 1 ? '' : 's'} configured`);
        statsSet('totalBreakTime', `${Math.round(minutes)}m`);
        statsSet('breakWindowDetails', system === 'flexible' ? 'Flexible' : system === 'scheduled' ? 'Scheduled' : 'None Set');
        const status = statsSet('breakAdherenceStatus', !system ? 'None Set' : view?.scheduled?.locked ? 'Locked' : 'Active & Tracked');
        if (status) status.style.color = system ? 'var(--success)' : 'var(--text-muted)';
    });

    // 5. AI verification bars
    statsPart('ai', () => {
        statsSet('countAiLocked', aiVerifiedCount);
        statsSet('countStandard', standardDoneCount);
        const ai = document.getElementById('barAiLocked'), std = document.getElementById('barStandard');
        if (ai) ai.style.width = `${(aiVerifiedCount / totalCompleted) * 100}%`;
        if (std) std.style.width = `${(standardDoneCount / totalCompleted) * 100}%`;
    });

    // 6. Distraction archive
    statsPart('archive', renderArchiveList);
}

// Clear All Archive button listener
const clearArchiveBtn = document.getElementById('clearAllArchiveBtn');
if (clearArchiveBtn) {
    clearArchiveBtn.addEventListener('click', () => {
        const count = getArchivedNotes().length;
        if (count === 0) return;
        if (confirm(`Are you sure you want to permanently delete all ${count} archived notes?`)) {
            saveArchivedNotes([]);
        }
    });
}

// Redraw while Stats is open whenever its data can change: sync, task edits (also in
// another tab), break answers from the Worker, sign-in finishing, Settings day start.
let statsQueued = false;
function refreshIfOpen() {
    if (statsQueued || window.TaskitatorShell?.current() !== 'stats') return;
    statsQueued = true;
    setTimeout(() => { statsQueued = false; if (window.TaskitatorShell?.current() === 'stats') renderStats(); }, 50);
}
for (const type of ['taskitator-synced', 'taskitator-tasks-updated', 'taskitator-breaks-changed', 'taskitator-auth-ready']) window.addEventListener(type, refreshIfOpen);
window.addEventListener('storage', e => { if (!e.key || /^taskitator_(tasks|projects|recurrence_state|archived_notes|settings|daily_breaks|break_state)$/.test(e.key)) refreshIfOpen(); });
window.renderStats = renderStats;
})();
// <<< MODULE_END: stats.html >>>
    

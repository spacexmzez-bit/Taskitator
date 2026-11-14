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

function renderStats() {
    if (!isPrivateWorkspaceAllowed()) return;
    let tasks = [];
    let projects = [];
    let breaks = [];

    try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'); } catch (e) { tasks = []; }
    const history = TaskitatorRecurrenceUI.state().history;
    for (const event of history) {
        if(event.outcome!=='completed') continue;
        for (const [i,t] of event.tasks.entries()) if(t.status==='completed') {
            tasks.push({...t,id:event.id+':'+i,status:'completed',due_date:event.due_date,completed_at:t.completed_at||event.ended_at});
        }
    }
    try { projects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'); } catch (e) { projects = []; }
    breaks = window.TaskitatorEngine?.BreakEngine?.getTodayBreaks() || [];

    if (!projects.some(p => p.id === 'inbox')) {
        projects.unshift({ id: 'inbox', name: 'Inbox', color: '#94a3b8', icon: '' });
    }

    const todayStr = new Date().toISOString().split('T')[0];

    const completedTasks = tasks.filter(t => t.status === 'completed');
    const activeTasks = tasks.filter(t => t.status === 'active');

    // 1. Key Metrics Calculation
    const completedToday = completedTasks.filter(t => t.completed_at && t.completed_at.startsWith(todayStr)).length;
    const pendingToday = activeTasks.filter(t => {
        const due = String(t.due_date || '').trim().toLowerCase();
        return due === 'today' || due === todayStr;
    }).length;

    const aiVerifiedCount = completedTasks.filter(t => t.ai_locked).length;
    const standardDoneCount = completedTasks.filter(t => !t.ai_locked).length;
    const rigorRatio = completedTasks.length > 0 ? Math.round((aiVerifiedCount / completedTasks.length) * 100) : 0;

    document.getElementById('statCompletedToday').textContent = completedToday;
    document.getElementById('statPendingToday').textContent = pendingToday;
    document.getElementById('statAiRigor').textContent = `${rigorRatio}%`;
    document.getElementById('statTotalActive').textContent = activeTasks.length;

    // 2. 7-Day Completion Velocity Heatmap
    const velocityContainer = document.getElementById('velocityBarsContainer');
    velocityContainer.innerHTML = '';
    const dayCounts = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const iso = d.toISOString().split('T')[0];
        const count = completedTasks.filter(t => t.completed_at && t.completed_at.startsWith(iso)).length;
        dayCounts.push({
            label: i === 0 ? 'Today' : dayNames[d.getDay()],
            count: count,
            isToday: i === 0
        });
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

    // 3. Project Productivity Allocation Breakdown
    const projectAllocationList = document.getElementById('projectAllocationList');
    projectAllocationList.innerHTML = '';

    const projectCounts = new Map();
    projects.forEach(p => projectCounts.set(p.id, 0));

    completedTasks.forEach(t => {
        const pId = t.project_id || 'inbox';
        projectCounts.set(pId, (projectCounts.get(pId) || 0) + 1);
    });

    const totalCompleted = Math.max(1, completedTasks.length);
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
        label.title = p.name;
        TaskitatorSafety.setProjectLabel(label, p);
        projectAllocationList.appendChild(row);
    });

    if (renderedProjectsCount === 0) {
        projectAllocationList.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding: 12px 0;">No completed tasks yet.</div>`;
    }

    // 4. Break Adherence Meter
    let totalMins = 0;
    breaks.forEach(b => {
        const bounds=TaskitatorEngine.BreakEngine.getLogicalDayBounds();
        const {startTime,endTime}=TaskitatorEngine.BreakEngine.getBreakTimestamps(b,bounds);
        if(Number.isFinite(startTime)&&endTime>startTime)totalMins+=(endTime-startTime)/60000;
    });

    const breakCountEl = document.getElementById('breakSlotsCount');
    const totalBreakTimeEl = document.getElementById('totalBreakTime');
    const breakAdherenceEl = document.getElementById('breakAdherenceStatus');

    if (breakCountEl) breakCountEl.textContent = `${breaks.length} break window${breaks.length === 1 ? '' : 's'} configured`;
    if (totalBreakTimeEl) totalBreakTimeEl.textContent = `${totalMins}m`;

    if (breakAdherenceEl) {
        if (breaks.length === 0) {
            breakAdherenceEl.textContent = 'None Set';
            breakAdherenceEl.style.color = 'var(--text-muted)';
        } else {
            breakAdherenceEl.textContent = 'Active & Tracked';
            breakAdherenceEl.style.color = 'var(--success)';
        }
    }

    // 5. AI Rigor Ratio Bars
    document.getElementById('countAiLocked').textContent = aiVerifiedCount;
    document.getElementById('barAiLocked').style.width = `${(aiVerifiedCount / totalCompleted) * 100}%`;

    document.getElementById('countStandard').textContent = standardDoneCount;
    document.getElementById('barStandard').style.width = `${(standardDoneCount / totalCompleted) * 100}%`;

    // 6. Render Distraction Archive
    renderArchiveList();
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

window.addEventListener('taskitator-synced', () => {
    if (window.TaskitatorShell?.current() === 'stats') renderStats();
});
window.renderStats = renderStats;
})();
// <<< MODULE_END: stats.html >>>
    

// Calendar view (moved out of components.html in Phase 3.0; runs inside the index.html shell).
// <<< MODULE_START: calendar.html >>>
(() => {
const TASKS_KEY = 'taskitator_tasks';
const PROJECTS_KEY = 'taskitator_projects';
const SETTINGS_KEY = 'taskitator_settings';

let tasks = [];
let projects = [];
let currentDate = new Date();
let selectedDateStr = new Date().toISOString().split('T')[0];

function isCalendarWorkspaceAllowed() {
    if (/[?&]view=(?:legal|compare|privacy|terms)(?:&|$)/i.test(window.location?.search || '')) return false;
    if (typeof window.TaskitatorAuth !== 'undefined') {
        return Boolean(window.TaskitatorAuth?.signedIn && localStorage.getItem('taskitator_local_owner') === window.TaskitatorAuth?.account?.user);
    }
    return true;
}

function loadData() {
    if (!isCalendarWorkspaceAllowed()) { tasks = []; projects = []; return; }
    try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'); } catch (e) { tasks = []; }
    try { projects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'); } catch (e) { projects = []; }
}

function saveDataAndSync() {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
        SyncEngine.markLocalModified();
        SyncEngine.scheduleAutoPush();
    }
    window.dispatchEvent(new Event('taskitator-tasks-updated'));
}

function earlyAppearance(task) {
    const E = window.TaskitatorEarly; if (!E) return '';
    const today = TaskitatorRecurrence.today(Date.now(), Number(JSON.parse(localStorage.getItem('taskitator_settings') || '{}').day_start_hour) || 0);
    return E.appearance(E.index(tasks), task, today) || '';
}

function getNormalizedTaskDueDate(task) {
    const raw = String(task.due_date || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'today') return new Date().toISOString().split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return '';
}

function isTaskRecurring(task) {
    return Boolean(task.recurring || task.recurrence || (task.tags && task.tags.includes('recurring')));
}

function renderCalendar() {
    if (!isCalendarWorkspaceAllowed()) return;
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    document.getElementById('calendarMonthTitle').textContent = `${monthNames[month]} ${year}`;

    const grid = document.getElementById('calendarGridBody');
    grid.innerHTML = '';

    const firstDayIndex = new Date(year, month, 1).getDay();
    const offset = (firstDayIndex === 0 ? 6 : firstDayIndex - 1); // Monday start
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const todayStr = new Date().toISOString().split('T')[0];

    // Compute task date map
    const activeTasks = tasks.filter(t => t.status === 'active');
    const dayMetaMap = new Map();

    activeTasks.forEach(t => {
        const early = earlyAppearance(t);
        if (early) {
            if (!dayMetaMap.has(early)) dayMetaMap.set(early, { hasSolid: false, hasRing: false });
            dayMetaMap.get(early).hasEarly = true;
        }
        const d = getNormalizedTaskDueDate(t);
        if (!d) return;
        if (!dayMetaMap.has(d)) {
            dayMetaMap.set(d, { hasSolid: false, hasRing: false });
        }
        const meta = dayMetaMap.get(d);
        if (isTaskRecurring(t)) {
            meta.hasRing = true;
        } else {
            meta.hasSolid = true;
        }
    });

    // Empty lead cells
    for (let i = 0; i < offset; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'calendar-cell empty';
        grid.appendChild(emptyCell);
    }

    // Month day cells
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-cell';

        if (dateStr === todayStr) cell.classList.add('today');
        if (dateStr === selectedDateStr) cell.classList.add('selected');

        const numberSpan = document.createElement('span');
        numberSpan.className = 'calendar-date-number';
        numberSpan.textContent = day;
        cell.appendChild(numberSpan);

        const dotsRow = document.createElement('div');
        dotsRow.className = 'calendar-dots-row';

        const meta = dayMetaMap.get(dateStr);
        if (meta) {
            if (meta.hasSolid) {
                const sDot = document.createElement('span');
                sDot.className = 'cal-dot-solid';
                dotsRow.appendChild(sDot);
            }
            if (meta.hasRing) {
                const rDot = document.createElement('span');
                rDot.className = 'cal-dot-ring';
                dotsRow.appendChild(rDot);
            }
            if (meta.hasEarly) {
                const eDot = document.createElement('span');
                eDot.className = 'cal-dot-early';
                dotsRow.appendChild(eDot);
            }
        }
        cell.appendChild(dotsRow);

        cell.addEventListener('click', () => {
            selectedDateStr = dateStr;
            renderCalendar();
            renderAgenda();
        });

        grid.appendChild(cell);
    }
}

// Path-Preserving Tree Engine for Selected Date
function renderAgenda() {
    const list = document.getElementById('agendaListContainer');
    list.innerHTML = '';

    const dateParts = selectedDateStr.split('-');
    const dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
    const options = { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' };
    document.getElementById('selectedDateHeading').textContent = (window.TaskitatorI18n?.date(dateObj, options) ?? dateObj.toLocaleDateString(undefined, options));

    const activeTasks = tasks.filter(t => t.status === 'active');
    const allChildrenMap = new Map();

    activeTasks.forEach(t => {
        const pId = t.parent_id || 'root';
        if (!allChildrenMap.has(pId)) allChildrenMap.set(pId, []);
        allChildrenMap.get(pId).push(t);
    });

    const matchMap = new Map();
    const descMatchMap = new Map();

    activeTasks.forEach(t => {
        const isMatch = getNormalizedTaskDueDate(t) === selectedDateStr || earlyAppearance(t) === selectedDateStr;
        matchMap.set(t.id, isMatch);
    });

    function checkDesc(nodeId) {
        if (descMatchMap.has(nodeId)) return descMatchMap.get(nodeId);
        const kids = allChildrenMap.get(nodeId) || [];
        let has = false;
        for (let k of kids) {
            if (matchMap.get(k.id) || checkDesc(k.id)) has = true;
        }
        descMatchMap.set(nodeId, has);
        return has;
    }
    activeTasks.forEach(t => checkDesc(t.id));

    let rootTasks = (allChildrenMap.get('root') || []).filter(t => {
        return matchMap.get(t.id) || descMatchMap.get(t.id);
    });

    const totalMatchingCount = activeTasks.filter(t => matchMap.get(t.id)).length;
    document.getElementById('agendaCountBadge').textContent = `${totalMatchingCount} task${totalMatchingCount === 1 ? '' : 's'}`;

    if (rootTasks.length === 0) {
        list.innerHTML = `<li style="text-align: center; color: var(--text-muted); padding: 24px 0; font-size: 0.88rem;">No tasks assigned to this date.</li>`;
    } else {
        rootTasks.forEach(t => list.appendChild(buildAgendaNode(t, 0, allChildrenMap, matchMap, descMatchMap)));
    }

    renderUnscheduledBacklog();
}

function buildAgendaNode(task, depth, allChildrenMap, matchMap, descMatchMap) {
    const li = document.createElement('li');
    li.className = 'task-node';

    const isMatch = matchMap.get(task.id);
    const hasDescMatch = descMatchMap.get(task.id);
    const isBreadcrumb = !isMatch && hasDescMatch;

    const row = document.createElement('div');
    row.className = 'task-row';
    row.style.marginInlineStart = `${depth * 20}px`;

    if (isBreadcrumb) {
        row.classList.add('muted-breadcrumb');
    }

    const main = document.createElement('div');
    main.className = 'task-main';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'check-circle';
    checkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadData();
        const current = tasks.find(item => item.id === task.id && item.status === 'active');
        if (!current) { refreshCalendar(); return; }
        const branch = TaskitatorRecurrence.subtree(tasks, current.id);
        if (branch.some(t=>t.ai_locked || t.strict_prerequisites || t.recurrence_series_id)) {
            alert('Complete this protected or recurring task from Today / General Tasks so proof, prerequisites, and recurrence are handled safely.');
            window.location.hash = '#general'; return;
        }
        current.status = 'completed';
        current.completed_at = new Date().toISOString();
        saveDataAndSync();
        refreshCalendar();
    });
    window.TaskitatorIcons?.decorateTask?.({ li, row, checkBtn, task, depth });
    main.appendChild(checkBtn);

    const titleSpan = document.createElement('span');
    titleSpan.className = 'task-title';
    titleSpan.textContent = task.title;
    main.appendChild(titleSpan);
    if (isMatch && earlyAppearance(task) === selectedDateStr) {
        const earlyBadge = document.createElement('span');
        earlyBadge.className = 'bonus-badge early-badge';
        earlyBadge.textContent = 'Early · due ' + getNormalizedTaskDueDate(task);
        main.appendChild(earlyBadge);
    }

    const proj = projects.find(p => p.id === (task.project_id || 'inbox'));
    if (proj && proj.id !== 'inbox') {
        const pBadge = document.createElement('span');
        pBadge.className = 'project-badge-chip';
        pBadge.style.borderColor = proj.color;
        pBadge.style.color = proj.color;
        TaskitatorSafety.setProjectLabel(pBadge, proj);
        main.appendChild(pBadge);
    }

    row.appendChild(main);
    li.appendChild(row);

    const kids = (allChildrenMap.get(task.id) || []).filter(k => matchMap.get(k.id) || descMatchMap.get(k.id));
    if (kids.length > 0) {
        const subUl = document.createElement('ul');
        subUl.className = 'task-subtree';
        kids.forEach(k => subUl.appendChild(buildAgendaNode(k, depth + 1, allChildrenMap, matchMap, descMatchMap)));
        li.appendChild(subUl);
    }

    return li;
}

function renderUnscheduledBacklog() {
    const list = document.getElementById('unscheduledListContainer');
    list.innerHTML = '';

    const unscheduledTasks = tasks.filter(t => t.status === 'active' && !getNormalizedTaskDueDate(t));
    document.getElementById('unscheduledCountBadge').textContent = unscheduledTasks.length;

    if (unscheduledTasks.length === 0) {
        list.innerHTML = `<li style="color: var(--text-muted); font-size: 0.82rem; padding: 6px 0;">No unscheduled tasks.</li>`;
        return;
    }

    unscheduledTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'task-node';
        li.style.marginBottom = '6px';

        const row = document.createElement('div');
        row.className = 'task-row';
        row.style.padding = '8px 12px';

        const main = document.createElement('div');
        main.className = 'task-main';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'task-title';
        titleSpan.style.fontSize = '0.88rem';
        titleSpan.textContent = task.title;
        main.appendChild(titleSpan);

        row.appendChild(main);

        const assignBtn = document.createElement('button');
        assignBtn.className = 'icon-btn';
        assignBtn.style.padding = '2px 8px';
        assignBtn.style.fontSize = '0.75rem';
        assignBtn.textContent = 'Assign to Today';
        assignBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            loadData();
            const current = tasks.find(item => item.id === task.id && item.status === 'active');
            if (current && !getNormalizedTaskDueDate(current)) {
                current.due_date = new Date().toISOString().split('T')[0];
                saveDataAndSync();
            }
            refreshCalendar();
        });
        row.appendChild(assignBtn);

        li.appendChild(row);
        list.appendChild(li);
    });
}

function toggleUnscheduledCard() {
    const card = document.getElementById('unscheduledCard');
    card.classList.toggle('open');
    const headerTitle = document.getElementById('unscheduledTitle');
    headerTitle.textContent = card.classList.contains('open') ? '▾ Unscheduled Tasks' : '▸ Unscheduled Tasks';
}

// Navigation Events
document.getElementById('prevMonthBtn').addEventListener('click', () => {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar();
});

document.getElementById('nextMonthBtn').addEventListener('click', () => {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar();
});

document.getElementById('todayJumpBtn').addEventListener('click', () => {
    currentDate = new Date();
    selectedDateStr = new Date().toISOString().split('T')[0];
    renderCalendar();
    renderAgenda();
});

function refreshCalendar() {
    loadData();
    renderCalendar();
    renderAgenda();
}
window.addEventListener('taskitator-synced', () => {
    if (window.TaskitatorShell?.current() === 'calendar') refreshCalendar();
});
document.querySelector('[data-cal-action-0]')?.addEventListener('click', function(){toggleUnscheduledCard()});
window.renderCalendarView = refreshCalendar;
})();
// <<< MODULE_END: calendar.html >>>
    

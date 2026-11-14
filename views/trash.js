// Trash view (moved out of components.html in Phase 3.0; runs inside the index.html shell).
// <<< MODULE_START: trash.html >>>
(() => {
const TASKS_KEY = 'taskitator_tasks';
let tasks = [];

function isTrashWorkspaceAllowed() {
    if (/[?&]view=(?:legal|compare|privacy|terms)(?:&|$)/i.test(window.location?.search || '')) return false;
    if (typeof window.TaskitatorAuth !== 'undefined') {
        return Boolean(window.TaskitatorAuth?.signedIn && localStorage.getItem('taskitator_local_owner') === window.TaskitatorAuth?.account?.user);
    }
    return true;
}

function loadTasks() {
    if (!isTrashWorkspaceAllowed()) { tasks = []; return; }
    try {
        tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
    } catch (e) {
        tasks = [];
    }
}

function saveTasksAndPush() {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    if (window.SyncEngine) {
        if (typeof SyncEngine.markLocalModified === 'function') {
            SyncEngine.markLocalModified();
        }
        if (typeof SyncEngine.scheduleAutoPush === 'function') {
            SyncEngine.scheduleAutoPush(45000);
        }
    }
    window.dispatchEvent(new Event('taskitator-tasks-updated'));
}

function renderTrash() {
    if (!isTrashWorkspaceAllowed()) return;
    const list = document.getElementById('trashList');
    list.innerHTML = '';

    const trashedTasks = tasks.filter(t => t.status === 'trash');

    if (trashedTasks.length === 0) {
        list.innerHTML = '<li style="text-align: center; color: var(--text-muted); padding: 32px;">Trash is empty.</li>';
        return;
    }

    trashedTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'trash-item';

        const info = document.createElement('div');
        info.innerHTML = `
            <div class="trash-title">${TaskitatorSafety.escapeHtml(task.title)} ${task.ai_locked ? '<span class="ai-badge"><svg class="tk-ic" aria-hidden="true" focusable="false"><use href="#ic-lock"></use></svg> AI</span>' : ''}</div>
            <div class="trash-meta">Created: ${(window.TaskitatorI18n?.date(task.created_at || Date.now()) ?? new Date(task.created_at || Date.now()).toLocaleDateString())}</div>
        `;

        const actions = document.createElement('div');
        actions.className = 'trash-actions';

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'icon-btn';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', () => restoreTask(task.id));

        const permDelBtn = document.createElement('button');
        permDelBtn.className = 'icon-btn';
        permDelBtn.style.color = 'var(--danger)';
        permDelBtn.style.borderColor = '#7f1d1d';
        permDelBtn.textContent = 'Delete Forever';
        permDelBtn.addEventListener('click', () => permanentlyDeleteTask(task.id));

        actions.appendChild(restoreBtn);
        actions.appendChild(permDelBtn);

        li.appendChild(info);
        li.appendChild(actions);
        list.appendChild(li);
    });
}

function restoreTask(taskId) {
    loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'trash') return;

    if (task.parent_id) {
        const parent = tasks.find(t => t.id === task.parent_id);
        if (!parent || parent.status === 'trash') {
            task.parent_id = null;
        }
    }

    task.status = 'active';
    delete task.trashed_by_completion;

    function recursiveRestoreChildren(parentId) {
        tasks.filter(t => t.parent_id === parentId && t.status === 'trash').forEach(child => {
            child.status = 'active';
            delete child.trashed_by_completion;
            recursiveRestoreChildren(child.id);
        });
    }
    recursiveRestoreChildren(taskId);

    saveTasksAndPush();
    renderTrash();
}

async function permanentlyDeleteTask(taskId) {
    if (!confirm('Permanently delete this task and all its subtasks? This cannot be undone.')) return;
    loadTasks();
    if (!tasks.some(task => task.id === taskId && task.status === 'trash')) return;

    const idsToDelete = new Set();
    function collectIds(targetId) {
        if (idsToDelete.has(targetId)) return;
        idsToDelete.add(targetId);
        tasks.filter(t => t.parent_id === targetId).forEach(child => collectIds(child.id));
    }
    collectIds(taskId);

    tasks = tasks.filter(t => !idsToDelete.has(t.id));
    saveTasksAndPush();
    renderTrash();

    if (window.ExemplarStore) {
        for (const id of idsToDelete) {
            try {
                await ExemplarStore.deleteExemplar(id);
            } catch (e) {
                console.warn('Failed to delete exemplar for task:', id);
            }
        }
    }
}

document.getElementById('emptyTrashBtn')?.addEventListener('click', async () => {
    loadTasks();
    const trashedTasks = tasks.filter(t => t.status === 'trash');
    const count = trashedTasks.length;
    if (count === 0) {
        alert('Trash is already empty.');
        return;
    }
    if (confirm(`Permanently delete all ${count} items in the trash?`)) {
        tasks = tasks.filter(t => t.status !== 'trash');
        saveTasksAndPush();
        renderTrash();
        if (window.ExemplarStore) {
            for (const t of trashedTasks) {
                try {
                    await ExemplarStore.deleteExemplar(t.id);
                } catch (e) {}
            }
        }
    }
});

function refreshTrash() {
    loadTasks();
    renderTrash();
}
window.addEventListener('taskitator-synced', () => {
    if (window.TaskitatorShell?.current() === 'trash') refreshTrash();
});
window.renderTrashView = refreshTrash;
})();
// <<< MODULE_END: trash.html >>>
    

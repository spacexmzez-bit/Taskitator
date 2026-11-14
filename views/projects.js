// Projects view (moved out of components.html in Phase 3.0; runs inside the index.html shell).
// <<< MODULE_START: projects.html >>>
(() => {
(() => {
    let activeProjectId = 'inbox';
    let selectedEmoji = '';
    let selectedColor = '#3b82f6';

    function isProjectsWorkspaceAllowed() {
        if (/[?&]view=(?:legal|compare|privacy|terms)(?:&|$)/i.test(window.location?.search || '')) return false;
        if (typeof window.TaskitatorAuth !== 'undefined') {
            return Boolean(window.TaskitatorAuth?.signedIn && localStorage.getItem('taskitator_local_owner') === window.TaskitatorAuth?.account?.user);
        }
        return true;
    }

    function renderProjectStrip() {
        if (!isProjectsWorkspaceAllowed()) return;
        const strip = document.getElementById('projectsHeaderStrip');
        const addBtn = document.getElementById('openCreateProjectModalBtn');
        if (!strip || !addBtn) return;

        strip.innerHTML = '';
        strip.appendChild(addBtn);

        const projects = TaskitatorApp.getGlobalProjects();
        if (!projects.some(p => p.id === activeProjectId)) {
            activeProjectId = 'inbox';
        }

        projects.forEach(p => {
            const pill = document.createElement('div');
            pill.className = `project-tab-pill ${p.id === activeProjectId ? 'active' : ''}`;
            if (p.id === activeProjectId) {
                pill.style.color = p.color;
            }
            TaskitatorSafety.setProjectLabel(pill, p);
            pill.addEventListener('click', () => {
                activeProjectId = p.id;
                renderProjectStrip();
                renderProjectWorkspace();
            });
            strip.appendChild(pill);
        });
    }

    function renderProjectWorkspace() {
        if (!isProjectsWorkspaceAllowed()) return;
        const projects = TaskitatorApp.getGlobalProjects();
        const activeProj = projects.find(p => p.id === activeProjectId) || projects[0];

        const iconEl = document.getElementById('activeProjectIcon');
        const nameEl = document.getElementById('activeProjectName');
        const countBadge = document.getElementById('projectTaskCountBadge');
        const list = document.getElementById('projectTaskListContainer');
        const editFab = document.getElementById('openEditActiveProjectFab');

        if (iconEl) {
            // The system Inbox default uses the sprite icon; user-chosen icons stay as chosen.
            if (activeProj.id === 'inbox' && activeProj.icon === '\u{1F4E5}' && window.TaskitatorIcons) iconEl.replaceChildren(window.TaskitatorIcons.node('inbox'));
            else iconEl.textContent = activeProj.icon;
        }
        if (nameEl) {
            nameEl.textContent = activeProj.name;
            nameEl.style.color = activeProj.color;
        }

        if (editFab) {
            editFab.style.display = (activeProj.id === 'inbox') ? 'none' : 'flex';
        }

        const canonicalTasks = TaskitatorApp.getTasks();
        const logicalToday=TaskitatorRecurrence.today(Date.now(),Number(JSON.parse(localStorage.getItem('taskitator_settings')||'{}').day_start_hour)||0);
        const tasks=canonicalTasks.map(t=>{if(t.status!=='active'||t.smart_early_date!==logicalToday)return t;const parent=canonicalTasks.find(p=>p.study_plan_id===t.study_plan_id&&!p.parent_id&&p.due_date===logicalToday);return parent?{...t,parent_id:parent.id,is_bonus:true}:t;});
        const allChildrenMap = new Map();
        const visibleChildrenMap = new Map();

        tasks.forEach(t => {
            if (t.status === 'trash') return;
            const pId = t.parent_id || 'root';
            if (!allChildrenMap.has(pId)) allChildrenMap.set(pId, []);
            allChildrenMap.get(pId).push(t);

            if (t.status === 'active') {
                if (!visibleChildrenMap.has(pId)) visibleChildrenMap.set(pId, []);
                visibleChildrenMap.get(pId).push(t);
            }
        });

        // Date filter (display only): keep matches and their ancestors.
        const dateMode = document.getElementById('projectDateMode'), dateRange = document.getElementById('projectDateRange');
        const projectDate = { mode: dateMode?.value || '', from: document.getElementById('projectDateFrom')?.value || '', to: document.getElementById('projectDateTo')?.value || '' };
        if (dateRange) dateRange.hidden = projectDate.mode !== 'range';
        const dateKeep = window.TaskitatorDateFilter?.active(projectDate) ? window.TaskitatorDateFilter.visible(canonicalTasks, logicalToday, projectDate) : null;
        if (dateKeep) for (const [k, list] of visibleChildrenMap) visibleChildrenMap.set(k, list.filter(t => dateKeep.has(t.id)));
        const projectTasks = tasks.filter(t => (t.project_id || 'inbox') === activeProjectId && t.status !== 'trash');
        if (countBadge) countBadge.textContent = `${projectTasks.length} Tasks`;

        if (!list) return;
        list.innerHTML = '';

        let rootTasks = (allChildrenMap.get('root') || []).filter(t => (t.project_id || 'inbox') === activeProjectId && t.status !== 'trash' && (!dateKeep || dateKeep.has(t.id)));
        rootTasks = TaskitatorApp.sortTasks(rootTasks);

        if (rootTasks.length === 0) {
            const empty = document.createElement('li');
            empty.style.cssText = 'text-align: center; color: var(--text-muted); padding: 32px;';
            empty.textContent = dateKeep ? 'No tasks match this date filter.' : `No active tasks in ${activeProj.name}.`;
            list.replaceChildren(empty);
            return;
        }

        const collapsed = new Set(JSON.parse(localStorage.getItem('taskitator_collapsed_nodes') || '[]'));
        function buildNode(task, depth = 0, visited = new Set()) {
            if (visited.has(task.id)) return document.createElement('li');
            visited = new Set([...visited, task.id]);
            const li = document.createElement('li');
            li.className = `task-node ${task.status === 'completed' ? 'completed' : ''}`;

            const row = document.createElement('div');
            row.className = 'task-row';
            row.style.marginInlineStart = `${depth * 20}px`;

            const main = document.createElement('div');
            main.className = 'task-main';

            const children = visibleChildrenMap.get(task.id) || [];
            if (children.length) {
                const toggle = document.createElement('button'); toggle.type='button'; toggle.className='collapse-toggle';
                toggle.textContent=collapsed.has(task.id)?'▶':'▼';
                toggle.setAttribute('aria-label',collapsed.has(task.id)?'Expand subtasks':'Collapse subtasks');
                toggle.setAttribute('aria-expanded',String(!collapsed.has(task.id)));
                toggle.onclick=e=>{e.stopPropagation();if(collapsed.has(task.id))collapsed.delete(task.id);else collapsed.add(task.id);localStorage.setItem('taskitator_collapsed_nodes',JSON.stringify([...collapsed]));renderProjectWorkspace();}; main.appendChild(toggle);
            }
            const checkBtn = document.createElement('button');
            checkBtn.className = 'check-circle';
            checkBtn.textContent = task.status === 'completed' ? '✓' : '';
            checkBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                TaskitatorApp.handleTaskCompletion(task.id, renderProjectWorkspace);
            });
            window.TaskitatorIcons?.decorateTask?.({ li, row, checkBtn, task, depth });
            main.appendChild(checkBtn);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'task-title';
            titleSpan.textContent = task.title;
            main.appendChild(titleSpan);
            if(task.smart_early_date===logicalToday&&task.is_bonus){const badge=document.createElement('span');badge.className='bonus-badge';badge.textContent='Early bonus';main.appendChild(badge);}if(task.early_date===logicalToday&&task.status==='active'&&task.due_date&&task.due_date>logicalToday){const badge=document.createElement('span');badge.className='bonus-badge early-badge';badge.textContent='Early today';main.appendChild(badge);}else if(task.early_date&&task.status==='active'&&window.TaskitatorEarly?.appearance(window.TaskitatorEarly.index(canonicalTasks),task,logicalToday)){const badge=document.createElement('span');badge.className='bonus-badge early-badge';badge.textContent='Early on '+task.early_date;main.appendChild(badge);}

            if (task.due_date) {
                const due = document.createElement('span');
                due.className = 'due-badge';
                due.textContent = task.due_date;
                main.appendChild(due);
            }

            row.appendChild(main);

            const delBtn = document.createElement('button');
            delBtn.className = 'action-del-btn';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                TaskitatorApp.deleteTask(task.id, renderProjectWorkspace);
            });
            row.appendChild(delBtn);

            row.addEventListener('click', () => {
                TaskitatorApp.openTaskDetailModal(task.id, renderProjectWorkspace);
            });

            li.appendChild(row);

            const kids = visibleChildrenMap.get(task.id) || [];
            if (kids.length > 0 && !collapsed.has(task.id)) {
                const subUl = document.createElement('ul');
                subUl.className = 'task-subtree';
                kids.forEach(k => subUl.appendChild(buildNode(k, depth + 1, visited)));
                li.appendChild(subUl);
            }

            return li;
        }

        rootTasks.forEach(t => list.appendChild(buildNode(t, 0)));
    }

    function refreshProjects() {
        if (!isProjectsWorkspaceAllowed()) return;
        TaskitatorApp.loadStorage();
        renderProjectStrip();
        renderProjectWorkspace();
    }
    window.refreshCurrentProjectView = refreshProjects;
    for (const id of ['projectDateMode', 'projectDateFrom', 'projectDateTo']) document.getElementById(id)?.addEventListener('change', renderProjectWorkspace);

    function openProjectModal(isEdit = false) {
        const modal = document.getElementById('projectModal');
        const modalTitle = document.getElementById('projectModalTitle');
        const idInput = document.getElementById('editingProjectId');
        const nameInput = document.getElementById('projectNameInput');
        const deleteSection = document.getElementById('projectDeleteSection');
        const cascadePanel = document.getElementById('cascadeDeleteOptionsPanel');

        if (!modal) return;
        if (cascadePanel) cascadePanel.style.display = 'none';

        if (isEdit) {
            const projects = TaskitatorApp.getGlobalProjects();
            const curr = projects.find(p => p.id === activeProjectId);
            if (!curr || curr.id === 'inbox') return;

            if (modalTitle) modalTitle.textContent = 'Edit Project';
            if (idInput) idInput.value = curr.id;
            if (nameInput) nameInput.value = curr.name;
            selectedEmoji = curr.icon || '';
            selectedColor = curr.color || '#3b82f6';
            if (deleteSection) deleteSection.style.display = 'block';

            const reassignSelect = document.getElementById('reassignTargetProjectSelect');
            if (reassignSelect) {
                reassignSelect.innerHTML = '';
                projects.filter(p => p.id !== curr.id).forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = `${p.icon} ${p.name}`;
                    reassignSelect.appendChild(opt);
                });
            }
        } else {
            if (modalTitle) modalTitle.textContent = 'Create New Project';
            if (idInput) idInput.value = '';
            if (nameInput) nameInput.value = '';
            selectedEmoji = '';
            selectedColor = '#3b82f6';
            if (deleteSection) deleteSection.style.display = 'none';
        }

        renderEmojiGrid();
        renderColorRow();
        modal.classList.add('open');
    }

    function renderEmojiGrid() {
        const grid = document.getElementById('emojiPickerGrid');
        if (!grid) return;
        grid.innerHTML = '';
        TaskitatorApp.PROJECT_ICONS.forEach(em => {
            const div = document.createElement('div');
            div.className = `emoji-grid-item ${em === selectedEmoji ? 'selected' : ''}`;
            div.textContent = em;
            div.addEventListener('click', () => {
                selectedEmoji = em;
                renderEmojiGrid();
            });
            grid.appendChild(div);
        });
    }

    function renderColorRow() {
        const row = document.getElementById('colorPickerRow');
        if (!row) return;
        row.innerHTML = '';
        TaskitatorApp.PROJECT_COLORS.forEach(c => {
            const dot = document.createElement('div');
            dot.className = `color-picker-dot ${c === selectedColor ? 'selected' : ''}`;
            dot.style.backgroundColor = c;
            dot.addEventListener('click', () => {
                selectedColor = c;
                renderColorRow();
            });
            row.appendChild(dot);
        });
    }

    window.addEventListener('taskitator-auth-ready', () => {
        const openCreateBtn = document.getElementById('openCreateProjectModalBtn');
        if (openCreateBtn) openCreateBtn.addEventListener('click', () => openProjectModal(false));

        const openEditFab = document.getElementById('openEditActiveProjectFab');
        if (openEditFab) openEditFab.addEventListener('click', () => openProjectModal(true));

        const closeProjectModalBtn = document.getElementById('closeProjectModalBtn');
        const projectModal = document.getElementById('projectModal');
        if (closeProjectModalBtn && projectModal) {
            closeProjectModalBtn.addEventListener('click', () => projectModal.classList.remove('open'));
        }

        const projectForm = document.getElementById('projectForm');
        if (projectForm && projectModal) {
            projectForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const name = document.getElementById('projectNameInput')?.value.trim();
                const id = document.getElementById('editingProjectId')?.value || null;
                if (!name) return;

                TaskitatorApp.saveProject({
                    id: id,
                    name: name,
                    icon: selectedEmoji,
                    color: selectedColor
                });

                projectModal.classList.remove('open');
                renderProjectStrip();
                renderProjectWorkspace();
            });
        }

        const triggerDeleteToggle = document.getElementById('triggerProjectDeleteToggleBtn');
        const cascadePanel = document.getElementById('cascadeDeleteOptionsPanel');
        if (triggerDeleteToggle && cascadePanel) {
            triggerDeleteToggle.addEventListener('click', () => {
                cascadePanel.style.display = cascadePanel.style.display === 'none' ? 'flex' : 'none';
            });
        }

        const confirmDeleteBtn = document.getElementById('confirmDeleteProjectBtn');
        if (confirmDeleteBtn && projectModal) {
            confirmDeleteBtn.addEventListener('click', () => {
                const choice = document.querySelector('input[name="cascadeChoice"]:checked')?.value || 'inbox';
                const targetProj = document.getElementById('reassignTargetProjectSelect')?.value || 'inbox';

                const result = TaskitatorApp.deleteProjectWithCascade(activeProjectId, choice, targetProj);
                if (!result.success) {
                    alert(result.error);
                    return;
                }
                activeProjectId = 'inbox';
                projectModal.classList.remove('open');
                renderProjectStrip();
                renderProjectWorkspace();
            });
        }

        const addTaskBtn = document.getElementById('openProjectTaskAddModalBtn');
        if (addTaskBtn) {
            addTaskBtn.addEventListener('click', () => {
                TaskitatorApp.openTaskCreationModal(null, `Create Task in ${document.getElementById('activeProjectName')?.textContent || 'Project'}`, activeProjectId);
            });
        }

        window.addEventListener('taskitator-synced', () => {
            if (window.TaskitatorShell?.current() === 'projects') refreshProjects();
        });
    });
})();
})();
// <<< MODULE_END: projects.html >>>
    

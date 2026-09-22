/**
 * Taskitator Unified Application Engine (app.js)
 * Consolidated state, registries, tree hierarchy algorithms, audio feedback,
 * modal bindings, and path-preserving filter engine shared across views.
 */

window.TaskitatorApp = (() => {
    // =========================================================================
    // Storage Keys & Core State
    // =========================================================================
    const TASKS_KEY = 'taskitator_tasks';
    const COLLAPSED_STATE_KEY = 'taskitator_collapsed_nodes';
    const SETTINGS_KEY = 'taskitator_settings';

    let tasks = [];
    let collapsedNodes = new Set();
    let pendingAuditTaskId = null;
    let activeDetailTaskId = null;
    let emergencyTimerInterval = null;

    let criteriaValidationState = { validated: false, score: 0, isTemplate: false };
    let cachedTemplates = null;
    const pendingGraceCompletions = new Map();

    // Active Filter State
    const activeFilters = { tags: new Set(), priorities: new Set() };
    const draftFilters = { tags: new Set(), priorities: new Set() };

    // Modal Selection State
    const createModalSelectedTags = new Set();
    let createModalSelectedPriority = null;
    const editModalSelectedTags = new Set();
    let editModalSelectedPriority = null;

    // Default System Registries
    const DEFAULT_TAGS = ['study', 'work', 'personal'];
    const DEFAULT_PRIORITIES = [
        { id: 'prio_high', name: 'High', color: '#ef4444', rank: 1 },
        { id: 'prio_med', name: 'Medium', color: '#eab308', rank: 2 },
        { id: 'prio_low', name: 'Low', color: '#22c55e', rank: 3 }
    ];

    // =========================================================================
    // Web Audio API Synthesizer (SoundFX)
    // =========================================================================
    const SoundFX = {
        ctx: null,
        getAudioContext() {
            if (!this.ctx) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AudioCtx();
            }
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            return this.ctx;
        },
        isMuted() {
            try {
                const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
                return settings.sound_effects_enabled === false;
            } catch (e) {
                return false;
            }
        },
        playComplete() {
            if (this.isMuted()) return;
            try {
                const ctx = this.getAudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
                gain.gain.setValueAtTime(0.12, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.12);
            } catch (e) {}
        },
        playSuccessAudit() {
            if (this.isMuted()) return;
            try {
                const ctx = this.getAudioContext();
                [523.25, 659.25, 783.99].forEach((freq, idx) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    const startTime = ctx.currentTime + idx * 0.08;
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(freq, startTime);
                    gain.gain.setValueAtTime(0.1, startTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(startTime);
                    osc.stop(startTime + 0.25);
                });
            } catch (e) {}
        }
    };

    // =========================================================================
    // Registries & Settings Accessors
    // =========================================================================
    function getGlobalTags() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return s.custom_tags || [...DEFAULT_TAGS];
        } catch (e) {
            return [...DEFAULT_TAGS];
        }
    }

    function getGlobalPriorities() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return s.custom_priorities || [...DEFAULT_PRIORITIES];
        } catch (e) {
            return [...DEFAULT_PRIORITIES];
        }
    }

    function saveGlobalTag(newTag) {
        if (!newTag) return;
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            const tags = s.custom_tags || [...DEFAULT_TAGS];
            if (!tags.includes(newTag)) {
                tags.push(newTag);
                s.custom_tags = tags;
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
                if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
                    SyncEngine.markLocalModified();
                }
            }
        } catch (e) {}
    }

    function getLowestPriorityId() {
        const p = getGlobalPriorities();
        if (!p || p.length === 0) return null;
        return p.reduce((prev, curr) => (curr.rank > prev.rank ? curr : prev)).id;
    }

    function isStrictCriteriaModeEnabled() {
        try {
            const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return settings.strict_criteria_validation !== false;
        } catch (e) {
            return true;
        }
    }

    // =========================================================================
    // Safe Engine Wrappers
    // =========================================================================
    function isBypassActiveSafe() {
        if (window.TaskitatorEngine?.EmergencyManager?.isBypassActive) {
            return TaskitatorEngine.EmergencyManager.isBypassActive();
        }
        return false;
    }

    function getEmergencyStateSafe() {
        if (window.TaskitatorEngine?.EmergencyManager?.getState) {
            return TaskitatorEngine.EmergencyManager.getState();
        }
        return { uses_left: 4, active_until: 0 };
    }

    function getTodayBreaksSafe() {
        if (window.TaskitatorEngine?.BreakEngine?.getTodayBreaks) {
            return TaskitatorEngine.BreakEngine.getTodayBreaks();
        }
        try {
            return JSON.parse(localStorage.getItem('taskitator_daily_breaks') || '[]');
        } catch (e) {
            return [];
        }
    }

    function isSelectionWindowOpenSafe() {
        if (window.TaskitatorEngine?.BreakEngine?.isSelectionWindowOpen) {
            return TaskitatorEngine.BreakEngine.isSelectionWindowOpen();
        }
        return true;
    }

    // =========================================================================
    // Storage Pipeline
    // =========================================================================
    function loadStorage() {
        try {
            tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
            const savedCollapsed = JSON.parse(localStorage.getItem(COLLAPSED_STATE_KEY) || '[]');
            collapsedNodes = new Set(savedCollapsed);
        } catch (e) {
            tasks = [];
            collapsedNodes = new Set();
        }
    }

    function saveStorageAndPush() {
        localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
        localStorage.setItem(COLLAPSED_STATE_KEY, JSON.stringify([...collapsedNodes]));

        if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
            SyncEngine.markLocalModified();
        }

        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch (e) {}

        if (!settings.worker_passkey) {
            updateSyncDot('local-only');
        } else {
            updateSyncDot('pending');
        }

        if (window.SyncEngine && typeof SyncEngine.scheduleAutoPush === 'function') {
            const breaks = getTodayBreaksSafe();
            SyncEngine.scheduleAutoPush(45000, { today_breaks: breaks });
        }
    }

    // =========================================================================
    // Sync Indicator
    // =========================================================================
    function updateSyncDot(state) {
        const dot = document.getElementById('syncStatusDot');
        if (!dot) return;
        dot.className = `sync-dot ${state}`;
        if (state === 'synced') dot.title = 'Sync Status: Synced up to date';
        else if (state === 'pending') dot.title = 'Sync Status: Not synced / Pending';
        else if (state === 'error') dot.title = 'Sync Status: Sync Failed / Offline';
        else dot.title = 'Sync Status: Local only';
    }

    function initSyncIndicator() {
        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch (e) {}
        if (!settings.worker_passkey) updateSyncDot('local-only');
        else updateSyncDot('synced');
    }

    // =========================================================================
    // Hierarchy, Shielding, & Sorting Algorithms
    // =========================================================================
    function sortTasks(tasksArray) {
        const priorities = getGlobalPriorities();
        const getRank = (pId) => {
            const p = priorities.find(x => x.id === pId);
            return p ? p.rank : 9999;
        };

        return tasksArray.sort((a, b) => {
            const rA = getRank(a.priority_id);
            const rB = getRank(b.priority_id);
            if (rA !== rB) return rA - rB;

            const dA = a.due_date || '9999-99-99';
            const dB = b.due_date || '9999-99-99';
            if (dA !== dB) return dA.localeCompare(dB);

            const cA = a.created_at || '';
            const cB = b.created_at || '';
            return cA.localeCompare(cB);
        });
    }

    function getAllDescendants(nodeId) {
        let descs = [];
        const kids = tasks.filter(t => t.parent_id === nodeId && t.status !== 'trash');
        for (const kid of kids) {
            descs.push(kid);
            descs = descs.concat(getAllDescendants(kid.id));
        }
        return descs;
    }

    function hasUncompletedDescendant(nodeId) {
        const kids = tasks.filter(t => t.parent_id === nodeId && t.status !== 'trash');
        for (const kid of kids) {
            if (kid.status !== 'completed') return true;
            if (hasUncompletedDescendant(kid.id)) return true;
        }
        return false;
    }

    function isCompletionBlocked(taskId) {
        if (isBypassActiveSafe()) return false;
        const targetTask = tasks.find(t => t.id === taskId);
        if (!targetTask) return false;

        const nodesToCheck = [targetTask, ...getAllDescendants(taskId)];
        for (const node of nodesToCheck) {
            if (node.strict_prerequisites) {
                if (hasUncompletedDescendant(node.id)) {
                    return true;
                }
            }
        }
        return false;
    }

    function cascadeTaskStatus(targetTaskId, newStatus, timestamp = null) {
        const target = tasks.find(t => t.id === targetTaskId);
        if (!target) return;

        target.status = newStatus;
        target.completed_at = timestamp;

        function cascadeChildren(parentId) {
            tasks.filter(t => t.parent_id === parentId && t.status !== 'trash').forEach(child => {
                child.status = newStatus;
                child.completed_at = timestamp;
                cascadeChildren(child.id);
            });
        }
        cascadeChildren(targetTaskId);
    }

    // =========================================================================
    // Grace Timers & Completion Handlers
    // =========================================================================
    function startGraceCompletionTimer(taskId, triggerRenderFn) {
        if (pendingGraceCompletions.has(taskId)) {
            const existing = pendingGraceCompletions.get(taskId);
            clearTimeout(existing.timerId);
            clearInterval(existing.intervalId);
        }

        let remaining = 10;
        const intervalId = setInterval(() => {
            remaining -= 1;
            const el = document.getElementById(`undoTimerSec_${taskId}`) || document.getElementById(`undoGeneralTimerSec_${taskId}`);
            if (el) el.textContent = remaining;
            if (remaining <= 0) {
                clearInterval(intervalId);
            }
        }, 1000);

        const timerId = setTimeout(() => {
            clearInterval(intervalId);
            pendingGraceCompletions.delete(taskId);
            if (typeof triggerRenderFn === 'function') triggerRenderFn();
        }, 10000);

        pendingGraceCompletions.set(taskId, { timerId, intervalId, remainingSec: remaining });
    }

    function undoTaskCompletion(taskId, triggerRenderFn) {
        if (pendingGraceCompletions.has(taskId)) {
            const grace = pendingGraceCompletions.get(taskId);
            clearTimeout(grace.timerId);
            clearInterval(grace.intervalId);
            pendingGraceCompletions.delete(taskId);
        }

        cascadeTaskStatus(taskId, 'active', null);
        saveStorageAndPush();
        if (typeof triggerRenderFn === 'function') triggerRenderFn();
    }

    function handleTaskCompletion(taskId, triggerRenderFn) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.status === 'completed') {
            if (task.ai_locked && !isBypassActiveSafe()) {
                alert('Blocked: AI-checked tasks are permanent and cannot be uncompleted.');
                return;
            }
            cascadeTaskStatus(taskId, 'active', null);
            saveStorageAndPush();
            if (typeof triggerRenderFn === 'function') triggerRenderFn();
            return;
        }

        if (isCompletionBlocked(taskId)) {
            alert("Blocked: A shielded task in this hierarchy requires all its subtasks to be completely finished first.");
            return;
        }

        if (task.ai_locked) {
            openAuditModal(task, triggerRenderFn);
            return;
        }

        cascadeTaskStatus(taskId, 'completed', new Date().toISOString());
        startGraceCompletionTimer(taskId, triggerRenderFn);
        SoundFX.playComplete();
        saveStorageAndPush();
        if (typeof triggerRenderFn === 'function') triggerRenderFn();
    }

    function deleteTask(taskId, triggerRenderFn) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.ai_locked && !isBypassActiveSafe()) {
            alert('Blocked: AI-locked tasks cannot be deleted without an active Emergency Bypass.');
            return;
        }

        if (confirm(`Delete "${task.title}" and any associated subtasks?`)) {
            function markTrash(id) {
                const target = tasks.find(t => t.id === id);
                if (target) target.status = 'trash';
                tasks.filter(t => t.parent_id === id).forEach(k => markTrash(k.id));
            }
            markTrash(taskId);
            saveStorageAndPush();
            if (typeof triggerRenderFn === 'function') triggerRenderFn();
        }
    }

    // =========================================================================
    // Modal Tag Cloud & Priority Selectors
    // =========================================================================
    function renderModalTagCloud(containerId, activeSet) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const globalTags = getGlobalTags();

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
            saveGlobalTag(val);
            activeSet.add(val);
            input.value = '';
            renderModalTagCloud(containerId, activeSet);
        }
    }

    function renderModalPriorityCloud(containerId, isEditModal) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const globalPriorities = getGlobalPriorities();

        globalPriorities.forEach(p => {
            const pill = document.createElement('span');
            pill.className = 'priority-select-pill';
            const isSelected = isEditModal ? (editModalSelectedPriority === p.id) : (createModalSelectedPriority === p.id);

            if (isSelected) {
                pill.classList.add('selected');
                pill.style.color = p.color;
            }

            pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${p.color};"></span> ${p.name}`;

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
    // Filter Popover Cloud Rendering
    // =========================================================================
    function renderFilterClouds() {
        const pCloud = document.getElementById('filterPriorityCloud');
        if (pCloud) {
            pCloud.innerHTML = '';
            getGlobalPriorities().forEach(p => {
                const pill = document.createElement('span');
                pill.className = 'filter-pill';
                if (draftFilters.priorities.has(p.id)) {
                    pill.classList.add('selected-prio');
                    pill.style.color = p.color;
                }
                pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${p.color};"></span> ${p.name}`;
                pill.addEventListener('click', () => {
                    if (draftFilters.priorities.has(p.id)) draftFilters.priorities.delete(p.id);
                    else draftFilters.priorities.add(p.id);
                    renderFilterClouds();
                });
                pCloud.appendChild(pill);
            });
        }

        const tCloud = document.getElementById('filterTagCloud');
        if (tCloud) {
            tCloud.innerHTML = '';
            getGlobalTags().forEach(tag => {
                const pill = document.createElement('span');
                pill.className = 'filter-pill';
                if (draftFilters.tags.has(tag)) pill.classList.add('selected');
                pill.textContent = tag;
                pill.addEventListener('click', () => {
                    if (draftFilters.tags.has(tag)) draftFilters.tags.delete(tag);
                    else draftFilters.tags.add(tag);
                    renderFilterClouds();
                });
                tCloud.appendChild(pill);
            });
        }
    }

    // =========================================================================
    // Proof Audit Modal Engine
    // =========================================================================
    function openAuditModal(task, triggerRenderFn) {
        pendingAuditTaskId = task.id;
        const auditModal = document.getElementById('auditModal');
        const auditTaskTitle = document.getElementById('auditTaskTitleDisplay');
        const auditCriteria = document.getElementById('auditCriteriaDisplay');
        const auditImage = document.getElementById('auditImageInput');
        const auditContext = document.getElementById('auditContextInput');
        const auditFeedback = document.getElementById('auditFeedbackContainer');
        const submitProofBtn = document.getElementById('submitProofBtn');

        if (auditTaskTitle) auditTaskTitle.textContent = task.title;
        if (auditCriteria) auditCriteria.innerHTML = `<strong>Required Criteria &lt;PC&gt;:</strong> ${task.proof_criteria || 'General confirmation of task completion.'}`;
        if (auditImage) auditImage.value = '';
        if (auditContext) auditContext.value = '';
        if (auditFeedback) auditFeedback.style.display = 'none';
        if (submitProofBtn) {
            submitProofBtn.disabled = false;
            submitProofBtn.textContent = 'Submit Proof';
        }
        if (auditModal) auditModal.classList.add('open');
        auditModal._triggerRenderFn = triggerRenderFn;
    }

    // =========================================================================
    // Task Detail / Edit Modal Engine
    // =========================================================================
    function openTaskDetailModal(taskId, triggerRenderFn) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        activeDetailTaskId = taskId;

        const isBypassActive = isBypassActiveSafe();
        const isLocked = Boolean(task.ai_locked);

        const taskDetailModal = document.getElementById('taskDetailModal');
        const editTaskTitle = document.getElementById('editTaskTitle');
        const editTaskDesc = document.getElementById('editTaskDesc');
        const editTaskDueDate = document.getElementById('editTaskDueDate');
        const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
        const editStrictPrereqCheckbox = document.getElementById('editStrictPrereqCheckbox');
        const editPrerequisiteBoxContainer = document.getElementById('editPrerequisiteBoxContainer');
        const editCriteriaBoxContainer = document.getElementById('editCriteriaBoxContainer');
        const editTaskCriteria = document.getElementById('editTaskCriteria');
        const detailSubtasksList = document.getElementById('detailSubtasksList');
        const detailLockStatusBadge = document.getElementById('detailLockStatusBadge');
        const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');

        const titleH = document.getElementById('detailTaskTitleHeader');
        if (titleH) titleH.textContent = task.title;
        if (editTaskTitle) editTaskTitle.value = task.title || '';
        if (editTaskDesc) editTaskDesc.value = task.description || '';
        if (editTaskDueDate) editTaskDueDate.value = task.due_date === 'today' ? new Date().toISOString().split('T')[0] : (task.due_date || '');

        editModalSelectedTags.clear();
        (task.tags || []).forEach(t => editModalSelectedTags.add(t));
        editModalSelectedPriority = task.priority_id || null;

        renderModalTagCloud('editTagCloud', editModalSelectedTags);
        renderModalPriorityCloud('editPriorityCloud', true);

        if (editAiLockCheckbox) editAiLockCheckbox.checked = isLocked;
        if (editStrictPrereqCheckbox) editStrictPrereqCheckbox.checked = Boolean(task.strict_prerequisites);

        if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = isLocked ? 'block' : 'none';
        if (editPrerequisiteBoxContainer) editPrerequisiteBoxContainer.style.display = isLocked ? 'block' : 'none';

        const cannotModifyLocked = isLocked && !isBypassActive;

        if (editTaskTitle) editTaskTitle.disabled = cannotModifyLocked;
        if (editTaskDueDate) editTaskDueDate.disabled = cannotModifyLocked;
        if (editAiLockCheckbox) editAiLockCheckbox.disabled = cannotModifyLocked;
        if (editStrictPrereqCheckbox) editStrictPrereqCheckbox.disabled = cannotModifyLocked;
        if (editTaskCriteria) {
            editTaskCriteria.disabled = cannotModifyLocked;
            editTaskCriteria.value = task.proof_criteria || '';
        }
        if (deleteFromDetailBtn) deleteFromDetailBtn.disabled = cannotModifyLocked;

        if (detailLockStatusBadge) {
            if (isLocked) {
                detailLockStatusBadge.innerHTML = isBypassActive
                    ? '<span class="tag-chip" style="background:#451a03;color:#fde68a;">Bypass Active</span>'
                    : '<span class="ai-badge">🔒 Locked</span>';
            } else {
                detailLockStatusBadge.innerHTML = '<span class="tag-chip">Standard</span>';
            }
        }

        if (detailSubtasksList) {
            detailSubtasksList.innerHTML = '';
            const directChildren = tasks.filter(t => t.parent_id === taskId && t.status !== 'trash');
            const sortedChildren = sortTasks([...directChildren]);

            if (sortedChildren.length === 0) {
                detailSubtasksList.innerHTML = '<li style="font-size: 0.825rem; color: var(--text-muted); padding: 4px 0;">No subtasks yet.</li>';
            } else {
                sortedChildren.forEach(child => {
                    const sLi = document.createElement('li');
                    sLi.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-color); font-size: 0.85rem;';

                    let cBadges = '';
                    if (child.ai_locked) cBadges += '<span class="ai-badge">🔒 AI</span> ';
                    if (child.strict_prerequisites) cBadges += '<span class="ai-badge" style="background:#451a03; color:#fde68a; border-color:#78350f;">🛡️</span>';

                    sLi.innerHTML = `
                        <span>${child.status === 'completed' ? '✓ ' : ''}${child.title} ${cBadges}</span>
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

        if (taskDetailModal) {
            taskDetailModal.classList.add('open');
            taskDetailModal._triggerRenderFn = triggerRenderFn;
        }
    }

    // =========================================================================
    // Task Creation Modal Launcher
    // =========================================================================
    function openTaskCreationModal(parentId = null, titleLabel = 'Create New Task', defaultDueDate = '') {
        const form = document.getElementById('taskCreateForm');
        if (form) form.reset();

        const pIdField = document.getElementById('creationParentId');
        if (pIdField) pIdField.value = parentId || '';

        const modalTitle = document.getElementById('addTaskModalTitle');
        if (modalTitle) modalTitle.textContent = titleLabel;

        const critBox = document.getElementById('criteriaBoxContainer');
        if (critBox) critBox.style.display = 'none';

        const prereqBox = document.getElementById('prerequisiteBoxContainer');
        if (prereqBox) prereqBox.style.display = 'none';

        const subtaskList = document.getElementById('subtaskBuilderList');
        if (subtaskList) subtaskList.innerHTML = '';

        const dueIn = document.getElementById('taskDueDateInput');
        if (dueIn) dueIn.value = defaultDueDate;

        createModalSelectedTags.clear();
        createModalSelectedPriority = getLowestPriorityId();

        renderModalTagCloud('createTagCloud', createModalSelectedTags);
        renderModalPriorityCloud('createPriorityCloud', false);

        criteriaValidationState = { validated: false, score: 0, isTemplate: false };
        const feedback = document.getElementById('criteriaFeedbackBox');
        if (feedback) {
            feedback.style.display = 'none';
            feedback.className = 'criteria-feedback-box';
            feedback.innerHTML = '';
        }

        const modal = document.getElementById('addTaskModal');
        if (modal) modal.classList.add('open');
    }

    // =========================================================================
    // Shared Event Bindings Initializer
    // =========================================================================
    function initSharedUI(triggerRenderFn) {
        // 1. Navigation Sidebar Drawer
        const sidebarDrawer = document.getElementById('sidebarDrawer');
        const drawerBackdrop = document.getElementById('drawerBackdrop');
        const openDrawerBtn = document.getElementById('openDrawerBtn');

        if (openDrawerBtn && sidebarDrawer && drawerBackdrop) {
            openDrawerBtn.addEventListener('click', () => {
                sidebarDrawer.classList.add('open');
                drawerBackdrop.classList.add('open');
            });
            drawerBackdrop.addEventListener('click', () => {
                sidebarDrawer.classList.remove('open');
                drawerBackdrop.classList.remove('open');
            });
        }

        // 2. Copilot Drawer
        const copilotDrawer = document.getElementById('copilotDrawer');
        const copilotBackdrop = document.getElementById('copilotBackdrop');
        const openCopilotNavBtn = document.getElementById('openCopilotNavBtn');
        const openCopilotFabBtn = document.getElementById('openCopilotFabBtn');
        const closeCopilotBtn = document.getElementById('closeCopilotBtn');

        function openCopilot() {
            if (copilotDrawer && copilotBackdrop) {
                copilotDrawer.classList.add('open');
                copilotBackdrop.classList.add('open');
            }
        }
        function closeCopilot() {
            if (copilotDrawer && copilotBackdrop) {
                copilotDrawer.classList.remove('open');
                copilotBackdrop.classList.remove('open');
            }
        }

        if (openCopilotNavBtn) openCopilotNavBtn.addEventListener('click', openCopilot);
        if (openCopilotFabBtn) openCopilotFabBtn.addEventListener('click', openCopilot);
        if (closeCopilotBtn) closeCopilotBtn.addEventListener('click', closeCopilot);
        if (copilotBackdrop) copilotBackdrop.addEventListener('click', closeCopilot);

        const startCopilotBtn = document.getElementById('startCopilotBtn');
        const copilotStandbyView = document.getElementById('copilotStandbyView');
        const copilotChatView = document.getElementById('copilotChatView');

        if (startCopilotBtn) {
            startCopilotBtn.addEventListener('click', () => {
                if (copilotStandbyView) copilotStandbyView.style.display = 'none';
                if (copilotChatView) copilotChatView.classList.add('active');
                const input = document.getElementById('copilotInput');
                if (input) input.focus();
            });
        }

        // 3. Filter Popover Bindings
        const openFilterModalBtn = document.getElementById('openFilterModalBtn');
        if (openFilterModalBtn) {
            openFilterModalBtn.addEventListener('click', () => {
                draftFilters.tags = new Set(activeFilters.tags);
                draftFilters.priorities = new Set(activeFilters.priorities);
                renderFilterClouds();
                const modal = document.getElementById('filterModal');
                if (modal) modal.classList.add('open');
            });
        }

        const closeFilterModalBtn = document.getElementById('closeFilterModalBtn');
        if (closeFilterModalBtn) {
            closeFilterModalBtn.addEventListener('click', () => {
                const modal = document.getElementById('filterModal');
                if (modal) modal.classList.remove('open');
            });
        }

        const clearFiltersBtn = document.getElementById('clearFiltersBtn');
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', () => {
                draftFilters.tags.clear();
                draftFilters.priorities.clear();
                renderFilterClouds();
            });
        }

        const applyFiltersBtn = document.getElementById('applyFiltersBtn');
        if (applyFiltersBtn) {
            applyFiltersBtn.addEventListener('click', () => {
                activeFilters.tags = new Set(draftFilters.tags);
                activeFilters.priorities = new Set(draftFilters.priorities);

                const hasFilters = activeFilters.tags.size > 0 || activeFilters.priorities.size > 0;
                const dot = document.getElementById('filterActiveDot');
                if (dot) dot.style.display = hasFilters ? 'block' : 'none';

                const modal = document.getElementById('filterModal');
                if (modal) modal.classList.remove('open');
                if (typeof triggerRenderFn === 'function') triggerRenderFn();
            });
        }

        // 4. Quick Tag Add Buttons
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

        // 5. Creation Modal Pre-Flight Verification & Subtask Fields
        const aiLockCheckbox = document.getElementById('aiLockCheckbox');
        if (aiLockCheckbox) {
            aiLockCheckbox.addEventListener('change', () => {
                const cBox = document.getElementById('criteriaBoxContainer');
                const pBox = document.getElementById('prerequisiteBoxContainer');
                if (cBox) cBox.style.display = aiLockCheckbox.checked ? 'block' : 'none';
                if (pBox) pBox.style.display = aiLockCheckbox.checked ? 'block' : 'none';
            });
        }

        const addSubtaskFieldBtn = document.getElementById('addSubtaskFieldBtn');
        const subtaskBuilderList = document.getElementById('subtaskBuilderList');
        if (addSubtaskFieldBtn && subtaskBuilderList) {
            addSubtaskFieldBtn.addEventListener('click', () => {
                const div = document.createElement('div');
                div.className = 'subtask-builder-item';
                div.innerHTML = `
                    <input type="text" class="subtask-input-title" placeholder="Quick subtask title..." style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-color);" required>
                    <button type="button" class="action-del-btn" onclick="this.parentElement.remove()">✕</button>
                `;
                subtaskBuilderList.appendChild(div);
            });
        }

        const closeAddTaskModalBtn = document.getElementById('closeAddTaskModalBtn');
        const addTaskModal = document.getElementById('addTaskModal');
        if (closeAddTaskModalBtn && addTaskModal) {
            closeAddTaskModalBtn.addEventListener('click', () => {
                addTaskModal.classList.remove('open');
            });
        }

        const taskCreateForm = document.getElementById('taskCreateForm');
        if (taskCreateForm) {
            taskCreateForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const title = document.getElementById('taskTitleInput')?.value.trim() || '';
                const desc = document.getElementById('taskDescInput')?.value.trim() || '';
                const dueDate = document.getElementById('taskDueDateInput')?.value || '';
                const isAi = Boolean(document.getElementById('aiLockCheckbox')?.checked);
                const isStrictPrereq = isAi ? Boolean(document.getElementById('strictPrereqCheckbox')?.checked) : false;
                const criteria = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                const parentId = document.getElementById('creationParentId')?.value || null;

                if (!title) return;

                if (isAi && isStrictCriteriaModeEnabled()) {
                    if (!criteriaValidationState.validated || criteriaValidationState.score < 7) {
                        alert('Criteria validation required: Please click "Validate Criteria" and ensure a score of at least 7/10 before creating an AI-locked task.');
                        return;
                    }
                }

                if (isAi) {
                    const confirmed = confirm(
                        "⚠️ IRREVOCABLE TASK WARNING ⚠️\n\n" +
                        "Once created, AI-Checked tasks CANNOT be edited (except description/tags) and CANNOT be deleted.\n\n" +
                        "If phone lock is active, your device stays locked until verified by AI proof.\n\n" +
                        "Proceed with creation?"
                    );
                    if (!confirmed) return;
                }

                const newTaskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
                const newTask = {
                    id: newTaskId,
                    parent_id: parentId,
                    title: title,
                    description: desc,
                    tags: Array.from(createModalSelectedTags),
                    priority_id: createModalSelectedPriority,
                    status: 'active',
                    due_date: dueDate,
                    ai_locked: isAi,
                    proof_criteria: isAi ? criteria : '',
                    strict_prerequisites: isStrictPrereq,
                    created_at: new Date().toISOString(),
                    completed_at: null
                };
                tasks.push(newTask);

                if (subtaskBuilderList) {
                    const quickSubtaskInputs = subtaskBuilderList.querySelectorAll('.subtask-input-title');
                    quickSubtaskInputs.forEach(input => {
                        const subTitle = input.value.trim();
                        if (subTitle) {
                            tasks.push({
                                id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                                parent_id: newTaskId,
                                title: subTitle,
                                description: '',
                                tags: [],
                                priority_id: getLowestPriorityId(),
                                status: 'active',
                                due_date: '',
                                ai_locked: false,
                                proof_criteria: '',
                                strict_prerequisites: false,
                                created_at: new Date().toISOString(),
                                completed_at: null
                            });
                        }
                    });
                }

                saveStorageAndPush();
                if (addTaskModal) addTaskModal.classList.remove('open');
                if (typeof triggerRenderFn === 'function') triggerRenderFn();
            });
        }

        // 6. Task Detail Modal Actions
        const taskDetailModal = document.getElementById('taskDetailModal');
        const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
        if (closeDetailModalBtn && taskDetailModal) {
            closeDetailModalBtn.addEventListener('click', () => {
                taskDetailModal.classList.remove('open');
                activeDetailTaskId = null;
            });
        }

        const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
        if (editAiLockCheckbox) {
            editAiLockCheckbox.addEventListener('change', () => {
                const cBox = document.getElementById('editCriteriaBoxContainer');
                const pBox = document.getElementById('editPrerequisiteBoxContainer');
                if (cBox) cBox.style.display = editAiLockCheckbox.checked ? 'block' : 'none';
                if (pBox) pBox.style.display = editAiLockCheckbox.checked ? 'block' : 'none';
            });
        }

        const saveTaskDetailsBtn = document.getElementById('saveTaskDetailsBtn');
        if (saveTaskDetailsBtn) {
            saveTaskDetailsBtn.addEventListener('click', () => {
                if (!activeDetailTaskId) return;

                loadStorage();
                const task = tasks.find(t => t.id === activeDetailTaskId);
                if (!task) {
                    alert('This task was removed in a background synchronization.');
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    activeDetailTaskId = null;
                    if (typeof triggerRenderFn === 'function') triggerRenderFn();
                    return;
                }

                const isBypassActive = isBypassActiveSafe();
                const willBeAiLocked = Boolean(document.getElementById('editAiLockCheckbox')?.checked);
                const willBeStrict = willBeAiLocked ? Boolean(document.getElementById('editStrictPrereqCheckbox')?.checked) : false;

                if (!task.ai_locked && willBeAiLocked) {
                    const confirmed = confirm(
                        "⚠️ IRREVOCABLE TASK WARNING ⚠️\n\n" +
                        "Enabling AI Proof on this task is permanent.\n" +
                        "Once saved, this task cannot be un-checked, criteria cannot be changed, and it CANNOT be deleted without an Emergency Bypass.\n\n" +
                        "Do you want to permanently lock this task?"
                    );
                    if (!confirmed) return;
                }

                task.description = document.getElementById('editTaskDesc')?.value.trim() || '';
                task.tags = Array.from(editModalSelectedTags);
                task.priority_id = editModalSelectedPriority;

                if (!task.ai_locked || isBypassActive) {
                    task.title = document.getElementById('editTaskTitle')?.value.trim() || task.title;
                    task.due_date = document.getElementById('editTaskDueDate')?.value || '';
                    task.ai_locked = willBeAiLocked;
                    task.strict_prerequisites = willBeStrict;
                    task.proof_criteria = willBeAiLocked ? (document.getElementById('editTaskCriteria')?.value.trim() || '') : '';
                }

                saveStorageAndPush();
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                activeDetailTaskId = null;
                if (typeof triggerRenderFn === 'function') triggerRenderFn();
            });
        }

        const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
        if (deleteFromDetailBtn) {
            deleteFromDetailBtn.addEventListener('click', () => {
                if (!activeDetailTaskId) return;
                deleteTask(activeDetailTaskId, triggerRenderFn);
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                activeDetailTaskId = null;
            });
        }

        const openChildAddModalBtn = document.getElementById('openChildAddModalBtn');
        if (openChildAddModalBtn) {
            openChildAddModalBtn.addEventListener('click', () => {
                if (!activeDetailTaskId) return;
                const parentTask = tasks.find(t => t.id === activeDetailTaskId);
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                activeDetailTaskId = null;
                openTaskCreationModal(parentTask.id, `Add Subtask to "${parentTask.title}"`);
            });
        }

        // 7. Audit Modal Event Listeners
        const auditModal = document.getElementById('auditModal');
        const closeAuditModalBtn = document.getElementById('closeAuditModalBtn');
        if (closeAuditModalBtn && auditModal) {
            closeAuditModalBtn.addEventListener('click', () => {
                auditModal.classList.remove('open');
                pendingAuditTaskId = null;
            });
        }

        const submitProofBtn = document.getElementById('submitProofBtn');
        if (submitProofBtn) {
            submitProofBtn.addEventListener('click', async () => {
                if (!pendingAuditTaskId) return;
                const task = tasks.find(t => t.id === pendingAuditTaskId);
                if (!task) return;

                const file = document.getElementById('auditImageInput')?.files[0];
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

                let result = { success: false, error: 'Audit engine missing' };
                if (window.TaskitatorEngine?.AuditEngine?.verifyProof) {
                    result = await TaskitatorEngine.AuditEngine.verifyProof({
                        file: file,
                        taskTitle: task.title,
                        criteria: task.proof_criteria,
                        userContext: document.getElementById('auditContextInput')?.value.trim() || ''
                    });
                }

                if (!result.success) {
                    submitProofBtn.disabled = false;
                    submitProofBtn.textContent = 'Submit Proof';
                    if (auditFeedback) {
                        auditFeedback.className = 'audit-critique-box';
                        auditFeedback.style.display = 'block';
                        auditFeedback.innerHTML = `<strong>Verification Halted:</strong> ${result.error}`;
                    }
                    return;
                }

                if (result.approved) {
                    task.verified_model = result.model_used;
                    cascadeTaskStatus(pendingAuditTaskId, 'completed', new Date().toISOString());
                    SoundFX.playSuccessAudit();
                    saveStorageAndPush();
                    if (auditModal) auditModal.classList.remove('open');
                    pendingAuditTaskId = null;
                    if (typeof triggerRenderFn === 'function') triggerRenderFn();
                } else {
                    submitProofBtn.disabled = false;
                    submitProofBtn.textContent = 'Retry Submission';
                    if (auditFeedback) {
                        auditFeedback.className = 'audit-critique-box';
                        auditFeedback.style.display = 'block';
                        auditFeedback.innerHTML = `<strong>Verdict: ${result.verdict.toUpperCase()}</strong><br>${result.critique}`;
                    }
                }
            });
        }

        // 8. Emergency Bypass Listeners
        const emergencyTriggerBtn = document.getElementById('emergencyTriggerBtn');
        const emergencyConfirmModal = document.getElementById('emergencyConfirmModal');
        const cancelEmergencyBtn = document.getElementById('cancelEmergencyBtn');
        const confirmEmergencyBtn = document.getElementById('confirmEmergencyBtn');
        const emergencyInfoBtn = document.getElementById('emergencyInfoBtn');
        const emergencyInfoModal = document.getElementById('emergencyInfoModal');
        const closeEmergencyInfoModalBtn = document.getElementById('closeEmergencyInfoModalBtn');

        if (emergencyTriggerBtn) {
            emergencyTriggerBtn.addEventListener('click', () => {
                if (isBypassActiveSafe()) {
                    alert('Emergency bypass is already active.');
                    return;
                }
                const state = getEmergencyStateSafe();
                if (state.uses_left <= 0) {
                    alert('All 4 emergency bypass uses for this week have been exhausted.');
                    return;
                }
                const remUses = document.getElementById('emergencyModalRemainingUses');
                if (remUses) remUses.textContent = `Remaining tokens this week: ${state.uses_left}/4`;
                if (emergencyConfirmModal) emergencyConfirmModal.classList.add('open');
            });
        }

        if (cancelEmergencyBtn && emergencyConfirmModal) {
            cancelEmergencyBtn.addEventListener('click', () => {
                emergencyConfirmModal.classList.remove('open');
            });
        }

        if (confirmEmergencyBtn && emergencyConfirmModal) {
            confirmEmergencyBtn.addEventListener('click', () => {
                let res = { success: false, error: 'Emergency manager uninitialized' };
                if (window.TaskitatorEngine?.EmergencyManager?.activateBypass) {
                    res = TaskitatorEngine.EmergencyManager.activateBypass();
                }
                emergencyConfirmModal.classList.remove('open');
                if (res.success) {
                    updateEmergencyUI(triggerRenderFn);
                } else {
                    alert(res.error);
                }
            });
        }

        if (emergencyInfoBtn && emergencyInfoModal) {
            emergencyInfoBtn.addEventListener('click', () => {
                emergencyInfoModal.classList.add('open');
            });
        }

        if (closeEmergencyInfoModalBtn && emergencyInfoModal) {
            closeEmergencyInfoModalBtn.addEventListener('click', () => {
                emergencyInfoModal.classList.remove('open');
            });
        }
    }

    function updateEmergencyUI(triggerRenderFn) {
        const banner = document.getElementById('activeEmergencyBanner');
        const countDisplay = document.getElementById('emergencyCountDisplay');

        const state = getEmergencyStateSafe();
        if (countDisplay) countDisplay.textContent = `${state.uses_left}/4`;

        if (isBypassActiveSafe()) {
            if (banner) banner.style.display = 'flex';
            clearInterval(emergencyTimerInterval);
            emergencyTimerInterval = setInterval(() => {
                let remaining = 0;
                if (window.TaskitatorEngine?.EmergencyManager?.getRemainingWindowSeconds) {
                    remaining = TaskitatorEngine.EmergencyManager.getRemainingWindowSeconds();
                }
                if (remaining <= 0) {
                    clearInterval(emergencyTimerInterval);
                    updateEmergencyUI(triggerRenderFn);
                    return;
                }
                const m = Math.floor(remaining / 60);
                const s = remaining % 60;
                const timerEl = document.getElementById('emergencyCountdownTimer');
                if (timerEl) {
                    timerEl.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                }
            }, 1000);
        } else {
            if (banner) banner.style.display = 'none';
            clearInterval(emergencyTimerInterval);
        }

        if (typeof triggerRenderFn === 'function') triggerRenderFn();
    }

    // =========================================================================
    // Public Module API
    // =========================================================================
    return {
        // Data & State
        getTasks: () => tasks,
        getCollapsedNodes: () => collapsedNodes,
        getActiveFilters: () => activeFilters,
        getPendingGraceCompletions: () => pendingGraceCompletions,
        getActiveDetailTaskId: () => activeDetailTaskId,

        // Core Actions
        loadStorage,
        saveStorageAndPush,
        initSyncIndicator,
        updateSyncDot,
        updateEmergencyUI,
        initSharedUI,

        // Hierarchy, Sorting & State
        sortTasks,
        getAllDescendants,
        hasUncompletedDescendant,
        isCompletionBlocked,
        cascadeTaskStatus,
        handleTaskCompletion,
        undoTaskCompletion,
        deleteTask,

        // Modals & UI
        openTaskCreationModal,
        openTaskDetailModal,
        openAuditModal,
        renderModalTagCloud,
        renderModalPriorityCloud,
        handleQuickAddTag,
        renderFilterClouds,

        // Registries
        getGlobalTags,
        getGlobalPriorities,
        saveGlobalTag,
        getLowestPriorityId,

        // Audio
        SoundFX
    };
})();

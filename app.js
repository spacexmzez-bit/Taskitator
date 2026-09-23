/**
 * Taskitator Unified Application Engine (app.js)
 * Manages view routing (#today / #general), unified task trees,
 * projects registry, break UI, proofs, emergency quotas, and persistent filters.
 */

window.TaskitatorApp = (() => {
    // =========================================================================
    // Storage Keys & State
    // =========================================================================
    const TASKS_KEY = 'taskitator_tasks';
    const COLLAPSED_STATE_KEY = 'taskitator_collapsed_nodes';
    const SETTINGS_KEY = 'taskitator_settings';
    const PROJECTS_KEY = 'taskitator_projects';

    let currentView = 'today'; // 'today' | 'general'
    let tasks = [];
    let collapsedNodes = new Set();
    let pendingAuditTaskId = null;
    let activeDetailTaskId = null;
    let emergencyTimerInterval = null;

    let criteriaValidationState = { validated: false, score: 0, isTemplate: false };
    let cachedTemplates = null;
    const pendingGraceCompletions = new Map();

    // Active Filter State (Tags, Priorities, Projects)
    const activeFilters = { tags: new Set(), priorities: new Set(), projects: new Set() };
    const draftFilters = { tags: new Set(), priorities: new Set(), projects: new Set() };

    // Modal Selection State
    const createModalSelectedTags = new Set();
    let createModalSelectedPriority = null;
    let createModalSelectedProject = 'inbox';

    const editModalSelectedTags = new Set();
    let editModalSelectedPriority = null;
    let editModalSelectedProject = 'inbox';

    // Default Registries
    const DEFAULT_TAGS = ['study', 'work', 'personal'];
    const DEFAULT_PRIORITIES = [
        { id: 'prio_high', name: 'High', color: '#ef4444', rank: 1 },
        { id: 'prio_med', name: 'Medium', color: '#eab308', rank: 2 },
        { id: 'prio_low', name: 'Low', color: '#22c55e', rank: 3 }
    ];
    const DEFAULT_PROJECTS = [
        { id: 'inbox', name: 'Inbox', color: '#94a3b8', icon: '📥', is_default: true }
    ];

    // Curated Project Icon Palettes for Project Customization
    const PROJECT_ICONS = ['📥', '📚', '💼', '⚡', '🔬', '🏥', '🎯', '💻', '📝', '🎨', '🚀', '🧠', '🏋️', '💰', '🛠️', '🌐'];
    const PROJECT_COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f97316'];

    // =========================================================================
    // Web Audio API Synthesizer
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
    // Projects Registry CRUD & Cascades
    // =========================================================================
    function getGlobalProjects() {
        try {
            const raw = localStorage.getItem(PROJECTS_KEY);
            if (!raw) {
                localStorage.setItem(PROJECTS_KEY, JSON.stringify(DEFAULT_PROJECTS));
                return [...DEFAULT_PROJECTS];
            }
            const list = JSON.parse(raw);
            if (!Array.isArray(list) || list.length === 0 || !list.some(p => p.id === 'inbox')) {
                const clean = Array.isArray(list) ? list.filter(p => p.id !== 'inbox') : [];
                clean.unshift(DEFAULT_PROJECTS[0]);
                localStorage.setItem(PROJECTS_KEY, JSON.stringify(clean));
                return clean;
            }
            return list;
        } catch (e) {
            return [...DEFAULT_PROJECTS];
        }
    }

    function saveProject(projectObj) {
        if (!projectObj || !projectObj.name) return { success: false, error: 'Project name required' };
        const projects = getGlobalProjects();

        if (projectObj.id) {
            const idx = projects.findIndex(p => p.id === projectObj.id);
            if (idx !== -1) {
                projects[idx] = { ...projects[idx], ...projectObj };
            } else {
                projects.push(projectObj);
            }
        } else {
            const newId = 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
            projects.push({
                id: newId,
                name: projectObj.name.trim(),
                color: projectObj.color || '#3b82f6',
                icon: projectObj.icon || '📁',
                is_default: false
            });
        }

        localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
        if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
            SyncEngine.markLocalModified();
        }
        return { success: true };
    }

    function deleteProjectWithCascade(projectId, cascadeMode = 'inbox', targetProjectId = 'inbox') {
        if (projectId === 'inbox') return { success: false, error: 'Cannot delete default Inbox project' };

        let projects = getGlobalProjects();
        projects = projects.filter(p => p.id !== projectId);
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));

        loadStorage();

        tasks.forEach(t => {
            if (t.project_id === projectId) {
                if (cascadeMode === 'trash') {
                    t.status = 'trash';
                    if (window.ExemplarStore) window.ExemplarStore.deleteExemplar(t.id);
                } else if (cascadeMode === 'reassign' && targetProjectId) {
                    t.project_id = targetProjectId;
                } else {
                    t.project_id = 'inbox';
                }
            }
        });

        saveStorageAndPush();
        return { success: true };
    }

    // =========================================================================
    // Tags & Priorities Registries
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
    // Storage & Sync Pipeline
    // =========================================================================
    function loadStorage() {
        try {
            tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
            let dirty = false;
            tasks.forEach(t => {
                if (!t.project_id) {
                    t.project_id = 'inbox';
                    dirty = true;
                }
            });
            if (dirty) {
                localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
            }
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

        if (newStatus === 'completed' && window.ExemplarStore) {
            window.ExemplarStore.deleteExemplar(target.id);
        }

        function cascadeChildren(parentId) {
            tasks.filter(t => t.parent_id === parentId && t.status !== 'trash').forEach(child => {
                child.status = newStatus;
                child.completed_at = timestamp;
                if (newStatus === 'completed' && window.ExemplarStore) {
                    window.ExemplarStore.deleteExemplar(child.id);
                }
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
            const el = document.getElementById(`undoTimerSec_${taskId}`);
            if (el) el.textContent = remaining;
            if (remaining <= 0) {
                clearInterval(intervalId);
            }
        }, 1000);

        const timerId = setTimeout(() => {
            clearInterval(intervalId);
            pendingGraceCompletions.delete(taskId);
            if (typeof triggerRenderFn === 'function') triggerRenderFn();
            else renderUnifiedView();
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
        else renderUnifiedView();
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
            else renderUnifiedView();
            return;
        }

        if (isCompletionBlocked(taskId)) {
            alert("Blocked: A shielded task in this hierarchy requires all its subtasks to be completely finished first.");
            return;
        }

        if (task.ai_locked) {
            openAuditModal(task);
            return;
        }

        cascadeTaskStatus(taskId, 'completed', new Date().toISOString());
        startGraceCompletionTimer(taskId, triggerRenderFn);
        SoundFX.playComplete();
        saveStorageAndPush();
        if (typeof triggerRenderFn === 'function') triggerRenderFn();
        else renderUnifiedView();
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
                if (target) {
                    target.status = 'trash';
                    if (window.ExemplarStore) window.ExemplarStore.deleteExemplar(id);
                }
                tasks.filter(t => t.parent_id === id).forEach(k => markTrash(k.id));
            }
            markTrash(taskId);
            saveStorageAndPush();
            if (typeof triggerRenderFn === 'function') triggerRenderFn();
            else renderUnifiedView();
        }
    }

    // =========================================================================
    // Modal Selectors: Tags, Priorities & Projects
    // =========================================================================
    function renderModalProjectCloud(containerId, isEditModal) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const globalProjects = getGlobalProjects();

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

            pill.innerHTML = `<span>${proj.icon}</span> <span>${proj.name}</span>`;

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

    function renderFilterClouds() {
        const projCloud = document.getElementById('filterProjectCloud');
        if (projCloud) {
            projCloud.innerHTML = '';
            getGlobalProjects().forEach(p => {
                const pill = document.createElement('span');
                pill.className = 'filter-pill';
                if (draftFilters.projects.has(p.id)) {
                    pill.classList.add('selected-prio');
                    pill.style.color = p.color;
                }
                pill.innerHTML = `<span>${p.icon}</span> <span>${p.name}</span>`;
                pill.addEventListener('click', () => {
                    if (draftFilters.projects.has(p.id)) draftFilters.projects.delete(p.id);
                    else draftFilters.projects.add(p.id);
                    renderFilterClouds();
                });
                projCloud.appendChild(pill);
            });
        }

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
    // Todoist-Style NLP Smart Creation Engine
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
            
            const match = textBeforeCaret.match(/(?:^|\s)([#!@][a-zA-Z0-9_.-]+)\s$/);
            if (!match) return;
            
            const rawToken = match[1];
            const prefix = rawToken[0];
            const value = rawToken.substring(1).toLowerCase();
            
            let chipData = null;
            
            if (prefix === '!') {
                const prios = getGlobalPriorities();
                let pId = null;
                if (['p1', 'high'].includes(value)) pId = prios.find(p => p.rank === 1)?.id;
                else if (['p2', 'med', 'medium'].includes(value)) pId = prios.find(p => p.rank === 2)?.id;
                else if (['p3', 'low'].includes(value)) pId = prios.find(p => p.rank === 3)?.id;
                
                if (pId) {
                    const pObj = prios.find(p => p.id === pId);
                    chipData = {
                        html: `<span class="nlp-chip nlp-prio" contenteditable="false" data-type="prio" data-id="${pId}" data-raw="${rawToken}"><span class="priority-color-dot" style="background:${pObj.color}; width:8px; height:8px; display:inline-block; border-radius:50%; margin-right:4px;"></span>${pObj.name} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
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
                const projs = getGlobalProjects();
                const pObj = projs.find(p => p.name.replace(/\s+/g, '').toLowerCase() === value);
                if (pObj && pObj.id !== 'inbox') {
                    chipData = {
                        html: `<span class="nlp-chip nlp-proj" contenteditable="false" data-type="proj" data-id="${pObj.id}" data-raw="${rawToken}"><span>${pObj.icon}</span> ${pObj.name} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
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
                    html: `<span class="nlp-chip nlp-tag" contenteditable="false" data-type="tag" data-id="${value}" data-raw="${rawToken}"># ${value} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                    action: () => {
                        saveGlobalTag(value);
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
                
                if (type === 'prio') {
                    if (contextType === 'edit' && editModalSelectedPriority === id) {
                        editModalSelectedPriority = getLowestPriorityId();
                        renderModalPriorityCloud('editPriorityCloud', true);
                    } else if (contextType === 'create' && createModalSelectedPriority === id) {
                        createModalSelectedPriority = getLowestPriorityId();
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
                
                // Replace with literal text & non-breaking space to prevent re-triggering
                const textNode = document.createTextNode(raw + '\u00A0');
                chip.parentNode.replaceChild(textNode, chip);
                
                div.focus();
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(div);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
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
        
        let criteriaHtml = `<strong>Required Criteria &lt;PC&gt;:</strong> ${task.proof_criteria || 'General confirmation of task completion.'}`;
        
        // Append exemplar status
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
    async function openTaskDetailModal(taskId, triggerRenderFn) {
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
        const editExemplarChip = document.getElementById('editExemplarChip');

        const titleH = document.getElementById('detailTaskTitleHeader');
        if (titleH) titleH.textContent = task.title;
        
        if (editTaskTitle) {
            if (editTaskTitle.tagName === 'DIV') editTaskTitle.innerHTML = task.title || '';
            else editTaskTitle.value = task.title || '';
        }
        
        if (editTaskDesc) editTaskDesc.value = task.description || '';
        if (editTaskDueDate) editTaskDueDate.value = task.due_date === 'today' ? new Date().toISOString().split('T')[0] : (task.due_date || '');

        editModalSelectedTags.clear();
        (task.tags || []).forEach(t => editModalSelectedTags.add(t));
        editModalSelectedPriority = task.priority_id || null;
        editModalSelectedProject = task.project_id || 'inbox';

        renderModalTagCloud('editTagCloud', editModalSelectedTags);
        renderModalPriorityCloud('editPriorityCloud', true);
        renderModalProjectCloud('editProjectCloud', true);

        if (editAiLockCheckbox) editAiLockCheckbox.checked = isLocked;
        if (editStrictPrereqCheckbox) editStrictPrereqCheckbox.checked = Boolean(task.strict_prerequisites);

        if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = isLocked ? 'block' : 'none';
        if (editPrerequisiteBoxContainer) editPrerequisiteBoxContainer.style.display = isLocked ? 'block' : 'none';

        if (editExemplarChip && window.ExemplarStore) {
            const hasRef = await ExemplarStore.hasExemplar(task.id);
            editExemplarChip.style.display = (isLocked && hasRef) ? 'flex' : 'none';
        }

        const cannotModifyLocked = isLocked && !isBypassActive;

        if (editTaskTitle) editTaskTitle.contentEditable = cannotModifyLocked ? 'false' : 'true';
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
        if (dueIn) {
            dueIn.value = (currentView === 'today') ? new Date().toISOString().split('T')[0] : '';
        }
        
        // Reset Exemplar File UI
        const exemplarInput = document.getElementById('createExemplarInput');
        const exemplarChip = document.getElementById('createExemplarChip');
        const exemplarGuidance = document.getElementById('exemplarGuidanceNote');
        if (exemplarInput) exemplarInput.value = '';
        if (exemplarChip) exemplarChip.style.display = 'none';
        if (exemplarGuidance) exemplarGuidance.style.display = 'none';

        createModalSelectedTags.clear();
        createModalSelectedPriority = getLowestPriorityId();

        if (parentId) {
            const parentTask = tasks.find(t => t.id === parentId);
            createModalSelectedProject = parentTask ? parentTask.project_id : 'inbox';
        } else {
            createModalSelectedProject = preselectedProjectId || 'inbox';
        }

        renderModalTagCloud('createTagCloud', createModalSelectedTags);
        renderModalPriorityCloud('createPriorityCloud', false);
        renderModalProjectCloud('createProjectCloud', false);

        criteriaValidationState = { validated: false, score: 0, isTemplate: false };
        const feedback = document.getElementById('criteriaFeedbackBox');
        if (feedback) {
            feedback.style.display = 'none';
            feedback.className = 'criteria-feedback-box';
            feedback.innerHTML = '';
        }

        const modal = document.getElementById('addTaskModal');
        if (modal) {
            modal.classList.add('open');
            setTimeout(() => { if(titleEl) titleEl.focus(); }, 100);
        }
    }

    // =========================================================================
    // Break System UI Controller
    // =========================================================================
    const BreakUI = {
        pill: null,
        pillText: null,
        pillIcon: null,
        modal: null,
        rowsContainer: null,
        errorBox: null,
        saveBtn: null,
        addBtn: null,
        closeBtn: null,

        init() {
            this.pill = document.getElementById('breakStatusPill');
            this.pillText = document.getElementById('breakPillText');
            this.pillIcon = document.getElementById('breakPillIcon');
            this.modal = document.getElementById('breakModal');
            this.rowsContainer = document.getElementById('breakRowsContainer');
            this.errorBox = document.getElementById('breakModalError');
            this.saveBtn = document.getElementById('saveBreaksModalBtn');
            this.addBtn = document.getElementById('addBreakRowModalBtn');
            this.closeBtn = document.getElementById('closeBreakModalBtn');

            if (!this.pill || !this.modal) return;
            this.pill.addEventListener('click', () => this.openModal());
            if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.closeModal());
            if (this.addBtn) this.addBtn.addEventListener('click', () => this.addBreakRow());
            if (this.saveBtn) this.saveBtn.addEventListener('click', () => this.saveBreaks());
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.closeModal();
            });
            this.updateStatusPill();
            setInterval(() => this.updateStatusPill(), 30000);
        },

        updateStatusPill() {
            if (!this.pill) return;
            if (currentView !== 'today') {
                this.pill.style.display = 'none';
                return;
            }
            this.pill.style.display = 'inline-flex';

            const isWindowOpen = isSelectionWindowOpenSafe();
            const breaks = getTodayBreaksSafe();
            const now = new Date();
            const curMins = now.getHours() * 60 + now.getMinutes();

            this.pill.className = 'break-status-pill';

            const activeBreak = breaks.find(b => {
                if (!b.start || !b.end) return false;
                const [sH, sM] = b.start.split(':').map(Number);
                const [eH, eM] = b.end.split(':').map(Number);
                return curMins >= (sH * 60 + sM) && curMins <= (eH * 60 + eM);
            });

            if (activeBreak) {
                const [eH, eM] = activeBreak.end.split(':').map(Number);
                const minsLeft = (eH * 60 + eM) - curMins;
                this.pill.classList.add('active-break');
                if (this.pillIcon) this.pillIcon.textContent = '🟢';
                if (this.pillText) this.pillText.textContent = `${minsLeft}m left`;
                return;
            }

            const upcomingBreak = breaks
                .map(b => {
                    if (!b.start) return null;
                    const [sH, sM] = b.start.split(':').map(Number);
                    return { ...b, startMins: sH * 60 + sM };
                })
                .filter(b => b && b.startMins > curMins)
                .sort((a, b) => a.startMins - b.startMins)[0];

            if (upcomingBreak) {
                if (this.pillIcon) this.pillIcon.textContent = '☕';
                if (this.pillText) this.pillText.textContent = `Next: ${upcomingBreak.start}`;
                return;
            }

            if (isWindowOpen) {
                this.pill.classList.add('window-open');
                if (this.pillIcon) this.pillIcon.textContent = '⏸️';
                if (this.pillText) this.pillText.textContent = breaks.length > 0 ? 'Edit Breaks' : 'Breaks';
            } else {
                if (this.pillIcon) this.pillIcon.textContent = '🔒';
                if (this.pillText) this.pillText.textContent = 'Breaks Locked';
            }
        },

        openModal() {
            const isWindowOpen = isSelectionWindowOpenSafe();
            const breaks = getTodayBreaksSafe();

            if (this.rowsContainer) this.rowsContainer.innerHTML = '';
            this.hideError();

            if (breaks.length > 0) {
                breaks.forEach(b => this.addBreakRow(b.start, b.end, !isWindowOpen));
            } else if (isWindowOpen) {
                this.addBreakRow();
            }

            if (this.addBtn) this.addBtn.style.display = isWindowOpen ? 'inline-block' : 'none';
            if (this.saveBtn) this.saveBtn.style.display = isWindowOpen ? 'inline-block' : 'none';

            const desc = document.getElementById('breakModalStatusDesc');
            if (desc) {
                desc.textContent = isWindowOpen
                    ? 'Schedule up to 3 non-overlapping breaks (≤ 3 hours total). The window locks permanently once closed.'
                    : 'The break scheduling window is now closed for today. Configured breaks are read-only.';
            }

            if (this.modal) this.modal.classList.add('open');
        },

        closeModal() {
            if (this.modal) this.modal.classList.remove('open');
        },

        addBreakRow(startVal = '', endVal = '', disabled = false) {
            if (!this.rowsContainer) return;
            const rows = this.rowsContainer.querySelectorAll('.break-row-item');
            if (rows.length >= 3) {
                this.showError('Maximum 3 breaks allowed per day.');
                return;
            }

            const row = document.createElement('div');
            row.className = 'break-row-item';
            row.style.cssText = 'display: flex; align-items: center; gap: 8px;';

            row.innerHTML = `
                <input type="time" class="b-start" value="${startVal}" ${disabled ? 'disabled' : ''} style="flex: 1; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-subtle); color: var(--text-color);">
                <span style="color: var(--text-muted); font-size: 0.85rem;">to</span>
                <input type="time" class="b-end" value="${endVal}" ${disabled ? 'disabled' : ''} style="flex: 1; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-subtle); color: var(--text-color);">
                ${!disabled ? '<button type="button" class="del-break-row-btn" style="background: none; border: none; color: var(--danger); font-size: 1.2rem; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>' : ''}
            `;

            if (!disabled) {
                row.querySelector('.del-break-row-btn').addEventListener('click', () => {
                    row.remove();
                    this.hideError();
                });
            }
            this.rowsContainer.appendChild(row);
        },

        saveBreaks() {
            if (!this.rowsContainer) return;
            const rows = this.rowsContainer.querySelectorAll('.break-row-item');
            const breaksArray = [];

            for (const r of rows) {
                const start = r.querySelector('.b-start')?.value;
                const end = r.querySelector('.b-end')?.value;
                if (start && end) {
                    breaksArray.push({ start, end });
                }
            }

            if (window.TaskitatorEngine?.BreakEngine?.saveTodayBreaks) {
                const res = TaskitatorEngine.BreakEngine.saveTodayBreaks(breaksArray);
                if (!res.valid) {
                    this.showError(res.error);
                    return;
                }
            } else {
                localStorage.setItem('taskitator_daily_breaks', JSON.stringify(breaksArray));
            }

            saveStorageAndPush();
            this.closeModal();
            this.updateStatusPill();
        },

        showError(msg) {
            if (!this.errorBox) return;
            this.errorBox.textContent = msg;
            this.errorBox.style.display = 'block';
        },

        hideError() {
            if (!this.errorBox) return;
            this.errorBox.style.display = 'none';
            this.errorBox.textContent = '';
        }
    };

    // =========================================================================
    // Core Tree Rendering & Subtractive Path-Preserving Filter Engine
    // =========================================================================
    function isTaskVisuallyActive(task) {
        if (task.status === 'trash') return false;
        if (task.status === 'active') return true;
        if (task.status === 'completed' && pendingGraceCompletions.has(task.id)) return true;
        return false;
    }

    function renderUnifiedTaskTree() {
        const list = document.getElementById('taskListContainer');
        if (!list) return;
        list.innerHTML = '';

        const todayStr = new Date().toISOString().split('T')[0];
        const isBypassActive = isBypassActiveSafe();
        const globalPriorities = getGlobalPriorities();
        const globalProjects = getGlobalProjects();

        const allChildrenMap = new Map();
        const visibleChildrenMap = new Map();

        tasks.forEach(t => {
            if (t.status === 'trash') return;
            const pId = t.parent_id || 'root';

            if (!allChildrenMap.has(pId)) allChildrenMap.set(pId, []);
            allChildrenMap.get(pId).push(t);

            if (isTaskVisuallyActive(t)) {
                if (!visibleChildrenMap.has(pId)) visibleChildrenMap.set(pId, []);
                visibleChildrenMap.get(pId).push(t);
            }
        });

        function belongsToCurrentView(task) {
            if (currentView === 'general') return true;
            const rawDue = (task.due_date || '').trim().toLowerCase();
            if (rawDue === 'today') return true;
            if (/^\d{4}-\d{2}-\d{2}$/.test(rawDue) && rawDue <= todayStr) return true;
            const kids = allChildrenMap.get(task.id) || [];
            return kids.some(k => belongsToCurrentView(k));
        }

        function hasVisibleDescendant(taskId) {
            const kids = visibleChildrenMap.get(taskId) || [];
            if (kids.length > 0) return true;
            const allKids = allChildrenMap.get(taskId) || [];
            return allKids.some(k => hasVisibleDescendant(k.id));
        }

        // Subtractive Filter Engine (Tags, Priorities, Projects)
        const hasFilters = activeFilters.tags.size > 0 || activeFilters.priorities.size > 0 || activeFilters.projects.size > 0;
        const matchMap = new Map();
        const descMatchMap = new Map();

        if (hasFilters) {
            tasks.forEach(t => {
                const tagMatch = activeFilters.tags.size === 0 || (t.tags && t.tags.some(tag => activeFilters.tags.has(tag)));
                const prioMatch = activeFilters.priorities.size === 0 || activeFilters.priorities.has(t.priority_id);
                const projMatch = activeFilters.projects.size === 0 || activeFilters.projects.has(t.project_id || 'inbox');
                matchMap.set(t.id, tagMatch && prioMatch && projMatch);
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
            tasks.forEach(t => checkDesc(t.id));
        }

        let rootTasks = (allChildrenMap.get('root') || []).filter(t => {
            if (!belongsToCurrentView(t)) return false;
            if (hasFilters) {
                const m = matchMap.get(t.id);
                const d = descMatchMap.get(t.id);
                if (!m && !d) return false;
            }
            return isTaskVisuallyActive(t) || hasVisibleDescendant(t.id);
        });

        rootTasks = sortTasks(rootTasks);

        if (rootTasks.length === 0) {
            const msg = (currentView === 'today') 
                ? 'No active tasks scheduled for today.' 
                : 'No active tasks found in workspace.';
            list.innerHTML = `<li style="text-align: center; color: var(--text-muted); padding: 32px;">${msg}</li>`;
            return;
        }

        function buildNodeElement(task, depth = 0) {
            const li = document.createElement('li');
            const isDone = task.status === 'completed';
            li.className = `task-node ${isDone ? 'completed' : ''}`;

            let isBreadcrumb = false;
            if (hasFilters) {
                const m = matchMap.get(task.id);
                const d = descMatchMap.get(task.id);
                if (!m && d) {
                    isBreadcrumb = true;
                }
            }

            if (pendingGraceCompletions.has(task.id) && !isBreadcrumb) {
                const graceInfo = pendingGraceCompletions.get(task.id);
                const graceRow = document.createElement('div');
                graceRow.className = 'undo-grace-row';
                graceRow.style.marginLeft = `${depth * 20}px`;
                graceRow.innerHTML = `
                    <div style="font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; gap: 8px;">
                        <span style="color: var(--success); font-weight: 700;">✓ Completed:</span>
                        <span style="text-decoration: line-through; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${task.title}</span>
                    </div>
                    <button class="undo-grace-btn" id="undoBtn_${task.id}">Undo (<span id="undoTimerSec_${task.id}">${graceInfo.remainingSec}</span>s)</button>
                `;
                const uBtn = graceRow.querySelector(`#undoBtn_${task.id}`);
                if (uBtn) {
                    uBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        undoTaskCompletion(task.id);
                    });
                }
                li.appendChild(graceRow);
                return li;
            }

            const row = document.createElement('div');
            row.className = 'task-row';
            row.style.marginLeft = `${depth * 20}px`;

            if (isBreadcrumb) {
                row.classList.add('muted-breadcrumb');
            }

            const pObj = globalPriorities.find(x => x.id === task.priority_id);
            if (pObj) {
                row.style.borderLeftColor = pObj.color;
            }

            const main = document.createElement('div');
            main.className = 'task-main';

            let visibleChildren = visibleChildrenMap.get(task.id) || [];
            if (hasFilters) {
                visibleChildren = (allChildrenMap.get(task.id) || []).filter(c => {
                    const m = matchMap.get(c.id);
                    const d = descMatchMap.get(c.id);
                    return m || d;
                });
            }
            visibleChildren = sortTasks(visibleChildren);

            const hasVisibleChildren = visibleChildren.length > 0;
            let isCollapsed = collapsedNodes.has(task.id);
            if (isBreadcrumb) isCollapsed = false;

            if (hasVisibleChildren) {
                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'collapse-toggle';
                toggleBtn.textContent = isCollapsed ? '▶' : '▼';
                toggleBtn.title = isCollapsed ? 'Expand subtasks' : 'Collapse subtasks';
                toggleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (collapsedNodes.has(task.id)) {
                        collapsedNodes.delete(task.id);
                    } else {
                        collapsedNodes.add(task.id);
                    }
                    saveStorageAndPush();
                    renderUnifiedTaskTree();
                });
                main.appendChild(toggleBtn);
            } else {
                const spacer = document.createElement('span');
                spacer.className = 'collapse-spacer';
                main.appendChild(spacer);
            }

            const checkBtn = document.createElement('button');
            checkBtn.className = 'check-circle';
            checkBtn.textContent = isDone ? '✓' : '';
            checkBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleTaskCompletion(task.id);
            });
            main.appendChild(checkBtn);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'task-title';
            titleSpan.textContent = task.title;
            main.appendChild(titleSpan);

            const projObj = globalProjects.find(pr => pr.id === (task.project_id || 'inbox'));
            if (projObj && projObj.id !== 'inbox') {
                const projBadge = document.createElement('span');
                projBadge.className = 'project-badge-chip';
                projBadge.style.borderColor = projObj.color;
                projBadge.style.color = projObj.color;
                projBadge.innerHTML = `<span>${projObj.icon}</span> <span>${projObj.name}</span>`;
                main.appendChild(projBadge);
            }

            if (task.ai_locked) {
                const badge = document.createElement('span');
                badge.className = 'ai-badge';
                badge.innerHTML = '🔒 AI';
                main.appendChild(badge);
            }

            if (task.strict_prerequisites) {
                const shieldBadge = document.createElement('span');
                shieldBadge.className = 'ai-badge';
                shieldBadge.innerHTML = '🛡️ Shielded';
                shieldBadge.style.background = '#451a03';
                shieldBadge.style.color = '#fde68a';
                shieldBadge.style.borderColor = '#78350f';
                main.appendChild(shieldBadge);
            }

            const allDesc = allChildrenMap.get(task.id);
            if (allDesc && allDesc.length > 0) {
                const doneKidsCount = allDesc.filter(k => k.status === 'completed').length;
                const countBadge = document.createElement('span');
                countBadge.className = 'subtasks-count-badge';
                countBadge.textContent = `✓ ${doneKidsCount}/${allDesc.length} Subtasks`;
                main.appendChild(countBadge);
            }

            if (task.due_date && currentView === 'general') {
                const dueBadge = document.createElement('span');
                dueBadge.className = 'due-badge';
                dueBadge.textContent = task.due_date;
                main.appendChild(dueBadge);
            }

            if (task.tags && task.tags.length > 0) {
                task.tags.forEach(tag => {
                    const tagChip = document.createElement('span');
                    tagChip.className = 'tag-chip';
                    tagChip.textContent = tag;
                    main.appendChild(tagChip);
                });
            }

            row.appendChild(main);

            const delBtn = document.createElement('button');
            delBtn.className = 'action-del-btn';
            delBtn.textContent = '✕';
            delBtn.title = 'Delete Task';

            if (task.ai_locked && !isBypassActive) {
                delBtn.disabled = true;
                delBtn.title = 'AI tasks cannot be deleted without an active emergency bypass';
            } else {
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteTask(task.id);
                });
            }
            row.appendChild(delBtn);

            row.addEventListener('click', () => {
                if (!isBreadcrumb) openTaskDetailModal(task.id);
            });

            li.appendChild(row);

            if (hasVisibleChildren) {
                const subUl = document.createElement('ul');
                subUl.className = `task-subtree ${isCollapsed ? 'collapsed' : ''}`;
                visibleChildren.forEach(child => {
                    subUl.appendChild(buildNodeElement(child, depth + 1));
                });
                li.appendChild(subUl);
            }

            return li;
        }

        rootTasks.forEach(task => list.appendChild(buildNodeElement(task, 0)));
    }

    // =========================================================================
    // Completed Tasks Modal
    // =========================================================================
    function renderCompletedModalList() {
        const container = document.getElementById('completedTasksListContainer');
        const titleEl = document.getElementById('completedModalTitle');
        if (!container) return;
        container.innerHTML = '';

        if (titleEl) {
            titleEl.textContent = (currentView === 'today') 
                ? "✓ Today's Completed Tasks" 
                : "✓ Workspace Completed Tasks";
        }

        const todayStr = new Date().toISOString().split('T')[0];

        const completedList = tasks.filter(t => {
            if (t.status !== 'completed') return false;
            if (pendingGraceCompletions.has(t.id)) return false;
            if (currentView === 'general') return true;

            const due = String(t.due_date || '').trim().toLowerCase();
            const compDate = t.completed_at ? t.completed_at.split('T')[0] : '';
            return due === 'today' || due === todayStr || compDate === todayStr;
        });

        if (completedList.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 24px 0;">
                    No completed tasks found.
                </div>
            `;
            return;
        }

        const isBypassActive = isBypassActiveSafe();

        completedList.forEach(task => {
            const row = document.createElement('div');
            row.className = 'completed-item-row';

            const info = document.createElement('div');
            info.style.cssText = 'flex: 1; margin-right: 12px;';

            let badgesHtml = '';
            if (task.ai_locked) badgesHtml += '<span class="ai-badge">🔒 AI</span> ';
            if (task.strict_prerequisites) badgesHtml += '<span class="ai-badge" style="background:#451a03; color:#fde68a; border-color:#78350f;">🛡️ Shielded</span>';

            info.innerHTML = `
                <div style="font-weight: 600; text-decoration: line-through; color: var(--text-muted);">
                    ${task.title} ${badgesHtml}
                </div>
                ${task.completed_at ? `<small style="color: var(--text-muted); font-size: 0.75rem;">Done at: ${new Date(task.completed_at).toLocaleTimeString()}</small>` : ''}
            `;

            const actionContainer = document.createElement('div');

            if (task.ai_locked && !isBypassActive) {
                const lockedBtn = document.createElement('span');
                lockedBtn.className = 'ai-locked-btn';
                lockedBtn.title = 'AI tasks are permanently locked and cannot be uncompleted';
                lockedBtn.innerHTML = '🔒 Locked';
                actionContainer.appendChild(lockedBtn);
            } else {
                const actionBtn = document.createElement('button');
                actionBtn.className = 'icon-btn';
                actionBtn.style.padding = '4px 10px';
                actionBtn.style.fontSize = '0.8rem';
                actionBtn.innerHTML = '↺ Uncomplete';

                actionBtn.addEventListener('click', () => {
                    uncompleteFromModal(task.id);
                });
                actionContainer.appendChild(actionBtn);
            }

            row.appendChild(info);
            row.appendChild(actionContainer);
            container.appendChild(row);
        });
    }

    function uncompleteFromModal(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.ai_locked && !isBypassActiveSafe()) {
            alert('Blocked: AI-checked tasks are permanent and cannot be uncompleted.');
            return;
        }

        if (task.parent_id) {
            const parent = tasks.find(t => t.id === task.parent_id);
            if (!parent || parent.status === 'trash') {
                task.parent_id = null;
            }
        }

        task.status = 'active';
        task.completed_at = null;

        saveStorageAndPush();
        renderUnifiedView();
    }

    // =========================================================================
    // Master View Render & Router
    // =========================================================================
    function renderUnifiedView() {
        renderUnifiedTaskTree();
        renderCompletedModalList();
        BreakUI.updateStatusPill();
    }

    function setView(viewName) {
        currentView = (viewName === 'general') ? 'general' : 'today';

        const heading = document.getElementById('pageViewHeading');
        const linkToday = document.getElementById('navLinkToday');
        const linkGeneral = document.getElementById('navLinkGeneral');

        if (currentView === 'today') {
            if (heading) heading.textContent = "Today's Focus";
            if (linkToday) linkToday.classList.add('active');
            if (linkGeneral) linkGeneral.classList.remove('active');
        } else {
            if (heading) heading.textContent = "General Tasks";
            if (linkToday) linkToday.classList.remove('active');
            if (linkGeneral) linkGeneral.classList.add('active');
        }

        renderUnifiedView();
    }

    function handleHashRouting() {
        const hash = window.location.hash.replace('#', '').toLowerCase();
        setView(hash === 'general' ? 'general' : 'today');
    }

    // =========================================================================
    // Emergency Countdown UI
    // =========================================================================
    function updateEmergencyUI() {
        const banner = document.getElementById('activeEmergencyBanner');
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
                    updateEmergencyUI();
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
        renderUnifiedTaskTree();
    }

    // =========================================================================
    // Boot and Event Wiring
    // =========================================================================
    function init() {
        initSyncIndicator();
        loadStorage();
        BreakUI.init();

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

        document.querySelectorAll('#drawerNavLinks a').forEach(link => {
            link.addEventListener('click', () => {
                if (sidebarDrawer) sidebarDrawer.classList.remove('open');
                if (drawerBackdrop) drawerBackdrop.classList.remove('open');
            });
        });

        window.addEventListener('hashchange', handleHashRouting);
        handleHashRouting();

        const completedModal = document.getElementById('completedModal');
        const openCompletedModalBtn = document.getElementById('openCompletedModalBtn');
        const closeCompletedModalBtn = document.getElementById('closeCompletedModalBtn');

        if (openCompletedModalBtn && completedModal) {
            openCompletedModalBtn.addEventListener('click', () => {
                renderCompletedModalList();
                completedModal.classList.add('open');
            });
        }
        if (closeCompletedModalBtn && completedModal) {
            closeCompletedModalBtn.addEventListener('click', () => {
                completedModal.classList.remove('open');
            });
        }

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
        if (startCopilotBtn) {
            startCopilotBtn.addEventListener('click', () => {
                const sb = document.getElementById('copilotStandbyView');
                const cv = document.getElementById('copilotChatView');
                if (sb) sb.style.display = 'none';
                if (cv) cv.classList.add('active');
                const inp = document.getElementById('copilotInput');
                if (inp) inp.focus();
            });
        }

        const openRootAddModalBtn = document.getElementById('openRootAddModalBtn');
        if (openRootAddModalBtn) {
            openRootAddModalBtn.addEventListener('click', () => {
                openTaskCreationModal(null, 'Create New Task');
            });
        }

        const openFilterModalBtn = document.getElementById('openFilterModalBtn');
        const closeFilterModalBtn = document.getElementById('closeFilterModalBtn');
        const clearFiltersBtn = document.getElementById('clearFiltersBtn');
        const applyFiltersBtn = document.getElementById('applyFiltersBtn');
        const filterModal = document.getElementById('filterModal');

        if (openFilterModalBtn && filterModal) {
            openFilterModalBtn.addEventListener('click', () => {
                draftFilters.tags = new Set(activeFilters.tags);
                draftFilters.priorities = new Set(activeFilters.priorities);
                draftFilters.projects = new Set(activeFilters.projects);
                renderFilterClouds();
                filterModal.classList.add('open');
            });
        }
        if (closeFilterModalBtn && filterModal) {
            closeFilterModalBtn.addEventListener('click', () => {
                filterModal.classList.remove('open');
            });
        }
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', () => {
                draftFilters.tags.clear();
                draftFilters.priorities.clear();
                draftFilters.projects.clear();
                renderFilterClouds();
            });
        }
        if (applyFiltersBtn && filterModal) {
            applyFiltersBtn.addEventListener('click', () => {
                activeFilters.tags = new Set(draftFilters.tags);
                activeFilters.priorities = new Set(draftFilters.priorities);
                activeFilters.projects = new Set(draftFilters.projects);

                const hasFilters = activeFilters.tags.size > 0 || activeFilters.priorities.size > 0 || activeFilters.projects.size > 0;
                const dot = document.getElementById('filterActiveDot');
                if (dot) dot.style.display = hasFilters ? 'block' : 'none';

                filterModal.classList.remove('open');
                renderUnifiedTaskTree();
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

        // =====================================================================
        // UI Handling for Exemplar Picker in Task Creation
        // =====================================================================
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
                createExemplarChip.style.display = 'none';
                exemplarGuidanceNote.style.display = 'none';
                criteriaValidationState = { validated: false, score: 0, isTemplate: false };
                const feedback = document.getElementById('criteriaFeedbackBox');
                if (feedback) {
                    feedback.style.display = 'none';
                    feedback.innerHTML = '';
                }
            });
        }

        NLPEngine.upgradeInput('taskTitleInput', 'create');
        NLPEngine.upgradeInput('editTaskTitle', 'edit');

        // =====================================================================
        // Task Creation Submission hook
        // =====================================================================
        const taskCreateForm = document.getElementById('taskCreateForm');
        if (taskCreateForm) {
            taskCreateForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const title = NLPEngine.extractCleanTitle('taskTitleInput');
                const desc = document.getElementById('taskDescInput')?.value.trim() || '';
                const dueDate = document.getElementById('taskDueDateInput')?.value || '';
                const isAi = Boolean(document.getElementById('aiLockCheckbox')?.checked);
                const isStrictPrereq = isAi ? Boolean(document.getElementById('strictPrereqCheckbox')?.checked) : false;
                const criteria = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                const parentId = document.getElementById('creationParentId')?.value || null;
                
                const exemplarInput = document.getElementById('createExemplarInput');
                const exemplarFile = (isAi && exemplarInput && exemplarInput.files.length > 0) ? exemplarInput.files[0] : null;

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

                let assignedProject = createModalSelectedProject || 'inbox';
                if (parentId) {
                    const parentTask = tasks.find(t => t.id === parentId);
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
                    title: title,
                    description: desc,
                    tags: Array.from(createModalSelectedTags),
                    priority_id: createModalSelectedPriority,
                    project_id: assignedProject,
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
                                project_id: assignedProject,
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
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Save Task';
                }
                
                if (addTaskModal) addTaskModal.classList.remove('open');
                
                if (typeof window.refreshCurrentProjectView === 'function') {
                    window.refreshCurrentProjectView();
                } else {
                    renderUnifiedView();
                }
            });
        }

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
                    renderUnifiedView();
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

                const oldProjectId = task.project_id;
                task.project_id = editModalSelectedProject || 'inbox';
                if (oldProjectId !== task.project_id) {
                    function cascadeProject(pId, newProj) {
                        tasks.filter(k => k.parent_id === pId && k.status !== 'trash').forEach(child => {
                            child.project_id = newProj;
                            cascadeProject(child.id, newProj);
                        });
                    }
                    cascadeProject(task.id, task.project_id);
                }

                if (!task.ai_locked || isBypassActive) {
                    task.title = NLPEngine.extractCleanTitle('editTaskTitle') || task.title;
                    task.due_date = document.getElementById('editTaskDueDate')?.value || '';
                    task.ai_locked = willBeAiLocked;
                    task.strict_prerequisites = willBeStrict;
                    task.proof_criteria = willBeAiLocked ? (document.getElementById('editTaskCriteria')?.value.trim() || '') : '';
                }

                saveStorageAndPush();
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                
                const customRender = taskDetailModal?._customRenderFn;
                activeDetailTaskId = null;

                if (typeof customRender === 'function') customRender();
                else renderUnifiedView();
            });
        }

        const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
        if (deleteFromDetailBtn) {
            deleteFromDetailBtn.addEventListener('click', () => {
                if (!activeDetailTaskId) return;
                const customRender = taskDetailModal?._customRenderFn;
                deleteTask(activeDetailTaskId, customRender);
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

        const auditModal = document.getElementById('auditModal');
        const closeAuditModalBtn = document.getElementById('closeAuditModalBtn');
        if (closeAuditModalBtn && auditModal) {
            closeAuditModalBtn.addEventListener('click', () => {
                auditModal.classList.remove('open');
                pendingAuditTaskId = null;
            });
        }

        // =====================================================================
        // Dual-Evidence Audit Submission
        // =====================================================================
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
                    
                    let refExemplarPart = null;
                    if (window.ExemplarStore) {
                        const exemplarRecord = await ExemplarStore.getExemplar(task.id);
                        if (exemplarRecord && exemplarRecord.inlineData) {
                            refExemplarPart = exemplarRecord.inlineData;
                        }
                    }

                    result = await TaskitatorEngine.AuditEngine.verifyProof({
                        file: file,
                        taskTitle: task.title,
                        criteria: task.proof_criteria,
                        userContext: document.getElementById('auditContextInput')?.value.trim() || '',
                        exemplarPart: refExemplarPart
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
                    renderUnifiedView();
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

        // =====================================================================
        // Validate Criteria (Pre-flight) with Exemplar Attached
        // =====================================================================
        const validateCriteriaBtn = document.getElementById('validateCriteriaBtn');
        if (validateCriteriaBtn) {
            validateCriteriaBtn.addEventListener('click', async () => {
                const criteriaText = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                const taskTitle = NLPEngine.extractCleanTitle('taskTitleInput') || '';
                const feedback = document.getElementById('criteriaFeedbackBox');
                
                const exemplarInput = document.getElementById('createExemplarInput');
                const exemplarFile = (exemplarInput && exemplarInput.files.length > 0) ? exemplarInput.files[0] : null;

                if (!criteriaText) {
                    if (feedback) {
                        feedback.style.display = 'block';
                        feedback.className = 'criteria-feedback-box fail';
                        feedback.textContent = 'Please enter proof criteria before validating.';
                    }
                    return;
                }

                validateCriteriaBtn.disabled = true;
                validateCriteriaBtn.textContent = 'Validating...';
                if (feedback) {
                    feedback.style.display = 'block';
                    feedback.className = 'criteria-feedback-box loading';
                    feedback.textContent = 'Auditing criteria with forensic model...';
                }

                let res = { success: false, error: 'Audit engine missing' };
                if (window.TaskitatorEngine?.AuditEngine?.validateCriteria) {
                    res = await TaskitatorEngine.AuditEngine.validateCriteria(criteriaText, taskTitle, exemplarFile);
                }

                validateCriteriaBtn.disabled = false;
                validateCriteriaBtn.textContent = '🔍 Validate Criteria';

                if (!res.success) {
                    if (feedback) {
                        feedback.className = 'criteria-feedback-box fail';
                        feedback.innerHTML = `<strong>Audit Halted:</strong> ${res.error || 'Failed to communicate with AI model.'}`;
                    }
                    criteriaValidationState = { validated: false, score: 0, isTemplate: false };
                    return;
                }

                criteriaValidationState = {
                    validated: true,
                    score: res.score,
                    isTemplate: false
                };

                if (feedback) {
                    if (res.passed) {
                        feedback.className = 'criteria-feedback-box pass';
                        feedback.innerHTML = `<strong>✓ Verified (${res.score}/10)</strong>: ${res.critique}`;
                    } else {
                        feedback.className = 'criteria-feedback-box fail';
                        let feedbackHtml = `<strong>⚠️ Low Quality Rating (${res.score}/10)</strong>: ${res.critique}`;
                        if (res.suggested_rewrite) {
                            feedbackHtml += `
                                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.2);">
                                    <strong>Suggested Artifact:</strong> "${res.suggested_rewrite}"
                                    <div style="margin-top: 6px;">
                                        <button type="button" class="icon-btn" id="applySuggestionBtn" style="padding: 3px 8px; font-size: 0.75rem; background: var(--card-subtle);">Use Suggestion</button>
                                    </div>
                                </div>
                            `;
                        }
                        feedback.innerHTML = feedbackHtml;

                        const applyBtn = feedback.querySelector('#applySuggestionBtn');
                        if (applyBtn) {
                            applyBtn.addEventListener('click', () => {
                                const tIn = document.getElementById('taskCriteriaInput');
                                if (tIn) tIn.value = res.suggested_rewrite;
                                criteriaValidationState = { validated: true, score: 9, isTemplate: true };
                                feedback.className = 'criteria-feedback-box pass';
                                feedback.innerHTML = `<strong>✓ Verified (9/10)</strong>: Applied forensic suggestion.`;
                            });
                        }
                    }
                }
            });
        }

        const openTemplatesBtn = document.getElementById('openTemplatesBtn');
        const templatesModal = document.getElementById('templatesModal');
        const closeTemplatesModalBtn = document.getElementById('closeTemplatesModalBtn');

        if (openTemplatesBtn && templatesModal) {
            openTemplatesBtn.addEventListener('click', async () => {
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
                                    <strong style="color: var(--text-color); font-size: 0.88rem;">${t.label}</strong>
                                    <span class="tag-chip" style="font-size: 0.7rem;">${t.category}</span>
                                </div>
                                <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted); line-height: 1.35;">${t.template}</p>
                            `;
                            card.addEventListener('click', () => {
                                const tIn = document.getElementById('taskCriteriaInput');
                                if (tIn) tIn.value = t.template;
                                criteriaValidationState = { validated: true, score: 10, isTemplate: true };
                                const fb = document.getElementById('criteriaFeedbackBox');
                                if (fb) {
                                    fb.style.display = 'block';
                                    fb.className = 'criteria-feedback-box pass';
                                    fb.innerHTML = `<strong>✓ Verified (10/10)</strong>: Standard verified artifact template selected.`;
                                }
                                templatesModal.classList.remove('open');
                            });
                            container.appendChild(card);
                        });
                    }
                }
                templatesModal.classList.add('open');
            });
        }
        if (closeTemplatesModalBtn && templatesModal) {
            closeTemplatesModalBtn.addEventListener('click', () => {
                templatesModal.classList.remove('open');
            });
        }

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
                    updateEmergencyUI();
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

        const syncStatusDot = document.getElementById('syncStatusDot');
        const syncInfoModal = document.getElementById('syncInfoModal');
        const closeSyncInfoModalBtn = document.getElementById('closeSyncInfoModalBtn');
        const forceSyncFromModalBtn = document.getElementById('forceSyncFromModalBtn');

        if (syncStatusDot && syncInfoModal) {
            syncStatusDot.addEventListener('click', () => syncInfoModal.classList.add('open'));
        }
        if (closeSyncInfoModalBtn && syncInfoModal) {
            closeSyncInfoModalBtn.addEventListener('click', () => syncInfoModal.classList.remove('open'));
        }
        if (forceSyncFromModalBtn) {
            forceSyncFromModalBtn.addEventListener('click', async () => {
                let settings = {};
                try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) {}

                if (!settings.worker_passkey) {
                    alert('Cannot sync: No secret passkey configured in Settings.');
                    updateSyncDot('local-only');
                    return;
                }

                updateSyncDot('pending');
                if (syncInfoModal) syncInfoModal.classList.remove('open');

                if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                    const breaks = getTodayBreaksSafe();
                    const ok = await SyncEngine.forceImmediateSync({ today_breaks: breaks });
                    if (ok) {
                        updateSyncDot('synced');
                        loadStorage();
                        renderUnifiedView();
                    } else {
                        updateSyncDot('error');
                    }
                }
            });
        }

        window.addEventListener('taskitator-synced', () => {
            updateSyncDot('synced');
            if (!activeDetailTaskId) {
                loadStorage();
                renderUnifiedView();
            }
        });
        window.addEventListener('taskitator-tasks-updated', () => {
            if (!activeDetailTaskId) {
                loadStorage();
                renderUnifiedView();
            }
        });
        window.addEventListener('taskitator-sync-error', () => {
            updateSyncDot('error');
        });

        if (window.SyncEngine && typeof SyncEngine.isConfigured === 'function' && SyncEngine.isConfigured()) {
            SyncEngine.pull(() => {
                if (!activeDetailTaskId) {
                    loadStorage();
                    renderUnifiedView();
                }
            });
        }
    }

    return {
        init,
        setView,
        renderUnifiedView,
        getTasks: () => tasks,
        loadStorage,
        saveStorageAndPush,
        getGlobalProjects,
        saveProject,
        deleteProjectWithCascade,
        openTaskCreationModal,
        openTaskDetailModal,
        sortTasks,
        handleTaskCompletion,
        deleteTask,
        undoTaskCompletion,
        PROJECT_ICONS,
        PROJECT_COLORS
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    TaskitatorApp.init();
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .catch(err => console.error('SW Registration failed:', err));
    });
}

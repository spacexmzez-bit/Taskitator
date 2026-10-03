/**
 * Taskitator Unified Application Engine (app.js)
 * Owns task data, tree rendering, routing, projects, sync, completion rules,
 * breaks, distraction notes, emergency controls, filters, and batch actions.
 * Task-editor UI is delegated to components.js through Host API v1.
 */

window.TaskitatorApp = (() => {
    // =========================================================================
    // Storage Keys & State
    // =========================================================================
    const TASKS_KEY = 'taskitator_tasks';
    const COLLAPSED_STATE_KEY = 'taskitator_collapsed_nodes';
    const SETTINGS_KEY = 'taskitator_settings';
    const PROJECTS_KEY = 'taskitator_projects';
    const AUDIT_LEDGER_KEY = 'taskitator_audit_ledger';
    const DISTRACTION_NOTES_KEY = 'taskitator_distraction_notes';
    const ARCHIVED_NOTES_KEY = 'taskitator_archived_notes';

    let currentView = 'today'; // 'today' | 'general'
    let tasks = [];
    let collapsedNodes = new Set();
    let emergencyTimerInterval = null;

    const pendingGraceCompletions = new Map();

    // Multi-Selection State
    let isSelectionModeActive = false;
    const selectedTaskIds = new Set();
    const batchSelectedTags = new Set();
    let batchSelectedPriority = null;

    // Active Filter State (Tags, Priorities, Projects)
    const activeFilters = { tags: new Set(), priorities: new Set(), projects: new Set() };
    const draftFilters = { tags: new Set(), priorities: new Set(), projects: new Set() };

    // Host API v1 is the only connection to the task-editor implementation.
    let components = null;
    function getComponents() {
        if (!components) {
            if (window.TaskitatorComponents?.apiVersion !== 1) {
                throw new Error('Load components.js (API v1) before initializing Taskitator.');
            }
            components = window.TaskitatorComponents.create({
                apiVersion: 1,
                tasks: {
                    getAll: () => tasks,
                    reload: loadStorage,
                    save: saveStorageAndPush,
                    sort: sortTasks,
                    descendants: getAllDescendants,
                    shieldedAncestor: getShieldedAncestor,
                    hasUncompletedDescendant,
                    remove: deleteTask,
                    moveProject: cascadeProject,
                    setStatus: cascadeTaskStatus,
                    finalize: finalizeTaskCompletion
                },
                catalogs: {
                    projects: getGlobalProjects, tags: getGlobalTags,
                    priorities: getGlobalPriorities, lowestPriority: getLowestPriorityId,
                    addTag: saveGlobalTag
                },
                view: { current: () => currentView, refresh: renderUnifiedView },
                rules: { bypassActive: isBypassActiveSafe, strictCriteria: isStrictCriteriaModeEnabled },
                effects: { auditSuccess: () => SoundFX.playSuccessAudit() },
                clock: { today: getAppTodayStr },
                breaks: { today: getTodayBreaksSafe }
            });
        }
        return components;
    }
    function openTaskCreationModal(...args) { return getComponents().openCreate(...args); }
    function openTaskDetailModal(...args) { return getComponents().openDetail(...args); }
    function openAuditModal(...args) { return getComponents().openAudit(...args); }
    function renderModalTagCloud(...args) { return getComponents().renderTags(...args); }

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

    const PROJECT_ICONS = ['📥', '📚', '💼', '⚡', '🔬', '🏥', '🎯', '💻', '📝', '🎨', '🚀', '🧠', '🏋', '💰', '🛠️', '🌐'];
    const PROJECT_COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f97316'];

    // =========================================================================
    // Logical Day Date Derivation (Day-Start Offset Aware)
    // =========================================================================
    function getAppTodayStr() {
        if (window.TaskitatorEngine?.BreakEngine?.getLogicalDayBounds) {
            return TaskitatorEngine.BreakEngine.getLogicalDayBounds().dateStr;
        }
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

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
        },
        playTimeoutAlert() {
            if (this.isMuted()) return;
            try {
                const ctx = this.getAudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'square';
                osc.frequency.setValueAtTime(150, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.3);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            } catch (e) {}
        }
    };

    // =========================================================================
    // Distraction Dump & Local Escrow GC
    // =========================================================================
    const DistractionDumpEngine = (() => {
        let activeTimer = null;
        let activeInterval = null;
        
        function getNotes() {
            try {
                return JSON.parse(localStorage.getItem(DISTRACTION_NOTES_KEY) || '[]');
            } catch (e) {
                return [];
            }
        }

        function saveNotes(notesArray) {
            localStorage.setItem(DISTRACTION_NOTES_KEY, JSON.stringify(notesArray));
            updateTriggerIcon();
        }

        function garbageCollect() {
            const now = Date.now();
            const TTL_MS = 48 * 60 * 60 * 1000;
            const notes = getNotes();
            const valid = notes.filter(n => (now - n.created_at) < TTL_MS);
            if (valid.length !== notes.length) {
                saveNotes(valid);
            } else {
                updateTriggerIcon();
            }
        }

        function updateTriggerIcon() {
            const btn = document.getElementById('openDistractionDumpBtn');
            const countDisplay = document.getElementById('dumpEscrowCountDisplay');
            if (!btn) return;
            
            const count = getNotes().length;
            if (count > 0) {
                btn.classList.add('has-notes');
            } else {
                btn.classList.remove('has-notes');
            }
            if (countDisplay) countDisplay.textContent = count;
        }

        function formatRemainingTTL(createdTimestamp) {
            const now = Date.now();
            const TTL_MS = 48 * 60 * 60 * 1000;
            const diff = TTL_MS - (now - createdTimestamp);
            if (diff <= 0) return 'Expired';
            
            const hours = Math.floor(diff / (1000 * 60 * 60));
            if (hours > 0) return `${hours}h remaining`;
            const mins = Math.floor(diff / (1000 * 60));
            return `${mins}m remaining`;
        }

        function openModal() {
            const modal = document.getElementById('distractionDumpModal');
            const input = document.getElementById('distractionNoteInput');
            const display = document.getElementById('dumpCountdownDisplay');
            const prog = document.getElementById('dumpTimerProgressBar');
            
            if (!modal || !input) return;

            let durationSecs = 90;
            try {
                const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
                if (settings.dump_duration !== undefined) {
                    durationSecs = parseInt(settings.dump_duration, 10);
                }
            } catch (e) {}

            input.value = '';
            modal.classList.add('open');
            setTimeout(() => input.focus(), 150);

            startHardTimer(durationSecs, display, prog);
        }

        function forceCommitAndClose() {
            const input = document.getElementById('distractionNoteInput');
            const val = (input?.value || '').trim();
            
            if (val) {
                const notes = getNotes();
                notes.push({
                    id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    text: val,
                    created_at: Date.now()
                });
                saveNotes(notes);
            }

            closeModal();
            SoundFX.playTimeoutAlert();
        }

        function closeModal() {
            const modal = document.getElementById('distractionDumpModal');
            if (modal) modal.classList.remove('open');
            if (activeTimer) clearTimeout(activeTimer);
            if (activeInterval) clearInterval(activeInterval);
        }

        function startHardTimer(totalSecs, displayEl, progEl) {
            if (activeTimer) clearTimeout(activeTimer);
            if (activeInterval) clearInterval(activeInterval);

            let remaining = totalSecs;
            
            const updateUI = () => {
                if (displayEl) {
                    const m = Math.floor(remaining / 60);
                    const s = remaining % 60;
                    displayEl.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                }
                if (progEl) {
                    const pct = (remaining / totalSecs) * 100;
                    progEl.style.width = `${pct}%`;
                    if (pct < 25) {
                        progEl.classList.add('urgency');
                    } else {
                        progEl.classList.remove('urgency');
                    }
                }
            };

            updateUI();
            
            activeInterval = setInterval(() => {
                remaining--;
                updateUI();
                if (remaining <= 0) {
                    clearInterval(activeInterval);
                    forceCommitAndClose();
                }
            }, 1000);
        }

        function openEscrowModal() {
            closeModal();
            const eModal = document.getElementById('distractionEscrowModal');
            const listEl = document.getElementById('escrowNotesList');
            const lockBanner = document.getElementById('escrowGateLockBanner');
            const unlockedBanner = document.getElementById('escrowGateUnlockedBanner');
            
            if (!eModal || !listEl) return;

            garbageCollect();
            const notes = getNotes();
            listEl.innerHTML = '';

            if (notes.length === 0) {
                listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 20px 0;">No active ideas in escrow.</div>';
            } else {
                notes.forEach((n, idx) => {
                    const card = document.createElement('div');
                    card.className = 'dump-note-item-card';
                    card.dataset.noteId = n.id;
                    
                    card.innerHTML = `
                        <div class="dump-note-header">
                            <input type="text" class="dump-note-title-input" placeholder="Optional Title..." value="${n.title || ''}" data-idx="${idx}">
                            <div class="dump-note-actions">
                                <span style="font-size: 0.7rem; color: #f59e0b; font-weight: 700; white-space: nowrap; margin-right: 6px;">⏳ ${formatRemainingTTL(n.created_at)}</span>
                                <button type="button" class="icon-btn del-escrow-note" data-idx="${idx}" style="color: var(--danger); border-color: rgba(239,68,68,0.3); padding: 2px 8px; font-size: 0.75rem;">✕</button>
                            </div>
                        </div>
                        <div style="font-size: 0.88rem; line-height: 1.45; color: var(--text-color); white-space: pre-wrap; padding-top: 4px;">${n.text}</div>
                    `;
                    
                    const titleInput = card.querySelector('.dump-note-title-input');
                    titleInput.addEventListener('blur', (e) => {
                        const i = parseInt(e.target.getAttribute('data-idx'), 10);
                        const currentNotes = getNotes();
                        if (currentNotes[i]) {
                            currentNotes[i].title = e.target.value.trim();
                            saveNotes(currentNotes);
                        }
                    });

                    listEl.appendChild(card);
                });

                listEl.querySelectorAll('.del-escrow-note').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const i = parseInt(e.target.getAttribute('data-idx'), 10);
                        notes.splice(i, 1);
                        saveNotes(notes);
                        openEscrowModal();
                    });
                });
            }

            const todayStr = getAppTodayStr();
            const hasPendingAiLocks = tasks.some(t => {
                if (!t.ai_locked || t.status === 'completed' || t.status === 'trash') return false;
                const due = (t.due_date || '').trim().toLowerCase();
                return due === 'today' || due <= todayStr;
            });
            
            if (lockBanner && unlockedBanner) {
                if (hasPendingAiLocks) {
                    lockBanner.style.display = 'flex';
                    unlockedBanner.style.display = 'none';
                } else if (notes.length > 0) {
                    lockBanner.style.display = 'none';
                    unlockedBanner.style.display = 'flex';
                } else {
                    lockBanner.style.display = 'none';
                    unlockedBanner.style.display = 'none';
                }
            }

            eModal.classList.add('open');
        }

        return {
            garbageCollect,
            openModal,
            closeModal,
            openEscrowModal,
            getNotes,
            saveNotes,
            updateTriggerIcon
        };
    })();

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

        loadStorage();
        if (cascadeMode === 'trash') {
            for (const task of tasks.filter(t => t.project_id === projectId)) {
                const error = TaskitatorSafety.deletionError(tasks, task.id, isBypassActiveSafe());
                if (error) return { success: false, error };
            }
        }

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
    // Safe Engine Wrappers & Break Normalization
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
            const b = TaskitatorEngine.BreakEngine.getTodayBreaks();
            return Array.isArray(b) ? b : [];
        }
        try {
            const raw = localStorage.getItem('taskitator_daily_breaks');
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object' && parsed !== null) {
                const todayStr = getAppTodayStr();
                const entry = parsed[todayStr];
                if (Array.isArray(entry)) return entry;
                if (Array.isArray(entry?.breaks)) return entry.breaks;
            }
            return [];
        } catch (e) {
            return [];
        }
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
                if (t.raw_title === undefined) {
                    t.raw_title = t.title || '';
                }
                if (t.is_bonus === undefined) {
                    t.is_bonus = false;
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
    // Hierarchy, Shielding, & Sorting Algorithms (Cycle-Safe & Bonus Aware)
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

    function getAllDescendants(nodeId, visited = new Set()) {
        let descs = [];
        if (visited.has(nodeId)) return descs;
        visited.add(nodeId);

        const kids = tasks.filter(t => t.parent_id === nodeId && t.status !== 'trash');
        for (const kid of kids) {
            descs.push(kid);
            descs = descs.concat(getAllDescendants(kid.id, visited));
        }
        return descs;
    }

    // Bonus Subtasks (is_bonus: true) are excluded from the mandatory shield requirement
    function hasUncompletedDescendant(nodeId, visited = new Set()) {
        if (visited.has(nodeId)) return false;
        visited.add(nodeId);

        const kids = tasks.filter(t => t.parent_id === nodeId && t.status !== 'trash');
        for (const kid of kids) {
            if (!kid.is_bonus && kid.status !== 'completed') return true;
            if (hasUncompletedDescendant(kid.id, visited)) return true;
        }
        return false;
    }

    function getShieldedAncestor(taskId) {
        let curr = tasks.find(t => t.id === taskId);
        const visited = new Set();
        while (curr && curr.parent_id) {
            if (visited.has(curr.id)) break;
            visited.add(curr.id);
            const parent = tasks.find(t => t.id === curr.parent_id);
            if (!parent) break;
            if (parent.strict_prerequisites) return parent;
            curr = parent;
        }
        return null;
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

    function cascadeProject(pId, newProj, visited = new Set()) {
        if (visited.has(pId)) return;
        visited.add(pId);

        tasks.filter(k => k.parent_id === pId && k.status !== 'trash').forEach(child => {
            child.project_id = newProj;
            cascadeProject(child.id, newProj, visited);
        });
    }

    function cascadeTaskStatus(targetTaskId, newStatus, timestamp = null) {
        const target = tasks.find(t => t.id === targetTaskId);
        if (!target) return;

        target.status = newStatus;
        target.completed_at = timestamp;

        if (newStatus === 'completed' && window.ExemplarStore) {
            window.ExemplarStore.deleteExemplar(target.id);
        }

        const visited = new Set([targetTaskId]);
        function cascadeChildren(parentId) {
            tasks.filter(t => t.parent_id === parentId && t.status !== 'trash').forEach(child => {
                if (visited.has(child.id)) return;
                visited.add(child.id);
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
    // Gamification Bridge, Grace Timers & Ledger Handling
    // =========================================================================
    async function finalizeTaskCompletion(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task || task.status !== 'completed') return;

        let hasExemplar = false;
        if (window.ExemplarStore) {
            hasExemplar = await window.ExemplarStore.hasExemplar(task.id);
        }

        let ledger = [];
        try {
            ledger = JSON.parse(localStorage.getItem(AUDIT_LEDGER_KEY) || '[]');
        } catch (e) {}

        const prios = getGlobalPriorities();

        function pushToLedger(targetTask, eventType) {
            const pObj = prios.find(p => p.id === targetTask.priority_id);
            const rank = pObj ? pObj.rank : 3;

            const payload = {
                sync_hash: 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8),
                task_id: targetTask.id,
                title: targetTask.title,
                event_type: eventType,
                priority_rank: rank,
                verified_by_ai: Boolean(targetTask.ai_locked),
                verification_model: targetTask.verified_model || null,
                completed_at: targetTask.completed_at || new Date().toISOString(),
                has_exemplar: hasExemplar && targetTask.id === taskId
            };

            if (targetTask.mrstudy_binding) {
                payload.mrstudy_binding = targetTask.mrstudy_binding;
            }

            ledger.push(payload);
        }

        const eventType = task.parent_id ? 'SUBTASK' : 'ROOT';
        pushToLedger(task, eventType);

        const descendants = getAllDescendants(taskId);
        descendants.forEach(child => {
            if (child.status === 'completed' && child.completed_at === task.completed_at) {
                pushToLedger(child, 'CASCADE');
            }
        });

        if (ledger.length > 200) {
            ledger = ledger.slice(ledger.length - 200);
        }

        localStorage.setItem(AUDIT_LEDGER_KEY, JSON.stringify(ledger));
        
        if (window.SyncEngine && typeof SyncEngine.markLocalModified === 'function') {
            SyncEngine.markLocalModified();
        }
    }

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
            
            finalizeTaskCompletion(taskId);

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
            alert("Blocked: A shielded task in this hierarchy requires all its core subtasks to be completely finished first.");
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

        const deletionError = TaskitatorSafety.deletionError(tasks, taskId, isBypassActiveSafe());
        if (deletionError) {
            alert(deletionError);
            return;
        }

        if (confirm(`Delete "${task.title}" and any associated subtasks?`)) {
            const visited = new Set();
            function markTrash(id) {
                if (visited.has(id)) return;
                visited.add(id);
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
                TaskitatorSafety.setProjectLabel(pill, p);
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
                pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${TaskitatorSafety.escapeHtml(p.color)};"></span> ${TaskitatorSafety.escapeHtml(p.name)}`;
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
    // Multi-Selection Mode & Batch Editing Controller
    // =========================================================================
    function toggleSelectionMode() {
        isSelectionModeActive = !isSelectionModeActive;
        selectedTaskIds.clear();

        const btn = document.getElementById('toggleSelectModeBtn');
        if (btn) btn.classList.toggle('active', isSelectionModeActive);

        updateBatchBarUI();
        renderUnifiedTaskTree();
    }

    function toggleTaskSelection(taskId) {
        if (pendingGraceCompletions.has(taskId)) return;

        if (selectedTaskIds.has(taskId)) {
            selectedTaskIds.delete(taskId);
        } else {
            selectedTaskIds.add(taskId);
        }

        updateBatchBarUI();
        renderUnifiedTaskTree();
    }

    function updateBatchBarUI() {
        const bar = document.getElementById('batchActionBar');
        const label = document.getElementById('batchSelectedCountLabel');
        if (!bar) return;

        // Clean gate: only show the floating bar if multi-select is active AND at least 1 item is checked
        if (isSelectionModeActive && selectedTaskIds.size > 0) {
            bar.classList.add('open');
            if (label) label.textContent = `${selectedTaskIds.size} Selected`;
        } else {
            bar.classList.remove('open');
            if (label) label.textContent = `0 Selected`;
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
        planningTimerInterval: null,

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
            setInterval(() => this.updateStatusPill(), 20000);
        },

        updateStatusPill() {
            if (!this.pill) return;
            if (currentView !== 'today') {
                this.pill.style.display = 'none';
                return;
            }
            this.pill.style.display = 'inline-flex';

            const status = window.TaskitatorEngine?.BreakEngine?.getPlanningStatus 
                ? TaskitatorEngine.BreakEngine.getPlanningStatus() 
                : { canStart: true, canEdit: false, isRunning: false, isLocked: false, isInBuffer: false, remainingWindowMs: 0, bounds: { start: new Date() } };

            const isCurrentlyOnBreak = window.TaskitatorEngine?.BreakEngine?.isCurrentlyOnBreak 
                ? TaskitatorEngine.BreakEngine.isCurrentlyOnBreak() 
                : false;

            const breaks = window.TaskitatorEngine?.BreakEngine?.getTodayBreaks 
                ? TaskitatorEngine.BreakEngine.getTodayBreaks() 
                : getTodayBreaksSafe();

            this.pill.className = 'break-status-pill';

            if (isCurrentlyOnBreak) {
                const nowTime = Date.now();
                const activeBreak = breaks.find(b => {
                    if (!b.start || !b.end || !window.TaskitatorEngine?.BreakEngine?.getBreakTimestamps) return false;
                    const { startTime, endTime } = TaskitatorEngine.BreakEngine.getBreakTimestamps(b, status.bounds);
                    return nowTime >= startTime && nowTime <= endTime;
                });

                let minsLeft = 0;
                if (activeBreak && window.TaskitatorEngine?.BreakEngine?.getBreakTimestamps) {
                    const { endTime } = TaskitatorEngine.BreakEngine.getBreakTimestamps(activeBreak, status.bounds);
                    minsLeft = Math.max(1, Math.round((endTime - nowTime) / (60 * 1000)));
                }

                this.pill.classList.add('active-break');
                if (this.pillIcon) this.pillIcon.textContent = '🟢';
                if (this.pillText) this.pillText.textContent = `${minsLeft}m left`;
                return;
            }

            if (status.isRunning) {
                const remSec = Math.ceil(status.remainingWindowMs / 1000);
                const remMin = Math.floor(remSec / 60);
                const remSecOnly = remSec % 60;
                this.pill.classList.add('window-open');
                if (this.pillIcon) this.pillIcon.textContent = '⏳';
                if (this.pillText) this.pillText.textContent = `Plan (${remMin}:${String(remSecOnly).padStart(2, '0')})`;
                return;
            }

            const nowTime = Date.now();
            const upcomingBreak = breaks
                .map(b => {
                    if (!b.start || !window.TaskitatorEngine?.BreakEngine?.getBreakTimestamps) return null;
                    const { startTime } = TaskitatorEngine.BreakEngine.getBreakTimestamps(b, status.bounds);
                    return { ...b, startTime };
                })
                .filter(b => b && b.startTime > nowTime)
                .sort((a, b) => a.startTime - b.startTime)[0];

            if (upcomingBreak) {
                if (this.pillIcon) this.pillIcon.textContent = '☕';
                if (this.pillText) this.pillText.textContent = `Next: ${upcomingBreak.start}`;
                return;
            }

            if (status.canStart) {
                this.pill.classList.add('window-open');
                if (this.pillIcon) this.pillIcon.textContent = '⏸️';
                if (this.pillText) this.pillText.textContent = 'Plan Breaks';
            } else if (status.isLocked) {
                if (this.pillIcon) this.pillIcon.textContent = '🔒';
                if (this.pillText) this.pillText.textContent = 'Breaks Locked';
            } else if (status.isInBuffer) {
                if (this.pillIcon) this.pillIcon.textContent = '⚠️';
                if (this.pillText) this.pillText.textContent = 'Planning Closed';
            } else {
                if (this.pillIcon) this.pillIcon.textContent = '⏸️';
                if (this.pillText) this.pillText.textContent = 'Breaks';
            }
        },

        openModal() {
            this.hideError();
            this.renderModal();
            if (this.modal) this.modal.classList.add('open');
        },

        closeModal() {
            if (this.planningTimerInterval) {
                clearInterval(this.planningTimerInterval);
                this.planningTimerInterval = null;
            }
            if (this.modal) this.modal.classList.remove('open');
        },

        startCountdownTimer() {
            if (this.planningTimerInterval) clearInterval(this.planningTimerInterval);
            this.planningTimerInterval = setInterval(() => {
                if (!window.TaskitatorEngine?.BreakEngine?.getPlanningStatus) return;
                const status = TaskitatorEngine.BreakEngine.getPlanningStatus();
                
                if (!status.isRunning) {
                    clearInterval(this.planningTimerInterval);
                    this.planningTimerInterval = null;
                    this.autoCommitAndLock();
                    return;
                }

                const remSec = Math.ceil(status.remainingWindowMs / 1000);
                const remMin = Math.floor(remSec / 60);
                const remSecOnly = remSec % 60;
                const formatted = `${String(remMin).padStart(2, '0')}:${String(remSecOnly).padStart(2, '0')}`;

                const cdDisplay = document.getElementById('breakPlanningCountdown');
                const progBar = document.getElementById('breakPlanningProgress');
                if (cdDisplay) cdDisplay.textContent = formatted;
                if (progBar) {
                    const totalMs = TaskitatorEngine.BreakEngine.PLANNING_WINDOW_MS || (10 * 60 * 1000);
                    const pct = Math.max(0, Math.min(100, (status.remainingWindowMs / totalMs) * 100));
                    progBar.style.width = `${pct}%`;
                }
                this.updateStatusPill();
            }, 1000);
        },

        autoCommitAndLock() {
            const currentRows = this.getCurrentRowsData();
            if (window.TaskitatorEngine?.BreakEngine?.saveTodayBreaks) {
                const res = TaskitatorEngine.BreakEngine.saveTodayBreaks(currentRows, true);
                if (!res.valid && window.TaskitatorEngine?.BreakEngine?.lockTodayBreaks) {
                    TaskitatorEngine.BreakEngine.lockTodayBreaks();
                }
            }
            saveStorageAndPush();
            SoundFX.playTimeoutAlert();
            alert("Time's up! Your 10-minute planning window has expired. Today's break schedule has been automatically locked.");
            this.renderModal();
            this.updateStatusPill();
        },

        getCurrentRowsData() {
            if (!this.rowsContainer) return [];
            const rows = this.rowsContainer.querySelectorAll('.break-row-item');
            const list = [];
            rows.forEach(r => {
                const start = r.querySelector('.b-start')?.value;
                const end = r.querySelector('.b-end')?.value;
                if (start && end) list.push({ start, end });
            });
            return list;
        },

        renderModal() {
            if (!this.modal || !this.rowsContainer) return;
            const status = window.TaskitatorEngine?.BreakEngine?.getPlanningStatus 
                ? TaskitatorEngine.BreakEngine.getPlanningStatus() 
                : { canStart: true, canEdit: false, isRunning: false, isLocked: false, isInBuffer: false, remainingWindowMs: 0, bounds: { start: new Date() } };

            const breaks = window.TaskitatorEngine?.BreakEngine?.getTodayBreaks 
                ? TaskitatorEngine.BreakEngine.getTodayBreaks() 
                : getTodayBreaksSafe();

            let headerBox = document.getElementById('breakPlanningHeaderBox');
            if (!headerBox) {
                headerBox = document.createElement('div');
                headerBox.id = 'breakPlanningHeaderBox';
                const desc = document.getElementById('breakModalStatusDesc');
                if (desc && desc.parentNode) {
                    desc.parentNode.insertBefore(headerBox, desc.nextSibling);
                }
            }

            const desc = document.getElementById('breakModalStatusDesc');

            if (status.isRunning) {
                if (desc) desc.style.display = 'none';
                const totalMs = TaskitatorEngine.BreakEngine.PLANNING_WINDOW_MS || (10 * 60 * 1000);
                const pct = Math.max(0, Math.min(100, (status.remainingWindowMs / totalMs) * 100));
                const remSec = Math.ceil(status.remainingWindowMs / 1000);
                const remMin = Math.floor(remSec / 60);
                const remSecOnly = remSec % 60;
                const formatted = `${String(remMin).padStart(2, '0')}:${String(remSecOnly).padStart(2, '0')}`;

                headerBox.innerHTML = `
                    <div style="background: rgba(59, 130, 246, 0.15); border: 1.5px solid var(--primary); border-radius: 8px; padding: 10px 14px; margin-bottom: 14px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <strong style="color: var(--primary); font-size: 0.88rem; display: flex; align-items: center; gap: 6px;">
                                <span>⏳</span> Planning Active
                            </strong>
                            <span id="breakPlanningCountdown" style="font-family: monospace; font-weight: 800; font-size: 0.95rem; color: #93c5fd; background: rgba(0,0,0,0.3); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color);">${formatted}</span>
                        </div>
                        <div style="width: 100%; height: 5px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                            <div id="breakPlanningProgress" style="height: 100%; width: ${pct}%; background: var(--primary); transition: width 1s linear;"></div>
                        </div>
                        <small style="color: var(--text-muted); font-size: 0.75rem; display: block; margin-top: 8px; line-height: 1.35;">
                            Adjust up to 3 non-overlapping breaks (≤ 3 hours). The schedule will permanently lock when you save or when the timer reaches 0:00.
                        </small>
                    </div>
                `;

                this.rowsContainer.innerHTML = '';
                if (Array.isArray(breaks) && breaks.length > 0) {
                    breaks.forEach(b => this.addBreakRow(b.start, b.end, false));
                } else {
                    this.addBreakRow('', '', false);
                }

                if (this.addBtn) this.addBtn.style.display = 'inline-block';
                if (this.saveBtn) {
                    this.saveBtn.style.display = 'inline-block';
                    this.saveBtn.textContent = 'Confirm & Lock Breaks';
                }

                this.startCountdownTimer();

            } else if (status.canStart) {
                if (this.planningTimerInterval) {
                    clearInterval(this.planningTimerInterval);
                    this.planningTimerInterval = null;
                }
                if (desc) desc.style.display = 'none';

                headerBox.innerHTML = `
                    <div style="background: rgba(59, 130, 246, 0.08); border: 1.5px dashed var(--primary); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; text-align: center;">
                        <p style="margin: 0 0 10px 0; font-size: 0.84rem; color: var(--text-color); line-height: 1.45;">
                            Breaks are open for this cycle. Starting planning initiates a strict <strong>10-minute window</strong> to adjust and lock your daily schedule.
                        </p>
                        <button type="button" id="startBreakPlanningBtn" class="icon-btn" style="background: var(--primary); color: #fff; border: none; font-weight: 700; padding: 9px 18px; font-size: 0.88rem; width: 100%;">
                            ▶ Start 10m Planning Window
                        </button>
                    </div>
                `;

                const startBtn = document.getElementById('startBreakPlanningBtn');
                if (startBtn) {
                    startBtn.addEventListener('click', () => this.handleStartPlanning());
                }

                this.rowsContainer.innerHTML = '';
                if (Array.isArray(breaks) && breaks.length > 0) {
                    breaks.forEach(b => this.addBreakRow(b.start, b.end, true));
                } else {
                    this.rowsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 14px 0;">No breaks scheduled. Click "Start 10m Planning Window" to configure.</div>';
                }

                if (this.addBtn) this.addBtn.style.display = 'none';
                if (this.saveBtn) this.saveBtn.style.display = 'none';

            } else {
                if (this.planningTimerInterval) {
                    clearInterval(this.planningTimerInterval);
                    this.planningTimerInterval = null;
                }
                if (desc) desc.style.display = 'none';

                const bannerBg = status.isLocked ? 'rgba(239, 68, 68, 0.12)' : 'rgba(234, 179, 8, 0.12)';
                const borderC = status.isLocked ? 'rgba(239, 68, 68, 0.4)' : 'rgba(234, 179, 8, 0.4)';
                const titleC = status.isLocked ? '#fca5a5' : '#fde047';

                headerBox.innerHTML = `
                    <div style="background: ${bannerBg}; border: 1.5px solid ${borderC}; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px;">
                        <div style="display: flex; align-items: flex-start; gap: 8px;">
                            <span style="font-size: 1.1rem; line-height: 1;">${status.isLocked ? '🔒' : '⚠️'}</span>
                            <div style="font-size: 0.82rem; color: ${titleC}; line-height: 1.45;">
                                <strong>${status.isLocked ? 'Schedule Locked' : 'Planning Buffer Closed'}:</strong> ${status.reason}
                            </div>
                        </div>
                        <button type="button" id="startBreakPlanningDisabledBtn" class="icon-btn" style="width: 100%; margin-top: 10px; opacity: 0.6; cursor: not-allowed; background: var(--card-subtle);">
                            🔒 Start Planning Window (Unavailable)
                        </button>
                    </div>
                `;

                const disabledBtn = document.getElementById('startBreakPlanningDisabledBtn');
                if (disabledBtn) {
                    disabledBtn.addEventListener('click', () => {
                        const curStatus = window.TaskitatorEngine?.BreakEngine?.getPlanningStatus 
                            ? TaskitatorEngine.BreakEngine.getPlanningStatus() 
                            : status;
                        alert(curStatus.reason || 'Planning window is currently unavailable.');
                    });
                }

                this.rowsContainer.innerHTML = '';
                if (Array.isArray(breaks) && breaks.length > 0) {
                    breaks.forEach(b => this.addBreakRow(b.start, b.end, true));
                } else {
                    this.rowsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 14px 0;">No breaks were scheduled for this cycle.</div>';
                }

                if (this.addBtn) this.addBtn.style.display = 'none';
                if (this.saveBtn) this.saveBtn.style.display = 'none';
            }
        },

        handleStartPlanning() {
            if (!window.TaskitatorEngine?.BreakEngine?.startPlanningWindow) return;
            const res = TaskitatorEngine.BreakEngine.startPlanningWindow();
            if (!res.success) {
                alert(res.error);
                this.renderModal();
                return;
            }
            this.renderModal();
            this.updateStatusPill();
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
            row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px;';

            row.innerHTML = `
                <input type="time" class="b-start" value="${startVal}" ${disabled ? 'disabled' : ''} style="flex: 1; padding: 7px 10px; border: 1.5px solid var(--border-color); border-radius: 6px; background: var(--card-subtle); color: var(--text-color); font-size: 0.9rem;">
                <span style="color: var(--text-muted); font-size: 0.85rem; font-weight: 700;">to</span>
                <input type="time" class="b-end" value="${endVal}" ${disabled ? 'disabled' : ''} style="flex: 1; padding: 7px 10px; border: 1.5px solid var(--border-color); border-radius: 6px; background: var(--card-subtle); color: var(--text-color); font-size: 0.9rem;">
                ${!disabled ? '<button type="button" class="del-break-row-btn" style="background: none; border: none; color: var(--danger); font-size: 1.3rem; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>' : ''}
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
            const breaksArray = this.getCurrentRowsData();

            const confirmed = confirm(
                "⚠️️ CONFIRM & LOCK DAILY SCHEDULE ⚠️\n\n" +
                "Once locked, your breaks cannot be edited, added, or cleared for the remainder of this cycle.\n\n" +
                "Do you want to permanently lock this schedule now?"
            );
            if (!confirmed) return;

            if (window.TaskitatorEngine?.BreakEngine?.saveTodayBreaks) {
                const res = TaskitatorEngine.BreakEngine.saveTodayBreaks(breaksArray, true);
                if (!res.valid) {
                    this.showError(res.error);
                    return;
                }
            } else {
                localStorage.setItem('taskitator_daily_breaks', JSON.stringify(breaksArray));
            }

            if (this.planningTimerInterval) {
                clearInterval(this.planningTimerInterval);
                this.planningTimerInterval = null;
            }

            saveStorageAndPush();
            this.renderModal();
            this.updateStatusPill();

            if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                const breaks = getTodayBreaksSafe();
                SyncEngine.forceImmediateSync({ today_breaks: breaks });
            }

            alert("Daily breaks locked successfully.");
            this.closeModal();
        },

        showError(msg) {
            if (!this.errorBox) return;
            this.errorBox.textContent = msg;
            this.errorBox.style.display = 'block';
        },

        hideError() {
            if (!this.errorBox) return;
            this.errorBox.textContent = '';
        }
    };

    // =========================================================================
    // Core Tree Rendering
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

        const todayStr = getAppTodayStr();
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

        function belongsToCurrentView(task, visited = new Set()) {
            if (currentView === 'general') return true;
            if (visited.has(task.id)) return false;
            visited.add(task.id);

            const rawDue = (task.due_date || '').trim().toLowerCase();
            if (rawDue === 'today') return true;
            if (/^\d{4}-\d{2}-\d{2}$/.test(rawDue) && rawDue <= todayStr) return true;
            const kids = allChildrenMap.get(task.id) || [];
            return kids.some(k => belongsToCurrentView(k, visited));
        }

        function hasVisibleDescendant(taskId, visited = new Set()) {
            if (visited.has(taskId)) return false;
            visited.add(taskId);

            const kids = visibleChildrenMap.get(taskId) || [];
            if (kids.length > 0) return true;
            const allKids = allChildrenMap.get(taskId) || [];
            return allKids.some(k => hasVisibleDescendant(k.id, visited));
        }

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

            function checkDesc(nodeId, visited = new Set()) {
                if (visited.has(nodeId)) return false;
                visited.add(nodeId);

                if (descMatchMap.has(nodeId)) return descMatchMap.get(nodeId);
                const kids = allChildrenMap.get(nodeId) || [];
                let has = false;
                for (let k of kids) {
                    if (matchMap.get(k.id) || checkDesc(k.id, visited)) has = true;
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
                if (!m && d) return false;
            }
            return isTaskVisuallyActive(t) || hasVisibleDescendant(t.id);
        });

        rootTasks = sortTasks(rootTasks);

        if (rootTasks.length === 0) {
            const msg = (currentView === 'today') 
                ? 'No active tasks scheduled for today.' 
                : 'No active tasks found in workspace.';
            list.innerHTML = `<li style="text-align: center; color: var(--text-muted); padding: 32px;">${msg}</li>`;
        } else {
            function buildNodeElement(task, depth = 0) {
                const li = document.createElement('li');
                const isDone = task.status === 'completed';
                
                const isOverdue = !isDone && 
                                  task.due_date && 
                                  /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) && 
                                  task.due_date < todayStr;

                const isSelected = selectedTaskIds.has(task.id);
                const isBonus = Boolean(task.is_bonus);
                li.className = `task-node ${isDone ? 'completed' : ''} ${isOverdue ? 'is-overdue' : ''} ${isSelected ? 'row-selected' : ''} ${isBonus ? 'is-bonus' : ''}`;

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
                row.className = `task-row ${isSelected ? 'row-selected' : ''}`;
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
                if (isSelectionModeActive) {
                    checkBtn.className = `check-square ${isSelected ? 'selected' : ''}`;
                    checkBtn.textContent = isSelected ? '✓' : '';
                    checkBtn.title = isSelected ? 'Deselect task' : 'Select task';
                    checkBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleTaskSelection(task.id);
                    });
                } else {
                    checkBtn.className = 'check-circle';
                    checkBtn.textContent = isDone ? '✓' : '';
                    checkBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handleTaskCompletion(task.id);
                    });
                }
                main.appendChild(checkBtn);

                const titleSpan = document.createElement('span');
                titleSpan.className = 'task-title';
                titleSpan.textContent = task.title;
                main.appendChild(titleSpan);

                if (task.is_bonus) {
                    const bonusBadge = document.createElement('span');
                    bonusBadge.className = 'bonus-badge';
                    bonusBadge.innerHTML = '⭐ Bonus';
                    main.appendChild(bonusBadge);
                }

                const projObj = globalProjects.find(pr => pr.id === (task.project_id || 'inbox'));
                if (projObj && projObj.id !== 'inbox') {
                    const projBadge = document.createElement('span');
                    projBadge.className = 'project-badge-chip';
                    projBadge.style.borderColor = projObj.color;
                    projBadge.style.color = projObj.color;
                    TaskitatorSafety.setProjectLabel(projBadge, projObj);
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

                if (!isBypassActive && (task.ai_locked || (task.strict_prerequisites && hasVisibleChildren))) {
                    delBtn.disabled = true;
                    delBtn.title = 'Locked tasks or shielded tasks with subtasks cannot be deleted without an active emergency bypass';
                } else {
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteTask(task.id);
                    });
                }
                row.appendChild(delBtn);

                row.addEventListener('click', () => {
                    if (isSelectionModeActive) {
                        toggleTaskSelection(task.id);
                    } else if (!isBreadcrumb) {
                        openTaskDetailModal(task.id);
                    }
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

        const overdueBar = document.getElementById('overdueRescheduleBar');
        const countText = document.getElementById('overdueTasksCountText');
        if (overdueBar && countText) {
            const overdueTasks = tasks.filter(t => t.status === 'active' && t.due_date && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) && t.due_date < todayStr);
            if (overdueTasks.length > 0) {
                overdueBar.style.display = 'flex';
                countText.textContent = `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}`;
            } else {
                overdueBar.style.display = 'none';
            }
        }
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

        const todayStr = getAppTodayStr();

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
            if (task.is_bonus) badgesHtml += '<span class="bonus-badge">⭐ Bonus</span> ';
            if (task.ai_locked) badgesHtml += '<span class="ai-badge">🔒 AI</span> ';
            if (task.strict_prerequisites) badgesHtml += '<span class="ai-badge" style="background:#451a03; color:#fde68a; border-color:#78350f;">🛡 Shielded</span>';

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
        updateBatchBarUI();
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
        DistractionDumpEngine.garbageCollect();

        getComponents().init();

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

        // Multi-Selection Mode Navbar Button
        const toggleSelectModeBtn = document.getElementById('toggleSelectModeBtn');
        if (toggleSelectModeBtn) {
            toggleSelectModeBtn.addEventListener('click', toggleSelectionMode);
        }

        // Batch Action Bar Handlers
        const batchSelectAllBtn = document.getElementById('batchSelectAllBtn');
        const batchCancelBtn = document.getElementById('batchCancelBtn');
        const batchOpenTagsBtn = document.getElementById('batchOpenTagsBtn');
        const batchOpenPriorityBtn = document.getElementById('batchOpenPriorityBtn');
        const batchOpenDueDateBtn = document.getElementById('batchOpenDueDateBtn');

        const batchTagsModal = document.getElementById('batchTagsModal');
        const closeBatchTagsBtn = document.getElementById('closeBatchTagsBtn');
        const applyBatchTagsBtn = document.getElementById('applyBatchTagsBtn');

        const batchPriorityModal = document.getElementById('batchPriorityModal');
        const closeBatchPriorityBtn = document.getElementById('closeBatchPriorityBtn');
        const applyBatchPriorityBtn = document.getElementById('applyBatchPriorityBtn');

        const batchDueDateModal = document.getElementById('batchDueDateModal');
        const closeBatchDueDateBtn = document.getElementById('closeBatchDueDateBtn');
        const applyBatchDueDateBtn = document.getElementById('applyBatchDueDateBtn');

        if (batchSelectAllBtn) {
            batchSelectAllBtn.addEventListener('click', () => {
                const todayStr = getAppTodayStr();
                tasks.forEach(t => {
                    if (t.status === 'trash' || t.status === 'completed' || pendingGraceCompletions.has(t.id)) return;
                    if (currentView === 'today') {
                        const due = String(t.due_date || '').trim().toLowerCase();
                        if (due !== 'today' && due !== todayStr) return;
                    }
                    selectedTaskIds.add(t.id);
                });
                updateBatchBarUI();
                renderUnifiedTaskTree();
            });
        }

        if (batchCancelBtn) {
            batchCancelBtn.addEventListener('click', toggleSelectionMode);
        }

        // Batch Tags Modal
        if (batchOpenTagsBtn && batchTagsModal) {
            batchOpenTagsBtn.addEventListener('click', () => {
                if (selectedTaskIds.size === 0) {
                    alert('Please select at least one task first.');
                    return;
                }
                batchSelectedTags.clear();
                renderModalTagCloud('batchTagCloud', batchSelectedTags);
                batchTagsModal.classList.add('open');
            });
        }
        if (closeBatchTagsBtn && batchTagsModal) {
            closeBatchTagsBtn.addEventListener('click', () => batchTagsModal.classList.remove('open'));
        }
        if (applyBatchTagsBtn && batchTagsModal) {
            applyBatchTagsBtn.addEventListener('click', () => {
                selectedTaskIds.forEach(id => {
                    const t = tasks.find(x => x.id === id);
                    if (t) t.tags = Array.from(batchSelectedTags);
                });
                saveStorageAndPush();
                batchTagsModal.classList.remove('open');
                renderUnifiedView();
            });
        }

        // Batch Priority Modal
        if (batchOpenPriorityBtn && batchPriorityModal) {
            batchOpenPriorityBtn.addEventListener('click', () => {
                if (selectedTaskIds.size === 0) {
                    alert('Please select at least one task first.');
                    return;
                }
                batchSelectedPriority = getLowestPriorityId();
                const container = document.getElementById('batchPriorityCloud');
                if (container) {
                    container.innerHTML = '';
                    getGlobalPriorities().forEach(p => {
                        const pill = document.createElement('span');
                        pill.className = 'priority-select-pill';
                        if (batchSelectedPriority === p.id) {
                            pill.classList.add('selected');
                            pill.style.color = p.color;
                        }
                        pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${TaskitatorSafety.escapeHtml(p.color)};"></span> ${TaskitatorSafety.escapeHtml(p.name)}`;
                        pill.addEventListener('click', () => {
                            batchSelectedPriority = p.id;
                            container.querySelectorAll('.priority-select-pill').forEach(el => el.classList.remove('selected'));
                            pill.classList.add('selected');
                        });
                        container.appendChild(pill);
                    });
                }
                batchPriorityModal.classList.add('open');
            });
        }
        if (closeBatchPriorityBtn && batchPriorityModal) {
            closeBatchPriorityBtn.addEventListener('click', () => batchPriorityModal.classList.remove('open'));
        }
        if (applyBatchPriorityBtn && batchPriorityModal) {
            applyBatchPriorityBtn.addEventListener('click', () => {
                selectedTaskIds.forEach(id => {
                    const t = tasks.find(x => x.id === id);
                    if (t) t.priority_id = batchSelectedPriority;
                });
                saveStorageAndPush();
                batchPriorityModal.classList.remove('open');
                renderUnifiedView();
            });
        }

        // Batch Due Date Modal
        if (batchOpenDueDateBtn && batchDueDateModal) {
            batchOpenDueDateBtn.addEventListener('click', () => {
                if (selectedTaskIds.size === 0) {
                    alert('Please select at least one task first.');
                    return;
                }
                const dueIn = document.getElementById('batchDueDateInput');
                if (dueIn) dueIn.value = getAppTodayStr();
                batchDueDateModal.classList.add('open');
            });
        }
        if (closeBatchDueDateBtn && batchDueDateModal) {
            closeBatchDueDateBtn.addEventListener('click', () => batchDueDateModal.classList.remove('open'));
        }
        if (applyBatchDueDateBtn && batchDueDateModal) {
            applyBatchDueDateBtn.addEventListener('click', () => {
                const targetDate = document.getElementById('batchDueDateInput')?.value || '';
                const todayStr = getAppTodayStr();
                const isBypass = isBypassActiveSafe();
                let protectedCount = 0;

                selectedTaskIds.forEach(id => {
                    const t = tasks.find(x => x.id === id);
                    if (!t) return;

                    if (t.ai_locked && t.due_date && t.due_date < todayStr && !isBypass) {
                        protectedCount++;
                        return;
                    }
                    t.due_date = targetDate;
                });

                saveStorageAndPush();
                batchDueDateModal.classList.remove('open');
                renderUnifiedView();

                if (protectedCount > 0) {
                    alert(`Due dates updated. ${protectedCount} overdue AI-locked task(s) were protected from postponement (requires proof or Emergency Bypass).`);
                }
            });
        }

        // Bulk Reschedule Gate Logic
        const rescheduleModal = document.getElementById('bulkRescheduleModal');
        const openRescheduleBtn = document.getElementById('openRescheduleModalBtn');
        const closeRescheduleBtn = document.getElementById('closeBulkRescheduleModalBtn');
        const cancelRescheduleBtn = document.getElementById('cancelBulkRescheduleBtn');
        const confirmRescheduleBtn = document.getElementById('confirmBulkRescheduleBtn');

        let bulkRescheduleMode = 'standard';

        function openBulkRescheduleModal() {
            const todayStr = getAppTodayStr();
            const overdueAiTasks = tasks.filter(t => t.ai_locked && t.status === 'active' && t.due_date && t.due_date < todayStr);
            
            const gateBanner = document.getElementById('rescheduleAiLockGateBanner');
            const formGroup = document.getElementById('rescheduleFormGroupContainer');
            const dateInput = document.getElementById('bulkRescheduleTargetDate');

            if (overdueAiTasks.length > 0) {
                bulkRescheduleMode = 'ai_rollover';
                if (gateBanner) gateBanner.style.display = 'block';
                if (formGroup) formGroup.style.display = 'none';
                if (confirmRescheduleBtn) confirmRescheduleBtn.textContent = 'Bring AI Tasks to Today';
            } else {
                bulkRescheduleMode = 'standard';
                if (gateBanner) gateBanner.style.display = 'none';
                if (formGroup) formGroup.style.display = 'block';
                if (confirmRescheduleBtn) confirmRescheduleBtn.textContent = 'Reschedule Tasks';
                if (dateInput) {
                    dateInput.value = todayStr;
                    dateInput.min = todayStr;
                }
            }
            if (rescheduleModal) rescheduleModal.classList.add('open');
        }

        if (openRescheduleBtn) openRescheduleBtn.addEventListener('click', openBulkRescheduleModal);
        const closeReschedule = () => { if (rescheduleModal) rescheduleModal.classList.remove('open'); };
        if (closeRescheduleBtn) closeRescheduleBtn.addEventListener('click', closeReschedule);
        if (cancelRescheduleBtn) cancelRescheduleBtn.addEventListener('click', closeReschedule);

        if (confirmRescheduleBtn) {
            confirmRescheduleBtn.addEventListener('click', () => {
                const todayStr = getAppTodayStr();
                let dirty = false;

                if (bulkRescheduleMode === 'ai_rollover') {
                    tasks.forEach(t => {
                        if (t.ai_locked && t.status === 'active' && t.due_date && t.due_date < todayStr) {
                            t.due_date = todayStr;
                            dirty = true;
                        }
                    });
                } else {
                    const dateInput = document.getElementById('bulkRescheduleTargetDate');
                    const targetDate = dateInput ? dateInput.value : '';
                    if (!targetDate || targetDate < todayStr) {
                        alert('Please select a valid future date or today.');
                        return;
                    }
                    tasks.forEach(t => {
                        if (!t.ai_locked && t.status === 'active' && t.due_date && t.due_date < todayStr) {
                            t.due_date = targetDate;
                            dirty = true;
                        }
                    });
                }

                if (dirty) {
                    saveStorageAndPush();
                    renderUnifiedView();
                }
                closeReschedule();
            });
        }

        // Distraction Dump UI Bindings
        const openDistractionDumpBtn = document.getElementById('openDistractionDumpBtn');
        const closeDumpModalBtn = document.getElementById('closeDumpModalBtn');
        const saveDumpNoteBtn = document.getElementById('saveDumpNoteBtn');
        const openDumpEscrowBtn = document.getElementById('openDumpEscrowBtn');
        const closeDumpEscrowModalBtn = document.getElementById('closeDumpEscrowModalBtn');
        const backToDumpInputBtn = document.getElementById('backToDumpInputBtn');
        const extractAllEscrowBtn = document.getElementById('extractAllEscrowBtn');
        const deleteAllEscrowBtn = document.getElementById('deleteAllEscrowBtn');

        if (openDistractionDumpBtn) {
            openDistractionDumpBtn.addEventListener('click', () => DistractionDumpEngine.openModal());
        }
        if (closeDumpModalBtn) {
            closeDumpModalBtn.addEventListener('click', () => DistractionDumpEngine.closeModal());
        }
        if (saveDumpNoteBtn) {
            saveDumpNoteBtn.addEventListener('click', () => {
                const input = document.getElementById('distractionNoteInput');
                if (!input || !input.value.trim()) {
                    DistractionDumpEngine.closeModal();
                    return;
                }
                const notes = DistractionDumpEngine.getNotes();
                notes.push({
                    id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    text: input.value.trim(),
                    created_at: Date.now()
                });
                DistractionDumpEngine.saveNotes(notes);
                DistractionDumpEngine.closeModal();
            });
        }
        if (openDumpEscrowBtn) {
            openDumpEscrowBtn.addEventListener('click', () => DistractionDumpEngine.openEscrowModal());
        }
        if (closeDumpEscrowModalBtn) {
            closeDumpEscrowModalBtn.addEventListener('click', () => {
                const m = document.getElementById('distractionEscrowModal');
                if (m) m.classList.remove('open');
            });
        }
        if (backToDumpInputBtn) {
            backToDumpInputBtn.addEventListener('click', () => {
                const m = document.getElementById('distractionEscrowModal');
                if (m) m.classList.remove('open');
                DistractionDumpEngine.openModal();
            });
        }
        
        if (extractAllEscrowBtn) {
            extractAllEscrowBtn.addEventListener('click', async () => {
                if (window.TaskitatorEngine?.AgentEngine?.extractNotesBatch) {
                    const currentNotes = DistractionDumpEngine.getNotes();
                    if (currentNotes.length === 0) return;
                    
                    const formatSelect = document.getElementById('escrowExportFormatSelect');
                    const format = formatSelect ? formatSelect.value : 'txt';
                    
                    extractAllEscrowBtn.disabled = true;
                    extractAllEscrowBtn.textContent = '🤖 Processing...';
                    if (deleteAllEscrowBtn) deleteAllEscrowBtn.disabled = true;
                    
                    const res = await TaskitatorEngine.AgentEngine.extractNotesBatch(currentNotes, format);
                    
                    extractAllEscrowBtn.disabled = false;
                    extractAllEscrowBtn.textContent = '📥 Extract All';
                    if (deleteAllEscrowBtn) deleteAllEscrowBtn.disabled = false;
                    
                    if (res.success) {
                        let archive = [];
                        try { archive = JSON.parse(localStorage.getItem(ARCHIVED_NOTES_KEY) || '[]'); } catch (e) {}
                        
                        const polishedSet = res.processedNotes.map(n => ({
                            id: n.id,
                            title: n.title,
                            original_text: (currentNotes.find(c => c.id === n.id) || {}).text || '',
                            clean_text: n.clean_text,
                            archived_at: new Date().toISOString()
                        }));
                        
                        localStorage.setItem(ARCHIVED_NOTES_KEY, JSON.stringify([...archive, ...polishedSet]));
                        
                        DistractionDumpEngine.saveNotes([]);
                        
                        const m = document.getElementById('distractionEscrowModal');
                        if (m) m.classList.remove('open');
                        
                        alert(`Successfully extracted ${polishedSet.length} note(s) to ${format.toUpperCase()} and moved to Archive.`);
                    } else {
                        alert(`Extraction failed: ${res.error}`);
                    }
                } else {
                    alert('Agent Engine not loaded.');
                }
            });
        }

        if (deleteAllEscrowBtn) {
            deleteAllEscrowBtn.addEventListener('click', () => {
                const currentNotes = DistractionDumpEngine.getNotes();
                if (currentNotes.length === 0) return;
                
                if (confirm(`Permanently delete all ${currentNotes.length} unextracted notes?`)) {
                    DistractionDumpEngine.saveNotes([]);
                    DistractionDumpEngine.openEscrowModal();
                }
            });
        }

        const escrowArchiveInfoBtn = document.getElementById('escrowArchiveInfoBtn');
        if (escrowArchiveInfoBtn) {
            escrowArchiveInfoBtn.addEventListener('click', () => {
                alert("Notes extracted from the Distraction Escrow are permanently saved to your 'Distraction Archive' located at the bottom of the Stats page.");
            });
        }

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

        // Emergency Bypass Handlers
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
            if (!components?.isEditing()) {
                loadStorage();
                renderUnifiedView();
            }
        });
        window.addEventListener('taskitator-tasks-updated', () => {
            if (!components?.isEditing()) {
                loadStorage();
                renderUnifiedView();
            }
        });
        window.addEventListener('taskitator-sync-error', () => {
            updateSyncDot('error');
        });

        if (window.SyncEngine && typeof SyncEngine.isConfigured === 'function' && SyncEngine.isConfigured()) {
            SyncEngine.pull(() => {
                if (!components?.isEditing()) {
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
        toggleSelectionMode,
        toggleTaskSelection,
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
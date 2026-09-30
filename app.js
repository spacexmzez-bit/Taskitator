/**
 * Taskitator Unified Application Engine (app.js)
 * Manages view routing (#today / #general), unified task trees,
 * projects registry, break UI, proofs, emergency quotas, persistent filters,
 * Move Task re-parenting, Sibling Criteria Inheritance, Multi-Selection Batch Actions,
 * Smart Criteria Variable Linker ({key==value} & {key}), Cycle-Safe Tree Traversal,
 * and Logical Day-Start Offset Synchronization.
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
    let pendingAuditTaskId = null;
    let activeDetailTaskId = null;
    let emergencyTimerInterval = null;

    let criteriaValidationState = { validated: false, score: 0, isTemplate: false };
    let editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
    let pendingEditExemplarFile = null;
    let cachedTemplates = null;
    let activeTemplateTarget = 'create'; // 'create' | 'edit'
    const pendingGraceCompletions = new Map();
    const consecutive503Tracker = new Map(); // taskId -> consecutive 503 error count

    // Multi-Selection State
    let isSelectionModeActive = false;
    const selectedTaskIds = new Set();
    const batchSelectedTags = new Set();
    let batchSelectedPriority = null;

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

    // Mr. Study Gamification State
    let activeMrStudyRules = [];
    let isMrStudyLinked = false;

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

    const PROJECT_ICONS = ['📥', '📚', '💼', '⚡', '🔬', '🏥', '🎯', '💻', '📝', '🎨', '🚀', '🧠', '🏋️', '💰', '🛠️', '🌐'];
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
    // Smart Criteria Variable Linker Helper Engine
    // =========================================================================
    const SmartCriteriaEngine = {
        /**
         * Parses {key==value} tokens from a title string.
         * Returns clean display title and normalized lowercase variable map.
         */
        parseTitle(rawInput) {
            const raw = String(rawInput || '');
            const varMap = {};
            const cleanTitle = raw.replace(/\{([^=]+)==([^}]+)\}/g, (match, key, value) => {
                const cleanKey = key.trim().toLowerCase();
                const cleanVal = value.trim();
                varMap[cleanKey] = cleanVal;
                return cleanVal;
            }).trim();

            return {
                cleanTitle: cleanTitle.replace(/\s+/g, ' '),
                varMap
            };
        },

        /**
         * Interpolates {key} placeholders inside proof criteria using varMap.
         * Flags any unresolved template brackets.
         */
        resolveCriteria(criteriaText, varMap = {}) {
            let text = String(criteriaText || '');
            const unresolvedKeys = [];

            text = text.replace(/\{([^=}]+)\}/g, (match, key) => {
                const cleanKey = key.trim().toLowerCase();
                if (Object.prototype.hasOwnProperty.call(varMap, cleanKey)) {
                    return varMap[cleanKey];
                }
                unresolvedKeys.push(cleanKey);
                return match;
            });

            // Check if any unmatched template brackets remain
            const hasUnresolved = unresolvedKeys.length > 0 || /\{[^}]+\}/.test(text);

            return {
                resolvedText: text.trim(),
                hasUnresolved,
                unresolvedKeys
            };
        },

        /**
         * Safety gate: rejects submission if template brackets remain unresolved.
         */
        validateCriteriaForSubmission(criteriaText, varMap = {}) {
            const { resolvedText, hasUnresolved, unresolvedKeys } = this.resolveCriteria(criteriaText, varMap);
            if (hasUnresolved) {
                const missingList = unresolvedKeys.length > 0 ? unresolvedKeys.join(', ') : 'unknown';
                alert(`Criteria Error: Unresolved variable placeholder(s) detected: {${missingList}}.\nPlease define all referenced variables in the task title using the format: Task Title {${missingList}==value}.`);
                return { valid: false, resolvedText: criteriaText };
            }
            return { valid: true, resolvedText };
        }
    };

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
    // Hierarchy, Shielding, & Sorting Algorithms (Cycle-Safe)
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

    function hasUncompletedDescendant(nodeId, visited = new Set()) {
        if (visited.has(nodeId)) return false;
        visited.add(nodeId);

        const kids = tasks.filter(t => t.parent_id === nodeId && t.status !== 'trash');
        for (const kid of kids) {
            if (kid.status !== 'completed') return true;
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
    function updateMrStudyRuleDropdown() {
        const container = document.getElementById('mrstudyRuleContainer');
        const select = document.getElementById('taskMrstudyRuleSelect');
        const rewardInputs = document.getElementById('mrstudyRewardInputs');
        if (!container || !select) return;

        if (!isMrStudyLinked || activeMrStudyRules.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        select.innerHTML = '<option value="">None (Standard Task)</option>';

        activeMrStudyRules.forEach(rule => {
            const opt = document.createElement('option');
            opt.value = rule.id;
            opt.textContent = `${rule.title} [${rule.min_xp}-${rule.max_xp} XP]`;
            select.appendChild(opt);
        });

        if (rewardInputs) rewardInputs.style.display = 'none';
    }

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

        const isBypassActive = isBypassActiveSafe();
        const isShielded = Boolean(task.strict_prerequisites);

        if (!isBypassActive) {
            if (task.ai_locked) {
                alert('Blocked: AI-locked tasks cannot be deleted without an active Emergency Bypass.');
                return;
            }
            if (isShielded && hasUncompletedDescendant(taskId)) {
                alert('Blocked: Shielded tasks with pending subtasks cannot be deleted without an active Emergency Bypass.');
                return;
            }
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
        if (pendingGraceCompletions.has(taskId)) return; // EC.2-B: Grace timer protection

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

        if (isSelectionModeActive && selectedTaskIds.size > 0) {
            bar.classList.add('open');
            if (label) label.textContent = `${selectedTaskIds.size} Selected`;
        } else if (isSelectionModeActive) {
            bar.classList.add('open');
            if (label) label.textContent = `0 Selected`;
        } else {
            bar.classList.remove('open');
        }
    }

    // =========================================================================
    // Todoist-Style NLP Smart Creation Engine (Preserves Raw Markup)
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
    // Task Detail / Edit Modal Engine (Move Task, Sibling Inherit & Template Linker)
    // =========================================================================
    function refreshDetailSubtaskList(parentId, triggerRenderFn) {
        const detailSubtasksList = document.getElementById('detailSubtasksList');
        const taskDetailModal = document.getElementById('taskDetailModal');
        if (!detailSubtasksList) return;
        
        detailSubtasksList.innerHTML = '';
        const directChildren = tasks.filter(t => t.parent_id === parentId && t.status !== 'trash');
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

    async function openTaskDetailModal(taskId, triggerRenderFn) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        activeDetailTaskId = taskId;

        const isBypassActive = isBypassActiveSafe();
        const isLocked = Boolean(task.ai_locked);
        const isShielded = Boolean(task.strict_prerequisites);

        const taskDetailModal = document.getElementById('taskDetailModal');
        const editTaskTitle = document.getElementById('editTaskTitle');
        const editTaskDesc = document.getElementById('editTaskDesc');
        const editTaskDueDate = document.getElementById('editTaskDueDate');
        const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
        const editStrictPrereqCheckbox = document.getElementById('editStrictPrereqCheckbox');
        const editCriteriaBoxContainer = document.getElementById('editCriteriaBoxContainer');
        const editTaskCriteria = document.getElementById('editTaskCriteria');
        const detailLockStatusBadge = document.getElementById('detailLockStatusBadge');
        const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
        const editExemplarChip = document.getElementById('editExemplarChip');
        const editExemplarName = document.getElementById('editExemplarName');
        const editExemplarSize = document.getElementById('editExemplarSize');
        const editExemplarInput = document.getElementById('editExemplarInput');
        const editFeedback = document.getElementById('editCriteriaFeedbackBox');
        const detailQuickSubtaskInput = document.getElementById('detailQuickSubtaskInput');

        // Move Task Elements
        const editTaskParentSelect = document.getElementById('editTaskParentSelect');
        const moveShieldWarningBadge = document.getElementById('moveShieldWarningBadge');

        // Sibling Criteria Inheritance Elements
        const siblingInheritContainer = document.getElementById('siblingInheritContainer');
        const siblingTaskSelect = document.getElementById('siblingTaskSelect');

        pendingEditExemplarFile = null;
        editCriteriaValidationState = {
            validated: isLocked,
            score: isLocked ? 10 : 0,
            isTemplate: false
        };

        if (editFeedback) {
            editFeedback.style.display = 'none';
            editFeedback.className = 'criteria-feedback-box';
            editFeedback.innerHTML = '';
        }

        if (editExemplarInput) editExemplarInput.value = '';

        const titleH = document.getElementById('detailTaskTitleHeader');
        if (titleH) titleH.textContent = task.title;
        
        // Populate edit title input using raw_title to preserve {key==value} syntax
        const titleForEdit = task.raw_title !== undefined ? task.raw_title : (task.title || '');
        if (editTaskTitle) {
            if (editTaskTitle.tagName === 'DIV') editTaskTitle.innerHTML = titleForEdit;
            else editTaskTitle.value = titleForEdit;
        }
        
        if (editTaskDesc) editTaskDesc.value = task.description || '';
        if (editTaskDueDate) editTaskDueDate.value = task.due_date === 'today' ? getAppTodayStr() : (task.due_date || '');
        if (detailQuickSubtaskInput) detailQuickSubtaskInput.value = '';

        editModalSelectedTags.clear();
        (task.tags || []).forEach(t => editModalSelectedTags.add(t));
        editModalSelectedPriority = task.priority_id || null;
        editModalSelectedProject = task.project_id || 'inbox';

        renderModalTagCloud('editTagCloud', editModalSelectedTags);
        renderModalPriorityCloud('editPriorityCloud', true);
        renderModalProjectCloud('editProjectCloud', true);

        // Move Task: Check Shield Confinement (EC.1-C)
        const shieldedAncestor = getShieldedAncestor(taskId);
        if (editTaskParentSelect && moveShieldWarningBadge) {
            if (shieldedAncestor && !isBypassActive) {
                moveShieldWarningBadge.style.display = 'inline-block';
                editTaskParentSelect.disabled = true;
                editTaskParentSelect.title = "Shielded task cannot be moved out of their parents";
            } else {
                moveShieldWarningBadge.style.display = 'none';
                editTaskParentSelect.disabled = false;
                editTaskParentSelect.title = "";
            }

            // Populate eligible parents (EC.1-A: Circular reference blacklist)
            const descendantIds = new Set(getAllDescendants(taskId).map(d => d.id));
            descendantIds.add(taskId); // Blacklist self

            editTaskParentSelect.innerHTML = '<option value="">(Root Level - No Parent)</option>';
            tasks.forEach(candidate => {
                if (descendantIds.has(candidate.id)) return;
                if (candidate.status === 'trash' || candidate.status === 'completed') return;

                const opt = document.createElement('option');
                opt.value = candidate.id;
                opt.textContent = `${candidate.title} [${candidate.project_id || 'inbox'}]`;
                if (candidate.id === task.parent_id) opt.selected = true;
                editTaskParentSelect.appendChild(opt);
            });
            if (!task.parent_id) {
                editTaskParentSelect.value = '';
            }
        }

        // Sibling Criteria Inheritance Population (EC.3-A, EC.3-C)
        if (siblingInheritContainer && siblingTaskSelect) {
            const isEligibleForInherit = task.parent_id && task.status !== 'completed' && (!task.ai_locked || isBypassActive);
            if (isEligibleForInherit) {
                const eligibleSiblings = tasks.filter(t => t.parent_id === task.parent_id && t.id !== task.id && t.status !== 'trash' && t.proof_criteria);
                if (eligibleSiblings.length > 0) {
                    siblingInheritContainer.style.display = 'block';
                    siblingTaskSelect.innerHTML = '<option value="">Select a sibling with verified criteria...</option>';
                    eligibleSiblings.forEach(sib => {
                        const opt = document.createElement('option');
                        opt.value = sib.id;
                        opt.textContent = `${sib.title} (${sib.proof_criteria.slice(0, 30)}...)`;
                        siblingTaskSelect.appendChild(opt);
                    });
                } else {
                    siblingInheritContainer.style.display = 'none';
                }
            } else {
                siblingInheritContainer.style.display = 'none';
            }
        }

        const editProjectGroup = document.getElementById('editProjectCloud')?.closest('.form-group');
        if (editProjectGroup) {
            editProjectGroup.style.display = task.parent_id ? 'none' : 'block';
        }

        const cannotModifyLocked = isLocked && !isBypassActive;
        const cannotUnshield = isShielded && !isBypassActive;

        if (editAiLockCheckbox) {
            editAiLockCheckbox.checked = isLocked;
            editAiLockCheckbox.disabled = cannotModifyLocked;
        }

        if (editStrictPrereqCheckbox) {
            editStrictPrereqCheckbox.checked = isShielded;
            editStrictPrereqCheckbox.disabled = cannotModifyLocked || cannotUnshield;
        }

        if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = isLocked ? 'block' : 'none';

        if (editExemplarChip && window.ExemplarStore) {
            const exemplarRecord = await ExemplarStore.getExemplar(task.id);
            if (exemplarRecord && isLocked) {
                if (editExemplarName) editExemplarName.textContent = exemplarRecord.fileName || exemplarRecord.filename || 'Attached Reference Exemplar';
                if (editExemplarSize) {
                    const bytes = exemplarRecord.fileSize || exemplarRecord.size || 0;
                    editExemplarSize.textContent = bytes ? (bytes / (1024 * 1024)).toFixed(2) + ' MB' : '';
                }
                editExemplarChip.style.display = 'flex';
            } else {
                editExemplarChip.style.display = 'none';
            }
        }

        const editFileWrapper = editCriteriaBoxContainer?.querySelector('.file-picker-wrapper');
        const editActionsBar = editCriteriaBoxContainer?.querySelector('.criteria-actions-bar');
        if (editFileWrapper) editFileWrapper.style.display = cannotModifyLocked ? 'none' : 'block';
        if (editActionsBar) editActionsBar.style.display = cannotModifyLocked ? 'none' : 'flex';

        if (editTaskTitle) editTaskTitle.contentEditable = cannotModifyLocked ? 'false' : 'true';
        if (editTaskDueDate) editTaskDueDate.disabled = cannotModifyLocked;
        if (editTaskCriteria) {
            editTaskCriteria.disabled = cannotModifyLocked;
            editTaskCriteria.value = task.proof_criteria || '';
        }

        if (deleteFromDetailBtn) {
            const isDeleteBlocked = !isBypassActive && (isLocked || (isShielded && hasUncompletedDescendant(taskId)));
            deleteFromDetailBtn.disabled = isDeleteBlocked;
        }

        if (detailLockStatusBadge) {
            if (isLocked) {
                detailLockStatusBadge.innerHTML = isBypassActive
                    ? '<span class="tag-chip" style="background:#451a03;color:#fde68a;">Bypass Active</span>'
                    : '<span class="ai-badge">🔒 Locked</span>';
            } else {
                detailLockStatusBadge.innerHTML = '<span class="tag-chip">Standard</span>';
            }
        }

        refreshDetailSubtaskList(taskId, triggerRenderFn);

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

        const subtaskList = document.getElementById('subtaskBuilderList');
        if (subtaskList) subtaskList.innerHTML = '';

        const dueIn = document.getElementById('taskDueDateInput');
        if (dueIn) {
            dueIn.value = (currentView === 'today') ? getAppTodayStr() : '';
        }

        const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
        const mrStudyRewardInputs = document.getElementById('mrstudyRewardInputs');
        const mrstudyXpInput = document.getElementById('mrstudyXpInput');
        const mrstudyBanchInput = document.getElementById('mrstudyBanchInput');
        const aiLockCheckbox = document.getElementById('aiLockCheckbox');
        const strictPrereqCheckbox = document.getElementById('strictPrereqCheckbox');
        const mrstudyAiNotice = document.getElementById('mrstudyAiNotice');

        if (mrStudySelect) mrStudySelect.value = '';
        if (mrStudyRewardInputs) mrStudyRewardInputs.style.display = 'none';
        if (mrstudyXpInput) mrstudyXpInput.value = '';
        if (mrstudyBanchInput) mrstudyBanchInput.value = '';
        if (aiLockCheckbox) {
            aiLockCheckbox.checked = false;
            aiLockCheckbox.disabled = false;
        }
        if (strictPrereqCheckbox) {
            strictPrereqCheckbox.checked = false;
            strictPrereqCheckbox.disabled = false;
        }
        if (mrstudyAiNotice) mrstudyAiNotice.style.display = 'none';
        
        const exemplarInput = document.getElementById('createExemplarInput');
        const exemplarChip = document.getElementById('createExemplarChip');
        const exemplarGuidance = document.getElementById('exemplarGuidanceNote');
        if (exemplarInput) exemplarInput.value = '';
        if (exemplarChip) exemplarChip.style.display = 'none';
        if (exemplarGuidance) exemplarGuidance.style.display = 'none';

        const pIdFieldVal = parentId || '';

        const projectGroup = document.getElementById('createProjectCloud')?.closest('.form-group');
        if (projectGroup) {
            projectGroup.style.display = pIdFieldVal ? 'none' : 'block';
        }

        createModalSelectedTags.clear();
        createModalSelectedPriority = getLowestPriorityId();

        if (pIdFieldVal) {
            const parentTask = tasks.find(t => t.id === pIdFieldVal);
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

        updateMrStudyRuleDropdown();

        const modal = document.getElementById('addTaskModal');
        if (modal) {
            modal.classList.add('open');
            setTimeout(() => { if (titleEl) titleEl.focus(); }, 100);
        }
    }

    // =========================================================================
    // Break System UI Controller (Floating 10m Window & Daily Lock)
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
                : { canStart: true, canEdit: false, isRunning: false, isLocked: false, isInBuffer: false, remainingWindowMs: 0, reason: '', bounds: { start: new Date() } };

            const breaks = window.TaskitatorEngine?.BreakEngine?.getTodayBreaks 
                ? TaskitatorEngine.BreakEngine.getTodayBreaks 
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
                if (breaks.length > 0) {
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
                if (breaks.length > 0) {
                    breaks.forEach(b => this.addBreakRow(b.start, b.end, true));
                } else {
                    this.rowsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 14px 0;">No breaks scheduled. Click "Start 10m Planning Window" to configure.</div>';
                }

                if (this.addBtn) this.addBtn.style.display = 'none';
                if (this.saveBtn) this.saveBtn.style.display = 'none';

            } else {
                // Locked or in final 6-hour buffer
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
                if (breaks.length > 0) {
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
                "⚠️ CONFIRM & LOCK DAILY SCHEDULE ⚠️\n\n" +
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

        // Cycle-guarded membership check
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

        // Cycle-guarded descendant visibility check
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
                // Retain root parent if it matches or has matching descendants
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
        } else {
            function buildNodeElement(task, depth = 0) {
                const li = document.createElement('li');
                const isDone = task.status === 'completed';
                
                const isOverdue = !isDone && 
                                  task.due_date && 
                                  /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) && 
                                  task.due_date < todayStr;

                const isSelected = selectedTaskIds.has(task.id);
                li.className = `task-node ${isDone ? 'completed' : ''} ${isOverdue ? 'is-overdue' : ''} ${isSelected ? 'row-selected' : ''}`;

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

                // Checkbox / Square Selection Box
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

                // Row Click Handler (Selection vs Detail Modal)
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
            if (task.ai_locked) badgesHtml += '<span class="ai-badge">🔒 AI</span> ';
            if (task.strict_prerequisites) badgesHtml += '<span class="ai-badge" style="background:#451a03; color:#fde68a; border-color:#78350f;">🛡️️ Shielded</span>';

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

        try {
            const rawRules = localStorage.getItem('taskitator_mrstudy_rules');
            if (rawRules) {
                activeMrStudyRules = JSON.parse(rawRules) || [];
                isMrStudyLinked = activeMrStudyRules.length > 0;
            }
        } catch (e) {}

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
                        pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${p.color};"></span> ${p.name}`;
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

        // Batch Due Date Modal (with EC.2-A Guard)
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

                    // EC.2-A: Protect overdue AI-locked tasks against date postponement
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

        // Sibling Criteria & Exemplar Inheritance Hook (EC.3-B, EC.3-D)
        const applySiblingInheritBtn = document.getElementById('applySiblingInheritBtn');
        if (applySiblingInheritBtn) {
            applySiblingInheritBtn.addEventListener('click', async () => {
                const siblingSelect = document.getElementById('siblingTaskSelect');
                const sibId = siblingSelect?.value;
                if (!sibId) {
                    alert('Please select a sibling task first.');
                    return;
                }

                const sibling = tasks.find(t => t.id === sibId);
                if (!sibling) return;

                const editTaskCriteriaInput = document.getElementById('editTaskCriteria');
                const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
                const editCriteriaBoxContainer = document.getElementById('editCriteriaBoxContainer');
                const editExemplarChip = document.getElementById('editExemplarChip');
                const editExemplarName = document.getElementById('editExemplarName');
                const editExemplarSize = document.getElementById('editExemplarSize');
                const editFeedback = document.getElementById('editCriteriaFeedbackBox');

                if (editTaskCriteriaInput) editTaskCriteriaInput.value = sibling.proof_criteria || '';
                if (editAiLockCheckbox) editAiLockCheckbox.checked = true;
                if (editCriteriaBoxContainer) editCriteriaBoxContainer.style.display = 'block';

                // Deep clone ExemplarStore binary blob
                if (window.ExemplarStore) {
                    const sibRecord = await ExemplarStore.getExemplar(sibling.id);
                    const inlineObj = sibRecord?.inline_data || sibRecord?.inlineData;
                    if (inlineObj && inlineObj.data) {
                        try {
                            const mimeType = inlineObj.mime_type || sibRecord.mimeType || 'application/pdf';
                            const fileName = sibRecord.fileName || sibRecord.filename || 'cloned_exemplar.pdf';
                            const byteChars = atob(inlineObj.data);
                            const byteNums = new Array(byteChars.length);
                            for (let i = 0; i < byteChars.length; i++) {
                                byteNums[i] = byteChars.charCodeAt(i);
                            }
                            const byteArray = new Uint8Array(byteNums);
                            const clonedBlob = new Blob([byteArray], { type: mimeType });
                            pendingEditExemplarFile = new File([clonedBlob], fileName, { type: mimeType });

                            if (editExemplarName) editExemplarName.textContent = pendingEditExemplarFile.name;
                            if (editExemplarSize) editExemplarSize.textContent = (pendingEditExemplarFile.size / (1024 * 1024)).toFixed(2) + ' MB';
                            if (editExemplarChip) editExemplarChip.style.display = 'flex';
                        } catch (err) {
                            console.warn('[Inheritance] Exemplar blob reconstruction error:', err);
                        }
                    }
                }

                editCriteriaValidationState = { validated: true, score: 10, isTemplate: true };
                if (editFeedback) {
                    editFeedback.style.display = 'block';
                    editFeedback.className = 'criteria-feedback-box pass';
                    editFeedback.innerHTML = `<strong>✓ Inherited (10/10)</strong>: Copied criteria and cloned reference exemplar from "${sibling.title}".`;
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

        // Sequential Subtask Entry with Criteria Inheritance & Variable Resolution
        const detailQuickSubtaskInput = document.getElementById('detailQuickSubtaskInput');
        if (detailQuickSubtaskInput) {
            detailQuickSubtaskInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!activeDetailTaskId) return;
                    
                    const rawSubInput = detailQuickSubtaskInput.value.trim();
                    if (!rawSubInput) return;

                    const parentTask = tasks.find(t => t.id === activeDetailTaskId);
                    if (!parentTask) return;

                    const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawSubInput);

                    // Inherit proof criteria template from parent if parent has one
                    let resolvedCriteria = '';
                    if (parentTask.proof_criteria) {
                        const res = SmartCriteriaEngine.resolveCriteria(parentTask.proof_criteria, varMap);
                        resolvedCriteria = res.resolvedText;
                    }

                    const newTaskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
                    const newSubtask = {
                        id: newTaskId,
                        parent_id: activeDetailTaskId,
                        title: cleanTitle,
                        raw_title: rawSubInput,
                        description: '',
                        tags: [],
                        priority_id: getLowestPriorityId(),
                        project_id: parentTask.project_id || 'inbox',
                        status: 'active',
                        due_date: '',
                        ai_locked: false,
                        proof_criteria: resolvedCriteria,
                        strict_prerequisites: false,
                        created_at: new Date().toISOString(),
                        completed_at: null
                    };

                    tasks.push(newSubtask);
                    saveStorageAndPush();

                    const taskDetailModal = document.getElementById('taskDetailModal');
                    refreshDetailSubtaskList(activeDetailTaskId, taskDetailModal?._customRenderFn);

                    if (typeof taskDetailModal?._customRenderFn === 'function') {
                        taskDetailModal._customRenderFn();
                    } else {
                        renderUnifiedView();
                    }

                    detailQuickSubtaskInput.value = '';
                    detailQuickSubtaskInput.focus();
                }
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
                if (!aiLockCheckbox.disabled && cBox) {
                    cBox.style.display = aiLockCheckbox.checked ? 'block' : 'none';
                }
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

        // Gamification Selection Handlers
        const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
        const mrStudyRewardInputs = document.getElementById('mrstudyRewardInputs');
        const mrstudyXpInput = document.getElementById('mrstudyXpInput');
        const mrstudyBanchInput = document.getElementById('mrstudyBanchInput');
        const mrstudyXpRangeLabel = document.getElementById('mrstudyXpRangeLabel');
        const mrstudyBanchRangeLabel = document.getElementById('mrstudyBanchRangeLabel');
        const mrstudyAiNotice = document.getElementById('mrstudyAiNotice');
        
        const mrstudyInfoTriggerBtn = document.getElementById('mrstudyInfoTriggerBtn');
        const mrstudyInfoModal = document.getElementById('mrstudyInfoModal');
        const closeMrstudyInfoModalBtn = document.getElementById('closeMrstudyInfoModalBtn');
        const dismissMrstudyInfoModalBtn = document.getElementById('dismissMrstudyInfoModalBtn');

        if (mrstudyInfoTriggerBtn && mrstudyInfoModal) {
            mrstudyInfoTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                mrstudyInfoModal.classList.add('open');
            });
            if (closeMrstudyInfoModalBtn) closeMrstudyInfoModalBtn.addEventListener('click', () => mrstudyInfoModal.classList.remove('open'));
            if (dismissMrstudyInfoModalBtn) dismissMrstudyInfoModalBtn.addEventListener('click', () => mrstudyInfoModal.classList.remove('open'));
        }

        if (mrStudySelect && mrStudyRewardInputs && aiLockCheckbox) {
            mrStudySelect.addEventListener('change', () => {
                const ruleId = mrStudySelect.value;
                if (!ruleId) {
                    mrStudyRewardInputs.style.display = 'none';
                    mrstudyXpInput.removeAttribute('required');
                    mrstudyBanchInput.removeAttribute('required');
                    aiLockCheckbox.disabled = false;
                    mrstudyAiNotice.style.display = 'none';
                    return;
                }

                const rule = activeMrStudyRules.find(r => r.id === ruleId);
                if (rule) {
                    mrStudyRewardInputs.style.display = 'block';
                    
                    mrstudyXpInput.min = rule.min_xp;
                    mrstudyXpInput.max = rule.max_xp;
                    mrstudyXpInput.value = rule.max_xp;
                    mrstudyXpInput.required = true;
                    if (mrstudyXpRangeLabel) mrstudyXpRangeLabel.textContent = `${rule.min_xp} – ${rule.max_xp}`;
                    
                    mrstudyBanchInput.min = rule.min_banch;
                    mrstudyBanchInput.max = rule.max_banch;
                    mrstudyBanchInput.value = rule.max_banch;
                    mrstudyBanchInput.required = true;
                    if (mrstudyBanchRangeLabel) mrstudyBanchRangeLabel.textContent = `${rule.min_banch} – ${rule.max_banch}`;

                    if (rule.requires_ai) {
                        aiLockCheckbox.checked = true;
                        aiLockCheckbox.disabled = true;
                        mrstudyAiNotice.style.display = 'block';
                        
                        const cBox = document.getElementById('criteriaBoxContainer');
                        if (cBox) cBox.style.display = 'block';

                        const labelEl = aiLockCheckbox.closest('label');
                        if (labelEl) {
                            labelEl.style.transition = 'color 0.3s ease';
                            labelEl.style.color = '#fbbf24';
                            setTimeout(() => labelEl.style.color = '', 800);
                        }
                    } else {
                        aiLockCheckbox.disabled = false;
                        mrstudyAiNotice.style.display = 'none';
                    }
                }
            });

            mrstudyXpInput.addEventListener('change', () => {
                if (!mrstudyXpInput.value) return;
                const min = parseInt(mrstudyXpInput.min, 10);
                const max = parseInt(mrstudyXpInput.max, 10);
                let val = parseInt(mrstudyXpInput.value, 10);
                if (val < min) val = min;
                if (val > max) val = max;
                mrstudyXpInput.value = val;
            });
            mrstudyBanchInput.addEventListener('change', () => {
                if (!mrstudyBanchInput.value) return;
                const min = parseInt(mrstudyBanchInput.min, 10);
                const max = parseInt(mrstudyBanchInput.max, 10);
                let val = parseInt(mrstudyBanchInput.value, 10);
                if (val < min) val = min;
                if (val > max) val = max;
                mrstudyBanchInput.value = val;
            });
        }

        window.addEventListener('taskitator-mrstudy-rules-updated', (e) => {
            if (e.detail) {
                isMrStudyLinked = e.detail.linked;
                activeMrStudyRules = e.detail.rules || [];
                const modal = document.getElementById('addTaskModal');
                if (modal && modal.classList.contains('open')) {
                    updateMrStudyRuleDropdown();
                }
            }
        });

        // Exemplar Picker in Creation
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

        // Exemplar Picker in Edit / Detail Modal
        const editExemplarInput = document.getElementById('editExemplarInput');
        const editExemplarChip = document.getElementById('editExemplarChip');
        const editExemplarName = document.getElementById('editExemplarName');
        const editExemplarSize = document.getElementById('editExemplarSize');
        const removeEditExemplarBtn = document.getElementById('removeEditExemplarBtn');

        if (editExemplarInput) {
            editExemplarInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) {
                    pendingEditExemplarFile = null;
                    return;
                }
                const maxBytes = 5 * 1024 * 1024;
                if (file.size > maxBytes) {
                    alert(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed is 5 MB.`);
                    editExemplarInput.value = '';
                    pendingEditExemplarFile = null;
                    return;
                }
                pendingEditExemplarFile = file;
                if (editExemplarName) editExemplarName.textContent = file.name;
                if (editExemplarSize) editExemplarSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
                if (editExemplarChip) editExemplarChip.style.display = 'flex';

                editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
                const fb = document.getElementById('editCriteriaFeedbackBox');
                if (fb) {
                    fb.style.display = 'none';
                    fb.innerHTML = '';
                }
            });
        }

        if (removeEditExemplarBtn) {
            removeEditExemplarBtn.addEventListener('click', async () => {
                if (editExemplarInput) editExemplarInput.value = '';
                pendingEditExemplarFile = null;
                if (activeDetailTaskId && window.ExemplarStore) {
                    await window.ExemplarStore.deleteExemplar(activeDetailTaskId);
                }
                if (editExemplarChip) editExemplarChip.style.display = 'none';
                editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
                const fb = document.getElementById('editCriteriaFeedbackBox');
                if (fb) {
                    fb.style.display = 'none';
                    fb.innerHTML = '';
                }
            });
        }

        NLPEngine.upgradeInput('taskTitleInput', 'create');
        NLPEngine.upgradeInput('editTaskTitle', 'edit');

        // Task Creation Submission Hook (Smart Criteria Variable Linker Integration)
        const taskCreateForm = document.getElementById('taskCreateForm');
        if (taskCreateForm) {
            taskCreateForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const rawTitle = NLPEngine.extractCleanTitle('taskTitleInput');
                const desc = document.getElementById('taskDescInput')?.value.trim() || '';
                const dueDate = document.getElementById('taskDueDateInput')?.value || '';
                const isAi = Boolean(document.getElementById('aiLockCheckbox')?.checked);
                const isStrictPrereq = Boolean(document.getElementById('strictPrereqCheckbox')?.checked);
                const rawCriteria = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                const parentId = document.getElementById('creationParentId')?.value || null;
                
                const exemplarInput = document.getElementById('createExemplarInput');
                const exemplarFile = (isAi && exemplarInput && exemplarInput.files.length > 0) ? exemplarInput.files[0] : null;

                if (!rawTitle) return;

                // Smart Criteria Variable Linker: Parse Title Variables
                const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawTitle);

                // Smart Criteria Variable Linker: Resolve Criteria & Guard Validation
                let finalCriteria = rawCriteria;
                if (isAi && rawCriteria) {
                    const gate = SmartCriteriaEngine.validateCriteriaForSubmission(rawCriteria, varMap);
                    if (!gate.valid) return;
                    finalCriteria = gate.resolvedText;

                    if (isStrictCriteriaModeEnabled()) {
                        if (!criteriaValidationState.validated || criteriaValidationState.score < 7) {
                            alert('Criteria validation required: Please click "Validate Criteria" and ensure a score of at least 7/10 before creating an AI-locked task.');
                            return;
                        }
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
                } else if (isStrictPrereq) {
                    const confirmed = confirm(
                        "⚠️ IRREVERSIBLE SHIELD ⚠️\n\n" +
                        "The Shield is permanent.\n" +
                        "Once created, this task cannot be completed until ALL subtasks are finished, and the Shield cannot be turned off.\n\n" +
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
                    title: cleanTitle,
                    raw_title: rawTitle,
                    description: desc,
                    tags: Array.from(createModalSelectedTags),
                    priority_id: createModalSelectedPriority,
                    project_id: assignedProject,
                    status: 'active',
                    due_date: dueDate,
                    ai_locked: isAi,
                    proof_criteria: isAi ? finalCriteria : '',
                    strict_prerequisites: isStrictPrereq,
                    created_at: new Date().toISOString(),
                    completed_at: null
                };

                const mrStudySelect = document.getElementById('taskMrstudyRuleSelect');
                if (mrStudySelect && mrStudySelect.value && isMrStudyLinked) {
                    const ruleId = mrStudySelect.value;
                    const assignedXp = parseInt(document.getElementById('mrstudyXpInput')?.value || 0, 10);
                    const assignedBanch = parseInt(document.getElementById('mrstudyBanchInput')?.value || 0, 10);
                    
                    newTask.mrstudy_binding = {
                        rule_id: ruleId,
                        assigned_xp: assignedXp,
                        assigned_banch: assignedBanch
                    };
                }

                tasks.push(newTask);

                if (subtaskBuilderList) {
                    const quickSubtaskInputs = subtaskBuilderList.querySelectorAll('.subtask-input-title');
                    quickSubtaskInputs.forEach(input => {
                        const rawSubText = input.value.trim();
                        if (rawSubText) {
                            const subParsed = SmartCriteriaEngine.parseTitle(rawSubText);
                            tasks.push({
                                id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                                parent_id: newTaskId,
                                title: subParsed.cleanTitle,
                                raw_title: rawSubText,
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
                
                const addTaskModal = document.getElementById('addTaskModal');
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
                pendingEditExemplarFile = null;
            });
        }

        const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
        if (editAiLockCheckbox) {
            editAiLockCheckbox.addEventListener('change', () => {
                const cBox = document.getElementById('editCriteriaBoxContainer');
                if (!editAiLockCheckbox.disabled && cBox) {
                    cBox.style.display = editAiLockCheckbox.checked ? 'block' : 'none';
                    if (editAiLockCheckbox.checked) {
                        const task = tasks.find(t => t.id === activeDetailTaskId);
                        if (!task || !task.ai_locked) {
                            editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
                        }
                    }
                }
            });
        }

        const editTaskCriteriaInput = document.getElementById('editTaskCriteria');
        if (editTaskCriteriaInput) {
            editTaskCriteriaInput.addEventListener('input', () => {
                editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
            });
        }

        // Save Task Details Hook (Handling Move Task, Sibling Criteria & Smart Variable Linker)
        const saveTaskDetailsBtn = document.getElementById('saveTaskDetailsBtn');
        if (saveTaskDetailsBtn) {
            saveTaskDetailsBtn.addEventListener('click', async () => {
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
                let willBeStrict = Boolean(document.getElementById('editStrictPrereqCheckbox')?.checked);
                const editedCriteriaRaw = document.getElementById('editTaskCriteria')?.value.trim() || '';
                const rawEditedTitle = NLPEngine.extractCleanTitle('editTaskTitle') || task.raw_title || task.title;

                // Smart Criteria Variable Linker: Parse Title Variables
                const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawEditedTitle);

                // Handle Move Task: Target Parent / Re-parenting
                const editTaskParentSelect = document.getElementById('editTaskParentSelect');
                const targetParentId = editTaskParentSelect ? (editTaskParentSelect.value.trim() || null) : task.parent_id;

                if (targetParentId !== task.parent_id) {
                    const shieldedAncestor = getShieldedAncestor(task.id);
                    if (shieldedAncestor && !isBypassActive) {
                        alert("Shielded task can't be moved out of their parents.");
                        return;
                    }

                    const descendants = getAllDescendants(task.id);
                    if (descendants.some(d => d.id === targetParentId)) {
                        alert("Circular Reference Error: You cannot move a task into one of its own subtasks.");
                        return;
                    }

                    task.parent_id = targetParentId;

                    // Cascade project_id down the subtree
                    if (targetParentId) {
                        const targetParent = tasks.find(t => t.id === targetParentId);
                        if (targetParent) {
                            task.project_id = targetParent.project_id || 'inbox';
                            cascadeProject(task.id, task.project_id);
                        }
                    }
                }

                if (task.strict_prerequisites && !isBypassActive) {
                    willBeStrict = true;
                }

                let finalEditedCriteria = editedCriteriaRaw;
                if (willBeAiLocked && (!task.ai_locked || isBypassActive)) {
                    if (editedCriteriaRaw) {
                        const gate = SmartCriteriaEngine.validateCriteriaForSubmission(editedCriteriaRaw, varMap);
                        if (!gate.valid) return;
                        finalEditedCriteria = gate.resolvedText;
                    }

                    if (isStrictCriteriaModeEnabled()) {
                        if (!editCriteriaValidationState.validated || editCriteriaValidationState.score < 7) {
                            alert('Criteria validation required: Please click "Validate Criteria" and ensure a score of at least 7/10 before saving an AI-locked task.');
                            return;
                        }
                    }
                }

                if (!task.ai_locked && willBeAiLocked) {
                    const confirmed = confirm(
                        "⚠️ IRREVOCABLE TASK WARNING ⚠️\n\n" +
                        "Enabling AI Proof on this task is permanent.\n" +
                        "Once saved, this task cannot be un-checked, criteria cannot be changed, and it CANNOT be deleted without an Emergency Bypass.\n\n" +
                        "Do you want to permanently lock this task?"
                    );
                    if (!confirmed) return;
                } else if (!task.strict_prerequisites && willBeStrict && !willBeAiLocked) {
                    const confirmed = confirm(
                        "⚠️ IRREVERSIBLE SHIELD ⚠️\n\n" +
                        "Enabling the Shield is permanent.\n" +
                        "Once saved, this task cannot be completed until ALL subtasks are finished, and the Shield cannot be turned off.\n\n" +
                        "Proceed?"
                    );
                    if (!confirmed) return;
                }

                if (pendingEditExemplarFile && willBeAiLocked && window.ExemplarStore) {
                    try {
                        await window.ExemplarStore.saveExemplar(task.id, pendingEditExemplarFile);
                        pendingEditExemplarFile = null;
                    } catch (err) {
                        alert(`Failed to save reference exemplar: ${err.message}`);
                        return;
                    }
                }

                task.description = document.getElementById('editTaskDesc')?.value.trim() || '';
                task.tags = Array.from(editModalSelectedTags);
                task.priority_id = editModalSelectedPriority;

                if (!task.parent_id) {
                    const oldProjectId = task.project_id;
                    task.project_id = editModalSelectedProject || 'inbox';
                    if (oldProjectId !== task.project_id) {
                        cascadeProject(task.id, task.project_id);
                    }
                }

                if (!task.ai_locked || isBypassActive) {
                    task.title = cleanTitle;
                    task.raw_title = rawEditedTitle;
                    task.due_date = document.getElementById('editTaskDueDate')?.value || '';
                    task.ai_locked = willBeAiLocked;
                    task.proof_criteria = willBeAiLocked ? finalEditedCriteria : '';
                }
                
                task.strict_prerequisites = willBeStrict;

                saveStorageAndPush();
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                
                const customRender = taskDetailModal?._customRenderFn;
                activeDetailTaskId = null;
                pendingEditExemplarFile = null;

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
                pendingEditExemplarFile = null;
            });
        }

        const openChildAddModalBtn = document.getElementById('openChildAddModalBtn');
        if (openChildAddModalBtn) {
            openChildAddModalBtn.addEventListener('click', () => {
                if (!activeDetailTaskId) return;
                const parentTask = tasks.find(t => t.id === activeDetailTaskId);
                if (taskDetailModal) taskDetailModal.classList.remove('open');
                activeDetailTaskId = null;
                pendingEditExemplarFile = null;
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

        // Dual-Evidence Audit Submission
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
                        if (exemplarRecord && exemplarRecord.inline_data) {
                            refExemplarPart = exemplarRecord.inline_data;
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

                const is503Outage = !result.success && (
                    result.status === 503 ||
                    result.code === 503 ||
                    (typeof result.error === 'string' && (
                        result.error.includes('503') ||
                        result.error.includes('UNAVAILABLE') ||
                        result.error.includes('high demand')
                    ))
                );

                if (is503Outage) {
                    const count = (consecutive503Tracker.get(pendingAuditTaskId) || 0) + 1;
                    consecutive503Tracker.set(pendingAuditTaskId, count);

                    if (count >= 5) {
                        consecutive503Tracker.delete(pendingAuditTaskId);
                        task.verified_model = 'gemini-fallback-auto-503';
                        cascadeTaskStatus(pendingAuditTaskId, 'completed', new Date().toISOString());
                        SoundFX.playSuccessAudit();
                        saveStorageAndPush();
                        
                        const completedTaskId = pendingAuditTaskId;
                        finalizeTaskCompletion(completedTaskId).then(() => {
                            if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                                const breaks = getTodayBreaksSafe();
                                SyncEngine.forceImmediateSync({ today_breaks: breaks });
                            }
                        });

                        if (auditModal) auditModal.classList.remove('open');
                        pendingAuditTaskId = null;
                        renderUnifiedView();
                        return;
                    }
                } else if (result.success) {
                    consecutive503Tracker.delete(pendingAuditTaskId);
                } else {
                    consecutive503Tracker.delete(pendingAuditTaskId);
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
                    
                    const completedTaskId = pendingAuditTaskId;
                    finalizeTaskCompletion(completedTaskId).then(() => {
                        if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                            const breaks = getTodayBreaksSafe();
                            SyncEngine.forceImmediateSync({ today_breaks: breaks });
                        }
                    });

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

        // Validate Criteria (Pre-flight) Engine: Shared Handler with Smart Criteria Interpolation
        async function runCriteriaValidation(criteriaText, taskTitle, exemplarFile, feedbackEl, btnEl, isEditMode) {
            if (!criteriaText) {
                if (feedbackEl) {
                    feedbackEl.style.display = 'block';
                    feedbackEl.className = 'criteria-feedback-box fail';
                    feedbackEl.textContent = 'Please enter proof criteria before validating.';
                }
                return;
            }

            // Smart Criteria Variable Linker: Parse Title and Resolve Template Placeholders
            const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(taskTitle);
            const { resolvedText, hasUnresolved, unresolvedKeys } = SmartCriteriaEngine.resolveCriteria(criteriaText, varMap);

            if (hasUnresolved) {
                const missing = unresolvedKeys.length > 0 ? unresolvedKeys.join(', ') : 'unknown';
                alert(`Criteria Error: Cannot validate criteria with unresolved template variables: {${missing}}.\nPlease define all variables in the task title (e.g. {${missing}==value}).`);
                if (feedbackEl) {
                    feedbackEl.style.display = 'block';
                    feedbackEl.className = 'criteria-feedback-box fail';
                    feedbackEl.innerHTML = `<strong>Validation Blocked:</strong> Unresolved template variable(s): <code>{${missing}}</code>`;
                }
                return;
            }

            btnEl.disabled = true;
            btnEl.textContent = 'Validating...';
            if (feedbackEl) {
                feedbackEl.style.display = 'block';
                feedbackEl.className = 'criteria-feedback-box loading';
                feedbackEl.textContent = 'Auditing criteria with forensic model...';
            }

            let res = { success: false, error: 'Audit engine missing' };
            if (window.TaskitatorEngine?.AuditEngine?.validateCriteria) {
                res = await TaskitatorEngine.AuditEngine.validateCriteria(resolvedText, cleanTitle, exemplarFile);
            }

            btnEl.disabled = false;
            btnEl.textContent = '🔍 Validate Criteria';

            const stateTarget = isEditMode ? editCriteriaValidationState : criteriaValidationState;

            if (!res.success) {
                if (feedbackEl) {
                    feedbackEl.className = 'criteria-feedback-box fail';
                    feedbackEl.innerHTML = `<strong>Audit Halted:</strong> ${res.error || 'Failed to communicate with AI model.'}`;
                }
                stateTarget.validated = false;
                stateTarget.score = 0;
                stateTarget.isTemplate = false;
                return;
            }

            stateTarget.validated = true;
            stateTarget.score = res.score;
            stateTarget.isTemplate = false;

            if (feedbackEl) {
                if (res.passed) {
                    feedbackEl.className = 'criteria-feedback-box pass';
                    feedbackEl.innerHTML = `<strong>✓ Verified (${res.score}/10)</strong>: ${res.critique}`;
                } else {
                    feedbackEl.className = 'criteria-feedback-box fail';
                    let feedbackHtml = `<strong>⚠️ Low Quality Rating (${res.score}/10)</strong>: ${res.critique}`;
                    if (res.suggested_rewrite) {
                        feedbackHtml += `
                            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.2);">
                                <strong>Suggested Artifact:</strong> "${res.suggested_rewrite}"
                                <div style="margin-top: 6px;">
                                    <button type="button" class="icon-btn apply-suggestion-btn" style="padding: 3px 8px; font-size: 0.75rem; background: var(--card-subtle);">Use Suggestion</button>
                                </div>
                            </div>
                        `;
                    }
                    feedbackEl.innerHTML = feedbackHtml;

                    const applyBtn = feedbackEl.querySelector('.apply-suggestion-btn');
                    if (applyBtn) {
                        applyBtn.addEventListener('click', () => {
                            const inputEl = isEditMode 
                                ? document.getElementById('editTaskCriteria') 
                                : document.getElementById('taskCriteriaInput');
                            if (inputEl) inputEl.value = res.suggested_rewrite;
                            stateTarget.validated = true;
                            stateTarget.score = 9;
                            stateTarget.isTemplate = true;
                            feedbackEl.className = 'criteria-feedback-box pass';
                            feedbackEl.innerHTML = `<strong>✓ Verified (9/10)</strong>: Applied forensic suggestion.`;
                        });
                    }
                }
            }
        }

        // Creation Validation Button
        const validateCriteriaBtn = document.getElementById('validateCriteriaBtn');
        if (validateCriteriaBtn) {
            validateCriteriaBtn.addEventListener('click', async () => {
                const criteriaText = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                const rawTitle = NLPEngine.extractCleanTitle('taskTitleInput') || '';
                const feedback = document.getElementById('criteriaFeedbackBox');
                const exemplarInput = document.getElementById('createExemplarInput');
                const exemplarFile = (exemplarInput && exemplarInput.files.length > 0) ? exemplarInput.files[0] : null;

                await runCriteriaValidation(criteriaText, rawTitle, exemplarFile, feedback, validateCriteriaBtn, false);
            });
        }

        // Edit Modal Validation Button
        const editValidateCriteriaBtn = document.getElementById('editValidateCriteriaBtn');
        if (editValidateCriteriaBtn) {
            editValidateCriteriaBtn.addEventListener('click', async () => {
                const criteriaText = document.getElementById('editTaskCriteria')?.value.trim() || '';
                const rawTitle = NLPEngine.extractCleanTitle('editTaskTitle') || '';
                const feedback = document.getElementById('editCriteriaFeedbackBox');
                
                let exemplarFile = pendingEditExemplarFile;
                if (!exemplarFile && activeDetailTaskId && window.ExemplarStore) {
                    const record = await window.ExemplarStore.getExemplar(activeDetailTaskId);
                    if (record && record.blob) exemplarFile = record.blob;
                }

                await runCriteriaValidation(criteriaText, rawTitle, exemplarFile, feedback, editValidateCriteriaBtn, true);
            });
        }

        // Template Picker Modal
        const templatesModal = document.getElementById('templatesModal');
        const closeTemplatesModalBtn = document.getElementById('closeTemplatesModalBtn');
        const openTemplatesBtn = document.getElementById('openTemplatesBtn');
        const editOpenTemplatesBtn = document.getElementById('editOpenTemplatesBtn');

        async function openTemplatesPicker(targetMode) {
            activeTemplateTarget = targetMode;
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
                            if (activeTemplateTarget === 'edit') {
                                const tIn = document.getElementById('editTaskCriteria');
                                if (tIn) tIn.value = t.template;
                                editCriteriaValidationState = { validated: true, score: 10, isTemplate: true };
                                const fb = document.getElementById('editCriteriaFeedbackBox');
                                if (fb) {
                                    fb.style.display = 'block';
                                    fb.className = 'criteria-feedback-box pass';
                                    fb.innerHTML = `<strong>✓ Verified (10/10)</strong>: Standard verified artifact template selected.`;
                                }
                            } else {
                                const tIn = document.getElementById('taskCriteriaInput');
                                if (tIn) tIn.value = t.template;
                                criteriaValidationState = { validated: true, score: 10, isTemplate: true };
                                const fb = document.getElementById('criteriaFeedbackBox');
                                if (fb) {
                                    fb.style.display = 'block';
                                    fb.className = 'criteria-feedback-box pass';
                                    fb.innerHTML = `<strong>✓ Verified (10/10)</strong>: Standard verified artifact template selected.`;
                                }
                            }
                            templatesModal.classList.remove('open');
                        });
                        container.appendChild(card);
                    });
                }
            }
            templatesModal.classList.add('open');
        }

        if (openTemplatesBtn) {
            openTemplatesBtn.addEventListener('click', () => openTemplatesPicker('create'));
        }
        if (editOpenTemplatesBtn) {
            editOpenTemplatesBtn.addEventListener('click', () => openTemplatesPicker('edit'));
        }
        if (closeTemplatesModalBtn && templatesModal) {
            closeTemplatesModalBtn.addEventListener('click', () => {
                templatesModal.classList.remove('open');
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

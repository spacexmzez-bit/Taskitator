/**
 * Taskitator task-editor components. Classic script; no imports or build step.
 * Owns editor/audit state and UI wiring. The core is supplied through Host API v1.
 * See MODULES.md for the contract and independent maintenance rules.
 */
window.TaskitatorComponents = Object.freeze({
    apiVersion: 1,
    create(host) {
        if (!host || host.apiVersion !== 1) {
            throw new Error('TaskitatorComponents requires Host API version 1.');
        }
        const required = {
            tasks: ['getAll', 'reload', 'save', 'sort', 'descendants', 'shieldedAncestor',
                'hasUncompletedDescendant', 'remove',
                'moveProject', 'setStatus', 'finalize'],
            catalogs: ['projects', 'tags', 'priorities', 'lowestPriority', 'addTag'],
            view: ['current', 'refresh'],
            rules: ['bypassActive', 'strictCriteria'],
            effects: ['auditSuccess'],
            clock: ['today'],
            breaks: ['today']
        };
        for (const [group, methods] of Object.entries(required)) {
            for (const method of methods) {
                if (typeof host[group]?.[method] !== 'function') {
                    throw new Error(`TaskitatorComponents requires host.${group}.${method}().`);
                }
            }
        }
        let initialized = false;
        let pendingAuditTaskId = null;
        let activeDetailTaskId = null;
        let criteriaValidationState = { validated: false, score: 0, isTemplate: false };
        let editCriteriaValidationState = { validated: false, score: 0, isTemplate: false };
        let pendingEditExemplarFile = null;
        let cachedTemplates = null;
        let activeTemplateTarget = 'create'; // 'create' | 'edit'
        const consecutive503Tracker = new Map(); // taskId -> consecutive 503 error count
        // Modal Selection State
        const createModalSelectedTags = new Set();
        let createModalSelectedPriority = null;
        let createModalSelectedProject = 'inbox';
        let createModalIsBonus = false;

        const editModalSelectedTags = new Set();
        let editModalSelectedPriority = null;
        let editModalSelectedProject = 'inbox';
        let editModalIsBonus = false;

        // Mr. Study Gamification State
        let activeMrStudyRules = [];
        let isMrStudyLinked = false;


        // =========================================================================
        // Smart Criteria Variable Linker Helper Engine
        // =========================================================================
        const SmartCriteriaEngine = {
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

                const hasUnresolved = unresolvedKeys.length > 0 || /\{[^}]+\}/.test(text);

                return {
                    resolvedText: text.trim(),
                    hasUnresolved,
                    unresolvedKeys
                };
            },

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

        // =========================================================================
        // Modal Selectors: Tags, Priorities & Projects
        // =========================================================================
        function renderModalProjectCloud(containerId, isEditModal) {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const globalProjects = host.catalogs.projects();

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

                TaskitatorSafety.setProjectLabel(pill, proj);

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
            const globalTags = host.catalogs.tags();

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
                host.catalogs.addTag(val);
                activeSet.add(val);
                input.value = '';
                renderModalTagCloud(containerId, activeSet);
            }
        }

        function renderModalPriorityCloud(containerId, isEditModal) {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const globalPriorities = host.catalogs.priorities();

            globalPriorities.forEach(p => {
                const pill = document.createElement('span');
                pill.className = 'priority-select-pill';
                const isSelected = isEditModal ? (editModalSelectedPriority === p.id) : (createModalSelectedPriority === p.id);

                if (isSelected) {
                    pill.classList.add('selected');
                    pill.style.color = p.color;
                }

                pill.innerHTML = `<span class="priority-color-dot" style="background-color: ${TaskitatorSafety.escapeHtml(p.color)};"></span> ${TaskitatorSafety.escapeHtml(p.name)}`;

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
        // Todoist-Style NLP Smart Creation Engine (Supports $$ Bonus Token)
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
                
                const match = textBeforeCaret.match(/(?:^|\s)((\$\$|[#!@][a-zA-Z0-9_.-]+))\s$/);
                if (!match) return;
                
                const rawToken = match[1];
                let chipData = null;

                if (rawToken === '$$') {
                    chipData = {
                        html: `<span class="nlp-chip nlp-bonus" contenteditable="false" data-type="bonus" data-raw="$$">⭐ Bonus <button type="button" class="nlp-chip-remove">&times;</button></span>`,
                        action: () => {
                            if (contextType === 'edit') {
                                editModalIsBonus = true;
                                const cb = document.getElementById('editBonusTaskCheckbox');
                                if (cb) cb.checked = true;
                            } else {
                                createModalIsBonus = true;
                                const cb = document.getElementById('bonusTaskCheckbox');
                                if (cb) cb.checked = true;
                            }
                        }
                    };
                } else {
                    const prefix = rawToken[0];
                    const value = rawToken.substring(1).toLowerCase();
                    
                    if (prefix === '!') {
                        const prios = host.catalogs.priorities();
                        let pId = null;
                        if (['p1', 'high'].includes(value)) pId = prios.find(p => p.rank === 1)?.id;
                        else if (['p2', 'med', 'medium'].includes(value)) pId = prios.find(p => p.rank === 2)?.id;
                        else if (['p3', 'low'].includes(value)) pId = prios.find(p => p.rank === 3)?.id;
                        
                        if (pId) {
                            const pObj = prios.find(p => p.id === pId);
                            chipData = {
                                html: `<span class="nlp-chip nlp-prio" contenteditable="false" data-type="prio" data-id="${TaskitatorSafety.escapeHtml(pId)}" data-raw="${TaskitatorSafety.escapeHtml(rawToken)}"><span class="priority-color-dot" style="background:${TaskitatorSafety.escapeHtml(pObj.color)}; width:8px; height:8px; display:inline-block; border-radius:50%; margin-right:4px;"></span>${TaskitatorSafety.escapeHtml(pObj.name)} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
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
                        const projs = host.catalogs.projects();
                        const pObj = projs.find(p => p.name.replace(/\s+/g, '').toLowerCase() === value);
                        if (pObj && pObj.id !== 'inbox') {
                            chipData = {
                                html: `<span class="nlp-chip nlp-proj" contenteditable="false" data-type="proj" data-id="${TaskitatorSafety.escapeHtml(pObj.id)}" data-raw="${TaskitatorSafety.escapeHtml(rawToken)}"><span>${TaskitatorSafety.escapeHtml(pObj.icon)}</span> ${TaskitatorSafety.escapeHtml(pObj.name)} <button type="button" class="nlp-chip-remove">&times;</button></span>`,
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
                                host.catalogs.addTag(value);
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
                    
                    if (type === 'bonus') {
                        if (contextType === 'edit') {
                            editModalIsBonus = false;
                            const cb = document.getElementById('editBonusTaskCheckbox');
                            if (cb) cb.checked = false;
                        } else {
                            createModalIsBonus = false;
                            const cb = document.getElementById('bonusTaskCheckbox');
                            if (cb) cb.checked = false;
                        }
                    } else if (type === 'prio') {
                        if (contextType === 'edit' && editModalSelectedPriority === id) {
                            editModalSelectedPriority = host.catalogs.lowestPriority();
                            renderModalPriorityCloud('editPriorityCloud', true);
                        } else if (contextType === 'create' && createModalSelectedPriority === id) {
                            createModalSelectedPriority = host.catalogs.lowestPriority();
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
        // Task Detail / Edit Modal Engine
        // =========================================================================
        function refreshDetailSubtaskList(parentId, triggerRenderFn) {
            const detailSubtasksList = document.getElementById('detailSubtasksList');
            const taskDetailModal = document.getElementById('taskDetailModal');
            if (!detailSubtasksList) return;
            
            detailSubtasksList.innerHTML = '';
            const directChildren = host.tasks.getAll().filter(t => t.parent_id === parentId && t.status !== 'trash');
            const sortedChildren = host.tasks.sort([...directChildren]);

            if (sortedChildren.length === 0) {
                detailSubtasksList.innerHTML = '<li style="font-size: 0.825rem; color: var(--text-muted); padding: 4px 0;">No subtasks yet.</li>';
            } else {
                sortedChildren.forEach(child => {
                    const sLi = document.createElement('li');
                    sLi.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-color); font-size: 0.85rem;';

                    let cBadges = '';
                    if (child.is_bonus) cBadges += '<span class="bonus-badge">⭐ Bonus</span> ';
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
            const task = host.tasks.getAll().find(t => t.id === taskId);
            if (!task) return;
            activeDetailTaskId = taskId;

            const isBypassActive = host.rules.bypassActive();
            const isLocked = Boolean(task.ai_locked);
            const isShielded = Boolean(task.strict_prerequisites);

            const taskDetailModal = document.getElementById('taskDetailModal');
            const editTaskTitle = document.getElementById('editTaskTitle');
            const editTaskDesc = document.getElementById('editTaskDesc');
            const editTaskDueDate = document.getElementById('editTaskDueDate');
            const editAiLockCheckbox = document.getElementById('editAiLockCheckbox');
            const editStrictPrereqCheckbox = document.getElementById('editStrictPrereqCheckbox');
            const editBonusTaskCheckbox = document.getElementById('editBonusTaskCheckbox');
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
            
            const titleForEdit = task.raw_title !== undefined ? task.raw_title : (task.title || '');
            if (editTaskTitle) {
                if (editTaskTitle.tagName === 'DIV') editTaskTitle.innerHTML = titleForEdit;
                else editTaskTitle.value = titleForEdit;
            }
            
            if (editTaskDesc) editTaskDesc.value = task.description || '';
            if (editTaskDueDate) editTaskDueDate.value = task.due_date === 'today' ? host.clock.today() : (task.due_date || '');
            if (detailQuickSubtaskInput) detailQuickSubtaskInput.value = '';

            editModalSelectedTags.clear();
            (task.tags || []).forEach(t => editModalSelectedTags.add(t));
            editModalSelectedPriority = task.priority_id || null;
            editModalSelectedProject = task.project_id || 'inbox';
            editModalIsBonus = Boolean(task.is_bonus);

            if (editBonusTaskCheckbox) {
                editBonusTaskCheckbox.checked = editModalIsBonus;
            }

            renderModalTagCloud('editTagCloud', editModalSelectedTags);
            renderModalPriorityCloud('editPriorityCloud', true);
            renderModalProjectCloud('editProjectCloud', true);

            // Move Task: Check Shield Confinement
            const shieldedAncestor = host.tasks.shieldedAncestor(taskId);
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

                const descendantIds = new Set(host.tasks.descendants(taskId).map(d => d.id));
                descendantIds.add(taskId);

                editTaskParentSelect.innerHTML = '<option value="">(Root Level - No Parent)</option>';
                host.tasks.getAll().forEach(candidate => {
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

            // Sibling Criteria Inheritance
            if (siblingInheritContainer && siblingTaskSelect) {
                const isEligibleForInherit = task.parent_id && task.status !== 'completed' && (!task.ai_locked || isBypassActive);
                if (isEligibleForInherit) {
                    const eligibleSiblings = host.tasks.getAll().filter(t => t.parent_id === task.parent_id && t.id !== task.id && t.status !== 'trash' && t.proof_criteria);
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
                const isDeleteBlocked = !isBypassActive && (isLocked || (isShielded && host.tasks.hasUncompletedDescendant(taskId)));
                deleteFromDetailBtn.disabled = isDeleteBlocked;
            }

            if (detailLockStatusBadge) {
                let statusHtml = '';
                if (task.is_bonus) {
                    statusHtml += '<span class="bonus-badge" style="margin-right: 4px;">⭐ Bonus</span>';
                }
                if (isLocked) {
                    statusHtml += isBypassActive
                        ? '<span class="tag-chip" style="background:#451a03;color:#fde68a;">Bypass Active</span>'
                        : '<span class="ai-badge">🔒 Locked</span>';
                } else {
                    statusHtml += '<span class="tag-chip">Standard</span>';
                }
                detailLockStatusBadge.innerHTML = statusHtml;
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
                dueIn.value = (host.view.current() === 'today') ? host.clock.today() : '';
            }

            const bonusCheckbox = document.getElementById('bonusTaskCheckbox');
            createModalIsBonus = false;
            if (bonusCheckbox) bonusCheckbox.checked = false;

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
            createModalSelectedPriority = host.catalogs.lowestPriority();

            if (pIdFieldVal) {
                const parentTask = host.tasks.getAll().find(t => t.id === pIdFieldVal);
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

        function init() {
            if (initialized) return;
            initialized = true;
            try {
                const rawRules = localStorage.getItem('taskitator_mrstudy_rules');
                if (rawRules) {
                    activeMrStudyRules = JSON.parse(rawRules) || [];
                    isMrStudyLinked = activeMrStudyRules.length > 0;
                }
            } catch (e) {}

            // Sibling Criteria Inheritance
            const applySiblingInheritBtn = document.getElementById('applySiblingInheritBtn');
            if (applySiblingInheritBtn) {
                applySiblingInheritBtn.addEventListener('click', async () => {
                    const siblingSelect = document.getElementById('siblingTaskSelect');
                    const sibId = siblingSelect?.value;
                    if (!sibId) {
                        alert('Please select a sibling task first.');
                        return;
                    }

                    const sibling = host.tasks.getAll().find(t => t.id === sibId);
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
                        editFeedback.innerHTML = `<strong>✓ Inherited (10/10)</strong>: Copied criteria and cloned reference exemplar from "${TaskitatorSafety.escapeHtml(sibling.title)}".`;
                    }
                });
            }

            // Sequential Subtask Entry with Criteria Inheritance & Variable Resolution ($$ Bonus Support)
            const detailQuickSubtaskInput = document.getElementById('detailQuickSubtaskInput');
            if (detailQuickSubtaskInput) {
                detailQuickSubtaskInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        if (!activeDetailTaskId) return;
                        
                        let rawSubInput = detailQuickSubtaskInput.value.trim();
                        if (!rawSubInput) return;

                        const parentTask = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                        if (!parentTask) return;

                        const isBonusSub = rawSubInput.includes('$$');
                        rawSubInput = rawSubInput.replace(/\$\$/g, '').trim();

                        const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawSubInput);

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
                            priority_id: host.catalogs.lowestPriority(),
                            project_id: parentTask.project_id || 'inbox',
                            status: 'active',
                            due_date: '',
                            ai_locked: false,
                            proof_criteria: resolvedCriteria,
                            strict_prerequisites: false,
                            is_bonus: isBonusSub,
                            created_at: new Date().toISOString(),
                            completed_at: null
                        };

                        host.tasks.getAll().push(newSubtask);
                        host.tasks.save();

                        const taskDetailModal = document.getElementById('taskDetailModal');
                        refreshDetailSubtaskList(activeDetailTaskId, taskDetailModal?._customRenderFn);

                        if (typeof taskDetailModal?._customRenderFn === 'function') {
                            taskDetailModal._customRenderFn();
                        } else {
                            host.view.refresh();
                        }

                        detailQuickSubtaskInput.value = '';
                        detailQuickSubtaskInput.focus();
                    }
                });
            }

            const openRootAddModalBtn = document.getElementById('openRootAddModalBtn');
            if (openRootAddModalBtn) {
                openRootAddModalBtn.addEventListener('click', () => {
                    openTaskCreationModal(null, 'Create New Task');
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

            const bonusTaskCheckbox = document.getElementById('bonusTaskCheckbox');
            if (bonusTaskCheckbox) {
                bonusTaskCheckbox.addEventListener('change', () => {
                    createModalIsBonus = Boolean(bonusTaskCheckbox.checked);
                });
            }

            const editBonusTaskCheckbox = document.getElementById('editBonusTaskCheckbox');
            if (editBonusTaskCheckbox) {
                editBonusTaskCheckbox.addEventListener('change', () => {
                    editModalIsBonus = Boolean(editBonusTaskCheckbox.checked);
                });
            }

            const addSubtaskFieldBtn = document.getElementById('addSubtaskFieldBtn');
            const subtaskBuilderList = document.getElementById('subtaskBuilderList');
            if (addSubtaskFieldBtn && subtaskBuilderList) {
                addSubtaskFieldBtn.addEventListener('click', () => {
                    const div = document.createElement('div');
                    div.className = 'subtask-builder-item';
                    div.innerHTML = `
                        <input type="text" class="subtask-input-title" placeholder="Quick subtask title... ($$ for bonus)" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-color);" required>
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

            // Task Creation Submission Hook
            const taskCreateForm = document.getElementById('taskCreateForm');
            if (taskCreateForm) {
                taskCreateForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    let rawTitle = NLPEngine.extractCleanTitle('taskTitleInput');
                    const desc = document.getElementById('taskDescInput')?.value.trim() || '';
                    const dueDate = document.getElementById('taskDueDateInput')?.value || '';
                    const isAi = Boolean(document.getElementById('aiLockCheckbox')?.checked);
                    const isStrictPrereq = Boolean(document.getElementById('strictPrereqCheckbox')?.checked);
                    const rawCriteria = document.getElementById('taskCriteriaInput')?.value.trim() || '';
                    const parentId = document.getElementById('creationParentId')?.value || null;
                    
                    const exemplarInput = document.getElementById('createExemplarInput');
                    const exemplarFile = (isAi && exemplarInput && exemplarInput.files.length > 0) ? exemplarInput.files[0] : null;

                    if (!rawTitle) return;

                    let isBonus = createModalIsBonus || rawTitle.includes('$$');
                    rawTitle = rawTitle.replace(/\$\$/g, '').trim();

                    const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawTitle);

                    let finalCriteria = rawCriteria;
                    if (isAi && rawCriteria) {
                        const gate = SmartCriteriaEngine.validateCriteriaForSubmission(rawCriteria, varMap);
                        if (!gate.valid) return;
                        finalCriteria = gate.resolvedText;

                        if (host.rules.strictCriteria()) {
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
                            "Once created, this task cannot be completed until ALL core subtasks are finished, and the Shield cannot be turned off.\n\n" +
                            "Proceed with creation?"
                        );
                        if (!confirmed) return;
                    }

                    let assignedProject = createModalSelectedProject || 'inbox';
                    if (parentId) {
                        const parentTask = host.tasks.getAll().find(t => t.id === parentId);
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
                        is_bonus: isBonus,
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

                    host.tasks.getAll().push(newTask);

                    if (subtaskBuilderList) {
                        const quickSubtaskInputs = subtaskBuilderList.querySelectorAll('.subtask-input-title');
                        quickSubtaskInputs.forEach(input => {
                            let rawSubText = input.value.trim();
                            if (rawSubText) {
                                const isSubBonus = rawSubText.includes('$$');
                                rawSubText = rawSubText.replace(/\$\$/g, '').trim();

                                const subParsed = SmartCriteriaEngine.parseTitle(rawSubText);
                                host.tasks.getAll().push({
                                    id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                                    parent_id: newTaskId,
                                    title: subParsed.cleanTitle,
                                    raw_title: rawSubText,
                                    description: '',
                                    tags: [],
                                    priority_id: host.catalogs.lowestPriority(),
                                    project_id: assignedProject,
                                    status: 'active',
                                    due_date: '',
                                    ai_locked: false,
                                    proof_criteria: '',
                                    strict_prerequisites: false,
                                    is_bonus: isSubBonus,
                                    created_at: new Date().toISOString(),
                                    completed_at: null
                                });
                            }
                        });
                    }

                    host.tasks.save();
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Save Task';
                    }
                    
                    const addTaskModal = document.getElementById('addTaskModal');
                    if (addTaskModal) addTaskModal.classList.remove('open');
                    
                    if (typeof window.refreshCurrentProjectView === 'function') {
                        window.refreshCurrentProjectView();
                    } else {
                        host.view.refresh();
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
                            const task = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
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

            // Save Task Details Hook
            const saveTaskDetailsBtn = document.getElementById('saveTaskDetailsBtn');
            if (saveTaskDetailsBtn) {
                saveTaskDetailsBtn.addEventListener('click', async () => {
                    if (!activeDetailTaskId) return;

                    host.tasks.reload();
                    const task = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
                    if (!task) {
                        alert('This task was removed in a background synchronization.');
                        if (taskDetailModal) taskDetailModal.classList.remove('open');
                        activeDetailTaskId = null;
                        host.view.refresh();
                        return;
                    }

                    const isBypassActive = host.rules.bypassActive();
                    const willBeAiLocked = Boolean(document.getElementById('editAiLockCheckbox')?.checked);
                    let willBeStrict = Boolean(document.getElementById('editStrictPrereqCheckbox')?.checked);
                    const editedCriteriaRaw = document.getElementById('editTaskCriteria')?.value.trim() || '';
                    let rawEditedTitle = NLPEngine.extractCleanTitle('editTaskTitle') || task.raw_title || task.title;

                    let willBeBonus = editModalIsBonus;
                    if (rawEditedTitle.includes('$$')) {
                        willBeBonus = true;
                        rawEditedTitle = rawEditedTitle.replace(/\$\$/g, '').trim();
                    }

                    const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(rawEditedTitle);

                    const editTaskParentSelect = document.getElementById('editTaskParentSelect');
                    const targetParentId = editTaskParentSelect ? (editTaskParentSelect.value.trim() || null) : task.parent_id;

                    if (targetParentId !== task.parent_id) {
                        const shieldedAncestor = host.tasks.shieldedAncestor(task.id);
                        if (shieldedAncestor && !isBypassActive) {
                            alert("Shielded task can't be moved out of their parents.");
                            return;
                        }

                        const descendants = host.tasks.descendants(task.id);
                        if (descendants.some(d => d.id === targetParentId)) {
                            alert("Circular Reference Error: You cannot move a task into one of its own subtasks.");
                            return;
                        }

                        task.parent_id = targetParentId;

                        if (targetParentId) {
                            const targetParent = host.tasks.getAll().find(t => t.id === targetParentId);
                            if (targetParent) {
                                task.project_id = targetParent.project_id || 'inbox';
                                host.tasks.moveProject(task.id, task.project_id);
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

                        if (host.rules.strictCriteria()) {
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
                            "Once saved, this task cannot be completed until ALL core subtasks are finished, and the Shield cannot be turned off.\n\n" +
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
                    task.is_bonus = willBeBonus;

                    if (!task.parent_id) {
                        const oldProjectId = task.project_id;
                        task.project_id = editModalSelectedProject || 'inbox';
                        if (oldProjectId !== task.project_id) {
                            host.tasks.moveProject(task.id, task.project_id);
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

                    host.tasks.save();
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    
                    const customRender = taskDetailModal?._customRenderFn;
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;

                    if (typeof customRender === 'function') customRender();
                    else host.view.refresh();
                });
            }

            const deleteFromDetailBtn = document.getElementById('deleteFromDetailBtn');
            if (deleteFromDetailBtn) {
                deleteFromDetailBtn.addEventListener('click', () => {
                    if (!activeDetailTaskId) return;
                    const customRender = taskDetailModal?._customRenderFn;
                    host.tasks.remove(activeDetailTaskId, customRender);
                    if (taskDetailModal) taskDetailModal.classList.remove('open');
                    activeDetailTaskId = null;
                    pendingEditExemplarFile = null;
                });
            }

            const openChildAddModalBtn = document.getElementById('openChildAddModalBtn');
            if (openChildAddModalBtn) {
                openChildAddModalBtn.addEventListener('click', () => {
                    if (!activeDetailTaskId) return;
                    const parentTask = host.tasks.getAll().find(t => t.id === activeDetailTaskId);
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
                    const task = host.tasks.getAll().find(t => t.id === pendingAuditTaskId);
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
                            host.tasks.setStatus(pendingAuditTaskId, 'completed', new Date().toISOString());
                            host.effects.auditSuccess();
                            host.tasks.save();
                            
                            const completedTaskId = pendingAuditTaskId;
                            host.tasks.finalize(completedTaskId).then(() => {
                                if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                                    const breaks = host.breaks.today();
                                    SyncEngine.forceImmediateSync({ today_breaks: breaks });
                                }
                            });

                            if (auditModal) auditModal.classList.remove('open');
                            pendingAuditTaskId = null;
                            host.view.refresh();
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
                            auditFeedback.innerHTML = `<strong>Verification Halted:</strong> ${TaskitatorSafety.escapeHtml(result.error)}`;
                        }
                        return;
                    }

                    if (result.approved) {
                        task.verified_model = result.model_used;
                        host.tasks.setStatus(pendingAuditTaskId, 'completed', new Date().toISOString());
                        host.effects.auditSuccess();
                        host.tasks.save();
                        
                        const completedTaskId = pendingAuditTaskId;
                        host.tasks.finalize(completedTaskId).then(() => {
                            if (window.SyncEngine && typeof SyncEngine.forceImmediateSync === 'function') {
                                const breaks = host.breaks.today();
                                SyncEngine.forceImmediateSync({ today_breaks: breaks });
                            }
                        });

                        if (auditModal) auditModal.classList.remove('open');
                        pendingAuditTaskId = null;
                        host.view.refresh();
                    } else {
                        submitProofBtn.disabled = false;
                        submitProofBtn.textContent = 'Retry Submission';
                        if (auditFeedback) {
                            auditFeedback.className = 'audit-critique-box';
                            auditFeedback.style.display = 'block';
                            auditFeedback.innerHTML = `<strong>Verdict: ${TaskitatorSafety.escapeHtml(result.verdict.toUpperCase())}</strong><br>${TaskitatorSafety.escapeHtml(result.critique)}`;
                        }
                    }
                });
            }

            // Validate Criteria (Pre-flight) Engine
            async function runCriteriaValidation(criteriaText, taskTitle, exemplarFile, feedbackEl, btnEl, isEditMode) {
                if (!criteriaText) {
                    if (feedbackEl) {
                        feedbackEl.style.display = 'block';
                        feedbackEl.className = 'criteria-feedback-box fail';
                        feedbackEl.textContent = 'Please enter proof criteria before validating.';
                    }
                    return;
                }

                const { cleanTitle, varMap } = SmartCriteriaEngine.parseTitle(taskTitle);
                const { resolvedText, hasUnresolved, unresolvedKeys } = SmartCriteriaEngine.resolveCriteria(criteriaText, varMap);

                if (hasUnresolved) {
                    const missing = unresolvedKeys.length > 0 ? unresolvedKeys.join(', ') : 'unknown';
                    alert(`Criteria Error: Cannot validate criteria with unresolved template variables: {${TaskitatorSafety.escapeHtml(missing)}}.\nPlease define all variables in the task title (e.g. {${TaskitatorSafety.escapeHtml(missing)}==value}).`);
                    if (feedbackEl) {
                        feedbackEl.style.display = 'block';
                        feedbackEl.className = 'criteria-feedback-box fail';
                        feedbackEl.innerHTML = `<strong>Validation Blocked:</strong> Unresolved template variable(s): <code>{${TaskitatorSafety.escapeHtml(missing)}}</code>`;
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
                        feedbackEl.innerHTML = `<strong>Audit Halted:</strong> ${TaskitatorSafety.escapeHtml(res.error || 'Failed to communicate with AI model.')}`;
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
                        feedbackEl.innerHTML = `<strong>✓ Verified (${TaskitatorSafety.escapeHtml(res.score)}/10)</strong>: ${TaskitatorSafety.escapeHtml(res.critique)}`;
                    } else {
                        feedbackEl.className = 'criteria-feedback-box fail';
                        let feedbackHtml = `<strong>⚠️ Low Quality Rating (${TaskitatorSafety.escapeHtml(res.score)}/10)</strong>: ${TaskitatorSafety.escapeHtml(res.critique)}`;
                        if (res.suggested_rewrite) {
                            feedbackHtml += `
                                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.2);">
                                    <strong>Suggested Artifact:</strong> "${TaskitatorSafety.escapeHtml(res.suggested_rewrite)}"
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

        }

        return Object.freeze({
            apiVersion: 1,
            init,
            openCreate: openTaskCreationModal,
            openDetail: openTaskDetailModal,
            openAudit: openAuditModal,
            renderTags: renderModalTagCloud,
            isEditing: () => activeDetailTaskId !== null
        });
    }
});

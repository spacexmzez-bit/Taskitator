// agent-engine.js
/**
 * Taskitator Focus Copilot - Complete Context-Aware Engine
 * 
 * Capabilities:
 * - Dynamic Name Binding: Adopts custom copilot_name across UI headers, nav buttons, input placeholders, and persona prompt.
 * - Multi-Page Context Engine: Detects active page via window.location.pathname and dynamically adapts persona.
 * - Tool Gating: Exposes task mutation tools ONLY on task-centric pages (index.html, general.html).
 * - Out-of-Context Routing: Strictly instructs the model to redirect users to task pages if mutations are requested on non-task pages.
 * - In-Memory Stats Ingestion: Reads task and break statistics directly from localStorage to assist in stats analysis.
 * - Dual-model cascade: gemini-3.5-flash-lite -> gemini-3.1-flash-lite on HTTP 429.
 * - Session fallback latch to prevent wasteful double roundtrips after quota exhaustion.
 * - External SYSTEM_PROMPT.md loader with runtime caching and offline fallback.
 * - Flat tool schemas (get_tasks, create_task, update_task, trash_task).
 * - Read & Mutation dispatchers reading fresh localStorage directly.
 * - Absolute Lock-in Guardrails: Rejects any attempt to trash or alter ai_locked tasks.
 * - Event-Driven: Dispatches 'taskitator-tasks-updated' for reactive UI rerendering.
 * - Distraction Dump Triage Agent: Enforces 100% completion on all AI-locked tasks before triaging notes into tasks, exports, or discards.
 * - Ephemeral UI Controller: In-memory session, sliding-window payload trimmer (last 6-8 messages).
 * - Valid API Roles: Maps function responses to role 'user' compliant with Gemini API schema.
 */

window.TaskitatorAgent = (() => {
    const STORAGE_KEY_SETTINGS = 'taskitator_settings';
    const STORAGE_KEY_TASKS = 'taskitator_tasks';
    const STORAGE_KEY_BREAKS = 'taskitator_daily_breaks';
    const SESSION_LATCH_KEY = 'gemini_fallback_active';

    const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
    const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

    let cachedSystemPrompt = null;
    let isProcessing = false;

    // Ephemeral in-memory conversation history
    // Kept in memory across drawer toggles; reset on page unload/refresh
    const conversationHistory = [];

    // =========================================================================
    // 1. Page Context Detection
    // =========================================================================
    function getPageContext() {
        const path = window.location.pathname.toLowerCase();
        if (path.endsWith('general.html')) return 'general';
        if (path.endsWith('stats.html')) return 'stats';
        if (path.endsWith('settings.html')) return 'settings';
        if (path.endsWith('blocker-guide.html') || path.endsWith('blocker_guide.html')) return 'blocker_guide';
        if (path.endsWith('trash.html')) return 'trash';
        return 'today'; // Defaults to index.html / root
    }

    function getCopilotName() {
        try {
            const settings = JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS) || '{}');
            return (settings.copilot_name || 'Focus Copilot').trim().slice(0, 20);
        } catch (e) {
            return 'Focus Copilot';
        }
    }

    // =========================================================================
    // 2. External Prompt Loader with Dynamic Page Context Injection
    // =========================================================================
    async function getSystemPrompt() {
        let baseText = cachedSystemPrompt;

        if (!baseText) {
            try {
                const res = await fetch('./SYSTEM_PROMPT.md');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                baseText = (await res.text()).trim();
                cachedSystemPrompt = baseText;
            } catch (err) {
                console.warn('[Copilot] Could not load SYSTEM_PROMPT.md, falling back to embedded baseline:', err);
                baseText = (
                    "You are the Taskitator Focus Copilot, a strict, direct task manager and technical guide embedded in Taskitator.\n" +
                    "Keep answers brief (1-3 sentences). Only assist with task operations and focus rules. " +
                    "Refuse general chat. Never create or edit ai_locked tasks."
                );
            }
        }

        const name = getCopilotName();
        const page = getPageContext();

        let contextDirectives = `Your assigned name is "${name}". Address yourself by this name if asked.\n`;

        if (page === 'today' || page === 'general') {
            contextDirectives += (
                `CURRENT PAGE: ${page === 'today' ? 'Today Queue (index.html)' : 'General Tasks (general.html)'}.\n` +
                "ROLE: Primary Task Manager.\n" +
                "You have full access to task inspection and mutation tools (get_tasks, create_task, update_task, trash_task). " +
                "Assist directly with creating, breaking down, and managing tasks."
            );
        } else if (page === 'stats') {
            let tasks = [];
            let breaks = [];
            try {
                tasks = JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS) || '[]');
                breaks = JSON.parse(localStorage.getItem(STORAGE_KEY_BREAKS) || '[]');
            } catch (e) {}

            const activeCount = tasks.filter(t => t.status === 'active').length;
            const completedCount = tasks.filter(t => t.status === 'completed').length;
            const trashCount = tasks.filter(t => t.status === 'trash').length;
            const lockedCount = tasks.filter(t => t.ai_locked && t.status === 'active').length;
            const todayBreaksCount = breaks.length;

            contextDirectives += (
                "CURRENT PAGE: Statistics & Analytics (stats.html).\n" +
                "ROLE: Performance Analyst.\n" +
                `LIVE DATA SNAPSHOT: Active Tasks: ${activeCount} (Locked: ${lockedCount}), Completed Tasks: ${completedCount}, Trashed: ${trashCount}, Scheduled Breaks Today: ${todayBreaksCount}.\n` +
                "Help the user interpret their productivity trends, velocity, and completion rates.\n" +
                "CRITICAL RESTRICTION: You DO NOT have task manipulation tools on this page. If the user asks you to create, update, complete, or trash a task, you MUST explicitly refuse and instruct them to switch to the Today or General Tasks page first."
            );
        } else if (page === 'settings') {
            contextDirectives += (
                "CURRENT PAGE: Settings (settings.html).\n" +
                "ROLE: Technical Configuration Assistant.\n" +
                "Explain settings clearly: Gemini API key acquisition (Google AI Studio at aistudio.google.com), Cloudflare KV sync setup, MacroDroid webhook authorization headers, weekend start/end cycle calculation, emergency token mechanics (4 tokens/cycle reset at midnight post-weekend), and the immutable daily break window.\n" +
                "CRITICAL RESTRICTION: You DO NOT have task manipulation tools on this page. If the user asks you to create, update, complete, or trash a task, you MUST explicitly refuse and instruct them to switch to the Today or General Tasks page first."
            );
        } else if (page === 'blocker_guide') {
            contextDirectives += (
                "CURRENT PAGE: MacroDroid Blocker Setup Guide (blocker-guide.html).\n" +
                "ROLE: Lockdown Implementation Coach.\n" +
                "Provide detailed technical assistance across every phase of the phone lockdown setup: MacroDroid HTTP GET configuration, bearer token authorization headers, response parsing (LOCKED vs UNLOCKED), volume/device locking triggers, and strict permission requirements.\n" +
                "CRITICAL RESTRICTION: You DO NOT have task manipulation tools on this page. If the user asks to create, update, or trash tasks, instruct them to switch to Today or General Tasks first."
            );
        } else if (page === 'trash') {
            contextDirectives += (
                "CURRENT PAGE: Trash & Data Retention (trash.html).\n" +
                "ROLE: Trash & Safety Guide.\n" +
                "Explain the soft-deletion model: trashing a parent task cascades soft-deletion down to all subtasks. Explain that AI-locked tasks cannot be trashed without an active Emergency Bypass.\n" +
                "CRITICAL RESTRICTION: You DO NOT have task manipulation tools on this page. If the user asks to create, edit, or trash tasks, instruct them to switch to Today or General Tasks first."
            );
        }

        return `${contextDirectives}\n\n${baseText}`;
    }

    // =========================================================================
    // 3. Flat Tool Schemas
    // =========================================================================
    const AGENT_TOOLS = [
        {
            function_declarations: [
                {
                    name: 'get_tasks',
                    description: 'Retrieve current tasks from Taskitator to check existing tasks, find IDs, or review schedules.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            filter: {
                                type: 'STRING',
                                enum: ['today', 'all', 'completed'],
                                description: 'Filter tasks: "today" for today queue, "all" for active tree, or "completed" for finished items.'
                            }
                        }
                    }
                },
                {
                    name: 'create_task',
                    description: 'Create a new regular task or subtask. Tasks created by the AI are always standard (ai_locked cannot be set).',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            title: {
                                type: 'STRING',
                                description: 'Clear title of the task.'
                            },
                            due_date: {
                                type: 'STRING',
                                description: 'Due date in YYYY-MM-DD format, or "today".'
                            },
                            parent_id: {
                                type: 'STRING',
                                description: 'Optional ID of the parent task if creating a subtask.'
                            }
                        },
                        required: ['title']
                    }
                },
                {
                    name: 'update_task',
                    description: 'Update the title, description, or due date of an existing non-locked task.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            task_id: {
                                type: 'STRING',
                                description: 'The exact ID of the task to update.'
                            },
                            title: {
                                type: 'STRING',
                                description: 'Updated title for the task.'
                            },
                            due_date: {
                                type: 'STRING',
                                description: 'Updated due date (YYYY-MM-DD or "today").'
                            },
                            description: {
                                type: 'STRING',
                                description: 'Updated notes or context for the task.'
                            }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'trash_task',
                    description: 'Move an existing non-locked task to the trash.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            task_id: {
                                type: 'STRING',
                                description: 'The exact ID of the task to move to trash.'
                            }
                        },
                        required: ['task_id']
                    }
                }
            ]
        }
    ];

    // =========================================================================
    // 4. API Key & Auth Retrieval
    // =========================================================================
    function getApiKey() {
        try {
            const settings = JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS) || '{}');
            return (settings.gemini_api_key || '').trim();
        } catch (e) {
            return '';
        }
    }

    // =========================================================================
    // 5. Dual-Model Cascade with Session 429 Fallback Latch
    // =========================================================================
    async function executeModelCall(payload, apiKey) {
        const buildUrl = (model) =>
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const isFallbackLatched = sessionStorage.getItem(SESSION_LATCH_KEY) === 'true';
        let targetModel = isFallbackLatched ? FALLBACK_MODEL : PRIMARY_MODEL;

        let response = await fetch(buildUrl(targetModel), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Failover on 429 Quota Exceeded and set session latch
        if (response.status === 429 && targetModel === PRIMARY_MODEL) {
            console.warn(`[Copilot] ${PRIMARY_MODEL} quota exhausted (HTTP 429). Latching to ${FALLBACK_MODEL} for remainder of session.`);
            sessionStorage.setItem(SESSION_LATCH_KEY, 'true');
            targetModel = FALLBACK_MODEL;

            response = await fetch(buildUrl(targetModel), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Gemini API HTTP ${response.status}`);
        }

        const data = await response.json();
        return { data, modelUsed: targetModel };
    }

    // =========================================================================
    // 6. Tool Dispatcher & Hard Lock Guardrails
    // =========================================================================
    function executeToolCall(name, args) {
        let tasks = [];
        try {
            tasks = JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS) || '[]');
        } catch (e) {
            tasks = [];
        }

        const isBypassActive = window.TaskitatorEngine?.EmergencyManager?.isBypassActive?.() || false;

        // READ: get_tasks
        if (name === 'get_tasks') {
            const todayStr = new Date().toISOString().split('T')[0];
            const filter = args.filter || 'today';

            const filtered = tasks.filter(t => {
                if (t.status === 'trash') return false;
                if (filter === 'completed') return t.status === 'completed';

                if (filter === 'today') {
                    if (t.status === 'completed') return false;
                    const due = String(t.due_date || 'today').trim().toLowerCase();
                    return due === 'today' || due === todayStr;
                }

                return t.status === 'active';
            });

            return {
                status: 'success',
                count: filtered.length,
                tasks: filtered.map(t => ({
                    id: t.id,
                    title: t.title,
                    parent_id: t.parent_id || null,
                    due_date: t.due_date || '',
                    ai_locked: Boolean(t.ai_locked),
                    status: t.status
                }))
            };
        }

        // MUTATION: create_task
        if (name === 'create_task') {
            const title = (args.title || '').trim();
            if (!title) {
                return { status: 'error', error: 'Task title is required.' };
            }

            const newId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
            const newTask = {
                id: newId,
                parent_id: args.parent_id || null,
                title: title,
                description: '',
                tags: [],
                status: 'active',
                due_date: args.due_date || 'today',
                ai_locked: false, // Model is strictly forbidden from setting ai_locked
                proof_criteria: '',
                created_at: new Date().toISOString(),
                completed_at: null
            };

            tasks.push(newTask);
            commitTasks(tasks);

            return {
                status: 'success',
                task_id: newId,
                title: title,
                due_date: newTask.due_date,
                parent_id: newTask.parent_id
            };
        }

        // MUTATION: update_task
        if (name === 'update_task') {
            const task = tasks.find(t => t.id === args.task_id);
            if (!task) {
                return { status: 'error', error: `Task ID "${args.task_id}" not found.` };
            }

            // Lock Guardrail
            if (task.ai_locked && !isBypassActive) {
                return {
                    status: 'error',
                    error: `Task "${task.title}" is AI-Locked. It cannot be altered without an active Emergency Bypass.`
                };
            }

            if (args.title !== undefined) task.title = args.title.trim();
            if (args.due_date !== undefined) task.due_date = args.due_date.trim();
            if (args.description !== undefined) task.description = args.description.trim();

            commitTasks(tasks);
            return { status: 'success', task_id: task.id, title: task.title };
        }

        // MUTATION: trash_task
        if (name === 'trash_task') {
            const task = tasks.find(t => t.id === args.task_id);
            if (!task) {
                return { status: 'error', error: `Task ID "${args.task_id}" not found.` };
            }

            // Lock Guardrail
            if (task.ai_locked && !isBypassActive) {
                return {
                    status: 'error',
                    error: `Task "${task.title}" is AI-Locked. It cannot be deleted without an active Emergency Bypass.`
                };
            }

            function markTrash(id) {
                const target = tasks.find(t => t.id === id);
                if (target) target.status = 'trash';
                tasks.filter(t => t.parent_id === id).forEach(k => markTrash(k.id));
            }
            markTrash(task.id);

            commitTasks(tasks);
            return { status: 'success', trashed_task_id: task.id, title: task.title };
        }

        return { status: 'error', error: `Unknown tool "${name}".` };
    }

    function commitTasks(updatedTasks) {
        localStorage.setItem(STORAGE_KEY_TASKS, JSON.stringify(updatedTasks));

        // Schedule background cloud sync debounced push
        if (window.SyncEngine) {
            if (typeof SyncEngine.markLocalModified === 'function') {
                SyncEngine.markLocalModified();
            }
            if (typeof SyncEngine.scheduleAutoPush === 'function') {
                const breaks = window.TaskitatorEngine?.BreakEngine?.getTodayBreaks?.() || [];
                SyncEngine.scheduleAutoPush(45000, { today_breaks: breaks });
            }
        }

        // Dispatch custom event for background UI rerendering without closing chat
        window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
    }

    // =========================================================================
    // 7. Sliding-Window Payload Trimmer
    // =========================================================================
    function getTrimmedContents() {
        // Retain the last 8 message turns maximum for network payload
        const recent = conversationHistory.slice(-8);
        return recent.map(msg => ({
            role: msg.role,
            parts: msg.parts
        }));
    }

    // =========================================================================
    // 8. Conversational Turn Execution
    // =========================================================================
    async function sendMessage(userText) {
        const apiKey = getApiKey();
        if (!apiKey) {
            return {
                text: "No Gemini API key configured. Please add your key in Settings first."
            };
        }

        if (isProcessing) return;
        isProcessing = true;

        try {
            // Append user message to in-memory history
            conversationHistory.push({
                role: 'user',
                parts: [{ text: userText }]
            });

            const systemText = await getSystemPrompt();
            const pageContext = getPageContext();

            // Only expose task manipulation tools on Today and General pages
            const activeTools = (pageContext === 'today' || pageContext === 'general') 
                ? AGENT_TOOLS 
                : [];

            // Run up to 4 consecutive tool execution loops (for chained operations)
            for (let loop = 0; loop < 4; loop++) {
                const payload = {
                    contents: getTrimmedContents(),
                    systemInstruction: {
                        parts: [{ text: systemText }]
                    },
                    generationConfig: {
                        temperature: 0.2
                    }
                };

                if (activeTools.length > 0) {
                    payload.tools = activeTools;
                }

                const { data, modelUsed } = await executeModelCall(payload, apiKey);
                const candidate = data.candidates?.[0]?.content;

                if (!candidate) {
                    throw new Error("Model returned an empty response.");
                }

                const parts = candidate.parts || [];
                const toolCallPart = parts.find(p => p.functionCall);

                if (toolCallPart) {
                    // Save model call with the tool request into history
                    conversationHistory.push({
                        role: 'model',
                        parts: parts
                    });

                    const fnName = toolCallPart.functionCall.name;
                    const fnArgs = toolCallPart.functionCall.args || {};
                    const toolResult = executeToolCall(fnName, fnArgs);

                    // Append tool execution response: role MUST be 'user' in Gemini API
                    conversationHistory.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: fnName,
                                response: toolResult
                            }
                        }]
                    });

                    // Loop continues so Gemini can see the tool output and respond
                    continue;
                }

                // Final text reply from model
                const replyText = parts.map(p => p.text || '').join('').trim();
                conversationHistory.push({
                    role: 'model',
                    parts: [{ text: replyText }]
                });

                return { text: replyText, modelUsed };
            }

            return { text: "Completed updates." };
        } finally {
            isProcessing = false;
        }
    }

    // =========================================================================
    // 9. Distraction Dump Triage Agent (Escrow Gate & Extraction)
    // =========================================================================
    async function triageNotes(notesArray) {
        const apiKey = getApiKey();
        if (!apiKey) {
            return { success: false, error: 'No Gemini API key configured.' };
        }

        // Strict Completion Gate: Verify every AI-locked task is 100% finished
        let activeTasks = [];
        try {
            activeTasks = JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS) || '[]');
        } catch (e) {}

        const hasPendingAiLocks = activeTasks.some(t => t.ai_locked && t.status !== 'completed' && t.status !== 'trash');
        if (hasPendingAiLocks) {
            return {
                success: false,
                error: 'Gate Locked: Complete and verify all active AI-locked tasks before triaging ideas.'
            };
        }

        if (!notesArray || notesArray.length === 0) {
            return { success: false, error: 'No notes found to triage.' };
        }

        const notesFormatted = notesArray.map((n, i) => `Note #${i + 1} (${new Date(n.created_at).toLocaleTimeString()}): ${n.text}`).join('\n\n');

        const triagePrompt = `You are the Taskitator Triage Agent.
You are reviewing raw distraction notes that the user jotted down during intense study blocks.
Categorize each thought into exactly ONE of the following 3 groups:
1. "tasks": Actionable, concrete items that should be added to Taskitator (e.g. "Buy replacement battery", "Fix CSS layout bug").
2. "export_notes": Creative thoughts, long-form concepts, or project ideas that are not tasks, but worth preserving.
3. "discarded": Random stream-of-consciousness, daydreaming, or irrelevant brain chatter that can be pruned.

Output strictly valid JSON with this exact schema:
{
  "tasks": [
    { "title": "Task title", "due_date": "today" }
  ],
  "export_notes": [
    { "title": "Concept title", "summary": "Detailed concept text" }
  ],
  "discarded": [
    "Short description of discarded thought"
  ]
}

Raw distraction dump:
${notesFormatted}`;

        try {
            const payload = {
                contents: [{
                    role: 'user',
                    parts: [{ text: triagePrompt }]
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            };

            const { data } = await executeModelCall(payload, apiKey);
            const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawJson) throw new Error('Model produced an empty triage response.');

            const parsed = JSON.parse(rawJson);
            let tasksGenerated = false;

            // Commit generated tasks
            if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
                const globalTasks = JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS) || '[]');
                parsed.tasks.forEach(t => {
                    if (!t.title) return;
                    globalTasks.push({
                        id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                        parent_id: null,
                        title: t.title.trim(),
                        description: 'Generated via Distraction Dump triage',
                        tags: ['idea'],
                        status: 'active',
                        due_date: t.due_date || 'today',
                        ai_locked: false,
                        proof_criteria: '',
                        created_at: new Date().toISOString(),
                        completed_at: null
                    });
                });
                commitTasks(globalTasks);
                tasksGenerated = true;
            }

            // Export preserved concepts to a file download if present
            if (Array.isArray(parsed.export_notes) && parsed.export_notes.length > 0) {
                let exportText = `TASKITATOR DISTRACTION DUMP - PRESERVED CONCEPTS\nExported: ${new Date().toLocaleString()}\n\n`;
                parsed.export_notes.forEach(item => {
                    exportText += `### ${item.title}\n${item.summary}\n\n`;
                });

                const blob = new Blob([exportText], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `taskitator_ideas_${new Date().toISOString().split('T')[0]}.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            const summaryMessage = `Triage Complete!\n- ${parsed.tasks?.length || 0} task(s) added\n- ${parsed.export_notes?.length || 0} concept(s) exported\n- ${parsed.discarded?.length || 0} idea(s) discarded.`;
            alert(summaryMessage);

            return { success: true, tasksGenerated };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // =========================================================================
    // 10. Drawer UI Controller & Universal Name Binding
    // =========================================================================
    function refreshSystemNames() {
        const name = getCopilotName();
        const page = getPageContext();

        // 1. Update Drawer Title Header
        const titleSpan = document.querySelector('.copilot-title-group span:first-child');
        if (titleSpan) {
            titleSpan.textContent = `🤖 ${name}`;
        }

        // 2. Update Standby Card Greeting & Subtitle
        const standbyTitle = document.querySelector('.copilot-standby-title');
        if (standbyTitle) {
            standbyTitle.textContent = name;
        }

        const standbyDesc = document.querySelector('.copilot-standby-card p');
        if (standbyDesc) {
            if (page === 'stats') {
                standbyDesc.textContent = 'Ask me to analyze your study patterns, velocity, or completion history.';
            } else if (page === 'settings') {
                standbyDesc.textContent = 'Ask me about configuring keys, emergency tokens, or break windows.';
            } else if (page === 'blocker_guide') {
                standbyDesc.textContent = 'Ask me for step-by-step guidance configuring MacroDroid phone lock.';
            } else if (page === 'trash') {
                standbyDesc.textContent = 'Ask me how soft-deletion, restoration, and data retention work.';
            } else {
                standbyDesc.textContent = 'Ready. Tell me what tasks you need to organize, breakdown, or check.';
            }
        }

        // 3. Update Floating / Top Nav Buttons across pages
        const navLabel = document.getElementById('copilotNavNameLabel');
        const navBtn = document.getElementById('openCopilotNavBtn');
        if (navLabel) {
            navLabel.textContent = name;
        } else if (navBtn) {
            navBtn.textContent = `💬 ${name}`;
        }

        const fabBtn = document.getElementById('openCopilotFabBtn');
        if (fabBtn) {
            fabBtn.title = `Open ${name}`;
        }

        // 4. Update Input Bar Placeholder per page
        const inputField = document.getElementById('copilotInput');
        if (inputField) {
            if (page === 'stats') {
                inputField.placeholder = `Ask ${name} to analyze stats...`;
            } else if (page === 'settings') {
                inputField.placeholder = `Ask ${name} about settings...`;
            } else if (page === 'blocker_guide') {
                inputField.placeholder = `Ask ${name} about lockdown steps...`;
            } else if (page === 'trash') {
                inputField.placeholder = `Ask ${name} about trash...`;
            } else {
                inputField.placeholder = `Ask ${name}...`;
            }
        }
    }

    function initUI() {
        refreshSystemNames();

        const form = document.getElementById('copilotForm');
        const input = document.getElementById('copilotInput');
        const messagesContainer = document.getElementById('copilotMessages');
        const chip = document.querySelector('.copilot-model-chip');

        if (!form || !input || !messagesContainer) return;

        function appendBubble(text, sender, isLoading = false) {
            const bubble = document.createElement('div');
            bubble.className = `chat-bubble ${sender} ${isLoading ? 'loading' : ''}`;
            bubble.textContent = text;
            messagesContainer.appendChild(bubble);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            return bubble;
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text || isProcessing) return;

            input.value = '';
            appendBubble(text, 'user');

            const loadingBubble = appendBubble('Thinking...', 'bot', true);

            try {
                const res = await sendMessage(text);
                loadingBubble.remove();
                appendBubble(res.text, 'bot');

                // Update model chip if fallback latched
                if (chip && sessionStorage.getItem(SESSION_LATCH_KEY) === 'true') {
                    chip.textContent = '3.1 Flash Lite';
                }
            } catch (err) {
                loadingBubble.remove();
                appendBubble(`Error: ${err.message}`, 'bot');
            }
        });
    }

    // Refresh UI elements if settings update via background sync
    window.addEventListener('taskitator-synced', refreshSystemNames);

    // Initialize UI when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

    const publicAPI = {
        sendMessage,
        triageNotes,
        refreshSystemNames,
        getPageContext,
        getHistory: () => conversationHistory
    };

    // Ensure double registration under TaskitatorEngine
    if (!window.TaskitatorEngine) window.TaskitatorEngine = {};
    window.TaskitatorEngine.AgentEngine = publicAPI;

    return publicAPI;
})();

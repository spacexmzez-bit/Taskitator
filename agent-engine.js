// agent-engine.js
/**
 * Taskitator Focus Copilot - Complete Engine
 * 
 * Capabilities:
 * - Dual-model cascade: gemini-3.5-flash-lite -> gemini-3.1-flash-lite on HTTP 429.
 * - Session fallback latch to prevent wasteful double roundtrips after quota exhaustion.
 * - External SYSTEM_PROMPT.md loader with runtime caching and offline fallback.
 * - Flat tool schemas (get_tasks, create_task, update_task, trash_task).
 * - Read & Mutation dispatchers reading fresh localStorage directly.
 * - Absolute Lock-in Guardrails: Rejects any attempt to trash or alter ai_locked tasks.
 * - Event-Driven: Dispatches 'taskitator-tasks-updated' for reactive UI rerendering.
 * - Ephemeral UI Controller: In-memory session, sliding-window payload trimmer (last 6-8 messages).
 */

window.TaskitatorAgent = (() => {
    const STORAGE_KEY_SETTINGS = 'taskitator_settings';
    const STORAGE_KEY_TASKS = 'taskitator_tasks';
    const SESSION_LATCH_KEY = 'gemini_fallback_active';

    const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
    const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

    let cachedSystemPrompt = null;
    let isProcessing = false;

    // Ephemeral in-memory conversation history
    // Kept in memory across drawer toggles; reset on page unload/refresh
    const conversationHistory = [];

    // =========================================================================
    // 1. External Prompt Loader with In-Memory Caching & Safe Fallback
    // =========================================================================
    async function getSystemPrompt() {
        if (cachedSystemPrompt) {
            return cachedSystemPrompt;
        }

        try {
            const res = await fetch('./SYSTEM_PROMPT.md');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            cachedSystemPrompt = (await res.text()).trim();
            return cachedSystemPrompt;
        } catch (err) {
            console.warn('[Copilot] Could not load SYSTEM_PROMPT.md, falling back to embedded baseline:', err);
            return (
                "You are the Taskitator Focus Copilot, a strict, direct task manager and technical guide embedded in Taskitator.\n" +
                "Keep answers brief (1-3 sentences). Only assist with task operations and focus rules. " +
                "Refuse general chat. Never create or edit ai_locked tasks."
            );
        }
    }

    // =========================================================================
    // 2. Flat Tool Schemas
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
    // 3. API Key & Auth Retrieval
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
    // 4. Dual-Model Cascade with Session 429 Fallback Latch
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
    // 5. Tool Dispatcher & Hard Lock Guardrails
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
    // 6. Sliding-Window Payload Trimmer
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
    // 7. Conversational Turn Execution
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

            // Run up to 4 consecutive tool execution loops (for chained operations)
            for (let loop = 0; loop < 4; loop++) {
                const payload = {
                    contents: getTrimmedContents(),
                    tools: AGENT_TOOLS,
                    systemInstruction: {
                        parts: [{ text: systemText }]
                    },
                    generationConfig: {
                        temperature: 0.2
                    }
                };

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

                    // Append tool execution response
                    conversationHistory.push({
                        role: 'function',
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

            return { text: "Completed task updates." };
        } finally {
            isProcessing = false;
        }
    }

    // =========================================================================
    // 8. Drawer UI Controller & Event Binding
    // =========================================================================
    function initUI() {
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

    // Initialize UI when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

    return {
        sendMessage,
        getHistory: () => conversationHistory
    };
})();

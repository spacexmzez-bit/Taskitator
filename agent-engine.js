// agent-engine.js
/**
 * Taskitator Focus Copilot - Core Engine
 * 
 * Capabilities:
 * - Dual-model cascade: gemini-3.5-flash-lite -> gemini-3.1-flash-lite on HTTP 429.
 * - Session fallback latch to prevent wasteful double roundtrips after quota exhaustion.
 * - External SYSTEM_PROMPT.md loader with runtime caching and offline fallback.
 * - Flat tool definitions (get_tasks, create_task, update_task, trash_task).
 * - Read dispatcher for querying live tasks directly from localStorage.
 */

window.TaskitatorAgent = (() => {
    const STORAGE_KEY_SETTINGS = 'taskitator_settings';
    const STORAGE_KEY_TASKS = 'taskitator_tasks';
    const SESSION_LATCH_KEY = 'gemini_fallback_active';

    const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
    const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

    let cachedSystemPrompt = null;

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
    // 2. Flat Tool Schemas (No Deep Nesting for Reliable Flash-Lite Execution)
    // =========================================================================
    const AGENT_TOOLS = [
        {
            function_declarations: [
                {
                    name: 'get_tasks',
                    description: 'Retrieve current tasks from Taskitator. Use this to check existing tasks, find IDs, or review schedules.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            filter: {
                                type: 'STRING',
                                enum: ['today', 'all', 'completed'],
                                description: 'Filter tasks: "today" for today\'s queue, "all" for full tree, or "completed" for finished items.'
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

        // Check if the fallback latch has already been tripped for this browser session
        const isFallbackLatched = sessionStorage.getItem(SESSION_LATCH_KEY) === 'true';
        let targetModel = isFallbackLatched ? FALLBACK_MODEL : PRIMARY_MODEL;

        let response = await fetch(buildUrl(targetModel), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // If the primary model encounters a 429 quota exhaustion, latch to fallback
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
    // 5. Read Dispatcher (Direct localStorage Query)
    // =========================================================================
    function executeReadTool(name, args) {
        if (name !== 'get_tasks') {
            return null; // Let Phase 5 mutation dispatcher handle write tools
        }

        let tasks = [];
        try {
            tasks = JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS) || '[]');
        } catch (e) {
            tasks = [];
        }

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

            // "all" filter
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

    return {
        getSystemPrompt,
        getApiKey,
        executeModelCall,
        executeReadTool,
        AGENT_TOOLS
    };
})();

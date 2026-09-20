// audit-engine.js
/**
 * Taskitator Core Engine
 * Manages BYOK Gemini Verification Cascade, Pre-Flight Criteria Validation,
 * Emergency Bypass Tokens, and Break Limits
 */

const TaskitatorEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_EMERGENCY: 'taskitator_emergency_state',
    STORAGE_KEY_BREAKS: 'taskitator_daily_breaks',

    PRIMARY_MODEL: 'gemini-3.5-flash-lite',
    FALLBACK_MODEL: 'gemini-3.1-flash-lite',

    // Enforced upload limit across files (Photos, Gallery, PDFs)
    MAX_FILE_SIZE_MB: 4,

    // In-memory cache for pre-flight criteria validations to prevent duplicate API hits
    _criteriaValidationCache: new Map(),

    // =========================================================================
    // 1. Break Engine (3 Breaks, <= 3 Hours Total, Window Enforcement)
    // =========================================================================
    BreakEngine: {
        isSelectionWindowOpen() {
            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const startStr = (settings.break_selection_start || '').trim();
            const endStr = (settings.break_selection_end || '').trim();

            // If unset, open for the entire day
            if (!startStr || !endStr) return true;

            const now = new Date();
            const currentMins = now.getHours() * 60 + now.getMinutes();

            const [sH, sM] = startStr.split(':').map(Number);
            const [eH, eM] = endStr.split(':').map(Number);

            const startMins = sH * 60 + sM;
            const endMins = eH * 60 + eM;

            if (startMins <= endMins) {
                return currentMins >= startMins && currentMins <= endMins;
            } else {
                // Crosses midnight
                return currentMins >= startMins || currentMins <= endMins;
            }
        },

        getTodayBreaks() {
            let allBreaks = {};
            try {
                allBreaks = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_BREAKS) || '{}');
            } catch (e) {
                allBreaks = {};
            }
            const todayStr = new Date().toISOString().split('T')[0];
            return allBreaks[todayStr] || [];
        },

        saveTodayBreaks(breaksArray) {
            if (!this.isSelectionWindowOpen()) {
                return { valid: false, error: 'Break selection window is closed for today.' };
            }

            if (!Array.isArray(breaksArray) || breaksArray.length > 3) {
                return { valid: false, error: 'Maximum 3 breaks allowed per day.' };
            }

            let totalMinutes = 0;
            const parsed = [];

            for (const b of breaksArray) {
                if (!b.start || !b.end) continue;
                const [sH, sM] = b.start.split(':').map(Number);
                const [eH, eM] = b.end.split(':').map(Number);
                const startMins = sH * 60 + sM;
                const endMins = eH * 60 + eM;

                if (endMins <= startMins) {
                    return { valid: false, error: 'Break end time must be strictly after start time.' };
                }

                const duration = endMins - startMins;
                totalMinutes += duration;
                parsed.push({ startMins, endMins, start: b.start, end: b.end });
            }

            if (totalMinutes > 180) {
                return { valid: false, error: `Total break time (${totalMinutes}m) exceeds 3 hours (180m) limit.` };
            }

            // Check overlap
            parsed.sort((a, b) => a.startMins - b.startMins);
            for (let i = 0; i < parsed.length - 1; i++) {
                if (parsed[i].endMins > parsed[i + 1].startMins) {
                    return { valid: false, error: 'Breaks cannot overlap.' };
                }
            }

            let allBreaks = {};
            try {
                allBreaks = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_BREAKS) || '{}');
            } catch (e) {
                allBreaks = {};
            }

            const todayStr = new Date().toISOString().split('T')[0];
            allBreaks[todayStr] = breaksArray;
            localStorage.setItem(TaskitatorEngine.STORAGE_KEY_BREAKS, JSON.stringify(allBreaks));

            return { valid: true };
        },

        isCurrentlyOnBreak() {
            const todayBreaks = this.getTodayBreaks();
            if (!todayBreaks || todayBreaks.length === 0) return false;

            const now = new Date();
            const currentMins = now.getHours() * 60 + now.getMinutes();

            return todayBreaks.some(b => {
                const [sH, sM] = b.start.split(':').map(Number);
                const [eH, eM] = b.end.split(':').map(Number);
                const startMins = sH * 60 + sM;
                const endMins = eH * 60 + eM;
                return currentMins >= startMins && currentMins <= endMins;
            });
        }
    },

    // =========================================================================
    // 2. Emergency Manager (4 Uses Per Cycle, 15m Unlock Window)
    // =========================================================================
    EmergencyManager: {
        getState() {
            let state = {};
            try {
                state = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY) || '{}');
            } catch (e) {
                state = {};
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const weekendEnd = settings.weekend_end !== undefined ? Number(settings.weekend_end) : 6;
            const now = new Date();
            const currentCycleId = this.getCycleIdentifier(now, weekendEnd);

            if (!state.cycle_id || state.cycle_id !== currentCycleId) {
                state = {
                    cycle_id: currentCycleId,
                    uses_left: 4,
                    active_until: null
                };
                localStorage.setItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY, JSON.stringify(state));
            }

            return state;
        },

        getCycleIdentifier(date, weekendEndDay) {
            const resetDay = (weekendEndDay + 1) % 7;
            const d = new Date(date);
            const day = d.getDay();
            const diff = (day < resetDay) ? (7 - resetDay + day) : (day - resetDay);
            d.setDate(d.getDate() - diff);
            return `${d.getFullYear()}-W${Math.ceil((d.getDate() + (6 - d.getDay())) / 7)}-start-${d.toISOString().split('T')[0]}`;
        },

        isBypassActive() {
            const state = this.getState();
            if (!state.active_until) return false;
            return new Date().getTime() < new Date(state.active_until).getTime();
        },

        getRemainingWindowSeconds() {
            const state = this.getState();
            if (!state.active_until) return 0;
            const diff = Math.floor((new Date(state.active_until).getTime() - new Date().getTime()) / 1000);
            return diff > 0 ? diff : 0;
        },

        activateBypass() {
            const state = this.getState();
            if (this.isBypassActive()) {
                return { success: false, error: 'Emergency bypass is already active.' };
            }
            if (state.uses_left <= 0) {
                return { success: false, error: 'All 4 emergency bypass tokens for this cycle have been exhausted.' };
            }

            state.uses_left -= 1;
            const expires = new Date(Date.now() + 15 * 60 * 1000);
            state.active_until = expires.toISOString();

            localStorage.setItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY, JSON.stringify(state));
            return { success: true, active_until: state.active_until, uses_left: state.uses_left };
        }
    },

    // =========================================================================
    // 3. AI Verification Cascade (Forensic Auditor & Failover)
    // =========================================================================
    AuditEngine: {
        validateFile(file, maxMb = TaskitatorEngine.MAX_FILE_SIZE_MB) {
            if (!file) {
                return { valid: false, error: 'No file attached.' };
            }

            const maxBytes = maxMb * 1024 * 1024;
            if (file.size > maxBytes) {
                return { 
                    valid: false, 
                    error: `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the ${maxMb} MB upload limit.` 
                };
            }

            const allowedTypes = [
                'image/jpeg', 
                'image/png', 
                'image/webp', 
                'image/heic', 
                'application/pdf'
            ];

            const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
            const isAllowed = allowedTypes.includes(file.type) || isPdf;

            if (!isAllowed) {
                return { valid: false, error: 'Unsupported file type. Please upload a photo (JPG, PNG, WebP) or PDF document.' };
            }

            return { valid: true };
        },

        async fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Data = reader.result.split(',')[1];
                    let mimeType = file.type || 'image/jpeg';
                    if (file.name.toLowerCase().endsWith('.pdf')) {
                        mimeType = 'application/pdf';
                    }
                    resolve({
                        inlineData: {
                            data: base64Data,
                            mimeType: mimeType
                        }
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        async callGemini(modelName, apiKey, inlineDataPart, promptText) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = {
                contents: [{
                    parts: [inlineDataPart, { text: promptText }]
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            };

            return await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },

        async callGeminiTextOnly(modelName, apiKey, promptText) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = {
                contents: [{
                    parts: [{ text: promptText }]
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            };

            return await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },

        /**
         * Pre-flight Criteria Evaluation
         * Analyzes whether criteria demand an objective, verifiable artifact.
         * Returns: { success: boolean, score: number, passed: boolean, critique: string, suggested_rewrite: string, error?: string }
         */
        async validateCriteria(criteriaText, taskTitle = '') {
            const trimmedCriteria = (criteriaText || '').trim();
            const trimmedTitle = (taskTitle || '').trim();

            if (!trimmedCriteria) {
                return {
                    success: false,
                    score: 0,
                    passed: false,
                    critique: 'Proof criteria cannot be empty.',
                    suggested_rewrite: ''
                };
            }

            // Check cache to avoid duplicate API calls
            const cacheKey = `${trimmedTitle}:::${trimmedCriteria}`;
            if (TaskitatorEngine._criteriaValidationCache.has(cacheKey)) {
                return TaskitatorEngine._criteriaValidationCache.get(cacheKey);
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const apiKey = (settings.gemini_api_key || '').trim();
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Gemini API key is not configured. Please set your key in Settings.'
                };
            }

            const prompt = `You are a forensic proof auditor. Evaluate whether this task acceptance criterion can be objectively verified using a single submitted photo or screenshot evidence file.

TASK TITLE: "${trimmedTitle || 'Untitled Task'}"
PROPOSED CRITERIA: "${trimmedCriteria}"

Evaluation Rules:
1. Objectivity: Does it require a tangible, visual artifact (handwritten page with date, screen terminal diff, completed checklist, cleared room surface)?
2. Disqualify Subjective Action: Strongly penalize unprovable internal states ("read", "understand", "study", "learn", "plan") unless tied to an explicit physical proof artifact (e.g. "photo of written notes").
3. Ambiguity: Reject criteria with unclear boundaries.
4. Pass Threshold: Score on a strict 1 to 10 scale. A score >= 7 means acceptable for automated AI audit.

Return strictly valid JSON with this exact schema:
{
  "score": <integer 1 to 10>,
  "passed": <boolean, true if score >= 7, false otherwise>,
  "critique": "<maximum 15 words explaining the flaw or confirming validity>",
  "suggested_rewrite": "<a concrete, artifact-based rewrite if score < 7, else empty string>"
}`;

            try {
                let usedModel = TaskitatorEngine.PRIMARY_MODEL;
                let res = await this.callGeminiTextOnly(usedModel, apiKey, prompt);

                // Cascade on rate limit
                if (res.status === 429) {
                    console.warn(`[AuditEngine] Model ${usedModel} hit 429 during criteria validation. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                    usedModel = TaskitatorEngine.FALLBACK_MODEL;
                    res = await this.callGeminiTextOnly(usedModel, apiKey, prompt);
                }

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    return {
                        success: false,
                        error: errJson.error?.message || `Gemini API HTTP ${res.status}`
                    };
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

                // Strip potential Markdown wrapping
                rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

                const parsed = JSON.parse(rawText);
                const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
                const passed = parsed.passed !== undefined ? Boolean(parsed.passed) : score >= 7;

                const result = {
                    success: true,
                    score,
                    passed,
                    critique: String(parsed.critique || '').slice(0, 120),
                    suggested_rewrite: String(parsed.suggested_rewrite || '').slice(0, 300),
                    model_used: usedModel
                };

                // Cache successful evaluation
                TaskitatorEngine._criteriaValidationCache.set(cacheKey, result);
                return result;
            } catch (err) {
                return {
                    success: false,
                    error: `Validation parsing error: ${err.message}`
                };
            }
        },

        async verifyProof({ file, taskTitle, criteria, userContext }) {
            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const apiKey = (settings.gemini_api_key || '').trim();
            if (!apiKey) {
                return { success: false, error: 'No Gemini API Key configured in Settings.' };
            }

            // Client-side validation: enforce size cap & supported formats
            const check = this.validateFile(file);
            if (!check.valid) {
                return { success: false, error: check.error };
            }

            const inlinePart = await this.fileToBase64(file);

            const systemPrompt = `
You are the Taskitator Forensic Audit AI. Your job is to strictly evaluate whether evidence (image or PDF document) legitimately proves completion of a task based on provided criteria.

Task: "${taskTitle}"
Proof Criteria <PC>: "${criteria || 'Clear confirmation of completed work.'}"
User Note: "${userContext || 'None'}"

Evaluation Rules:
1. Be skeptical and rigorous. Do not accept ambiguous, staged, or generic proof.
2. Verify specific criteria details if specified (e.g., dates, handwriting, calculated numbers, finished document structure).
3. If criteria are met, approve. If doubtful or incomplete, reject.

Return valid JSON matching this schema:
{
  "verdict": "approved" | "rejected",
  "confidence": 0.0 to 1.0,
  "critique": "Concise forensic explanation of the decision."
}
`;

            let usedModel = TaskitatorEngine.PRIMARY_MODEL;
            let res = await this.callGemini(usedModel, apiKey, inlinePart, systemPrompt);

            // Cascade to secondary model on 429 RPD/RPS limit
            if (res.status === 429) {
                console.warn(`[AuditEngine] Model ${usedModel} hit 429. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                usedModel = TaskitatorEngine.FALLBACK_MODEL;
                res = await this.callGemini(usedModel, apiKey, inlinePart, systemPrompt);
            }

            if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                return {
                    success: false,
                    error: errJson.error?.message || `Gemini HTTP ${res.status}`
                };
            }

            const data = await res.json();
            let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

            try {
                const parsed = JSON.parse(rawText);
                return {
                    success: true,
                    approved: parsed.verdict === 'approved',
                    verdict: parsed.verdict,
                    critique: parsed.critique,
                    model_used: usedModel
                };
            } catch (e) {
                return {
                    success: false,
                    error: 'Malformed JSON returned by verification model.'
                };
            }
        }
    }
};

window.TaskitatorEngine = TaskitatorEngine;

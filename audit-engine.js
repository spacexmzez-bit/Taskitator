/**
 * Taskitator Core Engine
 * Manages BYOK Gemini Verification Cascade, Multimodal Pre-Flight Criteria Validation,
 * Emergency Bypass Tokens, and Break Limits
 */

const TaskitatorEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_EMERGENCY: 'taskitator_emergency_state',
    STORAGE_KEY_BREAKS: 'taskitator_daily_breaks',

    // Switched to dedicated standard Flash endpoints to eliminate 503 capacity errors
    PRIMARY_MODEL: 'gemini-3.5-flash-lite',
    FALLBACK_MODEL: 'gemini-3.1-flash-lite',

    // Enforced upload limit across files (Photos, Gallery, PDFs)
    MAX_FILE_SIZE_MB: 5,

    // In-memory cache for pre-flight criteria validations to prevent duplicate API hits
    _criteriaValidationCache: new Map(),

    // =========================================================================
    // 1. Break Engine (10m Floating Window, Day-Start Offset, 6h Cutoff Buffer)
    // =========================================================================
    BreakEngine: {
        PLANNING_WINDOW_MS: 10 * 60 * 1000, // 10-Minute Ephemeral Planning Window

        getDayStartHour() {
            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }
            const val = parseInt(settings.day_start_hour, 10);
            return (!isNaN(val) && val >= 0 && val <= 4) ? val : 0;
        },

        /**
         * Computes the deterministic logical day boundaries based on day_start_hour (00:00 to 04:00).
         * Eliminates UTC skew and client timezone rollover drift.
         */
        getLogicalDayBounds(dayStartHour = null) {
            const h = dayStartHour !== null ? dayStartHour : this.getDayStartHour();
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
            
            // If before day_start_hour today, this logical cycle started yesterday
            if (now.getTime() < start.getTime()) {
                start.setDate(start.getDate() - 1);
            }
            
            const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
            const cutoff6h = new Date(end.getTime() - 6 * 60 * 60 * 1000);
            const dateStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
            
            return { start, end, cutoff6h, dateStr, dayStartHour: h };
        },

        getAllBreakData() {
            try {
                const raw = localStorage.getItem(TaskitatorEngine.STORAGE_KEY_BREAKS);
                if (!raw) return {};
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null) return parsed;
                return {};
            } catch (e) {
                return {};
            }
        },

        getBreakRecord(dateStr) {
            const allData = this.getAllBreakData();
            const entry = allData[dateStr];
            if (!entry) {
                return {
                    date: dateStr,
                    window_started_at: null,
                    locked: false,
                    breaks: []
                };
            }
            // Backward compatibility for legacy arrays
            if (Array.isArray(entry)) {
                return {
                    date: dateStr,
                    window_started_at: null,
                    locked: true,
                    breaks: entry
                };
            }
            return {
                date: dateStr,
                window_started_at: entry.window_started_at || null,
                locked: Boolean(entry.locked),
                breaks: Array.isArray(entry.breaks) ? entry.breaks : []
            };
        },

        saveBreakRecord(dateStr, record) {
            const allData = this.getAllBreakData();
            allData[dateStr] = {
                date: dateStr,
                window_started_at: record.window_started_at || null,
                locked: Boolean(record.locked),
                breaks: Array.isArray(record.breaks) ? record.breaks : []
            };
            localStorage.setItem(TaskitatorEngine.STORAGE_KEY_BREAKS, JSON.stringify(allData));
        },

        /**
         * Evaluates current planning eligibility and returns detailed status and alert reasons.
         */
        getPlanningStatus() {
            const bounds = this.getLogicalDayBounds();
            let record = this.getBreakRecord(bounds.dateStr);
            const nowTime = Date.now();

            const formatHour = (d) => {
                return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            };

            // Auto-lock on 10-minute expiration
            if (record.window_started_at && !record.locked) {
                const elapsed = nowTime - record.window_started_at;
                if (elapsed >= this.PLANNING_WINDOW_MS) {
                    record.locked = true;
                    this.saveBreakRecord(bounds.dateStr, record);
                }
            }

            // 1. Cycle already planned and sealed
            if (record.locked) {
                return {
                    canStart: false,
                    canEdit: false,
                    isRunning: false,
                    isLocked: true,
                    isInBuffer: false,
                    remainingWindowMs: 0,
                    reason: `Daily Breaks Locked: You have already planned and locked your breaks for this cycle. The window will reset tomorrow at ${formatHour(bounds.end)}.`,
                    bounds,
                    record
                };
            }

            // 2. Active 10-minute window running
            if (record.window_started_at && !record.locked) {
                const elapsed = nowTime - record.window_started_at;
                const remaining = this.PLANNING_WINDOW_MS - elapsed;
                if (remaining > 0) {
                    const remSec = Math.ceil(remaining / 1000);
                    const remMin = Math.floor(remSec / 60);
                    const remSecOnly = remSec % 60;
                    const remFormatted = `${String(remMin).padStart(2, '0')}:${String(remSecOnly).padStart(2, '0')}`;
                    return {
                        canStart: false,
                        canEdit: true,
                        isRunning: true,
                        isLocked: false,
                        isInBuffer: false,
                        remainingWindowMs: remaining,
                        reason: `Planning Active: Your 10-minute window is currently running. You have ${remFormatted} remaining to adjust and lock your breaks.`,
                        bounds,
                        record
                    };
                }
            }

            // 3. Final 6-hour buffer before cycle end
            if (nowTime >= bounds.cutoff6h.getTime()) {
                return {
                    canStart: false,
                    canEdit: false,
                    isRunning: false,
                    isLocked: false,
                    isInBuffer: true,
                    remainingWindowMs: 0,
                    reason: `Planning Closed: You are within the final 6 hours of your logical day (cycle ends at ${formatHour(bounds.end)}). Daily breaks cannot be scheduled during this final buffer.`,
                    bounds,
                    record
                };
            }

            // 4. Eligible to initiate 10-minute session
            return {
                canStart: true,
                canEdit: false,
                isRunning: false,
                isLocked: false,
                isInBuffer: false,
                remainingWindowMs: 0,
                reason: '',
                bounds,
                record
            };
        },

        startPlanningWindow() {
            const status = this.getPlanningStatus();
            if (!status.canStart) {
                return { success: false, error: status.reason };
            }
            const bounds = status.bounds;
            const record = status.record;
            record.window_started_at = Date.now();
            record.locked = false;
            this.saveBreakRecord(bounds.dateStr, record);
            return { success: true, record, remainingWindowMs: this.PLANNING_WINDOW_MS };
        },

        lockTodayBreaks() {
            const bounds = this.getLogicalDayBounds();
            const record = this.getBreakRecord(bounds.dateStr);
            record.locked = true;
            this.saveBreakRecord(bounds.dateStr, record);
            return { success: true, record };
        },

        isSelectionWindowOpen() {
            const status = this.getPlanningStatus();
            return status.canStart || status.canEdit;
        },

        getTodayBreaks() {
            const bounds = this.getLogicalDayBounds();
            const record = this.getBreakRecord(bounds.dateStr);
            return record.breaks || [];
        },

        /**
         * Resolves HH:MM break times to exact epoch timestamps within the active logical cycle.
         */
        getBreakTimestamps(b, bounds) {
            const [sH, sM] = b.start.split(':').map(Number);
            const [eH, eM] = b.end.split(':').map(Number);
            const dayStartH = bounds.start.getHours();

            const startD = new Date(bounds.start);
            if (sH < dayStartH) {
                startD.setDate(startD.getDate() + 1);
            }
            startD.setHours(sH, sM, 0, 0);

            const endD = new Date(bounds.start);
            if (eH < dayStartH || (eH === dayStartH && eM <= 0)) {
                endD.setDate(endD.getDate() + 1);
            }
            endD.setHours(eH, eM, 0, 0);

            if (endD.getTime() <= startD.getTime()) {
                endD.setDate(endD.getDate() + 1);
            }

            return { startTime: startD.getTime(), endTime: endD.getTime() };
        },

        saveTodayBreaks(breaksArray, lockImmediately = false) {
            const status = this.getPlanningStatus();

            if (!status.canEdit && !lockImmediately) {
                return { valid: false, error: status.reason || 'Planning window is not currently open.' };
            }

            if (!Array.isArray(breaksArray) || breaksArray.length > 3) {
                return { valid: false, error: 'Maximum 3 breaks allowed per day.' };
            }

            const bounds = status.bounds;
            let totalMinutes = 0;
            const parsed = [];

            for (const b of breaksArray) {
                if (!b.start || !b.end) continue;
                const { startTime, endTime } = this.getBreakTimestamps(b, bounds);

                if (endTime <= startTime) {
                    return { valid: false, error: 'Break end time must be strictly after start time.' };
                }

                // Prevent scheduling past the logical day cutoff
                if (endTime > bounds.end.getTime()) {
                    const cutoffFormatted = `${String(bounds.end.getHours()).padStart(2, '0')}:${String(bounds.end.getMinutes()).padStart(2, '0')}`;
                    return { valid: false, error: `Breaks cannot be scheduled past the end of your day cycle (${cutoffFormatted}).` };
                }

                if (startTime < bounds.start.getTime()) {
                    const startFormatted = `${String(bounds.start.getHours()).padStart(2, '0')}:${String(bounds.start.getMinutes()).padStart(2, '0')}`;
                    return { valid: false, error: `Breaks cannot be scheduled before the start of your day cycle (${startFormatted}).` };
                }

                const duration = Math.round((endTime - startTime) / (60 * 1000));
                totalMinutes += duration;
                parsed.push({ startTime, endTime, start: b.start, end: b.end, duration });
            }

            if (totalMinutes > 180) {
                return { valid: false, error: `Total break time (${totalMinutes}m) exceeds 3 hours (180m) limit.` };
            }

            // Check overlap
            parsed.sort((a, b) => a.startTime - b.startTime);
            for (let i = 0; i < parsed.length - 1; i++) {
                if (parsed[i].endTime > parsed[i + 1].startTime) {
                    return { valid: false, error: 'Breaks cannot overlap.' };
                }
            }

            const record = status.record;
            record.breaks = breaksArray;
            if (lockImmediately) {
                record.locked = true;
            }
            this.saveBreakRecord(bounds.dateStr, record);

            return { valid: true, record };
        },

        isCurrentlyOnBreak() {
            const bounds = this.getLogicalDayBounds();
            const record = this.getBreakRecord(bounds.dateStr);
            const breaks = record.breaks || [];
            if (breaks.length === 0) return false;

            const nowTime = Date.now();
            return breaks.some(b => {
                if (!b.start || !b.end) return false;
                const { startTime, endTime } = this.getBreakTimestamps(b, bounds);
                return nowTime >= startTime && nowTime <= endTime;
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

        async callGeminiWithParts(modelName, apiKey, partsArray) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = {
                contents: [{
                    parts: partsArray
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

        async callGemini(modelName, apiKey, inlineDataPart, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [inlineDataPart, { text: promptText }]);
        },

        async callGeminiTextOnly(modelName, apiKey, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [{ text: promptText }]);
        },

        /**
         * Pre-flight Criteria Evaluation (Multimodal)
         * Evaluates whether proposed criteria demand an objective, verifiable artifact.
         * If an exemplar reference file is supplied, enforces strict cross-referencing in criteria.
         */
        async validateCriteria(criteriaText, taskTitle = '', exemplarFile = null) {
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

            // Cache key includes file signature if present to prevent false cache collisions
            const fileSignature = exemplarFile ? `${exemplarFile.name}_${exemplarFile.size}` : 'nofile';
            const cacheKey = `${trimmedTitle}:::${trimmedCriteria}:::${fileSignature}`;
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

            let inlineExemplarPart = null;
            if (exemplarFile) {
                const check = this.validateFile(exemplarFile, TaskitatorEngine.MAX_FILE_SIZE_MB);
                if (!check.valid) {
                    return { success: false, error: check.error };
                }
                inlineExemplarPart = await this.fileToBase64(exemplarFile);
            }

            let prompt = `You are a forensic proof auditor for a task execution system.
Evaluate whether this task acceptance criterion can be objectively verified using submitted evidence.

TASK TITLE: "${trimmedTitle || 'Untitled Task'}"
PROPOSED CRITERIA: "${trimmedCriteria}"

Evaluation Rules:
1. Objectivity: Does it require a tangible, visual artifact (e.g., handwritten page with date, terminal output diff, completed checklist, cleared workspace)?
2. Disqualify Subjective Action: Strongly penalize unprovable internal states ("read", "understand", "study", "learn", "plan") unless tied to an explicit physical proof artifact.
3. Ambiguity: Reject criteria with vague or non-falsifiable boundaries.
4. Pass Threshold: Score on a strict 1 to 10 scale. A score >= 7 means acceptable for automated AI audit.`;

            if (inlineExemplarPart) {
                prompt += `
5. MANDATORY REFERENCE CROSS-CHECK: An exemplar reference document/image is attached. You MUST inspect whether the PROPOSED CRITERIA explicitly mentions, explains, and references this attachment (e.g. how the submitted proof must match or follow this exemplar). If an exemplar is attached without direct explanatory context in the text, you MUST rate the criteria below 7/10 and reject it.`;
            }

            prompt += `

Return strictly valid JSON with this exact schema:
{
  "score": <integer 1 to 10>,
  "passed": <boolean, true if score >= 7, false otherwise>,
  "critique": "<maximum 15 words explaining the flaw or confirming validity>",
  "suggested_rewrite": "<a concrete, artifact-based rewrite if score < 7, else empty string>"
}`;

            const parts = [];
            if (inlineExemplarPart) {
                parts.push(inlineExemplarPart);
            }
            parts.push({ text: prompt });

            try {
                let usedModel = TaskitatorEngine.PRIMARY_MODEL;
                let res = await this.callGeminiWithParts(usedModel, apiKey, parts);

                // Cascade on 429 rate limit or 503 capacity outage
                if (res.status === 429 || res.status === 503) {
                    console.warn(`[AuditEngine] Model ${usedModel} hit ${res.status} during criteria validation. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                    usedModel = TaskitatorEngine.FALLBACK_MODEL;
                    res = await this.callGeminiWithParts(usedModel, apiKey, parts);
                }

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    return {
                        success: false,
                        status: res.status,
                        code: res.status,
                        error: errJson.error?.message || `Gemini API HTTP ${res.status}`
                    };
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
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

                TaskitatorEngine._criteriaValidationCache.set(cacheKey, result);
                return result;
            } catch (err) {
                return {
                    success: false,
                    status: 0,
                    error: `Validation parsing error: ${err.message}`
                };
            }
        },

        /**
         * Dual-Evidence Verification Audit
         * Supports passing both submitted proof and saved reference exemplar to Gemini.
         * Explicitly passes HTTP status codes and cascades models on 429/503.
         */
        async verifyProof({ file, taskTitle, criteria, userContext, exemplarPart = null }) {
            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const apiKey = (settings.gemini_api_key || '').trim();
            if (!apiKey) {
                return { success: false, status: 401, error: 'No Gemini API Key configured in Settings.' };
            }

            // Client-side validation: enforce size cap & supported formats
            const check = this.validateFile(file, TaskitatorEngine.MAX_FILE_SIZE_MB);
            if (!check.valid) {
                return { success: false, status: 400, error: check.error };
            }

            let proofPart;
            try {
                proofPart = await this.fileToBase64(file);
            } catch (fileErr) {
                return { success: false, status: 400, error: `Failed to read evidence file: ${fileErr.message}` };
            }

            let systemPrompt = `
You are the Taskitator Forensic Audit AI. Your job is to strictly evaluate whether evidence (image or PDF document) legitimately proves completion of a task based on provided criteria.

Task: "${taskTitle}"
Proof Criteria <PC>: "${criteria || 'Clear confirmation of completed work.'}"
User Note: "${userContext || 'None'}"

Evaluation Rules:
1. Be skeptical and rigorous. Do not accept ambiguous, staged, or generic proof.
2. Verify specific criteria details if specified (e.g., dates, handwriting, calculated numbers, finished document structure).
3. If criteria are met, approve. If doubtful or incomplete, reject.`;

            if (exemplarPart) {
                systemPrompt += `
4. EXEMPLAR COMPARISON: The first attached document/image is the creator's Reference Exemplar. The second attached document/image is the User's Submitted Proof. Verify that the submitted proof satisfies the criteria and aligns with the expected format/substance demonstrated in the reference exemplar.`;
            }

            systemPrompt += `

Return valid JSON matching this schema:
{
  "verdict": "approved" | "rejected",
  "confidence": 0.0 to 1.0,
  "critique": "Concise forensic explanation of the decision."
}
`;

            const parts = [];
            if (exemplarPart) {
                parts.push(exemplarPart);
            }
            parts.push(proofPart);
            parts.push({ text: systemPrompt });

            try {
                let usedModel = TaskitatorEngine.PRIMARY_MODEL;
                let res = await this.callGeminiWithParts(usedModel, apiKey, parts);

                // Cascade to secondary model on 429 RPD/RPS limit or 503 capacity outage
                if (res.status === 429 || res.status === 503) {
                    console.warn(`[AuditEngine] Model ${usedModel} returned ${res.status}. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                    usedModel = TaskitatorEngine.FALLBACK_MODEL;
                    res = await this.callGeminiWithParts(usedModel, apiKey, parts);
                }

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    return {
                        success: false,
                        status: res.status,
                        code: res.status,
                        error: errJson.error?.message || `Gemini HTTP ${res.status}`
                    };
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

                const parsed = JSON.parse(rawText);
                return {
                    success: true,
                    status: 200,
                    code: 200,
                    approved: parsed.verdict === 'approved',
                    verdict: parsed.verdict,
                    critique: parsed.critique,
                    model_used: usedModel
                };
            } catch (err) {
                return {
                    success: false,
                    status: err.status || 0,
                    error: `Verification error: ${err.message}`
                };
            }
        }
    }
};

window.TaskitatorEngine = TaskitatorEngine;

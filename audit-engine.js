// audit-engine.js
/**
 * File: audit-engine.js
 * Core AI Audit Engine, Emergency Bypass Manager, and Break Engine Validator
 * 
 * - Multi-tier Gemini Verification Cascade (gemini-3.5-flash-lite -> gemini-3.1-flash-lite).
 * - Mandatory forensic critique schema for task verification rejections.
 * - Daily 429 RPD exhaustion lockout until midnight (00:00).
 * - 4-use weekly emergency bypass token management (15-minute active window).
 * - Dynamic workweek start calculations based on weekend settings.
 * - Daily break window scheduling, overlap detection, and 3-hour limit validation.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TaskitatorEngine = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const SETTINGS_KEY = 'taskitator_settings';
    const EMERGENCY_KEY = 'taskitator_emergency_state';
    const DAILY_LOCKOUT_KEY = 'taskitator_ai_daily_lockout';
    const BREAKS_KEY = 'taskitator_today_breaks';

    // =========================================================================
    // 1. Settings & Persistence Utilities
    // =========================================================================
    function getSettings() {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    // =========================================================================
    // 2. Emergency Bypass Manager
    // =========================================================================
    const EmergencyManager = {
        MAX_USES_PER_WEEK: 4,
        WINDOW_DURATION_MS: 15 * 60 * 1000, // 15 minutes

        getState: function () {
            this.checkAndApplyWeeklyReset();
            try {
                const raw = localStorage.getItem(EMERGENCY_KEY);
                return raw ? JSON.parse(raw) : this.getInitialState();
            } catch (e) {
                return this.getInitialState();
            }
        },

        getInitialState: function () {
            const state = {
                uses_left: this.MAX_USES_PER_WEEK,
                active_until: null,
                last_reset_week_id: this.getCurrentWeekId()
            };
            this.saveState(state);
            return state;
        },

        saveState: function (state) {
            localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state));
        },

        // Dynamically calculates the week identifier based on configured weekend
        getCurrentWeekId: function () {
            const settings = getSettings();
            const weekendDays = settings.weekend_days || [5, 6]; // Default Fri, Sat
            const sorted = [...weekendDays].sort((a, b) => a - b);
            const lastWeekendDay = sorted.length > 0 ? sorted[sorted.length - 1] : 6;
            const firstWorkday = (lastWeekendDay + 1) % 7;

            const now = new Date();
            const currentDay = now.getDay();
            
            // Calculate offset days back to the last workweek start
            let diff = currentDay - firstWorkday;
            if (diff < 0) diff += 7;

            const resetDate = new Date(now);
            resetDate.setDate(now.getDate() - diff);
            resetDate.setHours(0, 0, 0, 0);

            return resetDate.toISOString().split('T')[0];
        },

        checkAndApplyWeeklyReset: function () {
            try {
                const raw = localStorage.getItem(EMERGENCY_KEY);
                if (!raw) return;
                const state = JSON.parse(raw);
                const currentWeekId = this.getCurrentWeekId();

                if (state.last_reset_week_id !== currentWeekId) {
                    state.uses_left = this.MAX_USES_PER_WEEK;
                    state.last_reset_week_id = currentWeekId;
                    state.active_until = null;
                    this.saveState(state);
                }
            } catch (e) {
                // Ignore parse errors
            }
        },

        isBypassActive: function () {
            const state = this.getState();
            if (!state.active_until) return false;
            const now = Date.now();
            return now < state.active_until;
        },

        getRemainingWindowSeconds: function () {
            const state = this.getState();
            if (!state.active_until) return 0;
            const diff = Math.max(0, Math.floor((state.active_until - Date.now()) / 1000));
            return diff;
        },

        activateBypass: function () {
            const state = this.getState();

            if (this.isBypassActive()) {
                return { success: true, already_active: true, remaining: this.getRemainingWindowSeconds() };
            }

            if (state.uses_left <= 0) {
                return { success: false, error: 'All 4 emergency bypass tokens for this week have been exhausted.' };
            }

            state.uses_left -= 1;
            state.active_until = Date.now() + this.WINDOW_DURATION_MS;
            this.saveState(state);

            return {
                success: true,
                uses_left: state.uses_left,
                active_until: state.active_until,
                duration_seconds: this.WINDOW_DURATION_MS / 1000
            };
        }
    };

    // =========================================================================
    // 3. Break Engine Validator & State Manager
    // =========================================================================
    const BreakEngine = {
        MAX_BREAKS_PER_DAY: 3,
        MAX_TOTAL_MINUTES: 180, // 3 hours

        // Check if current time is inside configured 1-hour selection window
        isSelectionWindowOpen: function () {
            const settings = getSettings();
            const win = settings.break_selection_window;
            if (!win || !win.start || !win.end) return true; // Initial setup open

            const now = new Date();
            const curMins = now.getHours() * 60 + now.getMinutes();
            const [sH, sM] = win.start.split(':').map(Number);
            const [eH, eM] = win.end.split(':').map(Number);
            const startMins = sH * 60 + sM;
            const endMins = eH * 60 + eM;

            if (endMins >= startMins) {
                return curMins >= startMins && curMins <= endMins;
            } else {
                return curMins >= startMins || curMins <= endMins;
            }
        },

        // Condition 7A: Same day, non-overlapping, max 3 breaks, total <= 180 mins
        validateBreaks: function (breaksArray) {
            if (!Array.isArray(breaksArray)) {
                return { valid: false, error: 'Breaks must be provided as an array.' };
            }

            if (breaksArray.length > this.MAX_BREAKS_PER_DAY) {
                return { valid: false, error: `Maximum ${this.MAX_BREAKS_PER_DAY} breaks allowed per day.` };
            }

            let totalMinutes = 0;
            const parsedIntervals = [];

            for (let i = 0; i < breaksArray.length; i++) {
                const b = breaksArray[i];
                if (!b.start || !b.end) {
                    return { valid: false, error: `Break #${i + 1} has missing start or end time.` };
                }

                const [sH, sM] = b.start.split(':').map(Number);
                const [eH, eM] = b.end.split(':').map(Number);

                if (isNaN(sH) || isNaN(sM) || isNaN(eH) || isNaN(eM)) {
                    return { valid: false, error: `Break #${i + 1} contains invalid time format. Use HH:MM.` };
                }

                const startMin = sH * 60 + sM;
                const endMin = eH * 60 + eM;

                if (endMin <= startMin) {
                    return { valid: false, error: `Break #${i + 1} must end after it starts and cannot cross midnight.` };
                }

                const duration = endMin - startMin;
                totalMinutes += duration;
                parsedIntervals.push({ startMin, endMin, index: i + 1 });
            }

            if (totalMinutes > this.MAX_TOTAL_MINUTES) {
                return {
                    valid: false,
                    error: `Total break duration (${totalMinutes} mins) exceeds the 3-hour daily maximum (${this.MAX_TOTAL_MINUTES} mins).`
                };
            }

            // Check for overlaps
            parsedIntervals.sort((a, b) => a.startMin - b.startMin);
            for (let i = 0; i < parsedIntervals.length - 1; i++) {
                if (parsedIntervals[i].endMin > parsedIntervals[i + 1].startMin) {
                    return {
                        valid: false,
                        error: `Break intervals overlap between break #${parsedIntervals[i].index} and break #${parsedIntervals[i + 1].index}.`
                    };
                }
            }

            return { valid: true, totalMinutes };
        },

        saveTodayBreaks: function (breaksArray) {
            const check = this.validateBreaks(breaksArray);
            if (!check.valid) return check;

            const todayStr = new Date().toISOString().split('T')[0];
            const payload = {
                date: todayStr,
                breaks: breaksArray
            };

            localStorage.setItem(BREAKS_KEY, JSON.stringify(payload));
            return { valid: true, data: payload };
        },

        getTodayBreaks: function () {
            try {
                const raw = localStorage.getItem(BREAKS_KEY);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                const todayStr = new Date().toISOString().split('T')[0];
                if (parsed.date !== todayStr) return [];
                return Array.isArray(parsed.breaks) ? parsed.breaks : [];
            } catch (e) {
                return [];
            }
        },

        isCurrentlyInBreak: function () {
            const breaks = this.getTodayBreaks();
            if (breaks.length === 0) return false;

            const now = new Date();
            const curMins = now.getHours() * 60 + now.getMinutes();

            return breaks.some(b => {
                const [sH, sM] = b.start.split(':').map(Number);
                const [eH, eM] = b.end.split(':').map(Number);
                const s = sH * 60 + sM;
                const e = eH * 60 + eM;
                return curMins >= s && curMins <= e;
            });
        }
    };

    // =========================================================================
    // 4. Client-Side Image Pre-processor
    // =========================================================================
    const ImageCompressor = {
        processFile: function (file, maxDimension = 1280, quality = 0.8) {
            return new Promise((resolve, reject) => {
                if (!file || !file.type.startsWith('image/')) {
                    return reject(new Error('Provided file is not a valid image.'));
                }

                const reader = new FileReader();
                reader.onerror = () => reject(new Error('Failed to read local file.'));
                reader.onload = (e) => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('Failed to decode image data.'));
                    img.onload = () => {
                        let width = img.width;
                        let height = img.height;

                        if (width > maxDimension || height > maxDimension) {
                            if (width > height) {
                                height = Math.round((height * maxDimension) / width);
                                width = maxDimension;
                            } else {
                                width = Math.round((width * maxDimension) / height);
                                height = maxDimension;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        const base64Url = canvas.toDataURL('image/jpeg', quality);
                        const base64Data = base64Url.split(',')[1];
                        resolve({
                            mimeType: 'image/jpeg',
                            data: base64Data,
                            dataUrl: base64Url
                        });
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }
    };

    // =========================================================================
    // 5. AI Audit Engine (Two-Tier Model Cascade & Structured Evaluation)
    // =========================================================================
    const AuditEngine = {
        PRIMARY_MODEL: 'gemini-3.5-flash-lite',
        FALLBACK_MODEL: 'gemini-3.1-flash-lite',

        // Daily Lockout Checks (RPD bottleneck protection)
        checkDailyLockout: function () {
            try {
                const lockoutDate = localStorage.getItem(DAILY_LOCKOUT_KEY);
                if (!lockoutDate) return { locked: false };

                const todayStr = new Date().toISOString().split('T')[0];
                if (lockoutDate === todayStr) {
                    return {
                        locked: true,
                        message: 'Daily AI audit quota (RPD) exhausted across all models. Proof auditing is locked until midnight (00:00).'
                    };
                } else {
                    localStorage.removeItem(DAILY_LOCKOUT_KEY);
                    return { locked: false };
                }
            } catch (e) {
                return { locked: false };
            }
        },

        setDailyLockout: function () {
            const todayStr = new Date().toISOString().split('T')[0];
            localStorage.setItem(DAILY_LOCKOUT_KEY, todayStr);
        },

        buildSystemInstruction: function () {
            return (
                "You are an incorruptible, skeptical, and meticulous forensic task verification auditor for the Taskitator system. " +
                "Your objective is to evaluate whether visual evidence (a photograph) conclusively proves the completion of a user's task based on their specific Proof Criteria. " +
                "Strict Rules:\n" +
                "1. Zero Benefit of the Doubt: If the photograph is blurry, ambiguous, missing core context, or could easily depict an unrelated scene, you MUST reject it.\n" +
                "2. Outcome Classification: Output one of three verdicts strictly:\n" +
                "   - 'approved': Indisputable, clear evidence proving the task and criteria were satisfied.\n" +
                "   - 'not-enough': The image is genuine but lacks sufficient detail, clarity, or proof to confirm full completion.\n" +
                "   - 'inadmissible': The image is entirely irrelevant, deceptive, completely unrelated, or blank.\n" +
                "3. Mandatory Critique Rule: If the verdict is 'not-enough' or 'inadmissible', you MUST populate the 'critique' field with a direct, specific critique explaining exactly why the proof was rejected and what specific visual evidence is missing.\n" +
                "4. Return strictly a JSON object adhering to the schema: {\"verdict\": \"approved\"|\"not-enough\"|\"inadmissible\", \"critique\": \"string\"}."
            );
        },

        callGeminiApi: async function (model, apiKey, imageBase64, mimeType, taskTitle, criteria, userContext) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

            const userPromptText = 
                `TASK TITLE: ${taskTitle}\n` +
                `PROOF CRITERIA: ${criteria || 'General clear visual verification of task completion.'}\n` +
                `USER EXPLANATION / CONTEXT: ${userContext || 'No additional explanation provided.'}\n\n` +
                `Carefully examine the attached image evidence against the criteria above. Provide your verdict and mandatory critique.`;

            const requestBody = {
                contents: [
                    {
                        parts: [
                            { text: userPromptText },
                            {
                                inline_data: {
                                    mime_type: mimeType,
                                    data: imageBase64
                                }
                            }
                        ]
                    }
                ],
                systemInstruction: {
                    parts: [{ text: this.buildSystemInstruction() }]
                },
                generationConfig: {
                    responseMimeType: "application/json",
                    temperature: 0.1
                }
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            return response;
        },

        verifyProof: async function (options) {
            const { imageFile, taskTitle, criteria, userContext } = options;

            // 1. Quota Pre-Check
            const lockout = this.checkDailyLockout();
            if (lockout.locked) {
                return { success: false, rateLimited: true, error: lockout.message };
            }

            // 2. Settings check
            const settings = getSettings();
            const apiKey = settings.gemini_api_key;
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Gemini API key is not configured. Please enter your API key in Settings.'
                };
            }

            // 3. Compress / encode evidence image
            let processedImage;
            try {
                processedImage = await ImageCompressor.processFile(imageFile);
            } catch (err) {
                return { success: false, error: `Image processing failed: ${err.message}` };
            }

            // 4. Primary Model Execution (gemini-3.5-flash-lite)
            let rawResponse = null;
            let currentModel = this.PRIMARY_MODEL;

            try {
                rawResponse = await this.callGeminiApi(
                    this.PRIMARY_MODEL,
                    apiKey,
                    processedImage.data,
                    processedImage.mimeType,
                    taskTitle,
                    criteria,
                    userContext
                );
            } catch (netErr) {
                return { success: false, error: `Network error reaching AI service: ${netErr.message}` };
            }

            // 5. Fallback Cascade on HTTP 429 (Resource Exhausted / RPD Cap)
            if (rawResponse.status === 429) {
                currentModel = this.FALLBACK_MODEL;
                try {
                    rawResponse = await this.callGeminiApi(
                        this.FALLBACK_MODEL,
                        apiKey,
                        processedImage.data,
                        processedImage.mimeType,
                        taskTitle,
                        criteria,
                        userContext
                    );
                } catch (netErr2) {
                    return { success: false, error: `Network error reaching fallback AI service: ${netErr2.message}` };
                }

                // If fallback model also returns 429: lock out system until midnight
                if (rawResponse.status === 429) {
                    this.setDailyLockout();
                    return {
                        success: false,
                        rateLimited: true,
                        error: 'Daily API quota exhausted across both primary and fallback models. Auditing is locked until midnight (00:00).'
                    };
                }
            }

            // 6. Handle other API response failures
            if (!rawResponse.ok) {
                const errJson = await rawResponse.json().catch(() => ({}));
                return {
                    success: false,
                    error: `AI verification failed [${rawResponse.status}]: ${errJson.error?.message || rawResponse.statusText}`
                };
            }

            // 7. Parse Structured JSON Evaluation
            try {
                const resultData = await rawResponse.json();
                const rawText = resultData.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!rawText) {
                    return { success: false, error: 'AI model returned an empty evaluation candidate.' };
                }

                const evaluation = JSON.parse(rawText);
                const verdict = String(evaluation.verdict || '').toLowerCase().trim();
                const critique = evaluation.critique || 'No detailed critique provided by auditor.';

                return {
                    success: true,
                    model_used: currentModel,
                    verdict: verdict,
                    critique: critique,
                    approved: verdict === 'approved'
                };

            } catch (parseErr) {
                return {
                    success: false,
                    error: `Failed to parse AI evaluation response: ${parseErr.message}`
                };
            }
        }
    };

    // Public module surface
    return {
        EmergencyManager,
        BreakEngine,
        ImageCompressor,
        AuditEngine
    };
}));

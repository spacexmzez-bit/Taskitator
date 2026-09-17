// audit-engine.js
/**
 * Taskitator Core Engine
 * - EmergencyManager: 4 tokens/week quota, 15m unlock window, post-weekend midnight reset
 * - BreakEngine: Selection window enforcement, <= 3 non-overlapping breaks, <= 3h total
 * - AuditEngine: 2-tier cascade (gemini-3.5-flash-lite -> gemini-3.1-flash-lite),
 *   automatic RPD failover, client-side midnight lockout with rate-limit alerts.
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

    // =========================================================================
    // Storage Keys & Constants
    // =========================================================================
    const KEYS = {
        SETTINGS: 'taskitator_settings',
        EMERGENCY_STATE: 'taskitator_emergency_state',
        BREAKS: 'taskitator_daily_breaks',
        AI_LOCKOUT: 'taskitator_ai_daily_lockout'
    };

    // =========================================================================
    // Helper Utilities
    // =========================================================================
    function getTodayString() {
        return new Date().toISOString().split('T')[0];
    }

    function parseMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [h, m] = timeStr.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return null;
        return h * 60 + m;
    }

    function getSettings() {
        try {
            return JSON.parse(localStorage.getItem(KEYS.SETTINGS) || '{}');
        } catch (e) {
            return {};
        }
    }

    // =========================================================================
    // 1. Emergency Bypass Manager
    // =========================================================================
    const EmergencyManager = {
        MAX_USES_PER_WEEK: 4,
        WINDOW_DURATION_MINUTES: 15,

        getState() {
            try {
                const raw = localStorage.getItem(KEYS.EMERGENCY_STATE);
                const state = raw ? JSON.parse(raw) : null;
                return this._checkAndResetQuota(state);
            } catch (e) {
                return this._getDefaultState();
            }
        },

        _getDefaultState() {
            return {
                uses_left: this.MAX_USES_PER_WEEK,
                active_window_until: null,
                last_reset_date: getTodayString()
            };
        },

        _checkAndResetQuota(state) {
            if (!state) state = this._getDefaultState();

            const settings = getSettings();
            const weekendEndDay = (settings.weekend_end !== undefined) ? parseInt(settings.weekend_end, 10) : 6;
            const resetDay = (weekendEndDay + 1) % 7;

            const now = new Date();
            const lastReset = state.last_reset_date ? new Date(state.last_reset_date) : new Date(0);

            let checkDate = new Date(lastReset);
            checkDate.setDate(checkDate.getDate() + 1);
            checkDate.setHours(0, 0, 0, 0);

            let shouldReset = false;
            while (checkDate <= now) {
                if (checkDate.getDay() === resetDay) {
                    shouldReset = true;
                    break;
                }
                checkDate.setDate(checkDate.getDate() + 1);
            }

            if (shouldReset) {
                state.uses_left = this.MAX_USES_PER_WEEK;
                state.last_reset_date = getTodayString();
                this._saveState(state);
            }

            return state;
        },

        _saveState(state) {
            localStorage.setItem(KEYS.EMERGENCY_STATE, JSON.stringify(state));
        },

        isBypassActive() {
            const state = this.getState();
            if (!state.active_window_until) return false;
            return Date.now() < state.active_window_until;
        },

        getRemainingWindowSeconds() {
            const state = this.getState();
            if (!state.active_window_until) return 0;
            const diff = Math.max(0, Math.floor((state.active_window_until - Date.now()) / 1000));
            return diff;
        },

        activateBypass() {
            const state = this.getState();
            if (this.isBypassActive()) {
                return { success: false, error: 'Emergency bypass is already active.' };
            }
            if (state.uses_left <= 0) {
                return { success: false, error: 'No emergency tokens remaining for this cycle.' };
            }

            state.uses_left -= 1;
            state.active_window_until = Date.now() + (this.WINDOW_DURATION_MINUTES * 60 * 1000);
            this._saveState(state);

            return { success: true, uses_left: state.uses_left, expires_at: state.active_window_until };
        }
    };

    // =========================================================================
    // 2. Break Engine
    // =========================================================================
    const BreakEngine = {
        MAX_BREAKS_PER_DAY: 3,
        MAX_TOTAL_MINUTES: 180,

        isSelectionWindowOpen() {
            const settings = getSettings();
            if (!settings.break_selection_start || !settings.break_selection_end) {
                return false;
            }

            const now = new Date();
            const curMinutes = now.getHours() * 60 + now.getMinutes();
            const startMinutes = parseMinutes(settings.break_selection_start);
            const endMinutes = parseMinutes(settings.break_selection_end);

            if (startMinutes === null || endMinutes === null) return false;

            if (startMinutes <= endMinutes) {
                return curMinutes >= startMinutes && curMinutes <= endMinutes;
            } else {
                return curMinutes >= startMinutes || curMinutes <= endMinutes;
            }
        },

        getTodayBreaks() {
            try {
                const stored = JSON.parse(localStorage.getItem(KEYS.BREAKS) || '{}');
                const today = getTodayString();
                return stored[today] || [];
            } catch (e) {
                return [];
            }
        },

        saveTodayBreaks(breaksArray) {
            if (!this.isSelectionWindowOpen()) {
                return { valid: false, error: 'Break selection window is closed.' };
            }

            if (!Array.isArray(breaksArray)) {
                return { valid: false, error: 'Invalid input format.' };
            }

            if (breaksArray.length > this.MAX_BREAKS_PER_DAY) {
                return { valid: false, error: `Maximum ${this.MAX_BREAKS_PER_DAY} breaks allowed per day.` };
            }

            const parsed = [];
            let totalMinutes = 0;

            for (let i = 0; i < breaksArray.length; i++) {
                const b = breaksArray[i];
                const s = parseMinutes(b.start);
                const e = parseMinutes(b.end);

                if (s === null || e === null) {
                    return { valid: false, error: 'Invalid time string provided.' };
                }
                if (s >= e) {
                    return { valid: false, error: `Break start (${b.start}) must precede end (${b.end}).` };
                }

                const duration = e - s;
                totalMinutes += duration;
                parsed.push({ startMin: s, endMin: e, start: b.start, end: b.end });
            }

            if (totalMinutes > this.MAX_TOTAL_MINUTES) {
                return { valid: false, error: `Total break duration exceeds maximum limit of 3 hours (${totalMinutes} mins).` };
            }

            parsed.sort((a, b) => a.startMin - b.startMin);
            for (let i = 0; i < parsed.length - 1; i++) {
                if (parsed[i].endMin > parsed[i + 1].startMin) {
                    return { valid: false, error: `Breaks overlap: [${parsed[i].start}-${parsed[i].end}] overlaps with [${parsed[i + 1].start}-${parsed[i + 1].end}].` };
                }
            }

            const cleaned = parsed.map(p => ({ start: p.start, end: p.end }));
            const today = getTodayString();
            const stored = JSON.parse(localStorage.getItem(KEYS.BREAKS) || '{}');
            stored[today] = cleaned;
            localStorage.setItem(KEYS.BREAKS, JSON.stringify(stored));

            return { valid: true, breaks: cleaned };
        }
    };

    // =========================================================================
    // 3. Audit Engine (Cascade 3.5 -> 3.1 & Daily Midnight RPD Lock)
    // =========================================================================
    const AuditEngine = {
        PRIMARY_MODEL: 'gemini-3.5-flash-lite',
        FALLBACK_MODEL: 'gemini-3.1-flash-lite',

        isLockedOutToday() {
            const lockoutDate = localStorage.getItem(KEYS.AI_LOCKOUT);
            return lockoutDate === getTodayString();
        },

        setDailyLockout() {
            localStorage.setItem(KEYS.AI_LOCKOUT, getTodayString());
        },

        fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result;
                    const base64 = result.substring(result.indexOf(',') + 1);
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        async verifyProof({ imageFile, taskTitle, criteria, userContext = '' }) {
            if (this.isLockedOutToday()) {
                return {
                    success: false,
                    error: 'Daily rate limit exceeded for both verification models (3.5 & 3.1). Feature locked until 00:00 midnight.'
                };
            }

            const settings = getSettings();
            const apiKey = settings.gemini_api_key;
            if (!apiKey) {
                return { success: false, error: 'Gemini API key is not configured in Settings.' };
            }

            let base64Image;
            try {
                base64Image = await this.fileToBase64(imageFile);
            } catch (e) {
                return { success: false, error: 'Failed to process evidence image file.' };
            }

            const prompt = `You are the strict, forensic verification auditor for "Taskitator".
Your sole mission is to examine user-submitted photographic proof against task completion criteria.

TASK SPECIFICATIONS:
- Task Title: "${taskTitle}"
- Proof Criteria <PC>: "${criteria || 'General clear photographic proof of completion'}"
- User Notes: "${userContext || 'None provided'}"

RULES OF AUDIT:
1. Be rigorous and objective. If the proof is ambiguous, partial, blurry, or missing key elements specified in <PC>, you must REJECT it.
2. Reject screenshots or photos showing unverified screens, stock images, or unrelated physical items.
3. You must output your verdict strictly in valid JSON matching this schema:
{
  "approved": boolean,
  "verdict": "verified" | "not-enough" | "inadmissible",
  "critique": "A concise, objective critique (max 2 sentences) describing why it passed or specifically what proof element was missing."
}`;

            const payload = {
                contents: [
                    {
                        parts: [
                            { text: prompt },
                            {
                                inlineData: {
                                    mimeType: imageFile.type || 'image/jpeg',
                                    data: base64Image
                                }
                            }
                        ]
                    }
                ],
                generationConfig: {
                    responseMimeType: "application/json",
                    temperature: 0.1
                }
            };

            // Tier 1: Try Primary Model (gemini-3.5-flash-lite)
            let result = await this._callModel(this.PRIMARY_MODEL, apiKey, payload);

            // Automatic Failover on 429 RPD Exhaustion
            if (result.status === 429) {
                console.warn(`[AuditEngine] Model ${this.PRIMARY_MODEL} exhausted RPD. Cascading to fallback: ${this.FALLBACK_MODEL}...`);
                
                // Tier 2: Try Fallback Model (gemini-3.1-flash-lite)
                result = await this._callModel(this.FALLBACK_MODEL, apiKey, payload);

                // If fallback also hits 429, lock out for the day
                if (result.status === 429) {
                    this.setDailyLockout();
                    return {
                        success: false,
                        error: 'Daily rate limit exceeded for all available models (3.5 & 3.1). Verification locked until 00:00 midnight.'
                    };
                }
            }

            if (!result.ok) {
                return {
                    success: false,
                    error: `Gemini API Error (${result.status}): ${result.errorMessage || 'Audit call failed'}`
                };
            }

            try {
                const responseData = result.data;
                const textContent = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!textContent) {
                    return { success: false, error: 'Received empty response from auditor model.' };
                }

                const parsed = JSON.parse(textContent);
                return {
                    success: true,
                    approved: Boolean(parsed.approved),
                    verdict: parsed.verdict || (parsed.approved ? 'verified' : 'not-enough'),
                    critique: parsed.critique || (parsed.approved ? 'Criteria fully satisfied.' : 'Insufficient evidence.'),
                    model_used: result.model
                };
            } catch (e) {
                return { success: false, error: 'Auditor model returned invalid JSON structure.' };
            }
        },

        async _callModel(modelName, apiKey, payload) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    const data = await res.json();
                    return { ok: true, status: res.status, data: data, model: modelName };
                }

                let errMsg = '';
                try {
                    const errObj = await res.json();
                    errMsg = errObj.error?.message || res.statusText;
                } catch (e) {
                    errMsg = res.statusText;
                }

                return { ok: false, status: res.status, errorMessage: errMsg, model: modelName };
            } catch (networkErr) {
                return { ok: false, status: 0, errorMessage: networkErr.message, model: modelName };
            }
        }
    };

    return {
        EmergencyManager,
        BreakEngine,
        AuditEngine
    };
}));

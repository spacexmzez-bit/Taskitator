// sync-engine.js
/**
 * Taskitator Unified Cloud Sync Engine
 * Automated debounced push/pull bridge for Cloudflare Worker KV
 * Supports Client-Side SHA-256 Bearer Hashing & Multi-App Namespace Bridge
 * Synchronizes: Tasks, Projects, Daily Breaks, App Settings, Audit Ledger, and Mr. Study Rules.
 */

const SyncEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_TASKS: 'taskitator_tasks',
    STORAGE_KEY_PROJECTS: 'taskitator_projects',
    STORAGE_KEY_BREAKS: 'taskitator_daily_breaks',
    STORAGE_KEY_LEDGER: 'taskitator_audit_ledger',
    STORAGE_KEY_MRSTUDY_RULES: 'taskitator_mrstudy_rules',
    STORAGE_KEY_LAST_LOGIN: 'taskitator_last_login',
    STORAGE_KEY_LAST_MODIFIED: 'taskitator_tasks_last_modified',
    HARDCODED_WORKER_URL: 'https://taskitator-sync.spacexmzez.workers.dev',

    debounceTimer: null,
    hasUnsavedChanges: false,
    listeners: [],

    onStatusChange(fn) {
        this.listeners.push(fn);
    },

    notify(status, detail = null) {
        this.listeners.forEach(fn => fn(status, detail));
        
        if (status === 'synced') {
            window.dispatchEvent(new CustomEvent('taskitator-synced', { detail }));
        } else if (status === 'error') {
            window.dispatchEvent(new CustomEvent('taskitator-sync-error', { detail }));
        } else if (status === 'unconfigured') {
            window.dispatchEvent(new CustomEvent('taskitator-unconfigured', { detail }));
        }
    },

    /**
     * Validates that a password satisfies standard complexity requirements:
     * - Minimum 8 characters
     * - At least 1 uppercase letter ([A-Z])
     * - At least 1 lowercase letter ([a-z])
     * - At least 1 numeric digit ([0-9])
     * - At least 1 special character/symbol
     */
    validatePasswordComplexity(password) {
        const pass = String(password || '');
        const errors = [];

        if (pass.length < 8) {
            errors.push('Must be at least 8 characters long');
        }
        if (!/[A-Z]/.test(pass)) {
            errors.push('Must include at least 1 uppercase letter');
        }
        if (!/[a-z]/.test(pass)) {
            errors.push('Must include at least 1 lowercase letter');
        }
        if (!/[0-9]/.test(pass)) {
            errors.push('Must include at least 1 numeric digit');
        }
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pass)) {
            errors.push('Must include at least 1 special character/symbol');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    },

    /**
     * Derives an irreversible 64-character SHA-256 authentication token client-side.
     * Prevents raw secret exposure across the network or in Cloudflare KV.
     */
    async hashCredentials(username, password) {
        const cleanUser = String(username || '').trim().toLowerCase();
        const cleanPass = String(password || '').trim();
        const salt = 'taskitator-client-v1';

        const encoder = new TextEncoder();
        const payloadData = encoder.encode(`${cleanUser}:${cleanPass}:${salt}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', payloadData);
        
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    /**
     * Ensures any raw secret or token string is converted to a uniform 64-character SHA-256 hex string.
     */
    async ensureSha256(rawSecret) {
        const str = String(rawSecret || '').trim();
        if (/^[a-f0-9]{64}$/i.test(str)) {
            return str.toLowerCase();
        }
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    getConfig() {
        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        } catch (e) {
            settings = {};
        }

        return {
            url: this.HARDCODED_WORKER_URL,
            username: (settings.worker_username || '').trim().toLowerCase(),
            secret: (settings.worker_passkey || '').trim(), // SHA-256 bearer token
            last_synced: settings.last_synced || null
        };
    },

    isConfigured() {
        const config = this.getConfig();
        return Boolean(config.secret && config.username);
    },

    markLocalModified() {
        localStorage.setItem(this.STORAGE_KEY_LAST_MODIFIED, new Date().toISOString());
        this.hasUnsavedChanges = true;
    },

    getPayload(force = false, extraData = {}) {
        let tasks = [];
        let projects = [];
        let breaks = [];
        let ledger = [];
        let settings = {};

        try { tasks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_TASKS) || '[]'); } catch (e) {}
        try { projects = JSON.parse(localStorage.getItem(this.STORAGE_KEY_PROJECTS) || '[]'); } catch (e) {}
        try { settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}'); } catch (e) {}
        try { breaks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_BREAKS) || '[]'); } catch (e) {}
        try { ledger = JSON.parse(localStorage.getItem(this.STORAGE_KEY_LEDGER) || '[]'); } catch (e) {}

        const todayBreaks = (window.TaskitatorEngine && TaskitatorEngine.BreakEngine)
            ? TaskitatorEngine.BreakEngine.getTodayBreaks()
            : breaks;

        const lastLogin = localStorage.getItem(this.STORAGE_KEY_LAST_LOGIN) || null;
        const nowIso = new Date().toISOString();

        return {
            app: 'Taskitator',
            username: settings.worker_username || null,
            updated_at: nowIso,
            force: force,
            tasks: tasks,
            projects: projects,
            settings: settings,
            today_breaks: todayBreaks,
            completed_audit_ledger: ledger,
            last_login: lastLogin,
            ...extraData
        };
    },

    async push(force = false, extraData = {}) {
        const config = this.getConfig();
        if (!config.secret || !config.username) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        this.notify('syncing');
        const payload = this.getPayload(force, extraData);
        const bearerToken = await this.ensureSha256(config.secret);

        try {
            const res = await fetch(`${config.url}/sync/push`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${bearerToken}`,
                    'X-App-ID': 'taskitator',
                    'X-Taskitator-User': config.username
                },
                body: JSON.stringify(payload)
            });

            if (res.status === 409) {
                const conflictData = await res.json();
                this.notify('conflict', conflictData);
                return { success: false, conflict: true, data: conflictData };
            }

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            const data = await res.json().catch(() => ({}));
            
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.last_synced = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));

            this.hasUnsavedChanges = false;
            this.notify('synced', { timestamp: settings.last_synced });
            return { success: true, data };
        } catch (err) {
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    scheduleAutoPush(delayMs = 45000, extraData = {}) {
        if (!this.isConfigured()) return;
        this.markLocalModified();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            if (this.hasUnsavedChanges) {
                this.push(false, extraData);
            }
        }, delayMs);
    },

    flushIfDirty() {
        if (this.hasUnsavedChanges && this.isConfigured()) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.push(false);
        }
    },

    async forceImmediateSync(extraData = {}) {
        if (!this.isConfigured()) return false;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        
        const res = await this.push(true, extraData);
        return res.success;
    },

    /**
     * Executes an atomic credential rotation and cloud partition migration:
     * 1. Verifies current password against active worker_passkey
     * 2. Asserts new password complexity rules
     * 3. Hashes new password into newToken
     * 4. Pushes the full snapshot under newToken to Cloudflare KV
     * 5. Commits newToken to localStorage settings
     */
    async changePassword(currentPassword, newPassword) {
        const config = this.getConfig();
        if (!config.username || !config.secret) {
            return { success: false, error: 'No active session found.' };
        }

        const currentHash = await this.hashCredentials(config.username, currentPassword);
        if (currentHash !== config.secret) {
            return { success: false, error: 'Current password is incorrect.' };
        }

        const complexity = this.validatePasswordComplexity(newPassword);
        if (!complexity.valid) {
            return { success: false, error: complexity.errors.join('; ') };
        }

        const newHash = await this.hashCredentials(config.username, newPassword);
        if (newHash === currentHash) {
            return { success: false, error: 'New password cannot be the same as the current password.' };
        }

        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        } catch (e) {
            settings = {};
        }

        // Prepare full payload under the updated credential set
        settings.worker_passkey = newHash;
        const payload = this.getPayload(true);
        payload.settings = settings;

        this.notify('syncing');

        try {
            const res = await fetch(`${config.url}/sync/push`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${newHash}`,
                    'X-App-ID': 'taskitator',
                    'X-Taskitator-User': config.username
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            settings.last_synced = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            this.hasUnsavedChanges = false;
            this.notify('synced', { timestamp: settings.last_synced });

            return { success: true, newToken: newHash };
        } catch (err) {
            // Revert local passkey on failure
            settings.worker_passkey = config.secret;
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            this.notify('error', err.message);
            return { success: false, error: `Migration failed: ${err.message}` };
        }
    },

    /**
     * Pulls active rules published by Mr. Study from Cloudflare KV.
     */
    async fetchMrStudyRules() {
        const config = this.getConfig();
        if (!config.secret || !config.username) {
            localStorage.removeItem(this.STORAGE_KEY_MRSTUDY_RULES);
            window.dispatchEvent(new CustomEvent('taskitator-mrstudy-rules-updated', { detail: { rules: [], linked: false } }));
            return { linked: false, rules: [] };
        }

        try {
            const bearerToken = await this.ensureSha256(config.secret);
            const res = await fetch(`${config.url}/sync/bridge/mrstudy-rules`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'X-App-ID': 'taskitator',
                    'X-Taskitator-User': config.username
                }
            });

            if (!res.ok) {
                return { linked: false, rules: [] };
            }

            const data = await res.json();
            const rules = Array.isArray(data.rules) ? data.rules : [];
            const isLinked = Boolean(data.linked && rules.length > 0);

            if (isLinked) {
                localStorage.setItem(this.STORAGE_KEY_MRSTUDY_RULES, JSON.stringify(rules));
            } else {
                localStorage.removeItem(this.STORAGE_KEY_MRSTUDY_RULES);
            }

            window.dispatchEvent(new CustomEvent('taskitator-mrstudy-rules-updated', { detail: { rules, linked: isLinked } }));
            return { linked: isLinked, rules };
        } catch (err) {
            console.warn('[SyncEngine] Failed to fetch Mr. Study rules:', err.message);
            return { linked: false, rules: [] };
        }
    },

    async pull(onUpdateCallback = null) {
        const config = this.getConfig();
        if (!config.secret || !config.username) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        if (this.hasUnsavedChanges) {
            await this.push(false);
            return { success: true, localPushed: true };
        }

        this.notify('syncing');
        const bearerToken = await this.ensureSha256(config.secret);

        try {
            const res = await fetch(`${config.url}/sync/pull`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
The primary issue causing the authentication redirect loop is a timing collision between **asynchronous initialization** and the **immediate execution of the authentication gatekeeper IIFE**.

---

### Root Causes

1. **Race Condition in `pull()` Re-writing Settings:**
   Inside `login.html`, credentials are saved to `localStorage` under `taskitator_settings` before calling `SyncEngine.pull()`[span_4](start_span)[span_4](end_span). In `sync-engine.js`, `pull()` contains this block:
   ```javascript
   if (data.settings) {
       data.settings.last_synced = new Date().toISOString();
       if (config.secret && !data.settings.worker_passkey) {
           data.settings.worker_passkey = config.secret;
       }
       if (config.username && !data.settings.worker_username) {
           data.settings.worker_username = config.username;
       }
       localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(data.settings));
   }

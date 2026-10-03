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

    STORAGE_KEY_OWNER: 'taskitator_local_owner',
    STORAGE_KEY_SESSION: 'taskitator_session_id',
    STORAGE_KEY_INITIAL_PULL: 'taskitator_initial_pull_required',
    STORAGE_KEY_REVISION: 'taskitator_local_revision',
    STORAGE_KEY_DIRTY: 'taskitator_sync_dirty',
    ACCOUNT_KEYS: [
        'taskitator_settings', 'taskitator_tasks', 'taskitator_projects',
        'taskitator_daily_breaks', 'taskitator_audit_ledger', 'taskitator_mrstudy_rules',
        'taskitator_last_login', 'taskitator_tasks_last_modified', 'taskitator_collapsed_nodes',
        'taskitator_distraction_notes', 'taskitator_archived_notes', 'taskitator_emergency_state',
        'taskitator_local_revision', 'taskitator_sync_dirty'
    ],
    sessionId: null,
    pushQueue: Promise.resolve(),
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

    // Local backups are keyed by the authenticated credential, never by username alone.
    accountCacheKey(config) {
        return `taskitator_account_cache:${config.username}:${config.secret}`;
    },

    archiveLocalAccount() {
        const config = this.getConfig();
        const snapshot = {};
        this.ACCOUNT_KEYS.forEach(key => {
            const value = localStorage.getItem(key);
            if (value !== null) snapshot[key] = value;
        });
        if (!Object.keys(snapshot).length) return;
        // Credentials are supplied again at login, not restored from the backup.
        if (snapshot[this.STORAGE_KEY_SETTINGS]) {
            const settings = JSON.parse(snapshot[this.STORAGE_KEY_SETTINGS]);
            delete settings.worker_username;
            delete settings.worker_passkey;
            snapshot[this.STORAGE_KEY_SETTINGS] = JSON.stringify(settings);
        }
        const owned = config.username && config.secret &&
            localStorage.getItem(this.STORAGE_KEY_OWNER) === config.username;
        const key = owned ? this.accountCacheKey(config) : 'taskitator_unclaimed_backup';
        // Do not erase working data if the backup fails (e.g. quota exceeded).
        localStorage.setItem(key, JSON.stringify(snapshot));
    },

    clearLocalAccount() {
        this.ACCOUNT_KEYS.forEach(key => localStorage.removeItem(key));
        localStorage.removeItem(this.STORAGE_KEY_OWNER);
        localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
        sessionStorage.removeItem('gemini_fallback_active');
    },

    beginLogin(username, secret) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.archiveLocalAccount();
        const config = { username: username.trim().toLowerCase(), secret };
        const raw = localStorage.getItem(this.accountCacheKey(config));
        const snapshot = raw ? JSON.parse(raw) : {};
        this.clearLocalAccount();
        this.ACCOUNT_KEYS.forEach(key => {
            if (typeof snapshot[key] === 'string') localStorage.setItem(key, snapshot[key]);
        });
        const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        settings.worker_username = config.username;
        settings.worker_passkey = secret;
        settings.worker_url = this.HARDCODED_WORKER_URL;
        localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
        localStorage.setItem(this.STORAGE_KEY_OWNER, config.username);
        localStorage.setItem(this.STORAGE_KEY_INITIAL_PULL, 'true');
        this.sessionId = crypto.randomUUID();
        localStorage.setItem(this.STORAGE_KEY_SESSION, this.sessionId);
        this.hasUnsavedChanges = localStorage.getItem(this.STORAGE_KEY_DIRTY) === 'true';
    },

    initializeSession() {
        const config = this.getConfig();
        const owner = localStorage.getItem(this.STORAGE_KEY_OWNER);
        if (!localStorage.getItem('taskitator_exemplar_legacy_owner')) {
            localStorage.setItem('taskitator_exemplar_legacy_owner', config.username || '__unclaimed__');
        }
        // One-time migration for an already signed-in installation.
        if (config.username && config.secret && !owner) {
            localStorage.setItem(this.STORAGE_KEY_OWNER, config.username);
        }
        if (!localStorage.getItem(this.STORAGE_KEY_SESSION)) {
            localStorage.setItem(this.STORAGE_KEY_SESSION, crypto.randomUUID());
        }
        this.sessionId = localStorage.getItem(this.STORAGE_KEY_SESSION);
        this.hasUnsavedChanges = localStorage.getItem(this.STORAGE_KEY_DIRTY) === 'true';
    },

    sessionMatches(config, sessionId = this.sessionId) {
        const current = this.getConfig();
        return sessionId === localStorage.getItem(this.STORAGE_KEY_SESSION) &&
            current.username === config.username && current.secret === config.secret &&
            localStorage.getItem(this.STORAGE_KEY_OWNER) === config.username;
    },

    needsInitialPull() {
        return localStorage.getItem(this.STORAGE_KEY_INITIAL_PULL) === 'true';
    },

    isDirty() {
        return this.hasUnsavedChanges || localStorage.getItem(this.STORAGE_KEY_DIRTY) === 'true';
    },

    markLocalModified() {
        localStorage.setItem(this.STORAGE_KEY_LAST_MODIFIED, new Date().toISOString());
        localStorage.setItem(this.STORAGE_KEY_REVISION, crypto.randomUUID());
        localStorage.setItem(this.STORAGE_KEY_DIRTY, 'true');
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

    push(force = false, extraData = {}) {
        const sessionId = this.sessionId;
        const config = this.getConfig();
        // Serialize uploads so an older snapshot cannot arrive after a newer one.
        const run = () => this.sessionMatches(config, sessionId)
            ? this.performPush(force, extraData)
            : { success: false, reason: 'session_changed' };
        const result = this.pushQueue.then(run, run);
        this.pushQueue = result.catch(() => {});
        return result;
    },

    async performPush(force = false, extraData = {}) {
        const config = this.getConfig();
        if (!config.secret || !config.username) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        if (this.needsInitialPull()) return { success: false, reason: 'initial_pull_required' };
        const sessionId = this.sessionId;
        const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
        this.notify('syncing');
        // Read breaks at upload time, not from a stale debounce closure.
        const { today_breaks: ignoredBreaks, ...currentExtras } = extraData;
        const payload = this.getPayload(force, currentExtras);

        try {
            const bearerToken = await this.ensureSha256(config.secret);
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
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

            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
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
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };

            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.last_synced = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));

            const pending = revision !== localStorage.getItem(this.STORAGE_KEY_REVISION);
            this.hasUnsavedChanges = pending;
            localStorage.setItem(this.STORAGE_KEY_DIRTY, String(pending));
            this.notify(pending ? 'pending' : 'synced', { timestamp: settings.last_synced });
            if (pending && !this.debounceTimer) this.queueAutoPush();
            return { success: true, pending, data };
        } catch (err) {
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    scheduleAutoPush(delayMs = 45000, extraData = {}) {
        if (!this.isConfigured()) return;
        this.markLocalModified();
        this.queueAutoPush(delayMs, extraData);
    },

    queueAutoPush(delayMs = 45000, extraData = {}) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.isDirty()) this.push(false, extraData);
        }, delayMs);
    },

    flushIfDirty() {
        if (this.isDirty() && this.isConfigured() && !this.needsInitialPull()) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
            this.push(false);
        }
    },

    async forceImmediateSync(extraData = {}) {
        if (!this.isConfigured()) return false;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
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
    changePassword(currentPassword, newPassword) {
        const config = this.getConfig();
        const sessionId = this.sessionId;
        const run = () => this.sessionMatches(config, sessionId)
            ? this.performPasswordChange(currentPassword, newPassword)
            : { success: false, error: 'Session changed. Please sign in again.' };
        const result = this.pushQueue.then(run, run);
        this.pushQueue = result.catch(() => {});
        return result;
    },

    async performPasswordChange(currentPassword, newPassword) {
        const config = this.getConfig();
        if (!config.username || !config.secret) {
            return { success: false, error: 'No active session found.' };
        }

        if (this.needsInitialPull()) return { success: false, error: 'Complete sign-in before changing passwords.' };
        const sessionId = this.sessionId;
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

        if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
        const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
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

            if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
            // Preserve settings edited while the password request was pending.
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.worker_passkey = newHash;
            settings.last_synced = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            const pending = revision !== localStorage.getItem(this.STORAGE_KEY_REVISION);
            this.hasUnsavedChanges = pending;
            localStorage.setItem(this.STORAGE_KEY_DIRTY, String(pending));
            this.notify(pending ? 'pending' : 'synced', { timestamp: settings.last_synced });
            if (pending) this.queueAutoPush();

            return { success: true, newToken: newHash };
        } catch (err) {
            // The active credential was never changed before server success.
            if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
            this.notify('error', err.message);
            return { success: false, error: `Migration failed: ${err.message}` };
        }
    },

    /**
     * Pulls active rules published by Mr. Study from Cloudflare KV.
     */
    async fetchMrStudyRules() {
        const config = this.getConfig();
        const sessionId = this.sessionId;
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
            if (!this.sessionMatches(config, sessionId)) return { linked: false, rules: [] };
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

        const initial = this.needsInitialPull();
        const sessionId = this.sessionId;
        const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
        if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
        if (!initial && this.isDirty()) {
            const result = await this.push(false);
            return result.success ? { ...result, localPushed: true } : result;
        }

        this.notify('syncing');
        const bearerToken = await this.ensureSha256(config.secret);

        try {
            const res = await fetch(`${config.url}/sync/pull`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'X-App-ID': 'taskitator',
                    'X-Taskitator-User': config.username
                }
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            const data = await res.json();
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (revision !== localStorage.getItem(this.STORAGE_KEY_REVISION)) {
                return { success: false, reason: 'local_changed', error: 'Local edits occurred during download. Please sync again.' };
            }

            if (data.empty) {
                localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
                this.notify('synced', { empty: true });
                this.fetchMrStudyRules();
                return { success: true, empty: true };
            }

            if (!Array.isArray(data.tasks)) {
                throw new Error('Malformed snapshot: tasks array missing.');
            }

            localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
            const localLastMod = localStorage.getItem(this.STORAGE_KEY_LAST_MODIFIED);
            if (localLastMod && data.updated_at) {
                const localTime = new Date(localLastMod).getTime();
                const remoteTime = new Date(data.updated_at).getTime();
                if (localTime > remoteTime) {
                    // The login request must never upload. The dashboard resumes
                    // pending same-account edits after authentication completes.
                    if (initial) {
                        this.hasUnsavedChanges = true;
                        localStorage.setItem(this.STORAGE_KEY_DIRTY, 'true');
                        return { success: true, localWasFresher: true, pending: true };
                    }
                    const result = await this.push(true);
                    if (result.success) this.fetchMrStudyRules();
                    return result.success ? { ...result, localWasFresher: true } : result;
                }
            }

            const localTasksRaw = localStorage.getItem(this.STORAGE_KEY_TASKS);
            const remoteTasksRaw = JSON.stringify(data.tasks);

            // Reconcile Tasks
            localStorage.setItem(this.STORAGE_KEY_TASKS, remoteTasksRaw);

            // Reconcile Projects
            if (data.projects && Array.isArray(data.projects)) {
                localStorage.setItem(this.STORAGE_KEY_PROJECTS, JSON.stringify(data.projects));
            }
            
            // Reconcile Settings (Guarded against wiping active local session credentials)
            if (data.settings && typeof data.settings === 'object') {
                const updatedSettings = {
                    ...data.settings,
                    worker_username: config.username,
                    worker_passkey: config.secret,
                    last_synced: new Date().toISOString()
                };
                localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(updatedSettings));
            }

            // Reconcile Breaks
            if (data.today_breaks && Array.isArray(data.today_breaks)) {
                localStorage.setItem(this.STORAGE_KEY_BREAKS, JSON.stringify(data.today_breaks));
            }

            // Reconcile Audit Ledger
            if (data.completed_audit_ledger && Array.isArray(data.completed_audit_ledger)) {
                localStorage.setItem(this.STORAGE_KEY_LEDGER, JSON.stringify(data.completed_audit_ledger));
            }

            if (data.last_login) {
                localStorage.setItem(this.STORAGE_KEY_LAST_LOGIN, data.last_login);
            }

            this.hasUnsavedChanges = false;
            localStorage.setItem(this.STORAGE_KEY_DIRTY, 'false');
            this.notify('synced', { timestamp: new Date().toISOString() });

            // Fetch latest companion rules in background
            this.fetchMrStudyRules();

            if (onUpdateCallback && localTasksRaw !== remoteTasksRaw) {
                onUpdateCallback();
            }

            return { success: true, data };
        } catch (err) {
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    /**
     * Wipes active session credentials and returns the client to an unauthenticated state.
     */
    logout() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        try {
            this.archiveLocalAccount();
        } catch (err) {
            this.notify('error', 'Could not preserve local data. Export a backup before logging out.');
            return false;
        }
        this.clearLocalAccount();
        this.hasUnsavedChanges = false;
        this.sessionId = crypto.randomUUID();
        localStorage.setItem(this.STORAGE_KEY_SESSION, this.sessionId);
        this.notify('unconfigured');
        return true;
    }

};

SyncEngine.initializeSession();

// Automatically flush pending changes to cloud when user minimizes PWA or switches tabs
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        SyncEngine.flushIfDirty();
    }
});

// Flush on page exit/navigation
window.addEventListener('beforeunload', () => {
    SyncEngine.flushIfDirty();
});

// Centralized Authentication Gatekeeper (Clean Path Guard)
(function enforceAuthenticationGuard() {
    const cleanPath = window.location.pathname.split('/').pop().toLowerCase();
    const isLoginPage = cleanPath === 'login.html';
    const isConfigured = SyncEngine.isConfigured() && !SyncEngine.needsInitialPull();

    if (!isConfigured && !isLoginPage) {
        window.location.replace('login.html');
    } else if (isConfigured && isLoginPage) {
        window.location.replace('index.html');
    }
})();

window.SyncEngine = SyncEngine;

// Another tab changed accounts: discard this page's in-memory task state.
window.addEventListener('storage', event => {
    if (event.key === SyncEngine.STORAGE_KEY_SESSION && event.newValue !== SyncEngine.sessionId) {
        if (SyncEngine.debounceTimer) clearTimeout(SyncEngine.debounceTimer);
        window.location.reload();
    }
});

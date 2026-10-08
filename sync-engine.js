// sync-engine.js
/**
 * Taskitator Unified Cloud Sync Engine
 * Change-triggered, fixed two-minute sync batches with protected cloud writes
 * Supports account isolation, password-change recovery and manual sync
 * Synchronizes: Tasks, Projects, Daily Breaks, App Settings, Audit Ledger, Saved Criteria. No idle cloud polling.
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
    STORAGE_KEY_SAVED_CRITERIA: 'taskitator_saved_criteria',
    HARDCODED_WORKER_URL: 'https://taskitator-sync.spacexmzez.workers.dev',

    STORAGE_KEY_OWNER: 'taskitator_local_owner',
    STORAGE_KEY_SESSION: 'taskitator_session_id',
    STORAGE_KEY_INITIAL_PULL: 'taskitator_initial_pull_required',
    STORAGE_KEY_REVISION: 'taskitator_local_revision',
    STORAGE_KEY_DIRTY: 'taskitator_sync_dirty',
    STORAGE_KEY_REMOTE_VERSION: 'taskitator_remote_version',
    STORAGE_KEY_VERSION_PENDING: 'taskitator_version_pending',
    STORAGE_KEY_ROTATION: 'taskitator_pending_rotation',
    STORAGE_KEY_AUTO_DEADLINE: 'taskitator_auto_sync_deadline',
    STORAGE_KEY_PENDING_DOWNLOAD: 'taskitator_pending_sync_download',
    AUTO_WINDOW_MS: 120000,
    refreshGuards: [],
    ACCOUNT_KEYS: [
        'taskitator_settings', 'taskitator_tasks', 'taskitator_projects',
        'taskitator_daily_breaks', 'taskitator_audit_ledger', 'taskitator_mrstudy_rules',
        'taskitator_saved_criteria', 'taskitator_last_login', 'taskitator_tasks_last_modified',
        'taskitator_collapsed_nodes', 'taskitator_distraction_notes', 'taskitator_archived_notes',
        'taskitator_emergency_state', 'taskitator_local_revision', 'taskitator_sync_dirty',
        'taskitator_remote_version', 'taskitator_version_pending', 'taskitator_pending_rotation', 'taskitator_auto_sync_deadline',
        'taskitator_pending_sync_download'
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
        console.log(`[SyncEngine] Status update: ${status}`, detail || '');
        this.listeners.forEach(fn => {
            try { fn(status, detail); } catch (e) { console.error(e); }
        });
        
        if (status === 'synced') {
            window.dispatchEvent(new CustomEvent('taskitator-synced', { detail }));
        } else if (status === 'error') {
            window.dispatchEvent(new CustomEvent('taskitator-sync-error', { detail }));
        } else if (status === 'unconfigured') {
            window.dispatchEvent(new CustomEvent('taskitator-unconfigured', { detail }));
        }
    },

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
            secret: (settings.worker_passkey || '').trim(),
            last_synced: settings.last_synced || null
        };
    },

    isConfigured() {
        const config = this.getConfig();
        return Boolean(config.secret && config.username);
    },

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
        if (snapshot[this.STORAGE_KEY_SETTINGS]) {
            const settings = JSON.parse(snapshot[this.STORAGE_KEY_SETTINGS]);
            delete settings.worker_username;
            delete settings.worker_passkey;
            snapshot[this.STORAGE_KEY_SETTINGS] = JSON.stringify(settings);
        }
        const owned = config.username && config.secret &&
            localStorage.getItem(this.STORAGE_KEY_OWNER) === config.username;
        const key = owned ? this.accountCacheKey(config) : 'taskitator_unclaimed_backup';
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
        this.pendingPageRefresh = false;
        this.pendingDownloadOrigin = null;
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
        this.startAutoWindow();
    },

    rememberRemoteVersion(version) {
        if (Number.isSafeInteger(version) && version >= 0) {
            localStorage.setItem(this.STORAGE_KEY_REMOTE_VERSION, String(version));
            localStorage.removeItem(this.STORAGE_KEY_VERSION_PENDING);
        }
    },

    getPayload(force = false, extraData = {}) {
        let tasks = [];
        let projects = [];
        let breaks = [];
        let ledger = [];
        let settings = {};
        let savedCriteria = [];

        try { tasks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_TASKS) || '[]'); } catch (e) {}
        try { projects = JSON.parse(localStorage.getItem(this.STORAGE_KEY_PROJECTS) || '[]'); } catch (e) {}
        try { settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}'); } catch (e) {}
        try { breaks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_BREAKS) || '[]'); } catch (e) {}
        try { ledger = JSON.parse(localStorage.getItem(this.STORAGE_KEY_LEDGER) || '[]'); } catch (e) {}
        try { savedCriteria = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SAVED_CRITERIA) || '[]'); } catch (e) {}

        const todayBreaks = breaks; // Preserve dates and lock state across devices.

        const lastLogin = localStorage.getItem(this.STORAGE_KEY_LAST_LOGIN) || null;
        // Record when the edit happened, not when its delayed upload started.
        const nowIso = this.isDirty()
            ? localStorage.getItem(this.STORAGE_KEY_LAST_MODIFIED) || new Date().toISOString()
            : new Date().toISOString();

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
            saved_criteria: savedCriteria,
            last_login: lastLogin,
            ...extraData
        };
    },

    push(force = false, extraData = {}) {
        const sessionId = this.sessionId;
        const config = this.getConfig();
        const run = () => this.sessionMatches(config, sessionId)
            ? this.performPush(force, extraData)
            : { success: false, reason: 'session_changed' };
        const result = this.pushQueue.then(run, run);
        this.pushQueue = result.catch(() => {});
        return result;
    },

    async performPush(force = false, extraData = {}) {
        const recovered = await this.resumePasswordChange();
        if (!recovered.success) return recovered;
        const config = this.getConfig(), sessionId = this.sessionId;
        if (!this.isConfigured()) return { success: false, reason: 'unconfigured' };
        if (this.needsInitialPull()) return { success: false, reason: 'initial_pull_required' };
        let revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
        if (!revision) {
            revision = crypto.randomUUID();
            localStorage.setItem(this.STORAGE_KEY_REVISION, revision);
        }
        this.notify('syncing');
        try {
            let base = localStorage.getItem(this.STORAGE_KEY_REMOTE_VERSION);
            if (base === null) {
                const remote = await this.readCloud(config);
                if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
                if (!remote.empty) return this.reportConflict({ remote_version: remote.version });
                this.rememberRemoteVersion(remote.version);
                base = String(remote.version);
            }
            const { today_breaks: ignoredBreaks, ...currentExtras } = extraData;
            const payload = this.getPayload(false, currentExtras);
            payload.base_version = Number(base);
            payload.mutation_id = revision;
            const bearerToken = await this.ensureSha256(config.secret);
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            const res = await this.request(`${config.url}/sync/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}`,
                    'X-App-ID': 'taskitator', 'X-Taskitator-User': config.username },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (res.status === 409) return this.reportConflict(data);
            if (!res.ok || data.success !== true || data.version !== payload.base_version + 1) {
                throw new Error(data.error || 'Upload acknowledgement is invalid. Local changes were retained.');
            }
            this.rememberRemoteVersion(data.version);
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.last_synced = data.updated_at;
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

    async readCloud(config = this.getConfig()) {
        const bearerToken = await this.ensureSha256(config.secret);
        const res = await this.request(`${config.url}/sync/pull`, {
            method: 'GET', cache: 'no-store',
            headers: { 'Authorization': `Bearer ${bearerToken}`, 'X-App-ID': 'taskitator',
                'X-Taskitator-User': config.username }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!Number.isSafeInteger(data.version) || data.version < 0 || (!data.empty && !Array.isArray(data.tasks))) {
            throw new Error('Update the Worker: a valid versioned snapshot is required.');
        }
        return data;
    },

    async request(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            // Keep the timeout active until the body has finished downloading.
            const data = await response.json();
            return { ok: response.ok, status: response.status, json: async () => data };
        } finally { clearTimeout(timer); }
    },

    scheduleAutoPush(delayMs, extraData = {}) {
        // Compatibility with older callers: each saved edit joins the same batch.
        if (this.isConfigured()) this.markLocalModified();
    },

    queueAutoPush() {
        // Re-arm an existing deadline; never create a repeating cycle.
        this.armAutoSync();
    },

    startAutoWindow() {
        if (!this.isConfigured()) return;
        if (localStorage.getItem(this.STORAGE_KEY_AUTO_DEADLINE) === null) {
            localStorage.setItem(this.STORAGE_KEY_AUTO_DEADLINE, String(Date.now() + this.AUTO_WINDOW_MS));
        }
        this.armAutoSync();
    },

    armAutoSync() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        const raw = localStorage.getItem(this.STORAGE_KEY_AUTO_DEADLINE);
        if (raw === null || !this.isConfigured() || this.needsInitialPull()) return;
        const deadline = Number(raw);
        if (!Number.isFinite(deadline)) {
            localStorage.removeItem(this.STORAGE_KEY_AUTO_DEADLINE);
            return;
        }
        const config = this.getConfig(), sessionId = this.sessionId;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.sessionMatches(config, sessionId)) {
                this.runAutoSync(deadline).catch(err => this.notify('error', err.message));
            }
        }, Math.max(0, deadline - Date.now()));
    },

    cancelAutoWindow() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        localStorage.removeItem(this.STORAGE_KEY_AUTO_DEADLINE);
    },

    async runAutoSync(deadline) {
        const run = async () => {
            if (localStorage.getItem(this.STORAGE_KEY_AUTO_DEADLINE) !== String(deadline)) return;
            if (Date.now() < deadline) { this.armAutoSync(); return; }
            if (!this.isConfigured() || this.needsInitialPull()) return;
            // Consume this batch once. Failed attempts wait for manual sync or a
            // new saved edit, rather than retrying every two minutes forever.
            this.cancelAutoWindow();
            if (this.isDirty()) return this.syncNow({ origin: 'auto' });
        };
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return navigator.locks.request(`taskitator-auto:${this.getConfig().username}`,
                { ifAvailable: true }, lock => lock ? run() : undefined);
        }
        return run();
    },

    flushIfDirty() {
        // Navigation and tab hiding preserve the deadline without an early upload.
        this.armAutoSync();
    },

    async forceImmediateSync(extraData = {}) {
        const result = await this.syncNow({ origin: 'manual', extraData });
        return Boolean(result?.success);
    },

    async syncNow({ origin = 'manual', extraData = {} } = {}) {
        if (this.syncInFlight) {
            if (origin === 'manual') this.manualRefreshRequested = true;
            return this.syncInFlight;
        }
        let config = this.getConfig();
        const sessionId = this.sessionId;
        const run = async () => {
            const recovered = await this.resumePasswordChange();
            if (!recovered.success) return recovered;
            if (this.getConfig().username !== config.username || sessionId !== localStorage.getItem(this.STORAGE_KEY_SESSION)) {
                return { success: false, reason: 'session_changed' };
            }
            config = this.getConfig();
            if (!this.isConfigured()) return { success: false, reason: 'unconfigured' };
            if (this.isDirty()) {
                const sent = await this.push(false, extraData);
                if (!sent.success || sent.pending || this.isDirty()) return sent;
            }
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (!this.isSafeToRefresh()) {
                this.pendingDownloadOrigin = this.manualRefreshRequested ? 'manual' : origin;
                this.manualRefreshRequested = false;
                localStorage.setItem(this.STORAGE_KEY_PENDING_DOWNLOAD, this.pendingDownloadOrigin);
                return { success: true, deferred: true };
            }
            const received = await this.pull();
            if (!this.sessionMatches(config, sessionId) || !received.success || this.isDirty()) return received;
            this.cancelAutoWindow();
            this.pendingDownloadOrigin = null;
            localStorage.removeItem(this.STORAGE_KEY_PENDING_DOWNLOAD);
            const refreshOrigin = this.manualRefreshRequested ? 'manual' : origin;
            this.manualRefreshRequested = false;
            if (refreshOrigin === 'manual' || this.autoRefreshEnabled()) {
                this.pendingPageRefresh = true;
                this.pendingRefreshOrigin = refreshOrigin;
            }
            return received;
        };
        this.syncInFlight = run();
        let result;
        try { result = await this.syncInFlight; }
        finally { this.syncInFlight = null; }
        if (!result?.success) this.manualRefreshRequested = false;
        this.maybeRefreshPage();
        return result;
    },

    registerRefreshGuard(guard) {
        this.refreshGuards.push(guard);
    },

    isSafeToRefresh() {
        if (this.refreshGuards.some(guard => !guard())) return false;
        if (document.visibilityState === 'hidden') return false;
        if (document.querySelector?.('.modal-overlay.open, dialog[open]')) return false;
        const active = document.activeElement;
        return !active?.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName);
    },

    autoRefreshEnabled() {
        try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}').auto_page_refresh !== false; }
        catch { return true; }
    },

    maybeRefreshPage() {
        if (this.syncInFlight || this.isDirty() || !this.isSafeToRefresh()) return;
        this.pendingDownloadOrigin ||= localStorage.getItem(this.STORAGE_KEY_PENDING_DOWNLOAD);
        if (this.pendingDownloadOrigin) {
            const origin = this.pendingDownloadOrigin;
            this.pendingDownloadOrigin = null;
            localStorage.removeItem(this.STORAGE_KEY_PENDING_DOWNLOAD);
            this.syncNow({ origin }).catch(err => this.notify('error', err.message));
            return;
        }
        if (this.pendingPageRefresh) {
            this.pendingPageRefresh = false;
            if (this.pendingRefreshOrigin !== 'auto' || this.autoRefreshEnabled()) window.location.reload();
        }
    },

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
        const config = this.getConfig(), sessionId = this.sessionId;
        if (!this.isConfigured() || this.needsInitialPull()) {
            return { success: false, error: 'Complete initial synchronization before changing passwords.' };
        }
        const currentHash = await this.hashCredentials(config.username, currentPassword);
        const activeToken = await this.ensureSha256(config.secret);
        if (currentHash !== activeToken) return { success: false, error: 'Current password is incorrect.' };
        const complexity = this.validatePasswordComplexity(newPassword);
        if (!complexity.valid) return { success: false, error: complexity.errors.join('; ') };
        const newHash = await this.hashCredentials(config.username, newPassword);
        if (newHash === activeToken) return { success: false, error: 'New password must be different.' };
        if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
        const pending = this.getPendingRotation();
        if (pending) {
            if (pending.new_token !== newHash) return { success: false, error: 'Finish the previous password change first.' };
            return this.resumePasswordChange();
        }
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        // Persist local edits with version protection before rotating credentials.
        if (this.isDirty()) {
            const uploaded = await this.performPush(false);
            if (!uploaded.success || uploaded.pending) return { ...uploaded, success: false,
                error: uploaded.error || 'Finish syncing local edits before changing passwords.' };
        }
        if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
        const version = localStorage.getItem(this.STORAGE_KEY_REMOTE_VERSION);
        if (version === null) return { success: false, error: 'Sync once before changing passwords.' };
        const operation = { username: config.username, old_token: activeToken, new_token: newHash,
            base_version: Number(version), rotation_id: crypto.randomUUID() };
        try {
            // Small recovery record; never store plaintext passwords or duplicate the snapshot.
            localStorage.setItem(this.STORAGE_KEY_ROTATION, JSON.stringify(operation));
        } catch {
            return { success: false, error: 'Cannot save password-change recovery details. Free local storage and retry.' };
        }
        return this.resumePasswordChange();
    },

    getPendingRotation() {
        const raw = localStorage.getItem(this.STORAGE_KEY_ROTATION);
        return raw ? JSON.parse(raw) : null;
    },

    async resumePasswordChange() {
        // Share one request when a page-load download and a queued upload both recover.
        if (this.rotationInFlight) return this.rotationInFlight;
        const operation = this.getPendingRotation();
        if (!operation) return { success: true };
        this.rotationInFlight = this.completePasswordRotation(operation);
        try { return await this.rotationInFlight; }
        finally { this.rotationInFlight = null; }
    },

    async completePasswordRotation(operation) {
        const config = this.getConfig(), sessionId = this.sessionId;
        const configuredToken = await this.ensureSha256(config.secret);
        if (config.username !== operation.username ||
            ![operation.old_token, operation.new_token].includes(configuredToken)) {
            return { success: false, error: 'Password recovery belongs to another session.' };
        }
        try {
            this.notify('syncing');
            const res = await this.request(`${config.url}/sync/password-change`, {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    'Authorization': `Bearer ${operation.old_token}`, 'X-App-ID': 'taskitator',
                    'X-Taskitator-User': operation.username },
                body: JSON.stringify({ username: operation.username, new_token: operation.new_token,
                    base_version: operation.base_version, rotation_id: operation.rotation_id })
            });
            const data = await res.json();
            if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
            if (res.status === 409) {
                localStorage.removeItem(this.STORAGE_KEY_ROTATION);
                return this.reportConflict(data);
            }
            if (!res.ok || data.success !== true || data.rotation_id !== operation.rotation_id ||
                data.version !== operation.base_version + 1) {
                if ([400, 428].includes(res.status)) localStorage.removeItem(this.STORAGE_KEY_ROTATION);
                throw new Error(data.error || 'Password change was not confirmed. Retry to recover the result.');
            }
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.worker_passkey = operation.new_token;
            settings.last_synced = data.updated_at;
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            this.rememberRemoteVersion(data.version);
            localStorage.removeItem(this.STORAGE_KEY_ROTATION);
            this.notify(this.isDirty() ? 'pending' : 'synced', { timestamp: data.updated_at });
            if (this.isDirty()) this.queueAutoPush();
            return { success: true, newToken: operation.new_token };
        } catch (err) {
            if (!this.sessionMatches(config, sessionId)) return { success: false, error: 'Session changed.' };
            this.notify('error', err.message);
            return { success: false, error: err.message, recoveryPending: true };
        }
    },

    async fetchMrStudyRules() {
        localStorage.removeItem(this.STORAGE_KEY_MRSTUDY_RULES);
        return { linked: false, rules: [] };
    },

    async pull(onUpdateCallback = null, options = {}) {
        const recovered = await this.resumePasswordChange();
        if (!recovered.success) return recovered;
        const config = this.getConfig(), sessionId = this.sessionId;
        if (!this.isConfigured()) return { success: false, reason: 'unconfigured' };
        const initial = this.needsInitialPull();
        const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
        if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
        if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
            return { success: false, error: 'Local edits changed. Review the conflict again.' };
        }
        if (!initial && this.isDirty() && !options.discardLocal) {
            const result = await this.push(false);
            return result.success ? { ...result, localPushed: true } : result;
        }
        this.notify('syncing');
        try {
            const data = await this.readCloud(config);
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (revision !== localStorage.getItem(this.STORAGE_KEY_REVISION)) {
                return { success: false, reason: 'local_changed', error: 'Local edits occurred during download. Try again.' };
            }
            if (options.expectedVersion !== undefined && options.expectedVersion !== data.version) {
                return this.reportConflict({ remote_version: data.version });
            }
            const seen = localStorage.getItem(this.STORAGE_KEY_REMOTE_VERSION);
            if (!options.discardLocal && seen !== null && data.version < Number(seen)) {
                return this.reportConflict({ remote_version: data.version, error: 'Cloud revision is older than this device. Check the migration before choosing a copy.' });
            }
            const modified = localStorage.getItem(this.STORAGE_KEY_LAST_MODIFIED);
            const legacyLocalNewer = seen === null && modified && data.updated_at &&
                Date.parse(modified) > Date.parse(data.updated_at);
            if (!options.discardLocal && !data.empty && (this.isDirty() || legacyLocalNewer)) {
                localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
                this.hasUnsavedChanges = true;
                localStorage.setItem(this.STORAGE_KEY_DIRTY, 'true');
                return this.reportConflict({ remote_version: data.version });
            }
            if (data.empty && !options.discardLocal) {
                this.rememberRemoteVersion(data.version);
                localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
                this.notify(this.isDirty() ? 'pending' : 'synced', { empty: true });
                if (this.isDirty()) this.armAutoSync();
                return { success: true, empty: true, pending: this.isDirty() };
            }
            const currentSettings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            const updates = {
                [this.STORAGE_KEY_TASKS]: JSON.stringify(data.tasks || []),
                [this.STORAGE_KEY_PROJECTS]: JSON.stringify(data.projects || []),
                [this.STORAGE_KEY_SETTINGS]: JSON.stringify({ ...(data.settings || currentSettings),
                    worker_username: config.username, worker_passkey: config.secret,
                    last_synced: data.saved_at || data.updated_at || new Date().toISOString() }),
                [this.STORAGE_KEY_LEDGER]: JSON.stringify(data.completed_audit_ledger || []),
                [this.STORAGE_KEY_SAVED_CRITERIA]: JSON.stringify(data.saved_criteria || []),
                [this.STORAGE_KEY_REMOTE_VERSION]: String(data.version),
                [this.STORAGE_KEY_REVISION]: crypto.randomUUID(),
                [this.STORAGE_KEY_DIRTY]: 'false'
            };
            let breakRecords = data.today_breaks || {};
            if (Array.isArray(breakRecords)) {
                const records = {};
                const hour = Number(data.settings?.day_start_hour) || 0;
                const saved = Date.parse(data.updated_at);
                const fallbackDate = Number.isFinite(saved) ? new Date(saved + (3 - hour) * 3600000).toISOString().slice(0, 10) : null;
                for (const b of breakRecords) {
                    const date = b?.date || fallbackDate;
                    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                    records[date] ||= { date, locked: true, window_started_at: null, breaks: [] };
                    records[date].breaks.push(b);
                }
                breakRecords = records;
            }
            updates[this.STORAGE_KEY_BREAKS] = JSON.stringify(breakRecords);
            if (data.last_login) updates[this.STORAGE_KEY_LAST_LOGIN] = data.last_login;
            const before = new Map(Object.keys(updates).map(key => [key, localStorage.getItem(key)]));
            try {
                for (const [key, value] of Object.entries(updates)) localStorage.setItem(key, value);
            } catch (err) {
                // Restore the previous account copy if browser storage fills midway.
                for (const key of Object.keys(updates)) localStorage.removeItem(key);
                for (const [key, value] of before) if (value !== null) localStorage.setItem(key, value);
                throw err;
            }
            localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
            localStorage.removeItem(this.STORAGE_KEY_VERSION_PENDING);
            this.hasUnsavedChanges = false;
            this.cancelAutoWindow();
            this.notify('synced', { timestamp: data.updated_at });
            window.dispatchEvent(new CustomEvent('taskitator-saved-criteria-updated'));
            if (onUpdateCallback) onUpdateCallback();
            return { success: true, data };
        } catch (err) {
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    reportConflict(data = {}) {
        const detail = { ...data, conflict: true,
            error: data.error || 'Another device changed cloud data. Both copies are kept until you choose.' };
        this.notify('conflict', detail);
        this.notify('error', detail.error);
        if (typeof document.createElement === 'function' && document.body) {
            this.openConflictDialog().catch(err => this.notify('error', err.message));
        }
        return { success: false, conflict: true, error: detail.error, data: detail };
    },

    async openConflictDialog() {
        if (this.conflictDialogOpen) return;
        this.conflictDialogOpen = true;
        let dialog;
        try {
            const config = this.getConfig(), sessionId = this.sessionId;
            const remote = await this.readCloud(config);
            if (!this.sessionMatches(config, sessionId)) return;
            const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
            const local = this.getPayload();
            dialog = document.createElement('dialog');
            dialog.className = 'modal-overlay open';
            dialog.style.cssText = 'display:block;position:fixed;inset:0;margin:auto;width:min(90vw,480px);height:fit-content;max-height:90vh;overflow:auto;padding:24px;border:1px solid #777;border-radius:12px;background:#171b24;color:#fff;z-index:2147483647;';
            const title = document.createElement('h2'); title.textContent = 'Choose which copy to keep';
            const description = document.createElement('p');
            description.textContent = 'This device and the cloud have different edits. Nothing has been overwritten. Download both copies before choosing. Your choice replaces the other copy; it does not merge tasks.';
            const feedback = document.createElement('p');
            dialog.append(title, description, feedback);
            const addButton = (label, handler) => {
                const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
                button.style.cssText = 'margin:6px;padding:10px;border-radius:6px;cursor:pointer;';
                button.addEventListener('click', handler); dialog.appendChild(button); return button;
            };
            const close = () => { dialog.remove(); this.conflictDialogOpen = false; };
            const downloadBackup = (snapshot, label) => {
                const settings = { ...(snapshot.settings || {}) };
                delete settings.worker_passkey;
                delete settings.gemini_api_key;
                const backup = {
                    export_date: new Date().toISOString(),
                    taskitator_tasks: snapshot.tasks || [],
                    taskitator_projects: snapshot.projects || [],
                    taskitator_settings: settings,
                    taskitator_daily_breaks: snapshot.today_breaks || {},
                    taskitator_audit_ledger: snapshot.completed_audit_ledger || [],
                    taskitator_saved_criteria: snapshot.saved_criteria || []
                };
                const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
                const link = document.createElement('a'); link.href = url; link.download = `taskitator-${label}-backup.json`;
                document.body.appendChild(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
            };
            addButton('Download device backup', () => downloadBackup(local, 'device'));
            addButton('Download cloud backup', () => downloadBackup(remote, 'cloud'));
            let busy = false;
            const choose = async mode => {
                if (busy) return;
                busy = true;
                feedback.textContent = 'Applying your choice…';
                const run = async () => {
                    if (!this.sessionMatches(config, sessionId) || revision !== localStorage.getItem(this.STORAGE_KEY_REVISION)) {
                        return { success: false, error: 'Session or local edits changed. Close this dialog and sync again.' };
                    }
                    if (mode === 'cloud') return this.pull(null, { discardLocal: true,
                        expectedVersion: remote.version, expectedRevision: revision });
                    this.rememberRemoteVersion(remote.version);
                    localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
                    this.hasUnsavedChanges = true;
                    localStorage.setItem(this.STORAGE_KEY_DIRTY, 'true');
                    return this.performPush(false);
                };
                const pending = this.pushQueue.then(run, run);
                this.pushQueue = pending.catch(() => {});
                try {
                    const result = await pending;
                    if (result.success) close();
                    else feedback.textContent = result.error || 'The cloud changed again. Close this dialog and review the new conflict.';
                } catch (err) { feedback.textContent = err.message; }
                finally { busy = false; }
            };
            addButton('Use cloud copy', () => choose('cloud'));
            addButton('Keep this device’s copy', () => choose('local'));
            addButton('Decide later', () => { if (!busy) close(); });
            dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
            document.body.appendChild(dialog);
            dialog.showModal();
        } finally {
            if (!dialog?.isConnected) this.conflictDialogOpen = false;
        }
    },

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
        this.pendingPageRefresh = false;
        this.pendingDownloadOrigin = null;
        this.hasUnsavedChanges = false;
        this.sessionId = crypto.randomUUID();
        localStorage.setItem(this.STORAGE_KEY_SESSION, this.sessionId);
        this.notify('unconfigured');
        return true;
    }
};

SyncEngine.initializeSession();

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

// No polling loop. Events only restore an existing change-triggered deadline
// or finish a download/reload deferred by an unfinished form.
window.addEventListener('load', () => {
    if (window.location.pathname.split('/').pop().toLowerCase() === 'login.html') return;
    SyncEngine.armAutoSync();
    SyncEngine.maybeRefreshPage();
    if (typeof MutationObserver !== 'undefined' && document.body) {
        const observer = new MutationObserver(() => SyncEngine.maybeRefreshPage());
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'open'] });
    }
});
const resumePendingWork = () => {
    SyncEngine.armAutoSync();
    SyncEngine.maybeRefreshPage();
};
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumePendingWork();
});
window.addEventListener('focus', resumePendingWork);
window.addEventListener('online', resumePendingWork);
window.addEventListener('taskitator-refresh-safe', () => SyncEngine.maybeRefreshPage());
document.addEventListener('focusout', () => setTimeout(() => SyncEngine.maybeRefreshPage(), 0));
document.addEventListener('click', () => setTimeout(() => SyncEngine.maybeRefreshPage(), 0));
window.addEventListener('storage', event => {
    if (event.key === SyncEngine.STORAGE_KEY_SESSION && event.newValue !== SyncEngine.sessionId) {
        if (SyncEngine.debounceTimer) clearTimeout(SyncEngine.debounceTimer);
        window.location.reload();
    } else if (event.key === SyncEngine.STORAGE_KEY_AUTO_DEADLINE) {
        SyncEngine.armAutoSync();
    } else if (event.key === SyncEngine.STORAGE_KEY_DIRTY) {
        SyncEngine.hasUnsavedChanges = event.newValue === 'true';
    }
});

// sync-engine.js
/**
 * Taskitator Unified Cloud Sync Engine
 * Automated debounced push/pull bridge for Cloudflare Worker KV
 */

const SyncEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_TASKS: 'taskitator_tasks',
    STORAGE_KEY_LAST_LOGIN: 'taskitator_last_login',
    HARDCODED_WORKER_URL: 'https://gemini-todoist-verifier.spacexmzez.workers.dev',

    debounceTimer: null,
    hasUnsavedChanges: false,
    listeners: [],

    onStatusChange(fn) {
        this.listeners.push(fn);
    },

    notify(status, detail = null) {
        this.listeners.forEach(fn => fn(status, detail));
        // Dispatch window event so index.html sync dot turns green
        if (status === 'synced') {
            window.dispatchEvent(new CustomEvent('taskitator-synced', { detail }));
        }
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
            secret: (settings.worker_passkey || '').trim(),
            last_synced: settings.last_synced || null
        };
    },

    isConfigured() {
        const config = this.getConfig();
        return Boolean(config.secret);
    },

    getPayload(force = false, extraData = {}) {
        let tasks = [];
        let settings = {};
        try {
            tasks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_TASKS) || '[]');
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        } catch (e) {
            tasks = [];
            settings = {};
        }

        const lastLogin = localStorage.getItem(this.STORAGE_KEY_LAST_LOGIN) || null;

        return {
            app: 'Taskitator',
            updated_at: new Date().toISOString(),
            force: force,
            tasks: tasks,
            settings: settings,
            last_login: lastLogin,
            ...extraData
        };
    },

    async push(force = false, extraData = {}) {
        const config = this.getConfig();
        if (!config.secret) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        this.notify('syncing');
        const payload = this.getPayload(force, extraData);

        try {
            const res = await fetch(config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.secret}`
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
        this.hasUnsavedChanges = true;
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

    async pull(onUpdateCallback = null) {
        const config = this.getConfig();
        if (!config.secret) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        this.notify('syncing');

        try {
            const res = await fetch(config.url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.secret}`
                }
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }

            const data = await res.json();

            if (data.empty) {
                this.notify('synced', { empty: true });
                return { success: true, empty: true };
            }

            if (!Array.isArray(data.tasks)) {
                throw new Error('Malformed snapshot: tasks array missing.');
            }

            const localTasksRaw = localStorage.getItem(this.STORAGE_KEY_TASKS);
            const remoteTasksRaw = JSON.stringify(data.tasks);

            localStorage.setItem(this.STORAGE_KEY_TASKS, remoteTasksRaw);
            
            if (data.settings) {
                data.settings.last_synced = new Date().toISOString();
                localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(data.settings));
            }

            if (data.last_login) {
                localStorage.setItem(this.STORAGE_KEY_LAST_LOGIN, data.last_login);
            }

            this.notify('synced', { timestamp: new Date().toISOString() });

            if (onUpdateCallback && localTasksRaw !== remoteTasksRaw) {
                onUpdateCallback();
            }

            return { success: true, data };
        } catch (err) {
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    }
};

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

window.SyncEngine = SyncEngine;

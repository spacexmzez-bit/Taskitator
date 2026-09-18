// sync-engine.js
/**
 * Taskitator Unified Cloud Sync Engine
 * Automated debounced push/pull bridge for Cloudflare Worker KV
 * Supports Zero-Knowledge Client-Side Hashing & Mandatory Authentication Gate
 */

const SyncEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_TASKS: 'taskitator_tasks',
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
     * Derives an irreversible 64-character SHA-256 authentication token client-side.
     * Prevents raw password exposure across the network or in Cloudflare KV.
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
            secret: (settings.worker_passkey || '').trim(), // Stores derived SHA-256 bearer token
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
        let settings = {};
        try {
            tasks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_TASKS) || '[]');
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        } catch (e) {
            tasks = [];
            settings = {};
        }

        // Automatically fetch current daily breaks snapshot if engine is loaded
        const todayBreaks = window.TaskitatorEngine && TaskitatorEngine.BreakEngine
            ? TaskitatorEngine.BreakEngine.getTodayBreaks()
            : [];

        const lastLogin = localStorage.getItem(this.STORAGE_KEY_LAST_LOGIN) || null;
        const nowIso = new Date().toISOString();

        return {
            app: 'Taskitator',
            username: settings.worker_username || null,
            updated_at: nowIso,
            force: force,
            tasks: tasks,
            settings: settings,
            today_breaks: todayBreaks,
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

        try {
            const res = await fetch(config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.secret}`,
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

        try {
            const res = await fetch(config.url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.secret}`,
                    'X-Taskitator-User': config.username
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

            const localLastMod = localStorage.getItem(this.STORAGE_KEY_LAST_MODIFIED);
            if (localLastMod && data.updated_at) {
                const localTime = new Date(localLastMod).getTime();
                const remoteTime = new Date(data.updated_at).getTime();
                if (localTime > remoteTime) {
                    await this.push(true);
                    return { success: true, localWasFresher: true };
                }
            }

            const localTasksRaw = localStorage.getItem(this.STORAGE_KEY_TASKS);
            const remoteTasksRaw = JSON.stringify(data.tasks);

            localStorage.setItem(this.STORAGE_KEY_TASKS, remoteTasksRaw);
            
            if (data.settings) {
                data.settings.last_synced = new Date().toISOString();
                // Retain active auth passkey when overwriting settings from remote
                if (config.secret && !data.settings.worker_passkey) {
                    data.settings.worker_passkey = config.secret;
                }
                if (config.username && !data.settings.worker_username) {
                    data.settings.worker_username = config.username;
                }
                localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(data.settings));
            }

            if (data.today_breaks && Array.isArray(data.today_breaks)) {
                const todayStr = new Date().toISOString().split('T')[0];
                let breaksMap = {};
                try {
                    breaksMap = JSON.parse(localStorage.getItem('taskitator_daily_breaks') || '{}');
                } catch (e) {
                    breaksMap = {};
                }
                breaksMap[todayStr] = data.today_breaks;
                localStorage.setItem('taskitator_daily_breaks', JSON.stringify(breaksMap));
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
    },

    /**
     * Wipes active session credentials and returns the client to an unauthenticated state.
     */
    logout() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.hasUnsavedChanges = false;

        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        } catch (e) {
            settings = {};
        }

        delete settings.worker_username;
        delete settings.worker_passkey;
        delete settings.last_synced;

        localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
        localStorage.removeItem(this.STORAGE_KEY_LAST_LOGIN);

        this.notify('unconfigured');
        return true;
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

// Centralized Authentication Gatekeeper
(function enforceAuthenticationGuard() {
    const isLoginPage = window.location.pathname.endsWith('login.html');
    const isConfigured = SyncEngine.isConfigured();

    if (!isConfigured && !isLoginPage) {
        window.location.replace('login.html');
    } else if (isConfigured && isLoginPage) {
        window.location.replace('index.html');
    }
})();

window.SyncEngine = SyncEngine;

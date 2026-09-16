// sync-engine.js
const SyncEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_TASKS: 'taskitator_tasks',
    STORAGE_KEY_LAST_LOGIN: 'taskitator_last_login',

    debounceTimer: null,
    hasUnsavedChanges: false,
    listeners: [],

    onStatusChange(fn) {
        this.listeners.push(fn);
    },

    notify(status, detail = null) {
        this.listeners.forEach(fn => fn(status, detail));
    },

    getConfig() {
        const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS)) || {};
        return settings.sync || { url: '', secret: '', last_synced: null };
    },

    saveConfig(url, secret) {
        const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS)) || {};
        settings.sync = settings.sync || {};
        settings.sync.url = url.trim();
        settings.sync.secret = secret.trim();
        localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    },

    isConfigured() {
        const config = this.getConfig();
        return Boolean(config.url && config.secret);
    },

    getPayload(force = false) {
        const tasks = JSON.parse(localStorage.getItem(this.STORAGE_KEY_TASKS)) || [];
        const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS)) || {};
        const lastLogin = localStorage.getItem(this.STORAGE_KEY_LAST_LOGIN) || null;

        return {
            app: 'Taskitator',
            updated_at: new Date().toISOString(),
            force: force,
            tasks: tasks,
            settings: settings,
            last_login: lastLogin
        };
    },

    async push(force = false) {
        const config = this.getConfig();
        if (!config.url || !config.secret) {
            this.notify('unconfigured');
            return { success: false, reason: 'unconfigured' };
        }

        this.notify('syncing');
        const payload = this.getPayload(force);

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

            const data = await res.json();
            
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS)) || {};
            settings.sync = settings.sync || {};
            settings.sync.last_synced = new Date().toISOString();
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));

            this.hasUnsavedChanges = false;
            this.notify('synced', { timestamp: settings.sync.last_synced });
            return { success: true, data };
        } catch (err) {
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    scheduleAutoPush(delayMs = 10000) {
        if (!this.isConfigured()) return;
        this.hasUnsavedChanges = true;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            if (this.hasUnsavedChanges) {
                this.push(false);
            }
        }, delayMs);
    },

    flushIfDirty() {
        if (this.hasUnsavedChanges && this.isConfigured()) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.push(false);
        }
    },

    async pull(onUpdateCallback = null) {
        const config = this.getConfig();
        if (!config.url || !config.secret) {
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
                data.settings.sync = {
                    ...config,
                    last_synced: new Date().toISOString()
                };
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

// Automatically flush pending changes to cloud when user minimizes the PWA or switches tabs
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

(function () {
    'use strict';
    const config = window.TASKITATOR_AUTH_CONFIG || {};
    const credentialFields = ['worker_passkey', 'session_token', 'phone_token', 'macro_token', 'auth_user_id'];
    const storageWarnings = [];
    const recoveryPrefix = 'taskitator_account_recovery_v1:';
    function readSnapshot(raw) {
        const snapshot = JSON.parse(raw);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid saved copy');
        return cleanSnapshot(snapshot, true);
    }
    function recoveryCopies(username) {
        const raw = localStorage.getItem(recoveryPrefix + encodeURIComponent(username));
        if (!raw) return [];
        const copies = JSON.parse(raw);
        if (!Array.isArray(copies)) throw new Error('Invalid recovery copies');
        return copies.map(copy => cleanSnapshot(copy, true));
    }
    function preserveCopy(username, snapshot) {
        const key = recoveryPrefix + encodeURIComponent(username);
        const copies = recoveryCopies(username);
        const clean = cleanSnapshot(snapshot, true);
        if (!copies.some(copy => JSON.stringify(copy) === JSON.stringify(clean))) copies.push(clean);
        localStorage.setItem(key, JSON.stringify(copies));
    }
    function snapshotTime(snapshot) {
        const time = Date.parse(snapshot.taskitator_tasks_last_modified || '');
        return Number.isFinite(time) ? time : 0;
    }
    function cleanSettings(settings, exportSecrets = false, preserveLegacyAI = false) {
        const result = { ...(settings || {}) };
        credentialFields.forEach(key => delete result[key]);
        if (!preserveLegacyAI) {
            delete result.gemini_api_key;
            delete result.claude_api_key;
        }
        if (exportSecrets) {
            delete result.worker_username;
        }
        return result;
    }
    function cleanSnapshot(snapshot, preserveLegacyAI = false) {
        const result = { ...snapshot };
        if (result.taskitator_settings) {
            result.taskitator_settings = JSON.stringify(cleanSettings(JSON.parse(result.taskitator_settings),false,preserveLegacyAI));
        }
        delete result.taskitator_pending_rotation;
        return result;
    }
    function cleanLegacyStorage() {
        storageWarnings.length = 0;
        const settings = JSON.parse(localStorage.getItem('taskitator_settings') || '{}');
        if (settings.worker_passkey && settings.worker_username) {
            localStorage.setItem('taskitator_legacy_local_owner', settings.worker_username);
        }
        // Preserve drafts, but remove the reusable credential from keys and values.
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('taskitator_account_cache:')) continue;
            const tail = key.slice('taskitator_account_cache:'.length);
            const username = tail.slice(0, tail.lastIndexOf(':'));
            try {
                const snapshot = readSnapshot(localStorage.getItem(key) || '{}');
                const safeKey = 'taskitator_account_cache_v2:' + encodeURIComponent(username);
                const existing = localStorage.getItem(safeKey);
                if (!existing) {
                    localStorage.setItem(safeKey, JSON.stringify(snapshot));
                } else {
                    const previous = readSnapshot(existing);
                    if (JSON.stringify(previous) !== JSON.stringify(snapshot)) {
                        // Save BOTH copies before any overwrite/removal. Never merge
                        // task arrays blindly: deletions and revisions can differ.
                        preserveCopy(username, previous);
                        preserveCopy(username, snapshot);
                        if (snapshotTime(snapshot) > snapshotTime(previous)) {
                            localStorage.setItem(safeKey, JSON.stringify(snapshot));
                        } else {
                            localStorage.setItem(safeKey, JSON.stringify(previous));
                        }
                    }
                }
                localStorage.removeItem(key);
            } catch (err) {
                // An unreadable or unwritable archive is never restored or deleted.
                // It must not prevent unrelated accounts from signing in.
                storageWarnings.push('Some old saved copies could not be prepared. They remain on this device; see SECURITY-SETUP.txt before clearing browser data.');
            }
        }
        const backup = localStorage.getItem('taskitator_unclaimed_backup');
        if (backup) {
            try { localStorage.setItem('taskitator_unclaimed_backup', JSON.stringify(readSnapshot(backup))); }
            catch (err) { storageWarnings.push('An old unclaimed backup is unreadable. It has been retained, not restored.'); }
        }
        // Vault migration runs after account ownership is known. Until encryption
        // succeeds, retain old AI values rather than silently discard a user's key.
        localStorage.setItem('taskitator_settings', JSON.stringify(cleanSettings(settings,false,true)));
        localStorage.removeItem('taskitator_pending_rotation');
    }
    async function loadScript(src, attributes = {}) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src; script.async = true; script.crossOrigin = 'anonymous';
            Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
            script.onload = resolve;
            script.onerror = () => reject(new Error('Could not load secure sign-in. Check your connection and authentication settings.'));
            document.head.append(script);
        });
    }
    const auth = {
        account: null,
        cleanSettings,
        cleanLegacyStorage,
        storageWarnings,
        recoveryCopies,
        get userId() { return window.Clerk?.user?.id || null; },
        get signedIn() { return Boolean(window.Clerk?.session && this.account); },
        async token(fresh = false) {
            if (!window.Clerk?.session) throw new Error('Your session ended. Sign in again.');
            const token = await window.Clerk.session.getToken({skipCache:fresh});
            if (!token) throw new Error('Your session ended. Sign in again.');
            return token;
        },
        async api(path, options = {}) {
            const { freshToken = false, timeoutMs = 30000, ...requestOptions } = options;
            const headers = new Headers(options.headers);
            headers.set('Authorization', 'Bearer ' + await this.token(freshToken));
            if (options.body) headers.set('Content-Type', 'application/json');
            const res = await fetch(config.workerUrl.replace(/\/$/, '') + path,
                { ...requestOptions, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
            const data = await res.json();
            if (!res.ok) { const error = new Error(data.error || 'Account request failed.'); error.status = res.status; throw error; }
            return data;
        },
        async connect(body) {
            const data = await this.api('/auth/account', { method: 'POST', body: JSON.stringify(body) });
            this.account = data.account;
            await window.TaskitatorVault?.initialize();
            return data.account;
        },
        async signOut() {
            // Await provider revocation before treating the browser as signed out.
            await window.Clerk.signOut();
            this.account = null;
        },
        async manageAccount() { window.Clerk.openUserProfile(); },
        async init() {
            cleanLegacyStorage();
            if (!/^pk_(test|live)_[A-Za-z0-9+/=]+$/.test(config.publishableKey || '')) {
                throw new Error('Secure sign-in needs one-time setup. Follow SECURITY-SETUP.txt and fill in auth-config.js.');
            }
            const domain = atob(config.publishableKey.split('_')[2]).replace(/\$$/, '');
            if (!/^[a-zA-Z0-9.-]+$/.test(domain) || !domain.includes('.')) throw new Error('The Clerk publishable key is invalid.');
            await loadScript('https://' + domain + '/npm/@clerk/ui@1/dist/ui.browser.js');
            await loadScript('https://' + domain + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js',
                { 'data-clerk-publishable-key': config.publishableKey });
            await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, telemetry: false,
                signInUrl: location.origin + '/login.html', signUpUrl: location.origin + '/login.html',
                signInForceRedirectUrl: location.origin + '/login.html',
                signUpForceRedirectUrl: location.origin + '/login.html' });
            if (window.Clerk.session) {
                const data = await this.api('/auth/me');
                this.account = data.account;
                this.deletion = data.deletion || null;
                if (this.account && !this.deletion) await window.TaskitatorVault?.initialize();
            }
        }
    };
    window.TaskitatorAuth = auth;
})();

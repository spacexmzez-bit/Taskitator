// ============================================================================
// Taskitator Consolidated Core Engine (core.js)
// Combines: auth-config, auth-client, sync-engine, deletion-client,
// deletion-status, login-page, and auth-bootstrap.
// ============================================================================

// <<< MODULE_START: auth-config.js >>>
// PUBLIC configuration only. Never put a Clerk secret key in this file.
window.TASKITATOR_AUTH_CONFIG = Object.freeze({
    publishableKey: 'pk_live_Y2xlcmsubWF6ZW5kZXYuY29tJA',
    workerUrl: 'https://taskitator-sync.spacexmzez.workers.dev',
    // Public ES256 (P-256) JWK that verifies the Worker-signed offline Pro entitlement.
    // Generate the pair with tools/offline-pro-keygen.mjs. While this is null, offline Pro stays off.
    offlineProPublicKey: null
});

// <<< MODULE_END: auth-config.js >>>
// <<< MODULE_START: offline.js >>>
// Offline access. A previously signed-in device keeps using its cached workspace;
// this module tracks whether the Taskitator backend is reachable, enforces a fresh
// sign-in after seven days without a server-confirmed response, gates features that
// need a connection, and verifies the Worker-signed offline Pro entitlement.
// Nothing here grants server-side access: the Worker still checks every request.
(function () {
    'use strict';
    const KEY = {
        identity: 'taskitator_offline_identity_v1',
        online: 'taskitator_last_online_at',
        clock: 'taskitator_clock_high_water',
        pro: 'taskitator_offline_pro_token_v1'
    };
    const NOTICE = 'taskitator_reauth_notice', REAUTH_SESSION = 'taskitator_reauth_session';
    const REAUTH_MS = 7 * 86400000, PROBE_TIMEOUT_MS = 6000, MIN_DELAY_MS = 10000, MAX_DELAY_MS = 60000;
    // Connection-dependent controls. Clicks on these are stopped while offline.
    const GATED = ['#openCopilotNavBtn', '#openCopilotFabBtn', '#startCopilotBtn', '#copilotForm',
        '[data-switch-view="universe"]', 'a[href*="view=universe"]', '#vaultSaveBtn', '#vaultUseProviderBtn',
        '#vaultTestBtn', '#vaultShowBtn', '#vaultCopyBtn', '#vaultRefreshBtn', '#vaultDeleteBtn',
        '#pro-activate-btn', '#generatePhoneTokenBtn', '#revokePhoneTokenBtn',
        '[data-requires-online]'].join(',');
    let active = false, bootOffline = false, timer = null, delay = MIN_DELAY_MS, probing = null, recovering = false;

    class OfflineError extends Error {
        constructor(message) {
            super(message || 'You are offline. This needs an internet connection.');
            this.name = 'OfflineError'; this.offline = true;
        }
    }
    const workerUrl = () => String(window.TASKITATOR_AUTH_CONFIG?.workerUrl || '').replace(/\/+$/, '');
    const readJson = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
    const number = key => { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 ? n : 0; };

    // A failed request never proves the whole device is offline: the Worker, Clerk or
    // another service can fail alone. Only HTTP-less failures count as network-class.
    function isNetworkError(error) {
        if (!error || error.status) return false;
        if (error.offline || error.network || error.code === 'network_error') return true;
        if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
        return error.name === 'TypeError' && /fetch|network|load failed/i.test(String(error.message || ''));
    }
    // Reachability of the Taskitator Worker. Any HTTP answer, even 401, proves it is up.
    function probe() {
        if (probing) return probing;
        probing = (async () => {
            try {
                await fetch(workerUrl() + '/status', { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
                return true;
            } catch { return false; }
        })().finally(() => { probing = null; });
        return probing;
    }
    async function confirmFailure() {
        if (active) return true;
        if (await probe()) return false;
        setActive(true);
        return true;
    }
    async function translate(error) {
        if (!error || error.status || error.offline) return error;
        const network = isNetworkError(error) || /session ended/i.test(String(error.message || ''));
        if (network && await confirmFailure()) return new OfflineError();
        return error;
    }
    function assertOnline() { if (active) throw new OfflineError(); }

    function identity() {
        const record = readJson(KEY.identity);
        return record && record.account && typeof record.account.user === 'string' ? record : null;
    }
    function noteConfirmed(serverNow) {
        try {
            localStorage.setItem(KEY.online, String(Date.now()));
            if (Number.isFinite(serverNow) && serverNow > 0) localStorage.setItem(KEY.clock, String(serverNow));
            sessionStorage.removeItem(REAUTH_SESSION); sessionStorage.removeItem(NOTICE);
        } catch {}
    }
    function recordConfirmed(account, clerkUser) {
        if (account && typeof account.user === 'string') {
            writeJson(KEY.identity, { account, clerk_user: clerkUser || window.Clerk?.user?.id || null, confirmed_at: Date.now() });
        }
        noteConfirmed();
    }
    function forget() {
        try { [KEY.identity, KEY.online, KEY.pro].forEach(key => localStorage.removeItem(key)); } catch {}
    }
    function touchClock() {
        try { const now = Date.now(); if (now > number(KEY.clock)) localStorage.setItem(KEY.clock, String(now)); } catch {}
    }
    // The latest time this device has seen. A rolled-back clock cannot move it backwards.
    const trustedNow = () => Math.max(Date.now(), number(KEY.clock));

    function freshSession(lastOnline) {
        const session = window.Clerk?.session;
        if (!session) return false;
        let previous = null;
        try { previous = sessionStorage.getItem(REAUTH_SESSION); } catch {}
        if (previous) return session.id !== previous;
        const created = session.createdAt instanceof Date ? session.createdAt.getTime() : Date.parse(session.createdAt || '');
        return Number.isFinite(created) && created > lastOnline;
    }
    // More than seven days (in either direction) since the last server-confirmed
    // response requires a sign-in that happened after that gap.
    function reauthRequired() {
        const last = number(KEY.online);
        if (!last || Math.abs(trustedNow() - last) <= REAUTH_MS) return false;
        return !freshSession(last);
    }
    function markReauthStarted() {
        try {
            sessionStorage.setItem(NOTICE, '1');
            if (window.Clerk?.session?.id) sessionStorage.setItem(REAUTH_SESSION, window.Clerk.session.id);
        } catch {}
    }
    // Open the cached account only for a network-class failure, never after an HTTP
    // answer (401, deletion), a deliberate logout, or when the data belongs to someone else.
    async function canOpenOffline(error) {
        if (error?.status) return false;
        try { if (sessionStorage.getItem('taskitator_logout_pending') === '1') return false; } catch {}
        const known = identity();
        if (!known || localStorage.getItem('taskitator_local_owner') !== known.account.user) return false;
        return isNetworkError(error) || !(await probe());
    }
    function enterBootOffline() {
        const known = identity();
        bootOffline = true;
        if (window.TaskitatorAuth) { window.TaskitatorAuth.account = known.account; window.TaskitatorAuth.deletion = null; }
        setActive(true);
    }
    function leaveBootOffline() { bootOffline = false; setActive(false); }
    const cachedUserId = () => (bootOffline ? identity()?.clerk_user || null : null);

    // ----- Worker-signed offline Pro entitlement (ES256 compact JWS, type TKOP) -----
    const bytes = text => {
        const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
        return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    };
    async function verifyToken(token, jwk) {
        try {
            const [head, body, signature] = String(token).split('.');
            if (!head || !body || !signature) return null;
            const header = JSON.parse(new TextDecoder().decode(bytes(head)));
            if (header.alg !== 'ES256' || header.typ !== 'TKOP') return null;
            const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(signature),
                new TextEncoder().encode(head + '.' + body));
            if (!valid) return null;
            const claims = JSON.parse(new TextDecoder().decode(bytes(body)));
            return claims && claims.v === 1 && typeof claims.sub === 'string' && Number.isFinite(claims.valid_until) ? claims : null;
        } catch { return null; }
    }
    function saveProToken(token, serverNow) {
        try {
            if (typeof token === 'string' && token) localStorage.setItem(KEY.pro, token); else localStorage.removeItem(KEY.pro);
            if (Number.isFinite(serverNow) && serverNow > 0) localStorage.setItem(KEY.clock, String(serverNow));
        } catch {}
    }
    // Same shape the Worker returns, so existing Pro checks work unchanged. Fails closed.
    async function proStatus() {
        const none = status => ({ isPro: false, tier: 'free', plan: 'free', status, offline: true, expires_at: null, credits: null });
        const jwk = window.TASKITATOR_AUTH_CONFIG?.offlineProPublicKey;
        const token = localStorage.getItem(KEY.pro);
        if (!jwk || !token) return none('free');
        const claims = await verifyToken(token, jwk);
        const known = identity();
        if (!claims || !known || !known.clerk_user || claims.sub !== known.clerk_user) return none('invalid');
        if (trustedNow() >= claims.valid_until) return none('expired');
        return { isPro: true, tier: 'pro', plan: 'pro', status: 'active', offline: true,
            expires_at: Number.isFinite(claims.exp) ? claims.exp : null, valid_until: claims.valid_until, credits: null };
    }

    // ----- Connectivity state, banner and interface gating -----
    let bannerDismissed = false, bannerTimer = 0;
    const BANNER_SHOW_MS = 6000;
    function renderBanner() {
        let bar = document.getElementById('offlineBanner');
        if (!active || bannerDismissed) { bar?.remove(); return; }
        if (!bar) {
            bar = document.createElement('div'); bar.id = 'offlineBanner'; bar.setAttribute('role', 'status');
            const text = document.createElement('span'); text.textContent = 'Offline. Changes sync when you reconnect.';
            const close = document.createElement('button');
            close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss offline notice');
            close.addEventListener('click', () => { bannerDismissed = true; clearTimeout(bannerTimer); bar.remove(); });
            bar.append(text, close);
            document.body?.append(bar);
            // A notice, not a permanent bar: the grey sync dot stays as the lasting indicator.
            clearTimeout(bannerTimer);
            bannerTimer = setTimeout(() => { bannerDismissed = true; bar.remove(); }, BANNER_SHOW_MS);
        }
    }
    function applyUI() {
        document.querySelectorAll?.(GATED).forEach(node => {
            node.toggleAttribute('data-requires-online', active);
            if (active) node.setAttribute('aria-disabled', 'true'); else node.removeAttribute('aria-disabled');
        });
    }
    function setActive(next) {
        if (next === active) return;
        active = next;
        if (active) bannerDismissed = false;
        document.documentElement.classList.toggle('is-offline', active);
        renderBanner(); applyUI();
        window.dispatchEvent(new CustomEvent('taskitator-connectivity', { detail: { offline: active } }));
        if (active) schedule(); else { clearTimeout(timer); delay = MIN_DELAY_MS; }
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (!active) return;
            if (await probe()) await recover();
            if (active) { delay = Math.min(delay * 2, MAX_DELAY_MS); schedule(); }
        }, delay);
    }
    async function recover() {
        if (recovering) return;
        recovering = true;
        try { await window.TaskitatorAuth?.reconnect(); }
        catch (error) { if (!isNetworkError(error)) console.warn('[Offline] Reconnect failed:', error?.message || error); }
        finally { recovering = false; }
    }
    function notifyBlocked(event) {
        if (!active) return;
        const target = event.target?.closest?.(GATED);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        window.TaskitatorNotify?.('This needs an internet connection and is turned off while you are offline.');
    }
    document.addEventListener('click', notifyBlocked, true);
    document.addEventListener('submit', notifyBlocked, true);
    window.addEventListener('offline', () => { void confirmFailure(); });
    window.addEventListener('online', () => { if (active) { delay = 1000; schedule(); } });
    document.addEventListener('visibilitychange', () => {
        touchClock();
        if (!document.hidden && active) { delay = 1000; schedule(); }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyUI);
    setInterval(touchClock, 60000);
    touchClock();

    window.TaskitatorOffline = Object.freeze({
        OfflineError, isNetworkError, probe, confirmFailure, translate, assertOnline,
        get active() { return active; }, get bootOffline() { return bootOffline; },
        identity, recordConfirmed, noteConfirmed, forget, reauthRequired, markReauthStarted,
        canOpenOffline, enterBootOffline, leaveBootOffline, cachedUserId, setActive, applyUI,
        proStatus, saveProToken, trustedNow, lastOnline: () => number(KEY.online)
    });
})();

// <<< MODULE_END: offline.js >>>
// <<< MODULE_START: auth-client.js >>>
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
            script.onerror = () => {
                const error = new Error('Could not load secure sign-in. Check your connection and authentication settings.');
                error.network = true;
                reject(error);
            };
            document.head.append(script);
        });
    }
    const auth = {
        account: null,
        cleanSettings,
        cleanLegacyStorage,
        storageWarnings,
        recoveryCopies,
        get userId() { return window.Clerk?.user?.id || window.TaskitatorOffline?.cachedUserId() || null; },
        // Offline, the cached account stands in for the live Clerk session. Every network
        // call is refused by api(), so this only unlocks local features.
        get signedIn() { return Boolean((window.Clerk?.session || window.TaskitatorOffline?.bootOffline) && this.account); },
        async token(fresh = false) {
            if (!window.Clerk?.session) throw new Error('Your session ended. Sign in again.');
            const token = await window.Clerk.session.getToken({skipCache:fresh});
            if (!token) throw new Error('Your session ended. Sign in again.');
            return token;
        },
        async api(path, options = {}) {
            const { freshToken = false, timeoutMs = 30000, reconnect = false, ...requestOptions } = options;
            const offline = window.TaskitatorOffline;
            if (!reconnect) offline?.assertOnline();
            const headers = new Headers(options.headers);
            let res, data;
            try {
                headers.set('Authorization', 'Bearer ' + await this.token(freshToken));
                if (options.body) headers.set('Content-Type', 'application/json');
                res = await fetch(config.workerUrl.replace(/\/$/, '') + path,
                    { ...requestOptions, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
                data = await res.json();
            } catch (error) { throw (await offline?.translate(error)) ?? error; }
            if (res.ok) offline?.noteConfirmed();
            if (!res.ok) {
                const message=res.status===404 && path.startsWith('/ai/') && /Endpoint not found/i.test(data.error||'')?
                    'The website is newer than its Worker. In GitHub Actions, run Deploy Taskitator security Worker on the branch you uploaded, wait for success, then reload. Your local data has been retained.':data.error || 'Account request failed.';
                const error = new Error(message); error.status = res.status; throw error;
            }
            return data;
        },
        async connect(body) {
            const data = await this.api('/auth/account', { method: 'POST', body: JSON.stringify(body) });
            this.account = data.account;
            await window.TaskitatorVault?.initialize();
            return data.account;
        },
        async signOut() {
            // Keep an intent marker across the redirect. If Clerk's session-change
            // listener navigates before the caller does, the login bootstrap can
            // finish logout instead of auto-entering the still-cached account.
            const marker = 'taskitator_logout_pending';
            sessionStorage.setItem(marker, '1');
            try {
                await window.Clerk.signOut();
            } catch (error) {
                // Some SDK failures can arrive after the provider has already
                // cleared the session. Treat that as a completed logout.
                if (window.Clerk?.session) {
                    sessionStorage.removeItem(marker);
                    throw error;
                }
            }
            if (window.Clerk?.session) {
                sessionStorage.removeItem(marker);
                throw new Error('Taskitator could not confirm that your sign-in session ended. Please try Log Out again.');
            }
            this.account = null;
            // A deliberate logout must never reopen offline from the cached account.
            window.TaskitatorOffline?.forget();
        },
        async manageAccount() { window.Clerk.openUserProfile(); },
        async loadClerk() {
            if (window.Clerk?.loaded) return;
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
        },
        // Seven days without a server-confirmed response: end the Clerk session (keeping
        // every local edit) so the user signs in again before anything syncs.
        async forceReauth() {
            window.TaskitatorReauthInProgress = true;
            window.TaskitatorOffline?.markReauthStarted();
            try { await window.Clerk.signOut(); }
            catch (error) { if (window.Clerk?.session) { window.TaskitatorReauthInProgress = false; throw error; } }
            this.account = null;
        },
        // Called when the backend becomes reachable again after an offline period.
        async reconnect() {
            const offline = window.TaskitatorOffline;
            await this.loadClerk();
            if (!window.Clerk.session) { location.replace('login.html'); return; }
            if (offline.reauthRequired()) { await this.forceReauth(); location.replace('login.html'); return; }
            const data = await this.api('/auth/me', { reconnect: true });
            if (data.deletion) {
                offline.forget();
                if (data.deletion.receipt) sessionStorage.setItem('taskitator_deletion_receipt', data.deletion.receipt);
                location.replace('settings.html?view=deletion-status'); return;
            }
            const known = offline.identity();
            if (!data.account || (known && known.account.user !== data.account.user)) { location.replace('login.html'); return; }
            this.account = data.account; this.deletion = null;
            offline.recordConfirmed(data.account, window.Clerk.user?.id);
            offline.leaveBootOffline();
            await window.TaskitatorVault?.initialize();
            window.TaskitatorWatchSession?.();
            window.dispatchEvent(new Event('taskitator-reconnected'));
            window.TaskitatorTier?.refresh?.();
            const engine = window.SyncEngine;
            if (engine?.isConfigured() && engine.isDirty()) { engine.armAutoSync(); void engine.syncNow({ origin: 'auto' }); }
        },
        async init() {
            cleanLegacyStorage();
            await this.loadClerk();

            // A logout may trigger the old page's session listener before its
            // explicit redirect completes. Never auto-enter an account while
            // that deliberate logout is being finalized.
            const logoutMarker = 'taskitator_logout_pending';
            if (sessionStorage.getItem(logoutMarker) === '1') {
                if (window.Clerk.session) {
                    try { await window.Clerk.signOut(); }
                    catch (error) {
                        if (window.Clerk.session) throw new Error('Taskitator could not finish signing out. Please retry Log Out.');
                    }
                }
                if (window.Clerk.session) throw new Error('Taskitator could not confirm that your sign-in session ended. Please retry Log Out.');
                sessionStorage.removeItem(logoutMarker);
                this.account = null;
                this.deletion = null;
                return;
            }
            if (window.Clerk.session) {
                if (window.TaskitatorOffline?.reauthRequired()) { await this.forceReauth(); return; }
                const data = await this.api('/auth/me');
                this.account = data.account;
                this.deletion = data.deletion || null;
                if (this.deletion) window.TaskitatorOffline?.forget();
                if (this.account && !this.deletion) {
                    window.TaskitatorOffline?.recordConfirmed(this.account, window.Clerk.user?.id);
                    await window.TaskitatorVault?.initialize();
                }
            }
        }
    };
    window.TaskitatorAuth = auth;
})();

// <<< MODULE_END: auth-client.js >>>
// <<< MODULE_START: merge.js >>>
// Field-level three-way merge for edits made on this device while the cloud also changed
// (typically after working offline). Compares base (last synced copy), local and remote:
// a change on one side wins, identical changes agree, and only a field changed differently
// on both sides, or a delete against an edit, is a conflict the user decides on this device.
// Conflicts are recomputed from the three copies on every sync; none are stored.
(function () {
    'use strict';
    const DB_NAME = 'taskitator-merge', STORE = 'base';
    const LIST_SCOPES = ['tasks', 'projects'];
    const WHOLE_SCOPES = ['recurrence_state', 'saved_criteria'];
    // Per-device bookkeeping that is never a real disagreement.
    const VOLATILE_SETTINGS = new Set(['last_synced', 'worker_username', 'worker_url', 'worker_passkey']);

    function canon(value) {
        if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
        if (value && typeof value === 'object') {
            return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
                .map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
        }
        return JSON.stringify(value === undefined ? null : value);
    }
    const same = (a, b) => canon(a) === canon(b);
    const isPrimitiveList = v => Array.isArray(v) && v.every(x => x === null || typeof x !== 'object');
    const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

    // Tags and other primitive lists merge as sets: additions from both sides are kept and a
    // removal on either side sticks, so they never conflict.
    function mergeSet(base, local, remote) {
        const b = new Set(base), l = new Set(local), r = new Set(remote);
        const out = [];
        for (const x of [...remote, ...local]) {
            if (out.includes(x)) continue;
            const removed = (b.has(x) && (!l.has(x) || !r.has(x)));
            if (!removed) out.push(x);
        }
        return out;
    }

    function mergeItem(scope, id, base, local, remote, add, choice) {
        const out = {};
        const keys = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
        for (const key of keys) {
            const b = base?.[key], l = local[key], r = remote[key];
            if (same(l, r)) { if (l !== undefined) out[key] = clone(l); continue; }
            if (base && same(l, b)) { if (r !== undefined) out[key] = clone(r); continue; }
            if (base && same(r, b)) { if (l !== undefined) out[key] = clone(l); continue; }
            if (isPrimitiveList(l) && isPrimitiveList(r) && (b === undefined || isPrimitiveList(b))) {
                out[key] = mergeSet(b || [], l, r); continue;
            }
            const cid = `${scope}:${id}:${key}`;
            add({ id: cid, kind: 'field', scope, itemId: id, field: key, mine: clone(l), theirs: clone(r),
                label: String(local.title ?? remote.title ?? base?.title ?? id) });
            const pick = choice(cid) === 'theirs' ? r : l;
            if (pick !== undefined) out[key] = clone(pick);
        }
        return out;
    }

    function mergeList(scope, base, local, remote, add, choice) {
        const byId = list => new Map((Array.isArray(list) ? list : []).filter(x => x && x.id !== undefined).map(x => [x.id, x]));
        const B = byId(base), L = byId(local), R = byId(remote);
        const result = new Map();
        const ids = [...R.keys(), ...[...L.keys()].filter(id => !R.has(id))];
        for (const id of [...new Set([...ids, ...B.keys()])]) {
            const b = B.get(id), l = L.get(id), r = R.get(id);
            if (!l && !r) continue; // gone on both sides
            if (l && r) { result.set(id, mergeItem(scope, id, b, l, r, add, choice)); continue; }
            const survivor = l || r, deletedHere = !l;
            if (!b) { result.set(id, clone(survivor)); continue; } // added on one side only
            if (same(survivor, b)) continue; // deleted on one side, untouched on the other
            const cid = `${scope}:${id}:deleted`;
            add({ id: cid, kind: 'delete', scope, itemId: id, field: null, deletedOn: deletedHere ? 'device' : 'cloud',
                mine: deletedHere ? undefined : clone(l), theirs: deletedHere ? clone(r) : undefined,
                label: String(survivor.title ?? b.title ?? id) });
            // "mine" = this device's version of the item (deleted, or edited); "theirs" = the cloud's.
            const theirs = choice(cid) === 'theirs';
            const keep = deletedHere ? theirs : !theirs;
            if (keep) result.set(id, clone(survivor));
        }
        // A subtask whose parent disappeared must not be left dangling.
        if (scope === 'tasks') {
            for (const [id, task] of [...result]) {
                if (task.parent_id && !result.has(task.parent_id)) {
                    const cid = `tasks:${id}:orphan`;
                    add({ id: cid, kind: 'orphan', scope, itemId: id, field: 'parent_id', mine: 'Keep as a main task', theirs: 'Remove it',
                        label: String(task.title ?? id) });
                    if (choice(cid) === 'theirs') result.delete(id);
                    else result.set(id, { ...task, parent_id: null });
                }
            }
        }
        return [...result.values()];
    }

    function mergeWhole(scope, base, local, remote, add, choice) {
        if (same(local, remote)) return clone(local);
        if (same(local, base)) return clone(remote);
        if (same(remote, base)) return clone(local);
        const cid = `${scope}::whole`;
        add({ id: cid, kind: 'whole', scope, itemId: null, field: null, mine: clone(local), theirs: clone(remote), label: scope });
        return clone(choice(cid) === 'theirs' ? remote : local);
    }

    function mergeKeys(scope, base, local, remote, add, choice) {
        const out = {};
        const keys = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(remote || {})]);
        for (const key of keys) {
            if (VOLATILE_SETTINGS.has(key)) continue;
            const b = base?.[key], l = local?.[key], r = remote?.[key];
            let v;
            if (same(l, r) || same(r, b)) v = l;
            else if (same(l, b)) v = r;
            else {
                const cid = `${scope}::${key}`;
                add({ id: cid, kind: 'setting', scope, itemId: null, field: key, mine: clone(l), theirs: clone(r), label: key });
                v = choice(cid) === 'theirs' ? r : l;
            }
            if (v !== undefined) out[key] = clone(v);
        }
        return out;
    }

    // choices: { [conflictId]: 'mine' | 'theirs' }. Unchosen conflicts default to this device's value.
    function merge3(base, local, remote, choices = {}) {
        const conflicts = [];
        const add = c => conflicts.push(c);
        const choice = id => choices[id];
        const merged = {};
        for (const scope of LIST_SCOPES) merged[scope] = mergeList(scope, base[scope], local[scope], remote[scope], add, choice);
        merged.settings = mergeKeys('settings', base.settings, local.settings, remote.settings, add, choice);
        for (const scope of WHOLE_SCOPES) merged[scope] = mergeWhole(scope, base[scope], local[scope], remote[scope], add, choice);
        // The audit ledger only grows: keep every entry from both sides.
        const seen = new Set(), ledger = [];
        for (const entry of [...(remote.completed_audit_ledger || []), ...(local.completed_audit_ledger || [])]) {
            const k = canon(entry);
            if (!seen.has(k)) { seen.add(k); ledger.push(entry); }
        }
        merged.completed_audit_ledger = ledger;
        return { merged, conflicts, unresolved: conflicts.filter(c => !(c.id in choices)) };
    }

    // ---- Base snapshot (last copy known to match the cloud), kept in IndexedDB ----
    function openDb() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function withStore(mode, fn) {
        const db = await openDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(req?.result);
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
        } finally { db.close(); }
    }
    const SNAPSHOT_KEYS = ['tasks', 'projects', 'settings', 'recurrence_state', 'saved_criteria', 'completed_audit_ledger'];
    function snapshotOf(version, source) {
        const snap = { version };
        for (const key of SNAPSHOT_KEYS) snap[key] = clone(source[key]);
        return snap;
    }
    async function saveBase(user, version, source) {
        try { await withStore('readwrite', s => s.put(snapshotOf(version, source), user)); } catch { /* merge falls back to the copy chooser */ }
    }
    async function loadBase(user) {
        try { return (await withStore('readonly', s => s.get(user))) || null; } catch { return null; }
    }
    // Returns true when the account's base snapshot is gone (or IndexedDB is unavailable, so nothing was stored).
    async function clearBase(user) {
        if (typeof indexedDB === 'undefined') return true;
        try { await withStore('readwrite', s => s.delete(user)); return true; } catch { return false; }
    }
    // Full browser reset: drop the whole merge database.
    function clearAllBases() {
        return new Promise(resolve => {
            if (typeof indexedDB === 'undefined') return resolve(true);
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = () => resolve(true);
            req.onerror = req.onblocked = () => resolve(false);
        });
    }

    // ---- Conflict panel (runs on this device only) ----
    let panelOpen = false;
    const FIELD_NAMES = { title: 'Title', description: 'Description', due_date: 'Due date', priority_id: 'Priority', project_id: 'Project',
        status: 'Status', completed_at: 'Completed', parent_id: 'Parent', proof_criteria: 'Proof criteria' };
    function show(value) {
        if (value === undefined || value === null || value === '') return '(empty)';
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return text.length > 200 ? text.slice(0, 200) + '…' : text;
    }
    function describe(c) {
        if (c.kind === 'delete') return { title: c.label, line: c.deletedOn === 'device' ? 'Deleted on this device, edited in the cloud' : 'Edited on this device, deleted in the cloud',
            mine: c.deletedOn === 'device' ? 'Delete it' : 'Keep my edited version', theirs: c.deletedOn === 'device' ? 'Keep the cloud version' : 'Delete it' };
        if (c.kind === 'orphan') return { title: c.label, line: 'Its parent task was removed in the cloud', mine: c.mine, theirs: c.theirs };
        if (c.kind === 'whole') return { title: c.scope === 'recurrence_state' ? 'Repeating tasks' : 'Saved criteria', line: 'Changed on both sides', mine: show(c.mine), theirs: show(c.theirs) };
        return { title: c.label, line: (FIELD_NAMES[c.field] || c.field) + ' changed on both sides', mine: show(c.mine), theirs: show(c.theirs) };
    }
    // Resolves with a choices map, or null when the user decides later.
    function askUser(conflicts, times = {}) {
        if (panelOpen || typeof document === 'undefined' || !document.body) return Promise.resolve(null);
        panelOpen = true;
        return new Promise(resolve => {
            const choices = {};
            const dialog = document.createElement('dialog');
            dialog.id = 'taskitatorMergePanel';
            dialog.className = 'modal-overlay open';
            dialog.style.cssText = 'display:block;position:fixed;inset:0;margin:auto;width:min(94vw,560px);height:fit-content;max-height:90vh;overflow:auto;padding:20px;border:1px solid #777;border-radius:12px;background:#171b24;color:#fff;z-index:2147483647;';
            const el = (tag, text, css) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (css) n.style.cssText = css; return n; };
            dialog.append(el('h2', 'Choose what to keep', 'margin-top:0'),
                el('p', `${conflicts.length} item${conflicts.length === 1 ? ' was' : 's were'} changed differently on this device and in the cloud. Everything else merged automatically. Nothing is saved until you press Apply.`));
            const when = el('p', `This device last edited: ${times.local ? new Date(times.local).toLocaleString() : 'time unknown'} · Cloud saved: ${times.remote ? new Date(times.remote).toLocaleString() : 'time unknown'}`, 'font-size:.8rem;opacity:.75');
            dialog.append(when);
            const apply = el('button', 'Apply', 'margin:6px;padding:10px;border-radius:6px;cursor:pointer;');
            apply.type = 'button'; apply.disabled = true;
            const refresh = () => { apply.disabled = conflicts.some(c => !choices[c.id]); };
            for (const c of conflicts) {
                const d = describe(c);
                const card = el('div', undefined, 'border:1px solid #444;border-radius:8px;padding:10px;margin:10px 0;');
                card.dataset.conflictId = c.id;
                card.append(el('strong', d.title), el('div', d.line, 'font-size:.8rem;opacity:.75;margin-bottom:6px'));
                const row = el('div', undefined, 'display:flex;gap:8px;flex-wrap:wrap');
                const buttons = {};
                for (const [side, heading, text] of [['mine', 'This device', d.mine], ['theirs', 'Cloud', d.theirs]]) {
                    const b = el('button', undefined, 'flex:1 1 200px;text-align:left;padding:8px;border-radius:6px;cursor:pointer;');
                    b.type = 'button';
                    b.append(el('div', heading, 'font-size:.7rem;opacity:.7'), el('div', text, 'word-break:break-word'));
                    b.addEventListener('click', () => {
                        choices[c.id] = side;
                        for (const [s, other] of Object.entries(buttons)) other.style.outline = s === side ? '2px solid #4c8dff' : 'none';
                        refresh();
                    });
                    buttons[side] = b; row.append(b);
                }
                card.append(row); dialog.append(card);
            }
            const finish = value => { dialog.remove(); panelOpen = false; resolve(value); };
            const all = side => { for (const c of conflicts) choices[c.id] = side; finish({ ...choices }); };
            const bar = el('div', undefined, 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px');
            const mineAll = el('button', 'Keep all mine'), theirsAll = el('button', 'Use all cloud'), later = el('button', 'Decide later');
            for (const b of [mineAll, theirsAll, later]) { b.type = 'button'; b.style.cssText = 'margin:6px;padding:10px;border-radius:6px;cursor:pointer;'; }
            mineAll.addEventListener('click', () => all('mine'));
            theirsAll.addEventListener('click', () => all('theirs'));
            later.addEventListener('click', () => finish(null));
            apply.addEventListener('click', () => { if (!apply.disabled) finish({ ...choices }); });
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            bar.append(apply, mineAll, theirsAll, later);
            dialog.append(bar);
            document.body.appendChild(dialog);
            dialog.showModal();
        });
    }

    window.TaskitatorMerge = Object.freeze({ merge3, saveBase, loadBase, clearBase, clearAllBases, askUser, canon });
})();

// <<< MODULE_END: merge.js >>>
// <<< MODULE_START: sync-engine.js >>>
// File: sync-engine.js
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
        'taskitator_pending_sync_download', 'taskitator_recurrence_state'
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

    getConfig() {
        const account = window.TaskitatorAuth?.account;
        return {
            url: window.TASKITATOR_AUTH_CONFIG?.workerUrl || this.HARDCODED_WORKER_URL,
            username: account?.user || '',
            userId: window.TaskitatorAuth?.userId || '',
            authSessionId: window.Clerk?.session?.id || '',
            displayName: account?.display_name || '',
            last_synced: JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}').last_synced || null
        };
    },

    isConfigured() {
        return Boolean(window.TaskitatorAuth?.signedIn && this.getConfig().username);
    },

    accountCacheKey(config) {
        return `taskitator_account_cache_v2:${encodeURIComponent(config.username)}`;
    },

    archiveLocalAccount() {
        const localSettings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        const cacheOwner = localStorage.getItem(this.STORAGE_KEY_OWNER) || localSettings.worker_username || '';
        const snapshot = {};
        this.ACCOUNT_KEYS.forEach(key => {
            const value = localStorage.getItem(key);
            if (value !== null) snapshot[key] = value;
        });
        if (!Object.keys(snapshot).length) return;
        if (snapshot[this.STORAGE_KEY_SETTINGS]) {
            const settings = window.TaskitatorAuth.cleanSettings(JSON.parse(snapshot[this.STORAGE_KEY_SETTINGS]), false,
                cacheOwner !== window.TaskitatorAuth.account?.user);
            delete settings.worker_username;
            delete settings.worker_passkey;
            snapshot[this.STORAGE_KEY_SETTINGS] = JSON.stringify(settings);
        }
        // A newly signed-in identity may differ from the cached data's owner.
        // Archive under the data owner before restoring the next account.
        const key = cacheOwner ? this.accountCacheKey({ username: cacheOwner }) : 'taskitator_unclaimed_backup';
        localStorage.setItem(key, JSON.stringify(snapshot));
    },

    clearLocalAccount() {
        this.ACCOUNT_KEYS.forEach(key => localStorage.removeItem(key));
        localStorage.removeItem(this.STORAGE_KEY_OWNER);
        localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
        sessionStorage.removeItem('gemini_fallback_active');
    },

    beginLogin(username) {
        if (localStorage.getItem(this.STORAGE_KEY_OWNER) === username) {
            const settings = window.TaskitatorAuth.cleanSettings(JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}'));
            settings.worker_username = username;
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            this.initializeSession();
            return;
        }
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.pendingPageRefresh = false;
        this.pendingDownloadOrigin = null;
        this.archiveLocalAccount();
        const config = { username: username.trim().toLowerCase() };
        const raw = localStorage.getItem(this.accountCacheKey(config));
        const snapshot = raw ? JSON.parse(raw) : {};
        this.clearLocalAccount();
        this.ACCOUNT_KEYS.forEach(key => {
            if (typeof snapshot[key] === 'string') localStorage.setItem(key, snapshot[key]);
        });
        const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
        settings.worker_username = config.username;
        delete settings.worker_passkey;
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
        if (config.username && !owner &&
            JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}').worker_username === config.username) {
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
            current.username === config.username && current.userId === config.userId &&
            current.authSessionId === config.authSessionId &&
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

        const todayBreaks = globalThis.TaskitatorBreaks?.normalize(breaks,window.TaskitatorEngine?.BreakEngine?.getLogicalDayBounds?.().dateStr)||breaks;
        if(globalThis.TaskitatorBreaks)localStorage.setItem(this.STORAGE_KEY_BREAKS,JSON.stringify(todayBreaks));

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
            recurrence_state: JSON.parse(localStorage.getItem('taskitator_recurrence_state') || '{"series":[],"history":[]}'),
            recurrence_schema: 1,
            dynamic_priority_schema: 1,
            tasks: tasks,
            projects: projects,
            settings: window.TaskitatorAuth.cleanSettings(settings),
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
        // Offline: keep the dirty flag and every local edit; sync resumes on reconnect.
        if (window.TaskitatorOffline?.active) return { success: false, reason: 'offline' };
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
            const bearerToken = await window.TaskitatorAuth.token();
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            const res = await this.request(`${config.url}/sync/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}`,
                    'X-App-ID': 'taskitator', 'X-Taskitator-User': config.username },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (res.status === 409) return this.resolveConflict(data, this.mergeInFlight ? this.mergeAttempt : 0);
            if(res.status===403 && ['PROOF_REQUIRED','REQUIREMENTS_LOCKED','SHIELD_REQUIRED'].includes(data.code))
                return this.reportConflict({...data,remote_version:payload.base_version,error:data.error+' Keep a backup of local changes, then use the cloud copy and submit proof, or activate Emergency Bypass for the intended change.'});
            if (!res.ok || data.success !== true || data.version !== payload.base_version + 1) {
                throw new Error(data.error || 'Upload acknowledgement is invalid. Local changes were retained.');
            }
            this.rememberRemoteVersion(data.version);
            await window.TaskitatorMerge?.saveBase(config.username, data.version, payload);
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            settings.last_synced = data.updated_at;
            localStorage.setItem(this.STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            const pending = revision !== localStorage.getItem(this.STORAGE_KEY_REVISION);
            if(!pending&&data.today_breaks){localStorage.setItem(this.STORAGE_KEY_BREAKS,JSON.stringify(data.today_breaks));window.dispatchEvent(new CustomEvent('taskitator-breaks-changed'));}
            this.hasUnsavedChanges = pending;
            localStorage.setItem(this.STORAGE_KEY_DIRTY, String(pending));
            this.notify(pending ? 'pending' : 'synced', { timestamp: settings.last_synced });
            if (pending && !this.debounceTimer) this.queueAutoPush();
            return { success: true, pending, data };
        } catch (err) {
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            // Losing the connection is not a sync failure: the edits stay queued.
            if (err?.offline) { this.hasUnsavedChanges = true; return { success: false, reason: 'offline' }; }
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    async readCloud(config = this.getConfig()) {
        const bearerToken = await window.TaskitatorAuth.token();
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
        const offline = window.TaskitatorOffline;
        offline?.assertOnline();
        const headers = new Headers(options.headers);
        headers.set('Authorization', 'Bearer ' + await window.TaskitatorAuth.token());
        headers.delete('X-Taskitator-User');
        options = { ...options, headers };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            // Keep the timeout active until the body has finished downloading.
            const data = await response.json();
            if (response.ok) offline?.noteConfirmed();
            return { ok: response.ok, status: response.status, json: async () => data };
        } catch (error) { throw (await offline?.translate(error)) ?? error; }
        finally { clearTimeout(timer); }
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
            // Offline: keep the batch queued. Reconnecting re-arms it.
            if (window.TaskitatorOffline?.active) return;
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
            if (window.TaskitatorOffline?.active) return { success: false, reason: 'offline' };
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
            if (refreshOrigin === 'page-load') {
                window.dispatchEvent(new CustomEvent('taskitator-page-load-synced'));
            } else if (refreshOrigin === 'manual' || this.autoRefreshEnabled()) {
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
        if (document.querySelector?.('.modal-overlay.open, dialog[open], .pro-modal-backdrop')) return false;
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

    async changePassword() {
        await window.TaskitatorAuth.manageAccount();
        return { success: true };
    },

    async resumePasswordChange() {
        // Legacy credential rotation was replaced by managed account security.
        return { success: true };
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
        if (window.TaskitatorOffline?.active) return { success: false, reason: 'offline' };
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
                return this.resolveConflict({ remote_version: data.version });
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
                taskitator_recurrence_state: JSON.stringify(data.recurrence_state || {series:[],history:[]}),
                [this.STORAGE_KEY_TASKS]: JSON.stringify(data.tasks || []),
                [this.STORAGE_KEY_PROJECTS]: JSON.stringify(data.projects || []),
                [this.STORAGE_KEY_SETTINGS]: JSON.stringify({ ...window.TaskitatorAuth.cleanSettings(data.settings || currentSettings),
                    worker_username: config.username,
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
            await window.TaskitatorMerge?.saveBase(config.username, data.version,
                { ...data, settings: window.TaskitatorAuth.cleanSettings(data.settings || {}) });
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
            if (err?.offline) return { success: false, reason: 'offline' };
            this.notify('error', err.message);
            return { success: false, error: err.message };
        }
    },

    // Merge this device's edits with the cloud copy field by field. Only items changed
    // differently on both sides reach the user; anything that cannot be merged safely
    // (no base copy, older cloud revision, repeated races) falls back to the copy chooser.
    async resolveConflict(info = {}, attempt = 0) {
        const merge = window.TaskitatorMerge;
        const fallback = () => this.reportConflict(info);
        if (attempt === 0 && this.mergeInFlight) {
            return { success: false, conflict: true, deferred: true, error: 'A merge is already waiting for your decision.' };
        }
        if (!merge || attempt >= 3) return fallback();
        const config = this.getConfig(), sessionId = this.sessionId;
        const top = attempt === 0;
        if (top) { this.mergeInFlight = true; this.mergeAttempt = 0; }
        try {
            const base = await merge.loadBase(config.username);
            if (!base) return fallback();
            const remote = await this.readCloud(config);
            if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            if (remote.empty || !Array.isArray(remote.tasks) || base.version > remote.version) return fallback();
            const revision = localStorage.getItem(this.STORAGE_KEY_REVISION);
            const local = this.getPayload();
            const first = merge.merge3(base, local, remote);
            let choices = {};
            if (first.conflicts.length) {
                this.notify('conflict', { ...info, merge: true });
                choices = await merge.askUser(first.conflicts, {
                    local: localStorage.getItem(this.STORAGE_KEY_LAST_MODIFIED), remote: remote.updated_at });
                if (!choices) return { success: false, conflict: true, deferred: true, error: 'Conflicts are waiting for your decision on this device.' };
                if (!this.sessionMatches(config, sessionId)) return { success: false, reason: 'session_changed' };
            }
            if (revision !== localStorage.getItem(this.STORAGE_KEY_REVISION)) {
                return { success: false, error: 'Local edits changed during the merge. Sync again to retry.' };
            }
            const { merged } = merge.merge3(base, local, remote, choices);
            const settings = JSON.parse(localStorage.getItem(this.STORAGE_KEY_SETTINGS) || '{}');
            const updates = {
                [this.STORAGE_KEY_TASKS]: JSON.stringify(merged.tasks),
                [this.STORAGE_KEY_PROJECTS]: JSON.stringify(merged.projects),
                [this.STORAGE_KEY_SETTINGS]: JSON.stringify({ ...settings, ...merged.settings }),
                [this.STORAGE_KEY_LEDGER]: JSON.stringify(merged.completed_audit_ledger),
                [this.STORAGE_KEY_SAVED_CRITERIA]: JSON.stringify(merged.saved_criteria || []),
                taskitator_recurrence_state: JSON.stringify(merged.recurrence_state || { series: [], history: [] })
            };
            for (const [key, value] of Object.entries(updates)) localStorage.setItem(key, value);
            this.rememberRemoteVersion(remote.version);
            localStorage.removeItem(this.STORAGE_KEY_INITIAL_PULL);
            localStorage.setItem(this.STORAGE_KEY_REVISION, crypto.randomUUID());
            this.hasUnsavedChanges = true;
            localStorage.setItem(this.STORAGE_KEY_DIRTY, 'true');
            window.dispatchEvent(new CustomEvent('taskitator-merged', { detail: { conflicts: first.conflicts.length } }));
            this.mergeAttempt = attempt + 1;
            const result = await this.performPush(false);
            if (result.success && !result.pending) this.pendingPageRefresh = true;
            return result;
        } catch (err) {
            if (err?.offline) return { success: false, reason: 'offline' };
            this.notify('error', err.message);
            return { success: false, error: err.message };
        } finally {
            if (top) this.mergeInFlight = false;
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
                    taskitator_recurrence_state: snapshot.recurrence_state || {series:[],history:[]},
                    taskitator_tasks: snapshot.tasks || [],
                    taskitator_projects: snapshot.projects || [],
                    taskitator_settings: window.TaskitatorAuth.cleanSettings(settings),
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

    async logout() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.archiveLocalAccount();
        await window.TaskitatorAuth.signOut();
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

    if (!SyncEngine.isConfigured() && !isLoginPage && !document.documentElement?.classList?.contains('auth-pending')) {
        window.location.replace('login.html');

    }
})();

window.SyncEngine = SyncEngine;

// No polling loop. Events only restore an existing change-triggered deadline
// or finish a download/reload deferred by an unfinished form.
window.addEventListener('taskitator-auth-ready', () => {
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

// <<< MODULE_END: sync-engine.js >>>
// <<< MODULE_START: deletion-client.js >>>
(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    let proofId = null, verified = false, busy = false;
    let deletionOwner = null;
    const RECEIPT_KEY = 'taskitator_deletion_receipt';
    function feedback(message) { byId('accountDeletionFeedback').textContent = message; }
    function update() {
        byId('confirmAccountDeletionBtn').disabled = busy || !verified ||
            !byId('deletionBlockerDisabled').checked || byId('deletionPhrase').value !== 'Macrodroid disabled';
        byId('verifyDeletionPasswordBtn').disabled = busy;
        byId('verifyDeletionGoogleBtn').disabled = busy;
        byId('cancelAccountDeletionBtn').disabled = busy;
    }
    async function cleanLocal(user) {
        let complete = true;
        try {
            if (window.ExemplarStore?.deleteAccountFiles) complete = await window.ExemplarStore.deleteAccountFiles(user);
        } catch { complete = false; }
        // Audit F09: the merge base snapshot (tasks, settings, audit ledger) lives in IndexedDB.
        try {
            if (window.TaskitatorMerge && !await window.TaskitatorMerge.clearBase(user)) complete = false;
        } catch { complete = false; }
        try {
            if (localStorage.getItem('taskitator_local_owner') === user) {
                window.SyncEngine?.clearLocalAccount();
                localStorage.removeItem('taskitator_session_id');
            }
            for (const key of Object.keys(localStorage)) {
                const safe = key === 'taskitator_account_cache_v2:'+encodeURIComponent(user) ||
                    key === 'taskitator_account_recovery_v1:'+encodeURIComponent(user);
                let legacy = false;
                if (key.startsWith('taskitator_account_cache:')) {
                    const tail = key.slice('taskitator_account_cache:'.length);
                    legacy = tail.slice(0,tail.lastIndexOf(':')) === user;
                }
                if (safe || legacy) localStorage.removeItem(key);
            }
            const raw = localStorage.getItem('taskitator_unclaimed_backup');
            if (raw) {
                try {
                    const snapshot = JSON.parse(raw), settings = JSON.parse(snapshot.taskitator_settings || '{}');
                    if (settings.worker_username === user) localStorage.removeItem('taskitator_unclaimed_backup');
                    else if (!settings.worker_username) complete = false;
                } catch { complete = false; }
            }
            if (localStorage.getItem('taskitator_legacy_local_owner') === user) localStorage.removeItem('taskitator_legacy_local_owner');
            if (localStorage.getItem('taskitator_exemplar_legacy_owner') === user) localStorage.setItem('taskitator_exemplar_legacy_owner','__deleted__');
        } catch { complete = false; }
        sessionStorage.setItem('taskitator_deletion_local_cleanup', complete ? 'complete' : 'incomplete');
        return complete;
    }
    async function start(method) {
        verified = false; proofId = null;
        const data = await window.TaskitatorAuth.api('/auth/verification/start',{
            method:'POST',body:JSON.stringify({method})});
        proofId = data.verification_id;
        sessionStorage.setItem('taskitator_deletion_verification',proofId);
        return data;
    }
    async function password() {
        if (busy) return;
        busy = true; update();
        const input = byId('deletionPassword');
        try {
            if (!input.value) throw new Error('Enter your current sign-in password.');
            feedback('Verifying with Clerk…');
            await start('password');
            // Password goes directly to Clerk's SDK, never to Taskitator's Worker.
            await window.Clerk.session.startVerification({level:'first_factor'});
            const result = await window.Clerk.session.attemptFirstFactorVerification({strategy:'password',password:input.value});
            if (result.status !== 'complete') throw new Error('Password verification did not complete.');
            await window.TaskitatorAuth.token(true);
            await window.TaskitatorAuth.api('/auth/verification/password',{
                method:'POST',freshToken:true,body:JSON.stringify({verification_id:proofId})});
            verified = true; feedback('Identity verified. Check the blocker confirmation and manually type the phrase. Verification expires after five minutes.');
        } catch (error) { verified = false; feedback(error.message || 'Verification failed. Try again.'); }
        finally { input.value = ''; busy = false; update(); }
    }
    function googleAuthorizationUrl(value) {
        let url;
        try {
            if (typeof value !== 'string' || !value.trim()) throw new Error();
            url = new URL(value);
            if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
                url.username || url.password || url.hash) throw new Error();
        } catch {
            throw new Error('Google confirmation URL is missing or invalid. Check the Worker Google OAuth settings in pro/verification-setup.html, then retry or cancel.');
        }
        return url.href;
    }
    async function google() {
        if (busy) return;
        busy = true; update();
        try {
            const result = await start('google');
            const authorizationUrl = googleAuthorizationUrl(result.authorization_url);
            location.assign(authorizationUrl);
        } catch (error) { feedback(error.message); busy = false; update(); }
    }
    async function confirmDeletion() {
        if (busy || !verified || !byId('deletionBlockerDisabled').checked || byId('deletionPhrase').value !== 'Macrodroid disabled') return;
        busy = true; update();
        const account = window.TaskitatorAuth.account;
        deletionOwner = account.user;
        try {
            // Confirm with the server again immediately before the irreversible step.
            const proof = await window.TaskitatorAuth.api('/auth/verification/status',{
                method:'POST',body:JSON.stringify({verification_id:proofId})});
            if (!proof.verified) throw new Error('Verification expired. Verify again before deleting.');
            const receipt = Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
            // Retain the receipt BEFORE the request, including when its response is lost.
            sessionStorage.setItem(RECEIPT_KEY,receipt);
            feedback('Submitting permanent deletion…');
            const result = await window.TaskitatorAuth.api('/auth/account',{
                method:'DELETE',body:JSON.stringify({verification_id:proofId,receipt,
                    blocker_disabled:true,phrase:byId('deletionPhrase').value})});
            if (!result.accepted) throw new Error('Deletion was not accepted.');
            sessionStorage.setItem(RECEIPT_KEY,result.receipt || receipt);
            window.TaskitatorDeletionAccepted = true;
            if (window.SyncEngine?.debounceTimer) clearTimeout(window.SyncEngine.debounceTimer);
            await cleanLocal(account.user);
            window.TaskitatorAuth.account = null;
            location.replace('settings.html?view=deletion-status');
        } catch (error) {
            // A timeout may have occurred after acceptance. Keep the receipt and let
            // the status endpoint establish the result rather than resubmitting blind.
            feedback(error.message+' If the request timed out, use Check deletion status before trying again.');
            const button = byId('checkAccountDeletionStatusBtn'); button.hidden = false;
            if (error.status === 403) verified = false;
            busy = false; update();
        }
    }
    function open() {
        if (busy) return;
        verified = false; proofId = null;
        byId('deletionPhrase').value = ''; byId('deletionBlockerDisabled').checked = false;
        byId('deletionPassword').value = '';
        byId('checkAccountDeletionStatusBtn').hidden = true;
        feedback('Nothing has been deleted. Verify your identity, then confirm.');
        byId('deletionPassword').disabled = window.Clerk.user?.passwordEnabled === false;
        byId('accountDeletionDialog').showModal(); update();
    }
    window.TaskitatorAccountDeletion = {cleanLocal};
    window.addEventListener('taskitator-auth-ready', async () => {
        if (!byId('accountDeletionDialog')) return;
        byId('openAccountDeletionBtn').addEventListener('click',open);
        byId('cancelAccountDeletionBtn').addEventListener('click',()=>{ if (!busy) byId('accountDeletionDialog').close(); });
        byId('accountDeletionDialog').addEventListener('cancel',event=>{ if (busy) event.preventDefault(); });
        byId('verifyDeletionPasswordBtn').addEventListener('click',password);
        byId('verifyDeletionGoogleBtn').addEventListener('click',google);
        byId('confirmAccountDeletionBtn').addEventListener('click',confirmDeletion);
        byId('checkAccountDeletionStatusBtn').addEventListener('click',async()=>{
            try {
                const receipt = sessionStorage.getItem(RECEIPT_KEY);
                const response = await fetch(window.TASKITATOR_AUTH_CONFIG.workerUrl.replace(/\/$/,'')+'/auth/deletion/status',{
                    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt}),
                    cache:'no-store',signal:AbortSignal.timeout(15000)});
                const result = await response.json();
                if (!response.ok || !result.accepted) throw new Error(result.error || 'Deletion acceptance could not be confirmed.');
                window.TaskitatorDeletionAccepted = true;
                if (deletionOwner) await cleanLocal(deletionOwner);
                window.TaskitatorAuth.account = null;
                location.replace('settings.html?view=deletion-status');
            } catch (error) { feedback(error.message+' Your current local data has not been cleared.'); }
        });
        byId('deletionBlockerDisabled').addEventListener('change',update);
        const phrase = byId('deletionPhrase');
        phrase.addEventListener('input',update);
        ['paste','drop'].forEach(name=>phrase.addEventListener(name,event=>event.preventDefault()));
        phrase.addEventListener('beforeinput',event=>{
            if (['insertFromPaste','insertFromDrop'].includes(event.inputType)) event.preventDefault();
        });
        const match = /^#delete-verification=([a-f0-9]{64})$/.exec(location.hash);
        if (match) {
            history.replaceState(null,'',location.pathname+location.search);
            open();
            proofId = match[1];
            try {
                const result = await window.TaskitatorAuth.api('/auth/verification/status',{
                    method:'POST',body:JSON.stringify({verification_id:proofId})});
                verified = result.verified;
                feedback(verified ? 'Google identity confirmed. Check the blocker confirmation and manually type the phrase.' :
                    'Google confirmation failed or was cancelled. Use the Google account already connected to this login and try again.');
            } catch (error) { feedback(error.message); }
            update();
        }
    });
})();

// <<< MODULE_END: deletion-client.js >>>
// <<< MODULE_START: deletion-status.js >>>
(function () {
    'use strict';
    let timer, checking = false, bound = false;
    async function check() {
        const status = document.getElementById('deletionStatus');
        if (!status || checking) return;
        checking = true; clearTimeout(timer);
        const receipt = sessionStorage.getItem('taskitator_deletion_receipt');
        if (!receipt) { status.textContent='No deletion receipt is saved in this tab. No deletion is submitted from this page. Sign in to check your account or contact Mazendev.'; checking=false; return; }
        try {
            const response = await fetch(window.TASKITATOR_AUTH_CONFIG.workerUrl.replace(/\/$/,'')+'/auth/deletion/status',{
                method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt}),
                cache:'no-store',signal:AbortSignal.timeout(15000)});
            const data = await response.json();
            if (!response.ok) {
                if (response.status === 404) sessionStorage.removeItem('taskitator_deletion_receipt');
                throw new Error(data.error || 'Deletion status could not be checked.');
            }
            status.textContent = data.complete ? 'Cloud workspace and account deletion is complete.' :
                data.status==='retrying' ? 'Deletion was accepted and account access is blocked. Cleanup is retrying after a storage/provider error. You do not need to submit deletion again.' :
                'Deletion was accepted and account access is blocked. Cloud and sign-in cleanup is in progress.';
            if (data.legacy_review_needed) status.textContent += ' The legacy scan encountered unreadable records whose ownership could not be determined. Contact Mazendev for a manual review; unrelated records were not deleted.';
            if (data.migration_approval_remains) status.textContent += ' The old migration-approval configuration may still contain your username/email. Mazendev needs to remove that entry from its dashboard settings; the deleted workspace cannot be restored through it.';
            document.getElementById('phoneRecovery').textContent = 'Temporary phone unlock ends: '+new Date(data.phone_recovery_until).toLocaleString()+'.';
            const local = sessionStorage.getItem('taskitator_deletion_local_cleanup');
            document.getElementById('localCleanup').textContent = local==='complete' ? 'Identified local data was cleared in this browser.' :
                'Local cleanup may be incomplete. Close other Taskitator tabs and clear site data here after checking the result. This does not affect cloud cleanup.';
            if (!data.complete) timer=setTimeout(check,10000);
        } catch (error) { status.textContent=error.message+' If the receipt is not found, do not assume deletion succeeded. Sign in to check your account or contact Mazendev.'; }
        finally { checking=false; }
    }
    function activate() {
        const panel = document.getElementById('accountDeletionStatusContainer');
        if (panel) panel.style.display = 'block';
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.style.display = 'none';
        const sidebarDrawer = document.getElementById('sidebarDrawer');
        if (sidebarDrawer) sidebarDrawer.style.display = 'none';
        const copilotDrawer = document.getElementById('copilotDrawer');
        if (copilotDrawer) copilotDrawer.style.display = 'none';
        const refreshBtn = document.getElementById('refreshDeletionStatus');
        if (refreshBtn && !bound) {
            bound = true;
            refreshBtn.addEventListener('click', check);
        }
        check();
    }
    window.TaskitatorDeletionStatus = { check, activate };
    const isDeletionStatusRoute = typeof location !== 'undefined' && (
        location.pathname.endsWith('/account-deletion.html') ||
        (location.pathname.endsWith('/settings.html') && /[?&]view=deletion-status(?:&|$)/i.test(location.search || ''))
    );
    if (isDeletionStatusRoute || (!document.getElementById('authenticatedSettingsContainer') && document.getElementById('refreshDeletionStatus'))) {
        activate();
    }
})();
// <<< MODULE_END: deletion-status.js >>>
// <<< MODULE_START: login-page.js >>>
function runTaskitatorLoginPage() {
    if (!document.getElementById('loginFeedback') && !document.getElementById('secureSignIn')) return;
    (async function () {
    const feedback = document.getElementById('loginFeedback');
    const show = message => { feedback.textContent = message; feedback.hidden = false; };
    const continueButton = document.getElementById('continueBtn');
    const recoveryPanel = document.getElementById('recoveryPanel');
    let entering = false;
    function showConnected(account) {
        document.getElementById('connectPanel').hidden = true;
        continueButton.hidden = false;
        recoveryPanel.replaceChildren();
        const copies = TaskitatorAuth.recoveryCopies(account.user);
        recoveryPanel.hidden = !copies.length;
        if (!copies.length) return false;
        const message = document.createElement('p');
        message.textContent = 'Different old device copies were recovered. Download them before continuing; synchronization does not merge these copies.';
        recoveryPanel.append(message);
        copies.forEach((snapshot, index) => {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = 'Download recovered copy ' + (index + 1);
            button.onclick = () => {
                try {
                    // Match the existing settings-page backup import format.
                    const backup = { export_date: new Date().toISOString() };
                    for (const key of ['taskitator_tasks', 'taskitator_projects', 'taskitator_settings',
                        'taskitator_daily_breaks', 'taskitator_audit_ledger', 'taskitator_saved_criteria', 'taskitator_recurrence_state', 'taskitator_collapsed_nodes']) {
                        if (typeof snapshot[key] === 'string') backup[key] = JSON.parse(snapshot[key]);
                    }
                    backup.taskitator_settings = TaskitatorAuth.cleanSettings(backup.taskitator_settings, true);
                    backup.taskitator_tasks ||= [];
                    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
                    const link = document.createElement('a'); link.href = url;
                    link.download = 'taskitator-recovered-copy-' + (index + 1) + '.json';
                    document.body.append(link); link.click(); link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 30000);
                } catch (err) { show('This saved copy could not be exported. It remains on this device.'); }
            };
            recoveryPanel.append(button);
        });
        return true;
    }
    async function enter(account) {
        if (entering) return;
        entering = true; continueButton.disabled = true;
        try {
            showConnected(account);
            SyncEngine.beginLogin(account.user);
            const pulled = await SyncEngine.pull();
            if (!pulled.success && !pulled.conflict) throw new Error(pulled.error || 'Initial synchronization failed. Your local drafts are retained.');
            if (!pulled.conflict) location.replace('index.html');
            else show('This device has pending edits. Resolve the displayed cloud conflict, then choose Continue.');
        } finally { entering = false; continueButton.disabled = false; }
    }
    const redirect = location.origin + '/login.html';
    const signInNode = document.getElementById('secureSignIn');
    const choices = document.getElementById('loginChoices');
    const heading = document.getElementById('loginHeading'), intro = document.getElementById('loginIntro');
    if (!window.Clerk.session) {
        try {
            if (sessionStorage.getItem('taskitator_reauth_notice') === '1') {
                show('For your security, sign in again after this long away. Your unsynced changes are kept on this device.');
            }
        } catch {}
        let mode = 'signIn';
        const render = next => {
            if (mode === 'signUp') window.Clerk.unmountSignUp?.(signInNode);
            else window.Clerk.unmountSignIn?.(signInNode);
            mode = next;
            const options = {appearance:{elements:{rootBox:{width:'100%',maxWidth:'100%'},cardBox:{width:'100%',maxWidth:'100%'},card:{width:'100%',maxWidth:'100%',boxSizing:'border-box'}}},routing:'hash',forceRedirectUrl:redirect,signInForceRedirectUrl:redirect,signUpForceRedirectUrl:redirect};
            if (next === 'signUp') window.Clerk.mountSignUp(signInNode,options);
            else window.Clerk.mountSignIn(signInNode,{...options,withSignUp:true});
            document.getElementById('showSignInBtn')?.setAttribute('aria-pressed',String(next === 'signIn'));
            document.getElementById('showSignUpBtn')?.setAttribute('aria-pressed',String(next === 'signUp'));
        };
        const inButton=document.getElementById('showSignInBtn'), upButton=document.getElementById('showSignUpBtn');
        if (inButton) inButton.onclick=()=>render('signIn');
        if (upButton) upButton.onclick=()=>render('signUp');
        render('signIn'); return;
    }
    if (choices) choices.hidden=true;
    if (heading) heading.textContent='Your Taskitator account';
    if (intro) intro.textContent='You are signed in. Your tasks stay with this account.';
    document.getElementById('signedInPanel').hidden = false;
    if (TaskitatorAuth.storageWarnings.length) show([...new Set(TaskitatorAuth.storageWarnings)].join('\n'));
    document.getElementById('signedInEmail').textContent = window.Clerk.user?.primaryEmailAddress?.emailAddress || 'Signed in';
    document.getElementById('signOutLoginBtn').onclick = async () => {
        try { await SyncEngine.logout(); location.replace('login.html'); } catch (err) { show(err.message); }
    };
    continueButton.onclick = () => {
        if (TaskitatorAuth.account) return enter(TaskitatorAuth.account).catch(err => show(err.message));
    };
    if (TaskitatorAuth.account) {
        try { if (!showConnected(TaskitatorAuth.account) && !TaskitatorAuth.storageWarnings.length) await enter(TaskitatorAuth.account); }
        catch (err) { show(err.message); }
        return;
    }
    document.getElementById('connectPanel').hidden = false;
    const oldOwner = localStorage.getItem('taskitator_legacy_local_owner');
    if (oldOwner) document.getElementById('legacyUsername').value = oldOwner;
    document.getElementById('migrationForm').onsubmit = async event => {
        event.preventDefault();
        const button = document.getElementById('migrateAccountBtn'); button.disabled = true;
        const password = document.getElementById('legacyPassword');
        try {
            const account = await TaskitatorAuth.connect({ mode: 'migrate',
                username: document.getElementById('legacyUsername').value, password: password.value });
            password.value = '';
            if (!showConnected(account) && !TaskitatorAuth.storageWarnings.length) await enter(account);
        } catch (err) { show(err.message); } finally { password.value = ''; button.disabled = false; }
    };
    document.getElementById('newAccountBtn').onclick = async event => {
        if (!confirm('Start with an empty workspace? If you have an older Taskitator account, cancel and choose Import an older Taskitator account to keep its cloud tasks. Local drafts remain protected.')) return;
        event.target.disabled = true;
        try {
            const account = await TaskitatorAuth.connect({ mode: 'create' });
            sessionStorage.setItem('taskitator_new_tutorial', TaskitatorAuth.userId);
            if (!showConnected(account) && !TaskitatorAuth.storageWarnings.length) await enter(account);
        }
        catch (err) { show(err.message); } finally { event.target.disabled = false; }
    };

    
})();
}
if (document.documentElement?.classList?.contains('auth-pending')) {
    window.addEventListener('taskitator-auth-ready', runTaskitatorLoginPage);
} else {
    runTaskitatorLoginPage();
}

// <<< MODULE_END: login-page.js >>>
// <<< MODULE_START: auth-bootstrap.js >>>
// Do not initialize task UI or expose cached account data before server-checked sign-in.
(async function () {
    const loginPage = location.pathname.endsWith('/login.html');
    const deletionStatusPage = location.pathname.endsWith('/account-deletion.html') || (location.pathname.endsWith('/settings.html') && /[?&]view=deletion-status(?:&|$)/i.test(location.search || ''));
    const publicComponentView = location.pathname.endsWith('/components.html') && /[?&]view=(?:legal|compare|privacy|terms)(?:&|$)/i.test(location.search || '');
    const status = document.createElement('div');
    status.id = 'authLoadingStatus';
    status.style.cssText = 'position:fixed;inset:0;background:#0f172a;color:#e2e8f0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;gap:16px';
    status.textContent = 'Loading . . .';
    document.body.append(status);
    try {
        // Old cache-first workers ignore query strings and can return an old
        // sync engine to the new login. Activate the security worker first.
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            const versionMatches = () => new Promise(resolve => {
                const controller = navigator.serviceWorker.controller;
                if (!controller) { resolve(false); return; }
                const channel = new MessageChannel();
                const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
                channel.port1.onmessage = event => {
                    clearTimeout(timer); channel.port1.close();
                    resolve(event.data?.version === 'taskitator-real-cost-v1');
                };
                controller.postMessage({ type: 'TASKITATOR_SECURITY_VERSION' }, [channel.port2]);
            });
            // Offline, the cached files are all there is; waiting for a new worker would strand the user.
            if (!(await versionMatches()) && navigator.onLine !== false) {
                status.textContent = 'Updating secure app files…';
                await new Promise((resolve, reject) => {
                    let complete = false;
                    const finish = error => {
                        if (complete) return; complete = true;
                        clearTimeout(timer);
                        navigator.serviceWorker.removeEventListener('controllerchange', check);
                        if (error) reject(error); else resolve();
                    };
                    const check = async () => { if (await versionMatches()) finish(); };
                    const timer = setTimeout(() => finish(new Error('Security files are still updating. Close old Taskitator tabs, then reload this page. Your drafts are retained.')), 30000);
                    navigator.serviceWorker.addEventListener('controllerchange', check);
                    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                        .then(registration => registration.update()).then(check).catch(finish);
                });
                // Styles and deferred scripts may already have come from the old
                // controller. Rebuild the page under the new cache before init.
                location.reload();
                return;
            }
        } else if ('serviceWorker' in navigator) {
            // A first visit has no old worker intercepting scripts. Installation
            // may be disabled by the browser; secure login can still proceed.
            navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                .catch(() => {});
        }
        if (deletionStatusPage) {
            window.TaskitatorDeletionStatus?.activate?.();
            document.documentElement.classList.remove('auth-pending');
            status.remove();
            return;
        }
        if (publicComponentView) {
            const activatePublicView = (rawView) => {
                const pubView = String(rawView || '').toLowerCase() === 'compare' ? 'compare' : 'legal';
                document.querySelectorAll('.component-view-pane').forEach(el => {
                    if (el.id !== 'componentView-compare' && el.id !== 'componentView-legal') {
                        el.style.display = 'none';
                        el.remove?.();
                    } else {
                        el.style.display = el.id === 'componentView-' + pubView ? 'block' : 'none';
                    }
                });
                document.querySelectorAll('.components-subnav-btn').forEach(btn => {
                    const sw = btn.getAttribute('data-switch-view');
                    if (sw !== 'compare' && sw !== 'legal') {
                        btn.style.display = 'none';
                        btn.disabled = true;
                        btn.remove?.();
                    } else {
                        btn.classList.toggle('active', sw === pubView);
                    }
                });
                const titleEl = document.getElementById('componentPageTitle');
                if (titleEl) titleEl.textContent = pubView === 'compare' ? 'Compare Free & Pro' : 'Privacy Policy & Terms';
            };
            ['sidebarDrawer', 'drawerBackdrop', 'copilotDrawer', 'copilotBackdrop', 'openDrawerBtn', 'openCopilotNavBtn', 'todayJumpBtn'].forEach(id => {
                document.getElementById(id)?.remove?.();
            });
            document.querySelectorAll('script[type="text/taskitator-script"]').forEach(s => s.remove?.());
            const params = new URLSearchParams(location.search || '');
            activatePublicView(params.get('view') || 'legal');
            document.querySelectorAll('.components-subnav-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sw = btn.getAttribute('data-switch-view');
                    if (sw !== 'compare' && sw !== 'legal') {
                        location.replace('login.html');
                        return;
                    }
                    history.replaceState?.(null, '', 'components.html?view=' + sw);
                    activatePublicView(sw);
                });
            });
            document.documentElement.classList.remove('auth-pending');
            status.remove();
            return;
        }
        try { await TaskitatorAuth.init(); }
        catch (error) {
            const offline = window.TaskitatorOffline;
            // An HTTP answer that ends the account's access is final: no cached fallback.
            if (error?.status === 401 || error?.status === 403 || error?.status === 410) offline?.forget();
            if (!loginPage && offline && await offline.canOpenOffline(error)) offline.enterBootOffline();
            else throw error;
        }
        if (TaskitatorAuth.deletion) {
            if (TaskitatorAuth.deletion.receipt) sessionStorage.setItem('taskitator_deletion_receipt', TaskitatorAuth.deletion.receipt);
            location.replace('settings.html?view=deletion-status'); return;
        }
        if (!loginPage && !TaskitatorAuth.signedIn) { location.replace('login.html'); return; }
        if (!loginPage && localStorage.getItem('taskitator_local_owner') !== TaskitatorAuth.account?.user) {
            location.replace('login.html'); return;
        }
        // Keep the original classic-script order and global bindings intact.
        const scripts = [...document.querySelectorAll('script[type="text/taskitator-script"]')];
        for (const original of scripts) {
            const script = document.createElement('script');
            if (original.getAttribute('src')) {
                script.src = original.getAttribute('src'); script.async = false;
                await new Promise((resolve, reject) => {
                    script.onload = resolve; script.onerror = () => reject(new Error('An app file could not be loaded. Reload after checking your upload.'));
                    document.body.append(script);
                });
            } else { script.textContent = original.textContent; document.body.append(script); }
        }
        // Initialize existing page controls after asynchronous authentication.
        if (TaskitatorAuth.account && !TaskitatorAuth.deletion && window.TaskitatorVault && !window.TaskitatorOffline?.active) { await window.TaskitatorVault.initialize(); }
        window.dispatchEvent(new Event('taskitator-auth-ready'));
        document.documentElement.classList.remove('auth-pending');
        status.remove();
        // Also called after an offline period ends, once Clerk has loaded.
        let watching = false;
        window.TaskitatorWatchSession = () => {
            if (watching || !window.Clerk) return;
            watching = true;
            const initialSession = window.Clerk.session?.id;
            window.Clerk.addListener(({ session }) => {
                window.TaskitatorProfile?.refresh();
                if (initialSession && session?.id !== initialSession) {
                    if (window.TaskitatorDeletionAccepted || window.TaskitatorReauthInProgress) return;
                    window.TaskitatorVault?.clear();
                    window.SyncEngine?.archiveLocalAccount();
                    window.SyncEngine?.clearLocalAccount();
                    location.replace('login.html');
                }
            });
        };
        window.TaskitatorWatchSession();
        window.TaskitatorOffline?.applyUI();
    } catch (err) {
        if (err.status === 401 && sessionStorage.getItem('taskitator_deletion_receipt')) {
            location.replace('settings.html?view=deletion-status'); return;
        }
        status.textContent = err.message || 'Secure sign-in is unavailable. Reload to try again.';
        const reload = document.createElement('button'); reload.textContent = 'Try again';
        reload.onclick = () => location.reload(); status.append(reload);
    }
})();

// <<< MODULE_END: auth-bootstrap.js >>>

// Keep keyboard interaction within the open navigation drawer.
(function(){
 if(typeof document==='undefined'||typeof MutationObserver==='undefined')return;
 const drawer=document.getElementById('sidebarDrawer'),backdrop=document.getElementById('drawerBackdrop');if(!drawer||!backdrop)return;
 let wasOpen=false,returnFocus=null;const inerted=[];
 function update(){const open=drawer.classList.contains('open');if(open===wasOpen)return;wasOpen=open;
  if(open){returnFocus=document.activeElement;drawer.setAttribute('role','dialog');drawer.setAttribute('aria-modal','true');drawer.setAttribute('aria-label','Navigation');
   for(const child of document.body.children)if(child!==drawer&&child!==backdrop&&!child.contains(drawer)&&!child.matches('script,style,dialog,.cl-modalBackdrop')){inerted.push([child,child.inert]);child.inert=true;}
   drawer.querySelector('button,a,[tabindex]')?.focus();
  }else{for(const [child,previous]of inerted)child.inert=previous;inerted.length=0;drawer.removeAttribute('aria-modal');returnFocus?.focus();}
 }
 new MutationObserver(update).observe(drawer,{attributes:true,attributeFilter:['class']});
 document.addEventListener('keydown',e=>{if(!wasOpen)return;if(e.key==='Escape'){drawer.classList.remove('open');backdrop.classList.remove('open');e.preventDefault();}if(e.key==='Tab'){const nodes=[...drawer.querySelectorAll('a[href],button:not(:disabled),[tabindex="0"]')].filter(n=>n.getClientRects().length);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}}});
})();

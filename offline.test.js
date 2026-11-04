import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import './worker.js'; // load order matters: worker.js and pro-backend.js import each other
import { signOfflineEntitlement, OFFLINE_PRO_NO_EXPIRY_MS } from './pro-backend.js';

const root = new URL('./', import.meta.url);
const core = fs.readFileSync(new URL('core.js', root), 'utf8');
const section = core.match(/\/\/ <<< MODULE_START: offline\.js >>>([\s\S]*?)\/\/ <<< MODULE_END: offline\.js >>>/)[1];
const DAY = 86400000;

function storage() {
    const data = new Map();
    return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key), data };
}

// Loads the offline module into a sandbox with a controllable network.
function load({ reachable = true, publicKey = null, session = null } = {}) {
    const local = storage(), session_ = storage(), events = [], timers = [];
    const state = { reachable };
    const window = {
        TASKITATOR_AUTH_CONFIG: { workerUrl: 'https://worker.test', offlineProPublicKey: publicKey },
        Clerk: session ? { session } : undefined,
        addEventListener() {}, dispatchEvent: event => { events.push(event.type); return true; },
        TaskitatorAuth: {}
    };
    const document = {
        readyState: 'complete', body: { append() {} }, documentElement: { classList: { toggle() {} } },
        addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
        createElement: () => ({ setAttribute() {}, remove() {}, addEventListener() {}, append() {}, textContent: '' })
    };
    const sandbox = { window, document, localStorage: local, sessionStorage: session_, crypto: webcrypto, TextEncoder, TextDecoder,
        atob, btoa, AbortSignal, Date, Math, Number, JSON, Promise, Uint8Array, Array, String, Object, Error, console,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 0,
        fetch: async () => { if (!state.reachable) throw new TypeError('Failed to fetch'); return { status: 401 }; } };
    window.window = window;
    vm.createContext(sandbox);
    vm.runInContext(section, sandbox);
    return { O: window.TaskitatorOffline, window, local, session: session_, events, state, timers };
}
const identity = (local, extra = {}) => local.setItem('taskitator_offline_identity_v1',
    JSON.stringify({ account: { user: 'maz' }, clerk_user: 'user_1', confirmed_at: Date.now(), ...extra }));
async function keys() {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return { privateJwk: JSON.stringify(await webcrypto.subtle.exportKey('jwk', pair.privateKey)),
        publicJwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) };
}

test('offline Pro: a valid signed entitlement is accepted offline and exposes the usual status shape', async () => {
    const { privateJwk, publicJwk } = await keys();
    const { O, local } = load({ publicKey: publicJwk });
    identity(local);
    const exp = Date.now() + 20 * DAY;
    local.setItem('taskitator_offline_pro_token_v1', await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: privateJwk }, 'user_1', exp));
    const status = await O.proStatus();
    assert.equal(status.isPro, true);
    assert.equal(status.status, 'active');
    assert.equal(status.expires_at, exp);
    assert.equal(status.offline, true);
});

test('offline Pro: expiry, another account, tampering and a missing key all fail closed', async () => {
    const { privateJwk, publicJwk } = await keys();
    const env = { OFFLINE_PRO_PRIVATE_JWK: privateJwk };
    const { O, local } = load({ publicKey: publicJwk });
    identity(local);
    const put = token => local.setItem('taskitator_offline_pro_token_v1', token);

    put(await signOfflineEntitlement(env, 'user_1', Date.now() - 1000));
    assert.equal((await O.proStatus()).status, 'expired');
    assert.equal((await O.proStatus()).isPro, false);

    put(await signOfflineEntitlement(env, 'someone_else', Date.now() + DAY));
    assert.equal((await O.proStatus()).status, 'invalid');

    const good = await signOfflineEntitlement(env, 'user_1', Date.now() + DAY);
    const [head, body, sig] = good.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.valid_until += 365 * DAY; forged.exp += 365 * DAY;
    put([head, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.'));
    assert.equal((await O.proStatus()).status, 'invalid');

    const other = await keys();
    put(await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: other.privateJwk }, 'user_1', Date.now() + DAY));
    assert.equal((await O.proStatus()).status, 'invalid');

    const noKey = load({ publicKey: null });
    identity(noKey.local);
    noKey.local.setItem('taskitator_offline_pro_token_v1', good);
    assert.equal((await noKey.O.proStatus()).isPro, false);
    assert.equal((await load({ publicKey: publicJwk }).O.proStatus()).status, 'free');
});

test('offline Pro: a subscription without a fixed expiry is capped at 30 days', async () => {
    const { privateJwk, publicJwk } = await keys();
    const env = { OFFLINE_PRO_PRIVATE_JWK: privateJwk };
    const { O, local } = load({ publicKey: publicJwk });
    identity(local);
    local.setItem('taskitator_offline_pro_token_v1', await signOfflineEntitlement(env, 'user_1', null, Date.now() - (OFFLINE_PRO_NO_EXPIRY_MS - DAY)));
    const fresh = await O.proStatus();
    assert.equal(fresh.isPro, true);
    assert.equal(fresh.expires_at, null);
    local.setItem('taskitator_offline_pro_token_v1', await signOfflineEntitlement(env, 'user_1', null, Date.now() - OFFLINE_PRO_NO_EXPIRY_MS - 1000));
    assert.equal((await O.proStatus()).status, 'expired');
});

test('offline Pro: rolling the device clock back cannot extend access', async () => {
    const { privateJwk, publicJwk } = await keys();
    const { O, local } = load({ publicKey: publicJwk });
    identity(local);
    local.setItem('taskitator_offline_pro_token_v1', await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: privateJwk }, 'user_1', Date.now() + 5 * DAY));
    assert.equal((await O.proStatus()).isPro, true);
    // The device already saw a time past the expiry; a later, rolled-back clock does not undo that.
    local.setItem('taskitator_clock_high_water', String(Date.now() + 6 * DAY));
    assert.equal((await O.proStatus()).status, 'expired');
    // A server-confirmed time recovers a legitimate user after a wrong forward clock jump.
    O.saveProToken(local.getItem('taskitator_offline_pro_token_v1'), Date.now());
    assert.equal((await O.proStatus()).isPro, true);
});

test('Worker only signs when the secret is configured and never signs without an account', async () => {
    assert.equal(await signOfflineEntitlement({}, 'user_1', Date.now() + DAY), null);
    const { privateJwk } = await keys();
    assert.equal(await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: privateJwk }, '', Date.now() + DAY), null);
    assert.equal(await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: 'not json' }, 'user_1', Date.now() + DAY), null);
    const token = await signOfflineEntitlement({ OFFLINE_PRO_PRIVATE_JWK: privateJwk }, 'user_1', Date.now() + DAY);
    assert.equal(token.split('.').length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()), { alg: 'ES256', typ: 'TKOP' });
});

test('seven-day rule: only a gap over seven days without a later sign-in requires fresh authentication', () => {
    const { O, local } = load({});
    assert.equal(O.reauthRequired(), false, 'no recorded server contact yet');
    local.setItem('taskitator_last_online_at', String(Date.now() - 6 * DAY));
    assert.equal(O.reauthRequired(), false);
    local.setItem('taskitator_last_online_at', String(Date.now() - 8 * DAY));
    assert.equal(O.reauthRequired(), true);

    const created = load({ session: { id: 'new', createdAt: new Date() } });
    created.local.setItem('taskitator_last_online_at', String(Date.now() - 8 * DAY));
    assert.equal(created.O.reauthRequired(), false, 'a session created after the gap is a fresh sign-in');

    const old = load({ session: { id: 'old', createdAt: new Date(Date.now() - 30 * DAY) } });
    old.local.setItem('taskitator_last_online_at', String(Date.now() - 8 * DAY));
    assert.equal(old.O.reauthRequired(), true);

    old.O.markReauthStarted();
    assert.equal(old.O.reauthRequired(), true, 'the session that was told to sign out is still not fresh');
    const again = load({ session: { id: 'second', createdAt: new Date(Date.now() - 30 * DAY) } });
    again.local.setItem('taskitator_last_online_at', String(Date.now() - 8 * DAY));
    again.session.setItem('taskitator_reauth_session', 'old');
    assert.equal(again.O.reauthRequired(), false, 'a different session id after the forced sign-out is fresh');
});

test('seven-day rule: a clock jumped far in the other direction also forces fresh authentication', () => {
    const { O, local } = load({});
    local.setItem('taskitator_last_online_at', String(Date.now() + 30 * DAY));
    assert.equal(O.reauthRequired(), true);
});

test('offline fallback opens the cached account only for a network failure on the matching account', async () => {
    const network = new TypeError('Failed to fetch');
    const a = load({ reachable: false });
    identity(a.local); a.local.setItem('taskitator_local_owner', 'maz');
    assert.equal(await a.O.canOpenOffline(network), true);
    assert.equal(await a.O.canOpenOffline(Object.assign(new Error('Could not load secure sign-in.'), { network: true })), true);
    assert.equal(await a.O.canOpenOffline(Object.assign(new Error('Sign in'), { status: 401 })), false, '401 is an answer, not a network problem');
    assert.equal(await a.O.canOpenOffline(Object.assign(new Error('Gone'), { status: 410 })), false);
    a.session.setItem('taskitator_logout_pending', '1');
    assert.equal(await a.O.canOpenOffline(network), false, 'explicit logout');
    a.session.removeItem('taskitator_logout_pending');
    a.local.setItem('taskitator_local_owner', 'someone-else');
    assert.equal(await a.O.canOpenOffline(network), false, 'cached data belongs to another account');

    const first = load({ reachable: false });
    assert.equal(await first.O.canOpenOffline(network), false, 'first-time users must sign in online');

    const up = load({ reachable: true });
    identity(up.local); up.local.setItem('taskitator_local_owner', 'maz');
    assert.equal(await up.O.canOpenOffline(new Error('Clerk configuration is invalid')), false, 'a reachable backend and a non-network error is a real failure');
});

test('one failed request does not mean offline: the Worker is probed before the state changes', async () => {
    const a = load({ reachable: true });
    const kept = await a.O.translate(new TypeError('Failed to fetch'));
    assert.equal(kept.offline, undefined);
    assert.equal(a.O.active, false);

    const b = load({ reachable: false });
    const converted = await b.O.translate(new TypeError('Failed to fetch'));
    assert.equal(converted.offline, true);
    assert.equal(b.O.active, true);
    assert.ok(b.events.includes('taskitator-connectivity'));
    assert.throws(() => b.O.assertOnline(), error => error.offline === true);

    const http = Object.assign(new Error('Server error'), { status: 500 });
    assert.equal(await load({ reachable: false }).O.translate(http), http, 'HTTP errors pass through untouched');
});

test('server-confirmed contact is recorded and a deliberate logout forgets the cached account', () => {
    const { O, local, session } = load({});
    O.recordConfirmed({ user: 'maz' }, 'user_1');
    assert.equal(O.identity().account.user, 'maz');
    assert.equal(O.identity().clerk_user, 'user_1');
    assert.ok(Number(local.getItem('taskitator_last_online_at')) > 0);
    session.setItem('taskitator_reauth_notice', '1');
    O.noteConfirmed();
    assert.equal(session.getItem('taskitator_reauth_notice'), null, 'a confirmed contact clears the re-sign-in notice');
    local.setItem('taskitator_offline_pro_token_v1', 'x');
    O.forget();
    assert.equal(O.identity(), null);
    assert.equal(local.getItem('taskitator_last_online_at'), null);
    assert.equal(local.getItem('taskitator_offline_pro_token_v1'), null);
});

test('boot offline restores the cached account and uses its Clerk id for cached break state', () => {
    const { O, window, local } = load({});
    identity(local);
    O.enterBootOffline();
    assert.equal(O.active, true);
    assert.equal(O.bootOffline, true);
    assert.equal(window.TaskitatorAuth.account.user, 'maz');
    assert.equal(O.cachedUserId(), 'user_1');
    O.leaveBootOffline();
    assert.equal(O.active, false);
    assert.equal(O.cachedUserId(), null);
});

test('service worker precaches every local script and stylesheet the app pages load', () => {
    const sw = fs.readFileSync(new URL('sw.js', root), 'utf8');
    const assets = new Set([...sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, '')));
    for (const page of ['index.html', 'components.html', 'settings.html']) {
        const html = fs.readFileSync(new URL(page, root), 'utf8');
        for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))(?:\?[^"]*)?"/g)) {
            if (/^https?:/.test(match[1])) continue;
            assert.ok(assets.has(match[1]), page + ' loads ' + match[1] + ' but sw.js does not precache it');
        }
        assert.ok(assets.has(page), page + ' itself must be precached for offline navigation');
    }
});

test('connectivity-gated features are refused at the action layer, not only hidden', () => {
    const source = core.replace(/\r/g, '');
    // api(), the sync request and the Pro client all refuse to run offline.
    assert.match(source, /if \(!reconnect\) offline\?\.assertOnline\(\);/);
    assert.match(source, /async request\(url, options\) \{\s+const offline = window\.TaskitatorOffline;\s+offline\?\.assertOnline\(\);/);
    const pro = fs.readFileSync(new URL('pro.js', root), 'utf8');
    assert.match(pro, /global\.TaskitatorOffline\?\.assertOnline\(\);/);
});

test('offline banner is small, dismissible and gates AI actions in source', async () => {
    const pro = fs.readFileSync(new URL('pro.js', root), 'utf8');
    const comp = fs.readFileSync(new URL('components.js', root), 'utf8');
    const app = fs.readFileSync(new URL('app.js', root), 'utf8');
    assert.match(core, /aria-label', 'Dismiss offline notice'/);
    assert.match(core, /bannerDismissed = false;/);
    assert.match(core, /bannerTimer = setTimeout\(\(\) => \{ bannerDismissed = true; bar\.remove\(\); \}, BANNER_SHOW_MS\)/);
    assert.doesNotMatch(core, /Changes are saved on this device and sync when you reconnect/);
    assert.match(pro, /validateCriteria\(criteriaText[\s\S]{0,160}TaskitatorOffline\?\.active[\s\S]{0,160}internet connection/);
    assert.match(comp, /AI-locked tasks can\\'t be created offline/);
    assert.match(comp, /AI-locked tasks can\\'t be changed offline/);
    assert.match(comp, /Proof can\\'t be submitted offline/);
    assert.match(app, /async function sendMessage\(userText\) \{\n\s+if \(window\.TaskitatorOffline\?\.active\)/);
});

test('Pro activation, phone token and Sleep Lock setup need a connection or a MacroDroid token', () => {
    const pro = fs.readFileSync(new URL('pro.js', root), 'utf8');
    const sleep = fs.readFileSync(new URL('sleep.html', root), 'utf8');
    assert.match(core, /'#pro-activate-btn', '#generatePhoneTokenBtn', '#revokePhoneTokenBtn'/);
    assert.match(pro, /Activating Pro needs an internet connection/);
    assert.match(sleep, /id="macroNeeded"[^>]*hidden/);
    assert.match(sleep, /TaskitatorAuth\.api\('\/auth\/phone'\);phoneMissing=!phone\.active/);
    assert.match(sleep, /\|\|phoneMissing;/);
});

// Android app sign-in and account deletion (Phase 3 of the Android build). No production tokens or keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskitatorSync, verifySession, NATIVE_PARTIES } from './worker.js';

const webOrigin = 'https://taskitator.mazendev.com', issuer = 'https://test.clerk.example';
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = '-----BEGIN PUBLIC KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64') + '\n-----END PUBLIC KEY-----';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
// App tokens carry no azp unless a test sets one.
async function jwt(user, overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const data = encoded({ alg: 'RS256', typ: 'JWT' }) + '.' + encoded({ iss: issuer, sub: user, sid: 'sess_' + user.slice(5),
        iat: now, nbf: now - 1, exp: now + 60, ...overrides });
    return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
class Store {
    map = new Map(); tail = Promise.resolve(); alarm = null;
    async getAlarm() { return this.alarm; }
    async setAlarm(value) { this.alarm = value; }
    async list({ prefix = '', limit = 1000, startAfter } = {}) {
        return new Map([...this.map].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
    }
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, structuredClone(this.map.get(k))])) : structuredClone(this.map.get(key)); }
    async put(key, value) { if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v)); else this.map.set(key, structuredClone(value)); }
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
    async transaction(fn) {
        const run = async () => { const before = structuredClone(this.map); try { return await fn(this); } catch (err) { this.map = before; throw err; } };
        const result = this.tail.then(run, run); this.tail = result.catch(() => {}); return result;
    }
}
function fixture() {
    const storage = new Store(), kv = new Map(), deletedUsers = new Set();
    const env = { CLERK_JWT_KEY: publicKey, CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: issuer, ALLOWED_ORIGINS: webOrigin,
        ACCOUNT_DELETION_ENABLED: 'true',
        TASKITATOR_KV: { put: async (k, v) => { kv.set(k, JSON.parse(v)); }, get: async k => structuredClone(kv.get(k) || null),
            delete: async k => { kv.delete(k); }, list: async () => ({ keys: [], list_complete: true }) } };
    const service = new TaskitatorSync({ storage }, env);
    const state = { created: new Map(), defaultAgeMs: 60000 };
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'DELETE' && String(url).includes('/users/')) { deletedUsers.add(String(url).split('/').pop()); return Response.json({ deleted: true }); }
        if (String(url).includes('/sessions/')) {
            const id = String(url).split('/').pop();
            return Response.json({ status: 'active', user_id: 'user_' + id.slice(5, 6), created_at: state.created.get(id) ?? Date.now() - state.defaultAgeMs });
        }
        return Response.json({ primary_email_address_id: 'e1', email_addresses: [{ id: 'e1', email_address: 'a@example.com', verification: { status: 'verified' } }] });
    };
    // origin === null sends no Origin header, as the Android app does.
    async function call(path, token, method = 'GET', body, origin = null) {
        const res = await service.fetch(new Request('https://worker.test' + path, { method,
            headers: { Authorization: 'Bearer ' + token, ...(origin ? { Origin: origin } : {}), 'X-Taskitator-Client': 'android',
                'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
            ...(body ? { body: JSON.stringify(body) } : {}) }));
        return { status: res.status, body: await res.json() };
    }
    return { service, storage, call, state, deletedUsers };
}
async function account(f, user = 'user_A') {
    const token = await jwt(user);
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'create' })).status, 200);
    return token;
}
const receipt = () => crypto.randomUUID().replaceAll('-', '').repeat(2);

test('the Android package is an allowed authorized party, only without an Origin header', async () => {
    const f = fixture(); void f;
    for (const azp of ['com.aistudio.taskitator.mvptsk', 'clerk://com.aistudio.taskitator.mvptsk.callback', 'clerk://com.aistudio.taskitator.mvptsk.oauth']) {
        assert.ok(NATIVE_PARTIES.includes(azp));
        const token = await jwt('user_A', { azp });
        const identity = await verifySession(new Request('https://worker.test/auth/me'), f.service.env, token);
        assert.equal(identity.native, true);
        await assert.rejects(verifySession(new Request('https://worker.test/auth/me', { headers: { Origin: webOrigin } }), f.service.env, token), { status: 401 });
    }
    await assert.rejects(verifySession(new Request('https://worker.test/auth/me'), f.service.env, await jwt('user_A', { azp: 'com.aistudio.taskitator.mvptsk.evil' })), { status: 401 });
    // A website token is never "native", with or without an Origin header.
    const web = await jwt('user_A', { azp: webOrigin });
    assert.equal((await verifySession(new Request('https://worker.test/auth/me'), f.service.env, web)).native, false);
    assert.equal((await verifySession(new Request('https://worker.test/auth/me', { headers: { Origin: webOrigin } }), f.service.env, web)).native, false);
});

test('the app signs in, reads its account, and syncs without an Origin header', async () => {
    const f = fixture(), token = await account(f);
    const me = await f.call('/auth/me', token);
    assert.equal(me.status, 200); assert.ok(me.body.account.user);
    assert.equal((await f.call('/sync/pull', token)).status, 200);
});

// The app starts with its current session, then signs in again (a NEW session) and completes with that one.
async function begin(f, token) {
    const started = await f.call('/auth/verification/start', token, 'POST', { method: 'signin', action: 'delete-account' });
    assert.equal(started.status, 200);
    assert.equal(started.body.authorization_url, undefined);
    return started.body.verification_id;
}
async function newSession(f, user, sid) {
    f.state.created.set(sid, Date.now() + 50); // created after the attempt began
    return jwt(user, { sid });
}
const complete = (f, token, id) => f.call('/auth/verification/signin', token, 'POST', { verification_id: id, action: 'delete-account' });

test('app deletion: a new sign-in after the attempt began is the proof, with the app phrase', async () => {
    const f = fixture(), old = await account(f);
    const id = await begin(f, old);
    const token = await newSession(f, 'user_A', 'sess_A2');
    assert.equal((await complete(f, token, id)).status, 200);
    const base = { verification_id: id, receipt: receipt(), blocker_disabled: true };
    assert.equal((await f.call('/auth/account', token, 'DELETE', { ...base, phrase: 'Macrodroid disabled' })).status, 400);
    assert.equal((await f.call('/auth/account', token, 'DELETE', { ...base, phrase: 'Delete my account', blocker_disabled: false })).status, 400);
    const bad = await f.call('/auth/account', token, 'DELETE', { ...base, phrase: 'delete my account' });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /Delete my account/); assert.doesNotMatch(bad.body.error, /Macrodroid/i);
    const done = await f.call('/auth/account', token, 'DELETE', { ...base, phrase: 'Delete my account' });
    assert.equal(done.status, 200); assert.equal(done.body.accepted, true); assert.equal(done.body.receipt, base.receipt);
    const me = await f.call('/auth/me', token);
    assert.equal(me.body.account, null); assert.equal(me.body.deletion.receipt, base.receipt);
});

test('starting an attempt alone proves nothing: a stolen session cannot delete', async () => {
    const f = fixture(), stolen = await account(f);
    const id = await begin(f, stolen);
    const body = { verification_id: id, receipt: receipt(), blocker_disabled: true, phrase: 'Delete my account' };
    // Not verified yet.
    const early = await f.call('/auth/account', stolen, 'DELETE', body);
    assert.equal(early.status, 403);
    // The same session cannot complete its own attempt, however new it is.
    f.state.created.set('sess_A', Date.now() + 50);
    assert.equal((await complete(f, stolen, id)).status, 403);
    assert.equal((await f.call('/auth/account', stolen, 'DELETE', body)).status, 403);
    assert.equal((await f.call('/auth/me', stolen)).body.account !== null, true);
});

test('a session that already existed when the attempt began cannot complete it', async () => {
    const f = fixture(), old = await account(f);
    f.state.created.set('sess_A2', Date.now() - 60000); // another old session of the same user
    const other = await jwt('user_A', { sid: 'sess_A2' });
    const id = await begin(f, old);
    assert.equal((await complete(f, other, id)).status, 403);
});

test('the proof is bound to the attempt, the account, and one use', async () => {
    const f = fixture(), a = await account(f, 'user_A'), b = await account(f, 'user_B');
    const id = await begin(f, a);
    // Another account, even with a new session, cannot complete or use it.
    assert.equal((await complete(f, await newSession(f, 'user_B', 'sess_B2'), id)).status, 403);
    const token = await newSession(f, 'user_A', 'sess_A2');
    assert.equal((await complete(f, token, id)).status, 200);
    // A third session cannot take over the verified proof; completing twice is refused.
    assert.equal((await complete(f, await newSession(f, 'user_A', 'sess_A3'), id)).status, 403);
    const body = { verification_id: id, receipt: receipt(), blocker_disabled: true, phrase: 'Delete my account' };
    assert.equal((await f.call('/auth/account', await jwt('user_A', { sid: 'sess_A3' }), 'DELETE', body)).status, 403);
    assert.equal((await f.call('/auth/account', b, 'DELETE', body)).status, 403);
    assert.equal((await f.call('/auth/account', token, 'DELETE', body)).status, 200);
});

test('an expired attempt cannot be completed', async () => {
    const f = fixture(), old = await account(f);
    const id = await begin(f, old);
    const key = [...f.storage.map.keys()].find(k => k.startsWith('action-proof:'));
    const record = f.storage.map.get(key); record.expires = Date.now() - 1; f.storage.map.set(key, record);
    assert.equal((await complete(f, await newSession(f, 'user_A', 'sess_A2'), id)).status, 403);
});

test('sign-in verification is not available to website tokens, browsers, or other actions', async () => {
    const f = fixture(); await account(f);
    const web = await jwt('user_A', { azp: webOrigin });
    // A website token replayed without an Origin header, and from a browser.
    assert.equal((await f.call('/auth/verification/start', web, 'POST', { method: 'signin', action: 'delete-account' })).status, 403);
    assert.equal((await f.call('/auth/verification/start', web, 'POST', { method: 'signin', action: 'delete-account' }, webOrigin)).status, 403);
    const app = await jwt('user_A');
    assert.equal((await f.call('/auth/verification/signin', web, 'POST', { verification_id: 'a'.repeat(64), action: 'delete-account' })).status, 403);
    // Key actions stay website-only.
    for (const action of ['api-key-reveal', 'api-key-save', 'api-key-delete']) {
        const res = await f.call('/auth/verification/start', app, 'POST', { method: 'signin', action });
        assert.ok([403, 503].includes(res.status), action + ' -> ' + res.status);
    }
    // The website methods still need the website.
    assert.equal((await f.call('/auth/verification/start', app, 'POST', { method: 'password', action: 'delete-account' })).status, 403);
    // An impersonated app session cannot verify.
    assert.equal((await f.call('/auth/verification/start', await jwt('user_A', { act: { sub: 'admin' } }), 'POST', { method: 'signin', action: 'delete-account' })).status, 403);
});

test('the website deletion phrase is unchanged', async () => {
    const f = fixture(); await account(f);
    const web = await jwt('user_A', { azp: webOrigin });
    const res = await f.call('/auth/account', web, 'DELETE', { verification_id: 'a'.repeat(64), receipt: receipt(), blocker_disabled: true, phrase: 'Delete my account' }, webOrigin);
    assert.equal(res.status, 400); assert.match(res.body.error, /Macrodroid disabled/);
});

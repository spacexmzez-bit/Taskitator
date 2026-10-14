import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TaskitatorSync, evaluateStatus } from '../cloudflare/worker.js';
import { sha256 } from '../cloudflare/auth.js';

// Real RSA signatures exercise Web Crypto; only provider HTTP and DO storage
// are substituted. This never contacts the user's deployed service.
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const der = await crypto.subtle.exportKey('spki', keys.publicKey);
const publicKey = '-----BEGIN PUBLIC KEY-----\n' + Buffer.from(der).toString('base64') + '\n-----END PUBLIC KEY-----';
const origin = 'https://taskitator.mazendev.com';
const issuer = 'https://example.clerk.accounts.dev';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function jwt(user = 'user_A', overrides = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const data = encoded({ alg: 'RS256', typ: 'JWT', ...header }) + '.' + encoded({
        iss: issuer, sub: user, sid: 'sess_' + user.slice(5), azp: origin, iat: now, nbf: now - 1, exp: now + 60, ...overrides });
    return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
class Store {
    map = new Map(); tail = Promise.resolve();
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, structuredClone(this.map.get(k))])) : structuredClone(this.map.get(key)); }
    async put(key, value) { if (typeof key === 'object') for (const [k,v] of Object.entries(key)) this.map.set(k, structuredClone(v)); else this.map.set(key, structuredClone(value)); }
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
    async transaction(fn) {
        const run = async () => {
            const before = structuredClone(this.map);
            try { return await fn(this); } catch (err) { this.map = before; throw err; }
        };
        const result = this.tail.then(run, run); this.tail = result.catch(() => {}); return result;
    }
}
function fixture() {
    const storage = new Store(), kv = new Map();
    const env = { CLERK_JWT_KEY: publicKey, CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: issuer,
        ALLOWED_ORIGINS: origin, LEGACY_MIGRATION_OWNERS: '{"rd":"rd@example.com"}',
        LEGACY_MIGRATION_UNTIL: new Date(Date.now() + 86400000).toISOString(),
        TASKITATOR_KV: { get: async key => structuredClone(kv.get(key) || null) } };
    const service = new TaskitatorSync({ storage }, env);
    let revoked = false;
    globalThis.fetch = async url => {
        if (String(url).includes('/sessions/')) {
            const id = String(url).split('/').pop();
            return Response.json({ status: revoked ? 'revoked' : 'active', user_id: 'user_' + id.slice(5) });
        }
        if (String(url).endsWith('/users/user_A')) return Response.json({ primary_email_address_id: 'email1',
            email_addresses: [{ id: 'email1', email_address: 'rd@example.com', verification: { status: 'verified' } }] });
        return Response.json({ primary_email_address_id: 'email2',
            email_addresses: [{ id: 'email2', email_address: 'other@example.com', verification: { status: 'verified' } }] });
    };
    async function call(path, token, method = 'GET', body, extra = {}) {
        const res = await service.fetch(new Request('https://worker.test' + path, { method,
            headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Origin: origin,
                'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1', ...extra },
            ...(body ? { body: JSON.stringify(body) } : {}) }));
        return { status: res.status, body: await res.json() };
    }
    return { storage, kv, env, service, call, revoke: () => { revoked = true; } };
}
async function create(f, user = 'user_A') {
    const token = await jwt(user);
    const result = await f.call('/auth/account', token, 'POST', { mode: 'create' });
    assert.equal(result.status, 200);
    return { token, user: result.body.account.user };
}

test('unknown legacy credentials cannot create accounts; auth is required', async () => {
    const f = fixture();
    assert.equal((await f.call('/sync/pull')).status, 401);
    assert.equal((await f.call('/sync/pull', 'a'.repeat(64), 'GET', null, { 'X-Taskitator-User': 'victim' })).status, 401);
    assert.equal(f.storage.map.has('account:victim'), false);
});
test('JWT checks reject expired, wrong issuer/origin, pending, forged, and wrong algorithm tokens', async () => {
    const f = fixture();
    for (const claims of [{ exp: 0 }, { iss: 'https://evil.test' }, { azp: 'https://evil.test' },
        { nbf: Math.floor(Date.now()/1000) + 100 }, { sts: 'pending' }, { sid: 'sess_X' }, { azp: undefined }]) {
        assert.equal((await f.call('/auth/me', await jwt('user_A', claims))).status, 401);
    }
    assert.equal((await f.call('/auth/me', await jwt('user_A', {}, { alg: 'HS256' }))).status, 401);
    const good = await jwt();
    const parts = good.split('.'); parts[1] = encoded({ sub: 'user_B' });
    assert.equal((await f.call('/auth/me', parts.join('.'))).status, 401);
});
test('live provider revocation rejects a previously valid unexpired JWT', async () => {
    const f = fixture(), token = await jwt();
    assert.equal((await f.call('/auth/me', token)).status, 200);
    f.revoke(); assert.equal((await f.call('/auth/me', token)).status, 401);
});
test('missing configuration fails closed', async () => {
    const f = fixture(); delete f.env.CLERK_JWT_KEY;
    assert.equal((await f.call('/auth/me', await jwt())).status, 503);
});
test('accounts are created explicitly and remain isolated despite forged username headers', async () => {
    const f = fixture(), a = await create(f), b = await create(f, 'user_B');
    const snapshot = { username: a.user, tasks: [{ id: 'private', title: 'Private', status: 'active' }],
        settings: { worker_passkey: 'leaked', session_token: 'leaked', day_start_hour: 2 },
        base_version: 0, mutation_id: 'mutation1', recurrence_schema: 1 };
    assert.equal((await f.call('/sync/push', a.token, 'POST', snapshot)).status, 200);
    const other = await f.call('/sync/pull', b.token, 'GET', null, { 'X-Taskitator-User': a.user });
    assert.equal(other.body.empty, true);
    assert.equal((await f.call('/sync/push', b.token, 'POST', snapshot)).status, 400);
    const saved = await f.call('/sync/pull', a.token);
    assert.equal(saved.body.tasks[0].title, 'Private'); assert.equal(saved.body.version, 1);
    assert.equal(saved.body.settings.worker_passkey, undefined); assert.equal(saved.body.settings.session_token, undefined);
    assert.equal((await f.call('/sync/push', a.token, 'POST', { ...snapshot, mutation_id: 'mutation2' })).status, 409);
    assert.equal((await f.call('/sync/push', a.token, 'POST', snapshot)).body.version, 1);
});
test('phone tokens can read status only, rotate, revoke, and survive browser session revocation', async () => {
    const f = fixture(), a = await create(f);
    const issued = await f.call('/auth/phone', a.token, 'POST');
    assert.match(issued.body.token, /^tkp_[a-f0-9]{64}$/);
    const phone = issued.body.token;
    assert.equal((await f.call('/?action=status&format=json', phone)).status, 200);
    for (const [path, method] of [['/sync/pull','GET'],['/sync/push','POST'],['/auth/account','POST'],['/auth/phone','POST'],['/auth/me','GET']]) {
        assert.equal((await f.call(path, phone, method)).status, 403);
    }
    assert.equal((await f.call('/auth/phone', a.token)).body.token, undefined);
    const newPhone = (await f.call('/auth/phone', a.token, 'POST')).body.token;
    assert.equal((await f.call('/status', phone)).status, 401);
    f.revoke(); assert.equal((await f.call('/status', newPhone)).status, 200);
    // New fixture's provider state is active, but storage and phone record stay the same.
    fixture();
    assert.equal((await f.call('/auth/phone', a.token, 'DELETE')).status, 200);
    assert.equal((await f.call('/status', newPhone)).status, 401);
});
test('legacy migration requires correct password, owner-approved verified email, and an open deadline', async () => {
    const f = fixture(), token = await jwt();
    const legacy = await sha256('rd:OldPass!123:taskitator-client-v1');
    f.kv.set('user_reg:rd', { token_hash: legacy });
    f.kv.set('user_data:' + legacy, { username: 'rd', version: 7,
        tasks: [{ id: 'keep', title: 'Keep this task', status: 'active' }], settings: { worker_passkey: legacy } });
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 401);
    assert.equal((await f.call('/auth/account', await jwt('user_B'), 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' })).status, 403);
    const linked = await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' });
    assert.equal(linked.status, 200);
    const cloud = await f.call('/sync/pull', token); assert.equal(cloud.body.version, 7);
    assert.equal(cloud.body.tasks[0].title, 'Keep this task'); assert.equal(cloud.body.settings.worker_passkey, undefined);
    assert.equal((await f.call('/sync/pull', legacy, 'GET', null, { 'X-Taskitator-User': 'rd' })).status, 401);
    assert.equal((await f.storage.get('account:rd')).owner_id, 'user_A');
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' })).status, 200);
});
test('migration from existing Durable Object preserves version and closes legacy access', async () => {
    const f = fixture(), token = await jwt(), legacy = await sha256('rd:a:taskitator-client-v1');
    await f.storage.put('account:rd', { user: 'rd', digest: await sha256(legacy), version: 4, has_snapshot: false, chunks: 0 });
    f.env.LEGACY_MIGRATION_UNTIL = '2000-01-01T00:00:00Z';
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'a' })).status, 403);
    f.env.LEGACY_MIGRATION_UNTIL = new Date(Date.now()+86400000).toISOString();
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'a' })).status, 200);
    assert.equal((await f.call('/sync/pull', token)).body.version, 4);
    assert.equal((await f.storage.get('account:rd')).digest, undefined);
});
test('migration attempts are throttled across repeated requests', async () => {
    const f = fixture(), token = await jwt();
    for (let i = 0; i < 8; i++) assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 401);
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 429);
});
test('Worker CORS rejects unknown sites and never sends wildcard origin', async () => {
    const f = fixture(); f.env.TASKITATOR_SYNC = { idFromName: () => 'coordinator', get: () => f.service };
    assert.equal((await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }), f.env)).status, 403);
    const allowed = await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: origin } }), f.env);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(allowed.headers.get('Cache-Control'), 'no-store');
});
test('unlock status still respects due tasks and Riyadh breaks', () => {
    const now = Date.parse('2026-10-14T10:00:00+03:00');
    const data = { tasks: [{ status: 'active', due_date: '2026-10-14' }], settings: {}, today_breaks: [] };
    assert.equal(evaluateStatus(data, now).device_unlocked, false);
    data.today_breaks = { '2026-10-14': [{ start: '09:30', end: '10:30' }] };
    assert.equal(evaluateStatus(data, now).device_unlocked, true);
});

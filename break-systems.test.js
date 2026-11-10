// ============================================================================
// Taskitator Dual Break Systems Test Suite (break-systems.test.js)
// Phone-status pinning, Scheduled/Flexible server rules, concurrency, migration.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskitatorSync } from './worker.js';

// ---- fixture: real Worker routing with in-memory Durable Object storage ----
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const der = await crypto.subtle.exportKey('spki', keys.publicKey);
const publicKey = '-----BEGIN PUBLIC KEY-----\n' + Buffer.from(der).toString('base64') + '\n-----END PUBLIC KEY-----';
const origin = 'https://taskitator.mazendev.com', issuer = 'https://example.clerk.accounts.dev';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const realNow = Date.now;
let clock = null;
const now = () => clock ?? realNow();
Date.now = () => now();
async function jwt(user) {
    const t = Math.floor(now() / 1000);
    const data = encoded({ alg: 'RS256', typ: 'JWT' }) + '.' + encoded({ iss: issuer, sub: user, sid: 'sess_' + user.slice(5), azp: origin, iat: t, nbf: t - 1, exp: t + 60 });
    return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
class Store {
    map = new Map(); tail = Promise.resolve(); alarm = null;
    async getAlarm() { return this.alarm; }
    async setAlarm(value) { this.alarm = value; }
    async list({ prefix = '', limit = 1000 } = {}) { return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit).map(([k, v]) => [k, structuredClone(v)])); }
    async get(key) { return Array.isArray(key) ? new Map(key.filter(k => this.map.has(k)).map(k => [k, structuredClone(this.map.get(k))])) : structuredClone(this.map.get(key)); }
    async put(key, value) { if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v)); else this.map.set(key, structuredClone(value)); }
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
    async transaction(fn) {
        const run = async () => { const before = structuredClone(this.map); try { return await fn(this); } catch (e) { this.map = before; throw e; } };
        const result = this.tail.then(run, run); this.tail = result.catch(() => {}); return result;
    }
}
globalThis.fetch = async url => {
    if (String(url).includes('/sessions/')) return Response.json({ status: 'active', user_id: 'user_' + String(url).split('/').pop().slice(5) });
    return Response.json({ primary_email_address_id: 'e', email_addresses: [{ id: 'e', email_address: 'x@example.com', verification: { status: 'verified' } }] });
};
async function fixture(user = 'user_A') {
    const storage = new Store();
    const env = { CLERK_JWT_KEY: publicKey, CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: issuer, ALLOWED_ORIGINS: origin };
    const service = new TaskitatorSync({ storage }, env);
    async function call(path, method = 'GET', body, who = user, token = null) {
        const res = await service.fetch(new Request('https://worker.test' + path, { method,
            headers: { Authorization: 'Bearer ' + (token || await jwt(who)), Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.' + Math.floor(Math.random() * 200) },
            ...(body ? { body: JSON.stringify(body) } : {}) }));
        return { status: res.status, body: await res.json() };
    }
    const f = { storage, service, env, call, user };
    f.create = async (who = user) => { const r = await call('/auth/account', 'POST', { mode: 'create' }, who); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.account.user; };
    f.push = async (extra = {}, who = user) => {
        const old = await call('/sync/pull', 'GET', null, who);
        return call('/sync/push', 'POST', { tasks: [{ id: 'due', title: 'Due today', status: 'active', due_date: 'today' }], settings: {}, recurrence_schema: 1, dynamic_priority_schema: 1,
            base_version: old.body.version, mutation_id: 'm_' + crypto.randomUUID(), ...extra }, who);
    };
    f.phone = async () => (await call('/auth/phone', 'POST')).body.token;
    f.status = async token => (await call('/status', 'GET', null, user, token)).body;
    f.breaks = (body, who = user) => call('/breaks', body ? 'POST' : 'GET', body ? { timezone: 'Asia/Riyadh', ...body } : null, who);
    return f;
}
const at = iso => { clock = Date.parse(iso); };
const advance = ms => { clock = now() + ms; };
const MIN = 60000;

// ---------------------------------------------------------------------------
// 1. Pinned phone-status precedence (no break): tasks × Universe × Sleep Lock × Bypass
// ---------------------------------------------------------------------------
for (const finished of [false, true]) for (const universe of [false, true]) for (const sleep of [false, true]) for (const bypass of [false, true]) {
    test(`pinned /status: finished=${finished} universe=${universe} sleep=${sleep} bypass=${bypass}`, async () => {
        at('2026-11-04T10:00:00+03:00');
        try {
            const f = await fixture(); await f.create();
            const tasks = finished ? [] : [{ id: 'due', title: 'Due today', status: 'active', due_date: 'today' }];
            assert.equal((await f.push({ tasks })).status, 200);
            f.service.universe.lockStatus = async () => ({ locked: universe, count: universe ? 1 : 0, degraded: false });
            await f.storage.put('sleep-lock:user_A', { enabled: sleep, bedtime: '09:00', wake_time: '11:00', timezone: 'Asia/Riyadh', revision: 1 });
            if (bypass) await f.storage.put('pro:emergency:user_A', { cycle_id: 'x', uses_left: 3, active_until_ms: now() + 10 * MIN, reset_at: now() + 86400000 });
            const s = await f.status(await f.phone());
            // Sleep Lock is its own line now: it never changes device_unlocked.
            const expected = bypass ? true : universe ? false : finished;
            assert.equal(s.device_locked, !expected);
            assert.equal(s.sleep, bypass ? false : sleep, 'an active bypass frees Sleep Lock too');
            assert.equal(s.in_break, false);
            assert.equal(s.sleep_lock_active, sleep);
            assert.equal(!!s.emergency_bypass, bypass);
        } finally { clock = null; }
    });
}

// ---------------------------------------------------------------------------
// 2. System choice and Lock for Today
// ---------------------------------------------------------------------------
const op = () => 'op_' + crypto.randomUUID().replace(/-/g, '');
async function ready(iso = '2026-11-04T10:00:00+03:00') {
    at(iso); const f = await fixture(); await f.create(); assert.equal((await f.push()).status, 200); return f;
}
test('only Scheduled can be locked, without using allowance', async () => {
    try {
        const f = await ready();
        assert.equal((await f.breaks({ action: 'lock', system: 'flexible' })).body.code, 'INVALID_SYSTEM');
        const locked = await f.breaks({ action: 'lock', system: 'scheduled' });
        assert.equal(locked.body.scheduled.locked, true);
        assert.equal(locked.body.allowance.used, 0);
        assert.equal((await f.breaks({ action: 'lock', system: 'scheduled' })).status, 200);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).status, 409);
    } finally { clock = null; }
});
test('the lock resets at the logical-day reset', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'lock', system: 'scheduled' });
        at('2026-11-05T00:00:00+03:00');
        const next = await f.breaks();
        assert.equal(next.body.system, null); assert.equal(next.body.date, '2026-11-05'); assert.equal(next.body.allowance.remaining, 180);
    } finally { clock = null; }
});
test('two devices cannot select different systems at the same time', async () => {
    try {
        const f = await ready();
        const results = await Promise.all([f.breaks({ action: 'lock', system: 'scheduled' }), f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
        const system = (await f.breaks()).body.system;
        assert.equal(system, results[0].status === 200 ? 'scheduled' : 'flexible');
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// 3. Scheduled planning window
// ---------------------------------------------------------------------------
const plan = [{ start: '14:00', end: '14:30' }];
test('planning start, cancellation without save and expiry without save leave the day unlocked', async () => {
    try {
        const f = await ready();
        const started = await f.breaks({ action: 'plan_start' });
        assert.equal(started.status, 200); assert.equal(started.body.system, null);
        assert.equal(started.body.scheduled.planning.deadline, now() + 600000);
        assert.equal((await f.breaks({ action: 'plan_cancel' })).body.scheduled.planning, null);
        assert.equal((await f.breaks()).body.system, null);
        await f.breaks({ action: 'plan_start' }); advance(600000);
        const expired = await f.breaks();
        assert.equal(expired.body.system, null); assert.equal(expired.body.scheduled.planning, null);
        assert.equal(expired.body.flexible.can_start, true);
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: plan })).body.code, 'PLANNING_REQUIRED');
    } finally { clock = null; }
});
test('first save locks Scheduled; edits follow the original deadline on every device', async () => {
    try {
        const f = await ready();
        const start = now();
        await f.breaks({ action: 'plan_start' }); advance(4 * MIN);
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: [] })).body.code, 'INVALID_SCHEDULE', 'the first save needs a block');
        const saved = await f.breaks({ action: 'schedule_save', breaks: plan });
        assert.equal(saved.status, 200); assert.equal(saved.body.system, 'scheduled'); assert.equal(saved.body.lock_source, 'save');
        assert.equal(saved.body.scheduled.planning.deadline, start + 600000, 'saving does not restart the window');
        // Another device (or a reload) joins the same window and cannot restart it.
        assert.equal((await f.breaks({ action: 'plan_start' })).body.code, 'SCHEDULE_SAVED');
        assert.equal((await f.breaks({ action: 'plan_cancel' })).body.scheduled.planning.deadline, start + 600000);
        advance(5 * MIN);
        const edited = await f.breaks({ action: 'schedule_save', breaks: [{ start: '15:00', end: '15:45' }] });
        assert.equal(edited.body.scheduled.breaks[0].start, '15:00');
        const cleared = await f.breaks({ action: 'schedule_save', breaks: [] });
        assert.equal(cleared.status, 200); assert.equal(cleared.body.scheduled.breaks.length, 0); assert.equal(cleared.body.system, 'scheduled');
        advance(MIN);
        const final = await f.breaks({ action: 'schedule_save', breaks: plan });
        assert.equal(final.body.code, 'PLANNING_ENDED');
        const view = (await f.breaks()).body;
        assert.equal(view.scheduled.final, true); assert.equal(view.scheduled.breaks.length, 0); assert.equal(view.system, 'scheduled');
        assert.equal(view.flexible.can_start, true);
    } finally { clock = null; }
});
test('the six-hour closing rule and existing schedule validation still apply', async () => {
    try {
        const f = await ready('2026-11-04T18:00:00+03:00');
        assert.equal((await f.breaks({ action: 'plan_start' })).body.code, 'PLANNING_CLOSED');
        assert.equal((await f.breaks()).body.scheduled.can_start_planning, false);
        const g = await ready('2026-11-04T17:59:00+03:00');
        assert.equal((await g.breaks({ action: 'plan_start' })).status, 200);
        for (const bad of [[{ start: '14:00', end: '' }], [{ start: '14:00', end: '15:00' }, { start: '14:30', end: '15:30' }],
            [{ start: '10:00', end: '11:30' }, { start: '12:00', end: '13:31' }], [1, 2, 3, 4]])
            assert.equal((await g.breaks({ action: 'schedule_save', breaks: bad })).status, 400);
        assert.equal((await g.breaks()).body.system, null, 'rejected saves do not lock');
    } finally { clock = null; }
});
test('Lock for Today on Scheduled still allows one planning window later', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'lock', system: 'scheduled' });
        assert.equal((await f.breaks({ action: 'plan_start' })).status, 200);
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: plan })).body.system, 'scheduled');
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// 4. Flexible breaks
// ---------------------------------------------------------------------------
test('Flexible presets, custom durations and Until allowance ends are validated on the server', async () => {
    try {
        const f = await ready();
        for (const [body, code] of [[{ mode: 'preset', minutes: 20 }, 'INVALID_DURATION'], [{ mode: 'custom', minutes: 9 }, 'INVALID_DURATION'],
            [{ mode: 'custom', minutes: 181 }, 'INVALID_DURATION'], [{ mode: 'custom', minutes: 12.5 }, 'INVALID_DURATION'], [{ mode: 'other' }, 'INVALID_DURATION']])
            assert.equal((await f.breaks({ action: 'flex_start', operation_id: op(), ...body })).body.code, code);
        assert.equal((await f.breaks()).body.system, null, 'rejected starts do not lock');
        const started = await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 45, operation_id: op() });
        assert.equal(started.status, 200); assert.equal(started.body.system, 'flexible');
        assert.equal(started.body.flexible.active.ends_at, now() + 45 * MIN);
        assert.equal(started.body.flexible.active.can_end_at, now() + 10 * MIN);
        assert.equal(started.body.in_break, true);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).body.code, 'BREAK_ACTIVE');
        advance(45 * MIN);
        const after = await f.breaks();
        assert.equal(after.body.flexible.active, null); assert.equal(after.body.allowance.used, 45);
        assert.equal(after.body.flexible.sessions[0].reason, 'automatic');
        const until = await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() });
        assert.equal(until.body.flexible.active.ends_at, now() + 135 * MIN);
        advance(135 * MIN);
        const spent = (await f.breaks()).body;
        assert.equal(spent.allowance.remaining, 0); assert.equal(spent.flexible.can_start, false);
        assert.match(spent.flexible.reason, /Less than 10 minutes/);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 10, operation_id: op() })).body.code, 'ALLOWANCE_LOW');
    } finally { clock = null; }
});
test('manual ending is rejected before 10 minutes and charged by started minute', async () => {
    try {
        const f = await ready();
        const started = (await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() })).body;
        const id = started.flexible.active.id;
        advance(10 * MIN - 1);
        assert.equal((await f.breaks({ action: 'flex_end', break_id: id })).body.code, 'MINIMUM_NOT_REACHED');
        advance(1);
        // Exactly 10 minutes is allowed and charges exactly 10.
        const ended = await f.breaks({ action: 'flex_end', break_id: id });
        assert.equal(ended.status, 200); assert.equal(ended.body.allowance.used, 10); assert.equal(ended.body.in_break, false);
        assert.equal((await f.breaks({ action: 'flex_end', break_id: id })).status, 200, 'a repeated end does not charge twice');
        assert.equal((await f.breaks()).body.allowance.used, 10);
        const second = (await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() })).body.flexible.active.id;
        advance(30 * MIN + 1000);
        assert.equal((await f.breaks({ action: 'flex_end', break_id: second })).body.allowance.used, 10 + 31);
        assert.equal((await f.breaks({ action: 'flex_end' })).body.code, 'NO_ACTIVE_BREAK');
    } finally { clock = null; }
});
test('a 30-minute break leaves 2 hours 30 minutes; the remaining preset and custom limits follow', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() }); advance(30 * MIN);
        const v = (await f.breaks()).body;
        assert.equal(v.allowance.remaining, 150); assert.equal(v.flexible.max_custom, 150);
        await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 120, operation_id: op() }); advance(120 * MIN);
        const left = (await f.breaks()).body;
        assert.equal(left.allowance.remaining, 30);
        assert.deepEqual(left.flexible.presets.map(p => p.available), [true, false, false]);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 45, operation_id: op() })).body.code, 'ALLOWANCE_LOW');
    } finally { clock = null; }
});
test('Flexible breaks stop at the logical-day reset, cannot start in its last 10 minutes and never resume', async () => {
    try {
        const f = await ready('2026-11-04T23:40:00+03:00');
        const started = await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() });
        assert.equal(started.body.flexible.active.ends_at, Date.parse('2026-11-05T00:00:00+03:00'));
        at('2026-11-05T00:05:00+03:00');
        const next = (await f.breaks()).body;
        assert.equal(next.date, '2026-11-05'); assert.equal(next.flexible.active, null); assert.equal(next.system, null); assert.equal(next.allowance.used, 0);
        const g = await ready('2026-11-04T23:51:00+03:00');
        assert.equal((await g.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.code, 'RESET_SOON');
        assert.match((await g.breaks()).body.flexible.reason, /before the day resets/);
    } finally { clock = null; }
});
test('simultaneous and retried Flexible starts create one break and one charge', async () => {
    try {
        const f = await ready(), id = op();
        const results = await Promise.all([1, 2, 3].map(() => f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: id })));
        assert.ok(results.every(r => r.status === 200));
        assert.equal(results.filter(r => r.body.replayed).length, 2);
        const other = await Promise.all([f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() }), f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })]);
        assert.ok(other.every(r => r.body.code === 'BREAK_ACTIVE'));
        advance(30 * MIN);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: id })).body.replayed, true, 'a late retry of a finished break is a replay');
        const v = (await f.breaks()).body;
        assert.equal(v.allowance.used, 30); assert.equal(v.flexible.sessions.length, 1);
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// 5. Phone status with breaks
// ---------------------------------------------------------------------------
for (const kind of ['scheduled', 'flexible']) for (const universe of [false, true]) for (const sleep of [false, true]) for (const bypass of [false, true]) {
    test(`/status with active ${kind} break: universe=${universe} sleep=${sleep} bypass=${bypass}`, async () => {
        try {
            const f = await ready('2026-11-04T09:00:00+03:00');
            if (kind === 'scheduled') {
                await f.breaks({ action: 'plan_start' });
                await f.breaks({ action: 'schedule_save', breaks: [{ start: '10:00', end: '10:30' }] });
                at('2026-11-04T10:05:00+03:00');
            } else {
                at('2026-11-04T10:05:00+03:00');
                await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
            }
            f.service.universe.lockStatus = async () => ({ locked: universe, count: universe ? 1 : 0, degraded: false });
            await f.storage.put('sleep-lock:user_A', { enabled: sleep, bedtime: '10:00', wake_time: '11:00', timezone: 'Asia/Riyadh', revision: 1 });
            if (bypass) await f.storage.put('pro:emergency:user_A', { cycle_id: 'x', uses_left: 3, active_until_ms: now() + 10 * MIN, reset_at: now() + 86400000 });
            const before = (await f.breaks()).body.allowance.used;
            const s = await f.status(await f.phone());
            assert.equal(s.in_break, true);
            assert.equal(s.break_system, kind);
            assert.equal(s.device_locked, false, 'breaks override tasks and Universe locks');
            assert.equal(s.sleep, bypass ? false : sleep, 'breaks do not override Sleep Lock');
            assert.equal((await f.breaks()).body.allowance.used, before, 'status and bypass do not change break usage');
            at('2026-11-04T10:40:00+03:00');
            const later = await f.status(await f.phone());
            assert.equal(later.in_break, false);
            assert.equal(later.device_locked, !(bypass && now() < Date.parse('2026-11-04T10:15:00+03:00')));
        } finally { clock = null; }
    });
}
test('Emergency Bypass during a Flexible break does not end, refund or extend it', async () => {
    try {
        const f = await ready();
        const b = (await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).body.flexible.active;
        assert.equal((await f.call('/emergency', 'POST', {})).status, 200);
        const v = (await f.breaks()).body;
        assert.equal(v.flexible.active.id, b.id); assert.equal(v.flexible.active.ends_at, b.ends_at); assert.equal(v.allowance.used, 0);
        advance(30 * MIN);
        assert.equal((await f.breaks()).body.allowance.used, 30);
    } finally { clock = null; }
});
test('the phone token can read status but cannot call break actions', async () => {
    try {
        const f = await ready(), phone = await f.phone();
        assert.equal((await f.call('/breaks', 'POST', { action: 'lock', system: 'flexible' }, 'user_A', phone)).status, 403);
        assert.equal((await f.call('/breaks', 'GET', null, 'user_A', phone)).status, 403);
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// 6. Tampering, stale sync, settings changes, isolation and migration
// ---------------------------------------------------------------------------
test('synced snapshots cannot add breaks, remove a lock or restore allowance', async () => {
    try {
        const f = await ready();
        const forged = { '2026-11-04': { date: '2026-11-04', timezone: 'Asia/Riyadh', locked: true, breaks: [{ start: '10:00', end: '13:00' }] } };
        assert.equal((await f.push({ today_breaks: forged })).status, 200);
        const phone = await f.phone();
        assert.equal((await f.status(phone)).in_break, false, 'a forged schedule does not unlock the phone');
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() }); advance(30 * MIN);
        const stale = await f.push({ today_breaks: {} });
        assert.equal(stale.status, 200);
        assert.equal(stale.body.today_breaks['2026-11-04'].system, 'flexible');
        assert.equal(stale.body.today_breaks['2026-11-04'].breaks[0].kind, 'flexible');
        const pulled = await f.call('/sync/pull');
        assert.equal(pulled.body.today_breaks['2026-11-04'].system, 'flexible');
        const v = (await f.breaks()).body;
        assert.equal(v.system, 'flexible'); assert.equal(v.allowance.used, 30);
    } finally { clock = null; }
});
test('changing the day start or device timezone mid-day keeps today’s lock and allowance', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() }); advance(60 * MIN);
        assert.equal((await f.push({ settings: { day_start_hour: 4 } })).status, 200);
        const same = await f.breaks({ action: 'lock', system: 'scheduled', timezone: 'Pacific/Kiritimati' });
        assert.equal(same.body.date, '2026-11-04'); assert.equal(same.body.allowance.used, 60); assert.equal(same.body.reset_at, '2026-11-04T21:00:00.000Z');
        // The next day starts where this one ended, even with a later day start.
        at('2026-11-05T00:30:00+03:00');
        const next = (await f.breaks({ action: 'lock', system: 'scheduled' })).body;
        assert.equal(next.date, '2026-11-05'); assert.equal(next.cycle_start, Date.parse('2026-11-05T00:00:00+03:00'));
        assert.equal(next.reset_at, '2026-11-06T01:00:00.000Z');
        // Switching timezone cannot shorten the following day below 20 hours.
        at('2026-11-06T04:30:00+03:00');
        const after = (await f.breaks({ action: 'lock', system: 'scheduled', timezone: 'Pacific/Kiritimati' })).body;
        assert.ok(after.cycle_end - after.cycle_start >= 20 * 3600000);
        assert.equal(after.cycle_start, Date.parse('2026-11-06T04:00:00+03:00'));
    } finally { clock = null; }
});
test('break systems are isolated by account', async () => {
    try {
        const f = await ready();
        await f.create('user_B');
        await f.breaks({ action: 'lock', system: 'scheduled' });
        const b = await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() }, 'user_B');
        assert.equal(b.status, 200); assert.equal(b.body.system, 'flexible');
        assert.equal((await f.breaks()).body.system, 'scheduled');
    } finally { clock = null; }
});
async function legacy(f, record) {
    await f.storage.transaction(async tx => {
        const { snapshot } = await f.service.readTaskSnapshot(tx, 'user_A');
        snapshot.today_breaks = { '2026-11-04': { date: '2026-11-04', timezone: 'Asia/Riyadh', day_start_hour: 0,
            cycle_start: Date.parse('2026-11-04T00:00:00+03:00'), cycle_end: Date.parse('2026-11-05T00:00:00+03:00'), ...record } };
        await f.service.writeTaskSnapshot(tx, 'user_A', snapshot);
    });
}
test('a schedule saved before the update keeps the day Scheduled and its breaks active', async () => {
    try {
        const f = await ready();
        await legacy(f, { locked: true, window_started_at: now() - 3600000, breaks: [{ start: '10:30', end: '11:00' }] });
        const v = (await f.breaks()).body;
        assert.equal(v.system, 'scheduled'); assert.equal(v.lock_source, 'migration'); assert.equal(v.scheduled.breaks.length, 1);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.code, 'SYSTEM_LOCKED', 'no second allowance through Flexible');
        at('2026-11-04T10:45:00+03:00');
        assert.equal((await f.status(await f.phone())).in_break, true);
    } finally { clock = null; }
});
test('migration keeps an open saved window editable and leaves unsaved or repair records unlocked', async () => {
    try {
        const f = await ready();
        await legacy(f, { locked: false, window_started_at: now() - 4 * MIN, breaks: [{ start: '14:00', end: '14:30' }] });
        const open = (await f.breaks({ action: 'schedule_save', breaks: [{ start: '15:00', end: '15:30' }] })).body;
        assert.equal(open.system, 'scheduled'); assert.equal(open.scheduled.planning.deadline, now() + 6 * MIN);
        for (const record of [{ locked: false, window_started_at: now() - 2 * MIN, breaks: [] }, { locked: false, repair_required: true, window_started_at: now() - 3600000, breaks: [] }]) {
            const g = await ready(); await legacy(g, record);
            const v = (await g.breaks()).body;
            assert.equal(v.system, null); assert.equal(v.flexible.can_start, true);
        }
    } finally { clock = null; }
});
test('account deletion removes break records', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
        assert.ok([...f.storage.map.keys()].some(k => k.startsWith('breaks:')));
        await f.service.breaks.remove(f.storage, 'user_A');
        assert.ok(![...f.storage.map.keys()].some(k => k.startsWith('breaks:')));
    } finally { clock = null; }
});

// ===========================================================================
// Phase 2 — Strict modes
// ===========================================================================
// 2026-11-04 is a Wednesday (weekday 3); the Riyadh logical day starts at 00:00.
function strictConfig({ flexible = {}, scheduled = {}, allowance } = {}) {
    const days = {}; for (let d = 0; d < 7; d++) days[d] = { mode: 'default', breaks: [] };
    return { ...(allowance === undefined ? {} : { allowance }), flexible: { enabled: false, minimum: 30, ...flexible },
        scheduled: { enabled: false, deadline_minutes: 8 * 60, default: [], ...scheduled, days: { ...days, ...(scheduled.days || {}) } } };
}
async function strict(f, config, who = 'user_A') {
    const revision = (await f.breaks(null, who)).body.strict.revision;
    return f.breaks({ action: 'strict_save', config, revision }, who);
}
async function free(iso = '2026-11-04T09:00:00+03:00') {
    const f = await ready(iso); assert.equal((await f.push({ tasks: [] })).status, 200); return f;
}

test('Flexible Strict Mode accepts 30–60 minutes only', async () => {
    try {
        const f = await free();
        for (const minimum of [29, 61, 45.5, '30']) assert.equal((await strict(f, strictConfig({ flexible: { enabled: true, minimum } }))).body.code, 'INVALID_STRICT');
        for (const minimum of [30, 60]) {
            const saved = await strict(f, strictConfig({ flexible: { enabled: true, minimum } }));
            assert.equal(saved.status, 200); assert.equal(saved.body.flexible.minimum, minimum); assert.equal(saved.body.strict.pending_from, null);
        }
    } finally { clock = null; }
});
test('the strict minimum replaces 10 minutes for presets, custom, Until allowance ends and manual ending', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ flexible: { enabled: true, minimum: 45 } }));
        const v = (await f.breaks()).body;
        assert.deepEqual(v.flexible.presets.map(p => p.available), [false, true, true]);
        assert.match(v.flexible.presets[0].reason, /at least 45 minutes/);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).body.code, 'STRICT_MINIMUM');
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 44, operation_id: op() })).body.code, 'INVALID_DURATION');
        const until = (await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.flexible.active;
        assert.equal(until.can_end_at, now() + 45 * MIN); assert.equal(until.minimum, 45);
        advance(45 * MIN - 1);
        const early = await f.breaks({ action: 'flex_end', break_id: until.id });
        assert.equal(early.body.code, 'MINIMUM_NOT_REACHED'); assert.match(early.body.error, /45 minutes/);
        advance(1);
        assert.equal((await f.breaks({ action: 'flex_end', break_id: until.id })).body.allowance.used, 45);
    } finally { clock = null; }
});
test('the strict minimum blocks starts when allowance or time before reset is shorter', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ flexible: { enabled: true, minimum: 60 } }));
        await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 121, operation_id: op() }); advance(121 * MIN + 60 * MIN); // past the strict gap
        const low = (await f.breaks()).body;
        assert.equal(low.allowance.remaining, 59); assert.equal(low.flexible.can_start, false); assert.match(low.flexible.reason, /Less than 60 minutes of today/);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.code, 'ALLOWANCE_LOW');
        const g = await free('2026-11-04T23:01:00+03:00');
        await strict(g, strictConfig({ flexible: { enabled: true, minimum: 60 } }));
        assert.equal((await g.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() })).body.code, 'RESET_SOON');
        assert.match((await g.breaks()).body.flexible.reason, /60 minutes remain before the day resets/);
    } finally { clock = null; }
});
test('break settings cannot be changed at all while required non-bonus tasks remain today', async () => {
    try {
        const f = await ready(); // has an unfinished task due today
        const on = strictConfig({ flexible: { enabled: true, minimum: 40 }, scheduled: { enabled: true, default: [{ start: '20:00', end: '20:30' }] } });
        for (const change of [on, strictConfig({ allowance: 120 }), strictConfig({ flexible: { enabled: true, minimum: 60 } })]) {
            const blocked = await strict(f, change);
            assert.equal(blocked.status, 403, JSON.stringify(change)); assert.equal(blocked.body.code, 'STRICT_LOCKED');
            assert.match(blocked.body.error, /emergency bypass/);
        }
        const view = (await f.breaks()).body;
        assert.equal(view.strict.locked, true); assert.equal(view.strict.required_tasks, 1); assert.equal(view.strict.revision, 0);
        assert.equal((await strict(f, strictConfig())).status, 200, 'saving unchanged settings is harmless');
        // Bonus, completed and future tasks do not restrict; overdue and undated ones do.
        for (const [tasks, locked] of [[[{ id: 'b', title: 'Bonus', status: 'active', due_date: 'today', is_bonus: true }], false],
            [[{ id: 'c', title: 'Done', status: 'completed', due_date: 'today' }], false], [[{ id: 'n', title: 'Next', status: 'active', due_date: '2026-11-05' }], false],
            [[{ id: 'o', title: 'Old', status: 'active', due_date: '2026-11-01' }], true], [[{ id: 'u', title: 'Undated', status: 'active' }], true],
            [[{ id: 'p', title: 'Parent', status: 'active', due_date: '2026-11-09', is_bonus: true }, { id: 'k', title: 'Kid', parent_id: 'p', status: 'active' }], false]]) {
            assert.equal((await f.push({ tasks })).status, 200);
            assert.equal((await f.breaks()).body.strict.locked, locked, JSON.stringify(tasks));
        }
        assert.equal((await f.push({ tasks: [] })).status, 200);
        assert.equal((await strict(f, on)).status, 200, 'with no required work it can be changed');
        assert.equal((await strict(f, strictConfig())).status, 200, 'and turned off');
    } finally { clock = null; }
});
test('an active emergency bypass unlocks break settings; a break does not', async () => {
    try {
        const f = await ready();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
        assert.equal((await f.breaks()).body.in_break, true);
        assert.equal((await strict(f, strictConfig({ allowance: 120 }))).body.code, 'STRICT_LOCKED', 'being on a break does not unlock settings');
        await f.storage.put('pro:emergency:user_A', { cycle_id: 'x', uses_left: 3, active_until_ms: now() + 15 * MIN, reset_at: now() + 86400000 });
        const view = (await f.breaks()).body;
        assert.equal(view.strict.locked, false); assert.equal(view.strict.bypass, true); assert.equal(view.strict.required_tasks, 1);
        const saved = await strict(f, strictConfig({ allowance: 120, flexible: { enabled: true, minimum: 45 } }));
        assert.equal(saved.status, 200);
        assert.equal(saved.body.strict.pending_from, '2026-11-05', 'today is locked to Flexible, so the change waits for tomorrow');
        assert.equal(saved.body.allowance.total, 180);
        advance(16 * MIN);
        assert.equal((await strict(f, strictConfig({ allowance: 180 }))).body.code, 'STRICT_LOCKED', 'locked again once the bypass ends');
    } finally { clock = null; }
});

test('strict settings use a revision so a stale device cannot overwrite them', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ flexible: { enabled: true, minimum: 30 } }));
        const stale = await f.breaks({ action: 'strict_save', config: strictConfig(), revision: 0 });
        assert.equal(stale.status, 409); assert.equal(stale.body.code, 'STRICT_CHANGED');
    } finally { clock = null; }
});

const plan30 = [{ start: '13:00', end: '13:30' }];
test('Scheduled Strict Mode locks the default plan at the deadline: before, exactly at and after', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 11 * 60, default: plan30 } }));
        at('2026-11-04T10:59:59.999+03:00');
        const before = (await f.breaks()).body;
        assert.equal(before.system, null); assert.equal(before.strict_today.pending, true);
        assert.equal(before.strict_today.deadline, Date.parse('2026-11-04T11:00:00+03:00'));
        at('2026-11-04T11:00:00+03:00');
        const atDeadline = (await f.breaks()).body;
        assert.equal(atDeadline.system, 'scheduled'); assert.equal(atDeadline.lock_source, 'strict');
        assert.deepEqual(atDeadline.scheduled.breaks.map(b => b.start), ['13:00']);
        assert.equal(atDeadline.scheduled.can_start_planning, false); assert.match(atDeadline.scheduled.reason, /Strict Mode locked/);
        assert.equal((await f.breaks({ action: 'plan_start' })).body.code, 'SCHEDULE_SAVED', 'the strict schedule cannot be edited');
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.code, 'SYSTEM_LOCKED');
        at('2026-11-04T13:10:00+03:00');
        assert.equal((await f.status(await f.phone())).in_break, true);
    } finally { clock = null; }
});
test('weekday overrides replace the default; deselected days stay free; included days without a plan get zero breaks', async () => {
    try {
        const cases = [
            [{ 3: { mode: 'custom', breaks: [{ start: '15:00', end: '16:00' }] } }, 'scheduled', ['15:00']],
            [{ 3: { mode: 'off' } }, null, null],
            [{ 3: { mode: 'custom', breaks: [] } }, 'scheduled', []],
            [{}, 'scheduled', []]   // default plan is empty
        ];
        for (const [days, system, starts] of cases) {
            const f = await free();
            await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 10 * 60, default: starts === null || Object.keys(days).length ? plan30 : [], days } }));
            at('2026-11-04T10:30:00+03:00');
            const v = (await f.breaks()).body;
            assert.equal(v.system, system, JSON.stringify(days));
            if (starts) assert.deepEqual(v.scheduled.breaks.map(b => b.start), starts);
            if (system === null) { assert.equal(v.strict_today.covered, false); assert.equal(v.scheduled.can_start_planning, true); assert.equal(v.flexible.can_start, true); }
            else { assert.equal(v.strict_today.covered, true); if (!starts.length) assert.match(v.scheduled.reason, /no breaks/); }
        }
    } finally { clock = null; }
});
test('Scheduled Strict Mode still applies after Flexible use, while a saved plan is kept', async () => {
    try {
        const cfg = strictConfig({ scheduled: { enabled: true, deadline_minutes: 11 * 60, default: plan30 } });
        const f = await free(); await strict(f, cfg);
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
        at('2026-11-04T12:00:00+03:00');
        const flex = (await f.breaks()).body;
        assert.equal(flex.system, 'scheduled'); assert.equal(flex.lock_source, 'strict'); assert.equal(flex.flexible.can_start, false);
        const g = await free(); await strict(g, cfg);
        await g.breaks({ action: 'plan_start' }); await g.breaks({ action: 'schedule_save', breaks: [{ start: '16:00', end: '16:15' }] });
        at('2026-11-04T12:00:00+03:00');
        const own = (await g.breaks()).body;
        assert.equal(own.lock_source, 'save'); assert.deepEqual(own.scheduled.breaks.map(b => b.start), ['16:00']);
    } finally { clock = null; }
});
test('an unsaved planning window at the deadline is discarded and the strict plan applies', async () => {
    try {
        const f = await free('2026-11-04T10:55:00+03:00');
        await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 11 * 60, default: plan30 } }));
        assert.equal((await f.breaks({ action: 'plan_start' })).status, 200);
        at('2026-11-04T11:01:00+03:00');
        const save = await f.breaks({ action: 'schedule_save', breaks: [{ start: '18:00', end: '19:00' }] });
        assert.equal(save.status, 409);
        const v = (await f.breaks()).body;
        assert.equal(v.lock_source, 'strict'); assert.equal(v.scheduled.planning, null); assert.deepEqual(v.scheduled.breaks.map(b => b.start), ['13:00']);
    } finally { clock = null; }
});
test('offline at the deadline: the first later request and phone status see the strict lock', async () => {
    try {
        const f = await free('2026-11-03T20:00:00+03:00');
        await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 11 * 60, default: plan30 } }));
        const phone = await f.phone();
        // No request at all on Nov 4 until the strict break starts.
        at('2026-11-04T13:05:00+03:00');
        const s = await f.status(phone);
        assert.equal(s.in_break, true); assert.equal(s.break_system, 'scheduled'); assert.equal(s.device_locked, false);
        at('2026-11-04T13:40:00+03:00');
        assert.equal((await f.status(phone)).in_break, false);
        const first = await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() });
        assert.equal(first.body.code, 'SYSTEM_LOCKED', 'the strict lock is applied before a conflicting action');
        assert.equal((await f.breaks()).body.lock_source, 'strict');
    } finally { clock = null; }
});
test('the deadline counts from the logical day start (3:00 + 8 hours = 11:00)', async () => {
    try {
        const f = await ready('2026-11-04T09:00:00+03:00');
        assert.equal((await f.push({ tasks: [], settings: { day_start_hour: 3 } })).status, 200);
        await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 8 * 60, default: plan30 } }));
        const v = (await f.breaks()).body;
        assert.equal(v.cycle_start, Date.parse('2026-11-04T03:00:00+03:00'));
        assert.equal(v.strict_today.deadline, Date.parse('2026-11-04T11:00:00+03:00'));
    } finally { clock = null; }
});
test('strict changes never rewrite a locked day and apply from the next day once today is decided', async () => {
    try {
        const f = await free('2026-11-04T12:00:00+03:00');
        const late = await strict(f, strictConfig({ scheduled: { enabled: true, deadline_minutes: 10 * 60, default: plan30 } }));
        assert.equal(late.body.strict.pending_from, '2026-11-05', 'today’s deadline already passed');
        assert.equal(late.body.system, null); assert.equal(late.body.strict_today, null);
        at('2026-11-05T10:00:00+03:00');
        assert.equal((await f.breaks()).body.lock_source, 'strict');
        // Before today's deadline with nothing chosen, a change applies today.
        const g = await free('2026-11-04T09:00:00+03:00');
        assert.equal((await strict(g, strictConfig({ flexible: { enabled: true, minimum: 30 } }))).body.strict.pending_from, null);
        // Once Flexible is locked, a new minimum waits for tomorrow.
        await g.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
        const next = await strict(g, strictConfig({ flexible: { enabled: true, minimum: 60 } }));
        assert.equal(next.body.strict.pending_from, '2026-11-05'); assert.equal(next.body.flexible.minimum, 30);
        at('2026-11-05T09:00:00+03:00');
        assert.equal((await g.breaks()).body.flexible.minimum, 60);
    } finally { clock = null; }
});
test('strict plans must obey Scheduled rules and the three-hour limit; bad days are rejected', async () => {
    try {
        const f = await free();
        for (const scheduled of [{ enabled: true, default: [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '12:30' }] },
            { enabled: true, default: [{ start: '10:00', end: '12:00' }, { start: '13:00', end: '14:01' }] },
            { enabled: true, days: { 2: { mode: 'custom', breaks: [{ start: '10:00', end: '' }] } } },
            { enabled: true, days: { 5: { mode: 'weekly' } } }, { enabled: true, deadline_minutes: 30 }, { enabled: true, deadline_minutes: 487 },
            { enabled: true, deadline_minutes: 19 * 60 }])
            assert.equal((await strict(f, strictConfig({ scheduled }))).body.code, 'INVALID_STRICT', JSON.stringify(scheduled));
        assert.equal((await f.breaks()).body.strict.revision, 0, 'nothing was saved');
    } finally { clock = null; }
});
test('strict settings are isolated by account and removed with the account', async () => {
    try {
        const f = await free();
        await f.create('user_B');
        await strict(f, strictConfig({ flexible: { enabled: true, minimum: 60 } }));
        assert.equal((await f.breaks(null, 'user_B')).body.flexible.minimum, 10);
        await f.service.breaks.remove(f.storage, 'user_A');
        assert.equal(await f.storage.get('breaks:strict:user_A'), undefined);
        assert.equal((await f.breaks()).body.flexible.minimum, 10);
    } finally { clock = null; }
});

// ===========================================================================
// Flexible Strict gap and adjustable daily maximum
// ===========================================================================
test('Flexible Strict Mode enforces a gap as long as its minimum between breaks; normal mode has none', async () => {
    try {
        const f = await free();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() }); advance(30 * MIN);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).status, 200, 'normal mode: back-to-back is fine');
        const g = await free();
        await strict(g, strictConfig({ flexible: { enabled: true, minimum: 45 } }));
        await g.breaks({ action: 'flex_start', mode: 'preset', minutes: 45, operation_id: op() }); advance(50 * MIN); // ended automatically at 45
        let view = (await g.breaks()).body;
        assert.equal(view.flexible.can_start, false); assert.equal(view.flexible.gap_minutes, 45);
        assert.equal(view.flexible.gap_until, Date.parse('2026-11-04T09:00:00+03:00') + 90 * MIN);
        assert.match(view.flexible.reason, /45 minutes between breaks.*40 min/);
        assert.ok(view.flexible.presets.every(p => !p.available));
        const blocked = await g.breaks({ action: 'flex_start', mode: 'preset', minutes: 45, operation_id: op() });
        assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'STRICT_GAP');
        advance(40 * MIN - 1);
        assert.equal((await g.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body.code, 'STRICT_GAP', 'one millisecond early');
        advance(1);
        view = (await g.breaks()).body;
        assert.equal(view.flexible.gap_until, null); assert.equal(view.flexible.can_start, true);
        assert.equal((await g.breaks({ action: 'flex_start', mode: 'preset', minutes: 45, operation_id: op() })).status, 200);
        // A manual end starts the gap from the moment it ended.
        advance(45 * MIN); await g.breaks();
        const h = await free();
        await strict(h, strictConfig({ flexible: { enabled: true, minimum: 30 } }));
        const started = (await h.breaks({ action: 'flex_start', mode: 'preset', minutes: 60, operation_id: op() })).body;
        advance(35 * MIN); await h.breaks({ action: 'flex_end', break_id: started.flexible.active.id });
        assert.equal((await h.breaks()).body.flexible.gap_until, now() + 30 * MIN);
    } finally { clock = null; }
});
test('the daily maximum defaults to 3 hours and accepts 1–3 hours in 15-minute steps', async () => {
    try {
        const f = await free();
        const view = (await f.breaks()).body;
        assert.equal(view.allowance.total, 180); assert.equal(view.strict.config.allowance, 180);
        assert.deepEqual([view.strict.limits.allowanceMin, view.strict.limits.allowanceMax, view.strict.limits.allowanceStep], [60, 180, 15]);
        for (const allowance of [45, 59, 70, 181, 195, 90.5, '120'])
            assert.equal((await strict(f, strictConfig({ allowance }))).body.code, 'INVALID_ALLOWANCE', String(allowance));
        for (const allowance of [60, 75, 165, 180]) {
            const saved = await strict(f, strictConfig({ allowance }));
            assert.equal(saved.status, 200); assert.equal(saved.body.allowance.total, allowance, 'no system yet: applies today');
            assert.equal(saved.body.strict.config.allowance, allowance);
        }
        // An older page that sends no maximum keeps the saved one.
        await strict(f, strictConfig({ allowance: 90 }));
        assert.equal((await strict(f, strictConfig({ flexible: { enabled: true, minimum: 30 } }))).body.allowance.total, 90);
    } finally { clock = null; }
});
test('a lower maximum limits Flexible and Scheduled; strict minimum and the 10-minute rule are unchanged', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ allowance: 60 }));
        let view = (await f.breaks()).body;
        assert.equal(view.allowance.remaining, 60); assert.equal(view.flexible.max_custom, 60); assert.equal(view.flexible.minimum, 10);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 61, operation_id: op() })).body.code, 'INVALID_DURATION');
        const started = (await f.breaks({ action: 'flex_start', mode: 'until', operation_id: op() })).body;
        assert.equal(started.flexible.active.minutes, 60); assert.equal(started.flexible.active.can_end_at, now() + 10 * MIN);
        advance(60 * MIN);
        view = (await f.breaks()).body;
        assert.equal(view.allowance.used, 60); assert.equal(view.allowance.remaining, 0); assert.equal(view.flexible.can_start, false);
        const g = await free();
        await strict(g, strictConfig({ allowance: 75 }));
        await g.breaks({ action: 'plan_start' });
        const over = await g.breaks({ action: 'schedule_save', breaks: [{ start: '13:00', end: '14:00' }, { start: '15:00', end: '15:30' }] });
        assert.equal(over.status, 400); assert.match(over.body.error, /daily maximum of 1h 15m/);
        assert.equal((await g.breaks({ action: 'schedule_save', breaks: [{ start: '13:00', end: '14:15' }] })).status, 200);
        // Strict plans obey the maximum they are saved with.
        const h = await free();
        assert.equal((await strict(h, strictConfig({ allowance: 60, scheduled: { enabled: true, default: [{ start: '13:00', end: '14:30' }] } }))).body.code, 'INVALID_STRICT');
        assert.equal((await strict(h, strictConfig({ allowance: 60, flexible: { enabled: true, minimum: 60 } }))).status, 200, 'minimum may equal the maximum');
    } finally { clock = null; }
});
test('a day keeps the maximum it was locked with; changes after a lock apply from the next day', async () => {
    try {
        const f = await free();
        await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() });
        const saved = await strict(f, strictConfig({ allowance: 60 }));
        assert.equal(saved.body.strict.pending_from, '2026-11-05'); assert.equal(saved.body.allowance.total, 180);
        assert.equal((await f.breaks()).body.allowance.total, 180);
        at('2026-11-05T09:00:00+03:00');
        assert.equal((await f.breaks()).body.allowance.total, 60);
        assert.equal((await f.storage.get('breaks:day:user_A:2026-11-04')).allowance, 180, 'the locked day stored its maximum');
    } finally { clock = null; }
});

test('Flexible use and an unlocked schedule share the daily allowance', async () => {
    try {
        const f = await ready();
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).status, 200);
        advance(30 * MIN);
        assert.equal((await f.breaks({ action: 'plan_start' })).status, 200);
        const saved = await f.breaks({ action: 'schedule_save', breaks: [{ start: '14:00', end: '16:00' }] });
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.body.allowance, { total: 180, used: 30, reserved: 120, remaining: 30 });
        assert.equal(saved.body.scheduled.locked, false);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).status, 200);
    } finally { clock = null; }
});

test('strict minimum rejects unsaved schedules and cancellation resets the window', async () => {
    try {
        const f = await free();
        await strict(f, strictConfig({ allowance: 120, flexible: { enabled: true, minimum: 60 } }));
        await f.breaks({ action: 'plan_start' });
        const rejected = await f.breaks({ action: 'schedule_save', breaks: [{ start: '14:00', end: '15:30' }] });
        assert.equal(rejected.body.code, 'STRICT_MINIMUM');
        assert.equal((await f.breaks()).body.scheduled.saved, false);
        await f.breaks({ action: 'plan_cancel' }); advance(MIN);
        const restarted = await f.breaks({ action: 'plan_start' });
        assert.equal(restarted.body.scheduled.planning.deadline, now() + 10 * MIN);
        const saved = await f.breaks({ action: 'schedule_save', breaks: [{ start: '14:00', end: '15:00' }] });
        assert.equal(saved.status, 200); assert.equal(saved.body.allowance.remaining, 60);
    } finally { clock = null; }
});

test('window started before cutoff stays editable after cutoff; lock blocks Flexible immediately', async () => {
    try {
        const f = await ready('2026-11-04T17:59:00+03:00');
        await f.breaks({ action: 'plan_start' }); advance(2 * MIN);
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: [{ start: '19:00', end: '19:30' }] })).status, 200);
        assert.equal((await f.breaks({ action: 'lock', system: 'scheduled' })).body.scheduled.locked, true);
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).body.code, 'SYSTEM_LOCKED');
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: [{ start: '20:00', end: '20:30' }] })).status, 200);
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// Reserved breaks (a Scheduled sub-feature)
// ---------------------------------------------------------------------------
async function planned(reserved, breaks = [{ start: '14:00', end: '14:30' }]) {
    const f = await ready();
    await f.breaks({ action: 'plan_start' }); advance(MIN);
    const saved = await f.breaks({ action: 'schedule_save', breaks, reserved });
    return { f, saved };
}
test('reserved break: the whole amount is reserved from the allowance; start only inside the window', async () => {
    try {
        const { f, saved } = await planned([{ minutes: 60, from: '13:00', to: '13:30' }]);
        assert.equal(saved.status, 200);
        assert.equal(saved.body.allowance.reserved, 30 + 60, 'scheduled + reserved minutes');
        assert.equal(saved.body.reserved_breaks[0].state, 'pending');
        const id = saved.body.reserved_breaks[0].id;
        advance(4 * MIN);
        assert.equal((await f.breaks({ action: 'reserved_start', id, operation_id: op() })).body.code, 'PLANNING_OPEN');
        advance(10 * MIN);
        assert.equal((await f.breaks({ action: 'reserved_start', id, operation_id: op() })).body.code, 'RESERVED_EARLY');
        at('2026-11-04T13:20:00+03:00');
        const view = (await f.breaks()).body;
        assert.equal(view.reserved_breaks[0].state, 'open'); assert.equal(view.reserved_breaks[0].can_start, true);
        const o = op();
        const started = await f.breaks({ action: 'reserved_start', id, operation_id: o });
        assert.equal(started.status, 200); assert.equal(started.body.in_break, true);
        assert.equal((await f.breaks({ action: 'reserved_start', id, operation_id: o })).body.reserved_breaks[0].started_at !== null, true, 'a retry is harmless');
        assert.equal((await f.breaks({ action: 'reserved_start', id, operation_id: op() })).body.code, 'RESERVED_USED');
        assert.equal((await f.breaks({ action: 'flex_start', mode: 'custom', minutes: 10, operation_id: op() })).status, 409, 'no Flexible break during a reserved break');
    } finally { clock = null; }
});
test('reserved break cut by a Scheduled break: the remainder is revoked for the day', async () => {
    try {
        const { f, saved } = await planned([{ minutes: 60, from: '13:00', to: '13:30' }]);
        const id = saved.body.reserved_breaks[0].id;
        at('2026-11-04T13:20:00+03:00');
        const r = (await f.breaks({ action: 'reserved_start', id, operation_id: op() })).body.reserved_breaks[0];
        assert.equal(r.granted_minutes, 40); assert.equal(r.clipped, true);
        assert.equal(r.ends_at, Date.parse('2026-11-04T14:00:00+03:00'));
        at('2026-11-04T14:00:00+03:00');
        const after = (await f.breaks()).body;
        assert.equal(after.in_break, true, 'the Scheduled break starts right after');
        assert.equal(after.allowance.remaining, 180 - 30 - 60, 'the revoked 20 minutes are not refunded');
    } finally { clock = null; }
});
test('a reserved break that is not started inside its window is lost, and its allowance stays spent', async () => {
    try {
        const { f, saved } = await planned([{ minutes: 45, from: '13:00', to: '13:30' }]);
        const id = saved.body.reserved_breaks[0].id;
        at('2026-11-04T13:30:00+03:00');
        const view = (await f.breaks()).body;
        assert.equal(view.reserved_breaks[0].state, 'missed');
        assert.equal((await f.breaks({ action: 'reserved_start', id, operation_id: op() })).body.code, 'RESERVED_MISSED');
        assert.equal(view.allowance.remaining, 180 - 30 - 45);
    } finally { clock = null; }
});
test('reserved windows cannot overlap Scheduled breaks or each other; amounts must fit; same planning window', async () => {
    try {
        const { f } = await planned([]);
        const bad = async reserved => (await f.breaks({ action: 'schedule_save', breaks: [{ start: '14:00', end: '14:30' }], reserved })).body.code;
        assert.equal(await bad([{ minutes: 30, from: '14:10', to: '14:20' }]), 'RESERVED_CONFLICT');
        assert.equal(await bad([{ minutes: 30, from: '13:00', to: '13:30' }, { minutes: 30, from: '13:20', to: '13:50' }]), 'RESERVED_CONFLICT');
        assert.equal(await bad([{ minutes: 7, from: '13:00', to: '13:30' }]), 'INVALID_RESERVED');
        assert.equal(await bad([{ minutes: 30, from: '13:00', to: '13:02' }]), 'INVALID_RESERVED');
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: [{ start: '14:00', end: '14:30' }], reserved: [{ minutes: 170, from: '16:00', to: '16:30' }] })).status >= 400, true, 'over the allowance');
        advance(10 * MIN);
        assert.equal((await f.breaks({ action: 'schedule_save', breaks: [], reserved: [{ minutes: 30, from: '16:00', to: '16:30' }] })).body.code, 'PLANNING_ENDED', 'no extra time for reserved breaks');
    } finally { clock = null; }
});
test('a reserved-only schedule is allowed; the phone sees in_break during a reserved break', async () => {
    try {
        const { f, saved } = await planned([{ minutes: 30, from: '13:00', to: '13:30' }], []);
        assert.equal(saved.status, 200); assert.equal(saved.body.scheduled.breaks.length, 0);
        const id = saved.body.reserved_breaks[0].id;
        at('2026-11-04T13:10:00+03:00');
        await f.breaks({ action: 'reserved_start', id, operation_id: op() });
        const s = await f.status(await f.phone());
        assert.equal(s.in_break, true);
        at('2026-11-04T13:41:00+03:00');
        assert.equal((await f.status(await f.phone())).in_break, false);
    } finally { clock = null; }
});

// ---------------------------------------------------------------------------
// Phase 2.3: phone-lock counting modes (harsh / normal / limited)
// ---------------------------------------------------------------------------
const SC = globalThis.TaskitatorStatusCount;
const tk = (id, extra = {}) => ({ id, title: id, status: 'active', due_date: 'today', ...extra });
test('status modes: which tasks lock the phone', () => {
    const day = '2026-11-04', tasks = [tk('a'), tk('b', { status_count: false }), tk('ai', { ai_locked: true, status_count: false })];
    const locked = (list, mode) => SC.unfinished(list, { status_mode: mode }, day);
    assert.equal(locked([tk('b', { status_count: false })], 'harsh'), true, 'harsh counts everything due today');
    assert.equal(locked([tk('b', { status_count: false })], undefined), true, 'harsh is the default');
    assert.equal(locked([tk('b', { status_count: false })], 'normal'), false, 'unchecked task does not count in normal');
    assert.equal(locked([tk('a')], 'normal'), true, 'no flag means counted');
    assert.equal(locked([tk('a')], 'limited'), false, 'limited ignores ordinary tasks');
    for (const m of ['harsh', 'normal', 'limited']) assert.equal(locked([tasks[2]], m), true, 'AI-locked tasks count in ' + m);
    assert.equal(locked([tk('x', { due_date: '2026-11-05' })], 'harsh'), false, 'future tasks never count');
    assert.equal(locked(['bad'], 'limited'), true, 'corrupt entries still fail closed');
});
test('status modes: subtasks follow the parent unless set by hand', () => {
    const tasks = [tk('root', { status_count: false }), tk('alpha', { parent_id: 'root' }), tk('A', { parent_id: 'alpha' }), tk('C', { parent_id: 'alpha', status_count: true }), tk('I', { parent_id: 'C' }), tk('II', { parent_id: 'C' })];
    const by = SC.index ? SC.index(tasks) : new Map(tasks.map(t => [t.id, t]));
    const eff = id => SC.effective(by, by.get(id));
    assert.deepEqual(['root', 'alpha', 'A', 'C', 'I', 'II'].map(eff), [false, false, false, true, true, true]);
    by.get('I').status_count = false;
    assert.equal(eff('I'), false, 'a hand-set child keeps its own value'); assert.equal(eff('II'), true);
    assert.equal(SC.set(tasks, ['alpha'], true), 1); assert.equal(eff('A'), true, 'untouched children follow the changed parent');
});
test('status modes: loosening detection', () => {
    const day = '2026-11-04', rec = (mode, tasks) => ({ settings: { status_mode: mode }, tasks });
    assert.match(SC.loosened(rec('harsh', [tk('a')]), rec('normal', [tk('a')]), day), /Loosening/);
    assert.equal(SC.loosened(rec('limited', [tk('a')]), rec('harsh', [tk('a')]), day), null, 'tightening is free');
    assert.match(SC.loosened(rec('normal', [tk('a')]), rec('normal', [tk('a', { status_count: false })]), day), /Unchecking/);
    assert.equal(SC.loosened(rec('normal', [tk('a')]), rec('normal', [tk('a'), tk('n', { status_count: false })]), day), null, 'new unchecked task is allowed');
    assert.equal(SC.loosened(rec('normal', [tk('f', { due_date: '2026-11-05' })]), rec('normal', [tk('f', { due_date: '2026-11-05', status_count: false })]), day), null, 'tomorrow\'s task is allowed');
    assert.match(SC.loosened(rec('normal', [tk('p'), tk('c', { parent_id: 'p' })]), rec('normal', [tk('p', { status_count: false }), tk('c', { parent_id: 'p' })]), day), /Unchecking/, 'unchecking a parent loosens its children');
});
test('status modes: server refuses loosening while today is unfinished, allows it when done or on bypass', async () => {
    at('2026-11-04T10:00:00+03:00');
    try {
        const f = await fixture(); await f.create();
        assert.equal((await f.push({ tasks: [tk('due')], settings: { status_mode: 'harsh' } })).status, 200);
        let r = await f.push({ tasks: [tk('due')], settings: { status_mode: 'normal' } });
        assert.equal(r.status, 403); assert.match(JSON.stringify(r.body), /Loosening/);
        r = await f.push({ tasks: [tk('due')], settings: { status_mode: 'harsh' } }); assert.equal(r.status, 200);
        // Tightening is allowed while locked: harsh -> harsh with an added flag, and limited -> harsh below.
        await f.storage.put('pro:emergency:user_A', { cycle_id: 'x', uses_left: 3, active_until_ms: now() + 10 * MIN, reset_at: now() + 86400000 });
        r = await f.push({ tasks: [tk('due')], settings: { status_mode: 'limited' } }); assert.equal(r.status, 200, 'bypass allows loosening');
        await f.storage.delete('pro:emergency:user_A');
        r = await f.push({ tasks: [tk('due')], settings: { status_mode: 'harsh' } }); assert.equal(r.status, 200, 'tightening is always allowed');
        r = await f.push({ tasks: [tk('due', { status: 'completed' })], settings: { status_mode: 'harsh' } }); assert.equal(r.status, 200);
        r = await f.push({ tasks: [tk('due', { status: 'completed' })], settings: { status_mode: 'limited' } }); assert.equal(r.status, 200, 'allowed once today is finished');
        // An active break does not unlock the settings.
        r = await f.push({ tasks: [tk('due2')], settings: { status_mode: 'limited' } }); assert.equal(r.status, 200);
    } finally { clock = null; }
});
test('status modes: /status honours the mode and keeps AI locks', async () => {
    at('2026-11-04T10:00:00+03:00');
    try {
        const f = await fixture(); await f.create();
        const token = await f.phone();
        assert.equal((await f.push({ tasks: [tk('due')], settings: { status_mode: 'harsh' } })).status, 200);
        assert.equal((await f.status(token)).device_locked, true);
        await f.push({ tasks: [tk('due', { status: 'completed' })], settings: { status_mode: 'harsh' } });
        await f.push({ tasks: [tk('due', { status: 'completed' }), tk('x')], settings: { status_mode: 'limited' } });
        assert.equal((await f.status(token)).device_locked, false, 'limited: an ordinary task does not lock');
        await f.push({ tasks: [tk('due', { status: 'completed' }), tk('x'), tk('ai', { ai_locked: true })], settings: { status_mode: 'limited' } });
        assert.equal((await f.status(token)).device_locked, true, 'limited: an AI-locked task locks');
    } finally { clock = null; }
});

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
            const expected = bypass ? true : sleep ? false : universe ? false : finished;
            assert.equal(s.device_unlocked, expected);
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
test('viewing state locks nothing; Lock for Today selects a system without using allowance', async () => {
    try {
        for (const system of ['scheduled', 'flexible']) {
            const f = await ready();
            const view = await f.breaks();
            assert.equal(view.status, 200); assert.equal(view.body.system, null);
            assert.equal(view.body.allowance.remaining, 180);
            assert.equal(view.body.reset_at, '2026-11-04T21:00:00.000Z');
            const locked = await f.breaks({ action: 'lock', system });
            assert.equal(locked.status, 200); assert.equal(locked.body.system, system); assert.equal(locked.body.lock_source, 'lock');
            assert.equal(locked.body.allowance.used, 0); assert.equal(locked.body.flexible.active, null);
            assert.equal(locked.body.scheduled.planning, null);
            assert.equal((await f.breaks({ action: 'lock', system })).status, 200, 'repeating the same lock is harmless');
            const other = system === 'scheduled' ? 'flexible' : 'scheduled';
            assert.equal((await f.breaks({ action: 'lock', system: other })).body.code, 'SYSTEM_LOCKED');
            if (system === 'scheduled') assert.equal((await f.breaks({ action: 'flex_start', mode: 'preset', minutes: 30, operation_id: op() })).status, 409);
            else assert.equal((await f.breaks({ action: 'plan_start' })).body.code, 'SYSTEM_LOCKED');
            // A fresh Worker instance (restart) on the same storage keeps the lock.
            const restarted = new TaskitatorSync({ storage: f.storage }, f.env);
            assert.equal((await restarted.breaks.state('user_A', 'Asia/Riyadh')).system, system);
        }
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
        assert.equal(view.flexible.can_start, false);
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
            assert.equal(s.device_unlocked, bypass ? true : !sleep, 'breaks override Universe locks but not Sleep Lock');
            assert.equal((await f.breaks()).body.allowance.used, before, 'status and bypass do not change break usage');
            at('2026-11-04T10:40:00+03:00');
            const later = await f.status(await f.phone());
            assert.equal(later.in_break, false);
            assert.equal(later.device_unlocked, bypass && now() < Date.parse('2026-11-04T10:15:00+03:00'));
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
        const same = await f.breaks({ action: 'lock', system: 'flexible', timezone: 'Pacific/Kiritimati' });
        assert.equal(same.body.date, '2026-11-04'); assert.equal(same.body.allowance.used, 60); assert.equal(same.body.reset_at, '2026-11-04T21:00:00.000Z');
        // The next day starts where this one ended, even with a later day start.
        at('2026-11-05T00:30:00+03:00');
        const next = (await f.breaks({ action: 'lock', system: 'scheduled' })).body;
        assert.equal(next.date, '2026-11-05'); assert.equal(next.cycle_start, Date.parse('2026-11-05T00:00:00+03:00'));
        assert.equal(next.reset_at, '2026-11-06T01:00:00.000Z');
        // Switching timezone cannot shorten the following day below 20 hours.
        at('2026-11-06T04:30:00+03:00');
        const after = (await f.breaks({ action: 'lock', system: 'flexible', timezone: 'Pacific/Kiritimati' })).body;
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
        await f.breaks({ action: 'lock', system: 'flexible' });
        assert.ok([...f.storage.map.keys()].some(k => k.startsWith('breaks:')));
        await f.service.breaks.remove(f.storage, 'user_A');
        assert.ok(![...f.storage.map.keys()].some(k => k.startsWith('breaks:')));
    } finally { clock = null; }
});

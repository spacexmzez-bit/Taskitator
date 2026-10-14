// File: cloudflare/worker.js 
import '../recurrence-core.js';
import { SecurityError, allowedOrigins, verifySession, verifiedEmail, sha256 as authHash, randomPhoneToken } from './auth.js';
const Recurrence = globalThis.TaskitatorRecurrence;
// Taskitator transactional sync. Required: TASKITATOR_SYNC (Durable Object).
// Keep TASKITATOR_KV bound for one-time migration of existing accounts.
// New reads and writes use Durable Object storage exclusively.
const CORS = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-ID',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
};
const DAY = 86400000;
const OFFSET = 3 * 3600000; // Riyadh UTC+3, matching the original Worker.
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
});
class HTTPError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
function dayHour(settings) {
    const hour = Number.parseInt(settings?.day_start_hour, 10);
    return Number.isInteger(hour) && hour >= 0 && hour <= 4 ? hour : 0;
}
function logicalDate(time, hour) {
    return new Date(time + OFFSET - hour * 3600000).toISOString().slice(0, 10);
}
function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
    // Require an explicit timezone; avoid interpreting ambiguous local timestamps.
    return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
        ? Date.parse(value) : NaN;
}
function minutes(value) {
    if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return NaN;
    const [h, m] = value.split(':').map(Number);
    return h < 24 && m < 60 ? h * 60 + m : NaN;
}
function withinBreak(b, date, hour, now) {
    if (!object(b)) return false;
    const isoStart = timestamp(b.start), isoEnd = timestamp(b.end);
    if (Number.isFinite(isoStart) && Number.isFinite(isoEnd)) {
        return isoEnd > isoStart && now >= isoStart && now < isoEnd;
    }
    const startMinute = minutes(b.start), endMinute = minutes(b.end);
    if (!validDate(date) || !Number.isFinite(startMinute) || !Number.isFinite(endMinute) ||
        startMinute === endMinute) return false;
    const midnight = Date.parse(`${date}T00:00:00+03:00`);
    const start = midnight + startMinute * 60000 + (startMinute < hour * 60 ? DAY : 0);
    let end = midnight + endMinute * 60000 + (endMinute < hour * 60 ? DAY : 0);
    if (end <= start) end += DAY;
    return now >= start && now < end;
}
export function evaluateStatus(record, now = Date.now()) {
    if (!record) return { status: 'ok', device_unlocked: true, finished: true,
        in_break: false, message: 'No tasks configured; unlocked by default.' };
    if (!object(record) || !Array.isArray(record.tasks)) {
        throw new HTTPError(500, 'Stored task snapshot is malformed. Restore a valid snapshot.');
    }
    const hour = dayHour(record.settings);
    const today = logicalDate(now, hour);
    const unfinished = record.tasks.some(task => {
        if (!object(task)) return true; // Corrupt entries must not silently unlock.
        if (task.status !== 'active') return false;
        const due = typeof task.due_date === 'string' ? task.due_date.trim().toLowerCase() : '';
        // Preserve the original behavior for undated tasks; include overdue dates.
        return !due || due === 'today' || (validDate(due) && due <= today);
    });
    const raw = record.today_breaks;
    let breaks = [], defaultDate;
    if (Array.isArray(raw)) {
        breaks = raw;
        const saved = timestamp(record.updated_at);
        defaultDate = Number.isFinite(saved) ? logicalDate(saved, hour) : undefined;
    } else if (object(raw)) {
        // Settings uploads can contain the frontend's date-keyed break store.
        for (const [date, entry] of Object.entries(raw)) {
            if (!validDate(date)) continue;
            const entries = Array.isArray(entry) ? entry : entry?.breaks;
            if (Array.isArray(entries)) breaks.push(...entries.map(b => object(b) ? { ...b, date } : b));
        }
    }
    const inBreak = breaks.some(b => withinBreak(b, b?.date || defaultDate, hour, now));
    return { status: 'ok', device_unlocked: !unfinished || inBreak,
        finished: !unfinished, in_break: inBreak };
}
function publicRecord(record) {
    if (!object(record)) return record;
    const result = { ...record };
    // The client already has its bearer credential; do not echo it in snapshots.
    if (object(result.settings)) {
        result.settings = { ...result.settings };
        for (const key of ['worker_passkey', 'session_token', 'phone_token', 'macro_token', 'auth_user_id']) delete result.settings[key];
    }
    delete result.force;
    delete result.base_version;
    delete result.mutation_id;
    delete result.new_token;
    delete result.rotation_id;
    delete result.snapshot;
    return result;
}

const CHUNK_CHARS = 24576; // Safely below the 128 KiB storage-value limit.
const accountKey = user => `account:${encodeURIComponent(user)}`;
const tokenKey = digest => `credential:${digest}`;
const chunkKey = (user, index) => `snapshot:${encodeURIComponent(user)}:${index}`;
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value)
)), byte => byte.toString(16).padStart(2, '0')).join('');
const cleanToken = token => /^[a-fA-F0-9]{64}$/.test(token) ? token.toLowerCase() : token;

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
    if (Number(request.headers.get('Content-Length')) > maxBytes) {
        throw new HTTPError(413, 'Request payload is too large.');
    }
    if (!request.body) throw new HTTPError(400, 'JSON body required.');
    const reader = request.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new HTTPError(413, 'Request payload is too large.');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(text); } catch { throw new HTTPError(400, 'Invalid JSON.'); }
    if (!object(body)) throw new HTTPError(400, 'JSON object required.');
    return body;
}

function validateUser(user) {
    if (!user || new TextEncoder().encode(user).length > 240 || /[\x00-\x1f\x7f]/.test(user)) {
        throw new HTTPError(400, 'A valid X-Taskitator-User header is required.');
    }
}

function validateVersion(body) {
    if (!Number.isSafeInteger(body.base_version) || body.base_version < 0) {
        throw new HTTPError(428, 'Update the sync engine: base_version is required.');
    }
}

function validateSnapshot(body, user) {
    if (!Array.isArray(body.tasks) || body.tasks.some(t => !object(t))) {
        throw new HTTPError(400, 'tasks must be an array of objects.');
    }
    if (body.username != null && (typeof body.username !== 'string' || body.username.trim().toLowerCase() !== user)) {
        throw new HTTPError(400, 'Payload username does not match the authenticated account.');
    }
    if (body.settings !== undefined && !object(body.settings)) throw new HTTPError(400, 'Invalid settings.');
    if (body.today_breaks !== undefined && !Array.isArray(body.today_breaks) && !object(body.today_breaks)) {
        throw new HTTPError(400, 'Invalid break records.');
    }
    if (typeof body.mutation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.mutation_id)) {
        throw new HTTPError(428, 'Update the sync engine: mutation_id is required.');
    }
    if (body.recurrence_state !== undefined) {
        try { Recurrence.validateState(body.recurrence_state, body.tasks); }
        catch (err) { throw new HTTPError(400, err.message); }
    }
    return publicRecord({ ...body, username: user });
}

async function loadSnapshot(storage, user, meta) {
    if (!meta.has_snapshot) return null;
    const parts = [];
    for (let i = 0; i < meta.chunks; i += 128) {
        const keys = Array.from({ length: Math.min(128, meta.chunks - i) }, (_, j) => chunkKey(user, i + j));
        const values = await storage.get(keys);
        for (const key of keys) {
            if (typeof values.get(key) !== 'string') throw new HTTPError(503, 'Stored snapshot is incomplete.');
            parts.push(values.get(key));
        }
    }
    const record = JSON.parse(parts.join(''));
    return { ...record, version: meta.version, saved_at: meta.saved_at };
}

async function saveSnapshot(storage, user, meta, record) {
    const text = JSON.stringify(record), count = Math.ceil(text.length / CHUNK_CHARS);
    for (let i = 0; i < count; i += 128) {
        const entries = {};
        for (let j = i; j < Math.min(count, i + 128); j++) {
            entries[chunkKey(user, j)] = text.slice(j * CHUNK_CHARS, (j + 1) * CHUNK_CHARS);
        }
        await storage.put(entries);
    }
    for (let i = count; i < (meta.chunks || 0); i += 128) {
        await storage.delete(Array.from({ length: Math.min(128, meta.chunks - i) }, (_, j) => chunkKey(user, i + j)));
    }
    meta.chunks = count;
    meta.has_snapshot = true;
}

function conflict(version) {
    return json({ error: 'Another device changed this account. Your local edits have not been uploaded.',
        conflict: true, remote_version: version }, 409);
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin');
        if (origin && !allowedOrigins(env).includes(origin)) return json({ error: 'Origin is not allowed.' }, 403);
        let response;
        if (request.method === 'OPTIONS') response = new Response(null, { status: 204, headers: CORS });
        else if (!env.TASKITATOR_SYNC) response = json({ error: 'TASKITATOR_SYNC Durable Object binding is required.' }, 503);
        else {
            const id = env.TASKITATOR_SYNC.idFromName('taskitator-v1');
            try { response = await env.TASKITATOR_SYNC.get(id).fetch(request); }
            catch { response = json({ error: 'Sync service unavailable. Local edits were retained; retry shortly.' }, 503); }
        }
        const headers = new Headers(response.headers);
        if (origin) headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        return new Response(response.body, { status: response.status, headers });
    }
};

export class TaskitatorSync {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;
    }

    async importAccount(user, token, digest) {
        if (await this.storage.get(accountKey(user))) return;
        if (!this.env.TASKITATOR_KV) throw new HTTPError(503, 'Keep TASKITATOR_KV bound for account migration.');
        // Read legacy KV only when this account has never been imported.
        // No writes or deletes are made to the legacy namespace.
        let registration = null, record = null;
        if (this.env.TASKITATOR_KV) {
            [registration, record] = await Promise.all([
                this.env.TASKITATOR_KV.get(`user_reg:${user}`, { type: 'json' }),
                this.env.TASKITATOR_KV.get(`user_data:${token}`, { type: 'json' })
            ]);
        }
        const legacyToken = typeof registration === 'string' ? registration : registration?.token_hash;
        if (!registration && !record) throw new HTTPError(401, 'Existing account could not be verified.');
        if (registration && cleanToken(String(legacyToken || '')) !== token) throw new HTTPError(401, 'Incorrect credentials.');
        const owner = record?.username || record?.settings?.worker_username;
        if (record && (typeof owner !== 'string' || owner.trim().toLowerCase() !== user)) {
            throw new HTTPError(401, 'Legacy data does not belong to this username.');
        }
        if (record && (!object(record) || !Array.isArray(record.tasks))) {
            throw new HTTPError(503, 'Legacy snapshot is malformed; restore a backup before migration.');
        }
        await this.storage.transaction(async tx => {
            if (await tx.get(accountKey(user))) return;
            const occupied = await tx.get(tokenKey(digest));
            if (occupied) throw new HTTPError(401, 'Credential already belongs to an account.');
            const meta = {
                user, digest, version: record ? (Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 1) : 0,
                created_at: registration?.created_at || new Date().toISOString(),
                saved_at: record?.saved_at || new Date().toISOString(),
                has_snapshot: false, chunks: 0
            };
            if (record) await saveSnapshot(tx, user, meta, publicRecord(record));
            await tx.put(accountKey(user), meta);
            await tx.put(tokenKey(digest), { user, revoked: false });
        });
    }

    async rateLimit(request, scope = 'api', max = 240) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        await this.rateBucket(scope + ':' + await authHash(ip), max);
    }

    async rateBucket(key, max) {
        await this.storage.transaction(async tx => {
            const now = Date.now(), storageKey = 'rate:' + key;
            let entry = await tx.get(storageKey);
            if (!entry || entry.expires <= now) entry = { count: 0, expires: now + 60000 };
            if (entry.count >= max) throw new HTTPError(429, 'Too many attempts. Wait one minute and try again.');
            entry.count++;
            await tx.put(storageKey, entry);
        });
        if (this.storage.getAlarm && !(await this.storage.getAlarm())) await this.storage.setAlarm(Date.now() + 3600000);
    }

    async alarm() {
        let after;
        while (true) {
            const entries = await this.storage.list({ prefix: 'rate:', limit: 1000, ...(after ? {startAfter: after} : {}) });
            if (!entries.size) break;
            const expired = [...entries].filter(([, value]) => value.expires <= Date.now()).map(([key]) => key);
            if (expired.length) await this.storage.delete(expired);
            after = [...entries.keys()].pop();
            if (entries.size < 1000) break;
        }
        await this.storage.setAlarm(Date.now() + 3600000);
    }

    async accountFor(identity) {
        const link = await this.storage.get('identity:' + identity.userId);
        if (!link) return null;
        const meta = await this.storage.get(accountKey(link.user));
        if (!meta || meta.owner_id !== identity.userId) throw new HTTPError(403, 'Account ownership could not be verified.');
        return link;
    }

    async connectAccount(request, identity) {
        await this.rateLimit(request, 'connect', 8);
        await this.rateBucket('connect-user:' + identity.userId, 8);
        const body = await readJson(request, 8192);
        const existing = await this.accountFor(identity);
        if (existing) return json({ success: true, account: existing });
        const email = await verifiedEmail(this.env, identity.userId);
        if (body.mode === 'create') {
            const user = 'clerk:' + await authHash(identity.userId);
            const link = { user, display_name: email, user_id: identity.userId };
            await this.storage.transaction(async tx => {
                if (await tx.get('identity:' + identity.userId)) return;
                if (await tx.get(accountKey(user))) throw new HTTPError(409, 'Account identifier is already occupied. Contact the app owner.');
                await tx.put(accountKey(user), { user, owner_id: identity.userId, version: 0,
                    created_at: new Date().toISOString(), saved_at: new Date().toISOString(), has_snapshot: false, chunks: 0 });
                await tx.put('identity:' + identity.userId, link);
            });
            return json({ success: true, account: await this.accountFor(identity) });
        }
        if (body.mode !== 'migrate') throw new HTTPError(400, 'Choose an existing or a new account.');
        const user = String(body.username || '').trim().toLowerCase();
        validateUser(user);
        if (typeof body.password !== 'string' || !body.password || body.password.length > 1024) {
            throw new HTTPError(401, 'Existing account could not be verified.');
        }
        // Administrator-prepared email ownership map stops a stolen legacy bearer
        // credential from being enough to claim an account during migration.
        let owners;
        try { owners = JSON.parse(this.env.LEGACY_MIGRATION_OWNERS || '{}'); }
        catch { throw new HTTPError(503, 'Legacy migration ownership settings are invalid.'); }
        if (!object(owners) || !Object.hasOwn(owners, user) || String(owners[user]).trim().toLowerCase() !== email) {
            throw new HTTPError(403, 'This account is not approved for migration to your verified email. Ask the app owner to check migration settings.');
        }
        const deadline = Date.parse(this.env.LEGACY_MIGRATION_UNTIL || '');
        if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new HTTPError(403, 'Legacy migration is closed. Ask the app owner for assistance.');
        const token = await authHash(user + ':' + body.password.trim() + ':taskitator-client-v1');
        const digest = await authHash(token);
        await this.importAccount(user, token, digest);
        await this.storage.transaction(async tx => {
            const linked = await tx.get('identity:' + identity.userId);
            if (linked) {
                if (linked.user !== user) throw new HTTPError(409, 'This login is already connected to another account.');
                return;
            }
            const meta = await tx.get(accountKey(user));
            if (!meta || meta.digest !== digest || (meta.owner_id && meta.owner_id !== identity.userId)) {
                throw new HTTPError(401, 'Existing account could not be verified.');
            }
            meta.owner_id = identity.userId;
            meta.legacy_disabled = true;
            delete meta.digest;
            delete meta.rotation;
            await tx.put(tokenKey(digest), { user, revoked: true });
            await tx.put(accountKey(user), meta);
            await tx.put('identity:' + identity.userId, { user, display_name: user, user_id: identity.userId });
        });
        return json({ success: true, account: await this.accountFor(identity) });
    }

    async phoneAccess(request, user) {
        const key = 'phone-owner:' + encodeURIComponent(user);
        if (request.method === 'GET') {
            const current = await this.storage.get(key);
            return json({ active: Boolean(current), created_at: current?.created_at || null });
        }
        await this.rateLimit(request, 'phone-admin', 10);
        const token = request.method === 'POST' ? randomPhoneToken() : null;
        const digest = token ? await authHash(token) : null;
        const created_at = new Date().toISOString();
        await this.storage.transaction(async tx => {
            const previous = await tx.get(key);
            if (previous) await tx.delete('phone:' + previous.digest);
            await tx.delete(key);
            if (token) {
                await tx.put('phone:' + digest, { user, scope: 'status' });
                await tx.put(key, { digest, created_at });
            }
        });
        return json({ success: true, ...(token ? { token, created_at } : {}) });
    }

    async fetch(request) {
        try {
            const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
            const method = request.method;
            if (!['GET', 'POST', 'DELETE'].includes(method)) return json({ error: 'Method not allowed.' }, 405);
            if (request.headers.get('Origin') && !allowedOrigins(this.env).includes(request.headers.get('Origin'))) {
                throw new HTTPError(403, 'Origin is not allowed.');
            }
            const status = method === 'GET' && (path === '/status' ||
                (url.searchParams.get('action') === 'status' && ['/', '/sync/pull'].includes(path)));
            const pull = method === 'GET' && ['/', '/sync/pull'].includes(path) && !status;
            const push = method === 'POST' && ['/', '/sync/push'].includes(path);
            const bridge = method === 'GET' && path === '/sync/bridge/mrstudy-rules';
            const me = method === 'GET' && path === '/auth/me';
            const connect = method === 'POST' && path === '/auth/account';
            const phoneAdmin = ['GET', 'POST', 'DELETE'].includes(method) && path === '/auth/phone';
            if (!status && !pull && !push && !bridge && !me && !connect && !phoneAdmin) {
                return json({ error: 'Endpoint not found. Password changes are managed through your account profile.' }, 404);
            }
            await this.rateLimit(request);
            const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') || '')?.[1];
            if (!token) throw new HTTPError(401, 'Sign in to continue.');
            let user, identity;
            if (/^tkp_[a-f0-9]{64}$/.test(token)) {
                if (!status) throw new HTTPError(403, 'Phone tokens can only read unlock status.');
                const access = await this.storage.get('phone:' + await authHash(token));
                if (!access || access.scope !== 'status') throw new HTTPError(401, 'Phone access was revoked or is invalid.');
                user = access.user;
            } else {
                identity = await verifySession(request, this.env, token);
                if (connect) return await this.connectAccount(request, identity);
                const account = await this.accountFor(identity);
                if (me) return json({ account });
                if (!account) throw new HTTPError(403, 'Connect your Taskitator account on the login page first.');
                user = account.user;
                if (phoneAdmin) return await this.phoneAccess(request, user);
            }
            const body = push ? await readJson(request) : null;
            if (body) validateVersion(body);
            let snapshot = null, snapshotHash = null;
            if (push) {
                snapshot = validateSnapshot(body, user);
                snapshotHash = await sha256(JSON.stringify(snapshot));
            }

            return await this.storage.transaction(async tx => {
                const meta = await tx.get(accountKey(user));
                if (!meta || (identity && meta.owner_id !== identity.userId)) throw new HTTPError(403, 'Account access denied.');
                if (bridge) return json({ linked: false, rules: [] });
                if (status || pull) {
                    let record = await loadSnapshot(tx, user, meta);
                    if (record?.recurrence_state) {
                        const normalized=Recurrence.reconcile(record);
                        if(normalized.changed){
                            if(meta.version>=Number.MAX_SAFE_INTEGER)throw new HTTPError(503,'Account revision limit reached.');
                            meta.version++;meta.saved_at=new Date().toISOString();record.updated_at=meta.saved_at;
                            await saveSnapshot(tx,user,meta,record);await tx.put(accountKey(user),meta);
                            record={...record,version:meta.version,saved_at:meta.saved_at};
                        }
                    }
                    if (pull) return json(record || { empty: true, version: meta.version });
                    const state = evaluateStatus(record);
                    return url.searchParams.get('format') === 'text'
                        ? new Response(`device_unlocked = ${state.device_unlocked}`, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
                        : json(state);
                }
                if (push && meta.last_write?.mutation_id === body.mutation_id &&
                    meta.last_write.hash === snapshotHash && meta.last_write.base_version === body.base_version) {
                    return json({ success: true, version: meta.last_write.version ?? meta.version, updated_at: meta.last_write.saved_at || meta.saved_at });
                }
                if (body.base_version !== meta.version) return conflict(meta.version);
                if (meta.version >= Number.MAX_SAFE_INTEGER) throw new HTTPError(503, 'Account revision limit reached.');
                const now = new Date().toISOString();
                if (push) {
                    const previous = await loadSnapshot(tx, user, meta);
                    if (previous?.recurrence_state?.series?.length && body.recurrence_schema !== 1) {
                        throw new HTTPError(428, 'Refresh Taskitator on this device before syncing recurring tasks.');
                    }
                    try { Recurrence.reconcile(snapshot); }
                    catch (err) { throw new HTTPError(400, err.message); }
                    // Preserve array dates before replacing the client timestamp.
                    if (Array.isArray(snapshot.today_breaks)) {
                        const edited = timestamp(body.updated_at);
                        const date = logicalDate(Number.isFinite(edited) ? edited : Date.now(), dayHour(snapshot.settings));
                        snapshot.today_breaks = snapshot.today_breaks.map(b => object(b) ? { ...b, date: b.date || date } : b);
                    }
                    snapshot.updated_at = now;
                    await saveSnapshot(tx, user, meta, snapshot);
                    meta.version++;
                    meta.saved_at = now;
                    meta.last_write = { mutation_id: body.mutation_id, hash: snapshotHash, base_version: body.base_version, version:meta.version, saved_at:now };
                    await tx.put(accountKey(user), meta);
                    return json({ success: true, version: meta.version, updated_at: now });
                }
                throw new HTTPError(405, 'Method not allowed.');
            });
        } catch (err) {
            return json({ error: (err instanceof HTTPError || err instanceof SecurityError) ? err.message : 'Cloud storage request failed. Retry with the same operation ID.' },
                (err instanceof HTTPError || err instanceof SecurityError) ? err.status : 503);
        }
    }
}

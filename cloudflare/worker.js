// Taskitator transactional sync. Required: TASKITATOR_SYNC (Durable Object).
// Keep TASKITATOR_KV bound for one-time migration of existing accounts.
// New reads and writes use Durable Object storage exclusively.
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Taskitator-User, X-App-ID',
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
        delete result.settings.worker_passkey;
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
const RECEIPT_LIFETIME = DAY;
const accountKey = user => `account:${encodeURIComponent(user)}`;
const tokenKey = digest => `credential:${digest}`;
const chunkKey = (user, index) => `snapshot:${encodeURIComponent(user)}:${index}`;
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value)
)), byte => byte.toString(16).padStart(2, '0')).join('');
const cleanToken = token => /^[a-fA-F0-9]{64}$/.test(token) ? token.toLowerCase() : token;

async function readJson(request) {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
        throw new HTTPError(413, 'Payload exceeds 20 MiB.');
    }
    if (!request.body) throw new HTTPError(400, 'JSON body required.');
    const reader = request.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new HTTPError(413, 'Payload exceeds 20 MiB.');
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
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (!env.TASKITATOR_SYNC) {
            return json({ error: 'TASKITATOR_SYNC Durable Object binding is required. See deployment instructions.' }, 503);
        }
        // A single transactional coordinator also resolves bearer-only MacroDroid
        // requests without an eventually-consistent token lookup in KV.
        const id = env.TASKITATOR_SYNC.idFromName('taskitator-v1');
        try { return await env.TASKITATOR_SYNC.get(id).fetch(request); }
        catch { return json({ error: 'Sync service unavailable. Local edits should be retained; retry shortly.' }, 503); }
    }
};

export class TaskitatorSync {
    constructor(state, env) {
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

    async fetch(request) {
        try {
            const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
            const method = request.method;
            if (!['GET', 'POST'].includes(method)) return json({ error: 'Method not allowed.' }, 405);
            const status = method === 'GET' && url.searchParams.get('action') === 'status' && ['/', '/sync/pull', '/status'].includes(path);
            const pull = method === 'GET' && ['/', '/sync/pull'].includes(path) && !status;
            const push = method === 'POST' && ['/', '/sync/push'].includes(path);
            const rotate = method === 'POST' && path === '/sync/password-change';
            const bridge = method === 'GET' && path === '/sync/bridge/mrstudy-rules';
            if (!status && !pull && !push && !rotate && !bridge) return json({ error: 'Endpoint not found.' }, 404);
            const supplied = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') || '')?.[1];
            if (!supplied || new TextEncoder().encode(supplied).length > 240) throw new HTTPError(401, 'Missing or invalid Bearer token.');
            const token = cleanToken(supplied), digest = await sha256(token);
            let user = (request.headers.get('X-Taskitator-User') || '').trim().toLowerCase();
            if (!user && status) {
                const locator = await this.storage.get(tokenKey(digest));
                if (locator) user = locator.user;
                else if (this.env.TASKITATOR_KV) {
                    const legacy = await this.env.TASKITATOR_KV.get(`user_data:${token}`, { type: 'json' });
                    user = String(legacy?.username || legacy?.settings?.worker_username || '').trim().toLowerCase();
                }
                if (!user) throw new HTTPError(401, 'Unknown or revoked credential.');
            }
            validateUser(user);
            const body = (push || rotate) ? await readJson(request) : null;
            if (body) validateVersion(body);
            let snapshot = null, snapshotHash = null, newDigest = null;
            if (push) {
                snapshot = validateSnapshot(body, user);
                snapshotHash = await sha256(JSON.stringify(snapshot));
            }
            if (rotate) {
                if (body.username !== user || !/^[a-f0-9]{64}$/.test(body.new_token || '') || body.new_token === token) {
                    throw new HTTPError(400, 'Invalid username or new credential.');
                }
                if (typeof body.rotation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.rotation_id)) {
                    throw new HTTPError(428, 'rotation_id is required for recoverable password changes.');
                }
                newDigest = await sha256(body.new_token);
            }
            await this.importAccount(user, token, digest);

            return await this.storage.transaction(async tx => {
                const meta = await tx.get(accountKey(user));
                const receipt = meta?.rotation;
                // Old credentials can only replay the exact completed rotation.
                if (rotate && receipt && receipt.expires_at > Date.now() &&
                    receipt.old_digest === digest && receipt.new_digest === newDigest &&
                    receipt.rotation_id === body.rotation_id && receipt.base_version === body.base_version &&
                    meta.digest === newDigest) {
                    return json(receipt.response);
                }
                if (!meta || meta.digest !== digest) throw new HTTPError(401, 'Incorrect or revoked credentials.');
                if (bridge) return json({ linked: false, rules: [] });
                if (status || pull) {
                    const record = await loadSnapshot(tx, user, meta);
                    if (pull) return json(record || { empty: true, version: meta.version });
                    const state = evaluateStatus(record);
                    return url.searchParams.get('format') === 'text'
                        ? new Response(`device_unlocked = ${state.device_unlocked}`, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
                        : json(state);
                }
                if (push && meta.last_write?.mutation_id === body.mutation_id &&
                    meta.last_write.hash === snapshotHash && meta.last_write.base_version === body.base_version) {
                    return json({ success: true, version: meta.version, updated_at: meta.saved_at });
                }
                if (body.base_version !== meta.version) return conflict(meta.version);
                if (meta.version >= Number.MAX_SAFE_INTEGER) throw new HTTPError(503, 'Account revision limit reached.');
                const now = new Date().toISOString();
                if (push) {
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
                    meta.last_write = { mutation_id: body.mutation_id, hash: snapshotHash, base_version: body.base_version };
                    await tx.put(accountKey(user), meta);
                    return json({ success: true, version: meta.version, updated_at: now });
                }
                const occupied = await tx.get(tokenKey(newDigest));
                if (occupied && occupied.user !== user) throw new HTTPError(409, 'New credential belongs to another account.');
                meta.version++;
                meta.saved_at = now;
                meta.digest = newDigest;
                delete meta.last_write;
                const response = { success: true, version: meta.version, username: user,
                    rotation_id: body.rotation_id, updated_at: now };
                meta.rotation = { old_digest: digest, new_digest: newDigest,
                    rotation_id: body.rotation_id, base_version: body.base_version,
                    expires_at: Date.now() + RECEIPT_LIFETIME, response };
                await tx.put(tokenKey(digest), { user, revoked: true });
                await tx.put(tokenKey(newDigest), { user, revoked: false });
                await tx.put(accountKey(user), meta);
                return json(response);
            });
        } catch (err) {
            return json({ error: err instanceof HTTPError ? err.message : 'Cloud storage request failed. Retry with the same operation ID.' },
                err instanceof HTTPError ? err.status : 503);
        }
    }
}

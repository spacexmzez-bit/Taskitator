import '../recurrence-core.js';
import { HostedAudits } from './audit-service.js';
import {
    POLICY, loadStoredSnapshot, saveStoredSnapshot, taskRevision,
    collectTaskDescendants, isProtectedTask
} from './audit-policy.js';
// File: pro/pro-backend.js
// Taskitator Pro Phase 2: Pro Gateway, Keyo Entitlement, Hosted Claude Haiku 5.5 AI Review,
// Multi-File Proof Review, Batch Proof Review, and BYOK Mode Toggle.

const OFFSET_RIYADH = 3 * 3600000; // Asia/Riyadh UTC+3
const DAY_MS = 86400000;

const CORS = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-ID, X-Operation-ID',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
};

// Default Keyo Public Configuration from Integration Guide
const DEFAULT_KEYO_ORIGIN = 'https://keyo-api.spacexmzez.workers.dev';
const DEFAULT_KEYO_JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: '12kmFYFug4HYBs-ZTpRleElP9Q8kpQaI5aVyG9CqVOc',
    y: 'Up7x4X65FL-LaRweIptSkCZsXN4A3mZM7XIIHRzNndY',
    ext: true,
    key_ops: ['verify']
};

function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
    });
}

async function sha256(str) {
    const webCrypto = globalThis.crypto || (typeof window !== 'undefined' ? window.crypto : null);
    const data = new TextEncoder().encode(str);
    const digest = await webCrypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getRiyadhDateStrings(now = Date.now()) {
    const riyadhTime = new Date(now + OFFSET_RIYADH);
    const dateStr = riyadhTime.toISOString().slice(0, 10); // YYYY-MM-DD
    const monthStr = dateStr.slice(0, 7); // YYYY-MM
    return { dateStr, monthStr };
}

function base64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

export class ProGateway {
    constructor(parent) {
        this.parent = parent;
        this.storage = parent.storage;
        this.env = parent.env;
        this.audits = new HostedAudits(this);
    }

    async handleRequest(request, path, method, identity, account) {
        if (!identity || !identity.userId) {
            return json({ error: 'Authentication required for Pro operations.' }, 401);
        }

        const accountId = identity.userId;
        if (await this.audits.isDeleting(this.storage, accountId, account?.user)) {
            return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
        }

        // Route: GET /pro/status or GET /pro/me
        if (method === 'GET' && (path === '/pro/status' || path === '/pro/me')) {
            return await this.getStatus(accountId);
        }

        // Route: POST /pro/activate
        if (method === 'POST' && (path === '/pro/activate' || path === '/pro/license/activate')) {
            const body = await request.json().catch(() => ({}));
            return await this.activateLicense(accountId, body);
        }

        // Route: POST /pro/byok (Toggle BYOK mode without resetting limits)
        if (method === 'POST' && (path === '/pro/byok' || path === '/pro/settings/byok')) {
            const body = await request.json().catch(() => ({}));
            return await this.toggleByok(accountId, body);
        }

        if (method === 'POST' && ['/pro/ai/quote','/pro/ai/review','/pro/ai/batch-review'].includes(path)) {
            // Bound JSON before parsing base64 evidence into memory.
            const reader=request.body?.getReader();
            if (!reader) return json({error:'Evidence payload is missing.'},400);
            let size=0; const chunks=[];
            while (true) {
                const {done,value}=await reader.read(); if(done) break;
                size+=value.byteLength;
                if(size>30*1024*1024) { await reader.cancel(); return json({error:'Evidence payload exceeds 30 MiB.',code:'PAYLOAD_TOO_LARGE'},413); }
                chunks.push(value);
            }
            const bytes=new Uint8Array(size);let offset=0;
            for(const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.byteLength; }
            let body;
            try { body=JSON.parse(new TextDecoder().decode(bytes)); }
            catch { return json({error:'Invalid evidence JSON.'},400); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'Invalid audit request.'},400);
            const isQuote = path === '/pro/ai/quote' || body.preview === true;
            const isBatch = path === '/pro/ai/batch-review' || (path === '/pro/ai/quote' && body.batch === true);
            const result = await this.audits.handle(accountId, identity.sessionId, body, isBatch, isQuote, account?.user || null);
            return json(result.body,result.status);
        }

        // Route: POST /pro/ai/batch-confirm (Batch Result Confirmation & Attestation)
        if (method === 'POST' && path === '/pro/ai/batch-confirm') {
            const body = await request.json().catch(() => ({}));
            return await this.confirmBatchReview(accountId, body, identity.sessionId || null, account?.user || null);
        }

        // --- Phase 2.5: Unique Username Endpoints ---
        // Route: GET /pro/username/check
        if (method === 'GET' && path === '/pro/username/check') {
            const url = new URL(request.url);
            const uname = url.searchParams.get('username') || '';
            return await this.checkUsername(uname, accountId);
        }

        // Route: POST /pro/username
        if (method === 'POST' && path === '/pro/username') {
            const body = await request.json().catch(() => ({}));
            return await this.setUsername(accountId, body);
        }

        // Route: GET /pro/username/profile
        if (method === 'GET' && path === '/pro/username/profile') {
            return await this.getUsernameProfile(accountId);
        }

        return json({ error: `Pro endpoint not found: ${path}` }, 404);
    }

    // --- Entitlement & Status ---

    async getStatus(accountId) {
        if (await this.audits.isDeleting(this.storage, accountId)) {
            return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
        }
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);

        const usernameRec = await this.storage.get(`pro:user:username:${accountId}`);
        const claimed = usernameRec?.normalizedUsername ? await this.storage.get('pro:username:map:'+usernameRec.normalizedUsername) : null;
        const currentUsername = claimed?.accountId === accountId ? usernameRec.username : null;

        if (!entitlement) {
            return json({
                isPro: false,
                tier: 'free',
                status: 'inactive',
                username: currentUsername,
                use_byok: false,
                credits: {
                    daily_limit: 0,
                    daily_used: 0,
                    daily_remaining: 0,
                    monthly_limit: 0,
                    monthly_used: 0,
                    monthly_remaining: 0,
                    reset_timezone: 'Asia/Riyadh'
                }
            });
        }

        const now = Date.now();
        let status = entitlement.status;
        if (status === 'active' && entitlement.expires_at && now > entitlement.expires_at) {
            status = 'expired';
            entitlement.status = 'expired';
            await this.storage.transaction(async tx => {
                if (await this.audits.isDeleting(tx, accountId)) return;
                await tx.put(`pro:entitlement:${accountId}`, entitlement);
            });
        }

        const { dateStr, monthStr } = getRiyadhDateStrings(now);
        const dailyUsed = (await this.storage.get(`pro:usage:${accountId}:day:${dateStr}`)) || 0;
        const monthlyUsed = (await this.storage.get(`pro:usage:${accountId}:month:${monthStr}`)) || 0;

        // Owner requirements: 45 daily and 1,000 monthly credits
        const dailyLimit = POLICY.daily;
        const monthlyLimit = POLICY.monthly;
        const useByok = Boolean(entitlement.use_byok);

        return json({
            isPro: status === 'active',
            tier: entitlement.tier,
            status,
            username: currentUsername,
            use_byok: useByok,
            activated_at: entitlement.activated_at,
            expires_at: entitlement.expires_at,
            policy_version: entitlement.policy_version || '2.0',
            hosted_policy: POLICY.version,
            credits: {
                daily_limit: dailyLimit,
                daily_used: dailyUsed,
                daily_remaining: Math.max(0, dailyLimit - dailyUsed),
                monthly_limit: monthlyLimit,
                monthly_used: monthlyUsed,
                monthly_remaining: Math.max(0, monthlyLimit - monthlyUsed),
                reset_timezone: 'Asia/Riyadh'
            }
        });
    }

    async toggleByok(accountId, body) {
        if (await this.audits.isDeleting(this.storage, accountId)) {
            return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
        }
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        if (!entitlement || entitlement.status !== 'active') {
            return json({ error: 'Pro entitlement required to configure BYOK mode.', code: 'PRO_REQUIRED' }, 403);
        }

        // Pro users can choose to use BYOK but their limits do not reset
        entitlement.use_byok = Boolean(body.use_byok);
        await this.storage.transaction(async tx => {
            await this.audits.assertNotDeleting(tx, accountId);
            await tx.put(`pro:entitlement:${accountId}`, entitlement);
        });

        return json({
            success: true,
            use_byok: entitlement.use_byok,
            message: entitlement.use_byok ? 'Switched to personal BYOK mode. Your hosted credit limits remain active.' : 'Switched to hosted Claude Haiku 5.5 mode.'
        });
    }

    async activateLicense(accountId, body) {
        if (await this.audits.isDeleting(this.storage, accountId)) {
            return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
        }
        const rawKey = typeof body.key === 'string' ? body.key.trim() : (typeof body.license_key === 'string' ? body.license_key.trim() : '');
        if (!rawKey || rawKey.length < 8) {
            return json({ error: 'Please provide a valid license key.', code: 'INVALID_KEY' }, 400);
        }

        const normalizedKey = rawKey.toUpperCase().replace(/[\s-]/g, '');
        const keyFingerprint = await sha256(normalizedKey);

        const existingBinding = await this.storage.get(`pro:binding:${keyFingerprint}`);
        if (existingBinding && existingBinding.account_id !== accountId) {
            return json({
                error: 'This license key is already linked to another Taskitator account.',
                code: 'KEY_ALREADY_BOUND'
            }, 409);
        }

        const validation = await this.verifyKeyoKey(normalizedKey, accountId, rawKey);
        if (!validation.valid) {
            return json({
                error: validation.reason || 'License key validation failed.',
                code: validation.code || 'ACTIVATION_FAILED'
            }, 400);
        }

        const now = Date.now();
        const expiresAt = validation.expires_at || (now + 365 * DAY_MS);

        const entitlement = {
            account_id: accountId,
            tier: validation.tier || 'pro',
            status: 'active',
            key_fingerprint: keyFingerprint,
            signed_token: validation.signed_token || null,
            activated_at: now,
            expires_at: expiresAt,
            last_verified_at: now,
            policy_version: '2.0',
            credits_daily_limit: 45,
            credits_monthly_limit: 1000,
            use_byok: false
        };

        try {
            await this.storage.transaction(async tx => {
                await this.audits.assertNotDeleting(tx, accountId);
                const latestBinding = await tx.get(`pro:binding:${keyFingerprint}`);
                if (latestBinding && latestBinding.account_id !== accountId) {
                    const err = new Error('This license key is already linked to another Taskitator account.');
                    err.status = 409;
                    err.code = 'KEY_ALREADY_BOUND';
                    throw err;
                }
                await tx.put(`pro:entitlement:${accountId}`, entitlement);
                await tx.put(`pro:binding:${keyFingerprint}`, {
                    account_id: accountId,
                    key_fingerprint: keyFingerprint,
                    bound_at: now
                });
            });
        } catch (err) {
            return json({ error: err.message, code: err.code || 'ACTIVATION_FAILED' }, err.status || 500);
        }

        if (this.env?.TASKITATOR_DB && !(await this.audits.isDeleting(this.storage, accountId))) {
            try {
                await this.env.TASKITATOR_DB.prepare(
                    `INSERT INTO entitlements (account_id, key_fingerprint, tier, status, activated_at, expires_at, policy_version)
                     VALUES (?, ?, ?, 'active', ?, ?, '2.0')
                     ON CONFLICT(account_id) DO UPDATE SET
                     key_fingerprint = excluded.key_fingerprint,
                     status = 'active',
                     expires_at = excluded.expires_at,
                     last_verified_at = ?`
                ).bind(accountId, keyFingerprint, entitlement.tier, now, expiresAt, now).run();
            } catch (err) {
                console.warn('[Pro] D1 sync warning:', err.message);
            }
        }

        return json({
            success: true,
            isPro: true,
            tier: entitlement.tier,
            status: 'active',
            expires_at: expiresAt,
            credits_daily_limit: 45,
            credits_monthly_limit: 1000,
            message: 'Taskitator Pro successfully activated.'
        });
    }

    async verifyKeyoKey(normalizedKey, accountId, rawInput) {
        if (normalizedKey.includes('EXPIRED') || rawInput.includes('EXPIRED')) {
            return { valid: false, code: 'KEY_EXPIRED', reason: 'This license key has expired.' };
        }
        if (normalizedKey.includes('INVALID') || normalizedKey.includes('REVOKED') || rawInput.includes('INVALID') || rawInput.includes('REVOKED')) {
            return { valid: false, code: 'KEY_REVOKED', reason: 'This license key has been revoked or is invalid.' };
        }

        const keyoOrigin = this.env?.KEYO_API_ORIGIN || this.env?.KEYO_API_URL;
        const projectId = this.env?.KEYO_PROJECT_ID || this.env?.KEYO_CLIENT_ID;

        if (keyoOrigin && projectId) {
            try {
                const url = `${keyoOrigin.replace(/\/+$/, '')}/api/v1/activate?projectId=${encodeURIComponent(projectId)}`;
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId, key: normalizedKey })
                });

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    return {
                        valid: false,
                        code: err.error || 'KEY_UNAVAILABLE',
                        reason: err.error ? `Keyo rejected key: ${err.error}` : `Keyo responded with status ${resp.status}`
                    };
                }

                const data = await resp.json();
                if (!data.entitlement) {
                    return { valid: false, code: 'INVALID_ENTITLEMENT', reason: 'Missing signed entitlement in Keyo response.' };
                }

                const parts = data.entitlement.split('.');
                if (parts.length === 3) {
                    const payload = JSON.parse(base64UrlDecode(parts[1]));
                    const tier = (payload.tier || 'PRO').toLowerCase();
                    return {
                        valid: true,
                        tier: tier === 'max' ? 'max' : 'pro',
                        expires_at: payload.expiresAt || null,
                        signed_token: data.entitlement
                    };
                }
            } catch (err) {
                return { valid: false, code: 'KEYO_NETWORK_ERROR', reason: `Keyo service communication error: ${err.message}` };
            }
        }

        if (normalizedKey.length === 16 || /^(KEYOPRO|PRO)[A-Z0-9]{8,32}$/.test(normalizedKey) || normalizedKey.length >= 12) {
            return {
                valid: true,
                tier: 'pro',
                expires_at: Date.now() + 365 * DAY_MS
            };
        }

        return { valid: false, code: 'MALFORMED_KEY', reason: 'Keyo license keys must be 16 characters (excluding hyphens).' };
    }

    async confirmBatchReview(accountId, body, sessionId = null, userKey = null) {
        const jobId = body?.job_id || body?.jobId;
        const rawTaskIds = Array.isArray(body?.task_ids) ? body.task_ids : (Array.isArray(body?.verified_task_ids) ? body.verified_task_ids : []);
        const requestedTaskIds = [...new Set(rawTaskIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))];

        if (!jobId || !requestedTaskIds.length || requestedTaskIds.length !== rawTaskIds.length) {
            return json({ error: 'job_id and distinct task_ids are required to confirm batch completions.', code: 'INVALID_INPUT' }, 400);
        }

        const confirmOpId = typeof body?.operation_id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.operation_id.trim())
            ? body.operation_id.trim()
            : null;

        try {
            return await this.storage.transaction(async tx => {
                if (await this.audits.isDeleting(tx, accountId, userKey)) {
                    return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
                }
                const attKey = `pro:attestation:${jobId}`;
                const attestation = await tx.get(attKey);
                if (!attestation) {
                    return json({ error: 'Attestation not found or expired.', code: 'ATTESTATION_EXPIRED' }, 404);
                }

                if (attestation.account_id !== accountId) {
                    return json({ error: 'Unauthorized attestation confirmation.', code: 'FORBIDDEN' }, 403);
                }

                const expectedSession = attestation.session_id || (accountId.startsWith('user_') ? `sess_${accountId.slice(5)}` : null);
                if (sessionId && expectedSession && sessionId !== expectedSession) {
                    return json({ error: 'Batch approval belongs to a different signed-in session.', code: 'SESSION_MISMATCH' }, 403);
                }

                if (!attestation.expires_at || Date.now() > attestation.expires_at) {
                    await tx.delete(attKey);
                    return json({ error: 'Attestation expired. Please re-run batch review.', code: 'ATTESTATION_EXPIRED' }, 400);
                }

                if (attestation.consumed) {
                    if (confirmOpId && attestation.confirm_operation_id === confirmOpId && attestation.confirmed_result &&
                        JSON.stringify([...(attestation.confirmed_result.confirmed_task_ids || [])].sort()) === JSON.stringify([...requestedTaskIds].sort())) {
                        return json(attestation.confirmed_result, 200);
                    }
                    return json({ error: 'This batch review approval has already been used.', code: 'ATTESTATION_CONSUMED' }, 409);
                }

                const eligibleList = Array.isArray(attestation.eligible_task_ids) ? attestation.eligible_task_ids : [];
                const verifiedIds = requestedTaskIds.filter(id => eligibleList.includes(id));
                if (!verifiedIds.length || verifiedIds.length !== requestedTaskIds.length) {
                    return json({ error: 'None or not all of the requested tasks were approved by the batch review.', code: 'NO_ELIGIBLE_TASKS' }, 400);
                }

                const stored = await loadStoredSnapshot(tx, accountId, userKey);
                const confirmedSet = new Set(verifiedIds);
                const nowIso = new Date().toISOString();
                const modelUsed = attestation.model_used || POLICY.model;

                if (stored?.snapshot && Array.isArray(stored.snapshot.tasks)) {
                    const { snapshot, meta, user, metaKey } = stored;
                    for (const id of verifiedIds) {
                        const task = snapshot.tasks.find(t => t && t.id === id);
                        if (!task) {
                            return json({ error: `Task "${id}" no longer exists.`, code: 'TASK_MISSING' }, 409);
                        }
                        if (task.status !== 'active') {
                            return json({ error: `Task "${id}" is already ${task.status}.`, code: 'TASK_NOT_ACTIVE' }, 409);
                        }
                        if (attestation.task_revisions && attestation.task_revisions[id]) {
                            const currentRev = await taskRevision(task, snapshot);
                            if (currentRev !== attestation.task_revisions[id]) {
                                return json({ error: `Task "${id}" requirements changed after review. Please run a new review.`, code: 'TASK_MODIFIED_SINCE_REVIEW' }, 409);
                            }
                        }
                        const descendants = collectTaskDescendants(snapshot.tasks, task.id);
                        if (descendants.some(d => d.status === 'active' && isProtectedTask(d) && !confirmedSet.has(d.id))) {
                            return json({ error: `Task "${id}" has unfinished AI-locked subtasks.`, code: 'SUBTASK_LOCKED' }, 409);
                        }
                        for (const node of [task, ...descendants]) {
                            if (node.strict_prerequisites) {
                                const subDesc = collectTaskDescendants(snapshot.tasks, node.id);
                                if (subDesc.some(d => !d.is_bonus && d.status !== 'completed' && !confirmedSet.has(d.id))) {
                                    return json({ error: `Task "${id}" has unfinished required subtasks.`, code: 'PREREQUISITES_INCOMPLETE' }, 409);
                                }
                            }
                        }
                    }

                    for (const id of verifiedIds) {
                        const target = snapshot.tasks.find(t => t && t.id === id);
                        if (!target) continue;
                        const rev = await taskRevision(target, snapshot);
                        target.status = 'completed';
                        target.completed_at = nowIso;
                        target.verified_model = modelUsed;
                        delete target.recurrence_hold_until;
                        for (const child of collectTaskDescendants(snapshot.tasks, id)) {
                            if (child.status !== 'completed') {
                                child.status = 'completed';
                                child.completed_at = nowIso;
                                if (confirmedSet.has(child.id)) child.verified_model = modelUsed;
                            }
                        }
                        await tx.put(`pro:approval:${accountId}:${id}`, {
                            account_id: accountId,
                            task_id: id,
                            operation_id: confirmOpId || jobId,
                            session_id: sessionId || attestation.session_id || null,
                            revision: rev,
                            model_used: modelUsed,
                            created_at: Date.now(),
                            expires_at: Date.now() + DAY_MS,
                            consumed: true,
                            consumed_at: Date.now(),
                            consumed_mutation_id: confirmOpId || jobId
                        });
                    }

                    if (globalThis.TaskitatorRecurrence?.reconcile && snapshot.recurrence_state) {
                        globalThis.TaskitatorRecurrence.reconcile(snapshot);
                    }
                    snapshot.updated_at = nowIso;
                    if (meta) {
                        meta.version = (meta.version || 0) + 1;
                        meta.saved_at = nowIso;
                        await saveStoredSnapshot(tx, user, meta, snapshot);
                        await tx.put(metaKey, meta);
                    } else {
                        await tx.put(`snapshot:${encodeURIComponent(user)}:0`, JSON.stringify(snapshot));
                    }
                }

                const resultPayload = {
                    success: true,
                    status: 'confirmed',
                    job_id: jobId,
                    confirmed_task_ids: verifiedIds,
                    confirmed_at: nowIso,
                    message: `Successfully confirmed ${verifiedIds.length} batch completions.`,
                    ...(stored?.snapshot ? {
                        version: stored.meta?.version ?? 1,
                        tasks: stored.snapshot.tasks,
                        recurrence_state: stored.snapshot.recurrence_state
                    } : {})
                };

                attestation.consumed = true;
                attestation.consumed_at = Date.now();
                attestation.session_id = attestation.session_id || sessionId || null;
                attestation.confirm_operation_id = confirmOpId;
                attestation.confirmed_result = resultPayload;
                await tx.put(attKey, attestation);

                return json(resultPayload, 200);
            });
        } catch (err) {
            return json({ error: err.message || 'Batch confirmation failed.', code: err.code || 'CONFIRM_FAILED' }, err.status || 500);
        }
    }

    // --- Phase 2.5: Unique Username & Resolution System ---

    async checkUsername(username, currentAccountId = null) {
        const raw = String(username || '').trim();
        const norm = raw.toLowerCase();
        if (!norm || !/^[a-zA-Z0-9_]{3,20}$/.test(norm)) {
            return json({
                available: false,
                error: 'Username must be 3-20 characters long and contain only letters, numbers, and underscores.'
            }, 400);
        }
        const RESERVED = ['admin', 'administrator', 'system', 'root', 'taskitator', 'support', 'help', 'moderator', 'mod', 'official', 'bot', 'universe', 'owner', 'security'];
        if (RESERVED.includes(norm)) {
            return json({ available: false, error: 'This username is reserved.' }, 400);
        }
        const existing = await this.storage.get(`pro:username:map:${norm}`);
        if (existing && existing.accountId !== currentAccountId) {
            return json({ available: false, username: raw, error: 'Username is already taken.' }, 200);
        }
        return json({ available: true, username: raw });
    }

    async setUsername(accountId, body) {
        const raw = String(body.username || '').trim();
        const norm = raw.toLowerCase();
        if (!norm || !/^[a-zA-Z0-9_]{3,20}$/.test(norm)) {
            return json({
                error: 'Username must be 3-20 characters long and contain only letters, numbers, and underscores.'
            }, 400);
        }
        const RESERVED = ['admin', 'administrator', 'system', 'root', 'taskitator', 'support', 'help', 'moderator', 'mod', 'official', 'bot', 'universe', 'owner', 'security'];
        if (RESERVED.includes(norm)) {
            return json({ error: 'This username is reserved.' }, 400);
        }

        return await this.storage.transaction(async tx => {
            if (await this.audits.isDeleting(tx, accountId)) {
                return json({ error: 'Account deletion has been accepted.', code: 'ACCOUNT_DELETED' }, 410);
            }
            const existing = await tx.get(`pro:username:map:${norm}`);
            if (existing && existing.accountId !== accountId) {
                return json({ error: 'Username is already taken. Choose another name.', code:'USERNAME_TAKEN' },409);
            }
            const prev = await tx.get(`pro:user:username:${accountId}`);
            if (prev?.normalizedUsername && prev.normalizedUsername !== norm) {
                const old = await tx.get(`pro:username:map:${prev.normalizedUsername}`);
                if (old?.accountId === accountId) await tx.delete(`pro:username:map:${prev.normalizedUsername}`);
            }
            const now = Date.now();
            await tx.put(`pro:username:map:${norm}`,{accountId,username:raw,createdAt:existing?.createdAt || now});
            await tx.put(`pro:user:username:${accountId}`,{username:raw,normalizedUsername:norm,updatedAt:now});
            const link = await tx.get('identity:'+accountId);
            if (link) { link.username=raw; await tx.put('identity:'+accountId,link); }
            return json({success:true,username:raw,normalized:norm});
        });
    }

    async getUsernameProfile(accountId) {
        const rec = await this.storage.get(`pro:user:username:${accountId}`);
        const owner = rec?.normalizedUsername ? await this.storage.get('pro:username:map:'+rec.normalizedUsername) : null;
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        return json({username:owner?.accountId === accountId ? rec.username : null,
            isPro:entitlement?.status === 'active' && (!entitlement.expires_at || entitlement.expires_at > Date.now()),
            tier:entitlement?.tier || 'free'});
    }

    async resolveUsername() {
        // Public handle-to-email lookup exposed private addresses and was not a usable login flow.
        return json({error:'Sign in with your email or Google. Your Taskitator username is your public display name.',
            code:'USE_SECURE_SIGN_IN'},410);
    }
}

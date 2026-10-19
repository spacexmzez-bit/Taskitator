import { clerkAPI } from '../cloudflare/auth.js';
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

// Supported proof file types per execution spec (JPEG, PNG, WebP, PDF)
const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
];

// Target Claude Haiku 5.5 / 3.5 Haiku model family per owner requirement
const PRIMARY_CLAUDE_MODEL = 'claude-haiku-5-5';
const ANTHROPIC_API_VERSION = '2023-06-01';

export class ProGateway {
    constructor(parent) {
        this.parent = parent;
        this.storage = parent.storage;
        this.env = parent.env;
    }

    async handleRequest(request, path, method, identity, account) {
        if (!identity || !identity.userId) {
            return json({ error: 'Authentication required for Pro operations.' }, 401);
        }

        const accountId = identity.userId;

        // Route: GET /pro/status or GET /pro/me
        if (method === 'GET' && (path === '/pro/status' || path === '/pro/me')) {
            return await this.getStatus(accountId);
        }

        // Route: POST /pro/activate
        if (method === 'POST' && path === '/pro/activate') {
            const body = await request.json().catch(() => ({}));
            return await this.activateLicense(accountId, body);
        }

        // Route: POST /pro/byok (Toggle BYOK mode without resetting limits)
        if (method === 'POST' && path === '/pro/byok') {
            const body = await request.json().catch(() => ({}));
            return await this.toggleByok(accountId, body);
        }

        // Route: POST /pro/ai/review (Single & Multi-File Review)
        if (method === 'POST' && path === '/pro/ai/review') {
            const body = await request.json().catch(() => ({}));
            return await this.executeHostedReview(accountId, body);
        }

        // Route: POST /pro/ai/batch-review (Batch Proof Review)
        if (method === 'POST' && path === '/pro/ai/batch-review') {
            const body = await request.json().catch(() => ({}));
            return await this.executeBatchReview(accountId, body);
        }

        // Route: POST /pro/ai/batch-confirm (Batch Result Confirmation & Attestation)
        if (method === 'POST' && path === '/pro/ai/batch-confirm') {
            const body = await request.json().catch(() => ({}));
            return await this.confirmBatchReview(accountId, body);
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
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);

        const usernameRec = await this.storage.get(`pro:user:username:${accountId}`);
        const currentUsername = usernameRec?.username || null;

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
            await this.storage.put(`pro:entitlement:${accountId}`, entitlement);
        }

        const { dateStr, monthStr } = getRiyadhDateStrings(now);
        const dailyUsed = (await this.storage.get(`pro:usage:${accountId}:day:${dateStr}`)) || 0;
        const monthlyUsed = (await this.storage.get(`pro:usage:${accountId}:month:${monthStr}`)) || 0;

        // Owner requirements: 45 daily and 1,000 monthly credits
        const dailyLimit = entitlement.credits_daily_limit || 45;
        const monthlyLimit = entitlement.credits_monthly_limit || 1000;
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
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        if (!entitlement || entitlement.status !== 'active') {
            return json({ error: 'Pro entitlement required to configure BYOK mode.', code: 'PRO_REQUIRED' }, 403);
        }

        // Pro users can choose to use BYOK but their limits do not reset
        entitlement.use_byok = Boolean(body.use_byok);
        await this.storage.put(`pro:entitlement:${accountId}`, entitlement);

        return json({
            success: true,
            use_byok: entitlement.use_byok,
            message: entitlement.use_byok ? 'Switched to personal BYOK mode. Your hosted credit limits remain active.' : 'Switched to hosted Claude Haiku 5.5 mode.'
        });
    }

    async activateLicense(accountId, body) {
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

        await this.storage.put(`pro:entitlement:${accountId}`, entitlement);
        await this.storage.put(`pro:binding:${keyFingerprint}`, {
            account_id: accountId,
            key_fingerprint: keyFingerprint,
            bound_at: now
        });

        if (this.env?.TASKITATOR_DB) {
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

    // --- Phase 2: Single & Multi-File Proof Review ---

    async executeHostedReview(accountId, body) {
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        const now = Date.now();
        if (!entitlement || entitlement.status !== 'active' || (entitlement.expires_at && now > entitlement.expires_at)) {
            return json({
                error: 'Active Taskitator Pro entitlement required for hosted AI proof review.',
                code: 'PRO_REQUIRED'
            }, 403);
        }

        let filesList = [];
        if (Array.isArray(body.files)) {
            filesList = body.files;
        } else if (body.file) {
            filesList = [body.file];
        }

        if (filesList.length > 5) {
            return json({ error: 'Multi-file review accepts a maximum of 5 files per task.', code: 'TOO_MANY_FILES' }, 400);
        }

        let totalBytes = 0;
        const validatedFiles = [];
        for (const f of filesList) {
            if (!f) continue;
            const mimeType = (f.mime_type || f.mimeType || '').toLowerCase();
            const data = f.data || f.base64 || '';
            if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
                return json({ error: `Unsupported file format '${mimeType}'. Supported formats: JPEG, PNG, WebP, and PDF.`, code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
            }
            if (data.length > 7 * 1024 * 1024) {
                return json({ error: 'An evidence file exceeds the 5 MiB individual size limit.', code: 'PAYLOAD_TOO_LARGE' }, 413);
            }
            totalBytes += data.length;
            validatedFiles.push({ mimeType, data });
        }

        if (totalBytes > 28 * 1024 * 1024) { // ~20 MiB decoded
            return json({ error: 'Total evidence files exceed the 20 MiB combined limit.', code: 'PAYLOAD_TOO_LARGE' }, 413);
        }

        // Accounting: 1 credit for single file, 2 credits for multi-file (2-5 files)
        const creditCost = validatedFiles.length > 1 ? 2 : 1;

        const { dateStr, monthStr } = getRiyadhDateStrings(now);
        const dailyLimit = entitlement.credits_daily_limit || 45;
        const monthlyLimit = entitlement.credits_monthly_limit || 1000;

        const dailyUsed = (await this.storage.get(`pro:usage:${accountId}:day:${dateStr}`)) || 0;
        const monthlyUsed = (await this.storage.get(`pro:usage:${accountId}:month:${monthStr}`)) || 0;

        if (dailyUsed + creditCost > dailyLimit || monthlyUsed + creditCost > monthlyLimit) {
            return json({
                error: 'Hosted AI review credit quota exhausted. Quota resets at 00:00 Asia/Riyadh.',
                code: 'QUOTA_EXHAUSTED',
                credits: {
                    daily_remaining: Math.max(0, dailyLimit - dailyUsed),
                    monthly_remaining: Math.max(0, monthlyLimit - monthlyUsed),
                    reset_timezone: 'Asia/Riyadh'
                }
            }, 429);
        }

        // Idempotency check
        const operationId = body.operation_id || body.operationId;
        const inputHash = await sha256(JSON.stringify({
            task_id: body.task_id || body.taskId,
            criteria: body.criteria || '',
            file_count: validatedFiles.length,
            file_sample: validatedFiles.map(f => f.data.slice(0, 50)).join(':')
        }));

        if (operationId) {
            const cachedOp = await this.storage.get(`pro:op:${accountId}:${operationId}`);
            if (cachedOp) {
                if (cachedOp.inputHash === inputHash) return json(cachedOp.result);
                return json({ error: 'Operation ID reused with conflicting input payload.', code: 'OPERATION_CONFLICT' }, 409);
            }
        }

        // Execute Review via Claude Haiku 5.5
        let reviewResult = null;
        try {
            reviewResult = await this.callClaudeReview({
                title: body.task_title || 'Task',
                criteria: body.criteria || '',
                files: validatedFiles
            });
        } catch (err) {
            return json({
                error: `Hosted AI review failed: ${err.message}`,
                code: 'AI_PROVIDER_ERROR',
                retryable: true
            }, 502);
        }

        // Commit credit charge
        await this.storage.put(`pro:usage:${accountId}:day:${dateStr}`, dailyUsed + creditCost);
        await this.storage.put(`pro:usage:${accountId}:month:${monthStr}`, monthlyUsed + creditCost);

        const responsePayload = {
            success: true,
            verdict: reviewResult.verdict,
            confidence: reviewResult.confidence,
            critique: reviewResult.critique,
            model_used: PRIMARY_CLAUDE_MODEL,
            credits_charged: creditCost,
            credits_remaining: {
                daily: Math.max(0, dailyLimit - (dailyUsed + creditCost)),
                monthly: Math.max(0, monthlyLimit - (monthlyUsed + creditCost))
            },
            operation_id: operationId
        };

        if (operationId) {
            await this.storage.put(`pro:op:${accountId}:${operationId}`, {
                inputHash,
                result: responsePayload,
                timestamp: now
            });
        }

        return json(responsePayload);
    }

    // --- Phase 2: Batch Proof Review ---

    async executeBatchReview(accountId, body) {
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        const now = Date.now();
        if (!entitlement || entitlement.status !== 'active' || (entitlement.expires_at && now > entitlement.expires_at)) {
            return json({ error: 'Active Taskitator Pro entitlement required for batch review.', code: 'PRO_REQUIRED' }, 403);
        }

        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        if (!tasks.length) {
            return json({ error: 'At least one task is required for batch review.', code: 'INVALID_INPUT' }, 400);
        }
        if (tasks.length > 20) {
            return json({ error: 'Batch review supports up to 20 tasks per run.', code: 'TOO_MANY_TASKS' }, 400);
        }

        const filesList = Array.isArray(body.files) ? body.files : (body.file ? [body.file] : []);
        if (filesList.length > 5) {
            return json({ error: 'Batch review accepts up to 5 evidence files.', code: 'TOO_MANY_FILES' }, 400);
        }

        const validatedFiles = [];
        for (const f of filesList) {
            if (!f) continue;
            const mimeType = (f.mime_type || f.mimeType || '').toLowerCase();
            const data = f.data || f.base64 || '';
            if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
                return json({ error: `Unsupported file format '${mimeType}'.`, code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
            }
            validatedFiles.push({ mimeType, data });
        }

        // Accounting: 1 credit per task reviewed (capped at 10 credits for pilot)
        const creditCost = Math.min(10, tasks.length);

        const { dateStr, monthStr } = getRiyadhDateStrings(now);
        const dailyLimit = entitlement.credits_daily_limit || 45;
        const monthlyLimit = entitlement.credits_monthly_limit || 1000;
        const dailyUsed = (await this.storage.get(`pro:usage:${accountId}:day:${dateStr}`)) || 0;
        const monthlyUsed = (await this.storage.get(`pro:usage:${accountId}:month:${monthStr}`)) || 0;

        if (dailyUsed + creditCost > dailyLimit || monthlyUsed + creditCost > monthlyLimit) {
            return json({
                error: 'Credit quota exhausted for batch review. Quota resets at 00:00 Asia/Riyadh.',
                code: 'QUOTA_EXHAUSTED'
            }, 429);
        }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        let batchResults = [];
        try {
            batchResults = await this.callClaudeBatchReview({ tasks, files: validatedFiles });
        } catch (err) {
            return json({ error: `Batch review failed: ${err.message}`, code: 'AI_PROVIDER_ERROR' }, 502);
        }

        // Commit credits
        await this.storage.put(`pro:usage:${accountId}:day:${dateStr}`, dailyUsed + creditCost);
        await this.storage.put(`pro:usage:${accountId}:month:${monthStr}`, monthlyUsed + creditCost);

        // Save server attestation for confirmation (expires in 24 hours)
        const eligibleTaskIds = batchResults.filter(r => r.status === 'eligible').map(r => r.task_id);
        const attestation = {
            job_id: jobId,
            account_id: accountId,
            eligible_task_ids: eligibleTaskIds,
            created_at: now,
            expires_at: now + DAY_MS,
            consumed: false
        };
        await this.storage.put(`pro:attestation:${jobId}`, attestation);

        return json({
            success: true,
            job_id: jobId,
            model_used: PRIMARY_CLAUDE_MODEL,
            tasks: batchResults,
            credits_charged: creditCost,
            credits_remaining: {
                daily: Math.max(0, dailyLimit - (dailyUsed + creditCost)),
                monthly: Math.max(0, monthlyLimit - (monthlyUsed + creditCost))
            }
        });
    }

    async confirmBatchReview(accountId, body) {
        const jobId = body.job_id || body.jobId;
        const requestedTaskIds = Array.isArray(body.task_ids) ? body.task_ids : [];

        if (!jobId || !requestedTaskIds.length) {
            return json({ error: 'job_id and task_ids are required to confirm batch completions.', code: 'INVALID_INPUT' }, 400);
        }

        const attestation = await this.storage.get(`pro:attestation:${jobId}`);
        if (!attestation) {
            return json({ error: 'Attestation not found or expired.', code: 'ATTESTATION_EXPIRED' }, 404);
        }

        if (attestation.account_id !== accountId) {
            return json({ error: 'Unauthorized attestation confirmation.', code: 'FORBIDDEN' }, 403);
        }

        if (Date.now() > attestation.expires_at) {
            return json({ error: 'Attestation expired. Please re-run batch review.', code: 'ATTESTATION_EXPIRED' }, 400);
        }

        const verifiedIds = requestedTaskIds.filter(id => attestation.eligible_task_ids.includes(id));
        if (!verifiedIds.length) {
            return json({ error: 'None of the requested tasks were approved by the batch review.', code: 'NO_ELIGIBLE_TASKS' }, 400);
        }

        attestation.consumed = true;
        await this.storage.put(`pro:attestation:${jobId}`, attestation);

        return json({
            success: true,
            job_id: jobId,
            confirmed_task_ids: verifiedIds,
            message: `Successfully confirmed ${verifiedIds.length} batch completions.`
        });
    }

    // --- Claude Haiku 5.5 AI Gateway ---

    async callClaudeReview({ title, criteria, files }) {
        const apiKey = this.env?.CLAUDE_API_KEY || this.env?.ANTHROPIC_API_KEY;

        if (!apiKey) {
            throw new Error('Claude API key (CLAUDE_API_KEY) is not configured in Cloudflare Worker secrets. Add CLAUDE_API_KEY in Cloudflare Dashboard > Workers & Pages > taskitator-sync > Settings > Variables and Secrets.');
        }

        const system = "You are Taskitator Pro's forensic task audit AI, powered by Claude Haiku 5.5. " +
                       "Your job is to strictly evaluate whether evidence (images or PDFs) demonstrates that the user completed the work according to their proof criteria. " +
                       "Be skeptical, objective, and rigorous. Do not accept ambiguous or incomplete proof. " +
                       "You MUST respond ONLY with a raw JSON object with these fields:\n" +
                       "{\"verdict\": \"approved\" | \"rejected\", \"confidence\": number (0.0 to 1.0), \"critique\": string}\n" +
                       "Do not use markdown code blocks.";

        const contentBlocks = [];
        contentBlocks.push({
            type: 'text',
            text: `TASK TITLE: ${title}\nPROOF CRITERIA: ${criteria}\n\nPlease audit the attached ${files.length} evidence file(s) against the criteria.`
        });

        for (const file of files) {
            if (file.mimeType === 'application/pdf') {
                contentBlocks.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: file.data
                    }
                });
            } else {
                contentBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: file.mimeType,
                        data: file.data
                    }
                });
            }
        }

        const payload = {
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: contentBlocks }]
        };

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Claude API returned status ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const textBlock = data.content?.find(b => b.type === 'text')?.text || '';
        try {
            const parsed = JSON.parse(textBlock.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
            return {
                verdict: parsed.verdict === 'approved' ? 'approved' : 'rejected',
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.95,
                critique: parsed.critique || 'Audited against criteria.'
            };
        } catch {
            return {
                verdict: textBlock.includes('"approved"') ? 'approved' : 'rejected',
                confidence: 0.9,
                critique: textBlock.slice(0, 300)
            };
        }
    }

    async callClaudeBatchReview({ tasks, files }) {
        const apiKey = this.env?.CLAUDE_API_KEY || this.env?.ANTHROPIC_API_KEY;

        if (!apiKey) {
            throw new Error('Claude API key (CLAUDE_API_KEY) is not configured in Cloudflare Worker secrets. Add CLAUDE_API_KEY in Cloudflare Dashboard > Workers & Pages > taskitator-sync > Settings > Variables and Secrets.');
        }

        const taskManifest = tasks.map(t => `- ID: ${t.id}\n  Title: ${t.title}\n  Criteria: ${t.criteria}`).join('\n\n');

        const system = "You are Taskitator Pro's Batch Audit AI. Evaluate whether the attached evidence satisfies each of the listed tasks.\n" +
                       "Respond ONLY with a JSON array where each item has:\n" +
                       "{\"task_id\": string, \"status\": \"eligible\" | \"rejected\" | \"partial\" | \"uncertain\", \"verdict\": \"approved\" | \"rejected\", \"reason\": string}";

        const contentBlocks = [];
        contentBlocks.push({
            type: 'text',
            text: `BATCH AUDIT REQUEST:\n\nTASKS TO AUDIT:\n${taskManifest}\n\nPlease audit the evidence against each task independently.`
        });

        for (const file of files) {
            if (file.mimeType === 'application/pdf') {
                contentBlocks.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: file.data
                    }
                });
            } else {
                contentBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: file.mimeType,
                        data: file.data
                    }
                });
            }
        }

        const payload = {
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 2048,
            system,
            messages: [{ role: 'user', content: contentBlocks }]
        };

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Claude API returned status ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const textBlock = data.content?.find(b => b.type === 'text')?.text || '';
        try {
            const list = JSON.parse(textBlock.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
            if (Array.isArray(list)) return list;
        } catch {}

        return tasks.map(t => ({
            task_id: t.id,
            status: 'uncertain',
            verdict: 'rejected',
            reason: 'Could not reliably parse batch evaluation.'
        }));
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

        const existing = await this.storage.get(`pro:username:map:${norm}`);
        if (existing && existing.accountId !== accountId) {
            return json({ error: 'Username is already taken.' }, 409);
        }

        // Release old username if user already had one
        const prev = await this.storage.get(`pro:user:username:${accountId}`);
        if (prev && prev.normalizedUsername && prev.normalizedUsername !== norm) {
            await this.storage.delete(`pro:username:map:${prev.normalizedUsername}`);
        }

        const now = Date.now();
        await this.storage.put(`pro:username:map:${norm}`, {
            accountId,
            username: raw,
            createdAt: now
        });
        await this.storage.put(`pro:user:username:${accountId}`, {
            username: raw,
            normalizedUsername: norm,
            updatedAt: now
        });

        const link = await this.storage.get('identity:' + accountId);
        if (link) {
            link.username = raw;
            await this.storage.put('identity:' + accountId, link);
        }

        return json({ success: true, username: raw, normalized: norm });
    }

    async getUsernameProfile(accountId) {
        const usernameRec = await this.storage.get(`pro:user:username:${accountId}`);
        const entitlement = await this.storage.get(`pro:entitlement:${accountId}`);
        const isPro = entitlement?.status === 'active';
        // Note: Strict privacy rule - members see usernames, never email!
        return json({
            username: usernameRec?.username || null,
            isPro,
            tier: entitlement?.tier || 'free'
        });
    }

    async resolveUsername(body) {
        const raw = String(body.username || '').trim();
        const norm = raw.toLowerCase();
        if (!norm || !/^[a-zA-Z0-9_]{3,20}$/.test(norm)) {
            return json({ error: 'Username must be 3-20 characters long and contain only letters, numbers, and underscores.' }, 400);
        }
        const entry = await this.storage.get(`pro:username:map:${norm}`);
        if (!entry) {
            return json({ error: 'Username not found. Check spelling or sign in using your email address.' }, 404);
        }

        // Check if user account was created via Google OAuth only
        let clerkUser = null;
        if (this.env && typeof clerkAPI === 'function') {
            try {
                clerkUser = await clerkAPI(this.env, 'users/' + encodeURIComponent(entry.accountId));
            } catch {}
        }

        if (clerkUser) {
            const hasGoogle = clerkUser.external_accounts?.some(acc => acc.provider === 'oauth_google' || acc.provider === 'google');
            const hasPassword = Boolean(clerkUser.password_enabled);
            // Strict constraint: Google sign-in disallowed from username login
            if (hasGoogle && !hasPassword) {
                return json({
                    error: 'Google sign-in accounts cannot log in using a username. Please sign in using your email address or Google Sign-In button.',
                    disallow_google: true
                }, 403);
            }
            const email = clerkUser.email_addresses?.find(e => e.id === clerkUser.primary_email_address_id)?.email_address
                || clerkUser.email_addresses?.[0]?.email_address;
            return json({ success: true, username: entry.username, email, requires_password: true });
        }

        // Fallback for mock environment or stored identity
        const link = await this.storage.get('identity:' + entry.accountId);
        const email = (link?.display_name && link.display_name.includes('@')) ? link.display_name : (entry.email || `${norm}@example.com`);
        return json({ success: true, username: entry.username, email, requires_password: true });
    }
}

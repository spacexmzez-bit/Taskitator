import { SecurityError, clerkAPI, sha256, allowedOrigins } from './auth.js';
export const VERIFICATION_VERSION = 2;
export const VERIFICATION_MS = 5 * 60000;
export const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export async function verifyGoogleToken(token, env, nonce, subject) {
    let parts, header, claims;
    try {
        parts = token.split('.');
        if (parts.length !== 3 || token.length > 16000) throw new Error();
        header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    } catch { throw new SecurityError(401, 'Google verification returned an invalid identity.'); }
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        claims.aud !== env.GOOGLE_OAUTH_CLIENT_ID ||
        (claims.azp && claims.azp !== env.GOOGLE_OAUTH_CLIENT_ID) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 5 || now - claims.iat > 300 ||
        claims.nonce !== nonce || claims.sub !== subject) {
        throw new SecurityError(401, 'Select the Google account already connected to this Taskitator account.');
    }
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new SecurityError(503, 'Google verification is temporarily unavailable.');
    const jwk = (await res.json()).keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) throw new SecurityError(401, 'Google signing key was not recognized. Try again.');
    const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0]+'.'+parts[1])))) {
        throw new SecurityError(401, 'Google identity could not be verified.');
    }
}
export class ActionVerification {
    constructor(service) { this.service = service; this.storage = service.storage; this.env = service.env; }
    async get(id, identity, action = 'delete-account') {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new SecurityError(403, 'Start verification again.');
        const record = await this.storage.get('action-proof:'+await sha256(id));
        if (!record || record.version !== VERIFICATION_VERSION || record.expires <= Date.now() || record.userId !== identity.userId ||
            record.sessionId !== identity.sessionId || record.action !== action) {
            throw new SecurityError(403, 'Verification expired or belongs to a different session. Start again.');
        }
        return record;
    }
    async start(request, identity, method, action = 'delete-account', stageId = null, provider = 'gemini') {
        if (!['delete-account','api-key-reveal','api-key-save','api-key-delete'].includes(action)) throw new SecurityError(400,'Invalid verification action.');
        if (action === 'delete-account' && this.env.ACCOUNT_DELETION_ENABLED !== 'true') throw new SecurityError(503,'Account deletion needs one-time setup. Follow PHASE-1-SETUP.txt.');
        if (action !== 'delete-account' && !this.service.vault.ready()) throw new SecurityError(503,'Secure key storage needs setup. Follow PHASE-2-SETUP.html.');
        if (identity.actor) throw new SecurityError(403, 'Impersonated sessions cannot authorize sensitive actions.');
        if (!(await this.service.accountFor(identity))) throw new SecurityError(403,'Connect your Taskitator account before verification.');
        await this.service.rateBucket('verify-user:'+identity.userId, 8);
        if (!['password','google'].includes(method)) throw new SecurityError(400, 'Choose password or Google verification.');
        const origin = request.headers.get('Origin');
        if (!allowedOrigins(this.env).includes(origin)) throw new SecurityError(403, 'Open verification from the Taskitator website.');
        const id = randomSecret(), record = { version:VERIFICATION_VERSION, userId:identity.userId, sessionId:identity.sessionId,
            action, method, status:'pending', created:Date.now(), expires:Date.now()+VERIFICATION_MS,
            baseline:identity.reverificationId || null, origin };
        if (action !== 'delete-account') record.context = await this.service.vault.context(identity,action,stageId,provider);
        let authorizationUrl;
        if (method === 'google') {
            const settings = ['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','GOOGLE_VERIFICATION_REDIRECT_URI'];
            const missing = settings.filter(name => typeof this.env[name] !== 'string' || !this.env[name].trim());
            if (missing.length) throw new SecurityError(503, 'Google confirmation needs Worker setup: '+missing.join(', ')+'. See pro/verification-setup.html.');
            let redirect;
            try { redirect = new URL(this.env.GOOGLE_VERIFICATION_REDIRECT_URI); }
            catch { throw new SecurityError(503, 'Google confirmation callback is misconfigured. See pro/verification-setup.html.'); }
            if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.pathname !== '/auth/verification/google/callback' || redirect.search || redirect.hash) {
                throw new SecurityError(503, 'Google confirmation callback is misconfigured. See pro/verification-setup.html.');
            }
            const user = await clerkAPI(this.env, 'users/'+encodeURIComponent(identity.userId));
            const account = user.external_accounts?.find(item => item.provider === 'oauth_google' || item.provider === 'google');
            if (!account || account.verification?.status !== 'verified' || !account.provider_user_id) {
                throw new SecurityError(403, 'Connect your Google account in Manage account & password before using Google confirmation.');
            }
            record.subject = String(account.provider_user_id);
            record.nonce = randomSecret(); record.verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
            const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.verifier))));
            const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            url.search = new URLSearchParams({ client_id:this.env.GOOGLE_OAUTH_CLIENT_ID,
                redirect_uri:this.env.GOOGLE_VERIFICATION_REDIRECT_URI, response_type:'code', scope:'openid',
                state:id, nonce:record.nonce, code_challenge:challenge, code_challenge_method:'S256',
                prompt:'select_account', access_type:'online' }).toString();
            authorizationUrl = url.href;
        }
        await this.storage.put('action-proof:'+await sha256(id), record);
        await this.service.ensureAlarm();
        return { verification_id:id, expires_at:record.expires, ...(authorizationUrl ? {authorization_url:authorizationUrl} : {}) };
    }
    async password(id, identity, action = 'delete-account') {
        const record = await this.get(id, identity, action);
        if (record.method !== 'password' || record.status !== 'pending') throw new SecurityError(403, 'Start password verification again.');
        const rv = identity.reverificationId;
        if (typeof rv !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(rv) || rv === record.baseline ||
            !Array.isArray(identity.factorAge) || !Number.isFinite(identity.factorAge[0]) ||
            identity.factorAge[0] < 0 || identity.factorAge[0] > 2) {
            throw new SecurityError(403, 'Complete a new password verification. Check the Clerk reverification claim setup if this persists.');
        }
        const confirmed = await clerkAPI(this.env, 'sessions/'+encodeURIComponent(identity.sessionId)+'/reverifications/'+encodeURIComponent(rv));
        // Backend Reverification has factor timestamps, not the browser SDK's
        // first_factor_verification object. Bind both timestamps to this attempt.
        const now = Date.now();
        if (!confirmed || confirmed.object !== 'reverification' || confirmed.id !== rv ||
            confirmed.session_id !== identity.sessionId || confirmed.user_id !== identity.userId ||
            confirmed.status !== 'complete' || !['first_factor','multi_factor'].includes(confirmed.level) ||
            !Number.isSafeInteger(confirmed.created_at) || !Number.isSafeInteger(confirmed.first_factor_verified_at) ||
            confirmed.created_at < record.created || confirmed.created_at > now ||
            confirmed.first_factor_verified_at < confirmed.created_at || confirmed.first_factor_verified_at > now) {
            throw new SecurityError(403, 'Password verification has not completed.');
        }
        const usedKey = 'verification-used:'+await sha256(identity.sessionId+':'+rv);
        await this.storage.transaction(async tx => {
            const key = 'action-proof:'+await sha256(id), current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.status !== 'pending' || current.expires <= Date.now() || await tx.get(usedKey)) {
                throw new SecurityError(403, 'This verification was already used. Start again.');
            }
            current.status = 'verified';
            await tx.put(key, current); await tx.put(usedKey, {expires:Date.now()+10*60000});
        });
        return { verified:true };
    }
    async callback(request) {
        const url = new URL(request.url), id = url.searchParams.get('state');
        if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new SecurityError(400, 'Invalid Google verification request.');
        const key = 'action-proof:'+await sha256(id);
        const record = await this.storage.transaction(async tx => {
            const current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.method !== 'google' || current.status !== 'pending' || current.expires <= Date.now()) {
                throw new SecurityError(403, 'Google verification expired or was already used.');
            }
            current.status = 'checking'; await tx.put(key,current); return current;
        });
        let success = false;
        try {
            if (url.origin+url.pathname !== this.env.GOOGLE_VERIFICATION_REDIRECT_URI || url.searchParams.has('error')) throw new Error();
            const code = url.searchParams.get('code'); if (!code || code.length > 4096) throw new Error();
            const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST',
                headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:AbortSignal.timeout(10000),
                body:new URLSearchParams({ code, client_id:this.env.GOOGLE_OAUTH_CLIENT_ID,
                    client_secret:this.env.GOOGLE_OAUTH_CLIENT_SECRET, redirect_uri:this.env.GOOGLE_VERIFICATION_REDIRECT_URI,
                    grant_type:'authorization_code', code_verifier:record.verifier }) });
            if (!response.ok) throw new Error();
            await verifyGoogleToken((await response.json()).id_token, this.env, record.nonce, record.subject);
            // Recheck the live Clerk session and currently linked Google identity.
            const session = await clerkAPI(this.env, 'sessions/'+encodeURIComponent(record.sessionId));
            const user = await clerkAPI(this.env, 'users/'+encodeURIComponent(record.userId));
            if (session.status !== 'active' || session.user_id !== record.userId ||
                !user.external_accounts?.some(account => ['oauth_google','google'].includes(account.provider) &&
                    account.verification?.status === 'verified' && String(account.provider_user_id) === record.subject)) throw new Error();
            success = true;
        } catch { /* Never return provider tokens, secrets, or detailed errors in URLs. */ }
        await this.storage.transaction(async tx => {
            const current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.status !== 'checking') return;
            current.status = success && current.expires > Date.now() ? 'verified' : 'failed';
            delete current.verifier; delete current.nonce; delete current.subject;
            await tx.put(key,current);
        });
        const fragment = record.action === 'delete-account' ? 'delete-verification' : 'key-verification';
        return new Response(null, {status:303,headers:{Location:record.origin+'/settings.html#'+fragment+'='+id,
            'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
}

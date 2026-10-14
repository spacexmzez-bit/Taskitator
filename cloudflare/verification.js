import { SecurityError, clerkAPI, sha256, allowedOrigins } from './auth.js';
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
    async get(id, identity) {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new SecurityError(403, 'Start verification again.');
        const record = await this.storage.get('action-proof:'+await sha256(id));
        if (!record || record.expires <= Date.now() || record.userId !== identity.userId ||
            record.sessionId !== identity.sessionId || record.action !== 'delete-account') {
            throw new SecurityError(403, 'Verification expired or belongs to a different session. Start again.');
        }
        return record;
    }
    async start(request, identity, method) {
        if (this.env.ACCOUNT_DELETION_ENABLED !== 'true') throw new SecurityError(503,'Account deletion needs one-time setup. Follow PHASE-1-SETUP.txt.');
        if (identity.actor) throw new SecurityError(403, 'Impersonated sessions cannot delete accounts.');
        if (!(await this.service.accountFor(identity))) throw new SecurityError(403,'Connect your Taskitator account before verification.');
        await this.service.rateBucket('verify-user:'+identity.userId, 8);
        if (!['password','google'].includes(method)) throw new SecurityError(400, 'Choose password or Google verification.');
        const origin = request.headers.get('Origin');
        if (!allowedOrigins(this.env).includes(origin)) throw new SecurityError(403, 'Open verification from the Taskitator website.');
        const id = randomSecret(), record = { userId:identity.userId, sessionId:identity.sessionId,
            action:'delete-account', method, status:'pending', created:Date.now(), expires:Date.now()+VERIFICATION_MS,
            baseline:identity.reverificationId || null, origin };
        let authorizationUrl;
        if (method === 'google') {
            if (!this.env.GOOGLE_OAUTH_CLIENT_ID || !this.env.GOOGLE_OAUTH_CLIENT_SECRET || !this.env.GOOGLE_VERIFICATION_REDIRECT_URI) {
                throw new SecurityError(503, 'Google confirmation needs one-time setup. Follow PHASE-1-SETUP.txt, or use your password.');
            }
            const redirect = new URL(this.env.GOOGLE_VERIFICATION_REDIRECT_URI);
            if (redirect.protocol !== 'https:' || redirect.pathname !== '/auth/verification/google/callback' || redirect.search || redirect.hash) {
                throw new SecurityError(503, 'Google confirmation callback is misconfigured.');
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
    async password(id, identity) {
        const record = await this.get(id, identity);
        if (record.method !== 'password' || record.status !== 'pending') throw new SecurityError(403, 'Start password verification again.');
        const rv = identity.reverificationId;
        if (typeof rv !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(rv) || rv === record.baseline ||
            !Array.isArray(identity.factorAge) || !Number.isFinite(identity.factorAge[0]) ||
            identity.factorAge[0] < 0 || identity.factorAge[0] > 2) {
            throw new SecurityError(403, 'Complete a new password verification. Check the Clerk reverification claim setup if this persists.');
        }
        const confirmed = await clerkAPI(this.env, 'sessions/'+encodeURIComponent(identity.sessionId)+'/reverifications/'+encodeURIComponent(rv));
        if (confirmed.status !== 'complete' || confirmed.first_factor_verification?.status !== 'verified' ||
            confirmed.first_factor_verification?.strategy !== 'password') {
            throw new SecurityError(403, 'Password verification has not completed.');
        }
        const usedKey = 'verification-used:'+await sha256(identity.sessionId+':'+rv);
        await this.storage.transaction(async tx => {
            const key = 'action-proof:'+await sha256(id), current = await tx.get(key);
            if (!current || current.status !== 'pending' || current.expires <= Date.now() || await tx.get(usedKey)) {
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
            if (!current || current.method !== 'google' || current.status !== 'pending' || current.expires <= Date.now()) {
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
            if (!current || current.status !== 'checking') return;
            current.status = success && current.expires > Date.now() ? 'verified' : 'failed';
            delete current.verifier; delete current.nonce; delete current.subject;
            await tx.put(key,current);
        });
        return new Response(null, {status:303,headers:{Location:record.origin+'/settings.html#delete-verification='+id,
            'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
}

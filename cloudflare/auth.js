// Clerk session verification using Cloudflare Web Crypto. No password database.
// The short-lived JWT is checked locally, then the session is checked with Clerk
// on every request so revocation does not wait for token expiry.
export class SecurityError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export const allowedOrigins = env => String(env.ALLOWED_ORIGINS || 'https://taskitator.mazendev.com')
    .split(',').map(value => value.trim()).filter(Boolean);
const decode = value => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SecurityError(401, 'Invalid session. Sign in again.');
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
};
export const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
export function randomPhoneToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return 'tkp_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function clerkAPI(env, path) {
    if (!env.CLERK_SECRET_KEY) throw new SecurityError(503, 'Authentication setup is incomplete.');
    let res;
    try {
        res = await fetch('https://api.clerk.com/v1/' + path, {
            headers: { Authorization: 'Bearer ' + env.CLERK_SECRET_KEY },
            signal: AbortSignal.timeout(10000)
        });
    } catch { throw new SecurityError(503, 'Authentication service unavailable. Retry shortly.'); }
    if (res.status === 404) throw new SecurityError(401, 'Session is no longer active. Sign in again.');
    if (!res.ok) throw new SecurityError(503, 'Authentication service unavailable. Retry shortly.');
    try { return await res.json(); }
    catch { throw new SecurityError(503, 'Authentication service returned an invalid response.'); }
}
export async function verifySession(request, env, token) {
    if (!env.CLERK_JWT_KEY || !env.CLERK_ISSUER || !env.CLERK_SECRET_KEY) {
        throw new SecurityError(503, 'Authentication setup is incomplete.');
    }
    let header, claims, parts;
    try {
        parts = token.split('.');
        if (parts.length !== 3 || token.length > 8192) throw new Error();
        header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    } catch { throw new SecurityError(401, 'Invalid session. Sign in again.'); }
    if (header.alg !== 'RS256' || header.crit !== undefined) throw new SecurityError(401, 'Invalid session.');
    let key;
    try {
        const pem = env.CLERK_JWT_KEY.replace(/\\n/g, '\n')
            .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
        key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch { throw new SecurityError(503, 'The Clerk JWT public key is invalid. Check Worker settings.'); }
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]),
        new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const now = Math.floor(Date.now() / 1000), origins = allowedOrigins(env);
    const origin = request.headers.get('Origin');
    if (!valid || claims.iss !== env.CLERK_ISSUER.replace(/\/$/, '') ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.nbf) || claims.nbf > now + 5 ||
        !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
        !origins.includes(claims.azp) || (origin && origin !== claims.azp) ||
        typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(claims.sub) ||
        typeof claims.sid !== 'string' || !/^sess_[A-Za-z0-9]+$/.test(claims.sid) ||
        (claims.sts !== undefined && claims.sts !== 'active')) {
        throw new SecurityError(401, 'Session is invalid or expired. Sign in again.');
    }
    const session = await clerkAPI(env, 'sessions/' + encodeURIComponent(claims.sid));
    if (session.status !== 'active' || session.user_id !== claims.sub) {
        throw new SecurityError(401, 'Session is no longer active. Sign in again.');
    }
    return { userId: claims.sub, sessionId: claims.sid, factorAge: claims.fva,
        reverificationId: claims.taskitator_reverification_id, actor: claims.act };
}
export async function verifiedEmail(env, userId) {
    const user = await clerkAPI(env, 'users/' + encodeURIComponent(userId));
    const email = user.email_addresses?.find(entry => entry.id === user.primary_email_address_id);
    if (!email || email.verification?.status !== 'verified') {
        throw new SecurityError(403, 'Verify your primary email address before connecting Taskitator.');
    }
    return String(email.email_address).trim().toLowerCase();
}

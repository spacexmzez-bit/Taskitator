// Native Clerk JWT compatibility regression tests. No production tokens or keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySession } from './worker.js';

const webOrigin = 'https://taskitator.mazendev.com';
const otherAllowedOrigin = 'https://other-allowed.example';
const issuer = 'https://test.clerk.example';
const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'
}, true, ['sign', 'verify']);
const publicDer = await crypto.subtle.exportKey('spki', keys.publicKey);
const env = {
    CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\n' + Buffer.from(publicDer).toString('base64') + '\n-----END PUBLIC KEY-----',
    CLERK_ISSUER: issuer,
    CLERK_SECRET_KEY: 'test-only',
    ALLOWED_ORIGINS: webOrigin + ',' + otherAllowedOrigin
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(overrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = encode({ alg: 'RS256', typ: 'JWT', ...headerOverrides });
    const p = encode({
        iss: issuer, sub: 'user_ABC', sid: 'sess_ABC',
        iat: now, nbf: now - 1, exp: now + 60,
        azp: webOrigin, ...overrides
    });
    const data = h + '.' + p;
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data)
    );
    return data + '.' + Buffer.from(signature).toString('base64url');
}
let sessionStatus = 'active';
let sessionOwner = 'user_ABC';
globalThis.fetch = async url => {
    assert.equal(String(url), 'https://api.clerk.com/v1/sessions/sess_ABC');
    return Response.json({ status: sessionStatus, user_id: sessionOwner });
};
async function status(jwt, origin = null) {
    const headers = {};
    if (origin !== null) headers.Origin = origin;
    try {
        const identity = await verifySession(new Request('https://worker.test/auth/me', { headers }), env, jwt);
        assert.equal(identity.userId, 'user_ABC');
        return 200;
    } catch (e) {
        if (e?.status) return e.status;
        throw e;
    }
}

test('web Clerk tokens keep matching authorized-party and browser Origin checks', async () => {
    assert.equal(await status(await token(), webOrigin), 200);
    assert.equal(await status(await token(), null), 200); // Existing non-browser web-token behavior.
    assert.equal(await status(await token(), otherAllowedOrigin), 401);
    assert.equal(await status(await token({ azp: otherAllowedOrigin }), webOrigin), 401);
    assert.equal(await status(await token({ azp: undefined }), webOrigin), 401);
    assert.equal(await status(await token({ azp: null }), webOrigin), 401);
});

test('Android Clerk JWTs require an absent Origin and an allowed native party', async () => {
    const nativeParties = [
        undefined, null, 'com.mazendev.taskitator',
        'clerk://com.mazendev.taskitator.callback',
        'clerk://com.mazendev.taskitator.oauth'
    ];
    for (const azp of nativeParties) {
        const jwt = await token({ azp });
        assert.equal(await status(jwt), 200, 'expected native token to pass: ' + String(azp));
        assert.equal(await status(jwt, webOrigin), 401, 'native token must not pass browser Origin: ' + String(azp));
        assert.equal(await status(jwt, otherAllowedOrigin), 401, 'native token must not pass other browser Origin');
    }
    assert.equal(await status(await token({ azp: 'https://evil.example' })), 401);
    assert.equal(await status(await token({ azp: 'clerk://other.app.callback' })), 401);
    assert.equal(await status(await token({ azp: 'com.mazendev.taskitator.evil' })), 401);
});

test('native path preserves JWT signature, issuer, expiry, status and active-session checks', async () => {
    assert.equal(await status(await token({ azp: undefined, exp: 0 })), 401);
    assert.equal(await status(await token({ azp: undefined, iss: 'https://attacker.example' })), 401);
    assert.equal(await status(await token({ azp: undefined, nbf: Math.floor(Date.now()/1000) + 100 })), 401);
    assert.equal(await status(await token({ azp: undefined, sts: 'pending' })), 401);
    assert.equal(await status(await token({ azp: undefined }, { alg: 'HS256' })), 401);
    const good = await token({ azp: undefined });
    const parts = good.split('.');
    parts[1] = encode({ iss: issuer, sub: 'user_ABC', sid: 'sess_ABC', azp: undefined, exp: 9999999999, iat: 1, nbf: 1 });
    assert.equal(await status(parts.join('.')), 401); // Tampered payload cannot reuse signature.
    sessionStatus = 'revoked';
    assert.equal(await status(good), 401);
    sessionStatus = 'active';
    sessionOwner = 'user_Other';
    assert.equal(await status(good), 401);
    sessionOwner = 'user_ABC';
    assert.equal(await status(good), 200);
});

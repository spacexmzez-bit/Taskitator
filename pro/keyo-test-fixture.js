// Test-only signing keys; never imported by the deployed Worker.
import { KEYO_DEFAULTS } from './keyo-license.js';
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
export const testPublicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
export const testEnv={KEYO_PUBLIC_JWK:JSON.stringify(testPublicKey)};
export async function signedToken(accountId,overrides={},header={alg:'ES256',typ:'KEYO'}) {
    const now=Date.now();
    const payload={v:1,projectId:KEYO_DEFAULTS.projectId,accountId,keyId:'test-key',bindingId:'test-binding-'+accountId,
        tier:'PRO',expiresAt:now+30*86400000,issuedAt:now,validUntil:now+86400000,...overrides};
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const input=b64(header)+'.'+b64(payload);
    const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(input));
    return input+'.'+Buffer.from(sig).toString('base64url');
}
export async function activeLicense(accountId,overrides={}) {
    const token=await signedToken(accountId,overrides);
    const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
    return {account_id:accountId,status:'active',tier:'pro',signed_token:token,expires_at:p.expiresAt,
        valid_until:p.validUntil,keyo_version:1,last_verified_at:Date.now(),use_byok:false};
}

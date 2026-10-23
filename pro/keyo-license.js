import { liveAccount } from './account-lifecycle.js';
// Server-only subscription verification. Public settings from the owner's configured Keyo SDK.
export const KEYO_DEFAULTS = Object.freeze({
    endpoint: 'https://keyo.mazendev.com',
    projectId: 'prj_3ebe1ea2ab5948fd98bca332fad2e5c5',
    publicKey: {kty:'EC',crv:'P-256',x:'12kmFYFug4HYBs-ZTpRleElP9Q8kpQaI5aVyG9CqVOc',
        y:'Up7x4X65FL-LaRweIptSkCZsXN4A3mZM7XIIHRzNndY',ext:true,key_ops:['verify']}
});
const DAY = 86400000, HOUR = 3600000;
const DENIED = new Set(['SUSPENDED','REVOKED','DELETED','EXPIRED','INVALID_ENTITLEMENT','INVALID_PROJECT','KEY_UNAVAILABLE','KEY_NOT_FOUND','INVALID_KEY']);
const issue = (code,message,status=400) => Object.assign(new Error(message),{code,status});
const decode = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Encoding');
    return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
};
const parse = value => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(value)));

export function keyoConfig(env={}) {
    try {
        const endpoint = env.KEYO_API_ORIGIN ?? env.KEYO_API_URL ?? KEYO_DEFAULTS.endpoint;
        const url = new URL(endpoint);
        const projectId = env.KEYO_PROJECT_ID ?? env.KEYO_CLIENT_ID ?? KEYO_DEFAULTS.projectId;
        const rawKey = env.KEYO_PUBLIC_JWK ?? KEYO_DEFAULTS.publicKey;
        const publicKey = typeof rawKey === 'string' ? JSON.parse(rawKey) : rawKey;
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
            (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) || publicKey?.kty !== 'EC' || publicKey?.crv !== 'P-256' ||
            !publicKey.x || !publicKey.y || publicKey.d) throw Error('Configuration');
        return {endpoint:url.origin,projectId,publicKey};
    } catch { throw issue('KEYO_SETUP_REQUIRED','Keyo settings are invalid. Ask the operator to check KEYO_API_ORIGIN, KEYO_PROJECT_ID and KEYO_PUBLIC_JWK in the Worker.',503); }
}

export async function verifyKeyoToken(token,accountId,config,{allowExpired=false,now=Date.now()}={}) {
    try {
        if (typeof token !== 'string' || token.length > 4096) throw Error('Token');
        const parts=token.split('.');
        if (parts.length !== 3) throw Error('Token');
        const header=parse(parts[0]);
        if (header.alg !== 'ES256' || header.typ !== 'KEYO') throw Error('Header');
        const key=await crypto.subtle.importKey('jwk',config.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
        if (!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]))) throw Error('Signature');
        const p=parse(parts[1]);
        if (p.v !== 1 || p.projectId !== config.projectId || p.accountId !== accountId ||
            !['pro','max'].includes(p.tier?.toLowerCase()) || typeof p.keyId !== 'string' || !p.keyId ||
            typeof p.bindingId !== 'string' || !p.bindingId || !Number.isSafeInteger(p.issuedAt) || p.issuedAt < 0 ||
            !Number.isSafeInteger(p.validUntil) || p.validUntil <= p.issuedAt || p.validUntil > p.issuedAt+DAY ||
            p.issuedAt > now+60000 || !(p.expiresAt === null || Number.isSafeInteger(p.expiresAt)) ||
            (p.expiresAt !== null && p.validUntil > p.expiresAt)) throw Error('Claims');
        if (!allowExpired && (p.validUntil <= now || (p.expiresAt !== null && p.expiresAt <= now)))
            throw issue('KEY_EXPIRED','This Keyo entitlement has expired. Refresh or reactivate your license.');
        return p;
    } catch(e) {
        if(e.code === 'KEY_EXPIRED') throw e;
        throw issue('INVALID_ENTITLEMENT','Keyo returned an invalid, mismatched or untrusted entitlement. Ask the operator to check the project and public verification key.');
    }
}

export class KeyoLicenses {
    constructor(gateway) { this.storage=gateway.storage;this.env=gateway.env;this.pending=new Map(); }
    async request(action,accountId,body,config=keyoConfig(this.env)) {
        let response,data;
        try {
            const url=new URL('/api/v1/'+action,config.endpoint);url.searchParams.set('projectId',config.projectId);
            response=await fetch(url.toString(),{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({accountId,...body}),redirect:'error',signal:AbortSignal.timeout(10000)});
            data=await response.json();
        } catch { throw issue('KEYO_NETWORK_ERROR','Keyo is temporarily unavailable. Please retry shortly.',503); }
        if(!response.ok) {
            const code=typeof data?.error === 'string' && DENIED.has(data.error) ? data.error : null;
            if(code) throw issue(code,'Keyo rejected this license ('+code+'). Check its status and assigned account in Keyo.',403);
            throw issue('KEYO_UNAVAILABLE','Keyo could not verify the license. Please retry or ask the operator to check the Keyo service.',503);
        }
        return {token:data?.entitlement,payload:await verifyKeyoToken(data?.entitlement,accountId,config)};
    }
    record(accountId,verified,previous={},extra={}) {
        const {token,payload:p}=verified;
        return {...previous,...extra,account_id:accountId,tier:p.tier.toLowerCase(),status:'active',signed_token:token,
            expires_at:p.expiresAt,valid_until:p.validUntil,last_verified_at:Date.now(),keyo_version:1,
            keyo_key_id:p.keyId,keyo_binding_id:p.bindingId,policy_version:'2.0',
            credits_daily_limit:45,credits_monthly_limit:1000,use_byok:Boolean(previous.use_byok)};
    }
    async resolve(accountId) {
        if(this.pending.has(accountId)) return this.pending.get(accountId);
        const promise=this.refresh(accountId);
        this.pending.set(accountId,promise);
        try { return await promise; } finally { if(this.pending.get(accountId)===promise)this.pending.delete(accountId); }
    }
    async refresh(accountId) {
        const key='pro:entitlement:'+accountId,old=await this.storage.get(key);
        if(!old) return null;
        const inactive=status=>({...old,status});
        if(!old.signed_token) return inactive('verification_required');
        if(['revoked','invalid'].includes(old.status)) return old;
        await liveAccount(this.storage,accountId);
        const config=keyoConfig(this.env);
        let payload;
        try { payload=await verifyKeyoToken(old.signed_token,accountId,config,{allowExpired:true}); }
        catch { return this.updateIfCurrent(key,old,inactive('invalid')); }
        const now=Date.now();
        const validCache=old.keyo_version===1 && old.status==='active' && payload.validUntil>now &&
            (payload.expiresAt===null || payload.expiresAt>now);
        if(validCache && now-payload.issuedAt<HOUR) return {...this.record(accountId,{token:old.signed_token,payload},old),last_verified_at:old.last_verified_at};
        try {
            const verified=await this.request('verify',accountId,{entitlement:old.signed_token},config);
            // Verification refreshes the same key/binding; replacement requires explicit activation.
            if(verified.payload.keyId!==payload.keyId || verified.payload.bindingId!==payload.bindingId)
                throw issue('INVALID_ENTITLEMENT','Keyo returned a different license binding. Reactivate your license.');
            return this.updateIfCurrent(key,old,this.record(accountId,verified,old));
        } catch(e) {
            if(DENIED.has(e.code)) return this.updateIfCurrent(key,old,inactive(e.code==='EXPIRED'?'expired':'revoked'));
            if(validCache && ['KEYO_NETWORK_ERROR','KEYO_UNAVAILABLE'].includes(e.code))
                return {...this.record(accountId,{token:old.signed_token,payload},old),last_verified_at:old.last_verified_at};
            throw e;
        }
    }
    async updateIfCurrent(key,old,next) {
        return this.storage.transaction(async tx=>{
            await liveAccount(tx,old.account_id);
            const current=await tx.get(key);
            if(!current || current.signed_token!==old.signed_token || current.status!==old.status) return current || null;
            // Preserve a BYOK toggle made while Keyo was responding.
            next.use_byok=Boolean(current.use_byok);
            await tx.put(key,next);return next;
        });
    }
}

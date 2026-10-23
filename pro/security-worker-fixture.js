import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TaskitatorSync, evaluateStatus } from '../cloudflare/worker.js';
import { sha256 } from '../cloudflare/auth.js';
import { RECOVERY_MS } from '../cloudflare/deletion.js';

// Real RSA signatures exercise Web Crypto; only provider HTTP and DO storage
// are substituted. This never contacts the user's deployed service.
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const der = await crypto.subtle.exportKey('spki', keys.publicKey);
const publicKey = '-----BEGIN PUBLIC KEY-----\n' + Buffer.from(der).toString('base64') + '\n-----END PUBLIC KEY-----';
const origin = 'https://taskitator.mazendev.com';
const issuer = 'https://example.clerk.accounts.dev';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function jwt(user = 'user_A', overrides = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const data = encoded({ alg: 'RS256', typ: 'JWT', ...header }) + '.' + encoded({
        iss: issuer, sub: user, sid: 'sess_' + user.slice(5), azp: origin, iat: now, nbf: now - 1, exp: now + 60, ...overrides });
    return data + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data))).toString('base64url');
}
class Store {
    map = new Map(); tail = Promise.resolve();
    alarm = null;
    async getAlarm() { return this.alarm; }
    async setAlarm(value) { this.alarm = value; }
    async list({prefix='',limit=1000,startAfter}={}) {
        return new Map([...this.map].filter(([key])=>key.startsWith(prefix) && (!startAfter || key>startAfter))
            .sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,limit).map(([key,value])=>[key,structuredClone(value)]));
    }
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, structuredClone(this.map.get(k))])) : structuredClone(this.map.get(key)); }
    async put(key, value) { if (typeof key === 'object') for (const [k,v] of Object.entries(key)) this.map.set(k, structuredClone(v)); else this.map.set(key, structuredClone(value)); }
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k); }
    async transaction(fn) {
        const run = async () => {
            const before = structuredClone(this.map);
            try { return await fn(this); } catch (err) { this.map = before; throw err; }
        };
        const result = this.tail.then(run, run); this.tail = result.catch(() => {}); return result;
    }
}
function fixture() {
    const storage = new Store(), kv = new Map();
    const env = { CLERK_JWT_KEY: publicKey, CLERK_SECRET_KEY: 'test-only', CLERK_ISSUER: issuer,
        ALLOWED_ORIGINS: origin, LEGACY_MIGRATION_OWNERS: '{"rd":"rd@example.com"}',
        LEGACY_MIGRATION_UNTIL: new Date(Date.now() + 86400000).toISOString(),
        TASKITATOR_KV: {
            put: async (key,value) => {kv.set(key,JSON.parse(value));},
            get: async key => {if(kv.get(key)==='__invalid_json__')throw new SyntaxError('corrupt');return structuredClone(kv.get(key) || null);},
            delete: async key => {kv.delete(key);},
            list: async ({prefix='',limit=1000,cursor}={}) => {
                const keys=[...kv.keys()].filter(key=>key.startsWith(prefix) && (!cursor || key>cursor)).sort();
                return {keys:keys.slice(0,limit).map(name=>({name})),list_complete:keys.length<=limit,cursor:keys.length>limit?keys[limit-1]:undefined};
            }
        } };
    const service = new TaskitatorSync({ storage }, env);
    let verificationOverrides = {};
    let revoked = false, verificationStatus='complete', deleteFailure=false, googleToken=null, providerStatus=200;
    let claudeResponse={model:'claude-haiku-5-5',stop_reason:'end_turn',content:[{type:'text',text:'Hello from Claude'}],usage:{input_tokens:12,output_tokens:4}};
    const providerCalls=[];
    const deletedUsers=new Set(),sessionOwners=new Map();
    globalThis.fetch = async (url,options={}) => {
        if(String(url).startsWith('https://api.anthropic.com/v1/')){
            providerCalls.push({url:String(url),options});
            if(providerStatus!==200)return Response.json({error:{message:'provider diagnostic secret'}},{status:providerStatus});
            if(String(url).includes('/models/'))return Response.json({id:'claude-haiku-5-5',type:'model'});
            return Response.json(typeof claudeResponse==='function'?await claudeResponse(options):claudeResponse);
        }
        if(String(url).startsWith('https://generativelanguage.googleapis.com/')) {
            providerCalls.push({url:String(url),options});
            return providerStatus===200?Response.json(String(url).includes(':generateContent')?
                {candidates:[{content:{parts:[{text:'{"score":9,"passed":true}'}]}}]}:{name:'models/gemini-3.5-flash-lite'}):Response.json({error:{message:'provider diagnostic secret'}},{status:providerStatus});
        }
        if(String(url).includes('/reverifications/')) {
            const path = new URL(url).pathname.split('/'), now = Date.now();
            return Response.json({object:'reverification',id:path.at(-1),session_id:path[3],
                user_id:'user_'+path[3].slice(5),level:'first_factor',status:verificationStatus,
                created_at:now,first_factor_verified_at:verificationStatus==='complete'?now:null,
                second_factor_verified_at:null,updated_at:now,...verificationOverrides});
        }
        if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({id_token:googleToken});
        if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[{...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'google-key'}]});
        if(options.method==='DELETE' && String(url).includes('/users/')) {
            if(deleteFailure)return Response.json({error:'temporary'}, {status:503});
            deletedUsers.add(String(url).split('/').pop());return Response.json({deleted:true});
        }
        if (String(url).includes('/sessions/')) {
            const id = String(url).split('/').pop();
            const userId=sessionOwners.get(id)||'user_'+id.slice(5);
            return Response.json({ status: revoked || deletedUsers.has(userId) ? 'revoked' : 'active', user_id:userId });
        }
        if (String(url).endsWith('/users/user_A')) return Response.json({ primary_email_address_id: 'email1',
            email_addresses: [{ id: 'email1', email_address: 'rd@example.com', verification: { status: 'verified' } }],
            external_accounts:[{provider:'oauth_google',provider_user_id:'google_A',verification:{status:'verified'}}] });
        return Response.json({ primary_email_address_id: 'email2',
            email_addresses: [{ id: 'email2', email_address: 'other@example.com', verification: { status: 'verified' } }] });
    };
    async function call(path, token, method = 'GET', body, extra = {}) {
        const res = await service.fetch(new Request('https://worker.test' + path, { method,
            headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Origin: origin,
                'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1', ...extra },
            ...(body ? { body: JSON.stringify(body) } : {}) }));
        return { status: res.status, body: await res.json() };
    }
    return { storage, kv, env, service, call, deletedUsers, sessionOwners, revoke: () => { revoked = true; },
        setVerificationResponse:value=>{verificationOverrides=value},
        setVerificationStatus:value=>{verificationStatus=value},setDeleteFailure:value=>{deleteFailure=value},
        setGoogleToken:value=>{googleToken=value},providerCalls,setProviderStatus:value=>{providerStatus=value},setClaudeResponse:value=>{claudeResponse=value} };
}
async function create(f, user = 'user_A') {
    const token = await jwt(user);
    const result = await f.call('/auth/account', token, 'POST', { mode: 'create' });
    assert.equal(result.status, 200);
    return { token, user: result.body.account.user };
}

function enableVault(f) {
    f.env.API_VAULT_KEYS=JSON.stringify({v1:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')});
    f.env.API_VAULT_ACTIVE_KEY_ID='v1';
}
let keyChallenge=0;
async function keyProof(f,a,action,stage_id=null,provider='gemini') {
    const start=await f.call('/auth/verification/start',a.token,'POST',{method:'password',action,stage_id,provider});
    assert.equal(start.status,200,JSON.stringify(start.body));
    const token=await jwt('user_A',{taskitator_reverification_id:'rv_key_'+(++keyChallenge),fva:[0,-1]});
    const verification_id=start.body.verification_id;
    assert.equal((await f.call('/auth/verification/password',token,'POST',{verification_id,action})).status,200);
    return {verification_id,stage_id,provider};
}
async function saveKey(f,a,key='AIza-test-secret-123456789',provider='gemini') {
    const body=await keyProof(f,a,'api-key-save',null,provider);
    const result=await f.call('/ai/keys',a.token,'POST',{...body,key});
    assert.equal(result.status,200,JSON.stringify(result.body));return result;
}

async function verifiedDeletion(f, token, user='user_A', rv='rv_fresh') {
    f.env.ACCOUNT_DELETION_ENABLED='true';
    const started=await f.call('/auth/verification/start',token,'POST',{method:'password'});
    assert.equal(started.status,200);
    const fresh=await jwt(user,{fva:[0,-1],taskitator_reverification_id:rv});
    const verified=await f.call('/auth/verification/password',fresh,'POST',{verification_id:started.body.verification_id});
    assert.equal(verified.status,200);
    return {token:fresh,verification_id:started.body.verification_id,receipt:crypto.randomUUID().replaceAll('-','').repeat(2),
        blocker_disabled:true,phrase:'Macrodroid disabled'};
}
async function finishDeletion(f) {for(let i=0;i<12 && (await f.storage.list({prefix:'deletion-job:'})).size;i++)await f.service.alarm();}
export {fixture,create,jwt,verifiedDeletion,finishDeletion,enableVault,saveKey};

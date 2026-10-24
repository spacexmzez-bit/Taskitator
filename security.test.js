// ============================================================================
// Taskitator Consolidated Security & Worker Test Suite (security.test.js)
// Combines: tests/security.test.js, pro/security-fixes.test.js,
// pro/security-worker-fixture.js, and pro/keyo-test-fixture.js.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TaskitatorSync, evaluateStatus, sha256, RECOVERY_MS } from './worker.js';
import { KEYO_DEFAULTS, POLICY, periods, newOperation } from './pro-backend.js';

// Test-only signing keys; never imported by the deployed Worker.
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const testPublicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
const testEnv={KEYO_PUBLIC_JWK:JSON.stringify(testPublicKey)};
async function signedToken(accountId,overrides={},header={alg:'ES256',typ:'KEYO'}) {
    const now=Date.now();
    const payload={v:1,projectId:KEYO_DEFAULTS.projectId,accountId,keyId:'test-key',bindingId:'test-binding-'+accountId,
        tier:'PRO',expiresAt:now+30*86400000,issuedAt:now,validUntil:now+86400000,...overrides};
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const input=b64(header)+'.'+b64(payload);
    const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(input));
    return input+'.'+Buffer.from(sig).toString('base64url');
}
async function activeLicense(accountId,overrides={}) {
    const token=await signedToken(accountId,overrides);
    const p=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
    return {account_id:accountId,status:'active',tier:'pro',signed_token:token,expires_at:p.expiresAt,
        valid_until:p.validUntil,keyo_version:1,last_verified_at:Date.now(),use_byok:false};
}


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
test('Claude and Gemini retain separate encrypted keys and provider selection persists without exposing either key',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);
    assert.equal((await f.call('/ai/provider',a.token,'POST',{provider:'claude'})).status,409);
    await saveKey(f,a);await saveKey(f,a,'sk-ant-claude-secret-123456','claude');
    const state=(await f.call('/ai/keys?provider=claude',a.token)).body;
    assert.equal(state.provider,'claude');assert.equal(state.providers.gemini.saved,true);assert.equal(state.providers.claude.saved,true);
    assert.equal(state.selected_provider,'gemini');assert.equal(JSON.stringify([...f.storage.map]).includes('sk-ant-claude-secret'),false);
    assert.equal((await f.call('/ai/provider',a.token,'POST',{provider:'claude'})).body.selected_provider,'claude');
    assert.equal((await f.call('/ai/keys',a.token)).body.selected_provider,'claude');
    assert.equal((await f.call('/ai/provider',a.token,'POST',{provider:'gemini'})).body.providers.claude.saved,true);
    assert.equal((await f.call('/ai/keys?provider=other',a.token)).status,400);
});
test('Claude save and connection checks use only zero-generation model metadata with header authentication',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-test-no-generation','claude');
    const test=await f.call('/ai/keys/test',a.token,'POST',{provider:'claude'});assert.equal(test.status,200);assert.equal(test.body.generated_tokens,0);
    assert.equal(f.providerCalls.length,2);
    for(const call of f.providerCalls){assert.equal(call.url,'https://api.anthropic.com/v1/models/claude-haiku-5-5');assert.equal(call.options.method,undefined);assert.equal(call.options.body,undefined);assert.equal(call.options.headers['x-api-key'],'sk-ant-test-no-generation');}
});
test('provider-bound proofs cannot reveal, replace or remove the other provider key',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);await saveKey(f,a,'sk-ant-private-123456','claude');
    const reveal=await keyProof(f,a,'api-key-reveal',null,'claude');
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{...reveal,provider:'gemini'})).status,403);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',reveal)).body.key,'sk-ant-private-123456');
    const remove=await keyProof(f,a,'api-key-delete',null,'claude');
    assert.equal((await f.call('/ai/keys',a.token,'DELETE',{...remove,provider:'gemini'})).status,403);
    assert.equal((await f.call('/ai/keys',a.token,'DELETE',remove)).body.providers.gemini.saved,true);
    assert.equal((await f.call('/ai/keys',a.token)).body.providers.claude.saved,false);
});
test('provider ciphertext substitution fails authentication even for the same owner',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    const identity={userId:'user_A'},record=await f.storage.get(await f.service.vault.recordKey(identity));
    await assert.rejects(()=>f.service.vault.unseal(identity,record,'claude'));
    await assert.rejects(()=>f.service.vault.unseal(identity,{...record,provider:'claude'},'claude'));
});
test('Claude chat uses only its saved key, allowed model and Messages API, and never silently falls back',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);await saveKey(f,a,'sk-ant-cl-key-1234','claude');
    await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    const payload={contents:[{role:'user',parts:[{text:'Hello'}]}],generationConfig:{temperature:0.2}};
    const request={provider:'claude',model:'claude-haiku-5-5',payload};
    const result=await f.call('/ai/generate',a.token,'POST',request);assert.equal(result.status,200);assert.equal(result.body.candidates[0].content.parts[0].text,'Hello from Claude');
    const call=f.providerCalls.at(-1),body=JSON.parse(call.options.body);assert.equal(call.url,'https://api.anthropic.com/v1/messages');assert.equal(call.options.headers['x-api-key'],'sk-ant-cl-key-1234');
    assert.equal(body.temperature,undefined);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.output_config.effort,'low');assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.messages[0].content[0].text,'Hello');
    assert.equal((await f.call('/ai/generate',a.token,'POST',{...request,model:'claude-sonnet-5-5'})).status,400);
    assert.equal((await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.5-flash-lite',payload})).status,409);
    f.setProviderStatus(529);const count=f.providerCalls.length;
    assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,503);assert.equal(f.providerCalls.length,count+1);
});
test('Gemini incomplete output is rejected before any tool action or audit approval is returned',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    const previousFetch=globalThis.fetch;
    globalThis.fetch=async(url,options)=>String(url).includes(':generateContent')?Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{functionCall:{name:'trash_task',args:{id:'x'}}}]}}]}):previousFetch(url,options);
    const result=await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.5-flash-lite',payload:{contents:[{parts:[{text:'Test'}]}]}});
    assert.equal(result.status,502);assert.equal(result.body.candidates,undefined);
});
test('Claude preserves audit image/PDF parts and uses strict output schemas; invalid results never approve',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-for-audit-1234','claude');await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    const payload={taskitatorFormat:'proof',contents:[{parts:[{text:'Review evidence'},{inline_data:{mime_type:'image/png',data:'aGVsbG8='}},{inline_data:{mime_type:'application/pdf',data:'cGRm'}}]}],generationConfig:{responseMimeType:'application/json'}};
    const request={provider:'claude',model:'claude-haiku-5-5',payload};
    f.setClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text:'{"verdict":"approved","confidence":0.9,"critique":"Evidence matches"}'}]});
    assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,200);
    const body=JSON.parse(f.providerCalls.at(-1).options.body);assert.equal(body.messages[0].content[1].type,'image');assert.equal(body.messages[0].content[2].type,'document');assert.equal(body.output_config.format.schema.additionalProperties,false);
    for(const raw of [null,{verdict:'approved'}, {verdict:'approved',confidence:2,critique:'bad'}]){
        f.setClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(raw)}]});assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,502);
    }
    f.setClaudeResponse({stop_reason:'refusal',content:[{type:'text',text:'No'}]});assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,422);
    f.setClaudeResponse({stop_reason:'max_tokens',content:[{type:'text',text:'partial'}]});assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,502);
    payload.contents[0].parts=[{inlineData:{mimeType:'image/heic',data:'aGVsbG8='}}];const count=f.providerCalls.length;
    assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,415);assert.equal(f.providerCalls.length,count);
});
test('Claude tool identifiers round-trip across real adapter calls and locked tasks remain client-owned',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-for-tools-1234','claude');await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    const payload={contents:[{role:'user',parts:[{text:'List tasks'}]}],tools:[{functionDeclarations:[{name:'get_tasks',parameters:{type:'OBJECT',properties:{}}}]}]};
    const request={provider:'claude',model:'claude-haiku-5-5',payload};
    f.setClaudeResponse({stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_real_123',name:'get_tasks',input:{}}]});
    const answer=await f.call('/ai/generate',a.token,'POST',request);assert.equal(answer.status,200);
    const part=answer.body.candidates[0].content.parts[0];assert.equal(part.functionCall.id,'toolu_real_123');
    payload.contents.push({role:'model',parts:[part]},{role:'user',parts:[{functionResponse:{id:'toolu_real_123',name:'get_tasks',response:{tasks:[]}}}]});
    f.setClaudeResponse({stop_reason:'end_turn',content:[{type:'text',text:'No tasks'}]});assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,200);
    const forwarded=JSON.parse(f.providerCalls.at(-1).options.body);assert.equal(forwarded.tools[0].input_schema.type,'object');assert.equal(forwarded.messages[2].content[0].tool_use_id,'toolu_real_123');
    payload.contents[2].parts[0].functionResponse.id='toolu_wrong';assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,400);
});
test('an AI provider/key change while Claude is running rejects its result instead of applying it',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);await saveKey(f,a,'sk-ant-inflight-1234','claude');await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    let release,started;const didStart=new Promise(resolve=>{started=resolve;});const blocked=new Promise(resolve=>{release=resolve;});
    f.setClaudeResponse(async()=>{started();await blocked;return {stop_reason:'end_turn',content:[{type:'text',text:'Old answer'}]};});
    const running=f.call('/ai/generate',a.token,'POST',{provider:'claude',model:'claude-haiku-5-5',payload:{contents:[{parts:[{text:'Test'}]}]}});
    await didStart;await f.call('/ai/provider',a.token,'POST',{provider:'gemini'});release();assert.equal((await running).status,409);
});
test('concurrent generation limits are shared across providers and released after a provider change',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);await saveKey(f,a,'sk-ant-concurrent-1234','claude');await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    let release,notify,count=0;const blocked=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{notify=resolve;});
    f.setClaudeResponse(async()=>{if(++count===2)notify();await blocked;return {stop_reason:'end_turn',content:[{type:'text',text:'Done'}]};});
    const payload={contents:[{parts:[{text:'Test'}]}]},request={provider:'claude',model:'claude-haiku-5-5',payload};
    const one=f.call('/ai/generate',a.token,'POST',request),two=f.call('/ai/generate',a.token,'POST',request);await started;
    assert.equal((await f.call('/ai/generate',a.token,'POST',request)).status,429);
    await f.call('/ai/provider',a.token,'POST',{provider:'gemini'});
    const gemini={model:'gemini-3.5-flash-lite',payload};assert.equal((await f.call('/ai/generate',a.token,'POST',gemini)).status,429);
    release();assert.deepEqual((await Promise.all([one,two])).map(result=>result.status),[409,409]);
    assert.equal((await f.call('/ai/generate',a.token,'POST',gemini)).status,200);
});
test('Phase 2 encrypted Claude archives recover into protected pending keys without changing active Gemini',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);
    const identity={userId:'user_A'},prefix='vault:'+await f.service.vault.prefix(identity)+':claude-archive';
    await f.storage.put(prefix,await f.service.vault.seal(identity,'sk-ant-phase2-archive-1234','active','claude'));
    const result=(await f.call('/ai/keys?provider=claude',a.token)).body;assert.equal(result.pending.length,1);assert.equal(result.saved,false);assert.equal(result.selected_provider,'gemini');assert.equal(await f.storage.get(prefix),undefined);
    assert.equal((await f.call('/ai/keys',a.token,'POST',await keyProof(f,a,'api-key-save',result.pending[0].id,'claude'))).body.providers.claude.saved,true);
});

test('vault fails closed without encryption setup and phone tokens cannot access any AI endpoint',async()=>{
    const f=fixture(),a=await create(f);
    assert.equal((await f.call('/ai/keys',a.token)).body.ready,false);
    assert.equal((await f.call('/auth/verification/start',a.token,'POST',{method:'password',action:'api-key-save'})).status,503);
    const phone=(await f.call('/auth/phone',a.token,'POST')).body.token;
    for(const path of ['/ai/keys','/ai/generate','/ai/keys/reveal','/ai/keys/stage'])assert.equal((await f.call(path,phone,'POST',{})).status,403);
});
test('vault stores AES-GCM ciphertext, keeps sync key-free, and requires a one-use action proof for reveal',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);const key='AIza-test-secret-123456789';
    const saved=await saveKey(f,a,key);assert.equal(saved.body.suffix,key.slice(-4));assert.equal(saved.body.test.generated_tokens,0);
    assert.equal(JSON.stringify([...f.storage.map]).includes(key),false);
    assert.equal(f.providerCalls[0].options.method,undefined);assert.equal(f.providerCalls[0].url.includes(key),false);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{})).status,403);
    const proof=await keyProof(f,a,'api-key-reveal');
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',proof)).body.key,key);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',proof)).status,403);
    const snapshot={tasks:[],settings:{gemini_api_key:'overwrite-attempt',claude_api_key:'other',day_start_hour:2},base_version:0,mutation_id:'vault-sync-one'};
    assert.equal((await f.call('/sync/push',a.token,'POST',snapshot)).status,200);
    const pulled=await f.call('/sync/pull',a.token);assert.equal(pulled.body.settings.gemini_api_key,undefined);
    assert.equal(pulled.body.settings.claude_api_key,undefined);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',await keyProof(f,a,'api-key-reveal'))).body.key,key);
});
test('key actions bind to owner, session, action and current saved revision',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');enableVault(f);await saveKey(f,a);
    const reveal=await keyProof(f,a,'api-key-reveal');
    assert.equal((await f.call('/ai/keys',a.token,'DELETE',reveal)).status,403);
    assert.equal((await f.call('/ai/keys/reveal',b.token,'POST',reveal)).status,403);
    const row='action-proof:'+await sha256(reveal.verification_id),record=await f.storage.get(row);
    await f.storage.put(row,{...record,sessionId:'sess_other'});
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',reveal)).status,403);
    await f.storage.put(row,record);await saveKey(f,a,'AIza-different-key-987654321');
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',reveal)).status,403);
    assert.equal((await f.call('/auth/verification/start',await jwt('user_A',{act:{sub:'admin'}}),'POST',{method:'password',action:'api-key-save'})).status,403);
});
test('browser recovery is encrypted and inactive until a verified selection; deletion cannot be undone by sync',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);
    const recovered='AIza-browser-recovered-key-1234';
    const staged=await f.call('/ai/keys/stage',a.token,'POST',{keys:[recovered]});
    assert.equal(staged.body.saved,false);assert.equal(staged.body.pending.length,1);
    assert.equal(JSON.stringify([...f.storage.map]).includes(recovered),false);
    const id=staged.body.pending[0].id;
    assert.equal((await f.call('/ai/keys',a.token,'POST',{stage_id:id})).status,403);
    const selected=await f.call('/ai/keys',a.token,'POST',await keyProof(f,a,'api-key-save',id));assert.equal(selected.status,200);assert.equal(selected.body.pending.length,0);
    assert.equal((await f.call('/ai/keys',a.token,'DELETE',await keyProof(f,a,'api-key-delete'))).body.saved,false);
    await f.call('/sync/push',a.token,'POST',{tasks:[],settings:{gemini_api_key:recovered},base_version:0,mutation_id:'do-not-restore'});
    assert.equal((await f.call('/ai/keys',a.token)).body.saved,false);
});
test('pending password verification cannot save or cause provider key checks; invalid keys keep the old key',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    const started=(await f.call('/auth/verification/start',a.token,'POST',{method:'password',action:'api-key-save'})).body;
    const count=f.providerCalls.length;
    assert.equal((await f.call('/ai/keys',a.token,'POST',{verification_id:started.verification_id,key:'another-key-1234'})).status,403);
    assert.equal(f.providerCalls.length,count);
    f.setProviderStatus(403);
    assert.equal((await f.call('/ai/keys',a.token,'POST',{...await keyProof(f,a,'api-key-save'),key:'wrong-key-1234'})).status,400);
    f.setProviderStatus(200);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',await keyProof(f,a,'api-key-reveal'))).body.key,'AIza-test-secret-123456789');
});
test('gateway sends keys only in provider headers, preserves payloads, rejects unsafe models/files and isolates users',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');enableVault(f);await saveKey(f,a);
    const payload={contents:[{role:'user',parts:[{text:'Review task'}]}],tools:[{functionDeclarations:[{name:'get_tasks',parameters:{type:'OBJECT'}}]}],generationConfig:{temperature:0.2}};
    const result=await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.5-flash-lite',payload});assert.equal(result.status,200);assert.ok(result.body.candidates);
    const call=f.providerCalls.at(-1);assert.equal(call.options.headers['x-goog-api-key'],'AIza-test-secret-123456789');assert.equal(call.url.includes('key='),false);
    const forwarded=JSON.parse(call.options.body);assert.deepEqual(forwarded.contents,payload.contents);assert.deepEqual(forwarded.tools,payload.tools);assert.equal(forwarded.generationConfig.candidateCount,1);
    assert.equal((await f.call('/ai/generate',b.token,'POST',{model:'gemini-3.5-flash-lite',payload})).status,404);
    assert.equal((await f.call('/ai/generate',a.token,'POST',{model:'unrestricted-costly-model',payload})).status,400);
    assert.equal((await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.5-flash-lite',payload:{contents:[{parts:[{fileData:{fileUri:'https://private.test'}}]}]}})).status,400);
    assert.equal((await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.5-flash-lite',payload:{...payload,generationConfig:{maxOutputTokens:999999}}})).status,400);
    f.setProviderStatus(429);const limited=await f.call('/ai/generate',a.token,'POST',{model:'gemini-3.1-flash-lite',payload});assert.equal(limited.status,429);assert.equal(JSON.stringify(limited.body).includes('diagnostic'),false);
});
test('ciphertext tampering, cross-user ciphertext swapping and lost key versions fail closed; retained versions work',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');enableVault(f);await saveKey(f,a);
    const aid={userId:'user_A'},bid={userId:'user_B'},name=await f.service.vault.recordKey(aid),original=await f.storage.get(name);
    const swapped=await f.service.vault.recordKey(bid);await f.storage.put(swapped,original);
    await assert.rejects(()=>f.service.vault.unseal(bid,original));
    await assert.rejects(()=>f.service.vault.unseal(aid,{...original,version:'f'.repeat(64)}));
    const old=JSON.parse(f.env.API_VAULT_KEYS);f.env.API_VAULT_KEYS=JSON.stringify({...old,v2:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')});f.env.API_VAULT_ACTIVE_KEY_ID='v2';
    assert.equal(await f.service.vault.unseal(aid,original),'AIza-test-secret-123456789');
    delete old.v1;f.env.API_VAULT_KEYS=JSON.stringify({v2:JSON.parse(f.env.API_VAULT_KEYS).v2});
    await assert.rejects(()=>f.service.vault.unseal(aid,original));assert.deepEqual(await f.storage.get(name),original);
});
test('legacy cloud keys migrate without changing tasks or sync revision and historical copies are scrubbed after encryption',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);
    const metaKey='account:'+encodeURIComponent(a.user),meta=await f.storage.get(metaKey);
    const raw={tasks:[{id:'keep-me',status:'active'}],settings:{gemini_api_key:'AIza-legacy-cloud-12345',day_start_hour:2},updated_at:'2026-01-01T00:00:00Z'};
    meta.has_snapshot=true;meta.chunks=1;meta.version=7;meta.legacy_disabled=true;
    await f.storage.put('snapshot:'+encodeURIComponent(a.user)+':0',JSON.stringify(raw));await f.storage.put(metaKey,meta);
    const pulled=await f.call('/sync/pull',a.token);assert.equal(pulled.body.version,7);assert.deepEqual(pulled.body.tasks,raw.tasks);assert.equal(pulled.body.settings.gemini_api_key,undefined);
    assert.equal((await f.call('/ai/keys',a.token)).body.saved,true);assert.equal(JSON.stringify([...f.storage.map]).includes('AIza-legacy-cloud-12345'),false);
    f.kv.set('user_data:history',{username:a.user,...raw});f.kv.set('user_data:other',{username:'other',...raw});
    await f.service.vault.cleanupLegacy();assert.equal(f.kv.get('user_data:history').settings.gemini_api_key,undefined);assert.equal(f.kv.get('user_data:other').settings.gemini_api_key,'AIza-legacy-cloud-12345');
});
test('an old invalid placeholder is recovered without blocking account access or becoming active',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);
    const key='account:'+encodeURIComponent(a.user),meta=await f.storage.get(key);
    meta.has_snapshot=true;meta.chunks=1;await f.storage.put(key,meta);
    await f.storage.put('snapshot:'+encodeURIComponent(a.user)+':0',JSON.stringify({tasks:[{id:'preserved'}],settings:{gemini_api_key:'test'}}));
    assert.equal((await f.call('/auth/me',a.token)).status,200);
    const state=await f.call('/ai/keys',a.token);assert.equal(state.body.saved,false);assert.equal(state.body.pending.length,1);
    const id=state.body.pending[0].id;
    assert.equal((await f.call('/ai/keys',a.token,'POST',await keyProof(f,a,'api-key-save',id))).status,400);
    assert.equal((await f.call('/sync/pull',a.token)).body.tasks[0].id,'preserved');
    assert.equal((await f.call('/ai/keys/stage',a.token,'POST',{keys:['old invalid key']})).status,200);
});
test('account deletion removes all encrypted keys, recovered copies and cleanup jobs',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    await saveKey(f,a,'sk-ant-delete-active-key-1234','claude');await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    await f.call('/ai/keys/stage',a.token,'POST',{keys:['AIza-staged-key-12345'],claude_keys:['sk-ant-preserved-12345']});
    const deletion=await verifiedDeletion(f,a.token);assert.equal((await f.call('/auth/account',deletion.token,'DELETE',deletion)).status,200);
    assert.equal((await f.call('/ai/generate',a.token,'POST',{})).status,410);
    for(let i=0;i<10;i++)await f.service.alarm();
    assert.equal([...f.storage.map.keys()].some(key=>key.startsWith('vault:')||key.startsWith('vault-stage:')||key.startsWith('vault-cleanup:')),false);
});

test('unknown legacy credentials cannot create accounts; auth is required', async () => {
    const f = fixture();
    assert.equal((await f.call('/sync/pull')).status, 401);
    assert.equal((await f.call('/sync/pull', 'a'.repeat(64), 'GET', null, { 'X-Taskitator-User': 'victim' })).status, 401);
    assert.equal(f.storage.map.has('account:victim'), false);
});
test('JWT checks reject expired, wrong issuer/origin, pending, forged, and wrong algorithm tokens', async () => {
    const f = fixture();
    for (const claims of [{ exp: 0 }, { iss: 'https://evil.test' }, { azp: 'https://evil.test' },
        { nbf: Math.floor(Date.now()/1000) + 100 }, { sts: 'pending' }, { sid: 'sess_X' }, { azp: undefined }]) {
        assert.equal((await f.call('/auth/me', await jwt('user_A', claims))).status, 401);
    }
    assert.equal((await f.call('/auth/me', await jwt('user_A', {}, { alg: 'HS256' }))).status, 401);
    const good = await jwt();
    const parts = good.split('.'); parts[1] = encoded({ sub: 'user_B' });
    assert.equal((await f.call('/auth/me', parts.join('.'))).status, 401);
});
test('live provider revocation rejects a previously valid unexpired JWT', async () => {
    const f = fixture(), token = await jwt();
    assert.equal((await f.call('/auth/me', token)).status, 200);
    f.revoke(); assert.equal((await f.call('/auth/me', token)).status, 401);
});
test('missing configuration fails closed', async () => {
    const f = fixture(); delete f.env.CLERK_JWT_KEY;
    assert.equal((await f.call('/auth/me', await jwt())).status, 503);
});
test('accounts are created explicitly and remain isolated despite forged username headers', async () => {
    const f = fixture(), a = await create(f), b = await create(f, 'user_B');
    const snapshot = { username: a.user, tasks: [{ id: 'private', title: 'Private', status: 'active' }],
        settings: { worker_passkey: 'leaked', session_token: 'leaked', day_start_hour: 2 },
        base_version: 0, mutation_id: 'mutation1', recurrence_schema: 1 };
    assert.equal((await f.call('/sync/push', a.token, 'POST', snapshot)).status, 200);
    const other = await f.call('/sync/pull', b.token, 'GET', null, { 'X-Taskitator-User': a.user });
    assert.equal(other.body.empty, true);
    assert.equal((await f.call('/sync/push', b.token, 'POST', snapshot)).status, 400);
    const saved = await f.call('/sync/pull', a.token);
    assert.equal(saved.body.tasks[0].title, 'Private'); assert.equal(saved.body.version, 1);
    assert.equal(saved.body.settings.worker_passkey, undefined); assert.equal(saved.body.settings.session_token, undefined);
    assert.equal((await f.call('/sync/push', a.token, 'POST', { ...snapshot, mutation_id: 'mutation2' })).status, 409);
    assert.equal((await f.call('/sync/push', a.token, 'POST', snapshot)).body.version, 1);
});
test('phone tokens can read status only, rotate, revoke, and survive browser session revocation', async () => {
    const f = fixture(), a = await create(f);
    const issued = await f.call('/auth/phone', a.token, 'POST');
    assert.match(issued.body.token, /^tkp_[a-f0-9]{64}$/);
    const phone = issued.body.token;
    assert.equal((await f.call('/?action=status&format=json', phone)).status, 200);
    for (const [path, method] of [['/sync/pull','GET'],['/sync/push','POST'],['/auth/account','POST'],['/auth/phone','POST'],['/auth/me','GET']]) {
        assert.equal((await f.call(path, phone, method)).status, 403);
    }
    assert.equal((await f.call('/auth/phone', a.token)).body.token, undefined);
    const newPhone = (await f.call('/auth/phone', a.token, 'POST')).body.token;
    assert.equal((await f.call('/status', phone)).status, 401);
    f.revoke(); assert.equal((await f.call('/status', newPhone)).status, 200);
    // New fixture's provider state is active, but storage and phone record stay the same.
    fixture();
    assert.equal((await f.call('/auth/phone', a.token, 'DELETE')).status, 200);
    assert.equal((await f.call('/status', newPhone)).status, 401);
});
test('legacy migration requires correct password, owner-approved verified email, and an open deadline', async () => {
    const f = fixture(), token = await jwt();
    const legacy = await sha256('rd:OldPass!123:taskitator-client-v1');
    f.kv.set('user_reg:rd', { token_hash: legacy });
    f.kv.set('user_data:' + legacy, { username: 'rd', version: 7,
        tasks: [{ id: 'keep', title: 'Keep this task', status: 'active' }], settings: { worker_passkey: legacy } });
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 401);
    assert.equal((await f.call('/auth/account', await jwt('user_B'), 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' })).status, 403);
    const linked = await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' });
    assert.equal(linked.status, 200);
    const cloud = await f.call('/sync/pull', token); assert.equal(cloud.body.version, 7);
    assert.equal(cloud.body.tasks[0].title, 'Keep this task'); assert.equal(cloud.body.settings.worker_passkey, undefined);
    assert.equal((await f.call('/sync/pull', legacy, 'GET', null, { 'X-Taskitator-User': 'rd' })).status, 401);
    assert.equal((await f.storage.get('account:rd')).owner_id, 'user_A');
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'OldPass!123' })).status, 200);
});
test('migration from existing Durable Object preserves version and closes legacy access', async () => {
    const f = fixture(), token = await jwt(), legacy = await sha256('rd:a:taskitator-client-v1');
    await f.storage.put('account:rd', { user: 'rd', digest: await sha256(legacy), version: 4, has_snapshot: false, chunks: 0 });
    f.env.LEGACY_MIGRATION_UNTIL = '2000-01-01T00:00:00Z';
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'a' })).status, 403);
    f.env.LEGACY_MIGRATION_UNTIL = new Date(Date.now()+86400000).toISOString();
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'a' })).status, 200);
    assert.equal((await f.call('/sync/pull', token)).body.version, 4);
    assert.equal((await f.storage.get('account:rd')).digest, undefined);
});
test('migration attempts are throttled across repeated requests', async () => {
    const f = fixture(), token = await jwt();
    for (let i = 0; i < 8; i++) assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 401);
    assert.equal((await f.call('/auth/account', token, 'POST', { mode: 'migrate', username: 'rd', password: 'wrong' })).status, 429);
});
test('Worker CORS rejects unknown sites and never sends wildcard origin', async () => {
    const f = fixture(); f.env.TASKITATOR_SYNC = { idFromName: () => 'coordinator', get: () => f.service };
    assert.equal((await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }), f.env)).status, 403);
    const allowed = await worker.fetch(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: origin } }), f.env);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(allowed.headers.get('Cache-Control'), 'no-store');
});
test('unlock status still respects due tasks and Riyadh breaks', () => {
    const now = Date.parse('2026-10-14T10:00:00+03:00');
    const data = { tasks: [{ status: 'active', due_date: '2026-10-14' }], settings: {}, today_breaks: [] };
    assert.equal(evaluateStatus(data, now).device_unlocked, false);
    data.today_breaks = { '2026-10-14': [{ start: '09:30', end: '10:30' }] };
    assert.equal(evaluateStatus(data, now).device_unlocked, true);
});

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

test('deletion fails closed before setup and refuses anonymous, phone, unverified, and incorrect confirmations',async()=>{
    const f=fixture(),a=await create(f);
    assert.equal((await f.call('/auth/verification/start',a.token,'POST',{method:'password'})).status,503);
    assert.equal((await f.call('/auth/account',null,'DELETE',{})).status,401);
    const phone=(await f.call('/auth/phone',a.token,'POST')).body.token;
    assert.equal((await f.call('/auth/account',phone,'DELETE',{})).status,403);
    const body=await verifiedDeletion(f,a.token);
    assert.equal((await f.call('/auth/account',body.token,'DELETE',{...body,blocker_disabled:false})).status,400);
    assert.equal((await f.call('/auth/account',body.token,'DELETE',{...body,phrase:'DELETE'})).status,400);
    assert.equal((await f.call('/auth/account',body.token,'DELETE',{...body,verification_id:'a'.repeat(64)})).status,403);
    assert.ok(await f.storage.get('account:'+encodeURIComponent(a.user)));
});

test('password proof rejects incomplete provider verification, stale factors, and baseline verification reuse',async()=>{
    const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
    const initial=await jwt('user_A',{taskitator_reverification_id:'rv_old',fva:[0,-1]});
    const started=await f.call('/auth/verification/start',initial,'POST',{method:'password'});
    const body={verification_id:started.body.verification_id};
    assert.equal((await f.call('/auth/verification/password',initial,'POST',body)).status,403);
    assert.equal((await f.call('/auth/verification/password',await jwt('user_A',{taskitator_reverification_id:'rv_new',fva:[3,-1]}),'POST',body)).status,403);
    f.setVerificationStatus('needs_first_factor');
    assert.equal((await f.call('/auth/verification/password',await jwt('user_A',{taskitator_reverification_id:'rv_new',fva:[0,-1]}),'POST',body)).status,403);
    f.setVerificationStatus('complete');
    assert.equal((await f.call('/auth/verification/password',await jwt('user_A',{taskitator_reverification_id:'rv_new',fva:[0,-1]}),'POST',body)).status,200);
});

test('one verification cannot authorize two challenges and expires without affecting the account',async()=>{
    const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
    const first=await f.call('/auth/verification/start',a.token,'POST',{method:'password'});
    const second=await f.call('/auth/verification/start',a.token,'POST',{method:'password'});
    const token=await jwt('user_A',{taskitator_reverification_id:'rv_new',fva:[0,-1]});
    assert.equal((await f.call('/auth/verification/password',token,'POST',{verification_id:first.body.verification_id})).status,200);
    assert.equal((await f.call('/auth/verification/password',token,'POST',{verification_id:second.body.verification_id})).status,403);
    const key='action-proof:'+await sha256(first.body.verification_id),proof=await f.storage.get(key);proof.expires=Date.now()-1;await f.storage.put(key,proof);
    assert.equal((await f.call('/auth/account',token,'DELETE',{verification_id:first.body.verification_id,receipt:'d'.repeat(64),blocker_disabled:true,phrase:'Macrodroid disabled'})).status,403);
    assert.ok(await f.storage.get('account:'+encodeURIComponent(a.user)));
});

test('a proof cannot be used by another user or a different session, including impersonation',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    const body=await verifiedDeletion(f,a.token);
    assert.equal((await f.call('/auth/account',b.token,'DELETE',body)).status,403);
    const proofKey='action-proof:'+await sha256(body.verification_id),proof=await f.storage.get(proofKey);
    proof.sessionId='sess_other';await f.storage.put(proofKey,proof);
    assert.equal((await f.call('/auth/account',body.token,'DELETE',body)).status,403);
    assert.equal((await f.call('/auth/verification/start',await jwt('user_A',{act:{sub:'admin'}}),'POST',{method:'password'})).status,403);
});

test('acceptance immediately blocks account reads/writes and makes its phone token status-only unlocked for exactly seven days',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    const phone=(await f.call('/auth/phone',a.token,'POST')).body.token;
    const body=await verifiedDeletion(f,a.token);
    const accepted=await f.call('/auth/account',body.token,'DELETE',body);
    assert.equal(accepted.status,200);assert.equal(accepted.body.accepted,true);
    assert.ok(Math.abs(accepted.body.phone_recovery_until-Date.now()-RECOVERY_MS)<2000);
    assert.equal((await f.call('/sync/pull',body.token)).status,410);
    assert.equal((await f.call('/sync/push',body.token,'POST',{})).status,410);
    assert.equal((await f.call('/auth/account',body.token,'POST',{mode:'create'})).status,410);
    const me=await f.call('/auth/me',body.token);assert.equal(me.body.account,null);assert.equal(me.body.deletion.receipt,body.receipt);
    assert.equal((await f.call('/status',phone)).body.device_unlocked,true);
    assert.equal((await f.call('/sync/pull',phone)).status,403);
    assert.equal((await f.call('/sync/pull',b.token)).status,200);
    const text=await f.service.fetch(new Request('https://worker.test/status?format=text',{headers:{Authorization:'Bearer '+phone}}));
    assert.equal(await text.text(),'device_unlocked = true');
    const key='phone:'+await sha256(phone),record=await f.storage.get(key);
    assert.deepEqual(Object.keys(record).sort(),['expires','scope']);record.expires=Date.now()-1;await f.storage.put(key,record);
    assert.equal((await f.call('/status',phone)).status,401);
});

test('cleanup removes current snapshots and identity, keeps other users, and status is accessible after Clerk deletion',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    await f.call('/sync/push',a.token,'POST',{tasks:[{id:'private',title:'private task',status:'active'}],settings:{gemini_api_key:'secret-ai'},base_version:0,mutation_id:'mutation-delete'});
    await f.storage.put('credential:old',{user:a.user,revoked:true});
    await f.storage.put('credential:other',{user:b.user,revoked:true});
    const body=await verifiedDeletion(f,a.token);
    await f.call('/auth/account',body.token,'DELETE',body);
    await finishDeletion(f);
    assert.equal(await f.storage.get('account:'+encodeURIComponent(a.user)),undefined);
    assert.equal(await f.storage.get('identity:user_A'),undefined);
    assert.equal(await f.storage.get('credential:old'),undefined);
    assert.ok(await f.storage.get('credential:other'));
    assert.equal((await f.storage.list({prefix:'snapshot:'+encodeURIComponent(a.user)+':'})).size,0);
    assert.ok(await f.storage.get('account:'+encodeURIComponent(b.user)));
    assert.equal((await f.call('/sync/pull',b.token)).status,200);
    assert.ok(f.deletedUsers.has('user_A'));
    const status=await f.call('/auth/deletion/status',null,'POST',{receipt:body.receipt});
    assert.equal(status.body.complete,true);
    for(const key of ['user','userId','email','receipt'])assert.equal(status.body[key],undefined);
    assert.equal((await f.call('/auth/deletion/status',null,'POST',{receipt:'b'.repeat(64)})).status,404);
});

test('Clerk cleanup failures retry without reopening the account or extending phone recovery',async()=>{
    const f=fixture(),a=await create(f),body=await verifiedDeletion(f,a.token);
    const accepted=await f.call('/auth/account',body.token,'DELETE',body);
    f.setDeleteFailure(true);await finishDeletion(f);
    assert.equal((await f.call('/sync/pull',body.token)).status,410);
    assert.equal((await f.call('/auth/deletion/status',null,'POST',{receipt:body.receipt})).body.status,'retrying');
    const replay=await f.call('/auth/account',body.token,'DELETE',body);
    assert.equal(replay.body.phone_recovery_until,accepted.body.phone_recovery_until);
    assert.equal((await f.storage.list({prefix:'deletion-job:'})).size,1);
    f.setDeleteFailure(false);await finishDeletion(f);
    assert.equal((await f.call('/auth/deletion/status',null,'POST',{receipt:body.receipt})).body.complete,true);
});

test('legacy cleanup removes registration and every identifiable historical copy across pages, preserves unrelated data',async()=>{
    const f=fixture(),token=await jwt(),oldToken=await sha256('rd:old-password:taskitator-client-v1');
    f.kv.set('user_reg:rd',{token_hash:oldToken});
    for(let i=0;i<35;i++)f.kv.set('user_data:historical-'+String(i).padStart(3,'0'),{username:'rd',tasks:[]});
    f.kv.set('user_data:'+oldToken,{username:'rd',tasks:[]});
    f.kv.set('user_data:other',{username:'other',tasks:[{title:'keep'}]});
    f.kv.set('user_data:unreadable','__invalid_json__');
    assert.equal((await f.call('/auth/account',token,'POST',{mode:'migrate',username:'rd',password:'old-password'})).status,200);
    const body=await verifiedDeletion(f,token);
    await f.call('/auth/account',body.token,'DELETE',body);await finishDeletion(f);
    assert.equal(f.kv.has('user_reg:rd'),false);
    assert.equal([...f.kv.values()].some(record=>record?.username==='rd'),false);
    assert.equal(f.kv.get('user_data:other').tasks[0].title,'keep');
    assert.equal(f.kv.get('user_data:unreadable'),'__invalid_json__');
    assert.equal((await f.call('/auth/deletion/status',null,'POST',{receipt:body.receipt})).body.legacy_review_needed,true);
});

async function googleIdToken(nonce,overrides={}) {
    const now=Math.floor(Date.now()/1000);
    const data=encoded({alg:'RS256',kid:'google-key'})+'.'+encoded({iss:'https://accounts.google.com',
        aud:'google-client',sub:'google_A',nonce,iat:now,exp:now+60,...overrides});
    return data+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(data))).toString('base64url');
}
async function startGoogle(f,token,action='delete-account',provider='gemini') {
    f.env.ACCOUNT_DELETION_ENABLED='true';f.env.GOOGLE_OAUTH_CLIENT_ID='google-client';
    f.env.GOOGLE_OAUTH_CLIENT_SECRET='google-secret';f.env.GOOGLE_VERIFICATION_REDIRECT_URI='https://worker.test/auth/verification/google/callback';
    const started=await f.call('/auth/verification/start',token,'POST',{method:'google',action,provider});
    assert.equal(started.status,200);
    const id=started.body.verification_id,record=await f.storage.get('action-proof:'+await sha256(id));
    return {id,record,url:started.body.authorization_url};
}
test('linked Google confirmation reveals only the selected Claude key once',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-google-confirmed-key','claude');
    const google=await startGoogle(f,a.token,'api-key-reveal','claude');f.setGoogleToken(await googleIdToken(google.record.nonce));
    const response=await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test-code'));assert.equal(response.status,303);
    const body={provider:'claude',verification_id:google.id};
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{...body,provider:'gemini'})).status,403);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',body)).body.key,'sk-ant-google-confirmed-key');
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',body)).status,403);
});
test('Google confirmation authorizes the selected key action once, without granting deletion',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    const google=await startGoogle(f,a.token,'api-key-reveal');f.setGoogleToken(await googleIdToken(google.record.nonce));
    const callback=await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test-code'));
    assert.equal(callback.headers.get('Location'),origin+'/settings.html#key-verification='+google.id);
    assert.equal((await f.call('/auth/account',a.token,'DELETE',{verification_id:google.id,receipt:'e'.repeat(64),blocker_disabled:true,phrase:'Macrodroid disabled'})).status,403);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{verification_id:google.id})).body.key,'AIza-test-secret-123456789');
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{verification_id:google.id})).status,403);
});
test('Google confirmation validates signed identity and grants only the original session; callback is one-use',async()=>{
    const f=fixture(),a=await create(f),google=await startGoogle(f,a.token);
    const url=new URL(google.url);assert.equal(url.searchParams.get('scope'),'openid');
    assert.equal(url.searchParams.get('prompt'),'select_account');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    f.setGoogleToken(await googleIdToken(google.record.nonce));
    const callback=await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test-code'));
    assert.equal(callback.status,303);assert.equal(callback.headers.get('Location'),origin+'/settings.html#delete-verification='+google.id);
    const status=await f.call('/auth/verification/status',a.token,'POST',{verification_id:google.id});assert.equal(status.body.verified,true);
    const replay=await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test-code'));
    assert.equal(replay.status,403);
    const record=await f.storage.get('action-proof:'+await sha256(google.id));
    assert.equal(record.verifier,undefined);assert.equal(record.nonce,undefined);
    assert.equal((await f.call('/auth/account',a.token,'DELETE',{verification_id:google.id,receipt:'c'.repeat(64),blocker_disabled:true,phrase:'Macrodroid disabled'})).status,200);
});
test('Google confirmation rejects wrong account, nonce, audience, expiry, and forged signatures',async()=>{
    for(const overrides of [{sub:'other_google'},{nonce:'wrong'},{aud:'other-client'},{exp:0},'forge']) {
        const f=fixture(),a=await create(f),google=await startGoogle(f,a.token);
        let token=await googleIdToken(google.record.nonce,typeof overrides==='object'?overrides:{});
        if(overrides==='forge'){const parts=token.split('.');parts[2]='A'.repeat(parts[2].length);token=parts.join('.');}
        f.setGoogleToken(token);
        await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test-code'));
        assert.equal((await f.call('/auth/verification/status',a.token,'POST',{verification_id:google.id})).body.verified,false);
        assert.ok(await f.storage.get('account:'+encodeURIComponent(a.user)));
    }
});

test('Backend reverification requires the exact object, identity, level and fresh millisecond timestamps',async()=>{
    const cases=[{object:'session'},{id:'rv_other'},{user_id:'user_B'},{session_id:'sess_B'},
        {status:'needs_first_factor'},{status:'needs_second_factor'},{level:'second_factor'},{level:'unknown'},
        {created_at:null},{first_factor_verified_at:null},{created_at:'123'},
        {created_at:Date.now()-60000},{first_factor_verified_at:Date.now()-60000},
        {created_at:Date.now()+60000},{first_factor_verified_at:Date.now()+60000}];
    for(const overrides of cases){
        const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
        const started=await f.call('/auth/verification/start',a.token,'POST',{method:'password'});
        f.setVerificationResponse(overrides);
        const fresh=await jwt('user_A',{taskitator_reverification_id:'rv_test',fva:[0,-1]});
        assert.equal((await f.call('/auth/verification/password',fresh,'POST',{verification_id:started.body.verification_id})).status,403,JSON.stringify(overrides));
        assert.equal((await f.call('/auth/verification/status',fresh,'POST',{verification_id:started.body.verification_id})).body.verified,false);
    }
    for(const level of ['first_factor','multi_factor']){
        const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
        const started=await f.call('/auth/verification/start',a.token,'POST',{method:'password'});
        f.setVerificationResponse({level});
        const fresh=await jwt('user_A',{taskitator_reverification_id:'rv_test',fva:[0,-1]});
        assert.equal((await f.call('/auth/verification/password',fresh,'POST',{verification_id:started.body.verification_id})).status,200);
    }
});
test('expired pending challenges cannot approve a fresh password verification',async()=>{
    const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
    const start=await f.call('/auth/verification/start',a.token,'POST',{method:'password'});
    const key='action-proof:'+await sha256(start.body.verification_id),record=await f.storage.get(key);
    record.expires=Date.now()-1;await f.storage.put(key,record);
    const fresh=await jwt('user_A',{taskitator_reverification_id:'rv_test',fva:[0,-1]});
    assert.equal((await f.call('/auth/verification/password',fresh,'POST',{verification_id:start.body.verification_id})).status,403);
});
test('every missing or partial Google configuration fails closed for deletion and both provider keys',async()=>{
    const names=['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','GOOGLE_VERIFICATION_REDIRECT_URI'];
    for(let mask=0;mask<7;mask++)for(const action of ['delete-account','api-key-save'])for(const provider of ['gemini','claude']){
        const f=fixture(),a=await create(f);enableVault(f);f.env.ACCOUNT_DELETION_ENABLED='true';
        const values=['google-client','google-secret','https://worker.test/auth/verification/google/callback'];
        names.forEach((name,index)=>{if(mask&(1<<index))f.env[name]=values[index]});
        const result=await f.call('/auth/verification/start',a.token,'POST',{method:'google',action,provider});
        assert.equal(result.status,503);assert.match(result.body.error,/Worker setup/);
        names.forEach((name,index)=>{if(!(mask&(1<<index)))assert.ok(result.body.error.includes(name))});
        assert.equal(result.body.verified,undefined);assert.equal(result.body.authorization_url,undefined);
        assert.equal((await f.storage.list({prefix:'action-proof:'})).size,0);
    }
});
test('malformed Google callback configuration never creates approval',async()=>{
    for(const redirect of ['broken','http://worker.test/auth/verification/google/callback','https://worker.test/wrong',
        'https://user:pass@worker.test/auth/verification/google/callback','https://worker.test/auth/verification/google/callback?x=1']){
        const f=fixture(),a=await create(f);f.env.ACCOUNT_DELETION_ENABLED='true';
        Object.assign(f.env,{GOOGLE_OAUTH_CLIENT_ID:'id',GOOGLE_OAUTH_CLIENT_SECRET:'secret',GOOGLE_VERIFICATION_REDIRECT_URI:redirect});
        assert.equal((await f.call('/auth/verification/start',a.token,'POST',{method:'google'})).status,503);
        assert.equal((await f.storage.list({prefix:'action-proof:'})).size,0);
    }
});
test('legacy bypass grants cannot authorize status, callbacks, deletion or any key mutation/reveal',async()=>{
    for(const version of [undefined,1])for(const action of ['delete-account','api-key-save','api-key-reveal','api-key-delete']){
        const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);f.env.ACCOUNT_DELETION_ENABLED='true';
        const google=await startGoogle(f,a.token,action),key='action-proof:'+await sha256(google.id);
        const record=await f.storage.get(key);delete record.version;if(version!==undefined)record.version=version;
        record.status='verified';await f.storage.put(key,record);
        assert.equal((await f.call('/auth/verification/status',a.token,'POST',{verification_id:google.id,action})).status,403);
        const path=action==='delete-account'?'/auth/account':action==='api-key-reveal'?'/ai/keys/reveal':'/ai/keys';
        const method=['delete-account','api-key-delete'].includes(action)?'DELETE':'POST';
        assert.equal((await f.call(path,a.token,method,{verification_id:google.id,key:'replacement-key-1234',receipt:'e'.repeat(64),blocker_disabled:true,phrase:'Macrodroid disabled'})).status,403);
        record.status='pending';await f.storage.put(key,record);
        assert.equal((await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test'))).status,403);
    }
});
test('Google key approvals reject other sessions, accounts and actions without consuming the original approval',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a);
    const google=await startGoogle(f,a.token,'api-key-reveal');f.setGoogleToken(await googleIdToken(google.record.nonce));
    await f.service.fetch(new Request('https://worker.test/auth/verification/google/callback?state='+google.id+'&code=test'));
    f.sessionOwners.set('sess_Alternate','user_A');
    const otherSession=await jwt('user_A',{sid:'sess_Alternate'});
    const otherUser=(await create(f,'user_B')).token;
    for(const token of [otherSession,otherUser])assert.equal((await f.call('/ai/keys/reveal',token,'POST',{verification_id:google.id})).status,403);
    assert.equal((await f.call('/ai/keys',a.token,'DELETE',{verification_id:google.id})).status,403);
    assert.equal((await f.call('/ai/keys/reveal',a.token,'POST',{verification_id:google.id})).status,200);
});

test('account deletion removes hosted operations, spending and username claims without touching another account',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    await f.call('/pro/username',a.token,'POST',{username:'Mazen'});
    await f.call('/pro/username',b.token,'POST',{username:'OtherName'});
    for(const prefix of ['pro:op:','pro:usage:','pro:spend:']) {
        await f.storage.put(prefix+'user_A:test',{value:'remove'});
        await f.storage.put(prefix+'user_B:test',{value:'keep'});
    }
    await f.storage.put('pro:attestation:test_A',{account_id:'user_A'});
    await f.storage.put('pro:attestation:test_B',{account_id:'user_B'});
    const body=await verifiedDeletion(f,a.token);await f.call('/auth/account',body.token,'DELETE',body);
    await finishDeletion(f);
    for(const prefix of ['pro:op:','pro:usage:','pro:spend:']) {
        assert.equal(await f.storage.get(prefix+'user_A:test'),undefined);
        assert.ok(await f.storage.get(prefix+'user_B:test'));
    }
    assert.equal(await f.storage.get('pro:username:map:mazen'),undefined);
    assert.equal(await f.storage.get('pro:user:username:user_A'),undefined);
    assert.ok(await f.storage.get('pro:username:map:othername'));
    assert.equal(await f.storage.get('pro:attestation:test_A'),undefined);
    assert.ok(await f.storage.get('pro:attestation:test_B'));
});

const image={mime_type:'image/png',data:'YWJj'};
const task=(id='t',extra={})=>({id,title:'Protected '+id,status:'active',ai_locked:true,proof_criteria:'The saved required artifact',...extra});
async function save(f,a,tasks,extras={}){
    const old=await f.call('/sync/pull',a.token);
    return f.call('/sync/push',a.token,'POST',{tasks,settings:{},recurrence_schema:1,base_version:old.body.version,mutation_id:'mutation_'+crypto.randomUUID(),...extras});
}
async function setup(tasks=[task()],extras={}){
    const f=fixture(),a=await create(f);Object.assign(f.env,testEnv,{CLAUDE_API_KEY:'local-test'});
    await f.storage.put('pro:entitlement:user_A',await activeLicense('user_A'));
    assert.equal((await save(f,a,tasks,extras)).status,200);
    const before=globalThis.fetch,calls=[];
    let pause=null,providerResult=null;
    globalThis.fetch=async(url,options)=>{
        if(String(url)==='https://api.anthropic.com/v1/messages/count_tokens'){calls.push({type:'count'});if(pause)await pause('count');return Response.json({input_tokens:200});}
        if(String(url)==='https://api.anthropic.com/v1/messages'){
            const payload=JSON.parse(options.body);calls.push({type:'review',payload});if(pause)await pause('review');
            const batch=payload.messages[0].content[0].text.startsWith('BATCH'),list=JSON.parse(payload.messages[0].content[0].text.split('\n')[1]);
            const result=providerResult|| (batch?list.map(t=>({task_id:t.id,status:'eligible',verdict:'approved',reason:'Matches'})):{verdict:'approved',confidence:.98,critique:'Matches'});
            return Response.json({model:POLICY.model,stop_reason:'end_turn',usage:{input_tokens:200,output_tokens:100},content:[{type:'text',text:JSON.stringify(result)}]});
        }
        return before(url,options);
    };
    const quote=async(body,batch=false)=>f.call('/pro/ai/quote',a.token,'POST',{...body,batch});
    const review=async(ids=['t'],batch=false)=>{
        const body={operation_id:newOperation(),files:[image],...(batch?{tasks:ids.map(id=>({id}))}:{task_id:ids[0]})};
        const q=await quote(body,batch);assert.equal(q.status,200,JSON.stringify(q.body));
        const r=await f.call(batch?'/pro/ai/batch-review':'/pro/ai/review',a.token,'POST',{...body,quote_id:q.body.quote_id});
        assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
    };
    const confirm=(job,ids=['t'],operation='confirmation_one',batch=false,token=a.token)=>f.call('/pro/ai/batch-confirm',token,'POST',{job_id:job,task_ids:ids,operation_id:operation,batch});
    return {f,a,calls,quote,review,confirm,pause:fn=>{pause=fn},result:result=>{providerResult=result}};
}

test('protected completion, deletion, lock removal and requirements substitution through sync are rejected',async()=>{
    const {f,a}=await setup();
    for(const tasks of [[task('t',{status:'completed'})],[],[task('t',{status:'trash'})],[task('t',{ai_locked:false})],[task('t',{proof_criteria:'Anything'})]])
        assert.equal((await save(f,a,tasks)).status,403);
    assert.equal((await f.call('/status',a.token)).body.device_unlocked,false);
    assert.equal((await save(f,a,[task('t',{description:'Ordinary edit',priority_id:'high'})])).status,200);
});

test('hosted proof uses saved criteria and reference even if the caller omits or replaces them',async()=>{
    const {f,a,calls,quote}=await setup([task('t',{reference_inline_data:image})]);
    const body={operation_id:newOperation(),task_id:'t',criteria:'Anything',exemplar:{...image,data:'ZGVm'},files:[image]};
    const q=await quote(body);assert.equal(q.status,200);assert.equal(q.body.tasks[0].exemplar,true);
    const r=await f.call('/pro/ai/review',a.token,'POST',{...body,quote_id:q.body.quote_id});assert.equal(r.status,200);
    const payload=calls.find(c=>c.type==='review').payload;
    assert.ok(JSON.stringify(payload).includes('The saved required artifact'));assert.ok(!JSON.stringify(payload).includes('Anything'));
    assert.ok(!JSON.stringify(payload).includes('ZGVm'));
    const binding=await f.storage.get('pro:attestation:'+r.body.job_id);assert.equal(binding.session_id,'sess_A');assert.ok(binding.evidence_hash);
});

test('single approval atomically completes the server snapshot, creates one ledger entry and safely replays the same confirmation',async()=>{
    const {f,a,review,confirm}=await setup();const r=await review();
    const first=await confirm(r.job_id);assert.equal(first.status,200);
    const stored=await f.call('/sync/pull',a.token);assert.equal(stored.body.tasks[0].status,'completed');assert.equal(stored.body.version,2);
    assert.equal(stored.body.completed_audit_ledger.length,1);
    assert.equal((await confirm(r.job_id)).body.replayed,true);
    assert.equal((await confirm(r.job_id,['t'],'confirmation_other')).status,409);
    assert.equal((await f.call('/sync/pull',a.token)).body.completed_audit_ledger.length,1);
});

test('batch grants reject other actions, accounts and sessions; parallel confirmations apply once',async()=>{
    const {f,a,review,confirm}=await setup([task('a'),task('b')]);const r=await review(['a','b'],true);
    f.sessionOwners.set('sess_Other','user_A');const otherSession=await jwt('user_A',{sid:'sess_Other'});
    const b=await create(f,'user_B');
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',false)).status,403);
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',true,otherSession)).status,403);
    assert.equal((await confirm(r.job_id,['a'],'confirmation_one',true,b.token)).status,403);
    assert.equal((await confirm(r.job_id,['not_approved'],'confirmation_one',true)).status,403);
    const results=await Promise.all([confirm(r.job_id,['a','b'],'confirmation_one',true),confirm(r.job_id,['a','b'],'confirmation_two',true)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const snapshot=(await f.call('/sync/pull',a.token)).body;
    assert.ok(snapshot.tasks.every(t=>t.status==='completed'));assert.equal(snapshot.completed_audit_ledger.length,2);
});

test('legacy, expired, rejected and changed-task approvals cannot complete a task',async()=>{
    const {f,a,review,confirm}=await setup();const r=await review();
    const stored=(await f.call('/sync/pull',a.token)).body;
    assert.equal((await save(f,a,[{...stored.tasks[0],description:'A newer revision'}])).status,200);
    assert.equal((await confirm(r.job_id)).status,409);
    await f.storage.put('pro:attestation:legacy',{account_id:'user_A',eligible_task_ids:['t'],expires_at:Date.now()+10000,consumed:false});
    assert.equal((await confirm('legacy')).status,403);
    const fresh=await review();const record=await f.storage.get('pro:attestation:'+fresh.job_id);record.expires_at=Date.now()-1;await f.storage.put('pro:attestation:'+fresh.job_id,record);
    assert.equal((await confirm(fresh.job_id)).status,403);
});

test('parents require child proofs and shields; eligible same-batch children can complete with their parent',async()=>{
    let h=await setup([task('parent'),task('child',{parent_id:'parent'})]);
    let r=await h.review(['parent']);assert.equal((await h.confirm(r.job_id,['parent'])).status,409);
    r=await h.review(['parent','child'],true);assert.equal((await h.confirm(r.job_id,['parent','child'],'confirmation_batch',true)).status,200);
    h=await setup([task('parent',{strict_prerequisites:true}),{id:'child',title:'Required',parent_id:'parent',status:'active'}]);
    r=await h.review(['parent']);assert.equal((await h.confirm(r.job_id,['parent'])).status,409);
});

test('ordinary task completion and recurrence continue working; protected recurring branches advance on server confirmation',async()=>{
    let h=await setup([{id:'normal',status:'active',title:'Normal'}]);assert.equal((await save(h.f,h.a,[{id:'normal',status:'completed',title:'Normal'}])).status,200);
    const snapshot={tasks:[task()],settings:{},recurrence_state:{series:[],history:[]}};
    const today=globalThis.TaskitatorRecurrence.today(Date.now(),0);
    globalThis.TaskitatorRecurrence.start(snapshot.tasks,snapshot.recurrence_state,'t',{kind:'daily',start:today},'series_protected');
    h=await setup(snapshot.tasks,{recurrence_state:snapshot.recurrence_state});
    const f=h.f,a=h.a;
    const result=await h.review();assert.equal((await h.confirm(result.job_id)).status,200);
    const after=(await f.call('/sync/pull',a.token)).body;
    assert.equal(after.recurrence_state.history.length,1);assert.equal(after.recurrence_state.history[0].outcome,'completed');
    assert.ok(after.tasks.some(t=>t.status==='active'&&t.id!=='t'));
});

test('Emergency Bypass is server-authorized, lasts 15 minutes and cannot be forged in a sync payload',async()=>{
    const {f,a}=await setup();
    assert.equal((await save(f,a,[task('t',{status:'completed'})],{emergency_state:{uses_left:4,active_until:Date.now()+86400000}})).status,403);
    const started=await f.call('/pro/emergency',a.token,'POST',{});assert.equal(started.status,200);assert.equal(started.body.uses_left,3);
    assert.ok(Math.abs(Date.parse(started.body.active_until)-Date.now()-900000)<1000);
    assert.equal((await f.call('/status',a.token)).body.device_unlocked,true);
    assert.equal((await save(f,a,[task('t',{proof_criteria:'Explicit bypass edit'})])).status,200);
    const state=await f.storage.get('pro:emergency:user_A');state.active_until_ms=Date.now()-1;await f.storage.put('pro:emergency:user_A',state);
    assert.equal((await save(f,a,[task('t',{proof_criteria:'Explicit bypass edit',status:'completed'})])).status,403);
    for(let i=0;i<3;i++){assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,200);const s=await f.storage.get('pro:emergency:user_A');s.active_until_ms=Date.now()-1;await f.storage.put('pro:emergency:user_A',s);}
    assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,429);
});

test('exhausted previews make no provider calls and create no operations',async()=>{
    const {f,a,calls,quote}=await setup();
    await f.storage.put('pro:spend:user_A:'+periods().month,POLICY.monthlySpend);
    for(let i=0;i<10;i++)assert.equal((await quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,429);
    assert.equal(calls.length,0);assert.equal((await f.storage.list({prefix:'pro:op:user_A:'})).size,0);
});

test('preview limits bound unused quotes and permit only one external count at a time per account',async()=>{
    let h=await setup();let release,entered;
    const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.pause(async type=>{if(type==='count'){entered();await gate;}});
    const running=h.quote({operation_id:newOperation(),task_id:'t',files:[image]});await started;
    const other=await h.quote({operation_id:newOperation(),task_id:'t',files:[image]});assert.equal(other.status,429);release();assert.equal((await running).status,200);
    h=await setup();for(let i=0;i<12;i++)assert.equal((await h.quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,200);
    assert.equal((await h.quote({operation_id:newOperation(),task_id:'t',files:[image]})).status,429);
    assert.equal(h.calls.length,12);
});

test('expired unused records are cleaned; completed retries remain cached and old removed operation IDs cannot execute again',async()=>{
    const {f,a,quote,calls}=await setup(),id=newOperation();
    const q=await quote({operation_id:id,task_id:'t',files:[image]});assert.equal(q.status,200);
    const rec=await f.storage.get('pro:op:user_A:'+id);rec.expires=Date.now()-1;await f.storage.put('pro:op:user_A:'+id,rec);
    await f.storage.put('pro:attestation:expired',{expires_at:Date.now()-1});
    await f.storage.put('pro:op:user_A:pending',{state:'pending',created:0,retain_until:1});
    await f.service.alarm();
    assert.equal(await f.storage.get('pro:op:user_A:'+id),undefined);assert.equal(await f.storage.get('pro:attestation:expired'),undefined);
    assert.ok(await f.storage.get('pro:op:user_A:pending'));
    const old='op_'+(Date.now()-86400001).toString(36)+'_expired000';
    const before=calls.length;assert.equal((await quote({operation_id:old,task_id:'t',files:[image]})).status,409);assert.equal(calls.length,before);
});

test('account deletion removes licensing, previews, grants and emergency state while retaining other users records',async()=>{
    const {f,a}=await setup();await create(f,'user_B');
    for(const prefix of ['pro:binding:','pro:preview:','pro:quote-index:','pro:emergency:']){
        const name=prefix==='pro:binding:'?'fingerprint':'user_A';await f.storage.put(prefix+name,{account_id:'user_A'});
    }
    await f.storage.put('pro:entitlement:user_B',await activeLicense('user_B'));
    const deleted=[];f.env.TASKITATOR_DB={prepare:sql=>({bind:id=>({run:async()=>{deleted.push({sql,id})}})})};
    const body=await verifiedDeletion(f,a.token);assert.equal((await f.call('/auth/account',body.token,'DELETE',body)).status,200);
    await finishDeletion(f);assert.equal((await f.service.deletion.status(body.receipt)).complete,true);
    assert.equal(await f.storage.get('pro:entitlement:user_A'),undefined);assert.equal(await f.storage.get('pro:binding:fingerprint'),undefined);
    for(const prefix of ['pro:preview:','pro:quote-index:','pro:emergency:'])assert.equal(await f.storage.get(prefix+'user_A'),undefined);
    assert.ok(await f.storage.get('pro:entitlement:user_B'));assert.equal(deleted[0].id,'user_A');
});

test('late Keyo activation cannot recreate an accepted-deletion account entitlement',async()=>{
    const {f}=await setup();let release,entered;const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
    const before=globalThis.fetch;globalThis.fetch=async(url,opts)=>{
        if(String(url).includes('/api/v1/activate')){entered();await gate;return Response.json({entitlement:await signedToken('user_A')});}return before(url,opts);
    };
    const activating=f.service.pro.activateLicense('user_A',{key:'A1B2C3D4E5F6G7H8'});await started;
    const link=await f.storage.get('identity:user_A'),meta=await f.storage.get('account:'+encodeURIComponent(link.user));meta.deleting=true;await f.storage.put('account:'+encodeURIComponent(link.user),meta);await f.storage.delete('pro:entitlement:user_A');
    release();await assert.rejects(activating);assert.equal(await f.storage.get('pro:entitlement:user_A'),undefined);
});

test('late provider review cannot recreate deleted audit, spending or approval records',async()=>{
    const h=await setup();let release,entered;const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
    const body={operation_id:newOperation(),task_id:'t',files:[image]},q=await h.quote(body);
    h.pause(async type=>{if(type==='review'){entered();await gate;}});
    const reviewing=h.f.call('/pro/ai/review',h.a.token,'POST',{...body,quote_id:q.body.quote_id});await started;
    const proof=await verifiedDeletion(h.f,h.a.token);await h.f.call('/auth/account',proof.token,'DELETE',proof);await finishDeletion(h.f);release();
    assert.notEqual((await reviewing).status,200);
    assert.equal((await h.f.storage.list({prefix:'pro:op:user_A:'})).size,0);
    assert.equal((await h.f.storage.list({prefix:'pro:spend:user_A:'})).size,0);
    assert.equal((await h.f.storage.list({prefix:'pro:attestation:'})).size,0);
});

test('personal Claude proof uses the same protected requirements, one-use completion and retry cache',async()=>{
    const f=fixture(),a=await create(f);enableVault(f);await saveKey(f,a,'sk-ant-local-test','claude');
    await f.call('/ai/provider',a.token,'POST',{provider:'claude'});
    f.setClaudeResponse({model:POLICY.model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({verdict:'approved',confidence:.9,critique:'Matches'})}],usage:{input_tokens:200,output_tokens:100}});
    assert.equal((await save(f,a,[task('t',{reference_inline_data:image})])).status,200);
    const request={task_id:'t',criteria:'Replace requirements',files:[image],operation_id:newOperation()};
    const result=await f.call('/pro/ai/personal-review',a.token,'POST',request);assert.equal(result.status,200,JSON.stringify(result.body));
    const retry=await f.call('/pro/ai/personal-review',a.token,'POST',request);assert.equal(retry.body.job_id,result.body.job_id);
    const actual=f.providerCalls.filter(c=>c.options.method==='POST');assert.equal(actual.length,1);assert.ok(!actual[0].options.body.includes('Replace requirements'));
    const completed=await f.call('/pro/ai/batch-confirm',a.token,'POST',{job_id:result.body.job_id,task_ids:['t'],operation_id:'personal_confirmation',batch:false});assert.equal(completed.status,200);
    assert.equal((await f.call('/sync/pull',a.token)).body.tasks[0].status,'completed');
});

test('break planning sync acknowledges the shared timer and sealed schedule on another session',async()=>{
    const {f,a}=await setup();const now=Date.now(),zone='America/New_York',bounds=globalThis.TaskitatorBreaks.bounds({},now,zone);
    const date=bounds.dateStr,first={window_started_at:now-10000,timezone:zone,day_start_hour:0,locked:false,breaks:[{start:'14:00:00',end:'14:30:00'}]};
    const upload=await save(f,a,[task()],{today_breaks:{[date]:first}});assert.equal(upload.status,200);assert.equal(upload.body.today_breaks[date].window_started_at,first.window_started_at);
    const another=await f.call('/sync/pull',a.token);assert.equal(another.body.today_breaks[date].timezone,zone);
    const seal=await save(f,a,[task()],{today_breaks:{[date]:{...first,locked:true}}});assert.equal(seal.status,200);
    const overwrite=await save(f,a,[task()],{today_breaks:{[date]:{...first,window_started_at:now,locked:false,breaks:[]}}});assert.equal(overwrite.status,200);
    assert.equal(overwrite.body.today_breaks[date].locked,true);assert.equal(overwrite.body.today_breaks[date].breaks.length,1);
    const interval=globalThis.TaskitatorBreaks.interval(overwrite.body.today_breaks[date].breaks[0],bounds);
    const status=globalThis.TaskitatorBreaks.active(overwrite.body.today_breaks,{},interval.startTime);
    assert.equal(status,true);
});

test('expired completed-operation cleanup cannot cause the same paid request to execute again',async()=>{
    const h=await setup(),body={operation_id:newOperation(),task_id:'t',files:[image]},q=await h.quote(body);
    const result=await h.f.call('/pro/ai/review',h.a.token,'POST',{...body,quote_id:q.body.quote_id});assert.equal(result.status,200);
    const key='pro:op:user_A:'+body.operation_id,record=await h.f.storage.get(key);
    await h.f.service.alarm();assert.ok(await h.f.storage.get(key));
    const oldNow=Date.now;Date.now=()=>record.retain_until+1;
    try{
        await h.f.service.pro.audits.cleanup();assert.equal(await h.f.storage.get(key),undefined);
        const outcome=await h.f.service.pro.audits.handle('user_A','sess_A',{...body,quote_id:q.body.quote_id},false,false);
        // A fresh entitlement is required after this clock jump; neither outcome can repeat paid inference.
        assert.notEqual(outcome.status,200);
    }finally{Date.now=oldNow;}
    assert.equal(h.calls.filter(c=>c.type==='review').length,1);
});

for(const tier of ['Free','active Pro','expired Pro']){
    test(`${tier} uses the same Emergency Bypass without licensing or API-vault calls`,async()=>{
        const f=fixture(),a=await create(f);
        if(tier!=='Free'){
            Object.assign(f.env,testEnv);
            await f.storage.put('pro:entitlement:user_A',await activeLicense('user_A',tier==='expired Pro'?{expiresAt:Date.now()-1000}:{}));
        }
        f.service.pro.handleRequest=()=>{throw Error('Emergency must not use Pro routing')};
        f.service.migrateVault=()=>{throw Error('Emergency must not need an API vault')};
        const tasks=[{id:'locked',title:'Required task',status:'active',ai_locked:true,proof_criteria:'Saved requirements'}];
        assert.equal((await f.call('/sync/push',a.token,'POST',{tasks,settings:{},base_version:0,mutation_id:'initial_emergency_task'})).status,200);
        assert.equal((await f.call('/status',a.token)).body.device_unlocked,false);
        for(const path of ['/emergency','/pro/emergency']){
            const status=await f.call(path,a.token);
            assert.equal(status.status,200);assert.equal(status.body.uses_left,4);
        }
        const activated=await f.call('/emergency',a.token,'POST',{});
        assert.equal(activated.status,200);assert.equal(activated.body.uses_left,3);
        assert.ok(Math.abs(activated.body.active_until_ms-Date.now()-15*60000)<2000);
        assert.equal((await f.call('/status',a.token)).body.device_unlocked,true);
        const legacy=await f.call('/pro/emergency',a.token);
        assert.deepEqual(legacy.body,activated.body);
        const again=await f.call('/pro/emergency',a.token,'POST',{});
        assert.equal(again.status,409);assert.equal(again.body.code,'BYPASS_ACTIVE');
        assert.equal((await f.storage.get('pro:emergency:user_A')).uses_left,3);
        assert.equal(f.providerCalls.length,0);
    });
}

test('existing bypass windows and counters survive the route change; accounts remain isolated',async()=>{
    const f=fixture(),a=await create(f),b=await create(f,'user_B');
    const existing={cycle_id:'existing-cycle',uses_left:1,active_until_ms:Date.now()+60000,reset_at:Date.now()+86400000};
    await f.storage.put('pro:emergency:user_A',existing);
    const status=await f.call('/emergency',a.token);
    assert.equal(status.status,200);assert.equal(status.body.uses_left,1);
    assert.equal(status.body.active_until_ms,existing.active_until_ms);
    assert.deepEqual(await f.storage.get('pro:emergency:user_A'),existing);
    assert.equal((await f.call('/emergency',b.token)).body.uses_left,4);
    assert.equal((await f.call('/pro/emergency',a.token,'POST',{})).status,409);
});

test('concurrent aliases consume one use and exhaustion cannot create another window',async()=>{
    const f=fixture(),a=await create(f);
    const results=await Promise.all(['/emergency','/pro/emergency'].map(path=>f.call(path,a.token,'POST',{})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const state=await f.storage.get('pro:emergency:user_A');assert.equal(state.uses_left,3);
    for(let left=2;left>=0;left--){
        state.active_until_ms=0;await f.storage.put('pro:emergency:user_A',state);
        const r=await f.call('/emergency',a.token,'POST',{});
        assert.equal(r.status,200);assert.equal(r.body.uses_left,left);
        Object.assign(state,await f.storage.get('pro:emergency:user_A'));
    }
    state.active_until_ms=0;await f.storage.put('pro:emergency:user_A',state);
    const exhausted=await f.call('/emergency',a.token,'POST',{});
    assert.equal(exhausted.status,429);assert.equal(exhausted.body.code,'BYPASS_EXHAUSTED');
    assert.equal((await f.storage.get('pro:emergency:user_A')).active_until_ms,0);
});

test('both emergency URLs require a connected live account and reject phone tokens and unsupported methods',async()=>{
    const f=fixture(),a=await create(f),unconnected=await jwt('user_B');
    for(const path of ['/emergency','/pro/emergency']){
        assert.equal((await f.call(path,null)).status,401);
        assert.equal((await f.call(path,'tkp_'+'a'.repeat(64),'POST',{})).status,403);
        assert.equal((await f.call(path,unconnected)).status,403);
        assert.equal((await f.call(path,a.token,'DELETE')).status,405);
    }
    const deletion=await verifiedDeletion(f,a.token);
    assert.equal((await f.call('/auth/account',deletion.token,'DELETE',deletion)).status,200);
    for(const path of ['/emergency','/pro/emergency'])assert.equal((await f.call(path,a.token,'POST',{})).status,410);
});


// Universe foundation tests execute the production SQL and service entrypoints
// against SQLite, not a map of expected SQL strings. D1 transport is adapted.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
class UniverseTestD1 {
    constructor() { this.sql=new DatabaseSync(':memory:'); this.sql.exec(readFileSync(new URL('./uni/universe-schema.sql',import.meta.url),'utf8')); }
    withSession(mode) { assert.equal(mode,'first-primary'); return this; }
    prepare(sql) {
        const db=this;
        const stmt=(values=[])=>({sql,values,bind:(...args)=>stmt(args),
            first:async()=>db.sql.prepare(sql).get(...values)??null,
            all:async()=>({results:db.sql.prepare(sql).all(...values)}),
            run:async()=>({meta:db.sql.prepare(sql).run(...values)})});
        return stmt();
    }
    async batch(statements) {
        await new Promise(resolve=>setImmediate(resolve));
        if(this.beforeBatch) { const fn=this.beforeBatch; this.beforeBatch=null; await fn(); }
        this.sql.exec('BEGIN IMMEDIATE');
        try { const out=statements.map(s=>({meta:this.sql.prepare(s.sql).run(...s.values)}));this.sql.exec('COMMIT');return out; }
        catch(error) {this.sql.exec('ROLLBACK');throw error;}
    }
}
async function universeFixture() {
    const f=fixture(); Object.assign(f.env,testEnv,{UNIVERSE_FOUNDATION_ENABLED:'true',TASKITATOR_DB:new UniverseTestD1()});
    const token=await jwt();
    async function account(id,pro=false) {
        await f.storage.put('identity:'+id,{user:id});
        await f.storage.put('account:'+encodeURIComponent(id),{owner_id:id,version:0});
        if(pro)await f.storage.put('pro:entitlement:'+id,await activeLicense(id));
        return {userId:id,sessionId:'sess_'+id.slice(5)};
    }
    const owner=await account('user_A',true),db=f.env.TASKITATOR_DB;
    const handle=(id,path,body)=>f.service.universe.handle(id,path,body?'POST':'GET',body);
    const make=(id=owner,extra={})=>handle(id,'/universe/groups',{operation_id:newOperation(),title:'Study team',purpose:'Prepare together',...extra});
    const invite=async(group,actor=owner,role='member',extra={})=>{
        const token=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
        const body={operation_id:newOperation(),token,role,...extra};
        const result=await handle(actor,'/universe/groups/'+group+'/invitations',body);
        return {token,body,result};
    };
    const accept=(id,token,extra={})=>handle(id,'/universe/invitations/accept',{operation_id:newOperation(),token,...extra});
    return {f,db,owner,token,account,handle,make,invite,accept};
}
const universeReject=(promise,code)=>assert.rejects(promise,e=>e.code==='UNIVERSE_'+code);

test('Universe: baseline remains usable with missing schema and feature disabled; capability contract is honest',async()=>{
    const u=await universeFixture();
    u.f.env.UNIVERSE_FOUNDATION_ENABLED='false';
    const caps=await u.f.call('/universe/capabilities',u.token);
    assert.equal(caps.status,200);assert.equal(caps.body.foundation,false);assert.equal(caps.body.ui,false);
    assert.equal(caps.body.capabilities.hosted_ai,false);
    assert.equal((await u.f.call('/auth/me',u.token)).status,200);
    assert.equal((await u.f.call('/universe/groups',u.token)).status,503);
    u.f.env.UNIVERSE_FOUNDATION_ENABLED='true';u.db.sql.exec('DROP TABLE universe_schema');
    assert.equal((await u.f.call('/universe/groups',u.token)).status,503);
    assert.equal((await u.f.call('/auth/me',u.token)).status,200);
});
test('Universe: authenticated Worker routes use signed Keyo status and real SQL; reject phone credentials',async()=>{
    const u=await universeFixture();
    const body={operation_id:newOperation(),title:'Team'};
    const first=await u.f.call('/universe/groups',u.token,'POST',body);
    assert.equal(first.status,200,JSON.stringify(first.body));
    const again=await u.f.call('/universe/groups',u.token,'POST',body);
    assert.equal(again.body.group_id,first.body.group_id);assert.equal(again.body.replayed,true);
    assert.equal((await u.f.call('/universe/groups',null)).status,401);
    assert.equal((await u.f.call('/universe/groups','phone_'+ 'a'.repeat(64))).status,401);
    const list=await u.f.call('/universe/groups',u.token);assert.equal(list.body.groups.length,1);
    assert.equal((await u.f.call('/universe/groups',u.token,'POST',{...body,owner_id:'user_B'})).status,400);
    assert.equal((await u.f.call('/universe/reviews',u.token,'POST',{})).status,404);
});
test('Universe: Free and expired Pro cannot create or reserve; failed entitlement never becomes Pro',async()=>{
    const u=await universeFixture(),free=await u.account('user_Free');
    await universeReject(u.make(free),'PRO_REQUIRED');
    await u.f.storage.put('pro:entitlement:user_A',await activeLicense('user_A',{expiresAt:Date.now()-1000}));
    // Explicit confirmed expiration avoids any simulated provider refresh.
    await u.f.storage.put('pro:entitlement:user_A',{...(await u.f.storage.get('pro:entitlement:user_A')),status:'revoked'});
    await universeReject(u.make(),'PRO_REQUIRED');
    await universeReject(u.handle(free,'/universe/reservations',{operation_id:newOperation()}),'PRO_REQUIRED');
    u.f.service.pro.licenses.resolve=async()=>({status:'active',tier:'pro',expires_at:Date.now()-1000});
    await universeReject(u.make(),'PRO_REQUIRED');
    u.f.service.pro.licenses.resolve=async()=>{throw Object.assign(new Error('Verification unavailable'),{status:503,code:'KEYO_UNAVAILABLE'});};
    await assert.rejects(u.make(),/Verification unavailable/);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_groups').get().n,0);
});
test('Universe: concurrent creates and reserved imports share the two owned slots; no partial operation survives rollback',async()=>{
    const u=await universeFixture();
    const results=await Promise.allSettled(Array.from({length:8},()=>u.make()));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_groups').get().n,2);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n,2);
    const b=await u.account('user_B',true);
    const reservation=await u.handle(b,'/universe/reservations',{operation_id:'reserve_slot_one'});
    await u.make(b);await universeReject(u.make(b),'OWNED_CAP');
    const replay=await u.handle(b,'/universe/reservations',{operation_id:'reserve_slot_one'});
    assert.equal(replay.reservation_id,reservation.reservation_id);
    u.db.sql.prepare('UPDATE universe_reservations SET expires_at=0 WHERE id=?').run(reservation.reservation_id);
    await u.make(b);
});
test('Universe: invitation hashes, expiry, current issuer role, immutable owner and direct role checks',async()=>{
    const u=await universeFixture(),g=await u.make(),member=await u.account('user_M'),outsider=await u.account('user_O');
    const i=await u.invite(g.group_id);const a=await u.accept(member,i.token,{operation_id:'accept_member_one'});
    assert.equal(a.role,'member');assert.equal((await u.accept(member,i.token,{operation_id:'accept_member_one'})).replayed,true);
    await universeReject(u.accept(outsider,i.token),'INVITE_INVALID');
    assert.equal(u.db.sql.prepare('SELECT token_hash FROM universe_invitations').get().token_hash.length,64);
    assert.ok(!JSON.stringify(u.db.sql.prepare('SELECT * FROM universe_operations').all()).includes(i.token));
    await universeReject(u.invite(g.group_id,member),'ACCESS_DENIED');
    await universeReject(u.handle(outsider,'/universe/groups/'+g.group_id),'ACCESS_DENIED');
    await universeReject(u.handle(member,'/universe/groups/uni_forged'),'ACCESS_DENIED');
    assert.throws(()=>u.db.sql.prepare('UPDATE universe_groups SET owner_id=? WHERE id=?').run(member.userId,g.group_id),/U_OWNER_IMMUTABLE/);
    assert.throws(()=>u.db.sql.prepare("UPDATE universe_members SET role='member' WHERE role='owner'").run(),/U_OWNER_IMMUTABLE/);
    assert.throws(()=>u.db.sql.prepare("DELETE FROM universe_members WHERE role='owner'").run(),/U_OWNER_IMMUTABLE/);
    const expired=await u.invite(g.group_id);u.db.sql.prepare('UPDATE universe_invitations SET expires_at=0 WHERE id=?').run(expired.result.invitation_id);
    await universeReject(u.accept(outsider,expired.token),'INVITE_INVALID');
    const ai=await u.invite(g.group_id,u.owner,'admin'),admin=await u.account('user_Admin');await u.accept(admin,ai.token);
    await universeReject(u.invite(g.group_id,admin,'admin'),'ROLE_DENIED');
    const issued=await u.invite(g.group_id,admin);
    u.db.sql.prepare("UPDATE universe_members SET role='member' WHERE account_id=?").run(admin.userId);
    await universeReject(u.accept(outsider,issued.token),'ROLE_DENIED');
});
test('Universe: parallel accepts enforce twenty participants and preserve rejected invitations',async()=>{
    const u=await universeFixture(),g=await u.make();
    const inputs=[];
    for(let n=0;n<24;n++)inputs.push([await u.account('user_P'+n),(await u.invite(g.group_id)).token]);
    const results=await Promise.allSettled(inputs.map(([a,t])=>u.accept(a,t)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,20);
    assert.equal(u.db.sql.prepare("SELECT count(*) n FROM universe_members WHERE role<>'owner'").get().n,20);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_invitations WHERE accepted_by IS NULL').get().n,4);
});
test('Universe: Free joins two and Pro joins seven additional; owned groups do not count',async()=>{
    const u=await universeFixture(),free=await u.account('user_Free'),pro=await u.account('user_Pro',true);
    await u.make(pro);await u.make(pro);
    const groups=[];
    for(let n=0;n<8;n++){const owner=await u.account('user_Owner'+n,true);groups.push([owner,(await u.make(owner)).group_id]);}
    const freeInvites=[],proInvites=[];
    for(const [owner,g] of groups){freeInvites.push((await u.invite(g,owner)).token);proInvites.push((await u.invite(g,owner)).token);}
    const frees=await Promise.allSettled(freeInvites.map(t=>u.accept(free,t)));
    const pros=await Promise.allSettled(proInvites.map(t=>u.accept(pro,t)));
    assert.equal(frees.filter(r=>r.status==='fulfilled').length,2);assert.equal(pros.filter(r=>r.status==='fulfilled').length,7);
    assert.equal((await u.handle(pro,'/universe/groups')).groups.length,9);
});
test('Universe: simultaneous duplicate acceptance creates one membership and rejects operation ID reuse',async()=>{
    const u=await universeFixture(),g=await u.make(),m=await u.account('user_M'),i=await u.invite(g.group_id);
    const results=await Promise.all([u.accept(m,i.token,{operation_id:'same_accept_id'}),u.accept(m,i.token,{operation_id:'same_accept_id'})]);
    assert.equal(results.filter(r=>r.replayed).length,1);
    const another=await u.invite(g.group_id);
    await universeReject(u.accept(m,another.token,{operation_id:'same_accept_id'}),'OPERATION_CONFLICT');
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_members WHERE account_id=?').get(m.userId).n,1);
});
test('Universe: deletion between authorization and commit rolls back every write and hides owned groups',async()=>{
    const u=await universeFixture(),g=await u.make(),m=await u.account('user_M'),i=await u.invite(g.group_id);
    await u.accept(m,i.token);
    u.db.beforeBatch=()=>u.f.service.universe.blockAccount(u.owner.userId);
    await universeReject(u.make(),'ACCOUNT_BLOCKED');
    await universeReject(u.handle(m,'/universe/groups/'+g.group_id),'ACCESS_DENIED');
    assert.equal((await u.handle(m,'/universe/groups')).groups.length,0);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_groups').get().n,1);
    await universeReject(u.make(),'ACCOUNT_BLOCKED');
    assert.throws(()=>u.db.sql.prepare('UPDATE universe_accounts SET blocked=0 WHERE account_id=?').run(u.owner.userId),/U_ACCOUNT_BLOCKED/);
});
test('Universe: real account deletion fences D1 before acceptance, even when feature is disabled',async()=>{
    const u=await universeFixture(); await u.make();u.f.env.ACCOUNT_DELETION_ENABLED='true';
    const proof=await verifiedDeletion(u.f,u.token,'user_A','rv_universe_delete');
    u.f.env.UNIVERSE_FOUNDATION_ENABLED='false';
    const result=await u.f.call('/auth/account',proof.token,'DELETE',proof);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(u.db.sql.prepare('SELECT blocked FROM universe_accounts WHERE account_id=?').get('user_A').blocked,1);
});
test('Universe: removed members and blocked invitees lose access; guards abort even after operation insert',async()=>{
    const u=await universeFixture(),g=await u.make(),m=await u.account('user_M'),i=await u.invite(g.group_id);
    await u.accept(m,i.token);
    u.db.sql.prepare('DELETE FROM universe_members WHERE account_id=?').run(m.userId);
    await universeReject(u.handle(m,'/universe/groups/'+g.group_id+'/members'),'ACCESS_DENIED');
    const newMember=await u.account('user_New'),fresh=await u.invite(g.group_id);
    const before=u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n;
    u.db.beforeBatch=()=>u.f.service.universe.blockAccount(newMember.userId);
    await universeReject(u.accept(newMember,fresh.token),'ACCOUNT_BLOCKED');
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n,before);
    assert.equal(u.db.sql.prepare('SELECT accepted_by FROM universe_invitations WHERE id=?').get(fresh.result.invitation_id).accepted_by,null);
});
test('Universe: reapplying additive schema preserves groups, operations and deletion tombstones',async()=>{
    const u=await universeFixture();await u.make();await u.f.service.universe.blockAccount('user_Blocked');
    u.db.sql.exec(readFileSync(new URL('./uni/universe-schema.sql',import.meta.url),'utf8'));
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_groups').get().n,1);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n,1);
    assert.equal(u.db.sql.prepare('SELECT blocked FROM universe_accounts WHERE account_id=?').get('user_Blocked').blocked,1);
});
test('Universe: changed issuer authority at final commit and simultaneous reservation/create cannot bypass guards',async()=>{
    const u=await universeFixture(),g=await u.make(),admin=await u.account('user_Admin');
    await u.accept(admin,(await u.invite(g.group_id,u.owner,'admin')).token);
    const before=u.db.sql.prepare('SELECT count(*) n FROM universe_invitations').get().n;
    u.db.beforeBatch=()=>u.db.sql.prepare("UPDATE universe_members SET role='member' WHERE account_id=?").run(admin.userId);
    await universeReject(u.invite(g.group_id,admin),'ROLE_DENIED');
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_invitations').get().n,before);
    const b=await u.account('user_B',true);
    const results=await Promise.allSettled([u.make(b),u.make(b),u.handle(b,'/universe/reservations',{operation_id:newOperation()}),u.handle(b,'/universe/reservations',{operation_id:newOperation()})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
    const used=u.db.sql.prepare('SELECT (SELECT count(*) FROM universe_groups WHERE owner_id=?)+(SELECT count(*) FROM universe_reservations WHERE account_id=?) n').get(b.userId,b.userId).n;
    assert.equal(used,2);
});
test('Universe: invalid deletion approval never fences group access; failed fencing never accepts personal deletion',async()=>{
    const u=await universeFixture();await u.make();
    const proof=await verifiedDeletion(u.f,u.token,'user_A','rv_universe_failure');
    const invalid=await u.f.call('/auth/account',proof.token,'DELETE',{...proof,verification_id:'a'.repeat(64)});
    assert.equal(invalid.status,403);
    assert.equal(u.db.sql.prepare('SELECT blocked FROM universe_accounts WHERE account_id=?').get('user_A').blocked,0);
    const original=u.f.service.universe.blockAccount.bind(u.f.service.universe);
    u.f.service.universe.blockAccount=async()=>{throw Object.assign(new Error('Unavailable'),{status:503,code:'UNIVERSE_UNAVAILABLE'});};
    const failed=await u.f.call('/auth/account',proof.token,'DELETE',proof);assert.equal(failed.status,503);
    assert.equal(await u.f.service.deletion.marker(u.owner),undefined);
    assert.equal((await u.f.storage.get('account:user_A')).deleting,undefined);
    u.f.service.universe.blockAccount=original;
    const retried=await u.f.call('/auth/account',proof.token,'DELETE',proof);assert.equal(retried.status,200);
});
test('Universe: a second invitation cannot alter an existing member role and remains unconsumed',async()=>{
    const u=await universeFixture(),g=await u.make(),m=await u.account('user_M');
    await u.accept(m,(await u.invite(g.group_id)).token);
    const promotion=await u.invite(g.group_id,u.owner,'admin');
    await universeReject(u.accept(m,promotion.token),'ALREADY_MEMBER');
    assert.equal(u.db.sql.prepare('SELECT role FROM universe_members WHERE account_id=?').get(m.userId).role,'member');
    assert.equal(u.db.sql.prepare('SELECT accepted_by FROM universe_invitations WHERE id=?').get(promotion.result.invitation_id).accepted_by,null);
});
test('Universe: invitation removed before final update cannot return a false success after a zero-row write',async()=>{
    const u=await universeFixture(),g=await u.make(),m=await u.account('user_M'),i=await u.invite(g.group_id);
    const before=u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n;
    u.db.beforeBatch=()=>u.db.sql.prepare('DELETE FROM universe_invitations WHERE id=?').run(i.result.invitation_id);
    await universeReject(u.accept(m,i.token),'INVITE_INVALID');
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_operations').get().n,before);
    assert.equal(u.db.sql.prepare('SELECT count(*) n FROM universe_members WHERE account_id=?').get(m.userId).n,0);
});

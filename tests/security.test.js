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
    let revoked = false, verificationStatus='complete', deleteFailure=false, googleToken=null, providerStatus=200;
    let claudeResponse={model:'claude-haiku-5-5',stop_reason:'end_turn',content:[{type:'text',text:'Hello from Claude'}],usage:{input_tokens:12,output_tokens:4}};
    const providerCalls=[];
    const deletedUsers=new Set();
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
        if(String(url).includes('/reverifications/'))return Response.json({status:verificationStatus,
            first_factor_verification:{status:verificationStatus==='complete'?'verified':'unverified',strategy:'password'}});
        if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({id_token:googleToken});
        if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[{...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'google-key'}]});
        if(options.method==='DELETE' && String(url).includes('/users/')) {
            if(deleteFailure)return Response.json({error:'temporary'}, {status:503});
            deletedUsers.add(String(url).split('/').pop());return Response.json({deleted:true});
        }
        if (String(url).includes('/sessions/')) {
            const id = String(url).split('/').pop();
            const userId='user_'+id.slice(5);
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
    return { storage, kv, env, service, call, deletedUsers, revoke: () => { revoked = true; },
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProGateway } from './pro-backend.js';
import { KEYO_DEFAULTS, keyoConfig, verifyKeyoToken } from './keyo-license.js';
import { signedToken, activeLicense, testEnv, testPublicKey } from './keyo-test-fixture.js';

class Storage {
    constructor(){this.data=new Map();this.queue=Promise.resolve();}
    async get(k){return structuredClone(this.data.get(k));}
    async put(k,v){this.data.set(k,structuredClone(v));}
    async transaction(fn){
        const p=this.queue.then(async()=>{const before=structuredClone(this.data);try{return await fn(this)}catch(e){this.data=before;throw e}});
        this.queue=p.catch(()=>{});return p;
    }
}
const config=keyoConfig(testEnv),DAY=86400000,HOUR=3600000;
function harness(env={}) {
    const storage=new Storage(),gateway=new ProGateway({storage,env:{...testEnv,...env}}),calls=[];
    const before=globalThis.fetch;
    let reply=async({body})=>Response.json({entitlement:await signedToken(body.accountId)});
    globalThis.fetch=async(url,options)=>{
        const call={url:new URL(url),options,body:JSON.parse(options.body)};calls.push(call);return reply(call);
    };
    const route=async(path='/pro/activate',body={key:'A1B2-C3D4-E5F6-G7H8'},account='user_A')=>{
        const method=path==='/pro/status'?'GET':'POST';
        const r=await gateway.handleRequest(new Request('https://worker.test'+path,{method,...(method==='POST'?{body:JSON.stringify(body)}:{})}),path,method,{userId:account,sessionId:'session_A'},{});
        return {status:r.status,body:await r.json()};
    };
    return {storage,gateway,calls,route,reply:fn=>{reply=fn},restore:()=>{globalThis.fetch=before}};
}
async function withHarness(fn,env){const h=harness(env);try{await fn(h)}finally{h.restore()}}
const licenseKey='pro:entitlement:user_A';

test('configured public SDK settings are valid and malformed/empty overrides fail closed',async()=>{
    assert.equal(keyoConfig().endpoint,'https://keyo.mazendev.com');
    assert.equal(keyoConfig().projectId,KEYO_DEFAULTS.projectId);
    await crypto.subtle.importKey('jwk',KEYO_DEFAULTS.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    for(const env of [{KEYO_API_ORIGIN:''},{KEYO_API_ORIGIN:'http://keyo.test'},
        {KEYO_API_ORIGIN:'https://user:pass@keyo.test'},{KEYO_API_ORIGIN:'https://keyo.test/path'},
        {KEYO_PROJECT_ID:''},{KEYO_PUBLIC_JWK:''},{KEYO_PUBLIC_JWK:'{}'},
        {KEYO_PUBLIC_JWK:{...testPublicKey,d:'private'}}])assert.throws(()=>keyoConfig(env),{code:'KEYO_SETUP_REQUIRED'});
});

test('real ES256 tokens enforce signature, header, account, project, IDs, tier and deadlines',async()=>{
    const valid=await signedToken('user_A');
    assert.equal((await verifyKeyoToken(valid,'user_A',config)).tier,'PRO');
    assert.equal((await verifyKeyoToken(await signedToken('user_A',{expiresAt:null,tier:'MAX'}),'user_A',config)).expiresAt,null);
    const now=Date.now();
    for(const overrides of [{accountId:'user_B'},{projectId:'prj_other'},{v:2},{keyId:''},{keyId:7},{bindingId:''},
        {tier:'FREE'},{tier:'owner'},{tier:3},{issuedAt:now+61000,validUntil:now+DAY},
        {issuedAt:-1},{issuedAt:now+.5},{validUntil:now+DAY+60000},{validUntil:now},
        {expiresAt:now-1},{expiresAt:undefined},{expiresAt:'2099-01-01'},{expiresAt:now+500}]) {
        const token=await signedToken('user_A',overrides);
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config),undefined,JSON.stringify(overrides));
    }
    for(const header of [{alg:'none',typ:'KEYO'},{alg:'HS256',typ:'KEYO'},{alg:'ES256',typ:'JWT'}]) {
        const token=await signedToken('user_A',{},header);
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config));
    }
    const parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({tier:'MAX'})).toString('base64url');
    for(const token of [parts.join('.'),'a.b.c','anything','x'.repeat(4097),null])
        await assert.rejects(()=>verifyKeyoToken(token,'user_A',config));
    const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const otherPublicKey=await crypto.subtle.exportKey('jwk',other.publicKey);
    await assert.rejects(()=>verifyKeyoToken(valid,'user_A',{...config,publicKey:otherPublicKey}));
});

test('activation uses Keyo API with signed-in account, strips formatting and preserves balances and BYOK',async()=>withHarness(async h=>{
    const existing=await activeLicense('user_A');existing.use_byok=true;existing.activated_at=123;
    await h.storage.put(licenseKey,existing);await h.storage.put('pro:usage:user_A:month:2026-10',12.375);
    const r=await h.route();assert.equal(r.status,200);assert.equal(r.body.isPro,true);
    assert.equal(r.body.credits_daily_limit,45);assert.equal(r.body.credits_monthly_limit,1000);
    assert.equal(h.calls[0].url.origin,KEYO_DEFAULTS.endpoint);
    assert.equal(h.calls[0].url.pathname,'/api/v1/activate');
    assert.equal(h.calls[0].url.searchParams.get('projectId'),KEYO_DEFAULTS.projectId);
    assert.deepEqual(h.calls[0].body,{accountId:'user_A',key:'A1B2C3D4E5F6G7H8'});
    assert.equal(h.calls[0].options.redirect,'error');
    const saved=await h.storage.get(licenseKey);assert.equal(saved.keyo_version,1);assert.equal(saved.use_byok,true);assert.equal(saved.activated_at,123);
    assert.equal(await h.storage.get('pro:usage:user_A:month:2026-10'),12.375);
    assert.equal(saved.key,undefined);assert.equal(saved.license_key,undefined);
    assert.ok(!JSON.stringify([...h.storage.data]).includes('A1B2C3D4E5F6G7H8'));
    const status=await h.route('/pro/status');assert.equal(status.body.isPro,true);assert.equal(h.calls.length,1);
}));

test('fabricated keys, setup errors, provider denial, missing responses and bad signatures never grant Pro',async()=>{
    await withHarness(async h=>{
        for(const key of ['DEMOONLY00000001','arbitrary-long-string','abc']) {
            h.reply(async()=>Response.json({error:'KEY_UNAVAILABLE'},{status:403}));
            const r=await h.route('/pro/activate',{key});assert.notEqual(r.status,200);
            assert.equal(await h.storage.get(licenseKey),undefined);
        }
        for(const data of [{},{entitlement:'abc.def.ghi'},{entitlement:42},
            {entitlement:await signedToken('user_B')},{entitlement:await signedToken('user_A',{tier:'FREE'})}]) {
            h.reply(async()=>Response.json(data));assert.notEqual((await h.route()).status,200);
            assert.equal(await h.storage.get(licenseKey),undefined);
        }
        h.reply(async()=>{throw Error('offline')});assert.equal((await h.route()).status,503);
    });
    await withHarness(async h=>{assert.equal((await h.route()).body.code,'KEYO_SETUP_REQUIRED');assert.equal(h.calls.length,0)}, {KEYO_PROJECT_ID:''});
});

test('unsigned old bypass grants are blocked for status, toggles, quotes and paid audit requests',async()=>withHarness(async h=>{
    await h.storage.put(licenseKey,{status:'active',tier:'pro',expires_at:Date.now()+DAY});
    assert.equal((await h.route('/pro/status')).body.isPro,false);
    assert.equal((await h.route('/pro/byok',{use_byok:true})).status,403);
    for(const path of ['/pro/ai/quote','/pro/ai/review','/pro/ai/batch-review']) {
        const r=await h.route(path,{operation_id:'operation_123',task_id:'t',criteria:'Completed',
            tasks:[{id:'t',criteria:'Completed'}],files:[{mime_type:'image/png',data:'YWJj'}]});
        assert.equal(r.status,403);assert.equal(r.body.code,'PRO_REQUIRED');
    }
    assert.equal(h.calls.length,0);
}));

test('previous signed entitlements require online verification before migration',async()=>withHarness(async h=>{
    const old=await activeLicense('user_A');delete old.keyo_version;
    await h.storage.put(licenseKey,old);
    const r=await h.route('/pro/status');assert.equal(r.body.isPro,true);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].url.pathname,'/api/v1/verify');
    assert.equal(h.calls[0].body.entitlement,old.signed_token);
    assert.equal((await h.storage.get(licenseKey)).keyo_version,1);
}));

test('old signed tokens cannot migrate during a Keyo outage; tampered and wrong-account caches are rejected',async()=>withHarness(async h=>{
    const old=await activeLicense('user_A');delete old.keyo_version;
    await h.storage.put(licenseKey,old);h.reply(async()=>{throw Error('offline')});
    assert.equal((await h.route('/pro/status')).status,503);
    await h.storage.put(licenseKey,await activeLicense('user_B'));
    assert.equal((await h.route('/pro/status')).body.isPro,false);
    assert.equal((await h.storage.get(licenseKey)).status,'invalid');
}));

test('hourly refresh rejects revocation, suspension, deletion, expiry and binding reassignment',async()=>{
    for(const code of ['REVOKED','SUSPENDED','DELETED','EXPIRED','INVALID_PROJECT'])await withHarness(async h=>{
        await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
        h.reply(async()=>Response.json({error:code},{status:403}));
        const r=await h.route('/pro/status');assert.equal(r.body.isPro,false,code);
        assert.equal((await h.route('/pro/byok',{use_byok:true})).status,403);
    });
    await withHarness(async h=>{
        await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
        h.reply(async()=>Response.json({entitlement:await signedToken('user_A',{bindingId:'other-binding'})}));
        assert.equal((await h.route('/pro/status')).body.isPro,false);
    });
});

test('network fallback lasts only until the signed cache deadline; expired tokens can recover online',async()=>withHarness(async h=>{
    const now=Date.now();
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:now-HOUR-1000,validUntil:now+HOUR}));
    h.reply(async()=>{throw Error('offline')});
    assert.equal((await h.route('/pro/status')).body.isPro,true);
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:now-DAY,validUntil:now-1}));
    assert.equal((await h.route('/pro/status')).status,503);
    h.reply(async({body})=>Response.json({entitlement:await signedToken(body.accountId)}));
    assert.equal((await h.route('/pro/status')).body.isPro,true);
    assert.equal((await h.storage.get(licenseKey)).status,'active');
}));

test('lifetime licenses keep a null expiry and renew their short verification window',async()=>withHarness(async h=>{
    h.reply(async()=>Response.json({entitlement:await signedToken('user_A',{expiresAt:null})}));
    assert.equal((await h.route()).body.expires_at,null);
    const status=await h.route('/pro/status');assert.equal(status.body.isPro,true);assert.equal(status.body.expires_at,null);
}));

test('Keyo reassignment is authoritative even when a stale local fingerprint names another account',async()=>withHarness(async h=>{
    const normalized='A1B2C3D4E5F6G7H8';
    const fp=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized))).toString('hex');
    await h.storage.put('pro:binding:'+fp,{account_id:'old_owner'});
    assert.equal((await h.route()).status,200);
}));

test('late refresh cannot resurrect a deleted account',async()=>withHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    let release,entered;
    const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.reply(async({body})=>{entered();await gate;return Response.json({entitlement:await signedToken(body.accountId)})});
    const refreshing=h.route('/pro/status');await started;
    h.storage.data.delete(licenseKey);release();
    assert.equal((await refreshing).body.isPro,false);assert.equal(await h.storage.get(licenseKey),undefined);
}));

test('parallel status requests share one refresh and a late response preserves a replacement license',async()=>withHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    let release,entered;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    h.reply(async({body})=>{entered();await gate;return Response.json({entitlement:await signedToken(body.accountId)})});
    const requests=[h.route('/pro/status'),h.route('/pro/status')];await started;
    const replacement=await activeLicense('user_A',{keyId:'replacement-key',bindingId:'replacement-binding',tier:'MAX'});
    await h.storage.put(licenseKey,replacement);release();
    const results=await Promise.all(requests);assert.ok(results.every(r=>r.body.isPro));assert.equal(h.calls.length,1);
    assert.equal((await h.storage.get(licenseKey)).signed_token,replacement.signed_token);
}));

test('invalid refreshed signatures cannot use the outage fallback',async()=>withHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    h.reply(async()=>Response.json({entitlement:'bad.signature.here'}));
    assert.equal((await h.route('/pro/status')).body.isPro,false);
}));

test('cached access does not extend or refresh signed deadlines during temporary failure',async()=>withHarness(async h=>{
    const old=await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR});
    old.last_verified_at=Date.now()-HOUR;
    await h.storage.put(licenseKey,old);h.reply(async()=>{throw Error('offline')});
    const resolved=await h.gateway.licenses.resolve('user_A');
    assert.equal(resolved.last_verified_at,old.last_verified_at);assert.equal(resolved.valid_until,old.valid_until);
    assert.deepEqual(await h.storage.get(licenseKey),old);
}));


test('revocation after a price preview prevents a paid hosted provider call',async()=>withHarness(async h=>{
    await h.storage.put(licenseKey,await activeLicense('user_A',{issuedAt:Date.now()-HOUR-1000,validUntil:Date.now()+HOUR}));
    h.reply(async()=>Response.json({error:'REVOKED'},{status:403}));
    const r=await h.route('/pro/ai/review',{operation_id:'existing_quote_operation',quote_id:'previous_preview',task_id:'t',criteria:'Completed',files:[{mime_type:'image/png',data:'YWJj'}]});
    assert.equal(r.status,403);assert.equal(r.body.code,'PRO_REQUIRED');assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].url.pathname,'/api/v1/verify');
}));

import {SecurityError, sha256} from './auth.js';
import {randomSecret, VERIFICATION_VERSION} from './verification.js';
import {PROVIDERS,providerId} from './ai-models.js';
export const AI_MODELS = PROVIDERS.gemini.models;
export const MAX_AI_BYTES = 20 * 1024 * 1024;
export const secretFields = ['gemini_api_key','claude_api_key','worker_passkey','session_token','phone_token','macro_token','auth_user_id'];
export function scrubSettings(settings) {
    const clean={...(settings||{})}; for(const field of secretFields)delete clean[field]; return clean;
}
const encode=bytes=>btoa(String.fromCharCode(...bytes));
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const validId=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
export class KeyVault {
    constructor(service){this.service=service;this.storage=service.storage;this.env=service.env;}
    configuration(){
        let keys;
        try{keys=JSON.parse(this.env.API_VAULT_KEYS||'{}');}catch{throw new SecurityError(503,'Secure key storage needs setup. Follow PHASE-2-SETUP.html.');}
        const active=this.env.API_VAULT_ACTIVE_KEY_ID||'v1';
        if(!keys || typeof keys!=='object' || Array.isArray(keys) || !/^[A-Za-z0-9_-]{1,40}$/.test(active) || !Object.hasOwn(keys,active))
            throw new SecurityError(503,'Secure key storage needs setup. Follow PHASE-2-SETUP.html.');
        return {keys,active};
    }
    ready(){try{const {keys,active}=this.configuration();return decode(keys[active]).length===32;}catch{return false;}}
    async cryptoKey(kid){
        try{
            const {keys}=this.configuration();
            if(!Object.hasOwn(keys,kid) || typeof keys[kid]!=='string')throw new Error();
            const bytes=decode(keys[kid]);if(bytes.length!==32)throw new Error();
            return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
        }catch{throw new SecurityError(503,'Vault encryption key is unavailable. Check retained key versions; no saved key was replaced.');}
    }
    async prefix(identity){return await sha256(identity.userId);}
    async recordKey(identity,provider='gemini'){return 'vault:'+await this.prefix(identity)+':'+providerId(provider);}
    async stagePrefix(identity,provider='gemini'){return 'vault-stage:'+await this.prefix(identity)+':'+provider+':';}
    validateKey(value){
        if(typeof value!=='string')throw new SecurityError(400,'Enter a valid API key for the selected provider.');
        const key=value.trim();
        if(key.length<8 || key.length>2048 || /\s|[\x00-\x1f\x7f]/.test(key))throw new SecurityError(400,'Enter a valid API key without spaces or line breaks.');
        return key;
    }
    recoveredKey(value){
        // Recovery preserves even an old placeholder/invalid key. It must not
        // block access to the user's tasks; activation still validates the key.
        if(typeof value!=='string' || !value.trim() || value.length>4096)throw new SecurityError(400,'An old key needs manual review. The original copy has been retained.');
        return value.trim();
    }
    aad(identity,record){return new TextEncoder().encode(JSON.stringify(['Taskitator-key-vault',1,identity.userId,record.provider||'gemini',record.kind,record.version]));}
    async seal(identity,value,kind='active',provider='gemini'){
        const kid=this.configuration().active,iv=crypto.getRandomValues(new Uint8Array(12));
        const record={kind,kid,provider,version:randomSecret(),suffix:value.slice(-4),updated_at:Date.now()};
        const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(identity,record),tagLength:128},
            await this.cryptoKey(kid),new TextEncoder().encode(value));
        return {...record,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
    }
    async unseal(identity,record,provider='gemini'){
        if(!record?.ciphertext || !['active','stage'].includes(record.kind))throw new SecurityError(404,'No saved key is available.');
        if((record.provider||'gemini')!==providerId(provider))throw new SecurityError(503,'Saved key provider does not match this record. No key was returned or replaced.');
        const key=await this.cryptoKey(record.kid);
        try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(record.iv),
            additionalData:this.aad(identity,record),tagLength:128},key,decode(record.ciphertext)));}
        catch{throw new SecurityError(503,'Saved key could not be decrypted. Check vault key versions; no saved key was replaced.');}
    }
    async assertOwner(tx,identity){
        if(identity.actor)throw new SecurityError(403,'Impersonated sessions cannot access API keys.');
        const link=await tx.get('identity:'+identity.userId),meta=link?await tx.get('account:'+encodeURIComponent(link.user)):null;
        if(!meta || meta.deleting || meta.owner_id!==identity.userId)throw new SecurityError(403,'API key access denied.');
        return link;
    }
    async providerMetadata(identity,provider){
        const record=await this.storage.get(await this.recordKey(identity,provider));
        const staged=await this.storage.list({prefix:await this.stagePrefix(identity,provider),limit:17});
        const archives=provider==='claude'?await this.storage.list({prefix:'vault:'+await this.prefix(identity)+':claude-archive',limit:1}):new Map();
        return {provider,models:PROVIDERS[provider].models,ready:this.ready(),saved:record?.kind==='active',version:record?.version||'empty',archive_pending:archives.size>0,
            suffix:record?.kind==='active'?record.suffix:null,
            pending:[...staged].map(([key,item])=>({id:key.split(':').pop(),suffix:item.suffix,updated_at:item.updated_at}))};
    }
    async selectedProvider(identity){
        const link=await this.assertOwner(this.storage,identity);
        const meta=await this.storage.get('account:'+encodeURIComponent(link.user));
        return providerId(meta.ai_provider||'gemini');
    }
    async metadata(identity,provider='gemini'){
        providerId(provider);await this.assertOwner(this.storage,identity);
        const providers={};
        for(const id of Object.keys(PROVIDERS))providers[id]=await this.providerMetadata(identity,id);
        return {...providers[provider],providers,selected_provider:await this.selectedProvider(identity),
            historical_cleanup_pending:Boolean(await this.storage.get('vault-cleanup:'+await this.prefix(identity)))};
    }
    async select(identity,provider){
        providerId(provider);await this.assertOwner(this.storage,identity);
        const record=await this.storage.get(await this.recordKey(identity,provider));
        if(record?.kind!=='active')throw new SecurityError(409,'Save and test a key for this provider before using it for AI.');
        await this.unseal(identity,record,provider);
        await this.storage.transaction(async tx=>{
            const link=await this.assertOwner(tx,identity),key='account:'+encodeURIComponent(link.user),meta=await tx.get(key);
            const current=await tx.get(await this.recordKey(identity,provider));
            if(current?.kind!=='active' || current.version!==record.version)throw new SecurityError(409,'The saved key changed. Refresh its status and try again.');
            meta.ai_provider=provider;await tx.put(key,meta);
        });
        return this.metadata(identity,provider);
    }
    async recoverClaudeArchives(tx,identity){
        const prefix=await this.stagePrefix(identity,'claude');
        const staged=await tx.list({prefix,limit:17});
        const archives=await tx.list({prefix:'vault:'+await this.prefix(identity)+':claude-archive',limit:16});
        for(const [name,record]of archives){
            // Leave inaccessible versions intact; do not block unrelated Gemini
            // use or silently discard an encrypted archive on a keyring error.
            let value;try{value=await this.unseal(identity,record,'claude');}catch{return;}
            const key=prefix+await sha256(value);
            if(!staged.has(key)){
                if(staged.size>=16)return;
                const recovered=await this.seal(identity,value,'stage','claude');
                await tx.put(key,recovered);staged.set(key,recovered);
            }
            await tx.delete(name);
        }
    }
    async stage(identity,values,provider='gemini'){
        providerId(provider);
        if(!this.ready())throw new SecurityError(503,'Secure key storage needs setup before old keys can be migrated.');
        await this.assertOwner(this.storage,identity);
        if(!Array.isArray(values) || values.length>16)throw new SecurityError(400,'Too many recovered keys. Keep the original copies and contact support.');
        const prefix=await this.stagePrefix(identity,provider),prepared=[];
        for(const value of new Set(values)){
            const key=this.recoveredKey(value),id=await sha256(key);
            prepared.push([prefix+id,await this.seal(identity,key,'stage',provider)]);
        }
        await this.storage.transaction(async tx=>{
            await this.assertOwner(tx,identity);
            const existing=await tx.list({prefix,limit:17});
            if(new Set([...existing.keys(),...prepared.map(([key])=>key)]).size>16)throw new SecurityError(409,'Recovered key storage is full. Review saved keys before migrating more.');
            for(const [key,record]of prepared)if(!await tx.get(key))await tx.put(key,record);
        });
        return this.metadata(identity,provider);
    }
    async context(identity,action,stageId,provider='gemini'){
        providerId(provider);
        await this.assertOwner(this.storage,identity);
        if(!['api-key-reveal','api-key-save','api-key-delete'].includes(action))throw new SecurityError(400,'Invalid key action.');
        if(stageId && !validId(stageId))throw new SecurityError(400,'Invalid recovered key selection.');
        if(stageId && !await this.storage.get(await this.stagePrefix(identity,provider)+stageId))throw new SecurityError(404,'Recovered key was not found.');
        const record=await this.storage.get(await this.recordKey(identity,provider));
        return {provider,version:record?.version||'empty',stage_id:stageId||null};
    }
    async takeProof(tx,identity,id,action,stageId=null,provider='gemini'){
        providerId(provider);
        await this.assertOwner(tx,identity);
        if(!validId(id))throw new SecurityError(403,'Verify your identity for this key action.');
        const proofKey='action-proof:'+await sha256(id),proof=await tx.get(proofKey);
        const current=await tx.get(await this.recordKey(identity,provider));
        if(!proof || proof.version!==VERIFICATION_VERSION || proof.status!=='verified' || proof.expires<=Date.now() || proof.userId!==identity.userId ||
            proof.sessionId!==identity.sessionId || proof.action!==action || proof.context?.provider!==provider ||
            proof.context.version!==(current?.version||'empty') || proof.context.stage_id!==stageId){
            throw new SecurityError(403,'Verification expired, was used, or the saved key changed. Verify again.');
        }
        proof.status='consumed';await tx.put(proofKey,proof);
        return current;
    }
    async reveal(identity,body){
        const provider=providerId(body.provider);
        const stageId=body.stage_id||null,key=stageId?await this.stagePrefix(identity,provider)+stageId:await this.recordKey(identity,provider);
        if(stageId && !validId(stageId))throw new SecurityError(400,'Invalid recovered key.');
        const record=await this.storage.transaction(async tx=>{
            await this.takeProof(tx,identity,body.verification_id,'api-key-reveal',stageId,provider);
            const saved=await tx.get(key);if(!saved?.ciphertext)throw new SecurityError(404,'No key is saved.');return saved;
        });
        const value=await this.unseal(identity,record,provider);
        await this.assertOwner(this.storage,identity);
        return {key:value,reveal_seconds:30};
    }
    async testKey(key,provider='gemini'){
        providerId(provider);
        let response;
        const model=PROVIDERS[provider].models[0],name=PROVIDERS[provider].name;
        const url=provider==='claude'?'https://api.anthropic.com/v1/models/'+model:'https://generativelanguage.googleapis.com/v1beta/models/'+model;
        const headers=provider==='claude'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{'x-goog-api-key':key};
        try{response=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});}
        catch{throw new SecurityError(503,name+' connection could not be checked. Try again.');}
        if(!response.ok){
            try{await response.body?.cancel();}catch{}
            throw new SecurityError(response.status===429?429:response.status>=500?503:400,name+' did not accept the key/model check. Check the key, API restrictions and model access.');
        }
        try{await response.body?.cancel();}catch{}
        return {success:true,generated_tokens:0,model,provider,
            message:'Key and model access accepted. No tokens generated; generation quota and billing were not tested.'};
    }
    async save(identity,body){
        const stageId=body.stage_id||null,provider=providerId(body.provider);
        const proof=await this.service.verification.get(body.verification_id,identity,'api-key-save');
        const context=await this.context(identity,'api-key-save',stageId,provider);
        if(proof.status!=='verified' || JSON.stringify(proof.context)!==JSON.stringify(context))throw new SecurityError(403,'Verify your identity for this key change.');
        await this.service.rateBucket('key-test:'+identity.userId,6);
        let value;
        if(stageId){
            if(!validId(stageId))throw new SecurityError(400,'Invalid recovered key.');
            value=this.validateKey(await this.unseal(identity,await this.storage.get(await this.stagePrefix(identity,provider)+stageId),provider));
        }else value=this.validateKey(body.key);
        const test=await this.testKey(value,provider),sealed=await this.seal(identity,value,'active',provider);
        await this.storage.transaction(async tx=>{
            await this.takeProof(tx,identity,body.verification_id,'api-key-save',stageId,provider);
            await tx.put(await this.recordKey(identity,provider),sealed);
            if(stageId)await tx.delete(await this.stagePrefix(identity,provider)+stageId);
        });
        return {...await this.metadata(identity,provider),test};
    }
    async remove(identity,body){
        const stageId=body.stage_id||null,provider=providerId(body.provider);
        if(stageId && !validId(stageId))throw new SecurityError(400,'Invalid recovered key.');
        await this.storage.transaction(async tx=>{
            await this.takeProof(tx,identity,body.verification_id,'api-key-delete',stageId,provider);
            if(stageId)await tx.delete(await this.stagePrefix(identity,provider)+stageId);
            else await tx.put(await this.recordKey(identity,provider),{kind:'deleted',provider,version:randomSecret(),updated_at:Date.now()});
        });
        return this.metadata(identity,provider);
    }
    async testSaved(identity,provider='gemini'){
        providerId(provider);
        await this.assertOwner(this.storage,identity);
        await this.service.rateBucket('key-test:'+identity.userId,6);
        return this.testKey(await this.unseal(identity,await this.storage.get(await this.recordKey(identity,provider)),provider),provider);
    }
    async cleanupLegacy(){
        const jobs=await this.storage.list({prefix:'vault-cleanup:',limit:1});
        for(const [jobKey,job]of jobs){
            const identity={userId:job.userId};
            try{
                await this.assertOwner(this.storage,identity);
            }catch(error){if(error instanceof SecurityError && error.status===403)await this.storage.delete(jobKey);continue;}
            const kv=this.env.TASKITATOR_KV;
            if(!kv?.list || !kv?.put)return;
            try{
                const page=await kv.list({prefix:'user_data:',limit:15,...(job.cursor?{cursor:job.cursor}:{})});
                for(const entry of page.keys){
                    let record;
                    try{record=await kv.get(entry.name,{type:'json'});}catch{job.review_needed=true;continue;}
                    const owner=record?.username||record?.settings?.worker_username;
                    if(typeof owner!=='string'||owner.trim().toLowerCase()!==job.user)continue;
                    if(record.settings && ('gemini_api_key' in record.settings || 'claude_api_key' in record.settings)){
                        const gemini=record.settings.gemini_api_key;
                        if(typeof gemini==='string' && gemini.trim())await this.stage(identity,[gemini]);
                        const claude=record.settings.claude_api_key;
                        if(typeof claude==='string' && claude.trim())await this.stage(identity,[claude],'claude');
                        await this.assertOwner(this.storage,identity);
                        record.settings=scrubSettings(record.settings);
                        await kv.put(entry.name,JSON.stringify(record));
                    }
                }
                if(page.list_complete)await this.storage.delete(jobKey);
                else{job.cursor=page.cursor;await this.storage.put(jobKey,job);}
            }catch{ /* Cursor stays on the same page; scrub writes are idempotent. */ }
        }
    }
}

export function validatePayload(payload){
    if(!payload || typeof payload!=='object' || Array.isArray(payload) || !Array.isArray(payload.contents) ||
        !payload.contents.length || payload.contents.length>100)throw new SecurityError(400,'Invalid AI conversation.');
    const allowed=new Set(['contents','systemInstruction','system_instruction','generationConfig','tools','toolConfig','tool_config','safetySettings','taskitatorFormat']);
    if(Object.keys(payload).some(key=>!allowed.has(key)))throw new SecurityError(400,'Unsupported AI request options.');
    if(payload.taskitatorFormat && !['criteria','proof','notes'].includes(payload.taskitatorFormat))throw new SecurityError(400,'Unsupported AI output format.');
    const inspect=part=>{
        if(!part || typeof part!=='object')throw new SecurityError(400,'Invalid AI content.');
        const allowedParts=new Set(['text','inline_data','inlineData','functionCall','function_call','functionResponse','function_response','thoughtSignature','thought_signature','thought']);
        if(Object.keys(part).some(key=>!allowedParts.has(key)))throw new SecurityError(400,'Unsupported file or AI content.');
        const file=part.inline_data||part.inlineData;
        if(file){
            const type=file.mime_type||file.mimeType;
            if(!['image/jpeg','image/png','image/webp','image/heic','application/pdf'].includes(type) ||
                typeof file.data!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length>Math.ceil(5*1024*1024/3)*4)
                throw new SecurityError(413,'AI attachments must be supported images/PDFs of at most 5 MB each.');
        }
    };
    for(const content of payload.contents){
        if(!content || !Array.isArray(content.parts) || content.parts.length>40)throw new SecurityError(400,'Invalid AI message parts.');
        content.parts.forEach(inspect);
    }
    const system=payload.systemInstruction||payload.system_instruction;if(system?.parts)system.parts.forEach(inspect);
    if(payload.tools && (!Array.isArray(payload.tools) || payload.tools.some(tool=>Object.keys(tool).some(key=>!['functionDeclarations','function_declarations'].includes(key)))))
        throw new SecurityError(400,'Only Taskitator function tools are supported.');
    const generation={...(payload.generationConfig||{})};
    const maximum=generation.maxOutputTokens??16384;
    if(!Number.isInteger(maximum)||maximum<1||maximum>16384)throw new SecurityError(400,'AI output limit must be between 1 and 16384 tokens.');
    if(generation.candidateCount && generation.candidateCount!==1)throw new SecurityError(400,'Only one AI result is supported per request.');
    generation.maxOutputTokens=maximum;generation.candidateCount=1;
    return {...payload,generationConfig:generation};
}

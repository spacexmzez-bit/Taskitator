import {SecurityError} from './auth.js';
import {validatePayload} from './vault.js';
import {PROVIDERS,providerId} from './ai-models.js';

const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const jsonSchema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const OUTPUT_SCHEMAS={
    criteria:jsonSchema({score:{type:'integer'},passed:{type:'boolean'},critique:{type:'string'},suggested_rewrite:{type:'string'}}),
    proof:jsonSchema({verdict:{type:'string',enum:['approved','rejected']},confidence:{type:'number'},critique:{type:'string'}}),
    notes:jsonSchema({notes:{type:'array',items:jsonSchema({id:{anyOf:[{type:'string'},{type:'number'}]},title:{type:'string'},clean_text:{type:'string'}})}})
};
function translateSchema(value){
    if(Array.isArray(value))return value.map(translateSchema);
    if(!object(value))return value;
    const result={};
    for(const [key,item]of Object.entries(value)){
        if(key==='propertyOrdering'||key==='nullable')continue;
        result[key]=key==='type' && typeof item==='string'?item.toLowerCase():translateSchema(item);
    }
    if(value.nullable===true && typeof result.type==='string')result.type=[result.type,'null'];
    return result;
}
export function toClaudeRequest(payload){
    const messages=[],waiting=new Map();let callNumber=0;
    const add=(role,blocks)=>{
        if(!blocks.length)throw new SecurityError(400,'AI messages must contain text, a supported file or a tool result.');
        const previous=messages.at(-1);
        if(previous?.role===role)previous.content.push(...blocks);
        else messages.push({role,content:blocks});
    };
    for(const message of payload.contents){
        if(message.role && !['user','model'].includes(message.role))throw new SecurityError(400,'Unsupported AI message role.');
        const role=message.role==='model'?'assistant':'user',blocks=[];
        for(const part of message.parts){
            const fn=part.functionCall||part.function_call,result=part.functionResponse||part.function_response,file=part.inlineData||part.inline_data;
            if(fn){
                if(role!=='assistant' || typeof fn.name!=='string' || !object(fn.args||{}))throw new SecurityError(400,'Invalid AI tool call.');
                const id=fn.id||'toolu_taskitator_'+(++callNumber);
                if(!/^[A-Za-z0-9_-]{1,128}$/.test(id) || waiting.has(id))throw new SecurityError(400,'Invalid or duplicate AI tool call identifier.');
                waiting.set(id,fn.name);blocks.push({type:'tool_use',id,name:fn.name,input:fn.args||{}});
            }else if(result){
                if(role!=='user')throw new SecurityError(400,'Tool results must be user messages.');
                const id=result.id||[...waiting].find(([,name])=>name===result.name)?.[0];
                if(!id || waiting.get(id)!==result.name)throw new SecurityError(400,'Tool result does not match an earlier tool call.');
                waiting.delete(id);
                blocks.push({type:'tool_result',tool_use_id:id,content:JSON.stringify(result.response??{})});
            }else if(file){
                if(role!=='user')throw new SecurityError(400,'Reference files must be user messages.');
                const type=file.mimeType||file.mime_type;
                if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(type))throw new SecurityError(415,'Claude accepts JPG, PNG, WebP and PDF here. Convert HEIC photos or switch to Gemini.');
                const source={type:'base64',media_type:type,data:file.data};
                blocks.push(type==='application/pdf'?{type:'document',source}:{type:'image',source});
            }else if(typeof part.text==='string' && !part.thought){
                if(part.text)blocks.push({type:'text',text:part.text});
            }else if(part.thought || part.thoughtSignature || part.thought_signature){
                throw new SecurityError(400,'Start a new conversation after changing AI providers.');
            }else throw new SecurityError(400,'Unsupported Claude message content.');
        }
        // Claude requires tool results before ordinary text in the next user turn.
        if(role==='user')blocks.sort((a,b)=>(a.type==='tool_result'?0:1)-(b.type==='tool_result'?0:1));
        add(role,blocks);
    }
    if(waiting.size || messages[0]?.role!=='user' || messages.at(-1)?.role!=='user')throw new SecurityError(400,'Start or continue the AI conversation with a user message and complete tool results.');
    const result={model:PROVIDERS.claude.models[0],max_tokens:payload.generationConfig.maxOutputTokens,
        thinking:{type:'disabled'},output_config:{effort:'low'},messages};
    const system=payload.systemInstruction||payload.system_instruction;
    if(system){
        if(!Array.isArray(system.parts) || system.parts.some(part=>typeof part.text!=='string'))throw new SecurityError(400,'Invalid AI system instructions.');
        result.system=system.parts.map(part=>part.text).join('\n');
    }
    const tools=(payload.tools||[]).flatMap(tool=>tool.functionDeclarations||tool.function_declarations||[]);
    if(tools.length){
        if(tools.length>32 || tools.some(tool=>typeof tool.name!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)))throw new SecurityError(400,'Invalid AI tool definitions.');
        result.tools=tools.map(tool=>({name:tool.name,description:String(tool.description||''),input_schema:translateSchema(tool.parameters||{type:'object',properties:{}})}));
        result.tool_choice={type:'auto',disable_parallel_tool_use:true};
    }
    if(payload.taskitatorFormat)result.output_config.format={type:'json_schema',schema:OUTPUT_SCHEMAS[payload.taskitatorFormat]};
    else if(payload.generationConfig.responseMimeType==='application/json'){
        // Legacy callers without the new format tag still fail safely on invalid
        // JSON in the existing client parser rather than receiving an AI approval.
        result.system=(result.system||'')+'\nRespond only with valid JSON matching the requested schema. No markdown fences.';
    }
    return result;
}
export function fromClaudeResponse(data){
    if(data.stop_reason==='refusal')throw new SecurityError(422,'Claude declined this request. No AI approval was issued.');
    if(data.stop_reason==='max_tokens')throw new SecurityError(502,'Claude reached its output limit. No partial answer or tool action was accepted.');
    if(data.stop_reason==='model_context_window_exceeded')throw new SecurityError(413,'Claude conversation is too large. Start a new conversation.');
    if(!['end_turn','tool_use'].includes(data.stop_reason) || !Array.isArray(data.content))throw new SecurityError(502,'Claude returned an unsupported or incomplete response.');
    const parts=[];
    for(const block of data.content){
        if(block.type==='text' && typeof block.text==='string')parts.push({text:block.text});
        else if(block.type==='tool_use' && typeof block.id==='string' && typeof block.name==='string' && object(block.input)){
            parts.push({functionCall:{id:block.id,name:block.name,args:block.input}});
        }else if(['thinking','redacted_thinking'].includes(block.type))throw new SecurityError(502,'Claude returned unexpected reasoning content. Start a new request.');
        else throw new SecurityError(502,'Claude returned unsupported response content.');
    }
    if(!parts.length || (data.stop_reason==='tool_use')!==parts.some(part=>part.functionCall))throw new SecurityError(502,'Claude returned an incomplete tool response.');
    return {candidates:[{content:{role:'model',parts},finishReason:'STOP'}],modelVersion:data.model||PROVIDERS.claude.models[0],
        usageMetadata:{promptTokenCount:data.usage?.input_tokens||0,candidatesTokenCount:data.usage?.output_tokens||0}};
}
function validateOutput(data,format){
    if(!format)return;
    const parts=data.candidates?.[0]?.content?.parts||[];
    if(parts.some(part=>part.functionCall) || data.candidates?.[0]?.finishReason==='MAX_TOKENS')throw new SecurityError(502,'AI output was incomplete. No approval was accepted.');
    let parsed;try{parsed=JSON.parse(parts.map(part=>part.text||'').join('').replace(/^```(?:json)?\s*|\s*```$/gi,''));}catch{throw new SecurityError(502,'AI returned invalid JSON. No approval was accepted.');}
    const valid=object(parsed) && (format==='proof'?['approved','rejected'].includes(parsed.verdict) && Number.isFinite(parsed.confidence) && parsed.confidence>=0 && parsed.confidence<=1 && typeof parsed.critique==='string':
        format==='criteria'?Number.isInteger(parsed.score) && parsed.score>=1 && parsed.score<=10 && parsed.passed===(parsed.score>=7) && typeof parsed.critique==='string' && typeof parsed.suggested_rewrite==='string':
        Array.isArray(parsed.notes) && parsed.notes.every(note=>object(note) && ['string','number'].includes(typeof note.id) && typeof note.title==='string' && typeof note.clean_text==='string'));
    if(!valid)throw new SecurityError(502,'AI returned an invalid result. No approval was accepted.');
}
async function responseJSON(response,key){
    if(!response.body)throw new SecurityError(502,'AI returned an empty response.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,text='';
    try{
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024){await reader.cancel();throw new SecurityError(502,'AI response exceeded the supported size.');}text+=decoder.decode(value,{stream:true});}
        text+=decoder.decode();
    }finally{reader.releaseLock();}
    try{return JSON.parse(text.split(key).join('[redacted]'));}catch{throw new SecurityError(502,'AI returned an unreadable response.');}
}
export class AIGateway {
    constructor(service){this.service=service;this.inflight=new Map();}
    async generate(identity,body){
        const provider=providerId(body.provider),config=PROVIDERS[provider];
        if(!config.models.includes(body.model))throw new SecurityError(400,'This model is not enabled for the selected AI provider.');
        const payload=validatePayload(body.payload);
        await this.service.vault.assertOwner(this.service.storage,identity);
        if(await this.service.vault.selectedProvider(identity)!==provider)throw new SecurityError(409,'AI provider changed. Refresh AI status in Settings and start a new request.');
        const forward=provider==='claude'?toClaudeRequest(payload):{...payload};
        delete forward.taskitatorFormat;
        await this.service.rateBucket('ai-user:'+identity.userId,30);
        const count=this.inflight.get(identity.userId)||0;
        if(count>=2)throw new SecurityError(429,'Two AI requests are already running. Wait for one to finish.');
        this.inflight.set(identity.userId,count+1);
        try{
            const record=await this.service.storage.get(await this.service.vault.recordKey(identity,provider));
            if(body.key_version && body.key_version!==record?.version)throw new SecurityError(409,'The AI key changed. Refresh AI status and start a new conversation.');
            const key=await this.service.vault.unseal(identity,record,provider);
            const url=provider==='claude'?'https://api.anthropic.com/v1/messages':'https://generativelanguage.googleapis.com/v1beta/models/'+body.model+':generateContent';
            const headers=provider==='claude'?{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'}:{'Content-Type':'application/json','x-goog-api-key':key};
            let response;
            try{response=await fetch(url,{method:'POST',headers,body:JSON.stringify(forward),signal:AbortSignal.timeout(55000)});}
            catch{throw new SecurityError(504,config.name+' request timed out or could not connect. Retry carefully; provider usage may already have occurred.');}
            if(!response.ok){
                try{await response.body?.cancel();}catch{}
                const status=response.status===529?503:response.status;
                throw new SecurityError([400,401,403,404,413,429,500,502,503,504].includes(status)?status:502,
                    status===429?config.name+' quota or rate limit reached.':status===401||status===403?config.name+' rejected the saved key. Check its API access and restrictions.':
                    status>=500?config.name+' is temporarily unavailable.':config.name+' rejected this request. Check the model, file format and content.');
            }
            const raw=await responseJSON(response,key);
            if(provider==='gemini'){
                const reason=raw.candidates?.[0]?.finishReason;
                if(raw.promptFeedback?.blockReason || (reason && reason!=='STOP'))throw new SecurityError(502,'Gemini did not return a complete accepted answer. No partial approval or tool action was accepted.');
            }
            const data=provider==='claude'?fromClaudeResponse(raw):raw;
            validateOutput(data,payload.taskitatorFormat);
            await this.service.vault.assertOwner(this.service.storage,identity);
            const current=await this.service.storage.get(await this.service.vault.recordKey(identity,provider));
            if(current?.version!==record.version || await this.service.vault.selectedProvider(identity)!==provider)throw new SecurityError(409,'AI settings changed during the request. No result was applied.');
            return data;
        }finally{const remaining=(this.inflight.get(identity.userId)||1)-1;if(remaining)this.inflight.set(identity.userId,remaining);else this.inflight.delete(identity.userId);}
    }
}

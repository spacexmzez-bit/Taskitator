// ============================================================================
// Taskitator Consolidated Pro & Audit Suite (pro.js)
// Combines: safety, exemplar-store, break-core, vault-client, audit-engine,
// pro-client, pro-ui, and profile-ui.
// ============================================================================

// <<< MODULE_START: safety.js >>>
// Shared rendering and task-tree checks. Never interpret user labels as markup.
window.TaskitatorSafety = {
    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    },

    setProjectLabel(element, project) {
        const icon = document.createElement('span');
        const name = document.createElement('span');
        icon.textContent = project.icon || '';
        name.textContent = project.name || '';
        element.replaceChildren(icon, document.createTextNode(' '), name);
    },

    collectSubtree(tasks, rootId) {
        const ids = new Set();
        const pending = [rootId];
        while (pending.length) {
            const id = pending.pop();
            if (ids.has(id)) continue;
            ids.add(id);
            tasks.filter(task => task.parent_id === id).forEach(task => pending.push(task.id));
        }
        return tasks.filter(task => ids.has(task.id));
    },

    deletionError(tasks, rootId, bypassActive = false) {
        if (bypassActive) return null;
        const subtree = this.collectSubtree(tasks, rootId);
        if (subtree.some(task => task.ai_locked)) {
            return 'This task or one of its subtasks is AI-locked. An active Emergency Bypass is required to delete it.';
        }
        if (subtree.some(task => task.strict_prerequisites &&
            this.collectSubtree(tasks, task.id).some(child => child.id !== task.id &&
                child.status !== 'completed' && child.status !== 'trash'))) {
            return 'Shielded tasks with pending subtasks cannot be deleted without an active Emergency Bypass.';
        }
        return null;
    }
};

// <<< MODULE_END: safety.js >>>
// <<< MODULE_START: exemplar-store.js >>>
/* exemplar-store.js */
/**
 * Taskitator - Exemplar Reference Storage Engine
 * Manages client-side binary exemplar storage in IndexedDB.
 * Completely decoupled from localStorage and Cloudflare KV sync engine.
 */

(function (window) {
    'use strict';

    const DB_NAME = 'TaskitatorExemplarDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'exemplars';
    const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB ceiling

    let dbInstance = null;
    let dbInstanceName = null;
    const LEGACY_OWNER_KEY = 'taskitator_exemplar_legacy_owner';
    function currentUser() {
        try {
            return String(JSON.parse(localStorage.getItem('taskitator_settings') || '{}').worker_username || '').trim().toLowerCase();
        } catch (e) { return ''; }
    }
    // An unowned old database must never be assigned to the next person logging in.
    if (!localStorage.getItem(LEGACY_OWNER_KEY)) {
        localStorage.setItem(LEGACY_OWNER_KEY, currentUser() || '__unclaimed__');
    }

    /**
     * Initializes or retrieves the singleton IndexedDB connection.
     * @returns {Promise<IDBDatabase>}
     */
    function getDB() {
        const username = currentUser();
        if (!username) return Promise.reject(new Error('Sign in to access reference exemplars.'));
        const name = localStorage.getItem(LEGACY_OWNER_KEY) === username
            ? DB_NAME : `${DB_NAME}:${encodeURIComponent(username)}`;
        if (dbInstance && dbInstanceName === name) return Promise.resolve(dbInstance);
        if (dbInstance) dbInstance.close();

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(name, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'taskId' });
                }
            };

            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                dbInstanceName = name;
                resolve(dbInstance);
            };

            request.onerror = (event) => {
                console.error('[ExemplarStore] Database initialization error:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Converts a File or Blob into a base64 encoded string.
     * @param {Blob} blob 
     * @returns {Promise<string>} Pure base64 data without data-URL prefix.
     */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result;
                if (typeof result === 'string') {
                    const base64Data = result.split(',')[1] || '';
                    resolve(base64Data);
                } else {
                    reject(new Error('Failed to parse file to Base64 string.'));
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    const ExemplarStore = {
        MAX_FILE_SIZE_BYTES,
        async deleteAccountFiles(username) {
            const name = localStorage.getItem(LEGACY_OWNER_KEY) === username
                ? DB_NAME : `${DB_NAME}:${encodeURIComponent(username)}`;
            if (dbInstance && dbInstanceName === name) { dbInstance.close(); dbInstance = null; dbInstanceName = null; }
            return new Promise(resolve => {
                const request = indexedDB.deleteDatabase(name);
                const timer = setTimeout(() => resolve(false), 3000);
                request.onsuccess = () => { clearTimeout(timer); resolve(true); };
                request.onerror = request.onblocked = () => { clearTimeout(timer); resolve(false); };
            });
        },

        /**
         * Persists an exemplar document/image for an active task.
         * Enforces the hard 5 MB size limit before storage.
         * @param {string} taskId 
         * @param {Blob|File} file 
         * @returns {Promise<{success: boolean, message?: string}>}
         */
        async saveExemplar(taskId, file) {
            if (!taskId) throw new Error('Task ID is required to save an exemplar.');
            if (!file) throw new Error('No file provided for exemplar storage.');

            if (file.size > MAX_FILE_SIZE_BYTES) {
                throw new Error(`File exceeds maximum size of 5 MB (${(file.size / (1024 * 1024)).toFixed(2)} MB).`);
            }

            const db = await getDB();
            const record = {
                taskId: String(taskId),
                blob: file,
                mimeType: file.type || 'application/octet-stream',
                fileName: file.name || 'reference_exemplar',
                fileSize: file.size,
                savedAt: new Date().toISOString()
            };

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.put(record);

                request.onsuccess = () => resolve({ success: true });
                request.onerror = (event) => {
                    console.error('[ExemplarStore] Failed to save record:', event.target.error);
                    reject(event.target.error);
                };
            });
        },

        /**
         * Fast boolean check to confirm if an exemplar exists for a given task ID.
         * @param {string} taskId 
         * @returns {Promise<boolean>}
         */
        async hasExemplar(taskId) {
            if (!taskId) return false;
            const db = await getDB();

            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.count(IDBKeyRange.only(String(taskId)));

                request.onsuccess = () => resolve(request.result > 0);
                request.onerror = () => resolve(false);
            });
        },

        /**
         * Retrieves an exemplar and formats it as an inline Gemini multimodal payload.
         * @param {string} taskId 
         * @returns {Promise<{taskId: string, mimeType: string, fileName: string, inlineData: {mimeType: string, data: string}}|null>}
         */
        async getExemplar(taskId) {
            if (!taskId) return null;
            const db = await getDB();

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(String(taskId));

                request.onsuccess = async () => {
                    const record = request.result;
                    if (!record || !record.blob) {
                        resolve(null);
                        return;
                    }

                    try {
                        const base64Data = await blobToBase64(record.blob);
                        resolve({
                            taskId: record.taskId,
                            mimeType: record.mimeType,
                            fileName: record.fileName,
                            fileSize: record.fileSize,
                            inline_data: {
                                mime_type: record.mimeType,
                                data: base64Data
                            }
                        });
                    } catch (err) {
                        console.error('[ExemplarStore] Base64 encoding error:', err);
                        reject(err);
                    }
                };

                request.onerror = (event) => {
                    console.error('[ExemplarStore] Failed to retrieve record:', event.target.error);
                    reject(event.target.error);
                };
            });
        },

        /**
         * Immediately and permanently deletes an exemplar record.
         * Invoked immediately when a task is completed, deleted, or wiped.
         * @param {string} taskId 
         * @returns {Promise<boolean>}
         */
        async deleteExemplar(taskId) {
            if (!taskId) return false;
            const db = await getDB();

            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.delete(String(taskId));

                request.onsuccess = () => resolve(true);
                request.onerror = (event) => {
                    console.warn('[ExemplarStore] Failed to delete exemplar:', event.target.error);
                    resolve(false);
                };
            });
        },

        /**
         * Clears all exemplar files from IndexedDB.
         * Invoked during factory reset or full storage cleanup.
         * @returns {Promise<boolean>}
         */
        async clearAll() {
            const db = await getDB();
            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.clear();

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            });
        }
    };

    window.ExemplarStore = ExemplarStore;

})(window);

// <<< MODULE_END: exemplar-store.js >>>
// <<< MODULE_START: pro/break-core.js >>>
// Shared browser/Worker break dates, intervals and retention. No browser globals required.
(function(root){
    const DAY=86400000,WINDOW=600000,RETENTION=90,formats=new Map(),zones=new Map();
    const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
    const addDate=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
    function timezone(z){if(typeof z!=='string'||!z)return 'Asia/Riyadh';if(zones.has(z))return zones.get(z);let valid;try{new Intl.DateTimeFormat('en',{timeZone:z}).format(0);valid=z;}catch{valid='Asia/Riyadh';}if(zones.size>32)zones.clear();zones.set(z,valid);return valid;}
    function parts(ms,z){
        z=timezone(z);if(!formats.has(z)){if(formats.size>32)formats.clear();formats.set(z,new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));}
        const p=Object.fromEntries(formats.get(z).formatToParts(ms).map(p=>[p.type,p.value]));return {date:p.year+'-'+p.month+'-'+p.day,h:+p.hour,m:+p.minute,s:+p.second};
    }
    function time(s){const m=/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s||'');if(!m||+m[1]>23||+m[2]>59||+(m[3]||0)>59)return NaN;return +m[1]*3600 + +m[2]*60 + +(m[3]||0);}
    function wall(date,seconds,z){
        const target=Date.parse(date+'T00:00:00Z')+seconds*1000;let value=target;
        for(let i=0;i<5;i++){const p=parts(value,z),actual=Date.parse(p.date+'T00:00:00Z')+(p.h*3600+p.m*60+p.s)*1000;const delta=target-actual;if(!delta)return value;value+=delta;}
        throw Error('This clock time does not exist in the selected timezone. Choose another time.');
    }
    function dayBounds(date,hour,z){
        z=timezone(z);hour=Math.max(0,Math.min(4,Math.trunc(Number(hour)||0)));
        const boundary=d=>{for(let i=0;i<4;i++)try{return wall(d,(hour+i)*3600,z);}catch{}throw Error('Unable to resolve the day boundary in this timezone.');};
        const start=boundary(date),end=boundary(addDate(date,1));
        return {dateStr:date,start:new Date(start),end:new Date(end),cutoff6h:new Date(end-6*3600000),dayStartHour:hour,timezone:z};
    }
    function bounds(settings={},now=Date.now(),z=settings.break_timezone||'Asia/Riyadh'){
        z=timezone(z);const hour=Math.max(0,Math.min(4,Math.trunc(Number(settings.day_start_hour)||0))),p=parts(now,z),date=p.h<hour?addDate(p.date,-1):p.date;
        return dayBounds(date,hour,z);
    }
    function interval(b,bounds){
        if(!b||!bounds)return {startTime:NaN,endTime:NaN};
        if(/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(b.start||'')&&/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(b.end||''))return {startTime:Date.parse(b.start),endTime:Date.parse(b.end)};
        if(b.start_at&&b.end_at){const startTime=Date.parse(b.start_at),endTime=Date.parse(b.end_at);return {startTime,endTime};}
        const start=time(b.start),end=time(b.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start===end)return {startTime:NaN,endTime:NaN};
        const date=bounds.dateStr,z=bounds.timezone||'Asia/Riyadh',hour=bounds.dayStartHour??bounds.start.getHours();
        let startDate=start<hour*3600?addDate(date,1):date,endDate=end<hour*3600?addDate(date,1):date;
        const startTime=wall(startDate,start,z);let endTime=wall(endDate,end,z);
        if(endTime<=startTime)endTime=wall(addDate(endDate,1),end,z);
        return {startTime,endTime};
    }
    function validate(list,bounds){
        if(!Array.isArray(list)||!list.length||list.length>3)return {valid:false,error:'Enter between 1 and 3 complete break times before locking the schedule.'};
        const result=[];let total=0;
        try{for(const b of list){
            if((!Number.isFinite(time(b?.start))||!Number.isFinite(time(b?.end)))&&!(Number.isFinite(Date.parse(b?.start))&&Number.isFinite(Date.parse(b?.end))&&String(b.start).includes('T')&&String(b.end).includes('T')))throw Error('Complete both start and end times for every break.');
            // Rebuild absolute times from the entered clocks; caller timestamps cannot change validation.
            const {startTime,endTime}=interval({start:b.start,end:b.end},bounds),duration=(endTime-startTime)/60000;
            if(!Number.isFinite(duration)||duration<=0)throw Error('Break end time must be after its start.');
            if(startTime<+bounds.start||startTime>=+bounds.end||endTime>+bounds.end+3*3600000)throw Error('Breaks must start in this day cycle and end within 3 hours of its boundary.');
            const clock=value=>{const p=parts(value,bounds.timezone);return String(p.h).padStart(2,'0')+':'+String(p.m).padStart(2,'0')+(p.s?':'+String(p.s).padStart(2,'0'):'');};
            total+=duration;result.push({start:String(b.start).includes('T')?clock(startTime):b.start,end:String(b.end).includes('T')?clock(endTime):b.end,start_at:new Date(startTime).toISOString(),end_at:new Date(endTime).toISOString()});
        }
        if(total>180)throw Error('Total break time exceeds the 3-hour daily limit.');
        const sorted=[...result].sort((a,b)=>Date.parse(a.start_at)-Date.parse(b.start_at));
        if(sorted.some((b,i)=>i&&Date.parse(sorted[i-1].end_at)>Date.parse(b.start_at)))throw Error('Breaks cannot overlap.');
        return {valid:true,breaks:result,totalMinutes:total};
        }catch(error){return {valid:false,error:error.message};}
    }
    function normalize(raw,date,now=Date.now()){
        const today=new Date(now).toISOString().slice(0,10),out={};
        if(Array.isArray(raw))raw={[date||today]:{breaks:raw,locked:true}};
        if(!raw||typeof raw!=='object')return out;
        for(const [key,value]of Object.entries(raw))if(validDate(key)&&key>=addDate(today,-RETENTION)&&key<=addDate(today,2)){
            const v=Array.isArray(value)?{breaks:value,locked:true}:value;
            if(v&&typeof v==='object')out[key]={...v,date:key,breaks:Array.isArray(v.breaks)?v.breaks:[]};
        }
        return out;
    }
    function migrate(raw,settings={},zone='Asia/Riyadh',now=Date.now()){
        const out=normalize(raw,bounds(settings,now,zone).dateStr,now);
        for(const [date,record]of Object.entries(out)){
            if(record.timezone&&Number.isFinite(record.cycle_start)&&Number.isFinite(record.cycle_end)&&record.breaks.every(b=>b.start_at&&b.end_at))continue;
            const b=dayBounds(date,record.day_start_hour??settings.day_start_hour,record.timezone||zone);
            const result=validate(record.breaks,b);
            out[date]={...record,timezone:b.timezone,day_start_hour:b.dayStartHour,cycle_start:+b.start,cycle_end:+b.end,
                breaks:result.valid?result.breaks:record.breaks};
        }
        return out;
    }
    function activeBreak(raw,settings={},now=Date.now()){
        const utc=new Date(now).toISOString().slice(0,10);
        const source=Array.isArray(raw)?{[bounds(settings,now).dateStr]:{breaks:raw}}:raw||{};
        for(let i=-2;i<=1;i++){
            const date=addDate(utc,i),record=source[date],items=Array.isArray(record)?record:record?.breaks;
            if(!Array.isArray(items))continue;
            if(record.window_started_at&&!record.locked&&now-record.window_started_at<WINDOW)continue;
            const zone=record.timezone||settings.break_timezone||'Asia/Riyadh',hour=record.day_start_hour??settings.day_start_hour??0;
            const b={dateStr:date,dayStartHour:hour,timezone:zone};
            for(const item of items){try{const t=interval(item,b);if(now>=t.startTime&&now<t.endTime)return {break:item,...t,timezone:zone,date};}catch{}}
        }
        return null;
    }
    function active(raw,settings={},now=Date.now()){return !!activeBreak(raw,settings,now);}
    function merge(previous,incoming,settings={},now=Date.now()){
        const logical=bounds(settings,now).dateStr,out=normalize(previous,logical,now),next=normalize(incoming,logical,now);
        for(const [date,record]of Object.entries(next)){
            const old=out[date];if(old?.locked&&old.breaks.length){continue;}
            const zone=old?.timezone||record.timezone||settings.break_timezone||'Asia/Riyadh';
            const hour=old?.day_start_hour??record.day_start_hour??settings.day_start_hour??0;
            const b=dayBounds(date,hour,zone),start=+b.start,end=+b.end;
            const started=[old?.window_started_at,record.window_started_at].filter(n=>Number.isFinite(n)&&n>0);
            const window_started_at=started.length?Math.min(now,...started):null;
            const expired=window_started_at&&now-window_started_at>=WINDOW;
            const valid=validate(record.breaks,b),oldValid=validate(old?.breaks,b);
            if(record.breaks.length&&!valid.valid)throw Error(valid.error);
            const chosen=expired&&oldValid.valid?old.breaks:valid.valid?valid.breaks:old?.breaks||[];
            out[date]={...record,date,timezone:b.timezone,day_start_hour:b.dayStartHour,cycle_start:start,cycle_end:end,window_started_at,
                breaks:chosen,locked:chosen.length>0&&!!(record.locked||expired||old?.locked),repair_required:!!expired&&!chosen.length};
        }
        return out;
    }
    root.TaskitatorBreaks={DAY,WINDOW,RETENTION,parts,timezone,time,bounds,dayBounds,interval,validate,normalize,migrate,activeBreak,active,merge};
})(globalThis);

// <<< MODULE_END: pro/break-core.js >>>
// <<< MODULE_START: vault-client.js >>>
(function () {
    'use strict';
    const auth = () => window.TaskitatorAuth;
    const byId = id => document.getElementById(id);
    const pendingKey = 'taskitator_key_verification';
    const models={gemini:['gemini-3.5-flash-lite','gemini-3.1-flash-lite'],claude:['claude-haiku-5-5']};
    const names={gemini:'Gemini',claude:'Claude'};
    let metadata = {ready:false,saved:false,pending:[]}, owner = null, revealed = '', revealTimer;
    let providers={gemini:metadata,claude:{ready:false,saved:false,pending:[]}},activeProvider='gemini',viewedProvider='gemini',inflight=0;
    let operation = null, proofId = null, verified = false, busy = false;
    const api = (path,body,method='POST',extra={}) => auth().api(path,{method,...extra,...(body?{body:JSON.stringify(body)}:{})});
    function status(message, isTest = null) {
        const el=byId('vaultFeedback');
        if(!el)return;
        if(isTest === true || isTest === false) {
            el.className = 'vault-test-popup ' + (isTest ? 'success' : 'error');
            const safeText = String(message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            el.innerHTML = `<span style="font-size:1.15rem;line-height:1;margin-right:6px;">${isTest ? '✓' : '✕'}</span><span>${safeText}</span>`;
            el.style.display = 'flex';
        } else {
            el.className = '';
            el.style.display = 'block';
            el.textContent = message;
        }
    }
    function acceptMetadata(data,follow=false){
        const previous=activeProvider+':'+(providers[activeProvider]?.version||'empty');
        if(data.providers)providers=data.providers;
        else providers[data.provider||'gemini']=data;
        if(Object.hasOwn(models,data.selected_provider))activeProvider=data.selected_provider;
        if(follow)viewedProvider=activeProvider;
        metadata=providers[viewedProvider]||{ready:false,saved:false,pending:[]};
        const changed=previous!==activeProvider+':'+(providers[activeProvider]?.version||'empty');
        if(changed){
            clearReveal();sessionStorage.removeItem('gemini_fallback_active');
            window.dispatchEvent?.(new CustomEvent('taskitator-ai-provider-changed',{detail:{provider:activeProvider}}));
        }
        render();return data;
    }
    function clearReveal() {
        revealed='';clearTimeout(revealTimer);
        const field=byId('vaultRevealedKey');if(field)field.value='';
        const area=byId('vaultRevealArea');if(area)area.hidden=true;
    }
    function legacyEntries(user) {
        const entries=[];
        const parseSettings=snapshot=>JSON.parse(snapshot.taskitator_settings||'{}');
        const current=JSON.parse(localStorage.getItem('taskitator_settings')||'{}');
        const localOwner=localStorage.getItem('taskitator_local_owner') || localStorage.getItem('taskitator_legacy_local_owner') || current.worker_username;
        if(localOwner===user)entries.push({key:'taskitator_settings',settings:[current],value:current,direct:true});
        for(const key of Object.keys(localStorage)){
            try{
                if(key==='taskitator_account_cache_v2:'+encodeURIComponent(user)){
                    const value=JSON.parse(localStorage.getItem(key));entries.push({key,value,settings:[parseSettings(value)]});
                }else if(key==='taskitator_account_recovery_v1:'+encodeURIComponent(user)){
                    const value=JSON.parse(localStorage.getItem(key));
                    if(!Array.isArray(value))throw new Error();
                    entries.push({key,value,settings:value.map(parseSettings),array:true});
                }else if(key==='taskitator_unclaimed_backup'){
                    const value=JSON.parse(localStorage.getItem(key)),settings=parseSettings(value);
                    if(settings.worker_username===user)entries.push({key,value,settings:[settings]});
                }
            }catch{auth().storageWarnings.push('An unreadable browser backup remains on this device. Review it before clearing browser data.');}
        }
        return entries;
    }
    function render() {
        for(const chip of document.querySelectorAll?.('.copilot-model-chip')||[])chip.textContent=models[activeProvider][0];
        if(!byId('vaultStatus'))return;
        byId('vaultStatus').textContent=!metadata.ready?'Secure storage needs administrator setup.':metadata.saved?
            names[viewedProvider]+' key saved securely · ends in '+metadata.suffix:'No saved '+names[viewedProvider]+' key.';
        if(byId('aiProviderSelect')){byId('aiProviderSelect').value=viewedProvider;byId('aiProviderSelect').disabled=busy;}
        if(byId('aiActiveProvider'))byId('aiActiveProvider').textContent='Currently used for AI: '+names[activeProvider];
        if(byId('vaultUseProviderBtn')){
            byId('vaultUseProviderBtn').disabled=busy || !metadata.ready || !metadata.saved || viewedProvider===activeProvider;
            byId('vaultUseProviderBtn').textContent=viewedProvider===activeProvider?names[viewedProvider]+' is active':'Use '+names[viewedProvider]+' for AI';
        }
        if(byId('vaultModelInfo'))byId('vaultModelInfo').textContent=viewedProvider==='claude'?
            'Claude Haiku 5.5 (claude-haiku-5-5). No automatic switch to Gemini. Claude accepts JPG, PNG, WebP and PDF here; convert HEIC photos or use Gemini.':
            'Gemini 3.5 Flash-Lite (gemini-3.5-flash-lite), with Gemini 3.1 Flash-Lite (gemini-3.1-flash-lite) fallback under the existing quota/unavailable rules. No automatic switch to Claude.';
        byId('vaultRecovered').replaceChildren();
        for(const item of metadata.pending||[]){
            const row=document.createElement('div');row.className='vault-recovery-row';
            const label=document.createElement('span');label.textContent='Recovered key · …'+item.suffix;row.append(label);
            for(const [label,kind]of [['Use this key','save'],['Show','reveal'],['Remove','delete']]){
                const button=document.createElement('button');button.type='button';button.className='icon-btn';button.textContent=label;
                button.addEventListener('click',()=>open(kind,item.id));row.append(button);
            }
            byId('vaultRecovered').append(row);
        }
        if(metadata.archive_pending){
            const message=document.createElement('p');message.textContent='Additional encrypted Claude archives remain. Review/remove recovered copies and refresh; if they do not appear, ask the operator to check retained vault key versions.';
            byId('vaultRecovered').append(message);
        }
        for(const [id,needsSaved]of [['vaultSaveBtn',false],['vaultShowBtn',true],['vaultCopyBtn',true],['vaultDeleteBtn',true],['vaultTestBtn',true]]){
            byId(id).disabled=busy || !metadata.ready || (needsSaved && !metadata.saved);
        }
    }
    const vault = {
        get provider(){return activeProvider;},
        get available(){return owner===auth()?.account?.user && Boolean(providers[activeProvider]?.ready && providers[activeProvider]?.saved);},
        selection(){return {provider:activeProvider,primary:models[activeProvider][0],fallback:models[activeProvider][1]||null,keyVersion:providers[activeProvider]?.version};},
        async refresh(follow=false){
            const user=auth().account?.user,session=window.Clerk.session?.id;
            const data=await api('/ai/keys',null,'GET');
            if(user!==auth().account?.user || session!==window.Clerk.session?.id)throw new Error('Account changed. Reload before accessing AI settings.');
            return acceptMetadata(data,follow);
        },
        async initialize(){
            const user=auth().account?.user;if(!user)return;
            const sessionId=window.Clerk.session.id;
            owner=user;activeProvider='gemini';viewedProvider='gemini';await this.refresh(true);
            const entries=legacyEntries(user),keys=[],claudeKeys=[];
            for(const entry of entries)for(const settings of entry.settings){
                if(typeof settings.gemini_api_key==='string' && settings.gemini_api_key.trim())keys.push(settings.gemini_api_key);
                if(typeof settings.claude_api_key==='string' && settings.claude_api_key.trim())claudeKeys.push(settings.claude_api_key);
            }
            if(keys.length||claudeKeys.length){
                // A browser key is recovered, never silently made active. Only a
                // one-use verified save can select it as the current provider key.
                acceptMetadata(await api('/ai/keys/stage',{keys:[...new Set(keys)],claude_keys:[...new Set(claudeKeys)]}));
                if(auth().account?.user!==user || window.Clerk.session?.id!==sessionId)throw new Error('Account changed during key migration. Reload to continue.');
            }
            for(const entry of entries){
                if(!entry.settings.some(settings=>'gemini_api_key' in settings || 'claude_api_key' in settings))continue;
                const clean=entry.settings.map(settings=>auth().cleanSettings(settings));
                if(entry.direct)localStorage.setItem(entry.key,JSON.stringify(clean[0]));
                else{
                    (entry.array?entry.value:[entry.value]).forEach((snapshot,i)=>snapshot.taskitator_settings=JSON.stringify(clean[i]));
                    localStorage.setItem(entry.key,JSON.stringify(entry.value));
                }
            }
            render();
        },
        async generate(model,payload,selection=this.selection()){
            // Return a Response to preserve the existing audit/fallback behavior.
            inflight++;
            try{return Response.json(await api('/ai/generate',{model,payload,provider:selection.provider,key_version:selection.keyVersion},'POST',{timeoutMs:70000}));}
            catch(error){return Response.json({error:{message:error.message}},{status:error.status||503});}
            finally{inflight--;}
        },
        clear:clearReveal
    };
    function updateDialog(){
        byId('vaultPasswordBtn').disabled=busy || window.Clerk.user?.passwordEnabled===false;
        byId('vaultGoogleBtn').disabled=busy;
        byId('vaultConfirmBtn').disabled=busy || !verified;
        byId('vaultCancelBtn').disabled=busy;
        byId('vaultNewKey').disabled=busy;
        byId('vaultNewKeyArea').hidden=operation?.kind!=='save' || Boolean(operation?.stageId);
    }
    function dialogMessage(message){
        const el=byId('vaultDialogFeedback');
        if(!el)return;
        el.textContent=message;
        const isErr=/needs one-time setup|misconfigured|Connect your Google|expired|failed|error|invalid/i.test(message);
        const isOk=/confirmed/i.test(message);
        el.style.cssText=isErr?'padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.16);border:1px solid #ef4444;color:#fca5a5;font-weight:600;margin:10px 0;':
                         isOk?'padding:10px 12px;border-radius:8px;background:rgba(16,185,129,0.16);border:1px solid #10b981;color:#34d399;font-weight:600;margin:10px 0;':
                         'padding:8px 0;color:#cbd5e1;';
    }
    function open(kind,stageId=null){
        if(busy)return;
        // Google returns to a fresh Settings load with Tags & Prio selected.
        // Show the Account tab so the revealed key and clipboard fallback appear.
        document.querySelector('.tab-btn[data-tab="tab-account"]')?.click();
        clearReveal();operation={kind,stageId,provider:viewedProvider};proofId=null;verified=false;
        byId('vaultPassword').value='';byId('vaultNewKey').value='';
        byId('vaultDialogTitle').textContent=({save:stageId?'Activate recovered key':'Save / replace '+names[viewedProvider]+' key',delete:stageId?'Remove recovered key':'Delete saved '+names[viewedProvider]+' key',reveal:'Show saved '+names[viewedProvider]+' key',copy:'Copy saved '+names[viewedProvider]+' key'})[kind];
        if(byId('vaultNewKeyLabel'))byId('vaultNewKeyLabel').textContent='New '+names[viewedProvider]+' API key';
        dialogMessage('Confirm with your password or the Google account linked to this login. Each confirmation authorizes this action once.');
        byId('vaultConfirmBtn').textContent=kind==='delete'?'Delete key':kind==='save'?'Save key':'Continue';
        byId('vaultDialog').showModal();updateDialog();
    }
    function action(){return 'api-key-'+(['copy','reveal'].includes(operation.kind)?'reveal':operation.kind);}
    async function start(method){
        const result=await api('/auth/verification/start',{method,action:action(),stage_id:operation.stageId,provider:operation.provider});
        proofId=result.verification_id;return result;
    }
    async function password(){
        if(busy)return;busy=true;verified=false;updateDialog();
        try{
            const input=byId('vaultPassword');if(!input.value)throw new Error('Enter your current sign-in password.');
            dialogMessage('Confirming your password…');await start('password');
            await window.Clerk.session.startVerification({level:'first_factor'});
            const result=await window.Clerk.session.attemptFirstFactorVerification({strategy:'password',password:input.value});
            if(result.status!=='complete')throw new Error('Password confirmation did not complete.');
            await api('/auth/verification/password',{verification_id:proofId,action:action()},'POST',{freshToken:true});
            verified=true;dialogMessage('Identity confirmed. Continue within five minutes.');
        }catch(error){dialogMessage(error.message);}
        finally{byId('vaultPassword').value='';busy=false;updateDialog();}
    }
    function googleAuthorizationUrl(value) {
        let url;
        try {
            if (typeof value !== 'string' || !value.trim()) throw new Error();
            url = new URL(value);
            if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
                url.username || url.password || url.hash) throw new Error();
        } catch {
            throw new Error('Google confirmation URL is missing or invalid. Check the Worker Google OAuth settings in pro/verification-setup.html, then retry or cancel.');
        }
        return url.href;
    }
    async function google(){
        if(busy)return;busy=true;verified=false;updateDialog();
        try{
            const result=await start('google');
            const authorizationUrl = googleAuthorizationUrl(result.authorization_url);
            // Only action metadata survives navigation; no API key or password.
            sessionStorage.setItem(pendingKey,JSON.stringify({...operation,proofId,user:auth().account.user,session:window.Clerk.session.id}));
            byId('vaultNewKey').value='';byId('vaultPassword').value='';
            location.assign(authorizationUrl);
        }catch(error){dialogMessage(error.message);busy=false;updateDialog();}
    }
    async function confirm(){
        if(busy||!verified)return;busy=true;updateDialog();
        try{
            const body={verification_id:proofId,stage_id:operation.stageId,provider:operation.provider};
            if(operation.kind==='save'){
                if(!operation.stageId)body.key=byId('vaultNewKey').value;
                const result=await api('/ai/keys',body);acceptMetadata(result);status(result.test.message+' Press Use '+names[viewedProvider]+' for AI if you want to activate this provider.');
            }else if(operation.kind==='delete'){
                acceptMetadata(await api('/ai/keys',body,'DELETE'));status('Key removed. Revoke it separately at '+(operation.provider==='claude'?'Claude Console.':'Google AI Studio.'));
            }else{
                const result=await api('/ai/keys/reveal',body);revealed=result.key;
                byId('vaultRevealedKey').value=revealed;byId('vaultRevealArea').hidden=false;
                revealTimer=setTimeout(clearReveal,Math.min(result.reveal_seconds||30,30)*1000);
                status('Key shown for 30 seconds. Copies placed on your clipboard may remain there.');
                if(operation.kind==='copy'){
                    try{await navigator.clipboard.writeText(revealed);status('Key copied. Your clipboard may retain it after the display clears.');}
                    catch{status('Key ready. Press Copy displayed key while it is visible.');}
                }
            }
            byId('vaultDialog').close();verified=false;sessionStorage.removeItem(pendingKey);render();
        }catch(error){
            if(error.status===403)verified=false;
            dialogMessage(error.message+' If the request timed out, refresh key status before trying again.');
        }finally{byId('vaultNewKey').value='';byId('vaultPassword').value='';busy=false;updateDialog();render();}
    }
    window.TaskitatorVault=vault;
    window.addEventListener('pagehide',()=>{clearReveal();for(const id of ['vaultPassword','vaultNewKey']){const el=byId(id);if(el)el.value='';}});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearReveal();const input=byId('vaultPassword');if(input)input.value='';}});
    window.addEventListener('taskitator-auth-ready',async()=>{
        if(!byId('vaultDialog'))return;
        render();
        byId('aiProviderSelect')?.addEventListener('change',event=>{
            if(!Object.hasOwn(models,event.target.value))return;
            clearReveal();viewedProvider=event.target.value;metadata=providers[viewedProvider]||{ready:false,saved:false,pending:[]};render();
            status('Showing '+names[viewedProvider]+' keys. Save/test a key, then use the activation button to change the AI provider. Your other key stays saved.');
        });
        byId('vaultModelInfoBtn')?.addEventListener('click',()=>{
            const info=byId('vaultModelInfo');info.hidden=!info.hidden;byId('vaultModelInfoBtn').setAttribute('aria-expanded',String(!info.hidden));
        });
        byId('vaultUseProviderBtn')?.addEventListener('click',async()=>{
            if(busy)return;busy=true;render();clearReveal();
            try{if(inflight)throw new Error('Wait for the current AI request to finish before switching providers.');
                acceptMetadata(await api('/ai/provider',{provider:viewedProvider}));status(names[activeProvider]+' is now used for AI. Your other provider key stays saved.');
            }catch(error){status(error.message);}finally{busy=false;render();}
        });
        for(const [id,kind]of [['vaultSaveBtn','save'],['vaultShowBtn','reveal'],['vaultCopyBtn','copy'],['vaultDeleteBtn','delete']])byId(id).addEventListener('click',()=>open(kind));
        byId('vaultPasswordBtn').addEventListener('click',password);byId('vaultGoogleBtn').addEventListener('click',google);
        byId('vaultConfirmBtn').addEventListener('click',confirm);
        byId('vaultCancelBtn').addEventListener('click',()=>{if(!busy)byId('vaultDialog').close();});
        byId('vaultDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
        byId('vaultDialog').addEventListener('close',()=>{verified=false;proofId=null;byId('vaultNewKey').value='';byId('vaultPassword').value='';});
        byId('vaultHideBtn').addEventListener('click',clearReveal);
        byId('vaultCopyDisplayedBtn').addEventListener('click',async()=>{
            if(!revealed)return;try{await navigator.clipboard.writeText(revealed);status('Key copied. Your clipboard may retain it.');}catch{status('Clipboard access was denied. Select the displayed key and copy it manually.');}
        });
        byId('vaultRefreshBtn').addEventListener('click',async()=>{if(busy)return;busy=true;render();clearReveal();try{await vault.refresh();status('Key status refreshed.');}catch(error){status(error.message);}finally{busy=false;render();}});
        byId('vaultTestBtn').addEventListener('click',async()=>{
            if(busy)return;busy=true;render();
            try{
                const res = await api('/ai/keys/test',{provider:viewedProvider});
                status(names[viewedProvider]+': '+(res.message || 'Key connected and verified successfully!'), true);
            }catch(error){
                status(error.message || 'Connection test failed.', false);
            }finally{
                busy=false;render();
            }
        });
        const match=/^#key-verification=([a-f0-9]{64})$/.exec(location.hash);
        if(match){
            history.replaceState(null,'',location.pathname+location.search);
            try{
                const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');sessionStorage.removeItem(pendingKey);
                if(pending?.proofId!==match[1] || pending.user!==auth().account.user || pending.session!==window.Clerk.session.id || !['save','delete','reveal','copy'].includes(pending.kind))throw new Error('Google confirmation does not belong to this session. Start again.');
                const provider=pending.provider||'gemini';if(!Object.hasOwn(models,provider))throw new Error('Invalid provider confirmation. Start again.');
                viewedProvider=provider;metadata=providers[provider]||{ready:false,saved:false,pending:[]};render();
                open(pending.kind,pending.stageId);proofId=match[1];
                const result=await api('/auth/verification/status',{verification_id:proofId,action:action()});
                verified=result.verified && (!result.context || result.context.provider===provider);
                dialogMessage(verified?'Google identity confirmed. Continue within five minutes. For a new key, enter it now.':'Google confirmation was cancelled or failed. Use the linked Google account and try again.');
                updateDialog();
            }catch(error){status(error.message);}
        }
    });
    window.addEventListener('taskitator-synced',()=>{
        if(!busy && owner && owner===auth().account?.user)vault.refresh().catch(error=>status(error.message));
    });
})();

// <<< MODULE_END: vault-client.js >>>
// <<< MODULE_START: audit-engine.js >>>
// File: audit-engine.js
/**
 * audit-engine.js
 * Taskitator Core Engine
 * Manages BYOK Gemini Verification Cascade, Multimodal Pre-Flight Criteria Validation,
 * Emergency Bypass Tokens, and Break Limits
 */

const TaskitatorEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_EMERGENCY: 'taskitator_emergency_state',
    STORAGE_KEY_BREAKS: 'taskitator_daily_breaks',

    PRIMARY_MODEL: 'gemini-3.5-flash-lite',
    FALLBACK_MODEL: 'gemini-3.1-flash-lite',

    // Enforced upload limit across files (Photos, Gallery, PDFs)
    MAX_FILE_SIZE_MB: 5,

    // In-memory cache for pre-flight criteria validations to prevent duplicate API hits
    _criteriaValidationCache: new Map(),

    // =========================================================================
    // 1. Break Engine (10m Floating Window, Day-Start Offset, 6h Cutoff Buffer)
    // =========================================================================
    BreakEngine: {
        PLANNING_WINDOW_MS:600000,
        core(){if(!globalThis.TaskitatorBreaks)throw new Error('Refresh Taskitator to load break scheduling.');return globalThis.TaskitatorBreaks;},
        settings(){try{return JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS)||'{}');}catch{return {}; }},
        getDayStartHour(){return Math.max(0,Math.min(4,Number(this.settings().day_start_hour)||0));},
        getLogicalDayBounds(dayStartHour=null){
            const settings=this.settings();if(dayStartHour!==null)settings.day_start_hour=dayStartHour;
            const raw=this.getAllBreakData(),now=Date.now();
            const pinned=Object.values(raw).find(r=>r.cycle_start<=now&&now<r.cycle_end);
            return this.core().bounds({...settings,day_start_hour:pinned?.day_start_hour??settings.day_start_hour},now,pinned?.timezone||settings.break_timezone||Intl.DateTimeFormat().resolvedOptions().timeZone);
        },
        getAllBreakData(){try{
            const key=TaskitatorEngine.STORAGE_KEY_BREAKS,raw=localStorage.getItem(key)||'{}',settings=this.settings();
            const data=this.core().migrate(JSON.parse(raw),settings,settings.break_timezone||Intl.DateTimeFormat().resolvedOptions().timeZone);
            const normalized=JSON.stringify(data);
            if(raw!==normalized){localStorage.setItem(key,normalized);if(window.SyncEngine?.isConfigured?.())window.SyncEngine.markLocalModified();}
            return data;
        }catch{return {}; }},
        getBreakRecord(date){return {date,window_started_at:null,locked:false,breaks:[],...this.getAllBreakData()[date]};},
        saveBreakRecord(date,record){
            const data=this.getAllBreakData(),settings=this.settings(),b=this.getLogicalDayBounds();
            const previous=data[date];
            data[date]={...record,date,timezone:record.timezone||b.timezone,day_start_hour:b.dayStartHour,cycle_start:+b.start,cycle_end:+b.end};
            const value=JSON.stringify(this.core().normalize(data));
            if(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_BREAKS)!==value){
                localStorage.setItem(TaskitatorEngine.STORAGE_KEY_BREAKS,value);
                if(window.SyncEngine?.isConfigured?.())window.SyncEngine.markLocalModified();
                window.dispatchEvent?.(new CustomEvent('taskitator-breaks-changed'));
                if(window.SyncEngine?.isConfigured?.() && (previous?.window_started_at!==record.window_started_at||previous?.locked!==record.locked))
                    Promise.resolve().then(()=>window.SyncEngine.push()).catch(()=>{});
            }
        },
        getPlanningStatus(){
            const bounds=this.getLogicalDayBounds(),record=this.getBreakRecord(bounds.dateStr),now=Date.now();
            const expired=record.window_started_at&&now-record.window_started_at>=this.PLANNING_WINDOW_MS;
            const valid=this.core().validate(record.breaks,bounds);
            if((expired||record.locked)&&!valid.valid){
                if(!record.repair_required||record.locked){record.repair_required=true;record.locked=false;this.saveBreakRecord(bounds.dateStr,record);}
            }else if(expired&&!record.locked){record.locked=true;this.saveBreakRecord(bounds.dateStr,record);}
            const repair=!!record.repair_required&&!valid.valid;
            const running=!!record.window_started_at&&!expired&&!record.locked;
            const buffer=now>=+bounds.cutoff6h;
            return {bounds,record,isRepair:repair,isRunning:running,isLocked:record.locked,isInBuffer:buffer&&!repair,
                canStart:!record.window_started_at&&!record.locked&&!buffer&&!repair,canEdit:running||repair,
                remainingWindowMs:running?Math.max(0,this.PLANNING_WINDOW_MS-(now-record.window_started_at)):0,
                reason:repair?'The planning window ended without a valid schedule. Enter valid breaks once to repair and lock it.':
                    record.locked?'The break schedule is locked until the next day cycle.':buffer?'Planning is closed during the final 6 hours of this cycle.':''};
        },
        startPlanningWindow(){const s=this.getPlanningStatus();if(!s.canStart)return {success:false,error:s.reason};
            s.record.window_started_at=Date.now();s.record.locked=false;this.saveBreakRecord(s.bounds.dateStr,s.record);return {success:true,record:s.record};},
        lockTodayBreaks(){const s=this.getPlanningStatus();const result=this.core().validate(s.record.breaks,s.bounds);if(!result.valid)return {success:false,error:result.error};s.record.locked=true;this.saveBreakRecord(s.bounds.dateStr,s.record);return {success:true,record:s.record};},
        isSelectionWindowOpen(){const s=this.getPlanningStatus();return s.canStart||s.canEdit;},
        getTodayBreaks(){const b=this.getLogicalDayBounds();return this.getBreakRecord(b.dateStr).breaks;},
        getBreakTimestamps(b,bounds){return this.core().interval(b,bounds);},
        saveTodayBreaks(list,lockImmediately=false){
            const status=this.getPlanningStatus();if(status.isLocked||!status.canEdit)return {valid:false,error:status.reason||'Start the planning window first.'};
            const result=this.core().validate(list,status.bounds);if(!result.valid)return result;
            status.record.breaks=result.breaks;status.record.locked=!!lockImmediately||status.isRepair;status.record.repair_required=false;
            this.saveBreakRecord(status.bounds.dateStr,status.record);return {valid:true,record:status.record};
        },
        getActiveBreak(){return this.core().activeBreak(this.getAllBreakData(),{...this.settings(),break_timezone:this.getLogicalDayBounds().timezone});},
        isCurrentlyOnBreak(){return !!this.getActiveBreak();}
    },

    // =========================================================================
    // 2. Emergency Manager (4 Uses Per Cycle, 15m Unlock Window)
    // =========================================================================
    EmergencyManager: {
        getState() {
            let state = {};
            try {
                state = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY) || '{}');
            } catch (e) {
                state = {};
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const weekendEnd = settings.weekend_end !== undefined ? Number(settings.weekend_end) : 6;
            const now = new Date();
            const currentCycleId = this.getCycleIdentifier(now, weekendEnd);

            if (!state.server_managed && (!state.cycle_id || state.cycle_id !== currentCycleId)) {
                state = {
                    cycle_id: currentCycleId,
                    uses_left: 4,
                    active_until: null
                };
                localStorage.setItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY, JSON.stringify(state));
            }

            if(!state.server_managed)state.active_until=null;
            return state;
        },

        getCycleIdentifier(date, weekendEndDay) {
            const resetDay = (weekendEndDay + 1) % 7;
            const d = new Date(date);
            const day = d.getDay();
            const diff = (day < resetDay) ? (7 - resetDay + day) : (day - resetDay);
            d.setDate(d.getDate() - diff);
            return `${d.getFullYear()}-W${Math.ceil((d.getDate() + (6 - d.getDay())) / 7)}-start-${d.toISOString().split('T')[0]}`;
        },

        isBypassActive() {
            const state = this.getState();
            if (!state.active_until) return false;
            return new Date().getTime() < new Date(state.active_until).getTime();
        },

        getRemainingWindowSeconds() {
            const state = this.getState();
            if (!state.active_until) return 0;
            const diff = Math.floor((new Date(state.active_until).getTime() - new Date().getTime()) / 1000);
            return diff > 0 ? diff : 0;
        },

        async activateBypass() {
            try { return await window.TaskitatorPro.activateBypass(); }
            catch(error) { return {success:false,error:error.message}; }
        }
    },

    // =========================================================================
    // 3. AI Verification Cascade (Forensic Auditor & Failover)
    // =========================================================================
    AuditEngine: {
        selection(){return window.TaskitatorVault?.selection?.()||{provider:'gemini',primary:TaskitatorEngine.PRIMARY_MODEL,fallback:TaskitatorEngine.FALLBACK_MODEL};},
        validateFile(file, maxMb = TaskitatorEngine.MAX_FILE_SIZE_MB) {
            if (!file) {
                return { valid: false, error: 'No file attached.' };
            }

            const maxBytes = maxMb * 1024 * 1024;
            if (file.size > maxBytes) {
                return {
                    valid: false,
                    error: `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the ${maxMb} MB upload limit.`
                };
            }

            const allowedTypes = [
                'image/jpeg',
                'image/png',
                'image/webp',
                'image/heic',
                'application/pdf'
            ];

            const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
            const isAllowed = allowedTypes.includes(file.type) || isPdf;

            if (!isAllowed) {
                return { valid: false, error: 'Unsupported file type. Please upload a photo (JPG, PNG, WebP) or PDF document.' };
            }

            return { valid: true };
        },

        async fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Data = reader.result.split(',')[1];
                    let mimeType = file.type || 'image/jpeg';
                    if (file.name.toLowerCase().endsWith('.pdf')) {
                        mimeType = 'application/pdf';
                    }
                    resolve({
                        inline_data: {
                            data: base64Data,
                            mime_type: mimeType
                        }
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        async callGeminiWithParts(modelName, apiKey, partsArray, format='proof', selection=this.selection()) {
            const payload = {
                taskitatorFormat:format,
                contents: [{
                    // Older saved exemplars contain the blob fields directly.
                    // Gemini requires those fields inside an inline_data Part.
                    parts: partsArray.map(part => {
                        if (part && !part.inline_data && !part.inlineData &&
                            typeof part.mime_type === 'string' && typeof part.data === 'string') {
                            return { inline_data: { mime_type: part.mime_type, data: part.data } };
                        }
                        return part;
                    })
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            };

            return await window.TaskitatorVault.generate(modelName,payload,selection);
        },

        async callGemini(modelName, apiKey, inlineDataPart, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [{ text: promptText }, inlineDataPart]);
        },

        async callGeminiTextOnly(modelName, apiKey, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [{ text: promptText }]);
        },

        async validateCriteria(criteriaText, taskTitle = '', exemplarFile = null) {
            const selection=this.selection();
            const trimmedCriteria = (criteriaText || '').trim();
            const trimmedTitle = (taskTitle || '').trim();

            if (!trimmedCriteria) {
                return {
                    success: false,
                    score: 0,
                    passed: false,
                    critique: 'Proof criteria cannot be empty.',
                    suggested_rewrite: ''
                };
            }

            const fileSignature = exemplarFile ? `${exemplarFile.name}_${exemplarFile.size}` : 'nofile';
            const cacheKey = `${selection.provider}:${selection.keyVersion||''}:::${trimmedTitle}:::${trimmedCriteria}:::${fileSignature}`;
            if (TaskitatorEngine._criteriaValidationCache.has(cacheKey)) {
                return TaskitatorEngine._criteriaValidationCache.get(cacheKey);
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const apiKey = Boolean(window.TaskitatorVault?.available);
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Save a key for the active AI provider in Settings → Account.'
                };
            }

            let inlineExemplarPart = null;
            if (exemplarFile) {
                const check = this.validateFile(exemplarFile, TaskitatorEngine.MAX_FILE_SIZE_MB);
                if (!check.valid) {
                    return { success: false, error: check.error };
                }
                inlineExemplarPart = await this.fileToBase64(exemplarFile);
            }

            let prompt = `You are a forensic proof auditor for a task execution system.
Evaluate whether this task acceptance criterion can be objectively verified using submitted evidence.

TASK TITLE: "${trimmedTitle || 'Untitled Task'}"
PROPOSED CRITERIA: "${trimmedCriteria}"

Evaluation Rules:
1. Objectivity: Does it require a tangible, visual artifact (e.g., handwritten page with date, terminal output diff, completed checklist, cleared workspace)?
2. Disqualify Subjective Action: Strongly penalize unprovable internal states ("read", "understand", "study", "learn", "plan") unless tied to an explicit physical proof artifact.
3. Ambiguity: Reject criteria with vague or non-falsifiable boundaries.
4. Pass Threshold: Score on a strict 1 to 10 scale. A score >= 7 means acceptable for automated AI audit.`;

            if (inlineExemplarPart) {
                prompt += `
5. MANDATORY REFERENCE CROSS-CHECK: An exemplar reference document/image is attached. You MUST inspect whether the PROPOSED CRITERIA explicitly mentions, explains, and references this attachment (e.g. how the submitted proof must match or follow this exemplar). If an exemplar is attached without direct explanatory context in the text, you MUST rate the criteria below 7/10 and reject it.`;
            }

            prompt += `

Return strictly valid JSON with this exact schema:
{
  "score": <integer 1 to 10>,
  "passed": <boolean, true if score >= 7, false otherwise>,
  "critique": "<maximum 15 words explaining the flaw or confirming validity>",
  "suggested_rewrite": "<a concrete, artifact-based rewrite if score < 7, else empty string>"
}`;

            const parts = [{ text: prompt }];
            if (inlineExemplarPart) {
                parts.push(inlineExemplarPart);
            }

            try {
                let usedModel = selection.primary;
                let res = await this.callGeminiWithParts(usedModel, apiKey, parts, 'criteria', selection);

                if (selection.fallback && (res.status === 429 || res.status === 503)) {
                    console.warn(`[AuditEngine] Model ${usedModel} hit ${res.status}. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                    usedModel = selection.fallback;
                    res = await this.callGeminiWithParts(usedModel, apiKey, parts, 'criteria', selection);
                }

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    return {
                        success: false,
                        status: res.status,
                        code: res.status,
                        error: errJson.error?.message || `Gemini API HTTP ${res.status}`
                    };
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

                const parsed = JSON.parse(rawText);
                const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
                const passed = parsed.passed !== undefined ? Boolean(parsed.passed) : score >= 7;

                const result = {
                    success: true,
                    score,
                    passed,
                    critique: String(parsed.critique || '').slice(0, 120),
                    suggested_rewrite: String(parsed.suggested_rewrite || '').slice(0, 300),
                    model_used: usedModel
                };

                TaskitatorEngine._criteriaValidationCache.set(cacheKey, result);
                return result;
            } catch (err) {
                return {
                    success: false,
                    status: 0,
                    error: `Validation parsing error: ${err.message}`
                };
            }
        },

        async verifyProof({ taskId, file, files, taskTitle, criteria, userContext, exemplarPart = null }) {
            const fileList = Array.isArray(files) && files.length ? files : (file ? [file] : []);
            if (fileList.length > 5) {
                return { success: false, status: 400, error: 'Maximum 5 evidence files allowed per task.' };
            }

            // Taskitator Pro Hosted Claude Haiku 5.5 Hook (when active Pro & not in BYOK mode)
            if (window.TaskitatorPro) {
                let hostedSelected = false;
                try {
                    const proStatus = await window.TaskitatorPro.getStatus();
                    hostedSelected = proStatus && proStatus.isPro && !proStatus.use_byok;
                    if (proStatus && proStatus.isPro && !proStatus.use_byok) {
                        const encodedFiles = [];
                        for (const f of fileList) {
                            const check = this.validateFile(f, TaskitatorEngine.MAX_FILE_SIZE_MB);
                            if (!check.valid) return { success: false, status: 400, error: check.error };
                            const part = await this.fileToBase64(f);
                            encodedFiles.push({
                                mimeType: part.inline_data.mime_type,
                                data: part.inline_data.data
                            });
                        }
                        const combinedCriteria = (criteria || '') + (userContext ? (' - Note: ' + userContext) : '');
                        const proRes = await window.TaskitatorPro.reviewProof({
                            taskId: taskId || ('task_' + Date.now()),
                            title: taskTitle,
                            criteria: combinedCriteria,
                            files: encodedFiles,
                            exemplar: exemplarPart ? {mime_type:(exemplarPart.inline_data || exemplarPart).mime_type, data:(exemplarPart.inline_data || exemplarPart).data} : null
                        });
                        return {
                            success: true,
                            approved: proRes.verdict === 'approved',
                            verdict: proRes.verdict,
                            confidence: proRes.confidence,
                            critique: proRes.critique,
                            job_id:proRes.job_id,
                            model_used: proRes.model_used || 'claude-haiku-5-5'
                        };
                    }
                } catch (proErr) {
                    return {success:false,status:proErr.status||503,error:proErr.message};
                }
            }
            try {
                const encoded=[];
                for(const f of fileList){
                    const check=this.validateFile(f);if(!check.valid)return {success:false,status:400,error:check.error};
                    const part=(await this.fileToBase64(f)).inline_data;encoded.push({mime_type:part.mime_type,data:part.data});
                }
                const result=await window.TaskitatorPro.personalReview({task_id:taskId,files:encoded});
                return {success:true,approved:result.verdict==='approved',...result};
            } catch(error){return {success:false,status:error.status||0,error:error.message};}

        }
    }
};

window.TaskitatorEngine = TaskitatorEngine;

// <<< MODULE_END: audit-engine.js >>>
// <<< MODULE_START: pro/pro-client.js >>>
// File: pro/pro-client.js
// Taskitator Pro Phase 2: Client library for Keyo activation, status, Claude Haiku 5.5 review,
// multi-file proof review, batch proof review, and BYOK mode toggle.

(function(global) {
    class ProClient {
        constructor(options = {}) {
            this.baseUrl = options.baseUrl || null;
            this.getToken = options.getToken || this.defaultTokenProvider;
            this.pendingAudits = new Map();
            this.pendingConfirmations = new Map();
        }

        async defaultTokenProvider() {
            if (global.TaskitatorAuth?.token) {
                return await global.TaskitatorAuth.token();
            }
            if (global.Clerk?.session) {
                try {
                    return await global.Clerk.session.getToken();
                } catch (e) {
                    console.warn('[ProClient] Failed to retrieve token from Clerk session:', e);
                }
            }
            if (global.TaskitatorAuth?.getToken) {
                try {
                    return await global.TaskitatorAuth.getToken();
                } catch (e) {
                    console.warn('[ProClient] Failed to retrieve token from TaskitatorAuth:', e);
                }
            }
            return localStorage.getItem('taskitator_session_token') || null;
        }

        async request(path, options = {}) {
            // Resolve at request time: auth-config may load after this client.
            const baseUrl = (this.baseUrl || global.TASKITATOR_AUTH_CONFIG?.workerUrl || '').trim().replace(/\/+$/, '');
            if (!baseUrl) {
                throw new Error('Taskitator Worker URL is missing. Reload the app and check auth-config.js.');
            }
            const token = await this.getToken();
            if (!token) {
                throw new Error('Sign in to continue.');
            }

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            };

            const res = await fetch(`${baseUrl}${path}`, {
                ...options,
                headers,
                cache: 'no-store'
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                const err = new Error(data.error || `Pro API request failed with status ${res.status}`);
                err.status = res.status;
                err.code = data.code;
                err.details = data;
                throw err;
            }

            return data;
        }

        /**
         * Get Pro tier status and remaining daily/monthly credit balances.
         */
        async getStatus() {
            const owner=global.Clerk?.session?.id;
            const data=await this.request('/pro/status', { method: 'GET' });
            if(owner!==global.Clerk?.session?.id)throw new Error('Your session changed. Retry the status check.');
            if(typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('taskitator-pro-status',{detail:data}));
            return data;
        }

        /**
         * Check active Pro entitlement for consecutive subtask creation.
         * Returns { allowed: boolean, status: string, message: string }
         */
        async checkConsecutiveEntitlement() {
            try {
                const owner = global.Clerk?.session?.id;
                const status = await this.getStatus();
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Retry the Pro option.');
                if (status?.isPro === true && status.status === 'active' && (status.expires_at === null || (Number.isFinite(status.expires_at) && status.expires_at > Date.now()))) {
                    return { allowed: true, status: 'active', message: '' };
                }
                const st = status?.status || 'free';
                if (st === 'expired' || st === 'revoked' || st === 'invalid') {
                    return {
                        allowed: false,
                        status: st,
                        message: 'Your Taskitator Pro license has expired or is inactive. Consecutive {num==X} auto-increment is a Pro convenience feature — your existing subtasks and numbering are preserved, and you can still add manual subtasks.'
                    };
                }
                return {
                    allowed: false,
                    status: 'free',
                    message: 'Consecutive {num==X} auto-increment is a Taskitator Pro feature. Ordinary manual subtask creation remains available.'
                };
            } catch (err) {
                return {
                    allowed: false,
                    status: 'error',
                    message: 'Could not verify Taskitator Pro status right now. Ordinary manual subtask creation remains available — please retry the Pro consecutive option in a moment.'
                };
            }
        }

        /**
         * Activate Pro using a Keyo license key.
         * @param {string} key - The Keyo license key
         */
        async activate(key) {
            if (!key || typeof key !== 'string') {
                throw new Error('Please enter a valid license key.');
            }
            return await this.request('/pro/activate', {
                method: 'POST',
                body: JSON.stringify({ key: key.trim() })
            });
        }

        /**
         * Toggle BYOK mode for Pro users (hosted limits do not reset).
         */
        async setUseByok(useByok) {
            return await this.request('/pro/byok', {
                method: 'POST',
                body: JSON.stringify({ use_byok: Boolean(useByok) })
            });
        }

        /**
         * Submit single or multi-file proof review to hosted Claude Haiku 5.5 gateway.
         */
        async reviewProof({ taskId, title, criteria, file, files, operationId, exemplar }) {
            if (!taskId) throw new Error('taskId is required for proof review.');
            if (!criteria) throw new Error('Criteria must be defined for AI-audited review.');

            const opId = operationId || ('op_'+Date.now().toString(36)+'_'+crypto.randomUUID().replaceAll('-',''));

            const payload = {
                task_id: taskId,
                task_title: title || 'Task',
                criteria,
                operation_id: opId,
                exemplar: exemplar || null
            };

            if (Array.isArray(files) && files.length) {
                payload.files = files.map(f => ({
                    mime_type: f.mimeType || f.mime_type,
                    data: f.data || f.base64
                }));
            } else if (file) {
                payload.file = {
                    mime_type: file.mimeType || file.mime_type,
                    data: file.data || file.base64
                };
            }

            return await this.quotedReview(payload,false);
        }

        /**
         * Phase 2: Batch Proof Review across multiple selected tasks.
         * @param {Array<{id: string, title: string, criteria: string}>} tasks
         * @param {Array<{mimeType: string, data: string}>} files
         */
        async batchReview({ tasks, files, operationId }) {
            if (!Array.isArray(tasks) || !tasks.length) throw new Error('Please select at least one task for batch review.');
            if (!Array.isArray(files) || !files.length) throw new Error('Please attach at least one proof file for batch review.');

            const opId = operationId || ('op_'+Date.now().toString(36)+'_'+crypto.randomUUID().replaceAll('-',''));

            return await this.quotedReview({
                tasks:tasks.map(t => ({id:t.id,title:t.title,criteria:t.criteria || t.resolved_criteria || '',exemplar:t.exemplar || null})),
                files:files.map(f => ({mime_type:f.mimeType || f.mime_type,data:f.data || f.base64})),
                operation_id:opId
            },true);
        }

        async prepareAudit() {
            const sync=global.SyncEngine;
            if(!sync?.isConfigured?.())throw new Error('Sign in and sync your Taskitator tasks before submitting proof.');
            if(sync.needsInitialPull())throw new Error('Sync this device once before submitting proof.');
            const revision=localStorage.getItem(sync.STORAGE_KEY_REVISION);
            const tasks=JSON.parse(localStorage.getItem('taskitator_tasks')||'[]');let changed=false;
            for(const task of tasks)if(task.status==='active'&&(task.ai_locked||task.require_ai_proof)&&!task.reference_id&&!task.reference_inline_data){
                const old=await global.ExemplarStore?.getExemplar(task.id);
                if(old?.inline_data){task.reference_inline_data=old.inline_data;changed=true;}
            }
            if(revision!==localStorage.getItem(sync.STORAGE_KEY_REVISION))throw new Error('Your tasks changed while preparing proof. Retry.');
            if(changed){localStorage.setItem('taskitator_tasks',JSON.stringify(tasks));sync.markLocalModified();}
            if(sync.isDirty()){
                const result=await sync.push();
                if(!result?.success || result.pending || sync.isDirty())throw new Error(result?.error||'Finish syncing your task changes before submitting proof.');
            }
        }
        async personalReview(payload) {
            await this.prepareAudit();
            const owner=global.Clerk?.session?.id;
            const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({owner,payload,mode:'personal'})));
            const fingerprint='personal:'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
            const operation_id=this.pendingAudits.get(fingerprint)||('op_'+Date.now().toString(36)+'_'+crypto.randomUUID().replaceAll('-',''));
            this.pendingAudits.set(fingerprint,operation_id);
            try{
                const result=await this.request('/pro/ai/personal-review',{method:'POST',body:JSON.stringify({...payload,operation_id})});
                if(global.Clerk?.session?.id!==owner)throw new Error('Your session changed. Start a new review.');
                this.pendingAudits.delete(fingerprint);return result;
            }catch(error){if(error.status&&error.code!=='AUDIT_PENDING')this.pendingAudits.delete(fingerprint);throw error;}
        }
        async emergencyRequest(options) {
            const owner = global.Clerk?.session?.id;
            try {
                const state = await this.request('/emergency', options);
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Reopen Emergency Bypass.');
                localStorage.setItem('taskitator_emergency_state', JSON.stringify(state));
                if (typeof global.CustomEvent === 'function') global.dispatchEvent(new global.CustomEvent('taskitator-emergency-updated'));
                return state;
            } catch (error) {
                if (error.status === 404) error.message = 'Emergency Bypass is unavailable on the server. Update the Taskitator Worker and try again.';
                throw error;
            }
        }
        async emergencyStatus() {
            return this.emergencyRequest({method:'GET'});
        }
        async activateBypass() {
            return this.emergencyRequest({method:'POST',body:'{}'});
        }


        async quotedReview(payload,batch) {
            await this.prepareAudit();
            const owner = global.Clerk?.session?.id;
            const {operation_id:ignored,...input} = payload;
            const hashed = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({owner,input,batch})));
            const fingerprint = Array.from(new Uint8Array(hashed),b=>b.toString(16).padStart(2,'0')).join('');
            payload = {...payload,operation_id:this.pendingAudits.get(fingerprint) || payload.operation_id};
            this.pendingAudits.set(fingerprint,payload.operation_id);
            try {
                const quote = await this.request('/pro/ai/quote', {method:'POST',body:JSON.stringify({...payload,batch})});
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Start a new audit.');
                if (quote.completed) { this.pendingAudits.delete(fingerprint); return quote.result; }
                if (!Number.isFinite(quote.maximum_credits) || quote.maximum_credits <= 0 || !quote.quote_id)
                    throw new Error('Could not obtain a valid audit price. No paid audit was started.');
                const tasks = batch ? payload.tasks : [{id:payload.task_id,title:payload.task_title}];
                const names = new Map(tasks.map((task,index) => {
                    const title = typeof task.title === 'string' ? task.title.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120) : '';
                    return [task.id,title || (batch ? `Task ${index+1}` : 'Task')];
                }));
                const round1 = value => Number(Number(value || 0).toFixed(1)).toFixed(1);
                const round3 = value => Number(Number(value || 0).toFixed(3)).toFixed(3);
                const credits = value => Number(value.toFixed(3)).toString();
                const hasBatchDiscount = Boolean(batch && payload.tasks.length >= 2);
                const taskItems = quote.tasks.map((task,index) => ({
                    taskId: task.task_id,
                    title: names.get(task.task_id) || (batch ? `Task ${index+1}` : 'Task'),
                    credits: Number(task.credits || 0),
                    creditsFormatted: round3(task.credits),
                    creditsShort: credits(task.credits),
                    exemplar: Boolean(task.exemplar)
                }));
                let approved = false;
                if (typeof global.ProUI?.confirmReviewQuote === 'function') {
                    approved = await global.ProUI.confirmReviewQuote({
                        estimatedCredits: quote.estimated_credits,
                        maximumCredits: quote.maximum_credits,
                        estimatedDisplay: round1(quote.estimated_credits),
                        maximumDisplay: round1(quote.maximum_credits),
                        estimatedExact: round3(quote.estimated_credits),
                        maximumExact: round3(quote.maximum_credits),
                        tasks: taskItems,
                        batchDiscount: hasBatchDiscount
                    });
                }
                if (approved !== true) throw Object.assign(new Error('Audit cancelled. No paid review was started.'),{code:'AUDIT_CANCELLED'});
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Start a new audit.');
                const result = await this.request(batch ? '/pro/ai/batch-review' : '/pro/ai/review',{
                    method:'POST',body:JSON.stringify({...payload,quote_id:quote.quote_id})});
                this.pendingAudits.delete(fingerprint); return result;
            } catch (error) {
                // A lost browser response may already have been billed. Keep that operation for the next retry.
                if ((error.status && error.code !== 'AUDIT_PENDING') || error.code === 'AUDIT_CANCELLED') this.pendingAudits.delete(fingerprint);
                throw error;
            }
        }

        /**
         * Phase 2: Confirm eligible batch completions with server attestation.
         */
        async batchConfirm({ jobId, taskIds, operationId, batch=true }) {
            await this.prepareAudit();
            if(!jobId || !Array.isArray(taskIds)||!taskIds.length)throw new Error('A review approval and selected tasks are required.');
            const sync=global.SyncEngine,revision=localStorage.getItem(sync.STORAGE_KEY_REVISION),owner=global.Clerk?.session?.id;
            const key=jobId+':'+[...taskIds].sort().join(',');
            const opId=operationId || this.pendingConfirmations.get(key) || ('confirm_'+crypto.randomUUID());
            this.pendingConfirmations.set(key,opId);
            const result=await this.request('/pro/ai/batch-confirm',{method:'POST',body:JSON.stringify({job_id:jobId,task_ids:taskIds,operation_id:opId,batch})});
            if(global.Clerk?.session?.id!==owner)throw new Error('Your session changed. Reopen your task list.');
            // Download the authoritative completion; concurrent drafts are preserved by the revision check.
            const downloaded=await sync.pull(null,{discardLocal:true,expectedRevision:revision});
            if(!downloaded?.success)throw new Error(downloaded?.error||'Completion was saved on the server. Sync to view it; keep any new local edits.');
            for(const id of result.confirmed_task_ids||[])await global.ExemplarStore?.deleteExemplar(id);
            return result;
        }

        /**
         * Phase 2.5: Check if a unique username is available.
         */
        async checkUsername(username) {
            if (!username) throw new Error('Username is required.');
            return await this.request(`/pro/username/check?username=${encodeURIComponent(username.trim())}`, {
                method: 'GET'
            });
        }

        /**
         * Phase 2.5: Set or update the account's unique username.
         */
        async setUsername(username) {
            if (!username) throw new Error('Username is required.');
            return await this.request('/pro/username', {
                method: 'POST',
                body: JSON.stringify({ username: username.trim() })
            });
        }

        /**
         * Phase 2.5: Get the account username profile.
         */
        async getUsernameProfile() {
            return await this.request('/pro/username/profile', { method: 'GET' });
        }

        /**
         * Phase 2.5: Resolve a username for login (pre-auth).
         */
        async resolveUsername(username) {
            const baseUrl = (this.baseUrl || global.TASKITATOR_AUTH_CONFIG?.workerUrl || '').trim().replace(/\/+$/, '');
            if (!baseUrl) throw new Error('Worker URL is missing.');
            const res = await fetch(`${baseUrl}/pro/username/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: String(username || '').trim() })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || 'Failed to resolve username.');
                err.status = res.status;
                err.disallow_google = data.disallow_google;
                throw err;
            }
            return data;
        }
    }

    global.ProClient = ProClient;
    global.TaskitatorPro = global.TaskitatorPro || new ProClient();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { ProClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);

// <<< MODULE_END: pro/pro-client.js >>>
// <<< MODULE_START: pro/pro-ui.js >>>
// File: pro/pro-ui.js
// Taskitator Pro Phase 2: UI components for Settings page, BYOK toggle,
// multi-file proof review, and batch proof review.

(function(global) {
    function getClient() {
        return global.TaskitatorPro || (global.ProClient ? new global.ProClient() : null);
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const b64 = reader.result.split(',')[1];
                resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // --- Phase 2: Batch Proof Review Modal & Trigger ---

    function openBatchReviewModal(selectedIds = null) {
        if (document.getElementById('proBatchModalRoot')) return;

        let allTasks = [];
        try {
            allTasks = JSON.parse(localStorage.getItem('taskitator_tasks') || '[]');
        } catch {
            allTasks = [];
        }

        const scope = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
        const eligibleTasks = allTasks.filter(t => t.status === 'active' && (t.ai_locked || t.require_ai_proof) && (!scope || scope.has(t.id)));
        const preselect = Boolean(scope && eligibleTasks.length <= 20);

        const modal = document.createElement('div');
        modal.id = 'proBatchModalRoot';
        modal.className = 'pro-modal-backdrop';

        if (!eligibleTasks.length) {
            modal.innerHTML = `
                <div class="pro-modal-box">
                    <div class="pro-modal-header">
                        <h3 style="margin: 0;">⚡ Batch Proof Review</h3>
                        <button type="button" class="icon-btn" id="proBatchCloseBtn">✕</button>
                    </div>
                    <p style="color: #94a3b8; font-size: 0.95rem; margin: 20px 0;">
                        ${scope ? 'None of the selected tasks are active AI-audited tasks. Select an active task with' : 'No active AI-audited tasks found. Create a task with'} <em>Require AI Proof Verification</em> enabled first!
                    </p>
                    <div style="text-align: right;">
                        <button type="button" class="pro-btn" id="proBatchCancelBtn">Close</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            document.getElementById('proBatchCloseBtn').addEventListener('click', () => modal.remove());
            document.getElementById('proBatchCancelBtn').addEventListener('click', () => modal.remove());
            return;
        }

        const taskRowsHtml = eligibleTasks.map(t => `
            <label class="pro-batch-task-row">
                <input type="checkbox" class="pro-batch-task-cb" value="${escapeHtml(t.id)}" ${preselect ? 'checked' : ''} data-title="${escapeHtml(t.title)}" data-criteria="${escapeHtml(t.proof_criteria || '')}" />
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; color: #f8fafc; font-size: 0.9rem;">${escapeHtml(t.title)}</div>
                    <div style="font-size: 0.78rem; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        Criteria: ${escapeHtml(t.proof_criteria || 'None specified')}
                    </div>
                </div>
            </label>
        `).join('');

        modal.innerHTML = `
            <div class="pro-modal-box pro-batch-box">
                <div class="pro-modal-header">
                    <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <span>⚡</span> Batch Proof Review
                    </h3>
                    <button type="button" class="icon-btn" id="proBatchCloseBtn">✕</button>
                </div>
                <p style="font-size: 0.88rem; color: #94a3b8; margin: 8px 0 16px 0;">
                    ${scope ? 'Only your selected active AI-audited tasks are shown. ' : ''}Select up to 20 tasks and attach up to 5 proof files. Each task is reviewed and charged separately. Reviewing two or more tasks together gives each task a 25% discount. Comparing proof with a reference example doubles that task’s charge. You can check the price before starting.
                </p>

                <div class="pro-batch-section-title">1. Select Target Tasks (<span id="proBatchSelectedCount">0</span> selected)</div>
                <div class="pro-batch-task-list">
                    ${taskRowsHtml}
                </div>

                <div class="pro-batch-section-title" style="margin-top: 16px;">2. Attach Evidence Files (Up to 5 images or PDFs)</div>
                <div class="pro-batch-upload-area">
                    <input type="file" id="proBatchFileInput" multiple accept="image/jpeg,image/png,image/webp,application/pdf" style="display:none;" />
                    <button type="button" class="icon-btn" id="proBatchPickFilesBtn" style="gap: 6px;">
                        📁 <span>Select Evidence Files</span>
                    </button>
                    <div id="proBatchFileList" class="pro-batch-file-chips"></div>
                </div>

                <div id="proBatchResultsArea" style="display: none; margin-top: 20px;"></div>

                <div class="pro-modal-footer">
                    <div id="proBatchFeedback" style="font-size: 0.85rem; color: #f87171;"></div>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="icon-btn" id="proBatchCancelBtn">Cancel</button>
                        <button type="button" class="pro-btn" id="proBatchSubmitBtn" disabled>Preview Batch Audit</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeBtn = document.getElementById('proBatchCloseBtn');
        const cancelBtn = document.getElementById('proBatchCancelBtn');
        const submitBtn = document.getElementById('proBatchSubmitBtn');
        const pickBtn = document.getElementById('proBatchPickFilesBtn');
        const fileInput = document.getElementById('proBatchFileInput');
        const fileListDiv = document.getElementById('proBatchFileList');
        const countSpan = document.getElementById('proBatchSelectedCount');
        const feedback = document.getElementById('proBatchFeedback');
        const resultsArea = document.getElementById('proBatchResultsArea');

        const close = () => modal.remove();
        closeBtn.onclick = close;
        cancelBtn.onclick = close;

        const selectedTasks = preselect ? eligibleTasks.map(t => ({id:t.id, title:t.title, criteria:t.proof_criteria || ''})) : [];
        let stagedFiles = [];

        modal.querySelectorAll('.pro-batch-task-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const taskId = cb.value;
                const title = cb.dataset.title;
                const criteria = cb.dataset.criteria;
                if (cb.checked) {
                    if (selectedTasks.length >= 20) {
                        cb.checked = false;
                        feedback.textContent = 'Maximum 20 tasks per batch.';
                        return;
                    }
                    selectedTasks.push({ id: taskId, title, criteria });
                } else {
                    const idx = selectedTasks.findIndex(t => t.id === taskId);
                    if (idx !== -1) selectedTasks.splice(idx, 1);
                }
                countSpan.textContent = selectedTasks.length;
                updateSubmitState();
            });
        });

        countSpan.textContent = selectedTasks.length;
        updateSubmitState();

        pickBtn.onclick = () => fileInput.click();

        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files);
            if (stagedFiles.length + files.length > 5) {
                feedback.textContent = 'Maximum 5 evidence files permitted.';
                return;
            }

            for (const file of files) {
                const b64 = await fileToBase64(file);
                stagedFiles.push({
                    name: file.name,
                    mimeType: file.type,
                    data: b64
                });
            }

            renderStagedFiles();
            updateSubmitState();
        });

        function renderStagedFiles() {
            fileListDiv.innerHTML = stagedFiles.map((f, i) => `
                <div class="pro-file-chip">
                    <span>${f.mimeType === 'application/pdf' ? '📄' : '🖼️'} ${escapeHtml(f.name)}</span>
                    <button type="button" class="pro-chip-del" data-index="${i}">✕</button>
                </div>
            `).join('');

            fileListDiv.querySelectorAll('.pro-chip-del').forEach(btn => {
                btn.onclick = () => {
                    const idx = Number(btn.dataset.index);
                    stagedFiles.splice(idx, 1);
                    renderStagedFiles();
                    updateSubmitState();
                };
            });
        }

        function updateSubmitState() {
            feedback.textContent = '';
            submitBtn.disabled = selectedTasks.length === 0 || stagedFiles.length === 0;
            if (selectedTasks.length > 0) {
                submitBtn.textContent = `Preview Batch Audit (${selectedTasks.length} tasks)`;
            } else {
                submitBtn.textContent = 'Run Batch Audit';
            }
        }

        submitBtn.onclick = async () => {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Reviewing proof…';
            feedback.textContent = '';

            const client = getClient();
            try {
                const res = await client.batchReview({
                    tasks: await Promise.all(selectedTasks.map(async item => {
                        const task = allTasks.find(t => t.id === item.id);
                        let part = task?.reference_inline_data || global.TaskitatorRecurrenceUI?.state()?.reference_files?.[task?.reference_id];
                        const stored = await global.ExemplarStore?.getExemplar(item.id);
                        if (stored?.inline_data) part = stored.inline_data;
                        part = part?.inline_data || part;
                        if (task?.reference_id && !part) throw new Error('The reference exemplar for "'+item.title+'" is unavailable. Restore it before reviewing.');
                        return {...item,exemplar:part ? {mime_type:part.mime_type,data:part.data} : null};
                    })),
                    files: stagedFiles
                });

                renderBatchResults(res);
            } catch (err) {
                feedback.textContent = err.message || 'Batch audit failed.';
                submitBtn.disabled = false;
                submitBtn.textContent = `Preview Batch Audit (${selectedTasks.length} tasks)`;
            }
        };

        function renderBatchResults(result) {
            submitBtn.style.display = 'none';
            resultsArea.style.display = 'block';

            const tasks = result.tasks || [];
            const eligible = tasks.filter(t => t.status === 'eligible');

            let html = `
                <div class="pro-batch-section-title">3. Audit Results (Job: ${escapeHtml(result.job_id)})</div>
                <div class="pro-batch-results-list">
            `;

            tasks.forEach(t => {
                const isPass = t.status === 'eligible';
                const orig = selectedTasks.find(s => s.id === t.task_id);
                html += `
                    <div class="pro-result-row ${isPass ? 'pass' : 'fail'}">
                        <div style="font-weight: 600;">${isPass ? '✓ ELIGIBLE' : '✕ ' + t.status.toUpperCase()}: ${escapeHtml(orig?.title || t.task_id)}</div>
                        <div style="font-size: 0.8rem; margin-top: 4px; color: #cbd5e1;">${escapeHtml(t.reason || t.critique || '')}</div>
                    </div>
                `;
            });

            html += `</div>`;

            if (eligible.length > 0) {
                html += `
                    <div style="margin-top: 16px; text-align: right;">
                        <button type="button" class="pro-btn" id="proConfirmBatchBtn">
                            Confirm Completion for ${eligible.length} Eligible Task(s)
                        </button>
                    </div>
                `;
            }

            resultsArea.innerHTML = html;

            const confirmBtn = document.getElementById('proConfirmBatchBtn');
            if (confirmBtn) {
                confirmBtn.onclick = async () => {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = 'Confirming...';
                    try {
                        const client = getClient();
                        await client.batchConfirm({
                            jobId: result.job_id,
                            taskIds: eligible.map(e => e.task_id)
                        });

                        // batchConfirm downloads the server-authorized task snapshot.
                        modal.remove();
                        if (typeof window.TaskitatorApp?.refresh === 'function') window.TaskitatorApp.refresh();
                        else location.reload();
                    } catch (e) {
                        feedback.textContent = e.message || 'Failed to confirm batch completion.';
                        confirmBtn.disabled = false;
                    }
                };
            }
        }
    }

    // --- Settings Tab: Pro Dashboard & BYOK Toggle ---

    function renderProSection(containerId = 'pro-settings-container') {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="pro-card" id="pro-card-root">
                <div class="pro-header">
                    <div class="pro-title-wrap">
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600;">⭐ Taskitator Pro</h3>
                        <span class="pro-badge free" id="pro-status-badge">Checking...</span>
                    </div>
                    <span id="pro-expiry-label" style="font-size: 12px; color: #94a3b8;"></span>
                </div>

                <div id="pro-quota-container" style="display: none;">
                    <div class="pro-quota-grid">
                        <div class="pro-quota-card">
                            <div class="pro-quota-label">Daily Hosted AI Credits</div>
                            <div class="pro-quota-val"><span id="pro-daily-remaining">--</span> / <span id="pro-daily-limit">45</span></div>
                            <div class="pro-quota-sub">Resets at midnight Asia/Riyadh</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-daily-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                        <div class="pro-quota-card">
                            <div class="pro-quota-label">Monthly Hosted AI Credits</div>
                            <div class="pro-quota-val"><span id="pro-monthly-remaining">--</span> / <span id="pro-monthly-limit">1000</span></div>
                            <div class="pro-quota-sub">Resets on the first, Asia/Riyadh</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-monthly-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                    </div>

                    <details class="pro-credit-help" id="pro-credit-help-details">
                        <summary id="pro-credit-help-title">How credits work</summary>
                        <div class="pro-credit-help-body">
                            <ul>
                                <li><strong>Document Pages (Page Count):</strong> For PDF files, usage depends on how many pages are in the document. Each page is read by the AI, so a 10-page file uses more tokens than a 1-page file.</li>
                                <li><strong>Photo Resolution (Image Size):</strong> Higher-resolution or larger photos take more work for the AI to inspect than smaller, standard-sized screenshots or photos.</li>
                                <li><strong>Reference Example:</strong> Comparing your proof against an attached reference file doubles that task’s charge because the AI must inspect both files side by side.</li>
                                <li><strong>Batch Discount:</strong> Reviewing two or more tasks together gives each task a <strong>25% discount</strong> because they share the same proof upload.</li>
                                <li><strong>Price Preview & Refunds:</strong> Before any review begins, you see the estimated charge and the maximum held amount. Afterward, you only pay for what was actually used, and any unused held credits return immediately.</li>
                            </ul>
                            <p>You pay for a completed review even if the proof is rejected. Cancelling at the price preview starts no paid review.</p>
                        </div>
                    </details>
                    <div class="pro-byok-box">
                        <label class="pro-switch-wrap">
                            <input type="checkbox" id="proByokToggle" />
                            <span class="pro-switch-label"><strong>Use your own API key.</strong> Switching modes does not reset your hosted credits.</span>
                        </label>
                    </div>
                </div>

                <div class="pro-form" id="pro-activation-form">
                    <label style="font-size: 13px; font-weight: 500; color: #cbd5e1;">Activate Pro with Keyo License Key</label>
                    <div class="pro-input-group">
                        <input type="text" class="pro-input" id="pro-license-input" placeholder="e.g. XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocorrect="off" spellcheck="false" />
                        <button class="pro-btn" id="pro-activate-btn">Activate Pro</button>
                    </div>
                    <div class="pro-msg" id="pro-form-msg"></div>
                </div>

                <div class="pro-compare-link-row" style="margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(148, 163, 184, 0.2); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <span style="font-size: 0.82rem; color: #94a3b8;">See everything included in Free and Pro</span>
                    <a href="components.html?view=compare" class="pro-compare-link" id="proComparePageLink" style="font-size: 0.84rem; font-weight: 600; color: #60a5fa; text-decoration: none;">Compare Free and Pro →</a>
                </div>
            </div>
        `;

        bindProEvents();
        refreshProStatus();
    }

    function bindProEvents() {
        const btn = document.getElementById('pro-activate-btn');
        const input = document.getElementById('pro-license-input');
        const byokToggle = document.getElementById('proByokToggle');

        if (btn && input) {
            btn.addEventListener('click', async () => {
                const key = input.value.trim();
                if (!key) {
                    showMsg('Please enter your license key.', 'error');
                    return;
                }

                const client = getClient();
                btn.disabled = true;
                btn.textContent = 'Activating...';
                showMsg('', '');

                try {
                    const res = await client.activate(key);
                    showMsg(res.message || 'Taskitator Pro successfully activated!', 'success');
                    input.value = '';
                    await refreshProStatus();
                } catch (err) {
                    showMsg(err.message || 'Failed to activate license key.', 'error');
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Activate Pro';
                }
            });
        }

        if (byokToggle) {
            byokToggle.addEventListener('change', async () => {
                const client = getClient();
                try {
                    await client.setUseByok(byokToggle.checked);
                    showMsg(byokToggle.checked ? 'Personal API-key mode enabled. Hosted credits are unchanged.' : 'Hosted AI enabled.', 'success');
                } catch (err) {
                    showMsg(err.message || 'Failed to update BYOK mode.', 'error');
                    byokToggle.checked = !byokToggle.checked;
                }
            });
        }
    }

    function showMsg(text, type) {
        const msg = document.getElementById('pro-form-msg');
        if (!msg) return;
        if (!text) {
            msg.className = 'pro-msg';
            msg.textContent = '';
            msg.style.display = 'none';
            return;
        }
        msg.className = `pro-msg ${type}`;
        msg.textContent = text;
        msg.style.display = 'block';
    }

    async function refreshProStatus() {
        const client = getClient();
        if (!client) return;

        const badge = document.getElementById('pro-status-badge');
        const expiry = document.getElementById('pro-expiry-label');
        const quotaBox = document.getElementById('pro-quota-container');
        const byokToggle = document.getElementById('proByokToggle');

        try {
            const data = await client.getStatus();
            if (data.isPro) {
                if (badge) {
                    badge.className = 'pro-badge active';
                    badge.textContent = 'PRO ACTIVE';
                }
                if (expiry) expiry.textContent = data.expires_at === null ? 'Lifetime license' :
                    `Valid through ${new Date(data.expires_at).toLocaleDateString()}`;
                if (quotaBox) quotaBox.style.display = 'block';

                if (byokToggle) byokToggle.checked = Boolean(data.use_byok);

                const dailyRem = document.getElementById('pro-daily-remaining');
                const dailyLim = document.getElementById('pro-daily-limit');
                const dailyFill = document.getElementById('pro-daily-fill');
                const monthlyRem = document.getElementById('pro-monthly-remaining');
                const monthlyLim = document.getElementById('pro-monthly-limit');
                const monthlyFill = document.getElementById('pro-monthly-fill');

                if (data.credits) {
                    if (dailyRem) dailyRem.textContent = data.credits.daily_remaining;
                    if (dailyLim) dailyLim.textContent = data.credits.daily_limit;
                    if (dailyFill && data.credits.daily_limit > 0) {
                        const pct = Math.round((data.credits.daily_remaining / data.credits.daily_limit) * 100);
                        dailyFill.style.width = `${pct}%`;
                    }

                    if (monthlyRem) monthlyRem.textContent = data.credits.monthly_remaining;
                    if (monthlyLim) monthlyLim.textContent = data.credits.monthly_limit;
                    if (monthlyFill && data.credits.monthly_limit > 0) {
                        const pct = Math.round((data.credits.monthly_remaining / data.credits.monthly_limit) * 100);
                        monthlyFill.style.width = `${pct}%`;
                    }
                }
            } else {
                if (badge) {
                    badge.className = 'pro-badge free';
                    badge.textContent = 'FREE TIER';
                }
                if (expiry) expiry.textContent = data.status === 'verification_required' ?
                    'Please enter your Keyo license key again to verify this account.' :
                    ['revoked','invalid','expired'].includes(data.status) ? 'License verification failed. Check your license in Keyo, then reactivate.' : '';
                if (quotaBox) quotaBox.style.display = 'none';
            }
        } catch (err) {
            if (badge) {
                badge.className = 'pro-badge free';
                badge.textContent = 'VERIFICATION UNAVAILABLE';
            }
            if (expiry) expiry.textContent = err.message || 'Unable to check your license. Please refresh Settings and retry.';
            if (quotaBox) quotaBox.style.display = 'none';
        }
    }

    function autoInit() {
        if (document.getElementById('pro-settings-container')) {
            renderProSection('pro-settings-container');
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', autoInit);
        } else {
            autoInit();
        }
        global.addEventListener('taskitator-auth-ready', autoInit);
    }

    let activeQuoteCancel = null;

    function confirmReviewQuote(summary) {
        return new Promise((resolve) => {
            const doc = global.document || (typeof document !== "undefined" ? document : null);
            const existing = doc?.getElementById?.('proReviewPriceDialog');
            if (typeof activeQuoteCancel === 'function') {
                activeQuoteCancel();
            } else if (existing) {
                if (typeof existing._cancelQuote === 'function') existing._cancelQuote();
                else existing.remove?.();
            }

            const previousActiveElement = doc?.activeElement || null;

            const round1 = v => Number(Number(v || 0).toFixed(1)).toFixed(1);
            const round3 = v => Number(Number(v || 0).toFixed(3)).toFixed(3);
            const est1 = summary.estimatedDisplay || round1(summary.estimatedCredits);
            const max1 = summary.maximumDisplay || round1(summary.maximumCredits);
            const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
            const batchDiscount = Boolean(summary.batchDiscount);

            const taskRows = tasks.map((t, idx) => {
                const title = escapeHtml(t.title || `Task ${idx + 1}`);
                const c3 = escapeHtml(t.creditsFormatted || round3(t.credits));
                const exBadge = t.exemplar
                    ? ' <span class="pro-quote-multiplier">(reference comparison: ×2 charge)</span>'
                    : '';
                return `<li class="pro-quote-task-item"><span class="pro-quote-task-name">${title}</span>: up to <strong>${c3} credits</strong>${exBadge}</li>`;
            }).join('');

            const discountNote = batchDiscount
                ? `<p class="pro-quote-discount-note">Each task includes a <strong>25% batch discount</strong> for reviewing multiple tasks together.</p>`
                : '';

            const backdrop = doc.createElement('div');
            backdrop.id = 'proReviewPriceDialog';
            backdrop.className = 'pro-modal-backdrop pro-quote-dialog-backdrop';
            backdrop.tabIndex = -1;
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');
            backdrop.setAttribute('aria-labelledby', 'proQuoteDialogTitle');

            backdrop.innerHTML = `
                <div class="pro-modal-box pro-quote-dialog-box">
                    <div class="pro-modal-header">
                        <h3 id="proQuoteDialogTitle" style="margin: 0; font-size: 1.05rem;">Review cost preview</h3>
                        <button type="button" class="icon-btn" id="proQuoteCloseBtn" aria-label="Cancel review">✕</button>
                    </div>
                    <div class="pro-quote-summary-grid">
                        <div class="pro-quote-metric">
                            <span class="pro-quote-metric-label">Estimated charge</span>
                            <strong class="pro-quote-metric-value" id="proQuoteEstimatedVal">${escapeHtml(est1)} credits</strong>
                        </div>
                        <div class="pro-quote-metric">
                            <span class="pro-quote-metric-label">Maximum temporary hold</span>
                            <strong class="pro-quote-metric-value" id="proQuoteMaximumVal">${escapeHtml(max1)} credits</strong>
                        </div>
                    </div>
                    <p class="pro-quote-policy-brief">
                        Unused held credits return to your balance immediately after the review finishes. A completed review is charged even when proof is rejected. Cancelling now starts no paid review.
                    </p>
                    <details class="pro-quote-details" id="proQuoteDetailsToggle">
                        <summary id="proQuoteDetailsSummary">View details</summary>
                        <div class="pro-quote-details-body">
                            <div class="pro-quote-exact-totals">
                                <span>Exact estimated charge: <strong>${escapeHtml(summary.estimatedExact || round3(summary.estimatedCredits))} credits</strong></span>
                                <span>Exact maximum hold: <strong>${escapeHtml(summary.maximumExact || round3(summary.maximumCredits))} credits</strong></span>
                            </div>
                            <ul class="pro-quote-task-list">
                                ${taskRows}
                            </ul>
                            ${discountNote}
                        </div>
                    </details>
                    <div class="pro-modal-footer pro-quote-actions">
                        <button type="button" class="icon-btn" id="proQuoteCancelBtn">Cancel</button>
                        <button type="button" class="pro-btn" id="proQuoteStartBtn">Start review</button>
                    </div>
                </div>
            `;

            // Mark background siblings inert while modal is open
            const siblingStates = [];
            if (doc?.body?.children) {
                for (const child of Array.from(doc.body.children)) {
                    if (child === backdrop) continue;
                    siblingStates.push({
                        el: child,
                        inert: Boolean(child.inert),
                        ariaHidden: child.getAttribute?.('aria-hidden') ?? null
                    });
                    child.inert = true;
                    child.setAttribute?.('aria-hidden', 'true');
                }
            }

            doc.body.appendChild(backdrop);

            const closeBtn = backdrop.querySelector('#proQuoteCloseBtn');
            const detailsSummary = backdrop.querySelector('#proQuoteDetailsSummary');
            const cancelBtn = backdrop.querySelector('#proQuoteCancelBtn');
            const startBtn = backdrop.querySelector('#proQuoteStartBtn');

            const getFocusableElements = () => {
                if (typeof backdrop.querySelectorAll === 'function') {
                    const list = Array.from(backdrop.querySelectorAll(
                        'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
                    ));
                    if (list.length > 0) return list;
                }
                return [closeBtn, detailsSummary, cancelBtn, startBtn].filter(Boolean);
            };

            let settled = false;
            const handleKeydown = (e) => {
                if (settled || !e) return;
                if (e.key === 'Escape' || e.key === 'Esc') {
                    e.preventDefault?.();
                    e.stopPropagation?.();
                    finish(false);
                    return;
                }
                if (e.key === 'Tab') {
                    const focusables = getFocusableElements();
                    if (focusables.length === 0) {
                        e.preventDefault?.();
                        backdrop.focus?.();
                        return;
                    }
                    const first = focusables[0];
                    const last = focusables[focusables.length - 1];
                    const current = doc?.activeElement;
                    const idx = focusables.indexOf(current);
                    if (e.shiftKey) {
                        if (idx <= 0 || current === backdrop) {
                            e.preventDefault?.();
                            last?.focus?.();
                        }
                    } else {
                        if (idx === -1 || idx === focusables.length - 1) {
                            e.preventDefault?.();
                            first?.focus?.();
                        }
                    }
                }
            };

            const handleFocusIn = (e) => {
                if (settled || !e?.target) return;
                if (typeof backdrop.contains === 'function' && !backdrop.contains(e.target)) {
                    const focusables = getFocusableElements();
                    (focusables[0] || cancelBtn || startBtn || backdrop)?.focus?.();
                }
            };

            const finish = (decision) => {
                if (settled) return;
                settled = true;
                if (activeQuoteCancel === cancelCurrent) {
                    activeQuoteCancel = null;
                }
                doc?.removeEventListener?.('keydown', handleKeydown, true);
                doc?.removeEventListener?.('focusin', handleFocusIn, true);
                backdrop.removeEventListener?.('keydown', handleKeydown);
                for (const item of siblingStates) {
                    item.el.inert = item.inert;
                    if (item.ariaHidden === null) item.el.removeAttribute?.('aria-hidden');
                    else item.el.setAttribute?.('aria-hidden', item.ariaHidden);
                }
                backdrop.remove?.();
                if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
                    try { previousActiveElement.focus(); } catch {}
                }
                resolve(decision);
            };

            const cancelCurrent = () => finish(false);
            activeQuoteCancel = cancelCurrent;
            backdrop._cancelQuote = cancelCurrent;

            doc?.addEventListener?.('keydown', handleKeydown, true);
            doc?.addEventListener?.('focusin', handleFocusIn, true);
            backdrop.addEventListener?.('keydown', handleKeydown);

            cancelBtn?.addEventListener?.('click', () => finish(false));
            closeBtn?.addEventListener?.('click', () => finish(false));
            startBtn?.addEventListener?.('click', () => finish(true));

            const initialFocus = cancelBtn || startBtn || closeBtn || getFocusableElements()[0] || backdrop;
            if (initialFocus && typeof initialFocus.focus === 'function') {
                try { initialFocus.focus(); } catch {}
            }
        });
    }

    global.ProUI = Object.assign(global.ProUI || {}, {
        confirmReviewQuote,
        renderProSection,
        refreshProStatus,
        openBatchReviewModal
    });
    global.renderProSection = renderProSection;
    global.refreshProStatus = refreshProStatus;
    global.openBatchReviewModal = openBatchReviewModal;
})(typeof window !== 'undefined' ? window : globalThis);

// <<< MODULE_END: pro/pro-ui.js >>>
// <<< MODULE_START: pro/profile-ui.js >>>
// Display-only Taskitator username. It is never used for identity or permissions.
(function (global) {
    'use strict';
    let bound = false, currentName = '', currentOwner = '', serial = 0;
    const button = () => document.getElementById('accountUsernameBtn');
    const owner = () => (global.Clerk?.user?.id || '') + ':' + (global.Clerk?.session?.id || '');
    function nameFor() { return currentOwner === owner() ? currentName : ''; }
    function paint(name) {
        const node = button(); if (!node) return;
        node.textContent = name ? '@' + name : 'Set username';
        node.title = name ? 'Edit Taskitator username: @' + name : 'Choose a unique Taskitator username';
        node.setAttribute('aria-label',node.title);
    }
    async function refresh() {
        const ticket = ++serial, startOwner = owner();
        if (currentOwner !== startOwner) { currentName = ''; paint(''); }
        if (!global.Clerk?.session || !global.TaskitatorPro) return;
        try {
            const result = await global.TaskitatorPro.getUsernameProfile();
            if (ticket !== serial || startOwner !== owner()) return;
            currentOwner = startOwner; currentName = result.username || ''; paint(currentName);
        } catch {
            // Keep a name only when it was verified for this account and session.
            if (ticket === serial && startOwner === owner()) paint(nameFor());
        }
    }
    function open() {
        if (document.getElementById('taskitatorUsernameDialog')) return;
        const user = global.Clerk?.user, session = global.Clerk?.session?.id;
        if (!user || !session) return;
        const dialog = document.createElement('dialog');
        dialog.id = 'taskitatorUsernameDialog';
        dialog.className = 'username-dialog';
        dialog.setAttribute('aria-labelledby', 'usernameDialogTitle');
        dialog.innerHTML = `
            <form id="taskitatorUsernameForm">
                <div class="username-dialog-header">
                    <h2 id="usernameDialogTitle">Your Taskitator username</h2>
                    <button type="button" class="icon-btn" id="usernameCloseBtn" aria-label="Close username editor">✕</button>
                </div>
                <p id="usernameHelp">Choose the name shown beside your task list. It follows your signed-in account across devices.</p>
                <label for="taskitatorUsernameInput">Username</label>
                <input id="taskitatorUsernameInput" name="username" type="text" required minlength="3" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="usernameHelp usernameFormat" autofocus>
                <p id="usernameFormat">3–20 letters, numbers or underscores. Names are unique without regard to letter case. This display name does not change how you sign in.</p>
                <p id="usernameFeedback" role="status" aria-live="polite"></p>
                <div class="username-dialog-actions">
                    <button type="button" class="icon-btn" id="usernameCancelBtn">Cancel</button>
                    <button type="submit" class="icon-btn" id="usernameSaveBtn">Save username</button>
                </div>
            </form>`;
        document.body.appendChild(dialog);
        const input = dialog.querySelector('#taskitatorUsernameInput');
        const feedback = dialog.querySelector('#usernameFeedback');
        const save = dialog.querySelector('#usernameSaveBtn');
        const cancel = dialog.querySelector('#usernameCancelBtn');
        const closeButton = dialog.querySelector('#usernameCloseBtn');
        const form = dialog.querySelector('#taskitatorUsernameForm');
        input.value = nameFor(user);
        let busy = false;
        const close = () => { if (!busy) dialog.close(); };
        closeButton.addEventListener('click', close);
        cancel.addEventListener('click', close);
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => { dialog.remove(); button()?.focus(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            const name = input.value.trim().replace(/^@/, '');
            if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
                feedback.textContent = 'Use 3–20 letters, numbers or underscores. Uppercase and lowercase versions count as the same username.';
                input.focus(); return;
            }
            busy = true; save.disabled = cancel.disabled = closeButton.disabled = input.disabled = true;
            save.textContent = 'Saving…'; feedback.textContent = '';
            try {
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Close this editor and try again.');
                const updated = await global.TaskitatorPro.setUsername(name);
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Reload to see the current username.');
                ++serial; currentOwner = owner(); currentName = updated.username; paint(currentName);
                busy = false;
                dialog.close();
            } catch (error) {
                feedback.textContent = error.errors?.[0]?.longMessage || error.message || 'Could not save your username. Try again.';
            } finally {
                busy = false; save.disabled = cancel.disabled = closeButton.disabled = input.disabled = false;
                save.textContent = 'Save username';
            }
        });
        dialog.showModal();
    }
    function initialize() {
        if (!button()) return;
        refresh();
        if (bound) return;
        bound = true;
        button().addEventListener('click', open);
        global.addEventListener('focus', async () => {
            const user = global.Clerk?.user;
            if (!user) return;
            refresh();
        });
    }
    global.TaskitatorProfile = {initialize, refresh};
    global.addEventListener('taskitator-auth-ready', initialize);
})(window);

// <<< MODULE_END: pro/profile-ui.js >>>

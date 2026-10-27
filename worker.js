import { UniverseRelease } from './uni/universe-release.js';
// ============================================================================
// Taskitator Consolidated Cloudflare Worker & Security Engine (worker.js)
// Combines: recurrence-core, break-core, auth, ai-models, verification,
// deletion, vault, ai-gateway, and worker router.
// ============================================================================
import { ProGateway, TaskProtection, liveAccount } from './pro-backend.js';

// File: recurrence-core.js
// Shared deterministic recurrence rules, used by the browser and Cloudflare Worker.
(function (root) {
    'use strict';
    const DAY = 86400000;
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    function validDate(s) {
        return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
            Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
    }
    const dateMs = s => Date.parse(s + 'T00:00:00Z');
    const dateString = ms => new Date(ms).toISOString().slice(0, 10);
    function today(now = Date.now(), hour = 0) {
        return dateString(now + (3 - hour) * 3600000);
    }
    function schedule(input) {
        if (!input || !['daily', 'weekdays', 'monthly', 'month_day', 'half_yearly', 'yearly'].includes(input.kind)) throw new Error('Choose a recurrence schedule.');
        if (!validDate(input.start)) throw new Error('Choose a valid start date.');
        if (input.end && (!validDate(input.end) || input.end < input.start)) throw new Error('End date must be on or after the start date.');
        const result = { kind: input.kind, start: input.start, end: input.end || '' };
        if (input.kind === 'weekdays') {
            result.weekdays = [...new Set(input.weekdays || [])].sort();
            if (!result.weekdays.length || result.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw new Error('Select at least one weekday.');
        }
        if (input.kind === 'month_day') {
            result.day = Number(input.day);
            if (!Number.isInteger(result.day) || result.day < 1 || result.day > 31) throw new Error('Day of month must be between 1 and 31.');
        }
        return result;
    }
    function nextDate(config, after = null) {
        const s = schedule(config);
        if (after !== null && !validDate(after)) throw new Error('Invalid previous occurrence date.');
        const floor = Math.max(dateMs(s.start), after === null ? dateMs(s.start) : dateMs(after) + DAY);
        let candidate;
        if (s.kind === 'daily') candidate = dateString(floor);
        else if (s.kind === 'weekdays') {
            for (let i = 0; i < 7; i++) {
                const ms = floor + i * DAY;
                if (s.weekdays.includes(new Date(ms).getUTCDay())) { candidate = dateString(ms); break; }
            }
        } else {
            const anchor = new Date(dateMs(s.start));
            const minimum = new Date(floor);
            const step = s.kind === 'half_yearly' ? 6 : s.kind === 'yearly' ? 12 : 1;
            const anchorMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
            const targetMonth = minimum.getUTCFullYear() * 12 + minimum.getUTCMonth();
            let offset = Math.max(0, Math.floor((targetMonth - anchorMonth) / step) * step);
            const wantedDay = s.kind === 'month_day' ? s.day : anchor.getUTCDate();
            for (let i = 0; i < 3; i++, offset += step) {
                const m = anchorMonth + offset, year = Math.floor(m / 12), month = m % 12;
                const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
                const ms = Date.UTC(year, month, Math.min(wantedDay, last));
                if (ms >= floor) { candidate = dateString(ms); break; }
            }
        }
        return candidate && (!s.end || candidate <= s.end) ? candidate : null;
    }
    function subtree(tasks, id) {
        const ids = new Set([id]);
        let changed = true;
        while (changed) { changed = false; for (const task of tasks) if (ids.has(task.parent_id) && !ids.has(task.id)) { ids.add(task.id); changed = true; } }
        return tasks.filter(task => ids.has(task.id));
    }
    function seriesFor(state, task) {
        return state.series.find(s => s.id === task?.recurrence_series_id) || null;
    }
    function canStart(tasks, id) {
        const branch = subtree(tasks, id);
        if (branch.some(t => t.recurrence_series_id)) throw new Error('A recurring branch cannot contain another recurring series.');
        let parent = tasks.find(t => t.id === id)?.parent_id; const seen = new Set();
        while (parent && !seen.has(parent)) {
            seen.add(parent); const p = tasks.find(t => t.id === parent);
            if (!p || p.status !== 'active') throw new Error('The parent must be active.');
            if (p.recurrence_series_id) throw new Error('This task already follows its recurring ancestor.');
            parent = p.parent_id;
        }
    }
    function cleanNode(task, key, parentKey, rootDate) {
        const t = copy(task);
        for (const field of ['id', 'parent_id', 'status', 'created_at', 'completed_at', 'verified_model', 'recurrence_series_id', 'recurrence_node_id', 'recurrence_hold_until', 'recurrence_occurrence', 'recurring', 'recurrence']) delete t[field];
        return { key, parent_key: parentKey, date_offset: validDate(task.due_date) && validDate(rootDate) ? Math.round((dateMs(task.due_date) - dateMs(rootDate)) / DAY) : 0, task: t };
    }
    function start(tasks, state, id, config, seriesId, now = Date.now()) {
        config = schedule(config); canStart(tasks, id);
        const task = tasks.find(t => t.id === id);
        if (!task || task.status !== 'active') throw new Error('Only an active task can start recurring.');
        const due = nextDate(config);
        if (!due) throw new Error('No occurrence falls within these dates.');
        const branch = subtree(tasks, id).filter(t => t.status !== 'trash');
        const keys = new Map(branch.map((t, i) => [t.id, String(i)]));
        const previousDate = task.due_date;
        const nodes = branch.map(t => cleanNode(t, keys.get(t.id), t.id === id ? null : keys.get(t.parent_id), previousDate));
        const s = { id: seriesId, enabled: true, schedule: config, parent_id: task.parent_id || null,
            occurrence: 0, current_root_id: id, current_date: due, nodes, created_at: new Date(now).toISOString() };
        state.reference_files ||= {};
        for (const t of branch) {
            if (!t.reference_inline_data) continue;
            const key = `${seriesId}_ref_${keys.get(t.id)}`;
            state.reference_files[key] = t.reference_inline_data;
            t.reference_id = key; delete t.reference_inline_data;
            const node = nodes.find(n=>n.key===keys.get(t.id));
            node.task.reference_id=key; delete node.task.reference_inline_data;
        }
        state.series.push(s);
        branch.forEach(t => { t.recurrence_series_id = seriesId; t.recurrence_node_id = keys.get(t.id); t.recurrence_occurrence = 0; });
        task.due_date = due;
        for (const t of branch) if (t !== task) {
            const node = nodes.find(n => n.key === keys.get(t.id)); t.due_date = dateString(dateMs(due) + node.date_offset * DAY);
        }
        return s;
    }
    function updateNode(state, task, fields) {
        const s = seriesFor(state, task); const node = s?.nodes.find(n => n.key === task.recurrence_node_id);
        if (!node) return;
        const allowed = ['title', 'raw_title', 'description', 'tags', 'priority_id', 'project_id', 'is_bonus', 'strict_prerequisites', 'ai_locked', 'proof_criteria', 'raw_proof_criteria', 'reference_inline_data', 'reference_id'];
        for (const key of allowed) if (Object.prototype.hasOwnProperty.call(fields, key)) node.task[key] = copy(fields[key]);
    }
    function validateState(state, tasks) {
        if (!state || !Array.isArray(state.series) || !Array.isArray(state.history)) throw new Error('Recurring data is malformed. Restore a valid backup.');
        if(state.reference_files !== undefined && (!state.reference_files || typeof state.reference_files !== 'object' || Array.isArray(state.reference_files))) throw new Error('Invalid recurring references.');
        for(const h of state.history) if(!h || typeof h.id!=='string' || !['completed','deleted'].includes(h.outcome) || !Array.isArray(h.tasks)) throw new Error('Invalid recurrence history.');
        const ids = new Set();
        for (const s of state.series) {
            if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(s.id) || ids.has(s.id)) throw new Error('Invalid recurring series ID.');
            ids.add(s.id); schedule(s.schedule);
            if (typeof s.enabled !== 'boolean' || !Number.isSafeInteger(s.occurrence) || s.occurrence < 0 || !Array.isArray(s.nodes) || !s.nodes.length || !validDate(s.current_date)) throw new Error('Invalid recurring series.');
            const keys = new Set();
            for (const n of s.nodes) {
                if (!n || typeof n.key !== 'string' || !/^[0-9]+$/.test(n.key) || keys.has(n.key) || !n.task || typeof n.task !== 'object' || Array.isArray(n.task) || !Number.isInteger(n.date_offset) || Math.abs(n.date_offset) > 36600) throw new Error('Invalid recurring template.');
                keys.add(n.key);
            }
            if (s.nodes.filter(n => n.parent_key === null).length !== 1) throw new Error('Recurring template needs one root.');
            for (const n of s.nodes) {
                const seen = new Set([n.key]); let key = n.parent_key;
                while (key !== null) {
                    if (!keys.has(key) || seen.has(key)) throw new Error('Recurring template contains an invalid parent cycle.');
                    seen.add(key); key = s.nodes.find(x => x.key === key).parent_key;
                }
            }
        }
        for (const t of tasks) if (t.recurrence_series_id && !ids.has(t.recurrence_series_id)) throw new Error('A recurring task is missing its series.');
        return state;
    }
    function reconcile(snapshot, now = Date.now()) {
        const state = snapshot.recurrence_state || { series: [], history: [] };
        validateState(state, snapshot.tasks);
        let tasks = snapshot.tasks; let changed = false;
        const hour = Math.max(0, Math.min(4, Number(snapshot.settings?.day_start_hour) || 0));
        for (const s of state.series) {
            const current = tasks.find(t => t.id === s.current_root_id);
            if (!current) { if (s.enabled) { s.enabled = false; s.stopped_reason = 'Current task removed'; changed = true; } continue; }
            let parentId = current.parent_id; const seen = new Set(); let ancestorDone = false;
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId); const p = tasks.find(t => t.id === parentId);
                if (!p || p.status !== 'active') { ancestorDone = true; break; }
                if (p.recurrence_series_id && p.recurrence_series_id !== s.id) throw new Error('Nested recurring series are not supported.');
                parentId = p.parent_id;
            }
            if (ancestorDone && s.enabled) { s.enabled = false; s.stopped_reason = 'Parent completed or removed'; changed = true; }
            // Newly added children become part of the future branch automatically.
            const branch = subtree(tasks, current.id);
            const depth = t => {let n=0,p=t.parent_id,seen=new Set();while(p&&!seen.has(p)){seen.add(p);const parent=branch.find(x=>x.id===p);if(!parent)break;n++;p=parent.parent_id;}return n;};
            branch.sort((a,b)=>depth(a)-depth(b));
            for (const t of branch.filter(t => t.status !== 'trash')) {
                if (t.recurrence_series_id && t.recurrence_series_id !== s.id) throw new Error('Nested recurring series are not supported.');
                if (!t.recurrence_node_id || t.recurrence_series_id !== s.id) {
                    const key = String(Math.max(-1, ...s.nodes.map(n => Number(n.key))) + 1);
                    const parent = tasks.find(p => p.id === t.parent_id);
                    if (!parent?.recurrence_node_id) continue;
                    t.recurrence_series_id = s.id; t.recurrence_node_id = key; t.recurrence_occurrence = s.occurrence;
                    if(t.reference_inline_data){
                        state.reference_files ||= {};const refId=`${s.id}_ref_${key}`;
                        state.reference_files[refId]=t.reference_inline_data;t.reference_id=refId;delete t.reference_inline_data;
                    }
                    s.nodes.push(cleanNode(t, key, parent.recurrence_node_id, s.current_date)); changed = true;
                }
            }
            if (current.status === 'active' || Number(current.recurrence_hold_until) > now) continue;
            if (!['completed', 'trash'].includes(current.status)) throw new Error('Invalid recurring task status.');
            const reason = current.status === 'completed' ? 'completed' : 'deleted';
            const eventId = `${s.id}:${s.occurrence}`;
            if (!state.history.some(h => h.id === eventId)) state.history.push({ id: eventId, series_id: s.id,
                title: current.title, due_date: s.current_date, ended_at: current.completed_at || new Date(now).toISOString(),
                outcome: reason, tasks: branch.map(t => ({ title: t.title, status: t.status, ai_locked: !!t.ai_locked, verified_model: t.verified_model || null, project_id:t.project_id || 'inbox', priority_id:t.priority_id || null, completed_at:t.completed_at || (t.status==='completed' ? new Date(now).toISOString() : null) })) });
            state.history = state.history.slice(-500);
            const ids = new Set(branch.map(t => t.id)); tasks = tasks.filter(t => !ids.has(t.id));
            const finishedDate = today(Number.isFinite(Date.parse(current.completed_at)) ? Date.parse(current.completed_at) : now, hour);
            const after = [s.current_date, finishedDate, today(now, hour)].sort().at(-1);
            const due = s.enabled && !ancestorDone ? nextDate(s.schedule, after) : null;
            s.current_root_id = null;
            if (!due) { s.enabled = false; s.stopped_reason ||= 'Series stopped or end date reached'; changed = true; continue; }
            s.occurrence++;
            const idFor = key => `${s.id}_o${s.occurrence}_n${key}`;
            for (const n of s.nodes) {
                const t = copy(n.task);
                t.id = idFor(n.key); t.parent_id = n.parent_key === null ? current.parent_id || null : idFor(n.parent_key);
                t.status = 'active'; t.completed_at = null; t.created_at = new Date(now).toISOString(); delete t.verified_model;
                t.recurrence_series_id = s.id; t.recurrence_node_id = n.key; t.recurrence_occurrence = s.occurrence;
                t.due_date = n.parent_key === null ? due : (validDate(n.task.due_date) ? dateString(dateMs(due) + n.date_offset * DAY) : due);
                tasks.push(t); if (n.parent_key === null) s.current_root_id = t.id;
            }
            s.parent_id = current.parent_id || null; s.current_date = due; changed = true;
        }
        if(state.reference_files){
            const used=new Set([...tasks.map(t=>t.reference_id),...state.series.flatMap(s=>s.nodes.map(n=>n.task.reference_id))]);
            for(const key of Object.keys(state.reference_files))if(!used.has(key))delete state.reference_files[key];
        }
        snapshot.tasks = tasks; snapshot.recurrence_state = state;
        return { snapshot, changed };
    }
    const api = { schedule, nextDate, validDate, today, subtree, seriesFor, start, updateNode, validateState, reconcile };
    root.TaskitatorRecurrence = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);


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


// Clerk session verification using Cloudflare Web Crypto. No password database.
// The short-lived JWT is checked locally, then the session is checked with Clerk
// on every request so revocation does not wait for token expiry.
export class SecurityError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export const allowedOrigins = env => String(env.ALLOWED_ORIGINS || 'https://taskitator.mazendev.com')
    .split(',').map(value => value.trim()).filter(Boolean);
const decodeAuthB64 = value => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SecurityError(401, 'Invalid session. Sign in again.');
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
};
export const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
export function randomPhoneToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return 'tkp_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function clerkAPI(env, path) {
    if (!env.CLERK_SECRET_KEY) throw new SecurityError(503, 'Authentication setup is incomplete.');
    let res;
    try {
        res = await fetch('https://api.clerk.com/v1/' + path, {
            headers: { Authorization: 'Bearer ' + env.CLERK_SECRET_KEY },
            signal: AbortSignal.timeout(10000)
        });
    } catch { throw new SecurityError(503, 'Authentication service unavailable. Retry shortly.'); }
    if (res.status === 404) throw new SecurityError(401, 'Session is no longer active. Sign in again.');
    if (!res.ok) throw new SecurityError(503, 'Authentication service unavailable. Retry shortly.');
    try { return await res.json(); }
    catch { throw new SecurityError(503, 'Authentication service returned an invalid response.'); }
}
export async function verifySession(request, env, token) {
    if (!env.CLERK_JWT_KEY || !env.CLERK_ISSUER || !env.CLERK_SECRET_KEY) {
        throw new SecurityError(503, 'Authentication setup is incomplete.');
    }
    let header, claims, parts;
    try {
        parts = token.split('.');
        if (parts.length !== 3 || token.length > 8192) throw new Error();
        header = JSON.parse(new TextDecoder().decode(decodeAuthB64(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(decodeAuthB64(parts[1])));
    } catch { throw new SecurityError(401, 'Invalid session. Sign in again.'); }
    if (header.alg !== 'RS256' || header.crit !== undefined) throw new SecurityError(401, 'Invalid session.');
    let key;
    try {
        const pem = env.CLERK_JWT_KEY.replace(/\\n/g, '\n')
            .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
        key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch { throw new SecurityError(503, 'The Clerk JWT public key is invalid. Check Worker settings.'); }
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeAuthB64(parts[2]),
        new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const now = Math.floor(Date.now() / 1000), origins = allowedOrigins(env);
    const origin = request.headers.get('Origin');
    if (!valid || claims.iss !== env.CLERK_ISSUER.replace(/\/$/, '') ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.nbf) || claims.nbf > now + 5 ||
        !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
        !origins.includes(claims.azp) || (origin && origin !== claims.azp) ||
        typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(claims.sub) ||
        typeof claims.sid !== 'string' || !/^sess_[A-Za-z0-9]+$/.test(claims.sid) ||
        (claims.sts !== undefined && claims.sts !== 'active')) {
        throw new SecurityError(401, 'Session is invalid or expired. Sign in again.');
    }
    const session = await clerkAPI(env, 'sessions/' + encodeURIComponent(claims.sid));
    if (session.status !== 'active' || session.user_id !== claims.sub) {
        throw new SecurityError(401, 'Session is no longer active. Sign in again.');
    }
    return { userId: claims.sub, sessionId: claims.sid, factorAge: claims.fva,
        reverificationId: claims.taskitator_reverification_id, actor: claims.act };
}
export async function verifiedEmail(env, userId) {
    const user = await clerkAPI(env, 'users/' + encodeURIComponent(userId));
    const email = user.email_addresses?.find(entry => entry.id === user.primary_email_address_id);
    if (!email || email.verification?.status !== 'verified') {
        throw new SecurityError(403, 'Verify your primary email address before connecting Taskitator.');
    }
    return String(email.email_address).trim().toLowerCase();
}


export const PROVIDERS = {
    gemini: {name:'Gemini',models:['gemini-3.5-flash-lite','gemini-3.1-flash-lite']},
    claude: {name:'Claude',models:['claude-haiku-5-5']}
};
export function providerId(value='gemini') {
    if(typeof value!=='string' || !Object.hasOwn(PROVIDERS,value))throw new SecurityError(400,'Choose Gemini or Claude.');
    return value;
}

export const VERIFICATION_VERSION = 2;
export const VERIFICATION_MS = 5 * 60000;
export const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeVerifyB64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export async function verifyGoogleToken(token, env, nonce, subject) {
    let parts, header, claims;
    try {
        parts = token.split('.');
        if (parts.length !== 3 || token.length > 16000) throw new Error();
        header = JSON.parse(new TextDecoder().decode(decodeVerifyB64(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(decodeVerifyB64(parts[1])));
    } catch { throw new SecurityError(401, 'Google verification returned an invalid identity.'); }
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        claims.aud !== env.GOOGLE_OAUTH_CLIENT_ID ||
        (claims.azp && claims.azp !== env.GOOGLE_OAUTH_CLIENT_ID) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 5 || now - claims.iat > 300 ||
        claims.nonce !== nonce || claims.sub !== subject) {
        throw new SecurityError(401, 'Select the Google account already connected to this Taskitator account.');
    }
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new SecurityError(503, 'Google verification is temporarily unavailable.');
    const jwk = (await res.json()).keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) throw new SecurityError(401, 'Google signing key was not recognized. Try again.');
    const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeVerifyB64(parts[2]), new TextEncoder().encode(parts[0]+'.'+parts[1])))) {
        throw new SecurityError(401, 'Google identity could not be verified.');
    }
}
export class ActionVerification {
    constructor(service) { this.service = service; this.storage = service.storage; this.env = service.env; }
    async get(id, identity, action = 'delete-account') {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new SecurityError(403, 'Start verification again.');
        const record = await this.storage.get('action-proof:'+await sha256(id));
        if (!record || record.version !== VERIFICATION_VERSION || record.expires <= Date.now() || record.userId !== identity.userId ||
            record.sessionId !== identity.sessionId || record.action !== action) {
            throw new SecurityError(403, 'Verification expired or belongs to a different session. Start again.');
        }
        return record;
    }
    async start(request, identity, method, action = 'delete-account', stageId = null, provider = 'gemini') {
        if (!['delete-account','api-key-reveal','api-key-save','api-key-delete'].includes(action)) throw new SecurityError(400,'Invalid verification action.');
        if (action === 'delete-account' && this.env.ACCOUNT_DELETION_ENABLED !== 'true') throw new SecurityError(503,'Account deletion needs one-time setup. Follow PHASE-1-SETUP.txt.');
        if (action !== 'delete-account' && !this.service.vault.ready()) throw new SecurityError(503,'Secure key storage needs setup. Follow PHASE-2-SETUP.html.');
        if (identity.actor) throw new SecurityError(403, 'Impersonated sessions cannot authorize sensitive actions.');
        if (!(await this.service.accountFor(identity))) throw new SecurityError(403,'Connect your Taskitator account before verification.');
        await this.service.rateBucket('verify-user:'+identity.userId, 8);
        if (!['password','google'].includes(method)) throw new SecurityError(400, 'Choose password or Google verification.');
        const origin = request.headers.get('Origin');
        if (!allowedOrigins(this.env).includes(origin)) throw new SecurityError(403, 'Open verification from the Taskitator website.');
        const id = randomSecret(), record = { version:VERIFICATION_VERSION, userId:identity.userId, sessionId:identity.sessionId,
            action, method, status:'pending', created:Date.now(), expires:Date.now()+VERIFICATION_MS,
            baseline:identity.reverificationId || null, origin };
        if (action !== 'delete-account') record.context = await this.service.vault.context(identity,action,stageId,provider);
        let authorizationUrl;
        if (method === 'google') {
            const settings = ['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','GOOGLE_VERIFICATION_REDIRECT_URI'];
            const missing = settings.filter(name => typeof this.env[name] !== 'string' || !this.env[name].trim());
            if (missing.length) throw new SecurityError(503, 'Google confirmation needs Worker setup: '+missing.join(', ')+'. See pro/verification-setup.html.');
            let redirect;
            try { redirect = new URL(this.env.GOOGLE_VERIFICATION_REDIRECT_URI); }
            catch { throw new SecurityError(503, 'Google confirmation callback is misconfigured. See pro/verification-setup.html.'); }
            if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.pathname !== '/auth/verification/google/callback' || redirect.search || redirect.hash) {
                throw new SecurityError(503, 'Google confirmation callback is misconfigured. See pro/verification-setup.html.');
            }
            const user = await clerkAPI(this.env, 'users/'+encodeURIComponent(identity.userId));
            const account = user.external_accounts?.find(item => item.provider === 'oauth_google' || item.provider === 'google');
            if (!account || account.verification?.status !== 'verified' || !account.provider_user_id) {
                throw new SecurityError(403, 'Connect your Google account in Manage account & password before using Google confirmation.');
            }
            record.subject = String(account.provider_user_id);
            record.nonce = randomSecret(); record.verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
            const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.verifier))));
            const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            url.search = new URLSearchParams({ client_id:this.env.GOOGLE_OAUTH_CLIENT_ID,
                redirect_uri:this.env.GOOGLE_VERIFICATION_REDIRECT_URI, response_type:'code', scope:'openid',
                state:id, nonce:record.nonce, code_challenge:challenge, code_challenge_method:'S256',
                prompt:'select_account', access_type:'online' }).toString();
            authorizationUrl = url.href;
        }
        await this.storage.put('action-proof:'+await sha256(id), record);
        await this.service.ensureAlarm();
        return { verification_id:id, expires_at:record.expires, ...(authorizationUrl ? {authorization_url:authorizationUrl} : {}) };
    }
    async password(id, identity, action = 'delete-account') {
        const record = await this.get(id, identity, action);
        if (record.method !== 'password' || record.status !== 'pending') throw new SecurityError(403, 'Start password verification again.');
        const rv = identity.reverificationId;
        if (typeof rv !== 'string' || !/^[A-Za-z0-9_-]{5,100}$/.test(rv) || rv === record.baseline ||
            !Array.isArray(identity.factorAge) || !Number.isFinite(identity.factorAge[0]) ||
            identity.factorAge[0] < 0 || identity.factorAge[0] > 2) {
            throw new SecurityError(403, 'Complete a new password verification. Check the Clerk reverification claim setup if this persists.');
        }
        const confirmed = await clerkAPI(this.env, 'sessions/'+encodeURIComponent(identity.sessionId)+'/reverifications/'+encodeURIComponent(rv));
        // Backend Reverification has factor timestamps, not the browser SDK's
        // first_factor_verification object. Bind both timestamps to this attempt.
        const now = Date.now();
        if (!confirmed || confirmed.object !== 'reverification' || confirmed.id !== rv ||
            confirmed.session_id !== identity.sessionId || confirmed.user_id !== identity.userId ||
            confirmed.status !== 'complete' || !['first_factor','multi_factor'].includes(confirmed.level) ||
            !Number.isSafeInteger(confirmed.created_at) || !Number.isSafeInteger(confirmed.first_factor_verified_at) ||
            confirmed.created_at < record.created || confirmed.created_at > now ||
            confirmed.first_factor_verified_at < confirmed.created_at || confirmed.first_factor_verified_at > now) {
            throw new SecurityError(403, 'Password verification has not completed.');
        }
        const usedKey = 'verification-used:'+await sha256(identity.sessionId+':'+rv);
        await this.storage.transaction(async tx => {
            const key = 'action-proof:'+await sha256(id), current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.status !== 'pending' || current.expires <= Date.now() || await tx.get(usedKey)) {
                throw new SecurityError(403, 'This verification was already used. Start again.');
            }
            current.status = 'verified';
            await tx.put(key, current); await tx.put(usedKey, {expires:Date.now()+10*60000});
        });
        return { verified:true };
    }
    async callback(request) {
        const url = new URL(request.url), id = url.searchParams.get('state');
        if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new SecurityError(400, 'Invalid Google verification request.');
        const key = 'action-proof:'+await sha256(id);
        const record = await this.storage.transaction(async tx => {
            const current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.method !== 'google' || current.status !== 'pending' || current.expires <= Date.now()) {
                throw new SecurityError(403, 'Google verification expired or was already used.');
            }
            current.status = 'checking'; await tx.put(key,current); return current;
        });
        let success = false;
        try {
            if (url.origin+url.pathname !== this.env.GOOGLE_VERIFICATION_REDIRECT_URI || url.searchParams.has('error')) throw new Error();
            const code = url.searchParams.get('code'); if (!code || code.length > 4096) throw new Error();
            const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST',
                headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:AbortSignal.timeout(10000),
                body:new URLSearchParams({ code, client_id:this.env.GOOGLE_OAUTH_CLIENT_ID,
                    client_secret:this.env.GOOGLE_OAUTH_CLIENT_SECRET, redirect_uri:this.env.GOOGLE_VERIFICATION_REDIRECT_URI,
                    grant_type:'authorization_code', code_verifier:record.verifier }) });
            if (!response.ok) throw new Error();
            await verifyGoogleToken((await response.json()).id_token, this.env, record.nonce, record.subject);
            // Recheck the live Clerk session and currently linked Google identity.
            const session = await clerkAPI(this.env, 'sessions/'+encodeURIComponent(record.sessionId));
            const user = await clerkAPI(this.env, 'users/'+encodeURIComponent(record.userId));
            if (session.status !== 'active' || session.user_id !== record.userId ||
                !user.external_accounts?.some(account => ['oauth_google','google'].includes(account.provider) &&
                    account.verification?.status === 'verified' && String(account.provider_user_id) === record.subject)) throw new Error();
            success = true;
        } catch { /* Never return provider tokens, secrets, or detailed errors in URLs. */ }
        await this.storage.transaction(async tx => {
            const current = await tx.get(key);
            if (!current || current.version !== VERIFICATION_VERSION || current.status !== 'checking') return;
            current.status = success && current.expires > Date.now() ? 'verified' : 'failed';
            delete current.verifier; delete current.nonce; delete current.subject;
            await tx.put(key,current);
        });
        const fragment = record.action === 'delete-account' ? 'delete-verification' : 'key-verification';
        return new Response(null, {status:303,headers:{Location:record.origin+'/settings.html#'+fragment+'='+id,
            'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
}

export const RECOVERY_MS = 7 * 86400000;
const secretPattern = /^[a-f0-9]{64}$/;
const accountKey = user => 'account:'+encodeURIComponent(user);
export class AccountDeletion {
    constructor(service) { this.service=service; this.storage=service.storage; this.env=service.env; this.running=false; }
    async marker(identity) { return this.storage.get('deleted-identity:'+await sha256(identity.userId)); }
    async status(receipt) {
        if (typeof receipt !== 'string' || !secretPattern.test(receipt)) throw new SecurityError(404,'Deletion receipt was not found.');
        const record=await this.storage.get('deletion-status:'+await sha256(receipt));
        if (!record || (record.expires && record.expires<=Date.now())) throw new SecurityError(404,'Deletion receipt expired or was not found.');
        return { accepted:true, status:record.status, complete:record.status==='complete',
            accepted_at:record.accepted_at, completed_at:record.completed_at || null,
            phone_recovery_until:record.phone_recovery_until, legacy_review_needed:record.legacy_review_needed===true,
            migration_approval_remains:record.migration_approval_remains===true };
    }
    async accept(request, identity, body) {
        if (this.env.ACCOUNT_DELETION_ENABLED !== 'true') throw new SecurityError(503,'Account deletion needs one-time setup. Follow PHASE-1-SETUP.txt.');
        if (identity.actor) throw new SecurityError(403,'Impersonated sessions cannot delete accounts.');
        if (body.blocker_disabled !== true || body.phrase !== 'Macrodroid disabled') {
            throw new SecurityError(400,'Disable blocking on every device, check the confirmation, and type Macrodroid disabled exactly.');
        }
        if (!secretPattern.test(body.receipt || '')) throw new SecurityError(400,'A deletion receipt is required.');
        const previous=await this.marker(identity);
        if (previous) return { accepted:true, receipt:previous.receipt || body.receipt,
            status:previous.status, phone_recovery_until:previous.phone_recovery_until };
        const proof=await this.service.verification.get(body.verification_id,identity);
        if (proof.status!=='verified') throw new SecurityError(403,'Verify your password or Google account before deleting.');
        const statusHash=await sha256(body.receipt), markerKey='deleted-identity:'+await sha256(identity.userId);
        const accepted=Date.now(), recoveryUntil=accepted+RECOVERY_MS;
        await this.storage.transaction(async tx=>{
            if (await tx.get(markerKey)) return;
            if (await tx.get('deletion-status:'+statusHash)) throw new SecurityError(409,'This receipt is already in use. Start again.');
            const proofKey='action-proof:'+await sha256(body.verification_id), current=await tx.get(proofKey);
            if (!current || current.status!=='verified' || current.expires<=Date.now() ||
                current.userId!==identity.userId || current.sessionId!==identity.sessionId || current.action!=='delete-account') {
                throw new SecurityError(403,'Verification was already used or expired. Start again.');
            }
            const link=await tx.get('identity:'+identity.userId);
            const meta=link ? await tx.get(accountKey(link.user)) : null;
            if (!meta || meta.owner_id!==identity.userId) throw new SecurityError(403,'Account ownership could not be verified.');
            await this.service.universe.blockAccount(identity.userId);
            meta.deleting=true; await tx.put(accountKey(link.user),meta);
            let approvalRemains=false;
            if (meta.legacy_disabled) {
                try { approvalRemains=Object.hasOwn(JSON.parse(this.env.LEGACY_MIGRATION_OWNERS || '{}'),link.user); }
                catch { approvalRemains=true; }
            }
            const active=await tx.get('phone-owner:'+encodeURIComponent(link.user));
            if (active) {
                // A recovery record contains only a digest-keyed, status-only expiry.
                await tx.put('phone:'+active.digest,{scope:'deleted-unlock',expires:recoveryUntil});
                await tx.delete('phone-owner:'+encodeURIComponent(link.user));
            }
            current.status='consumed'; await tx.put(proofKey,current);
            await tx.put(markerKey,{status:'pending',receipt:body.receipt,phone_recovery_until:recoveryUntil});
            if (meta.legacy_disabled) await tx.put('deleted-legacy:'+await sha256(link.user),{expires:recoveryUntil});
            await tx.put('deletion-status:'+statusHash,{status:'pending',accepted_at:accepted,phone_recovery_until:recoveryUntil});
            await tx.put('deletion-job:'+statusHash,{userId:identity.userId,user:link.user,statusHash,markerKey,
                legacy:meta.legacy_disabled===true,migration_approval_remains:approvalRemains,
                stage:'snapshots',cursor:null,legacy_cursor:null,
                accepted_at:accepted,phone_recovery_until:recoveryUntil});
        });
        await this.service.ensureAlarm(1000);
        // Return acceptance before external cleanup can revoke the browser session.
        return { accepted:true, receipt:body.receipt,status:'pending',phone_recovery_until:recoveryUntil };
    }
    async page(job,prefix,match) {
        const entries=await this.storage.list({prefix,limit:100,...(job.cursor?{startAfter:job.cursor}:{})});
        const keys=[...entries].filter(([key,value])=>!match || match(value,key)).map(([key])=>key);
        if (keys.length) await this.storage.delete(keys);
        job.cursor=entries.size ? [...entries.keys()].pop() : null;
        return entries.size<100;
    }
    async legacy(job) {
        if (!job.legacy) return true;
        const kv=this.env.TASKITATOR_KV;
        if (!kv?.list || !kv?.delete) throw new SecurityError(503,'Legacy storage cleanup is unavailable.');
        // The registration identifies its current snapshot even if that snapshot is malformed.
        if (!job.registration_deleted) {
            let registration;
            try { registration=await kv.get('user_reg:'+job.user,{type:'json'}); }
            catch { job.unreadable_legacy=true; }
            const token=typeof registration==='string'?registration:registration?.token_hash;
            if (typeof token==='string' && secretPattern.test(token)) await kv.delete('user_data:'+token);
            await kv.delete('user_reg:'+job.user);
            job.registration_deleted=true;
        }
        const page=await kv.list({prefix:'user_data:',limit:15,...(job.legacy_cursor?{cursor:job.legacy_cursor}:{})});
        for (const key of page.keys) {
            let record;
            try { record=await kv.get(key.name,{type:'json'}); }
            catch { job.unreadable_legacy=true; continue; }
            // Never delete a different user's data or guess ownership of corrupt records.
            const owner=record?.username || record?.settings?.worker_username;
            if (typeof owner==='string' && owner.trim().toLowerCase()===job.user) await kv.delete(key.name);
        }
        job.legacy_cursor=page.cursor || null;
        return page.list_complete===true;
    }
    async deleteClerk(userId) {
        const response=await fetch('https://api.clerk.com/v1/users/'+encodeURIComponent(userId),{
            method:'DELETE',headers:{Authorization:'Bearer '+this.env.CLERK_SECRET_KEY},signal:AbortSignal.timeout(10000)});
        if (!response.ok && response.status!==404) throw new SecurityError(503,'Authentication account cleanup is retrying.');
    }
    async run() {
        if (this.running) return;
        this.running=true;
        try {
            const jobs=await this.storage.list({prefix:'deletion-job:',limit:5});
            for (const [key,job] of jobs) {
                try {
                    let next=false;
                    if (job.stage==='snapshots') next=await this.page(job,'snapshot:'+encodeURIComponent(job.user)+':');
                    else if (job.stage==='credentials') next=await this.page(job,'credential:',value=>value?.user===job.user);
                    else if (job.stage==='proofs') next=await this.page(job,'action-proof:',value=>value?.userId===job.userId);
                    else if (job.stage==='vault') next=await this.page(job,'vault:'+await sha256(job.userId)+':');
                    else if (job.stage==='vault-stages') next=await this.page(job,'vault-stage:'+await sha256(job.userId)+':');
                    else if (job.stage==='hosted') next=await this.page(job,'pro:',(value,key)=>
                        ['pro:usage:','pro:spend:','pro:op:'].some(prefix=>key.startsWith(prefix+job.userId+':')) ||
                        key==='pro:user:username:'+job.userId || key==='pro:entitlement:'+job.userId ||
                        key==='pro:emergency:'+job.userId || key==='pro:preview:'+job.userId || key==='pro:quote-index:'+job.userId ||
                        (key.startsWith('pro:binding:') && value?.account_id===job.userId) ||
                        (key.startsWith('pro:username:map:') && value?.accountId===job.userId) ||
                        (key.startsWith('pro:attestation:') && value?.account_id===job.userId));
                    else if (job.stage==='legacy') {await this.storage.delete('sleep-lock:'+job.userId);next=await this.page(job,'sleep-delay:'+job.userId+':')&&await this.legacy(job);}
                    else if (job.stage==='clerk') {
                        if(this.env.TASKITATOR_DB){
                            try{await this.env.TASKITATOR_DB.prepare('DELETE FROM entitlements WHERE account_id = ?').bind(job.userId).run();}
                            catch(error){if(!/no such table: entitlements/i.test(error.message||''))throw error;}
                        }
                        await this.deleteClerk(job.userId);
                        const completed=Date.now(), expires=completed+RECOVERY_MS;
                        await this.storage.transaction(async tx=>{
                            await tx.delete([accountKey(job.user),'identity:'+job.userId,
                                'rate:connect-user:'+job.userId,'rate:verify-user:'+job.userId,
                                'rate:ai-user:'+job.userId,'rate:key-test:'+job.userId,
                                'vault-cleanup:'+await sha256(job.userId)]);
                            await tx.put('deletion-status:'+job.statusHash,{status:'complete',accepted_at:job.accepted_at,
                                completed_at:completed,phone_recovery_until:job.phone_recovery_until,
                                legacy_review_needed:job.unreadable_legacy===true,
                                migration_approval_remains:job.migration_approval_remains===true,expires});
                            await tx.put(job.markerKey,{status:'complete',phone_recovery_until:job.phone_recovery_until,expires});
                            await tx.delete(key);
                        });
                        continue;
                    }
                    if (next) {
                        job.stage=({snapshots:'credentials',credentials:'proofs',proofs:'vault',vault:'vault-stages','vault-stages':'hosted',hosted:'legacy',legacy:'clerk'})[job.stage];
                        job.cursor=null;
                    }
                    await this.storage.put(key,job);
                } catch {
                    // Persist stage/cursor only after successful operations. All steps
                    // tolerate replay; accepted accounts remain inaccessible on failure.
                    await this.storage.put('deletion-status:'+job.statusHash,{status:'retrying',accepted_at:job.accepted_at,
                        phone_recovery_until:job.phone_recovery_until});
                }
            }
        } finally { this.running=false; }
    }
}

export const AI_MODELS = PROVIDERS.gemini.models;
export const MAX_AI_BYTES = 20 * 1024 * 1024;
export const secretFields = ['gemini_api_key','claude_api_key','worker_passkey','session_token','phone_token','macro_token','auth_user_id'];
export function scrubSettings(settings) {
    const clean={...(settings||{})}; for(const field of secretFields)delete clean[field]; return clean;
}
const encodeVaultB64=bytes=>btoa(String.fromCharCode(...bytes));
const decodeVaultB64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
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
    ready(){try{const {keys,active}=this.configuration();return decodeVaultB64(keys[active]).length===32;}catch{return false;}}
    async cryptoKey(kid){
        try{
            const {keys}=this.configuration();
            if(!Object.hasOwn(keys,kid) || typeof keys[kid]!=='string')throw new Error();
            const bytes=decodeVaultB64(keys[kid]);if(bytes.length!==32)throw new Error();
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
        return {...record,iv:encodeVaultB64(iv),ciphertext:encodeVaultB64(new Uint8Array(ciphertext))};
    }
    async unseal(identity,record,provider='gemini'){
        if(!record?.ciphertext || !['active','stage'].includes(record.kind))throw new SecurityError(404,'No saved key is available.');
        if((record.provider||'gemini')!==providerId(provider))throw new SecurityError(503,'Saved key provider does not match this record. No key was returned or replaced.');
        const key=await this.cryptoKey(record.kid);
        try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decodeVaultB64(record.iv),
            additionalData:this.aad(identity,record),tagLength:128},key,decodeVaultB64(record.ciphertext)));}
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
    const allowed=new Set(['contents','systemInstruction','system_instruction','generationConfig','tools','toolConfig','tool_config','safetySettings','taskitatorFormat','taskitatorTask']);
    if(Object.keys(payload).some(key=>!allowed.has(key)))throw new SecurityError(400,'Unsupported AI request options.');
    if(payload.taskitatorFormat && !['criteria','proof','notes'].includes(payload.taskitatorFormat))throw new SecurityError(400,'Unsupported AI output format.');
    if(payload.taskitatorTask !== undefined && (!payload.taskitatorTask || typeof payload.taskitatorTask !== 'object' || Array.isArray(payload.taskitatorTask))) {
        throw new SecurityError(400,'Invalid taskitatorTask metadata.');
    }
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

// File: worker.js
const Recurrence = globalThis.TaskitatorRecurrence;
// Taskitator transactional sync. Required: TASKITATOR_SYNC (Durable Object).
// Keep TASKITATOR_KV bound for one-time migration of existing accounts.
// New reads and writes use Durable Object storage exclusively.
const CORS = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-ID',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
};
const DAY = 86400000;
const OFFSET = 3 * 3600000; // Riyadh UTC+3, matching the original Worker.
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
});
class HTTPError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
function dayHour(settings) {
    const hour = Number.parseInt(settings?.day_start_hour, 10);
    return Number.isInteger(hour) && hour >= 0 && hour <= 4 ? hour : 0;
}
function logicalDate(time, hour) {
    return new Date(time + OFFSET - hour * 3600000).toISOString().slice(0, 10);
}
function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
    // Require an explicit timezone; avoid interpreting ambiguous local timestamps.
    return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
        ? Date.parse(value) : NaN;
}
export function evaluateStatus(record, now = Date.now()) {
    if (!record) return { status: 'ok', device_unlocked: true, finished: true,
        in_break: false, message: 'No tasks configured; unlocked by default.' };
    if (!object(record) || !Array.isArray(record.tasks)) {
        throw new HTTPError(500, 'Stored task snapshot is malformed. Restore a valid snapshot.');
    }
    const hour = dayHour(record.settings);
    const today = logicalDate(now, hour);
    const byId = new Map(record.tasks.filter(object).map(task => [task.id, task]));
    function effectiveDue(task) {
        const visited = new Set();
        while (task) {
            if (visited.has(task)) return ''; // Broken trees retain the existing blocking fallback.
            visited.add(task);
            const due = typeof task.due_date === 'string' ? task.due_date.trim().toLowerCase() : '';
            if (due) return due;
            task = byId.get(task.parent_id);
        }
        return '';
    }
    const unfinished = record.tasks.some(task => {
        if (!object(task)) return true; // Corrupt entries must not silently unlock.
        if (task.status !== 'active') return false;
        const due = effectiveDue(task);
        // Undated subtasks inherit the nearest dated ancestor. Standalone undated
        // tasks retain their existing behavior; explicit subtask dates take priority.
        return !due || due === 'today' || (validDate(due) && due <= today);
    });
    const inBreak = globalThis.TaskitatorBreaks.active(record.today_breaks,record.settings||{},now);
    return { status: 'ok', device_unlocked: !unfinished || inBreak,
        finished: !unfinished, in_break: inBreak };
}
export function sleepWindow(schedule, now = Date.now()) {
    const valid=t=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if(!schedule?.enabled||!valid(schedule.bedtime)||!valid(schedule.wake_time)||schedule.bedtime===schedule.wake_time)return null;
    const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),start=minutes(schedule.bedtime),end=minutes(schedule.wake_time);
    const dayMs=86400000,local=now+3*3600000,current=new Date(local).getUTCHours()*60+new Date(local).getUTCMinutes();let day=Math.floor(local/dayMs)*dayMs;
    if(start>end&&current<end)day-=dayMs;
    if(start<end&&current>=end)day+=dayMs;
    return {day:new Date(day).toISOString().slice(0,10),start:day-3*3600000+start*60000,end:day-3*3600000+end*60000+(start>end?dayMs:0)};
}
export function sleepLockActive(schedule, now = Date.now(), delay = null) {
    const w=sleepWindow(schedule,now);if(!w)return false;
    const minutes=delay?.day===w.day&&[30,60].includes(delay.minutes)?delay.minutes:0;
    return now>=w.start+minutes*60000&&now<w.end;
}
function publicRecord(record) {
    if (!object(record)) return record;
    const result = { ...record };
    // The client already has its bearer credential; do not echo it in snapshots.
    if (object(result.settings)) {
        result.settings = scrubSettings(result.settings);
    }
    delete result.force;
    delete result.base_version;
    delete result.mutation_id;
    delete result.new_token;
    delete result.rotation_id;
    delete result.snapshot;
    return result;
}

const CHUNK_CHARS = 24576; // Safely below the 128 KiB storage-value limit.

const tokenKey = digest => `credential:${digest}`;
const chunkKey = (user, index) => `snapshot:${encodeURIComponent(user)}:${index}`;

const cleanToken = token => /^[a-fA-F0-9]{64}$/.test(token) ? token.toLowerCase() : token;

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
    if (Number(request.headers.get('Content-Length')) > maxBytes) {
        throw new HTTPError(413, 'Request payload is too large.');
    }
    if (!request.body) throw new HTTPError(400, 'JSON body required.');
    const reader = request.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new HTTPError(413, 'Request payload is too large.');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(text); } catch { throw new HTTPError(400, 'Invalid JSON.'); }
    if (!object(body)) throw new HTTPError(400, 'JSON object required.');
    return body;
}

function validateUser(user) {
    if (!user || new TextEncoder().encode(user).length > 240 || /[\x00-\x1f\x7f]/.test(user)) {
        throw new HTTPError(400, 'A valid X-Taskitator-User header is required.');
    }
}

function validateVersion(body) {
    if (!Number.isSafeInteger(body.base_version) || body.base_version < 0) {
        throw new HTTPError(428, 'Update the sync engine: base_version is required.');
    }
}

function validateSnapshot(body, user) {
    if (!Array.isArray(body.tasks) || body.tasks.some(t => !object(t))) {
        throw new HTTPError(400, 'tasks must be an array of objects.');
    }
    if (body.username != null && (typeof body.username !== 'string' || body.username.trim().toLowerCase() !== user)) {
        throw new HTTPError(400, 'Payload username does not match the authenticated account.');
    }
    if (body.settings !== undefined && !object(body.settings)) throw new HTTPError(400, 'Invalid settings.');
    if (body.today_breaks !== undefined && !Array.isArray(body.today_breaks) && !object(body.today_breaks)) {
        throw new HTTPError(400, 'Invalid break records.');
    }
    if (typeof body.mutation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.mutation_id)) {
        throw new HTTPError(428, 'Update the sync engine: mutation_id is required.');
    }
    if (body.recurrence_state !== undefined) {
        try { Recurrence.validateState(body.recurrence_state, body.tasks); }
        catch (err) { throw new HTTPError(400, err.message); }
    }
    return publicRecord({ ...body, username: user });
}

async function loadSnapshot(storage, user, meta) {
    if (!meta.has_snapshot) return null;
    const parts = [];
    for (let i = 0; i < meta.chunks; i += 128) {
        const keys = Array.from({ length: Math.min(128, meta.chunks - i) }, (_, j) => chunkKey(user, i + j));
        const values = await storage.get(keys);
        for (const key of keys) {
            if (typeof values.get(key) !== 'string') throw new HTTPError(503, 'Stored snapshot is incomplete.');
            parts.push(values.get(key));
        }
    }
    const record = JSON.parse(parts.join(''));
    return { ...record, version: meta.version, saved_at: meta.saved_at };
}

async function saveSnapshot(storage, user, meta, record) {
    const text = JSON.stringify(record), count = Math.ceil(text.length / CHUNK_CHARS);
    for (let i = 0; i < count; i += 128) {
        const entries = {};
        for (let j = i; j < Math.min(count, i + 128); j++) {
            entries[chunkKey(user, j)] = text.slice(j * CHUNK_CHARS, (j + 1) * CHUNK_CHARS);
        }
        await storage.put(entries);
    }
    for (let i = count; i < (meta.chunks || 0); i += 128) {
        await storage.delete(Array.from({ length: Math.min(128, meta.chunks - i) }, (_, j) => chunkKey(user, i + j)));
    }
    meta.chunks = count;
    meta.has_snapshot = true;
}

function conflict(version) {
    return json({ error: 'Another device changed this account. Your local edits have not been uploaded.',
        conflict: true, remote_version: version }, 409);
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin');
        if (origin && !allowedOrigins(env).includes(origin)) return json({ error: 'Origin is not allowed.' }, 403);
        let response;
        if (request.method === 'OPTIONS') response = new Response(null, { status: 204, headers: CORS });
        else if (!env.TASKITATOR_SYNC) response = json({ error: 'TASKITATOR_SYNC Durable Object binding is required.' }, 503);
        else {
            const id = env.TASKITATOR_SYNC.idFromName('taskitator-v1');
            try { response = await env.TASKITATOR_SYNC.get(id).fetch(request); }
            catch { response = json({ error: 'Sync service unavailable. Local edits were retained; retry shortly.' }, 503); }
        }
        const headers = new Headers(response.headers);
        if (origin) headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        return new Response(response.body, { status: response.status, headers });
    }
};

export class TaskitatorSync {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;
        this.verification = new ActionVerification(this);
        this.deletion = new AccountDeletion(this);
        this.vault = new KeyVault(this);
        this.ai = new AIGateway(this);
        this.protection = new TaskProtection(this);
        this.pro = new ProGateway(this);
        this.universe = new UniverseRelease(this);
    }

    async readTaskSnapshot(store, accountId) {
        const {link,meta}=await liveAccount(store,accountId);
        return {snapshot:await loadSnapshot(store,link.user,meta),meta,user:link.user};
    }
    async writeTaskSnapshot(tx,accountId,snapshot) {
        const {link,meta}=await liveAccount(tx,accountId);
        if(meta.version>=Number.MAX_SAFE_INTEGER)throw new HTTPError(503,'Account revision limit reached.');
        meta.version++;meta.saved_at=new Date().toISOString();snapshot.updated_at=meta.saved_at;
        delete meta.last_write;
        await saveSnapshot(tx,link.user,meta,snapshot);await tx.put(accountKey(link.user),meta);
        return meta.version;
    }

    async migrateVault(identity) {
        if (!this.vault.ready()) return;
        await this.storage.transaction(async tx => {
            const link = await this.vault.assertOwner(tx,identity);
            const meta = await tx.get(accountKey(link.user));
            const record = await loadSnapshot(tx,link.user,meta);
            if (record?.settings) {
                const raw = record.settings.gemini_api_key;
                const vaultKey = await this.vault.recordKey(identity);
                // Only a previously stored, owned cloud snapshot may initialize an
                // empty vault. Ordinary sync requests can never change a vault key.
                if (typeof raw === 'string' && raw.trim() && !await tx.get(vaultKey)) {
                    const value=this.vault.recoveredKey(raw);
                    let valid=true;try{this.vault.validateKey(value);}catch{valid=false;}
                    if (valid) await tx.put(vaultKey,await this.vault.seal(identity,value));
                    else await tx.put(await this.vault.stagePrefix(identity)+await sha256(value),await this.vault.seal(identity,value,'stage'));
                }
                const claude = record.settings.claude_api_key;
                if (typeof claude === 'string' && claude.trim()) {
                    const archiveKey='vault:'+await this.vault.prefix(identity)+':claude-archive';
                    if (!await tx.get(archiveKey)) await tx.put(archiveKey,await this.vault.seal(identity,this.vault.recoveredKey(claude),'active','claude'));
                }
                if ('gemini_api_key' in record.settings || 'claude_api_key' in record.settings) {
                    await saveSnapshot(tx,link.user,meta,publicRecord(record));
                    await tx.put(accountKey(link.user),meta);
                }
            }
            if (meta.legacy_disabled && !meta.vault_legacy_cleanup_queued) {
                await tx.put('vault-cleanup:'+await this.vault.prefix(identity),{userId:identity.userId,user:link.user,cursor:null});
                meta.vault_legacy_cleanup_queued=true;await tx.put(accountKey(link.user),meta);
            }
            await this.vault.recoverClaudeArchives(tx,identity);
        });
        await this.ensureAlarm(15000);
    }

    async importAccount(user, token, digest) {
        const deletedLegacyKey = 'deleted-legacy:' + await sha256(user);
        const deletedLegacy = await this.storage.get(deletedLegacyKey);
        if (deletedLegacy?.expires > Date.now()) throw new HTTPError(410, 'This legacy account has been deleted.');
        if (await this.storage.get(accountKey(user))) return;
        if (!this.env.TASKITATOR_KV) throw new HTTPError(503, 'Keep TASKITATOR_KV bound for account migration.');
        // Read legacy KV only when this account has never been imported.
        // Historical key fields are scrubbed by the vault migration after linking.
        let registration = null, record = null;
        if (this.env.TASKITATOR_KV) {
            [registration, record] = await Promise.all([
                this.env.TASKITATOR_KV.get(`user_reg:${user}`, { type: 'json' }),
                this.env.TASKITATOR_KV.get(`user_data:${token}`, { type: 'json' })
            ]);
        }
        const legacyToken = typeof registration === 'string' ? registration : registration?.token_hash;
        if (!registration && !record) throw new HTTPError(401, 'Existing account could not be verified.');
        if (registration && cleanToken(String(legacyToken || '')) !== token) throw new HTTPError(401, 'Incorrect credentials.');
        const owner = record?.username || record?.settings?.worker_username;
        if (record && (typeof owner !== 'string' || owner.trim().toLowerCase() !== user)) {
            throw new HTTPError(401, 'Legacy data does not belong to this username.');
        }
        if (record && (!object(record) || !Array.isArray(record.tasks))) {
            throw new HTTPError(503, 'Legacy snapshot is malformed; restore a backup before migration.');
        }
        await this.storage.transaction(async tx => {
            if ((await tx.get(deletedLegacyKey))?.expires > Date.now()) throw new HTTPError(410, 'This legacy account has been deleted.');
            if (await tx.get(accountKey(user))) return;
            const occupied = await tx.get(tokenKey(digest));
            if (occupied) throw new HTTPError(401, 'Credential already belongs to an account.');
            const meta = {
                user, digest, version: record ? (Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 1) : 0,
                created_at: registration?.created_at || new Date().toISOString(),
                saved_at: record?.saved_at || new Date().toISOString(),
                has_snapshot: false, chunks: 0
            };
            if (record) {
                const imported=publicRecord(record);
                // Retain keys internally until their authenticated owner can encrypt
                // them. publicRecord always strips these fields from responses.
                for (const field of ['gemini_api_key','claude_api_key']) {
                    if (record.settings?.[field]) (imported.settings ||= {})[field]=record.settings[field];
                }
                await saveSnapshot(tx,user,meta,imported);
            }
            await tx.put(accountKey(user), meta);
            await tx.put(tokenKey(digest), { user, revoked: false });
        });
    }

    async rateLimit(request, scope = 'api', max = 240) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        await this.rateBucket(scope + ':' + await sha256(ip), max);
    }

    async rateBucket(key, max) {
        await this.storage.transaction(async tx => {
            const now = Date.now(), storageKey = 'rate:' + key;
            let entry = await tx.get(storageKey);
            if (!entry || entry.expires <= now) entry = { count: 0, expires: now + 60000 };
            if (entry.count >= max) throw new HTTPError(429, 'Too many attempts. Wait one minute and try again.');
            entry.count++;
            await tx.put(storageKey, entry);
        });
        await this.ensureAlarm();
    }

    async ensureAlarm(delay = 3600000) {
        if (!this.storage.getAlarm) return;
        const at = Date.now() + delay, existing = await this.storage.getAlarm();
        if (!existing || existing > at) await this.storage.setAlarm(at);
    }

    async alarm() {
        await this.vault.cleanupLegacy();
        await this.deletion.run();
        const moreAuditCleanup=await this.pro.audits.cleanup();
        let moreUniverseCleanup=false;
        try{moreUniverseCleanup=await this.universe.cleanup();}catch{moreUniverseCleanup=true;}
        let after;
        while (true) {
            const entries = await this.storage.list({ prefix: 'rate:', limit: 1000, ...(after ? {startAfter: after} : {}) });
            if (!entries.size) break;
            const expired = [...entries].filter(([, value]) => value.expires <= Date.now()).map(([key]) => key);
            if (expired.length) await this.storage.delete(expired);
            after = [...entries.keys()].pop();
            if (entries.size < 1000) break;
        }
        for (const prefix of ['action-proof:', 'verification-used:', 'deleted-identity:', 'deleted-legacy:', 'deletion-status:', 'phone:', 'sleep-delay:']) {
            let cursor;
            while (true) {
                const entries = await this.storage.list({prefix,limit:1000,...(cursor?{startAfter:cursor}:{})});
            const expired = [...entries].filter(([,value]) => value?.expires && value.expires <= Date.now()).map(([key]) => key);
                if (expired.length) await this.storage.delete(expired);
                if (entries.size < 1000) break;
                cursor = [...entries.keys()].pop();
            }
        }
        const pending = await this.storage.list({prefix:'deletion-job:',limit:1});
        const cleanup = await this.storage.list({prefix:'vault-cleanup:',limit:1});
        await this.storage.setAlarm(Date.now() + (pending.size || cleanup.size || moreAuditCleanup || moreUniverseCleanup ? 15000 : 3600000));
    }

    async accountFor(identity) {
        if (await this.deletion.marker(identity)) throw new HTTPError(410, 'Account deletion has been accepted.');
        const link = await this.storage.get('identity:' + identity.userId);
        if (!link) return null;
        const meta = await this.storage.get(accountKey(link.user));
        if (!meta || meta.deleting || meta.owner_id !== identity.userId) throw new HTTPError(403, 'Account ownership could not be verified.');
        const usernameRec = await this.storage.get('pro:user:username:' + identity.userId);
        if (usernameRec?.normalizedUsername) {
            const owner=await this.storage.get('pro:username:map:'+usernameRec.normalizedUsername);
            if (owner?.accountId===identity.userId) link.username=usernameRec.username;
            else delete link.username;
        }
        return link;
    }

    async connectAccount(request, identity) {
        await this.rateLimit(request, 'connect', 8);
        await this.rateBucket('connect-user:' + identity.userId, 8);
        const body = await readJson(request, 8192);
        const existing = await this.accountFor(identity);
        if (existing) return json({ success: true, account: existing });
        const email = await verifiedEmail(this.env, identity.userId);
        if (body.mode === 'create') {
            const user = 'clerk:' + await sha256(identity.userId);
            const link = { user, display_name: email, user_id: identity.userId };
            await this.storage.transaction(async tx => {
                if (await tx.get('identity:' + identity.userId)) return;
                if (await tx.get(accountKey(user))) throw new HTTPError(409, 'Account identifier is already occupied. Contact the app owner.');
                await tx.put(accountKey(user), { user, owner_id: identity.userId, version: 0,
                    created_at: new Date().toISOString(), saved_at: new Date().toISOString(), has_snapshot: false, chunks: 0 });
                await tx.put('identity:' + identity.userId, link);
            });
            return json({ success: true, account: await this.accountFor(identity) });
        }
        if (body.mode !== 'migrate') throw new HTTPError(400, 'Choose an existing or a new account.');
        const user = String(body.username || '').trim().toLowerCase();
        validateUser(user);
        if (typeof body.password !== 'string' || !body.password || body.password.length > 1024) {
            throw new HTTPError(401, 'Existing account could not be verified.');
        }
        // Administrator-prepared email ownership map stops a stolen legacy bearer
        // credential from being enough to claim an account during migration.
        let owners;
        try { owners = JSON.parse(this.env.LEGACY_MIGRATION_OWNERS || '{}'); }
        catch { throw new HTTPError(503, 'Legacy migration ownership settings are invalid.'); }
        if (!object(owners) || !Object.hasOwn(owners, user) || String(owners[user]).trim().toLowerCase() !== email) {
            throw new HTTPError(403, 'This account is not approved for migration to your verified email. Ask the app owner to check migration settings.');
        }
        const deadline = Date.parse(this.env.LEGACY_MIGRATION_UNTIL || '');
        if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new HTTPError(403, 'Legacy migration is closed. Ask the app owner for assistance.');
        const token = await sha256(user + ':' + body.password.trim() + ':taskitator-client-v1');
        const digest = await sha256(token);
        await this.importAccount(user, token, digest);
        await this.storage.transaction(async tx => {
            const linked = await tx.get('identity:' + identity.userId);
            if (linked) {
                if (linked.user !== user) throw new HTTPError(409, 'This login is already connected to another account.');
                return;
            }
            const meta = await tx.get(accountKey(user));
            if (!meta || meta.digest !== digest || (meta.owner_id && meta.owner_id !== identity.userId)) {
                throw new HTTPError(401, 'Existing account could not be verified.');
            }
            meta.owner_id = identity.userId;
            meta.legacy_disabled = true;
            delete meta.digest;
            delete meta.rotation;
            await tx.put(tokenKey(digest), { user, revoked: true });
            await tx.put(accountKey(user), meta);
            await tx.put('identity:' + identity.userId, { user, display_name: user, user_id: identity.userId });
        });
        return json({ success: true, account: await this.accountFor(identity) });
    }

    async phoneAccess(request, user) {
        const key = 'phone-owner:' + encodeURIComponent(user);
        if (request.method === 'GET') {
            const current = await this.storage.get(key);
            return json({ active: Boolean(current), created_at: current?.created_at || null });
        }
        await this.rateLimit(request, 'phone-admin', 10);
        const token = request.method === 'POST' ? randomPhoneToken() : null;
        const digest = token ? await sha256(token) : null;
        const created_at = new Date().toISOString();
        await this.storage.transaction(async tx => {
            const previous = await tx.get(key);
            if (previous) await tx.delete('phone:' + previous.digest);
            await tx.delete(key);
            if (token) {
                await tx.put('phone:' + digest, { user, scope: 'status' });
                await tx.put(key, { digest, created_at });
            }
        });
        return json({ success: true, ...(token ? { token, created_at } : {}) });
    }

    async fetch(request) {
        try {
            const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
            const method = request.method;
            if (method === 'GET' && path === '/auth/verification/google/callback') {
                await this.rateLimit(request, 'google-callback', 30);
                return await this.verification.callback(request);
            }
            if (!['GET', 'POST', 'DELETE'].includes(method)) return json({ error: 'Method not allowed.' }, 405);
            if (request.headers.get('Origin') && !allowedOrigins(this.env).includes(request.headers.get('Origin'))) {
                throw new HTTPError(403, 'Origin is not allowed.');
            }
            const status = method === 'GET' && (path === '/status' ||
                (url.searchParams.get('action') === 'status' && ['/', '/sync/pull'].includes(path)));
            const pull = method === 'GET' && ['/', '/sync/pull'].includes(path) && !status;
            const push = method === 'POST' && ['/', '/sync/push'].includes(path);
            const bridge = method === 'GET' && path === '/sync/bridge/mrstudy-rules';
            const me = method === 'GET' && path === '/auth/me';
            const connect = method === 'POST' && path === '/auth/account';
            const phoneAdmin = ['GET', 'POST', 'DELETE'].includes(method) && path === '/auth/phone';
            const proofStart = method === 'POST' && path === '/auth/verification/start';
            const proofPassword = method === 'POST' && path === '/auth/verification/password';
            const proofStatus = method === 'POST' && path === '/auth/verification/status';
            const deletion = method === 'DELETE' && path === '/auth/account';
            const deletionStatus = method === 'POST' && path === '/auth/deletion/status';
            const keyRoute = ['/ai/keys','/ai/keys/stage','/ai/keys/reveal','/ai/keys/test','/ai/generate','/ai/provider'].includes(path);
            const emergencyRoute = ['/emergency','/pro/emergency'].includes(path);
            const proRoute = path.startsWith('/pro/') && !emergencyRoute;
            const universeRoute = path.startsWith('/universe/');
            const sleepRoute = path === '/sleep-lock';
            if (!status && !pull && !push && !bridge && !me && !connect && !phoneAdmin &&
                !proofStart && !proofPassword && !proofStatus && !deletion && !deletionStatus && !keyRoute && !proRoute && !emergencyRoute && !universeRoute && !sleepRoute) {
                return json({ error: 'Endpoint not found. Password changes are managed through your account profile.' }, 404);
            }
            await this.rateLimit(request);
            if (deletionStatus) return json(await this.deletion.status((await readJson(request,8192)).receipt));
            if (path === '/pro/username/resolve' && method === 'POST') {
                return await this.pro.resolveUsername(await readJson(request, 4096));
            }
            const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') || '')?.[1];
            if (!token) throw new HTTPError(401, 'Sign in to continue.');
            let user, identity;
            if (/^tkp_[a-f0-9]{64}$/.test(token)) {
                if (!status) throw new HTTPError(403, 'Phone tokens can only read unlock status.');
                const access = await this.storage.get('phone:' + await sha256(token));
                if (access?.scope === 'deleted-unlock' && access.expires > Date.now()) {
                    return url.searchParams.get('format') === 'text'
                        ? new Response('device_unlocked = true', {headers:{...CORS,'Content-Type':'text/plain; charset=utf-8'}})
                        : json({status:'ok',device_unlocked:true,finished:true,in_break:false,account_deleted:true,
                            recovery_until:access.expires});
                }
                if (!access || access.scope !== 'status') throw new HTTPError(401, 'Phone access was revoked or is invalid.');
                user = access.user;
            } else {
                identity = await verifySession(request, this.env, token);
                if (universeRoute) {
                    await this.rateLimit(request,'universe:'+identity.userId,60);
                    const upload=/^\/universe\/groups\/[A-Za-z0-9_-]+\/work\/files\/[A-Za-z0-9_-]+\/upload$/.test(path);
                    const transfer=path==='/universe/imports'||/^\/universe\/(?:imports|groups\/[^/]+\/(?:transfer|archive))\/[^/]+\/file$/.test(path);
                    return json(await this.universe.handle(identity,path,method,method==='GET'?{}:await readJson(request,upload?8*1024*1024:transfer?21*1024*1024:16384)));
                }
                if (proRoute) {
                    const account = await this.accountFor(identity);
                    return await this.pro.handleRequest(request, path, method, identity, account || { user: identity.userId });
                }
                if (deletion) return json(await this.deletion.accept(request, identity, await readJson(request,8192)));
                const deleting = await this.deletion.marker(identity);
                if (deleting) {
                    if (me) return json({account:null,deletion:deleting});
                    throw new HTTPError(410, 'Account deletion has been accepted.');
                }
                if (proofStart) {
                    const body=await readJson(request,8192);
                    return json(await this.verification.start(request,identity,body.method,body.action,body.stage_id,body.provider));
                }
                if (proofPassword) {
                    const body=await readJson(request,8192);
                    return json(await this.verification.password(body.verification_id,identity,body.action));
                }
                if (proofStatus) {
                    const body=await readJson(request,8192);
                    const record = await this.verification.get(body.verification_id,identity,body.action);
                    return json({verified:record.status==='verified',status:record.status,action:record.action,context:record.context,expires_at:record.expires});
                }
                if (connect) return await this.connectAccount(request, identity);
                const account = await this.accountFor(identity);
                if(sleepRoute){
                    if(!account)throw new HTTPError(403,'Connect your Taskitator account first.');
                    if(!['GET','POST'].includes(method))throw new HTTPError(405,'Method not allowed.');
                    const key='sleep-lock:'+identity.userId;
                    const defaults={enabled:false,bedtime:'23:00',wake_time:'07:00',timezone:'Asia/Riyadh',revision:0};
                    if(method==='GET'){const schedule=await this.storage.get(key)||defaults,w=sleepWindow(schedule);return json({schedule,delay:w?await this.storage.get('sleep-delay:'+identity.userId+':'+w.day)||null:null});}
                    const b=await readJson(request,2048),valid=t=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
                    if(b.action==='delay'){
                        if(Object.keys(b).some(k=>!['action','minutes','revision'].includes(k))||![30,60].includes(b.minutes)||!Number.isSafeInteger(b.revision))throw new HTTPError(400,'Choose a 30- or 60-minute delay.');
                        await this.ensureAlarm();
                        return await this.storage.transaction(async tx=>{
                            const meta=await tx.get(accountKey(account.user));if(!meta||meta.deleting||meta.owner_id!==identity.userId)throw new HTTPError(403,'Account access denied.');
                            const schedule=await tx.get(key)||defaults;if(schedule.revision!==b.revision)throw new HTTPError(409,'Sleep schedule changed. Reload before delaying sleep.');
                            const now=Date.now(),w=sleepWindow(schedule,now);if(!w)throw new HTTPError(409,'Enable and save your sleep schedule first.');
                            const delayKey='sleep-delay:'+identity.userId+':'+w.day,old=await tx.get(delayKey);
                            if(old)throw new HTTPError(409,'Sleep has already been delayed for this night.');
                            const until=w.start+b.minutes*60000;if(until<=now||until>=w.end)throw new HTTPError(409,'That delay would already have ended or reach your wake-up time.');
                            const delay={day:w.day,minutes:b.minutes,sleep_at:until,wake_at:w.end,expires:w.end+172800000};await tx.put(delayKey,delay);return json({schedule,delay});
                        });
                    }
                    if(Object.keys(b).some(k=>!['enabled','bedtime','wake_time','revision'].includes(k))||typeof b.enabled!=='boolean'||!valid(b.bedtime)||!valid(b.wake_time)||b.bedtime===b.wake_time||!Number.isSafeInteger(b.revision)||b.revision<0)throw new HTTPError(400,'Choose different bedtime and wake-up times, and refresh before saving.');
                    return await this.storage.transaction(async tx=>{
                        const meta=await tx.get(accountKey(account.user));if(!meta||meta.deleting||meta.owner_id!==identity.userId)throw new HTTPError(403,'Account access denied.');
                        const old=await tx.get(key)||defaults;if(old.revision!==b.revision)throw new HTTPError(409,'Sleep schedule changed on another device. Reload it before saving.');
                        if(old.revision>=Number.MAX_SAFE_INTEGER)throw new HTTPError(409,'Sleep schedule revision limit reached.');
                        const schedule={enabled:b.enabled,bedtime:b.bedtime,wake_time:b.wake_time,timezone:'Asia/Riyadh',revision:old.revision+1};await tx.put(key,schedule);return json({schedule});
                    });
                }
                if (emergencyRoute) {
                    if (!account) throw new HTTPError(403, 'Connect your Taskitator account on the login page first.');
                    if (!['GET','POST'].includes(method)) throw new HTTPError(405, 'Method not allowed.');
                    return json(await this.protection.emergency(identity, method === 'POST'));
                }
                if (account && this.vault.ready()) await this.migrateVault(identity);
                if (me) return json({ account });
                if (!account) throw new HTTPError(403, 'Connect your Taskitator account on the login page first.');
                user = account.user;
                if (phoneAdmin) return await this.phoneAccess(request, user);
                if (keyRoute) {
                    if (path === '/ai/keys' && method === 'GET') return json(await this.vault.metadata(identity,url.searchParams.get('provider')||'gemini'));
                    const body=await readJson(request,path === '/ai/generate' ? MAX_BODY_BYTES : 65536);
                    if (path === '/ai/keys/test' && method === 'POST') return json(await this.vault.testSaved(identity,body.provider));
                    if (path === '/ai/provider' && method === 'POST') return json(await this.vault.select(identity,body.provider));
                    if (path === '/ai/keys' && method === 'POST') return json(await this.vault.save(identity,body));
                    if (path === '/ai/keys' && method === 'DELETE') return json(await this.vault.remove(identity,body));
                    if (path === '/ai/keys/stage' && method === 'POST') {
                        await this.rateBucket('key-stage:'+identity.userId,10);
                        await this.vault.stage(identity,body.keys);
                        if (body.claude_keys?.length) await this.vault.stage(identity,body.claude_keys,'claude');
                        return json(await this.vault.metadata(identity));
                    }
                    if (path === '/ai/keys/reveal' && method === 'POST') return json(await this.vault.reveal(identity,body));
                    if (path === '/ai/generate' && method === 'POST') return json(await this.ai.generate(identity,body));
                    throw new HTTPError(405,'Method not allowed.');
                }
            }
            const body = push ? await readJson(request) : null;
            if (body) validateVersion(body);
            let snapshot = null, snapshotHash = null;
            if (push) {
                snapshot = validateSnapshot(body, user);
                snapshotHash = await sha256(JSON.stringify(snapshot));
            }

            return await this.storage.transaction(async tx => {
                const meta = await tx.get(accountKey(user));
                if (!meta || meta.deleting || (identity && meta.owner_id !== identity.userId)) throw new HTTPError(403, 'Account access denied.');
                if (bridge) return json({ linked: false, rules: [] });
                if (status || pull) {
                    let record = await loadSnapshot(tx, user, meta);
                    if (record?.recurrence_state) {
                        const normalized=Recurrence.reconcile(record);
                        if(normalized.changed){
                            if(meta.version>=Number.MAX_SAFE_INTEGER)throw new HTTPError(503,'Account revision limit reached.');
                            meta.version++;meta.saved_at=new Date().toISOString();record.updated_at=meta.saved_at;
                            await saveSnapshot(tx,user,meta,record);await tx.put(accountKey(user),meta);
                            record={...record,version:meta.version,saved_at:meta.saved_at};
                        }
                    }
                    if (pull) return json(record ? publicRecord(record) : { empty: true, version: meta.version });
                    const state = evaluateStatus(record);
                    const groupState=await this.universe.lockStatus(identity?.userId||meta.owner_id);
                    state.universe_degraded=groupState.degraded;
                    state.universe_locks=groupState.count||0;
                    if(groupState.locked&&!state.in_break){state.device_unlocked=false;state.finished=false;}
                    const schedule=await tx.get('sleep-lock:'+(identity?.userId||meta.owner_id));
                    const sleepPeriod=sleepWindow(schedule),delay=sleepPeriod?await tx.get('sleep-delay:'+(identity?.userId||meta.owner_id)+':'+sleepPeriod.day):null;
                    state.sleep_lock_active=sleepLockActive(schedule,Date.now(),delay);
                    if(state.sleep_lock_active)state.device_unlocked=false;
                    if(identity && await this.protection.bypass(tx,identity.userId)) { state.device_unlocked=true;state.emergency_bypass=true; }
                    else if(!identity) { const owner=meta.owner_id; if(owner && await this.protection.bypass(tx,owner)){state.device_unlocked=true;state.emergency_bypass=true;} }
                    return url.searchParams.get('format') === 'text'
                        ? new Response(`device_unlocked = ${state.device_unlocked}`, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
                        : json(state);
                }
                if (push && meta.last_write?.mutation_id === body.mutation_id &&
                    meta.last_write.hash === snapshotHash && meta.last_write.base_version === body.base_version) {
                    return json({ success: true, version: meta.last_write.version ?? meta.version, updated_at: meta.last_write.saved_at || meta.saved_at });
                }
                if (body.base_version !== meta.version) return conflict(meta.version);
                if (meta.version >= Number.MAX_SAFE_INTEGER) throw new HTTPError(503, 'Account revision limit reached.');
                const now = new Date().toISOString();
                if (push) {
                    const previous = await loadSnapshot(tx, user, meta);
                    if (!this.vault.ready() && (previous?.settings?.gemini_api_key || previous?.settings?.claude_api_key)) {
                        throw new HTTPError(503,'Set up encrypted key storage before syncing this legacy account. No saved data was replaced.');
                    }
                    if (previous?.recurrence_state?.series?.length && body.recurrence_schema !== 1) {
                        throw new HTTPError(428, 'Refresh Taskitator on this device before syncing recurring tasks.');
                    }
                    await this.protection.guardSync(tx,identity.userId,previous,snapshot);
                    try { Recurrence.reconcile(snapshot); }
                    catch (err) { throw new HTTPError(400, err.message); }
                    // Preserve array dates before replacing the client timestamp.
                    if (Array.isArray(snapshot.today_breaks)) {
                        const edited = timestamp(body.updated_at);
                        const date = logicalDate(Number.isFinite(edited) ? edited : Date.now(), dayHour(snapshot.settings));
                        snapshot.today_breaks = snapshot.today_breaks.map(b => object(b) ? { ...b, date: b.date || date } : b);
                    }
                    await this.protection.guardSync(tx,identity.userId,previous,snapshot);
                    try { snapshot.today_breaks=globalThis.TaskitatorBreaks.merge(previous?.today_breaks,snapshot.today_breaks,snapshot.settings); }
                    catch(error){throw new HTTPError(400,error.message);}
                    snapshot.updated_at = now;
                    await saveSnapshot(tx, user, meta, snapshot);
                    meta.version++;
                    meta.saved_at = now;
                    meta.last_write = { mutation_id: body.mutation_id, hash: snapshotHash, base_version: body.base_version, version:meta.version, saved_at:now };
                    await tx.put(accountKey(user), meta);
                    return json({ success: true, version: meta.version, updated_at: now,today_breaks:snapshot.today_breaks });
                }
                throw new HTTPError(405, 'Method not allowed.');
            });
        } catch (err) {
            return json({ code:err.code, error: (err instanceof HTTPError || err instanceof SecurityError || (Number.isInteger(err.status) && typeof err.code==='string')) ? err.message : 'Cloud storage request failed. Retry with the same operation ID.' },
                (err instanceof HTTPError || err instanceof SecurityError || (Number.isInteger(err.status) && typeof err.code==='string')) ? err.status : 503);
        }
    }
}

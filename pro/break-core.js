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

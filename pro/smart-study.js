/* Shared Smart Study rules. Appearances refer to existing units, never copies. */
(function(root){
'use strict';
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00Z').toISOString().slice(0,10)===s;
function nextWeekend(day,start=5,end=6){
 const n=new Date(day+'T12:00Z'); do{n.setUTCDate(n.getUTCDate()+1);}while(n.getUTCDay()!==start);
 const dates=[];for(let i=0;i<7;i++){dates.push(n.toISOString().slice(0,10));if(n.getUTCDay()===end)break;n.setUTCDate(n.getUTCDate()+1);}return dates;
}
function normalize(s,rows){
 if(!s)return null;
 if(!['original','weekend','dates'].includes(s.mode)||!Array.isArray(s.appearances)||!s.appearances.length||s.appearances.length>1000)throw Error('Choose an Early Appearance option and at least one future unit.');
 // Only required units can be shown early: a plan's own bonus units (the last ones of a day) are optional already.
 const units=new Map(rows.flatMap(r=>r.numbers.slice(0,r.count??r.numbers.length).map(n=>[n,r.date]))),dates=new Set(rows.map(r=>r.date)),seen=new Set();
 if(s.appearances.some(a=>a&&!units.has(a.unit)&&rows.some(r=>r.numbers.includes(a.unit))))throw Error('Bonus units are optional already and cannot be shown early. Choose required units.');
 const appearances=s.appearances.map(a=>{if(!Number.isInteger(a.unit)||seen.has(a.unit)||!dates.has(a.date)||!units.has(a.unit)||a.date>=units.get(a.unit))throw Error('Each unit needs one earlier date already in this recurrence.');seen.add(a.unit);return {unit:a.unit,date:a.date};});
 const targets=[...new Set(s.dates||[])].sort();if(targets.some(d=>!date(d)||!dates.has(d)))throw Error('Select dates in this study recurrence.');
 if(s.mode==='dates'&&!targets.length)throw Error('Choose at least one date to lighten.');
 const start=Number(s.weekend_start??5),end=Number(s.weekend_end??6);if(![start,end].every(n=>Number.isInteger(n)&&n>=0&&n<7))throw Error('Invalid weekend settings.');
 if(s.mode==='weekend'&&appearances.some(a=>!nextWeekend(a.date,start,end).some(d=>rows.some(r=>r.date===d))))throw Error('No tasks on the next configured weekend. Choose specific dates instead.');
 return {mode:s.mode,dates:targets,appearances,weekend_start:start,weekend_end:end};
}
function decorate(tasks,s){
 if(!s)return tasks;
 for(const t of tasks){t.smart_origin_date=t.due_date;t.smart_origin_parent=t.parent_id;}
 tasks[0].smart_config=s;
 for(const a of s.appearances){const t=tasks.find(t=>t.id.endsWith('_unit_'+a.unit));t.smart_early_date=a.date;}
 return tasks;
}
function apply(snapshot,previous,now=Date.now(),approval=null){
 const list=snapshot.tasks||[],today=root.TaskitatorRecurrence.today(now,Number(snapshot.settings?.day_start_hour)||0),old=new Map((previous?.tasks||[]).map(t=>[t.id,t]));
 for(const task of list){
  if(!task.smart_early_date||task.smart_adjusted||task.status!=='completed'||old.get(task.id)?.status==='completed')continue;
  const config=list.find(t=>t.study_plan_id===task.study_plan_id&&t.smart_config)?.smart_config;
  if(!config)continue;
  const audited=task.ai_locked||task.require_ai_proof;
  const submitted=audited?(approval?.ids?.includes(task.id)?approval.submittedAt:null):now;
  if(!submitted||root.TaskitatorRecurrence.today(submitted,Number(snapshot.settings?.day_start_hour)||0)!==task.smart_early_date)continue;
  task.smart_adjusted=true; // consumed once, including when no replacement fits
  if(config.mode==='original'||task.due_date<today)continue;
  const targets=config.mode==='weekend'?nextWeekend(task.smart_early_date,config.weekend_start,config.weekend_end):config.dates;
  const candidates=list.filter(t=>t.study_plan_id===task.study_plan_id&&t.parent_id&&t.status==='active'&&!t.is_bonus&&!t.smart_early_date&&!t.smart_moved_from&&t.early_date===undefined&&targets.includes(t.due_date)&&t.due_date>task.due_date).sort((a,b)=>a.due_date.localeCompare(b.due_date)||Number(a.id.split('_unit_').at(-1))-Number(b.id.split('_unit_').at(-1)));
  const replacement=candidates[0];if(!replacement)continue;
  replacement.smart_moved_from=replacement.due_date;replacement.due_date=task.due_date;replacement.parent_id=task.parent_id;task.smart_replacement_id=replacement.id;
 }
 return snapshot;
}
// exempt: plan ids whose whole task tree the Worker computed itself and pinned for this sync (a bonus change that cleared early appearances).
function guard(previous,next,exempt=new Set()){
 const map=new Map((next.tasks||[]).map(t=>[t.id,t]));
 for(const old of previous?.tasks||[]){const t=map.get(old.id);if(!t)continue;if(old.study_plan_id&&exempt.has(old.study_plan_id))continue;
  for(const k of new Set([...Object.keys(old),...Object.keys(t)].filter(k=>k.startsWith('smart_'))))if(JSON.stringify(old[k])!==JSON.stringify(t[k]))throw Error('Early Appearance schedule changed elsewhere. Sync and retry.');
 }
 for(const t of next.tasks||[])if(!previous?.tasks?.some(o=>o.id===t.id)&&!t.study_plan_id&&Object.keys(t).some(k=>k.startsWith('smart_')))throw Error('Early Appearance requires an authorized study recurrence.');
}
// Bulk tools (Phase 3.6.1). They only choose early appearances (unit -> earlier date); every unit stays required on its own date.
// rows: [{date, numbers}] in any order. current: Map(unit -> date). o.scope: Set of dates the tool may fill (null = every date).
// o.pick 'first'|'last' decides which units of a source date are taken. Returns {appearances, added, notes}. Never edits its inputs.
function bulk(rows,tool,o={},current=new Map()){
 const sched=[...rows].filter(r=>r&&r.numbers?.length).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
 const dateOf=new Map();for(const r of sched)for(const n of r.numbers)dateOf.set(n,r.date);
 if(tool==='clear')return {appearances:new Map(),added:0,notes:[]};
 const out=new Map();for(const [u,d] of current)if(dateOf.has(u)&&d<dateOf.get(u))out.set(u,d);
 const pick=o.pick==='last'?'last':'first',notes=[],inScope=d=>!o.scope||o.scope.has(d);
 const free=r=>r.numbers.filter(n=>!out.has(n));
 const take=(src,k)=>{const f=free(src),chosen=pick==='last'?f.slice(-k):f.slice(0,k);return chosen;};
 const amount=o.amount==null||o.amount===''?null:Number(o.amount);
 if(amount!==null&&(!Number.isSafeInteger(amount)||amount<1||amount>1000))throw Error('Use a whole number of tasks from 1 to 1,000.');
 let added=0;
 if(tool==='next'){
  sched.forEach((row,i)=>{
   if(!inScope(row.date))return;const src=sched[i+1];
   if(!src){notes.push({date:row.date,why:'last'});return;}
   const avail=free(src).length,k=amount===null?avail:Math.min(amount,avail);
   if(!k){notes.push({date:row.date,why:'empty'});return;}
   for(const n of take(src,k)){out.set(n,row.date);added++;}
  });
 }else if(tool==='level'){
  const target=Number(o.target);if(!Number.isSafeInteger(target)||target<1||target>1000)throw Error('Use a whole number of tasks from 1 to 1,000.');
  sched.forEach((row,i)=>{
   if(!inScope(row.date))return;
   let load=row.numbers.length+[...out.values()].filter(d=>d===row.date).length;
   for(let j=i+1;j<sched.length&&load<target;j++){const got=take(sched[j],target-load);for(const n of got){out.set(n,row.date);added++;load++;}}
   if(load<target)notes.push({date:row.date,why:'short'});
  });
 }else if(tool==='move'){
  const from=sched.find(r=>r.date===o.from),to=sched.find(r=>r.date===o.to);
  if(!from||!to)throw Error('Choose two dates that are in this recurrence.');
  if(!(o.to<o.from))throw Error('The tasks can only appear on an earlier date than the one they are due.');
  const count=Number(o.count);if(!Number.isSafeInteger(count)||count<1||count>1000)throw Error('Use a whole number of tasks from 1 to 1,000.');
  const got=take(from,count);if(!got.length)notes.push({date:o.from,why:'empty'});
  for(const n of got){out.set(n,o.to);added++;}
 }else throw Error('Unknown Early Appearance tool.');
 return {appearances:out,added,notes};
}
root.TaskitatorSmartStudy={normalize,decorate,apply,guard,nextWeekend,bulk};
})(typeof window==='undefined'?globalThis:window);

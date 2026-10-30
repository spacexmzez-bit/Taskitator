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
 if(!['original','weekend','dates'].includes(s.mode)||!Array.isArray(s.appearances)||!s.appearances.length||s.appearances.length>1000)throw Error('Choose a Smart Study option and at least one future unit.');
 const units=new Map(rows.flatMap(r=>r.numbers.map(n=>[n,r.date]))),dates=new Set(rows.map(r=>r.date)),seen=new Set();
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
  const candidates=list.filter(t=>t.study_plan_id===task.study_plan_id&&t.parent_id&&t.status==='active'&&!t.is_bonus&&!t.smart_early_date&&!t.smart_moved_from&&targets.includes(t.due_date)&&t.due_date>task.due_date).sort((a,b)=>a.due_date.localeCompare(b.due_date)||Number(a.id.split('_unit_').at(-1))-Number(b.id.split('_unit_').at(-1)));
  const replacement=candidates[0];if(!replacement)continue;
  replacement.smart_moved_from=replacement.due_date;replacement.due_date=task.due_date;replacement.parent_id=task.parent_id;task.smart_replacement_id=replacement.id;
 }
 return snapshot;
}
function guard(previous,next){
 const map=new Map((next.tasks||[]).map(t=>[t.id,t]));
 for(const old of previous?.tasks||[]){const t=map.get(old.id);if(!t)continue;
  for(const k of new Set([...Object.keys(old),...Object.keys(t)].filter(k=>k.startsWith('smart_'))))if(JSON.stringify(old[k])!==JSON.stringify(t[k]))throw Error('Smart Study schedule changed elsewhere. Sync and retry.');
 }
 for(const t of next.tasks||[])if(!previous?.tasks?.some(o=>o.id===t.id)&&!t.study_plan_id&&Object.keys(t).some(k=>k.startsWith('smart_')))throw Error('Smart Study requires an authorized study recurrence.');
}
root.TaskitatorSmartStudy={normalize,decorate,apply,guard,nextWeekend};
})(typeof window==='undefined'?globalThis:window);

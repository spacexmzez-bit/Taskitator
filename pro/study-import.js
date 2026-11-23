/* Study plan importer (Phase 6.1.2). Turns a file made by Export JSON (format "taskitator-study-plan", version 1)
   into a study-plan config for TaskitatorStudyCore.build. The plan is then created through the normal authorize
   flow, so the Worker checks it exactly like a plan made in the creation dialog.
   Modes:
     template (default): new start date, the day gaps of the file are kept, everything is created active.
     restore           : the file's dates are kept, and units marked done in the file are completed afterwards
                         with their original completed_at.
   AI-audited units are imported as normal units (criteria and reference files aren't in the file). Early dates
   are dropped. Nothing is created when the file has any problem: every problem is listed. */
(function(root){
'use strict';
const MAX_UNITS=500,ISO=/^\d{4}-\d{2}-\d{2}$/;
const dateOK=d=>typeof d==='string'&&ISO.test(d)&&new Date(d+'T00:00Z').toISOString().slice(0,10)===d;
const shift=(d,n)=>{const x=new Date(d+'T00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const gap=(a,b)=>Math.round((Date.parse(b+'T00:00Z')-Date.parse(a+'T00:00Z'))/86400000);
class ImportError extends Error{constructor(problems){super(problems.join(' '));this.problems=problems;}}
// opts: { mode:'template'|'restore', start (template), priorities:[ids] }
function convert(data,opts={}){
 const problems=[],mode=opts.mode==='restore'?'restore':'template';
 if(!data||typeof data!=='object'||Array.isArray(data))throw new ImportError(['This file is not a Taskitator study plan.']);
 if(data.format!=='taskitator-study-plan')throw new ImportError(['This file is not a Taskitator study plan export.']);
 if(data.version!==1)throw new ImportError(['This plan file version ('+String(data.version)+') is not supported. Update Taskitator and try again.']);
 const plan=data.plan&&typeof data.plan==='object'?data.plan:{},days=Array.isArray(data.days)?data.days:null;
 const title=typeof plan.title==='string'?plan.title.trim():'';
 if(!title||title.length>160)problems.push('The plan needs a title of up to 160 characters.');
 if(!days||!days.length)throw new ImportError([...problems,'The file has no study days.']);
 if(days.length>365)problems.push('A plan can have at most 365 study days.');
 const clean=[];let unitCount=0;
 for(const [i,d] of days.entries()){
  const label='Day '+(i+1);
  if(!d||typeof d!=='object'){problems.push(label+' is not valid.');continue;}
  if(!dateOK(d.date)){problems.push(label+' has no valid date.');continue;}
  const units=Array.isArray(d.units)?d.units.filter(u=>u&&typeof u==='object'):[];
  unitCount+=units.length;
  const req=units.filter(u=>!u.bonus),bonus=units.filter(u=>u.bonus);
  if(!req.length)problems.push(label+' ('+d.date+') has no required unit. Every study day needs at least one.');
  const nums=units.map(u=>u.number);
  if(nums.some(n=>n!==null&&n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>1000000)))problems.push(label+' has an invalid unit number.');
  clean.push({date:d.date,priority:typeof d.priority==='string'?d.priority:null,req,bonus,units});
 }
 if(unitCount>MAX_UNITS)problems.push('This plan has '+unitCount+' units. The import limit is '+MAX_UNITS+'.');
 clean.sort((a,b)=>a.date.localeCompare(b.date));
 for(let i=1;i<clean.length;i++)if(clean[i].date===clean[i-1].date)problems.push('Two study days share the date '+clean[i].date+'.');
 let start=clean[0]?.date;
 if(mode==='template'){if(!dateOK(opts.start))problems.push('Choose a valid start date.');else start=opts.start;}
 if(problems.length)throw new ImportError(problems);
 const offset=mode==='template'?gap(clean[0].date,start):0,dates=clean.map(d=>offset?shift(d.date,offset):d.date);
 // Unit numbers: the file's own numbers when they are complete and distinct, otherwise 1..n in day order.
 const all=clean.flatMap(d=>[...d.req,...d.bonus]),fileNums=all.map(u=>u.number);
 const numbered=fileNums.every(n=>Number.isSafeInteger(n))&&new Set(fileNums).size===fileNums.length;
 const first=numbered?Math.min(...fileNums):1;
 const priorities=new Set(Array.isArray(opts.priorities)?opts.priorities:[]);
 const same=list=>{const v=[...new Set(list)];return v.length===1&&v[0]&&priorities.has(v[0])?v[0]:null;};
 const chapter=plan.chapter&&Number.isSafeInteger(plan.chapter.size)&&plan.chapter.size>0?plan.chapter:null;
 const unitName=typeof plan.unit==='string'&&plan.unit.trim()&&!/[{}·]/.test(plan.unit)?plan.unit.trim().slice(0,40):'Chapter';
 const plural=typeof plan.plural==='string'&&plan.plural.trim()&&!/[{}·]/.test(plan.plural)?plan.plural.trim().slice(0,45):unitName+'s';
 const counts=clean.map(d=>d.req.length),bonusCounts=clean.map(d=>d.bonus.length),bonusTotal=bonusCounts.reduce((a,b)=>a+b,0);
 // When the file's numbers are used, numbers missing from the range are skipped so each unit keeps its number.
 let skipped=[];
 if(numbered){const have=new Set(fileNums),max=Math.max(...fileNums);for(let n=first;n<=max;n++)if(!have.has(n))skipped.push(n);}
 const config={title,unit:unitName,plural,total:counts.reduce((a,b)=>a+b,0),days:clean.length,first,start:dates[0],weekdays:[],skipped,counts,dates,
  ...(bonusTotal?{bonus:bonusTotal,bonus_counts:bonusCounts}:{}),
  ...(chapter?{chapter_size:chapter.size,chapter_label:String(chapter.label||'Ch').slice(0,20)}:{}),
  ...(same(clean.map(d=>d.priority))?{parent_priority:same(clean.map(d=>d.priority))}:{}),
  ...(same(all.map(u=>u.priority))?{unit_priority:same(all.map(u=>u.priority))}:{})};
 // Build assigns numbers in day order, required units first, then bonus. Completions follow that same order.
 const order=clean.flatMap(d=>[...d.req.slice().sort((a,b)=>(a.number??0)-(b.number??0)),...d.bonus.slice().sort((a,b)=>(a.number??0)-(b.number??0))]);
 const completions=mode==='restore'?order.map((u,i)=>({index:i,done:u.status==='completed',completed_at:typeof u.completed_at==='string'&&Number.isFinite(Date.parse(u.completed_at))?u.completed_at:null})).filter(c=>c.done):[];
 const audited=all.filter(u=>u.ai_audited).length,early=all.filter(u=>u.early_date).length;
 return {config,mode,completions,summary:{title,days:clean.length,required:config.total,bonus:bonusTotal,start:dates[0],end:dates.at(-1),audited,early,done:completions.length}};
}
// After the plan's tasks are built: the units in build order (day order, required first, then bonus).
function unitsInOrder(tasks){
 const parents=tasks.filter(t=>!t.parent_id).sort((a,b)=>String(a.due_date).localeCompare(String(b.due_date)));
 const num=t=>{const m=/_unit_(\d+)$/.exec(t.id);return m?Number(m[1]):0;};
 return parents.flatMap(p=>{const kids=tasks.filter(t=>t.parent_id===p.id);return [...kids.filter(k=>!k.is_bonus).sort((a,b)=>num(a)-num(b)),...kids.filter(k=>k.is_bonus).sort((a,b)=>num(a)-num(b))];});
}
// Restore: complete the units marked done in the file. Returns the number completed.
function applyCompletions(tasks,planId,completions,now=new Date().toISOString()){
 const mine=tasks.filter(t=>t.study_plan_id===planId),units=unitsInOrder(mine);let n=0;
 for(const c of completions){const u=units[c.index];if(u&&u.status==='active'&&!u.ai_locked){u.status='completed';u.completed_at=c.completed_at||now;n++;}}
 // A day whose units are all done is completed too.
 for(const p of mine.filter(t=>!t.parent_id&&t.status==='active')){const kids=mine.filter(t=>t.parent_id===p.id);if(kids.length&&kids.every(k=>k.status==='completed')){p.status='completed';p.completed_at=kids.map(k=>k.completed_at).sort().at(-1)||now;}}
 return n;
}
root.TaskitatorStudyImport={convert,unitsInOrder,applyCompletions,ImportError,MAX_UNITS};
})(typeof window==='undefined'?globalThis:window);

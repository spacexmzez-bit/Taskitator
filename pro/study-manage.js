/* Study plan management (Phase 2.4a). Pure functions over the task list; the page and the tests share them.
   A plan is every task carrying the same study_plan_id: one parent per study day, units under each parent.
   Nothing here talks to the server. The Worker enforces Pro, locks and deletion authorization. */
(function(root){
'use strict';
const DEFAULT_PRIORITIES=[{id:'prio_high',rank:1},{id:'prio_med',rank:2},{id:'prio_low',rank:3}];
const prioritiesOf=settings=>Array.isArray(settings?.custom_priorities)&&settings.custom_priorities.length?settings.custom_priorities:DEFAULT_PRIORITIES;
// Higher number = less important. No priority counts as the least important.
function rankOf(list,id){if(!id)return Infinity;const i=list.findIndex(p=>p.id===id);if(i<0)return Infinity;const r=Number(list[i].rank);return Number.isFinite(r)?r:i+1;}
const isAudited=t=>Boolean(t&&(t.ai_locked||t.require_ai_proof));
const unitNumber=t=>{const m=/\{num==(\d+)\}$/.exec(t.raw_title||'');return m?Number(m[1]):null;};
const live=t=>t&&t.status!=='trash';

function plans(tasks){
 const groups=new Map();
 for(const t of tasks||[])if(t&&t.study_plan_id){if(!groups.has(t.study_plan_id))groups.set(t.study_plan_id,[]);groups.get(t.study_plan_id).push(t);}
 return [...groups].map(([id,group])=>{
  const items=group.filter(live),parents=items.filter(t=>!t.parent_id),ids=new Set(parents.map(p=>p.id)),units=items.filter(t=>t.parent_id&&ids.has(t.parent_id));
  const bases=new Set(),custom=[];
  for(const p of parents){const m=/^(.*) (\d+)$/.exec(p.raw_title||p.title||'');if(m)bases.add(m[1]);else custom.push(p.id);}
  const base=bases.size===1?[...bases][0]:'';
  const um=units.map(u=>/^(.*)\.\{num==\d+\}$/.exec(u.raw_title||'')).find(Boolean);
  const dm=parents.map(p=>/^Covers (.*?) \d/.exec(p.description||'')).find(Boolean);
  const unit=um?um[1]:'',plural=dm?dm[1]:'';
  const dates=parents.map(p=>p.due_date).filter(Boolean).sort();
  const done=units.filter(u=>u.status==='completed').length;
  const same=values=>new Set(values).size===1?values[0]??null:undefined;
  return {id,base,custom:custom.length,unit,plural,total:units.length,done,remaining:units.length-done,days:parents.length,
   start:dates[0]||null,end:dates.at(-1)||null,audited:units.filter(isAudited).length,
   parentPriority:same(parents.map(p=>p.priority_id||null)),unitPriority:same(units.map(u=>u.priority_id||null)),
   finished:units.length>0&&done===units.length,parents,units,group};
 }).sort((a,b)=>(b.end||'').localeCompare(a.end||''));
}
const copy=tasks=>tasks.map(t=>({...t}));
const forPlan=(tasks,id)=>{const plan=plans(tasks).find(p=>p.id===id);if(!plan)throw Error('This study plan no longer exists.');return plan;};

// Parent title: "<base> 3" for every day. Parents with their own custom title are left alone.
function renamePlan(tasks,id,name){
 const plan=forPlan(tasks,id),next=String(name??'').trim();
 if(!plan.base)throw Error('This plan has custom day titles, so there is no single name to change.');
 if(!next||next.length>160)throw Error('Enter a title, up to 160 characters.');
 const out=copy(tasks),mine=new Set(plan.parents.map(p=>p.id));let changed=0;
 for(const t of out)if(mine.has(t.id)){const m=/^(.*) (\d+)$/.exec(t.raw_title||t.title||'');if(m&&m[1]===plan.base){t.title=t.raw_title=next+' '+m[2];changed++;}}
 return {tasks:out,changed};
}
// Unit name ("Chapter"): updates every unit title and the "Covers chapters 1 to 3" line on each day.
function renameUnit(tasks,id,unit,plural,{bypass=false}={}){
 const plan=forPlan(tasks,id);unit=String(unit??'').trim();plural=String(plural||'').trim()||unit+'s';
 if(!plan.unit)throw Error('This plan has no units to rename.');
 if(!unit||unit.length>40||plural.length>45||/[{}]/.test(unit+plural))throw Error('Enter a unit name without syntax brackets.');
 if(plan.audited&&!bypass)throw Error('This plan has AI-audited units. Renaming them needs Emergency Bypass.');
 const out=copy(tasks),units=new Set(plan.units.map(u=>u.id)),parents=new Set(plan.parents.map(p=>p.id));let changed=0;
 for(const t of out){
  if(units.has(t.id)){const n=unitNumber(t);if(n!==null){t.title=unit+'.'+n;t.raw_title=unit+'.{num=='+n+'}';changed++;}}
  else if(parents.has(t.id)&&plan.plural&&typeof t.description==='string'&&t.description.startsWith('Covers '+plan.plural+' '))t.description='Covers '+plural.toLowerCase()+t.description.slice(7+plan.plural.length);
 }
 return {tasks:out,changed};
}
// Priorities apply to unfinished tasks only. A unit can never be more important than its parent.
function setPriorities(tasks,id,{parent,unit},settings){
 const plan=forPlan(tasks,id),list=prioritiesOf(settings),known=v=>v===null||list.some(p=>p.id===v);
 if(!known(parent)||!known(unit))throw Error('Choose one of your priorities.');
 if(rankOf(list,unit)<rankOf(list,parent))throw Error('Units cannot have a higher priority than their parent task.');
 const out=copy(tasks),mine=new Map([...plan.parents.map(p=>[p.id,parent]),...plan.units.map(u=>[u.id,unit])]);let changed=0;
 for(const t of out)if(mine.has(t.id)&&t.status==='active'){const v=mine.get(t.id);if((t.priority_id||null)!==v){if(v===null)delete t.priority_id;else t.priority_id=v;changed++;}}
 return {tasks:out,changed};
}
// Add AI criteria to a plan that has none. Only unfinished units can be audited; {num} becomes the unit number.
function addCriteria(tasks,id,criteria,numbers){
 const plan=forPlan(tasks,id);criteria=String(criteria??'');
  if(!criteria.trim()||criteria.length>4000)throw Error('Enter audit criteria, up to 4,000 characters.');
 if(/\{(?!num\})[^}]*\}/.test(criteria))throw Error('Only {num} is available in study criteria.');
 const pick=new Set(numbers),out=copy(tasks),mine=new Map(plan.units.map(u=>[u.id,u]));let changed=0;
 for(const t of out){const u=mine.get(t.id);if(!u||u.status!=='active'||isAudited(u))continue;const n=unitNumber(u);if(n===null||!pick.has(n))continue;
  t.ai_locked=true;t.proof_criteria=criteria.replace(/\{num\}/g,String(n));t.raw_proof_criteria=criteria;changed++;}
 if(!changed)throw Error('Select at least one unfinished unit.');
 return {tasks:out,changed};
}
// Which unfinished units a criteria edit reaches. Units that already have criteria stay locked and are never changed here.
// excludeText uses the skipped-units syntax ("8, 10-12"). Returns {numbers, locked, excluded}.
function auditTargets(plan,excludeText){
 const open=plan.units.filter(u=>u.status==='active').map(u=>({n:unitNumber(u),locked:isAudited(u)})).filter(u=>u.n!==null).sort((a,b)=>a.n-b.n);
 const locked=open.filter(u=>u.locked).map(u=>u.n),free=open.filter(u=>!u.locked).map(u=>u.n);
 let excluded=[];
 if(String(excludeText??'').trim()){
  const all=plan.units.map(unitNumber).filter(n=>n!==null).sort((a,b)=>a-b),have=new Set(all),gaps=[];
  for(let n=all[0];n<=all.at(-1);n++)if(!have.has(n))gaps.push(n);
  excluded=root.TaskitatorStudyCore.parseSkips(excludeText,all[0],all.length,gaps);
 }
 const ex=new Set(excluded);
 return {numbers:free.filter(n=>!ex.has(n)),locked,excluded:free.filter(n=>ex.has(n))};
}
// Assign unit numbers to dates in order: sched = [{date,count}] sorted by date. Returns Map date -> numbers.
function assignUnits(numbers,sched){
 const out=new Map();let i=0;
 for(const {date,count}of sched){out.set(date,numbers.slice(i,i+count));i+=count;}
 return out;
}
// Surplus (positive) or missing (negative) units compared with the units that need a date.
const balance=(sched,total)=>sched.reduce((a,x)=>a+x.count,0)-total;
// Unit numbers of a plan's unfinished units (for the audit picker).
const openUnits=plan=>plan.units.filter(u=>u.status==='active').map(unitNumber).filter(n=>n!==null).sort((a,b)=>a-b);
// Config the Worker's study validator understands, rebuilt from the generated tasks.
function configOf(plan){
 const nums=plan.units.map(unitNumber).filter(n=>n!==null).sort((a,b)=>a-b),first=nums[0]??1,last=nums.at(-1)??first,have=new Set(nums),skipped=[];
 for(let n=first;n<=last;n++)if(!have.has(n))skipped.push(n);
 const counts=plan.parents.slice().sort((a,b)=>String(a.due_date).localeCompare(String(b.due_date))).map(p=>plan.units.filter(u=>u.parent_id===p.id).length).filter(c=>c>0);
 return {title:plan.base||'Study plan',unit:plan.unit||'Chapter',plural:plan.plural?plan.plural.charAt(0).toUpperCase()+plan.plural.slice(1):(plan.unit||'Chapter')+'s',total:nums.length,days:counts.length||1,first,start:plan.start,skipped,counts};
}
// Delete every task of the plan (and anything under it). Completed tasks leave a history entry so Stats still counts them.
function deletePlan(tasks,state,id,now=new Date().toISOString()){
 const plan=forPlan(tasks,id),byParent=new Map();
 for(const t of tasks)if(t.parent_id){if(!byParent.has(t.parent_id))byParent.set(t.parent_id,[]);byParent.get(t.parent_id).push(t);}
 const doomed=new Set(),stack=plan.group.map(t=>t.id);
 while(stack.length){const k=stack.pop();if(doomed.has(k))continue;doomed.add(k);for(const c of byParent.get(k)||[])stack.push(c.id);}
 const removed=tasks.filter(t=>doomed.has(t.id)),completed=removed.filter(t=>t.status==='completed');
 const next={...state,history:[...(state?.history||[])].filter(h=>h.id!=='study_plan:'+id)};
 if(completed.length)next.history.push({id:'study_plan:'+id,series_id:null,title:plan.base||'Study plan',due_date:plan.end||now.slice(0,10),ended_at:now,outcome:'completed',
  tasks:completed.map(t=>({title:t.title,status:'completed',ai_locked:!!t.ai_locked,verified_model:t.verified_model||null,project_id:t.project_id||'inbox',priority_id:t.priority_id||null,completed_at:t.completed_at||now}))});
 next.history=next.history.slice(-500);
 return {tasks:tasks.filter(t=>!doomed.has(t.id)),state:next,removed:removed.length,completed:completed.length};
}

// ---- Re-plan (Phase 2.4b) ----
// Only unfinished units move. Completed units, past days and finished parents stay where they are.
// Day parents left with nothing are removed; new day parents get ids "study_<plan>_<rev>_day_<i>" so the browser and
// the Worker build the exact same tasks from the same options.
const DAY=86400000,iso=ms=>new Date(ms).toISOString().slice(0,10);
const dateOK=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&iso(Date.parse(s+'T00:00:00Z'))===s;
const whole=(v,min,max,msg)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw Error(msg);return v;};
// The plan's tasks and everything under them.
function planTree(tasks,id){
 const ids=new Set((tasks||[]).filter(t=>t&&t.study_plan_id===id).map(t=>t.id));let grew=true;
 while(grew){grew=false;for(const t of tasks||[])if(t&&t.parent_id&&ids.has(t.parent_id)&&!ids.has(t.id)){ids.add(t.id);grew=true;}}
 return ids;
}
const coverageLine=(plural,numbers)=>root.TaskitatorStudyCore.coverage(plural,numbers);
const userPart=desc=>{const s=String(desc||'');return s.startsWith('Covers ')?(s.includes('\n')?s.slice(s.indexOf('\n')):''):(s?'\n'+s:'');};
function replanOptions(o){
 if(!o||typeof o!=='object')throw Error('Choose re-plan options.');
 const rev=String(o.rev||'');if(!/^[a-z0-9]{4,16}$/.test(rev))throw Error('Invalid re-plan identifier.');
 if(!dateOK(o.start))throw Error('Choose a valid starting date.');
 const weekdays=[...new Set(o.weekdays??[])];if(weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))throw Error('Choose valid weekdays.');
 const mode=o.mode==='perDay'?'perDay':'days';
 const startUnit=o.start_unit==null||o.start_unit===''?null:whole(o.start_unit,0,1000000,'Choose a valid starting unit.');
 const skipped=[...new Set(o.skipped??[])];if(skipped.length>1000||skipped.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid skipped unit.');
 const rates={};for(const [k,v]of Object.entries(o.rates||{})){const d=Number(k);if(!Number.isInteger(d)||d<0||d>6)throw Error('Choose valid weekdays.');if(v===''||v==null)continue;rates[d]=whole(Number(v),1,1000,'Use whole numbers within the displayed limits.');}
 const counts=o.counts==null?null:o.counts;
 const dates=o.dates==null?null:o.dates;
 if(dates&&(!counts||!Array.isArray(dates)||dates.length!==counts.length||dates.some((d,i)=>!dateOK(d)||d<o.start||(i&&d<=dates[i-1]))))throw Error('Choose valid study dates.');
 if(counts&&(!Array.isArray(counts)||!counts.length||counts.length>365||counts.some(n=>!Number.isSafeInteger(n)||n<1||n>1000)))throw Error('Each study day needs at least one unit.');
 return {rev,start:o.start,weekdays:weekdays.sort((a,b)=>a-b),mode,days:mode==='days'?whole(Number(o.days),1,365,'Study days must be 1–365.'):null,per:mode==='perDay'?whole(Number(o.per),1,1000,'Units per day must be 1–1,000.'):null,rates,startUnit,skipped:skipped.sort((a,b)=>a-b),counts:counts?[...counts]:null,dates:dates?[...dates]:null};
}
// Which unfinished units get scheduled, before any dates are chosen.
function replanUnits(plan,o){
 const open=plan.units.filter(u=>u.status==='active').sort((a,b)=>(unitNumber(a)??Infinity)-(unitNumber(b)??Infinity)||String(a.due_date).localeCompare(String(b.due_date)));
 const skip=new Set(o.skipped),keep=[],drop=[];
 for(const u of open){const n=unitNumber(u);((n!==null&&(skip.has(n)||(o.startUnit!==null&&n<o.startUnit)))?drop:keep).push(u);}
 return {open,keep,drop};
}
// Daily amounts for the units being scheduled. Option A: when per-date edits are given, their total must stay the same.
function replanCounts(total,o){
 const S=root.TaskitatorStudyCore;
 if(o.counts){const sum=o.counts.reduce((a,b)=>a+b,0);if(sum!==total)throw Error('The daily amounts must add up to '+total+' units.');return o.counts;}
 if(o.mode==='perDay')return S.weekdayPlan(total,o.per,o.rates,o.weekdays,o.start).counts;
 if(o.days>total)throw Error('Each study day needs at least one unit.');
 return Array.from({length:o.days},(_,i)=>Math.floor(total/o.days)+(i<total%o.days?1:0));
}
function replanDates(n,o){if(o.dates)return o.dates;const allowed=new Set(o.weekdays.length?o.weekdays:[0,1,2,3,4,5,6]),out=[];let at=Date.parse(o.start+'T00:00:00Z');while(out.length<n){if(allowed.has(new Date(at).getUTCDay()))out.push(iso(at));at+=DAY;}return out;}
// Per-date edit with the total fixed (Option A): +1 takes a unit from the end of the plan, −1 pushes one to the end.
function adjustCounts(counts,index,delta){
 const c=[...counts],last=c.length-1;if(!Number.isInteger(index)||index<0||index>last)throw Error('Choose a study day.');
 if(delta>0){if(index===last)throw Error('The last day has no later units to take.');c[index]++;c[last]--;if(!c[last])c.pop();}
 else if(delta<0){if(c[index]<=1)throw Error('Each study day needs at least one unit.');c[index]--;if(index===last){if(c.length>=365)throw Error('The limit is 365 study days.');c.push(1);}else c[last]++;}
 return c;
}
function replan(tasks,id,options){
 const o=replanOptions(options),plan=forPlan(tasks,id);
 if(plan.units.some(u=>u.status==='active'&&Object.keys(u).some(k=>k.startsWith('smart_'))))throw Error('This plan uses Smart Study early dates, which are fixed. It cannot be re-planned.');
 const {keep,drop}=replanUnits(plan,o);
 if(!keep.length)throw Error('No unfinished units are left to schedule. Delete the plan instead.');
 const counts=replanCounts(keep.length,o),dates=replanDates(counts.length,o);
 if(counts.length>365)throw Error('The limit is 365 study days.');
 // Removed units take everything under them.
 const byParent=new Map();for(const t of tasks)if(t.parent_id){if(!byParent.has(t.parent_id))byParent.set(t.parent_id,[]);byParent.get(t.parent_id).push(t);}
 const doomed=new Set(),stack=drop.map(u=>u.id);while(stack.length){const k=stack.pop();if(doomed.has(k))continue;doomed.add(k);for(const c of byParent.get(k)||[])stack.push(c.id);}
 const moving=new Set(keep.map(u=>u.id)),parentIds=new Set(plan.parents.map(p=>p.id));
 // A day parent stays if it is finished or still has a child that is not moving or removed.
 const stays=p=>p.status!=='active'||(byParent.get(p.id)||[]).some(c=>!moving.has(c.id)&&!doomed.has(c.id));
 for(const p of plan.parents)if(!stays(p))doomed.add(p.id);
 const kept=plan.parents.filter(p=>!doomed.has(p.id)),template=plan.parents.slice().sort((a,b)=>String(a.due_date).localeCompare(String(b.due_date)))[0];
 const base=plan.base||(plan.parents.length?'':'Study plan');
 let next=1;for(const p of kept){const m=/^(.*) (\d+)$/.exec(p.raw_title||p.title||'');if(m&&m[1]===base)next=Math.max(next,Number(m[2])+1);}
 if(!base)next=kept.length+1;
 const plural=plan.plural||((plan.unit||'unit')+'s'),extra=userPart(template?.description),fresh=[];let offset=0;
 const prio=plan.parentPriority===undefined?template?.priority_id:plan.parentPriority;
 const out=[];const placed=new Map();
 counts.forEach((count,i)=>{
  const pid='study_'+id+'_'+o.rev+'_day_'+i;if(tasks.some(t=>t.id===pid))throw Error('Re-plan identifier already used. Try again.');
  const units=keep.slice(offset,offset+count);offset+=count;const nums=units.map(unitNumber).filter(n=>n!==null);
  const title=(base||'Study plan')+' '+(next+i);
  const parent={study_plan_id:id,status:'active',project_id:template?.project_id||'inbox',tags:[...(template?.tags||[])],is_bonus:false,created_at:template?.created_at||null,completed_at:null,due_date:dates[i],
   id:pid,parent_id:null,title,raw_title:title,description:coverageLine(plural,nums)+extra,ai_locked:false,proof_criteria:'',raw_proof_criteria:'',strict_prerequisites:true,
   ...(prio?{priority_id:prio}:{}),...(typeof template?.status_count==='boolean'?{status_count:template.status_count}:{})};
  fresh.push(parent);for(const u of units)placed.set(u.id,{parent_id:pid,due_date:dates[i]});
 });
 for(const t of tasks){
  if(doomed.has(t.id))continue;
  const move=placed.get(t.id);
  if(move){const u={...t,parent_id:move.parent_id,due_date:move.due_date};if(typeof u.early_date==='string'&&u.early_date>=move.due_date)delete u.early_date;out.push(u);continue;}
  if(parentIds.has(t.id)){
   // A day that keeps some units gets an updated "Covers" line.
   const left=(byParent.get(t.id)||[]).filter(c=>!moving.has(c.id)&&!doomed.has(c.id)).map(unitNumber).filter(n=>n!==null);
   if(left.length&&String(t.description||'').startsWith('Covers ')){const d=coverageLine(plural,left)+userPart(t.description);if(d!==t.description){out.push({...t,description:d});continue;}}
  }
  out.push(t);
 }
 out.push(...fresh);
 return {tasks:out,scheduled:keep.length,removed:drop.length,days:counts.length,counts,dates,end:dates.at(-1)};
}
// Effective due date: own date, else nearest dated ancestor.
function dueOf(by,t){const seen=new Set();for(let n=t;n&&!seen.has(n.id);n=by.get(n.parent_id)){seen.add(n.id);const d=typeof n.due_date==='string'?n.due_date.trim():'';if(d)return d;}return '';}
// What a re-plan loosens. Shared by the page (to warn) and the Worker (to decide).
//  later: AI-protected tasks that move to a later date or are removed -> needs an active Emergency Bypass window.
//  today: counting tasks due today (or overdue) that stop being due today or are removed -> phone-lock rule (bypass or today finished).
function replanImpact(before,after,id,today,settings){
 const SC=root.TaskitatorStatusCount,b=new Map(before.map(t=>[t.id,t])),a=new Map(after.map(t=>[t.id,t])),later=[],dueToday=[];
 for(const tid of planTree(before,id)){
  const old=b.get(tid),now=a.get(tid);if(!old||old.status!=='active')continue;
  const was=dueOf(b,old),will=now?dueOf(a,now):null;
  if(isAudited(old)&&(will===null||(dateOK(was)&&dateOK(will)?will>was:will!==was)))later.push(tid);
  // An emptied day parent is not work by itself: its units are judged one by one.
  const emptiedDay=!now&&old.study_plan_id===id&&!old.parent_id;
  if(SC&&!emptiedDay&&SC.dueNow(b,old,today)&&SC.counts(b,old,settings)&&(!now||!SC.dueNow(a,now,today)))dueToday.push(tid);
 }
 return {later,today:dueToday};
}

root.TaskitatorStudyManage={auditTargets,assignUnits,balance,planTree,replan,replanOptions,replanUnits,replanCounts,adjustCounts,replanImpact,configOf,unitNumber,plans,renamePlan,renameUnit,setPriorities,addCriteria,openUnits,deletePlan,prioritiesOf,rankOf,isAudited};
})(typeof window==='undefined'?globalThis:window);

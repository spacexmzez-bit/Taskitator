/* Numeric labels and study-plan early groups (Phase 6.1.2). Shared by the browser pages and tests.
   Labels: a numeric label at the START of a title ("5.10 Revise", "5.1-0-1 Notes") is read as integer segments.
   The part after the dot is one integer (5.10 = 5, 10). Hyphens split it into separate numbers (5.1-0-1 = 5, 1, 0, 1).
   Ordering compares segment by segment: the first segment decides, later ones only break ties.
   Anything else falls back to a numeric-aware text compare (the app's existing alphabetical order).
   Early groups: in Today, early study-plan units whose plan has no umbrella due today are shown under a derived,
   never-stored header "<plan> X.n", where X is the last plan day before today and n is the number of days after
   day X (5.1 = the day after day 5). Before the first plan day, X is 0 and n counts the days left until day 1. */
(function(root){
'use strict';
const LEAD=/^(\d+)(?:\.(\d+(?:-\d+)*))?(?=\s|$)/;
function parse(title){
 const m=LEAD.exec(String(title??'').trim());
 if(!m)return null;
 return [Number(m[1]),...(m[2]?m[2].split('-').map(Number):[])];
}
function compareSegments(a,b){
 for(let i=0;i<Math.max(a.length,b.length);i++){
  if(a[i]===undefined)return -1;if(b[i]===undefined)return 1;
  if(a[i]!==b[i])return a[i]-b[i];
 }
 return 0;
}
const text=(x,y)=>String(x??'').localeCompare(String(y??''),undefined,{sensitivity:'base',numeric:true});
function compare(x,y){
 const a=parse(x),b=parse(y);
 if(a&&b){const c=compareSegments(a,b);if(c)return c;}
 return text(x,y);
}
const ISO=/^\d{4}-\d{2}-\d{2}$/;
const dayNumber=t=>{const m=/ (\d+)$/.exec(String(t?.raw_title||t?.title||''));return m?Number(m[1]):null;};
const baseOf=t=>{const m=/^(.*) \d+$/.exec(String(t?.raw_title||t?.title||''));return m?m[1]:(t?.title||'Study plan');};
// Returns { headers: [{id,title,study_plan_id,project_id,date}], parentOf: Map(unitId -> parentId) } for today's early units.
function earlyGroups(tasks,today){
 const list=(tasks||[]).filter(t=>t&&typeof t==='object'),out={headers:[],parentOf:new Map()};
 const plans=new Map();
 for(const t of list)if(t.study_plan_id&&t.status!=='trash'){if(!plans.has(t.study_plan_id))plans.set(t.study_plan_id,[]);plans.get(t.study_plan_id).push(t);}
 for(const [id,group] of plans){
  const parents=group.filter(t=>!t.parent_id&&ISO.test(t.due_date||'')),pids=new Set(parents.map(p=>p.id));
  const early=group.filter(u=>u.status==='active'&&u.parent_id&&pids.has(u.parent_id)&&u.early_date===today&&!u.smart_early_date&&!u.recurrence_series_id&&
   (group.find(p=>p.id===u.parent_id)?.due_date||'')>today);
  if(!early.length)continue;
  const real=parents.find(p=>p.due_date===today&&p.status!=='trash');
  if(real){for(const u of early)out.parentOf.set(u.id,real.id);continue;}
  const sorted=[...parents].sort((a,b)=>a.due_date.localeCompare(b.due_date)||(dayNumber(a)??0)-(dayNumber(b)??0));
  const before=sorted.filter(p=>p.due_date<today).at(-1),after=sorted.find(p=>p.due_date>today);
  // Only today's group is ever on screen (early appearances expire after their day), so a running index would
  // always be 1. n is the number of days after day X instead: unique, stable from day to day and in date order.
  const gapDays=(a,b)=>Math.round((Date.parse(b+'T00:00Z')-Date.parse(a+'T00:00Z'))/86400000);
  const x=before?(dayNumber(before)??sorted.indexOf(before)+1):0,n=before?gapDays(before.due_date,today):gapDays(today,after.due_date);
  const header={id:'early_group_'+id+'_'+today,title:baseOf(sorted[0])+' '+x+'.'+n,study_plan_id:id,project_id:sorted[0]?.project_id||'inbox',date:today,x,n};
  out.headers.push(header);
  for(const u of early)out.parentOf.set(u.id,header.id);
 }
 return out;
}
const api={parse,compare,compareSegments,earlyGroups};
root.TaskitatorLabels=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);

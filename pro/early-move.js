/* Pull from tomorrow (Pro). Pure rules; the Today page and the tests share them.
   A plan unlocks when everything that is on today's list for that plan is done AND every AI-audited task
   outside the plan that is due (or overdue) today is done. Pulling uses the early-bonus mechanism:
   the unit keeps tomorrow's due date and shows today as optional work. The gate is client-side only. */
(function(root){
'use strict';
const audited=t=>Boolean(t&&(t.ai_locked||t.require_ai_proof));
const num=t=>{const m=/\{num==(\d+)\}$/.exec(t.raw_title||'');return m?Number(m[1]):null;};
const plain=t=>t.title||(t.raw_title||'').replace(/\s*\{num==\d+\}$/,'');
function addDay(date){const d=new Date(date+'T00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
// On today's list: due today or overdue, or shown early today (early bonus or Smart Study).
function onToday(by,t,today){const due=root.TaskitatorEarly.dueOf(by,t);return Boolean(due&&due<=today)||t.early_date===today||t.smart_early_date===today;}
function blocks(tasks,today){
 const E=root.TaskitatorEarly,by=E.index(tasks),tomorrow=addDay(today),groups=new Map();
 for(const t of tasks||[])if(t&&t.study_plan_id&&t.status!=='trash'){if(!groups.has(t.study_plan_id))groups.set(t.study_plan_id,[]);groups.get(t.study_plan_id).push(t);}
 const out=[];
 for(const [id,group] of groups){
  const parents=group.filter(t=>!t.parent_id),pids=new Set(parents.map(p=>p.id)),units=group.filter(t=>t.parent_id&&pids.has(t.parent_id)&&!t.is_bonus);
  const pull=units.filter(u=>u.status==='active'&&!u.recurrence_series_id&&!u.smart_early_date&&!u.early_date&&E.dueOf(by,u)===tomorrow)
   .sort((a,b)=>(num(a)??1e9)-(num(b)??1e9)||String(a.id).localeCompare(String(b.id)));
  if(!pull.length)continue;
  const own=group.filter(t=>t.status==='active'&&!t.is_bonus&&units.includes(t)&&onToday(by,t,today)).length;
  const others=(tasks||[]).filter(t=>t&&t.status==='active'&&audited(t)&&t.study_plan_id!==id&&onToday(by,t,today)&&!(tasks||[]).some(c=>c&&c.parent_id===t.id&&c.status==='active')).length;
  const m=/^(.*) \d+$/.exec(parents[0]?.raw_title||parents[0]?.title||'');
  out.push({id,name:m?m[1]:(parents[0]?.title||'Study plan'),own,others,locked:own>0||others>0,units:pull.map(u=>({id:u.id,title:plain(u)}))});
 }
 return out.sort((a,b)=>a.name.localeCompare(b.name));
}
// Applies the pick. Only units of an unlocked block can move.
function apply(tasks,ids,today){
 const ok=new Set();
 for(const b of blocks(tasks,today))if(!b.locked)for(const u of b.units)ok.add(u.id);
 const pick=[...new Set(ids)].filter(id=>ok.has(id));
 const result=root.TaskitatorEarly.set(tasks,pick,today,today);
 result.rejected=(ids||[]).length-pick.length;
 return result;
}
root.TaskitatorEarlyMove={blocks,apply,addDay};
})(typeof window==='undefined'?globalThis:window);

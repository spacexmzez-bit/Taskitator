/* Phone-lock counting modes. Shared by the browser and the Worker.
   harsh   : every task due today (or earlier) counts toward device_locked. Bonus tasks count only when
             "Count bonus tasks" (status_bonus_count) is on.
   normal  : only tasks whose "count" flag is on count. Required tasks default to on (inherited from the nearest
             ancestor with an explicit flag). Bonus tasks use their own flag only; without one they follow
             status_bonus_count.
   limited : only AI-locked tasks count. Bonus tasks never count.
   AI-locked tasks always count. Undated tasks never count (Phase 6.1.1).
   Phase 7.7: a collab task copy whose owner set a phone lock (collab_link.phone) always counts, like AI-locked tasks:
   its assignee agreed to it.
   Bonus = is_bonus, or Dynamic Bonus (dynamic_bonus) once every required descendant is done and at least one
   required descendant exists (completed). Dynamic Bonus is derived, never stored. */
(function(root){
'use strict';
const RANK={limited:0,normal:1,harsh:2};
const mode=settings=>RANK[settings?.status_mode]!==undefined?settings.status_mode:'harsh';
const bonusCount=settings=>settings?.status_bonus_count===true;
const audited=t=>Boolean(t&&(t.ai_locked||t.require_ai_proof));
const index=tasks=>new Map((tasks||[]).filter(t=>t&&typeof t==='object').map(t=>[t.id,t]));
// Ids of every effective bonus task: manual bonus, plus Dynamic Bonus parents whose required work is done.
// A descendant counts as required unless it is itself (effectively) bonus. Trashed tasks are ignored.
function bonusIds(tasks){
 const list=(tasks||[]).filter(t=>t&&typeof t==='object'&&t.id!=null),kids=new Map(),memo=new Map();
 for(const t of list)if(t.parent_id!=null&&t.status!=='trash'){if(!kids.has(t.parent_id))kids.set(t.parent_id,[]);kids.get(t.parent_id).push(t);}
 const isBonus=(t,path)=>{
  if(memo.has(t.id))return memo.get(t.id);
  let out=Boolean(t.is_bonus);
  if(!out&&t.dynamic_bonus===true&&!audited(t)&&!path.has(t.id)){
   path.add(t.id);let done=false,open=false;const seen=new Set([t.id]),stack=[...(kids.get(t.id)||[])];
   while(stack.length&&!open){const c=stack.pop();if(seen.has(c.id))continue;seen.add(c.id);
    if(!path.has(c.id)&&!isBonus(c,path)){if(c.status==='completed')done=true;else if(c.status==='active')open=true;}
    for(const k of kids.get(c.id)||[])stack.push(k);}
   path.delete(t.id);out=done&&!open;
  }
  memo.set(t.id,out);return out;
 };
 const ids=new Set();for(const t of list)if(t.status!=='trash'&&isBonus(t,new Set()))ids.add(t.id);
 return ids;
}
// Does a Dynamic Bonus task have any required descendant at all? Without one, Dynamic Bonus never turns it bonus.
function hasRequired(tasks,id){
 const bonus=bonusIds(tasks),kids=new Map();
 for(const t of tasks||[])if(t&&t.parent_id!=null&&t.status!=='trash'){if(!kids.has(t.parent_id))kids.set(t.parent_id,[]);kids.get(t.parent_id).push(t);}
 const seen=new Set([id]),stack=[...(kids.get(id)||[])];
 while(stack.length){const c=stack.pop();if(seen.has(c.id))continue;seen.add(c.id);if(!bonus.has(c.id))return true;for(const k of kids.get(c.id)||[])stack.push(k);}
 return false;
}
// Effective flag: own explicit value, else nearest ancestor's explicit value, else true. (Required tasks.)
function effective(by,task){
 let n=task;
 for(let i=0;n&&i<100;i++){if(typeof n.status_count==='boolean')return n.status_count;n=n.parent_id?by.get(n.parent_id):null;}
 return true;
}
// bonus: optional Set from bonusIds(); without it only is_bonus is treated as bonus.
const forced=t=>Boolean(t&&(t.ai_locked||t.collab_link?.phone===true));
function counts(by,task,settings,bonus){
 if(forced(task))return true;
 const m=mode(settings);
 if(m==='limited')return false;
 const isBonus=bonus?bonus.has(task.id):Boolean(task.is_bonus);
 if(isBonus)return m==='harsh'?bonusCount(settings):(typeof task.status_count==='boolean'?task.status_count:bonusCount(settings));
 return m==='harsh'?true:effective(by,task);
}
// Due now: "today", or today/overdue (own date, else nearest dated ancestor). Undated tasks are never due now.
function dueNow(by,task,today){
 let due='',n=task;const seen=new Set();
 while(n&&!seen.has(n)){seen.add(n);const d=typeof n.due_date==='string'?n.due_date.trim().toLowerCase():'';if(d){due=d;break;}n=by.get(n.parent_id);}
 if(!due)return false;
 return due==='today'||(/^\d{4}-\d{2}-\d{2}$/.test(due)&&due<=today);
}
// Locks the settings: any active task due now, regardless of mode, except bonus tasks unless they count
// (status_bonus_count on, and not Limited). AI-locked tasks always lock.
function pending(tasks,today,settings){
 const by=index(tasks),bonus=bonusIds(tasks),withBonus=mode(settings)!=='limited'&&bonusCount(settings);
 return (tasks||[]).some(t=>!t||typeof t!=='object'||(t.status==='active'&&dueNow(by,t,today)&&(forced(t)||withBonus||!bonus.has(t.id))));
}
// Does any active due task count under the record's settings?
function unfinished(tasks,settings,today){
 const by=index(tasks),bonus=bonusIds(tasks);
 return (tasks||[]).some(t=>!t||typeof t!=='object'||(t.status==='active'&&dueNow(by,t,today)&&counts(by,t,settings,bonus)));
}
// Worker: which parts of this change loosen the phone lock? Tightening and creating tasks unchecked are always fine.
// setting: a message for a looser mode or "Count bonus tasks" turned off. tasks: [{id,message}] per loosened task.
function loosenings(previous,next,today){
 const out={setting:null,tasks:[]};
 if(!previous)return out;
 if(RANK[mode(next.settings)]<RANK[mode(previous.settings)])out.setting='Loosening the phone-lock mode is locked until all of today\'s tasks are finished or Emergency Bypass is on.';
 else if(mode(previous.settings)!=='limited'&&bonusCount(previous.settings)&&!bonusCount(next.settings))out.setting='Turning off "Count bonus tasks" is locked until all of today\'s tasks are finished or Emergency Bypass is on.';
 const before=index(previous.tasks),after=index(next.tasks),bb=bonusIds(previous.tasks),ab=bonusIds(next.tasks);
 for(const old of before.values()){
  if(old.status!=='active'||!dueNow(before,old,today))continue;
  const now=after.get(old.id),add=message=>out.tasks.push({id:old.id,message});
  if(bb.has(old.id)){
   // A counted bonus task due today may be finished, but not removed, moved out of today or uncounted.
   if(!counts(before,old,previous.settings,bb))continue;
   if(!now||now.status==='trash'||(now.status==='active'&&(!dueNow(after,now,today)||!counts(after,now,next.settings,ab))))
    add('Removing, moving or uncounting bonus tasks that count toward today\'s phone lock is locked until all of today\'s tasks are finished or Emergency Bypass is on.');
   continue;
  }
  if(!now)continue;
  if(effective(before,old)&&!effective(after,now)){add('Unchecking "Count toward phone lock" on today\'s tasks is locked until all of today\'s tasks are finished or Emergency Bypass is on.');continue;}
  // Required work due today that turns into uncounted bonus work (Bonus, or Dynamic Bonus switched on).
  if(now.status==='active'&&ab.has(now.id)&&dueNow(after,now,today)&&counts(before,old,previous.settings,bb)&&!counts(after,now,next.settings,ab))
   add('Turning today\'s counted work into bonus work is locked until all of today\'s tasks are finished or Emergency Bypass is on.');
 }
 return out;
}
function loosened(previous,next,today){const l=loosenings(previous,next,today);return l.setting||l.tasks[0]?.message||null;}
// Worker: Bonus / Dynamic Bonus / AI audit exclusivity (Phase 6.1.1). Returns [{id,message}] for tasks that break it.
// Unchanged existing combinations are kept. Study-plan units are exempt from the Bonus + AI audit rule: the plan
// engine moves audited units between required and bonus while balancing days.
function bonusRules(previous,next){
 const before=index(previous?.tasks),out=[];
 for(const t of next?.tasks||[]){
  if(!t||typeof t!=='object'||t.status==='trash')continue;
  const old=before.get(t.id),same=k=>Boolean(old&&old[k])===Boolean(t[k])&&audited(old)===audited(t);
  if(t.dynamic_bonus===true&&t.is_bonus&&!(same('dynamic_bonus')&&same('is_bonus')))out.push({id:t.id,message:'A task can be Bonus or Dynamic Bonus, not both.'});
  else if(t.dynamic_bonus===true&&audited(t)&&!same('dynamic_bonus'))out.push({id:t.id,message:'AI-audited tasks can\'t use Dynamic Bonus.'});
  else if(t.is_bonus&&audited(t)&&!t.study_plan_id&&!same('is_bonus'))out.push({id:t.id,message:'AI-audited tasks can\'t be bonus work.'});
 }
 return out;
}
// Browser: set the explicit flag on the selected tasks. Children without their own flag follow automatically.
function set(tasks,ids,value){let n=0;const pick=new Set(ids);for(const t of tasks||[])if(pick.has(t.id)){t.status_count=!!value;n++;}return n;}
root.TaskitatorStatusCount={RANK,mode,bonusCount,bonusIds,hasRequired,index,effective,counts,dueNow,pending,unfinished,loosenings,loosened,bonusRules,set};
})(typeof window==='undefined'?globalThis:window);

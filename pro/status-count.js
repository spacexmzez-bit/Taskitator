/* Phone-lock counting modes. Shared by the browser and the Worker.
   harsh   : every task due today (or earlier / undated) counts toward device_locked.
   normal  : only tasks whose "count" flag is on count (default on).
   limited : only AI-locked tasks count.
   AI-locked tasks always count. The flag is `status_count`; a task without one follows its nearest ancestor with one, else on. */
(function(root){
'use strict';
const RANK={limited:0,normal:1,harsh:2};
const mode=settings=>RANK[settings?.status_mode]!==undefined?settings.status_mode:'harsh';
const index=tasks=>new Map((tasks||[]).filter(t=>t&&typeof t==='object').map(t=>[t.id,t]));
// Effective flag: own explicit value, else nearest ancestor's explicit value, else true.
function effective(by,task){
 let n=task;
 for(let i=0;n&&i<100;i++){if(typeof n.status_count==='boolean')return n.status_count;n=n.parent_id?by.get(n.parent_id):null;}
 return true;
}
function counts(by,task,settings){
 if(task.ai_locked)return true;
 const m=mode(settings);
 return m==='harsh'?true:m==='normal'?effective(by,task):false;
}
// Same due test the status endpoint always used: undated, "today", or today/overdue (own date, else nearest dated ancestor).
function dueNow(by,task,today){
 let due='',n=task;const seen=new Set();
 while(n&&!seen.has(n)){seen.add(n);const d=typeof n.due_date==='string'?n.due_date.trim().toLowerCase():'';if(d){due=d;break;}n=by.get(n.parent_id);}
 const valid=/^\d{4}-\d{2}-\d{2}$/.test(due);
 return !due||due==='today'||(valid&&due<=today);
}
// Any active task due now, regardless of mode: this is what locks the settings.
function pending(tasks,today){
 const by=index(tasks);
 return (tasks||[]).some(t=>!t||typeof t!=='object'||(t.status==='active'&&dueNow(by,t,today)));
}
// Does any active due task count under the record's settings?
function unfinished(tasks,settings,today){
 const by=index(tasks);
 return (tasks||[]).some(t=>!t||typeof t!=='object'||(t.status==='active'&&dueNow(by,t,today)&&counts(by,t,settings)));
}
// Worker: is this change a loosening? Returns a message or null. Tightening and creating tasks unchecked are always fine.
function loosened(previous,next,today){
 if(!previous)return null;
 if(RANK[mode(next.settings)]<RANK[mode(previous.settings)])return 'Loosening the phone-lock mode is locked until all of today\'s tasks are finished or Emergency Bypass is on.';
 const before=index(previous.tasks),after=index(next.tasks);
 for(const old of before.values()){
  const now=after.get(old.id);
  if(!now||old.status!=='active'||!dueNow(before,old,today))continue;
  if(effective(before,old)&&!effective(after,now))return 'Unchecking "Count toward phone lock" on today\'s tasks is locked until all of today\'s tasks are finished or Emergency Bypass is on.';
 }
 return null;
}
// Browser: set the explicit flag on the selected tasks. Children without their own flag follow automatically.
function set(tasks,ids,value){let n=0;const pick=new Set(ids);for(const t of tasks||[])if(pick.has(t.id)){t.status_count=!!value;n++;}return n;}
root.TaskitatorStatusCount={RANK,mode,effective,counts,dueNow,pending,unfinished,loosened,set};
})(typeof window==='undefined'?globalThis:window);

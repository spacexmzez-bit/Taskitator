/* Early bonus (Pro). A task keeps its real due date; early_date adds an optional appearance on one earlier day.
   Shared by the browser and the Worker. Nothing here moves a due date or any other task. */
(function(root){
'use strict';
const ISO=/^\d{4}-\d{2}-\d{2}$/;
const date=s=>typeof s==='string'&&ISO.test(s)&&new Date(s+'T00:00Z').toISOString().slice(0,10)===s;
const index=tasks=>new Map((tasks||[]).filter(Boolean).map(t=>[t.id,t]));
// Own due date, else the nearest ancestor's. 'today' and empty values are not dates, so they never qualify.
function dueOf(by,task){let n=task;for(let i=0;n&&i<100;i++){if(date(n.due_date))return n.due_date;n=n.parent_id?by.get(n.parent_id):null;}return null;}
function reason(by,task,early,today){
 if(!task||task.status!=='active')return 'Only active tasks can be shown early.';
 if(task.recurrence_series_id)return 'Recurring tasks cannot be shown early.';
 if(task.smart_early_date)return 'Already shown early by Smart Study.';
 if(!date(early))return 'Choose a valid date.';
 if(early<today)return 'The early date cannot be in the past.';
 const due=dueOf(by,task);
 if(!due)return 'The task has no due date.';
 if(early>=due)return 'The early date must be before the due date ('+due+').';
 return null;
}
// Sets early_date on the selected tasks. A selected subtask under a selected, eligible parent is covered by the parent.
function set(tasks,ids,early,today){
 const by=index(tasks),pick=new Set(ids),result={set:[],covered:[],skipped:[]};
 const covered=t=>{for(let p=by.get(t.parent_id),i=0;p&&i<100;p=by.get(p.parent_id),i++)if(pick.has(p.id)&&!reason(by,p,early,today))return true;return false;};
 for(const id of pick){const t=by.get(id);if(!t)continue;
  if(covered(t)){result.covered.push(id);continue;}
  const why=reason(by,t,early,today);
  if(why){result.skipped.push({id,title:t.title,reason:why});continue;}
  t.early_date=early;result.set.push(id);
 }
 return result;
}
function clear(tasks,ids){let n=0;const pick=new Set(ids);for(const t of tasks)if(pick.has(t.id)&&t.early_date!==undefined){delete t.early_date;n++;}return n;}
// Is this early appearance showing today? Requires a still-valid early date (before the current due date).
function showing(by,task,today){return !!task&&task.status==='active'&&task.early_date===today&&!task.recurrence_series_id&&!task.smart_early_date&&(dueOf(by,task)||'')>today;}
// Display copies for today's view. The real task is untouched; the copy is optional work dated today.
function view(tasks,today){
 const by=index(tasks);
 return (tasks||[]).map(t=>{
  if(!t||t.early_date===undefined||!showing(by,t,today))return t;
  return {...t,due_date:today,is_bonus:true,early_due:dueOf(by,t),early_bonus:!!t.is_bonus};
 });
}
// Dates on which this task also appears, for the calendar. Only still-valid, not-yet-past appearances.
function appearance(by,task,today){
 if(!task||task.status!=='active'||!date(task.early_date)||task.early_date<today||task.recurrence_series_id||task.smart_early_date)return null;
 const due=dueOf(by,task);return due&&task.early_date<due?task.early_date:null;
}
// Worker: drop appearances that can no longer apply (past, finished, removed, or the due date moved up to them).
function apply(snapshot,now=Date.now()){
 const today=root.TaskitatorRecurrence.today(now,Number(snapshot.settings?.day_start_hour)||0),by=index(snapshot.tasks);
 for(const t of snapshot.tasks||[]){
  if(t.early_date===undefined)continue;
  const due=dueOf(by,t);
  if(t.status!=='active'||!date(t.early_date)||t.early_date<today||!due||t.early_date>=due)delete t.early_date;
 }
 return snapshot;
}
// Worker: validate every new or changed early_date. Clearing one is always allowed.
function guard(previous,next){
 const before=index(previous?.tasks),by=index(next?.tasks);
 for(const t of next?.tasks||[]){
  if(t.early_date===undefined||t.early_date===null){if(t.early_date===null)throw Error('Invalid early date.');continue;}
  const old=before.get(t.id);
  if(old&&old.early_date===t.early_date)continue;
  if(!date(t.early_date))throw Error('Choose a valid early date.');
  if(t.status!=='active')throw Error('Only active tasks can be shown early.');
  if(t.recurrence_series_id)throw Error('Recurring tasks cannot be shown early.');
  if(t.smart_early_date)throw Error('A task already shown early by Smart Study cannot get another early date.');
  const due=dueOf(by,t);
  if(!due||t.early_date>=due)throw Error('The early date must be before the due date.');
 }
}
// Tasks whose early date was added or changed in this snapshot (these need Pro).
function changed(previous,next){const before=index(previous?.tasks);return (next?.tasks||[]).filter(t=>t.early_date!==undefined&&t.early_date!==null&&before.get(t.id)?.early_date!==t.early_date);}
root.TaskitatorEarly={date,index,dueOf,reason,set,clear,showing,view,appearance,apply,guard,changed};
})(typeof window==='undefined'?globalThis:window);

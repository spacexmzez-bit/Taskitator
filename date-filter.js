/* Date filter for task lists (display only; never changes stored data).
   Matches the effective due date (own or inherited). Early tasks also match on their early date. */
(function(root){
'use strict';
const ISO=/^\d{4}-\d{2}-\d{2}$/;
const add=(iso,n)=>{const d=new Date(iso+'T00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
function active(f){return !!f&&['overdue','today','week','none','range'].includes(f.mode)&&(f.mode!=='range'||ISO.test(f.from||'')||ISO.test(f.to||''));}
function dueOf(by,task,today){
 for(let n=task,i=0;n&&i<100;i++){const raw=String(n.due_date||'').trim().toLowerCase();if(raw==='today')return today;if(ISO.test(raw))return raw;n=n.parent_id?by.get(n.parent_id):null;}
 return null;
}
function matches(task,by,today,f){
 if(!active(f))return true;
 const due=dueOf(by,task,today),E=root.TaskitatorEarly,early=E?E.appearance(by,task,today):null;
 const within=(a,b)=>d=>!!d&&d>=a&&d<=b;
 if(f.mode==='overdue')return !!due&&due<today;
 if(f.mode==='today')return due===today||early===today;
 if(f.mode==='week'){const t=within(today,add(today,6));return t(due)||t(early);}
 if(f.mode==='none')return !due;
 let a=ISO.test(f.from||'')?f.from:'0000-01-01',b=ISO.test(f.to||'')?f.to:'9999-12-31';if(a>b)[a,b]=[b,a];
 const t=within(a,b);return t(due)||t(early);
}
// Ids to show: every match plus its ancestors (parents stay visible for context).
function visible(tasks,today,f){
 const by=new Map((tasks||[]).filter(Boolean).map(t=>[t.id,t])),keep=new Set();
 for(const t of by.values()){if(t.status==='trash'||!matches(t,by,today,f))continue;for(let n=t,i=0;n&&!keep.has(n.id)&&i<200;i++){keep.add(n.id);n=n.parent_id?by.get(n.parent_id):null;}}
 return keep;
}
root.TaskitatorDateFilter={active,matches,visible,dueOf};
})(typeof window==='undefined'?globalThis:window);

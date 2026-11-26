/* Phase 3.7.5: one read-only schedule view (Calendar or List) shared by the plan builder's Summary and the
   Study plans page Preview. Dots: Main (blue), Bonus (orange), Early (purple). A unit shown early appears as Early
   on its early date and as Main on its due date. Nothing here edits a plan. */
(function(root){
'use strict';
const KINDS=['main','bonus','early'],LABEL={main:'Main',bonus:'Bonus',early:'Early'};
const tr=(k,v)=>{const I=root.TaskitatorI18n;return I&&I.t?I.t(k,v||{}):k.replace(/\{(\w+)\}/g,(_,x)=>(v||{})[x]);};
function mk(tag,text,parent,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;if(parent)parent.append(e);return e;}
// entries: [{date, kind, text, n?}] -> Map(date -> {main:[],bonus:[],early:[]}) with items sorted by n then text.
function group(entries){
 const days=new Map();
 for(const e of entries||[]){if(!e||!e.date||!KINDS.includes(e.kind))continue;if(!days.has(e.date))days.set(e.date,{main:[],bonus:[],early:[]});days.get(e.date)[e.kind].push(e);}
 for(const d of days.values())for(const k of KINDS)d[k].sort((a,b)=>(a.n??1e9)-(b.n??1e9)||String(a.text).localeCompare(String(b.text)));
 return days;
}
// A saved plan (TaskitatorStudyManage.plans item) -> entries. Early = Smart Study early date or a pulled-forward early_date.
function fromPlan(plan){
 const due=new Map((plan.parents||[]).map(p=>[p.id,p.due_date])),out=[];
 for(const u of plan.units||[]){
  const d=due.get(u.parent_id);if(!d)continue;
  const m=/\{num==(\d+)\}$/.exec(u.raw_title||''),n=m?Number(m[1]):null,text=(u.status==='completed'?'✓ ':'')+(u.title||(u.raw_title||'').replace(/\s*\{num==\d+\}$/,''));
  const e=!u.is_bonus?(u.smart_early_date&&!u.smart_adjusted?u.smart_early_date:u.early_date):null,early=e&&e<d?e:null;
  out.push({date:d,kind:u.is_bonus?'bonus':'main',n,text:text+(early?' · '+tr('also early on {date}',{date:early}):'')});
  if(early)out.push({date:early,kind:'early',n,text:text+' · '+tr('due {date}',{date:d})});
 }
 return out;
}
function items(days,d){const s=days.get(d);return s?KINDS.flatMap(k=>s[k].map(e=>[k,e.text])):[];}
// state: {view:'cal'|'list', month:'YYYY-MM'|null, sel:string|null}. again(): called after the state changes.
function render(box,days,state,again,opts={}){
 const dates=[...days.keys()].sort(),fmtMonth=opts.fmtMonth||(ym=>ym);
 if(!dates.length){mk('p',tr('Nothing scheduled yet.'),box,'plan-hint');return;}
 const seg=mk('div',undefined,box,'ss-sum-seg');
 for(const [k,t] of [['cal','Calendar'],['list','List']]){const b=mk('button',tr(t),seg,state.view===k?'is-on':'');b.type='button';b.setAttribute('data-sum-view',k);b.setAttribute('aria-pressed',String(state.view===k));b.onclick=()=>{state.view=k;again();};}
 const legend=mk('div',undefined,box,'ss-sum-legend');
 for(const k of KINDS){const l=mk('span',undefined,legend);mk('i',undefined,l,'sum-dot is-'+k);mk('span',tr(LABEL[k]),l);}
 const line=(parent,k,t)=>{const it=mk('div',undefined,parent,'ss-sum-item');mk('i',undefined,it,'sum-dot is-'+k);mk('span',t,it);return it;};
 if(state.view==='list'){
  const list=mk('div',undefined,box,'ss-sum-list');
  for(const d of dates){const row=mk('div',undefined,list,'ss-sum-day');mk('strong',opts.fmtDay?opts.fmtDay(d):d,row);const col=mk('div',undefined,row,'ss-sum-items');for(const [k,t] of items(days,d))line(col,k,t);}
  return;
 }
 if(!state.month||!/^\d{4}-\d{2}$/.test(state.month))state.month=dates[0].slice(0,7);
 const [y,m]=state.month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)),len=new Date(Date.UTC(y,m,0)).getUTCDate();
 const nav=mk('div',undefined,box,'ss-cal-nav'),go=k=>{state.month=new Date(Date.UTC(y,m-1+k,1)).toISOString().slice(0,7);state.sel=null;again();};
 const prev=mk('button','‹',nav,'ss-cal-arrow');prev.type='button';prev.setAttribute('aria-label',tr('Previous month'));prev.onclick=()=>go(-1);
 mk('strong',fmtMonth(state.month),nav);
 const next=mk('button','›',nav,'ss-cal-arrow');next.type='button';next.setAttribute('aria-label',tr('Next month'));next.onclick=()=>go(1);
 const grid=mk('div',undefined,box,'calendar-grid ss-cal');
 for(const n of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])mk('div',tr(n),grid,'calendar-day-header');
 for(let k=0;k<first.getUTCDay();k++)mk('div','',grid,'calendar-cell empty');
 for(let n=1;n<=len;n++){
  const d=state.month+'-'+String(n).padStart(2,'0'),sl=days.get(d),cell=mk('button',undefined,grid,'calendar-cell ss-cell'+(d===state.sel?' selected':'')+(sl?'':' is-off'));cell.type='button';cell.setAttribute('data-sum-date',d);
  mk('span',String(n),cell,'calendar-date-number');
  if(sl){const dots=mk('div',undefined,cell,'calendar-dots-row');for(const k of KINDS)if(sl[k].length)mk('span',undefined,dots,'sum-dot is-'+k);cell.onclick=()=>{state.sel=d;again();};}else cell.disabled=true;
 }
 const det=mk('div',undefined,box,'ss-detail');
 if(state.sel&&days.has(state.sel)){mk('strong',opts.fmtDay?opts.fmtDay(state.sel):state.sel,det);for(const [k,t] of items(days,state.sel)){const it=line(det,k,t);mk('small',tr(LABEL[k]),it,'ss-hint');}}
 else mk('p',tr('Select a date to see its tasks.'),det,'ss-hint');
}
root.TaskitatorPlanCalendar={group,fromPlan,render,tr,KINDS};
})(typeof window==='undefined'?globalThis:window);

/* Finite personal study plans. Shared deterministic core and browser preview. */
(function(root){
 'use strict';
 const dateOK=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 const int=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('Use whole numbers within the displayed limits.');return v;};
 function normalize(c){
  if(typeof c.title!=='string'||!c.title.trim()||c.title.length>160)throw Error('Enter a title, up to 160 characters.');
  const total=int(c.total,1,1000),days=int(c.days,1,365),first=int(c.first??1,1,1000000),bonus=int(c.bonus??0,0,1000);if(days>total)throw Error('Each study day needs at least one unit.');if(!dateOK(c.start))throw Error('Choose a valid starting date.');
  const weekdays=c.weekdays??[];if(!Array.isArray(weekdays)||weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))throw Error('Choose valid weekdays.');
  const skipped=[...new Set(c.skipped??[])].sort((a,b)=>a-b);if(skipped.length>1000||skipped.some(n=>!Number.isSafeInteger(n)||n<first||n>first+total+bonus+1000))throw Error('Invalid skipped unit.');
  const unit=String(c.unit||'Chapter').trim(),plural=String(c.plural||unit+'s').trim();if(!unit||unit.length>40||plural.length>45||/[{}·]/.test(unit))throw Error('Enter a unit name without syntax brackets.');
  const chSize=c.chapter_size==null||c.chapter_size===''?null:int(Number(c.chapter_size),1,1000),chLabel=String(c.chapter_label??'Ch').trim()||'Ch';if(chSize&&(chLabel.length>20||/[{}·]/.test(chLabel)))throw Error('Enter a chapter label without brackets or the · sign, up to 20 characters.');
  const counts=c.counts??Array.from({length:days},(_,i)=>Math.floor(total/days)+(i<total%days?1:0));if(!Array.isArray(counts)||counts.length!==days||counts.some(n=>!Number.isSafeInteger(n)||n<1||n>1000))throw Error('Each day needs at least one unit.');
  let bonusCounts=c.bonus_counts;if(bonusCounts!=null){if(!Array.isArray(bonusCounts)||bonusCounts.length!==days||bonusCounts.some(n=>!Number.isSafeInteger(n)||n<0||n>1000)||bonusCounts.reduce((x,y)=>x+y,0)!==bonus)throw Error('The daily bonus amounts must add up to the bonus total.');bonusCounts=[...bonusCounts];}
  if(typeof c.description!=='undefined'&&(typeof c.description!=='string'||c.description.length>8000))throw Error('Description exceeds 8,000 characters.');
  const prio=v=>{if(v==null||v==='')return null;if(typeof v!=='string'||v.length>64||/[^\w-]/.test(v))throw Error('Choose valid priorities.');return v;},parentPriority=prio(c.parent_priority),unitPriority=prio(c.unit_priority);
  let dates=c.dates;if(dates!=null){if(!Array.isArray(dates)||dates.length!==days||dates.some((d,i)=>!dateOK(d)||d<c.start||(i&&d<=dates[i-1])))throw Error('Choose valid study dates.');dates=[...dates];}
  const exclude=[...new Set(c.exclude??[])].sort((a,b)=>a-b);if(exclude.length>1000||exclude.some(n=>!Number.isSafeInteger(n)||n<first||n>first+total+bonus+1000))throw Error('Invalid excluded unit.');
  let titles=c.titles??[];if(!Array.isArray(titles)||titles.length>days||titles.some(t=>typeof t!=='string'||!t.trim()||t.length>200))throw Error('Enter valid parent titles.');titles=Array.from({length:days},(_,i)=>titles[i]||c.title.trim()+' '+(i+1));
  return {title:c.title.trim(),unit,plural,total,...(bonus?{bonus}:{}),...(bonus&&bonusCounts?{bonus_counts:bonusCounts}:{}),days,first,start:c.start,weekdays:[...new Set(weekdays)],skipped,counts:[...counts],titles:[...titles],...(dates?{dates}:{}),...(exclude.length?{exclude}:{}),description:c.description||'',...(chSize?{chapter_size:chSize,chapter_label:chLabel}:{}),...(parentPriority?{parent_priority:parentPriority}:{}),...(unitPriority?{unit_priority:unitPriority}:{}),...(c.smart?{smart:root.TaskitatorSmartStudy.normalize(c.smart,rows({...c,smart:null}))}:{})};
 }
 // Bonus units are spread like the required ones: day i gets floor(B/days) plus one while i < B mod days. They are the LAST units of the day.
 function bonusSplit(days,bonus){const b=bonus||0;return Array.from({length:days},(_,i)=>Math.floor(b/days)+(i<b%days?1:0));}
 function rows(input){const c=normalize(input),allowed=new Set(c.weekdays.length?c.weekdays:[0,1,2,3,4,5,6]),skip=new Set(c.skipped),units=[],extra=c.bonus_counts||bonusSplit(c.days,c.bonus);for(let n=c.first;units.length<c.total+(c.bonus||0);n++)if(!skip.has(n))units.push(n);
  let at=Date.parse(c.start+'T00:00:00Z'),offset=0;return c.counts.map((count,i)=>{let date;if(c.dates)date=c.dates[i];else{while(!allowed.has(new Date(at).getUTCDay()))at+=86400000;date=new Date(at).toISOString().slice(0,10);at+=86400000;}const bonus=extra[i],numbers=units.slice(offset,offset+count+bonus);offset+=count+bonus;return {date,numbers,count,bonus,title:c.titles[i]||c.title+' '+(i+1)};});
 }
 // Chapter label (Phase 3.5): units are grouped by number, chapter = ceil(number / size). It only labels; no extra tasks exist.
 const chapterOf=(n,size)=>Math.ceil(n/size);
 const chapOf=c=>c&&c.chapter_size?{size:c.chapter_size,label:c.chapter_label||'Ch'}:null;
 // The unit name inside a stored raw title, with or without the "Ch 3 · " prefix.
 const unitName=raw=>{const m=/^(?:[^·{}]{1,20} \d+ · )?(.*)\.\{num==\d+\}$/.exec(raw||'');return m?m[1]:null;};
 const unitTexts=(unit,n,ch)=>{const p=ch&&ch.size?ch.label+' '+chapterOf(n,ch.size)+' · ':'';return {title:p+unit+'.'+n,raw:p+unit+'.{num=='+n+'}'};};
 const spanOf=ns=>ns.length>1&&ns.every((n,i)=>!i||n===ns[i-1]+1)?ns[0]+'–'+ns.at(-1):ns.join(', ');
 function coverage(unit,numbers,ch){const consecutive=numbers.every((n,i)=>!i||n===numbers[i-1]+1),base='Covers '+unit.toLowerCase()+' '+(consecutive&&numbers.length>1?numbers[0]+' to '+numbers.at(-1):numbers.join(', '));
  if(!ch||!ch.size)return base;const g=new Map();for(const n of numbers){const k=chapterOf(n,ch.size);if(!g.has(k))g.set(k,[]);g.get(k).push(n);}
  return base+' · '+[...g].map(([k,ns])=>(ch.label||'Ch')+' '+k+' ('+spanOf(ns)+')').join(', ');}
 function build(input,id,created,audit=false,criteria=''){
  const c=normalize(input);if(c.counts.reduce((a,b)=>a+b,0)!==c.total)throw Error('The daily total must equal the requested unit amount.');if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))throw Error('Invalid plan identifier.');if(typeof created!=='string'||!Number.isFinite(Date.parse(created)))throw Error('Invalid creation time.');
  if(typeof criteria!=='string'||criteria.length>4000||audit&&!criteria.trim())throw Error('Enter audit criteria.');if(audit&&/\{(?!num\})[^}]*\}/.test(criteria))throw Error('Only {num} is available in study criteria.');
  const skipAudit=new Set(c.exclude||[]);if(audit&&rows(c).every(r=>r.numbers.every(n=>skipAudit.has(n))))throw Error('Every unit is excluded from the criteria.');
  const ch=chapOf(c),tasks=[];for(const [i,r]of rows(c).entries()){const pid='study_'+id+'_day_'+i,base={study_plan_id:id,status:'active',project_id:'inbox',tags:[],is_bonus:false,created_at:created,completed_at:null,due_date:r.date};tasks.push({...base,id:pid,parent_id:null,title:r.title,raw_title:r.title,description:coverage(c.plural,r.numbers,ch)+(c.description?'\n'+c.description:''),ai_locked:false,proof_criteria:'',raw_proof_criteria:'',strict_prerequisites:true,...(c.parent_priority?{priority_id:c.parent_priority}:{})});for(const [k,n]of r.numbers.entries())tasks.push({...base,is_bonus:k>=r.count,id:'study_'+id+'_unit_'+n,parent_id:pid,title:unitTexts(c.unit,n,ch).title,raw_title:unitTexts(c.unit,n,ch).raw,...(ch?{chapter_size:ch.size,chapter_label:ch.label}:{}),description:'',ai_locked:audit&&!skipAudit.has(n),proof_criteria:audit&&!skipAudit.has(n)?criteria.replace(/\{num\}/g,String(n)):'',raw_proof_criteria:audit&&!skipAudit.has(n)?criteria:'',strict_prerequisites:false,...(c.unit_priority?{priority_id:c.unit_priority}:{})});}return root.TaskitatorSmartStudy?root.TaskitatorSmartStudy.decorate(tasks,c.smart):tasks;
 }
 function defaultDays(settings={}){const start=Number(settings.weekend_start??5),end=Number(settings.weekend_end??6),weekend=new Set();if(![start,end].every(n=>Number.isInteger(n)&&n>=0&&n<=6))return [0,1,2,3,4];for(let n=start;;n=(n+1)%7){weekend.add(n);if(n===end)break;}return [0,1,2,3,4,5,6].filter(n=>!weekend.has(n));}
 // Units-per-day split: whole units only, the last day takes the remainder (20 at 6 per day: 6,6,6,2).
 function perDay(total,per){
  int(total,1,1000);if(!Number.isSafeInteger(per)||per<1)throw Error('Enter a whole number of units per day.');
  if(per>total)throw Error('Units per day cannot exceed the units to study.');
  const days=Math.ceil(total/per);if(days>365)throw Error('This split needs '+days+' study days. The limit is 365.');
  return Array.from({length:days},(_,i)=>i<days-1?per:total-per*(days-1));
 }
 // Weekday-specific rates. rates: {0..6: whole number} overrides the default per weekday. Walks forward from start over allowed weekdays
 // (empty = every day), each day takes its rate, last day takes the remainder. Returns counts, end date, and whether the last day was clipped.
 // One weekday's own amount. 0 is refused on purpose: a weekday is switched off by unchecking it, not by typing 0.
 function rateOf(v){if(Number(v)===0)throw Error('To skip a day, uncheck it instead of typing 0.');return int(Number(v),1,1000);}
 // "Number of study days" with specific weekday amounts (Phase 3.4): the total and the number of days stay fixed. Every study date that
 // falls on a weekday with its own amount gets that amount; the other dates share what is left, the first of them taking the extra units
 // (the same rule as the plain equal split). Bonus units are not part of these amounts.
 function calSplit(total,dates,rates={}){
  int(total,1,1000);const over={};
  for(const [k,v] of Object.entries(rates||{})){const d=Number(k);if(!Number.isInteger(d)||d<0||d>6)throw Error('Choose valid weekdays.');if(v===''||v==null)continue;over[d]=rateOf(v);}
  const dow=d=>new Date(d+'T00:00:00Z').getUTCDay(),n=dates.length,present=new Set(dates.map(dow));
  const ignored=Object.keys(over).map(Number).filter(d=>!present.has(d)).sort((a,b)=>a-b),fixed=dates.map(d=>over[dow(d)]);
  const free=fixed.filter(v=>v===undefined).length,fixedTotal=fixed.reduce((a,v)=>a+(v||0),0);
  if(free===n)return {counts:Array.from({length:n},(_,i)=>Math.floor(total/n)+(i<total%n?1:0)),ignored};
  if(!free)throw Error('Every study day has its own amount, so nothing is left to share the rest. Leave at least one weekday empty.');
  if(fixedTotal>=total)throw Error('The specific amounts add up to '+fixedTotal+', which leaves nothing of the '+total+' units for the other days.');
  const left=total-fixedTotal;
  if(left<free)throw Error('The specific amounts use '+fixedTotal+' of '+total+' units and leave '+left+' for '+free+' other day'+(free===1?'':'s')+'. Each other day needs at least 1.');
  let k=0;const counts=fixed.map(v=>v!==undefined?v:Math.floor(left/free)+(k++<left%free?1:0));
  return {counts,ignored};
 }
 function weekdayPlan(total,def,rates={},weekdays=[],start){
  int(total,1,1000);int(def,1,1000);if(!dateOK(start))throw Error('Choose a valid starting date.');
  const allowed=new Set(weekdays.length?weekdays:[0,1,2,3,4,5,6]),over={};
  for(const [k,v]of Object.entries(rates||{})){const d=Number(k);if(!Number.isInteger(d)||d<0||d>6)throw Error('Choose valid weekdays.');if(v===''||v==null)continue;over[d]=rateOf(v);}
  const ignored=Object.keys(over).map(Number).filter(d=>!allowed.has(d)).sort((a,b)=>a-b);
  const counts=[],dates=[];let left=total,at=Date.parse(start+'T00:00:00Z'),clipped=false;
  while(left>0){const dow=new Date(at).getUTCDay();if(allowed.has(dow)){if(counts.length>=365)throw Error('This split needs more than 365 study days. The limit is 365.');const rate=over[dow]??def,n=Math.min(rate,left);if(n<rate)clipped=true;counts.push(n);dates.push(new Date(at).toISOString().slice(0,10));left-=n;}at+=86400000;}
  return {counts,dates,end:dates.at(-1),clipped,ignored,lastRate:counts.length?(over[new Date(dates.at(-1)+'T00:00:00Z').getUTCDay()]??def):def};
 }
 // Dates and daily amounts for a number of units: equal split over N study days, or a per-day rate (with weekday overrides).
 // weekdays empty = every day. Used by the plan page and the create dialog so both build the same schedule.
 function schedule(total,o){
  int(total,1,1000);if(!dateOK(o.start))throw Error('Choose a valid starting date.');
  if(o.mode==='perDay'){const r=weekdayPlan(total,int(Number(o.per),1,1000),o.rates||{},o.weekdays||[],o.start);return {dates:r.dates,counts:r.counts,clipped:r.clipped,lastRate:r.lastRate,ignored:r.ignored};}
  const days=int(Number(o.days),1,365);if(days>total)throw Error('Each study day needs at least one unit.');
  const allowed=new Set((o.weekdays||[]).length?o.weekdays:[0,1,2,3,4,5,6]),dates=[];let at=Date.parse(o.start+'T00:00:00Z');
  while(dates.length<days){if(allowed.has(new Date(at).getUTCDay()))dates.push(new Date(at).toISOString().slice(0,10));at+=86400000;}
  const split=calSplit(total,dates,o.rates||{});
  return {dates,counts:split.counts,ignored:split.ignored};
 }
 // Skipped units typed as real unit numbers: "8", "8, 12", "8-10", "8, 10-12". Arabic digits and comma accepted.
 // All or nothing: any bad item rejects the whole input. Numbers already skipped are ignored.
 function parseSkips(text,first,total,skipped=[]){
  const digits=String(text??'').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x0660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x06F0));
  const items=digits.split(/[,،;\s]+/).filter(Boolean);if(!items.length)throw Error('Type a unit number, a list or a range.');
  const last=first+total-1+skipped.length,out=new Set(),inside=n=>{if(n<first||n>last)throw Error(n+' is outside this plan ('+first+'–'+last+').');};
  for(const item of items){
   const m=item.match(/^(\d+)(?:[-–—](\d+))?$/);if(!m)throw Error('"'+item+'" is not a unit number or range.');
   const a=Number(m[1]),b=m[2]===undefined?a:Number(m[2]);if(b<a)throw Error(item+' is not a valid range.');
   inside(a);inside(b);if(b-a>1000)throw Error(item+' is too large a range.');for(let n=a;n<=b;n++)out.add(n);
  }
  const fresh=[...out].filter(n=>!skipped.includes(n));if(skipped.length+fresh.length>1000)throw Error('Too many skipped units.');
  return fresh.sort((x,y)=>x-y);
 }
 // Basic calculator: + − × ÷ with normal precedence. No eval.
 function calculate(expr){
  const tokens=String(expr).replace(/\s+/g,'').match(/\d*\.?\d+|[+−\-×÷*/]/g)||[];
  const nums=[],ops=[];let expectNum=true,neg=false;
  for(const t of tokens){
   if(/\d/.test(t)){if(!expectNum)throw Error('Error');nums.push(neg?-Number(t):Number(t));neg=false;expectNum=false;continue;}
   const op={'−':'-','*':'×','/':'÷'}[t]||t;
   if(expectNum){if(op==='-'&&!neg){neg=true;continue;}throw Error('Error');}
   ops.push(op);expectNum=true;
  }
  if(expectNum||!nums.length)throw Error('Error');
  const n2=[nums[0]],o2=[];
  ops.forEach((op,i)=>{const v=nums[i+1];if(op==='×')n2.push(n2.pop()*v);else if(op==='÷'){if(v===0)throw Error('Error');n2.push(n2.pop()/v);}else{o2.push(op);n2.push(v);}});
  const r=o2.reduce((acc,op,i)=>op==='+'?acc+n2[i+1]:acc-n2[i+1],n2[0]);
  if(!Number.isFinite(r))throw Error('Error');return Math.round(r*1e10)/1e10;
 }
 const core={normalize,rows,bonusSplit,build,coverage,chapterOf,chapOf,unitName,unitTexts,defaultDays,perDay,weekdayPlan,calSplit,schedule,parseSkips,calculate};root.TaskitatorStudyCore=core;
 if(typeof window==='undefined'||!root.document)return;
 const node=(tag,text,p,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;p?.append(e);return e;};
 const longDate=iso=>window.TaskitatorI18n?.date(iso+'T12:00:00Z',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'UTC'})??new Date(iso+'T12:00:00Z').toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});
 let opened=null,opening=false;
 async function open(initial={}){
  if(new URLSearchParams(location.search).get('view')==='universe')return {status:'unavailable',message:'Study recurrence is available only in your personal workspace.'};
  if(opening)return {status:"confirmation_required",message:"A study preview is being prepared."};
  if(opened?.open){opened.focus();return {status:'confirmation_required',message:'A study preview is already open.'};}
  opening=true;let check;try{check=await window.TaskitatorPro?.checkConsecutiveEntitlement?.();}finally{opening=false;}if(!check?.allowed)return {status:'pro_required',message:'Study recurrence is a Pro feature. With Pro, I can distribute your units across study days and show you a schedule before creating it.'};
  const actor=window.Clerk?.session?.id,settings=JSON.parse(localStorage.getItem('taskitator_settings')||'{}'),today=window.TaskitatorRecurrence.today(Date.now(),Number(settings.day_start_hour)||0),d=node('dialog',undefined,undefined,'study-dialog');opened=d;
  const head=node('div',undefined,d,'study-head');node('h2','Study recurrence · Pro',head);
  const calcBtn=node('button','+ − × ÷',head,'icon-btn study-calc-toggle');calcBtn.type='button';calcBtn.setAttribute('aria-label','Calculator');calcBtn.setAttribute('aria-expanded','false');
  const calcBox=node('div',undefined,d,'study-calc');calcBox.hidden=true;calcBox.setAttribute('dir','ltr');
  const status=node('p','Nothing is created until you confirm.',d,'study-status');status.setAttribute('role','status');let busy=false,used=false,confirmBtn=null;
  function button(text,p,fn,cls='icon-btn study-btn'){const b=node('button',text,p,cls);b.type='button';b.onclick=()=>run(fn);return b;}
  async function run(fn){if(busy)return;busy=true;const inputs=[...d.querySelectorAll('input,textarea,select')],prior=inputs.map(e=>e.disabled);inputs.forEach(e=>e.disabled=true);try{if(actor!==window.Clerk?.session?.id)throw Error('Account changed. Reopen this preview.');await fn();}catch(e){status.textContent=e.message;}finally{inputs.forEach((e,i)=>e.disabled=prior[i]);busy=false;}}
  function field(label,value,type='text',parent=d,cls){const l=node('label',label,parent,type==='checkbox'?'study-check':'study-field'+(cls?' '+cls:''));const e=node(type==='textarea'?'textarea':'input',undefined,l);if(type!=='textarea')e.type=type;e.value=value;return e;}
  // Calculator (built on first open)
  let calcExpr='',calcShow=null;
  function calcKey(k){if(k==='C'){calcExpr='';}else if(k==='⌫'){calcExpr=calcExpr.slice(0,-1);}else if(k==='='){try{calcExpr=String(calculate(calcExpr));}catch{calcShow.textContent='Error';calcExpr='';return;}}else{if(/[+−×÷]/.test(k)&&/[+−×÷]$/.test(calcExpr))calcExpr=calcExpr.slice(0,-1);if(calcExpr.length<40)calcExpr+=k;}calcShow.textContent=calcExpr||'0';}
  calcBtn.onclick=()=>{if(!calcShow){calcShow=node('div','0',calcBox,'study-calc-display');calcShow.setAttribute('aria-live','polite');const pad=node('div',undefined,calcBox,'study-calc-pad');for(const k of ['7','8','9','÷','4','5','6','×','1','2','3','−','0','.','=','+','C','⌫']){const b=node('button',k,pad,'icon-btn study-calc-key'+(/[+−×÷=]/.test(k)?' is-op':''));b.type='button';b.onclick=()=>calcKey(k);}}calcBox.hidden=!calcBox.hidden;calcBtn.setAttribute('aria-expanded',String(!calcBox.hidden));};
  // Tabs: Task info, AI criteria, Scheduling (Phase 2.6)
  const tabBar=node('div',undefined,d,'tk-tabs'),panels={},tabButtons={};tabBar.setAttribute('role','tablist');
  for(const [key,text,icon]of [['info','Task info','notes'],['ai','AI criteria','ai'],['sched','Scheduling','calendar'],['summary','Summary','goal']]){const b=node('button',text,tabBar,'tk-tab');if(window.TaskitatorIcons?.has?.(icon)){const ic=window.TaskitatorIcons.node(icon,'tk-tab-icon');ic.setAttribute?.('aria-hidden','true');b.prepend(ic);}b.type='button';b.setAttribute('role','tab');b.onclick=()=>showTab(key);tabButtons[key]=b;panels[key]=node('div',undefined,d,'study-panel');}
  let activeTab=null,tabTimer=null;
  function showTab(k){
    clearTimeout(tabTimer);
    const old=panels[activeTab];
    if(old)old.classList.remove('study-panel-leaving');
    if(activeTab===k)return;
    const apply=()=>{for(const [key,p]of Object.entries(panels)){p.hidden=key!==k;tabButtons[key].setAttribute('aria-selected',String(key===k));}activeTab=k;};
    if(!old||window.matchMedia('(prefers-reduced-motion: reduce)').matches){apply();return;}
    old.classList.add('study-panel-leaving');
    tabTimer=setTimeout(()=>{old.classList.remove('study-panel-leaving');apply();},140);
  }
  // -- Task info --
  const info=panels.info,title=field('Title',initial.title||'','text',info);
  const grid=node('div',undefined,info,'ss-grid');grid.style.marginTop='12px';
  const unit=field('Unit name',initial.unit||'Chapter','text',grid),total=field('Total units (1–1,000)',initial.total??20,'number',grid),bonus=field('Bonus units (optional)',initial.bonus??0,'number',grid);bonus.min=0;bonus.max=1000;bonus.inputMode='numeric';
  const prios=(()=>{try{const st=JSON.parse(localStorage.getItem('taskitator_settings')||'{}');return Array.isArray(st.custom_priorities)&&st.custom_priorities.length?st.custom_priorities:[{id:'prio_high',name:'High',rank:1},{id:'prio_med',name:'Medium',rank:2},{id:'prio_low',name:'Low',rank:3}];}catch{return [];}})();
  const prioRank=id=>{if(!id)return Infinity;const p=prios.find(x=>x.id===id);return p?(Number(p.rank)||prios.indexOf(p)+1):Infinity;};
  const prioField=label=>{const l=node('label',label,grid,'study-field');const e=node('select',undefined,l);node('option','No priority',e).value='';for(const p of prios)node('option',p.name||p.id,e).value=p.id;e.addEventListener('change',()=>refresh());return e;};
  const parentPrio=prioField('Parent task priority'),unitPrio=prioField('Unit priority');
  node('p','Bonus units are extra work on top of the total. Each day gets its share and the last unit of every day is the bonus. A bonus you skip moves to the next day, and the plan gives up one unit at the end.',info,'study-hint');
  const desc=field('Description (optional)','','textarea',info);
  // Chapter labels (Phase 3.6.1): an optional section after the description. Its fields only exist for the plan while the switch is on.
  const chapOn=field('Use chapter labels',false,'checkbox',info);chapOn.checked=Boolean(initial.chapter_size);
  const chapBody=node('div',undefined,info);chapBody.hidden=!chapOn.checked;
  const chapGrid=node('div',undefined,chapBody,'ss-grid');
  const chapSize=field('Units per chapter (optional)',initial.chapter_size||'','number',chapGrid),chapLabel=field('Chapter label',initial.chapter_label||'Ch','text',chapGrid);chapSize.min=1;chapSize.max=1000;chapSize.inputMode='numeric';chapLabel.maxLength=20;
  node('p','Units per chapter adds a chapter label to every unit title (for example Ch 3 · Lesson.17) and to each day\'s "Covers" line. It does not create extra tasks.',chapBody,'study-hint');
  chapOn.onchange=()=>{chapBody.hidden=!chapOn.checked;refresh();};chapSize.addEventListener('input',()=>refresh());chapLabel.addEventListener('input',()=>refresh());
  // The plural is automatic ("Chapter" gives "Chapters") unless Copilot supplied one for the unit it named.
  const pluralOf=()=>initial.plural&&unit.value===(initial.unit||'Chapter')?initial.plural:unit.value.trim()+'s';
  // -- AI criteria --
  const ai=panels.ai,audit=field('Enable AI audits for unit subtasks only',false,'checkbox',ai);audit.checked=false;
  const aiBody=node('div',undefined,ai);aiBody.hidden=true;
  const criteria=field('Proof criteria for the units. Use {num} for each unit number.','','textarea',aiBody);criteria.maxLength=4000;
  const exclude=field('Exclude units from the criteria (optional)','','text',aiBody);exclude.placeholder='8, 10-12';exclude.dir='ltr';exclude.inputMode='numeric';
  node('p','Every unit gets the criteria unless you list it here.',aiBody,'study-hint');
  const validationText=node('p','',aiBody,'study-hint');
  let validation=null,validationStamp='';
  // -- Scheduling --
  const sched=window.TaskitatorStudySchedule.mount(panels.sched,{today,start:initial.start||today,weekdays:initial.weekdays??defaultDays(settings),startUnit:initial.first??1,startUnitHint:1,days:initial.days??5,
   note:'Choose how the units are spread over days.',label:()=>unit.value.trim()||'Unit',units:o=>unitSpec(o).numbers,
   parentTitle:i=>title.value.trim()+' '+(i+1),disabled:()=>false,onChange:()=>refresh(),assign:rowsSorted=>layout(rowsSorted),bonusStep:(date,v)=>setBonus(date,v),bonusRoom:()=>1000-bonusN(),chip:n=>starred.has(n)?{text:(unit.value.trim()||'Unit')+'.'+n+' ★',cls:'is-bonus'}:null,
   early:date=>smartEnabled?[...smartAppearances].filter(([,d])=>d===date).sort((a,b)=>a[0]-b[0]).map(([n])=>({text:(unit.value.trim()||'Unit')+'.'+n})):[]});
  const bonusN=()=>{const n=Number(bonus.value);return Number.isSafeInteger(n)&&n>0?Math.min(n,1000):0;},starred=new Set();
  // Phase 3.7.3: per-date bonus amounts (date -> count). Valid only while it covers exactly the previewed dates and adds up to the bonus total.
  let bonusPer=null;
  function bonusFor(rowsSorted,n){const even=core.bonusSplit(rowsSorted.length,n);if(!bonusPer)return even;const ok=bonusPer.size===rowsSorted.length&&rowsSorted.every(r=>bonusPer.has(r.date))&&[...bonusPer.values()].reduce((a,b)=>a+b,0)===n;if(!ok){bonusPer=null;return even;}return rowsSorted.map(r=>bonusPer.get(r.date));}
  function setBonus(date,v){const rs=sched.state().sched;if(!rs.some(r=>r.date===date)||!Number.isInteger(v)||v<0)return;const cur=bonusFor(rs,bonusN()),m=new Map(rs.map((r,i)=>[r.date,cur[i]]));m.set(date,v);const sum=[...m.values()].reduce((a,b)=>a+b,0);if(sum>1000)return;bonusPer=m;bonus.value=String(sum);sched.rerender();refresh();}
  // Preview numbering with the bonus units placed at the end of each day.
  function layout(rowsSorted){
   const sp=unitSpec(sched.state().options),n=bonusN(),nums=[...sp.numbers],skip=new Set(sp.skipped);for(let k=(nums.at(-1)||sp.first-1)+1;nums.length<sp.total+n;k++)if(!skip.has(k))nums.push(k);
   const extra=bonusFor(rowsSorted,n),out=new Map();let i=0;starred.clear();
   rowsSorted.forEach(({date,count},j)=>{const take=count+extra[j],list=nums.slice(i,i+take);out.set(date,list);list.slice(count).forEach(x=>starred.add(x));i+=take;});
   return out;
  }
  function unitSpec(o){
   const n=Number(total.value);if(!Number.isSafeInteger(n)||n<1||n>1000)throw Error('Use whole numbers within the displayed limits.');
   const first=o.startUnit==null||Number.isNaN(o.startUnit)?1:o.startUnit;if(!Number.isSafeInteger(first)||first<1)throw Error('Use whole numbers within the displayed limits.');
   const skipped=String(o.skipText||'').trim()?parseSkips(o.skipText,first,n,[]):[],skip=new Set(skipped),numbers=[];for(let k=first;numbers.length<n;k++)if(!skip.has(k))numbers.push(k);
   return {first,total:n,skipped,numbers};
  }
  const audited=()=>{const sp=unitSpec(sched.state().options);const ex=exclude.value.trim()?parseSkips(exclude.value,sp.first,sp.total,sp.skipped):[];return {sp,exclude:ex};};
  let smartEnabled=false,smartMode='original',smartDates=new Set(),smartAppearances=new Map(),plan=null,planError='';
  const smartPanel=node('details',undefined,panels.sched,'study-collapse');node('summary','Smart Study Recurrence · Pro',smartPanel);
  for(const e of [title,unit,desc])e.addEventListener('input',()=>refresh());
  total.addEventListener('input',()=>{bonusPer=null;sched.invalidate();});bonus.addEventListener('input',()=>{bonusPer=null;sched.rerender();refresh();});
  audit.onchange=()=>{aiBody.hidden=!audit.checked;validation=null;refresh();};criteria.oninput=()=>{validation=null;validationText.textContent='Criteria changed. Validate again.';refresh();};exclude.addEventListener('input',()=>refresh());
  button('Validate reusable criteria',aiBody,async()=>{
   if(!audit.checked)throw Error('Enable audits first.');if(!criteria.value.trim())throw Error('Enter the criteria for the units.');
   const stub=normalize({title:title.value,unit:unit.value,plural:pluralOf(),total:unitSpec(sched.state().options).total,days:1,first:unitSpec(sched.state().options).first,skipped:unitSpec(sched.state().options).skipped,start:today});
   const selection=window.TaskitatorEngine.AuditEngine.selection();const r=await window.TaskitatorAuth.api('/study-plan',{method:'POST',body:JSON.stringify({action:'validate',config:stub,criteria:criteria.value,provider:selection.provider,model:selection.primary,key_version:selection.keyVersion})});
   validation=r;validationStamp=stampOf();validationText.textContent=r.score+'/10 · '+r.critique;refresh();
  });
  const stampOf=()=>{try{const sp=unitSpec(sched.state().options);return JSON.stringify([criteria.value,title.value.trim(),unit.value.trim(),sp.total,sp.first,sp.skipped]);}catch{return '';}};
  const strict=settings.strict_criteria_validation!==false;
  function buildPlan(){
   planError='';const st=sched.state();if(!st.hasPreview||st.stale||st.balance!==0||!st.sched.length)return null;
   try{const {sp,exclude:ex}=audited();return normalize({title:title.value,unit:unit.value,plural:pluralOf(),parent_priority:parentPrio.value||null,unit_priority:unitPrio.value||null,total:sp.total,bonus:bonusN(),...(bonusN()&&bonusFor(st.sched,bonusN())&&bonusPer?{bonus_counts:st.sched.map(x=>bonusPer.get(x.date))}:{}),chapter_size:chapOn.checked?chapSize.value||null:null,chapter_label:chapLabel.value,days:st.sched.length,counts:st.sched.map(x=>x.count),dates:st.sched.map(x=>x.date),first:sp.first,start:st.sched[0].date,weekdays:st.options.weekdays,skipped:sp.skipped,description:desc.value,...(audit.checked&&ex.length?{exclude:ex}:{})});}
   catch(e){planError=e.message;return null;}
  }
  // Smart Study (Phase 3.6.1): a calendar, per-unit taps, bulk tools and templates all write the same unit -> earlier date map.
  let smartMonth=null,smartSel=null,smartUndo=[],smartTool='next',smartScope='all',smartWd=new Set(),smartScopeDates=new Set(),smartAmount='',smartPick='first',smartLevel='',smartFrom='',smartTo='',smartCount='',smartNote='',smartTarget='';
  const isoDay=(date,opt)=>window.TaskitatorI18n?.date(date+'T12:00:00Z',{...opt,timeZone:'UTC'})??new Date(date+'T12:00:00Z').toLocaleDateString(undefined,{...opt,timeZone:'UTC'});
  const weekdayOf=date=>new Date(date+'T12:00:00Z').getUTCDay(),shortWd=i=>isoDay('2023-01-0'+(i+1),{weekday:'short'});
  const smartRemember=()=>{smartUndo.push(new Map(smartAppearances));if(smartUndo.length>20)smartUndo.shift();};
  function renderSmart(){
   const wasOpen=smartPanel.open;smartPanel.replaceChildren();node('summary','Smart Study Recurrence · Pro',smartPanel);smartPanel.open=wasOpen;const body=node('div',undefined,smartPanel,'study-collapse-body');
   const enable=field('Enable early bonus opportunities',false,'checkbox',body);enable.checked=smartEnabled;enable.onchange=()=>{smartEnabled=enable.checked;renderSmart();sched.rerender();};
   node('p','Only tasks in this recurrence can be shown early or rearranged. Each opportunity expires at the end of its chosen study day. Unfinished work stays required on its original date.',body,'study-hint');
   if(!smartEnabled)return;if(!plan){node('p','Preview a balanced schedule first.',body,'study-hint');return;}
   // Only required units can be shown early. A date's bonus is its plan bonus (the last units of the day) plus what shows early on it.
   const full=rows(plan).filter(r=>r.numbers.length),schedule=full.map(r=>({...r,numbers:r.numbers.slice(0,r.count)})),planBonus=new Map(full.map(r=>[r.date,r.numbers.length-r.count])),dates=schedule.map(r=>r.date),dueOf=new Map();for(const r of schedule)for(const n of r.numbers)dueOf.set(n,r.date);
   let pruned=false;for(const [u,d]of [...smartAppearances])if(!(dueOf.has(u)&&d<dueOf.get(u))){smartAppearances.delete(u);pruned=true;}
   const early=new Map();for(const [u,d]of smartAppearances){if(!early.has(d))early.set(d,[]);early.get(d).push(u);}
   const again=()=>{renderSmart();sched.rerender();};if(pruned)sched.rerender();
   if(bonusN())node('p','This plan also has bonus units. They are optional already, so only required units can be shown early. If a bonus unit later slides, or bonus units are added or removed, any unit that changes day loses its early appearance.',body,'study-hint');
   // Calendar
   if(!smartMonth||smartMonth<dates[0].slice(0,7)||smartMonth>dates.at(-1).slice(0,7))smartMonth=dates[0].slice(0,7);
   node('p','Tap a date to see what is due and what shows early on it.',body,'study-hint');
   const [y,m]=smartMonth.split('-').map(Number),len=new Date(Date.UTC(y,m,0)).getUTCDate(),pad=new Date(Date.UTC(y,m-1,1)).getUTCDay();
   const nav=node('div',undefined,body,'ss-cal-nav'),shift=k=>{smartMonth=new Date(Date.UTC(y,m-1+k,1)).toISOString().slice(0,7);again();};
   const pv=node('button','‹',nav,'ss-cal-arrow');pv.type='button';pv.setAttribute('aria-label','Previous month');pv.onclick=()=>shift(-1);
   node('strong',isoDay(smartMonth+'-01',{month:'long',year:'numeric'}),nav);
   const nx=node('button','›',nav,'ss-cal-arrow');nx.type='button';nx.setAttribute('aria-label','Next month');nx.onclick=()=>shift(1);
   const grid=node('div',undefined,body,'calendar-grid ss-cal');for(let i=0;i<7;i++)node('div',shortWd(i),grid,'calendar-day-header');for(let k=0;k<pad;k++)node('div','',grid,'calendar-cell empty');
   for(let day=1;day<=len;day++){
    const date=smartMonth+'-'+String(day).padStart(2,'0'),due=dueOf.size?schedule.find(r=>r.date===date)?.numbers.length||0:0,pb=planBonus.get(date)||0,em=early.get(date)?.length||0;
    const cell=node('button',undefined,grid,'calendar-cell ss-cell'+(date===smartSel?' selected':''));cell.type='button';node('span',String(day),cell,'calendar-date-number');
    const dots=node('div',undefined,cell,'calendar-dots-row');if(due)node('span',undefined,dots,'cal-dot-solid');if(pb)node('span',undefined,dots,'ss-dot-bonus');if(em)node('span',undefined,dots,'ss-dot-edit');
    if(due||em){const cnt=node('span',undefined,cell,'ss-smart-count');node('b',String(due),cnt);if(pb+em)node('i','+'+(pb+em),cnt);}
    cell.disabled=!due;cell.setAttribute('data-ss-smart-cell',date);cell.onclick=()=>{smartSel=date;smartTarget='';again();};
   }
   const legend=node('div',undefined,body,'ss-legend');for(const [cls,text]of [['cal-dot-solid','Due'],...(bonusN()?[['ss-dot-bonus','Plan bonus']]:[]),['ss-dot-edit','Early bonus']]){const sp=node('span',undefined,legend);node('i',undefined,sp,cls);node('span',text,sp);}
   // Selected date: what is due, what shows early, and manual picking.
   if(smartSel&&dueOf.size&&schedule.some(r=>r.date===smartSel)){
    const det=node('div',undefined,body,'ss-detail');node('strong',longDate(smartSel),det);
    const dueHere=schedule.find(r=>r.date===smartSel).numbers,earlyHere=(early.get(smartSel)||[]).sort((a,b)=>a-b),earlier=dates.filter(x=>x<smartSel);
    const pbHere=planBonus.get(smartSel)||0;
    node('p','Required here: '+dueHere.length,det,'ss-hint');node('p','Bonus here: '+(pbHere+earlyHere.length)+' ('+pbHere+' plan, '+earlyHere.length+' early)',det,'ss-hint').setAttribute('data-ss-bonus-line','');
    if(earlyHere.length){const c=node('div',undefined,det,'ss-chips');for(const n of earlyHere){const b=node('button',plan.unit+'.'+n+' · due '+dueOf.get(n)+' ✕',c,'ss-chip is-early');b.type='button';b.setAttribute('aria-label','Remove early appearance');b.onclick=()=>{smartRemember();smartAppearances.delete(n);again();};}}
    if(earlier.length){
     node('p','Show these units early on:',det,'ss-hint');const l=node('label',undefined,det,'study-field'),sel=node('select',undefined,l);for(const e of earlier)node('option',e,sel).value=e;if(!earlier.includes(smartTarget))smartTarget=earlier.at(-1);sel.value=smartTarget;sel.onchange=()=>{smartTarget=sel.value;};
     const c=node('div',undefined,det,'ss-chips');for(const n of dueHere){const to=smartAppearances.get(n),b=node('button',plan.unit+'.'+n+(to?' → '+to:''),c,'ss-chip'+(to?' is-early':''));b.type='button';b.setAttribute('aria-pressed',String(Boolean(to)));b.setAttribute('data-ss-unit',String(n));b.onclick=()=>{smartRemember();if(smartAppearances.get(n)===smartTarget)smartAppearances.delete(n);else smartAppearances.set(n,smartTarget);again();};}
    }else node('p','This is the first date, so nothing can show before it.',det,'ss-hint');
   }
   // Bulk tools and templates
   const tools=node('div',undefined,body,'ss-detail');node('strong','Apply to many dates',tools);
   const tl=node('label','Tool',tools,'study-field'),ts=node('select',undefined,tl);for(const [v,t]of [['next','Take from the next date'],['level','Level to a number per day'],['move','Template: move first or last units from one date to an earlier one']])node('option',t,ts).value=v;ts.value=smartTool;ts.onchange=()=>{smartTool=ts.value;again();};
   if(smartTool!=='move'){
    node('p','Apply to',tools,'ss-hint');
    for(const [v,t]of [['all','All dates'],['weekdays','Chosen weekdays'],['dates','Chosen dates']]){const l=node('label',t,tools,'study-radio'),r=node('input',undefined,l);r.type='radio';r.name='smartScope';r.value=v;r.checked=smartScope===v;r.onchange=()=>{smartScope=v;again();};}
    if(smartScope==='weekdays'){const w=node('div',undefined,tools,'ss-chips');for(let i=0;i<7;i++){const l=node('label',shortWd(i),w,'study-check'),c=node('input',undefined,l);c.type='checkbox';c.checked=smartWd.has(i);c.onchange=()=>{c.checked?smartWd.add(i):smartWd.delete(i);};}}
    if(smartScope==='dates'){const w=node('div',undefined,tools,'study-scroll');for(const d of dates){const l=node('label',d,w,'study-check'),c=node('input',undefined,l);c.type='checkbox';c.checked=smartScopeDates.has(d);c.onchange=()=>{c.checked?smartScopeDates.add(d):smartScopeDates.delete(d);};}}
   }
   if(smartTool==='next'){const a=field('How many to take from the next date (blank = as many as it has)',smartAmount,'number',tools);a.min=1;a.max=1000;a.inputMode='numeric';a.oninput=()=>{smartAmount=a.value;};}
   if(smartTool==='level'){const a=field('Tasks per day to reach',smartLevel,'number',tools);a.min=1;a.max=1000;a.inputMode='numeric';a.oninput=()=>{smartLevel=a.value;};node('p','Each chosen date pulls units from the dates after it until it shows this many (its own units count).',tools,'ss-hint');}
   if(smartTool==='move'){
    for(const [label,key]of [['From date (the units are due here)','from'],['Show them early on','to']]){const l=node('label',label,tools,'study-field'),sel=node('select',undefined,l);node('option','Choose a date',sel).value='';for(const d of key==='to'&&smartFrom?dates.filter(x=>x<smartFrom):dates)node('option',d,sel).value=d;sel.value=key==='from'?smartFrom:smartTo;sel.onchange=()=>{if(key==='from'){smartFrom=sel.value;if(smartTo&&smartTo>=smartFrom)smartTo='';again();}else smartTo=sel.value;};}
    const a=field('How many units',smartCount,'number',tools);a.min=1;a.max=1000;a.inputMode='numeric';a.oninput=()=>{smartCount=a.value;};
   }
   if(smartTool!=='level'){node('p','Take',tools,'ss-hint');for(const [v,t]of [['first','The first units of the date'],['last','The last units of the date']]){const l=node('label',t,tools,'study-radio'),r=node('input',undefined,l);r.type='radio';r.name='smartPick';r.value=v;r.checked=smartPick===v;r.onchange=()=>{smartPick=v;};}}
   const bar=node('div',undefined,tools,'study-actions');
   const apply=node('button','Apply',bar,'icon-btn study-btn');apply.type='button';apply.setAttribute('data-ss-apply','');apply.onclick=()=>{
    try{
     let scope=null;if(smartTool!=='move'&&smartScope!=='all'){scope=new Set(smartScope==='weekdays'?dates.filter(d=>smartWd.has(weekdayOf(d))):smartScopeDates);if(!scope.size)throw Error('Choose at least one '+(smartScope==='weekdays'?'weekday':'date')+'.');}
     const r=root.TaskitatorSmartStudy.bulk(schedule,smartTool,{scope,amount:smartAmount,pick:smartPick,target:smartLevel,from:smartFrom,to:smartTo,count:smartCount},smartAppearances);
     if(r.added){smartRemember();smartAppearances=r.appearances;}
     smartNote=r.added?'Added '+r.added+' early appearance(s).'+(r.notes.length?' '+r.notes.length+' date(s) had nothing to take.':''):'Nothing changed: no date had free tasks to take.';
    }catch(e){smartNote=e.message;}
    again();};
   const undo=node('button','Undo last change',bar,'icon-btn study-btn');undo.type='button';undo.disabled=!smartUndo.length;undo.setAttribute('data-ss-undo','');undo.onclick=()=>{if(smartUndo.length){smartAppearances=smartUndo.pop();smartNote='Last change undone.';again();}};
   const clr=node('button','Clear all early appearances',bar,'icon-btn study-btn');clr.type='button';clr.disabled=!smartAppearances.size;clr.setAttribute('data-ss-clear','');clr.onclick=()=>{smartRemember();smartAppearances=new Map();smartNote='All early appearances cleared.';again();};
   if(smartNote){const n=node('p',smartNote,tools,'ss-note');n.setAttribute('role','status');}
   node('p','Early appearances now: '+smartAppearances.size,body,'ss-hint');
   // Per-unit list view
   const list=node('details',undefined,body,'study-collapse');node('summary','List view',list);const options=node('div',undefined,list,'study-scroll');
   for(const r of schedule)for(const n of r.numbers){const earlier=schedule.filter(x=>x.date<r.date);if(!earlier.length)continue;const l=node('label',plan.unit+'.'+n+' · required '+r.date,options,'study-field');const sel=node('select',undefined,l);node('option','No early appearance',sel).value='';for(const row of earlier)node('option',row.date,sel).value=row.date;sel.value=smartAppearances.get(n)||'';sel.onchange=()=>{smartRemember();if(sel.value)smartAppearances.set(n,sel.value);else smartAppearances.delete(n);again();};}
   const weekendOK=smartAppearances.size>0&&[...smartAppearances.values()].every(date=>root.TaskitatorSmartStudy.nextWeekend(date,Number(settings.weekend_start??5),Number(settings.weekend_end??6)).some(day=>schedule.some(r=>r.date===day)));
   for(const [value,text]of [['original','A · Lighten the original date'],['weekend','B · Lighten the next configured weekend'],['dates','C · Lighten selected dates']]){const l=node('label',text,body,'study-radio');const radio=node('input',undefined,l);radio.type='radio';radio.name='smartStudyMode';radio.value=value;radio.checked=smartMode===value;radio.disabled=value==='weekend'&&!weekendOK;radio.onchange=()=>{smartMode=value;renderSmart();};}
   node('small','Option B targets the next weekend starting after each early date; a weekend already underway is skipped. It is unavailable when that next weekend has no tasks. Use C to select other dates. Completed bonus tasks free slots on their original dates; at most one eligible task moves per freed slot.',body,'study-hint');
   if(smartMode==='dates'){node('p','Choose dates to lighten. Eligible unfinished units move in date order, finishing the earliest date first.',body);for(const r of schedule){const l=node('label',r.date,body,'study-check');const c=node('input',undefined,l);c.type='checkbox';c.checked=smartDates.has(r.date);c.onchange=()=>c.checked?smartDates.add(r.date):smartDates.delete(r.date);}}
  }
  // Summary tab (Phase 3.7): read-only, filled only while the plan is ready to create.
  let ready=false;
  // Phase 3.7.3: the Summary is read only. Sub tabs keep it organised: Schedule (calendar or list), AI criteria (only when set), Task info.
  let sumSub='sched';const sumState={view:'cal',month:null,sel:null};
  function renderSummary(){
   const box=panels.summary;box.replaceChildren();
   if(!ready||!plan){node('p','Complete the plan to see its summary.',box,'study-hint');return;}
   const sch=rows(plan),auditOn=Boolean(audit.checked&&criteria.value.trim()),U=plan.unit;
   if(sumSub==='ai'&&!auditOn)sumSub='sched';
   node('h3',plan.title,box,'ss-sum-title');node('p','Read only. Make changes in the other tabs.',box,'ss-hint');
   const bar=node('div',undefined,box,'ss-sum-sub');bar.setAttribute('role','tablist');
   for(const [k,t]of [['sched','Schedule'],...(auditOn?[['ai','AI criteria']]:[]),['info','Task info']]){const b=node('button',t,bar,'ss-sum-subtab'+(k===sumSub?' is-on':''));b.type='button';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(k===sumSub));b.setAttribute('data-sum-sub',k);b.onclick=()=>{sumSub=k;renderSummary();};}
   const body=node('div',undefined,box,'ss-sum-body');
   const line=(k,v)=>{const r=node('div',undefined,body,'ss-sum-row');node('span',k,r,'ss-hint');node('b',v,r);};
   if(sumSub==='info'){
    line('Unit',U+' · '+plan.total+' required'+(plan.bonus?' + '+plan.bonus+' bonus':''));
    line('Study days',sch.length+' · '+sch[0].date+' to '+sch.at(-1).date);
    line('Required per day',sch.map(r=>r.count).join(' / '));
    if(plan.bonus)line('Bonus per day',sch.map(r=>r.bonus).join(' / '));
    if(plan.chapter_size)line('Chapter labels',plan.chapter_label+' every '+plan.chapter_size+' units');
    line('Smart Study',smartEnabled&&smartAppearances.size?smartAppearances.size+' early appearance(s)':'Off');
    line('AI criteria',auditOn?'On':'Off');
    return;
   }
   if(sumSub==='ai'){
    line('AI criteria','On'+(validation?' · '+validation.score+'/10':''));
    line('Applies to',plan.exclude?.length?'Every unit except '+plan.exclude.length:'Every unit');
    node('p','Criteria',body,'ss-hint');node('div',criteria.value.trim(),body,'ss-sum-crit');
    if(plan.exclude?.length){node('p','Excluded units',body,'ss-hint');const w=node('div',undefined,body,'ss-sum-pills');for(const n of plan.exclude)node('span',U+'.'+n,w,'ss-sum-pill');}
    return;
   }
   // Schedule: the shared read-only calendar/list (pro/plan-calendar.js). An early unit is listed on its early day AND on its due day.
   const PC=window.TaskitatorPlanCalendar,earlyOn=new Map(),entries=[];
   if(smartEnabled)for(const [n,d] of smartAppearances)earlyOn.set(n,d);
   const dueOf=new Map();for(const r of sch)for(const n of r.numbers)dueOf.set(n,r.date);
   for(const r of sch)r.numbers.forEach((n,k)=>{const main=k<r.count;entries.push({date:r.date,kind:main?'main':'bonus',n,text:U+'.'+n+(main&&earlyOn.has(n)?' · '+PC.tr('also early on {date}',{date:earlyOn.get(n)}):'')});});
   for(const [n,d] of earlyOn)entries.push({date:d,kind:'early',n,text:U+'.'+n+' · '+PC.tr('due {date}',{date:dueOf.get(n)})});
   PC.render(body,PC.group(entries),sumState,renderSummary,{fmtMonth:ym=>isoDay(ym+'-01',{month:'long',year:'numeric'})});
  }

  // One place decides whether "Create plan" is available and says why not.
  function refresh(){
   plan=buildPlan();renderSmart();const st=sched.state();let msg='',ok=false;
   if(!title.value.trim())msg='Enter a title.';
   else if(prioRank(unitPrio.value)<prioRank(parentPrio.value))msg='Units cannot have a higher priority than their parent task.';
   else if(!st.hasPreview)msg='Preview a schedule to create the plan.';
   else if(st.stale)msg='Preview the new schedule again to create the plan.';
   else if(st.balance!==0)msg=(st.balance>0?'Settle '+st.balance+' surplus unit(s) first.':'Settle '+(-st.balance)+' missing unit(s) first.');
   else if(audit.checked&&!criteria.value.trim())msg='Enter the criteria for the units.';
   else if(audit.checked&&strict&&!(validation?.passed&&validationStamp===stampOf()))msg='Validate the criteria (7/10 or higher) before creating.';
   else if(!plan)msg=planError||'Check the plan settings.';
   else{ok=true;msg='Review the schedule, then create the plan.';}
   status.textContent=msg;if(confirmBtn)confirmBtn.disabled=!ok||used;ready=ok;renderSummary();
  }
  // Drafts (Phase 2.8): a restored draft fills the form; the preview comes back only if the units still match.
  let draftId=initial.draft?.id||null;
  if(initial.draft){
   const dr=initial.draft;title.value=dr.info.title||'';unit.value=dr.info.unit||unit.value;if(dr.info.total)total.value=dr.info.total;if(dr.info.bonus)bonus.value=dr.info.bonus;if(dr.info.chapSize)chapSize.value=dr.info.chapSize;if(dr.info.chapLabel)chapLabel.value=dr.info.chapLabel;chapOn.checked=dr.info.chapOn===true||(dr.info.chapOn===undefined&&Boolean(dr.info.chapSize));chapBody.hidden=!chapOn.checked;desc.value=dr.info.description||'';
   if(dr.smart){smartEnabled=dr.smart.enabled===true;smartMode=dr.smart.mode||'original';smartDates=new Set(dr.smart.dates||[]);smartAppearances=new Map((dr.smart.appearances||[]).map(a=>[a.unit,a.date]));}
   for(const [sel,v]of [[parentPrio,dr.info.parent],[unitPrio,dr.info.unitP]])if(Array.from(sel.options||sel.children||[]).some(o=>o.value===v))sel.value=v;
   audit.checked=dr.ai.enabled;aiBody.hidden=!audit.checked;criteria.value=dr.ai.criteria||'';exclude.value=dr.ai.exclude||'';
   const r=sched.restore(dr.schedule);bonusPer=Array.isArray(dr.schedule.bonus_per)&&dr.schedule.bonus_per.length?new Map(dr.schedule.bonus_per):null;if(bonusPer)sched.rerender();
   var draftMsg=dr.schedule.sched&&!r.preview?'Draft restored. Preview the schedule again.':'Draft restored. Nothing is created until you confirm.';
  }
  async function confirmAsk(message){return window.TaskitatorConfirm?await window.TaskitatorConfirm({title:'Save draft?',message,confirmLabel:'Save draft'}):confirm(message);}
  showTab('info');renderSummary();
  const actions=node('div',undefined,d,'study-actions study-footer');
  const planId=crypto.randomUUID(),created=new Date().toISOString();
  confirmBtn=button('Create plan',actions,async()=>{
   refresh();if(used||!plan||confirmBtn.disabled)throw Error(status.textContent||'Preview a balanced schedule first.');if(window.TaskitatorEditorDraft)throw Error('Save or cancel your open task editor first.');
   // First press shows the summary; the second one, from the summary, asks for confirmation (red when AI criteria is set).
   if(activeTab!=='summary'){showTab('summary');status.textContent='Review the summary, then press Create plan again to confirm.';return;}
   const guarded=Boolean(audit.checked&&criteria.value.trim()),tasksN=rows(plan).reduce((a,r)=>a+r.numbers.length,0)+plan.days;
   const message='Create "'+plan.title+'": '+tasksN+' tasks over '+plan.days+' study days.'+(guarded?' AI criteria is on: the audited units are locked, changing them later needs Emergency Bypass, and deleting this plan costs Emergency Bypass uses.':' Nothing here is locked; you can edit or delete the plan later.');
   const sure=window.TaskitatorConfirm?await window.TaskitatorConfirm({title:'Create this plan?',message,confirmLabel:'Create plan',tone:guarded?'danger':'primary'}):confirm(message);
   if(!sure)return;
   const frozen=normalize({...plan,...(smartEnabled?{smart:{mode:smartMode,dates:[...smartDates],appearances:[...smartAppearances].map(([unit,date])=>({unit,date})),weekend_start:Number(settings.weekend_start??5),weekend_end:Number(settings.weekend_end??6)}}:{})}),payload={action:'authorize',config:frozen,plan_id:planId,created_at:created,audit:audit.checked,criteria:criteria.value,validation_id:validation?.id};
   if(!await window.SyncEngine.forceImmediateSync())throw Error('Sync your workspace successfully before creating the plan.');if(actor!==window.Clerk?.session?.id)throw Error('Account changed. Reopen the preview.');const before=localStorage.getItem('taskitator_tasks');
   if(!d.open)throw Error('Preview closed. Nothing was created.');const tasks=build(frozen,planId,created,audit.checked,criteria.value);await window.TaskitatorAuth.api('/study-plan',{method:'POST',body:JSON.stringify(payload)});
   if(!d.open||actor!==window.Clerk?.session?.id||before!==localStorage.getItem('taskitator_tasks'))throw Error('Your workspace changed. Review and confirm again.');
   const current=JSON.parse(before||'[]');if(current.some(t=>t.study_plan_id===planId)){used=true;d.close();return;}localStorage.setItem('taskitator_tasks',JSON.stringify([...current,...tasks]));used=true;confirmBtn.disabled=true;if(draftId)window.TaskitatorDrafts?.removeStudy(draftId);window.TaskitatorApp.loadStorage();window.TaskitatorApp.saveStorageAndPush();window.TaskitatorApp.renderUnifiedView();if(!await window.SyncEngine.forceImmediateSync()){status.textContent='Created locally; sync is pending. Use Sync Now before editing the new tasks.';return;}d.close();
  },'icon-btn study-btn study-primary');confirmBtn.disabled=true;if(initial.draft){refresh();const why=status.textContent;status.textContent=draftMsg+(confirmBtn.disabled&&!/^Preview/.test(why)?' '+why:'');}
  button('Save draft',actions,async()=>{
   if(!window.TaskitatorDrafts)throw Error('Drafts are unavailable. Reload Taskitator.');
   if(!await confirmAsk('Keep this study plan in Drafts? Nothing is created. Find it in the Drafts tab of the Study plans page.'+(draftId?' This replaces the draft you restored.':'')))return;
   draftId=window.TaskitatorDrafts.saveStudy({kind:'create',title:title.value,info:{title:title.value,unit:unit.value,total:total.value,bonus:bonus.value,chapOn:chapOn.checked,chapSize:chapSize.value,chapLabel:chapLabel.value,parent:parentPrio.value,unitP:unitPrio.value,description:desc.value},
    ai:{enabled:audit.checked,criteria:criteria.value,exclude:exclude.value},schedule:{...sched.snapshot(),bonus_per:bonusPer?[...bonusPer]:[]},smart:{enabled:smartEnabled,mode:smartMode,dates:[...smartDates],appearances:[...smartAppearances].map(([unit,date])=>({unit,date}))}},draftId);
   status.textContent='Draft saved. Find it in the Drafts tab of the Study plans page.';
  });
  button('Cancel',actions,()=>d.close());d.addEventListener('close',()=>{d.remove();if(opened===d)opened=null;window.dispatchEvent(new Event('taskitator-study-closed'));});document.body.append(d);d.showModal();return {status:'confirmation_required',message:'Study preview opened. No tasks exist until the user confirms. Audit controls are manual only.'};
 }
 // Restoring a new-plan draft from the Study plans page lands here as index.html?study_draft=<id>; the + button there uses ?study_new=1.
 (function openDraftFromUrl(){
  let id,fresh=false;try{const q=new URLSearchParams(location.search);id=q.get('study_draft');fresh=q.get('study_new')==='1';}catch{return;}
  if((!id&&!fresh)||/study-plans\.html$/.test(location.pathname))return;
  let tries=0;const tick=async()=>{
   if(!(window.TaskitatorApp&&window.TaskitatorPro&&window.Clerk?.session&&window.TaskitatorDrafts&&window.TaskitatorStudySchedule)){if(++tries<60)setTimeout(tick,500);return;}
   try{history.replaceState(null,'',location.pathname+location.hash);}catch{}
   if(fresh){const r=await open({});if(r?.status==='pro_required')window.TaskitatorNotify?.(r.message);return;}
   const dr=window.TaskitatorDrafts.getStudy(id);
   if(!dr||dr.kind!=='create'){window.TaskitatorNotify?.('This study plan draft no longer exists.');return;}
   const r=await open({draft:{...dr,id}});if(r?.status==='pro_required')window.TaskitatorNotify?.(r.message);
  };
  setTimeout(tick,0);
 })();
 root.TaskitatorStudy={open,async propose(args){if(!args?.title||!Number.isInteger(args.total)||!Number.isInteger(args.days))return {status:'needs_input',message:'Ask the user for the missing title, total units, and study days. Never invent these.'};const allowed=['title','unit','plural','total','days','first','start','weekdays'];if(Object.keys(args).some(k=>!allowed.includes(k)))return {status:'error',message:'Copilot cannot supply audit settings, criteria, confirmation or skipped units.'};return open(args);}};
})(typeof window==='undefined'?globalThis:window);

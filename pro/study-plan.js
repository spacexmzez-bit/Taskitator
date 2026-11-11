/* Finite personal study plans. Shared deterministic core and browser preview. */
(function(root){
 'use strict';
 const dateOK=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 const int=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('Use whole numbers within the displayed limits.');return v;};
 function normalize(c){
  if(typeof c.title!=='string'||!c.title.trim()||c.title.length>160)throw Error('Enter a title, up to 160 characters.');
  const total=int(c.total,1,1000),days=int(c.days,1,365),first=int(c.first??1,1,1000000);if(days>total)throw Error('Each study day needs at least one unit.');if(!dateOK(c.start))throw Error('Choose a valid starting date.');
  const weekdays=c.weekdays??[];if(!Array.isArray(weekdays)||weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))throw Error('Choose valid weekdays.');
  const skipped=[...new Set(c.skipped??[])].sort((a,b)=>a-b);if(skipped.length>1000||skipped.some(n=>!Number.isSafeInteger(n)||n<first||n>first+total+1000))throw Error('Invalid skipped unit.');
  const unit=String(c.unit||'Chapter').trim(),plural=String(c.plural||unit+'s').trim();if(!unit||unit.length>40||plural.length>45||/[{}]/.test(unit))throw Error('Enter a unit name without syntax brackets.');
  const counts=c.counts??Array.from({length:days},(_,i)=>Math.floor(total/days)+(i<total%days?1:0));if(!Array.isArray(counts)||counts.length!==days||counts.some(n=>!Number.isSafeInteger(n)||n<1||n>1000))throw Error('Each day needs at least one unit.');
  if(typeof c.description!=='undefined'&&(typeof c.description!=='string'||c.description.length>8000))throw Error('Description exceeds 8,000 characters.');
  const prio=v=>{if(v==null||v==='')return null;if(typeof v!=='string'||v.length>64||/[^\w-]/.test(v))throw Error('Choose valid priorities.');return v;},parentPriority=prio(c.parent_priority),unitPriority=prio(c.unit_priority);
  let dates=c.dates;if(dates!=null){if(!Array.isArray(dates)||dates.length!==days||dates.some((d,i)=>!dateOK(d)||d<c.start||(i&&d<=dates[i-1])))throw Error('Choose valid study dates.');dates=[...dates];}
  const exclude=[...new Set(c.exclude??[])].sort((a,b)=>a-b);if(exclude.length>1000||exclude.some(n=>!Number.isSafeInteger(n)||n<first||n>first+total+1000))throw Error('Invalid excluded unit.');
  let titles=c.titles??[];if(!Array.isArray(titles)||titles.length>days||titles.some(t=>typeof t!=='string'||!t.trim()||t.length>200))throw Error('Enter valid parent titles.');titles=Array.from({length:days},(_,i)=>titles[i]||c.title.trim()+' '+(i+1));
  return {title:c.title.trim(),unit,plural,total,days,first,start:c.start,weekdays:[...new Set(weekdays)],skipped,counts:[...counts],titles:[...titles],...(dates?{dates}:{}),...(exclude.length?{exclude}:{}),description:c.description||'',...(parentPriority?{parent_priority:parentPriority}:{}),...(unitPriority?{unit_priority:unitPriority}:{}),...(c.smart?{smart:root.TaskitatorSmartStudy.normalize(c.smart,rows({...c,smart:null}))}:{})};
 }
 function rows(input){const c=normalize(input),allowed=new Set(c.weekdays.length?c.weekdays:[0,1,2,3,4,5,6]),skip=new Set(c.skipped),units=[];for(let n=c.first;units.length<c.total;n++)if(!skip.has(n))units.push(n);
  let at=Date.parse(c.start+'T00:00:00Z'),offset=0;return c.counts.map((count,i)=>{let date;if(c.dates)date=c.dates[i];else{while(!allowed.has(new Date(at).getUTCDay()))at+=86400000;date=new Date(at).toISOString().slice(0,10);at+=86400000;}const numbers=units.slice(offset,offset+count);offset+=count;return {date,numbers,count,title:c.titles[i]||c.title+' '+(i+1)};});
 }
 function coverage(unit,numbers){const consecutive=numbers.every((n,i)=>!i||n===numbers[i-1]+1);return 'Covers '+unit.toLowerCase()+' '+(consecutive&&numbers.length>1?numbers[0]+' to '+numbers.at(-1):numbers.join(', '));}
 function build(input,id,created,audit=false,criteria=''){
  const c=normalize(input);if(c.counts.reduce((a,b)=>a+b,0)!==c.total)throw Error('The daily total must equal the requested unit amount.');if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))throw Error('Invalid plan identifier.');if(typeof created!=='string'||!Number.isFinite(Date.parse(created)))throw Error('Invalid creation time.');
  if(typeof criteria!=='string'||criteria.length>4000||audit&&!criteria.trim())throw Error('Enter audit criteria.');if(audit&&/\{(?!num\})[^}]*\}/.test(criteria))throw Error('Only {num} is available in study criteria.');
  const skipAudit=new Set(c.exclude||[]);if(audit&&rows(c).every(r=>r.numbers.every(n=>skipAudit.has(n))))throw Error('Every unit is excluded from the criteria.');
  const tasks=[];for(const [i,r]of rows(c).entries()){const pid='study_'+id+'_day_'+i,base={study_plan_id:id,status:'active',project_id:'inbox',tags:[],is_bonus:false,created_at:created,completed_at:null,due_date:r.date};tasks.push({...base,id:pid,parent_id:null,title:r.title,raw_title:r.title,description:coverage(c.plural,r.numbers)+(c.description?'\n'+c.description:''),ai_locked:false,proof_criteria:'',raw_proof_criteria:'',strict_prerequisites:true,...(c.parent_priority?{priority_id:c.parent_priority}:{})});for(const n of r.numbers)tasks.push({...base,id:'study_'+id+'_unit_'+n,parent_id:pid,title:c.unit+'.'+n,raw_title:c.unit+'.{num=='+n+'}',description:'',ai_locked:audit&&!skipAudit.has(n),proof_criteria:audit&&!skipAudit.has(n)?criteria.replace(/\{num\}/g,String(n)):'',raw_proof_criteria:audit&&!skipAudit.has(n)?criteria:'',strict_prerequisites:false,...(c.unit_priority?{priority_id:c.unit_priority}:{})});}return root.TaskitatorSmartStudy?root.TaskitatorSmartStudy.decorate(tasks,c.smart):tasks;
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
 function weekdayPlan(total,def,rates={},weekdays=[],start){
  int(total,1,1000);int(def,1,1000);if(!dateOK(start))throw Error('Choose a valid starting date.');
  const allowed=new Set(weekdays.length?weekdays:[0,1,2,3,4,5,6]),over={};
  for(const [k,v]of Object.entries(rates||{})){const d=Number(k);if(!Number.isInteger(d)||d<0||d>6)throw Error('Choose valid weekdays.');if(v===''||v==null)continue;over[d]=int(Number(v),1,1000);}
  const ignored=Object.keys(over).map(Number).filter(d=>!allowed.has(d)).sort((a,b)=>a-b);
  const counts=[],dates=[];let left=total,at=Date.parse(start+'T00:00:00Z'),clipped=false;
  while(left>0){const dow=new Date(at).getUTCDay();if(allowed.has(dow)){if(counts.length>=365)throw Error('This split needs more than 365 study days. The limit is 365.');const rate=over[dow]??def,n=Math.min(rate,left);if(n<rate)clipped=true;counts.push(n);dates.push(new Date(at).toISOString().slice(0,10));left-=n;}at+=86400000;}
  return {counts,dates,end:dates.at(-1),clipped,ignored,lastRate:counts.length?(over[new Date(dates.at(-1)+'T00:00:00Z').getUTCDay()]??def):def};
 }
 // Dates and daily amounts for a number of units: equal split over N study days, or a per-day rate (with weekday overrides).
 // weekdays empty = every day. Used by the plan page and the create dialog so both build the same schedule.
 function schedule(total,o){
  int(total,1,1000);if(!dateOK(o.start))throw Error('Choose a valid starting date.');
  if(o.mode==='perDay'){const r=weekdayPlan(total,int(Number(o.per),1,1000),o.rates||{},o.weekdays||[],o.start);return {dates:r.dates,counts:r.counts,clipped:r.clipped,lastRate:r.lastRate};}
  const days=int(Number(o.days),1,365);if(days>total)throw Error('Each study day needs at least one unit.');
  const allowed=new Set((o.weekdays||[]).length?o.weekdays:[0,1,2,3,4,5,6]),dates=[];let at=Date.parse(o.start+'T00:00:00Z');
  while(dates.length<days){if(allowed.has(new Date(at).getUTCDay()))dates.push(new Date(at).toISOString().slice(0,10));at+=86400000;}
  return {dates,counts:Array.from({length:days},(_,i)=>Math.floor(total/days)+(i<total%days?1:0))};
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
 const core={normalize,rows,build,coverage,defaultDays,perDay,weekdayPlan,schedule,parseSkips,calculate};root.TaskitatorStudyCore=core;
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
  for(const [key,text]of [['info','Task info'],['ai','AI criteria'],['sched','Scheduling']]){const b=node('button',text,tabBar,'tk-tab');b.type='button';b.setAttribute('role','tab');b.onclick=()=>showTab(key);tabButtons[key]=b;panels[key]=node('div',undefined,d,'study-panel');}
  function showTab(k){for(const [key,p]of Object.entries(panels)){p.hidden=key!==k;tabButtons[key].setAttribute('aria-selected',String(key===k));}}
  // -- Task info --
  const info=panels.info,title=field('Title',initial.title||'','text',info);
  const grid=node('div',undefined,info,'ss-grid');grid.style.marginTop='12px';
  const unit=field('Unit name',initial.unit||'Chapter','text',grid),total=field('Total units (1–1,000)',initial.total??20,'number',grid);
  const prios=(()=>{try{const st=JSON.parse(localStorage.getItem('taskitator_settings')||'{}');return Array.isArray(st.custom_priorities)&&st.custom_priorities.length?st.custom_priorities:[{id:'prio_high',name:'High',rank:1},{id:'prio_med',name:'Medium',rank:2},{id:'prio_low',name:'Low',rank:3}];}catch{return [];}})();
  const prioRank=id=>{if(!id)return Infinity;const p=prios.find(x=>x.id===id);return p?(Number(p.rank)||prios.indexOf(p)+1):Infinity;};
  const prioField=label=>{const l=node('label',label,grid,'study-field');const e=node('select',undefined,l);node('option','No priority',e).value='';for(const p of prios)node('option',p.name||p.id,e).value=p.id;e.addEventListener('change',()=>refresh());return e;};
  const parentPrio=prioField('Parent task priority'),unitPrio=prioField('Unit priority');
  const desc=field('Description (optional)','','textarea',info);
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
   parentTitle:i=>title.value.trim()+' '+(i+1),disabled:()=>false,onChange:()=>refresh()});
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
  total.addEventListener('input',()=>{sched.invalidate();});
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
   try{const {sp,exclude:ex}=audited();return normalize({title:title.value,unit:unit.value,plural:pluralOf(),parent_priority:parentPrio.value||null,unit_priority:unitPrio.value||null,total:sp.total,days:st.sched.length,counts:st.sched.map(x=>x.count),dates:st.sched.map(x=>x.date),first:sp.first,start:st.sched[0].date,weekdays:st.options.weekdays,skipped:sp.skipped,description:desc.value,...(audit.checked&&ex.length?{exclude:ex}:{})});}
   catch(e){planError=e.message;return null;}
  }
  function renderSmart(){
   const wasOpen=smartPanel.open;smartPanel.replaceChildren();node('summary','Smart Study Recurrence · Pro',smartPanel);smartPanel.open=wasOpen;const body=node('div',undefined,smartPanel,'study-collapse-body');
   const enable=field('Enable early bonus opportunities',false,'checkbox',body);enable.checked=smartEnabled;enable.onchange=()=>{smartEnabled=enable.checked;renderSmart();};
   node('p','Only tasks in this recurrence can be shown early or rearranged. Each opportunity expires at the end of its chosen study day. Unfinished work stays required on its original date.',body,'study-hint');
   if(!smartEnabled)return;if(!plan){node('p','Preview a balanced schedule first.',body,'study-hint');return;}
   const schedule=rows(plan);
   node('p','Choose an earlier date for each specific future unit you want to show as bonus work. Leave other units unchanged.',body);
   const options=node('div',undefined,body,'study-scroll');
   for(const r of schedule)for(const n of r.numbers){const earlier=schedule.filter(x=>x.date<r.date);if(!earlier.length)continue;const l=node('label',plan.unit+'.'+n+' · required '+r.date,options,'study-field');const sel=node('select',undefined,l);node('option','No early appearance',sel).value='';for(const row of earlier)node('option',row.date,sel).value=row.date;sel.value=smartAppearances.get(n)||'';sel.onchange=()=>{if(sel.value)smartAppearances.set(n,sel.value);else smartAppearances.delete(n);renderSmart();};}
   const weekendOK=smartAppearances.size>0&&[...smartAppearances.values()].every(date=>root.TaskitatorSmartStudy.nextWeekend(date,Number(settings.weekend_start??5),Number(settings.weekend_end??6)).some(day=>schedule.some(r=>r.date===day)));
   for(const [value,text]of [['original','A · Lighten the original date'],['weekend','B · Lighten the next configured weekend'],['dates','C · Lighten selected dates']]){const l=node('label',text,body,'study-radio');const radio=node('input',undefined,l);radio.type='radio';radio.name='smartStudyMode';radio.value=value;radio.checked=smartMode===value;radio.disabled=value==='weekend'&&!weekendOK;radio.onchange=()=>{smartMode=value;renderSmart();};}
   node('small','Option B targets the next weekend starting after each early date; a weekend already underway is skipped. It is unavailable when that next weekend has no tasks. Use C to select other dates. Completed bonus tasks free slots on their original dates; at most one eligible task moves per freed slot.',body,'study-hint');
   if(smartMode==='dates'){node('p','Choose dates to lighten. Eligible unfinished units move in date order, finishing the earliest date first.',body);for(const r of schedule){const l=node('label',r.date,body,'study-check');const c=node('input',undefined,l);c.type='checkbox';c.checked=smartDates.has(r.date);c.onchange=()=>c.checked?smartDates.add(r.date):smartDates.delete(r.date);}}
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
   status.textContent=msg;if(confirmBtn)confirmBtn.disabled=!ok||used;
  }
  // Drafts (Phase 2.8): a restored draft fills the form; the preview comes back only if the units still match.
  let draftId=initial.draft?.id||null;
  if(initial.draft){
   const dr=initial.draft;title.value=dr.info.title||'';unit.value=dr.info.unit||unit.value;if(dr.info.total)total.value=dr.info.total;desc.value=dr.info.description||'';
   for(const [sel,v]of [[parentPrio,dr.info.parent],[unitPrio,dr.info.unitP]])if(Array.from(sel.options||sel.children||[]).some(o=>o.value===v))sel.value=v;
   audit.checked=dr.ai.enabled;aiBody.hidden=!audit.checked;criteria.value=dr.ai.criteria||'';exclude.value=dr.ai.exclude||'';
   const r=sched.restore(dr.schedule);
   var draftMsg=dr.schedule.sched&&!r.preview?'Draft restored. Preview the schedule again.':'Draft restored. Nothing is created until you confirm.';
  }
  async function confirmAsk(message){return window.TaskitatorConfirm?await window.TaskitatorConfirm({title:'Save draft?',message,confirmLabel:'Save draft'}):confirm(message);}
  showTab('info');
  const actions=node('div',undefined,d,'study-actions study-footer');
  const planId=crypto.randomUUID(),created=new Date().toISOString();
  confirmBtn=button('Create plan',actions,async()=>{
   refresh();if(used||!plan||confirmBtn.disabled)throw Error(status.textContent||'Preview a balanced schedule first.');if(window.TaskitatorEditorDraft)throw Error('Save or cancel your open task editor first.');
   const frozen=normalize({...plan,...(smartEnabled?{smart:{mode:smartMode,dates:[...smartDates],appearances:[...smartAppearances].map(([unit,date])=>({unit,date})),weekend_start:Number(settings.weekend_start??5),weekend_end:Number(settings.weekend_end??6)}}:{})}),payload={action:'authorize',config:frozen,plan_id:planId,created_at:created,audit:audit.checked,criteria:criteria.value,validation_id:validation?.id};
   if(!await window.SyncEngine.forceImmediateSync())throw Error('Sync your workspace successfully before creating the plan.');if(actor!==window.Clerk?.session?.id)throw Error('Account changed. Reopen the preview.');const before=localStorage.getItem('taskitator_tasks');
   if(!d.open)throw Error('Preview closed. Nothing was created.');const tasks=build(frozen,planId,created,audit.checked,criteria.value);await window.TaskitatorAuth.api('/study-plan',{method:'POST',body:JSON.stringify(payload)});
   if(!d.open||actor!==window.Clerk?.session?.id||before!==localStorage.getItem('taskitator_tasks'))throw Error('Your workspace changed. Review and confirm again.');
   const current=JSON.parse(before||'[]');if(current.some(t=>t.study_plan_id===planId)){used=true;d.close();return;}localStorage.setItem('taskitator_tasks',JSON.stringify([...current,...tasks]));used=true;confirmBtn.disabled=true;if(draftId)window.TaskitatorDrafts?.removeStudy(draftId);window.TaskitatorApp.loadStorage();window.TaskitatorApp.saveStorageAndPush();window.TaskitatorApp.renderUnifiedView();if(!await window.SyncEngine.forceImmediateSync()){status.textContent='Created locally; sync is pending. Use Sync Now before editing the new tasks.';return;}d.close();
  },'icon-btn study-btn study-primary');confirmBtn.disabled=true;if(initial.draft){refresh();const why=status.textContent;status.textContent=draftMsg+(confirmBtn.disabled&&!/^Preview/.test(why)?' '+why:'');}
  button('Save draft',actions,async()=>{
   if(!window.TaskitatorDrafts)throw Error('Drafts are unavailable. Reload Taskitator.');
   if(!await confirmAsk('Keep this study plan in Drafts? Nothing is created. Find it in the Drafts tab of the Study plans page.'+(draftId?' This replaces the draft you restored.':'')))return;
   draftId=window.TaskitatorDrafts.saveStudy({kind:'create',title:title.value,info:{title:title.value,unit:unit.value,total:total.value,parent:parentPrio.value,unitP:unitPrio.value,description:desc.value},
    ai:{enabled:audit.checked,criteria:criteria.value,exclude:exclude.value},schedule:sched.snapshot()},draftId);
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

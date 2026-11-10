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
  let titles=c.titles??[];if(!Array.isArray(titles)||titles.length>days||titles.some(t=>typeof t!=='string'||!t.trim()||t.length>200))throw Error('Enter valid parent titles.');titles=Array.from({length:days},(_,i)=>titles[i]||c.title.trim()+' '+(i+1));
  return {title:c.title.trim(),unit,plural,total,days,first,start:c.start,weekdays:[...new Set(weekdays)],skipped,counts:[...counts],titles:[...titles],description:c.description||'',...(parentPriority?{parent_priority:parentPriority}:{}),...(unitPriority?{unit_priority:unitPriority}:{}),...(c.smart?{smart:root.TaskitatorSmartStudy.normalize(c.smart,rows({...c,smart:null}))}:{})};
 }
 function rows(input){const c=normalize(input),allowed=new Set(c.weekdays.length?c.weekdays:[0,1,2,3,4,5,6]),skip=new Set(c.skipped),units=[];for(let n=c.first;units.length<c.total;n++)if(!skip.has(n))units.push(n);
  let at=Date.parse(c.start+'T00:00:00Z'),offset=0;return c.counts.map((count,i)=>{while(!allowed.has(new Date(at).getUTCDay()))at+=86400000;const date=new Date(at).toISOString().slice(0,10);at+=86400000;const numbers=units.slice(offset,offset+count);offset+=count;return {date,numbers,count,title:c.titles[i]||c.title+' '+(i+1)};});
 }
 function coverage(unit,numbers){const consecutive=numbers.every((n,i)=>!i||n===numbers[i-1]+1);return 'Covers '+unit.toLowerCase()+' '+(consecutive&&numbers.length>1?numbers[0]+' to '+numbers.at(-1):numbers.join(', '));}
 function build(input,id,created,audit=false,criteria=''){
  const c=normalize(input);if(c.counts.reduce((a,b)=>a+b,0)!==c.total)throw Error('The daily total must equal the requested unit amount.');if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))throw Error('Invalid plan identifier.');if(typeof created!=='string'||!Number.isFinite(Date.parse(created)))throw Error('Invalid creation time.');
  if(typeof criteria!=='string'||criteria.length>4000||audit&&!criteria.trim())throw Error('Enter audit criteria.');if(audit&&/\{(?!num\})[^}]*\}/.test(criteria))throw Error('Only {num} is available in study criteria.');
  const tasks=[];for(const [i,r]of rows(c).entries()){const pid='study_'+id+'_day_'+i,base={study_plan_id:id,status:'active',project_id:'inbox',tags:[],is_bonus:false,created_at:created,completed_at:null,due_date:r.date};tasks.push({...base,id:pid,parent_id:null,title:r.title,raw_title:r.title,description:coverage(c.plural,r.numbers)+(c.description?'\n'+c.description:''),ai_locked:false,proof_criteria:'',raw_proof_criteria:'',strict_prerequisites:true,...(c.parent_priority?{priority_id:c.parent_priority}:{})});for(const n of r.numbers)tasks.push({...base,id:'study_'+id+'_unit_'+n,parent_id:pid,title:c.unit+'.'+n,raw_title:c.unit+'.{num=='+n+'}',description:'',ai_locked:audit,proof_criteria:audit?criteria.replace(/\{num\}/g,String(n)):'',raw_proof_criteria:audit?criteria:'',strict_prerequisites:false,...(c.unit_priority?{priority_id:c.unit_priority}:{})});}return root.TaskitatorSmartStudy?root.TaskitatorSmartStudy.decorate(tasks,c.smart):tasks;
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
 const core={normalize,rows,build,coverage,defaultDays,perDay,weekdayPlan,parseSkips,calculate};root.TaskitatorStudyCore=core;
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
  const status=node('p','Nothing is created until you confirm.',d,'study-status');status.setAttribute('role','status');let busy=false,plan=null,validation=null,used=false;const customTitles={};
  function button(text,p,fn,cls='icon-btn study-btn'){const b=node('button',text,p,cls);b.type='button';b.onclick=()=>run(fn);return b;}
  async function run(fn){if(busy)return;busy=true;const inputs=[...d.querySelectorAll('input,textarea,select')],prior=inputs.map(e=>e.disabled);inputs.forEach(e=>e.disabled=true);try{if(actor!==window.Clerk?.session?.id)throw Error('Account changed. Reopen this preview.');await fn();}catch(e){status.textContent=e.message;}finally{inputs.forEach((e,i)=>e.disabled=prior[i]);busy=false;}}
  function field(label,value,type='text',parent=d,cls){const l=node('label',label,parent,type==='checkbox'?'study-check':'study-field'+(cls?' '+cls:''));const e=node(type==='textarea'?'textarea':'input',undefined,l);if(type!=='textarea')e.type=type;e.value=value;return e;}
  // Calculator (built on first open)
  let calcExpr='',calcShow=null;
  function calcKey(k){if(k==='C'){calcExpr='';}else if(k==='⌫'){calcExpr=calcExpr.slice(0,-1);}else if(k==='='){try{calcExpr=String(calculate(calcExpr));}catch{calcShow.textContent='Error';calcExpr='';return;}}else{if(/[+−×÷]/.test(k)&&/[+−×÷]$/.test(calcExpr))calcExpr=calcExpr.slice(0,-1);if(calcExpr.length<40)calcExpr+=k;}calcShow.textContent=calcExpr||'0';}
  calcBtn.onclick=()=>{if(!calcShow){calcShow=node('div','0',calcBox,'study-calc-display');calcShow.setAttribute('aria-live','polite');const pad=node('div',undefined,calcBox,'study-calc-pad');for(const k of ['7','8','9','÷','4','5','6','×','1','2','3','−','0','.','=','+','C','⌫']){const b=node('button',k,pad,'icon-btn study-calc-key'+(/[+−×÷=]/.test(k)?' is-op':''));b.type='button';b.onclick=()=>calcKey(k);}}calcBox.hidden=!calcBox.hidden;calcBtn.setAttribute('aria-expanded',String(!calcBox.hidden));};
  // Plan settings
  const basics=node('div',undefined,d,'study-grid');
  const title=field('Title',initial.title||'','text',basics,'study-wide'),unit=field('Unit name (singular)',initial.unit||'Chapter','text',basics),plural=field('Unit name (plural)',initial.plural||(initial.unit?initial.unit+'s':'Chapters'),'text',basics),total=field('Units to study (1–1,000)',initial.total??20,'number',basics),first=field('Starting unit',initial.first??1,'number',basics),start=field('Starting date',initial.start||today,'date',basics);
  const prios=(()=>{try{const st=JSON.parse(localStorage.getItem('taskitator_settings')||'{}');return Array.isArray(st.custom_priorities)&&st.custom_priorities.length?st.custom_priorities:[{id:'prio_high',name:'High',rank:1},{id:'prio_med',name:'Medium',rank:2},{id:'prio_low',name:'Low',rank:3}];}catch{return [];}})();
  const prioRank=id=>{if(!id)return Infinity;const p=prios.find(x=>x.id===id);return p?(Number(p.rank)||prios.indexOf(p)+1):Infinity;};
  const prioField=label=>{const l=node('label',label,basics,'study-field');const e=node('select',undefined,l);node('option','No priority',e).value='';for(const p of prios)node('option',p.name||p.id,e).value=p.id;e.addEventListener('change',()=>invalidate());return e;};
  const parentPrio=prioField('Parent task priority'),unitPrio=prioField('Unit priority');
  const split=node('fieldset',undefined,d,'study-card');node('legend','Split units by',split);
  const modes=node('div',undefined,split,'study-segment');let splitMode='days';const modeBtns={};
  for(const [value,text]of [['days','Number of study days'],['perDay','Units per day']]){const b=node('button',text,modes,'study-seg-btn');b.type='button';b.onclick=()=>{splitMode=value;syncMode();invalidate();};modeBtns[value]=b;}
  const days=field('Study days (1–365)',initial.days??5,'number',split),per=field('Units per day',4,'number',split);
  const rateBox=node('div',undefined,split,'study-rates');node('span','Different amount on specific weekdays (optional)',rateBox,'study-rates-title');const rateRow=node('div',undefined,rateBox,'study-rates-row');
  const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],rateInputs=WD.map(name=>{const l=node('label',name,rateRow,'study-rate');const e=node('input',undefined,l);e.type='number';e.min='1';e.max='1000';e.inputMode='numeric';e.addEventListener('input',()=>{invalidate();updateSplit();});return e;});
  const splitLine=node('p','',split,'study-hint'),splitCounts=node('p','',split,'study-hint'),splitEnd=node('p','',split,'study-hint'),splitWarn=node('p','',split,'study-hint study-warn'),splitIgnore=node('p','',split,'study-hint study-warn');
  const rateMap=()=>Object.fromEntries(rateInputs.flatMap((e,i)=>e.value.trim()===''?[]:[[i,Number(e.value)]]));
  const checkedDays=()=>checks.flatMap((e,i)=>e.checked?[i]:[]);
  const perDayPlan=()=>weekdayPlan(Number(total.value),Number(per.value),rateMap(),checkedDays(),start.value);
  function syncMode(){for(const [k,b]of Object.entries(modeBtns)){b.className='study-seg-btn'+(k===splitMode?' is-active':'');b.setAttribute('aria-pressed',String(k===splitMode));}days.parentElement.hidden=splitMode!=='days';per.parentElement.hidden=splitMode!=='perDay';rateBox.hidden=splitMode!=='perDay';updateSplit();}
  function updateSplit(){const t=Number(total.value);splitWarn.textContent='';splitIgnore.textContent='';splitEnd.textContent='';splitCounts.textContent='';try{if(splitMode==='perDay'){const r=perDayPlan();splitLine.textContent=t+' units over '+r.counts.length+' days';splitCounts.textContent='Daily: '+r.counts.join(', ');splitEnd.textContent='Ends on '+r.end;splitWarn.textContent=r.clipped?'The last day has only '+r.counts.at(-1)+' of its '+r.lastRate+' units.':'';splitIgnore.textContent=r.ignored.length?'Amounts set on unchecked weekdays are ignored: '+r.ignored.map(i=>WD[i]).join(', ')+'.':'';}else{const n=Number(days.value);if(!Number.isSafeInteger(t)||!Number.isSafeInteger(n)||n<1||t<1||n>t){splitLine.textContent='';return;}splitLine.textContent=t+' units over '+n+' days';splitCounts.textContent='Daily: '+Array.from({length:n},(_,i)=>Math.floor(t/n)+(i<t%n?1:0)).join(', ');}}catch(e){splitLine.textContent=e.message;}}
  const weekdays=node('fieldset',undefined,d,'study-card');node('legend','Study weekdays',weekdays);const dayRow=node('div',undefined,weekdays,'study-weekdays');const checks=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((name,i)=>{const l=node('label',name,dayRow,'study-day-chip');const e=node('input',undefined,l);e.type='checkbox';e.checked=(initial.weekdays??defaultDays(settings)).includes(i);return e;});node('small','Defaults exclude your Settings weekends. No days selected means every day.',weekdays,'study-hint');
  const desc=field('Description (optional)','','textarea');
  const preview=node('section',undefined,undefined,'study-preview');
  function invalidate(){plan=null;validation=null;preview.replaceChildren();skips.hidden=true;confirmBtn.disabled=true;status.textContent='Settings changed. Generate the schedule again.';}
  const setup=[title,unit,plural,total,days,per,first,start,desc,...checks];for(const e of setup)e.addEventListener('input',()=>{invalidate();updateSplit();});
  let autoPlural=!initial.plural;plural.addEventListener('input',()=>{autoPlural=false;});unit.addEventListener('input',()=>{if(autoPlural)plural.value=unit.value+'s';});
  let smartEnabled=false,smartMode='original',smartDates=new Set(),smartAppearances=new Map();
  const smartPanel=node('details',undefined,d,'study-collapse');node('summary','Smart Study Recurrence · Pro',smartPanel);
  function renderSmart(){
   const wasOpen=smartPanel.open;smartPanel.replaceChildren();node('summary','Smart Study Recurrence · Pro',smartPanel);smartPanel.open=wasOpen;const body=node('div',undefined,smartPanel,'study-collapse-body');
   const enable=field('Enable early bonus opportunities',false,'checkbox',body);enable.checked=smartEnabled;enable.onchange=()=>{smartEnabled=enable.checked;renderSmart();};
   node('p','Only tasks in this recurrence can be shown early or rearranged. Each opportunity expires at the end of its chosen study day. Unfinished work stays required on its original date.',body,'study-hint');
   if(!smartEnabled)return;if(!plan){node('p','Generate dates first.',body,'study-hint');return;}
   const schedule=rows(plan);
   node('p','Choose an earlier date for each specific future unit you want to show as bonus work. Leave other units unchanged.',body);
   const options=node('div',undefined,body,'study-scroll');
   for(const r of schedule)for(const n of r.numbers){const earlier=schedule.filter(x=>x.date<r.date);if(!earlier.length)continue;const l=node('label',plan.unit+'.'+n+' · required '+r.date,options,'study-field');const sel=node('select',undefined,l);node('option','No early appearance',sel).value='';for(const row of earlier)node('option',row.date,sel).value=row.date;sel.value=smartAppearances.get(n)||'';sel.onchange=()=>{if(sel.value)smartAppearances.set(n,sel.value);else smartAppearances.delete(n);renderSmart();};}
   const weekendOK=smartAppearances.size>0&&[...smartAppearances.values()].every(date=>root.TaskitatorSmartStudy.nextWeekend(date,Number(settings.weekend_start??5),Number(settings.weekend_end??6)).some(day=>schedule.some(r=>r.date===day)));
   for(const [value,text]of [['original','A · Lighten the original date'],['weekend','B · Lighten the next configured weekend'],['dates','C · Lighten selected dates']]){const l=node('label',text,body,'study-radio');const radio=node('input',undefined,l);radio.type='radio';radio.name='smartStudyMode';radio.value=value;radio.checked=smartMode===value;radio.disabled=value==='weekend'&&!weekendOK;radio.onchange=()=>{smartMode=value;renderSmart();};}
   node('small','Option B targets the next weekend starting after each early date; a weekend already underway is skipped. It is unavailable when that next weekend has no tasks. Use C to select other dates. Completed bonus tasks free slots on their original dates; at most one eligible task moves per freed slot.',body,'study-hint');
   if(smartMode==='dates'){node('p','Choose dates to lighten. Eligible unfinished units move in date order, finishing the earliest date first.',body);for(const r of schedule){const l=node('label',r.date,body,'study-check');const c=node('input',undefined,l);c.type='checkbox';c.checked=smartDates.has(r.date);c.onchange=()=>c.checked?smartDates.add(r.date):smartDates.delete(r.date);}}
  }
  renderSmart();
  const generateRow=node('div',undefined,d,'study-actions');
  d.append(preview);
  // Skipped units: typed as real unit numbers, lists or ranges.
  const skips=node('details',undefined,d,'study-collapse');skips.hidden=true;const skipSummary=node('summary','Skipped units',skips);const skipBox=node('div',undefined,skips,'study-collapse-body');
  node('p','Type the real unit number to skip (if units start at 5, type 8 for unit 8). Lists and ranges work: 8, 10-12.',skipBox,'study-hint');
  const skipRow=node('div',undefined,skipBox,'study-inline'),skipInput=node('input',undefined,skipRow,'study-input');skipInput.type='text';skipInput.name='studySkips';skipInput.setAttribute('inputmode','numeric');skipInput.placeholder='8, 10-12';
  const skipError=node('p','',skipBox,'study-error');skipError.setAttribute('role','alert');const chips=node('div',undefined,skipBox,'study-chips');
  function addSkips(){if(!plan)return;skipError.textContent='';try{const fresh=parseSkips(skipInput.value,plan.first,plan.total,plan.skipped);plan.skipped=[...new Set([...plan.skipped,...fresh])].sort((a,b)=>a-b);skipInput.value='';validation=null;render();}catch(e){skipError.textContent=e.message;}}
  button('Add skipped',skipRow,addSkips);skipInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();run(addSkips);}});
  function renderSkips(){skipSummary.textContent=plan.skipped.length?'Skipped units · '+plan.skipped.length:'Skipped units';chips.replaceChildren();for(const n of plan.skipped)button(plan.unit+' '+n+' ✕',chips,()=>{plan.skipped=plan.skipped.filter(x=>x!==n);validation=null;render();},'study-chip');}
  const audit=field('Enable AI audits for unit subtasks only',false,'checkbox');audit.checked=false;const criteria=field('Shared criteria — use {num} for each unit number','','textarea');criteria.maxLength=4000;criteria.parentElement.hidden=true;const validationText=node('p','',d,'study-hint');
  audit.onchange=()=>{criteria.parentElement.hidden=!audit.checked;validation=null;};criteria.oninput=()=>{validation=null;validationText.textContent='Criteria changed. Validate again.';};
  button('Validate reusable criteria',d,async()=>{if(!plan||!audit.checked)throw Error('Generate the schedule and enable audits first.');const selection=window.TaskitatorEngine.AuditEngine.selection();const r=await window.TaskitatorAuth.api('/study-plan',{method:'POST',body:JSON.stringify({action:'validate',config:plan,criteria:criteria.value,provider:selection.provider,model:selection.primary,key_version:selection.keyVersion})});validation=r;validationText.textContent=r.score+'/10 · '+r.critique;});
  // Preview: list or calendar. Both edit the same day state.
  let view='list',calMonth=null,calPick=0;
  function dayCard(i,r,numbers,parent){
   const row=node('article',undefined,parent,'study-day');node('h4',longDate(r.date),row);
   const name=field('Parent title',r.title,'text',row);name.oninput=()=>{plan.titles[i]=name.value;customTitles[i]=name.value;};
   node('p',coverage(plan.plural,numbers),row,'study-coverage');node('p',numbers.map(n=>plan.unit+'.'+n).join(', '),row,'study-units');
   const step=node('div',undefined,row,'study-stepper');
   button('−',step,()=>{if(plan.counts[i]>1){plan.counts[i]--;validation=null;render();}});node('span',String(plan.counts[i]),step,'study-count');button('+',step,()=>{if(plan.counts[i]<1000){plan.counts[i]++;validation=null;render();}});
  }
  function render(){renderSmart();preview.replaceChildren();renderSkips();const sum=plan.counts.reduce((a,b)=>a+b,0);
   const bar=node('div',undefined,preview,'study-preview-head');node('h3','Preview · '+sum+' / '+plan.total+' units',bar);
   const toggle=node('div',undefined,bar,'study-segment');for(const [value,text]of [['list','List'],['calendar','Calendar']]){const b=node('button',text,toggle,'study-seg-btn'+(view===value?' is-active':''));b.type='button';b.setAttribute('aria-pressed',String(view===value));b.onclick=()=>{view=value;render();};}
   let index=0;const sequence=[];for(let n=plan.first;sequence.length<Math.max(sum,plan.total);n++)if(!plan.skipped.includes(n))sequence.push(n);
   const schedule=rows(plan).map((r,i)=>{const numbers=sequence.slice(index,index+plan.counts[i]);index+=plan.counts[i];return {r,i,numbers};});
   if(view==='list'){for(const {r,i,numbers}of schedule)dayCard(i,r,numbers,preview);}
   else{
    const byDate=new Map(schedule.map(x=>[x.r.date,x]));if(calPick>=schedule.length)calPick=0;
    if(!calMonth)calMonth=schedule[0].r.date.slice(0,7);
    const [y,m]=calMonth.split('-').map(Number),firstDay=new Date(Date.UTC(y,m-1,1)),lead=(firstDay.getUTCDay()+6)%7,len=new Date(Date.UTC(y,m,0)).getUTCDate();
    const nav=node('div',undefined,preview,'study-cal-nav');
    const shift=k=>{const t=new Date(Date.UTC(y,m-1+k,1));calMonth=t.toISOString().slice(0,7);render();};
    const prev=node('button','‹',nav,'icon-btn study-cal-arrow');prev.type='button';prev.setAttribute('aria-label','Previous month');prev.onclick=()=>shift(-1);
    node('strong',window.TaskitatorI18n?.date(firstDay,{month:'long',year:'numeric',timeZone:'UTC'})??firstDay.toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'}),nav);
    const next=node('button','›',nav,'icon-btn study-cal-arrow');next.type='button';next.setAttribute('aria-label','Next month');next.onclick=()=>shift(1);
    const grid=node('div',undefined,preview,'study-cal-grid');for(const w of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])node('span',w,grid,'study-cal-wd');
    for(let k=0;k<lead;k++)node('span','',grid,'study-cal-cell is-empty');
    for(let dd=1;dd<=len;dd++){const iso=calMonth+'-'+String(dd).padStart(2,'0'),hit=byDate.get(iso);
     if(!hit){node('span',String(dd),grid,'study-cal-cell');continue;}
     const cell=node('button',undefined,grid,'study-cal-cell is-study'+(hit.i===calPick?' is-picked':''));cell.type='button';node('span',String(dd),cell,'study-cal-num');
     const ns=hit.numbers;node('span',ns.length>1?ns[0]+'–'+ns.at(-1):String(ns[0]??''),cell,'study-cal-units');cell.onclick=()=>{calPick=hit.i;render();};}
    node('p','Tap a study day to edit it.',preview,'study-hint');
    const pick=schedule[calPick];if(pick)dayCard(pick.i,pick.r,pick.numbers,preview);
   }
   confirmBtn.disabled=sum!==plan.total||used;status.textContent=sum===plan.total?'Review every date and title, then confirm.':sum+' / '+plan.total+' units. '+(sum>plan.total?'Remove '+(sum-plan.total):'Add '+(plan.total-sum))+' before confirming.';
  }
  button('Generate dates',generateRow,()=>{const t=Number(total.value),counts=splitMode==='perDay'?perDayPlan().counts:null;if(prioRank(unitPrio.value)<prioRank(parentPrio.value)){status.textContent='Units cannot have a higher priority than their parent task.';return;}plan=normalize({title:title.value,unit:unit.value,plural:plural.value,parent_priority:parentPrio.value||null,unit_priority:unitPrio.value||null,total:t,days:counts?counts.length:Number(days.value),...(counts?{counts}:{}),first:Number(first.value),start:start.value,weekdays:checks.flatMap((e,i)=>e.checked?[i]:[]),description:desc.value});plan.titles=plan.titles.map((t,i)=>customTitles[i]||t);calMonth=null;calPick=0;skips.hidden=false;render();},'icon-btn study-btn study-primary');
  const actions=node('div',undefined,d,'study-actions study-footer');
  syncMode();
  const planId=crypto.randomUUID(),created=new Date().toISOString();
  const confirmBtn=button('Confirm and create',actions,async()=>{
   if(used||!plan)throw Error('Generate the schedule first.');if(window.TaskitatorEditorDraft)throw Error('Save or cancel your open task editor first.');
   const frozen=normalize({...plan,...(smartEnabled?{smart:{mode:smartMode,dates:[...smartDates],appearances:[...smartAppearances].map(([unit,date])=>({unit,date})),weekend_start:Number(settings.weekend_start??5),weekend_end:Number(settings.weekend_end??6)}}:{})}),payload={action:'authorize',config:frozen,plan_id:planId,created_at:created,audit:audit.checked,criteria:criteria.value,validation_id:validation?.id};
   if(!await window.SyncEngine.forceImmediateSync())throw Error('Sync your workspace successfully before creating the plan.');if(actor!==window.Clerk?.session?.id)throw Error('Account changed. Reopen the preview.');const before=localStorage.getItem('taskitator_tasks');
   if(!d.open)throw Error('Preview closed. Nothing was created.');const tasks=build(frozen,planId,created,audit.checked,criteria.value);await window.TaskitatorAuth.api('/study-plan',{method:'POST',body:JSON.stringify(payload)});
   if(!d.open||actor!==window.Clerk?.session?.id||before!==localStorage.getItem('taskitator_tasks'))throw Error('Your workspace changed. Review and confirm again.');
   const current=JSON.parse(before||'[]');if(current.some(t=>t.study_plan_id===planId)){used=true;d.close();return;}localStorage.setItem('taskitator_tasks',JSON.stringify([...current,...tasks]));used=true;confirmBtn.disabled=true;window.TaskitatorApp.loadStorage();window.TaskitatorApp.saveStorageAndPush();window.TaskitatorApp.renderUnifiedView();if(!await window.SyncEngine.forceImmediateSync()){status.textContent='Created locally; sync is pending. Use Sync Now before editing the new tasks.';return;}d.close();
  },'icon-btn study-btn study-primary');confirmBtn.disabled=true;
  button('Cancel',actions,()=>d.close());d.addEventListener('close',()=>{d.remove();if(opened===d)opened=null;window.dispatchEvent(new Event('taskitator-study-closed'));});document.body.append(d);d.showModal();return {status:'confirmation_required',message:'Study preview opened. No tasks exist until the user confirms. Audit controls are manual only.'};
 }
 root.TaskitatorStudy={open,async propose(args){if(!args?.title||!Number.isInteger(args.total)||!Number.isInteger(args.days))return {status:'needs_input',message:'Ask the user for the missing title, total units, and study days. Never invent these.'};const allowed=['title','unit','plural','total','days','first','start','weekdays'];if(Object.keys(args).some(k=>!allowed.includes(k)))return {status:'error',message:'Copilot cannot supply audit settings, criteria, confirmation or skipped units.'};return open(args);}};
})(typeof window==='undefined'?globalThis:window);

/* Scheduling tab shared by the study plan page (re-plan) and the create-plan dialog (Phase 2.6).
   Controls: starting date, split mode, study weekdays, per-weekday amounts, skipped units, "Preview new schedule".
   Preview: calendar (default) or list, a surplus/missing balance, and per-date editing. The caller owns what the units are
   (ctx.units) and what else is on the calendar (ctx.fixed); this file owns the controls and the preview. */
(function(root){
'use strict';
if(typeof document==='undefined')return;
const tr=(key,vars)=>root.TaskitatorI18n?.t?root.TaskitatorI18n.t(key,vars):String(key).replace(/\{(\w+)\}/g,(_,k)=>vars?.[k]??'');
const el=(tag,text,parent,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;if(parent)parent.append(e);return e;};
const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const longDate=iso=>root.TaskitatorI18n?.date?root.TaskitatorI18n.date(iso+'T12:00:00Z',{weekday:'long',month:'short',day:'numeric',timeZone:'UTC'}):new Date(iso+'T12:00:00Z').toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric',timeZone:'UTC'});
const shortDate=iso=>root.TaskitatorI18n?.date?root.TaskitatorI18n.date(iso+'T12:00:00Z',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}):new Date(iso+'T12:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
const monthName=d=>root.TaskitatorI18n?.date?root.TaskitatorI18n.date(d,{month:'long',year:'numeric',timeZone:'UTC'}):d.toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'});

/* ctx: {
     today: 'YYYY-MM-DD', start: initial starting date, weekdays: [..], startUnit: initial 'Start from unit' value, startUnitHint: placeholder,
     units({startUnit, skipText}) -> number[]  (throws a readable Error)
     label() -> unit name for chips,
     fixed() -> Map date -> [{text, done}]   read-only items of this plan that are not part of the preview
     parentTitle(index, date) -> string       optional
     chip(number, date) -> {text, cls}        optional
     notes(state) -> [{text, warn}]           optional, shown under the balance
     disabled() -> bool, onChange() } */
function mount(parent,ctx){
 const st={start:ctx.start,mode:'cal',days:Math.max(1,Number(ctx.days)||4),per:Number(ctx.per)||2,rates:{},weekdays:new Set(ctx.weekdays||[]),startUnit:ctx.startUnit??'',skipText:'',
  sched:null,units:null,previewed:false,edited:new Set(),view:'cal',month:null,sel:null,touched:false,error:''};
 const box=el('div',undefined,parent,'ss');
 if(ctx.note)el('p',ctx.note,box,'ss-hint');
 const controls=el('div',undefined,box,'ss-controls'),previewBox=el('div',undefined,box,'ss-preview');previewBox.hidden=true;
 const off=()=>Boolean(ctx.disabled?.());
 const changed=({touch=true}={})=>{if(touch){st.touched=true;st.previewed=false;}paintButton();ctx.onChange?.();};
 const field=(label,p)=>{const w=el('label',label,p,'ss-field');return w;};
 const input=(label,p,type,value,cls)=>{const w=field(label,p);if(cls)w.classList.add(cls);const i=el('input',undefined,w);i.type=type;i.value=value??'';return i;};

 // ---- controls ----
 const startInput=input(tr('Starting date'),controls,'date',st.start);startInput.min=ctx.today;
 startInput.addEventListener('change',()=>{st.start=startInput.value;changed();});
 const seg=el('div',undefined,controls,'ss-seg'),segBtns={};
 for(const [value,text]of [['cal',tr('Number of study days')],['per',tr('Units per day')]]){const b=el('button',text,seg,'ss-seg-btn');b.type='button';b.addEventListener('click',()=>{st.mode=value;paintMode();changed();});segBtns[value]=b;}
 const rowDays=el('div',undefined,controls,'ss-grid'),rowPer=el('div',undefined,controls,'ss-grid');
 const daysInput=input(tr('Study days (1–365)'),rowDays,'number',st.days);daysInput.min=1;daysInput.max=365;daysInput.inputMode='numeric';
 const fromA=input(tr('Start from unit'),rowDays,'number',st.startUnit);
 const perInput=input(tr('Units per day'),rowPer,'number',st.per);perInput.min=1;perInput.max=1000;perInput.inputMode='numeric';
 const fromB=input(tr('Start from unit'),rowPer,'number',st.startUnit);
 for(const f of [fromA,fromB]){f.placeholder=ctx.startUnitHint==null?'':String(ctx.startUnitHint);f.inputMode='numeric';f.addEventListener('input',()=>{st.startUnit=f.value;fromA.value=fromB.value=f.value;changed();});}
 daysInput.addEventListener('input',()=>{st.days=daysInput.value;changed();});perInput.addEventListener('input',()=>{st.per=perInput.value;changed();});
 el('p',tr('Study weekdays (none selected means every day)'),controls,'ss-hint');
 const wdRow=el('div',undefined,controls,'ss-wd'),wdBoxes=WD.map((n,i)=>{const l=el('label',tr(n),wdRow,'ss-wd-item'),c=el('input',undefined,l);c.type='checkbox';c.checked=st.weekdays.has(i);
  c.addEventListener('change',()=>{c.checked?st.weekdays.add(i):st.weekdays.delete(i);syncRates();changed();});return c;});
 // Specific amount per weekday (units-per-day mode). Only selected weekdays can have their own amount.
 const rateBox=el('details',undefined,controls,'ss-collapse');el('summary',tr('Specific amount per weekday'),rateBox);const rateBody=el('div',undefined,rateBox,'ss-collapse-body');
 el('p',tr('Only selected weekdays can have their own amount. Empty means the default above.'),rateBody,'ss-hint');
 const rateRow=el('div',undefined,rateBody,'ss-wd'),rateInputs=WD.map((n,i)=>{const l=el('label',tr(n),rateRow,'ss-wd-item'),e=el('input',undefined,l);e.type='number';e.min=1;e.max=1000;e.inputMode='numeric';
  e.addEventListener('input',()=>{if(e.value.trim())st.rates[i]=Number(e.value);else delete st.rates[i];changed();});return e;});
 function syncRates(){rateInputs.forEach((e,i)=>{const on=!st.weekdays.size||st.weekdays.has(i);e.disabled=!on||off();if(!on){e.value='';delete st.rates[i];}});}
 const skipBox=el('details',undefined,controls,'ss-collapse');el('summary',tr('Skipped units'),skipBox);const skipBody=el('div',undefined,skipBox,'ss-collapse-body');
 const skipInput=el('input',undefined,skipBody,'ss-input');skipInput.type='text';skipInput.placeholder='8, 10-12';skipInput.dir='ltr';skipInput.inputMode='numeric';
 skipInput.addEventListener('input',()=>{st.skipText=skipInput.value;changed();});
 el('p',tr('Type real unit numbers. Lists and ranges work. Skipped units are removed from the plan.'),skipBody,'ss-hint');
 const button=el('button',tr('Preview new schedule'),controls,'ss-preview-btn');button.type='button';
 const buttonError=el('p','',controls,'ss-hint ss-warn');buttonError.setAttribute('role','alert');
 button.addEventListener('click',generate);
 function paintMode(){for(const [k,b]of Object.entries(segBtns)){b.classList.toggle('is-active',st.mode===k);b.setAttribute('aria-pressed',String(st.mode===k));}rowDays.hidden=st.mode!=='cal';rowPer.hidden=st.mode!=='per';rateBox.hidden=st.mode!=='per';}
 function paintButton(){
  button.classList.toggle('is-done',st.previewed);button.textContent=st.previewed?tr('Preview generated ✓'):tr('Preview new schedule');
  button.disabled=off()||st.previewed;button.setAttribute('aria-pressed',String(st.previewed));
 }
 function generate(){
  buttonError.textContent='';
  try{
   if(st.start<ctx.today)throw Error(tr('The new schedule cannot start before today.'));
   const units=ctx.units({startUnit:st.startUnit===''?null:Number(st.startUnit),skipText:st.skipText});
   if(!units.length)throw Error(tr('No unfinished units are left to schedule.'));
   const r=root.TaskitatorStudyCore.schedule(units.length,{mode:st.mode==='per'?'perDay':'days',days:Number(st.days),per:Number(st.per),rates:st.rates,weekdays:[...st.weekdays].sort(),start:st.start});
   st.sched=r.dates.map((date,i)=>({date,count:r.counts[i]}));st.units=units;st.edited=new Set();st.previewed=true;st.touched=true;st.view='cal';st.sel=null;st.month=r.dates[0].slice(0,7);
  }catch(e){buttonError.textContent=e.message;return;}
  paintButton();renderPreview();ctx.onChange?.();
 }

 // ---- preview ----
 const sorted=()=>st.sched.filter(x=>x.count>0).sort((a,b)=>a.date.localeCompare(b.date));
 const balance=()=>st.sched.reduce((a,x)=>a+x.count,0)-st.units.length;
 function setCount(date,count){
  const row=st.sched.find(x=>x.date===date);
  if(row)row.count=Math.max(0,count);else if(count>0)st.sched.push({date,count});
  st.sched=st.sched.filter(x=>x.count>0).sort((a,b)=>a.date.localeCompare(b.date));st.edited.add(date);
  renderPreview();ctx.onChange?.();
 }
 function renderPreview(){
  previewBox.replaceChildren();previewBox.hidden=!st.sched;if(!st.sched)return;
  const views=el('div',undefined,previewBox,'ss-seg');
  for(const [value,text]of [['cal',tr('Calendar')],['list',tr('List')]]){const b=el('button',text,views,'ss-seg-btn'+(st.view===value?' is-active':''));b.type='button';b.setAttribute('aria-pressed',String(st.view===value));b.addEventListener('click',()=>{st.view=value;renderPreview();});}
  const bal=balance(),banner=el('div',undefined,previewBox,'ss-balance '+(bal===0?'is-ok':'is-off'));banner.setAttribute('role','status');
  if(bal===0)banner.textContent=tr('All {n} units are placed.',{n:st.units.length})+' ✓';
  else{el('b',bal>0?tr('Surplus: {n}',{n:bal}):tr('Missing: {n}',{n:-bal}),banner);el('span',' '+(bal>0?tr('Remove {n} unit(s) from other dates.',{n:bal}):tr('Add {n} unit(s) to any date.',{n:-bal}))+' '+tr('The plan cannot be saved until this is 0.'),banner);}
  for(const n of ctx.notes?.(api.state())||[])el('p',n.text,previewBox,'ss-note'+(n.warn?' ss-warn':''));
  const assigned=new Map();{let i=0;for(const {date,count}of sorted()){assigned.set(date,st.units.slice(i,i+count));i+=count;}}
  if(st.view==='list'){
   const list=el('div',undefined,previewBox,'ss-list');
   if(!assigned.size)el('p',tr('Nothing is scheduled.'),list,'ss-hint');
   for(const [date,nums]of assigned){const r=el('div',undefined,list,'ss-row'+(st.edited.has(date)?' is-edited':''));el('strong',shortDate(date),r);el('span',nums.map(n=>ctx.label()+'.'+n).join(', '),r,'ss-row-units');}
  }else{calendar(assigned);detail(assigned);}
  if(off())for(const e of previewBox.querySelectorAll('input,button,select,textarea'))e.disabled=true;
 }
 function calendar(assigned){
  const [y,m]=st.month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)),pad=first.getUTCDay(),len=new Date(Date.UTC(y,m,0)).getUTCDate(),fixed=ctx.fixed?.()||new Map();
  const nav=el('div',undefined,previewBox,'ss-cal-nav');
  const shift=k=>{st.month=new Date(Date.UTC(y,m-1+k,1)).toISOString().slice(0,7);renderPreview();};
  const prev=el('button','‹',nav,'ss-cal-arrow');prev.type='button';prev.setAttribute('aria-label',tr('Previous month'));prev.addEventListener('click',()=>shift(-1));
  el('strong',monthName(first),nav);
  const next=el('button','›',nav,'ss-cal-arrow');next.type='button';next.setAttribute('aria-label',tr('Next month'));next.addEventListener('click',()=>shift(1));
  const grid=el('div',undefined,previewBox,'calendar-grid ss-cal');
  WD.forEach(n=>el('div',tr(n).slice(0,3),grid,'calendar-day-header'));
  for(let k=0;k<pad;k++)el('div','',grid,'calendar-cell empty');
  for(let d=1;d<=len;d++){
   const date=st.month+'-'+String(d).padStart(2,'0'),past=date<ctx.today,count=assigned.get(date)?.length||0,fx=fixed.get(date)||[];
   const cell=el('button',undefined,grid,'calendar-cell ss-cell'+(date===ctx.today?' today':'')+(date===st.sel?' selected':'')+(past&&!fx.length?' is-off':''));cell.type='button';
   el('span',String(d),cell,'calendar-date-number');
   const dots=el('div',undefined,cell,'calendar-dots-row');
   if(fx.length)el('span',undefined,dots,fx.every(x=>x.done)?'ss-dot-done':'cal-dot-solid');
   if(count)el('span',undefined,dots,st.edited.has(date)?'ss-dot-edit':'cal-dot-solid');
   if(count)el('small',String(count),cell,'ss-cell-count');
   cell.disabled=past&&!fx.length;
   cell.addEventListener('click',()=>{st.sel=date;renderPreview();});
  }
  const legend=el('div',undefined,previewBox,'ss-legend');
  for(const [cls,text]of [['cal-dot-solid',tr('Plan tasks')],['ss-dot-done',tr('Finished')],['ss-dot-edit',tr('Edited by you')]]){const s=el('span',undefined,legend);el('i',undefined,s,cls);el('span',text,s);}
  el('p',tr('This calendar shows only this plan\'s tasks.'),previewBox,'ss-hint');
 }
 function detail(assigned){
  const d=el('div',undefined,previewBox,'ss-detail');
  if(!st.sel){el('p',tr('Select a date to see and edit its tasks.'),d,'ss-hint');return;}
  const date=st.sel,nums=assigned.get(date)||[],fx=(ctx.fixed?.()||new Map()).get(date)||[],past=date<ctx.today;
  el('strong',longDate(date),d);
  if(fx.length){const c=el('div',undefined,d,'ss-chips');for(const x of fx)el('span',(x.done?'✓ ':'')+x.text,c,'ss-chip'+(x.done?' is-done':''));}
  if(past){el('p',tr('Past days and finished work stay as they are.'),d,'ss-hint');return;}
  if(nums.length){
   const index=sorted().findIndex(x=>x.date===date);
   const title=ctx.parentTitle?.(index,date);if(title)el('p',tr('Parent: {title}',{title}),d,'ss-hint');
   const c=el('div',undefined,d,'ss-chips');for(const n of nums){const info=ctx.chip?.(n,date)||{text:ctx.label()+'.'+n};el('span',info.text,c,'ss-chip'+(info.cls?' '+info.cls:''));}
  }else el('p',tr('No new tasks on this date.'),d,'ss-hint');
  const step=el('div',undefined,d,'ss-step');el('span',tr('Units on this date'),step,'ss-hint');
  const minus=el('button','−',step,'ss-step-btn');minus.type='button';minus.setAttribute('aria-label',tr('Remove one unit'));minus.disabled=!nums.length;minus.addEventListener('click',()=>setCount(date,nums.length-1));
  el('b',String(nums.length),step);
  const plus=el('button','+',step,'ss-step-btn');plus.type='button';plus.setAttribute('aria-label',tr('Add one unit'));plus.addEventListener('click',()=>setCount(date,nums.length+1));
  el('p',tr('Changing a date does not move other dates. It creates a surplus or a missing amount that you settle yourself.'),d,'ss-hint');
  if(nums.length){const rm=el('button',tr('Remove this date'),d,'ss-remove');rm.type='button';rm.addEventListener('click',()=>setCount(date,0));}
 }
 function setDisabled(flag){
  if(flag){for(const e of box.querySelectorAll('input,button,select,textarea'))e.disabled=true;return;}
  for(const e of controls.querySelectorAll('input,button,select,textarea'))e.disabled=false;
  syncRates();button.disabled=st.previewed;
 }
 const api={
  el:box,
  // Everything the caller needs to validate and save.
  state(){
   const sched=st.sched?sorted():[],bal=st.sched?balance():null;
   return {touched:st.touched,previewed:st.previewed,hasPreview:Boolean(st.sched),stale:Boolean(st.sched)&&!st.previewed,sched,units:st.units,balance:bal,edited:new Set(st.edited),
    options:{start:sched[0]?.date||st.start,mode:st.mode,days:Number(st.days),per:Number(st.per),rates:{...st.rates},weekdays:[...st.weekdays].sort(),startUnit:st.startUnit===''?null:Number(st.startUnit),skipText:st.skipText}};
  },
  rerender(){renderPreview();paintButton();},
  // Something outside this tab (for example the total number of units) changed: the preview no longer matches.
  invalidate(){if(!st.sched)return;st.previewed=false;paintButton();renderPreview();ctx.onChange?.();},
  disable(){setDisabled(off());paintButton();renderPreview();},
  reset(){
   st.sched=null;st.units=null;st.previewed=false;st.touched=false;st.edited=new Set();st.sel=null;st.start=ctx.start;st.mode='cal';st.rates={};st.skipText='';st.startUnit=ctx.startUnit??'';st.weekdays=new Set(ctx.weekdays||[]);
   startInput.value=st.start;skipInput.value='';fromA.value=fromB.value=st.startUnit;rateInputs.forEach(e=>e.value='');wdBoxes.forEach((c,i)=>c.checked=st.weekdays.has(i));
   buttonError.textContent='';paintMode();syncRates();renderPreview();paintButton();
  }
 };
 paintMode();syncRates();paintButton();setDisabled(off());
 return api;
}
root.TaskitatorStudySchedule={mount};
})(typeof window==='undefined'?globalThis:window);

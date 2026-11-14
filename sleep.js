/* Sleep Lock view (Phase 3.0: moved out of sleep.html's inline script; runs inside the index.html shell). */
(()=>{
 const form=document.getElementById('sleepForm'),enabled=document.getElementById('sleepEnabled'),bed=document.getElementById('bedtime'),wake=document.getElementById('wakeTime'),status=document.getElementById('sleepStatus'),save=document.getElementById('saveSleep'),reload=document.getElementById('reloadSleep'),bypass=document.getElementById('sleepBypass');let revision=0,ready=false,busy=false,visible=false,baseline='',settingsBaseline='';
 const panel=document.getElementById('sleepSettingsPanel'),gear=document.getElementById('sleepSettingsBtn'),firm=document.getElementById('firmMode'),todayOn=document.getElementById('todayOn'),todayBed=document.getElementById('todayBed'),todayWake=document.getElementById('todayWake'),panelSave=document.getElementById('saveSleepSettings'),panelStatus=document.getElementById('sleepSettingsStatus'),lockingStatus=document.getElementById('lockingStatus'),badge=document.getElementById('firmBadge'),delaySection=document.getElementById('delaySection'),delayFirmNote=document.getElementById('delayFirmNote');let saved={enabled:false,bedtime:'23:00',wake_time:'07:00',firm:false,today:null},lock=null,offset=0,lockTimer=null;
 const delayButtons=[document.getElementById('delay30'),document.getElementById('delay60')],delayStatus=document.getElementById('delayStatus');let delayUsed=false,savedEnabled=false;
 function showDelay(r){delayUsed=!!r.delay;savedEnabled=r.schedule.enabled;delayStatus.textContent=r.delay?'Delay used: '+r.delay.minutes+' minutes. Sleep starts at '+(window.TaskitatorI18n?.time(r.delay.sleep_at, {timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'}, 'en-GB') ?? new Date(r.delay.sleep_at).toLocaleTimeString('en-GB',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'}))+' Riyadh time.':'No delay used for this night.';}
 const scheduleFields=[enabled,bed,wake],settingsFields=[firm,todayOn,todayBed,todayWake];
 const values=fields=>fields.map(field=>field.type==='checkbox'?field.checked:field.value);
 const snapshot=fields=>JSON.stringify(values(fields));
 const dirty=()=>ready&&(baseline!==snapshot(scheduleFields)||settingsBaseline!==snapshot(settingsFields));
 async function reloadPreserving(fields, before){
  const edits=before===snapshot(fields)?null:values(fields);
  await load();
  if(edits)fields.forEach((field,index)=>{if(field.type==='checkbox')field.checked=edits[index];else field.value=edits[index];});
 }
 let phoneMissing=false;function controls(){for(const n of [enabled,bed,wake,save,bypass])n.disabled=busy||!ready||phoneMissing;for(const n of [firm,todayOn,panelSave])n.disabled=busy||!ready||phoneMissing;for(const n of [todayBed,todayWake])n.disabled=busy||!ready||phoneMissing||!todayOn.checked;for(const n of delayButtons)n.disabled=busy||!ready||delayUsed||!savedEnabled;reload.disabled=busy;}
 async function run(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){status.textContent=e.message;}finally{busy=false;controls();}}
 function lockState(){const now=Date.now()+offset;return !!(saved.firm&&saved.enabled&&lock&&now>=lock.from&&now<lock.until);}
 function renderLock(){const locked=lockState(),now=Date.now()+offset;badge.hidden=!saved.firm;delaySection.hidden=false;delayFirmNote.hidden=!saved.firm;for(const n of delayButtons)n.hidden=locked;
  lockingStatus.textContent=!saved.firm?'':!saved.enabled?'Firm mode is on. It applies once Sleep Lock is enabled.':locked?'Locking period is active until wake-up. Delays are closed, and later times or turning anything off need an Emergency Bypass.':lock?'Locking period opens at '+new Date(lock.from).toLocaleTimeString('en-GB',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'})+' Riyadh time (2 hours before bedtime).':'';
  if(visible&&lock&&now>=lock.until&&saved.firm&&!busy&&!dirty())run(load);}
 async function load(){const phone=await TaskitatorAuth.api('/auth/phone');phoneMissing=!phone.active;document.getElementById('macroNeeded').hidden=phone.active;const r=await TaskitatorAuth.api('/sleep-lock');enabled.checked=r.schedule.enabled;bed.value=r.schedule.bedtime;wake.value=r.schedule.wake_time;revision=r.schedule.revision;saved={enabled:r.schedule.enabled,bedtime:r.schedule.bedtime,wake_time:r.schedule.wake_time,firm:r.schedule.firm===true,today:r.schedule.today||null};lock=r.locking||null;offset=(r.now||Date.now())-Date.now();firm.checked=saved.firm;const t=saved.today;todayOn.checked=!!t;todayBed.value=t?t.bedtime:r.schedule.bedtime;todayWake.value=t?t.wake_time:r.schedule.wake_time;ready=true;baseline=snapshot(scheduleFields);settingsBaseline=snapshot(settingsFields);showDelay(r);renderLock();status.textContent=r.schedule.enabled?'Saved: '+bed.value+'–'+wake.value+' every day, Riyadh time.':'Sleep Lock is off.';}
 form.addEventListener('submit',e=>{e.preventDefault();run(async()=>{if(bed.value===wake.value)throw Error('Bedtime and wake-up time must be different.');await TaskitatorAuth.api('/sleep-lock',{method:'POST',body:JSON.stringify({enabled:enabled.checked,bedtime:bed.value,wake_time:wake.value,revision})});await reloadPreserving(settingsFields,settingsBaseline);});});
 delayButtons.forEach((button,i)=>button.addEventListener('click',()=>run(async()=>{if(dirty())throw Error('Save your schedule changes before delaying sleep.');const minutes=i===0?30:60;if(!confirm('Postpone tonight’s bedtime by '+minutes+' minutes? This uses your one delay for this night.'))return;const r=await TaskitatorAuth.api('/sleep-lock',{method:'POST',body:JSON.stringify({action:'delay',minutes,revision})});showDelay(r);status.textContent='Sleep delay saved to the server.';})));
 reload.addEventListener('click',()=>{if(!dirty()||confirm('Discard unsaved sleep schedule changes?'))run(load);});
 bypass.addEventListener('click',()=>run(async()=>{if(!confirm('Use one Emergency Bypass to unlock temporarily for 15 minutes?'))return;const r=await TaskitatorAuth.api('/emergency',{method:'POST',body:'{}'});status.textContent='Emergency Bypass active. Remaining weekly uses: '+r.uses_left+'.';}));
 gear.addEventListener('click',()=>{panel.hidden=!panel.hidden;gear.setAttribute('aria-expanded',String(!panel.hidden));});
 document.getElementById('closeSleepSettings').addEventListener('click',()=>{panel.hidden=true;gear.setAttribute('aria-expanded','false');});
 todayOn.addEventListener('change',controls);
 document.getElementById('sleepSettingsForm').addEventListener('submit',e=>{e.preventDefault();run(async()=>{panelStatus.textContent='';try{if(todayOn.checked&&todayBed.value===todayWake.value)throw Error('Tonight’s bedtime and wake-up time must be different.');
  await TaskitatorAuth.api('/sleep-lock',{method:'POST',body:JSON.stringify({enabled:saved.enabled,bedtime:saved.bedtime,wake_time:saved.wake_time,revision,firm:firm.checked,today:todayOn.checked?{bedtime:todayBed.value,wake_time:todayWake.value}:null})});
  await reloadPreserving(scheduleFields,baseline);panelStatus.textContent='Settings saved.';}catch(err){panelStatus.textContent=err.message;}});});
 window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
 // Shell view (Phase 3.0): load the schedule the first time the view opens, and again on later visits unless there are unsaved changes.
 window.TaskitatorSleepView={
  show(){visible=true;if(!lockTimer)lockTimer=setInterval(renderLock,30000);if(!dirty())run(load);else renderLock();},
  hide(){visible=false;clearInterval(lockTimer);lockTimer=null;},
  dirty
 };
})();

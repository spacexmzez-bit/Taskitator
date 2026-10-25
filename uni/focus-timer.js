(() => {
 'use strict';
 const defaults={work:25,rest:5,large:20,sessions:4,sound:true,vibration:true,awake:false};
 const fresh=()=>({config:{...defaults},phase:'work',session:1,running:false,left:1500000,target:null,done:false});
 function valid(s){return s&&['work','break','large'].includes(s.phase)&&Number.isInteger(s.session)&&s.session>=1&&s.session<=4&&typeof s.running==='boolean'&&Number.isFinite(s.left)&&s.left>=0&&s.left<=5400000&&(!s.running||Number.isFinite(s.target))&&s.config&&Number.isInteger(s.config.work)&&s.config.work>=1&&s.config.work<=90&&Number.isInteger(s.config.rest)&&s.config.rest>=1&&s.config.rest<=15&&Number.isInteger(s.config.large)&&s.config.large>=1&&s.config.large<=35&&Number.isInteger(s.config.sessions)&&s.config.sessions>=1&&s.config.sessions<=4;}
 function advance(s,now){let event=null,endedAt=null;
  for(let n=0;n<24&&s.running&&s.target<=now;n++){
   endedAt=s.target;
   if(s.phase==='large'){s.running=false;s.done=true;s.left=0;event='complete';break;}
   if(s.phase==='work'&&s.session>=s.config.sessions){s.phase='large';s.target+=(s.config.large||20)*60000;event='work';continue;}
   if(s.phase==='work'){s.phase='break';event='work';s.target+=s.config.rest*60000;}
   else{s.phase='work';s.session++;event='break';s.target+=s.config.work*60000;}
  }if(s.running)s.left=Math.max(0,s.target-now);return {state:s,event,endedAt};
 }
 window.TaskitatorPomodoro={advance,fresh,valid};
 let key=null,tag,panel,display,counter,phaseLabel,setup,restart,pause,end,message,pip=null,audio=null,wake=null,wakePending=false,busy=false;
 const user=()=>window.Clerk?.user?.id||window.TaskitatorAuth?.account?.user||null;
 const read=()=>{try{const s=JSON.parse(localStorage.getItem(key));if(s?.config){s.config.large??=20;s.config.work=Math.min(s.config.work,90);s.config.rest=Math.min(s.config.rest,15);s.config.sessions=Math.min(s.config.sessions,4);s.session=Math.min(s.session,4);}return valid(s)?s:fresh();}catch{return fresh();}};
 const el=(t,text,p)=>{const n=document.createElement(t);if(text!==undefined)n.textContent=text;p?.append(n);return n;};
 function save(s){localStorage.setItem(key,JSON.stringify(s));}
 async function exclusive(fn){if(!key)return;const current=key;const run=()=>current===key?fn():undefined;return navigator.locks?.request?navigator.locks.request('focus:'+current,run):run();}
 function unlockAudio(){try{audio ||=new(window.AudioContext||window.webkitAudioContext)();void audio.resume();}catch{}}
 function notify(event,s){if(s.config.sound&&audio?.state==='running'){try{const count=event==='complete'?3:event==='work'?2:1;for(let i=0;i<count;i++){const o=audio.createOscillator(),g=audio.createGain(),at=audio.currentTime+i*.3;o.frequency.value=event==='break'?880:587;o.connect(g);g.connect(audio.destination);g.gain.setValueAtTime(.15,at);g.gain.exponentialRampToValueAtTime(.001,at+.2);o.start(at);o.stop(at+.22);}}catch{}}
  if(s.config.vibration)try{navigator.vibrate?.(event==='complete'?[350,150,350,150,700]:event==='work'?[200,100,200]:[80,80,80]);}catch{}
 }
 async function screen(s){const wanted=s.config.awake&&s.running&&!document.hidden;
  if(!wanted&&wake){const old=wake;wake=null;await old.release().catch(()=>{});}
  if(wanted&&!wake&&!wakePending&&navigator.wakeLock){wakePending=true;const owner=key;try{const lock=await navigator.wakeLock.request('screen');if(owner!==key||document.hidden||!read().config.awake||!read().running)await lock.release();else{wake=lock;lock.addEventListener('release',()=>{if(wake===lock)wake=null;});}}catch{}finally{wakePending=false;}}
  if(message)message.textContent=s.config.awake?(!navigator.wakeLock?'Screen-awake is unavailable in this browser.':wake?'Screen-awake active.':'Screen-awake requested; the browser may release it.') : '';
 }
 function render(s){if(!tag)return;const ms=s.running?Math.max(0,s.target-Date.now()):s.left,sec=Math.ceil(ms/1000),text=s.done?'Sessions complete':`${s.phase==='work'?'Study':s.phase==='large'?'Large break':'Break'} ${s.session}/${s.config.sessions} · ${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}${s.running?'':' · paused'}`;
  const active=Boolean(s.target)&&!s.done,clock=`${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}`;
  tag.textContent=active?clock:'⏱';tag.classList.toggle('timer-active',active);tag.title=active?text:'Focus timer';display.textContent=clock;phaseLabel.textContent=s.done?'Complete':s.phase==='large'?'Large break':s.phase==='work'?'Study':'Break';counter.textContent=`${s.done||s.phase==='large'?s.config.sessions:s.session-(s.phase==='work'?1:0)} / ${s.config.sessions} sessions completed`;
  if(!active)setup.open=true;else if(!panel.open)setup.open=false;
  setup.querySelector('summary').textContent=active?'Restart':'Timer settings';restart.textContent=active?'Restart timer':'Start timer';pause.hidden=!active;end.hidden=!active;pause.textContent=s.running?'Pause':'Resume';if(pip&&!pip.closed)pip.document.body.textContent=text;void screen(s);
 }
 async function tick(){if(busy||!key)return;busy=true;try{await exclusive(()=>{const s=read(),a=advance(s,Date.now());if(a.event){save(s);if(Date.now()-a.endedAt<5000)notify(a.event,s);}render(s);});}catch{if(message)message.textContent='Timer could not save. Check browser storage.';}finally{busy=false;}}
 async function action(fn){unlockAudio();await exclusive(()=>{const s=advance(read(),Date.now()).state;fn(s);save(s);render(s);});}
 function mount(){const id=user(),next=id?'taskitator_focus_v1:'+id:null;if(next===key)return;key=next;tag?.remove();panel?.remove();tag=null;if(wake){void wake.release();wake=null;}pip?.close();pip=null;if(!key)return;
  tag=el('button','⏱ Focus timer',document.body);tag.type='button';tag.id='focusTimerTag';tag.className='icon-btn';tag.setAttribute('aria-label','Open focus timer');
  panel=el('dialog',undefined,document.body);panel.id='focusTimerPanel';panel.setAttribute('aria-labelledby','focusTimerHeading');const heading=el('h2','Focus timer',panel);heading.id='focusTimerHeading';phaseLabel=el('p','',panel);phaseLabel.className='focus-timer-phase';display=el('p','',panel);display.className='focus-timer-display';counter=el('p','',panel);counter.className='focus-timer-counter';message=el('p','',panel);message.className='focus-timer-status';message.setAttribute('role','status');
  setup=el('details',undefined,panel);el('summary','Timer settings',setup);setup.open=true;
  const fields=el('div',undefined,setup);fields.className='focus-timer-fields';
  const inputs={};for(const [name,label,max]of [['work','Study minutes',90],['rest','Break minutes',15],['large','Large break minutes',35]]){const l=el('label',label,fields),n=el('input',undefined,l);n.type='number';n.min=1;n.max=max;n.value=read().config[name];inputs[name]=n;}
  const sessionRow=el('div',undefined,setup);sessionRow.className='focus-session-stepper';el('span','Sessions before large break',sessionRow);const minus=el('button','−',sessionRow),n=el('input',undefined,sessionRow),plus=el('button','+',sessionRow);n.type='number';n.min=1;n.max=4;n.value=read().config.sessions;n.readOnly=true;n.setAttribute('aria-label','Sessions before large break');inputs.sessions=n;for(const [b,delta,label]of [[minus,-1,'Fewer sessions'],[plus,1,'More sessions']]){b.type='button';b.className='icon-btn';b.setAttribute('aria-label',label);b.addEventListener('click',()=>{n.value=Math.max(1,Math.min(4,Number(n.value)+delta));});}
  const options=el('div',undefined,setup);options.className='focus-timer-options';
  for(const [name,label]of [['sound','Sound'],['vibration','Vibration'],['awake','Keep screen awake']]){const l=el('label',label,options),n=el('input',undefined,l);n.type='checkbox';n.checked=read().config[name];n.addEventListener('change',()=>action(s=>s.config[name]=n.checked));}
  const actions=el('div',undefined,panel);actions.className='focus-timer-actions';
  function button(label,fn,parent=actions){const b=el('button',label,parent);b.type='button';b.className='icon-btn';b.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>message.textContent=e.message));return b;}
  restart=button('Start timer',()=>{const current=read();if(current.target&&!current.done&&!window.confirm('Restart this timer? Current progress will be lost.'))return;return action(s=>{const c={...s.config};for(const [name,n]of Object.entries(inputs)){const v=Number(n.value);if(!Number.isInteger(v)||v<1||v>Number(n.max))throw Error('Enter valid durations and session count.');c[name]=v;}Object.assign(s,fresh(),{config:c,running:true,left:c.work*60000,target:Date.now()+c.work*60000});setup.open=false;});},setup);restart.classList.add('focus-timer-start');
  pause=button('Pause',()=>action(s=>{if(s.done)return;s.left=s.running?Math.max(0,s.target-Date.now()):s.left;s.running=!s.running;if(s.running)s.target=Date.now()+s.left;}));
  end=button('End timer',()=>{if(!window.confirm('End this timer before it is finished?'))return;return action(s=>{const c=s.config;Object.assign(s,fresh(),{config:c,left:c.work*60000});});});
  if(window.documentPictureInPicture)button('Floating timer',async()=>{pip=await window.documentPictureInPicture.requestWindow({width:300,height:100});pip.document.body.style.cssText='font:22px system-ui;background:#102038;color:white;padding:16px';render(read());});
  const help=el('p','Your timer continues across pages. Alerts depend on browser support; tap a timer control to enable sound. Keep this tab open when using the floating window.',panel);help.className='focus-timer-help';
  button('Close',()=>panel.close());tag.addEventListener('click',()=>{unlockAudio();panel.showModal();render(read());});if(read().config.sound)unlockAudio();void tick();
 }
 window.addEventListener('taskitator-auth-ready',mount);window.Clerk?.addListener?.(mount);window.addEventListener('storage',()=>{mount();void tick();});document.addEventListener('visibilitychange',()=>{mount();void tick();});window.addEventListener('pagehide',()=>{if(wake)void wake.release();});setInterval(()=>{mount();void tick();},500);
 if(document.readyState!=='loading')mount();
})();

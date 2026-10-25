(() => {
 'use strict';
 const defaults={work:25,rest:5,sessions:4,sound:true,vibration:true,awake:false};
 const fresh=()=>({config:{...defaults},phase:'work',session:1,running:false,left:1500000,target:null,done:false});
 function valid(s){return s&&['work','break'].includes(s.phase)&&Number.isInteger(s.session)&&s.session>=1&&s.session<=12&&typeof s.running==='boolean'&&Number.isFinite(s.left)&&s.left>=0&&s.left<=7200000&&(!s.running||Number.isFinite(s.target))&&s.config&&Number.isInteger(s.config.work)&&s.config.work>=1&&s.config.work<=120&&Number.isInteger(s.config.rest)&&s.config.rest>=1&&s.config.rest<=60&&Number.isInteger(s.config.sessions)&&s.config.sessions>=1&&s.config.sessions<=12;}
 function advance(s,now){let event=null,endedAt=null;
  for(let n=0;n<24&&s.running&&s.target<=now;n++){
   endedAt=s.target;
   if(s.phase==='work'&&s.session>=s.config.sessions){s.running=false;s.done=true;s.left=0;event='complete';break;}
   if(s.phase==='work'){s.phase='break';event='work';s.target+=s.config.rest*60000;}
   else{s.phase='work';s.session++;event='break';s.target+=s.config.work*60000;}
  }if(s.running)s.left=Math.max(0,s.target-now);return {state:s,event,endedAt};
 }
 window.TaskitatorPomodoro={advance,fresh,valid};
 let key=null,tag,panel,display,message,pip=null,audio=null,wake=null,wakePending=false,busy=false;
 const user=()=>window.Clerk?.user?.id||window.TaskitatorAuth?.account?.user||null;
 const read=()=>{try{const s=JSON.parse(localStorage.getItem(key));return valid(s)?s:fresh();}catch{return fresh();}};
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
 function render(s){if(!tag)return;const ms=s.running?Math.max(0,s.target-Date.now()):s.left,sec=Math.ceil(ms/1000),text=s.done?'Sessions complete':`${s.phase==='work'?'Study':'Break'} ${s.session}/${s.config.sessions} · ${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}${s.running?'':' · paused'}`;
  tag.textContent='⏱ '+text;display.textContent=text;if(pip&&!pip.closed)pip.document.body.textContent=text;void screen(s);
 }
 async function tick(){if(busy||!key)return;busy=true;try{await exclusive(()=>{const s=read(),a=advance(s,Date.now());if(a.event){save(s);if(Date.now()-a.endedAt<5000)notify(a.event,s);}render(s);});}catch{if(message)message.textContent='Timer could not save. Check browser storage.';}finally{busy=false;}}
 async function action(fn){unlockAudio();await exclusive(()=>{const s=advance(read(),Date.now()).state;fn(s);save(s);render(s);});}
 function mount(){const id=user(),next=id?'taskitator_focus_v1:'+id:null;if(next===key)return;key=next;tag?.remove();panel?.remove();tag=null;if(wake){void wake.release();wake=null;}pip?.close();pip=null;if(!key)return;
  tag=el('button','⏱ Focus timer',document.body);tag.type='button';tag.id='pomodoroFabBtn';tag.style.cssText='position:fixed;right:20px;bottom:160px;z-index:9990;padding:12px;border-radius:12px;background:#063db5;color:white;border:1px solid #6197ff;max-width:calc(100vw - 40px)';
  panel=el('dialog',undefined,document.body);panel.id='focusTimerPanel';panel.style.cssText='max-width:90vw;border-radius:16px;padding:22px;background:var(--card-bg,#102038);color:var(--text-color,white)';el('h2','Focus timer',panel);display=el('p','',panel);message=el('p','',panel);message.setAttribute('role','status');
  const inputs={};for(const [name,label,max]of [['work','Study minutes',120],['rest','Break minutes',60],['sessions','Sessions',12]]){const l=el('label',label,panel),n=el('input',undefined,l);n.type='number';n.min=1;n.max=max;n.value=read().config[name];n.style.cssText='display:block;margin:8px 0;padding:8px';inputs[name]=n;}
  for(const [name,label]of [['sound','Sound'],['vibration','Vibration'],['awake','Keep screen awake']]){const l=el('label',label,panel),n=el('input',undefined,l);l.style.display='block';n.type='checkbox';n.checked=read().config[name];n.addEventListener('change',()=>action(s=>s.config[name]=n.checked));}
  function button(label,fn){const b=el('button',label,panel);b.type='button';b.style.cssText='margin:8px;padding:10px';b.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>message.textContent=e.message));}
  button('Start new sessions',()=>action(s=>{const c={...s.config};for(const [name,n]of Object.entries(inputs)){const v=Number(n.value);if(!Number.isInteger(v)||v<1||v>Number(n.max))throw Error('Enter valid durations and session count.');c[name]=v;}Object.assign(s,fresh(),{config:c,running:true,left:c.work*60000,target:Date.now()+c.work*60000});}));
  button('Pause / resume',()=>action(s=>{if(s.done)return;s.left=s.running?Math.max(0,s.target-Date.now()):s.left;s.running=!s.running;s.target=s.running?Date.now()+s.left:null;}));
  button('Reset',()=>action(s=>{const c=s.config;Object.assign(s,fresh(),{config:c,left:c.work*60000});}));
  if(window.documentPictureInPicture)button('Floating timer',async()=>{pip=await window.documentPictureInPicture.requestWindow({width:300,height:100});pip.document.body.style.cssText='font:22px system-ui;background:#102038;color:white;padding:16px';render(read());});
  el('p','The timer survives page changes and restores after reopening. Sound/vibration require browser support and may be delayed while suspended. After navigation, a tap may be required to enable sound. A floating window requires this tab to stay open.',panel);
  button('Close',()=>panel.close());tag.addEventListener('click',()=>{unlockAudio();panel.showModal();render(read());});if(read().config.sound)unlockAudio();void tick();
 }
 window.addEventListener('taskitator-auth-ready',mount);window.Clerk?.addListener?.(mount);window.addEventListener('storage',()=>{mount();void tick();});document.addEventListener('visibilitychange',()=>{mount();void tick();});window.addEventListener('pagehide',()=>{if(wake)void wake.release();});setInterval(()=>{mount();void tick();},500);
 if(document.readyState!=='loading')mount();
})();

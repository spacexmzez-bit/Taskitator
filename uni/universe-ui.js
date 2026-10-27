(() => {
 let root=document.getElementById('universeWorkspace');if(!root)return;
 const workspace=root;let shell=null;
 let epoch=0,busy=false;const pending=new Map();
 const actor=()=>[window.Clerk?.session?.id,window.TaskitatorAuth?.account?.user].join(':');let owner=actor();
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const status=node('p');status.className='uni-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 window.Clerk?.addListener?.(()=>{if(owner!==actor()){window.UniverseShell?.reset();owner=actor();epoch++;pending.clear();root=workspace;workspace.replaceChildren();}});
 async function api(path,body){const a=actor(),rev=epoch;window.UniverseShell?.connection(body?'saving':'connected');let r;try{r=await window.TaskitatorAuth.api(path,body?{method:'POST',body:JSON.stringify(body)}:{});window.UniverseShell?.connection(navigator.onLine===false?'offline':'connected');}catch(e){window.UniverseShell?.connection(navigator.onLine===false?'offline':'attention');throw e;}if(a!==actor()||rev!==epoch)throw new Error('Your session or view changed. Refresh to continue.');return r;}
 async function send(path,body){const key=JSON.stringify([path,body]);if(!pending.has(key))pending.set(key,{...body,operation_id:crypto.randomUUID()});const r=await api(path,pending.get(key));pending.delete(key);return r;}
 async function run(fn){if(busy)return;busy=true;root.setAttribute('aria-busy','true');status.textContent='Loading…';try{await fn();if(status.textContent==='Loading…')status.textContent='';}catch(e){status.textContent=e.message+' Retry the same action if the connection failed.';}finally{busy=false;root.setAttribute('aria-busy','false');}}
 function button(parent,text,fn){const b=node('button',text);b.type='button';b.addEventListener('click',()=>run(fn));parent.append(b);return b;}
 function field(parent,text,value='',max=120){const l=node('label',text),input=node('input');input.value=value;input.maxLength=max;l.append(input);parent.append(l);return input;}
 function form(parent,title,fields,submit,fn){const f=node('form');f.append(node('h3',title));const inputs=fields.map(([label,value,max])=>field(f,label,value,max));const b=node('button',submit);b.type='submit';f.append(b);f.addEventListener('submit',e=>{e.preventDefault();run(()=>fn(inputs.map(i=>i.value)));});parent.append(f);return inputs;}
 function start(){epoch++;root=workspace;window.UniverseShell?.reset();root.replaceChildren(status);}
 async function list(){start();const cap=await api('/universe/capabilities');if(!cap.ui){status.textContent='Universe needs a server update or setup. Your personal tasks are still available.';return;}
  const data=await api('/universe/groups');root.classList?.add('uni-selection');root.append(node('h2','Your Universes'),node('p','Choose a space. Work together, one Universe at a time.'));
  let isPro=false;try{const p=await api('/pro/status');isPro=p.isPro===true||p.status==='active'&&p.tier==='pro';}catch{}
  const tabs=node('div'),cards=node('div');cards.className='uni-cards';root.append(tabs,cards);const me=window.Clerk?.user?.id;
  const joined=button(tabs,'Joined Universes',()=>render(false)),created=button(tabs,'Created Universes',()=>{if(!isPro&&!data.groups.some(g=>g.role==='owner')){window.alert('Creating Universes is a Pro feature.');return;}render(true);});
  function render(owned){joined.setAttribute('aria-selected',String(!owned));created.setAttribute('aria-selected',String(owned));cards.replaceChildren();const groups=data.groups.filter(g=>(g.role==='owner')===owned);if(!groups.length)cards.append(node('p',owned?'You have not created a Universe.':'You have not joined a Universe.'));for(const g of groups)button(cards,g.title+' · '+g.role,()=>detail(g.id));}
  render(false);
  if(isPro)form(root,'Create a Universe',[['Name','',120],['Purpose','',2000]],'Create Universe',async([title,purpose])=>{const r=await send('/universe/groups',{title,purpose});await detail(r.group_id);});
  else root.append(node('p','Pro is required to create a Universe. Existing owned Universes remain accessible.'));
  form(root,'Join by invitation',[['Invitation token','',64]],'Join Universe',async([token])=>{const r=await send('/universe/invitations/accept',{token:token.trim()});await detail(r.group_id);});
  const viewEpoch=epoch;
  if(cap.capabilities?.portability&&window.UniverseReleaseUI)await window.UniverseReleaseUI.mount(root,null,{api,send,run,current:()=>viewEpoch===epoch&&owner===actor()});
 }
 async function detail(id){start();const g=(await api('/universe/groups/'+id)).group;const members=(await api('/universe/groups/'+id+'/members')).members;
  if(window.UniverseShell){workspace.classList.remove('uni-selection');shell=window.UniverseShell.create(workspace,g,window.TaskitatorAuth?.account?.user||window.Clerk?.user?.username||'Member',()=>run(list),()=>run(()=>detail(id)));root=shell.panes.controls||shell.panes.settings;if(g.solo_until)shell.panes.dashboard.append(node('p','Permanent deletion: '+new Date(g.solo_until).toLocaleString('en-GB',{timeZone:'Asia/Riyadh'})+' Riyadh unless another member joins. '+(!g.owner_pro?'Renew Pro to allow joining. ':'')+'Export remains available in Settings.'));shell.panes.dashboard.append(node('h3','My dashboard'),node('p',g.purpose));}else button(root,'All Universes',list);root.append(node('h2',g.title),node('p',g.purpose),node('p','Your role: '+g.role));
  if(g.solo_until)root.append(node('p','This Universe will be permanently deleted on '+new Date(g.solo_until).toLocaleString('en-GB',{timeZone:'Asia/Riyadh'})+' (Riyadh) unless another member joins. '+(!g.owner_pro?'Renew Pro to allow members to join. ':'')+'Export remains available during this countdown.'));
  if(!g.owner_pro&&!g.entitlement_unavailable)root.append(node('p','The owner needs active Pro to rename this Universe or add members. Existing work continues.'));
  if(g.read_only)root.append(node('p','Read-only: the owner needs to renew Pro. You may still leave; the owner may delete this Universe.'));
  else if(g.grace_until)root.append(node('p','Normal access continues until '+new Date(g.grace_until).toLocaleString()+'. The owner needs to renew Pro.'));
  if(g.entitlement_unavailable)root.append(node('p','Pro status could not be checked. Refresh before making changes.'));
  root.append(node('p','Joining a Universe does not enable phone blocking. You can choose whether to allow it below.'));
  const capabilities=await api('/universe/capabilities');
  const viewEpoch=epoch;
  if(capabilities.capabilities?.tasks&&window.UniverseTasksUI)await window.UniverseTasksUI.mount(shell?.panes.projects||root,g,members,{api,send,run,view:'projects',current:()=>viewEpoch===epoch&&owner===actor()});
  if(shell&&capabilities.capabilities?.tasks)await window.UniverseTasksUI.mount(shell.panes.dashboard,g,members,{api,send,run,view:'dashboard',onCreate:()=>{shell.show('projects');window.dispatchEvent(new Event('universe-create-task'));},current:()=>viewEpoch===epoch&&owner===actor()});
  if(capabilities.capabilities?.portability&&window.UniverseReleaseUI)await window.UniverseReleaseUI.mount(shell?.panes.community||root,g,{api,send,run,current:()=>viewEpoch===epoch&&owner===actor()});
  async function change(action,extra={}){await send('/universe/groups/'+id+'/'+action,{revision:g.revision,...extra});await (['leave','delete'].includes(action)?list():detail(id));}
  if(['owner','admin'].includes(g.role)){
   if(g.role==='owner'&&g.can_rename)form(shell?.panes.settings||root,'Group settings',[['Name',g.title,120],['Purpose',g.purpose,2000]],'Save',([title,purpose])=>change('edit',{title,purpose}));
   const invite=node('div'),l=node('label','Invitation role'),select=node('select');for(const role of(g.role==='owner'?['member','reviewer','admin']:['member','reviewer'])){const o=node('option',role);o.value=role;select.append(o);}l.append(select);invite.append(l);let token=null;
   if(g.can_add_members)button(invite,'Create invitation',async()=>{token??=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');const r=await send('/universe/groups/'+id+'/invitations',{token,role:select.value});const output=field(invite,'Share this single-use token privately. Expires '+new Date(r.expires_at).toLocaleString(),token,64);output.readOnly=true;output.focus();output.select();token=null;});root.append(invite);
  }
  if(['owner','admin'].includes(g.role)){const invitations=await api('/universe/groups/'+id+'/invitations');for(const i of invitations.invitations){root.append(node('p','Reserved seat · '+i.role+' · until '+new Date(i.expires_at).toLocaleString()));button(root,'Cancel invitation',async()=>{await send('/universe/groups/'+id+'/invitations/'+i.id+'/cancel',{revision:g.revision});await detail(id);});}}
  if(g.role==='owner'){const settings=await api('/universe/groups/'+id+'/settings');button(shell?.panes.settings||root,settings.validate_criteria?'Disable criteria validation':'Enable criteria validation',async()=>{if(confirm('Change criteria validation for this Universe?')){await send('/universe/groups/'+id+'/settings',{revision:g.revision,validate_criteria:!settings.validate_criteria});await detail(id);}});}
  root.append(node('h3','Members'));const ul=node('ul');root.append(ul);
  for(const m of members){const li=node('li',(m.username||'Member')+' · '+m.role);ul.append(li);
   if(!g.read_only&&!g.entitlement_unavailable&&m.role!=='owner'&&(g.role==='owner'||(g.role==='admin'&&['member','reviewer'].includes(m.role)))){
    const l=node('label','Role for '+(m.username||'Member')),select=node('select');for(const role of(g.role==='owner'?['member','reviewer','admin']:['member','reviewer'])){const o=node('option',role);o.value=role;select.append(o);}select.value=m.role;l.append(select);li.append(l);
    button(li,'Change role',()=>change('role',{target_id:m.account_id,role:select.value}));button(li,'Remove member',async()=>{if(window.confirm('Remove this member and end their group access?'))await change('remove',{target_id:m.account_id});});
   }
  }
  const events=(await api('/universe/groups/'+id+'/activity')).events;const history=node('details');history.append(node('summary','Recent membership activity'));for(const e of events)history.append(node('p',new Date(e.created_at).toLocaleString()+' · '+e.kind+' · '+(members.find(m=>m.account_id===e.actor_id)?.username||'Member')));(shell?.panes.community||root).append(history);if(shell){const portability=[...shell.panes.community.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Export and import');if(portability?.querySelector('summary')?.textContent==='Export and import')shell.panes.settings.append(portability);workspace.prepend(status);}
  if(g.role==='owner')button(shell?.panes.settings||root,'Delete Universe',async()=>{if(window.confirm('Permanently delete this Universe for every member? Save an export first if you need one.'))await change('delete',{confirm:true});});
  else button(shell?.panes.settings||root,'Leave Universe',async()=>{if(window.confirm('Leave this Universe and lose access to its history?'))await change('leave');});
 }
 window.addEventListener('taskitator-universe-view',()=>run(list));if(new URLSearchParams(location.search).get('view')==='universe')run(list);
})();

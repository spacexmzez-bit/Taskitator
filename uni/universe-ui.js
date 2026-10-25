(() => {
 const root=document.getElementById('universeWorkspace');if(!root)return;
 let epoch=0,busy=false;const pending=new Map();
 const actor=()=>[window.Clerk?.session?.id,window.TaskitatorAuth?.account?.user].join(':');let owner=actor();
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 window.Clerk?.addListener?.(()=>{if(owner!==actor()){owner=actor();epoch++;pending.clear();root.replaceChildren();}});
 async function api(path,body){const a=actor(),rev=epoch;const r=await window.TaskitatorAuth.api(path,body?{method:'POST',body:JSON.stringify(body)}:{});if(a!==actor()||rev!==epoch)throw new Error('Your session or view changed. Refresh to continue.');return r;}
 async function send(path,body){const key=JSON.stringify([path,body]);if(!pending.has(key))pending.set(key,{...body,operation_id:crypto.randomUUID()});const r=await api(path,pending.get(key));pending.delete(key);return r;}
 async function run(fn){if(busy)return;busy=true;root.setAttribute('aria-busy','true');status.textContent='Loading…';try{await fn();if(status.textContent==='Loading…')status.textContent='';}catch(e){status.textContent=e.message+' Retry the same action if the connection failed.';}finally{busy=false;root.setAttribute('aria-busy','false');}}
 function button(parent,text,fn){const b=node('button',text);b.type='button';b.addEventListener('click',()=>run(fn));parent.append(b);return b;}
 function field(parent,text,value='',max=120){const l=node('label',text),input=node('input');input.value=value;input.maxLength=max;l.append(input);parent.append(l);return input;}
 function form(parent,title,fields,submit,fn){const f=node('form');f.append(node('h3',title));const inputs=fields.map(([label,value,max])=>field(f,label,value,max));const b=node('button',submit);b.type='submit';f.append(b);f.addEventListener('submit',e=>{e.preventDefault();run(()=>fn(inputs.map(i=>i.value)));});parent.append(f);return inputs;}
 function start(){epoch++;root.replaceChildren(status);button(root,'Refresh',list);}
 async function list(){start();const cap=await api('/universe/capabilities');if(!cap.ui){status.textContent='Universe needs a server update or setup. Your personal tasks are still available.';return;}
  const data=await api('/universe/groups');root.append(node('h2','Your Universes'));if(!data.groups.length)root.append(node('p','You have not joined a Universe.'));
  for(const g of data.groups)button(root,g.title+(g.read_only?' · Read-only':''),()=>detail(g.id));
  form(root,'Create a Universe (Pro)',[['Name','',120],['Purpose','',2000]],'Create Universe',async([title,purpose])=>{const r=await send('/universe/groups',{title,purpose});await detail(r.group_id);});
  form(root,'Join by invitation',[['Invitation token','',64]],'Join Universe',async([token])=>{const r=await send('/universe/invitations/accept',{token:token.trim()});await detail(r.group_id);});
  const viewEpoch=epoch;
  if(cap.capabilities?.portability&&window.UniverseReleaseUI)await window.UniverseReleaseUI.mount(root,null,{api,send,run,current:()=>viewEpoch===epoch&&owner===actor()});
 }
 async function detail(id){start();const g=(await api('/universe/groups/'+id)).group;const members=(await api('/universe/groups/'+id+'/members')).members;
  button(root,'All Universes',list);root.append(node('h2',g.title),node('p',g.purpose),node('p','Your role: '+g.role));
  if(g.read_only)root.append(node('p','Read-only: the owner needs to renew Pro. You may still leave; the owner may delete this Universe.'));
  else if(g.grace_until)root.append(node('p','Normal access continues until '+new Date(g.grace_until).toLocaleString()+'. The owner needs to renew Pro.'));
  if(g.entitlement_unavailable)root.append(node('p','Pro status could not be checked. Refresh before making changes.'));
  root.append(node('p','Joining a Universe does not enable phone blocking. You can choose whether to allow it below.'));
  const capabilities=await api('/universe/capabilities');
  const viewEpoch=epoch;
  if(capabilities.capabilities?.tasks&&window.UniverseTasksUI)await window.UniverseTasksUI.mount(root,g,members,{api,send,run,current:()=>viewEpoch===epoch&&owner===actor()});
  if(capabilities.capabilities?.portability&&window.UniverseReleaseUI)await window.UniverseReleaseUI.mount(root,g,{api,send,run,current:()=>viewEpoch===epoch&&owner===actor()});
  async function change(action,extra={}){await send('/universe/groups/'+id+'/'+action,{revision:g.revision,...extra});await (['leave','delete'].includes(action)?list():detail(id));}
  if(!g.read_only&&!g.entitlement_unavailable&&['owner','admin'].includes(g.role)){
   form(root,'Group settings',[['Name',g.title,120],['Purpose',g.purpose,2000]],'Save',([title,purpose])=>change('edit',{title,purpose}));
   const invite=node('div'),l=node('label','Invitation role'),select=node('select');for(const role of(g.role==='owner'?['member','reviewer','admin']:['member','reviewer'])){const o=node('option',role);o.value=role;select.append(o);}l.append(select);invite.append(l);let token=null;
   button(invite,'Create invitation',async()=>{token??=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');const r=await send('/universe/groups/'+id+'/invitations',{token,role:select.value});const output=field(invite,'Share this single-use token privately. Expires '+new Date(r.expires_at).toLocaleString(),token,64);output.readOnly=true;output.focus();output.select();token=null;});root.append(invite);
  }
  root.append(node('h3','Members'));const ul=node('ul');root.append(ul);
  for(const m of members){const li=node('li',m.account_id+' · '+m.role);ul.append(li);
   if(!g.read_only&&!g.entitlement_unavailable&&m.role!=='owner'&&(g.role==='owner'||(g.role==='admin'&&['member','reviewer'].includes(m.role)))){
    const l=node('label','Role for '+m.account_id),select=node('select');for(const role of(g.role==='owner'?['member','reviewer','admin']:['member','reviewer'])){const o=node('option',role);o.value=role;select.append(o);}select.value=m.role;l.append(select);li.append(l);
    button(li,'Change role',()=>change('role',{target_id:m.account_id,role:select.value}));button(li,'Remove member',async()=>{if(window.confirm('Remove this member and end their group access?'))await change('remove',{target_id:m.account_id});});
   }
  }
  const events=(await api('/universe/groups/'+id+'/activity')).events;const history=node('details');history.append(node('summary','Recent membership activity'));for(const e of events)history.append(node('p',new Date(e.created_at).toLocaleString()+' · '+e.kind+' · '+e.actor_id));root.append(history);
  if(g.role==='owner')button(root,'Delete Universe',async()=>{if(window.confirm('Permanently delete this Universe for every member? Save an export first if you need one.'))await change('delete',{confirm:true});});
  else button(root,'Leave Universe',async()=>{if(window.confirm('Leave this Universe and lose access to its history?'))await change('leave');});
 }
 window.addEventListener('taskitator-universe-view',()=>run(list));if(new URLSearchParams(location.search).get('view')==='universe')run(list);
})();

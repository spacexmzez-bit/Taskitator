(() => {
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const date=value=>value?new Date(value).toISOString().slice(0,16):'';
 window.UniverseTasksUI={async mount(parent,g,members,tools){
  const {run}=tools,base='/universe/groups/'+g.id+'/work',panel=node('section');parent.append(panel);
  const active=()=>{if(!tools.current())throw Error('Your session or view changed. Refresh to continue.');};
  const api=(...args)=>{active();return tools.api(...args);},send=(...args)=>{active();return tools.send(...args);};
  const management=['owner','admin'].includes(g.role),writable=!g.read_only&&!g.entitlement_unavailable;
  const button=(p,label,fn)=>{const b=node('button',label);b.type='button';b.addEventListener('click',()=>run(fn));p.append(b);return b;};
  function input(p,label,value='',type='text',max=200){const l=node('label',label),e=node(type==='textarea'?'textarea':'input');if(type!=='textarea')e.type=type;e.value=value;e.maxLength=max;l.append(e);p.append(l);return e;}
  function select(p,label,choices,value){const l=node('label',label),s=node('select');for(const [v,text]of choices){const o=node('option',text);o.value=v;s.append(o);}s.value=value??choices[0]?.[0];l.append(s);p.append(l);return s;}
  async function download(id){const f=await api(base+'/files/'+id),bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=node('a');a.href=url;a.download=f.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  const uploadCache=new Map();
  async function upload(file,t,a,kind){
   if(file.size<1||file.size>5*1024*1024)throw Error('Files must be 1 byte to 5 MiB.');
   const bytes=new Uint8Array(await file.arrayBuffer()),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');active();
   const mime=file.type||(/\.txt$/i.test(file.name)?'text/plain':'');
   const key=JSON.stringify([t.id,t.revision,a?.id,kind,file.name,hash]);
   if(!uploadCache.has(key))uploadCache.set(key,await send(base+'/files',{task_id:t.id,assignment_id:a?.id??null,task_revision:t.revision,kind,name:file.name,mime,size:bytes.length,hash}));
   const staged=uploadCache.get(key);
   if(staged.uploaded)return staged.id;
   let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
   await send(base+'/files/'+staged.id+'/upload',{data:btoa(raw)});staged.uploaded=true;return staged.id;
  }
  function editor(data,t){
   const f=node('form');panel.append(f);f.append(node('h3',t?'Revise task and reset assignments':'Create task'));
   const project=select(f,'Project',data.projects.map(p=>[p.id,p.title]),t?.project_id),title=input(f,'Title',t?.title),criteria=input(f,'Completion criteria',t?.criteria??'','textarea',4000),mode=select(f,'Assignment type',[['everyone','Everyone’s — separate assignments'],['shared','Shared — one completion']],t?.mode);
   const start=input(f,'Opens (UTC)',date(t?.start_at),'datetime-local'),due=input(f,'Due (UTC)',date(t?.due_at),'datetime-local'),late=input(f,'Allow late submission','','checkbox');late.checked=t?.allow_late??false;
   const ai=input(f,'Require Universe AI review','','checkbox'),human=input(f,'Require human review after AI approval','','checkbox');ai.checked=t?.ai_required??false;human.checked=t?.human_required??true;
   const selected=[];const group=node('fieldset');group.append(node('legend','Selected assignees'));f.append(group);
   for(const m of members){const c=input(group,m.account_id+' · '+m.role,'','checkbox');c.checked=t?t.members.includes(m.account_id):false;selected.push([m.account_id,c]);}
   const reviewers=[],r=node('fieldset');r.append(node('legend','Reviewer roles'));f.append(r);for(const role of ['owner','admin','reviewer']){const c=input(r,role,'','checkbox');c.checked=t?t.reviewer_roles.includes(role):true;reviewers.push([role,c]);}
   const submit=node('button',t?'Save revision':'Create task');submit.type='submit';f.append(submit);
   f.addEventListener('submit',e=>{e.preventDefault();run(async()=>{await send(base+'/tasks'+(t?'/'+t.id+'/edit':''),{project_id:project.value,title:title.value,criteria:criteria.value,mode:mode.value,members:selected.filter(([,c])=>c.checked).map(([id])=>id),reviewer_roles:reviewers.filter(([,c])=>c.checked).map(([role])=>role),start_at:start.value?Date.parse(start.value+'Z'):null,due_at:due.value?Date.parse(due.value+'Z'):null,allow_late:late.checked,ai_required:ai.checked,human_required:human.checked,...(t?{revision:t.revision}:{})});await list();});});
  }
  async function assignment(id){
   const d=await api(base+'/assignments/'+id),a=d.assignment,t=d.task;panel.replaceChildren();button(panel,'Back to projects',list);panel.append(node('h3',t.title),node('p',t.criteria),node('p','Status: '+a.state+' · task revision '+t.revision));
   if(management&&writable)button(panel,'Edit task',async()=>{const data=await api(base);panel.replaceChildren();button(panel,'Back',list);editor(data,t);});
   panel.append(node('h4','Reference files'));for(const f of d.references)button(panel,f.name,()=>download(f.id));
   if(management&&writable){const file=input(panel,'Add reference (changes task revision)','','file');file.accept='.png,.jpg,.jpeg,.pdf,.txt';button(panel,'Upload reference',async()=>{if(!file.files[0])throw Error('Select a reference file.');const fid=await upload(file.files[0],t,null,'reference');await send(base+'/files/'+fid+'/attach',{task_revision:t.revision});await assignment(id);});}
   if(writable&&['open','rejected'].includes(a.state)){
    const text=input(panel,'Proof text','','textarea',8000),files=input(panel,'Proof files (up to three, 5 MiB each)','','file');files.multiple=true;files.accept='.png,.jpg,.jpeg,.pdf,.txt';
    button(panel,'Submit proof',async()=>{if(files.files.length>3)throw Error('Choose up to three files.');const uploaded=[];for(const f of files.files)uploaded.push(await upload(f,t,a,'proof'));await send(base+'/assignments/'+id+'/submit',{revision:a.revision,task_revision:t.revision,text:text.value,files:uploaded});await assignment(id);});
   }
   panel.append(node('h4','Submission history'));for(const s of d.submissions){const h=node('article');panel.append(h);h.append(node('p',new Date(s.created_at).toLocaleString()+' · '+s.actor_id+' · '+(s.decision||'Awaiting review')),node('p',s.text),node('p',s.reason||''));for(const fid of s.files||[])button(h,'Download proof',()=>download(fid));}
   if(a.state==='pending'&&d.submissions.some(s=>s.id===a.submission_id&&Date.now()-s.created_at>=86400000))panel.append(node('p','Review is overdue. This assignment stays released from phone blocking while the review is pending.'));
   for(const s of d.submissions)if(s.actor_id===window.Clerk?.user?.id)for(const fid of s.files||[]){button(panel,'Allow proof attachment '+fid+' in Universe exports',async()=>{if(confirm('Allow this attachment to be downloaded in Universe backups by an owner or admin? Withdrawing permission cannot recall files already downloaded.'))await send('/universe/groups/'+g.id+'/transfer/'+fid,{allowed:true});});button(panel,'Withdraw export permission for '+fid,()=>send('/universe/groups/'+g.id+'/transfer/'+fid,{allowed:false}));}
   if(t.ai_required){
    const aiBase='/universe/groups/'+g.id+'/ai';panel.append(node('h4','Universe AI review'),node('p',t.human_required?'AI approval is followed by a human decision.':'AI makes the completion decision.'));
    if(d.can_request_ai&&writable&&a.state==='pending'){
     const mode=select(panel,'Review payment',t.mode==='shared'?[['hosted','Group Shared credits']]:[['personal','My saved Gemini key'],['hosted','My Universe credits (Pro)']]);
     button(panel,'Get review quote',async()=>{await send(aiBase+'/'+id+'/quote',{mode:mode.value});await assignment(id);});
    }
    for(const q of d.ai_reviews||[]){const box=node('article');panel.append(box);box.append(node('p',q.mode+' · '+q.model+' · '+q.state),node('p','Maximum: '+q.max_credits+' credits. Charged: '+q.charged+' credits.'));
     if(q.result)box.append(node('p',q.result.verdict+': '+q.result.reason+(q.applied?'':' (not applied: assignment or access changed)')));
     if(q.state==='quoted'&&writable&&q.expires_at>Date.now()){
      box.append(node('p',q.mode==='personal'?'Your provider bills your own key. No Taskitator credits are charged.':'This reserves the maximum shown; unused credits return at settlement. Completed rejected reviews are charged.'));
      button(box,'Approve review — up to '+q.max_credits+' credits',async()=>{await send(aiBase+'/'+q.id+'/approve',{accept_max_credits:q.max_credits});await assignment(id);});
      button(box,'Cancel quote',async()=>{await send(aiBase+'/'+q.id+'/cancel',{});await assignment(id);});
     }
     if(['running','uncertain'].includes(q.state))box.append(node('p','This inference will not restart automatically. Its maximum hold remains until reconciled; refresh to check its status.'));
    }
    button(panel,'Refresh review status',()=>assignment(id));
   }
   if(writable&&['owner','admin','reviewer'].includes(g.role)){
    const reason=input(panel,'Review / reopening / dispute reason','','textarea',2000);
    async function change(action,extra={}){await send(base+'/assignments/'+id+'/'+action,{revision:a.revision,task_revision:t.revision,reason:reason.value,...extra});await assignment(id);}
    if(a.state==='pending'&&(!t.ai_required||t.human_required&&d.ai_attestation?.verdict==='approved')){button(panel,'Approve',()=>change('review',{decision:'approved'}));button(panel,'Reject',()=>change('review',{decision:'rejected'}));}
    if(['approved','rejected'].includes(a.state))button(panel,'Reopen with reason',()=>change('reopen'));
    if(a.submission_id)button(panel,'Close dispute',()=>change('dispute',{open:false}));
   }
   if(writable&&['approved','rejected'].includes(a.state)){const reason=input(panel,'Dispute reason','','textarea',2000);button(panel,'Open dispute',async()=>{await send(base+'/assignments/'+id+'/dispute',{revision:a.revision,task_revision:t.revision,reason:reason.value,open:true});await assignment(id);});}
  }
  async function list(){const data=await api(base);panel.replaceChildren(node('h3','Projects and tasks'));button(panel,'Refresh tasks',list);
   button(panel,'Show Universe balances',async()=>{const b=await api('/universe/groups/'+g.id+'/ai');panel.append(node('p','My Universe: '+b.account.daily/1000+' / 45 today, '+b.account.monthly/1000+' / 1000 this month. Shared: '+b.shared.daily/1000+' / 100 today, '+b.shared.monthly/1000+' / 2000 this month. Includes active holds.'));});
   for(const p of data.projects){const section=node('section');section.append(node('h4',p.title));panel.append(section);for(const t of data.tasks.filter(t=>t.project_id===p.id)){section.append(node('p',t.title+' · '+t.mode));for(const a of data.assignments.filter(a=>a.task_id===t.id&&a.state!=='cancelled'))button(section,(a.account_id||'Shared')+' · '+a.state,()=>assignment(a.id));}}
   if(management&&writable){const title=input(panel,'New project name');button(panel,'Create project',async()=>{await send(base+'/projects',{title:title.value});await list();});if(data.projects.length)editor(data);}
  }
  await list();
 }};
})();

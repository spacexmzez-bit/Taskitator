// Universe Community tab (Space plan Phase 3): admin posts, comments in a thread view, Load more paging.
// The server decides every permission (can_post, can_comment, can_edit, can_delete); the page only follows it.
(() => {
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const roleName=role=>window.UniverseSpace?.label?.('role',role)??role;
 const when=ms=>window.TaskitatorI18n?.dateTime?.(ms,{dateStyle:'medium',timeStyle:'short'})??new Date(ms).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
 const ask=message=>window.UniverseDialog?.confirm(message)??Promise.resolve(window.confirm(message));
 // ---- Context tab (3C): files and photos admins share. Needs the owner's active Pro; the server decides. ----
 window.UniverseContextUI={async mount(root,g,members,tools){
  const {api,send,button,field,run}=tools,base='/universe/groups/'+g.id+'/context',MB=1048576,toast=(m,o)=>window.UniverseUX?.toast(m,o);
  const size=n=>n<MB?Math.max(1,Math.round(n/1024))+' KB':(n/MB).toFixed(1)+' MB';
  const bytesOf=f=>{const raw=atob(f.data),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;};
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const body=node('div');body.className='uni-context';root.append(body);const uploaded=new Map();
  async function draw(){const d=await api(base);body.replaceChildren();
   const meter=node('div');meter.className='uni-context-usage';const bar=node('div');bar.className='uni-progress';const fill=node('i');fill.style.width=Math.min(100,Math.round(d.used/d.quota*100))+'%';bar.append(fill);meter.append(node('p',size(d.used)+' of '+Math.round(d.quota/MB)+' MB used'),bar);
   if(!d.available){const off=node('div');off.className='uni-empty';const art=window.UniverseSpace?.body?.('comet','uni-empty-art');if(art)off.append(art);off.append(node('h3','Context is off'));
    const until=d.retention_until?(window.TaskitatorI18n?.date?.(d.retention_until,{timeZone:'Asia/Riyadh',day:'numeric',month:'short',year:'numeric'})??new Date(d.retention_until).toLocaleDateString()):null;
    off.append(node('p',until?(window.TaskitatorI18n?.t?.('The owner’s Pro has lapsed. Files are kept until {0}, then deleted.',{0:until})??'The owner’s Pro has lapsed. Files are kept until '+until+', then deleted.'):'Context needs the owner’s active Pro.'),node('p','The owner can renew Pro, or transfer ownership to a member who has Pro, to bring the files back.'));body.append(off);if(d.used)body.append(meter);return;}
   body.append(meter);
   if(d.can_upload&&!g.read_only){const up=node('form');up.className='uni-context-upload';const pick=field(up,'Add files or photos','file');pick.multiple=true;pick.accept='.png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.docx,.xlsx,.pptx';const go=node('button','Upload');go.type='submit';go.className='btn-primary';const status=node('p');status.className='uni-hint';status.setAttribute('role','status');up.append(go,status,Object.assign(node('p','Up to 10 MB per file. Members can download everything here.'),{className:'uni-hint'}));body.append(up);
    up.addEventListener('submit',e=>{e.preventDefault();return run(async()=>{const list=[...(pick.files||[])];if(!list.length)throw Error('Choose files to upload.');if(list.some(f=>f.size>10*MB))throw Error('Each Context file can be up to 10 MB.');if(list.reduce((n,f)=>n+f.size,0)+d.used>d.quota)throw Error('This Universe’s Context is full (200 MB). Delete files to make room.');
     // One request per file; a retry skips files that already arrived.
     for(const [i,f]of list.entries()){if(uploaded.has(f))continue;status.textContent='Uploading '+(i+1)+' of '+list.length;const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(let j=0;j<bytes.length;j+=8192)raw+=String.fromCharCode(...bytes.subarray(j,j+8192));
      const mime=f.type||({txt:'text/plain',csv:'text/csv'})[f.name.split('.').pop()?.toLowerCase()]||'';uploaded.set(f,(await send(base+'/files',{name:f.name,mime,size:bytes.length,hash:await hash(bytes),data:btoa(raw)})).id);}
     pick.value='';uploaded.clear();toast(list.length===1?'1 file uploaded':list.length+' files uploaded');await draw();},go);});}
   if(!d.files.length){body.append(Object.assign(node('p',d.can_upload?'Nothing here yet. Upload study material, photos or handouts.':'Nothing here yet. Files your admins share will appear here.'),{className:'uni-empty-line'}));return;}
   const grid=node('div');grid.className='uni-context-grid';body.append(grid);
   for(const f of d.files){const card=node('article');card.className='uni-context-item'+(f.kind==='image'?' is-image':'');grid.append(card);
    if(f.kind==='image'){const img=node('img');img.alt=f.name;img.loading='lazy';img.setAttribute('translate','no');card.append(img);api(base+'/files/'+f.id).then(x=>{if(['image/png','image/jpeg','image/webp'].includes(x.mime))img.src=URL.createObjectURL(new Blob([bytesOf(x)],{type:x.mime}));}).catch(()=>img.remove());}
    const name=node('p',f.name);name.className='uni-context-name';name.setAttribute('translate','no');name.setAttribute('dir','auto');card.append(name);
    const meta=node('p',size(f.bytes)+' · '+(f.username||tools.nameOf(f.uploader_id)));meta.className='uni-context-meta';meta.setAttribute('translate','no');card.append(meta);
    const acts=node('div');acts.className='uni-post-actions';card.append(acts);
    button(acts,'Download',async()=>{const x=await api(base+'/files/'+f.id),url=URL.createObjectURL(new Blob([bytesOf(x)],{type:'application/octet-stream'})),a=node('a');a.href=url;a.download=x.name;a.click?.();setTimeout(()=>URL.revokeObjectURL(url),10000);});
    if(d.can_upload)button(acts,'Delete',async()=>{if(!await ask('Delete this file for everyone?'))return;await send(base+'/files/'+f.id+'/delete',{});toast('File deleted');await draw();},'uni-danger');}}
  const tools2=node('div');tools2.className='uni-feed-tools';root.prepend(tools2);button(tools2,'Refresh',draw);
  await draw();
 }};
 window.UniverseCommunityUI={async mount(slot,g,members,tools){
  const {run}=tools,base='/universe/groups/'+g.id+'/community',root=node('section');root.className='uni-community';slot.append(root);
  const active=()=>{if(!tools.current())throw Error('Your session or view changed. Refresh to continue.');};
  const api=(...a)=>{active();return tools.api(...a);},send=(...a)=>{active();return tools.send(...a);};
  const toast=(m,o)=>window.UniverseUX?.toast(m,o);
  const button=(p,label,fn,cls)=>{const b=node('button',label);b.type='button';if(cls)b.className=cls;b.addEventListener('click',()=>run(fn,b));p.append(b);return b;};
  const field=(p,label,type='text',max=200)=>{const l=node('label',label),e=node(type==='textarea'?'textarea':'input');if(type!=='textarea')e.type=type;e.maxLength=max;l.append(e);p.append(l);return e;};
  const nameOf=(id,fallback)=>fallback||members.find(m=>m.account_id===id)?.username||'Former member';
  const byline=(target,id,username,role,created,edited)=>{const line=node('p');line.className='uni-byline';const who=node('strong',nameOf(id,username));who.setAttribute('translate','no');const chip=node('span',roleName(role));chip.className='uni-role-chip';chip.dataset.role=role;const time=node('time',when(created)+(edited?' · ':''));line.append(who,chip,time);if(edited)time.append(node('span','edited'));target.append(line);return line;};
  // Body text is user content: shown as plain text, never as HTML. Phase 3B adds link rendering here.
  const bodyText=(target,text)=>{const p=node('div');p.className='uni-post-body';p.setAttribute('translate','no');p.setAttribute('dir','auto');if(tools.renderBody)tools.renderBody(p,text);else p.textContent=text;target.append(p);return p;};
  if(tools.view==='context'){await (window.UniverseContextUI?.mount?.(root,g,members,{...tools,api,send,button,field,nameOf}));return;}
  // A form sheet in the shared overlay: heading, body, primary action, Cancel; focus and Escape handled by UniverseUX.
  function sheet(heading,submitText){const overlay=node('div');overlay.className='uni-editor-overlay';const f=node('form');f.className='uni-editor modal-box uni-sheet';overlay.append(f);const head=node('div');head.className='uni-editor-heading';head.append(node('h3',heading));const body=node('div');body.className='uni-editor-body';const actions=node('div');actions.className='uni-editor-actions';f.append(head,body,actions);let save=null;if(submitText){save=node('button',submitText);save.type='submit';save.className='btn-primary';actions.append(save);}let release=null;
   f.addEventListener('input',()=>{f.dataset.dirty='true';});
   const close=async()=>{if(f.dataset.saving==='true')return;if(f.dataset.dirty!=='true'||await ask('Discard unsaved changes?')){f.dataset.dirty='false';release?.();overlay.remove();f.dispatchEvent(new Event('universe-closed'));}};button(actions,submitText?'Cancel':'Close',close);root.append(overlay);
   return {f,body,save,close,done(){f.dataset.dirty='false';release?.();overlay.remove();},open(initial){release=window.UniverseUX?.layer(overlay,{close,initial})||null;initial?.focus?.();}};}
  // ---- Composer (admins and the owner) ----
  function composer(p){
   const s=sheet(p?'Edit post':'New post',p?'Save post':'Publish');
   const text=field(s.body,'Post','textarea',8000);text.rows=6;text.value=p?.body||'';
   const who=node('fieldset');who.className='uni-tag-options uni-audience';who.append(node('legend','Who can comment'));s.body.append(who);
   const roles=[['member','Members'],['reviewer','Reviewers']].map(([value,label])=>{const box=field(who,label,'checkbox');box.checked=p?p.comment_roles.includes(value):true;return [value,box];});
   const projects=(tools.projects||[]).map(pr=>{const box=field(who,'Assignees of '+pr.title,'checkbox');box.checked=!!p?.comment_projects.includes(pr.id);return [pr.id,box];});
   s.body.append(Object.assign(node('p','Admins and the owner can always comment. Leave everything unticked to turn comments off.'),{className:'uni-hint'}));
   const extra=tools.composerExtras?.(s,p)||null;
   s.f.addEventListener('submit',e=>{e.preventDefault();return run(async()=>{if(!text.value.trim())throw Error('Write something before publishing.');s.f.dataset.saving='true';try{
    const body={body:text.value,comment_roles:roles.filter(([,b])=>b.checked).map(([v])=>v),comment_projects:projects.filter(([,b])=>b.checked).map(([v])=>v),...(await extra?.collect?.()||{}),...(p?{revision:p.revision}:{})};
    await send(base+'/posts'+(p?'/'+p.id+'/edit':''),body);s.done();await load(true);toast(p?'Post saved':'Post published');
   }finally{s.f.dataset.saving='false';}},e.submitter||s.save);});
   s.open(text);
  }
  // ---- Thread view ----
  async function thread(p){
   const s=sheet(p.legacy?'Earlier discussion':'Comments',null);s.f.classList.add('uni-thread');
   const top=node('article');top.className='uni-post uni-thread-post';if(!p.legacy){byline(top,p.author_id,p.username,p.author_role,p.created_at,p.edited_at);bodyText(top,p.body);tools.renderFiles?.(top,p);}else top.append(Object.assign(node('p','Comments from the old Discussion section. Read-only.'),{className:'uni-hint'}));s.body.append(top);
   const list=node('div');list.className='uni-comments';list.setAttribute('aria-live','polite');s.body.append(list);
   const more=node('div');more.className='uni-feed-end';s.body.append(more);
   let next=null,replyTo=null,rows=[];const write=node('form');write.className='uni-comment-form';
   const replyLine=node('p'),replyText=node('span');replyLine.className='uni-reply-to';replyLine.hidden=true;replyLine.append(replyText);
   const draw=()=>{list.replaceChildren();if(!rows.length)list.append(Object.assign(node('p','No comments yet.'),{className:'uni-empty-line'}));for(const c of rows){const row=node('article');row.className='uni-thread-comment'+(c.deleted?' is-removed':'')+(c.parent_id?' is-reply':'');row.dataset.id=c.id;
     byline(row,c.author_id,c.username,c.author_role,c.created_at,c.edited_at);
     if(c.parent_id){const parent=rows.find(x=>x.id===c.parent_id);const ref=node('p',parent?'Reply to '+nameOf(parent.author_id,parent.username):'Reply');ref.className='uni-reply-ref';row.append(ref);}
     if(c.deleted)row.append(Object.assign(node('p','Removed'),{className:'uni-removed'}));else bodyText(row,c.body);
     const acts=node('div');acts.className='uni-comment-actions';
     if(!c.deleted&&data.can_comment)button(acts,'Reply',()=>{replyTo=c;replyLine.hidden=false;replyText.textContent='Replying to '+nameOf(c.author_id,c.username);input.focus?.();});
     if(c.can_edit)button(acts,'Edit',()=>edit(c,row));
     if(c.can_delete)button(acts,'Delete',async()=>{if(!await ask(c.author_id===window.Clerk?.user?.id?'Delete your comment?':'Remove this comment? Its text is cleared for everyone.'))return;await send(base+'/comments/'+c.id+'/delete',{revision:c.revision});await reload();toast('Comment removed');},'uni-danger');
     if(acts.children.length)row.append(acts);list.append(row);}};
   const edit=(c,row)=>{if(row.querySelector('.uni-comment-edit'))return;const f=node('form');f.className='uni-comment-edit';const t=field(f,'Edit your comment','textarea',4000);t.value=c.body;const save=node('button','Save');save.type='submit';f.append(save);button(f,'Cancel',()=>f.remove());f.addEventListener('submit',e=>{e.preventDefault();return run(async()=>{await send(base+'/comments/'+c.id+'/edit',{revision:c.revision,body:t.value});await reload();},save);});row.append(f);t.focus?.();};
   let data={can_comment:false};
   const page=async()=>{data=await api(base+'/posts/'+p.id+'/comments'+(next?'/after/'+next:''));rows=[...rows,...data.comments];next=data.next;draw();more.replaceChildren();if(next)button(more,'Load more comments',page);write.hidden=!data.can_comment;closed.hidden=data.can_comment;};
   const reload=async()=>{rows=[];next=null;await page();};
   const closed=node('p',p.legacy?'This thread is read-only.':'This post does not take comments from your role.');closed.className='uni-hint';
   const input=field(write,'Write a comment','textarea',4000);input.rows=3;const sendButton=node('button','Comment');sendButton.type='submit';sendButton.className='btn-primary';
   const cancelReply=node('button','Cancel reply');cancelReply.type='button';cancelReply.addEventListener('click',()=>{replyTo=null;replyLine.hidden=true;});replyLine.append(cancelReply);
   write.prepend(replyLine);write.append(sendButton);
   write.addEventListener('submit',e=>{e.preventDefault();return run(async()=>{if(!input.value.trim())throw Error('Write a comment first.');await send(base+'/posts/'+p.id+'/comments',{body:input.value,...(replyTo?{parent_id:replyTo.id}:{})});input.value='';replyTo=null;replyLine.hidden=true;s.f.dataset.dirty='false';await reload();},sendButton);});
   s.body.append(write,closed);s.open(input);await reload();
   // Comment counts in the feed may have changed.
   s.f.addEventListener('universe-closed',()=>load(true));
  }
  // ---- Feed ----
  const head=node('div');head.className='uni-feed-tools';root.append(head);
  const feed=node('div');feed.className='uni-feed';root.append(feed);const end=node('div');end.className='uni-feed-end';root.append(end);
  let cursor=null,posts=[],canPost=false;
  function card(p){const a=node('article');a.className='uni-post'+(p.legacy?' is-legacy':'');a.dataset.id=p.id;
   if(p.legacy){a.append(node('h3','Earlier discussion'),Object.assign(node('p','Comments from the old Discussion section, kept read-only.'),{className:'uni-hint'}));}
   else{byline(a,p.author_id,p.username,p.author_role,p.created_at,p.edited_at);bodyText(a,p.body);tools.renderFiles?.(a,p);tools.renderExpiry?.(a,p);}
   const foot=node('div');foot.className='uni-post-actions';a.append(foot);
   const open=button(foot,p.comment_count===0?'Comments':p.comment_count===1?'1 comment':p.comment_count+' comments',()=>thread(p),'uni-comments-button');open.setAttribute('aria-label','Open comments');
   if(p.can_edit)button(foot,'Edit',()=>composer(p));
   if(p.can_delete)button(foot,'Delete',async()=>{if(!await ask('Delete this post, its comments and its attachments for everyone?'))return;await send(base+'/posts/'+p.id+'/delete',{revision:p.revision});await load(true);toast('Post deleted');},'uni-danger');
   return a;}
  async function load(reset=false){if(reset){cursor=null;posts=[];}
   const data=await api(base+(cursor?'/after/'+cursor:''));canPost=data.can_post;posts=[...posts,...data.posts];cursor=data.next;
   if(reset)feed.replaceChildren();for(const p of data.posts)feed.append(card(p));
   end.replaceChildren();
   if(!posts.length){const empty=node('div');empty.className='uni-empty';const art=window.UniverseSpace?.body?.('comet','uni-empty-art');if(art)empty.append(art);empty.append(node('h3','No posts yet'),node('p',canPost?'Share news, plans or material with everyone here.':'Posts from your admins will appear here.'));end.append(empty);}
   else if(data.end)end.append(Object.assign(node('p','No more posts'),{className:'uni-end-line'}));
   else button(end,'Load more',()=>load());
   drawTools();}
  function drawTools(){head.replaceChildren();if(canPost&&!g.read_only)button(head,'New post',()=>composer(null),'btn-primary');button(head,'Refresh',()=>load(true));}
  try{tools.projects=(await api('/universe/groups/'+g.id+'/work')).projects?.filter(p=>!p.options?.deleted)||[];}catch{tools.projects=[];}
  // ---- Links (3B): http(s) addresses in a post or comment become links that open in a new tab without referrer, with
  // the real domain shown beside them, so the text of a link can never hide where it goes.
  tools.renderBody=(target,text)=>{const re=/https?:\/\/[^\s<>"']+/g;let last=0,m;while((m=re.exec(text))){let url=m[0];const trail=url.match(/[.,;:!?)\]]+$/)?.[0]||'';if(trail)url=url.slice(0,-trail.length);let host='';try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))continue;host=u.hostname;}catch{continue;}
    if(m.index>last)target.append(document.createTextNode(text.slice(last,m.index)));const a=node('a',url);a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.className='uni-link';const domain=node('span',host);domain.className='uni-link-domain';target.append(a,domain);last=m.index+url.length;}
   if(last<text.length)target.append(document.createTextNode(text.slice(last)));};
  if(tools.capabilities?.community_files){
   const MB=1048576,LIMIT=8*MB,size=n=>n<MB?Math.max(1,Math.round(n/1024))+' KB':(n/MB).toFixed(1)+' MB';
   const asBlob=f=>{const raw=atob(f.data),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;};
   // Files are always saved, never opened in the page (octet-stream, download attribute). Images show inline.
   const save=async file=>{const f=await api(base+'/files/'+file.id),url=URL.createObjectURL(new Blob([asBlob(f)],{type:'application/octet-stream'})),a=node('a');a.href=url;a.download=f.name;a.click?.();setTimeout(()=>URL.revokeObjectURL(url),10000);};
   tools.renderFiles=(target,p)=>{if(!p.files?.length)return;const wrap=node('div');wrap.className='uni-post-files';target.append(wrap);
    for(const file of p.files){if(file.kind==='image'){const fig=node('figure');fig.className='uni-post-image';const img=node('img');img.alt=file.name;img.loading='lazy';img.setAttribute('translate','no');fig.append(img);wrap.append(fig);
      api(base+'/files/'+file.id).then(f=>{if(!['image/png','image/jpeg','image/webp'].includes(f.mime))return;img.src=URL.createObjectURL(new Blob([asBlob(f)],{type:f.mime}));}).catch(()=>{fig.replaceChildren(Object.assign(node('p','Image unavailable'),{className:'uni-hint'}));});}
     else{const b=button(wrap,file.name,()=>save(file),'uni-file-chip');b.setAttribute('translate','no');b.title=file.name+' · '+size(file.bytes);const meta=node('span',size(file.bytes));meta.className='uni-file-size';b.append(meta);}}};
   tools.renderExpiry=(target,p)=>{if(!p.expires_at)return;const opts={timeZone:'Asia/Riyadh',day:'numeric',month:'short',year:'numeric'},day=window.TaskitatorI18n?.date?.(p.expires_at,opts)??new Date(p.expires_at).toLocaleDateString([],opts);
    // Translated here: a localised date makes the text Arabic, which the page translator skips.
    const chip=node('p',window.TaskitatorI18n?.t?.('Removed on {0}',{0:day})??'Removed on '+day);chip.className='uni-expiry';target.append(chip);};
   tools.composerExtras=(s,p)=>{
    const ends=node('div');ends.className='uni-expiry-pick';s.body.append(ends);
    const choice=node('select'),l=node('label','Remove this post');for(const [v,t]of [['keep',p?'Keep the current setting':'Never'],['never','Never'],['3','After 3 days'],['7','After 7 days'],['14','After 14 days'],['30','After 30 days'],['date','On a date…']]){if(!p&&v==='never')continue;const o=node('option',t);o.value=v;choice.append(o);}l.append(choice);ends.append(l);
    const date=field(ends,'End date (removed at 23:59 Riyadh time)','date');date.parentElement.hidden=true;choice.addEventListener('change',()=>{date.parentElement.hidden=choice.value!=='date';});
    if(p?.expires_at)ends.append(Object.assign(node('p','Currently removed on '+new Date(p.expires_at+3*3600000).toISOString().slice(0,10)+'.'),{className:'uni-hint'}));
    const box=node('fieldset');box.className='uni-attachments';box.append(node('legend','Attachments'));s.body.append(box);
    const list=node('ul');list.className='uni-attach-list';const meter=node('p');meter.className='uni-hint';meter.setAttribute('role','status');
    const picker=field(box,'Add files or images','file');picker.multiple=true;picker.accept='.png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.docx,.xlsx,.pptx';box.append(list,meter);
    box.append(Object.assign(node('p','Images need your own Pro. Up to 5 MB per file and 8 MB per post. Files are downloaded, never opened in the page.'),{className:'uni-hint'}));
    let kept=[...(p?.files||[])];const added=[],uploaded=new Map();
    const draw=()=>{list.replaceChildren();for(const [arr,item,label,bytes]of [...kept.map(f=>[kept,f,f.name,f.bytes]),...added.map(f=>[added,f,f.name,f.size])]){const li=node('li');const name=node('span',label+' · '+size(bytes));name.setAttribute('translate','no');li.append(name);const x=node('button','Remove');x.type='button';x.addEventListener('click',()=>{arr.splice(arr.indexOf(item),1);s.f.dataset.dirty='true';draw();});li.append(x);list.append(li);}
     const total=kept.reduce((n,f)=>n+f.bytes,0)+added.reduce((n,f)=>n+f.size,0);meter.textContent=total?size(total)+' of 8 MB':'';meter.dataset.over=String(total>LIMIT);};
    picker.addEventListener('change',()=>{for(const f of picker.files||[])added.push(f);picker.value='';draw();});draw();
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    return {async collect(){
     const total=kept.reduce((n,f)=>n+f.bytes,0)+added.reduce((n,f)=>n+f.size,0);if(total>LIMIT)throw Error('Attachments on one post can total 8 MB. Remove some files.');
     if(added.some(f=>f.size>5*MB))throw Error('Each file can be up to 5 MB.');
     // Each file is uploaded once; a retry after a failure reuses what already arrived.
     const ids=[...kept.map(f=>f.id)];for(const f of added){if(!uploaded.has(f)){const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
       const mime=f.type||({txt:'text/plain',csv:'text/csv'})[f.name.split('.').pop()?.toLowerCase()]||'';uploaded.set(f,(await send(base+'/files',{name:f.name,mime,size:bytes.length,hash:await hash(bytes),data:btoa(raw)})).id);}ids.push(uploaded.get(f));}
     const out={};if(added.length||kept.length!==(p?.files||[]).length||!p)out.file_ids=ids;
     if(choice.value==='date'){if(!date.value)throw Error('Choose an end date.');out.expires_on=date.value;}else if(['3','7','14','30'].includes(choice.value))out.expires_in_days=Number(choice.value);else if(choice.value==='never'&&p)out.expires_on=null;
     return out;}};};
  }
  await load(true);
 }};
})();

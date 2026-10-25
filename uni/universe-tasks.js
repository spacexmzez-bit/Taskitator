import { UniverseMembership } from './universe-membership.js';
import { fail, digest } from '../pro-backend.js';
const DAY=86400000, MAX=5*1024*1024;
const err=(status,code,message)=>fail(status,'UNIVERSE_'+code,message);
const roles=['reviewer','admin','owner'];
const mimeTypes=['image/png','image/jpeg','application/pdf','text/plain'];
const uuid=prefix=>prefix+'_'+crypto.randomUUID();
export class UniverseTasks extends UniverseMembership {
 async phase3(db=this.database()){try{return Boolean(await db.prepare('SELECT version FROM universe_phase3 WHERE version=3').first());}catch{return false;}}
 async availability(){const a=await super.availability(),ready=a.ui&&await this.phase3();return {...a,version:ready?3:a.version,schema_version:ready?3:a.schema_version,capabilities:{...a.capabilities,tasks:ready,reviews:ready,proof_uploads:ready&&Boolean(this.env.TASKITATOR_EVIDENCE)}};}
 async record(db,table,id,gid){const row=await this.statement(db,`SELECT * FROM ${table} WHERE id=? AND group_id=?`,id,gid).first();if(!row)throw err(404,'NOT_FOUND','This item is unavailable.');return row;}
 async task(db,id,gid){const t=await this.record(db,'universe_tasks',id,gid);return {...t,...JSON.parse(t.data)};}
 async access(db,identity,gid,write=false){const g=await this.authorize(db,identity,gid);if(write)this.writable(g);return g;}
 manager(g){if(!['owner','admin'].includes(g.role))throw err(403,'ROLE_DENIED','An owner or administrator must make this change.');}
 reviewer(g,t){if(!roles.includes(g.role)||!t.reviewer_roles.includes(g.role))throw err(403,'ROLE_DENIED','Your current role cannot review this task.');}
 submitter(g,a,identity){if(a.account_id&&a.account_id!==identity.userId)throw err(403,'ROLE_DENIED','This assignment belongs to another member.');}
 checkRevision(actual,expected){if(!Number.isSafeInteger(expected)||actual!==expected)throw err(409,'REVISION','This item changed. Refresh before continuing.');}
 bucket(){if(!this.env.TASKITATOR_EVIDENCE)throw err(503,'EVIDENCE_UNAVAILABLE','Private evidence storage needs setup.');return this.env.TASKITATOR_EVIDENCE;}
 async commit(db,identity,g,scope,body,result,writes){
  this.operation(body);
  await this.service.ensureAlarm();
  return this.mutate(db,identity,'tasks:'+g.id+':'+scope,body,result,[this.guard(db,identity,g.id,g.revision,'m.role=?',[g.role]),...writes,this.statement(db,'UPDATE universe_groups SET revision=revision+1 WHERE id=?',g.id),this.event(db,g.id,identity.userId,scope,result.id||g.id)]);
 }
 async replay(db,identity,gid,scope,body){
  await this.access(db,identity,gid);this.operation(body);
  const old=await this.statement(db,'SELECT * FROM universe_operations WHERE actor_id=? AND operation_id=?',identity.userId,body.operation_id).first();
  if(!old)return null;scope='tasks:'+gid+':'+scope;
  if(old.scope!==scope||old.request_hash!==await digest({scope,body}))throw err(409,'OPERATION_CONFLICT','This operation ID has different input.');
  return {...JSON.parse(old.result),replayed:true};
 }
 async taskData(db,gid,b){
  if(!['everyone','shared'].includes(b.mode))throw err(400,'INPUT','Choose Everyone’s or Shared.');
  if(b.ai_required)throw err(409,'AI_UNAVAILABLE','AI-required tasks will be available in Phase 4.');
  const reviewers=b.reviewer_roles??roles;
  if(!Array.isArray(reviewers)||!reviewers.length||reviewers.some(r=>!roles.includes(r)))throw err(400,'INPUT','Choose permitted reviewer roles.');
  const members=b.members;
  if(!Array.isArray(members)||!members.length||members.length>21||new Set(members).size!==members.length||members.some(m=>typeof m!=='string'))throw err(400,'INPUT','Select current members.');
  for(const id of members)if(!await this.statement(db,'SELECT 1 FROM universe_members m JOIN universe_accounts a ON a.account_id=m.account_id WHERE m.group_id=? AND m.account_id=? AND a.blocked=0',gid,id).first())throw err(400,'INPUT','An assignee is no longer a member.');
  for(const date of ['start_at','due_at'])if(b[date]!=null&&(!Number.isSafeInteger(b[date])||b[date]<0))throw err(400,'INPUT','Use valid dates.');
  if(b.start_at&&b.due_at&&b.start_at>b.due_at)throw err(400,'INPUT','Due date must follow start date.');
  return {title:this.text(b.title,200),criteria:this.text(b.criteria,4000),mode:b.mode,members,reviewer_roles:[...new Set(reviewers)],start_at:b.start_at??null,due_at:b.due_at??null,allow_late:b.allow_late===true,ai_required:false};
 }
 async handle(identity,path,method,b={}){
  const match=path.match(/^\/universe\/groups\/([A-Za-z0-9_-]{1,100})\/work(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?(?:\/([a-z]+))?$/);
  if(!match)return super.handle(identity,path,method,b);
  const db=await this.ready();await this.active(identity,db);if(!await this.phase3(db))throw err(503,'SCHEMA','Apply the Phase 3 migration first.');
  const [,gid,entity,id,action]=match;let g=await this.access(db,identity,gid,method!=='GET');
  if(method==='GET')return this.read(db,identity,g,entity,id);
  if(method!=='POST')throw err(405,'METHOD','Use GET or POST.');
  const scope=[entity,id,action].filter(Boolean).join(':');const replay=await this.replay(db,identity,gid,scope,b);if(replay)return replay;
  let writes=[],result={};const now=Date.now();
  if(entity==='projects'&&!id){
   this.input(b,['operation_id','title']);this.manager(g);const pid=uuid('project');
   writes=[this.statement(db,'INSERT INTO universe_projects VALUES(?,?,?,?)',pid,gid,this.text(b.title,200),now)];result={id:pid};
  }else if(entity==='tasks'&&(!id||action==='edit')){
   this.input(b,['operation_id','revision','project_id','title','criteria','mode','members','reviewer_roles','start_at','due_at','allow_late','ai_required']);this.manager(g);
   const data=await this.taskData(db,gid,b);await this.record(db,'universe_projects',b.project_id,gid);const tid=id||uuid('task');let revision=1;
   if(id){const t=await this.task(db,id,gid);this.checkRevision(t.revision,b.revision);revision=t.revision+1;
    writes.push(this.statement(db,'UPDATE universe_tasks SET project_id=?,revision=?,data=? WHERE id=?',b.project_id,revision,JSON.stringify(data),id),
     this.statement(db,"UPDATE universe_assignments SET state='cancelled',revision=revision+1 WHERE task_id=?",id),
     this.statement(db,"UPDATE universe_submissions SET decision=COALESCE(decision,'superseded'),retain_until=COALESCE(retain_until,?) WHERE assignment_id IN(SELECT id FROM universe_assignments WHERE task_id=?)",now+30*DAY,id),
     this.statement(db,"UPDATE universe_files SET expires_at=? WHERE task_id=? AND kind='reference' AND state='attached'",now+30*DAY,id));
   }else writes.push(this.statement(db,'INSERT INTO universe_tasks VALUES(?,?,?,?,?,?)',tid,gid,b.project_id,1,JSON.stringify(data),now));
   for(const account of(data.mode==='shared'?[null]:data.members))writes.push(this.statement(db,'INSERT INTO universe_assignments(id,group_id,task_id,account_id) VALUES(?,?,?,?)',uuid('assignment'),gid,tid,account));
   result={id:tid,revision};
  }else if(entity==='assignments'&&action==='submit'){
   this.input(b,['operation_id','revision','task_revision','text','files']);
   const a=await this.record(db,'universe_assignments',id,gid),t=await this.task(db,a.task_id,gid);this.submitter(g,a,identity);
   if(t.mode==='shared'&&!t.members.includes(identity.userId))throw err(403,'ROLE_DENIED','You are not selected for this Shared task.');
   this.checkRevision(a.revision,b.revision);this.checkRevision(t.revision,b.task_revision);
   if(!['open','rejected'].includes(a.state))throw err(409,'STATE','This assignment cannot accept a submission.');
   if(t.start_at&&now<t.start_at||t.due_at&&now>t.due_at&&!t.allow_late)throw err(409,'DATES','Submissions are closed for this task.');
   const text=this.text(b.text??'',8000,false),files=b.files??[];
   if(!Array.isArray(files)||files.length>3||new Set(files).size!==files.length||!text&&!files.length)throw err(400,'INPUT','Add text or up to three proof files.');
   const sid=uuid('submission');
   for(const fid of files){const f=await this.record(db,'universe_files',fid,gid);if(f.assignment_id!==id||f.actor_id!==identity.userId||f.kind!=='proof'||f.task_revision!==t.revision||f.state!=='uploaded'||f.expires_at<=now)throw err(409,'FILE','A proof upload is unavailable or stale.');
    writes.push(this.statement(db,"UPDATE universe_files SET state='attached',submission_id=?,expires_at=? WHERE id=?",sid,now+365*DAY,fid));}
   writes.push(this.statement(db,'INSERT INTO universe_submissions(id,group_id,assignment_id,actor_id,task_revision,data,created_at) VALUES(?,?,?,?,?,?,?)',sid,gid,id,identity.userId,t.revision,JSON.stringify({text,files,criteria:t.criteria,task_title:t.title}),now),this.statement(db,"UPDATE universe_assignments SET state='pending',revision=revision+1,submission_id=? WHERE id=?",sid,id));result={id:sid};
  }else if(entity==='assignments'&&['review','reopen','dispute'].includes(action)){
   this.input(b,['operation_id','revision','task_revision','decision','reason','open']);
   const a=await this.record(db,'universe_assignments',id,gid),t=await this.task(db,a.task_id,gid);this.checkRevision(a.revision,b.revision);this.checkRevision(t.revision,b.task_revision);
   if(!a.submission_id)throw err(409,'STATE','There is no submission.');const sub=await this.record(db,'universe_submissions',a.submission_id,gid);
   const reason=this.text(b.reason,2000);if(sub.task_revision!==t.revision||a.state==='cancelled')throw err(409,'REVISION','This submission is superseded.');
   if(action==='dispute'){
    if(b.open!==true&&b.open!==false)throw err(400,'INPUT','Choose whether to open or close the dispute.');
    if(b.open){if(sub.actor_id!==identity.userId&&!roles.includes(g.role))throw err(403,'ROLE_DENIED','Only the submitter or a reviewer can dispute.');}
    else this.reviewer(g,t);
    if(!sub.decision)throw err(409,'STATE','Only a decided submission can be disputed.');
    if(b.open&&(sub.retain_until??0)<=now)throw err(410,'EXPIRED','The dispute period has ended.');
    writes=[this.statement(db,'UPDATE universe_submissions SET disputed=?,retain_until=CASE WHEN ?=0 THEN ? ELSE retain_until END WHERE id=?',b.open?1:0,b.open?1:0,now+30*DAY,sub.id)];
   }else{
    this.reviewer(g,t);
    if(action==='review'){
     if(a.state!=='pending'||!['approved','rejected'].includes(b.decision))throw err(409,'STATE','Select approve or reject for a pending submission.');
     if(sub.actor_id===identity.userId)throw err(403,'SELF_REVIEW','Another reviewer must decide your submission.');
     writes.push(this.statement(db,'UPDATE universe_submissions SET decision=?,reviewer_id=?,reason=?,decided_at=?,retain_until=? WHERE id=?',b.decision,identity.userId,reason,now,now+30*DAY,sub.id),this.statement(db,'UPDATE universe_assignments SET state=?,revision=revision+1 WHERE id=?',b.decision,id));
    }else{
     if(!['approved','rejected'].includes(a.state))throw err(409,'STATE','Only a decided assignment can be reopened.');
     writes.push(this.statement(db,"UPDATE universe_assignments SET state='open',revision=revision+1,submission_id=NULL WHERE id=?",id));
    }
   }result={id,action};
   writes.push(this.event(db,gid,identity.userId,action+':'+reason,sub.id));
  }else if(entity==='files'&&!id){
   this.input(b,['operation_id','task_id','assignment_id','kind','name','mime','size','hash','task_revision']);this.bucket();
   const t=await this.task(db,b.task_id,gid);this.checkRevision(t.revision,b.task_revision);
   if(!mimeTypes.includes(b.mime)||!Number.isSafeInteger(b.size)||b.size<1||b.size>MAX||!/^([a-f0-9]{64})$/.test(b.hash??''))throw err(400,'FILE','Use PNG, JPEG, PDF or text up to 5 MiB, with a SHA-256 hash.');
   if(b.kind==='reference')this.manager(g);
   else if(b.kind==='proof'){const a=await this.record(db,'universe_assignments',b.assignment_id,gid);this.submitter(g,a,identity);if(a.task_id!==t.id||!['open','rejected'].includes(a.state)||t.mode==='shared'&&!t.members.includes(identity.userId))throw err(409,'STATE','This assignment cannot accept uploads.');}
   else throw err(400,'INPUT','Choose proof or reference.');
   const count=await this.statement(db,"SELECT count(*) n FROM universe_files WHERE actor_id=? AND state IN ('staged','uploaded') AND expires_at>?",identity.userId,now).first();if(count.n>=12)throw err(429,'UPLOAD_LIMIT','Finish pending uploads first.');
   const fid=uuid('file');writes=[this.statement(db,'INSERT INTO universe_files(id,group_id,task_id,assignment_id,actor_id,task_revision,kind,name,mime,size,hash,object_key,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',fid,gid,t.id,b.kind==='proof'?b.assignment_id:null,identity.userId,t.revision,b.kind,this.text(b.name,200),b.mime,b.size,b.hash,'universe/'+gid+'/'+fid,now+3600000,now)];result={id:fid};await this.service.ensureAlarm();
  }else if(entity==='files'&&action==='upload'){
   this.input(b,['operation_id','data']);const f=await this.record(db,'universe_files',id,gid),t=await this.task(db,f.task_id,gid);
   if(f.actor_id!==identity.userId||!['staged','uploaded'].includes(f.state)||f.expires_at<=now||f.task_revision!==t.revision)throw err(409,'FILE','This upload is unavailable or stale.');
   if(f.kind==='reference')this.manager(g);else{const a=await this.record(db,'universe_assignments',f.assignment_id,gid);this.submitter(g,a,identity);if(!['open','rejected'].includes(a.state)||t.mode==='shared'&&!t.members.includes(identity.userId))throw err(409,'STATE','This assignment cannot accept uploads.');}
   if(typeof b.data!=='string'||b.data.length>Math.ceil(MAX/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.data))throw err(400,'FILE','Invalid file encoding.');
   const bytes=Uint8Array.from(atob(b.data),x=>x.charCodeAt(0)),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
   if(bytes.length!==f.size||hash!==f.hash)throw err(400,'HASH','The uploaded bytes do not match the declared size and hash.');
   const signature=f.mime==='application/pdf'?new TextDecoder().decode(bytes.slice(0,5))==='%PDF-':f.mime==='image/png'?[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v):f.mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:true;
   if(!signature)throw err(400,'FILE','The file content does not match its type.');
   await this.bucket().put(f.object_key,bytes,{httpMetadata:{contentType:'application/octet-stream'}});
   // Recheck after R2: D1 membership/revision guards prevent finalization after deletion or edits.
   await this.access(db,identity,gid,true);
   const current=await this.record(db,'universe_files',id,gid);if(!['staged','uploaded'].includes(current.state)||current.expires_at<=Date.now())throw err(409,'FILE','This upload expired or was finalized.');
   this.checkRevision((await this.task(db,f.task_id,gid)).revision,f.task_revision);
   writes=[this.statement(db,"UPDATE universe_files SET state='uploaded' WHERE id=?",id)];result={id};
  }else if(entity==='files'&&action==='attach'){
   this.input(b,['operation_id','task_revision']);this.manager(g);const f=await this.record(db,'universe_files',id,gid),t=await this.task(db,f.task_id,gid);this.checkRevision(t.revision,b.task_revision);
   if(f.kind!=='reference'||f.state!=='uploaded'||f.actor_id!==identity.userId||f.task_revision!==t.revision||f.expires_at<=now)throw err(409,'FILE','Reference upload is unavailable.');
   writes=[this.statement(db,"UPDATE universe_files SET state='attached',expires_at=? WHERE id=?",now+3650*DAY,id),this.statement(db,'UPDATE universe_tasks SET revision=revision+1 WHERE id=?',t.id),this.statement(db,'UPDATE universe_files SET task_revision=? WHERE id=?',t.revision+1,id),this.statement(db,"UPDATE universe_assignments SET state=CASE WHEN state='cancelled' THEN state ELSE 'open' END,submission_id=NULL,revision=revision+1 WHERE task_id=?",t.id),this.statement(db,"UPDATE universe_submissions SET decision=COALESCE(decision,'superseded'),retain_until=COALESCE(retain_until,?) WHERE assignment_id IN(SELECT id FROM universe_assignments WHERE task_id=?)",now+30*DAY,t.id)];result={id};
   writes.push(this.statement(db,"UPDATE universe_files SET task_revision=? WHERE task_id=? AND task_revision=? AND kind='reference' AND state='attached'",t.revision+1,t.id,t.revision));
  }else throw err(404,'ENDPOINT','Unknown task action.');
  return this.commit(db,identity,g,scope,b,result,writes);
 }
 async read(db,identity,g,entity,id){
  if(!entity){const projects=(await this.statement(db,'SELECT * FROM universe_projects WHERE group_id=? ORDER BY created_at,id',g.id).all()).results;
   const tasks=(await this.statement(db,'SELECT * FROM universe_tasks WHERE group_id=? ORDER BY created_at,id LIMIT 500',g.id).all()).results.map(t=>({...t,...JSON.parse(t.data),data:undefined}));
   const assignments=(await this.statement(db,'SELECT * FROM universe_assignments WHERE group_id=? ORDER BY id LIMIT 2000',g.id).all()).results;return {projects,tasks,assignments};}
  if(entity==='assignments'&&id){const a=await this.record(db,'universe_assignments',id,g.id),t=await this.task(db,a.task_id,g.id);
   const privileged=roles.includes(g.role)&&t.reviewer_roles.includes(g.role);
   const submissions=(await this.statement(db,'SELECT * FROM universe_submissions WHERE assignment_id=? ORDER BY created_at DESC LIMIT 100',id).all()).results.filter(s=>privileged||s.actor_id===identity.userId).map(s=>({...s,...(s.retain_until&&s.retain_until<=Date.now()&&!s.disputed?{text:'Proof retention ended.',files:[]}:JSON.parse(s.data)),data:undefined}));
   const files=(await this.statement(db,"SELECT id,name,mime,size,kind,task_revision FROM universe_files WHERE task_id=? AND task_revision=? AND kind='reference' AND state='attached' AND expires_at>?",t.id,t.revision,Date.now()).all()).results;return {assignment:a,task:t,submissions,references:files};}
  if(entity==='files'&&id){const f=await this.record(db,'universe_files',id,g.id),t=await this.task(db,f.task_id,g.id);if(f.state!=='attached')throw err(404,'FILE','This file is unavailable.');
   if(f.kind==='proof'){const s=await this.record(db,'universe_submissions',f.submission_id,g.id);if(s.actor_id!==identity.userId)this.reviewer(g,t);if(s.retain_until&&s.retain_until<=Date.now()&&!s.disputed)throw err(410,'EXPIRED','Proof retention ended.');}
   else if(f.expires_at<=Date.now())throw err(410,'EXPIRED','Reference retention ended.');
   const obj=await this.bucket().get(f.object_key);if(!obj)throw err(410,'EXPIRED','File bytes are no longer available.');const bytes=new Uint8Array(await obj.arrayBuffer());
   const currentGroup=await this.access(db,identity,g.id);
   const currentFile=await this.record(db,'universe_files',id,g.id);if(currentFile.state!=='attached')throw err(410,'EXPIRED','File bytes are no longer available.');
   if(f.kind==='proof'){const sub=await this.record(db,'universe_submissions',f.submission_id,g.id);if(sub.actor_id!==identity.userId)this.reviewer(currentGroup,await this.task(db,f.task_id,g.id));if(sub.retain_until&&sub.retain_until<=Date.now()&&!sub.disputed)throw err(410,'EXPIRED','Proof retention ended.');}
   let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return {name:f.name,mime:f.mime,data:btoa(raw)};
  }throw err(404,'ENDPOINT','Unknown task view.');
 }
 async cleanup(){
  const more=await super.cleanup(),db=this.database();if(!db||!await this.phase3(db)||!this.env.TASKITATOR_EVIDENCE)return more;
  const now=Date.now();
  const rows=(await this.statement(db,`SELECT f.* FROM universe_files f LEFT JOIN universe_submissions s ON s.id=f.submission_id
   WHERE f.cleaned_at IS NULL AND (f.state='deleted' OR (f.state IN ('staged','uploaded') AND f.expires_at<=?) OR
   (f.kind='reference' AND f.expires_at<=?) OR (s.retain_until<=? AND s.disputed=0) OR
   EXISTS(SELECT 1 FROM universe_group_state WHERE group_id=f.group_id AND deleted=1) OR
   EXISTS(SELECT 1 FROM universe_accounts WHERE account_id=f.actor_id AND blocked=1)) LIMIT 50`,now,now,now).all()).results;
  for(const f of rows){await this.statement(db,"UPDATE universe_files SET state='deleted' WHERE id=?",f.id).run();await this.bucket().delete(f.object_key);
   // A full day exceeds the upload deadline and leaves room for an in-flight R2 write to settle.
   if(f.expires_at<now-DAY||f.created_at<now-DAY)await this.statement(db,'UPDATE universe_files SET cleaned_at=? WHERE id=?',now,f.id).run();}
  await this.statement(db,"UPDATE universe_submissions SET data='{}' WHERE retain_until<=? AND disputed=0",now).run();
  return more||rows.length===50;
 }
}

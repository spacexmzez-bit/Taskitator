import { UniverseAI } from './universe-ai.js';
import { fail, digest } from '../pro-backend.js';
const DAY=86400000,MiB=1048576;
const err=(s,c,m)=>fail(s,'UNIVERSE_'+c,m);
const uid=p=>p+'_'+crypto.randomUUID();
export const bytesHash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export const encode=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const decode=s=>{if(typeof s!=='string'||s.length>7*MiB||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw err(400,'FILE','Invalid attachment encoding.');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
export class UniverseRelease extends UniverseAI {
 async phase5(db=this.database()){try{return !!await db.prepare('SELECT version FROM universe_phase5 WHERE version=5').first();}catch{return false;}}
 async availability(){const a=await super.availability(),ready=a.capabilities.universe_ai&&await this.phase5();return {...a,version:ready?5:a.version,schema_version:ready?5:a.schema_version,capabilities:{...a.capabilities,locking:ready,discussion:ready,portability:ready}};}
 async epoch(db,gid,actor){return (await this.statement(db,'SELECT epoch FROM universe_member_epochs WHERE group_id=? AND account_id=?',gid,actor).first())?.epoch;}
 async lockStatus(actor,now=Date.now()){
  if(this.env.UNIVERSE_FOUNDATION_ENABLED!=='true')return {locked:false,degraded:false};
  try{
   const db=this.database();if(!await this.phase5(db))return {locked:false,degraded:true};
   const groups=(await this.statement(db,`SELECT DISTINCT g.id,g.owner_id FROM universe_groups g JOIN universe_members m ON m.group_id=g.id JOIN universe_lock_consent c ON c.group_id=g.id AND c.account_id=m.account_id JOIN universe_member_epochs e ON e.group_id=m.group_id AND e.account_id=m.account_id JOIN universe_accounts a ON a.account_id=m.account_id JOIN universe_accounts o ON o.account_id=g.owner_id LEFT JOIN universe_group_state s ON s.group_id=g.id WHERE m.account_id=? AND c.enabled=1 AND c.epoch=e.epoch AND a.blocked=0 AND o.blocked=0 AND COALESCE(s.deleted,0)=0`,actor).all()).results;
   let count=0,degraded=false;
   for(const g of groups){const life=await this.lifecycle(db,g.owner_id);if(life.entitlement_unavailable){degraded=true;continue;}if(life.read_only)continue;
    const rows=(await this.statement(db,`SELECT a.*,t.data,t.revision task_revision,l.task_revision eligible_revision,l.assignment_revision eligible_assignment_revision,l.notice_at,l.accepted_epoch,e.epoch FROM universe_assignments a JOIN universe_tasks t ON t.id=a.task_id JOIN universe_lock_eligibility l ON l.assignment_id=a.id JOIN universe_member_epochs e ON e.group_id=a.group_id AND e.account_id=a.account_id WHERE a.group_id=? AND a.account_id=? AND a.state IN ('open','rejected') AND l.eligible=1 AND l.assignee_epoch=e.epoch`,g.id,actor).all()).results;
    for(const a of rows){const t=JSON.parse(a.data);if(t.mode!=='everyone'||a.task_revision!==a.eligible_revision||a.revision!==a.eligible_assignment_revision||!t.due_at||now<t.due_at||t.start_at&&now<t.start_at||now<a.notice_at&&a.accepted_epoch!==a.epoch)continue;count++;}
   }return {locked:count>0,count,degraded};
  }catch{return {locked:false,degraded:true};}
 }
 async handle(identity,path,method,b={}){
  const archive=path.match(/^\/universe\/groups\/([A-Za-z0-9_-]+)\/archive(?:\/([A-Za-z0-9_-]+))?(?:\/(file))?$/);
  if(archive){const db=await this.ready();await this.active(identity,db);if(!await this.phase5(db))throw err(503,'SCHEMA','Apply Phase 5 SQL first.');const g=await this.access(db,identity,archive[1]);this.manager(g);
   if(!archive[2]&&method==='GET')return {archives:(await this.statement(db,"SELECT id,created_at FROM universe_transfers WHERE group_id=? AND kind='import' AND state='done'",g.id).all()).results};
   const r=await this.statement(db,"SELECT * FROM universe_transfers WHERE id=? AND group_id=? AND kind='import' AND state='done'",archive[2],g.id).first();if(!r)throw err(404,'ARCHIVE','Imported history is unavailable.');
   const manifest=await this.manifest(r);manifest.files=manifest.files.filter(f=>f.kind!=='proof'||Date.now()<Math.min(f.expires_at||r.created_at+30*DAY,r.created_at+30*DAY));if(manifest.history?.submissions)manifest.history.submissions=manifest.history.submissions.filter(s=>!s.retain_until||s.disputed||s.retain_until>Date.now());if(!archive[3]&&method==='GET')return {manifest};
   if(archive[3]==='file'&&method==='POST'){this.input(b,['operation_id','file_id']);const f=await this.statement(db,'SELECT * FROM universe_transfer_files WHERE transfer_id=? AND file_id=? AND uploaded=1',r.id,b.file_id).first(),meta=manifest.files.find(f=>f.id===b.file_id);if(!f||!meta)throw err(404,'FILE','Unknown historical attachment.');if(meta.kind==='proof'&&Date.now()>r.created_at+30*DAY)throw err(410,'EXPIRED','Imported proof retention ended.');const obj=await this.bucket().get(f.object_key);if(!obj)throw err(410,'FILE','Historical attachment expired.');const bytes=new Uint8Array(await obj.arrayBuffer());if(await bytesHash(bytes)!==f.hash)throw err(409,'HASH','Historical attachment integrity failed.');this.manager(await this.access(db,identity,g.id));return {data:encode(bytes)};}
   throw err(405,'METHOD','Unsupported archive action.');
  }
  const m=path.match(/^\/universe\/groups\/([A-Za-z0-9_-]+)\/(consent|locks|discussion|transfer)(?:\/([A-Za-z0-9_-]+))?(?:\/(edit|moderate|accept|file|cancel|finish))?$/);
  const imports=path.match(/^\/universe\/imports(?:\/([A-Za-z0-9_-]+))?(?:\/(file|finish|cancel))?$/);
  if(!m&&!imports)return super.handle(identity,path,method,b);
  const db=await this.ready();await this.active(identity,db);if(!await this.phase5(db))throw err(503,'SCHEMA','Apply the Phase 5 SQL first.');
  if(imports)return this.importRoute(db,identity,imports[1],imports[2],method,b);
  const [,gid,kind,id,action]=m,g=await this.access(db,identity,gid,false);
  if(method==='GET'){
   if(kind==='consent')return {consent:await this.statement(db,'SELECT * FROM universe_lock_consent WHERE group_id=? AND account_id=?',gid,identity.userId).first(),epoch:await this.epoch(db,gid,identity.userId)};
   if(kind==='locks')return {assignments:(await this.statement(db,`SELECT a.id,a.account_id,a.state,a.revision,t.revision task_revision,t.data,l.eligible,l.notice_at,l.accepted_epoch,l.assignment_revision eligible_assignment_revision,l.task_revision eligible_revision FROM universe_assignments a JOIN universe_tasks t ON t.id=a.task_id LEFT JOIN universe_lock_eligibility l ON l.assignment_id=a.id WHERE a.group_id=? AND a.state<>'cancelled' AND a.account_id IS NOT NULL ${['owner','admin'].includes(g.role)?'':'AND a.account_id=?'} ORDER BY a.id`,gid,...(['owner','admin'].includes(g.role)?[]:[identity.userId])).all()).results};
   if(kind==='discussion')return this.comments(db,g,id);
   if(kind==='transfer'&&id)return this.exportRead(db,identity,g,id,action,b);
   throw err(404,'ENDPOINT','Unknown action.');
  }
  if(method!=='POST')throw err(405,'METHOD','Use GET or POST.');
  if(kind==='transfer')return this.exportRoute(db,identity,g,id,action,b);
  if(kind==='consent'){
   this.input(b,['operation_id','enabled']);if(typeof b.enabled!=='boolean')throw err(400,'INPUT','Choose whether to consent.');if(b.enabled)this.writable(g);
   const epoch=await this.epoch(db,gid,identity.userId);
   return this.mutate(db,identity,'consent:'+gid,b,{enabled:b.enabled},[this.guard(db,identity,gid,g.revision,'EXISTS(SELECT 1 FROM universe_member_epochs e WHERE e.group_id=g.id AND e.account_id=m.account_id AND e.epoch=?)',[epoch],b.enabled),this.statement(db,'INSERT INTO universe_lock_consent VALUES(?,?,?,?,?) ON CONFLICT(group_id,account_id) DO UPDATE SET epoch=excluded.epoch,enabled=excluded.enabled,updated_at=excluded.updated_at',gid,identity.userId,epoch,b.enabled?1:0,Date.now()),this.event(db,gid,identity.userId,b.enabled?'lock_consent':'lock_withdrawn',gid)]);
  }
  this.writable(g);
  if(kind==='locks'){
   this.input(b,['operation_id','eligible','revision','task_revision']);const a=await this.record(db,'universe_assignments',id,gid),t=await this.task(db,a.task_id,gid);this.checkRevision(a.revision,b.revision);this.checkRevision(t.revision,b.task_revision);
   const effectiveDue=t.due_at||(typeof this.ancestors==='function'?(await this.ancestors(db,t)).find(p=>p.due_at)?.due_at:null);if(t.mode!=='everyone'||!effectiveDue||!['open','rejected'].includes(a.state))throw err(409,'LOCK','Only open individual assignments with a deadline can affect locking.');
   if(action==='accept'){
    if(a.account_id!==identity.userId)throw err(403,'ROLE','Only the assigned member may accept shorter notice.');const l=await this.recordLock(db,id);if(!l?.eligible||l.task_revision!==t.revision||l.assignment_revision!==a.revision)throw err(409,'REVISION','Refresh lock eligibility first.');
    const c=await this.statement(db,'SELECT * FROM universe_lock_consent WHERE group_id=? AND account_id=?',gid,identity.userId).first(),epoch=await this.epoch(db,gid,identity.userId);if(!c?.enabled||c.epoch!==epoch)throw err(409,'CONSENT','Consent to Universe phone blocking first.');
    return this.commit(db,identity,g,'lock_accept:'+id,b,{id},[this.statement(db,'UPDATE universe_lock_eligibility SET accepted_epoch=? WHERE assignment_id=?',epoch,id)]);
   }
   this.manager(g);if(typeof b.eligible!=='boolean')throw err(400,'INPUT','Choose eligibility.');
   const n=await this.statement(db,`SELECT count(*) n FROM universe_lock_eligibility l JOIN universe_assignments a ON a.id=l.assignment_id JOIN universe_tasks t ON t.id=a.task_id WHERE a.group_id=? AND a.account_id=? AND a.id<>? AND a.state IN ('open','rejected') AND l.eligible=1 AND l.task_revision=t.revision AND l.assignment_revision=a.revision`,gid,a.account_id,id).first();
   if(b.eligible&&n.n>=3)throw err(409,'LOCK_CAP','This member already has three eligible assignments in this Universe.');
   return this.commit(db,identity,g,'lock_eligibility:'+id,b,{id},[this.statement(db,'INSERT INTO universe_lock_eligibility VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(assignment_id) DO UPDATE SET task_revision=excluded.task_revision,assignment_revision=excluded.assignment_revision,eligible=excluded.eligible,notice_at=excluded.notice_at,accepted_epoch=NULL,created_at=excluded.created_at,assignee_epoch=excluded.assignee_epoch',id,gid,t.revision,a.revision,b.eligible?1:0,Date.now()+DAY,Date.now(),await this.epoch(db,gid,a.account_id))]);
  }
  if(kind==='discussion')return this.commentWrite(db,identity,g,id,action,b);
 }
 async recordLock(db,id){return this.statement(db,'SELECT * FROM universe_lock_eligibility WHERE assignment_id=?',id).first();}
 async comments(db,g,cursor){
  let before=null;if(cursor)before=await this.record(db,'universe_comments',cursor,g.id);
  const rows=(await this.statement(db,`SELECT * FROM universe_comments WHERE group_id=? ${before?'AND (created_at<? OR (created_at=? AND id<?))':''} ORDER BY created_at DESC,id DESC LIMIT 51`,g.id,...(before?[before.created_at,before.created_at,before.id]:[])).all()).results;
  return {comments:rows.slice(0,50).map(c=>({...c,body:c.hidden?'[Removed by moderation]':c.body})),next:rows.length>50?rows[49].id:null};
 }
 async commentWrite(db,identity,g,id,action,b){
  this.input(b,['operation_id','body','task_id','parent_id','revision','reason']);const now=Date.now();let writes=[],result={id:id||'comment_'+b.operation_id};
  if(!id){if(b.task_id)await this.task(db,b.task_id,g.id);if(b.parent_id){const p=await this.record(db,'universe_comments',b.parent_id,g.id);if((p.task_id||null)!==(b.task_id||null))throw err(400,'THREAD','Reply must stay in the same discussion.');}writes.push(this.statement(db,'INSERT INTO universe_comments(id,group_id,task_id,parent_id,actor_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',result.id,g.id,b.task_id||null,b.parent_id||null,identity.userId,this.text(b.body,4000),now,now));}
  else {const c=await this.record(db,'universe_comments',id,g.id);this.checkRevision(c.revision,b.revision);
   if(action==='edit'){if(c.actor_id!==identity.userId||c.hidden)throw err(403,'ROLE','Only the author may edit a visible comment.');writes.push(this.statement(db,'UPDATE universe_comments SET body=?,revision=revision+1,updated_at=? WHERE id=?',this.text(b.body,4000),now,id));}
   else if(action==='moderate'){this.manager(g);writes.push(this.statement(db,'UPDATE universe_comments SET hidden=1,body=?,reason=?,revision=revision+1,updated_at=? WHERE id=?','',this.text(b.reason,2000),now,id));}
   else throw err(404,'ENDPOINT','Unknown discussion action.');
  }return this.commit(db,identity,g,'discussion:'+result.id+':'+(action||'post'),b,result,writes);
 }
 async transfer(db,identity,id,kind){const r=await this.statement(db,'SELECT * FROM universe_transfers WHERE id=? AND actor_id=? AND kind=?',id,identity.userId,kind).first();if(!r||r.state==='cancelled'||r.expires_at<=Date.now())throw err(410,'TRANSFER','This transfer expired or was cancelled.');return r;}
 async manifest(r){const obj=await this.bucket().get(r.manifest_key);if(!obj)throw err(410,'TRANSFER','Transfer content is unavailable.');return JSON.parse(new TextDecoder().decode(await obj.arrayBuffer()));}
 async exportRoute(db,identity,g,id,action,b){
  if(action==='file')return this.exportFile(db,identity,g,id,b);
  this.input(b,['operation_id','full','file_id','allowed']);
  if(id){const f=await this.record(db,'universe_files',id,g.id);if(f.kind!=='proof'||f.actor_id!==identity.userId||typeof b.allowed!=='boolean')throw err(403,'EXPORT','Only the proof author may grant export permission.');if(b.allowed)this.writable(g);return this.mutate(db,identity,'export_permission:'+g.id+':'+id,b,{id},[this.guard(db,identity,g.id,g.revision,'1=1',[],b.allowed),this.statement(db,'UPDATE universe_groups SET revision=revision+1 WHERE id=?',g.id),this.statement(db,'INSERT INTO universe_export_permissions VALUES(?,?,?) ON CONFLICT(file_id) DO UPDATE SET allowed=excluded.allowed',id,identity.userId,b.allowed?1:0)]);}
  this.manager(g);const old=await this.statement(db,"SELECT * FROM universe_transfers WHERE actor_id=? AND id=? AND kind='export'",identity.userId,b.operation_id).first();if(old){if(old.group_id!==g.id)throw err(409,'TRANSFER','Use a fresh operation ID.');return {id:old.id};}
  // D1 batch reads share one consistent transaction; never silently truncate a backup.
  const tables=['universe_projects','universe_tasks','universe_assignments','universe_submissions','universe_comments','universe_events'];
  const batch=await db.batch(tables.map(table=>this.statement(db,`SELECT * FROM ${table} WHERE group_id=? ORDER BY ${table==='universe_events'?'created_at,id':'id'}`,g.id)));
  const [projects,tasks,assignments,submissions,comments,events]=batch.map(r=>r.results);
  const files=b.full?(await this.statement(db,`SELECT f.* FROM universe_files f LEFT JOIN universe_export_permissions p ON p.file_id=f.id WHERE f.group_id=? AND f.state='attached' AND f.expires_at>? AND (f.kind='reference' OR f.actor_id=? OR p.allowed=1)`,g.id,Date.now(),identity.userId).all()).results:[];
  const allowedFiles=[];for(const f of files){if(f.kind==='proof'){const s=submissions.find(s=>s.id===f.submission_id);if(!s||s.retain_until&&s.retain_until<=Date.now()&&!s.disputed)continue;f.expires_at=Math.min(f.expires_at,s.disputed?f.expires_at:s.retain_until||f.expires_at);}allowedFiles.push(f);}
  const rules=typeof this.exportMetadata==='function'&&await this.phase67(db)?await this.exportMetadata(db,g):null;
  const manifest={...(rules?{rules}:{}),format:'taskitator-universe',version:1,created_at:Date.now(),group:{title:g.title,purpose:g.purpose},projects,tasks,history:b.full?{assignments,submissions:submissions.filter(s=>s.actor_id===identity.userId&&(!s.retain_until||s.retain_until>Date.now()||s.disputed)).map(s=>({...s,data:JSON.stringify({...JSON.parse(s.data),files:(JSON.parse(s.data).files||[]).filter(id=>allowedFiles.some(f=>f.id===id))})})),comments:comments.map(c=>({...c,body:c.hidden?'[Removed]':c.body})),events}:null,files:allowedFiles.map(({id,name,mime,size,hash,kind,task_id,task_revision,submission_id,expires_at})=>({id,name,mime,size,hash,kind,task_id,task_revision,submission_id,expires_at})),exclusions:['Memberships, lock consent, credentials and balances are never exported.','Other members’ proof text is excluded; proof attachments need the author’s explicit export permission.','Expired, unavailable and unpermitted files are excluded.']};
  const bytes=new TextEncoder().encode(JSON.stringify(manifest));if(bytes.length>20*MiB||bytes.length+allowedFiles.reduce((s,f)=>s+f.size,0)>100*MiB)throw err(413,'EXPORT','Export exceeds the 100 MiB decoded limit or 20 MiB manifest limit.');
  const key='universe-transfers/'+identity.userId+'/'+b.operation_id+'/manifest_'+crypto.randomUUID();await this.service.ensureAlarm();await this.bucket().put(key,bytes);try{await this.access(db,identity,g.id);const current=await this.statement(db,'SELECT revision FROM universe_groups WHERE id=?',g.id).first();if(current.revision!==g.revision)throw err(409,'REVISION','Universe changed during export. Start again.');
  await db.batch([this.guard(db,identity,g.id,g.revision,"m.role IN ('owner','admin')",[],false),this.statement(db,"INSERT INTO universe_transfers VALUES(?,?,'export',?,?,NULL,'staged',?,?,?,NULL)",b.operation_id,identity.userId,g.id,g.revision,key,Date.now(),Date.now()+3600000)]);}catch(e){await this.bucket().delete(key);throw e;}return {id:b.operation_id};
 }
 async exportRead(db,identity,g,id){const r=await this.transfer(db,identity,id,'export');this.manager(g);if(r.group_id!==g.id||r.revision!==g.revision)throw err(409,'REVISION','Universe changed. Restart the export.');return {manifest:await this.manifest(r)};}
 async exportFile(db,identity,g,id,b){this.input(b,['operation_id','file_id']);const {manifest}=await this.exportRead(db,identity,g,id);if(!manifest.files.some(f=>f.id===b.file_id))throw err(403,'EXPORT','Attachment is outside this export.');const f=await this.record(db,'universe_files',b.file_id,g.id);
  if(f.kind==='proof'&&f.actor_id!==identity.userId&&!(await this.statement(db,'SELECT 1 FROM universe_export_permissions WHERE file_id=? AND allowed=1',f.id).first()))throw err(403,'EXPORT','The author has withdrawn export permission.');
  const result=await super.read(db,identity,g,'files',f.id);await this.exportRead(db,identity,await this.access(db,identity,g.id),id);return result;
 }
 async importRoute(db,identity,id,action,method,b){
  if(method==='GET'){const r=await this.transfer(db,identity,id,'import');return {id:r.id,state:r.state,result:r.result?JSON.parse(r.result):null,files:(await this.statement(db,'SELECT file_id,uploaded FROM universe_transfer_files WHERE transfer_id=?',id).all()).results};}
  if(method!=='POST')throw err(405,'METHOD','Use GET or POST.');this.operation(b);
  if(!id){this.input(b,['operation_id','manifest']);const old=await this.statement(db,"SELECT * FROM universe_transfers WHERE id=? AND actor_id=? AND kind='import'",b.operation_id,identity.userId).first();if(old)return {id:old.id};
   if(!await this.entitlement(identity))throw err(403,'PRO_REQUIRED','Active Pro is required to import.');await this.project(db,identity,true);const m=this.validateManifest(b.manifest),rid=uid('reservation'),key='universe-transfers/'+identity.userId+'/'+b.operation_id+'/manifest_'+crypto.randomUUID(),now=Date.now();
   await this.service.ensureAlarm();await this.bucket().put(key,JSON.stringify(m));try{await db.batch([this.statement(db,'INSERT INTO universe_reservations VALUES(?,?,?,?)',rid,identity.userId,now+3599000,now),this.statement(db,"INSERT INTO universe_transfers VALUES(?,?,'import',NULL,NULL,?,'staged',?,?,?,NULL)",b.operation_id,identity.userId,rid,key,now,now+3599000),...m.files.map(f=>this.statement(db,'INSERT INTO universe_transfer_files VALUES(?,?,?,?,?,0,?)',b.operation_id,f.id,'universe-transfers/'+identity.userId+'/'+b.operation_id+'/'+f.id,f.size,f.hash,f.kind==='proof'?Math.min(f.expires_at,now+30*DAY):now+3650*DAY))]);}catch(e){await this.bucket().delete(key);throw e;}return {id:b.operation_id};
  }
  const r=await this.transfer(db,identity,id,'import');if(r.state==='done')return JSON.parse(r.result);
  if(action==='cancel'){this.input(b,['operation_id']);await db.batch([this.statement(db,"UPDATE universe_transfers SET state='cancelled' WHERE id=?",id),this.statement(db,'DELETE FROM universe_reservations WHERE id=?',r.reservation_id)]);return {cancelled:true};}
  if(action==='file'){this.input(b,['operation_id','file_id','data']);const f=await this.statement(db,'SELECT * FROM universe_transfer_files WHERE transfer_id=? AND file_id=?',id,b.file_id).first();if(!f)throw err(400,'FILE','Unknown import attachment.');const bytes=decode(b.data);if(bytes.length!==f.size||await bytesHash(bytes)!==f.hash)throw err(400,'HASH','Attachment size or hash does not match.');await this.bucket().put(f.object_key,bytes);await this.active(identity,db);await this.statement(db,"UPDATE universe_transfer_files SET uploaded=1 WHERE transfer_id=? AND file_id=? AND EXISTS(SELECT 1 FROM universe_transfers WHERE id=? AND state='staged' AND expires_at>?)",id,f.file_id,id,Date.now()).run();return {uploaded:true};}
  if(action!=='finish')throw err(404,'ENDPOINT','Unknown import action.');this.input(b,['operation_id']);if(!await this.entitlement(identity))throw err(403,'PRO_REQUIRED','Active Pro is required to finish import.');const m=this.validateManifest(await this.manifest(r)),files=(await this.statement(db,'SELECT * FROM universe_transfer_files WHERE transfer_id=?',id).all()).results;if(files.some(f=>!f.uploaded))throw err(409,'FILES','Upload all matching attachments first.');
  const gid=uid('group'),map=new Map(m.projects.map(p=>[p.id,uid('project')])),now=Date.now(),result={group_id:gid};const writes=[this.statement(db,'INSERT OR REPLACE INTO universe_write_guard VALUES(1,EXISTS(SELECT 1 FROM universe_transfers t JOIN universe_reservations r ON r.id=t.reservation_id WHERE t.id=? AND t.actor_id=? AND t.state=\'staged\' AND t.expires_at>? AND r.expires_at>?))',id,identity.userId,now,now),this.statement(db,'DELETE FROM universe_reservations WHERE id=?',r.reservation_id),this.statement(db,'INSERT INTO universe_groups VALUES(?,?,?,?,1,?)',gid,identity.userId,m.group.title,m.group.purpose,now)];
  for(const p of m.projects)writes.push(this.statement(db,'INSERT INTO universe_projects VALUES(?,?,?,?)',map.get(p.id),gid,p.title,now));
  const taskMap=new Map();for(const t of m.tasks){const tid=uid('task');taskMap.set(t.id,tid);const d=JSON.parse(t.data);writes.push(this.statement(db,'INSERT INTO universe_tasks VALUES(?,?,?,?,?,?)',tid,gid,map.get(t.project_id),1,JSON.stringify({...d,members:[identity.userId],reviewer_roles:['owner','admin','reviewer'],start_at:null,due_at:null,ai_required:false,human_required:true}),now),this.statement(db,'INSERT INTO universe_assignments(id,group_id,task_id,account_id) VALUES(?,?,?,?)',uid('assignment'),gid,tid,identity.userId));}
  // Uploaded historical evidence stays separate from live completion and consent.
  writes.push(this.statement(db,"UPDATE universe_transfers SET state='done',group_id=?,result=? WHERE id=?",gid,JSON.stringify(result),id),this.event(db,gid,identity.userId,'import',id));
  for(const f of m.files.filter(f=>f.kind==='reference')){const tid=taskMap.get(f.task_id),stored=files.find(x=>x.file_id===f.id);if(tid)writes.push(this.statement(db,"INSERT INTO universe_files(id,group_id,task_id,actor_id,task_revision,kind,name,mime,size,hash,object_key,state,expires_at,created_at) VALUES(?,?,?,?,1,'reference',?,?,?,?,?,'attached',?,?)",uid('file'),gid,tid,identity.userId,f.name,f.mime,f.size,f.hash,stored.object_key,now+3650*DAY,now));}
  await db.batch(writes);return result;
 }
 validateManifest(m){
  if(!m||m.format!=='taskitator-universe'||m.version!==1||!m.group||!Array.isArray(m.projects)||!Array.isArray(m.tasks)||!Array.isArray(m.files))throw err(400,'IMPORT','Unsupported Universe backup.');
  // Bound statements, decoded bytes and object depth before any staging writes.
  const encodedManifest=JSON.stringify(m);if(new TextEncoder().encode(encodedManifest).length>20*MiB||m.projects.length>100||m.tasks.length>200||m.files.length>1000)throw err(413,'IMPORT','Backup exceeds import limits (20 MiB manifest, 100 projects, 200 tasks, 1,000 files).');
  this.text(m.group.title,120);this.text(m.group.purpose,2000,false);const ids=new Set();for(const p of [...m.projects,...m.tasks,...m.files]){if(typeof p.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(p.id)||ids.has(p.id))throw err(400,'IMPORT','Invalid or duplicate backup ID.');ids.add(p.id);}
  for(const p of m.projects)this.text(p.title,200);
  for(const t of m.tasks){if(!m.projects.some(p=>p.id===t.project_id))throw err(400,'IMPORT','Task points to a missing project.');let d;try{d=JSON.parse(t.data);}catch{throw err(400,'IMPORT','Invalid task data.');}this.text(d.title,200);this.text(d.criteria??'',4000,false);if(!['everyone','shared'].includes(d.mode))throw err(400,'IMPORT','Invalid task type.');}
  let size=new TextEncoder().encode(JSON.stringify(m)).length;for(const f of m.files){if(!Number.isSafeInteger(f.size)||f.size<1||f.size>5*MiB||!/^[a-f0-9]{64}$/.test(f.hash)||!['reference','proof'].includes(f.kind)||!m.tasks.some(t=>t.id===f.task_id)||!['image/png','image/jpeg','application/pdf','text/plain'].includes(f.mime))throw err(400,'IMPORT','Invalid attachment manifest.');this.text(f.name,200);size+=f.size;}if(size>100*MiB)throw err(413,'IMPORT','Decoded backup exceeds 100 MiB.');
  // Historical participants are inert records. Never interpret imported credentials, roles or state.
  return {format:m.format,version:1,group:{title:m.group.title,purpose:m.group.purpose},projects:m.projects.map(p=>({id:p.id,title:p.title})),tasks:m.tasks.map(t=>({id:t.id,project_id:t.project_id,data:JSON.stringify({title:JSON.parse(t.data).title,criteria:JSON.parse(t.data).criteria,mode:JSON.parse(t.data).mode})})),files:m.files.map(f=>({id:f.id,name:f.name,mime:f.mime,size:f.size,hash:f.hash,kind:f.kind,task_id:f.task_id,expires_at:Number.isSafeInteger(f.expires_at)?f.expires_at:Date.now()+2592000000})),history:m.history??null};
 }
 async cleanup(){let more=await super.cleanup();const db=this.database();if(!db||!await this.phase5(db))return more;
  const jobs=(await this.statement(db,"SELECT * FROM universe_transfers WHERE (expires_at<? OR state='cancelled') AND NOT(kind='import' AND state='done' AND COALESCE(json_extract(result,'$.overwrite'),0)=0) LIMIT 5",Date.now()).all()).results;
  for(const r of jobs){const files=(await this.statement(db,'SELECT object_key FROM universe_transfer_files WHERE transfer_id=?',r.id).all()).results;for(const f of files)await this.bucket().delete(f.object_key);await this.bucket().delete(r.manifest_key);await db.batch([this.statement(db,'DELETE FROM universe_transfer_files WHERE transfer_id=?',r.id),this.statement(db,'DELETE FROM universe_transfers WHERE id=?',r.id),this.statement(db,'DELETE FROM universe_reservations WHERE id=?',r.reservation_id)]);}
  // Imported history is removed when its Universe/account is deleted, too.
  const gone=(await db.prepare("SELECT t.* FROM universe_transfers t JOIN universe_group_state s ON s.group_id=t.group_id WHERE t.kind='import' AND t.state='done' AND s.deleted=1 LIMIT 5").all()).results;
  for(const r of gone){await this.statement(db,"UPDATE universe_transfers SET state='cancelled' WHERE id=?",r.id).run();more=true;}
  const expired=(await this.statement(db,"SELECT f.* FROM universe_transfer_files f JOIN universe_transfers t ON t.id=f.transfer_id WHERE t.kind='import' AND t.state='done' AND f.uploaded=1 AND f.expires_at<=? LIMIT 50",Date.now()).all()).results;
  for(const f of expired){await this.bucket().delete(f.object_key);await this.statement(db,'UPDATE universe_transfer_files SET uploaded=0 WHERE transfer_id=? AND file_id=?',f.transfer_id,f.file_id).run();}
  if(expired.length===50)more=true;
  await db.prepare("UPDATE universe_comments SET body='',reason=NULL WHERE group_id IN(SELECT group_id FROM universe_group_state WHERE deleted=1) AND (body<>'' OR reason IS NOT NULL)").run();
  return more||jobs.length===5;
 }
}

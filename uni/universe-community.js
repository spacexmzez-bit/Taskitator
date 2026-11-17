// Universe Community (Space plan Phase 3): a feed of admin posts with comments, in its own tab.
// Posts and comments do not raise the Universe revision, so a busy thread never makes task edits stale and never
// triggers the 15-second view refresh. Every write is still replay-safe (operation_id) and role-checked at commit time.
import { UniverseRules } from './universe-rules.js';
import { fail } from '../pro-backend.js';
const error=(status,code,message)=>fail(status,'UNIVERSE_'+code,message);
const uuid=prefix=>prefix+'_'+crypto.randomUUID();
export const PAGE=5, COMMENT_PAGE=50, EDIT_WINDOW=30*60000;
export const MiB=1048576, FILE_MAX=5*MiB, POST_MAX=8*MiB, STAGED_MAX=12, RIYADH=3*3600000, DAY=86400000;
// Images display in the post; other files are only ever downloaded (the app saves them, it never opens them in the page).
export const CONTEXT_QUOTA=200*MiB, CONTEXT_FILE_MAX=10*MiB, RETENTION=90*DAY;
export const IMAGE_TYPES=['image/png','image/jpeg','image/webp'];
export const FILE_TYPES=['application/pdf','text/plain','text/csv','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'];
const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
const decode=data=>{if(typeof data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw error(400,'FILE','Send the file as base64.');const raw=atob(data),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;};
const encode=bytes=>{let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw);};
// End of a Riyadh calendar day (23:59), as a timestamp.
export const endOfDay=iso=>{const [y,m,d]=iso.split('-').map(Number);return Date.UTC(y,m-1,d,23,59)-RIYADH;};
const riyadhDay=ms=>new Date(ms+RIYADH).toISOString().slice(0,10);

const COMMENT_ROLES=['member','reviewer'];
const MANAGERS=['owner','admin'];
const json=(text,fallback)=>{try{const v=JSON.parse(text);return Array.isArray(v)?v:fallback;}catch{return fallback;}};

// The class is built on first use: worker.js and universe-rules.js import each other through pro-backend.js, so
// extending UniverseRules while this module is first evaluated could run before UniverseRules exists.
let built=null;export const universeCommunity=()=>built??=communityFor(UniverseRules);
export function communityFor(Base){return class UniverseCommunity extends Base {
 async phase11(db=this.database()){try{return !!await db.prepare('SELECT version FROM universe_phase11 WHERE version=11').first();}catch{return false;}}
 async phase12(db=this.database()){try{return !!await db.prepare('SELECT version FROM universe_phase12 WHERE version=12').first();}catch{return false;}}
 async phase13(db=this.database()){try{return !!await db.prepare('SELECT version FROM universe_phase13 WHERE version=13').first();}catch{return false;}}
 async availability(){const a=await super.availability(),on=!!a.capabilities?.rules&&await this.phase11(),files=on&&await this.phase12(),context=files&&await this.phase13();return {...a,capabilities:{...a.capabilities,community:on,community_files:files,context}};}
 async handle(identity,path,method,b={}){
  const m=path.match(/^\/universe\/groups\/([A-Za-z0-9_-]{1,100})\/(community|discussion|context)(\/.*)?$/);
  if(!m)return super.handle(identity,path,method,b);
  const db=await this.ready();this.rulesEnabled=await this.phase67(db);
  if(m[2]==='context'&&!(this.rulesEnabled&&await this.phase11(db)&&await this.phase12(db)&&await this.phase13(db)))throw error(409,'PHASE13_SETUP','Apply uni/universe-phase11.sql to universe-phase13.sql before using Context.');
  if(!this.rulesEnabled||!await this.phase11(db)){if(m[2]==='community')throw error(409,'PHASE11_SETUP','Apply uni/universe-phase11.sql before using Community.');return super.handle(identity,path,method,b);}
  // The old discussion is now the read-only "Earlier discussion" post. Reads still work; new writes go to Community.
  if(m[2]==='discussion'){if(method!=='GET')throw error(410,'MOVED','Discussion moved to the Community tab. Refresh to continue.');return super.handle(identity,path,method,b);}
  this.files=await this.phase12(db);await this.active(identity,db);await this.profile(db,identity);
  const g=await this.authorize(db,identity,m[1]);if(m[2]==='context')return this.contextRoute(db,identity,g,m[3]||'',method,b);return this.community(db,identity,g,m[3]||'',method,b);
 }
 async community(db,identity,g,tail,method,b){
  let r;
  if(method==='GET'){
   if(tail===''||tail==='/')return this.feed(db,g,null);
   if((r=tail.match(/^\/after\/([A-Za-z0-9_-]+)$/)))return this.feed(db,g,r[1]);
   if((r=tail.match(/^\/posts\/([A-Za-z0-9_-]+)\/comments(?:\/after\/([A-Za-z0-9_-]+))?$/)))return this.postComments(db,g,r[1],r[2]||null);
   return this.communityGet(db,identity,g,tail);
  }
  if(method!=='POST')throw error(405,'METHOD','Use GET or POST.');
  if(tail==='/posts')return this.postWrite(db,identity,g,null,'create',b);
  if((r=tail.match(/^\/posts\/([A-Za-z0-9_-]+)\/(edit|delete)$/)))return this.postWrite(db,identity,g,r[1],r[2],b);
  if((r=tail.match(/^\/posts\/([A-Za-z0-9_-]+)\/comments$/)))return this.commentCreate(db,identity,g,r[1],b);
  if((r=tail.match(/^\/comments\/([A-Za-z0-9_-]+)\/(edit|delete)$/)))return this.commentChange(db,identity,g,r[1],r[2],b);
  return this.communityPost(db,identity,g,tail,b);
 }
 // Extension points for attachments (3B) and Context (3C).
 async communityGet(db,identity,g,tail){let r;if(this.files&&(r=tail.match(/^\/files\/([A-Za-z0-9_-]+)$/)))return this.fileDownload(db,identity,g,r[1]);throw error(404,'ENDPOINT','Unknown Community request.');}
 async communityPost(db,identity,g,tail,b){if(this.files&&tail==='/files')return this.fileUpload(db,identity,g,b);throw error(404,'ENDPOINT','Unknown Community request.');}
 // Expired posts are hidden from every read straight away; the hourly cleanup removes them later.
 visibleWhere(a='p'){return this.files?` AND NOT EXISTS(SELECT 1 FROM universe_post_expiry e WHERE e.post_id=${a}.id AND e.expires_at<=?)`:'';}
 visibleArgs(){return this.files?[Date.now()]:[];}
 async decorate(db,posts){if(!this.files||!posts.length)return posts;const ids=posts.map(p=>p.id),marks=ids.map(()=>'?').join(',');
  const exp=new Map((await this.statement(db,`SELECT post_id,expires_at FROM universe_post_expiry WHERE post_id IN(${marks})`,...ids).all()).results.map(r=>[r.post_id,r.expires_at]));
  const files=(await this.statement(db,`SELECT id,post_id,kind,name,mime,bytes FROM universe_post_files WHERE post_id IN(${marks}) ORDER BY created_at,id`,...ids).all()).results;
  for(const p of posts){p.expires_at=exp.get(p.id)??null;p.files=files.filter(f=>f.post_id===p.id).map(({post_id,...f})=>f);}return posts;}
 // ---- Reads ----
 async findPost(db,g,id){const p=await this.statement(db,'SELECT p.* FROM universe_posts p WHERE p.id=? AND p.group_id=?'+this.visibleWhere('p'),id,g.id,...this.visibleArgs()).first();if(!p)throw error(404,'POST','This post is unavailable. It may have been deleted or expired.');return p;}
 async canComment(db,g,p){
  if(p.legacy)return false;if(MANAGERS.includes(g.role))return true;
  if(json(p.comment_roles,[]).includes(g.role))return true;
  for(const pid of json(p.comment_projects,[])){let o;try{o=await this.options(db,pid);}catch{continue;}if(!o.deleted&&(o.members||[]).includes(g.actor_id))return true;}
  return false;
 }
 canManagePost(g,p,action){if(!MANAGERS.includes(g.role))return false;if(p.legacy)return g.role==='owner'&&action==='delete';if(g.role==='owner'||p.author_id===g.actor_id)return true;return action==='delete'&&p.author_role!=='owner';}
 async feed(db,g,cursor){
  let before=null;if(cursor)before=await this.statement(db,'SELECT created_at,id FROM universe_posts WHERE id=? AND group_id=?',cursor,g.id).first();
  if(cursor&&!before)throw error(409,'CURSOR','The feed changed. Refresh to start again.');
  const rows=(await this.statement(db,`SELECT p.*,pr.username,(SELECT count(*) FROM universe_post_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) comment_count FROM universe_posts p LEFT JOIN universe_profiles pr ON pr.account_id=p.author_id WHERE p.group_id=?${this.visibleWhere('p')} ${before?'AND (p.created_at<? OR (p.created_at=? AND p.id<?))':''} ORDER BY p.created_at DESC,p.id DESC LIMIT ${PAGE+1}`,g.id,...this.visibleArgs(),...(before?[before.created_at,before.created_at,before.id]:[])).all()).results;
  const page=rows.slice(0,PAGE),posts=[];
  for(const p of page)posts.push({id:p.id,author_id:p.author_id,author_role:p.author_role,username:p.username||null,body:p.body,legacy:!!p.legacy,comment_roles:json(p.comment_roles,[]),comment_projects:json(p.comment_projects,[]),comment_count:p.comment_count,created_at:p.created_at,edited_at:p.edited_at,expires_at:p.expires_at??null,revision:p.revision,can_comment:await this.canComment(db,g,p),can_edit:this.canManagePost(g,p,'edit'),can_delete:this.canManagePost(g,p,'delete')});
  return {posts:await this.decorate(db,posts,g),next:rows.length>PAGE?page[page.length-1].id:null,end:rows.length<=PAGE,can_post:MANAGERS.includes(g.role)};
 }
 async postComments(db,g,postId,cursor){
  const p=await this.findPost(db,g,postId);let after=null;
  if(cursor){after=await this.statement(db,'SELECT created_at,id FROM universe_post_comments WHERE id=? AND post_id=?',cursor,p.id).first();if(!after)throw error(409,'CURSOR','The thread changed. Refresh to start again.');}
  const rows=(await this.statement(db,`SELECT c.*,pr.username,m.role current_role FROM universe_post_comments c LEFT JOIN universe_profiles pr ON pr.account_id=c.author_id LEFT JOIN universe_members m ON m.group_id=c.group_id AND m.account_id=c.author_id WHERE c.post_id=? ${after?'AND (c.created_at>? OR (c.created_at=? AND c.id>?))':''} ORDER BY c.created_at,c.id LIMIT ${COMMENT_PAGE+1}`,p.id,...(after?[after.created_at,after.created_at,after.id]:[])).all()).results;
  const now=Date.now(),page=rows.slice(0,COMMENT_PAGE);
  return {post_id:p.id,can_comment:await this.canComment(db,g,p),edit_window_ms:EDIT_WINDOW,next:rows.length>COMMENT_PAGE?page[page.length-1].id:null,
   comments:page.map(c=>{const deleted=c.deleted_at!=null;return {id:c.id,parent_id:c.parent_id,author_id:c.author_id,author_role:c.author_role,username:c.username||null,body:deleted?'':c.body,deleted,created_at:c.created_at,edited_at:c.edited_at,revision:c.revision,
    can_edit:!deleted&&!p.legacy&&c.author_id===g.actor_id&&now-c.created_at<EDIT_WINDOW,can_delete:!deleted&&this.canDeleteComment(g,c)};})};
 }
 // Delete hierarchy: anyone deletes their own comment; admins delete members' and reviewers' comments; only the owner
 // deletes admins' comments. The author's current role counts while they are still a member, otherwise the frozen one.
 canDeleteComment(g,c){if(c.author_id===g.actor_id)return true;const rank=c.current_role||c.author_role;if(g.role==='owner')return true;return g.role==='admin'&&COMMENT_ROLES.includes(rank);}
 // ---- Writes ----
 async communityWrite(db,identity,g,scope,b,result,writes,condition='m.role=?',args=[g.role]){
  // Re-read the revision just before the commit, so an unrelated task change does not refuse a comment.
  const {revision}=await this.statement(db,'SELECT revision FROM universe_groups WHERE id=?',g.id).first();
  return this.mutate(db,identity,'community:'+g.id+':'+scope,b,result,[this.guard(db,identity,g.id,revision,condition,args),...writes]);
 }
 audience(db,g,b,old){
  const roles=b.comment_roles??json(old?.comment_roles,COMMENT_ROLES),projects=b.comment_projects??json(old?.comment_projects,[]);
  if(!Array.isArray(roles)||roles.some(r=>!COMMENT_ROLES.includes(r))||new Set(roles).size!==roles.length)throw error(400,'AUDIENCE','Choose who may comment: members and/or reviewers.');
  if(!Array.isArray(projects)||projects.length>50||projects.some(p=>typeof p!=='string')||new Set(projects).size!==projects.length)throw error(400,'AUDIENCE','Choose valid projects.');
  return {roles,projects};
 }
 postFields(){return ['operation_id','revision','body','comment_roles','comment_projects',...(this.files?['expires_in_days','expires_on','file_ids']:[])];}
 // Expiry: a preset (3, 7, 14 or 30 days from today) or a date, ending at 23:59 Riyadh time. expires_on:null clears it.
 expiry(b){
  if(b.expires_in_days!==undefined&&b.expires_on!==undefined)throw error(400,'EXPIRY','Choose a preset or a date, not both.');
  const today=riyadhDay(Date.now());
  if(b.expires_in_days!==undefined){if(![3,7,14,30].includes(b.expires_in_days))throw error(400,'EXPIRY','Choose 3, 7, 14 or 30 days.');return endOfDay(riyadhDay(endOfDay(today)+b.expires_in_days*DAY));}
  if(b.expires_on===null)return null;
  if(typeof b.expires_on!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.expires_on)||Number.isNaN(endOfDay(b.expires_on))||riyadhDay(endOfDay(b.expires_on))!==b.expires_on)throw error(400,'EXPIRY','Use a valid end date.');
  if(b.expires_on<today||endOfDay(b.expires_on)>Date.now()+366*DAY)throw error(400,'EXPIRY','Choose an end date from today up to a year ahead.');
  return endOfDay(b.expires_on);
 }
 async postExtras(db,identity,g,b,old,pid){
  const out={columns:[],values:[],writes:[],result:{}};if(!this.files)return out;
  if(b.expires_in_days!==undefined||b.expires_on!==undefined){const at=this.expiry(b);out.writes.push(at===null?this.statement(db,'DELETE FROM universe_post_expiry WHERE post_id=?',pid):this.statement(db,'INSERT INTO universe_post_expiry VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET expires_at=excluded.expires_at',pid,g.id,at));out.result.expires_at=at;}
  if(b.file_ids===undefined)return out;
  const ids=b.file_ids;if(!Array.isArray(ids)||ids.length>20||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw error(400,'FILES','Choose up to 20 attachments.');
  const current=old?(await this.statement(db,'SELECT * FROM universe_post_files WHERE post_id=?',pid).all()).results:[];const now=Date.now(),fresh=[];
  for(const id of ids){if(current.some(f=>f.id===id))continue;const f=await this.statement(db,'SELECT * FROM universe_post_files WHERE id=? AND group_id=? AND post_id IS NULL AND uploader_id=? AND staged_until>?',id,g.id,identity.userId,now).first();if(!f)throw error(409,'FILES','An attachment expired or is unavailable. Add it again.');fresh.push(f);}
  if(fresh.length)await this.requireOwnerPro(db,g.id).catch(()=>{throw error(403,'OWNER_PRO','The Universe owner needs active Pro for new attachments. You can still post text.');});
  // Counted on the server from stored sizes: the whole post, old and new attachments together.
  const kept=current.filter(f=>ids.includes(f.id)),total=[...kept,...fresh].reduce((n,f)=>n+f.bytes,0);
  if(total>POST_MAX)throw error(413,'POST_SIZE','Attachments on one post can total 8 MB.');
  for(const f of fresh)out.writes.push(this.statement(db,'UPDATE universe_post_files SET post_id=?,staged_until=NULL WHERE id=? AND post_id IS NULL',pid,f.id));
  for(const f of current.filter(f=>!ids.includes(f.id)))out.writes.push(this.statement(db,'INSERT OR IGNORE INTO universe_r2_trash VALUES(?,?)',f.object_key,now),this.statement(db,'DELETE FROM universe_post_files WHERE id=?',f.id));
  return out;
 }
 async postDelete(db,g,p){if(!this.files)return [];const now=Date.now();return [this.statement(db,'INSERT OR IGNORE INTO universe_r2_trash SELECT object_key,? FROM universe_post_files WHERE post_id=?',now,p.id),this.statement(db,'DELETE FROM universe_post_files WHERE post_id=?',p.id),this.statement(db,'DELETE FROM universe_post_expiry WHERE post_id=?',p.id)];}
 // ---- Attachments ----
 // One request per file: checks, then R2, then the row. Images need the uploader's own active Pro (checked here, on the
 // server); any new attachment needs the owner's active Pro. Files stay staged for an hour until a post uses them.
 async fileUpload(db,identity,g,b){
  if(!MANAGERS.includes(g.role))throw error(403,'ROLE_DENIED','Only admins and the owner can attach files.');
  this.input(b,['operation_id','name','mime','size','hash','data']);this.operation(b);const scope='community:'+g.id+':file';
  const done=await this.statement(db,'SELECT result,scope FROM universe_operations WHERE actor_id=? AND operation_id=?',identity.userId,b.operation_id).first();if(done)return this.mutate(db,identity,scope,b,{},[]);
  const image=IMAGE_TYPES.includes(b.mime);if(!image&&!FILE_TYPES.includes(b.mime))throw error(400,'FILE_TYPE','Use PNG, JPEG or WebP images, or PDF, text, CSV, Word, Excel or PowerPoint files.');
  if(!Number.isSafeInteger(b.size)||b.size<1||b.size>FILE_MAX)throw error(413,'FILE_SIZE','Each file can be up to 5 MB.');
  if(!/^[a-f0-9]{64}$/.test(b.hash??''))throw error(400,'FILE','Send the file’s SHA-256 hash.');
  await this.requireOwnerPro(db,g.id).catch(()=>{throw error(403,'OWNER_PRO','The Universe owner needs active Pro for new attachments. You can still post text.');});
  if(image&&!await this.entitlement(identity))throw error(403,'PRO','Images need your own active Pro. You can still attach files or post text.');
  const staged=await this.statement(db,'SELECT count(*) n FROM universe_post_files WHERE uploader_id=? AND post_id IS NULL AND staged_until>?',identity.userId,Date.now()).first();if(staged.n>=STAGED_MAX)throw error(429,'UPLOAD_LIMIT','Publish or wait for your pending attachments first.');
  const bytes=decode(b.data);if(bytes.length!==b.size||hex(await crypto.subtle.digest('SHA-256',bytes))!==b.hash)throw error(400,'FILE','The file did not arrive intact. Try again.');
  const fid=uuid('pfile'),key='universe/'+g.id+'/community/'+fid,now=Date.now();
  await this.service.ensureAlarm();await this.bucket().put(key,bytes);
  try{return await this.communityWrite(db,identity,g,'file',b,{id:fid,kind:image?'image':'file',name:this.text(b.name,200),mime:b.mime,bytes:b.size},[this.statement(db,'INSERT INTO universe_post_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',fid,g.id,null,identity.userId,image?'image':'file',this.text(b.name,200),b.mime,b.size,b.hash,key,now,now+3600000)],"m.role IN ('owner','admin')",[]);}
  catch(e){await this.bucket().delete(key).catch(()=>{});throw e;}
 }
 async fileDownload(db,identity,g,id){
  const f=await this.statement(db,'SELECT * FROM universe_post_files WHERE id=? AND group_id=?',id,g.id).first();if(!f)throw error(404,'FILE','This attachment is unavailable.');
  if(f.post_id)await this.findPost(db,g,f.post_id);else if(f.uploader_id!==identity.userId)throw error(404,'FILE','This attachment is unavailable.');
  const obj=await this.bucket().get(f.object_key);if(!obj)throw error(410,'FILE','This attachment is no longer stored.');
  return {id:f.id,name:f.name,mime:f.mime,kind:f.kind,data:encode(new Uint8Array(await obj.arrayBuffer()))};
 }
 async postWrite(db,identity,g,id,action,b){
  if(!MANAGERS.includes(g.role))throw error(403,'ROLE_DENIED','Only admins and the owner can post.');
  this.input(b,action==='delete'?['operation_id','revision']:this.postFields());this.operation(b);
  const old=id?await this.findPost(db,g,id):null;
  if(old){if(!this.canManagePost(g,old,action))throw error(403,'ROLE_DENIED',action==='delete'?'Only the author, another admin or the owner can delete this post. Only the owner can delete the owner’s posts.':'Only the author or the owner can edit this post.');if(b.revision!==old.revision)throw error(409,'REVISION','This post changed. Refresh to load the latest version.');}
  if(action==='delete')return this.communityWrite(db,identity,g,'post-delete:'+id,b,{id,deleted:true},[...await this.postDelete(db,g,old),this.statement(db,'DELETE FROM universe_post_comments WHERE post_id=?',id),this.statement(db,'DELETE FROM universe_posts WHERE id=?',id)],"m.role IN ('owner','admin')",[]);
  const body=this.text(b.body??old?.body,8000),{roles,projects}=this.audience(db,g,b,old);
  for(const pid of projects){const row=await this.statement(db,'SELECT id FROM universe_projects WHERE id=? AND group_id=?',pid,g.id).first(),o=row&&await this.options(db,pid);if(!o||o.deleted)throw error(400,'AUDIENCE','A chosen project no longer exists.');}
  const now=Date.now(),pid=id||uuid('post'),extra=await this.postExtras(db,identity,g,b,old,pid);
  const writes=old?[this.statement(db,`UPDATE universe_posts SET body=?,comment_roles=?,comment_projects=?,revision=revision+1,edited_at=?${extra.columns.map(c=>','+c+'=?').join('')} WHERE id=?`,body,JSON.stringify(roles),JSON.stringify(projects),now,...extra.values,pid)]
   :[this.statement(db,`INSERT INTO universe_posts(id,group_id,author_id,author_role,body,comment_roles,comment_projects,created_at${extra.columns.map(c=>','+c).join('')}) VALUES(?,?,?,?,?,?,?,?${extra.columns.map(()=>',?').join('')})`,pid,g.id,identity.userId,g.role,body,JSON.stringify(roles),JSON.stringify(projects),now,...extra.values)];
  return this.communityWrite(db,identity,g,'post:'+(id?'edit:'+id:'create'),b,{id:pid,...extra.result},[...writes,...extra.writes],"m.role IN ('owner','admin')",[]);
 }
 async commentCreate(db,identity,g,postId,b){
  this.input(b,['operation_id','body','parent_id']);this.operation(b);const p=await this.findPost(db,g,postId);
  if(!await this.canComment(db,g,p))throw error(403,'COMMENT_DENIED',p.legacy?'Earlier discussion is read-only.':'This post does not take comments from your role or projects.');
  if(b.parent_id!=null){const parent=await this.statement(db,'SELECT post_id FROM universe_post_comments WHERE id=? AND group_id=?',b.parent_id,g.id).first();if(!parent||parent.post_id!==p.id)throw error(400,'THREAD','A reply must stay on the same post.');}
  const cid=uuid('comment'),now=Date.now();
  // The role is frozen on the comment: later promotions or demotions do not change it.
  return this.communityWrite(db,identity,g,'comment:'+p.id,b,{id:cid},[this.statement(db,'INSERT INTO universe_post_comments(id,group_id,post_id,parent_id,author_id,author_role,body,created_at) VALUES(?,?,?,?,?,?,?,?)',cid,g.id,p.id,b.parent_id??null,identity.userId,g.role,this.text(b.body,4000),now)]);
 }
 async commentChange(db,identity,g,id,action,b){
  this.input(b,action==='edit'?['operation_id','revision','body']:['operation_id','revision']);this.operation(b);
  const c=await this.statement(db,'SELECT c.*,m.role current_role FROM universe_post_comments c LEFT JOIN universe_members m ON m.group_id=c.group_id AND m.account_id=c.author_id WHERE c.id=? AND c.group_id=?',id,g.id).first();
  if(!c)throw error(404,'COMMENT','This comment is unavailable.');const p=await this.findPost(db,g,c.post_id);
  if(c.deleted_at!=null)throw error(409,'REMOVED','This comment was removed.');if(b.revision!==c.revision)throw error(409,'REVISION','This comment changed. Refresh to load the latest version.');
  const now=Date.now();
  if(action==='edit'){if(c.author_id!==identity.userId||p.legacy)throw error(403,'ROLE_DENIED','Only the author can edit a comment.');if(now-c.created_at>=EDIT_WINDOW)throw error(409,'EDIT_WINDOW','Comments can be edited for 30 minutes after posting. You can still delete it.');
   return this.communityWrite(db,identity,g,'comment-edit:'+id,b,{id},[this.statement(db,'UPDATE universe_post_comments SET body=?,edited_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL',this.text(b.body,4000),now,id)]);}
  if(!this.canDeleteComment(g,c))throw error(403,'ROLE_DENIED','Admins remove members’ and reviewers’ comments. Only the owner removes an admin’s comment.');
  // Tombstone: the row stays (so replies keep their place) with the text cleared.
  return this.communityWrite(db,identity,g,'comment-delete:'+id,b,{id,deleted:true},[this.statement(db,'UPDATE universe_post_comments SET body=\'\',deleted_at=?,deleted_by=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL',now,identity.userId,id)]);
 }
 // ---- Context (3C) ----
 // Files and photos admins share for members to download. Access needs the owner's active Pro (another member's Pro does
 // not count). When the owner's Pro lapses the tab is off and the files are kept for 3 months from the lapse, then deleted.
 // Renewing, or transferring ownership to a member with Pro, restores access; a later lapse starts a new 3-month period.
 async ownerState(db,g){const {owner_id}=await this.statement(db,'SELECT owner_id FROM universe_groups WHERE id=?',g.id).first();const l=await this.lifecycle(db,owner_id);return {pro:!!l.owner_pro,lapse_at:l.lapse_at??null,unavailable:!!l.entitlement_unavailable};}
 async contextRoute(db,identity,g,tail,method,b){
  const o=await this.ownerState(db,g),used=(await this.statement(db,'SELECT COALESCE(sum(bytes),0) n FROM universe_context_files WHERE group_id=?',g.id).first()).n;
  const off=()=>error(o.unavailable?503:403,'OWNER_PRO',o.unavailable?'The owner’s Pro status could not be checked. Try again shortly.':'Context needs the Universe owner’s active Pro. Files are kept for 3 months after the lapse.');
  let r;
  if(method==='GET'&&(tail===''||tail==='/')){const base={quota:CONTEXT_QUOTA,file_max:CONTEXT_FILE_MAX,used,can_upload:MANAGERS.includes(g.role),available:o.pro,retention_until:o.pro||o.lapse_at==null?null:o.lapse_at+RETENTION};
   if(!o.pro)return {...base,files:[]};
   const files=(await this.statement(db,'SELECT f.id,f.uploader_id,f.kind,f.name,f.mime,f.bytes,f.created_at,p.username FROM universe_context_files f LEFT JOIN universe_profiles p ON p.account_id=f.uploader_id WHERE f.group_id=? ORDER BY f.created_at DESC,f.id DESC',g.id).all()).results;return {...base,files};}
  if(!o.pro)throw off();
  if(method==='GET'&&(r=tail.match(/^\/files\/([A-Za-z0-9_-]+)$/))){const f=await this.statement(db,'SELECT * FROM universe_context_files WHERE id=? AND group_id=?',r[1],g.id).first();if(!f)throw error(404,'FILE','This file is unavailable.');const obj=await this.bucket().get(f.object_key);if(!obj)throw error(410,'FILE','This file is no longer stored.');return {id:f.id,name:f.name,mime:f.mime,kind:f.kind,data:encode(new Uint8Array(await obj.arrayBuffer()))};}
  if(method!=='POST')throw error(404,'ENDPOINT','Unknown Context request.');
  if(!MANAGERS.includes(g.role))throw error(403,'ROLE_DENIED','Only admins and the owner can change Context files.');
  if((r=tail.match(/^\/files\/([A-Za-z0-9_-]+)\/delete$/))){this.input(b,['operation_id']);this.operation(b);const f=await this.statement(db,'SELECT * FROM universe_context_files WHERE id=? AND group_id=?',r[1],g.id).first();if(!f)throw error(404,'FILE','This file is unavailable.');
   return this.communityWrite(db,identity,g,'context-delete:'+f.id,b,{id:f.id,deleted:true},[this.statement(db,'INSERT OR IGNORE INTO universe_r2_trash VALUES(?,?)',f.object_key,Date.now()),this.statement(db,'DELETE FROM universe_context_files WHERE id=?',f.id)],"m.role IN ('owner','admin')",[]);}
  if(tail!=='/files')throw error(404,'ENDPOINT','Unknown Context request.');
  this.input(b,['operation_id','name','mime','size','hash','data']);this.operation(b);const scope='community:'+g.id+':context-file';
  if(await this.statement(db,'SELECT 1 FROM universe_operations WHERE actor_id=? AND operation_id=?',identity.userId,b.operation_id).first())return this.mutate(db,identity,scope,b,{},[]);
  const image=IMAGE_TYPES.includes(b.mime);if(!image&&!FILE_TYPES.includes(b.mime))throw error(400,'FILE_TYPE','Use PNG, JPEG or WebP images, or PDF, text, CSV, Word, Excel or PowerPoint files.');
  if(!Number.isSafeInteger(b.size)||b.size<1||b.size>CONTEXT_FILE_MAX)throw error(413,'FILE_SIZE','Each Context file can be up to 10 MB.');
  if(!/^[a-f0-9]{64}$/.test(b.hash??''))throw error(400,'FILE','Send the file’s SHA-256 hash.');
  if(used+b.size>CONTEXT_QUOTA)throw error(413,'QUOTA','This Universe’s Context is full (200 MB). Delete files to make room.');
  const bytes=decode(b.data);if(bytes.length!==b.size||hex(await crypto.subtle.digest('SHA-256',bytes))!==b.hash)throw error(400,'FILE','The file did not arrive intact. Try again.');
  const fid=uuid('cfile'),key='universe/'+g.id+'/context/'+fid,now=Date.now();
  await this.service.ensureAlarm();await this.bucket().put(key,bytes);
  // The quota is checked again inside the commit, so two uploads at once cannot pass it together.
  try{return await this.communityWrite(db,identity,g,'context-file',b,{id:fid,kind:image?'image':'file',name:this.text(b.name,200),mime:b.mime,bytes:b.size},[this.statement(db,'INSERT INTO universe_context_files VALUES(?,?,?,?,?,?,?,?,?,?)',fid,g.id,identity.userId,image?'image':'file',this.text(b.name,200),b.mime,b.size,b.hash,key,now)],"m.role IN ('owner','admin') AND (SELECT COALESCE(sum(bytes),0) FROM universe_context_files WHERE group_id=g.id)+?<=?",[b.size,CONTEXT_QUOTA]);}
  catch(e){await this.bucket().delete(key).catch(()=>{});throw e;}
 }
 async contextCleanup(db,now){if(!await this.phase13(db))return false;
  // Look up owners who have Context files and were not checked for a day, so a lapse is noticed even if nobody visits.
  const stale=(await this.statement(db,"SELECT DISTINCT g.owner_id FROM universe_context_files f JOIN universe_groups g ON g.id=f.group_id LEFT JOIN universe_lifecycle l ON l.account_id=g.owner_id WHERE l.checked_at IS NULL OR l.checked_at<? LIMIT 10",now-DAY).all()).results;
  for(const {owner_id}of stale){try{await this.lifecycle(db,owner_id);}catch{}}
  const gone='SELECT group_id FROM universe_group_state WHERE deleted=1';
  const expired=`SELECT g.id FROM universe_groups g JOIN universe_lifecycle l ON l.account_id=g.owner_id WHERE l.lapse_at IS NOT NULL AND l.lapse_at+${RETENTION}<=?`;
  await db.batch([this.statement(db,`INSERT OR IGNORE INTO universe_r2_trash SELECT object_key,? FROM universe_context_files WHERE group_id IN(${gone}) OR group_id IN(${expired})`,now,now),this.statement(db,`DELETE FROM universe_context_files WHERE group_id IN(${gone}) OR group_id IN(${expired})`,now)]);
  return stale.length===10;}
 async cleanup(){const more=await super.cleanup(),db=this.database();if(!db||!await this.phase11(db))return more;
  // A deleted Universe keeps no Community content.
  const gone='SELECT group_id FROM universe_group_state WHERE deleted=1',files=await this.phase12(db),now=Date.now();
  await db.batch([...(files?[this.statement(db,`INSERT OR IGNORE INTO universe_r2_trash SELECT object_key,? FROM universe_post_files WHERE group_id IN(${gone})`,now),this.statement(db,`DELETE FROM universe_post_files WHERE group_id IN(${gone})`),this.statement(db,`DELETE FROM universe_post_expiry WHERE group_id IN(${gone})`)]:[]),
   this.statement(db,`DELETE FROM universe_post_comments WHERE group_id IN(${gone})`),this.statement(db,`DELETE FROM universe_posts WHERE group_id IN(${gone})`)]);
  if(!files)return more;
  // Expired posts: rows go now, their R2 objects through the trash below.
  const due=(await this.statement(db,'SELECT post_id FROM universe_post_expiry WHERE expires_at<=? LIMIT 50',now).all()).results;
  for(const {post_id}of due)await db.batch([this.statement(db,'INSERT OR IGNORE INTO universe_r2_trash SELECT object_key,? FROM universe_post_files WHERE post_id=?',now,post_id),this.statement(db,'DELETE FROM universe_post_files WHERE post_id=?',post_id),this.statement(db,'DELETE FROM universe_post_comments WHERE post_id=?',post_id),this.statement(db,'DELETE FROM universe_posts WHERE id=?',post_id),this.statement(db,'DELETE FROM universe_post_expiry WHERE post_id=?',post_id)]);
  // Uploads that were never attached to a post.
  await db.batch([this.statement(db,'INSERT OR IGNORE INTO universe_r2_trash SELECT object_key,? FROM universe_post_files WHERE post_id IS NULL AND staged_until<=?',now,now),this.statement(db,'DELETE FROM universe_post_files WHERE post_id IS NULL AND staged_until<=?',now)]);
  const more3=await this.contextCleanup(db,now),more2=await this.emptyTrash(db);
  return more||due.length===50||more2||more3;}
 async emptyTrash(db){const trash=(await db.prepare('SELECT object_key FROM universe_r2_trash ORDER BY queued_at LIMIT 100').all()).results;
  for(const {object_key}of trash){try{await this.bucket().delete(object_key);await this.statement(db,'DELETE FROM universe_r2_trash WHERE object_key=?',object_key).run();}catch{return true;}}
  return trash.length===100;}
};}

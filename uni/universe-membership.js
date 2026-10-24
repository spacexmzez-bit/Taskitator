import { UniverseService, fail, digest } from '../pro-backend.js';
const error=(status,code,message)=>fail(status,'UNIVERSE_'+code,message);
const DAY=86400000;
export class UniverseMembership extends UniverseService {
 async phase2(db=this.database()){try{return Boolean(await db.prepare('SELECT version FROM universe_phase2 WHERE version=2').first());}catch{return false;}}
 async availability(){const a=await super.availability();const ready=a.foundation&&await this.phase2();return {...a,version:2,schema_version:ready?2:a.schema_version,ui:ready};}
 async lifecycle(db,id){
  let e;try{e=await this.service.pro.licenses.resolve(id);}catch(ex){
   const old=await this.statement(db,'SELECT lapse_at FROM universe_lifecycle WHERE account_id=?',id).first();
   if(!old)throw ex;return this.state(old.lapse_at,true);
  }
  const now=Date.now(),active=e?.status==='active'&&e.tier==='pro'&&(e.expires_at===null||Number(e.expires_at)>now);
  const lapse=active?null:(Number.isFinite(e?.expires_at)&&e.expires_at<now?e.expires_at:now);
  await this.statement(db,`INSERT INTO universe_lifecycle VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET
   lapse_at=CASE WHEN excluded.lapse_at IS NULL THEN NULL ELSE COALESCE(universe_lifecycle.lapse_at,excluded.lapse_at) END,checked_at=excluded.checked_at`,id,lapse,now).run();
  return this.state((await this.statement(db,'SELECT lapse_at FROM universe_lifecycle WHERE account_id=?',id).first()).lapse_at);
 }
 state(lapse,unavailable=false){return {lapse_at:lapse,grace_until:lapse===null?null:lapse+7*DAY,read_only:lapse!==null&&lapse+7*DAY<=Date.now(),entitlement_unavailable:unavailable};}
 async authorize(db,identity,gid,min='member'){
  const g=await super.authorize(db,identity,gid,min);
  if(!await this.phase2(db))return g;
  if(await this.statement(db,'SELECT 1 FROM universe_group_state WHERE group_id=? AND deleted=1',gid).first())throw error(403,'ACCESS_DENIED','This Universe was deleted.');
  Object.assign(g,await this.lifecycle(db,g.owner_id));if(min==='admin')this.writable(g);return g;
 }
 writable(g){if(g.entitlement_unavailable)throw error(503,'ENTITLEMENT_UNAVAILABLE','Pro status could not be checked. Retry this change.');if(g.read_only)throw error(409,'READ_ONLY','The owner needs to renew Pro before this Universe can be changed.');}
 guard(db,identity,g,revision,condition,args=[],write=true){return this.statement(db,`INSERT OR REPLACE INTO universe_write_guard VALUES(1,EXISTS(
  SELECT 1 FROM universe_groups g JOIN universe_members m ON m.group_id=g.id JOIN universe_accounts a ON a.account_id=m.account_id
  JOIN universe_accounts o ON o.account_id=g.owner_id LEFT JOIN universe_group_state s ON s.group_id=g.id LEFT JOIN universe_lifecycle l ON l.account_id=g.owner_id
  WHERE g.id=? AND m.account_id=? AND g.revision=? AND a.blocked=0 AND o.blocked=0 AND COALESCE(s.deleted,0)=0
  ${write?'AND (l.lapse_at IS NULL OR l.lapse_at+604800000>unixepoch()*1000)':''} AND (${condition})))`,g,identity.userId,revision,...args);}
 async change(db,identity,gid,action,body){
  this.input(body,['operation_id','revision','target_id','role','title','purpose','confirm']);this.operation(body);
  const scope=action+':'+gid;
  const old=await this.statement(db,'SELECT * FROM universe_operations WHERE actor_id=? AND operation_id=?',identity.userId,body.operation_id).first();
  if(old){if(old.scope!==scope||old.request_hash!==await digest({scope,body}))throw error(409,'OPERATION_CONFLICT','This operation ID was already used for different input.');return {...JSON.parse(old.result),replayed:true};}
  const g=await this.authorize(db,identity,gid);const write=!['leave','delete'].includes(action);if(write)this.writable(g);
  if(!Number.isSafeInteger(body.revision))throw error(400,'INVALID_INPUT','Refresh the Universe before changing it.');
  let condition,args=[],writes=[];const target=body.target_id;
  if(action==='leave'){condition="m.role<>'owner'";writes=[this.statement(db,'DELETE FROM universe_members WHERE group_id=? AND account_id=?',gid,identity.userId)];}
  else if(action==='delete'){
   if(body.confirm!==true)throw error(400,'INVALID_INPUT','Confirm permanent group deletion.');condition="m.role='owner'";
   writes=[this.statement(db,`INSERT INTO universe_group_state VALUES(?,1,?) ON CONFLICT(group_id) DO UPDATE SET deleted=1,deleted_at=excluded.deleted_at`,gid,Date.now()),this.statement(db,'INSERT OR IGNORE INTO universe_cleanup(group_id) VALUES(?)',gid)];await this.service.ensureAlarm();
  }else if(action==='edit'){condition="m.role IN ('owner','admin')";writes=[this.statement(db,'UPDATE universe_groups SET title=?,purpose=? WHERE id=?',this.text(body.title,120),this.text(body.purpose??'',2000,false),gid)];}
  else if(action==='role'||action==='remove'){
   if(typeof target!=='string'||(action==='role'&&!['admin','reviewer','member'].includes(body.role)))throw error(400,'INVALID_INPUT','Select a current member and valid role.');
   condition=`EXISTS(SELECT 1 FROM universe_members t WHERE t.group_id=g.id AND t.account_id=? AND t.role<>'owner'
    AND (m.role='owner' OR (m.role='admin' AND t.role IN ('member','reviewer') ${action==='role'?"AND ?<>'admin'":''})))`;
   args=[target,...(action==='role'?[body.role]:[])];writes=[action==='role'?this.statement(db,'UPDATE universe_members SET role=? WHERE group_id=? AND account_id=?',body.role,gid,target):this.statement(db,'DELETE FROM universe_members WHERE group_id=? AND account_id=?',gid,target)];
  }else throw error(404,'ENDPOINT_UNAVAILABLE','Unknown action.');
  return this.mutate(db,identity,scope,body,{version:2,group_id:gid,revision:body.revision+1,action},[
   this.guard(db,identity,gid,body.revision,condition,args,write),...writes,
   this.statement(db,'UPDATE universe_groups SET revision=revision+1 WHERE id=?',gid),this.event(db,gid,identity.userId,action,target??gid)]);
 }
 async handle(identity,path,method,body={}){
  if(path==='/universe/capabilities')return super.handle(identity,path,method,body);
  const db=await this.ready();await this.active(identity,db);const ready=await this.phase2(db);
  const match=path.match(/^\/universe\/groups\/([A-Za-z0-9_-]{1,100})\/(leave|delete|edit|role|remove|activity)$/);
  if(match&&ready){
   if(method==='POST'&&match[2]!=='activity')return this.change(db,identity,match[1],match[2],body);
   if(method==='GET'&&match[2]==='activity'){await this.authorize(db,identity,match[1]);return {events:(await this.statement(db,'SELECT kind,actor_id,resource_id,created_at FROM universe_events WHERE group_id=? ORDER BY created_at DESC,id DESC LIMIT 50',match[1]).all()).results};}
  }
  if(ready&&path==='/universe/invitations/accept'&&method==='POST'){
   if(typeof body.token==='string'){
    const invite=await this.statement(db,'SELECT group_id FROM universe_invitations WHERE token_hash=?',await digest(body.token)).first();
    if(invite){const g=await this.statement(db,'SELECT owner_id FROM universe_groups WHERE id=?',invite.group_id).first();if(g)this.writable(await this.lifecycle(db,g.owner_id));}
   }
  }
  const result=await super.handle(identity,path,method,body);
  if(ready&&path==='/universe/groups'&&method==='GET'){
   const groups=[];for(const g of result.groups){if(await this.statement(db,'SELECT 1 FROM universe_group_state WHERE group_id=? AND deleted=1',g.id).first())continue;Object.assign(g,await this.lifecycle(db,g.owner_id));groups.push(g);}return {...result,groups};
  }return result;
 }
 async blockAccount(id){
  await super.blockAccount(id);const db=this.database();if(!db||!await this.phase2(db))return;
  await db.batch([this.statement(db,`INSERT INTO universe_group_state SELECT id,1,? FROM universe_groups WHERE owner_id=? ON CONFLICT(group_id) DO UPDATE SET deleted=1,deleted_at=excluded.deleted_at`,Date.now(),id),
   this.statement(db,'INSERT OR IGNORE INTO universe_cleanup(group_id) SELECT id FROM universe_groups WHERE owner_id=?',id)]);
 }
 async cleanup(){
  const db=this.database();if(!db||!await this.phase2(db))return false;
  const jobs=(await db.prepare("SELECT group_id FROM universe_cleanup WHERE status='pending' LIMIT 20").all()).results;
  for(const j of jobs)await db.batch([
   this.statement(db,"UPDATE universe_groups SET title='Deleted Universe',purpose='' WHERE id=?",j.group_id),
   this.statement(db,"DELETE FROM universe_members WHERE group_id=? AND role<>'owner'",j.group_id),
   this.statement(db,'DELETE FROM universe_invitations WHERE group_id=?',j.group_id),
   this.statement(db,"UPDATE universe_cleanup SET status='complete' WHERE group_id=?",j.group_id)]);
  await db.prepare("DELETE FROM universe_members WHERE role<>'owner' AND account_id IN(SELECT account_id FROM universe_accounts WHERE blocked=1)").run();return jobs.length===20;
 }
}

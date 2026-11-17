// Universe Community (Space plan Phase 3): Worker rules for posts, comments, attachments and Context.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {universeCommunity,PAGE,EDIT_WINDOW,endOfDay} from './universe-community.js';
const UniverseCommunity=universeCommunity();
const PHASES=['universe-phase10.sql','universe-phase11.sql','universe-phase12.sql','universe-phase13.sql'];
class D1{
 constructor(){this.sql=new DatabaseSync(':memory:');for(const f of ['universe-schema.sql','universe-phase2.sql','universe-phase3.sql','universe-phase4.sql','universe-phase5.sql'])this.sql.exec(readFileSync(new URL(f,import.meta.url),'utf8'));this.migration=readFileSync(new URL('universe-phase6-7.sql',import.meta.url),'utf8');this.sql.exec(this.migration);this.sql.exec(readFileSync(new URL('universe-phase9.sql',import.meta.url),'utf8'));for(const f of PHASES)this.sql.exec(readFileSync(new URL(f,import.meta.url),'utf8'));}
 withSession(){return this;}prepare(sql){const make=(values=[])=>({sql,values,bind:(...v)=>make(v),first:async()=>this.sql.prepare(sql).get(...values)||null,all:async()=>({results:this.sql.prepare(sql).all(...values)}),run:async()=>this.sql.prepare(sql).run(...values)});return make();}
 async batch(statements){if(this.before){const fn=this.before;this.before=null;await fn();}this.sql.exec('BEGIN');try{const r=statements.map(s=>{const q=this.sql.prepare(s.sql);return q.columns().length?{results:q.all(...s.values)}:{meta:q.run(...s.values)};});this.sql.exec('COMMIT');return r;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
async function fixture(){const db=new D1(),map=new Map(),pro=new Set(['owner']),storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),transaction:async fn=>fn(storage)},files=new Map();const service={env:{UNIVERSE_FOUNDATION_ENABLED:'true',TASKITATOR_DB:db,TASKITATOR_EVIDENCE:{get:async k=>files.has(k)?{arrayBuffer:async()=>new Uint8Array(files.get(k)).buffer}:null,put:async(k,v)=>files.set(k,typeof v==='string'?new TextEncoder().encode(v):v),delete:async k=>files.delete(k)}},storage,pro:{licenses:{resolve:async id=>({status:pro.has(id)?'active':'expired',tier:'pro',expires_at:pro.has(id)?null:Date.now()-1000})},credits:{refreshLicense:async()=>{},state:async()=>({ledger:{plan:'pro'}})}},ensureAlarm:async()=>{},ai:{generate:async()=>({candidates:[{content:{parts:[{text:'{"score":8,"critique":"Clear"}'}]}}]})}};const u=new UniverseCommunity(service),ids={};for(const id of ['owner','admin','reviewer','member','outsider']){ids[id]={userId:id};map.set('identity:'+id,{user:id});map.set('account:'+id,{owner_id:id,version:0});map.set('pro:user:username:'+id,{username:id+'Name'});await u.project(db,ids[id],pro.has(id));}const call=(who,path,body)=>u.handle(ids[who],path,body?'POST':'GET',body?{operation_id:crypto.randomUUID(),...body}:{});const group=await call('owner','/universe/groups',{title:'Universe',purpose:''}),gid=group.group_id;for(const [id,role]of [['admin','admin'],['reviewer','reviewer'],['member','member'],['outsider','member']])db.sql.prepare('INSERT INTO universe_members VALUES(?,?,?,?)').run(gid,id,role,Date.now());const base='/universe/groups/'+gid;const post=(who,path,body={})=>call(who,base+path,body),get=(who,path)=>call(who,base+path);const project=await post('admin','/work/projects',{title:'Project',members:['member'],reviewers:['reviewer']});const task=async(data={},who='admin')=>post(who,'/work/tasks',{project_id:project.id,title:'Work',members:['member'],...data});const assignment=id=>db.sql.prepare("SELECT * FROM universe_assignments WHERE task_id=? AND state<>'cancelled' ORDER BY rowid").get(id);const rev=()=>db.sql.prepare('SELECT revision FROM universe_groups WHERE id=?').get(gid).revision;const submit=async(t,who='member',extra={})=>{const a=assignment(t.id);return post(who,'/work/assignments/'+a.id+'/submit',{revision:a.revision,task_revision:(await u.task(db,t.id,gid)).revision,text:'Completed work',...extra});};const review=async(t,who='reviewer')=>{const a=assignment(t.id);return post(who,'/work/assignments/'+a.id+'/review',{revision:a.revision,task_revision:(await u.task(db,t.id,gid)).revision,decision:'approved'});};return {db,u,pro,map,ids,gid,base,call,post,get,task,project,assignment,rev,submit,review};}
const rejects=(p,code)=>assert.rejects(p,e=>e.code==='UNIVERSE_'+code);
const post=(v,who='admin',data={})=>v.post(who,'/community/posts',{body:'Hello',...data});
const comment=(v,p,who='member',data={})=>v.post(who,'/community/posts/'+p.id+'/comments',{body:'Reply',...data});
const thread=async(v,p,who='member')=>(await v.get(who,'/community/posts/'+p.id+'/comments')).comments;

test('3A migration is repeatable and moves old discussion into one read-only post without losing comments',async()=>{
 const v=await fixture();v.db.sql.prepare('DELETE FROM universe_phase11').run();v.db.sql.exec('DELETE FROM universe_posts;DELETE FROM universe_post_comments;');
 const t=await v.task({title:'Lab report'}),now=Date.now(),ins=v.db.sql.prepare('INSERT INTO universe_comments VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 ins.run('c1',v.gid,null,null,'member','General hello',1,0,null,now-3000,now-3000);ins.run('c2',v.gid,t.id,'c1','admin','On the task',2,0,null,now-2000,now-1000);ins.run('c3',v.gid,null,null,'member','',2,1,'spam',now-1500,now-1200);
 for(let i=0;i<2;i++)v.db.sql.exec(readFileSync(new URL('universe-phase11.sql',import.meta.url),'utf8'));
 assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_comments').get().n,3);
 const feed=await v.get('member','/community');assert.equal(feed.posts.length,1);const legacy=feed.posts[0];assert.equal(legacy.legacy,true);assert.equal(legacy.can_comment,false);assert.equal(legacy.comment_count,2);
 const c=await thread(v,legacy);assert.deepEqual(c.map(x=>[x.id,x.body,x.parent_id,x.deleted,x.author_role]),[['c1','General hello',null,false,'member'],['c2','[Lab report] On the task','c1',false,'admin'],['c3','',null,true,'member']]);
 await rejects(comment(v,legacy,'admin'),'COMMENT_DENIED');await rejects(v.post('admin','/community/posts/'+legacy.id+'/edit',{revision:1,body:'x'}),'ROLE_DENIED');
 await rejects(v.post('member','/discussion',{body:'old route'}),'MOVED');
});
test('3A only admins and the owner post; feed pages by 5 with an end state',async()=>{
 const v=await fixture();await rejects(post(v,'member'),'ROLE_DENIED');await rejects(post(v,'reviewer'),'ROLE_DENIED');
 for(let i=0;i<12;i++){v.db.sql.prepare('SELECT 1').get();await post(v,i%2?'owner':'admin',{body:'Post '+i});}
 const caps=(await v.call('member','/universe/capabilities')).capabilities;assert.equal(caps.community,true);
 const a=await v.get('member','/community');assert.equal(a.posts.length,PAGE);assert.equal(a.end,false);assert.equal(a.can_post,false);
 const b=await v.get('member','/community/after/'+a.next);assert.equal(b.posts.length,5);const c=await v.get('member','/community/after/'+b.next);assert.equal(c.posts.length,2);assert.equal(c.end,true);assert.equal(c.next,null);
 const ids=[...a.posts,...b.posts,...c.posts].map(p=>p.id);assert.equal(new Set(ids).size,12);
 await rejects(v.get('member','/community/after/missing'),'CURSOR');
 // Community writes never raise the Universe revision.
 const rev=v.rev();await post(v);assert.equal(v.rev(),rev);
});
test('3A audience: members, reviewers or chosen projects may comment; managers always can',async()=>{
 const v=await fixture();const reviewersOnly=await post(v,'admin',{comment_roles:['reviewer']});
 await rejects(comment(v,reviewersOnly,'member'),'COMMENT_DENIED');await comment(v,reviewersOnly,'reviewer');await comment(v,reviewersOnly,'owner');await comment(v,reviewersOnly,'admin');
 const byProject=await post(v,'admin',{comment_roles:[],comment_projects:[v.project.id]});await comment(v,byProject,'member');await rejects(comment(v,byProject,'outsider'),'COMMENT_DENIED');await rejects(comment(v,byProject,'reviewer'),'COMMENT_DENIED');
 assert.equal((await v.get('outsider','/community')).posts.find(p=>p.id===byProject.id).can_comment,false);
 await rejects(post(v,'admin',{comment_roles:['admin']}),'AUDIENCE');await rejects(post(v,'admin',{comment_projects:['nope']}),'AUDIENCE');
});
test('3A the comment role is frozen; edits close after 30 minutes; own delete any time',async()=>{
 const v=await fixture(),p=await post(v),c=await comment(v,p,'member');
 v.db.sql.prepare("UPDATE universe_members SET role='admin' WHERE account_id='member'").run();
 assert.equal((await thread(v,p))[0].author_role,'member');
 await v.post('member','/community/comments/'+c.id+'/edit',{revision:1,body:'Fixed'});assert.equal((await thread(v,p))[0].body,'Fixed');
 await rejects(v.post('admin','/community/comments/'+c.id+'/edit',{revision:2,body:'Not mine'}),'ROLE_DENIED');
 v.db.sql.prepare('UPDATE universe_post_comments SET created_at=? WHERE id=?').run(Date.now()-EDIT_WINDOW-1,c.id);
 await rejects(v.post('member','/community/comments/'+c.id+'/edit',{revision:2,body:'Late'}),'EDIT_WINDOW');
 assert.equal((await thread(v,p,'member'))[0].can_edit,false);
 await v.post('member','/community/comments/'+c.id+'/delete',{revision:2});const after=(await thread(v,p))[0];assert.equal(after.deleted,true);assert.equal(after.body,'');
 await rejects(v.post('member','/community/comments/'+c.id+'/delete',{revision:3}),'REMOVED');
});
test('3A delete hierarchy: admins remove members’ and reviewers’ comments, only the owner removes an admin’s',async()=>{
 const v=await fixture(),p=await post(v,'owner');const m=await comment(v,p,'member'),r=await comment(v,p,'reviewer'),a=await comment(v,p,'admin'),o=await comment(v,p,'owner');
 await rejects(v.post('member','/community/comments/'+r.id+'/delete',{revision:1}),'ROLE_DENIED');
 await v.post('admin','/community/comments/'+m.id+'/delete',{revision:1});await v.post('admin','/community/comments/'+r.id+'/delete',{revision:1});
 await rejects(v.post('admin','/community/comments/'+o.id+'/delete',{revision:1}),'ROLE_DENIED');
 const view=await thread(v,p,'admin'),can=id=>view.find(c=>c.id===id).can_delete;assert.deepEqual([m,r,a,o].map(c=>can(c.id)),[false,false,true,false]);
 await v.post('owner','/community/comments/'+a.id+'/delete',{revision:1});
 // Tombstones keep the thread's shape: replies still point at a removed comment.
 const reply=await comment(v,p,'member',{parent_id:m.id});const all=await thread(v,p,'owner');assert.equal(all.length,5);assert.equal(all.find(c=>c.id===reply.id).parent_id,m.id);
 await rejects(comment(v,p,'member',{parent_id:'other'}),'THREAD');
});
test('3A post edit and delete rules; deleting a post removes its comments',async()=>{
 const v=await fixture(),own=await post(v,'owner'),mine=await post(v,'admin');
 await rejects(v.post('admin','/community/posts/'+own.id+'/edit',{revision:1,body:'x'}),'ROLE_DENIED');await rejects(v.post('admin','/community/posts/'+own.id+'/delete',{revision:1}),'ROLE_DENIED');
 await v.post('owner','/community/posts/'+mine.id+'/edit',{revision:1,body:'Edited by owner'});await rejects(v.post('admin','/community/posts/'+mine.id+'/edit',{revision:1,body:'stale'}),'REVISION');
 const feed=await v.get('member','/community');assert.equal(feed.posts.find(p=>p.id===mine.id).body,'Edited by owner');assert.ok(feed.posts.find(p=>p.id===mine.id).edited_at);
 await comment(v,mine);await v.post('admin','/community/posts/'+mine.id+'/delete',{revision:2});
 assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_comments WHERE post_id=?').get(mine.id).n,0);await rejects(v.get('member','/community/posts/'+mine.id+'/comments'),'POST');
 // A replayed create returns the same post.
 const body={operation_id:crypto.randomUUID(),body:'Once'};const x=await v.call('admin',v.base+'/community/posts',body),y=await v.call('admin',v.base+'/community/posts',body);assert.equal(x.id,y.id);
});
test('3A a deleted Universe keeps no Community content after cleanup',async()=>{
 const v=await fixture(),p=await post(v);await comment(v,p);v.db.sql.prepare('INSERT INTO universe_group_state VALUES(?,1,?) ON CONFLICT(group_id) DO UPDATE SET deleted=1').run(v.gid,Date.now());
 await v.u.cleanup();assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_posts').get().n,0);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_comments').get().n,0);
});

// ---- 3B: attachments, links, expiry, sweep ----
const fileBody=async(text,mime='application/pdf',name='notes.pdf')=>{const bytes=new TextEncoder().encode(text),hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');return {name,mime,size:bytes.length,hash,data:Buffer.from(bytes).toString('base64')};};
const upload=async(v,who,text,mime,name)=>v.post(who,'/community/files',await fileBody(text,mime,name));
const objects=v=>v.u.service.env.TASKITATOR_EVIDENCE;
const stored=async(v,key)=>!!await objects(v).get(key);
test('3B uploads: managers only, type and size checks, hash check, images need the uploader’s Pro, files need the owner’s Pro',async()=>{
 const v=await fixture();assert.equal((await v.call('owner','/universe/capabilities')).capabilities.community_files,true);
 await rejects(upload(v,'member','x'),'ROLE_DENIED');await rejects(upload(v,'admin','<html>','text/html','x.html'),'FILE_TYPE');await rejects(upload(v,'admin','x','image/svg+xml','x.svg'),'FILE_TYPE');
 const bad=await fileBody('abc');bad.hash='0'.repeat(64);await rejects(v.post('admin','/community/files',bad),'FILE');
 const big=await fileBody('a');big.size=5*1048576+1;await rejects(v.post('admin','/community/files',big),'FILE_SIZE');
 await rejects(upload(v,'admin','png bytes','image/png','a.png'),'PRO');
 v.pro.add('admin');const img=await upload(v,'admin','png bytes','image/png','a.png');assert.equal(img.kind,'image');
 const pdf=await upload(v,'admin','pdf bytes');assert.equal(pdf.kind,'file');
 v.pro.delete('owner');await rejects(upload(v,'admin','later'),'OWNER_PRO');
 // Text posts still work when the owner's Pro has lapsed; new attachments do not.
 await post(v,'admin',{body:'Text only'});await rejects(post(v,'admin',{body:'With file',file_ids:[pdf.id]}),'OWNER_PRO');
});
test('3B attachments: 8 MB per post counted on the server, staged files belong to their uploader, post delete empties R2',async()=>{
 const v=await fixture();v.pro.add('admin');
 const ids=[];for(let i=0;i<2;i++)ids.push((await upload(v,'admin','file '+i)).id);
 v.db.sql.prepare('UPDATE universe_post_files SET bytes=? WHERE id=?').run(4*1048576,ids[0]);v.db.sql.prepare('UPDATE universe_post_files SET bytes=? WHERE id=?').run(4*1048576+1,ids[1]);
 await rejects(post(v,'admin',{file_ids:ids}),'POST_SIZE');
 const mine=await upload(v,'owner','owner file');await rejects(post(v,'admin',{file_ids:[mine.id]}),'FILES');
 const p=await post(v,'admin',{file_ids:[ids[0]]});const feed=await v.get('member','/community');assert.deepEqual(feed.posts[0].files.map(f=>f.id),[ids[0]]);
 const dl=await v.get('member','/community/files/'+ids[0]);assert.equal(Buffer.from(dl.data,'base64').toString(),'file 0');
 await rejects(v.get('member','/community/files/'+ids[1]),'FILE');
 // Editing the list removes dropped files (queued for R2 deletion) and adds new ones.
 const add=(await upload(v,'admin','third')).id;await v.post('admin','/community/posts/'+p.id+'/edit',{revision:1,file_ids:[add]});
 const key0=v.db.sql.prepare('SELECT object_key FROM universe_r2_trash').get().object_key;assert.match(key0,/community/);
 await v.post('admin','/community/posts/'+p.id+'/delete',{revision:2});assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_files WHERE post_id IS NOT NULL').get().n,0);
 const keys=v.db.sql.prepare('SELECT object_key FROM universe_r2_trash').all().map(r=>r.object_key);assert.equal(keys.length,2);
 await v.u.cleanup();for(const k of keys)assert.equal(await stored(v,k),false);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_r2_trash').get().n,0);
});
test('3B expiry: presets and dates end at 23:59 Riyadh; expired posts are hidden at once and purged by cleanup',async()=>{
 const v=await fixture();v.pro.add('admin');
 assert.equal(endOfDay('2026-11-20'),Date.UTC(2026,10,20,20,59));
 const week=await post(v,'admin',{expires_in_days:7});assert.equal(week.expires_at,endOfDay(new Date(Date.now()+3*3600000+7*86400000).toISOString().slice(0,10)));
 await rejects(post(v,'admin',{expires_in_days:5}),'EXPIRY');await rejects(post(v,'admin',{expires_on:'2020-01-01'}),'EXPIRY');await rejects(post(v,'admin',{expires_on:'2026-02-30'}),'EXPIRY');await rejects(post(v,'admin',{expires_in_days:3,expires_on:'2030-01-01'}),'EXPIRY');
 const f=(await upload(v,'admin','attached')).id,p=await post(v,'admin',{file_ids:[f],expires_in_days:3});await comment(v,p);
 const key=v.db.sql.prepare('SELECT object_key FROM universe_post_files WHERE id=?').get(f).object_key;
 v.db.sql.prepare('UPDATE universe_post_expiry SET expires_at=? WHERE post_id=?').run(Date.now()-1,p.id);
 assert.equal((await v.get('member','/community')).posts.some(x=>x.id===p.id),false);await rejects(comment(v,p),'POST');await rejects(v.get('member','/community/files/'+f),'POST');
 await v.u.cleanup();assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_posts WHERE id=?').get(p.id).n,0);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_comments WHERE post_id=?').get(p.id).n,0);assert.equal(await stored(v,key),false);
 // Clearing an end date on edit.
 await v.post('admin','/community/posts/'+week.id+'/edit',{revision:1,expires_on:null});assert.equal((await v.get('member','/community')).posts.find(x=>x.id===week.id).expires_at,null);
});
test('3B staged uploads that are never posted are removed after an hour; deleted Universes lose their files',async()=>{
 const v=await fixture();const s=await upload(v,'owner','never posted');const key=v.db.sql.prepare('SELECT object_key FROM universe_post_files WHERE id=?').get(s.id).object_key;
 v.db.sql.prepare('UPDATE universe_post_files SET staged_until=? WHERE id=?').run(Date.now()-1,s.id);await v.u.cleanup();assert.equal(await stored(v,key),false);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_files').get().n,0);
 const kept=await upload(v,'owner','kept'),p=await post(v,'owner',{file_ids:[kept.id]});const k2=v.db.sql.prepare('SELECT object_key FROM universe_post_files WHERE id=?').get(kept.id).object_key;
 v.db.sql.prepare('INSERT INTO universe_group_state VALUES(?,1,?) ON CONFLICT(group_id) DO UPDATE SET deleted=1').run(v.gid,Date.now());await v.u.cleanup();assert.equal(await stored(v,k2),false);void p;
});
test('3B a replayed upload does not store a second object',async()=>{
 const v=await fixture(),body={operation_id:crypto.randomUUID(),...await fileBody('once')};const a=await v.call('owner',v.base+'/community/files',body),b=await v.call('owner',v.base+'/community/files',body);assert.equal(a.id,b.id);
 assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_post_files').get().n,1);
});

// ---- 3C: Context, quota, retention ----
const ctxUpload=async(v,who,text,mime,name)=>v.post(who,'/context/files',await fileBody(text,mime,name));
test('3C Context: admins upload, everyone downloads, only with the owner’s active Pro; another member’s Pro does not count',async()=>{
 const v=await fixture();assert.equal((await v.call('owner','/universe/capabilities')).capabilities.context,true);
 await rejects(ctxUpload(v,'member','x'),'ROLE_DENIED');await rejects(ctxUpload(v,'admin','<b>','text/html','a.html'),'FILE_TYPE');
 const f=await ctxUpload(v,'admin','chapter one');const view=await v.get('member','/context');assert.equal(view.available,true);assert.equal(view.used,11);assert.equal(view.quota,200*1048576);assert.equal(view.can_upload,false);assert.deepEqual(view.files.map(x=>x.id),[f.id]);
 assert.equal(Buffer.from((await v.get('member','/context/files/'+f.id)).data,'base64').toString(),'chapter one');
 // Images in Context need only the owner's Pro (the Context is paid by the owner).
 await ctxUpload(v,'admin','img','image/png','a.png');
 v.pro.delete('owner');v.pro.add('admin');v.pro.add('member');
 const off=await v.get('member','/context');assert.equal(off.available,false);assert.deepEqual(off.files,[]);assert.ok(off.retention_until>Date.now()+89*86400000);
 await rejects(v.get('member','/context/files/'+f.id),'OWNER_PRO');await rejects(ctxUpload(v,'admin','more'),'OWNER_PRO');
 // Renewing restores access and the files are still there.
 v.pro.add('owner');const back=await v.get('member','/context');assert.equal(back.available,true);assert.equal(back.files.length,2);assert.equal(back.retention_until,null);
});
test('3C quota: 200 MB per Universe, checked before and inside the commit; deleting frees space and empties R2',async()=>{
 const v=await fixture();const a=await ctxUpload(v,'admin','first');
 v.db.sql.prepare('UPDATE universe_context_files SET bytes=? WHERE id=?').run(200*1048576-3,a.id);
 await rejects(ctxUpload(v,'admin','four'),'QUOTA');const ok=await ctxUpload(v,'admin','abc');assert.ok(ok.id);
 const big=await fileBody('x');big.size=10*1048576+1;await rejects(v.post('admin','/context/files',big),'FILE_SIZE');
 const key=v.db.sql.prepare('SELECT object_key FROM universe_context_files WHERE id=?').get(a.id).object_key;
 await rejects(v.post('member','/context/files/'+a.id+'/delete',{}),'ROLE_DENIED');await v.post('admin','/context/files/'+a.id+'/delete',{});
 assert.equal((await v.get('owner','/context')).used,3);await v.u.cleanup();assert.equal(await stored(v,key),false);
 // A replayed upload stores one object.
 const body={operation_id:crypto.randomUUID(),...await fileBody('again')};const x=await v.call('admin',v.base+'/context/files',body),y=await v.call('admin',v.base+'/context/files',body);assert.equal(x.id,y.id);assert.equal(v.db.sql.prepare("SELECT count(*) n FROM universe_context_files WHERE name='notes.pdf'").get().n,2);
});
test('3C retention: files are deleted 3 months after the owner’s lapse; a renewal then a new lapse starts a new period; transfer restores',async()=>{
 const v=await fixture(),f=await ctxUpload(v,'admin','keep me'),key=v.db.sql.prepare('SELECT object_key FROM universe_context_files WHERE id=?').get(f.id).object_key;
 v.pro.delete('owner');await v.get('member','/context');const lapse=v.db.sql.prepare("SELECT lapse_at FROM universe_lifecycle WHERE account_id='owner'").get().lapse_at;assert.ok(lapse);
 await v.u.cleanup();assert.equal(await stored(v,key),true);
 // Renewal clears the lapse; a later lapse gets its own 3 months.
 v.pro.add('owner');await v.get('member','/context');assert.equal(v.db.sql.prepare("SELECT lapse_at FROM universe_lifecycle WHERE account_id='owner'").get().lapse_at,null);
 v.pro.delete('owner');await v.get('member','/context');const second=v.db.sql.prepare("SELECT lapse_at FROM universe_lifecycle WHERE account_id='owner'").get().lapse_at;assert.ok(second>=lapse);
 v.db.sql.prepare("UPDATE universe_lifecycle SET lapse_at=?,checked_at=? WHERE account_id='owner'").run(Date.now()-90*86400000-1,Date.now());
 await v.u.cleanup();assert.equal(await stored(v,key),false);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_context_files').get().n,0);
});
test('3C retention notices a lapse during cleanup even if nobody opens the Universe',async()=>{
 const v=await fixture();await ctxUpload(v,'admin','quiet');v.db.sql.prepare("UPDATE universe_lifecycle SET checked_at=0 WHERE account_id='owner'").run();v.pro.delete('owner');
 await v.u.cleanup();assert.ok(v.db.sql.prepare("SELECT lapse_at FROM universe_lifecycle WHERE account_id='owner'").get().lapse_at);assert.equal(v.db.sql.prepare('SELECT count(*) n FROM universe_context_files').get().n,1);
});
test('3C posts while the owner is lapsed: existing posts stay, text posts work, images and files are refused, old images still download',async()=>{
 const v=await fixture();v.pro.add('admin');const img=await upload(v,'admin','png','image/png','a.png'),p=await post(v,'admin',{file_ids:[img.id]});
 v.pro.delete('owner');assert.equal((await v.get('member','/community')).posts[0].id,p.id);await post(v,'admin',{body:'Text still works'});
 await rejects(upload(v,'admin','png2','image/png','b.png'),'OWNER_PRO');assert.equal(Buffer.from((await v.get('member','/community/files/'+img.id)).data,'base64').toString(),'png');
});
test('Community class overrides only handle, availability and cleanup from the Universe chain',()=>{
 const own=Object.getOwnPropertyNames(UniverseCommunity.prototype).filter(n=>n!=='constructor');const parent=new Set();for(let p=Object.getPrototypeOf(UniverseCommunity.prototype);p&&p!==Object.prototype;p=Object.getPrototypeOf(p))for(const n of Object.getOwnPropertyNames(p))parent.add(n);
 assert.deepEqual(own.filter(n=>parent.has(n)).sort(),['availability','cleanup','handle']);
});

// Phase 7.2: Collab = a Universe group created from Friends, Pro for everyone. Real Universe rules on an in-memory D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {UniverseRules} from './universe-rules.js';
import {FriendsService} from '../friends-backend.js';

class D1{
 constructor(){this.sql=new DatabaseSync(':memory:');for(const f of ['universe-schema.sql','universe-phase2.sql','universe-phase3.sql','universe-phase4.sql','universe-phase5.sql','universe-phase6-7.sql','universe-phase9.sql'])this.sql.exec(readFileSync(new URL(f,import.meta.url),'utf8'));}
 withSession(){return this;}
 prepare(sql){const make=(values=[])=>({sql,values,bind:(...v)=>make(v),first:async()=>this.sql.prepare(sql).get(...values)||null,all:async()=>({results:this.sql.prepare(sql).all(...values)}),run:async()=>this.sql.prepare(sql).run(...values)});return make();}
 async batch(statements){this.sql.exec('BEGIN');try{const r=statements.map(s=>{const q=this.sql.prepare(s.sql);return q.columns().length?{results:q.all(...s.values)}:{meta:q.run(...s.values)};});this.sql.exec('COMMIT');return r;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
const ctx={};vm.runInNewContext(readFileSync(new URL('../points.js',import.meta.url),'utf8'),ctx);globalThis.TaskitatorPoints=ctx.TaskitatorPoints;

async function fixture(){
 const db=new D1(),map=new Map(),pro=new Set(['ana','ben','cy']);
 const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),transaction:async fn=>fn(storage)};
 const service={env:{UNIVERSE_FOUNDATION_ENABLED:'true',TASKITATOR_DB:db},storage,
  pro:{licenses:{resolve:async id=>({status:pro.has(id)?'active':'expired',tier:'pro',expires_at:pro.has(id)?null:Date.now()-1000})},credits:{refreshLicense:async()=>{},state:async()=>({ledger:{plan:'pro'}})}},
  ensureAlarm:async()=>{},deletion:{marker:async()=>null}};
 const u=new UniverseRules(service);service.universe=u;
 const f=new FriendsService(service);service.friends=f;
 const ids={};
 for(const id of ['ana','ben','cy','dee']){ids[id]={userId:id};map.set('identity:'+id,{user:id});map.set('account:'+id,{owner_id:id,version:0});
  map.set('pro:user:username:'+id,{username:id,normalizedUsername:id});map.set('pro:username:map:'+id,{accountId:id,username:id});}
 // ana is friends with ben and cy; dee is a stranger
 const rec=fr=>({v:1,friends:Object.fromEntries(fr.map(x=>[x,{since:1}])),out:{},in:{},blocked:{},cheers:[],cheered:{},privacy:'anyone',sent:[]});
 map.set('friends:ana',rec(['ben','cy']));map.set('friends:ben',rec(['ana']));map.set('friends:cy',rec(['ana']));
 const post=(who,action,body)=>f.handle(ids[who],'/friends/collab/'+action,'POST',body,{});
 return {db,map,pro,u,f,ids,post};
}
const err=(r,code)=>{assert.ok(r.__error,'expected an error');assert.equal(r.__error.code,code);};

test('create: friends only, Pro for everyone, then each friend accepts from Friends', async()=>{
 const v=await fixture();
 err(await v.post('ana','create',{title:'Thesis',ids:['dee']}),'COLLAB_NOT_FRIENDS');
 v.pro.delete('cy');
 err(await v.post('ana','create',{title:'Thesis',ids:['ben','cy']}),'COLLAB_PRO');
 v.pro.add('cy');
 const made=await v.post('ana','create',{title:'Thesis',ids:['ben','cy']});
 assert.ok(made.ok&&made.id);
 assert.equal(v.map.get('collab:'+made.id).owner,'ana');
 const benView=await v.f.handle(v.ids.ben,'/friends','GET',null,{});
 assert.equal(benView.collab_invites[0].title,'Thesis'); assert.equal(benView.collab_invites[0].username,'ana');
 assert.equal((await v.post('ben','accept',{id:made.id})).ok,true);
 assert.equal(v.db.sql.prepare('SELECT role FROM universe_members WHERE group_id=? AND account_id=?').get(made.id,'ben').role,'admin','friends can add work');
 const after=await v.f.handle(v.ids.ben,'/friends','GET',null,{});
 assert.equal(after.collab_invites.length,0); assert.equal(after.collabs[0].title,'Thesis'); assert.deepEqual(after.collabs[0].members,['ana']);
 assert.equal((await v.post('cy','decline',{id:made.id})).ok,true);
 assert.equal((await v.f.handle(v.ids.cy,'/friends','GET',null,{})).collab_invites.length,0);
 err(await v.post('cy','accept',{id:made.id}),'COLLAB_GONE');
});

test('accept needs Pro; inside a collab every change needs Pro for every member', async()=>{
 const v=await fixture();
 const made=await v.post('ana','create',{title:'Duo',ids:['ben']});
 v.pro.delete('ben');
 err(await v.post('ben','accept',{id:made.id}),'COLLAB_PRO');
 v.pro.add('ben');
 await v.post('ben','accept',{id:made.id});
 const base='/universe/groups/'+made.id;
 assert.equal(await v.f.gate(v.ids.ana,base+'/work/projects','POST',{}),null);
 v.pro.delete('ben');
 const blocked=await v.f.gate(v.ids.ana,base+'/work/projects','POST',{});
 assert.equal(blocked.code,'COLLAB_PRO'); assert.equal(blocked.status,403);
 assert.equal(await v.f.gate(v.ids.ana,base+'/work','GET',{}),null,'reading stays open');
 assert.equal(await v.f.gate(v.ids.ben,base+'/leave','POST',{}),null,'leaving stays open');
 assert.equal(await v.f.gate(v.ids.ben,base+'/consent','POST',{enabled:false}),null,'withdrawing phone-blocking consent stays open');
 assert.ok(await v.f.gate(v.ids.ben,base+'/consent','POST',{enabled:true}));
 // Ordinary Universes are untouched
 assert.equal(await v.f.gate(v.ids.ana,'/universe/groups/uni_other/work/projects','POST',{}),null);
});

test('limits: 1 to 5 friends and a name', async()=>{
 const v=await fixture();
 err(await v.post('ana','create',{title:'',ids:['ben']}),'COLLAB_TITLE');
 err(await v.post('ana','create',{title:'X',ids:[]}),'COLLAB_MEMBERS');
 err(await v.post('ana','create',{title:'X',ids:['a','b','c','d','e','f']}),'COLLAB_MEMBERS');
});

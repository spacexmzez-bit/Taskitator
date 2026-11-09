import test from 'node:test';import assert from 'node:assert/strict';
import './worker.js';
import {TaskProtection} from './pro-backend.js';
const E=globalThis.TaskitatorEarly,S=globalThis.TaskitatorSmartStudy,C=globalThis.TaskitatorStudyCore;
const T=(id,due,extra={})=>({id,title:id,status:'active',due_date:due,is_bonus:false,...extra});
const today='2026-11-09',clone=x=>structuredClone(x);
test('early: set keeps the due date and skips ineligible tasks with a reason',()=>{
 const tasks=[T('a','2026-11-12'),T('b','2026-11-09'),T('c','2026-11-12',{status:'completed'}),T('d','2026-11-12',{recurrence_series_id:'x'}),T('e','',{}),T('f','2026-11-12',{smart_early_date:'2026-11-10'})];
 const r=E.set(tasks,tasks.map(t=>t.id),'2026-11-10',today);
 assert.deepEqual(r.set,['a']);assert.equal(tasks[0].due_date,'2026-11-12');assert.equal(tasks[0].early_date,'2026-11-10');
 assert.equal(r.skipped.length,5);assert.ok(r.skipped.every(x=>x.reason));
 assert.equal(E.set([T('p','2026-11-12')],['p'],'2026-11-08',today).skipped[0].reason,'The early date cannot be in the past.');
 assert.equal(E.set([T('p','2026-11-12')],['p'],'2026-11-12',today).set.length,0);
});
test('early: subtask rides under a selected eligible parent; inherited due dates work',()=>{
 const tasks=[T('p','2026-11-12'),T('k','',{parent_id:'p'}),T('lone','',{parent_id:'nodate'}),T('nodate','')];
 const r=E.set(tasks,['p','k'],'2026-11-10',today);
 assert.deepEqual(r.set,['p']);assert.deepEqual(r.covered,['k']);assert.equal(tasks[1].early_date,undefined);
 const solo=E.set(tasks,['k'],'2026-11-11',today);assert.deepEqual(solo.set,['k']);
 assert.equal(E.set(tasks,['lone'],'2026-11-10',today).skipped[0].reason,'The task has no due date.');
});
test('early: today view is optional copy; real task, shield and bonus flag untouched',()=>{
 const tasks=[T('a','2026-11-12',{early_date:today,strict_prerequisites:true,ai_locked:true}),T('b','2026-11-12',{early_date:today,is_bonus:true}),T('c','2026-11-12',{early_date:'2026-11-10'})];
 const v=E.view(tasks,today);
 assert.equal(v[0].due_date,today);assert.equal(v[0].is_bonus,true);assert.equal(v[0].early_due,'2026-11-12');assert.equal(v[0].early_bonus,false);assert.equal(v[0].strict_prerequisites,true);assert.equal(v[0].ai_locked,true);
 assert.equal(v[1].early_bonus,true);assert.equal(v[2],tasks[2]);
 assert.equal(tasks[0].due_date,'2026-11-12');assert.equal(tasks[0].is_bonus,false);
 const moved=[T('a','2026-11-09',{early_date:today})];assert.equal(E.view(moved,today)[0],moved[0]); // due date caught up: no phantom bonus
});
test('early: calendar appearance only while valid',()=>{
 const by=E.index([T('a','2026-11-12',{early_date:'2026-11-10'}),T('b','2026-11-12',{early_date:'2026-11-08'}),T('c','2026-11-12',{early_date:'2026-11-10',status:'completed'})]);
 assert.equal(E.appearance(by,by.get('a'),today),'2026-11-10');assert.equal(E.appearance(by,by.get('b'),today),null);assert.equal(E.appearance(by,by.get('c'),today),null);
});
test('early: clear removes only the early date',()=>{const t=[T('a','2026-11-12',{early_date:'2026-11-10'})];assert.equal(E.clear(t,['a']),1);assert.equal(t[0].early_date,undefined);assert.equal(t[0].due_date,'2026-11-12');});
test('early: Worker guard validates changed dates and allows clearing',()=>{
 const prev={tasks:[T('a','2026-11-12',{early_date:'2026-11-10'}),T('b','2026-11-12')]};
 const ok=clone(prev);ok.tasks[1].early_date='2026-11-11';E.guard(prev,ok);
 const cleared=clone(prev);delete cleared.tasks[0].early_date;E.guard(prev,cleared);
 for(const bad of [['2026-11-12'],['2026-11-13'],['nope'],[null]]){const n=clone(prev);n.tasks[1].early_date=bad[0];assert.throws(()=>E.guard(prev,n));}
 const rec=clone(prev);rec.tasks[1].early_date='2026-11-10';rec.tasks[1].recurrence_series_id='s';assert.throws(()=>E.guard(prev,rec));
 const smart=clone(prev);smart.tasks[1].early_date='2026-11-10';smart.tasks[1].smart_early_date='2026-11-10';assert.throws(()=>E.guard(prev,smart));
 const done=clone(prev);done.tasks[1].early_date='2026-11-10';done.tasks[1].status='completed';assert.throws(()=>E.guard(prev,done));
 E.guard(prev,prev); // untouched existing dates are not revalidated
});
test('early: Worker apply drops expired, finished and caught-up appearances only',()=>{
 const time=Date.parse('2026-11-09T12:00Z'),snap={settings:{},tasks:[T('a','2026-11-12',{early_date:'2026-11-10'}),T('b','2026-11-12',{early_date:'2026-11-08'}),T('c','2026-11-12',{early_date:'2026-11-10',status:'completed'}),T('d','2026-11-10',{early_date:'2026-11-10'})]};
 E.apply(snap,time);
 assert.equal(snap.tasks[0].early_date,'2026-11-10');assert.equal(snap.tasks[1].early_date,undefined);assert.equal(snap.tasks[2].early_date,undefined);assert.equal(snap.tasks[3].early_date,undefined);
 assert.equal(snap.tasks[1].due_date,'2026-11-12');
});
test('early: Pro is required to add or change, never to clear',async()=>{
 const g=new TaskProtection({storage:{}}),prev={tasks:[T('a','2026-11-12',{early_date:'2026-11-10'}),T('b','2026-11-12')]};
 const pro={status:'active',tier:'pro',account_id:'u1',keyo_version:1,signed_token:'x',valid_until:Date.now()+1e6,expires_at:null};
 const tx=e=>({get:async()=>e}),add=clone(prev);add.tasks[1].early_date='2026-11-11';
 await assert.rejects(g.guardEarly(tx(null),'u1',prev,add),{code:'PRO_REQUIRED'});
 await assert.rejects(g.guardEarly(tx({...pro,status:'expired'}),'u1',prev,add),{code:'PRO_REQUIRED'});
 await assert.rejects(g.guardEarly(tx(pro),'u1',prev,add,new Error('keyo down')),{message:'keyo down'});
 await g.guardEarly(tx(pro),'u1',prev,add);
 const clear=clone(prev);delete clear.tasks[0].early_date;await g.guardEarly(tx(null),'u1',prev,clear);
 await g.guardEarly(tx(null),'u1',prev,prev);
});
test('early: study units can use it; Smart Study never moves an early-dated unit',()=>{
 const cfg={title:'Math',total:8,days:4,start:'2026-11-02',weekdays:[],counts:[2,2,2,2]};
 const tasks=C.build({...cfg,smart:{mode:'dates',dates:['2026-11-05'],appearances:[{unit:3,date:'2026-11-02'}]}},'plan_abcdefgh','2026-11-01T00:00:00Z');
 const unit=tasks.find(t=>t.title==='Chapter.7'),smartUnit=tasks.find(t=>t.title==='Chapter.3');
 const r=E.set(tasks,[unit.id,smartUnit.id],'2026-11-02','2026-11-02');
 assert.deepEqual(r.set,[unit.id]);assert.match(r.skipped[0].reason,/Smart Study/);
 const run=withEarly=>{const before=clone(tasks),next=clone(tasks);next.find(t=>t.id===smartUnit.id).status='completed';const u=next.find(t=>t.title==='Chapter.7');if(withEarly)u.early_date='2026-11-03';S.apply({tasks:next,settings:{}},{tasks:before},Date.parse('2026-11-02T12:00Z'));return next.filter(t=>t.smart_moved_from);};
 assert.equal(run(false).length,1); // control: Smart Study does move a unit into the freed slot
 assert.ok(run(true).every(t=>t.title!=='Chapter.7'));
});

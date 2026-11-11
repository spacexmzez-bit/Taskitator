import test from 'node:test';import assert from 'node:assert/strict';
import './worker.js';
const C=globalThis.TaskitatorStudyCore,M=globalThis.TaskitatorStudyManage;
// Mon 9 Nov 2026 .. Thu 12 Nov, then Sun 15 Nov: 2 lessons a day, 10 in total.
const cfg={title:'Bio',unit:'L',plural:'Ls',total:10,days:5,first:1,start:'2026-11-09',weekdays:[],counts:[2,2,2,2,2],dates:['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-15']};
const CREATED='2026-11-01T00:00:00.000Z',cache=new Map();
const plan=(audit=false)=>{if(!cache.has(audit))cache.set(audit,C.build(cfg,'plan_soft_unit',CREATED,audit,audit?'Notes {num}':''));return structuredClone(cache.get(audit));};
const TODAY='2026-11-11';
const run=(o,tasks=plan(),today=TODAY)=>M.softReschedule(tasks,'plan_soft_unit',{rev:'abcd',...o},today);
const layout=tasks=>{const by=new Map(tasks.map(t=>[t.id,t])),o={};for(const t of tasks)if(t.parent_id){const d=by.get(t.parent_id).due_date;(o[d]??=[]).push(M.unitNumber(t));}for(const k of Object.keys(o))o[k].sort((a,b)=>a-b);return o;};
test('soft reschedule: Max hands overdue out in rounds and the plan stays consecutive',()=>{
 const r=run({mode:'spread',scope:'max'});
 assert.deepEqual(layout(r.tasks),{'2026-11-11':[1,2,3,4],'2026-11-12':[5,6,7],'2026-11-15':[8,9,10]});
 assert.equal(M.softCheck(plan(),r.tasks,'plan_soft_unit',TODAY,'spread'),null);assert.equal(r.overdue,4);
});
test('soft reschedule: a shorter period leaves later days alone; a day never drops below what it had',()=>{
 assert.deepEqual(layout(run({mode:'spread',scope:'until',until:'2026-11-12'}).tasks),{'2026-11-11':[1,2,3,4],'2026-11-12':[5,6,7,8],'2026-11-15':[9,10]});
 assert.deepEqual(layout(run({mode:'spread',scope:'dates',dates:['2026-11-11','2026-11-15']}).tasks),{'2026-11-11':[1,2,3,4],'2026-11-12':[5,6],'2026-11-15':[7,8,9,10]});
});
test('soft reschedule: input is not mutated; titles, criteria and shield stay on every unit',()=>{
 const tasks=plan(true),copy=JSON.stringify(tasks),r=run({mode:'spread',scope:'max'},tasks);
 assert.equal(JSON.stringify(tasks),copy);
 const was=new Map(tasks.map(t=>[t.id,t]));
 for(const u of r.tasks.filter(t=>t.parent_id))for(const k of ['title','raw_title','proof_criteria','ai_locked','strict_prerequisites'])assert.equal(u[k],was.get(u.id)[k]);
 assert.ok(r.locked.length>0);
 const days=r.tasks.filter(t=>!t.parent_id);
 assert.ok(days.find(d=>d.due_date==='2026-11-11').description.includes('1 to 4'));
 assert.ok(days.find(d=>d.due_date==='2026-11-12').description.includes('5 to 7'));
});
test('soft reschedule: rules and errors',()=>{
 assert.throws(()=>run({mode:'spread',scope:'dates',dates:['2026-11-12','2026-11-15']}),/Today is a study day/);
 assert.throws(()=>run({mode:'spread',scope:'dates',dates:['2026-11-11','2026-12-30']}),/belong to this plan/);
 assert.throws(()=>run({mode:'spread',scope:'until',until:'2026-11-10'}),/No plan day/);
 assert.throws(()=>run({mode:'spread'}),/Max, a period/);assert.throws(()=>run({mode:'x'}),/how to reschedule/);
 assert.throws(()=>run({mode:'spread',scope:'max'},plan(),'2026-11-09'),/Nothing is overdue/);
 assert.throws(()=>M.softReschedule(plan(),'plan_soft_unit',{rev:'!',mode:'today'},TODAY),/identifier/);
});
test('soft reschedule: finished units stay put and are not counted as overdue',()=>{
 const done=plan().map(t=>t.parent_id&&['L.1','L.2'].includes(t.title)?{...t,status:'completed',completed_at:'2026-11-09T09:00:00Z'}:t);
 const r=run({mode:'spread',scope:'max'},done);
 assert.equal(r.overdue,2);assert.deepEqual(layout(r.tasks),{'2026-11-09':[1,2],'2026-11-11':[3,4,5],'2026-11-12':[6,7,8],'2026-11-15':[9,10]});
 assert.equal(M.softCheck(done,r.tasks,'plan_soft_unit',TODAY,'spread'),null);
});
test('soft reschedule: move overdue to today stacks only the overdue units; softCheck catches bad results',()=>{
 const r=run({mode:'today'});assert.deepEqual(layout(r.tasks),{'2026-11-11':[1,2,3,4,5,6],'2026-11-12':[7,8],'2026-11-15':[9,10]});
 const bad=structuredClone(run({mode:'spread',scope:'max'}).tasks),u=bad.find(t=>t.parent_id);u.title='Renamed';
 assert.match(M.softCheck(plan(),bad,'plan_soft_unit',TODAY,'spread'),/beyond its day/);
 const spread=run({mode:'spread',scope:'max'}).tasks,late=structuredClone(spread);late.find(t=>t.parent_id&&t.due_date==='2026-11-15').due_date='2026-11-30';
 assert.match(M.softCheck(plan(),late,'plan_soft_unit',TODAY,'spread'),/end moved later/);
 const short=structuredClone(spread);for(const u of short.filter(t=>t.parent_id&&t.due_date==='2026-11-15').slice(0,2))u.due_date='2026-11-12';
 assert.match(M.softCheck(plan(),short,'plan_soft_unit',TODAY,'spread'),/lost units/);
 const gone=r.tasks.filter(t=>!t.id.endsWith('_unit_3'));assert.match(M.softCheck(plan(),gone,'plan_soft_unit',TODAY,'today'),/unit list changed/);
});

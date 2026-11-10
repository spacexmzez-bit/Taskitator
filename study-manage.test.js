import test from 'node:test';import assert from 'node:assert/strict';
import './worker.js';
const C=globalThis.TaskitatorStudyCore,M=globalThis.TaskitatorStudyManage;
const cfg={title:'Biology',unit:'Chapter',plural:'Chapters',total:6,days:3,first:1,start:'2026-11-09',weekdays:[],parent_priority:'prio_high',unit_priority:'prio_med'};
const build=(audit=false)=>C.build(cfg,'plan_manage_1',new Date().toISOString(),audit,audit?'Show notes for chapter {num}.':'');
const finish=(tasks,...ids)=>tasks.map(t=>ids.includes(t.id)?{...t,status:'completed',completed_at:'2026-11-09T10:00:00.000Z'}:t);
test('plans: derives name, unit, plural, progress, dates and priorities from the tasks',()=>{
 const tasks=finish(build(),'study_plan_manage_1_unit_1','study_plan_manage_1_unit_2');
 const [p]=M.plans(tasks);
 assert.equal(p.id,'plan_manage_1');assert.equal(p.base,'Biology');assert.equal(p.unit,'Chapter');assert.equal(p.plural,'chapters');
 assert.deepEqual([p.total,p.done,p.remaining,p.days,p.audited],[6,2,4,3,0]);assert.equal(p.start,'2026-11-09');assert.equal(p.end,'2026-11-11');
 assert.equal(p.parentPriority,'prio_high');assert.equal(p.unitPriority,'prio_med');assert.equal(p.finished,false);
 assert.equal(M.plans(finish(build(),...build().filter(t=>t.parent_id).map(t=>t.id)))[0].finished,true);
 assert.equal(M.plans([{id:'x',title:'Plain'}]).length,0,'ordinary tasks are not plans');
});
test('rename plan: every day parent follows; custom titles stay',()=>{
 const tasks=build(),custom=tasks.map(t=>t.id==='study_plan_manage_1_day_1'?{...t,title:'Exam week',raw_title:'Exam week'}:t);
 const r=M.renamePlan(tasks,'plan_manage_1','Zoology');
 assert.deepEqual(r.tasks.filter(t=>!t.parent_id).map(t=>t.title),['Zoology 1','Zoology 2','Zoology 3']);assert.equal(r.changed,3);
 assert.deepEqual(tasks.filter(t=>!t.parent_id).map(t=>t.title),['Biology 1','Biology 2','Biology 3'],'input is not mutated');
 assert.equal(M.renamePlan(custom,'plan_manage_1','Zoology').changed,2);
 assert.throws(()=>M.renamePlan(tasks,'plan_manage_1','  '));assert.throws(()=>M.renamePlan(tasks,'plan_manage_1','x'.repeat(161)));assert.throws(()=>M.renamePlan(tasks,'missing','Zoology'));
});
test('rename unit: titles, raw titles and the "Covers" line change together',()=>{
 const r=M.renameUnit(build(),'plan_manage_1','Lesson','Lessons');
 const units=r.tasks.filter(t=>t.parent_id);assert.deepEqual(units.map(t=>t.title),['Lesson.1','Lesson.2','Lesson.3','Lesson.4','Lesson.5','Lesson.6']);
 assert.equal(units[0].raw_title,'Lesson.{num==1}');
 assert.deepEqual(r.tasks.filter(t=>!t.parent_id).map(t=>t.description),['Covers lessons 1 to 2','Covers lessons 3 to 4','Covers lessons 5 to 6']);
 assert.equal(M.renamePlan(r.tasks,'plan_manage_1','X').changed,3,'still a plan after renaming');
 assert.equal(M.plans(r.tasks)[0].unit,'Lesson');
 for(const bad of ['','{num}','x'.repeat(41)])assert.throws(()=>M.renameUnit(build(),'plan_manage_1',bad,''));
 assert.equal(M.renameUnit(build(),'plan_manage_1','Study','').tasks.find(t=>!t.parent_id).description,'Covers studys 1 to 2','plural defaults to unit + s');
});
test('rename unit: an audited plan needs bypass',()=>{
 const audited=build(true);
 assert.throws(()=>M.renameUnit(audited,'plan_manage_1','Lesson','Lessons'),/Emergency Bypass/);
 assert.equal(M.renameUnit(audited,'plan_manage_1','Lesson','Lessons',{bypass:true}).changed,6);
});
test('priorities: unit never above parent; unfinished tasks only',()=>{
 const tasks=finish(build(),'study_plan_manage_1_unit_1');
 const r=M.setPriorities(tasks,'plan_manage_1',{parent:'prio_med',unit:'prio_low'},{});
 const byId=Object.fromEntries(r.tasks.map(t=>[t.id,t]));
 assert.equal(byId.study_plan_manage_1_unit_1.priority_id,'prio_med','a completed unit keeps its priority');
 assert.equal(byId.study_plan_manage_1_unit_2.priority_id,'prio_low');assert.equal(byId.study_plan_manage_1_day_0.priority_id,'prio_med');
 assert.throws(()=>M.setPriorities(tasks,'plan_manage_1',{parent:'prio_low',unit:'prio_high'},{}),/higher priority/);
 assert.throws(()=>M.setPriorities(tasks,'plan_manage_1',{parent:null,unit:'prio_high'},{}),/higher priority/,'no priority is the lowest');
 assert.throws(()=>M.setPriorities(tasks,'plan_manage_1',{parent:'ghost',unit:null},{}),/Choose one/);
 const custom={custom_priorities:[{id:'a',rank:1},{id:'b',rank:2}]};
 assert.equal(M.setPriorities(tasks,'plan_manage_1',{parent:'a',unit:'b'},custom).changed>0,true);
 const cleared=M.setPriorities(tasks,'plan_manage_1',{parent:null,unit:null},{});assert.equal(cleared.tasks.find(t=>t.id==='study_plan_manage_1_unit_2').priority_id,undefined);
});
test('add criteria: only plans without criteria, only unfinished units, {num} filled in',()=>{
 const tasks=finish(build(),'study_plan_manage_1_unit_1');
 const r=M.addCriteria(tasks,'plan_manage_1','Show notes for chapter {num}.',[1,2,3]);
 const units=Object.fromEntries(r.tasks.filter(t=>t.parent_id).map(t=>[t.id,t]));
 assert.equal(r.changed,2,'unit 1 is completed and cannot be audited');assert.equal(units.study_plan_manage_1_unit_1.ai_locked,false);
 assert.equal(units.study_plan_manage_1_unit_2.ai_locked,true);assert.equal(units.study_plan_manage_1_unit_2.proof_criteria,'Show notes for chapter 2.');
 assert.equal(units.study_plan_manage_1_unit_2.raw_proof_criteria,'Show notes for chapter {num}.');assert.equal(units.study_plan_manage_1_unit_4.ai_locked,false,'unselected units stay unaudited');
 assert.deepEqual(M.openUnits(M.plans(tasks)[0]),[2,3,4,5,6]);
 assert.throws(()=>M.addCriteria(r.tasks,'plan_manage_1','Again {num}',[4]),/already has AI criteria/);
 assert.throws(()=>M.addCriteria(tasks,'plan_manage_1','',[2]));assert.throws(()=>M.addCriteria(tasks,'plan_manage_1','Bad {oops}',[2]),/Only \{num\}/);
 assert.throws(()=>M.addCriteria(tasks,'plan_manage_1','Fine {num}',[1]),/at least one/);
});
test('delete plan: tasks go, completed ones stay counted in history, subtasks under units go too',()=>{
 let tasks=finish(build(),'study_plan_manage_1_unit_1','study_plan_manage_1_unit_2');
 tasks.push({id:'manual_sub',parent_id:'study_plan_manage_1_unit_3',title:'Extra',status:'active'},{id:'plain',title:'Unrelated',status:'completed'});
 const state={series:[],history:[{id:'old',outcome:'completed',tasks:[]}]};
 const r=M.deletePlan(tasks,state,'plan_manage_1','2026-11-12T08:00:00.000Z');
 assert.deepEqual(r.tasks.map(t=>t.id),['plain']);assert.equal(r.removed,10);assert.equal(r.completed,2);
 const ev=r.state.history.find(h=>h.id==='study_plan:plan_manage_1');assert.equal(ev.outcome,'completed');assert.equal(ev.tasks.length,2);
 assert.ok(ev.tasks.every(t=>t.status==='completed'&&t.completed_at));assert.equal(r.state.history.length,2,'existing history kept');
 assert.equal(state.history.length,1,'input state is not mutated');
 const none=M.deletePlan(build(),{series:[],history:[]},'plan_manage_1');assert.equal(none.state.history.length,0,'nothing completed, nothing to count');
 assert.throws(()=>M.deletePlan(build(),state,'missing'));
});
// ---- Phase 2.4b: re-plan ----
const ID='plan_manage_1',opts=o=>({rev:'rp01',start:'2026-11-20',mode:'perDay',per:2,weekdays:[],...o});
const units=r=>r.tasks.filter(t=>t.parent_id&&t.study_plan_id).sort((a,b)=>M.unitNumber(a)-M.unitNumber(b));
test('re-plan: only unfinished units move; completed units and their day stay; empty days go',()=>{
 const tasks=finish(build(),'study_plan_manage_1_unit_1','study_plan_manage_1_unit_3');
 const r=M.replan(tasks,ID,opts());
 assert.deepEqual([r.scheduled,r.removed,r.days],[4,0,2]);assert.deepEqual(r.dates,['2026-11-20','2026-11-21']);
 const u=new Map(r.tasks.map(t=>[t.id,t]));
 assert.equal(u.get('study_plan_manage_1_unit_1').parent_id,'study_plan_manage_1_day_0','completed unit untouched');
 assert.equal(u.get('study_plan_manage_1_unit_1').due_date,'2026-11-09');
 assert.equal(u.get('study_plan_manage_1_day_0').description,'Covers chapters 1','kept day covers what is left');
 assert.equal(u.get('study_plan_manage_1_day_2'),undefined,'a day with only moved units is removed');
 assert.deepEqual(units(r).filter(t=>t.status==='active').map(t=>[M.unitNumber(t),t.due_date]),[[2,'2026-11-20'],[4,'2026-11-20'],[5,'2026-11-21'],[6,'2026-11-21']]);
 const fresh=r.tasks.filter(t=>t.id.includes('_rp01_day_'));assert.deepEqual(fresh.map(t=>t.title),['Biology 3','Biology 4'],'numbering continues after kept days');
 assert.ok(fresh.every(t=>t.strict_prerequisites&&t.priority_id==='prio_high'&&t.study_plan_id===ID));
 assert.equal(fresh[0].description,'Covers chapters 2, 4');
 assert.equal(M.plans(r.tasks)[0].done,2,'progress unchanged');
 assert.deepEqual(M.replan(tasks,ID,opts()).tasks,r.tasks,'deterministic');
});
test('re-plan: starting unit and skipped units drop unfinished units with everything under them',()=>{
 const tasks=[...build(),{id:'child_of_2',parent_id:'study_plan_manage_1_unit_2',title:'Extra',status:'active'}];
 const r=M.replan(tasks,ID,opts({start_unit:3,skipped:[5]}));
 assert.deepEqual([r.scheduled,r.removed],[3,3]);
 assert.deepEqual(units(r).map(M.unitNumber),[3,4,6]);assert.equal(r.tasks.some(t=>t.id==='child_of_2'),false);
 assert.throws(()=>M.replan(build(),ID,opts({start_unit:7})),/Delete the plan/);
});
test('re-plan: modes, weekdays and per-date counts (Option A keeps the total)',()=>{
 assert.deepEqual(M.replan(build(),ID,opts({mode:'days',days:4})).counts,[2,2,1,1]);
 assert.deepEqual(M.replan(build(),ID,opts({weekdays:[1]})).dates,['2026-11-23','2026-11-30','2026-12-07'],'Mondays only');
 assert.deepEqual(M.replan(build(),ID,opts({rates:{5:4}})).counts,[4,2],'Friday takes 4');
 assert.deepEqual(M.replan(build(),ID,opts({counts:[1,3,2]})).counts,[1,3,2]);
 assert.throws(()=>M.replan(build(),ID,opts({counts:[1,3]})),/add up to 6/);
 assert.deepEqual(M.adjustCounts([2,2,2],0,1),[3,2,1]);assert.deepEqual(M.adjustCounts([2,2,1],0,1),[3,2],'last day emptied');
 assert.deepEqual(M.adjustCounts([2,2,2],0,-1),[1,2,3]);assert.deepEqual(M.adjustCounts([2,2,2],2,-1),[2,2,1,1],'last day pushes into a new day');
 assert.throws(()=>M.adjustCounts([2,2],1,1));assert.throws(()=>M.adjustCounts([1,2],0,-1));
 for(const bad of [{rev:'X'},{start:'2026-02-30'},{mode:'days',days:0},{weekdays:[9]},{counts:[0,6]}])assert.throws(()=>M.replan(build(),ID,opts(bad)));
});
test('re-plan: Smart Study plans are refused; early dates that would fall on or after the new date are cleared',()=>{
 const smart=build().map(t=>t.id==='study_plan_manage_1_unit_6'?{...t,smart_early_date:'2026-11-09'}:t);
 assert.throws(()=>M.replan(smart,ID,opts()),/Smart Study/);
 const early=build().map(t=>t.id==='study_plan_manage_1_unit_1'?{...t,early_date:'2026-11-25'}:t.id==='study_plan_manage_1_unit_2'?{...t,early_date:'2026-11-15'}:t);
 const r=new Map(M.replan(early,ID,opts()).tasks.map(t=>[t.id,t]));
 assert.equal(r.get('study_plan_manage_1_unit_1').early_date,undefined);assert.equal(r.get('study_plan_manage_1_unit_2').early_date,'2026-11-15');
});
test('re-plan impact: AI units later or removed; counting work due today moved off today',()=>{
 const ai=build(true),later=M.replan(ai,ID,opts()),earlier=M.replan(ai,ID,opts({start:'2026-11-09',per:6}));
 assert.equal(M.replanImpact(ai,later.tasks,ID,'2026-11-01',{}).later.length,6);
 assert.equal(M.replanImpact(ai,earlier.tasks,ID,'2026-11-01',{}).later.length,0);
 assert.equal(M.replanImpact(ai,M.replan(ai,ID,opts({start:'2026-11-09',per:6,skipped:[6]})).tasks,ID,'2026-11-01',{}).later.length,1,'removal counts');
 const plain=build(),today='2026-11-09';
 assert.deepEqual(M.replanImpact(plain,M.replan(plain,ID,opts({start:today,per:6})).tasks,ID,today,{}).today,[],'pulling into today is fine');
 assert.deepEqual(M.replanImpact(plain,M.replan(plain,ID,opts({start:'2026-11-10'})).tasks,ID,today,{}).today.sort(),['study_plan_manage_1_unit_1','study_plan_manage_1_unit_2']);
 assert.deepEqual(M.replanImpact(plain,M.replan(plain,ID,opts({start:'2026-11-10'})).tasks,ID,today,{status_mode:'limited'}).today,[],'Limited: non-AI work does not count');
});

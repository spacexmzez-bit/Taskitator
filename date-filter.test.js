import test from 'node:test';import assert from 'node:assert/strict';
import './worker.js';
import './date-filter.js';
const F=globalThis.TaskitatorDateFilter,today='2026-11-09';
const T=(id,due,extra={})=>({id,title:id,status:'active',due_date:due,...extra});
const tasks=[T('over','2026-11-01'),T('now','today'),T('soon','2026-11-14'),T('late','2026-12-20'),T('none',''),T('kid','',{parent_id:'soon'}),T('early','2026-11-20',{early_date:'2026-11-10'})];
const ids=f=>[...F.visible(tasks,today,f)].sort();
test('date filter: quick picks match the effective due date, early date included',()=>{
 assert.equal(F.active({mode:''}),false);assert.equal(F.active({mode:'range'}),false);
 assert.deepEqual(ids({mode:'overdue'}),['over']);assert.deepEqual(ids({mode:'today'}),['now']);
 assert.deepEqual(ids({mode:'week'}),['early','kid','now','soon']);assert.deepEqual(ids({mode:'none'}),['none']);
});
test('date filter: custom range is inclusive, open-ended and order-tolerant; ancestors kept',()=>{
 assert.deepEqual(ids({mode:'range',from:'2026-12-01'}),['late']);assert.deepEqual(ids({mode:'range',from:'2026-11-20',to:'2026-11-14'}),['early','kid','soon']);
 const nested=[T('p','2026-12-20'),T('c','2026-11-10',{parent_id:'p'})];assert.deepEqual([...F.visible(nested,today,{mode:'week'})].sort(),['c','p']);
 assert.equal(tasks[1].due_date,'today');
});

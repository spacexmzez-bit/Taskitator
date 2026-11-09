import test from 'node:test';import assert from 'node:assert/strict';
import './worker.js';
const C=globalThis.TaskitatorStudyCore;
test('study: units per day splits whole numbers, remainder last',()=>{
 assert.deepEqual(C.perDay(20,6),[6,6,6,2]);assert.deepEqual(C.perDay(20,5),[5,5,5,5]);assert.deepEqual(C.perDay(7,7),[7]);assert.deepEqual(C.perDay(1,1),[1]);
 for(const bad of [0,-1,2.5,NaN])assert.throws(()=>C.perDay(20,bad));
 assert.throws(()=>C.perDay(20,21),/cannot exceed/);assert.throws(()=>C.perDay(1000,2),/needs 500 study days/);
 const plan=C.normalize({title:'M',total:20,days:4,counts:C.perDay(20,6),start:'2026-11-02'});assert.equal(C.rows(plan).length,4);
});
test('study: skip parser takes real unit numbers, lists, ranges and Arabic digits; all or nothing',()=>{
 assert.deepEqual(C.parseSkips('8',5,20),[8]);assert.deepEqual(C.parseSkips('8, 12 15',5,20),[8,12,15]);assert.deepEqual(C.parseSkips('8-10, 12',5,20),[8,9,10,12]);
 assert.deepEqual(C.parseSkips('٨، ١٠–١١',5,20),[8,10,11]);assert.deepEqual(C.parseSkips('8-10',5,20,[9]),[8,10]);
 assert.throws(()=>C.parseSkips('8, 30',5,20),/30 is outside this plan \(5–24\)/);assert.throws(()=>C.parseSkips('10-8',5,20),/not a valid range/);
 assert.throws(()=>C.parseSkips('4',5,20),/outside/);assert.throws(()=>C.parseSkips('x',5,20),/not a unit number/);assert.throws(()=>C.parseSkips('  ',5,20));
 assert.deepEqual(C.parseSkips('25',5,20,[6]),[25]); // each existing skip extends the plan by one unit
});
test('study: calculator uses precedence and rejects bad input without eval',()=>{
 assert.equal(C.calculate('2+3×4'),14);assert.equal(C.calculate('20÷6'),3.3333333333);assert.equal(C.calculate('−5+2'),-3);assert.equal(C.calculate('10−2−3'),5);assert.equal(C.calculate('0.1+0.2'),0.3);
 for(const bad of ['','5+','×5','5÷0','1++2'])assert.throws(()=>C.calculate(bad));
});

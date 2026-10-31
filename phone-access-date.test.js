import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('./settings.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function phoneChangeAllowed()'),html.indexOf('async function refreshPhoneStatus()'));
function allowed(tasks,{onBreak=false,bypass=false}={}){
 let alerts=0;
 const context=vm.createContext({window:{TaskitatorEngine:{BreakEngine:{isCurrentlyOnBreak:()=>onBreak},EmergencyManager:{isBypassActive:()=>bypass}}},localStorage:{getItem:()=>JSON.stringify(tasks)},getAppTodayStr:()=> '2026-10-31',alert:()=>alerts++});
 vm.runInContext(source,context);const result=context.phoneChangeAllowed();assert.equal(alerts,result?0:1);return result;
}
const task=(id,parent_id,due_date,status='active')=>({id,parent_id,due_date,status});
test('Phone token gate follows parent moves for undated children and grandchildren',()=>{
 const tasks=[task('p',null,'2026-11-01'),task('c','p',''),task('g','c',null)];
 assert.equal(allowed(tasks),true);tasks[0].due_date='2026-10-31';assert.equal(allowed(tasks),false);tasks[0].due_date='2026-11-02';assert.equal(allowed(tasks),true);
});
test('Phone token gate respects explicit child date and completed parents',()=>{
 const tasks=[task('p',null,'2026-11-01','completed'),task('c','p','today')];assert.equal(allowed(tasks),false);tasks[1].due_date='';assert.equal(allowed(tasks),true);
 const nested=[task('p',null,'today','completed'),task('c','p','2026-11-01'),task('g','c','')];assert.equal(allowed(nested),true);
});
test('Phone token gate retains standalone, overdue and broken ancestry blocking',()=>{
 for(const tasks of [[task('a',null,'')],[task('a','missing','')],[task('a','b',''),task('b','a','')],[task('a',null,'2026-10-30')]])assert.equal(allowed(tasks),false);
 assert.equal(allowed([task('a',null,'','completed')]),true);
});
test('Phone token gate keeps scheduled break and Emergency Bypass exceptions',()=>{
 const tasks=[task('a',null,'today')];assert.equal(allowed(tasks),false);assert.equal(allowed(tasks,{onBreak:true}),true);assert.equal(allowed(tasks,{bypass:true}),true);
});

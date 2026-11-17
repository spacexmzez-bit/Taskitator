// Universe Phase 2: shield and bonus panel, outline to tasks, batch tags/priority, sync experience,
// and the close-out tests for the Phase 0 sort, date filter and completed-root collapse.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Element,descendants,byText,input} from './universe-interface.test.js';
const source=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const byClass=(root,name)=>descendants(root).filter(x=>x.className?.split(' ').includes(name));
const DAY=86400000;

// Mounts the task UI with a chosen role and server capabilities.
async function mount({role='owner',capabilities={admin_shield:true,batch_labels:true},setup=null,view='projects',dates=false}={}){
 const panel=new Element('root'),controls=new Element('section'),sent=[],gets=[];
 const window={Clerk:{user:{id:'me'}},addEventListener(){},removeEventListener(){}};
 const data={revision:1,projects:[{id:'p',title:'First',members:['me','sara'],reviewers:[]}],tasks:[
  {id:'t',project_id:'p',title:'Shielded',members:['sara'],mode:'everyone',shield:true,shield_by:'admin2',shield_at:Date.UTC(2026,10,14,9),revision:3,tags:['exam']},
  {id:'c',project_id:'p',parent_id:'t',title:'Child',members:['sara'],mode:'everyone',revision:1,tags:[]},
  {id:'o',project_id:'p',title:'Open',members:['sara'],mode:'everyone',revision:1,tags:[]}],
  assignments:[],catalog:[{id:'high',kind:'priority',rank:1,title:'High'},{id:'exam',kind:'tag',rank:0,title:'Exam'},{id:'lab',kind:'tag',rank:1,title:'Lab'}],progress:{}};
 if(setup)setup(data);
 const context={window,requestAnimationFrame:()=>{},document:{createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag),createTextNode:text=>{const n=new Element('#text');n.textContent=text;return n;}},Date,Map,Set,Error,Event:class{constructor(type){this.type=type;}},confirm:()=>true};
 vm.createContext(context);if(dates)vm.runInContext(readFileSync(new URL('../date-filter.js',import.meta.url),'utf8'),context);if(dates&&!window.TaskitatorDateFilter)window.TaskitatorDateFilter=context.TaskitatorDateFilter;
 vm.runInContext(source('universe-tasks-ui.js'),context);
 const members=[{account_id:'me',username:'Mazen',role},{account_id:'admin2',username:'Huda',role:'admin'},{account_id:'sara',username:'Sara',role:'member'}];
 let failAt=0;
 await window.UniverseTasksUI.mount(panel,{id:'g',role},members,{view,controls,capabilities,stage(){},current:()=>true,run:fn=>fn(),
  api:async path=>{gets.push(path);return path==='/universe/groups/g'?{group:{revision:41}}:data;},
  send:async(path,body)=>{if(failAt&&sent.length+1===failAt){failAt=0;throw Error('Offline');}sent.push({path,body});return {id:'new'+sent.length};}});
 return {panel,sent,gets,data,window,failNext:n=>failAt=n};
}
// Every rendered task owns one hidden detail dialog with an "Edit task" button, in render order.
const openEdit=async(f,title)=>{const titles=byClass(f.panel,'task-title').map(n=>n.textContent),edit=descendants(f.panel).filter(n=>n.textContent==='Edit task');assert.equal(titles.length,edit.length);await edit[titles.indexOf(title)].fire('click');return byClass(f.panel,'uni-editor').at(-1);};
const shieldBox=form=>byClass(form,'uni-box').find(b=>b.children[0].textContent==='Shield and bonus');

test('Shield and bonus: each option has a line of explanation and a ? note; the owner can change both',async()=>{
 const f=await mount();const form=await openEdit(f,'Shielded'),box=shieldBox(form);
 assert.deepEqual(byClass(box,'uni-protect-row').map(r=>r.dataset.protect),['shield','bonus']);
 assert.ok(byText(box,'Locks this task until its required subtasks are done.'));assert.ok(byText(box,'Optional work. It never blocks its parent task.'));
 const help=byClass(box,'uni-help');assert.deepEqual(help.map(h=>h.attrs['aria-label']),['About shield','About bonus']);await help[0].fire('click');assert.match(byClass(box,'uni-help-text')[0].textContent,/only one who can turn the shield off/);
 assert.equal(input(box,'Shield').checked,true);assert.notEqual(input(box,'Shield').disabled,true);assert.notEqual(input(box,'Bonus').disabled,true);
 assert.equal(byClass(box,'uni-shield-by')[0].textContent,'Shielded by Huda on 14 Nov 2026');
});

test('Shield and bonus: an admin can turn a shield on but not off, and never changes bonus on an existing task',async()=>{
 const f=await mount({role:'admin'});let box=shieldBox(await openEdit(f,'Shielded'));
 assert.equal(input(box,'Shield').disabled,true);assert.equal(input(box,'Bonus').disabled,true);assert.ok(byText(box,'Only the owner can turn this shield off or change bonus status.'));
 const g=await mount({role:'admin'});box=shieldBox(await openEdit(g,'Open'));
 assert.notEqual(input(box,'Shield').disabled,true);assert.equal(input(box,'Bonus').disabled,true);assert.ok(byText(box,'You can turn the shield on. Only the owner can turn it off again, or change bonus status.'));
 // A Worker without the shield track keeps the old rule: owner only on existing tasks.
 const old=await mount({role:'admin',capabilities:{}});box=shieldBox(await openEdit(old,'Open'));assert.equal(input(box,'Shield').disabled,true);
 assert.ok(byText(box,'Only the owner can change shield or bonus status on an existing task.'));
 // Creating: both allowed, with a reminder that only the owner can turn a shield off.
 const c=await mount({role:'admin'});await descendants(c.panel).find(n=>n.attrs['aria-label']==='Create Universe task').fire('click');box=shieldBox(byClass(c.panel,'uni-editor').at(-1));
 assert.notEqual(input(box,'Shield').disabled,true);assert.ok(byText(box,'Once a shield is on, only the owner can turn it off.'));
});

test('Shield and bonus: the Worker, not the browser, records who set a shield',()=>{
 const ui=source('universe-tasks-ui.js');assert.doesNotMatch(ui,/shield_by:|shield_at:|shield_admin:/);
 const rules=source('universe-rules.js');assert.match(rules,/d\.shield_by=g\.actor_id;d\.shield_at=Date\.now\(\);d\.shield_admin=g\.role!=='owner'/);
 assert.match(rules,/if\(old\.shield&&!d\.shield\)throw error\(403,'PROTECTED'/);
});

test('Outline parser: indentation makes subtasks; bullets, numbers and checkboxes are removed',async()=>{
 const {window}=await mount(),parse=text=>JSON.parse(JSON.stringify(window.UniverseTasksUI.parseOutline(text)));
 assert.deepEqual(parse('- Week 1\n  - Read\n    1. Notes\n  * Quiz\n\n[ ] Week 2\n\t- [x] Lab').map(r=>[r.title,r.parent,r.depth]),[['Week 1',null,0],['Read',0,1],['Notes',1,2],['Quiz',0,1],['Week 2',null,0],['Lab',4,1]]);
 // An uneven dedent attaches to the nearest shallower line.
 assert.deepEqual(parse('A\n      B\n   C').map(r=>r.parent),[null,0,0]);
 assert.deepEqual(parse('  \n- \n'),[]);assert.equal(parse('x'.repeat(300))[0].title.length,200);
 assert.throws(()=>window.UniverseTasksUI.parseOutline(Array.from({length:101},(_, i)=>'T'+i).join('\n')),/Paste up to 100 tasks at a time\./);
 const deep=parse(Array.from({length:40},(_, i)=>' '.repeat(i)+'L'+i).join('\n'));assert.ok(Math.max(...deep.map(r=>r.depth))<30);
});

test('Outline to tasks: managers preview, then create ordinary tasks in order; a failure resumes where it stopped',async()=>{
 const member=await mount({role:'member'});assert.equal(byText(member.panel,'Outline to tasks'),undefined);
 const f=await mount({role:'admin'});await byText(f.panel,'Outline to tasks').fire('click');const sheet=byClass(f.panel,'uni-sheet').at(-1);
 const text=input(sheet,'Outline');text.value='- Week 1\n  - Read\n- Week 2';await text.fire('input');
 assert.deepEqual(byClass(sheet,'uni-outline-preview')[0].children.map(li=>[li.textContent,li.style['--uni-depth']]),[['Week 1','0'],['Read','1'],['Week 2','0']]);
 assert.ok(byText(sheet,'3 tasks will be created'));
 f.failNext(2);await assert.rejects(sheet.fire('submit'),/Offline/);assert.ok(byText(sheet,'Created 1 of 3. Fix the problem and select Create tasks to continue.'));assert.equal(text.disabled,true);
 await sheet.fire('submit');
 assert.deepEqual(JSON.parse(JSON.stringify(f.sent.map(s=>[s.path,s.body.title,s.body.parent_id,s.body.audit_mode,s.body.mode,'shield' in s.body,s.body.members]))),[
  ['/universe/groups/g/work/tasks','Week 1',null,'none','everyone',false,['me','sara']],
  ['/universe/groups/g/work/tasks','Read','new1','none','everyone',false,['me','sara']],
  ['/universe/groups/g/work/tasks','Week 2',null,'none','everyone',false,['me','sara']]]);
 // Under an existing task the new tasks take that task's assignees (so an admin shield's fence is respected).
 const u=await mount({role:'admin'});await byText(u.panel,'Outline to tasks').fire('click');const s2=byClass(u.panel,'uni-sheet').at(-1);input(s2,'Add under').value='t';await input(s2,'Add under').fire('change');input(s2,'Outline').value='Step';await input(s2,'Outline').fire('input');await s2.fire('submit');
 assert.deepEqual([u.sent[0].body.parent_id,u.sent[0].body.members],['t',['sara']]);
});

test('Batch tags and priority: one request with the current Universe revision; offered only when the Worker supports it',async()=>{
 const off=await mount({role:'admin',capabilities:{}});assert.equal(byText(off.panel,'Edit tags and priority'),undefined);
 const f=await mount({role:'admin'});await byText(f.panel,'Edit tags and priority').fire('click');const sheet=byClass(f.panel,'uni-sheet').at(-1);
 const tasks=byClass(sheet,'uni-batch-tasks')[0];assert.deepEqual(tasks.children.filter(c=>c.tag==='label').map(l=>[l.textContent,l.style['--uni-depth']]),[['Shielded','0'],['Child','1'],['Open','0']]);
 await assert.rejects(sheet.fire('submit'),/Select at least one task\./);
 tasks.children.filter(c=>c.tag==='label')[0].children[0].checked=true;tasks.children.filter(c=>c.tag==='label')[2].children[0].checked=true;
 await assert.rejects(sheet.fire('submit'),/Choose tags to add or remove, or a priority\./);
 const [add,remove]=byClass(sheet,'uni-tag-options');input(add,'Lab').checked=true;input(remove,'Lab').checked=true;await input(remove,'Lab').fire('change');assert.equal(input(add,'Lab').checked,false);
 input(add,'Lab').checked=true;await input(add,'Lab').fire('change');assert.equal(input(remove,'Lab').checked,false);input(remove,'Exam').checked=true;input(sheet,'Priority').value='high';
 await sheet.fire('submit');
 assert.deepEqual(JSON.parse(JSON.stringify(f.sent.map(s=>[s.path,s.body]))),[['/universe/groups/g/work/tasks/batch',{revision:41,task_ids:['t','o'],add_tags:['lab'],remove_tags:['exam'],priority_id:'high'}]]);
});

test('Sync experience: refresh only when idle, retry only unsent sends, never queue offline edits',()=>{
 const ui=source('universe-ui.js'),shell=source('universe-shell.js');
 assert.match(ui,/const SYNC_EVERY=15000/);
 const idle=ui.match(/const idle=\(\)=>([^\n]+)/)[1];for(const part of ['!busy','!document.hidden','navigator.onLine!==false','isDirty','!unsaved()','!layerOpen()','!editing()'])assert.ok(idle.includes(part),part);
 assert.match(ui,/'\.uni-editor-overlay:not\(\[hidden\]\),\.uni-confirm-overlay/);
 assert.match(ui,/if\(pending\.size&&idle\(\)\)/);assert.match(ui,/if\(idle\(\)\)refresh\(\);else showNewer\(\);/);
 // A server answer (any status) drops the operation; only sends that never got an answer are retried, with the same operation_id.
 assert.match(ui,/catch\(e\)\{if\(e\?\.status\)pending\.delete\(key\);throw e;\}/);
 assert.match(ui,/for\(const \[key,body\]of \[\.\.\.pending\]\)\{const \[path\]=JSON\.parse\(key\);try\{await api\(path,body\)/);
 for(const event of ['focus','online'])assert.match(ui,new RegExp("window\\.addEventListener\\?\\.\\('"+event+"',wake\\)"));
 assert.match(shell,/className='uni-sync-status'/);assert.match(shell,/'Retry unsent changes'/);assert.match(shell,/isDirty\(bar=true\)\{return dirty\(bar\);\}/);
});

test('Owner leave: the Worker refuses it and Settings points the owner to ownership transfer',()=>{
 assert.match(source('universe-rules.js'),/tail==='\/leave'&&method==='POST'&&g\.role==='owner'\)throw error\(409,'OWNER_LEAVE'/);
 assert.match(source('universe-ui.js'),/To leave instead, transfer ownership first\./);
});

// ---- Close-out: Phase 0 list tools had no dedicated tests -------------------------------------
const dateTasks=data=>{const now=Date.now();data.tasks=[
 {id:'z',project_id:'p',title:'Zebra',members:['me'],mode:'everyone',position:0,priority_id:'low',due_at:now+5*DAY},
 {id:'a',project_id:'p',title:'Apple',members:['me'],mode:'everyone',position:1,priority_id:'high',due_at:now-DAY},
 {id:'m',project_id:'p',title:'Mango',members:['me'],mode:'everyone',position:2},
 {id:'k',project_id:'p',parent_id:'m',title:'Kiwi',members:['me'],mode:'everyone',position:0,due_at:now+DAY}];
 data.catalog=[{id:'low',kind:'priority',rank:9,title:'Low'},{id:'high',kind:'priority',rank:1,title:'High'}];};
const roots=f=>byClass(f.panel,'task-node').filter(n=>!byClass(f.panel,'uni-child-inner').some(c=>c.children.includes(n))).map(n=>byClass(n,'task-title')[0]?.textContent);

test('Phase 0 close-out: sort modes reorder the project list without changing stored data',async()=>{
 const f=await mount({setup:dateTasks});assert.deepEqual(roots(f),['Zebra','Apple','Mango']);
 const sort=input(f.panel,'Sort by');for(const [mode,order]of [['title',['Apple','Mango','Zebra']],['priority',['Apple','Zebra','Mango']],['due',['Apple','Zebra','Mango']],['manual',['Zebra','Apple','Mango']]]){sort.value=mode;await sort.fire('input');assert.deepEqual(roots(f),order,mode);}
 assert.equal(f.sent.length,0);
});

test('Phase 0 close-out: the date filter keeps the parents of a match and hides everything else',async()=>{
 const f=await mount({setup:dateTasks,dates:true}),when=()=>input(f.panel,'When');
 for(const [mode,order]of [['overdue',['Apple']],['none',['Mango']],['week',['Zebra','Mango']],['all',['Zebra','Apple','Mango']]]){when().value=mode;await when().fire('input');assert.deepEqual(roots(f),order,mode);}
 when().value='week';await when().fire('input');const mango=byClass(f.panel,'task-node').find(n=>byClass(n,'task-title')[0]?.textContent==='Mango');assert.deepEqual(byClass(mango,'task-title').map(n=>n.textContent),['Mango','Kiwi']);
 assert.equal(f.sent.length,0);
});

test('Phase 0 close-out: a completed root collapses its finished children; an open root does not',async()=>{
 const f=await mount({setup:data=>{dateTasks(data);data.progress={m:{complete:true},k:{complete:true}};}});
 const mango=byClass(f.panel,'task-node').find(n=>byClass(n,'task-title')[0]?.textContent==='Mango');assert.ok(byClass(mango,'uni-child-tree')[0].className.includes('uni-collapsed'));
 const g=await mount({setup:data=>{dateTasks(data);data.progress={m:{complete:true}};}});
 const open=byClass(g.panel,'task-node').find(n=>byClass(n,'task-title')[0]?.textContent==='Mango');assert.equal(byClass(open,'uni-child-tree')[0].className.includes('uni-collapsed'),false);
});

test('Phase 2 styles: tokens and logical properties only',()=>{
 const css=source('universe.css'),part=css.slice(css.indexOf('/* 17. Phase 2'),css.indexOf('@media (prefers-reduced-motion: reduce) { #universeWorkspace .check-circle'));assert.ok(part.length>2000);
 assert.doesNotMatch(part,/#[0-9a-fA-F]{3,8}\b|rgba?\(/);assert.doesNotMatch(part.replace(/border-inline-start|inset-inline(-end|-start)?|margin-inline|padding-inline(-start)?/g,''),/(?:^|[\s;{])(?:left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
});

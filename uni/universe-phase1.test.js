// Universe Phase 1: boxed task panel, Controls label editor with the universal Save bar, invitation labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Element,descendants,byText,input,fixture} from './universe-interface.test.js';
const source=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};
const openEditor=async f=>{await descendants(f.panel).find(x=>x.attrs['aria-label']==='Create Universe task').fire('click');return descendants(f.panel).find(x=>x.className?.split(' ').includes('uni-editor'));};
const byClass=(root,name)=>descendants(root).filter(x=>x.className?.split(' ').includes(name));
const labelled=(root,name)=>descendants(root).find(x=>x.attrs['aria-label']===name);

test('Task panel: sections are boxes in the planned order; dates and completion requirement sit under Auditing',async()=>{
 const form=await openEditor(await fixture()),boxes=byClass(form,'uni-box');
 assert.deepEqual(boxes.map(b=>b.children[0].textContent),['Task details','Assignment','Auditing','Shield and bonus','Quick subtasks']);
 assert.ok(byText(boxes[0],'Tags'));assert.ok(input(boxes[0],'Priority'));assert.ok(input(boxes[0],'Work description'));
 assert.ok(byText(boxes[1],'Project assignees'));assert.equal(byClass(boxes[1],'uni-assignees')[0].tag,'details');
 assert.deepEqual(byClass(boxes[2],'uni-subbox-title').map(x=>x.textContent),['Completion requirement','Dates and late entries']);
 assert.ok(input(boxes[2],'Due (Riyadh)'));assert.ok(byText(boxes[2],'Assigned reviewers'));assert.equal(byText(form,'Reviewers and audits'),undefined);
});

test('Task panel: square choice buttons drive the same controls that are saved; help buttons explain each choice',async()=>{
 const f=await fixture(),form=await openEditor(f),picks=byClass(form,'uni-choice-pick');
 assert.equal(picks.length,7);assert.equal(input(form,'Assignment type').value,'everyone');assert.equal(input(form,'Audit mode').value,'none');
 const pick=title=>picks.find(p=>p.children.some(c=>c.textContent===title));
 await pick('Shared').fire('click');assert.equal(input(form,'Assignment type').value,'shared');assert.equal(pick('Shared').attrs['aria-checked'],'true');assert.equal(pick('Everyone’s').attrs['aria-checked'],'false');
 // Shared work has no completion requirement and no late entries.
 assert.equal(byText(form,'Completion requirement').parentElement.hidden,true);assert.equal(input(form,'Allow late entries').parentElement.hidden,true);
 await pick('Human only').fire('click');assert.equal(input(form,'Audit mode').value,'human');assert.equal(form.dataset.dirty,'true');
 const help=labelled(form,'About AI only'),note=byClass(form,'uni-help-text').find(n=>n.parentElement===help.parentElement.parentElement.parentElement);
 assert.equal(note.hidden,true);await help.fire('click');assert.equal(note.hidden,false);assert.match(note.textContent,/7\/10/);await help.fire('click');assert.equal(note.hidden,true);
 input(form,'Title').value='Shared work';await form.fire('submit');const body=f.sent.at(-1).body;assert.equal(body.mode,'shared');assert.equal(body.audit_mode,'human');assert.equal(body.shield,false);assert.equal(body.bonus,false);
});

test('Task panel: quick subtasks commit on Enter, can be removed, and a typed title is not lost on Save',async()=>{
 const f=await fixture(),form=await openEditor(f),title=labelled(form,'Subtask title');input(form,'Title').value='Parent';
 let prevented=0;const enter=async()=>{for(const fn of title.events.keydown)await fn({key:'Enter',preventDefault(){prevented++;}});};
 title.value='  First   child ';await enter();title.value='Second';await enter();title.value='';await enter();
 assert.equal(prevented,3);assert.equal(title.value,'');assert.equal(input(form,'Subtask titles').value,'First child\nSecond');
 await labelled(form,'Remove subtask Second').fire('click');assert.equal(input(form,'Subtask titles').value,'First child');
 title.value='Typed only';await form.fire('submit');
 assert.deepEqual(f.sent.map(x=>[x.body.title,x.body.parent_id]),[['Parent',null],['First child','new1'],['Typed only','new1']]);
});

test('Task panel: editing keeps protected values, and new subtasks never carry the edited task’s revision',async()=>{
 const f=await fixture('projects',data=>{Object.assign(data.tasks[0],{revision:4,shield:true,bonus:true,audit_mode:'human',criteria:'Show it',reviewers:[],mode:'everyone'});});
 await byText(f.panel,'First task').fire('click');const dialog=descendants(f.panel).find(x=>x.attrs.role==='dialog');await byText(dialog,'Edit task').fire('click');
 const form=descendants(f.panel).find(x=>x.className?.split(' ').includes('uni-editor'));assert.equal(input(form,'Assignment type').disabled,true);
 assert.equal(byClass(form,'uni-parent')[0].hidden,false);assert.equal(input(form,'Shield').checked,true);
 labelled(form,'Subtask title').value='Late addition';await form.fire('submit');
 const [edit,child]=f.sent;assert.match(edit.path,/\/tasks\/t\/edit$/);assert.equal(edit.body.revision,4);assert.equal(edit.body.shield,true);assert.equal(edit.body.bonus,true);
 assert.match(child.path,/\/tasks$/);assert.equal('revision' in child.body,false);assert.equal(child.body.parent_id,'t');assert.equal(child.body.title,'Late addition');
});

test('Task panel: templates and saved criteria are offered; saved criteria are read, never written',async()=>{
 const src=source('universe-tasks-ui.js');assert.match(src,/localStorage\.getItem\('taskitator_saved_criteria'\)/);assert.doesNotMatch(src,/localStorage\.setItem/);assert.match(src,/fetch\('\.\/CRITERIA_TEMPLATES\.json'\)/);
 const form=await openEditor(await fixture());assert.ok(byText(form,'Templates'));assert.ok(byText(form,'Saved criteria'));assert.equal(byClass(form,'uni-criteria-list')[0].hidden,true);
});

test('Parent picker: create mode has no move wording and no confirmation; the panel registers the dialog as the top layer',()=>{
 const picker=readFileSync(new URL('../parent-picker.js',import.meta.url),'utf8'),ui=source('universe-tasks-ui.js'),page=readFileSync(new URL('../components.html',import.meta.url),'utf8');
 assert.match(picker,/opts\.creating \? tr\('Choose where the new task will sit\.'\)/);assert.match(picker,/const ok = opts\.creating \|\| await window\.TaskitatorConfirm/);
 assert.match(ui,/creating:true/);assert.match(ui,/UniverseUX\?\.layer\(dialog,\{fit:false/);assert.match(page,/src="parent-picker\.js"/);
 assert.match(source('universe-widgets.js'),/if \(!v \|\| !fit\) return;/);
});

test('Labels: nothing is sent while editing; each changed row becomes one named staged change',async()=>{
 const f=await fixture('projects',data=>{data.catalog.push({id:'exam',kind:'tag',rank:0,title:'Exam',color:'#B58CFA'});});
 assert.equal(byText(f.controls,'Save'),undefined);assert.equal(f.staged.size,0);
 const rows=()=>byClass(f.controls,'uni-catalog-row'),name=row=>row.children.find(c=>c.tag==='input');
 const tagRow=rows().find(r=>name(r).value==='Exam');name(tagRow).value='Exams';await name(tagRow).fire('input');
 assert.equal(f.sent.length,0);assert.deepEqual([...f.staged.keys()],['label:exam']);assert.equal(f.staged.get('label:exam').label,'Tag “Exams”');
 await f.staged.get('label:exam').apply(9);assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1))),{path:'/universe/groups/g/work/catalog/exam/edit',body:{revision:9,kind:'tag',title:'Exams',rank:0,color:'#b58cfa'}});
 // Typing the old name back removes the change again.
 name(tagRow).value='Exam';await name(tagRow).fire('input');assert.equal(f.staged.size,0);
 // An empty name is refused before anything is sent.
 name(tagRow).value='  ';await name(tagRow).fire('input');const before=f.sent.length;assert.throws(()=>f.staged.get('label:exam').apply(9),/Enter a name/);assert.equal(f.sent.length,before);
});

test('Labels: custom colors come from presets, the picker or a typed hex code; invalid codes are not staged',async()=>{
 const f=await fixture('projects',data=>{data.catalog.push({id:'exam',kind:'tag',rank:0,title:'Exam',color:'#b58cfa'});});
 const row=byClass(f.controls,'uni-catalog-row').find(r=>r.children.some(c=>c.value==='Exam')),panel=row.parentElement.children[row.parentElement.children.indexOf(row)+1];
 assert.equal(panel.className,'uni-color-panel');assert.equal(panel.hidden,true);await row.children[0].children[0].fire('click');assert.equal(panel.hidden,false);
 const code=panel.children.find(c=>c.className==='uni-hex'),native=panel.children.find(c=>c.type==='color'),presets=panel.children.filter(c=>c.className==='uni-swatch');assert.equal(presets.length,8);
 for(const bad of ['red','#12345','#12345g','rgb(1,2,3)']){code.value=bad;await code.fire('input');assert.equal(code.attrs['aria-invalid'],'true');assert.equal(f.staged.size,0,bad);}
 code.value='22D3EE';await code.fire('input');assert.equal(code.attrs['aria-invalid'],'false');assert.equal(native.value,'#22d3ee');
 await f.staged.get('label:exam').apply(1);assert.equal(f.sent.at(-1).body.color,'#22d3ee');
 await presets[0].fire('click');assert.equal(f.staged.size,0);native.value='#010203';await native.fire('input');await f.staged.get('label:exam').apply(1);assert.equal(f.sent.at(-1).body.color,'#010203');
});

test('Labels: add, reorder and delete are staged; saved rows settle so they are never sent twice',async()=>{
 const f=await fixture(),box=()=>byClass(f.controls,'uni-label-box')[1],names=()=>byClass(box(),'uni-catalog-row').filter(r=>!r.className.includes('uni-catalog-add')).map(r=>r.children.find(c=>c.tag==='input').value);
 assert.deepEqual(names(),['High','Low']);
 await byClass(box(),'uni-catalog-row')[1].children.find(c=>c.attrs['aria-label']==='Higher urgency').fire('click');
 assert.deepEqual(names(),['Low','High']);assert.deepEqual([...f.staged.keys()].sort(),['label:high','label:low']);
 await f.staged.get('label:low').apply(3);assert.equal(f.sent.at(-1).body.rank,1);await f.staged.get('label:high').apply(4);assert.equal(f.sent.at(-1).body.rank,9);
 const add=byClass(box(),'uni-catalog-add')[0],fresh=add.children.find(c=>c.tag==='input');fresh.value=' Someday ';await byText(add,'Add priority').fire('click');
 assert.deepEqual(names(),['Low','High','Someday']);const key=[...f.staged.keys()].find(k=>k.startsWith('label:new')),created=f.staged.get(key);assert.equal(created.label,'Priority “Someday”');
 await created.apply(5);assert.deepEqual({...f.sent.at(-1).body,color:undefined},{revision:5,kind:'priority',title:'Someday',rank:10,color:undefined});assert.match(f.sent.at(-1).path,/\/work\/catalog$/);
 // The server accepted it: the row now has an id, and editing it again stages an edit, not a second create.
 created.done({id:'srv1'});f.staged.delete(key);const settled=byClass(box(),'uni-catalog-row')[2],field=settled.children.find(c=>c.tag==='input');field.value='Later';await field.fire('input');
 await f.staged.get(key).apply(6);assert.match(f.sent.at(-1).path,/\/work\/catalog\/srv1\/edit$/);
 const first=byClass(box(),'uni-catalog-row')[0];await first.children.at(-1).fire('click');assert.ok(byText(box(),'Undo delete'));
 await f.staged.get('label:low').apply(7);assert.match(f.sent.at(-1).path,/\/work\/catalog\/low\/delete$/);await byText(box(),'Undo delete').fire('click');assert.equal(f.staged.has('label:low'),true,'the earlier reorder is still waiting');
});

async function ownerUI(extra={}){
 const root=new Element('div'),body=new Element('body'),events={},posts=[],state={revision:1,fail:null,invitations:[{id:'i1',role:'member',expires_at:1,label:'Sara’s partner'}],...extra};body.append(root);
 Element.prototype.prepend=function(...items){for(const item of items){item.remove?.();item.parentElement=this;}this.children.unshift(...items);};
 const group=()=>({id:'g',title:'Orion',purpose:'Study together',role:'owner',owner_pro:true,can_rename:true,can_add_members:true,revision:state.revision});
 const window={Clerk:{session:{id:'s'},user:{id:'me',username:'Mazen'},addListener(){}},addEventListener:(name,fn)=>(events[name]??=[]).push(fn),TaskitatorAuth:{account:{user:'me'},api:async(path,options)=>{
  if(options?.method==='POST'){const b=JSON.parse(options.body);posts.push({path,body:b});if(state.fail&&path.endsWith(state.fail))throw Error('Refused by the server.');if('revision' in b){if(b.revision!==state.revision)throw Error('Stale revision '+b.revision);state.revision++;}return {id:'made',expires_at:5};}
  if(path==='/pro/status')return {isPro:true};if(path.endsWith('/capabilities'))return {ui:true,capabilities:{tasks:true,invitation_labels:state.labels!==false}};if(path==='/universe/groups')return {groups:[group()]};if(path.endsWith('/members'))return {members:[{account_id:'me',username:'Mazen',role:'owner'}]};if(path.endsWith('/invitations'))return {invitations:state.invitations};if(path.endsWith('/activity'))return {events:[{kind:'invited',actor_id:'me',resource_id:'i1',created_at:1,label:'Sara’s partner'}]};if(path.endsWith('/settings'))return {validate_criteria:true};if(path.endsWith('/work'))return {revision:state.revision,projects:[],tasks:[],assignments:[],catalog:[{id:'exam',kind:'tag',rank:0,title:'Exam'}]};if(path.endsWith('/ai'))return {account:{daily:0,monthly:0}};return {group:group()};}}};
 const context={window,requestAnimationFrame:()=>{},crypto:{randomUUID:()=>'op-'+Math.random(),getRandomValues:a=>a},document:{body,createElement:tag=>new Element(tag),getElementById:()=>root,querySelectorAll:()=>descendants(root).filter(n=>n.tag==='form')},navigator:{onLine:true},location:{search:'',href:'https://preview.local/components.html'},URL,URLSearchParams,Event,Date,Map,Set,Error};
 for(const file of ['universe-tasks-ui.js','universe-shell.js','universe-ui.js'])vm.runInNewContext(source(file),context);
 events['taskitator-universe-view'][0]();await flush();await byText(root,'Created').fire('click');await byText(root,'Orion').fire('click');await flush();
 const bar=()=>descendants(root).find(n=>n.className==='uni-savebar');
 return {root,posts,state,events,bar,pane:()=>descendants(root).find(n=>n.className?.includes('uni-pane')&&!n.hidden)?.dataset.pane};
}

test('Save bar: hidden until a value changes, counts changes, and removes itself when a change is undone',async()=>{
 const ui=await ownerUI();assert.equal(ui.bar().hidden,true);assert.equal(ui.bar().tag,'form');assert.equal(byText(ui.root,'Disable criteria validation'),undefined);
 const name=input(ui.root,'Name');name.value='Orion 2';await name.fire('input');assert.equal(ui.bar().hidden,false);assert.ok(byText(ui.bar(),'1 unsaved change'));assert.equal(ui.bar().dataset.dirty,'true');
 const toggle=byText(ui.root,'Require validated AI criteria').children[0];toggle.checked=false;await toggle.fire('change');assert.ok(byText(ui.bar(),'2 unsaved changes'));assert.equal(ui.posts.length,0);
 name.value='Orion';await name.fire('input');toggle.checked=true;await toggle.fire('change');assert.equal(ui.bar().hidden,true);assert.equal(ui.bar().dataset.dirty,'false');
 // Leaving the page with staged changes is guarded.
 name.value='X';await name.fire('input');let stopped=false;ui.events.beforeunload[0]({preventDefault(){stopped=true;}});assert.equal(stopped,true);
});

test('Save bar: Save sends changes in order with a fresh revision each time, then returns to the same tab',async()=>{
 const ui=await ownerUI();await byText(ui.root,'Settings').fire('click');await flush();assert.equal(ui.pane(),'settings');
 const name=input(ui.root,'Name');name.value='Orion 2';await name.fire('input');const toggle=byText(ui.root,'Require validated AI criteria').children[0];toggle.checked=false;await toggle.fire('change');
 const tag=descendants(ui.root).find(n=>n.attrs['aria-label']==='Tag name');tag.value='Exams';await tag.fire('input');assert.ok(byText(ui.bar(),'3 unsaved changes'));
 // Moving between tabs keeps the staged changes without asking.
 await byText(ui.root,'Controls').fire('click');await flush();assert.equal(ui.pane(),'controls');assert.equal(descendants(ui.root).some(n=>n.className?.includes('uni-confirm-sheet')),false);assert.ok(byText(ui.bar(),'3 unsaved changes'));
 await ui.bar().fire('submit');await flush();
 assert.deepEqual(ui.posts.map(p=>[p.path.replace('/universe/groups/g',''),p.body.revision]),[['/edit',1],['/settings',2],['/work/catalog/exam/edit',3]]);
 assert.deepEqual(ui.posts[0].body.title,'Orion 2');assert.equal(ui.posts[1].body.validate_criteria,false);
 assert.equal(ui.bar().hidden,true);assert.equal(ui.pane(),'controls');
});

test('Save bar: a failure stops the run, names the item and keeps the rest staged',async()=>{
 const ui=await ownerUI({fail:'/settings'});const name=input(ui.root,'Name');name.value='Orion 2';await name.fire('input');const toggle=byText(ui.root,'Require validated AI criteria').children[0];toggle.checked=false;await toggle.fire('change');
 const tag=descendants(ui.root).find(n=>n.attrs['aria-label']==='Tag name');tag.value='Exams';await tag.fire('input');
 await ui.bar().fire('submit');await flush();
 assert.deepEqual(ui.posts.map(p=>p.path.replace('/universe/groups/g','')),['/edit','/settings']);
 const status=descendants(ui.root).find(n=>n.className==='uni-status');assert.match(status.textContent,/^Not saved: Review standards\. Refused by the server\./);
 assert.equal(ui.bar().hidden,false);assert.ok(byText(ui.bar(),'2 unsaved changes'));
 ui.state.fail=null;await ui.bar().fire('submit');await flush();assert.deepEqual(ui.posts.slice(2).map(p=>[p.path.replace('/universe/groups/g',''),p.body.revision]),[['/settings',2],['/work/catalog/exam/edit',3]]);assert.equal(ui.bar().hidden,true);
});

test('Save bar: actions are never staged, and the shell asks before a refresh but not on a tab switch',()=>{
 const ui=source('universe-ui.js'),shell=source('universe-shell.js');
 for(const key of [...ui.matchAll(/stage\('([a-z]+)'/g)].map(m=>m[1]))assert.ok(['details','standards'].includes(key),key);
 assert.doesNotMatch(ui,/stage\([^)]*(invitations|owner-transfer|'remove'|'role'|'leave'|'delete'|consent)/);
 assert.match(shell,/if\(dirty\(false\)&&!await this\.leave\(false\)\)return;/);assert.match(shell,/if\(await this\.leave\(\)\)onRefresh\(\)/);assert.match(shell,/current:\(\)=>shown/);
});

test('Invitation labels: optional field for managers, sent only when filled, shown on pending invitations and activity',async()=>{
 const ui=await ownerUI();const field=input(ui.root,'Label (optional)');assert.ok(field);assert.equal(field.maxLength,80);
 const tags=descendants(ui.root).filter(n=>n.className==='uni-invite-label');assert.deepEqual(tags.map(t=>[t.textContent,t.attrs.translate]),[['Sara’s partner','no'],['Sara’s partner','no']]);
 await byText(ui.root,'Create invitation').fire('click');await flush();assert.equal('label' in ui.posts.at(-1).body,false);
 input(ui.root,'Label (optional)').value='  Lab group B ';await byText(ui.root,'Create invitation').fire('click');await flush();assert.equal(ui.posts.at(-1).body.label,'Lab group B');assert.match(ui.posts.at(-1).path,/\/invitations$/);
 // Server without the Phase 10 SQL: the field is not offered and invitations work as before.
 const old=await ownerUI({labels:false,invitations:[{id:'i1',role:'member',expires_at:1}]});assert.equal(input(old.root,'Label (optional)'),undefined);assert.ok(byText(old.root,'Create invitation'));
});

test('Phase 1 styles: new rules use tokens and logical properties only; sprite has every new icon',()=>{
 const css=source('universe.css'),part=css.slice(css.indexOf('/* 16. Task panel sections'));assert.ok(part.length>2000);
 assert.doesNotMatch(part,/#[0-9a-fA-F]{3,8}\b|rgba?\(/);assert.doesNotMatch(part.replace(/border-inline-start|inset-inline|margin-inline|padding-inline/g,''),/(?:^|[\s;{])(?:left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
 const sprite=readFileSync(new URL('../image/space_sprites/sprite.svg',import.meta.url),'utf8');for(const icon of ['task','tree','spark','person','ban'])assert.ok(sprite.includes('id="sp-i-'+icon+'"'),icon);
});

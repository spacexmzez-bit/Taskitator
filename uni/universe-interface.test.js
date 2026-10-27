import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.events={};this.style={};this.value='';this.textContent='';this.hidden=false;}
 append(...items){for(const item of items){if(item.parentElement)item.remove();item.parentElement=this;this.children.push(item);}}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 replaceChildren(...items){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...items);}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){(this.events[k]??=[]).push(fn);}
 async fire(type){for(const fn of this.events[type]||[])await fn({preventDefault(){}});}
 querySelectorAll(selector){const selectors=selector.split(',');return descendants(this).slice(1).filter(x=>selectors.some(s=>s.startsWith('.')?x.className?.split(' ').includes(s.slice(1)):x.tag===s));}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 reset(){}focus(){}select(){}
}
const descendants=e=>[e,...e.children.flatMap(descendants)];
async function fixture(view='projects'){
 const panel=new Element('root'),controls=new Element('section'),sent=[],listeners={};let fail=false;
 const window={Clerk:{user:{id:'me'}},addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),removeEventListener(){}};
 const data={revision:1,projects:[{id:'p',title:'First',members:['me'],reviewers:[]},{id:'q',title:'Second',members:['other'],reviewers:[]}],tasks:[{id:'t',project_id:'p',title:'First task',members:['me'],mode:'everyone'},{id:'u',project_id:'q',title:'Second task',members:['other'],mode:'everyone'}],assignments:[],catalog:[{id:'low',kind:'priority',rank:9,title:'Low'},{id:'high',kind:'priority',rank:1,title:'High'}],progress:{}};
 const context={window,document:{createElement:tag=>new Element(tag)},Date,Map,Set,Error,confirm:()=>true};
 vm.runInNewContext(readFileSync(new URL('./universe-tasks-ui.js',import.meta.url),'utf8'),context);
 await window.UniverseTasksUI.mount(panel,{id:'g',role:'owner'},[{account_id:'me',username:'Mazen',role:'owner'},{account_id:'other',username:'Sara',role:'member'}],{view,controls,current:()=>true,run:fn=>fn(),api:async()=>data,send:async(path,body)=>{sent.push({path,body});if(fail&&body.title==='Child'){fail=false;throw Error('Offline');}return {id:'new'+sent.length};}});
 return {panel,controls,sent,window,listeners,setFailure:()=>fail=true};
}
const byText=(root,text)=>descendants(root).find(x=>x.textContent===text);
const input=(root,label)=>byText(root,label)?.children[0];
test('Corrected Universe projects switch locally, hide unrelated tasks, and create only through FAB',async()=>{
 const f=await fixture();assert.ok(byText(f.panel,'First task'));assert.equal(byText(f.panel,'Second task'),undefined);await byText(f.panel,'Second').fire('click');assert.ok(byText(f.panel,'Second task'));assert.equal(byText(f.panel,'First task'),undefined);assert.equal(byText(f.panel,'New project name'),undefined);assert.equal(byText(f.panel,'Rank'),undefined);assert.ok(byText(f.controls,'Manage tags'));assert.ok(byText(f.controls,'Manage priorities'));assert.equal(f.sent.length,0);
 await descendants(f.panel).find(n=>n.attrs['aria-label']==='Create Universe task').fire('click');const form=descendants(f.panel).find(n=>n.className?.split(' ').includes('uni-editor'));assert.ok(form);assert.equal(input(form,'Project').value,'q');assert.equal(input(form,'Priority').value,'low');assert.deepEqual(descendants(form).filter(x=>x.tag==='summary').map(x=>x.textContent).slice(-1),['Quick subtasks (one title per line)']);assert.equal(form.children.at(-1).className,'uni-editor-actions');assert.equal(input(form,'Sara').checked,true);assert.equal(input(form,'Mazen').checked,false);
});
test('Corrected Universe editor retains saved parent on child retry and does not duplicate parent',async()=>{
 const f=await fixture();await descendants(f.panel).find(n=>n.attrs['aria-label']==='Create Universe task').fire('click');const form=descendants(f.panel).find(n=>n.className?.split(' ').includes('uni-editor'));input(form,'Title').value='Parent';input(form,'Subtask titles').value='Child';input(form,'Assignment type').value='everyone';input(form,'Requirement').value='all';input(form,'Audit mode').value='none';f.setFailure();await assert.rejects(form.fire('submit'),/Offline/);assert.equal(f.sent.filter(x=>x.body.title==='Parent').length,1);await form.fire('submit');assert.equal(f.sent.filter(x=>x.body.title==='Parent').length,1);assert.equal(f.sent.at(-1).body.parent_id,'new1');
});
test('Corrected Universe dashboard hides search and filters until requested',async()=>{
 const f=await fixture('dashboard'),filters=descendants(f.panel).find(x=>x.className==='uni-filterbar');assert.equal(filters.hidden,true);await descendants(f.panel).find(x=>x.attrs['aria-label']==='Filter tasks').fire('click');assert.equal(filters.hidden,false);assert.equal(byText(f.panel,'Show Universe balances'),undefined);assert.equal(byText(f.panel,'Refresh tasks'),undefined);
});

test('Personal-style task rows open details separately from local child expansion',async()=>{const f=await fixture();const title=byText(f.panel,'First task');assert.ok(title.className.includes('task-title'));const dialog=descendants(f.panel).find(x=>x.attrs.role==='dialog');assert.equal(dialog.hidden,true);await title.fire('click');assert.equal(dialog.hidden,false);await byText(dialog,'Close').fire('click');assert.equal(dialog.hidden,true);assert.equal(f.sent.length,0);});

test('Visual rebuild selection opens a complete owner shell with Controls and Settings',async()=>{
 const root=new Element('div'),body=new Element('body'),events={};body.append(root);
 Element.prototype.prepend=function(...items){for(const item of items){item.remove?.();item.parentElement=this;}this.children.unshift(...items);};
 Object.defineProperty(Element.prototype,'classList',{get(){return {add:cls=>{this.className=((this.className||'')+' '+cls).trim();},remove:cls=>{this.className=(this.className||'').split(' ').filter(x=>x!==cls).join(' ');},toggle:()=>{}};}});
 const group={id:'g',title:'Orion',purpose:'Study together',role:'owner',owner_pro:true,can_rename:true,can_add_members:true,revision:1};
 const window={Clerk:{session:{id:'s'},user:{id:'me',username:'Mazen'},addListener(){}},addEventListener:(name,fn)=>(events[name]??=[]).push(fn),TaskitatorAuth:{account:{user:'me'},api:async path=>{if(path==='/pro/status')return {isPro:true};if(path.endsWith('/capabilities'))return {ui:true,capabilities:{tasks:true}};if(path==='/universe/groups')return {groups:[group]};if(path.endsWith('/members'))return {members:[{account_id:'me',username:'Mazen',role:'owner'}]};if(path.endsWith('/invitations'))return {invitations:[]};if(path.endsWith('/activity'))return {events:[]};if(path.endsWith('/settings'))return {validate_criteria:true};if(path.endsWith('/work'))return {revision:1,projects:[],tasks:[],assignments:[],catalog:[]};if(path.endsWith('/ai'))return {account:{daily:0,monthly:0}};return {group};}}};
 const context={window,document:{body,createElement:tag=>new Element(tag),getElementById:()=>root,querySelectorAll:()=>descendants(root).filter(n=>n.tag==='form')},navigator:{onLine:true},location:{search:'',href:'https://preview.local/components.html'},URL,URLSearchParams,Event,Date,Map,Set,Error};
 for(const file of ['universe-tasks-ui.js','universe-shell.js','universe-ui.js'])vm.runInNewContext(readFileSync(new URL('./'+file,import.meta.url),'utf8'),context);
 events['taskitator-universe-view'][0]();for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 await byText(root,'Created Universes').fire('click');await byText(root,'Orion').fire('click');for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
 assert.ok(byText(root,'Members'));assert.ok(byText(root,'Create invitation'));assert.ok(byText(root,'Group settings'));assert.ok(byText(root,'Delete Universe'));assert.ok(byText(root,'Manage priorities'));assert.equal(byText(root,'Community'),undefined);assert.ok(byText(root,'My stats'));assert.ok(descendants(root).some(n=>n.className==='uni-connection'&&n.attrs['aria-label']==='Connected'));
});

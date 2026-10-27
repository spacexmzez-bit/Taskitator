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
 querySelectorAll(selector){const selectors=selector.split(',');return descendants(this).slice(1).filter(x=>selectors.some(s=>s.startsWith('.')?x.className===s.slice(1):x.tag===s));}
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
 await descendants(f.panel).find(n=>n.attrs['aria-label']==='Create Universe task').fire('click');const form=descendants(f.panel).find(n=>n.className==='uni-editor');assert.ok(form);assert.equal(input(form,'Project').value,'q');assert.equal(input(form,'Priority').value,'low');assert.deepEqual(descendants(form).filter(x=>x.tag==='summary').map(x=>x.textContent).slice(-1),['Quick subtasks (one title per line)']);assert.equal(form.children.at(-1).className,'uni-editor-actions');assert.equal(input(form,'Sara').checked,true);assert.equal(input(form,'Mazen').checked,false);
});
test('Corrected Universe editor retains saved parent on child retry and does not duplicate parent',async()=>{
 const f=await fixture();await descendants(f.panel).find(n=>n.attrs['aria-label']==='Create Universe task').fire('click');const form=descendants(f.panel).find(n=>n.className==='uni-editor');input(form,'Title').value='Parent';input(form,'Subtask titles').value='Child';input(form,'Assignment type').value='everyone';input(form,'Requirement').value='all';input(form,'Audit mode').value='none';f.setFailure();await assert.rejects(form.fire('submit'),/Offline/);assert.equal(f.sent.filter(x=>x.body.title==='Parent').length,1);await form.fire('submit');assert.equal(f.sent.filter(x=>x.body.title==='Parent').length,1);assert.equal(f.sent.at(-1).body.parent_id,'new1');
});
test('Corrected Universe dashboard hides search and filters until requested',async()=>{
 const f=await fixture('dashboard'),filters=descendants(f.panel).find(x=>x.className==='uni-filterbar');assert.equal(filters.hidden,true);await descendants(f.panel).find(x=>x.attrs['aria-label']==='Filter tasks').fire('click');assert.equal(filters.hidden,false);assert.equal(byText(f.panel,'Show Universe balances'),undefined);assert.equal(byText(f.panel,'Refresh tasks'),undefined);
});

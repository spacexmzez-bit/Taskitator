import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Element,descendants,byText,input,fixture} from './universe-interface.test.js';
const source=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};

test('Complete task panel separates scroll body and Save/Cancel footer and does not save on input',async()=>{
 const f=await fixture();await descendants(f.panel).find(x=>x.attrs['aria-label']==='Create Universe task').fire('click');const form=descendants(f.panel).find(x=>x.className?.includes('uni-editor modal-box'));
 assert.deepEqual(form.children.map(x=>x.className),['uni-editor-heading','uni-editor-body','uni-editor-actions']);
 input(form,'Title').value='Unsaved';await form.fire('input');assert.equal(f.sent.length,0);assert.equal(form.dataset.dirty,'true');await byText(form,'Cancel').fire('click');assert.equal(f.sent.length,0);assert.equal(form.parentElement.parentElement,null);
});

test('Task details use two columns without exposing a hidden assignment list',async()=>{
 const f=await fixture('projects',data=>{data.tasks[0].members=undefined;});await byText(f.panel,'First task').fire('click');const dialog=descendants(f.panel).find(x=>x.attrs.role==='dialog');assert.ok(descendants(dialog).some(x=>x.className==='uni-detail-layout'));assert.ok(byText(dialog,'Private assignment list'));assert.equal(f.sent.length,0);
});

async function completeUI(role='member'){
 const root=new Element('div'),body=new Element('body'),events={};body.append(root);const cls=n=>({add:s=>{n.className=s;},remove:()=>{},toggle:()=>{}});Object.defineProperty(body,'classList',{value:cls(body)});Object.defineProperty(root,'classList',{value:cls(root)});root.prepend=function(...nodes){for(const n of nodes)n.remove();this.children.unshift(...nodes);};
 const group={id:'g',title:'Team',purpose:'Study together',role,owner_pro:true,can_rename:role==='owner',can_add_members:role!=='member',revision:1};const window={Clerk:{session:{id:'s'},user:{id:'me',username:'Mazen'},addListener(){}},addEventListener:(k,fn)=>(events[k]??=[]).push(fn),TaskitatorAuth:{account:{user:'me'},api:async path=>{
 if(path==='/pro/status')return {isPro:true};if(path.endsWith('/capabilities'))return {ui:true,capabilities:{tasks:true}};if(path==='/universe/groups')return {groups:[group]};if(path.endsWith('/members'))return {members:[{account_id:'me',username:'Mazen',role}]};if(path.endsWith('/settings'))return {validate_criteria:true};if(path.endsWith('/invitations'))return {invitations:[]};if(path.endsWith('/activity'))return {events:[]};if(path.endsWith('/work'))return {revision:1,tasks:[],projects:[],assignments:[],catalog:[]};if(path.endsWith('/ai'))return {account:{daily:0,monthly:0}};return {group};}}};
 const doc={body,createElement:tag=>{const e=new Element(tag);Object.defineProperty(e,'classList',{value:cls(e)});return e;},getElementById:()=>root,querySelectorAll:()=>descendants(root).filter(x=>x.tag==='form')};const context={window,document:doc,navigator:{onLine:true},location:{search:'',href:'https://preview.local/components.html'},URL,URLSearchParams,Event,Date,Map,Set,Error};for(const name of ['universe-tasks-ui.js','universe-shell.js','universe-ui.js'])vm.runInNewContext(source(name),context);events['taskitator-universe-view'][0]();await flush();if(role==='owner')await byText(root,'Created Universes').fire('click');await byText(root,'Team').fire('click');await flush();return {root};
}

test('Member settings remain useful without owner controls or another member stats selector',async()=>{
 const {root}=await completeUI('member');assert.ok(byText(root,'Universe details'));assert.ok(byText(root,'Members'));assert.ok(byText(root,'Leave Universe'));assert.equal(byText(root,'Create invitation'),undefined);assert.equal(byText(root,'Delete Universe'),undefined);assert.equal(byText(root,'Disable criteria validation'),undefined);assert.ok(byText(root,'Only your own assignments and credit usage are shown.'));
});

test('Admin controls include invitations and labels but do not expose owner settings',async()=>{
 const {root}=await completeUI('admin');assert.ok(byText(root,'Create invitation'));assert.ok(byText(root,'Manage priorities'));assert.equal(byText(root,'Group settings'),undefined);assert.equal(byText(root,'Delete Universe'),undefined);assert.equal(byText(root,'Disable criteria validation'),undefined);
});

test('Phone preference failure does not remove export actions; comments edit is author-only',async()=>{
 const root=new Element('div'),window={Clerk:{user:{id:'me'}}};vm.runInNewContext(source('universe-release-ui.js'),{window,document:{createElement:t=>new Element(t)},Date,Map,Set,Error});
 await window.UniverseReleaseUI.mount(root,{id:'g',role:'owner'},{current:()=>true,run:fn=>fn(),api:async path=>{if(path.endsWith('/members'))return {members:[{account_id:'me',username:'Mazen'},{account_id:'other',username:'Sara'}]};if(path.endsWith('/work'))return {tasks:[],assignments:[]};if(path.endsWith('/consent'))throw Error('Unavailable');if(path.endsWith('/archive'))return {archives:[]};if(path.endsWith('/discussion'))return {comments:[{id:'a',actor_id:'other',body:'Hello',created_at:1},{id:'b',actor_id:'me',body:'My comment',created_at:1}],next:null};return {};},send:async()=>{throw Error('No writes expected');}});
 assert.ok(byText(root,'Export projects and tasks'));assert.ok(byText(root,'Retry phone preferences'));await byText(root,'Refresh discussion').fire('click');const comments=descendants(root).filter(x=>x.className==='uni-comment');assert.equal(comments.length,2);assert.equal(byText(comments[0],'Edit my comment'),undefined);assert.ok(byText(comments[1],'Edit my comment'));await byText(comments[1],'Edit my comment').fire('click');assert.equal(input(comments[1],'Edit your comment').value,'My comment');
});

test('Shared layer helper traps focus, sizes to visual viewport and releases scroll lock',async()=>{
 let document;const listeners=new Map();class E extends Element{constructor(t){super(t);this.tabIndex=['button','input','textarea','select'].includes(t)?0:-1;}get isConnected(){return this===document?.documentElement||!!this.parentElement?.isConnected;}getClientRects(){return this.isConnected?[{}]:[];}closest(s){let n=this;while(n){if(s==='[hidden]'&&n.hidden)return n;n=n.parentElement;}return null;}contains(target){return descendants(this).includes(target);}focus(){document.activeElement=this;}querySelectorAll(s){return descendants(this).slice(1).filter(x=>s.split(',').some(k=>k.trim()===x.tag||k.trim()==='[tabindex]'&&x.attrs.tabindex!==undefined));}}
 const html=new E('html'),body=new E('body'),root=new E('div');html.append(body);body.append(root);const old=new E('button');root.append(old);document={documentElement:html,body,activeElement:old,getElementById:()=>root,createElement:t=>new E(t),addEventListener:(k,f)=>{const a=listeners.get(k)||[];a.push(f);listeners.set(k,a);},removeEventListener:(k,f)=>listeners.set(k,(listeners.get(k)||[]).filter(x=>x!==f))};const vEvents={};const window={visualViewport:{offsetTop:10,height:400,addEventListener:(k,f)=>vEvents[k]=f,removeEventListener:k=>delete vEvents[k]}};
 vm.runInNewContext(source('universe-widgets.js'),{window,document,navigator:{onLine:true},setTimeout:()=>1,clearTimeout(){}});const overlay=new E('div'),first=new E('button'),last=new E('button');overlay.append(first,last);root.append(overlay);let close=0;const release=window.UniverseUX.layer(overlay,{initial:first,close:()=>close++});assert.equal(document.activeElement,first);assert.equal(html.style.overflow,'hidden');assert.equal(overlay.style.height,'400px');last.focus();let prevented=false;listeners.get('keydown')[0]({key:'Tab',preventDefault(){prevented=true;}});assert.ok(prevented);assert.equal(document.activeElement,first);listeners.get('keydown')[0]({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});await flush();assert.equal(close,1);release();assert.equal(document.activeElement,old);assert.equal(html.style.overflow,undefined);assert.deepEqual(Object.keys(vEvents),[]);
});

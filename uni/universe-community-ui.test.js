// Universe Community tab (Space plan Phase 3): browser behaviour with a fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Element,descendants,byText} from './universe-interface.test.js';
const source=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const byClass=(root,name)=>descendants(root).filter(x=>x.className?.split(' ').includes(name));
const label=(root,text)=>byText(root,text)?.children[0];
const now=Date.now();
const postRow=(i,extra={})=>({id:'p'+i,author_id:'a',author_role:'admin',username:'Huda',body:'Post '+i,legacy:false,comment_roles:['member'],comment_projects:[],comment_count:0,created_at:now-i*1000,edited_at:null,revision:1,can_comment:true,can_edit:false,can_delete:false,...extra});
export async function mountCommunity({role='member',posts=[postRow(1)],comments={},canPost=role==='owner'||role==='admin',view='community',extraGlobals={}}={}){
 const slot=new Element('section'),sent=[],gets=[];
 const window={Clerk:{user:{id:'me'}},addEventListener(){},removeEventListener(){},...extraGlobals};
 const context={window,document:{createElement:t=>new Element(t),createElementNS:(n,t)=>new Element(t),createTextNode:t=>{const n=new Element('#text');n.textContent=t;return n;}},Date,Map,Set,Error,URL,Event:class{constructor(t){this.type=t;}},confirm:()=>true,Promise,JSON};
 vm.createContext(context);vm.runInContext(source('universe-community-ui.js'),context);
 const api=async path=>{gets.push(path);if(path.endsWith('/work'))return {projects:[{id:'pr',title:'Lab'}]};const m=path.match(/\/posts\/([^/]+)\/comments/);if(m)return {post_id:m[1],can_comment:!posts.find(p=>p.id===m[1])?.legacy,next:null,comments:comments[m[1]]||[]};const after=path.match(/\/after\/(.+)$/)?.[1],i=after?posts.findIndex(p=>p.id===after)+1:0,page=posts.slice(i,i+5);return {posts:page,next:i+5<posts.length?page.at(-1).id:null,end:i+5>=posts.length,can_post:canPost};};
 await window.UniverseCommunityUI.mount(slot,{id:'g',role},[{account_id:'a',username:'Huda',role:'admin'}],{view,api,send:async(path,body)=>{sent.push({path,body});return {id:'new'};},run:fn=>fn(),current:()=>true,capabilities:{community:true}});
 return {slot,sent,gets,window};
}
test('Community feed: 5 posts, Load more, then an end state; members cannot post',async()=>{
 const f=await mountCommunity({posts:Array.from({length:7},(_,i)=>postRow(i))});
 assert.equal(byClass(f.slot,'uni-post').length,5);assert.equal(byText(f.slot,'New post'),undefined);
 await byText(f.slot,'Load more').fire('click');assert.equal(byClass(f.slot,'uni-post').length,7);assert.ok(byText(f.slot,'No more posts'));assert.equal(byText(f.slot,'Load more'),undefined);
 assert.deepEqual(f.gets.filter(p=>p.includes('/community')),['/universe/groups/g/community','/universe/groups/g/community/after/p4']);
 const empty=await mountCommunity({posts:[]});assert.ok(byText(empty.slot,'No posts yet'));assert.ok(byText(empty.slot,'Posts from your admins will appear here.'));
});
test('Community feed: user text is plain text marked as user content; the server decides edit and delete buttons',async()=>{
 const f=await mountCommunity({posts:[postRow(1,{body:'<img src=x onerror=alert(1)>',can_edit:true}),postRow(2,{can_delete:true})]});
 const bodies=byClass(f.slot,'uni-post-body');assert.deepEqual(bodies[0].children.map(c=>[c.tag,c.textContent]),[['#text','<img src=x onerror=alert(1)>']]);
 assert.ok(bodies.every(b=>b.attrs.translate==='no'&&b.attrs.dir==='auto'));
 const [first,second]=byClass(f.slot,'uni-post');assert.ok(byText(first,'Edit'));assert.equal(byText(first,'Delete'),undefined);assert.ok(byText(second,'Delete'));assert.equal(byText(second,'Edit'),undefined);
 assert.doesNotMatch(source('universe-community-ui.js'),/innerHTML/);
});
test('Composer: admins choose who may comment; the request carries the audience',async()=>{
 const f=await mountCommunity({role:'admin'});await byText(f.slot,'New post').fire('click');const sheet=byClass(f.slot,'uni-sheet').at(-1);
 assert.ok(byText(sheet,'Assignees of Lab'));label(sheet,'Post').value='Exam on Sunday';label(sheet,'Reviewers').checked=false;label(sheet,'Assignees of Lab').checked=true;
 await sheet.fire('submit');assert.deepEqual(JSON.parse(JSON.stringify(f.sent)),[{path:'/universe/groups/g/community/posts',body:{body:'Exam on Sunday',comment_roles:['member'],comment_projects:['pr']}}]);
 await byText(f.slot,'New post').fire('click');const blank=byClass(f.slot,'uni-sheet').at(-1);await assert.rejects(blank.fire('submit'),/Write something before publishing\./);
});
test('Thread: comments with frozen roles, removed comments keep their place, replies send parent_id',async()=>{
 const comments={p1:[{id:'c1',parent_id:null,author_id:'x',author_role:'member',username:'Noura',body:'Question',deleted:false,created_at:now,revision:1,can_edit:false,can_delete:false},{id:'c2',parent_id:'c1',author_id:'y',author_role:'reviewer',username:'Khalid',body:'',deleted:true,created_at:now,revision:2,can_edit:false,can_delete:false}]};
 const f=await mountCommunity({comments});await byClass(f.slot,'uni-comments-button')[0].fire('click');const t=byClass(f.slot,'uni-thread').at(-1);
 const rows=byClass(t,'uni-thread-comment');assert.equal(rows.length,2);assert.ok(rows[1].className.includes('is-removed'));assert.ok(byText(rows[1],'Removed'));assert.ok(byText(rows[1],'Reply to Noura'));
 assert.deepEqual(byClass(t,'uni-role-chip').map(c=>c.dataset.role),['admin','member','reviewer']);
 await byText(rows[0],'Reply').fire('click');assert.ok(byText(t,'Replying to Noura'));assert.ok(byText(t,'Cancel reply'));label(t,'Write a comment').value='Answer';await byClass(t,'uni-comment-form')[0].fire('submit');
 assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1))),{path:'/universe/groups/g/community/posts/p1/comments',body:{body:'Answer',parent_id:'c1'}});
});
test('Thread: the read-only Earlier discussion has no comment box',async()=>{
 const f=await mountCommunity({posts:[postRow(1,{id:'legacy_g',legacy:true,comment_count:1})],comments:{legacy_g:[]}});
 assert.ok(byText(f.slot,'Earlier discussion'));await byClass(f.slot,'uni-comments-button')[0].fire('click');const t=byClass(f.slot,'uni-thread').at(-1);
 assert.equal(byClass(t,'uni-comment-form')[0].hidden,true);assert.ok(byText(t,'This thread is read-only.'));
});
test('Community wiring: own tab only when the Worker reports it; old discussion hidden; comment rows are not whole user content',()=>{
 const shell=source('universe-shell.js'),ui=source('universe-ui.js'),rel=source('universe-release-ui.js');
 assert.match(shell,/features\.community\?\[\['community','Community'\]\]:\[\]/);assert.match(ui,/community:!!cap\.capabilities\?\.community&&!!window\.UniverseCommunityUI/);
 assert.match(rel,/if\(!tools\.capabilities\?\.community\)\{/);
 assert.doesNotMatch(source('universe-community-ui.js'),/'uni-comment'/);
 assert.match(readFileSync(new URL('../components.html',import.meta.url),'utf8'),/src="uni\/universe-community-ui\.js"/);
});

// ---- 3B ----
test('Links: http(s) only, open without referrer, real domain shown beside the link; other schemes stay text',async()=>{
 const doc={createElement:t=>new Element(t),createTextNode:t=>{const n=new Element('#text');n.textContent=t;return n;},createElementNS:(n,t)=>new Element(t)};
 const f=await mountCommunity({posts:[postRow(1,{body:'See https://example.com/a?b=1. and javascript:alert(1) or http://evil.test/login)'})],extraGlobals:{}});void doc;
 const body=byClass(f.slot,'uni-post-body')[0];const links=descendants(body).filter(n=>n.tag==='a');
 assert.deepEqual(links.map(a=>[a.href,a.textContent,a.rel,a.target]),[['https://example.com/a?b=1','https://example.com/a?b=1','noopener noreferrer','_blank'],['http://evil.test/login','http://evil.test/login','noopener noreferrer','_blank']]);
 assert.deepEqual(byClass(body,'uni-link-domain').map(d=>d.textContent),['example.com','evil.test']);
 assert.ok(descendants(body).some(n=>n.tag==='#text'&&n.textContent.includes('javascript:alert(1)')));
});
test('Attachments: images inline, files as download chips, end date shown; composer sends expiry and uploads once',async()=>{
 const files=[{id:'i1',kind:'image',name:'board.png',mime:'image/png',bytes:2048},{id:'f1',kind:'file',name:'notes.pdf',mime:'application/pdf',bytes:3*1048576}];
 const f=await mountCommunity({role:'admin',posts:[postRow(1,{files,expires_at:Date.UTC(2026,10,20,20,59)})],extraGlobals:{}});
 assert.equal(byClass(f.slot,'uni-post-image').length,0);
 const g=await mountFiles({posts:[postRow(1,{files,expires_at:Date.UTC(2026,10,20,20,59)})]});
 assert.equal(byClass(g.slot,'uni-post-image').length,1);const chip=byClass(g.slot,'uni-file-chip')[0];assert.equal(chip.attrs.translate,'no');assert.ok(byText(chip,'3.0 MB'));assert.match(byClass(g.slot,'uni-expiry')[0].textContent,/^Removed on /);
 await byText(g.slot,'New post').fire('click');const sheet=byClass(g.slot,'uni-sheet').at(-1);label(sheet,'Post').value='With end date';const pick=descendants(sheet).find(n=>n.tag==='select');pick.value='7';
 const picker=label(sheet,'Add files or images');const file={name:'a.txt',size:5,type:'text/plain',arrayBuffer:async()=>new TextEncoder().encode('hello').buffer};picker.files=[file];await picker.fire('change');
 g.failNext('/community/posts');await assert.rejects(sheet.fire('submit'));await sheet.fire('submit');
 const uploads=g.sent.filter(x=>x.path.endsWith('/community/files'));assert.equal(uploads.length,1);assert.equal(uploads[0].body.mime,'text/plain');assert.equal(uploads[0].body.size,5);
 const posted=g.sent.filter(x=>x.path.endsWith('/community/posts')).at(-1).body;assert.equal(posted.expires_in_days,7);assert.deepEqual(JSON.parse(JSON.stringify(posted.file_ids)),['new1']);
 const big={name:'b.pdf',size:9*1048576,type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)};await byText(g.slot,'New post').fire('click');const s2=byClass(g.slot,'uni-sheet').at(-1);label(s2,'Post').value='x';const p2=label(s2,'Add files or images');p2.files=[big];await p2.fire('change');await assert.rejects(s2.fire('submit'),/8 MB/);
});
async function mountFiles({posts}){const slot=new Element('section'),sent=[];let fail=null;
 const window={Clerk:{user:{id:'me'}},addEventListener(){},removeEventListener(){}};
 const context={window,document:{createElement:t=>new Element(t),createElementNS:(n,t)=>new Element(t),createTextNode:t=>{const n=new Element('#text');n.textContent=t;return n;}},Date,Map,Set,Error,Event:class{constructor(t){this.type=t;}},URL,Blob,Uint8Array,TextEncoder,crypto,btoa,atob,setTimeout,Promise,JSON};
 vm.createContext(context);vm.runInContext(source('universe-community-ui.js'),context);
 const api=async path=>{if(path.endsWith('/work'))return {projects:[]};if(path.includes('/files/'))return {name:'board.png',mime:'image/png',data:btoa('png')};return {posts,next:null,end:true,can_post:true};};
 await window.UniverseCommunityUI.mount(slot,{id:'g',role:'admin'},[],{view:'community',api,send:async(path,body)=>{if(fail&&path.endsWith(fail)){fail=null;throw Error('Offline');}sent.push({path,body});return {id:'new'+sent.length};},run:fn=>fn(),current:()=>true,capabilities:{community:true,community_files:true}});
 return {slot,sent,failNext:p=>fail=p};}

// ---- 3C ----
async function mountContext(state){const slot=new Element('section'),sent=[];
 const window={Clerk:{user:{id:'me'}},addEventListener(){},removeEventListener(){},confirm:()=>true};
 const context={window,document:{createElement:t=>new Element(t),createElementNS:(n,t)=>new Element(t),createTextNode:t=>{const n=new Element('#text');n.textContent=t;return n;}},Date,Map,Set,Error,URL,Blob,Uint8Array,crypto,btoa,atob,setTimeout,Promise,JSON,Event:class{constructor(t){this.type=t;}}};
 vm.createContext(context);vm.runInContext(source('universe-community-ui.js'),context);
 const api=async path=>{if(path.includes('/context/files/'))return {name:'a.png',mime:'image/png',data:btoa('x')};if(path.endsWith('/context'))return state;return {projects:[]};};
 await window.UniverseCommunityUI.mount(slot,{id:'g',role:state.can_upload?'admin':'member'},[],{view:'context',api,send:async(path,body)=>{sent.push({path,body});return {id:'c'+sent.length};},run:fn=>fn(),current:()=>true,capabilities:{context:true}});
 return {slot,sent};}
test('Context tab: usage, files and photos, admin upload and delete; members only download',async()=>{
 const files=[{id:'c1',kind:'image',name:'board.png',mime:'image/png',bytes:2048,uploader_id:'a',username:'Huda',created_at:now},{id:'c2',kind:'file',name:'Chapter 1.pdf',mime:'application/pdf',bytes:3*1048576,uploader_id:'a',username:'Huda',created_at:now}];
 const m=await mountContext({available:true,quota:200*1048576,used:3*1048576+2048,can_upload:false,files,retention_until:null});
 assert.ok(byText(m.slot,'3.0 MB of 200 MB used'));assert.equal(byClass(m.slot,'uni-context-item').length,2);assert.equal(byText(m.slot,'Delete'),undefined);assert.equal(byText(m.slot,'Upload'),undefined);
 assert.ok(byClass(m.slot,'uni-context-name').every(n=>n.attrs.translate==='no'));
 const a=await mountContext({available:true,quota:200*1048576,used:0,can_upload:true,files,retention_until:null});
 const pick=label(a.slot,'Add files or photos');pick.files=[{name:'n.txt',size:3,type:'text/plain',arrayBuffer:async()=>new TextEncoder().encode('abc').buffer}];
 await byClass(a.slot,'uni-context-upload')[0].fire('submit');assert.deepEqual([a.sent[0].path,a.sent[0].body.mime,a.sent[0].body.size],['/universe/groups/g/context/files','text/plain',3]);
 const pick2=label(a.slot,'Add files or photos');pick2.files=[{name:'big.pdf',size:11*1048576,type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)}];await assert.rejects(byClass(a.slot,'uni-context-upload')[0].fire('submit'),/10 MB/);
 await byText(byClass(a.slot,'uni-context-item')[1],'Delete').fire('click');assert.equal(a.sent.at(-1).path,'/universe/groups/g/context/files/c2/delete');
});
test('Context tab: when the owner’s Pro has lapsed it explains the 3-month retention and how to restore',async()=>{
 const c=await mountContext({available:false,quota:200*1048576,used:5*1048576,can_upload:true,files:[],retention_until:Date.UTC(2027,1,15,12)});
 assert.ok(byText(c.slot,'Context is off'));assert.ok(descendants(c.slot).some(n=>/^The owner’s Pro has lapsed\. Files are kept until .+, then deleted\.$/.test(n.textContent||'')));assert.ok(byText(c.slot,'The owner can renew Pro, or transfer ownership to a member who has Pro, to bring the files back.'));assert.equal(byText(c.slot,'Upload'),undefined);
 assert.match(source('universe-ui.js'),/context:!!cap\.capabilities\?\.context&&!!window\.UniverseCommunityUI/);
});

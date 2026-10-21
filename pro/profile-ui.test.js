import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('pro/profile-ui.js',root),'utf8');
function profile({username=null,metadata={},modern=true,fail=false}={}) {
    const nodes=new Map(),events=new Map(),requests=[];
    class Node {
        constructor(){this.events=new Map();this.value='';this.disabled=false;this.textContent='';}
        setAttribute(){}
        addEventListener(name,fn){this.events.set(name,fn)}
        querySelector(selector){if(!nodes.has(selector.slice(1)))nodes.set(selector.slice(1),new Node());return nodes.get(selector.slice(1))}
        showModal(){this.open=true}
        close(){this.open=false;this.events.get('close')?.()}
        remove(){nodes.delete(this.id)}
        focus(){this.focused=true}
    }
    const button=new Node();nodes.set('accountUsernameBtn',button);
    const user={id:'user_A',username,unsafeMetadata:metadata};
    const save=async body=>{
        requests.push(body);
        if(fail)throw new Error('Network unavailable');
        user.unsafeMetadata={...user.unsafeMetadata,...body.unsafeMetadata};return user;
    };
    user[modern?'updateMetadata':'update']=save;
    const window={Clerk:{user,session:{id:'sess_A'}},addEventListener(name,fn){events.set(name,fn)}};
    const document={getElementById:id=>nodes.get(id)||null,createElement:()=>new Node(),
        body:{appendChild(node){nodes.set(node.id,node)}}};
    vm.runInContext(source,vm.createContext({window,document}));
    events.get('taskitator-auth-ready')();
    return {window,nodes,events,requests,button,user,
        open(){button.events.get('click')()},
        submit(){return nodes.get('taskitatorUsernameForm').events.get('submit')({preventDefault(){}})}};
}

test('Taskitator editor saves an account display name without Clerk username configuration or profile UI',async()=>{
    const f=profile();assert.equal(f.button.textContent,'Set username');f.open();
    assert.equal(f.nodes.get('taskitatorUsernameDialog').open,true);
    f.nodes.get('taskitatorUsernameInput').value='Hogkla';await f.submit();
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].unsafeMetadata.taskitator_username,'Hogkla');
    assert.equal(f.button.textContent,'@Hogkla');assert.equal(f.nodes.has('taskitatorUsernameDialog'),false);
    const otherDevice=profile({metadata:f.user.unsafeMetadata});assert.equal(otherDevice.button.textContent,'@Hogkla');
});
test('ClerkJS fallback preserves unrelated metadata and Taskitator name overrides Clerk login name',async()=>{
    const f=profile({username:'LoginName',metadata:{theme:'dark',preferences:{retained:true}},modern:false});
    assert.equal(f.button.textContent,'@LoginName');f.open();f.nodes.get('taskitatorUsernameInput').value='NewName';await f.submit();
    assert.equal(f.user.unsafeMetadata.theme,'dark');assert.equal(f.user.unsafeMetadata.preferences.retained,true);
    assert.equal(f.button.textContent,'@NewName');assert.equal(f.user.username,'LoginName');
});
test('cancel and X close the username editor without changing the account',()=>{
    for(const id of ['usernameCancelBtn','usernameCloseBtn']){
        const f=profile();f.open();f.nodes.get(id).events.get('click')();
        assert.equal(f.nodes.has('taskitatorUsernameDialog'),false);assert.equal(f.requests.length,0);
    }
});
test('invalid input or failed save preserves the previous username and allows retry/cancel',async()=>{
    const invalid=profile({metadata:{taskitator_username:'OldName'}});invalid.open();invalid.nodes.get('taskitatorUsernameInput').value='<script>';await invalid.submit();
    assert.equal(invalid.requests.length,0);assert.equal(invalid.button.textContent,'@OldName');
    const f=profile({metadata:{taskitator_username:'OldName'},fail:true});f.open();f.nodes.get('taskitatorUsernameInput').value='NewName';await f.submit();
    assert.equal(f.button.textContent,'@OldName');assert.match(f.nodes.get('usernameFeedback').textContent,/Network unavailable/);
    assert.equal(f.nodes.get('usernameSaveBtn').disabled,false);assert.equal(f.nodes.get('usernameCancelBtn').disabled,false);
});
test('a session change during save cannot paint the prior account username into the current account UI',async()=>{
    const f=profile();f.open();let finish;
    f.user.updateMetadata=()=>new Promise(resolve=>{finish=resolve});
    f.nodes.get('taskitatorUsernameInput').value='OtherName';const pending=f.submit();
    f.window.Clerk.session={id:'sess_B'};finish({id:'user_A',unsafeMetadata:{taskitator_username:'OtherName'}});await pending;
    assert.equal(f.button.textContent,'Set username');assert.match(f.nodes.get('usernameFeedback').textContent,/account changed/);
});
test('refresh paints the updated account name safely as text',()=>{
    const f=profile({metadata:{taskitator_username:'<img src=x onerror=bad()>'}});
    assert.equal(f.button.textContent,'@<img src=x onerror=bad()>');
    f.user.unsafeMetadata.taskitator_username='Renamed';f.window.TaskitatorProfile.refresh();assert.equal(f.button.textContent,'@Renamed');
});

test('service worker refreshes Pro scripts and styles before using cached copies',async()=>{
    const handlers=new Map(),calls=[],pending=[];
    const cache={async match(){calls.push('cache-match');return new Response('cached-ui')},async put(){calls.push('cache-put')}};
    const self={location:{origin:'https://taskitator.test'},addEventListener(name,fn){handlers.set(name,fn)}};
    const context=vm.createContext({self,URL,Request,Response,caches:{async open(){return cache}},fetch:async(request,options)=>{
        calls.push('fetch:'+options.cache);return new Response('fresh-ui');
    }});
    vm.runInContext(fs.readFileSync(new URL('sw.js',root),'utf8'),context);
    for(const path of ['/pro/pro-ui.js','/style.css','/pro/profile-ui.js']){
        let response;
        handlers.get('fetch')({request:new Request('https://taskitator.test'+path),respondWith(value){response=value},waitUntil(value){pending.push(value)}});
        assert.equal(await (await response).text(),'fresh-ui');
    }
    await Promise.all(pending);assert.equal(calls.includes('cache-match'),false);
    assert.equal(calls.filter(call=>call==='fetch:no-cache').length,3);
    // An actual network failure can fall back only to this release's cache.
    context.fetch=async()=>{throw new Error('offline')};let response;
    handlers.get('fetch')({request:new Request('https://taskitator.test/pro/pro-ui.js'),respondWith(value){response=value},waitUntil(){}});
    assert.equal(await (await response).text(),'cached-ui');
    let intercepted=false;
    handlers.get('fetch')({request:new Request('https://taskitator.test/auth/account'),respondWith(){intercepted=true}});
    assert.equal(intercepted,false);
});
test('Pro UI and username scripts wait for authenticated cache activation',()=>{
    for(const file of ['index.html','settings.html']){
        const html=fs.readFileSync(new URL(file,root),'utf8');
        assert.match(html,/<script type="text\/taskitator-script" src="pro\/pro-ui\.js"><\/script>/);
        assert.doesNotMatch(html,/<script defer src="pro\/pro-ui\.js"/);
    }
    const bootstrap=fs.readFileSync(new URL('auth-bootstrap.js',root),'utf8');
    assert.ok(bootstrap.indexOf('location.reload()')<bootstrap.indexOf('await TaskitatorAuth.init()'));
    assert.ok(!bootstrap.includes('TaskitatorAuth.manageAccount()'));
});

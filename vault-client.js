(function () {
    'use strict';
    const auth = () => window.TaskitatorAuth;
    const byId = id => document.getElementById(id);
    const pendingKey = 'taskitator_key_verification';
    let metadata = {ready:false,saved:false,pending:[]}, owner = null, revealed = '', revealTimer;
    let operation = null, proofId = null, verified = false, busy = false;
    const api = (path,body,method='POST',extra={}) => auth().api(path,{method,...extra,...(body?{body:JSON.stringify(body)}:{})});
    function status(message) { const el=byId('vaultFeedback');if(el)el.textContent=message; }
    function clearReveal() {
        revealed='';clearTimeout(revealTimer);
        const field=byId('vaultRevealedKey');if(field)field.value='';
        const area=byId('vaultRevealArea');if(area)area.hidden=true;
    }
    function legacyEntries(user) {
        const entries=[];
        const parseSettings=snapshot=>JSON.parse(snapshot.taskitator_settings||'{}');
        const current=JSON.parse(localStorage.getItem('taskitator_settings')||'{}');
        const localOwner=localStorage.getItem('taskitator_local_owner') || localStorage.getItem('taskitator_legacy_local_owner') || current.worker_username;
        if(localOwner===user)entries.push({key:'taskitator_settings',settings:[current],value:current,direct:true});
        for(const key of Object.keys(localStorage)){
            try{
                if(key==='taskitator_account_cache_v2:'+encodeURIComponent(user)){
                    const value=JSON.parse(localStorage.getItem(key));entries.push({key,value,settings:[parseSettings(value)]});
                }else if(key==='taskitator_account_recovery_v1:'+encodeURIComponent(user)){
                    const value=JSON.parse(localStorage.getItem(key));
                    if(!Array.isArray(value))throw new Error();
                    entries.push({key,value,settings:value.map(parseSettings),array:true});
                }else if(key==='taskitator_unclaimed_backup'){
                    const value=JSON.parse(localStorage.getItem(key)),settings=parseSettings(value);
                    if(settings.worker_username===user)entries.push({key,value,settings:[settings]});
                }
            }catch{auth().storageWarnings.push('An unreadable browser backup remains on this device. Review it before clearing browser data.');}
        }
        return entries;
    }
    function render() {
        if(!byId('vaultStatus'))return;
        byId('vaultStatus').textContent=!metadata.ready?'Secure storage needs administrator setup.':metadata.saved?
            'Gemini key saved securely · ends in '+metadata.suffix:'No active Gemini key saved.';
        byId('vaultRecovered').replaceChildren();
        for(const item of metadata.pending||[]){
            const row=document.createElement('div');row.className='vault-recovery-row';
            const label=document.createElement('span');label.textContent='Recovered key · …'+item.suffix;row.append(label);
            for(const [label,kind]of [['Use this key','save'],['Show','reveal'],['Remove','delete']]){
                const button=document.createElement('button');button.type='button';button.className='icon-btn';button.textContent=label;
                button.addEventListener('click',()=>open(kind,item.id));row.append(button);
            }
            byId('vaultRecovered').append(row);
        }
        for(const [id,needsSaved]of [['vaultSaveBtn',false],['vaultShowBtn',true],['vaultCopyBtn',true],['vaultDeleteBtn',true],['vaultTestBtn',true]]){
            byId(id).disabled=!metadata.ready || (needsSaved && !metadata.saved);
        }
    }
    const vault = {
        get available(){return owner===auth()?.account?.user && Boolean(metadata.ready && metadata.saved);},
        async refresh(){metadata=await api('/ai/keys',null,'GET');render();return metadata;},
        async initialize(){
            const user=auth().account?.user;if(!user)return;
            const sessionId=window.Clerk.session.id;
            owner=user;await this.refresh();
            const entries=legacyEntries(user),keys=[],claudeKeys=[];
            for(const entry of entries)for(const settings of entry.settings){
                if(typeof settings.gemini_api_key==='string' && settings.gemini_api_key.trim())keys.push(settings.gemini_api_key);
                if(typeof settings.claude_api_key==='string' && settings.claude_api_key.trim())claudeKeys.push(settings.claude_api_key);
            }
            if(keys.length||claudeKeys.length){
                // A browser key is recovered, never silently made active. Only a
                // one-use verified save can select it as the current provider key.
                metadata=await api('/ai/keys/stage',{keys:[...new Set(keys)],claude_keys:[...new Set(claudeKeys)]});
                if(auth().account?.user!==user || window.Clerk.session?.id!==sessionId)throw new Error('Account changed during key migration. Reload to continue.');
            }
            for(const entry of entries){
                if(!entry.settings.some(settings=>'gemini_api_key' in settings || 'claude_api_key' in settings))continue;
                const clean=entry.settings.map(settings=>auth().cleanSettings(settings));
                if(entry.direct)localStorage.setItem(entry.key,JSON.stringify(clean[0]));
                else{
                    (entry.array?entry.value:[entry.value]).forEach((snapshot,i)=>snapshot.taskitator_settings=JSON.stringify(clean[i]));
                    localStorage.setItem(entry.key,JSON.stringify(entry.value));
                }
            }
            render();
        },
        async generate(model,payload){
            // Return a Response to preserve the existing audit/fallback behavior.
            try{return Response.json(await api('/ai/generate',{model,payload},'POST',{timeoutMs:70000}));}
            catch(error){return Response.json({error:{message:error.message}},{status:error.status||503});}
        },
        clear:clearReveal
    };
    function updateDialog(){
        byId('vaultPasswordBtn').disabled=busy || window.Clerk.user?.passwordEnabled===false;
        byId('vaultGoogleBtn').disabled=busy;
        byId('vaultConfirmBtn').disabled=busy || !verified;
        byId('vaultCancelBtn').disabled=busy;
        byId('vaultNewKey').disabled=busy;
        byId('vaultNewKeyArea').hidden=operation?.kind!=='save' || Boolean(operation?.stageId);
    }
    function dialogMessage(message){byId('vaultDialogFeedback').textContent=message;}
    function open(kind,stageId=null){
        if(busy)return;
        // Google returns to a fresh Settings load with Tags & Prio selected.
        // Show the Account tab so the revealed key and clipboard fallback appear.
        document.querySelector('.tab-btn[data-tab="tab-account"]')?.click();
        clearReveal();operation={kind,stageId};proofId=null;verified=false;
        byId('vaultPassword').value='';byId('vaultNewKey').value='';
        byId('vaultDialogTitle').textContent=({save:stageId?'Activate recovered key':'Save / replace Gemini key',delete:stageId?'Remove recovered key':'Delete saved Gemini key',reveal:'Show saved key',copy:'Copy saved key'})[kind];
        dialogMessage('Confirm with your password or the Google account linked to this login. Each confirmation authorizes this action once.');
        byId('vaultConfirmBtn').textContent=kind==='delete'?'Delete key':kind==='save'?'Save key':'Continue';
        byId('vaultDialog').showModal();updateDialog();
    }
    function action(){return 'api-key-'+(['copy','reveal'].includes(operation.kind)?'reveal':operation.kind);}
    async function start(method){
        const result=await api('/auth/verification/start',{method,action:action(),stage_id:operation.stageId});
        proofId=result.verification_id;return result;
    }
    async function password(){
        if(busy)return;busy=true;verified=false;updateDialog();
        try{
            const input=byId('vaultPassword');if(!input.value)throw new Error('Enter your current sign-in password.');
            dialogMessage('Confirming your password…');await start('password');
            await window.Clerk.session.startVerification({level:'first_factor'});
            const result=await window.Clerk.session.attemptFirstFactorVerification({strategy:'password',password:input.value});
            if(result.status!=='complete')throw new Error('Password confirmation did not complete.');
            await api('/auth/verification/password',{verification_id:proofId,action:action()},'POST',{freshToken:true});
            verified=true;dialogMessage('Identity confirmed. Continue within five minutes.');
        }catch(error){dialogMessage(error.message);}
        finally{byId('vaultPassword').value='';busy=false;updateDialog();}
    }
    async function google(){
        if(busy)return;busy=true;verified=false;updateDialog();
        try{
            const result=await start('google');
            // Only action metadata survives navigation; no API key or password.
            sessionStorage.setItem(pendingKey,JSON.stringify({...operation,proofId,user:auth().account.user,session:window.Clerk.session.id}));
            byId('vaultNewKey').value='';byId('vaultPassword').value='';
            location.assign(result.authorization_url);
        }catch(error){dialogMessage(error.message);busy=false;updateDialog();}
    }
    async function confirm(){
        if(busy||!verified)return;busy=true;updateDialog();
        try{
            const body={verification_id:proofId,stage_id:operation.stageId};
            if(operation.kind==='save'){
                if(!operation.stageId)body.key=byId('vaultNewKey').value;
                metadata=await api('/ai/keys',body);status(metadata.test.message);
            }else if(operation.kind==='delete'){
                metadata=await api('/ai/keys',body,'DELETE');status('Key removed. This does not revoke it at Google AI Studio.');
            }else{
                const result=await api('/ai/keys/reveal',body);revealed=result.key;
                byId('vaultRevealedKey').value=revealed;byId('vaultRevealArea').hidden=false;
                revealTimer=setTimeout(clearReveal,Math.min(result.reveal_seconds||30,30)*1000);
                status('Key shown for 30 seconds. Copies placed on your clipboard may remain there.');
                if(operation.kind==='copy'){
                    try{await navigator.clipboard.writeText(revealed);status('Key copied. Your clipboard may retain it after the display clears.');}
                    catch{status('Key ready. Press Copy displayed key while it is visible.');}
                }
            }
            byId('vaultDialog').close();verified=false;sessionStorage.removeItem(pendingKey);render();
        }catch(error){
            if(error.status===403)verified=false;
            dialogMessage(error.message+' If the request timed out, refresh key status before trying again.');
        }finally{byId('vaultNewKey').value='';byId('vaultPassword').value='';busy=false;updateDialog();}
    }
    window.TaskitatorVault=vault;
    window.addEventListener('pagehide',()=>{clearReveal();for(const id of ['vaultPassword','vaultNewKey']){const el=byId(id);if(el)el.value='';}});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearReveal();const input=byId('vaultPassword');if(input)input.value='';}});
    window.addEventListener('taskitator-auth-ready',async()=>{
        if(!byId('vaultDialog'))return;
        render();
        for(const [id,kind]of [['vaultSaveBtn','save'],['vaultShowBtn','reveal'],['vaultCopyBtn','copy'],['vaultDeleteBtn','delete']])byId(id).addEventListener('click',()=>open(kind));
        byId('vaultPasswordBtn').addEventListener('click',password);byId('vaultGoogleBtn').addEventListener('click',google);
        byId('vaultConfirmBtn').addEventListener('click',confirm);
        byId('vaultCancelBtn').addEventListener('click',()=>{if(!busy)byId('vaultDialog').close();});
        byId('vaultDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
        byId('vaultDialog').addEventListener('close',()=>{verified=false;proofId=null;byId('vaultNewKey').value='';byId('vaultPassword').value='';});
        byId('vaultHideBtn').addEventListener('click',clearReveal);
        byId('vaultCopyDisplayedBtn').addEventListener('click',async()=>{
            if(!revealed)return;try{await navigator.clipboard.writeText(revealed);status('Key copied. Your clipboard may retain it.');}catch{status('Clipboard access was denied. Select the displayed key and copy it manually.');}
        });
        byId('vaultRefreshBtn').addEventListener('click',async()=>{clearReveal();try{await vault.refresh();status('Key status refreshed.');}catch(error){status(error.message);}});
        byId('vaultTestBtn').addEventListener('click',async()=>{byId('vaultTestBtn').disabled=true;try{status((await api('/ai/keys/test',{})).message);}catch(error){status(error.message);}finally{render();}});
        const match=/^#key-verification=([a-f0-9]{64})$/.exec(location.hash);
        if(match){
            history.replaceState(null,'',location.pathname+location.search);
            try{
                const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');sessionStorage.removeItem(pendingKey);
                if(pending?.proofId!==match[1] || pending.user!==auth().account.user || pending.session!==window.Clerk.session.id || !['save','delete','reveal','copy'].includes(pending.kind))throw new Error('Google confirmation does not belong to this session. Start again.');
                open(pending.kind,pending.stageId);proofId=match[1];
                const result=await api('/auth/verification/status',{verification_id:proofId,action:action()});
                verified=result.verified;
                dialogMessage(verified?'Google identity confirmed. Continue within five minutes. For a new key, enter it now.':'Google confirmation was cancelled or failed. Use the linked Google account and try again.');
                updateDialog();
            }catch(error){status(error.message);}
        }
    });
})();

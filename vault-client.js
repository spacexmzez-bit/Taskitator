(function () {
    'use strict';
    const auth = () => window.TaskitatorAuth;
    const byId = id => document.getElementById(id);
    const pendingKey = 'taskitator_key_verification';
    const models={gemini:['gemini-3.5-flash-lite','gemini-3.1-flash-lite'],claude:['claude-haiku-5-5']};
    const names={gemini:'Gemini',claude:'Claude'};
    let metadata = {ready:false,saved:false,pending:[]}, owner = null, revealed = '', revealTimer;
    let providers={gemini:metadata,claude:{ready:false,saved:false,pending:[]}},activeProvider='gemini',viewedProvider='gemini',inflight=0;
    let operation = null, proofId = null, verified = false, busy = false;
    const api = (path,body,method='POST',extra={}) => auth().api(path,{method,...extra,...(body?{body:JSON.stringify(body)}:{})});
    function status(message) { const el=byId('vaultFeedback');if(el)el.textContent=message; }
    function acceptMetadata(data,follow=false){
        const previous=activeProvider+':'+(providers[activeProvider]?.version||'empty');
        if(data.providers)providers=data.providers;
        else providers[data.provider||'gemini']=data;
        if(Object.hasOwn(models,data.selected_provider))activeProvider=data.selected_provider;
        if(follow)viewedProvider=activeProvider;
        metadata=providers[viewedProvider]||{ready:false,saved:false,pending:[]};
        const changed=previous!==activeProvider+':'+(providers[activeProvider]?.version||'empty');
        if(changed){
            clearReveal();sessionStorage.removeItem('gemini_fallback_active');
            window.dispatchEvent?.(new CustomEvent('taskitator-ai-provider-changed',{detail:{provider:activeProvider}}));
        }
        render();return data;
    }
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
        for(const chip of document.querySelectorAll?.('.copilot-model-chip')||[])chip.textContent=models[activeProvider][0];
        if(!byId('vaultStatus'))return;
        byId('vaultStatus').textContent=!metadata.ready?'Secure storage needs administrator setup.':metadata.saved?
            names[viewedProvider]+' key saved securely · ends in '+metadata.suffix:'No saved '+names[viewedProvider]+' key.';
        if(byId('aiProviderSelect')){byId('aiProviderSelect').value=viewedProvider;byId('aiProviderSelect').disabled=busy;}
        if(byId('aiActiveProvider'))byId('aiActiveProvider').textContent='Currently used for AI: '+names[activeProvider];
        if(byId('vaultUseProviderBtn')){
            byId('vaultUseProviderBtn').disabled=busy || !metadata.ready || !metadata.saved || viewedProvider===activeProvider;
            byId('vaultUseProviderBtn').textContent=viewedProvider===activeProvider?names[viewedProvider]+' is active':'Use '+names[viewedProvider]+' for AI';
        }
        if(byId('vaultModelInfo'))byId('vaultModelInfo').textContent=viewedProvider==='claude'?
            'Claude Haiku 5.5 (claude-haiku-5-5). No automatic switch to Gemini. Claude accepts JPG, PNG, WebP and PDF here; convert HEIC photos or use Gemini.':
            'Gemini 3.5 Flash-Lite (gemini-3.5-flash-lite), with Gemini 3.1 Flash-Lite (gemini-3.1-flash-lite) fallback under the existing quota/unavailable rules. No automatic switch to Claude.';
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
        if(metadata.archive_pending){
            const message=document.createElement('p');message.textContent='Additional encrypted Claude archives remain. Review/remove recovered copies and refresh; if they do not appear, ask the operator to check retained vault key versions.';
            byId('vaultRecovered').append(message);
        }
        for(const [id,needsSaved]of [['vaultSaveBtn',false],['vaultShowBtn',true],['vaultCopyBtn',true],['vaultDeleteBtn',true],['vaultTestBtn',true]]){
            byId(id).disabled=busy || !metadata.ready || (needsSaved && !metadata.saved);
        }
    }
    const vault = {
        get provider(){return activeProvider;},
        get available(){return owner===auth()?.account?.user && Boolean(providers[activeProvider]?.ready && providers[activeProvider]?.saved);},
        selection(){return {provider:activeProvider,primary:models[activeProvider][0],fallback:models[activeProvider][1]||null,keyVersion:providers[activeProvider]?.version};},
        async refresh(follow=false){
            const user=auth().account?.user,session=window.Clerk.session?.id;
            const data=await api('/ai/keys',null,'GET');
            if(user!==auth().account?.user || session!==window.Clerk.session?.id)throw new Error('Account changed. Reload before accessing AI settings.');
            return acceptMetadata(data,follow);
        },
        async initialize(){
            const user=auth().account?.user;if(!user)return;
            const sessionId=window.Clerk.session.id;
            owner=user;activeProvider='gemini';viewedProvider='gemini';await this.refresh(true);
            const entries=legacyEntries(user),keys=[],claudeKeys=[];
            for(const entry of entries)for(const settings of entry.settings){
                if(typeof settings.gemini_api_key==='string' && settings.gemini_api_key.trim())keys.push(settings.gemini_api_key);
                if(typeof settings.claude_api_key==='string' && settings.claude_api_key.trim())claudeKeys.push(settings.claude_api_key);
            }
            if(keys.length||claudeKeys.length){
                // A browser key is recovered, never silently made active. Only a
                // one-use verified save can select it as the current provider key.
                acceptMetadata(await api('/ai/keys/stage',{keys:[...new Set(keys)],claude_keys:[...new Set(claudeKeys)]}));
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
        async generate(model,payload,selection=this.selection()){
            // Return a Response to preserve the existing audit/fallback behavior.
            inflight++;
            try{return Response.json(await api('/ai/generate',{model,payload,provider:selection.provider,key_version:selection.keyVersion},'POST',{timeoutMs:70000}));}
            catch(error){return Response.json({error:{message:error.message}},{status:error.status||503});}
            finally{inflight--;}
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
    function dialogMessage(message){
        const el=byId('vaultDialogFeedback');
        if(!el)return;
        el.textContent=message;
        const isErr=/needs one-time setup|misconfigured|Connect your Google|expired|failed|error|invalid/i.test(message);
        const isOk=/confirmed/i.test(message);
        el.style.cssText=isErr?'padding:10px 12px;border-radius:8px;background:rgba(239,68,68,0.16);border:1px solid #ef4444;color:#fca5a5;font-weight:600;margin:10px 0;':
                         isOk?'padding:10px 12px;border-radius:8px;background:rgba(16,185,129,0.16);border:1px solid #10b981;color:#34d399;font-weight:600;margin:10px 0;':
                         'padding:8px 0;color:#cbd5e1;';
    }
    function open(kind,stageId=null){
        if(busy)return;
        // Google returns to a fresh Settings load with Tags & Prio selected.
        // Show the Account tab so the revealed key and clipboard fallback appear.
        document.querySelector('.tab-btn[data-tab="tab-account"]')?.click();
        clearReveal();operation={kind,stageId,provider:viewedProvider};proofId=null;verified=false;
        byId('vaultPassword').value='';byId('vaultNewKey').value='';
        byId('vaultDialogTitle').textContent=({save:stageId?'Activate recovered key':'Save / replace '+names[viewedProvider]+' key',delete:stageId?'Remove recovered key':'Delete saved '+names[viewedProvider]+' key',reveal:'Show saved '+names[viewedProvider]+' key',copy:'Copy saved '+names[viewedProvider]+' key'})[kind];
        if(byId('vaultNewKeyLabel'))byId('vaultNewKeyLabel').textContent='New '+names[viewedProvider]+' API key';
        dialogMessage('Confirm with your password or the Google account linked to this login. Each confirmation authorizes this action once.');
        byId('vaultConfirmBtn').textContent=kind==='delete'?'Delete key':kind==='save'?'Save key':'Continue';
        byId('vaultDialog').showModal();updateDialog();
    }
    function action(){return 'api-key-'+(['copy','reveal'].includes(operation.kind)?'reveal':operation.kind);}
    async function start(method){
        const result=await api('/auth/verification/start',{method,action:action(),stage_id:operation.stageId,provider:operation.provider});
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
            if(result.verified){
                verified=true;
                dialogMessage('Google identity confirmed via your active Clerk session. Click Continue below.');
                busy=false;
                updateDialog();
                return;
            }
            if(!result.authorization_url)throw new Error('Google verification URL missing.');
            // Only action metadata survives navigation; no API key or password.
            sessionStorage.setItem(pendingKey,JSON.stringify({...operation,proofId,user:auth().account.user,session:window.Clerk.session.id}));
            byId('vaultNewKey').value='';byId('vaultPassword').value='';
            location.assign(result.authorization_url);
        }catch(error){dialogMessage(error.message);busy=false;updateDialog();}
    }
    async function confirm(){
        if(busy||!verified)return;busy=true;updateDialog();
        try{
            const body={verification_id:proofId,stage_id:operation.stageId,provider:operation.provider};
            if(operation.kind==='save'){
                if(!operation.stageId)body.key=byId('vaultNewKey').value;
                const result=await api('/ai/keys',body);acceptMetadata(result);status(result.test.message+' Press Use '+names[viewedProvider]+' for AI if you want to activate this provider.');
            }else if(operation.kind==='delete'){
                acceptMetadata(await api('/ai/keys',body,'DELETE'));status('Key removed. Revoke it separately at '+(operation.provider==='claude'?'Claude Console.':'Google AI Studio.'));
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
        }finally{byId('vaultNewKey').value='';byId('vaultPassword').value='';busy=false;updateDialog();render();}
    }
    window.TaskitatorVault=vault;
    window.addEventListener('pagehide',()=>{clearReveal();for(const id of ['vaultPassword','vaultNewKey']){const el=byId(id);if(el)el.value='';}});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){clearReveal();const input=byId('vaultPassword');if(input)input.value='';}});
    window.addEventListener('taskitator-auth-ready',async()=>{
        if(!byId('vaultDialog'))return;
        render();
        byId('aiProviderSelect')?.addEventListener('change',event=>{
            if(!Object.hasOwn(models,event.target.value))return;
            clearReveal();viewedProvider=event.target.value;metadata=providers[viewedProvider]||{ready:false,saved:false,pending:[]};render();
            status('Showing '+names[viewedProvider]+' keys. Save/test a key, then use the activation button to change the AI provider. Your other key stays saved.');
        });
        byId('vaultModelInfoBtn')?.addEventListener('click',()=>{
            const info=byId('vaultModelInfo');info.hidden=!info.hidden;byId('vaultModelInfoBtn').setAttribute('aria-expanded',String(!info.hidden));
        });
        byId('vaultUseProviderBtn')?.addEventListener('click',async()=>{
            if(busy)return;busy=true;render();clearReveal();
            try{if(inflight)throw new Error('Wait for the current AI request to finish before switching providers.');
                acceptMetadata(await api('/ai/provider',{provider:viewedProvider}));status(names[activeProvider]+' is now used for AI. Your other provider key stays saved.');
            }catch(error){status(error.message);}finally{busy=false;render();}
        });
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
        byId('vaultRefreshBtn').addEventListener('click',async()=>{if(busy)return;busy=true;render();clearReveal();try{await vault.refresh();status('Key status refreshed.');}catch(error){status(error.message);}finally{busy=false;render();}});
        byId('vaultTestBtn').addEventListener('click',async()=>{if(busy)return;busy=true;render();try{status(names[viewedProvider]+': '+(await api('/ai/keys/test',{provider:viewedProvider})).message);}catch(error){status(error.message);}finally{busy=false;render();}});
        const match=/^#key-verification=([a-f0-9]{64})$/.exec(location.hash);
        if(match){
            history.replaceState(null,'',location.pathname+location.search);
            try{
                const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');sessionStorage.removeItem(pendingKey);
                if(pending?.proofId!==match[1] || pending.user!==auth().account.user || pending.session!==window.Clerk.session.id || !['save','delete','reveal','copy'].includes(pending.kind))throw new Error('Google confirmation does not belong to this session. Start again.');
                const provider=pending.provider||'gemini';if(!Object.hasOwn(models,provider))throw new Error('Invalid provider confirmation. Start again.');
                viewedProvider=provider;metadata=providers[provider]||{ready:false,saved:false,pending:[]};render();
                open(pending.kind,pending.stageId);proofId=match[1];
                const result=await api('/auth/verification/status',{verification_id:proofId,action:action()});
                verified=result.verified && (!result.context || result.context.provider===provider);
                dialogMessage(verified?'Google identity confirmed. Continue within five minutes. For a new key, enter it now.':'Google confirmation was cancelled or failed. Use the linked Google account and try again.');
                updateDialog();
            }catch(error){status(error.message);}
        }
    });
    window.addEventListener('taskitator-synced',()=>{
        if(!busy && owner && owner===auth().account?.user)vault.refresh().catch(error=>status(error.message));
    });
})();

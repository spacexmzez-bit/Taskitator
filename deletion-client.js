(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    let proofId = null, verified = false, busy = false;
    let deletionOwner = null;
    const RECEIPT_KEY = 'taskitator_deletion_receipt';
    function feedback(message) { byId('accountDeletionFeedback').textContent = message; }
    function update() {
        byId('confirmAccountDeletionBtn').disabled = busy || !verified ||
            !byId('deletionBlockerDisabled').checked || byId('deletionPhrase').value !== 'Macrodroid disabled';
        byId('verifyDeletionPasswordBtn').disabled = busy;
        byId('verifyDeletionGoogleBtn').disabled = busy;
        byId('cancelAccountDeletionBtn').disabled = busy;
    }
    async function cleanLocal(user) {
        let complete = true;
        try {
            if (window.ExemplarStore?.deleteAccountFiles) complete = await window.ExemplarStore.deleteAccountFiles(user);
        } catch { complete = false; }
        try {
            if (localStorage.getItem('taskitator_local_owner') === user) {
                window.SyncEngine?.clearLocalAccount();
                localStorage.removeItem('taskitator_session_id');
            }
            for (const key of Object.keys(localStorage)) {
                const safe = key === 'taskitator_account_cache_v2:'+encodeURIComponent(user) ||
                    key === 'taskitator_account_recovery_v1:'+encodeURIComponent(user);
                let legacy = false;
                if (key.startsWith('taskitator_account_cache:')) {
                    const tail = key.slice('taskitator_account_cache:'.length);
                    legacy = tail.slice(0,tail.lastIndexOf(':')) === user;
                }
                if (safe || legacy) localStorage.removeItem(key);
            }
            const raw = localStorage.getItem('taskitator_unclaimed_backup');
            if (raw) {
                try {
                    const snapshot = JSON.parse(raw), settings = JSON.parse(snapshot.taskitator_settings || '{}');
                    if (settings.worker_username === user) localStorage.removeItem('taskitator_unclaimed_backup');
                    else if (!settings.worker_username) complete = false;
                } catch { complete = false; }
            }
            if (localStorage.getItem('taskitator_legacy_local_owner') === user) localStorage.removeItem('taskitator_legacy_local_owner');
            if (localStorage.getItem('taskitator_exemplar_legacy_owner') === user) localStorage.setItem('taskitator_exemplar_legacy_owner','__deleted__');
        } catch { complete = false; }
        sessionStorage.setItem('taskitator_deletion_local_cleanup', complete ? 'complete' : 'incomplete');
        return complete;
    }
    async function start(method) {
        verified = false; proofId = null;
        const data = await window.TaskitatorAuth.api('/auth/verification/start',{
            method:'POST',body:JSON.stringify({method})});
        proofId = data.verification_id;
        sessionStorage.setItem('taskitator_deletion_verification',proofId);
        return data;
    }
    async function password() {
        if (busy) return;
        busy = true; update();
        const input = byId('deletionPassword');
        try {
            if (!input.value) throw new Error('Enter your current sign-in password.');
            feedback('Verifying with Clerk…');
            await start('password');
            // Password goes directly to Clerk's SDK, never to Taskitator's Worker.
            await window.Clerk.session.startVerification({level:'first_factor'});
            const result = await window.Clerk.session.attemptFirstFactorVerification({strategy:'password',password:input.value});
            if (result.status !== 'complete') throw new Error('Password verification did not complete.');
            await window.TaskitatorAuth.token(true);
            await window.TaskitatorAuth.api('/auth/verification/password',{
                method:'POST',freshToken:true,body:JSON.stringify({verification_id:proofId})});
            verified = true; feedback('Identity verified. Check the blocker confirmation and manually type the phrase. Verification expires after five minutes.');
        } catch (error) { verified = false; feedback(error.message || 'Verification failed. Try again.'); }
        finally { input.value = ''; busy = false; update(); }
    }
    function googleAuthorizationUrl(value) {
        let url;
        try {
            if (typeof value !== 'string' || !value.trim()) throw new Error();
            url = new URL(value);
            if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
                url.username || url.password || url.hash) throw new Error();
        } catch {
            throw new Error('Google confirmation URL is missing or invalid. Check the Worker Google OAuth settings in pro/verification-setup.html, then retry or cancel.');
        }
        return url.href;
    }
    async function google() {
        if (busy) return;
        busy = true; update();
        try {
            const result = await start('google');
            const authorizationUrl = googleAuthorizationUrl(result.authorization_url);
            location.assign(authorizationUrl);
        } catch (error) { feedback(error.message); busy = false; update(); }
    }
    async function confirmDeletion() {
        if (busy || !verified || !byId('deletionBlockerDisabled').checked || byId('deletionPhrase').value !== 'Macrodroid disabled') return;
        busy = true; update();
        const account = window.TaskitatorAuth.account;
        deletionOwner = account.user;
        try {
            // Confirm with the server again immediately before the irreversible step.
            const proof = await window.TaskitatorAuth.api('/auth/verification/status',{
                method:'POST',body:JSON.stringify({verification_id:proofId})});
            if (!proof.verified) throw new Error('Verification expired. Verify again before deleting.');
            const receipt = Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
            // Retain the receipt BEFORE the request, including when its response is lost.
            sessionStorage.setItem(RECEIPT_KEY,receipt);
            feedback('Submitting permanent deletion…');
            const result = await window.TaskitatorAuth.api('/auth/account',{
                method:'DELETE',body:JSON.stringify({verification_id:proofId,receipt,
                    blocker_disabled:true,phrase:byId('deletionPhrase').value})});
            if (!result.accepted) throw new Error('Deletion was not accepted.');
            sessionStorage.setItem(RECEIPT_KEY,result.receipt || receipt);
            window.TaskitatorDeletionAccepted = true;
            if (window.SyncEngine?.debounceTimer) clearTimeout(window.SyncEngine.debounceTimer);
            await cleanLocal(account.user);
            window.TaskitatorAuth.account = null;
            location.replace('account-deletion.html');
        } catch (error) {
            // A timeout may have occurred after acceptance. Keep the receipt and let
            // the status endpoint establish the result rather than resubmitting blind.
            feedback(error.message+' If the request timed out, use Check deletion status before trying again.');
            const button = byId('checkAccountDeletionStatusBtn'); button.hidden = false;
            if (error.status === 403) verified = false;
            busy = false; update();
        }
    }
    function open() {
        if (busy) return;
        verified = false; proofId = null;
        byId('deletionPhrase').value = ''; byId('deletionBlockerDisabled').checked = false;
        byId('deletionPassword').value = '';
        byId('checkAccountDeletionStatusBtn').hidden = true;
        feedback('Nothing has been deleted. Verify your identity, then confirm.');
        byId('deletionPassword').disabled = window.Clerk.user?.passwordEnabled === false;
        byId('accountDeletionDialog').showModal(); update();
    }
    window.TaskitatorAccountDeletion = {cleanLocal};
    window.addEventListener('taskitator-auth-ready', async () => {
        if (!byId('accountDeletionDialog')) return;
        byId('openAccountDeletionBtn').addEventListener('click',open);
        byId('cancelAccountDeletionBtn').addEventListener('click',()=>{ if (!busy) byId('accountDeletionDialog').close(); });
        byId('accountDeletionDialog').addEventListener('cancel',event=>{ if (busy) event.preventDefault(); });
        byId('verifyDeletionPasswordBtn').addEventListener('click',password);
        byId('verifyDeletionGoogleBtn').addEventListener('click',google);
        byId('confirmAccountDeletionBtn').addEventListener('click',confirmDeletion);
        byId('checkAccountDeletionStatusBtn').addEventListener('click',async()=>{
            try {
                const receipt = sessionStorage.getItem(RECEIPT_KEY);
                const response = await fetch(window.TASKITATOR_AUTH_CONFIG.workerUrl.replace(/\/$/,'')+'/auth/deletion/status',{
                    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt}),
                    cache:'no-store',signal:AbortSignal.timeout(15000)});
                const result = await response.json();
                if (!response.ok || !result.accepted) throw new Error(result.error || 'Deletion acceptance could not be confirmed.');
                window.TaskitatorDeletionAccepted = true;
                if (deletionOwner) await cleanLocal(deletionOwner);
                window.TaskitatorAuth.account = null;
                location.replace('account-deletion.html');
            } catch (error) { feedback(error.message+' Your current local data has not been cleared.'); }
        });
        byId('deletionBlockerDisabled').addEventListener('change',update);
        const phrase = byId('deletionPhrase');
        phrase.addEventListener('input',update);
        ['paste','drop'].forEach(name=>phrase.addEventListener(name,event=>event.preventDefault()));
        phrase.addEventListener('beforeinput',event=>{
            if (['insertFromPaste','insertFromDrop'].includes(event.inputType)) event.preventDefault();
        });
        const match = /^#delete-verification=([a-f0-9]{64})$/.exec(location.hash);
        if (match) {
            history.replaceState(null,'',location.pathname+location.search);
            open();
            proofId = match[1];
            try {
                const result = await window.TaskitatorAuth.api('/auth/verification/status',{
                    method:'POST',body:JSON.stringify({verification_id:proofId})});
                verified = result.verified;
                feedback(verified ? 'Google identity confirmed. Check the blocker confirmation and manually type the phrase.' :
                    'Google confirmation failed or was cancelled. Use the Google account already connected to this login and try again.');
            } catch (error) { feedback(error.message); }
            update();
        }
    });
})();

(function () {
    'use strict';
    let timer, checking = false;
    const status = document.getElementById('deletionStatus');
    async function check() {
        if (checking) return;
        checking = true; clearTimeout(timer);
        const receipt = sessionStorage.getItem('taskitator_deletion_receipt');
        if (!receipt) { status.textContent='No deletion receipt is saved in this tab. No deletion is submitted from this page. Sign in to check your account or contact Mazendev.'; checking=false; return; }
        try {
            const response = await fetch(window.TASKITATOR_AUTH_CONFIG.workerUrl.replace(/\/$/,'')+'/auth/deletion/status',{
                method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt}),
                cache:'no-store',signal:AbortSignal.timeout(15000)});
            const data = await response.json();
            if (!response.ok) {
                if (response.status === 404) sessionStorage.removeItem('taskitator_deletion_receipt');
                throw new Error(data.error || 'Deletion status could not be checked.');
            }
            status.textContent = data.complete ? 'Cloud workspace and account deletion is complete.' :
                data.status==='retrying' ? 'Deletion was accepted and account access is blocked. Cleanup is retrying after a storage/provider error. You do not need to submit deletion again.' :
                'Deletion was accepted and account access is blocked. Cloud and sign-in cleanup is in progress.';
            if (data.legacy_review_needed) status.textContent += ' The legacy scan encountered unreadable records whose ownership could not be determined. Contact Mazendev for a manual review; unrelated records were not deleted.';
            if (data.migration_approval_remains) status.textContent += ' The old migration-approval configuration may still contain your username/email. Mazendev needs to remove that entry from its dashboard settings; the deleted workspace cannot be restored through it.';
            document.getElementById('phoneRecovery').textContent = 'Temporary phone unlock ends: '+new Date(data.phone_recovery_until).toLocaleString()+'.';
            const local = sessionStorage.getItem('taskitator_deletion_local_cleanup');
            document.getElementById('localCleanup').textContent = local==='complete' ? 'Identified local data was cleared in this browser.' :
                'Local cleanup may be incomplete. Close other Taskitator tabs and clear site data here after checking the result. This does not affect cloud cleanup.';
            if (!data.complete) timer=setTimeout(check,10000);
        } catch (error) { status.textContent=error.message+' If the receipt is not found, do not assume deletion succeeded. Sign in to check your account or contact Mazendev.'; }
        finally { checking=false; }
    }
    document.getElementById('refreshDeletionStatus').addEventListener('click',check);
    check();
})();

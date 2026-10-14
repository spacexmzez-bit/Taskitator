(async function () {
    const feedback = document.getElementById('loginFeedback');
    const show = message => { feedback.textContent = message; feedback.hidden = false; };
    const continueButton = document.getElementById('continueBtn');
    const recoveryPanel = document.getElementById('recoveryPanel');
    let entering = false;
    function showConnected(account) {
        document.getElementById('connectPanel').hidden = true;
        continueButton.hidden = false;
        recoveryPanel.replaceChildren();
        const copies = TaskitatorAuth.recoveryCopies(account.user);
        recoveryPanel.hidden = !copies.length;
        if (!copies.length) return false;
        const message = document.createElement('p');
        message.textContent = 'Different old device copies were recovered. Download them before continuing; synchronization does not merge these copies.';
        recoveryPanel.append(message);
        copies.forEach((snapshot, index) => {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = 'Download recovered copy ' + (index + 1);
            button.onclick = () => {
                try {
                    // Match the existing settings-page backup import format.
                    const backup = { export_date: new Date().toISOString() };
                    for (const key of ['taskitator_tasks', 'taskitator_projects', 'taskitator_settings',
                        'taskitator_daily_breaks', 'taskitator_audit_ledger', 'taskitator_saved_criteria', 'taskitator_recurrence_state', 'taskitator_collapsed_nodes']) {
                        if (typeof snapshot[key] === 'string') backup[key] = JSON.parse(snapshot[key]);
                    }
                    backup.taskitator_settings = TaskitatorAuth.cleanSettings(backup.taskitator_settings, true);
                    backup.taskitator_tasks ||= [];
                    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
                    const link = document.createElement('a'); link.href = url;
                    link.download = 'taskitator-recovered-copy-' + (index + 1) + '.json';
                    document.body.append(link); link.click(); link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 30000);
                } catch (err) { show('This saved copy could not be exported. It remains on this device.'); }
            };
            recoveryPanel.append(button);
        });
        return true;
    }
    async function enter(account) {
        if (entering) return;
        entering = true; continueButton.disabled = true;
        try {
            showConnected(account);
            SyncEngine.beginLogin(account.user);
            const pulled = await SyncEngine.pull();
            if (!pulled.success && !pulled.conflict) throw new Error(pulled.error || 'Initial synchronization failed. Your local drafts are retained.');
            if (!pulled.conflict) location.replace('index.html');
            else show('This device has pending edits. Resolve the displayed cloud conflict, then choose Continue.');
        } finally { entering = false; continueButton.disabled = false; }
    }
    const redirect = location.origin + '/login.html';
    if (!window.Clerk.session) {
        window.Clerk.mountSignIn(document.getElementById('secureSignIn'), {
            routing: 'hash', withSignUp: true, forceRedirectUrl: redirect, signUpForceRedirectUrl: redirect
        });
        return;
    }
    document.getElementById('signedInPanel').hidden = false;
    if (TaskitatorAuth.storageWarnings.length) show([...new Set(TaskitatorAuth.storageWarnings)].join('\n'));
    document.getElementById('signedInEmail').textContent = window.Clerk.user?.primaryEmailAddress?.emailAddress || 'Signed in';
    document.getElementById('signOutLoginBtn').onclick = async () => {
        try { await SyncEngine.logout(); location.replace('login.html'); } catch (err) { show(err.message); }
    };
    continueButton.onclick = () => {
        if (TaskitatorAuth.account) return enter(TaskitatorAuth.account).catch(err => show(err.message));
    };
    if (TaskitatorAuth.account) {
        try { if (!showConnected(TaskitatorAuth.account) && !TaskitatorAuth.storageWarnings.length) await enter(TaskitatorAuth.account); }
        catch (err) { show(err.message); }
        return;
    }
    document.getElementById('connectPanel').hidden = false;
    const oldOwner = localStorage.getItem('taskitator_legacy_local_owner');
    if (oldOwner) document.getElementById('legacyUsername').value = oldOwner;
    document.getElementById('migrationForm').onsubmit = async event => {
        event.preventDefault();
        const button = document.getElementById('migrateAccountBtn'); button.disabled = true;
        const password = document.getElementById('legacyPassword');
        try {
            const account = await TaskitatorAuth.connect({ mode: 'migrate',
                username: document.getElementById('legacyUsername').value, password: password.value });
            password.value = '';
            if (!showConnected(account) && !TaskitatorAuth.storageWarnings.length) await enter(account);
        } catch (err) { show(err.message); } finally { password.value = ''; button.disabled = false; }
    };
    document.getElementById('newAccountBtn').onclick = async event => {
        if (!confirm('Create a new, empty Taskitator account? Choose Connect existing account to keep your existing cloud tasks.')) return;
        event.target.disabled = true;
        try {
            const account = await TaskitatorAuth.connect({ mode: 'create' });
            if (!showConnected(account) && !TaskitatorAuth.storageWarnings.length) await enter(account);
        }
        catch (err) { show(err.message); } finally { event.target.disabled = false; }
    };
})();

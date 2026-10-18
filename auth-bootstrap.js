// Do not initialize task UI or expose cached account data before server-checked sign-in.
(async function () {
    const loginPage = location.pathname.endsWith('/login.html');
    const status = document.createElement('div');
    status.id = 'authLoadingStatus';
    status.style.cssText = 'position:fixed;inset:0;background:#0f172a;color:#e2e8f0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;gap:16px';
    status.textContent = 'Checking your secure session…';
    document.body.append(status);
    try {
        // Old cache-first workers ignore query strings and can return an old
        // sync engine to the new login. Activate the security worker first.
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            const versionMatches = () => new Promise(resolve => {
                const controller = navigator.serviceWorker.controller;
                if (!controller) { resolve(false); return; }
                const channel = new MessageChannel();
                const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
                channel.port1.onmessage = event => {
                    clearTimeout(timer); channel.port1.close();
                    resolve(event.data?.version === 'taskitator-phase-3-providers-v1');
                };
                controller.postMessage({ type: 'TASKITATOR_SECURITY_VERSION' }, [channel.port2]);
            });
            if (!(await versionMatches())) {
                status.textContent = 'Updating secure app files…';
                await new Promise((resolve, reject) => {
                    let complete = false;
                    const finish = error => {
                        if (complete) return; complete = true;
                        clearTimeout(timer);
                        navigator.serviceWorker.removeEventListener('controllerchange', check);
                        if (error) reject(error); else resolve();
                    };
                    const check = async () => { if (await versionMatches()) finish(); };
                    const timer = setTimeout(() => finish(new Error('Security files are still updating. Close old Taskitator tabs, then reload this page. Your drafts are retained.')), 30000);
                    navigator.serviceWorker.addEventListener('controllerchange', check);
                    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                        .then(registration => registration.update()).then(check).catch(finish);
                });
            }
        } else if ('serviceWorker' in navigator) {
            // A first visit has no old worker intercepting scripts. Installation
            // may be disabled by the browser; secure login can still proceed.
            navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                .catch(() => {});
        }
        await TaskitatorAuth.init();
        if (TaskitatorAuth.deletion) {
            if (TaskitatorAuth.deletion.receipt) sessionStorage.setItem('taskitator_deletion_receipt', TaskitatorAuth.deletion.receipt);
            location.replace('account-deletion.html'); return;
        }
        if (!loginPage && !TaskitatorAuth.signedIn) { location.replace('login.html'); return; }
        if (!loginPage && localStorage.getItem('taskitator_local_owner') !== TaskitatorAuth.account?.user) {
            location.replace('login.html'); return;
        }
        // Keep the original classic-script order and global bindings intact.
        const scripts = [...document.querySelectorAll('script[type="text/taskitator-script"]')];
        for (const original of scripts) {
            const script = document.createElement('script');
            if (original.getAttribute('src')) {
                script.src = original.getAttribute('src'); script.async = false;
                await new Promise((resolve, reject) => {
                    script.onload = resolve; script.onerror = () => reject(new Error('An app file could not be loaded. Reload after checking your upload.'));
                    document.body.append(script);
                });
            } else { script.textContent = original.textContent; document.body.append(script); }
        }
        // Initialize existing page controls after asynchronous authentication.
        window.dispatchEvent(new Event('taskitator-auth-ready'));
        document.documentElement.classList.remove('auth-pending');
        status.remove();
        if (window.Clerk) {
            const initialSession = window.Clerk.session?.id;
            window.Clerk.addListener(({ session }) => {
                if (initialSession && session?.id !== initialSession) {
                    if (window.TaskitatorDeletionAccepted) return;
                    window.TaskitatorVault?.clear();
                    window.SyncEngine?.archiveLocalAccount();
                    window.SyncEngine?.clearLocalAccount();
                    location.replace('login.html');
                }
            });
        }
    } catch (err) {
        if (err.status === 401 && sessionStorage.getItem('taskitator_deletion_receipt')) {
            location.replace('account-deletion.html'); return;
        }
        status.textContent = err.message || 'Secure sign-in is unavailable. Reload to try again.';
        const reload = document.createElement('button'); reload.textContent = 'Try again';
        reload.onclick = () => location.reload(); status.append(reload);
    }
})();

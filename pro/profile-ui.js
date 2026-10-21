// Display-only Taskitator username. It is never used for identity or permissions.
(function (global) {
    'use strict';
    let bound = false, currentName = '', currentOwner = '', serial = 0;
    const button = () => document.getElementById('accountUsernameBtn');
    const owner = () => (global.Clerk?.user?.id || '') + ':' + (global.Clerk?.session?.id || '');
    function nameFor() { return currentOwner === owner() ? currentName : ''; }
    function paint(name) {
        const node = button(); if (!node) return;
        node.textContent = name ? '@' + name : 'Set username';
        node.title = name ? 'Edit Taskitator username: @' + name : 'Choose a unique Taskitator username';
        node.setAttribute('aria-label',node.title);
    }
    async function refresh() {
        const ticket = ++serial, startOwner = owner();
        if (currentOwner !== startOwner) { currentName = ''; paint(''); }
        if (!global.Clerk?.session || !global.TaskitatorPro) return;
        try {
            const result = await global.TaskitatorPro.getUsernameProfile();
            if (ticket !== serial || startOwner !== owner()) return;
            currentOwner = startOwner; currentName = result.username || ''; paint(currentName);
        } catch {
            // Keep a name only when it was verified for this account and session.
            if (ticket === serial && startOwner === owner()) paint(nameFor());
        }
    }
    function open() {
        if (document.getElementById('taskitatorUsernameDialog')) return;
        const user = global.Clerk?.user, session = global.Clerk?.session?.id;
        if (!user || !session) return;
        const dialog = document.createElement('dialog');
        dialog.id = 'taskitatorUsernameDialog';
        dialog.className = 'username-dialog';
        dialog.setAttribute('aria-labelledby', 'usernameDialogTitle');
        dialog.innerHTML = `
            <form id="taskitatorUsernameForm">
                <div class="username-dialog-header">
                    <h2 id="usernameDialogTitle">Your Taskitator username</h2>
                    <button type="button" class="icon-btn" id="usernameCloseBtn" aria-label="Close username editor">✕</button>
                </div>
                <p id="usernameHelp">Choose the name shown beside your task list. It follows your signed-in account across devices.</p>
                <label for="taskitatorUsernameInput">Username</label>
                <input id="taskitatorUsernameInput" name="username" type="text" required minlength="3" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="usernameHelp usernameFormat" autofocus>
                <p id="usernameFormat">3–20 letters, numbers or underscores. Names are unique without regard to letter case. This display name does not change how you sign in.</p>
                <p id="usernameFeedback" role="status" aria-live="polite"></p>
                <div class="username-dialog-actions">
                    <button type="button" class="icon-btn" id="usernameCancelBtn">Cancel</button>
                    <button type="submit" class="icon-btn" id="usernameSaveBtn">Save username</button>
                </div>
            </form>`;
        document.body.appendChild(dialog);
        const input = dialog.querySelector('#taskitatorUsernameInput');
        const feedback = dialog.querySelector('#usernameFeedback');
        const save = dialog.querySelector('#usernameSaveBtn');
        const cancel = dialog.querySelector('#usernameCancelBtn');
        const closeButton = dialog.querySelector('#usernameCloseBtn');
        const form = dialog.querySelector('#taskitatorUsernameForm');
        input.value = nameFor(user);
        let busy = false;
        const close = () => { if (!busy) dialog.close(); };
        closeButton.addEventListener('click', close);
        cancel.addEventListener('click', close);
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => { dialog.remove(); button()?.focus(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            const name = input.value.trim().replace(/^@/, '');
            if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
                feedback.textContent = 'Use 3–20 letters, numbers or underscores. Names are unique without regard to letter case.';
                input.focus(); return;
            }
            busy = true; save.disabled = cancel.disabled = closeButton.disabled = input.disabled = true;
            save.textContent = 'Saving…'; feedback.textContent = '';
            try {
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Close this editor and try again.');
                const updated = await global.TaskitatorPro.setUsername(name);
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Reload to see the current username.');
                ++serial; currentOwner = owner(); currentName = updated.username; paint(currentName);
                busy = false;
                dialog.close();
            } catch (error) {
                feedback.textContent = error.errors?.[0]?.longMessage || error.message || 'Could not save your username. Try again.';
            } finally {
                busy = false; save.disabled = cancel.disabled = closeButton.disabled = input.disabled = false;
                save.textContent = 'Save username';
            }
        });
        dialog.showModal();
    }
    function initialize() {
        if (!button()) return;
        refresh();
        if (bound) return;
        bound = true;
        button().addEventListener('click', open);
        global.addEventListener('focus', async () => {
            const user = global.Clerk?.user;
            if (!user) return;
            refresh();
        });
    }
    global.TaskitatorProfile = {initialize, refresh};
    global.addEventListener('taskitator-auth-ready', initialize);
})(window);

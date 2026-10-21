// Display-only Taskitator username. It is never used for identity or permissions.
(function (global) {
    'use strict';
    const metadataKey = 'taskitator_username';
    let bound = false;
    const button = () => document.getElementById('accountUsernameBtn');
    function nameFor(user) {
        const value = user?.unsafeMetadata?.[metadataKey] || user?.username;
        return typeof value === 'string' ? value : '';
    }
    function refresh(user = global.Clerk?.user) {
        const node = button();
        if (!node) return;
        const name = nameFor(user);
        node.textContent = name ? '@' + name : 'Set username';
        node.title = name ? 'Edit Taskitator username: @' + name : 'Set your Taskitator username';
        node.setAttribute('aria-label', node.title);
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
                <input id="taskitatorUsernameInput" name="username" type="text" required minlength="3" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="usernameHelp usernameFormat" autofocus>
                <p id="usernameFormat">3–24 letters, numbers, underscores, dots or dashes. This display name does not change how you sign in.</p>
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
            if (!/^[A-Za-z0-9_.-]{3,24}$/.test(name)) {
                feedback.textContent = 'Use 3–24 letters, numbers, underscores, dots or dashes.';
                input.focus(); return;
            }
            busy = true; save.disabled = cancel.disabled = closeButton.disabled = input.disabled = true;
            save.textContent = 'Saving…'; feedback.textContent = '';
            try {
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Close this editor and try again.');
                let updated;
                if (typeof user.updateMetadata === 'function') {
                    updated = await user.updateMetadata({unsafeMetadata:{[metadataKey]:name}});
                } else if (typeof user.update === 'function') {
                    // ClerkJS v5 supports update(); preserve all unrelated metadata.
                    updated = await user.update({unsafeMetadata:{...user.unsafeMetadata,[metadataKey]:name}});
                } else throw new Error('Account updates are unavailable. Reload the page and try again.');
                if (global.Clerk?.user?.id !== user.id || global.Clerk?.session?.id !== session) throw new Error('Your account changed. Reload to see the current username.');
                refresh(updated || user);
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
            try { await user.reload?.(); } catch { /* Keep the last known display name when offline. */ }
            refresh();
        });
    }
    global.TaskitatorProfile = {initialize, refresh};
    global.addEventListener('taskitator-auth-ready', initialize);
})(window);

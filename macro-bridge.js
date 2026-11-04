// File: macro-bridge.js
// Builds the user's MacroDroid bridge by putting their phone token into the
// "user token" local variable of the shipped template, then offers it as a download.
// The edit is done on the raw text, never JSON.parse/stringify: macro GUIDs are 64-bit
// integers that JavaScript numbers would silently corrupt.
(function () {
    'use strict';

    const BRIDGE_URL = 'macros/Taskitator_Cloud_Bridge.macro';
    const BLOCKER_URL = 'macros/App_Blocker.macro';
    const TOKEN_PATTERN = /^tkp_[a-f0-9]{64}$/;
    const SLOT = '"m_name":"user token","m_stringValue":""';

    function injectToken(template, token) {
        if (typeof template !== 'string' || !template) throw new Error('The macro template is missing.');
        if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new Error('That is not a valid Taskitator phone token.');
        const first = template.indexOf(SLOT);
        if (first === -1 || template.indexOf(SLOT, first + 1) !== -1) {
            throw new Error('The macro template has no single empty "user token" variable.');
        }
        const out = template.slice(0, first) + '"m_name":"user token","m_stringValue":"' + token + '"' + template.slice(first + SLOT.length);
        JSON.parse(out); // must still be valid JSON
        if (out.length !== template.length + token.length) throw new Error('The macro could not be built safely.');
        return out;
    }

    async function fetchText(url) {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ').');
        return res.text();
    }

    function save(text, filename) {
        const blob = new Blob([text], { type: 'application/octet-stream' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
    }

    async function downloadBridge(token) {
        const built = injectToken(await fetchText(BRIDGE_URL), token);
        save(built, 'Taskitator_Cloud_Bridge.macro');
    }

    async function downloadBlocker() {
        save(await fetchText(BLOCKER_URL), 'App_Blocker.macro');
    }

    window.TaskitatorMacro = { injectToken, downloadBridge, downloadBlocker, TOKEN_PATTERN };
})();

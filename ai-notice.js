/* AI notice (Phase 6.6). One line wherever AI is used, anywhere in Taskitator (Universe included):
   "AI services are handled by {company}, a third-party company. AI can make mistakes, so check answers and results."
   The company is the AI provider that is enabled right now. Markup carries the generic sentence as its own fallback
   (<p class="ai-notice" data-ai-notice>), so the disclaimer is never blank even if this script does not run.
   Surfaces built in JavaScript call TaskitatorAiNotice.node(scope). Scope 'universe' = hosted Universe review. */
(function () {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorAiNotice) return;
    const COMPANY = { gemini: 'Google', claude: 'Anthropic' };
    // Hosted Universe review runs on Gemini (UNIVERSE_GEMINI_API_KEY in docs/worker-configuration.md). Keep in step with the server.
    const UNIVERSE_COMPANY = 'Google';
    // Hosted Taskitator AI runs on the Anthropic key (ANTHROPIC_API_KEY in docs/worker-configuration.md).
    const HOSTED_COMPANY = 'Anthropic';
    const GENERIC = 'AI services are handled by a third party. AI can make mistakes, so check answers and results.';
    const withCompany = c => 'AI services are handled by ' + c + ', a third-party company. AI can make mistakes, so check answers and results.';

    function company(scope) {
        if (scope === 'universe') return UNIVERSE_COMPANY;
        const v = window.TaskitatorVault;
        if (!v) return '';
        try {
            if (v.hosted) return HOSTED_COMPANY;
            if (v.available) return COMPANY[v.provider] || '';
        } catch { /* provider not ready yet: generic sentence */ }
        return '';
    }
    const text = scope => { const c = company(scope); return c ? withCompany(c) : GENERIC; };

    function fill(el) {
        const next = text(el.dataset.aiNotice === 'universe' ? 'universe' : 'user');
        if (el.dataset.aiText === next) return;
        el.dataset.aiText = next;
        el.textContent = next;
    }
    function refresh(root) {
        (root || document).querySelectorAll('[data-ai-notice]').forEach(fill);
    }
    function node(scope) {
        const p = document.createElement('p');
        p.className = 'ai-notice';
        p.dataset.aiNotice = scope === 'universe' ? 'universe' : 'user';
        p.textContent = GENERIC;
        fill(p);
        return p;
    }

    let queued = false;
    const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; refresh(); }); };
    document.addEventListener('DOMContentLoaded', refresh);
    window.addEventListener('load', refresh);
    for (const name of ['taskitator-ai-provider-changed', 'taskitator-pro-status', 'taskitator-auth-ready', 'taskitator-universe-view']) window.addEventListener(name, later);
    if (typeof MutationObserver === 'function') {
        const start = () => new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.matches?.('[data-ai-notice]') || n.querySelector?.('[data-ai-notice]')) { later(); return; }
            }
        }).observe(document.body, { childList: true, subtree: true });
        if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    }

    window.TaskitatorAiNotice = Object.freeze({ node, refresh, text, GENERIC, COMPANY, UNIVERSE_COMPANY, HOSTED_COMPANY });
})();

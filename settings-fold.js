/* Settings sections (Phase 6.7.1): every card on the Settings page folds, collapsed by default.
   A card opens by default only when its markup carries data-fold-open (Danger zone). Open/closed is not saved:
   each visit starts collapsed. Works on the card's own header, so cards that JavaScript re-renders (Break limits)
   keep working: a MutationObserver re-marks the new header. The Animations card is a <details> and folds natively.
   API: TaskitatorFold.reveal(el) opens whatever card/details holds el (used by the tutorial spotlight and #hash links). */
(function () {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorFold) return;
    const CARDS = '.settings-pane .settings-card:not(details)';
    const HEADS = '.card-title, .card-title-row, .status-mode-head';
    let uid = 0;

    function headOf(card) {
        for (const child of card.children) if (child.matches(HEADS) || child.tagName === 'H4') return child;
        return null;
    }
    function setOpen(card, open) {
        card.classList.toggle('is-open', open);
        const btn = card.querySelector(':scope > .fold-head > .fold-toggle');
        if (btn) btn.setAttribute('aria-expanded', String(open));
    }
    function enhance(card) {
        const head = headOf(card);
        if (!head) { card.classList.remove('fold-card'); return; }
        card.classList.add('fold-card');
        if (head.classList.contains('fold-head') && head.querySelector(':scope > .fold-toggle')) return;
        head.classList.add('fold-head');
        const title = head.matches('.card-title') || head.tagName === 'H4' ? head : head.querySelector('.card-title, h4');
        if (title && !title.id) title.id = 'fold-title-' + (++uid);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fold-toggle';
        btn.setAttribute('aria-expanded', String(card.classList.contains('is-open')));
        if (title) btn.setAttribute('aria-labelledby', title.id);
        btn.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        head.prepend(btn);
    }
    function init(card) {
        if (card.dataset.foldReady) return;
        card.dataset.foldReady = '1';
        if (card.hasAttribute('data-fold-open')) card.classList.add('is-open');
        enhance(card);
        // Rendered cards replace their children: mark the new header again. Marking touches the header only, so no loop.
        if (typeof MutationObserver === 'function') new MutationObserver(() => enhance(card)).observe(card, { childList: true });
    }
    document.addEventListener('click', e => {
        const head = e.target.closest?.('.fold-card > .fold-head');
        if (!head) return;
        // A click on the header's own buttons or links keeps its job (help "!", Sync now, Add level ...).
        const inner = e.target.closest('button, a, input, select, textarea, label');
        if (inner && inner.parentElement && !inner.classList.contains('fold-toggle') && head.contains(inner)) return;
        const card = head.parentElement;
        setOpen(card, !card.classList.contains('is-open'));
    });

    function reveal(el) {
        if (!el || !el.closest) return false;
        let changed = false;
        for (let n = el; n; n = n.parentElement) {
            if (n.tagName === 'DETAILS' && !n.open) { n.open = true; changed = true; }
            if (n.classList.contains('fold-card') && !n.classList.contains('is-open')) { setOpen(n, true); changed = true; }
        }
        return changed;
    }
    function revealHash() {
        const id = decodeURIComponent((location.hash || '').slice(1));
        const el = id ? document.getElementById(id) : null;
        if (el && !el.classList.contains('settings-pane')) reveal(el);
    }
    function start() {
        document.querySelectorAll(CARDS).forEach(init);
        revealHash();
    }
    window.addEventListener('hashchange', revealHash);
    window.TaskitatorFold = Object.freeze({ reveal, open: card => setOpen(card, true), close: card => setOpen(card, false), init: start });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();

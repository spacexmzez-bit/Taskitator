/* Shared presentation helpers. These never grant permissions or commit data. */
(() => {
  const layers = [];
  let previousOverflow = '', noticeTimer;
  const element = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const focusable = root => [...root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
    .filter(n => !n.disabled && n.tabIndex !== -1 && !n.closest('[hidden]') && n.getClientRects().length);
  function layer(overlay, { close, initial } = {}) {
    const returnTo = document.activeElement;
    if (!layers.length) { previousOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'; }
    const item = { overlay, close, closing: false };
    layers.push(item);
    const updateViewport = () => {
      const v = window.visualViewport;
      if (!v) return;
      overlay.style.top = v.offsetTop + 'px';
      overlay.style.height = v.height + 'px';
      overlay.style.bottom = 'auto';
    };
    updateViewport();
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    const release = () => {
      const index = layers.indexOf(item); if (index < 0) return;
      const wasTop = index === layers.length - 1;
      layers.splice(index, 1);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus, true);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      observer?.disconnect();
      if (!layers.length) document.documentElement.style.overflow = previousOverflow;
      if (wasTop && returnTo?.isConnected && !returnTo.closest('[hidden]')) returnTo.focus();
    };
    const requestClose = async () => {
      if (layers.at(-1) !== item || item.closing) return;
      item.closing = true;
      try { await close?.(); } finally { item.closing = false; }
    };
    const key = e => {
      if (layers.at(-1) !== item) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); void requestClose(); }
      if (e.key === 'Tab') {
        const items = focusable(overlay); if (!items.length) { e.preventDefault(); return; }
        const i = items.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); items.at(-1).focus(); }
        else if (!e.shiftKey && (i < 0 || i === items.length - 1)) { e.preventDefault(); items[0].focus(); }
      }
    };
    const focus = e => { if (layers.at(-1) === item && !overlay.contains(e.target)) focusable(overlay)[0]?.focus(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus, true);
    const observer = window.MutationObserver ? new MutationObserver(() => { if (!overlay.isConnected || overlay.hidden) release(); }) : null;
    observer?.observe(document.getElementById('universeWorkspace'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    (initial || focusable(overlay)[0])?.focus();
    return release;
  }
  // Toast with optional tone ('success' | 'info' | 'error') and one optional action button.
  function toast(message, { tone = 'success', action, onAction, duration = 4000 } = {}) {
    const root = document.getElementById('universeWorkspace'); if (!root) return;
    root.querySelector('.uni-toast')?.remove();
    const node = element('div'); node.className = 'uni-toast'; node.dataset.tone = tone;
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); node.setAttribute('aria-live', 'polite');
    node.append(element('span', message));
    if (action && onAction) {
      const b = element('button', action); b.type = 'button'; b.className = 'btn-primary';
      b.addEventListener('click', () => { node.remove(); onAction(); });
      node.append(b);
    }
    root.append(node); clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => node.remove(), duration);
  }
  // Placeholder rows shown while a view loads.
  function skeleton(rows = 4) {
    const group = element('div'); group.className = 'uni-skeleton-group'; group.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < rows; i++) { const r = element('div'); r.className = 'uni-skeleton'; group.append(r); }
    return group;
  }
  // Visual busy/done feedback for the button that started an action. Never changes the action's outcome.
  function pressFeedback(button) {
    if (!button || !button.classList) return { done() {}, fail() {} };
    const timer = setTimeout(() => { if (button.isConnected) { button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); } }, 160);
    const settle = cls => {
      clearTimeout(timer);
      const wasBusy = button.classList.contains('is-busy');
      button.classList.remove('is-busy'); button.removeAttribute('aria-busy');
      if (!button.isConnected || (cls === 'is-done' && !wasBusy)) return;
      button.classList.add(cls); setTimeout(() => button.classList.remove(cls), cls === 'is-done' ? 1100 : 400);
    };
    return { done: () => settle('is-done'), fail: () => settle('is-failed') };
  }
  function errorMessage(error) {
    const status = error?.status || error?.statusCode;
    if (status === 409 || /REVISION|CONFLICT/.test(error?.code || '')) return 'This changed elsewhere. Refresh to load the latest version. Your unsaved draft is still open.';
    if (status === 401) return 'Sign in again to continue. Your draft has not been saved.';
    if (status === 403) return 'Your current role cannot perform this action. Refresh to check your access.';
    if (navigator.onLine === false) return 'You’re offline. Reconnect, then retry the same action. No offline changes are queued.';
    const text = String(error?.message || '');
    if (text && text.length < 260 && !/SELECT |INSERT |UPDATE |D1_|stack|https?:\/\//i.test(text)) return text;
    return 'Couldn’t finish this action. Check your connection and retry. Your draft has not been cleared.';
  }
  window.UniverseUX = { layer, toast, errorMessage, skeleton, pressFeedback };
})();

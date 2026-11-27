/* Taskitator motion helpers (Phase 6.6): tap bubbles and the icon wipe. Cosmetic only: never reads or writes tasks,
   settings or sync state. Both honour the per-device Animations mode and switches (theme-boot.js) and the OS
   "reduce motion" setting, so they do nothing in Reduced, Static or when their switch is off. */
(function () {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorMotion) return;
    const ok = key => {
        const a = window.TaskitatorAppearance;
        if (a && typeof a.motionAllowed === 'function') return a.motionAllowed(key);
        try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
    };

    // ----- Wipe: the selected icon is revealed left to right (right to left in RTL; see .tk-wipe in style.css) -----
    function wipe(el) {
        if (!el || !ok('wipe')) return false;
        el.classList.remove('tk-wipe');
        void el.getBoundingClientRect();
        el.classList.add('tk-wipe');
        el.addEventListener('animationend', () => el.classList.remove('tk-wipe'), { once: true });
        return true;
    }

    // ----- Bubble: a soft circle where a button is pressed. Own fixed layer, so no button is clipped or restyled. -----
    const TARGETS = 'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], summary, .drawer-links a';
    const SKIP = ':disabled, [aria-disabled="true"], [data-no-bubble], input, textarea, select';
    const live = new Map();
    let layer = null;
    function getLayer() {
        if (layer && layer.isConnected) return layer;
        layer = document.createElement('div');
        layer.id = 'tk-bubbles';
        layer.setAttribute('aria-hidden', 'true');
        (document.body || document.documentElement).appendChild(layer);
        return layer;
    }
    function drop(dot) {
        if (dot && dot.isConnected) dot.remove();
    }
    function bubble(x, y, id) {
        if (!ok('bubbles')) return null;
        const dot = document.createElement('span');
        dot.className = 'tk-bubble';
        dot.style.left = x + 'px';
        dot.style.top = y + 'px';
        getLayer().appendChild(dot);
        if (id !== undefined) live.set(id, dot);
        const done = () => { drop(dot); if (live.get(id) === dot) live.delete(id); };
        dot.addEventListener('animationend', done, { once: true });
        setTimeout(done, 900);
        return dot;
    }
    document.addEventListener('pointerdown', e => {
        if (e.button > 0 || !e.isPrimary) return;
        const t = e.target && e.target.closest ? e.target.closest(TARGETS) : null;
        if (!t || t.matches(SKIP)) return;
        bubble(e.clientX, e.clientY, e.pointerId);
    }, true);
    // A touch that turns into a scroll is cancelled by the browser: the bubble goes away at once.
    document.addEventListener('pointercancel', e => {
        const dot = live.get(e.pointerId);
        if (dot) { drop(dot); live.delete(e.pointerId); }
    }, true);

    window.TaskitatorMotion = Object.freeze({ wipe, bubble });
})();

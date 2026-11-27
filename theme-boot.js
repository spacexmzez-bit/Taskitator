/* Taskitator theme boot + Appearance store. Blocking script in <head> of every page,
   loaded right after registry.js so the theme is applied before first paint.
   External file on purpose: editing it never changes the CSP inline-script hashes.

   Storage: localStorage 'taskitator_appearance' (per device, never synced):
     { v:1, theme, effective, anim:{particles,clouds,animals,bird,parallax,bubbles,wipe,mode}, bird_speed, notice }
   - anim.mode  = 'normal' (default) | 'custom' | 'reduced' | 'static' (Phase 6.6). The switches are kept per key; Normal shows them
                  all on, Custom uses them, Reduced and Static turn every decorative effect off and collapse CSS motion.
   - theme      = what the user picked (preferred)
   - effective  = what is applied now (falls back to the free default when Pro lapses)
   It is not in SyncEngine.ACCOUNT_KEYS, SNAPSHOT_KEYS, cleanSettings or backups, so it
   never syncs and it survives sign-out. "Clear this browser" (localStorage.clear) resets it. */
/* Audit M3: clickjacking defence. The site is served by GitHub Pages, which cannot send frame-ancestors or
   X-Frame-Options, so the check is done here, in the first script of every page. Inside another site's frame the
   page is hidden and cannot be clicked. A frame that blocks scripts gets no working app at all (everything needs scripts). */
(function () {
    'use strict';
    let framed = true;
    try { framed = window.top !== window.self; } catch { framed = true; }
    if (!framed) return;
    document.documentElement.style.setProperty('display', 'none', 'important');
    try { window.top.location.replace(window.self.location.href); } catch { /* sandboxed frame: stay hidden */ }
})();
(function () {
    'use strict';
    const KEY = 'taskitator_appearance';
    const VERSION = 1;
    const SWITCH_KEYS = ['particles', 'clouds', 'animals', 'bird', 'parallax', 'bubbles', 'wipe'];
    const MODES = ['static', 'reduced', 'normal', 'custom'];
    // Effects that Reduced and Static turn off (animals are art, not motion, so they keep their own switch).
    const DECORATIVE = ['particles', 'clouds', 'bird', 'parallax', 'bubbles', 'wipe'];
    const reg = window.TaskitatorThemes;
    const html = document.documentElement;
    if (!reg) return;

    const lowEnd = () => {
        try {
            const mem = Number(navigator.deviceMemory);
            return (Number.isFinite(mem) && mem > 0 && mem <= 2) || navigator.connection?.saveData === true;
        } catch { return false; }
    };
    const osReduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
    // A device that never chose a mode: low-end or OS "reduce motion" starts in Reduced, everyone else in Normal.
    const defaultMode = () => (lowEnd() || osReduced() ? 'reduced' : 'normal');
    function defaults() {
        return { v: VERSION, theme: reg.DEFAULT_THEME, effective: reg.DEFAULT_THEME,
            anim: { particles: true, clouds: true, animals: true, bird: true, parallax: true, bubbles: true, wipe: true, mode: defaultMode() },
            bird_speed: 7, notice: null };
    }
    // Validate + migrate any stored value. Unknown fields are dropped; bad values fall back.
    function normalize(raw) {
        const base = defaults();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
        const out = { ...base };
        out.theme = reg.validTheme(raw.theme);
        out.effective = reg.validTheme(raw.effective ?? raw.theme);
        const anim = raw.anim && typeof raw.anim === 'object' ? raw.anim : {};
        out.anim = {};
        for (const k of SWITCH_KEYS) out.anim[k] = typeof anim[k] === 'boolean' ? anim[k] : base.anim[k];
        const anyOff = SWITCH_KEYS.some(k => out.anim[k] === false);
        let mode = MODES.includes(anim.mode) ? anim.mode : null;
        // Older data had a Reduce motion switch (= Static) and per-effect switches (some off = Custom).
        if (!mode) mode = anim.reduce === true ? 'static' : (anyOff ? 'custom' : base.anim.mode);
        if (mode === 'normal' && anyOff) mode = 'custom';
        out.anim.mode = mode;
        out.bird_speed = base.bird_speed;   // fixed at 7: any stored value is ignored
        out.notice = typeof raw.notice === 'string' && reg.byId(raw.notice) ? raw.notice : null;
        return out;
    }
    // The switches as they act right now: Normal = all on, Custom = stored, Reduced/Static = decorative off.
    function effectiveAnim(app) {
        const m = app.anim.mode, e = {};
        for (const k of SWITCH_KEYS) {
            if (m === 'normal') e[k] = true;
            else if (m === 'custom') e[k] = app.anim[k];
            else e[k] = DECORATIVE.includes(k) ? false : app.anim[k];
        }
        return e;
    }
    function read() {
        try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaults(); }
    }
    function save(app) {
        try { localStorage.setItem(KEY, JSON.stringify(app)); } catch {}
    }

    // Universe has its own family (space): the personal family layer is switched off while it is open.
    const universeOpen = () => Boolean(document.body && document.body.classList.contains('universe-active'));
    function apply(app) {
        const theme = reg.byId(app.effective) || reg.byId(reg.DEFAULT_THEME);
        html.dataset.palette = theme.palette;
        html.dataset.theme = theme.id;
        const space = universeOpen() ? reg.FAMILIES.space : null;
        html.dataset.family = space ? space.id : theme.family;
        const eff = effectiveAnim(app);
        const off = SWITCH_KEYS.filter(k => !eff[k]);
        if (off.length) html.dataset.fxOff = off.join(' '); else delete html.dataset.fxOff;
        if (app.anim.mode === 'static' || app.anim.mode === 'reduced') html.dataset.motion = app.anim.mode; else delete html.dataset.motion;
        html.style.setProperty('--tk-bird-speed', String(app.bird_speed));
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta && document.head) {
            meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta);
        }
        if (meta) meta.content = space ? space.metaThemeColor : theme.metaThemeColor;
        // Phase 6.3: paint the page background and native controls before the stylesheet loads (no white flash between pages).
        html.style.colorScheme = 'dark';
        html.style.backgroundColor = space ? space.metaThemeColor : theme.metaThemeColor;
    }

    // ----- Allowed themes (product gate) -----
    // Before any status arrives this session, estimate from the cached tier (tier-ui.js).
    function cachedAllowed() {
        try {
            const c = JSON.parse(localStorage.getItem('taskitator_tier_v1'));
            const pro = c && c.tier === 'pro' && (c.exp === null || Number(c.exp) > Date.now());
            return reg.themesAllowed(pro ? 'pro' : 'free');
        } catch { return reg.themesAllowed('free'); }
    }
    let allowed = cachedAllowed();
    let statusSeen = false;
    let expiryTimer = 0;

    function notify(message) {
        const show = () => window.TaskitatorToast?.show(message, { type: 'info' });
        if (window.TaskitatorToast) show();
        else window.addEventListener('taskitator-auth-ready', () => setTimeout(show, 600), { once: true });
    }
    function emit(app) {
        try { window.dispatchEvent(new CustomEvent('taskitator-appearance', { detail: { ...app, allowed: [...allowed] } })); } catch {}
    }

    // Lapse rule (Phase 7): keep the preference; apply it only while allowed.
    function reconcile(reason) {
        const app = read();
        const before = app.effective;
        if (allowed.includes(app.theme)) {
            app.effective = app.theme;
            app.notice = null;
        } else if (reason === 'status' || reason === 'expired') {
            app.effective = reg.DEFAULT_THEME;
            if (before !== reg.DEFAULT_THEME && app.notice !== app.theme) {
                app.notice = app.theme;
                notify('Pro ended, theme set to ' + reg.byId(reg.DEFAULT_THEME).label + '.');
            }
        }
        save(app);
        if (app.effective !== before) apply(app);
        emit(app);
        return app;
    }

    function onStatus(status) {
        if (!status || typeof status !== 'object') return;
        statusSeen = true;
        allowed = reg.allowedFromStatus(status);
        clearTimeout(expiryTimer);
        const exp = status.expires_at === null || status.expires_at === undefined ? null : Number(status.expires_at);
        if (reg.planFromStatus(status) !== 'free' && exp !== null && exp > Date.now()) {
            // Same approach as components.js: re-check the moment Pro expires mid-session.
            expiryTimer = setTimeout(() => {
                allowed = reg.allowedFromStatus({ ...status, expires_at: Date.now() - 1 });
                reconcile('expired');
            }, Math.min(2147483647, exp - Date.now() + 50));
        }
        reconcile('status');
    }

    const api = {
        KEY,
        defaults,
        normalize,
        read,
        get: read,
        allowed: () => [...allowed],
        statusSeen: () => statusSeen,
        isAllowed: id => allowed.includes(id),
        // Only themes the account may use can be selected. Locked ids are refused.
        setTheme(id) {
            const valid = reg.validTheme(id);
            if (valid !== id || !allowed.includes(id)) return false;
            const app = read();
            app.theme = id; app.effective = id; app.notice = null;
            save(app); apply(app); emit(app);
            return true;
        },
        // Switches only change anything in Normal and Custom. In Normal every effect shows as on, so the first switch
        // you turn off starts from "all on" and the mode becomes Custom; all on again returns to Normal.
        setAnim(key, on) {
            if (!SWITCH_KEYS.includes(key)) return false;
            const app = read();
            const m = app.anim.mode;
            if (m === 'normal') for (const k of SWITCH_KEYS) app.anim[k] = true;
            app.anim[key] = Boolean(on);
            if (m === 'normal' || m === 'custom') app.anim.mode = SWITCH_KEYS.every(k => app.anim[k]) ? 'normal' : 'custom';
            save(app); apply(app); emit(app);
            return true;
        },
        setMode(mode) {
            if (!MODES.includes(mode)) return false;
            const app = read();
            app.anim.mode = mode;
            save(app); apply(app); emit(app);
            return true;
        },
        effective: () => effectiveAnim(read()),
        // 'static' | 'reduced' | 'normal' (Custom counts as normal motion). The OS setting counts as at least Reduced.
        motionLevel() {
            const m = read().anim.mode;
            if (m === 'static') return 'static';
            if (m === 'reduced' || osReduced()) return 'reduced';
            return 'normal';
        },
        motionAllowed(key) {
            const app = read();
            if (app.anim.mode === 'static' || app.anim.mode === 'reduced') return false;
            if (osReduced()) return false;
            return key ? effectiveAnim(app)[key] !== false : true;
        },
        onStatus,
        apply: () => apply(read())
    };
    window.TaskitatorAppearance = api;

    // Boot: apply the stored effective theme immediately (no flash, works signed out/offline).
    const boot = read();
    // A cached Pro tier that has already expired cannot keep a Pro theme across restarts.
    try {
        const c = JSON.parse(localStorage.getItem('taskitator_tier_v1'));
        const theme = reg.byId(boot.effective);
        if (theme && theme.tier !== 'free' && c && c.tier === 'pro' && c.exp !== null && Number(c.exp) <= Date.now()) {
            boot.effective = reg.DEFAULT_THEME;
            save(boot);
        }
    } catch {}
    apply(boot);

    window.addEventListener('taskitator-pro-status', e => onStatus(e.detail));
    window.addEventListener('storage', e => { if (e.key === KEY) apply(read()); });
    document.addEventListener('DOMContentLoaded', () => {
        apply(read());
        if (typeof MutationObserver === 'function' && document.body) {
            let open = universeOpen();
            new MutationObserver(() => {
                const now = universeOpen();
                if (now !== open) { open = now; apply(read()); }
            }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
    });
})();

/* Taskitator theme boot + Appearance store. Blocking script in <head> of every page,
   loaded right after registry.js so the theme is applied before first paint.
   External file on purpose: editing it never changes the CSP inline-script hashes.

   Storage: localStorage 'taskitator_appearance' (per device, never synced):
     { v:1, theme, effective, anim:{particles,clouds,animals,bird,parallax,reduce}, bird_speed, notice }
   - theme      = what the user picked (preferred)
   - effective  = what is applied now (falls back to the free default when Pro lapses)
   It is not in SyncEngine.ACCOUNT_KEYS, SNAPSHOT_KEYS, cleanSettings or backups, so it
   never syncs and it survives sign-out. "Clear this browser" (localStorage.clear) resets it. */
(function () {
    'use strict';
    const KEY = 'taskitator_appearance';
    const VERSION = 1;
    const ANIM_KEYS = ['particles', 'clouds', 'animals', 'bird', 'parallax', 'reduce'];
    const reg = window.TaskitatorThemes;
    const html = document.documentElement;
    if (!reg) return;

    const lowEnd = () => {
        try {
            const mem = Number(navigator.deviceMemory);
            return (Number.isFinite(mem) && mem > 0 && mem <= 2) || navigator.connection?.saveData === true;
        } catch { return false; }
    };
    function defaults() {
        const motion = !lowEnd();
        return { v: VERSION, theme: reg.DEFAULT_THEME, effective: reg.DEFAULT_THEME,
            anim: { particles: motion, clouds: motion, animals: true, bird: motion, parallax: motion, reduce: false },
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
        for (const k of ANIM_KEYS) out.anim[k] = typeof anim[k] === 'boolean' ? anim[k] : base.anim[k];
        const speed = Number(raw.bird_speed);
        out.bird_speed = Number.isInteger(speed) && speed >= 1 && speed <= 10 ? speed : base.bird_speed;
        out.notice = typeof raw.notice === 'string' && reg.byId(raw.notice) ? raw.notice : null;
        return out;
    }
    function read() {
        try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch { return defaults(); }
    }
    function save(app) {
        try { localStorage.setItem(KEY, JSON.stringify(app)); } catch {}
    }

    // Universe keeps its legacy look: the family layer is parked while it is open.
    const universeOpen = () => Boolean(document.body && document.body.classList.contains('universe-active'));
    function apply(app) {
        const theme = reg.byId(app.effective) || reg.byId(reg.DEFAULT_THEME);
        html.dataset.palette = theme.palette;
        html.dataset.theme = theme.id;
        if (universeOpen()) delete html.dataset.family; else html.dataset.family = theme.family;
        const off = ANIM_KEYS.filter(k => k !== 'reduce' && !app.anim[k]);
        if (app.anim.reduce) off.push('particles', 'clouds', 'bird', 'parallax');
        if (off.length) html.dataset.fxOff = [...new Set(off)].join(' '); else delete html.dataset.fxOff;
        if (app.anim.reduce) html.dataset.motion = 'reduce'; else delete html.dataset.motion;
        html.style.setProperty('--tk-bird-speed', String(app.bird_speed));
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta && document.head) {
            meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta);
        }
        if (meta) meta.content = theme.metaThemeColor;
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
        setAnim(key, on) {
            if (!ANIM_KEYS.includes(key)) return false;
            const app = read();
            app.anim[key] = Boolean(on);
            save(app); apply(app); emit(app);
            return true;
        },
        setBirdSpeed(n) {
            const app = read();
            const v = Math.round(Number(n));
            if (!(v >= 1 && v <= 10)) return false;
            app.bird_speed = v;
            save(app); apply(app); emit(app);
            return true;
        },
        motionAllowed(key) {
            const app = read();
            if (app.anim.reduce) return false;
            try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
            return key ? app.anim[key] !== false : true;
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

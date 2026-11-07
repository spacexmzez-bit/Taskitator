/* Taskitator theme registry: single source of truth for themes.
   Dual-use file (same pattern as pro/smart-study.js): imported by the Worker
   (pro-backend.js) and shipped to the browser (precached by sw.js).
   A theme = {family, palette}. Family = look and feel (frames, scenes, sprite).
   Palette = colours only. Adding a palette = one palettes.css block + one row.
   Adding a family = family-<name>.css + scenes + sprite + icon map + rows.
   This is a product gate, not DRM: all theme files ship in the bundle; the
   server decides which themes an account may use, the client enforces it. */
(function (root) {
    'use strict';
    const CATALOG_VERSION = 1;
    const DEFAULT_THEME = 'blue';

    const FAMILIES = Object.freeze({
        nature: Object.freeze({ id: 'nature', sprite: 'image/nature_sprites/sprite.svg', sceneSet: 'nature' })
    });

    // tier: 'free' | 'pro'. status: 'live' | 'hidden' (hidden = kept but never offered).
    // entitlementKey is reserved for individually unlocked themes (not used yet).
    const THEMES = Object.freeze([
        Object.freeze({ id: 'blue', label: 'Blue', family: 'nature', palette: 'blue', tier: 'free', status: 'live', order: 1,
            swatch: Object.freeze(['#0a1119', '#304d74', '#6e9bd5']), metaThemeColor: '#0a1119', spriteKey: 'nature', sceneSet: 'nature', since: 1 }),
        Object.freeze({ id: 'green', label: 'Green', family: 'nature', palette: 'green', tier: 'pro', status: 'live', order: 2,
            swatch: Object.freeze(['#0f1410', '#6a553a', '#c9b27a']), metaThemeColor: '#0f1410', spriteKey: 'nature', sceneSet: 'nature', since: 1 })
    ]);

    const byId = id => THEMES.find(t => t.id === id) || null;
    const isProPlan = plan => plan === 'pro' || plan === 'max';
    const live = () => THEMES.filter(t => t.status === 'live').sort((a, b) => a.order - b.order);

    // Every live theme this plan may use. Unknown or expired plans get free themes only.
    function themesAllowed(plan) {
        return live().filter(t => t.tier === 'free' || (isProPlan(plan) && (!t.entitlementKey))).map(t => t.id);
    }

    // Additive block for GET /pro/status (online) and TaskitatorOffline.proStatus() (offline).
    function statusFor(plan) {
        return { allowed: themesAllowed(plan), default: DEFAULT_THEME, catalog_version: CATALOG_VERSION };
    }

    // Client mirror of the existing Pro check (components.js, tier-ui.js).
    function planFromStatus(status, now) {
        const t = Number.isFinite(now) ? now : Date.now();
        const active = Boolean(status) && status.isPro === true && status.status === 'active' &&
            (status.expires_at === null || status.expires_at === undefined || Number(status.expires_at) > t);
        if (!active) return 'free';
        return status.tier === 'max' ? 'max' : 'pro';
    }

    // Allowed theme ids for a Pro status object. The server list wins when present
    // (filtered to live registry ids); older Workers without it fall back to the plan.
    function allowedFromStatus(status, now) {
        const plan = planFromStatus(status, now);
        const liveIds = live().map(t => t.id);
        const server = status && status.themes && Array.isArray(status.themes.allowed) ? status.themes.allowed : null;
        const list = server ? server.filter(id => liveIds.includes(id)) : themesAllowed(plan);
        // Defence in depth: an inactive plan never unlocks a Pro theme, whatever the list says.
        const safe = list.filter(id => byId(id).tier === 'free' || isProPlan(plan));
        return safe.includes(DEFAULT_THEME) ? safe : [DEFAULT_THEME, ...safe];
    }

    // Validate a stored id; unknown, hidden or malformed ids fall back to the default.
    function validTheme(id) {
        const theme = typeof id === 'string' ? byId(id) : null;
        return theme && theme.status === 'live' ? theme.id : DEFAULT_THEME;
    }

    root.TaskitatorThemes = Object.freeze({
        CATALOG_VERSION, DEFAULT_THEME, FAMILIES, THEMES,
        byId, live, themesAllowed, statusFor, planFromStatus, allowedFromStatus, validTheme
    });
})(typeof window === 'undefined' ? globalThis : window);

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
    const CATALOG_VERSION = 2;
    const DEFAULT_THEME = 'savannah';

    const FAMILIES = Object.freeze({
        nature: Object.freeze({ id: 'nature', sprite: 'image/nature_sprites/sprite.svg', sceneSet: 'nature' }),
        // Universe only: applied by theme-boot.js while a Universe is open. It has no selectable theme row;
        // its palette is fixed in uni/universe.css and its sprite is loaded by uni/universe-space.js.
        space: Object.freeze({ id: 'space', sprite: 'image/space_sprites/sprite.svg', sceneSet: null, metaThemeColor: '#0a0716' })
    });

    // tier: 'free' | 'pro'. status: 'live' | 'hidden' (hidden = kept but never offered).
    // entitlementKey is reserved for individually unlocked themes (not used yet).
    // Phase 6.7: each theme also names its animal pack (the same id; see PACKS in icons.js). Blue/Green were removed
    // without migration: a stored unknown id falls back to the default through validTheme().
    const THEMES = Object.freeze([
        Object.freeze({ id: 'savannah', label: 'Savannah', family: 'nature', palette: 'savannah', tier: 'free', status: 'live', order: 1,
            swatch: Object.freeze(['#0f1411', '#55695a', '#a9bea9']), metaThemeColor: '#0f1411', spriteKey: 'nature', sceneSet: 'nature', since: 2 }),
        Object.freeze({ id: 'desert', label: 'Desert', family: 'nature', palette: 'desert', tier: 'pro', status: 'live', order: 2,
            swatch: Object.freeze(['#15110a', '#7a6236', '#d4b97a']), metaThemeColor: '#15110a', spriteKey: 'nature', sceneSet: 'nature', since: 2 }),
        Object.freeze({ id: 'jungle', label: 'Jungle', family: 'nature', palette: 'jungle', tier: 'pro', status: 'live', order: 3,
            swatch: Object.freeze(['#0b0e06', '#4a5726', '#a7b85a']), metaThemeColor: '#0b0e06', spriteKey: 'nature', sceneSet: 'nature', since: 2 }),
        Object.freeze({ id: 'marina', label: 'Marina', family: 'nature', palette: 'marina', tier: 'pro', status: 'live', order: 4,
            swatch: Object.freeze(['#071219', '#2b5a72', '#6fb3d2']), metaThemeColor: '#071219', spriteKey: 'nature', sceneSet: 'nature', since: 2 }),
        Object.freeze({ id: 'fictional', label: 'Fictional', family: 'nature', palette: 'fictional', tier: 'pro', status: 'live', order: 5,
            swatch: Object.freeze(['#140a0b', '#6e2a35', '#e3826f']), metaThemeColor: '#140a0b', spriteKey: 'nature', sceneSet: 'nature', since: 2 })
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
        // A Worker on an older catalog (e.g. still listing blue/green) is ignored: the plan decides until it is redeployed.
        const server = status && status.themes && Array.isArray(status.themes.allowed) && Number(status.themes.catalog_version) >= CATALOG_VERSION ? status.themes.allowed : null;
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

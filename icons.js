/* Taskitator icon system. App code asks for SEMANTIC keys ('lock', 'shield', 'nav-today', ...);
   each family maps them to symbols in its sprite, so a future family can supply different
   art for the same keys. The sprite is fetched once (precached by the service worker for
   offline use) and injected into the DOM so <use href="#id"> stays a local reference. */
(function () {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorIcons) return;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Semantic key -> symbol id, per family.
    const MAPS = {
        nature: {
            // shell
            'menu': 'nt-i-earth', 'completed': 'nt-i-leaf', 'breaks': 'nt-i-tent', 'scratchpad': 'nt-i-ff0',
            'scratchpad-lit': 'nt-i-ff1', 'emergency': 'nt-i-flame', 'copilot': 'nt-x-copilot-head', 'sparkle': 'nt-x-sparkle',
            'add': 'nt-x-plus', 'leaf': 'nt-leaf',
            // navigation
            'nav-today': 'nt-e-pine', 'nav-general': 'nt-e-palm', 'nav-calendar': 'nt-e-calendar', 'nav-projects': 'nt-e-briefcase',
            'nav-stats': 'nt-e-sprout2', 'nav-trash': 'nt-x-trash', 'nav-drafts': 'nt-e-receipt', 'nav-universe': 'nt-e-planet',
            'nav-sleep': 'nt-e-moon', 'nav-help': 'nt-e-book', 'nav-settings': 'nt-e-mountain', 'nav-login': 'nt-e-key',
            // states and features
            'lock': 'nt-e-lock', 'unlock': 'nt-x-unlock', 'shield': 'nt-e-shield', 'bonus': 'nt-e-star', 'star': 'nt-e-star',
            'warning': 'nt-e-warning', 'calendar': 'nt-e-calendar', 'robot': 'nt-x-copilot-head', 'copilot-body': 'nt-x-copilot-body', 'ai': 'nt-e-owl', 'owl': 'nt-e-owl',
            'siren': 'nt-e-siren', 'bolt': 'nt-e-bolt', 'bulb': 'nt-e-bulb', 'test': 'nt-e-tube', 'clip': 'nt-e-clip',
            'camera': 'nt-e-camera', 'receipt': 'nt-e-receipt', 'notes': 'nt-e-receipt', 'book': 'nt-e-book', 'study': 'nt-e-bulb', 'recurring': 'nt-e-leaves', 'key': 'nt-e-key',
            'tag': 'nt-e-tag', 'person': 'nt-e-person', 'phone': 'nt-e-phone', 'inbox': 'nt-e-inbox', 'mail': 'nt-e-mailbox',
            'briefcase': 'nt-e-briefcase', 'folder': 'nt-e-briefcase', 'sliders': 'nt-e-sliders', 'settings': 'nt-e-sliders',
            'moon': 'nt-e-moon', 'planet': 'nt-e-planet', 'mountain': 'nt-e-mountain', 'goal': 'nt-e-mountain', 'pine': 'nt-e-pine',
            'palm': 'nt-e-palm', 'sprout': 'nt-e-sprout', 'growth': 'nt-e-sprout2', 'leaves': 'nt-e-leaves', 'trash': 'nt-x-trash',
            'butterfly': 'nt-e-butterfly', 'bee': 'nt-e-bee', 'mushroom': 'nt-e-mushroom', 'coffee': 'nt-x-coffee',
            'earth': 'nt-i-earth', 'flame': 'nt-i-flame', 'dove': 'nt-i-dove', 'tent': 'nt-i-tent', 'save': 'nt-e-inbox',
            'search': 'nt-e-sliders', 'stats': 'nt-e-sprout2', 'timer': 'nt-x-timer', 'help': 'nt-e-book',
            // brand (body = currentColor, swash = --tk-logo-accent)
            'brand-hybrid': 'nt-brand-hybrid', 'brand-mascot': 'nt-brand-mascot', 'brand-letter': 'nt-brand-letter', 'brand-text': 'nt-brand-text'
        }
    };
    // Animal completion buttons, in priority order (rank 1 first). Extra ranks wrap around.
    const ANIMALS = ['lion', 'tiger', 'wolf', 'bear', 'eagle', 'fox', 'elephant', 'rhino', 'gorilla', 'deer', 'owl', 'zebra', 'giraffe', 'hippo', 'roo', 'croc'];
    const BIRD_FRAMES = ['nt-bird0', 'nt-bird1', 'nt-bird2'];

    const family = () => document.documentElement.dataset.family || document.documentElement.getAttribute('data-family') || 'nature';
    const mapFor = fam => MAPS[fam] || MAPS.nature;
    // Animals, bird frames and the leaf are semantic keys too.
    for (const fam of Object.keys(MAPS)) {
        ANIMALS.forEach(a => { MAPS[fam]['animal-' + a] = 'nt-a-' + a; });
        BIRD_FRAMES.forEach((b, i) => { MAPS[fam]['bird' + i] = b; });
    }
    // Markup always points at the family-neutral alias #ic-<key>; the alias is built from
    // the active family's sprite at injection time, so markup never names family art.
    const symbol = key => (mapFor(family())[key] ? 'ic-' + key : null);
    const has = key => typeof key === 'string' && Boolean(mapFor('nature')[key]);

    // The mascot is wider than tall, so these keys get a wider box (see .tk-ic-wide).
    const WIDE = new Set(["copilot","robot"]);

    // Markup string. Icons are decorative: the surrounding control carries the label.
    function icon(key, cls) {
        const id = symbol(key);
        if (!id) return '';
        return '<svg class="tk-ic' + (WIDE.has(key) ? ' tk-ic-wide' : '') + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#' + id + '"></use></svg>';
    }
    function node(key, cls) {
        const id = symbol(key);
        if (!id) return document.createTextNode('');
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'tk-ic' + (WIDE.has(key) ? ' tk-ic-wide' : '') + (cls ? ' ' + cls : ''));
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', '#' + id);
        svg.appendChild(use);
        return svg;
    }
    // For renderers that accept either an icon key or plain text (tour steps, lists).
    function glyph(value, cls) {
        return has(value) ? node(value, cls) : document.createTextNode(value == null ? '' : String(value));
    }
    // Random but stable: the same task always gets the same animal (hash of its id), so re-renders never reshuffle.
    function animalForId(id) {
        let h = 2166136261;
        for (const c of String(id ?? '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
        return ANIMALS[(h >>> 0) % ANIMALS.length];
    }
    function animalFor(rank) {
        const n = Number.isInteger(rank) && rank > 0 ? rank - 1 : 0;
        return ANIMALS[n % ANIMALS.length];
    }
    function animal(rankOrName, cls) {
        const name = typeof rankOrName === 'string' && ANIMALS.includes(rankOrName) ? rankOrName : animalFor(rankOrName);
        return node('animal-' + name, 'tk-animal' + (cls ? ' ' + cls : ''));
    }

    // Shared by every task-list renderer (Today/General, Projects, Calendar agenda):
    // depth for frame thickness, priority colour for the ring, animal by priority rank.
    function decorateTask({ li, row, checkBtn, task, depth = 0 } = {}) {
        try {
            if (li) li.style.setProperty('--d', String(depth));
            const prios = window.TaskitatorApp?.getGlobalPriorities?.() || [];
            const p = prios.find(x => x.id === task?.priority_id);
            if (p && row) row.style.setProperty('--pc', p.color);
            if (checkBtn) {
                if (task?.ai_locked) checkBtn.classList.add('is-ai-locked');
                if (!checkBtn.querySelector('.tk-animal')) checkBtn.appendChild(animal(task?.id != null ? animalForId(task.id) : (Number(p?.rank) || 1)));
            }
        } catch { /* cosmetic only */ }
    }

    // ----- Sprite injection -----
    let ready = null;
    function sprite() {
        if (ready) return ready;
        const fam = window.TaskitatorThemes?.FAMILIES?.[family()] || window.TaskitatorThemes?.FAMILIES?.nature;
        const url = fam?.sprite || 'image/nature_sprites/sprite.svg';
        const load = (opts) => fetch(url, opts)
            .then(r => (r.ok ? r.text() : Promise.reject(new Error('sprite ' + r.status))))
            .then(text => {
                if (!/^\s*<svg[\s>]/.test(text) || /<script|on[a-z]+=|javascript:/i.test(text)) throw new Error('Unexpected sprite content');
                const holder = document.createElement('div');
                holder.innerHTML = text;
                const svg = holder.querySelector('svg');
                if (!svg) throw new Error('Sprite has no svg');
                svg.id = 'tk-sprite';
                const map = mapFor(family());
                for (const [key, id] of Object.entries(map)) {
                    const target = svg.querySelector('symbol[id="' + id + '"]');
                    if (!target) continue;
                    const alias = target.cloneNode(true);
                    alias.id = 'ic-' + key;
                    svg.appendChild(alias);
                }
                const insert = () => document.body.insertBefore(svg, document.body.firstChild);
                if (document.body) insert(); else document.addEventListener('DOMContentLoaded', insert, { once: true });
                document.documentElement.classList.add('tk-icons-ready');
                return true;
            });
        // A failed or stale response (e.g. a 404 held by a CDN or the HTTP cache after a deploy) must not leave
        // icons blank for the whole session: retry with the cache bypassed. Icons are <use> references, so they
        // appear by themselves once the sprite is in the page.
        const tries = [0, 1500, 6000];
        ready = (async () => {
            for (let i = 0; i < tries.length; i++) {
                if (tries[i]) await new Promise(r => setTimeout(r, tries[i]));
                try { return await load(i ? { credentials: 'same-origin', cache: 'reload' } : { credentials: 'same-origin' }); } catch { /* retry */ }
            }
            return false;
        })();
        return ready;
    }
    sprite();

    window.TaskitatorIcons = Object.freeze({ MAPS, ANIMALS, BIRD_FRAMES, icon, node, glyph, has, symbol, animal, animalFor, animalForId, decorateTask, ready: () => sprite() });
})();

/* Taskitator family runtime: NATURE. Cosmetic only: scenes, parallax, cloud page
   transitions, loader styling hook, leaf bursts and the bird. It never reads or writes
   tasks, settings or sync state. Every effect honours the per-device Appearance flags
   (theme-boot.js), prefers-reduced-motion, and pauses while the page is hidden. */
(function () {
    'use strict';
    if (typeof document === 'undefined' || window.TaskitatorNature) return;
    const html = document.documentElement;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const appearance = () => window.TaskitatorAppearance;
    const active = () => html.dataset.family === 'nature';
    const allowed = key => active() && !document.hidden && (appearance()?.motionAllowed(key) ?? true);

    // ----- Scenes (colours come from CSS variables, never JS hex) -----
    const rng = seed => () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const fill = v => 'style="fill:var(' + v + ')"';
    const hill = (y, c, a = 1, k = 1) => '<path d="M0 ' + y + ' C90 ' + (y - 60 * k) + ',170 ' + (y - 10 * k) + ',240 ' + (y - 45 * k) + ' S360 ' + (y + 5) + ',400 ' + (y - 35 * k) + ' V800 H0Z" ' + fill(c) + ' opacity="' + a + '"/>';
    function pines(n, y0, y1, c, size, seed) {
        const r = rng(seed); let o = '';
        for (let i = 0; i < n; i++) {
            const x = r() * 400, y = y0 + r() * (y1 - y0), h = size * (0.75 + r() * 0.6);
            o += '<path d="M' + x + ' ' + (y - h) + 'L' + (x + h * 0.3) + ' ' + (y - h * 0.2) + 'H' + (x + h * 0.14) + 'L' + (x + h * 0.36) + ' ' + y + 'H' + (x - h * 0.36) + 'L' + (x - h * 0.14) + ' ' + (y - h * 0.2) + 'H' + (x - h * 0.3) + 'Z" ' + fill(c) + '/>';
        }
        return o;
    }
    const SCENES = {};
    const Scenes = {
        register(family, set) { SCENES[family] = Object.assign(SCENES[family] || {}, set); },
        get(family, name) { const f = SCENES[family] || {}; return f[name] || f.today || null; }
    };
    Scenes.register('nature', {
        today: { ground: ['', '--sc-hill2', '--sc-hill3'], layers: () => [
            hill(430, '--sc-hill1', 0.9),
            hill(520, '--sc-hill2', 0.95, 0.8) + pines(26, 430, 560, '--sc-tree1', 46, 3) +
                '<path d="M215 400C120 470 310 520 200 590S110 700 240 760 290 820 270 860" fill="none" style="stroke:var(--sc-water)" stroke-width="30" stroke-linecap="round" opacity=".75"/>' +
                '<path d="M215 400C120 470 310 520 200 590S110 700 240 760" fill="none" style="stroke:var(--sc-water-hi)" stroke-width="5" stroke-linecap="round" opacity=".35"/>',
            hill(660, '--sc-hill3', 1, 0.7) + pines(30, 640, 800, '--sc-tree2', 60, 9)] },
        general: { ground: ['', '', ''], layers: () => {
            const r = rng(5); let w = '';
            for (let i = 0; i < 14; i++) w += '<path d="M' + r() * 300 + ' ' + (380 + i * 34) + 'q10 -9 20 0t20 0t20 0" style="stroke:var(--sc-water-hi)" stroke-width="2" fill="none" opacity=".4"/>';
            const isl = ([x, y, rx, ry], i) => '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" ' + fill('--sc-sand') + ' opacity=".85"/><ellipse cx="' + x + '" cy="' + (y - ry * 0.35) + '" rx="' + rx * 0.78 + '" ry="' + ry * 0.7 + '" ' + fill('--sc-grass') + '/>' + pines(5, y - ry * 0.9, y - ry * 0.2, '--sc-tree1', 34, i + 2);
            return [w + isl([300, 470, 60, 20], 1), isl([110, 560, 120, 38], 2) + isl([330, 650, 70, 24], 3), isl([210, 745, 90, 28], 4)];
        } },
        settings: { ground: ['', '--sc-hill2', '--sc-hill3'], layers: () => {
            let o = '';
            [[70, 420, 150], [210, 380, 190], [340, 430, 150]].forEach(([x, y], i) => {
                o += '<path d="M' + (x - 150) + ' 640L' + x + ' ' + y + 'L' + (x + 150) + ' 640Z" ' + fill(i === 1 ? '--sc-rock2' : '--sc-rock1') + '/>' +
                    '<path d="M' + x + ' ' + y + 'L' + (x + 34) + ' ' + (y + 52) + 'L' + (x + 12) + ' ' + (y + 44) + 'L' + x + ' ' + (y + 66) + 'L' + (x - 14) + ' ' + (y + 44) + 'L' + (x - 36) + ' ' + (y + 54) + 'Z" ' + fill('--sc-snow') + ' opacity=".8"/>';
            });
            return [o, hill(620, '--sc-hill2', 1, 0.8) + pines(22, 610, 690, '--sc-tree2', 44, 6),
                '<ellipse cx="200" cy="745" rx="170" ry="38" ' + fill('--sc-water') + ' opacity=".7"/><rect x="0" y="770" width="400" height="40" ' + fill('--sc-hill3') + '/>'];
        } },
        sleep: { ground: ['', '--sc-night2', '--sc-night1'], layers: () => {
            const r = rng(4);
            let o = '<circle cx="300" cy="170" r="42" ' + fill('--sc-sun') + ' opacity=".85"/><circle cx="316" cy="160" r="38" ' + fill('--sc-night1') + '/>';
            for (let i = 0; i < 45; i++) o += '<circle cx="' + r() * 400 + '" cy="' + r() * 420 + '" r="' + (r() * 1.6 + 0.4) + '" fill="#fff" opacity="' + (0.3 + r() * 0.5) + '"/>';
            return [o + hill(520, '--sc-night2', 0.9, 1.2), hill(610, '--sc-night2', 1, 1), hill(710, '--sc-night1', 1, 0.8)];
        } },
        help: { ground: ['', '--sc-hill2', '--sc-hill3'], layers: () => [
            '<circle cx="300" cy="260" r="46" ' + fill('--sc-sun') + ' opacity=".8"/>' + hill(470, '--sc-hill1', 0.9, 0.9),
            hill(560, '--sc-hill2', 1, 0.9) + pines(8, 560, 640, '--sc-tree1', 34, 12),
            hill(680, '--sc-hill3', 1, 0.7)] },
        login: { ground: ['', '--sc-hill2', '--sc-hill3'], layers: () => {
            let b = '';
            [[90, 210, 1], [170, 170, 0.8], [250, 240, 0.9]].forEach(([x, y, s]) => {
                b += '<path d="M' + x + ' ' + y + 'q' + 12 * s + ' ' + (-10 * s) + ' ' + 24 * s + ' 0q' + 12 * s + ' ' + (-10 * s) + ' ' + 24 * s + ' 0" style="stroke:var(--sc-snow)" stroke-width="2.4" fill="none" opacity=".7"/>';
            });
            return ['<circle cx="200" cy="470" r="78" ' + fill('--sc-glow') + ' opacity=".75"/>' + b + hill(500, '--sc-rock1', 0.9, 1),
                hill(580, '--sc-hill2', 1, 0.8) + pines(10, 580, 660, '--sc-tree1', 38, 15), hill(690, '--sc-hill3', 1, 0.7)];
        } }
    });

    function pageScene() {
        const p = location.pathname;
        if (p.endsWith('/settings.html')) return 'settings';
        if (p.endsWith('/sleep.html')) return 'sleep';
        if (p.endsWith('/study-plans.html')) return 'general';
        if (p.endsWith('/help.html')) return 'help';
        if (p.endsWith('/login.html')) return 'login';
        if (p.endsWith('/components.html')) return /view=projects/.test(location.search) ? 'general' : 'help';
        return /^#general/.test(location.hash) ? 'general' : 'today';
    }
    let sceneName = null;
    function scene(name) {
        const host = document.getElementById('tk-scene');
        const def = Scenes.get(html.dataset.family || 'nature', name);
        if (!host || !def || name === sceneName) return;
        sceneName = name;
        const layers = def.layers();
        host.replaceChildren(...layers.map((svg, i) => {
            const layer = document.createElement('div');
            layer.className = 'tk-layer';
            if (def.ground[i]) layer.style.setProperty('--tk-ground', 'var(' + def.ground[i] + ')');
            layer.innerHTML = '<svg viewBox="0 0 400 800" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">' + svg + '</svg>';
            return layer;
        }));
        parallax();
    }

    // ----- Parallax: three depths, transform only, capped at 30vh -----
    const DEPTH = [0.35, 0.65, 1];
    let frame = 0, idle = 0;
    function parallax() {
        const host = document.getElementById('tk-scene');
        if (!host) return;
        const on = allowed('parallax');
        const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
        const p = on ? Math.min(1, scrollY / max) : 0, cap = innerHeight * 0.3;
        host.querySelectorAll('.tk-layer').forEach((layer, i) => { layer.style.transform = 'translate3d(0,' + (-(p * cap * DEPTH[i])).toFixed(1) + 'px,0)'; });
    }
    function onScroll() {
        if (frame || !active()) return;
        const host = document.getElementById('tk-scene');
        host?.classList.add('is-moving');           // will-change only while moving
        clearTimeout(idle);
        idle = setTimeout(() => host?.classList.remove('is-moving'), 250);
        frame = requestAnimationFrame(() => { frame = 0; parallax(); });
    }

    // ----- Leaf burst on completion -----
    const LEAF_COLOURS = ['var(--sc-grass)', 'var(--tk-accent)', 'var(--tk-soft)', '#d9a441', '#62b36d', 'var(--tk-frame)'];
    function burst(target, count = 12) {
        if (!allowed('particles')) return;
        const fx = document.getElementById('tk-fx');
        if (!fx) return;
        let x = innerWidth / 2, y = innerHeight / 2;
        if (target?.getBoundingClientRect) { const r = target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
        for (let i = 0; i < count; i++) {
            const s = document.createElementNS(SVG_NS, 'svg');
            s.setAttribute('class', 'tk-leaf');
            s.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS(SVG_NS, 'use');
            use.setAttribute('href', '#ic-leaf');
            s.appendChild(use);
            s.style.cssText = 'left:' + (x - 10) + 'px;top:' + (y - 10) + 'px;color:' + LEAF_COLOURS[i % LEAF_COLOURS.length] +
                ';--dx:' + ((Math.random() - 0.5) * 190).toFixed(0) + 'px;--r:' + ((Math.random() - 0.5) * 720).toFixed(0) + 'deg;--t:' + (1.1 + Math.random() * 0.8).toFixed(2) + 's';
            fx.appendChild(s);
            setTimeout(() => s.remove(), 2100);
        }
    }

    // ----- Bird: one random pass when a task is created. Speed 1-10 (10 = fastest). -----
    let birdBusy = false;
    function bird(force) {
        if (birdBusy || (!force && !allowed('bird')) || typeof Element.prototype.animate !== 'function') return;
        const speed = appearance()?.read().bird_speed || 7;
        const s = document.createElementNS(SVG_NS, 'svg');
        s.setAttribute('class', 'tk-bird');
        s.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', '#ic-bird0');
        s.appendChild(use);
        document.body.appendChild(s);
        birdBusy = true;
        const W = innerWidth, H = innerHeight, y0 = H * (0.15 + Math.random() * 0.5), dir = Math.random() < 0.5 ? 1 : -1;
        const x0 = dir > 0 ? -50 : W + 10, x1 = dir > 0 ? W + 10 : -110, flip = dir > 0 ? '' : ' scaleX(-1)';
        const keys = [];
        for (let i = 0; i <= 10; i++) { const f = i / 10; keys.push({ transform: 'translate(' + (x0 + (x1 - x0) * f) + 'px,' + (y0 + Math.sin(f * 9) * 9 - f * 30) + 'px)' + flip }); }
        const duration = 4500 * Math.pow(0.1, (speed - 1) / 9) * (0.9 + Math.random() * 0.2);
        const flap = Math.min(110, Math.max(28, 55 * duration / 1616));
        let k = 0;
        const timer = setInterval(() => { k = (k + 1) % 4; use.setAttribute('href', ['#ic-bird0', '#ic-bird1', '#ic-bird2', '#ic-bird1'][k]); }, flap);
        const done = () => { clearInterval(timer); s.remove(); birdBusy = false; };
        const anim = s.animate(keys, { duration, easing: 'linear' });
        anim.onfinish = done; anim.oncancel = done;
    }

    // ----- Cloud transition between pages -----
    const CLOUD_FLAG = 'taskitator_clouds_pending';
    function clouds() {
        let c = document.getElementById('tk-clouds');
        if (!c) {
            c = document.createElement('div');
            c.id = 'tk-clouds';
            c.setAttribute('aria-hidden', 'true');
            c.innerHTML = '<div class="tk-cloud l"></div><div class="tk-cloud r"></div>';
            document.body.appendChild(c);
        }
        return c;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    async function cloudsIn() {
        if (!allowed('clouds')) return false;
        const c = clouds();
        c.classList.add('in');
        await wait(330);
        return true;
    }
    function cloudsOut() {
        const c = document.getElementById('tk-clouds');
        if (!c) return;
        requestAnimationFrame(() => c.classList.remove('in', 'plain'));
    }
    function interceptLinks() {
        document.addEventListener('click', e => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !active()) return;
            const a = e.target.closest?.('a[href]');
            if (!a || a.target || a.hasAttribute('download') || a.dataset.noClouds !== undefined) return;
            const url = new URL(a.href, location.href);
            if (url.origin !== location.origin || !/\.html$|\/$/.test(url.pathname)) return;
            if (url.pathname === location.pathname && url.search === location.search) return;  // in-page hash routes stay instant
            if (/view=universe/.test(url.search) || !allowed('clouds')) return;
            e.preventDefault();
            try { sessionStorage.setItem(CLOUD_FLAG, '1'); } catch {}
            cloudsIn().then(() => { location.href = url.href; });
        });
    }
    function arriveWithClouds() {
        let pending = false;
        try { pending = sessionStorage.getItem(CLOUD_FLAG) === '1'; sessionStorage.removeItem(CLOUD_FLAG); } catch {}
        if (!pending || !allowed('clouds')) return;
        const c = clouds();
        c.style.transition = 'none';
        c.classList.add('in');
        void c.offsetWidth;
        c.style.transition = '';
        const part = () => setTimeout(cloudsOut, 120);
        if (html.classList.contains('auth-pending')) window.addEventListener('taskitator-auth-ready', part, { once: true });
        else part();
        setTimeout(cloudsOut, 6000); // never leave clouds covering the page
    }

    // ----- Loading: the secure-boot status becomes clouds, then a small card after 1.8s -----
    function watchLoader() {
        const mark = el => { setTimeout(() => { if (el.isConnected) el.classList.add('tk-loading-card'); }, 1800); };
        const found = document.getElementById('authLoadingStatus');
        if (found) { mark(found); return; }
        if (typeof MutationObserver !== 'function' || !document.body) return;
        const mo = new MutationObserver(() => {
            const el = document.getElementById('authLoadingStatus');
            if (el) { mo.disconnect(); mark(el); }
        });
        mo.observe(document.body, { childList: true });
        setTimeout(() => mo.disconnect(), 15000);
    }

    function mount() {
        if (!document.getElementById('tk-scene')) {
            const host = document.createElement('div');
            host.id = 'tk-scene';
            host.setAttribute('aria-hidden', 'true');
            document.body.insertBefore(host, document.body.firstChild);
        }
        if (!document.getElementById('tk-fx')) {
            const fx = document.createElement('div');
            fx.id = 'tk-fx';
            fx.setAttribute('aria-hidden', 'true');
            document.body.appendChild(fx);
        }
        scene(pageScene());
        watchLoader();
        arriveWithClouds();
        interceptLinks();
        addEventListener('scroll', onScroll, { passive: true });
        addEventListener('resize', onScroll);
        addEventListener('hashchange', () => scene(pageScene()));
        addEventListener('taskitator-task-created', () => setTimeout(() => bird(false), 350));
        addEventListener('taskitator-appearance', () => parallax());
        // Back/forward cache: never restore a page still covered by clouds.
        addEventListener('pageshow', () => cloudsOut());
        document.addEventListener('visibilitychange', () => {
            document.querySelectorAll('.tk-bird').forEach(b => b.getAnimations?.().forEach(a => (document.hidden ? a.pause() : a.play())));
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();

    window.TaskitatorNature = Object.freeze({ Scenes, scene, burst, bird, cloudsIn, cloudsOut });
})();

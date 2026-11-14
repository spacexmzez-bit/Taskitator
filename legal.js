/* legal.html: Privacy Policy & Terms, or Free vs Pro with ?view=compare. Public: works without signing in. */
(function () {
    'use strict';
    let view = '';
    try { view = String(new URLSearchParams(location.search).get('view') || '').toLowerCase(); } catch (e) { view = ''; }
    const compare = view === 'compare';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
    show('componentView-compare', compare);
    show('componentView-legal', !compare);
    const title = document.getElementById('legalPageTitle');
    if (title) title.textContent = compare ? 'Compare Free & Pro' : 'Privacy Policy & Terms';
    document.title = (compare ? 'Compare Free & Pro' : 'Privacy Policy & Terms') + ' — Taskitator';
    const back = document.getElementById('legalBack');
    try { const prev = new URL(document.referrer); if (prev.origin === location.origin && !/\/legal\.html$/.test(prev.pathname)) back.href = prev.href; } catch (e) { /* direct visit: back to the app */ }
    let anchor = location.hash.slice(1);
    try { anchor = decodeURIComponent(anchor); } catch (_) {}
    const target = anchor && document.getElementById(anchor);
    if (target) requestAnimationFrame(() => target.scrollIntoView());
})();

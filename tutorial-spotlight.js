/* Taskitator tour engine (v2).
   TaskitatorSpotlight.start({steps, onFinish, chapter}) / .stop()
   Step: {selector:string|string[], title, text, why, note, icon, visual, kind:'center', before(), when()}
   Visuals: {type:'legend'|'pips'|'list'|'checklist', ...}. Text supports **bold** and `code`. */
(() => {
  'use strict';
  let active = null;
  const GAP = 14, EDGE = 12, PAD = 6;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // **bold** and `code` -> DOM nodes (never innerHTML).
  function rich(parent, str) {
    String(str || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach(part => {
      if (!part) return;
      if (part.startsWith('**')) parent.append(el('b', '', part.slice(2, -2)));
      else if (part.startsWith('`')) parent.append(el('code', '', part.slice(1, -1)));
      else parent.append(document.createTextNode(part));
    });
    return parent;
  }
  function findTarget(sel) {
    const list = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const s of list) {
      let n = null;
      try { n = document.querySelector(s); } catch { /* bad selector */ }
      if (visible(n)) return n;
    }
    return null;
  }
  function buildVisual(v, finish) {
    if (!v) return null;
    const box = el('div', 'tt-visual');
    if (v.type === 'legend') {
      const g = el('div', 'tt-legend');
      v.items.forEach(i => { const s = el('span'); const d = el('i', 'tt-dot'); d.style.background = i.color; s.append(d, document.createTextNode(i.label)); g.append(s); });
      box.append(g);
    } else if (v.type === 'pips') {
      const g = el('div', 'tt-pips');
      for (let i = 0; i < v.total; i++) g.append(el('i', i < v.on ? '' : 'tt-off'));
      if (v.label) g.append(el('span', '', ' ' + v.label));
      box.append(g);
    } else if (v.type === 'list') {
      const ul = el('ul', 'tt-list');
      v.items.forEach(i => { const li = el('li'); li.append(el('span', '', i.icon || '•')); li.append(rich(el('span'), i.text)); ul.append(li); });
      box.append(ul);
    } else if (v.type === 'checklist') {
      const g = el('div', 'tt-checklist');
      v.items.forEach(i => {
        const a = el('a'); a.href = i.href || '#'; a.setAttribute('role', 'link');
        a.append(el('span', '', i.icon || '•'));
        const t = el('span'); t.append(document.createTextNode(i.label)); if (i.sub) t.append(el('small', '', i.sub)); a.append(t);
        a.append(el('span', 'tt-go', '→'));
        a.addEventListener('click', e => { e.preventDefault(); finish('completed', i.href); });
        g.append(a);
      });
      box.append(g);
    } else return null;
    return box;
  }

  function start({ steps, onFinish = () => {}, chapter = '' } = {}) {
    if (active || !Array.isArray(steps) || !steps.length) return false;
    // Never cover a modal or sign-in screen. The caller can retry later.
    if (document.querySelector('dialog[open], .modal-overlay.open, #authLoadingStatus')) return false;

    const previous = document.activeElement;
    const veil = el('div', 'tt-veil');
    const ring = el('div', 'tt-ring tt-none'); ring.setAttribute('aria-hidden', 'true');
    const arrow = el('div', 'tt-arrow tt-hide'); arrow.setAttribute('aria-hidden', 'true');
    const card = el('section', 'tt-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.tabIndex = -1;
    card.setAttribute('aria-labelledby', 'tt-title'); card.setAttribute('aria-describedby', 'tt-text');
    const live = el('div', 'tt-sr'); live.setAttribute('aria-live', 'polite');
    veil.append(ring, arrow, card, live);
    document.body.append(veil);

    let index = 0, target = null, raf = 0, token = 0, done = false, list = steps.slice();

    function finish(result, href) {
      if (done) return; done = true; active = null; token++;
      cancelAnimationFrame(raf);
      removeEventListener('resize', onMove); removeEventListener('scroll', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      veil.remove();
      if (previous?.isConnected && !href) try { previous.focus({ preventScroll: true }); } catch { /* ignore */ }
      try { onFinish(result); } finally { if (href) location.href = href; }
    }

    function render(step, t) {
      card.replaceChildren();
      const centered = !t || step.kind === 'center';
      const meta = el('div', 'tt-meta');
      meta.append(el('span', 'tt-chapter', chapter), el('span', 'tt-count', `${index + 1} of ${list.length}`));
      const bar = el('div', 'tt-bar'); bar.setAttribute('aria-hidden', 'true');
      list.forEach((_, i) => bar.append(el('i', i < index ? 'tt-done' : i === index ? 'tt-now' : '')));
      const head = el('div', 'tt-head');
      if (step.icon) head.append(el('div', 'tt-icon', step.icon));
      const body = el('div');
      const h = el('h2', '', step.title); h.id = 'tt-title';
      const p = rich(el('p', 'tt-text'), step.text); p.id = 'tt-text';
      body.append(h, p); head.append(body);
      card.append(meta, bar, head);
      if (!t && step.selector && step.kind !== 'center') card.append(el('p', 'tt-note', 'This isn’t on your screen right now, so there’s nothing to point at. The description above still applies.'));
      if (step.note) card.append(rich(el('p', 'tt-note'), step.note));
      if (step.why) card.append(rich(el('p', 'tt-why'), '**Why it matters:** ' + step.why));
      const vis = buildVisual(step.visual, finish); if (vis) card.append(vis);
      const actions = el('div', 'tt-actions');
      const skip = el('button', 'tt-skip', 'Skip tour'); skip.type = 'button';
      const back = el('button', 'tt-btn', 'Back'); back.type = 'button'; back.disabled = index === 0;
      const next = el('button', 'tt-btn tt-primary', index === list.length - 1 ? 'Done' : 'Next'); next.type = 'button';
      skip.onclick = () => finish('skipped');
      back.onclick = go.bind(null, -1);
      next.onclick = () => index === list.length - 1 ? finish('completed') : go(1);
      actions.append(skip, el('span', 'tt-spacer'), back, next);
      card.append(actions, el('p', 'tt-keys', '← → to move · Esc to skip'));
      card.classList.toggle('tt-center', centered);
      card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
      return next;
    }

    function place() {
      if (done) return;
      const step = list[index];
      target = step.kind === 'center' ? null : findTarget(step.selector);
      const vw = innerWidth, vh = innerHeight;
      card.style.maxHeight = (vh - 2 * EDGE) + 'px';
      if (!target) {
        veil.classList.add('tt-dim'); ring.classList.add('tt-none'); arrow.classList.add('tt-hide');
        card.classList.add('tt-center'); card.style.left = card.style.top = '';
        return;
      }
      const r = target.getBoundingClientRect();
      const L = Math.max(0, r.left - PAD), T = Math.max(0, r.top - PAD);
      const R = Math.min(vw, r.right + PAD), B = Math.min(vh, r.bottom + PAD);
      if (R <= L || B <= T) { veil.classList.add('tt-dim'); ring.classList.add('tt-none'); card.classList.add('tt-center'); return; }
      veil.classList.remove('tt-dim'); ring.classList.remove('tt-none');
      Object.assign(ring.style, { left: L + 'px', top: T + 'px', width: (R - L) + 'px', height: (B - T) + 'px' });

      card.classList.remove('tt-center');
      const w = Math.min(420, vw - 2 * EDGE);
      card.style.width = w + 'px';
      const h = card.offsetHeight;
      const below = vh - B - GAP - EDGE, above = T - GAP - EDGE;
      let side = h <= below ? 'below' : h <= above ? 'above' : (below >= above ? 'below' : 'above');
      let room = side === 'below' ? below : above;
      let top, showArrow = true;
      if (room < Math.min(h, 160)) { // target nearly fills the screen: dock the card at the bottom, no arrow
        side = 'dock'; showArrow = false; top = vh - EDGE - Math.min(h, vh * 0.5);
        card.style.maxHeight = Math.floor(vh * 0.5) + 'px';
      } else {
        const used = Math.min(h, room);
        if (h > room) card.style.maxHeight = Math.floor(room) + 'px';
        top = side === 'below' ? B + GAP : T - GAP - used;
      }
      const cx = (L + R) / 2;
      const left = Math.min(Math.max(cx - w / 2, EDGE), vw - EDGE - w);
      card.style.left = left + 'px'; card.style.top = top + 'px';
      arrow.classList.toggle('tt-hide', !showArrow);
      if (showArrow) {
        arrow.classList.toggle('tt-below', side === 'below'); arrow.classList.toggle('tt-above', side === 'above');
        arrow.style.left = (Math.min(Math.max(cx, left + 24), left + w - 24) - 7) + 'px';
        arrow.style.top = (side === 'below' ? B + GAP - 7 : T - GAP - 7) + 'px';
      }
    }
    function onMove() {
      ring.classList.add('tt-instant');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { place(); requestAnimationFrame(() => ring.classList.remove('tt-instant')); });
    }

    async function show(dir = 1) {
      const my = ++token;
      // Skip steps whose condition says they don't apply.
      while (index >= 0 && index < list.length && list[index].when && !safe(list[index].when)) index += dir;
      if (index < 0) index = 0;
      if (index >= list.length) return finish('completed');
      const step = list[index];
      if (step.before) { try { await step.before(); } catch { /* ignore */ } if (my !== token) return; }
      const t = step.kind === 'center' ? null : findTarget(step.selector);
      if (t) {
        const r = t.getBoundingClientRect();
        if (r.top < 70 || r.bottom > innerHeight - 70) { ring.classList.add('tt-instant'); t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); await sleep(30); if (my !== token) return; }
      }
      const next = render(step, t);
      live.textContent = `Step ${index + 1} of ${list.length}: ${step.title}`;
      place();
      requestAnimationFrame(() => { ring.classList.remove('tt-instant'); });
      next.focus({ preventScroll: true });
    }
    const safe = fn => { try { return fn(); } catch { return true; } };
    function go(d) {
      const n = index + d;
      if (n < 0 || n >= list.length) return;
      index = n; show(d);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('skipped'); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); index === list.length - 1 ? finish('completed') : go(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
      if (e.key === 'Tab') {
        const f = [...card.querySelectorAll('button:not(:disabled), a[href]')];
        if (!f.length) { e.preventDefault(); card.focus(); return; }
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      }
    }

    active = { finish };
    addEventListener('resize', onMove); addEventListener('scroll', onMove, true);
    document.addEventListener('keydown', onKey, true);
    show(1);
    return true;
  }

  window.TaskitatorSpotlight = Object.freeze({ start, stop: () => active?.finish('skipped'), isActive: () => !!active });
})();

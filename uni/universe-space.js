/* Universe space kit (presentation only; never grants permissions or changes data).
   - Injects image/space_sprites/sprite.svg once, so <use href="#sp-..."> stays a local reference.
   - body(): celestial bodies for task completion circles. The pick is random but stable: the same
     task id always gets the same body (same hash as the personal animals in icons.js).
   - icon(): line icons for Universe controls.
   - label(): readable names for server values (roles, states, audit modes, activity kinds), so the
     page never shows raw words like "member_joined". The English text is the i18n dictionary key. */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.UniverseSpace) return;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPRITE = 'image/space_sprites/sprite.svg';
  // Round bodies sit well inside a completion circle. Stars also get the shine animation.
  const STARS = ['sun', 'sirius', 'polaris', 'vega'];
  const BODIES = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon', 'ceres', 'eris', 'io', 'titan', 'betelgeuse', ...STARS];
  // Not round: decoration only (empty states, completed roots).
  const DECOR = ['comet', 'pluto-charon', 'vesta', 'alpha-centauri', 'phobos-deimos'];
  const ICONS = ['menu', 'sync', 'filter', 'chevron', 'plus', 'close', 'check', 'up', 'down', 'back', 'shield', 'review', 'bonus', 'sort', 'calendar', 'people'];

  function bodyFor(id) {
    let h = 2166136261;
    for (const c of String(id ?? '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return BODIES[(h >>> 0) % BODIES.length];
  }
  const isStar = name => STARS.includes(name);

  function use(symbol, cls) {
    if (typeof document === 'undefined' || !document.createElementNS) return null;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const ref = document.createElementNS(SVG_NS, 'use');
    ref.setAttribute('href', '#' + symbol);
    svg.appendChild(ref);
    return svg;
  }
  // Returns an <svg> node, or null where SVG is unavailable (callers keep their text fallback).
  function body(name, cls) {
    if (!BODIES.includes(name) && !DECOR.includes(name)) return null;
    return use('sp-b-' + name, 'uni-body' + (isStar(name) ? ' uni-star' : '') + (cls ? ' ' + cls : ''));
  }
  function icon(key, cls) {
    if (!ICONS.includes(key)) return null;
    return use('sp-i-' + key, 'uni-ic' + (cls ? ' ' + cls : ''));
  }
  // Replace a button's text glyph with an icon. The accessible name stays on the button.
  function setIcon(button, key) {
    const node = icon(key);
    if (node && button?.replaceChildren) button.replaceChildren(node);
    return button;
  }

  const LABELS = {
    role: { owner: 'Owner', admin: 'Admin', reviewer: 'Reviewer', member: 'Member' },
    state: { open: 'Open', pending: 'In review', approved: 'Approved', rejected: 'Needs changes', cancelled: 'Cancelled' },
    audit: { none: 'No audit', human: 'Human only', ai: 'AI only', either: 'AI or human', both: 'AI then human' },
    decision: { approved: 'Approved', rejected: 'Needs changes' },
    pay: { personal: 'My saved key', hosted: 'Universe credits' },
    quote: { quoted: 'Quoted', approved: 'Approved', running: 'Running', uncertain: 'Checking', settled: 'Finished', cancelled: 'Cancelled', expired: 'Expired', failed: 'Failed' },
    activity: {
      create: 'Universe created', edit: 'Details changed', role: 'Role changed', remove: 'Member removed', leave: 'Member left',
      accept: 'Invitation accepted', invite: 'Invitation created', cancel: 'Invitation cancelled', delete: 'Deleted', transfer: 'Ownership transferred',
      'owner-transfer': 'Ownership transferred', settings: 'Review standards changed', submit: 'Proof submitted', review: 'Submission reviewed',
      complete: 'Task completed', reopen: 'Assignment reopened', dispute: 'Dispute updated', moderate: 'Comment removed', close: 'Task closed',
      reorder: 'Tasks reordered', attach: 'File attached', upload: 'File uploaded', file: 'File added', quote: 'AI review quoted',
      import: 'Backup imported', import_overwrite: 'Universe replaced from backup', lock_consent: 'Phone blocking allowed',
      lock_withdrawn: 'Phone blocking withdrawn', ai_review_settled: 'AI review finished', member_joined: 'Member joined', role_changed: 'Role changed'
    }
  };
  // Unknown values are shown as plain words ("task_closed:late" -> "Task closed: late"), never dropped.
  function humanize(value) {
    const text = String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s*:\s*/g, ': ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }
  function label(kind, value) {
    const map = LABELS[kind] || {}, key = String(value ?? '');
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    if (kind === 'activity') {
      const [head, ...rest] = key.split(':');
      if (rest.length && Object.prototype.hasOwnProperty.call(map, head)) return map[head] + ': ' + rest.join(':');
    }
    return humanize(key);
  }

  // ----- Sprite injection (same safety checks and retry as icons.js) -----
  let ready = null;
  function sprite() {
    if (ready) return ready;
    if (typeof document === 'undefined' || typeof fetch !== 'function' || !document.body) return Promise.resolve(false);
    const load = opts => fetch(SPRITE, opts)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error('sprite ' + r.status))))
      .then(text => {
        if (!/^\s*<svg[\s>]/.test(text) || /<script|on[a-z]+=|javascript:/i.test(text)) throw new Error('Unexpected sprite content');
        const holder = document.createElement('div');
        holder.innerHTML = text;
        const svg = holder.querySelector('svg');
        if (!svg) throw new Error('Sprite has no svg');
        svg.id = 'uni-sprite';
        document.getElementById('uni-sprite')?.remove();
        document.body.insertBefore(svg, document.body.firstChild);
        return true;
      });
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
  try { sprite(); } catch { /* cosmetic only */ }

  window.UniverseSpace = Object.freeze({ BODIES, STARS, DECOR, ICONS, LABELS, bodyFor, isStar, body, icon, setIcon, label, humanize, ready: () => sprite() });
})();

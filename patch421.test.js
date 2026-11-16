// Phase 4.2.1: break sprites, gear for Settings, no date filter on Today.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const icons = read('icons.js'), sprite = read('image/nature_sprites/sprite.svg'), app = read('app.js'), html = read('index.html');

test('Phase 4.2.1: break icons are weapons (out of break) and farming (in break), not the tent', () => {
  assert.match(icons, /'breaks': 'nt-i-weapons'/);
  assert.match(icons, /'breaks-active': 'nt-i-farming'/);
  for (const id of ['nt-i-weapons', 'nt-i-farming', 'nt-x-gear']) assert.match(sprite, new RegExp('<symbol id="' + id + '"'));
  assert.match(app, /break: 'breaks-active'/);
  assert.match(app, /#breakModalTitle > span/);
});

test('Phase 4.2.1: Settings uses the gear everywhere', () => {
  assert.match(icons, /'nav-settings': 'nt-x-gear'/);
  assert.doesNotMatch(icons, /'nav-settings': 'nt-e-mountain'/);
});

test('Phase 4.2.1: the date filter is hidden and ignored on Today', () => {
  assert.match(html, /id="filterDateSection"/);
  assert.match(app, /dateSec\.hidden = currentView === 'today'/);
  assert.match(app, /const listFilters = viewFilters\(activeFilters\)/);
  const fn = new Function('currentView', app.slice(app.indexOf('function viewFilters'), app.indexOf('function filtersActive')) + '; return viewFilters;');
  const f = { tags: new Set(), date: { mode: 'week', from: '', to: '' } };
  assert.equal(fn('today')(f).date.mode, '');
  assert.equal(fn('general')(f).date.mode, 'week');
});

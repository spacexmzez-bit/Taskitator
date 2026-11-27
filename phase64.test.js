// Phase 6.4: footprint stamp on task completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
// Phase 6.7: five packs of 9 animals; footprints are shared archetypes (PRINT_OF in icons.js).
const icons67 = read('icons.js');
const animals = icons67.match(/const PACKS = Object\.freeze\(\{([\s\S]*?)\n    \}\);/)[1].match(/'([a-z]+)'/g).map(a => a.slice(1, -1));
const printOf = Object.fromEntries([...icons67.match(/const PRINT_OF = Object\.freeze\(\{([\s\S]*?)\n    \}\);/)[1].matchAll(/([a-z]+): '([a-z]+)'/g)].map(m => [m[1], m[2]]));

test('every animal maps to a footprint archetype that exists in the sprite', () => {
    const sprite = read('image/nature_sprites/sprite.svg');
    const icons = read('icons.js');
    assert.equal(animals.length, 45);
    assert.equal(new Set(animals).size, 45, 'animal names are unique across packs');
    for (const a of animals) {
        const kind = printOf[a];
        assert.ok(kind, a + ' has an archetype');
        const m = sprite.match(new RegExp('<symbol id="nt-f-' + kind + '" viewBox="0 0 100 100">([\\s\\S]*?)</symbol>'));
        assert.ok(m, 'nt-f-' + kind);
        assert.match(m[1], /<path[^>]+d="M[^"]{8,}"/, kind + ' has path data');
    }
    assert.match(icons, /MAPS\[fam\]\['print-' \+ p\] = 'nt-f-' \+ p/);
    assert.ok(!/<script|on[a-z]+=|javascript:/i.test(sprite), 'sprite stays inert');
});

test('stamp reads the animal from the ring, only in the nature family, and skips when animals are off', () => {
    const src = read('icons.js');
    assert.match(src, /family\(\) !== 'nature'\) return false/);
    assert.match(src, /includes\('animals'\)\) return false/);
    assert.match(src, /querySelector\('\.tk-animal use'\)/);
    assert.match(src, /STAMP_MS = 340/);
    assert.match(src, /stamp, STAMP_MS,/);
});

test('UIFX.complete waits for the stamp and keeps the old wait when none ran', () => {
    const src = read('app.js');
    assert.match(src, /const stamped = Boolean\(window\.TaskitatorIcons\?\.stamp\?\.\(checkBtn\)\);/);
    assert.match(src, /stamped \? window\.TaskitatorIcons\.STAMP_MS : 260/);
    assert.ok(src.indexOf("if (this.reducedMotion()) return Promise.resolve();") < src.indexOf('stamp?.(checkBtn)'), 'reduced motion returns before stamping');
});

test('stamp CSS: fits the 340 ms wait, hidden when animals are off, ring stays positioned', () => {
    const css = read('family-nature.css');
    assert.match(css, /\.check-circle \.tk-print \{[^}]*animation: tkStamp \.34s/);
    assert.match(css, /@keyframes tkStamp/);
    assert.match(css, /\[data-fx-off~="animals"\] \.check-circle \.tk-print \{ display: none; \}/);
    assert.match(css, /html\[data-family="nature"\] \.check-circle \{\s*position: relative;/);
});

test('cache version moved so devices pick up the new sprite and styles', () => {
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v\d+'/);
});

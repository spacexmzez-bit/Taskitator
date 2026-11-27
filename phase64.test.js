// Phase 6.4: footprint stamp on task completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const animals = read('icons.js').match(/const ANIMALS = \[([^\]]+)\]/)[1].match(/'([a-z]+)'/g).map(a => a.slice(1, -1));

test('every animal has a footprint symbol and a print- key', () => {
    const sprite = read('image/nature_sprites/sprite.svg');
    const icons = read('icons.js');
    assert.equal(animals.length, 16);
    for (const a of animals) {
        const m = sprite.match(new RegExp('<symbol id="nt-f-' + a + '" viewBox="0 0 100 100">([\\s\\S]*?)</symbol>'));
        assert.ok(m, 'nt-f-' + a);
        assert.match(m[1], /<path[^>]+d="M[^"]{8,}"/, a + ' has path data');
    }
    assert.match(icons, /MAPS\[fam\]\['print-' \+ a\] = 'nt-f-' \+ a/);
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
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v66'/);
});

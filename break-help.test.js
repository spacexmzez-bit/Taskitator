import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './worker.js'; // loads the Worker first, as break-systems.test.js does (avoids a circular-import error)
const { BREAKS } = await import('./break-systems.js');

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const section = name => {
    const m = html.match(new RegExp('<div class="break-help-body" data-help-for="' + name + '"[^>]*>([\\s\\S]*?)\\n        </div>\\n    </div>\\n</div>'));
    assert.ok(m, 'help body for ' + name);
    return m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
};

test('both break systems have a ? button that opens a help dialog', () => {
    for (const name of ['scheduled', 'flexible']) {
        assert.match(html, new RegExp('data-break-help="' + name + '"'));
        assert.match(html, new RegExp('data-help-for="' + name + '"'));
    }
    assert.match(html, /id="breakHelpModal"/);
    assert.match(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), /bindHelp\(\)/);
});

test('help text states the real limits from break-systems.js', () => {
    const sched = section('scheduled'), flex = section('flexible');
    assert.match(sched, new RegExp(`Maximum ${BREAKS.reservedMax} per day`));
    assert.match(sched, new RegExp(`at least ${BREAKS.reservedMin} minutes, in ${BREAKS.reservedStep}-minute steps`));
    assert.match(sched, new RegExp(`at least ${BREAKS.reservedWindowMin} minutes wide`));
    assert.match(sched, new RegExp(`The ${BREAKS.window / 60000} minutes start`));
    assert.match(sched, new RegExp(`${BREAKS.closing / 3600000} hours before the day resets`));
    assert.match(sched, /Up to 3 breaks|up to 3 breaks/i);
    for (const p of BREAKS.presets) assert.match(flex, new RegExp(String(p)));
    assert.match(flex, new RegExp(`first ${BREAKS.flexMinimum} minutes`));
    assert.match(flex, new RegExp(`at least ${BREAKS.flexMinimum} minutes of allowance`));
    assert.match(flex, /Reserved breaks belong to the Scheduled system/);
});

test('Copilot uses the alligator mascot', () => {
    const icons = fs.readFileSync(new URL('./icons.js', import.meta.url), 'utf8');
    assert.match(icons, /'copilot': 'nt-brand-mascot'/);
    assert.match(icons, /'robot': 'nt-brand-mascot'/);
    assert.match(fs.readFileSync(new URL('./image/nature_sprites/sprite.svg', import.meta.url), 'utf8'), /<symbol id="nt-brand-mascot"/);
});

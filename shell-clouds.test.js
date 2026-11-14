import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 3.3: the cloud transition also runs when switching views inside the single-page shell.
const source = fs.readFileSync(new URL('./nature.js', import.meta.url), 'utf8');
const a = source.indexOf('    let switching = false;'), b = source.indexOf('    function interceptLinks()');
assert.ok(a > 0 && b > a);
function run({ allowed = true, current = 'tasks', key = 'today' } = {}) {
    const log = [], location = { hash: '' };
    const shell = { routeOf: k => k.startsWith('help-') ? { view: 'help' } : (['today', 'general'].includes(k) ? { view: 'tasks' } : { view: k }), current: () => current, key: () => key };
    const ctx = { window: { TaskitatorShell: shell }, location, allowed: () => allowed, cloudsIn: async () => { log.push('in'); }, cloudsOut: () => log.push('out'),
        wait: () => Promise.resolve(), setTimeout: fn => 0, decodeURIComponent };
    ctx.setTimeout = () => 0;
    vm.runInNewContext(source.slice(a, b) + '\nthis.shellSwitch = shellSwitch;', ctx);
    return { go: (hash) => { const r = ctx.shellSwitch({}, { hash }); return r; }, log, location, ctx };
}
const settle = () => new Promise(r => setTimeout(r, 10));

test('switching to another view closes the clouds, changes the hash, then opens them', async () => {
    const t = run();
    assert.equal(t.go('#projects'), true);
    await settle();
    assert.deepEqual(t.log, ['in', 'out']);
    assert.equal(t.location.hash, '#projects');
});

test('Today and General count as different pages; anchors inside one view stay instant', async () => {
    assert.equal(run({ key: 'today' }).go('#general'), true);
    assert.equal(run({ key: 'general' }).go('#today'), true);
    assert.equal(run({ key: 'today' }).go('#today'), false);
    assert.equal(run({ current: 'help' }).go('#help-sleep'), false);
    assert.equal(run({ current: 'projects' }).go('#projects'), false);
});

test('the Clouds setting and Reduce motion turn it off (links then work as plain hash links)', async () => {
    const t = run({ allowed: false });
    assert.equal(t.go('#projects'), false);
    assert.deepEqual(t.log, []);
    assert.equal(run().go(''), false);
});

test('a second tap during a transition is ignored, and the interceptor and shell are wired', async () => {
    const t = run();
    assert.equal(t.go('#stats'), true);
    assert.equal(t.go('#trash'), false);
    await settle();
    assert.equal(t.location.hash, '#stats');
    assert.match(source, /if \(shellSwitch\(a, url\)\) e\.preventDefault\(\);/);
    const router = fs.readFileSync(new URL('./shell-router.js', import.meta.url), 'utf8');
    assert.match(router, /routeOf,\s*\n?\s*\}|routeOf\s*\}\);/);
    assert.match(router, /current: \(\) => current/);
    assert.match(router, /key: hashKey/);
    const settings = fs.readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
    assert.match(settings, /data-fx="clouds"/);
});

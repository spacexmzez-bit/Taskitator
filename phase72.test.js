// Phase 7.2: Collab. Behaviour on the real Universe rules is in uni/collab.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');

test('Worker runs the collab Pro gate before every Universe request', () => {
    const w = read('worker.js');
    assert.match(w, /const collabBlock=await this\.friends\.gate\(identity,path,method,ubody\);\s*if\(collabBlock\)return json\(\{error:collabBlock\.message,code:collabBlock\.code\},collabBlock\.status\);\s*return json\(await this\.universe\.handle\(identity,path,method,ubody\)\);/);
});

test('Friends view has Collabs; Universe page opens a group directly and badges collabs', () => {
    const ui = read('friends-ui.js');
    assert.match(ui, /act\('collab\/create', \{ title: name\.value\.trim\(\), ids \}/);
    assert.match(ui, /act\('collab\/accept', \{ id: c\.id \}/);
    assert.match(ui, /location\.href = 'components\.html\?view=universe&group=' \+ encodeURIComponent\(id\)/);
    const uni = read('uni/universe-ui.js');
    assert.match(uni, /gid=q\.get\('group'\);if\(q\.get\('view'\)==='universe'\)run\(gid&&\/\^\[A-Za-z0-9_-\]\{1,100\}\$\/\.test\(gid\)\?\(\)=>detail\(gid\):list\)/);
    assert.match(uni, /startsWith\('Collab ·'\)/);
    assert.match(read('friends-backend.js'), /purpose: 'Collab · a shared space for friends\.'/);
    assert.match(read('index.html'), /id="help-p-collab"/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v75'/);
    assert.match(read('README.md'), /\*\*Collab \(Phase 7\.0\):\*\*/);
    for (const k of ['Collabs', 'Start a collab', 'Create collab', 'Invited by @{0}']) assert.ok(read('locales/ar.js').includes('"' + k + '"'), k);
});

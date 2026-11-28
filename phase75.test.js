// Phase 7.5: lean Collab (collab-backend.js) and Friends challenges (friends-backend.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FriendsService } from './friends-backend.js';
import { CollabService, COLLAB_LIMITS } from './collab-backend.js';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const ctx = {}; vm.runInNewContext(read('points.js'), ctx); globalThis.TaskitatorPoints = ctx.TaskitatorPoints;
const plain = x => JSON.parse(JSON.stringify(x));
const DAY = 86400000;
const riyadh = t => new Date(t + 3 * 3600000).toISOString().slice(0, 10);
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

function fixture(people = ['ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus']) {
    const map = new Map(), pro = new Set(people), writes = { n: 0 };
    const clone = v => v === undefined ? undefined : structuredClone(v);
    const storage = {
        get: async k => clone(map.get(k)),
        put: async (k, v) => { writes.n++; map.set(k, clone(v)); },
        delete: async k => { if (Array.isArray(k)) { if (k.length > 128) throw new Error('too many keys'); k.forEach(x => map.delete(x)); } else map.delete(k); },
        list: async ({ prefix }) => new Map([...map.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, clone(v)])),
        transaction: async fn => fn(storage)
    };
    const service = { storage, universe: { entitlement: async ({ userId }) => pro.has(userId) }, deletion: { marker: async () => null } };
    const f = new FriendsService(service); service.friends = f;
    const c = new CollabService(service, f); service.collab = c;
    for (const id of people) {
        map.set('identity:' + id, { user: id });
        map.set('pro:user:username:' + id, { username: id, normalizedUsername: id });
        map.set('pro:username:map:' + id, { accountId: id, username: id });
    }
    const rec = fr => ({ v: 1, friends: Object.fromEntries(fr.map(x => [x, { since: 1 }])), out: {}, in: {}, blocked: {}, cheers: [], cheered: {}, privacy: 'anyone', sent: [] });
    // ana is friends with everyone except gus; ben–cy are friends too
    for (const id of people) map.set('friends:' + id, rec(id === 'ana' ? people.filter(x => x !== 'ana' && x !== 'gus') : id === 'gus' ? [] : id === 'ben' ? ['ana', 'cy'] : id === 'cy' ? ['ana', 'ben'] : ['ana']));
    const id = u => ({ userId: u });
    const cb = (who, action, body) => c.handle(id(who), '/collab/' + action, 'POST', body, {});
    const view = (who, cid, rev) => c.handle(id(who), '/collab/' + cid, 'GET', null, { rev });
    const fr = (who, action, body) => f.handle(id(who), '/friends/' + action, 'POST', body, {});
    const overview = who => f.handle(id(who), '/friends', 'GET', null, {});
    return { map, pro, f, c, cb, view, fr, overview, writes };
}
const err = (r, code) => { assert.ok(r && r.__error, 'expected an error, got ' + JSON.stringify(r)); assert.equal(r.__error.code, code); };
const ok = r => { assert.ok(r && !r.__error, JSON.stringify(r && r.__error)); return r; };

async function started(v, ids = ['ben', 'cy']) {
    const { id } = ok(await v.cb('ana', 'create', { title: 'Thesis', ids }));
    for (const u of ids) ok(await v.cb(u, 'accept', { id }));
    return id;
}

test('collab: friends only, Pro for everyone, invite shows on Friends, accept joins', async () => {
    const v = fixture();
    err(await v.cb('ana', 'create', { title: 'Thesis', ids: ['gus'] }), 'COLLAB_NOT_FRIENDS');
    err(await v.cb('ana', 'create', { title: '', ids: ['ben'] }), 'COLLAB_TEXT');
    err(await v.cb('ana', 'create', { title: 'X', ids: [] }), 'COLLAB_MEMBERS');
    err(await v.cb('ana', 'create', { title: 'X', ids: ['ben', 'cy', 'dee', 'eve', 'fay', 'gus'] }), 'COLLAB_MEMBERS');
    v.pro.delete('cy');
    const noPro = await v.cb('ana', 'create', { title: 'Thesis', ids: ['ben', 'cy'] });
    err(noPro, 'COLLAB_PRO'); assert.match(noPro.__error.message, /@cy/);
    v.pro.add('cy');
    const { id } = ok(await v.cb('ana', 'create', { title: 'Thesis', ids: ['ben', 'cy'] }));
    assert.match(id, /^cb[a-f0-9]{20}$/);
    const benView = ok(await v.overview('ben'));
    assert.equal(benView.collab_invites[0].title, 'Thesis'); assert.equal(benView.collab_invites[0].username, 'ana');
    err(await v.cb('dee', 'accept', { id }), 'COLLAB_GONE');
    v.pro.delete('ben');
    err(await v.cb('ben', 'accept', { id }), 'COLLAB_PRO');
    v.pro.add('ben');
    ok(await v.cb('ben', 'accept', { id }));
    const after = ok(await v.overview('ben'));
    assert.equal(after.collab_invites.length, 0);
    assert.equal(after.collabs[0].title, 'Thesis'); assert.equal(after.collabs[0].owner, false); assert.equal(after.collabs[0].owner_name, 'ana');
    ok(await v.cb('cy', 'decline', { id }));
    const full = ok(await v.view('ana', id));
    assert.deepEqual(plain(full.members.map(m => m.username)), ['ana', 'ben']);
    assert.equal(full.invited.length, 0);
    assert.equal(full.tasks.length, 1); assert.equal(full.tasks[0].id, 'root'); assert.equal(full.tasks[0].title, 'Thesis');
});

test('collab: only the owner edits tasks and people; edits are shared, not copied', async () => {
    const v = fixture(), id = await started(v);
    const { task: a } = ok(await v.cb('ana', 'add', { id, parent: 'root', title: 'Chapter 1', notes: 'Read sources', due: '2026-12-05' }));
    const { task: a1 } = ok(await v.cb('ana', 'add', { id, parent: a, title: 'Outline' }));
    err(await v.cb('ben', 'add', { id, parent: 'root', title: 'Mine' }), 'COLLAB_OWNER');
    err(await v.cb('ben', 'edit', { id, task: a, title: 'Hacked' }), 'COLLAB_OWNER');
    err(await v.cb('ben', 'assign', { id, task: a, assignees: ['ben'] }), 'COLLAB_OWNER');
    err(await v.cb('ben', 'invite', { id, ids: ['dee'] }), 'COLLAB_OWNER');
    err(await v.cb('ben', 'remove', { id, uid: 'cy' }), 'COLLAB_OWNER');
    ok(await v.cb('ana', 'edit', { id, task: a, title: 'Chapter One', due: null }));
    const seen = ok(await v.view('ben', id));
    const t = seen.tasks.find(x => x.id === a);
    assert.equal(t.title, 'Chapter One'); assert.equal(t.due, null); assert.equal(t.notes, 'Read sources');
    assert.equal(seen.tasks.find(x => x.id === a1).parent, a);
    ok(await v.cb('ana', 'edit', { id, task: 'root', title: 'Thesis 2' }));
    assert.equal(ok(await v.overview('cy')).collabs[0].title, 'Thesis 2', 'renaming the root renames the collab');
    err(await v.cb('ana', 'del', { id, task: 'root' }), 'COLLAB_ROOT');
    ok(await v.cb('ana', 'del', { id, task: a }));
    assert.equal(ok(await v.view('ana', id)).tasks.length, 1, 'deleting a task deletes its subtree');
});

test('collab: assignees complete their task and everything under it; several can share one', async () => {
    const v = fixture(), id = await started(v);
    const { task: a } = ok(await v.cb('ana', 'add', { id, title: 'Part A' }));
    const { task: a1 } = ok(await v.cb('ana', 'add', { id, parent: a, title: 'A.1' }));
    const { task: a2 } = ok(await v.cb('ana', 'add', { id, parent: a, title: 'A.2' }));
    const { task: b } = ok(await v.cb('ana', 'add', { id, title: 'Part B' }));
    err(await v.cb('ana', 'assign', { id, task: a, assignees: ['dee'] }), 'COLLAB_NOT_MEMBER');
    ok(await v.cb('ana', 'assign', { id, task: a, assignees: ['ben', 'cy'] }));
    err(await v.cb('ben', 'complete', { id, task: b }), 'COLLAB_NOT_ASSIGNED');
    ok(await v.cb('cy', 'complete', { id, task: a1 }));
    let s = ok(await v.view('ben', id));
    assert.ok(s.tasks.find(x => x.id === a1).done);
    assert.equal(s.tasks.find(x => x.id === a1).done.by, 'cy');
    ok(await v.cb('ben', 'complete', { id, task: a }));
    s = ok(await v.view('ben', id));
    for (const x of [a, a1, a2]) assert.ok(s.tasks.find(t => t.id === x).done, 'subtree completed: ' + x);
    assert.equal(s.tasks.find(t => t.id === a1).done.by, 'cy', 'already-finished tasks keep who finished them');
    ok(await v.cb('ben', 'complete', { id, task: a2, done: false }));
    s = ok(await v.view('ben', id));
    assert.equal(s.tasks.find(t => t.id === a2).done, null);
    assert.equal(s.tasks.find(t => t.id === a).done, null, 'reopening reopens the finished task above it');
    ok(await v.cb('ana', 'complete', { id, task: b }), 'the owner can complete anything');
    ok(await v.cb('ana', 'add', { id, parent: b, title: 'B.1' }));
    s = ok(await v.view('ana', id));
    assert.equal(s.tasks.find(t => t.id === b).done, null, 'adding under a finished task reopens it');
    const list = ok(await v.overview('ben')).collabs[0];
    assert.equal(list.total, 6); assert.equal(list.done, 1);
});

test('collab: Pro for every member on changes; comments, leaving and deleting stay open', async () => {
    const v = fixture(), id = await started(v);
    const { task } = ok(await v.cb('ana', 'add', { id, title: 'Draft' }));
    ok(await v.cb('ana', 'assign', { id, task, assignees: ['ben'] }));
    v.pro.delete('cy');
    const blocked = await v.cb('ben', 'complete', { id, task });
    err(blocked, 'COLLAB_PRO'); assert.match(blocked.__error.message, /@cy/);
    err(await v.cb('ana', 'add', { id, title: 'More' }), 'COLLAB_PRO');
    const s = ok(await v.view('ben', id));
    assert.equal(s.pro_ok, false); assert.deepEqual(plain(s.pro_missing), ['cy']);
    const { comment } = ok(await v.cb('ben', 'comment', { id, text: '  Notes   for later ' }));
    const c = ok(await v.view('ana', id)).comments[0];
    assert.equal(c.text, 'Notes for later'); assert.equal(c.username, 'ben'); assert.equal(typeof c.at, 'number'); assert.equal(c.mine, false);
    err(await v.cb('ana', 'uncomment', { id, comment }), 'COLLAB_OWNER');
    ok(await v.cb('ben', 'uncomment', { id, comment }));
    err(await v.cb('ben', 'comment', { id, text: 'x'.repeat(COLLAB_LIMITS.comment + 1) }), 'COLLAB_TEXT');
    ok(await v.cb('cy', 'leave', { id }));
    err(await v.cb('ana', 'leave', { id }), 'COLLAB_OWNER');
    ok(await v.cb('ben', 'complete', { id, task }), 'with cy gone everyone left is on Pro');
    ok(await v.cb('ana', 'remove', { id, uid: 'ben' }));
    assert.deepEqual(plain(ok(await v.view('ana', id)).tasks.find(t => t.id === task).assignees), [], 'a removed person is unassigned');
    err(await v.view('ben', id), 'COLLAB_GONE');
    assert.equal(ok(await v.overview('ben')).collabs.length, 0);
    ok(await v.cb('ana', 'delete', { id }));
    assert.equal([...v.map.keys()].filter(k => k.startsWith('cb')).length, 0, 'deleting wipes every record');
});

test('collab: cheap polling, limits and comment cap', async () => {
    const v = fixture(), id = await started(v, ['ben']);
    const s = ok(await v.view('ben', id));
    assert.deepEqual(plain(ok(await v.view('ben', id, String(s.rev)))), { unchanged: true, rev: s.rev });
    ok(await v.cb('ana', 'add', { id, title: 'New' }));
    assert.equal(ok(await v.view('ben', id, String(s.rev))).tasks.length, 2);
    // depth
    let parent = 'root';
    for (let i = 1; i < COLLAB_LIMITS.depth; i++) parent = ok(await v.cb('ana', 'add', { id, parent, title: 'L' + i })).task;
    err(await v.cb('ana', 'add', { id, parent, title: 'too deep' }), 'COLLAB_DEPTH');
    // invites: 6 people max
    ok(await v.cb('ana', 'invite', { id, ids: ['cy', 'dee', 'eve', 'fay'] }));
    err(await v.cb('ana', 'invite', { id, ids: ['gus'] }), 'COLLAB_FULL');
    // comments keep the newest 200; deletes stay under the 128-key storage limit
    for (let i = 0; i < COLLAB_LIMITS.comments + 5; i++) v.map.set('cbm:' + id + ':' + String(1e12 + i).padStart(13, '0') + '-0000000' + (i % 10), { id: String(1e12 + i).padStart(13, '0') + '-0000000' + (i % 10), by: 'ben', at: 1e12 + i, text: 'c' + i });
    ok(await v.cb('ben', 'comment', { id, text: 'latest' }));
    const after = ok(await v.view('ana', id));
    assert.equal(after.comments.length, COLLAB_LIMITS.comments);
    assert.equal(after.comments.at(-1).text, 'latest');
    for (let i = 0; i < 140; i++) await v.map.set('cbt:' + id + ':t' + String(i).padStart(12, '0'), { id: 't' + String(i).padStart(12, '0'), parent: 'root', title: 'x', notes: '', due: null, assignees: [], done: null, at: 1, ord: i });
    ok(await v.cb('ana', 'delete', { id }));
    assert.equal([...v.map.keys()].filter(k => k.includes(id)).length, 0);
});

test('collab: account deletion of the owner removes the collab on next read', async () => {
    const v = fixture(), id = await started(v, ['ben']);
    v.map.delete('identity:ana');
    err(await v.view('ben', id), 'COLLAB_GONE');
    assert.equal(ok(await v.overview('ben')).collabs.length, 0);
    assert.equal(v.map.has('cb:' + id), false);
});

// Challenges: the 7.5 one-to-one tests were replaced by phase76.test.js (groups, Time/Amount, anti-cheat log).

test('wiring: Worker routes, old Universe collab gone, lazy collab view', () => {
    const w = read('worker.js');
    assert.match(w, /import \{ CollabService \} from '\.\/collab-backend\.js';/);
    assert.match(w, /this\.collab = new CollabService\(this, this\.friends\);/);
    assert.match(w, /const collabRoute = path\.startsWith\('\/collab\/'\);/);
    assert.match(w, /this\.collab\.handle\(identity, path, method, method === 'POST' \? await readJson\(request, 8192\) : null,\s*\{ rev: url\.searchParams\.get\('rev'\) \?\? undefined \}\)/);
    assert.doesNotMatch(w, /friends\.gate\(/);
    const fb = read('friends-backend.js');
    assert.doesNotMatch(fb, /universe\/groups|U\.handle|async gate\(/);
    assert.match(fb, /delete r\.collab_in; delete r\.collabs;/);
    assert.doesNotMatch(read('uni/universe-ui.js'), /uni-collab-badge/);
    const router = read('shell-router.js');
    assert.match(router, /collab: \{ title: '', doc: 'Collab — Taskitator' \}/);
    assert.match(router, /if \(key\.startsWith\('collab-'\)\) return \{ view: 'collab', id: key\.slice\(7\) \};/);
    const index = read('index.html');
    assert.match(index, /<section id="shellView-collab" class="shell-view" data-shell-view="collab" hidden><div class="cb-wrap" id="collabRoot"><\/div><\/section>/);
    assert.doesNotMatch(index, /src="collab-ui\.js/, 'collab-ui.js is loaded only when a collab is opened');
    assert.match(read('friends-ui.js'), /location\.hash = '#collab-' \+ id/);
    assert.match(read('sw.js'), /'\.\/collab-ui\.js'/);
    assert.match(read('sw.js'), /taskitator-phase4-v82/);
    const ar = read('locales/ar.js');
    for (const k of ['Challenges', 'Send challenge', 'Forfeit', 'Delete collab', 'Leave collab', '{0} started this collab. You can complete what you’re assigned and comment.', '{0} of {1} done']) assert.ok(ar.includes('"' + k + '"'), k);
    // Keys never start with "@{0}": translateText buckets patterns by their first word, and "@" never equals "@name".
    assert.doesNotMatch(read('collab-ui.js') + read('friends-ui.js'), /tf\('@\{0\}/);
    assert.match(read('copilot-knowledge.js'), /Challenges \(Pro to send, free to join\): friend row → Challenge/);
});

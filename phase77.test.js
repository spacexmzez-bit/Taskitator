// Phase 7.7: locked collab assignments (collab-locks.js): consent, the linked copy in the assignee's own list,
// release, sync guard, completion both ways, phone-lock counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FriendsService } from './friends-backend.js';
import { CollabService } from './collab-backend.js';
import { CollabLocks, mirrorId } from './collab-locks.js';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const ctx = {}; vm.runInNewContext(read('points.js'), ctx); globalThis.TaskitatorPoints = ctx.TaskitatorPoints;
const sc = {}; vm.runInNewContext(read('pro/status-count.js'), sc); const SC = sc.TaskitatorStatusCount;
const plain = x => JSON.parse(JSON.stringify(x));

function fixture(people = ['ana', 'ben', 'cy', 'dee']) {
    const map = new Map(), pro = new Set(people), bypass = new Set();
    const clone = v => v === undefined ? undefined : structuredClone(v);
    const storage = {
        get: async k => clone(map.get(k)), put: async (k, v) => { map.set(k, clone(v)); },
        delete: async k => { (Array.isArray(k) ? k : [k]).forEach(x => map.delete(x)); },
        list: async ({ prefix }) => new Map([...map.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, clone(v)])),
        transaction: async fn => fn(storage)
    };
    const service = { storage, universe: { entitlement: async ({ userId }) => pro.has(userId) }, deletion: { marker: async () => null },
        protection: { bypass: async (tx, uid) => bypass.has(uid) },
        readTaskSnapshot: async (store, uid) => { if (!map.has('identity:' + uid)) throw new Error('gone'); return { snapshot: await store.get('snap:' + uid) || null }; },
        writeTaskSnapshot: async (tx, uid, snap, opts = {}) => { if (!opts.skipCollab) await service.collab.locks.reconcile(tx, uid, snap); await tx.put('snap:' + uid, snap); service.writes.push(uid); },
        writes: [] };
    const f = new FriendsService(service); service.friends = f;
    const c = new CollabService(service, f); service.collab = c;
    for (const id of people) {
        map.set('identity:' + id, { user: id });
        map.set('pro:user:username:' + id, { username: id, normalizedUsername: id });
        map.set('pro:username:map:' + id, { accountId: id, username: id });
        map.set('friends:' + id, { v: 1, friends: Object.fromEntries(people.filter(x => x !== id).map(x => [x, { since: 1 }])), out: {}, in: {}, blocked: {}, cheers: [], cheered: {}, privacy: 'anyone', sent: [] });
        map.set('snap:' + id, { tasks: [{ id: 'own', title: 'Mine', status: 'active', due_date: 'today' }], settings: {} });
    }
    const cb = (who, action, body) => c.handle({ userId: who }, '/collab/' + action, 'POST', body, {});
    const view = (who, cid) => c.handle({ userId: who }, '/collab/' + cid, 'GET', null, {});
    const snap = uid => map.get('snap:' + uid);
    // A push like worker.js: guards, then reconcile, then save.
    async function push(uid, change) {
        const previous = structuredClone(snap(uid)), next = structuredClone(previous);
        change(next);
        try { await c.locks.guardPush(storage, uid, previous, next); }
        catch (e) { return { error: e.code, rejected: e.rejected }; }
        await c.locks.reconcile(storage, uid, next, { previous, bypass: bypass.has(uid) });
        map.set('snap:' + uid, next);
        return { ok: true };
    }
    return { map, pro, bypass, c, cb, view, snap, push, service, storage };
}
const err = (r, code) => { assert.ok(r && r.__error, 'expected an error, got ' + JSON.stringify(r)); assert.equal(r.__error.code, code, r.__error.message); };
const ok = r => { assert.ok(r && !r.__error, JSON.stringify(r && r.__error)); return r; };
async function setup(v, locks = { phone: true }, due = '2026-12-02') {
    const { id } = ok(await v.cb('ana', 'create', { title: 'Report', ids: ['ben', 'cy'] }));
    for (const u of ['ben', 'cy']) ok(await v.cb(u, 'accept', { id }));
    const { task } = ok(await v.cb('ana', 'add', { id, title: 'Draft', due, locks }));
    ok(await v.cb('ana', 'assign', { id, task, assignees: ['ben', 'cy'] }));
    return { id, task, mid: mirrorId(id, task) };
}

test('locks: owner only, AI needs criteria, phone needs a date; assignees start pending', async () => {
    const v = fixture();
    const { id } = ok(await v.cb('ana', 'create', { title: 'Report', ids: ['ben'] }));
    ok(await v.cb('ben', 'accept', { id }));
    err(await v.cb('ana', 'add', { id, title: 'X', locks: { ai: true } }), 'COLLAB_LOCKS');
    err(await v.cb('ana', 'add', { id, title: 'X', locks: { phone: true } }), 'COLLAB_LOCKS');
    const { task } = ok(await v.cb('ana', 'add', { id, title: 'X', locks: { ai: true, criteria: 'A photo of the printed draft', shield: true } }));
    err(await v.cb('ben', 'edit', { id, task, locks: null }), 'COLLAB_OWNER');
    ok(await v.cb('ana', 'assign', { id, task, assignees: ['ben'] }));
    const t = ok(await v.view('ana', id)).tasks.find(x => x.id === task);
    assert.deepEqual(plain(t.locks), { ai: true, shield: true, phone: false, criteria: 'A photo of the printed draft' });
    assert.equal(t.consent.ben.s, 'pending');
    assert.equal((await v.c.listFor('ben', Date.now())).collabs[0].needs_ok, 1, 'Friends list: needs your OK');
});

test('consent: pending can’t complete; refusing is free; accepting adds the linked copy to their list', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v, { phone: true, shield: false });
    err(await v.cb('ben', 'complete', { id, task }), 'COLLAB_NOT_ASSIGNED');
    v.pro.delete('cy');
    ok(await v.cb('cy', 'refuse', { id, task })); // no Pro needed to say no
    v.pro.add('cy');
    v.map.delete('snap:ben');
    err(await v.cb('ben', 'consent', { id, task }), 'COLLAB_SYNC');
    v.map.set('snap:ben', { tasks: [], settings: { status_mode: 'limited' } });
    ok(await v.cb('ben', 'consent', { id, task }));
    const copy = v.snap('ben').tasks.find(x => x.id === mid);
    assert.equal(copy.title, 'Draft'); assert.equal(copy.due_date, '2026-12-02'); assert.equal(copy.status, 'active');
    assert.deepEqual(plain(copy.collab_link), { cid: id, tid: task, phone: true, shield: false, collab: 'Report' });
    assert.equal(copy.ai_locked, false); assert.match(copy.description, /From the collab “Report” by @ana\./);
    // limited mode counts only AI-locked tasks, but an agreed phone lock always counts
    assert.equal(SC.unfinished(v.snap('ben').tasks, v.snap('ben').settings, '2026-12-02'), true);
    assert.equal(SC.unfinished(v.snap('ben').tasks, v.snap('ben').settings, '2026-12-01'), false, 'not before its date');
    const t = ok(await v.view('ana', id)).tasks.find(x => x.id === task);
    assert.equal(t.consent.ben.s, 'yes'); assert.equal(t.consent.cy.s, 'no');
    err(await v.cb('ben', 'refuse', { id, task }), 'COLLAB_LOCKED');
});

test('after accepting: no leaving, no removing the copy; release request → deny / approve; owner releases anyone', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v);
    ok(await v.cb('ben', 'consent', { id, task })); ok(await v.cb('cy', 'consent', { id, task }));
    err(await v.cb('ben', 'leave', { id }), 'COLLAB_LOCKED');
    let r = await v.push('ben', s => { s.tasks = s.tasks.filter(x => x.id !== mid); });
    assert.equal(r.error, 'COLLAB_LOCKED'); assert.equal(r.rejected[0].id, mid);
    r = await v.push('ben', s => { s.tasks.find(x => x.id === mid).due_date = '2026-12-09'; });
    assert.equal(r.error, 'COLLAB_LOCKED');
    r = await v.push('ben', s => { s.tasks.find(x => x.id === mid).description = 'my note'; });
    assert.ok(r.ok, 'notes are free');
    r = await v.push('ben', s => { s.tasks.push({ id: 'fake', title: 'x', status: 'active', collab_link: { cid: id, tid: task } }); });
    assert.equal(r.error, 'COLLAB_LINK');
    ok(await v.cb('ben', 'release_request', { id, task }));
    assert.equal((await v.c.listFor('ana', Date.now())).collabs[0].needs_ok, 1, 'the owner sees the request');
    ok(await v.cb('ana', 'release', { id, task, uid: 'ben', approve: false }));
    assert.equal(ok(await v.view('ana', id)).tasks.find(x => x.id === task).consent.ben.req, undefined);
    ok(await v.cb('ben', 'release_request', { id, task }));
    ok(await v.cb('ana', 'release', { id, task, uid: 'ben' }));
    assert.equal(v.snap('ben').tasks.some(x => x.id === mid), false, 'copy removed from ben’s list');
    const t = ok(await v.view('ana', id)).tasks.find(x => x.id === task);
    assert.deepEqual(plain(t.assignees), ['cy']); assert.equal(t.consent.ben, undefined);
    ok(await v.cb('ben', 'leave', { id }));
    // removing a member releases them
    ok(await v.cb('ana', 'remove', { id, uid: 'cy' }));
    assert.equal(v.snap('cy').tasks.some(x => x.id === mid), false);
});

test('Emergency Bypass: the copy can go, and the owner sees it', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v);
    ok(await v.cb('ben', 'consent', { id, task }));
    v.bypass.add('ben');
    assert.ok((await v.push('ben', s => { s.tasks = s.tasks.filter(x => x.id !== mid); })).ok);
    const c = ok(await v.view('ana', id)).tasks.find(x => x.id === task).consent.ben;
    assert.equal(c.s, 'no'); assert.ok(c.bypass);
});

test('completing the copy completes the collab task and closes the others’ copies; shield needs the subtasks first', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v, { phone: true, shield: true });
    const { task: sub } = ok(await v.cb('ana', 'add', { id, parent: task, title: 'Outline' }));
    ok(await v.cb('ben', 'consent', { id, task })); ok(await v.cb('cy', 'consent', { id, task }));
    let r = await v.push('ben', s => { const x = s.tasks.find(y => y.id === mid); x.status = 'completed'; x.completed_at = new Date().toISOString(); });
    assert.equal(r.error, 'CHILDREN_REQUIRED');
    err(await v.cb('ana', 'complete', { id, task }), 'COLLAB_SHIELD');
    ok(await v.cb('ana', 'assign', { id, task: sub, assignees: ['ben'] }));
    ok(await v.cb('ben', 'complete', { id, task: sub }));
    r = await v.push('ben', s => { const x = s.tasks.find(y => y.id === mid); x.status = 'completed'; x.completed_at = new Date().toISOString(); });
    assert.ok(r.ok);
    const t = ok(await v.view('ana', id)).tasks.find(x => x.id === task);
    assert.equal(t.done.by, 'ben');
    assert.equal(v.snap('cy').tasks.find(x => x.id === mid).status, 'completed', 'cy is freed too');
    err(await v.cb('ana', 'complete', { id, task, done: false }), 'COLLAB_LOCKED');
});

test('AI check: never from the collab page; an approved proof on the copy completes it', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v, { ai: true, criteria: 'Photo of the signed form' }, null);
    ok(await v.cb('ben', 'consent', { id, task })); ok(await v.cb('cy', 'consent', { id, task }));
    const copy = v.snap('ben').tasks.find(x => x.id === mid);
    assert.equal(copy.ai_locked, true); assert.equal(copy.proof_criteria, 'Photo of the signed form'); assert.equal(copy.due_date, null, 'no phone lock → no date');
    assert.equal(copy.original_proof_criteria, 'Photo of the signed form');
    err(await v.cb('ana', 'complete', { id, task }), 'COLLAB_AI_LOCKED');
    err(await v.cb('ana', 'complete', { id, task: 'root' }), 'COLLAB_AI_LOCKED');
    // proof approved (pro-backend confirm writes the snapshot through writeTaskSnapshot)
    const s = v.snap('ben'); const x = s.tasks.find(y => y.id === mid); x.status = 'completed'; x.completed_at = new Date().toISOString(); x.verified_model = 'm';
    await v.service.writeTaskSnapshot(v.storage, 'ben', s);
    const t = ok(await v.view('ana', id)).tasks.find(y => y.id === task);
    assert.equal(t.done.by, 'ben'); assert.equal(t.done.via, 'proof');
    assert.equal(v.snap('cy').tasks.find(y => y.id === mid).status, 'completed');
});

test('owner completes a phone-locked task → copies close; lock change asks again; delete removes open copies', async () => {
    const v = fixture();
    const { id, task, mid } = await setup(v);
    ok(await v.cb('ben', 'consent', { id, task }));
    ok(await v.cb('ana', 'edit', { id, task, locks: { phone: true, shield: true } }));
    let t = ok(await v.view('ana', id)).tasks.find(x => x.id === task);
    assert.equal(t.consent.ben.s, 'pending'); assert.equal(v.snap('ben').tasks.some(x => x.id === mid), false, 'new terms: copy removed until accepted again');
    ok(await v.cb('ben', 'consent', { id, task }));
    ok(await v.cb('ana', 'edit', { id, task, title: 'Final draft' }));
    assert.equal(v.snap('ben').tasks.find(x => x.id === mid).title, 'Final draft', 'title follows the owner');
    err(await v.cb('ana', 'edit', { id, task, due: null }), 'COLLAB_LOCKS');
    ok(await v.cb('ana', 'complete', { id, task }));
    assert.equal(v.snap('ben').tasks.find(x => x.id === mid).status, 'completed');
    // delete: open copies go, finished ones stay as history
    const { task: t2 } = ok(await v.cb('ana', 'add', { id, title: 'Slides', due: '2026-12-03', locks: { phone: true } }));
    ok(await v.cb('ana', 'assign', { id, task: t2, assignees: ['cy'] })); ok(await v.cb('cy', 'consent', { id, task: t2 }));
    ok(await v.cb('ana', 'delete', { id }));
    assert.equal(v.snap('cy').tasks.some(x => x.id === mirrorId(id, t2)), false);
    assert.equal(v.snap('ben').tasks.find(x => x.id === mid).status, 'completed');
    // removing locks frees everyone
    const v2 = fixture(); const s2 = await setup(v2);
    ok(await v2.cb('ben', 'consent', { id: s2.id, task: s2.task }));
    ok(await v2.cb('ana', 'edit', { id: s2.id, task: s2.task, locks: null }));
    t = ok(await v2.view('ana', s2.id)).tasks.find(x => x.id === s2.task);
    assert.equal(t.locks, null); assert.deepEqual(plain(t.consent), {}); assert.equal(v2.snap('ben').tasks.some(x => x.id === s2.mid), false);
});

test('wiring: Worker guard + reconcile in sync, writeTaskSnapshot hook, status-count, UI', () => {
    const w = read('worker.js');
    assert.match(w, /await this\.collab\.locks\.guardPush\(tx,identity\.userId,previous,snapshot\);/);
    assert.match(w, /await this\.collab\.locks\.reconcile\(tx,identity\.userId,snapshot,\{previous,bypass:await this\.protection\.bypass\(tx,identity\.userId\)\}\);/);
    assert.ok(w.indexOf('this.collab.locks.reconcile(tx,identity.userId') < w.indexOf('await saveSnapshot(tx, user, meta, snapshot);'));
    assert.match(w, /async writeTaskSnapshot\(tx,accountId,snapshot,opts=\{\}\) \{\s*const \{link,meta\}=await liveAccount\(tx,accountId\);\s*if\(!opts\.skipCollab\)await this\.collab\.locks\.reconcile\(tx,accountId,snapshot\);/);
    assert.match(read('pro/status-count.js'), /const forced=t=>Boolean\(t&&\(t\.ai_locked\|\|t\.collab_link\?\.phone===true\)\);/);
    const ui = read('collab-ui.js');
    for (const k of ["post('consent'", "post('refuse'", "post('release_request'", "post('release'"]) assert.ok(ui.includes(k), k);
    assert.match(read('app.js'), /task\.collab_link/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v82'/);
});

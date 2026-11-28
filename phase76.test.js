// Phase 7.6: group challenges (Time / Amount, prize, colors, anti-cheat log), finished collabs (archive) and the Today race bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FriendsService } from './friends-backend.js';
import { CollabService } from './collab-backend.js';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const ctx = {}; vm.runInNewContext(read('points.js'), ctx); globalThis.TaskitatorPoints = ctx.TaskitatorPoints;
const P = ctx.TaskitatorPoints;
const plain = x => JSON.parse(JSON.stringify(x));
const DAY = 86400000, MIN = 60000;
const riyadh = t => new Date(t + 3 * 3600000).toISOString().slice(0, 10);
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const T0 = Date.parse('2026-12-01T09:00:00Z'); // Riyadh 12:00, Tuesday
let clock = T0;
const realNow = Date.now;
Date.now = () => clock;
test.after(() => { Date.now = realNow; });
const noon = d => Date.parse(d + 'T09:00:00Z');

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


const award = (day, p, extra = {}) => ({ id: 't' + Math.random().toString(16).slice(2), day, p, req: true, at: noon(day), created: noon(day) - 60 * MIN, ...extra });
async function log(v, uid, awards, now = clock) { await v.f.chRecord(v.f.storage, uid, awards, v.map.get('points:' + uid) || null, now); }
const mineList = async (v, who) => ok(await v.overview(who)).challenges;
async function group(v, body = {}, joiners = ['ben', 'cy']) {
    clock = T0;
    const { id } = ok(await v.fr('ana', 'challenge/create', { ids: ['ben', 'cy', 'dee'], metric: 'points', ...body }));
    for (const u of joiners) ok(await v.fr(u, 'challenge/accept', { id }));
    const r = ok(await v.fr('ana', 'challenge/start', { id }));
    return { id, ...r };
}

test('create: Pro, 1–5 friends, Time/Amount, reachable goals, prize text, color', async () => {
    clock = T0;
    const v = fixture();
    v.pro.delete('ana');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], metric: 'points' }), 'CHALLENGE_PRO');
    v.pro.add('ana');
    err(await v.fr('ana', 'challenge/create', { ids: [], metric: 'points' }), 'CHALLENGE_MEMBERS');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben', 'cy', 'dee', 'eve', 'fay', 'x1'], metric: 'points' }), 'CHALLENGE_MEMBERS');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben', 'gus'], metric: 'points' }), 'CHALLENGE_NOT_FRIENDS');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], type: 'relay', metric: 'points' }), 'CHALLENGE_TYPE');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], type: 'amount', metric: 'tasks', days: 2 }), 'CHALLENGE_TARGET');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], type: 'amount', metric: 'tasks', days: 2, target: 1 }), 'CHALLENGE_TARGET');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], type: 'amount', metric: 'tasks', days: 2, target: 31 }), 'CHALLENGE_TARGET', 'unreachable: 15 a day');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], type: 'amount', metric: 'streak', days: 1, target: 1 }), 'CHALLENGE_TARGET');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], metric: 'points', prize: 'x'.repeat(41) }), 'CHALLENGE_PRIZE');
    err(await v.fr('ana', 'challenge/create', { ids: ['ben'], metric: 'points', color: 8 }), 'CHALLENGE_COLOR');
    const { id, auto_start_at } = ok(await v.fr('ana', 'challenge/create', { ids: ['ben', 'cy'], type: 'amount', metric: 'tasks', days: 4, target: 4, prize: '  $300‮  dinner ', color: 3 }));
    assert.equal(auto_start_at, T0 + 48 * 3600000);
    const c = v.map.get('challenge:' + id);
    assert.equal(c.v, 2); assert.equal(c.prize, '$300 dinner', 'plain text, direction overrides dropped');
    assert.deepEqual(plain(Object.fromEntries(Object.entries(c.members).map(([u, m]) => [u, m.s]))), { ana: 'in', ben: 'invited', cy: 'invited' });
    const seen = (await mineList(v, 'ben'))[0];
    assert.equal(seen.state, 'invited'); assert.equal(seen.by, 'ana'); assert.equal(seen.prize, '$300 dinner'); assert.equal(seen.target, 4);
    assert.ok(!JSON.stringify(seen).includes('"ana":'), 'no account ids keyed in the view');
    // 7.5 one-to-one path (id instead of ids) still works
    ok(await v.fr('ana', 'challenge/create', { id: 'dee', metric: 'streak' }));
});

test('join, colors, start: next day, invited-but-silent dropped, nobody joins after the start', async () => {
    clock = T0;
    const v = fixture();
    const { id } = ok(await v.fr('ana', 'challenge/create', { ids: ['ben', 'cy', 'dee'], metric: 'points', color: 5 }));
    err(await v.fr('ana', 'challenge/start', { id }), 'CHALLENGE_STATE'); // nobody joined yet
    ok(await v.fr('ben', 'challenge/accept', { id, color: 5 })); // taken → first free
    ok(await v.fr('cy', 'challenge/accept', { id, color: 2 }));
    let c = v.map.get('challenge:' + id);
    assert.equal(c.members.ben.color, 0); assert.equal(c.members.cy.color, 2);
    err(await v.fr('ben', 'challenge/color', { id, color: 2 }), 'CHALLENGE_COLOR');
    ok(await v.fr('ben', 'challenge/color', { id, color: 7 }));
    err(await v.fr('ben', 'challenge/start', { id }), 'CHALLENGE_STATE', 'only the sender starts it');
    const r = ok(await v.fr('ana', 'challenge/start', { id }));
    assert.equal(r.start, shift(riyadh(T0), 1)); assert.equal(r.end, shift(riyadh(T0), 5));
    c = v.map.get('challenge:' + id);
    assert.deepEqual(Object.keys(c.members).sort(), ['ana', 'ben', 'cy']);
    assert.equal(v.map.get('friends:dee').challenges[id], undefined, 'silent invitee dropped');
    err(await v.fr('dee', 'challenge/accept', { id }), 'CHALLENGE_GONE');
    for (const u of ['ana', 'ben', 'cy']) assert.equal(v.map.get('chl:' + u)[id], r.end, 'running index for the sync log');
    err(await v.fr('ana', 'challenge/cancel', { id }), 'CHALLENGE_STATE', 'no cancelling once it started');
    err(await v.fr('ben', 'challenge/leave', { id }), 'CHALLENGE_STATE', 'leaving after the start = forfeit');
});

test('auto-start 48 h after sending if someone joined; expiry after 7 days if nobody did; limit 3', async () => {
    clock = T0;
    const v = fixture();
    const { id } = ok(await v.fr('ana', 'challenge/create', { ids: ['ben'], metric: 'tasks' }));
    const { id: lonely } = ok(await v.fr('ana', 'challenge/create', { ids: ['cy'], metric: 'tasks' }));
    ok(await v.fr('ben', 'challenge/accept', { id }));
    ok(await v.fr('ana', 'challenge/create', { ids: ['dee'], metric: 'tasks' }));
    err(await v.fr('ana', 'challenge/create', { ids: ['eve'], metric: 'tasks' }), 'CHALLENGE_ACTIVE_LIMIT');
    clock = T0 + 47 * 3600000;
    assert.equal((await mineList(v, 'ana')).find(c => c.id === id).status, 'pending');
    clock = T0 + 48 * 3600000 + MIN;
    const started = (await mineList(v, 'ana')).find(c => c.id === id);
    assert.equal(started.status, 'active'); assert.equal(started.start, shift(riyadh(clock), 1));
    clock = T0 + 7 * DAY + MIN;
    assert.equal((await mineList(v, 'ana')).some(c => c.id === lonely), false);
    assert.equal(v.map.has('challenge:' + lonely), false);
});

test('anti-cheat log: window, 5-minute age, 50 points / 15 tasks a day, only while running', async () => {
    const v = fixture();
    const { id, start } = await group(v, { metric: 'points' });
    clock = noon(start);
    await log(v, 'ana', [
        award(shift(start, -1), 40),                         // before the start
        award(start, 30), award(start, 30),                  // 60 → 50 a day
        award(start, 5, { created: noon(start) - 2 * MIN }), // too fresh
        award(shift(start, 1), 4, { created: NaN })          // older task without created_at counts
    ]);
    await log(v, 'ben', [award(start, 12)]);
    let c = v.map.get('challenge:' + id);
    assert.deepEqual(plain(c.prog.ana), { [start]: { p: 50, r: 2 }, [shift(start, 1)]: { p: 4, r: 1 } });
    // tasks cap
    const v2 = fixture();
    const g = await group(v2, { metric: 'tasks' });
    clock = noon(g.start);
    await log(v2, 'ana', Array.from({ length: 20 }, () => award(g.start, 1)));
    await log(v2, 'ana', [award(g.start, 1, { req: false })]);
    assert.equal(v2.map.get('challenge:' + g.id).prog.ana[g.start].r, 15);
    // no running challenge = one read and nothing written
    const w = v2.writes.n; await log(v2, 'eve', [award(g.start, 3)]); assert.equal(v2.writes.n, w);
    // standings come from the log, not the ledger
    clock = noon(shift(start, 1));
    v.map.set('points:ana', { v: 1, total: 9999, best: 0, days: { [start]: { p: 150, n: 50, r: 50, a: 0 } }, awarded: {}, free: [], modes: [], required: {}, hour: 0 });
    const me = (await mineList(v, 'ana')).find(x => x.id === id);
    assert.deepEqual(plain(me.members.map(m => [m.username, m.main])), [['ana', 54], ['ben', 12], ['cy', 0]]);
});

test('Amount: the first sync to reach the goal wins on the server clock; later syncs change nothing', async () => {
    const v = fixture();
    const { id, start } = await group(v, { type: 'amount', metric: 'tasks', days: 5, target: 4 });
    clock = noon(start);
    await log(v, 'ben', [award(start, 1), award(start, 1), award(start, 1)]);
    clock += 10 * MIN;
    await log(v, 'ana', [award(start, 1), award(start, 1), award(start, 1), award(start, 1)]); // reaches 4
    const reachedAt = clock;
    clock += MIN;
    await log(v, 'ben', [award(start, 1, { at: noon(start) - 30 * MIN })]); // claims an earlier time: ignored, ana already won
    assert.deepEqual(plain(v.map.get('challenge:' + id).reached), { ana: reachedAt });
    const list = await mineList(v, 'ben');
    const c = list.find(x => x.id === id);
    assert.equal(c.status, 'finished'); assert.equal(c.result.outcome, 'loss'); assert.equal(c.result.how, 'target');
    assert.deepEqual(plain(c.result.winners), ['ana']);
    assert.equal((await mineList(v, 'ana')).find(x => x.id === id).result.outcome, 'win');
    // Not reached by the end: highest score wins, marked.
    const v2 = fixture();
    const g = await group(v2, { type: 'amount', metric: 'points', days: 2, target: 90 });
    clock = noon(g.start);
    await log(v2, 'cy', [award(g.start, 20)]); await log(v2, 'ana', [award(g.start, 10)]);
    clock = noon(shift(g.end, 1));
    const done = (await mineList(v2, 'cy')).find(x => x.id === g.id);
    assert.equal(done.result.outcome, 'win'); assert.equal(done.result.target_missed, true); assert.equal(done.result.how, 'deadline');
});

test('Time: highest wins, ties share it, streak tie-break by finished days; result frozen', async () => {
    const v = fixture();
    const { id, start, end } = await group(v, { metric: 'points', days: 3 });
    clock = noon(start);
    await log(v, 'ana', [award(start, 10)]); await log(v, 'ben', [award(start, 10)]); await log(v, 'cy', [award(start, 3)]);
    clock = noon(shift(end, 1));
    const c = (await mineList(v, 'ana')).find(x => x.id === id);
    assert.equal(c.result.outcome, 'draw'); assert.deepEqual(plain(c.result.winners).sort(), ['ana', 'ben']);
    assert.equal((await mineList(v, 'cy')).find(x => x.id === id).result.outcome, 'loss');
    v.map.get('challenge:' + id); // frozen
    await log(v, 'cy', [award(end, 50)]);
    assert.equal((await mineList(v, 'cy')).find(x => x.id === id).result.outcome, 'loss');
    // streak scoring: free day skips, today-not-done doesn't break, ties by finished days
    const f = new FriendsService({ storage: {} });
    const st = { days: {}, free: [{ from: '2026-01-01', days: [5] }] }; // Fridays free
    const ch = { metric: 'streak', start: '2026-12-01', end: '2026-12-10', track_from: '2026-12-01',
        prog: { a: { '2026-12-01': { r: 1 }, '2026-12-02': { r: 1 }, '2026-12-03': { r: 2 }, '2026-12-05': { r: 1 }, '2026-12-07': { r: 1 } } } };
    assert.deepEqual(plain(f.chScore(ch, 'a', st, '2026-12-08')), { main: 4, second: 5 });
    const order = FriendsService.chOrder({ type: 'time', metric: 'streak', members: { a: { s: 'in' }, b: { s: 'in' }, c: { s: 'left' } } },
        { a: { main: 3, second: 4 }, b: { main: 3, second: 5 }, c: { main: 9, second: 9 } });
    assert.deepEqual(order, ['b', 'a', 'c']);
});

test('forfeit, leave, decline, block: blocker forfeits; last one standing wins', async () => {
    const v = fixture();
    const { id } = await group(v, { metric: 'points' }, ['ben']);
    ok(await v.fr('ben', 'challenge/forfeit', { id }));
    const a = (await mineList(v, 'ana')).find(x => x.id === id);
    assert.equal(a.result.outcome, 'win'); assert.equal(a.result.how, 'forfeit');
    assert.equal((await mineList(v, 'ben')).find(x => x.id === id).result.forfeit, true);
    assert.equal(v.map.get('chl:ben')?.[id], undefined, 'no more logging');
    // pending: leave / decline
    clock = T0;
    const { id: p } = ok(await v.fr('ana', 'challenge/create', { ids: ['cy', 'dee'], metric: 'tasks' }));
    ok(await v.fr('cy', 'challenge/accept', { id: p })); ok(await v.fr('cy', 'challenge/leave', { id: p })); ok(await v.fr('dee', 'challenge/decline', { id: p }));
    assert.deepEqual(Object.keys(v.map.get('challenge:' + p).members), ['ana']);
    // block during a race: the blocker forfeits, the race goes on for the others
    const v2 = fixture();
    const g = await group(v2, { metric: 'points' }, ['ben', 'cy']);
    clock = noon(g.start);
    await log(v2, 'ana', [award(g.start, 30)]);
    ok(await v2.fr('ben', 'block', { id: 'ana' }));
    const c = v2.map.get('challenge:' + g.id);
    assert.equal(c.status, 'active'); assert.equal(c.members.ben.s, 'left'); assert.equal(c.members.ana.s, 'in');
    // blocking a waiting one you sent cancels it
    const { id: w } = ok(await v2.fr('dee', 'challenge/create', { ids: ['ana'], metric: 'points' }));
    ok(await v2.fr('dee', 'block', { id: 'ana' }));
    assert.equal(v2.map.has('challenge:' + w), false);
    assert.equal(v2.map.get('friends:ana').challenges[w], undefined);
});

test('a 7.5 record keeps its ledger scoring and reads as a two-person Time challenge', async () => {
    clock = T0;
    const v = fixture();
    const start = shift(riyadh(T0), -1);
    v.map.set('challenge:ch_' + 'a'.repeat(24), { id: 'ch_' + 'a'.repeat(24), from: 'ana', to: 'ben', metric: 'points', days: 3, status: 'active', at: T0 - 2 * DAY, accepted_at: T0 - 2 * DAY, start, end: shift(start, 2) });
    for (const u of ['ana', 'ben']) v.map.get('friends:' + u).challenges = { ['ch_' + 'a'.repeat(24)]: T0 };
    v.map.set('points:ben', { v: 1, total: 0, best: 0, days: { [start]: { p: 7, n: 1, r: 1, a: 0 } }, awarded: {}, free: [], modes: [], required: {}, hour: 0 });
    const c = (await mineList(v, 'ana'))[0];
    assert.equal(c.type, 'time'); assert.equal(c.legacy, true); assert.equal(c.status, 'active');
    assert.deepEqual(plain(c.members.map(m => [m.username, m.main])), [['ben', 7], ['ana', 0]]);
});

test('live endpoint: joined running/waiting ones and the last day’s results; cache cleared by the log', async () => {
    const v = fixture();
    const { id, start } = await group(v, { metric: 'points' });
    clock = noon(start);
    const live = () => v.f.handle({ userId: 'ben' }, '/friends/challenges/live', 'GET', null, {});
    let r = ok(await live());
    assert.equal(r.challenges.length, 1); assert.equal(r.challenges[0].members.find(m => m.me).username, 'ben');
    await log(v, 'ben', [award(start, 9)]);
    r = ok(await live());
    assert.equal(r.challenges[0].members[0].username, 'ben', 'cache cleared: ben now leads'); assert.equal(r.challenges[0].members[0].main, 9);
    clock = T0; const { id: inv } = ok(await v.fr('cy', 'challenge/create', { ids: ['ben'], metric: 'tasks' }));
    clock = noon(start);
    assert.equal(ok(await live()).challenges.some(c => c.id === inv), false, 'an invitation you haven’t joined isn’t on the bar');
    ok(await v.fr('cy', 'challenge/forfeit', { id }));
    ok(await v.fr('ana', 'challenge/forfeit', { id }));
    r = ok(await live());
    assert.equal(r.challenges.find(c => c.id === id).status, 'finished');
    clock += DAY + MIN;
    assert.equal(ok(await live()).challenges.some(c => c.id === id), false, 'gone from the bar after 24 h');
});

test('points.js reports what it awarded (for the challenge log)', () => {
    const now = Date.parse('2026-12-02T09:00:00Z');
    const snap = (status, extra = {}) => ({ settings: {}, tasks: [{ id: 'a', status, completed_at: status === 'completed' ? '2026-12-02T08:00:00Z' : null, created_at: '2026-12-02T07:00:00.000Z', priority_id: 'prio_high', ...extra }] });
    const r = P.record(null, snap('active'), snap('completed'), now);
    assert.equal(r.awards.length, 1);
    assert.deepEqual(plain(r.awards[0]), { id: 'a', day: '2026-12-02', p: 5, req: true, at: Date.parse('2026-12-02T08:00:00Z'), created: Date.parse('2026-12-02T07:00:00Z') });
    assert.equal(P.record(r.state, snap('active'), snap('completed'), now).awards.length, 0, 'once per task');
    const w = read('worker.js');
    assert.match(w, /await this\.friends\.chRecord\(tx,identity\.userId,awarded\.awards,awarded\.state,Date\.now\(\)\);/);
    assert.ok(w.indexOf('this.friends.chRecord(') < w.indexOf('await saveSnapshot(tx, user, meta, snapshot);'));
    assert.match(w, /path === '\/friends\/challenges\/live'\) await this\.rateLimit\(request, 'friends-live:' \+ identity\.userId, 20\)/);
});

// ---------------------------------------------------------------- collab: finish, archive, viewer
async function collab(v, ids = ['ben', 'cy']) {
    clock = T0;
    const { id } = ok(await v.cb('ana', 'create', { title: 'Thesis', ids }));
    for (const u of ids) ok(await v.cb(u, 'accept', { id }));
    return id;
}
test('collab: completing the main task finishes it for everyone; read-only; deleted 7 days later', async () => {
    const v = fixture();
    const id = await collab(v, ['ben', 'cy', 'dee'].slice(0, 2));
    ok(await v.cb('ana', 'invite', { id, ids: ['dee'] }));
    const { task } = ok(await v.cb('ana', 'add', { id, title: 'Chapter 1' }));
    ok(await v.cb('ana', 'assign', { id, task: 'root', assignees: ['ben'] }));
    ok(await v.cb('cy', 'comment', { id, text: 'Good luck' }));
    err(await v.cb('cy', 'complete', { id, task: 'root' }), 'COLLAB_NOT_ASSIGNED');
    ok(await v.cb('ben', 'complete', { id, task: 'root' }));
    const fin = ok(await v.view('cy', id));
    assert.equal(fin.finished.username, 'ben'); assert.equal(fin.purge_at, T0 + 7 * DAY); assert.equal(fin.can_edit, false);
    assert.ok(fin.tasks.every(t => t.done), 'everything under it is done');
    assert.equal(fin.invited.length, 0, 'waiting invitations dropped');
    assert.equal(v.map.get('friends:dee').cb_in[id], undefined);
    for (const [who, action, body] of [['ana', 'add', { title: 'More' }], ['ana', 'edit', { task, title: 'x' }], ['ben', 'complete', { task: 'root', done: false }],
        ['cy', 'comment', { text: 'late' }], ['ana', 'invite', { ids: ['eve'] }], ['ana', 'assign', { task, assignees: [] }]]) err(await v.cb(who, action, { id, ...body }), 'COLLAB_FINISHED');
    v.pro.delete('cy'); // Pro doesn't matter once it's finished
    assert.equal(ok(await v.view('cy', id)).finished.by, 'ben');
    // finished collabs don't take a slot
    assert.deepEqual(plain(v.map.get('friends:ana').cb[id]), { done: T0 + 7 * DAY });
    const fl = ok(await v.overview('ana')).collabs[0];
    assert.equal(fl.finished, T0); assert.equal(fl.purge_at, T0 + 7 * DAY);
    // leave = off my list only
    ok(await v.cb('cy', 'leave', { id }));
    assert.equal(ok(await v.overview('cy')).collabs.length, 0);
    assert.ok(v.map.get('cb:' + id).members.includes('cy'), 'record kept for the archive');
    // purge after 7 days on the next read
    clock = T0 + 7 * DAY + 1;
    err(await v.view('ben', id), 'COLLAB_GONE');
    assert.equal(v.map.has('cb:' + id), false);
    assert.equal([...v.map.keys()].some(k => k.startsWith('cbt:' + id) || k.startsWith('cbm:' + id)), false);
    assert.equal(v.map.get('friends:ana').cb[id], undefined);
});

test('archive: a record with the tree, progress, viewers and comments — never importable', async () => {
    const v = fixture();
    const id = await collab(v, ['ben', 'cy']);
    const { task } = ok(await v.cb('ana', 'add', { id, title: 'Chapter 1', notes: 'Draft' }));
    ok(await v.cb('ana', 'add', { id, parent: task, title: 'Intro' }));
    ok(await v.cb('ana', 'assign', { id, task, assignees: ['ben'] }));
    ok(await v.cb('ben', 'complete', { id, task }));
    clock = T0 + 1234;
    ok(await v.cb('cy', 'comment', { id, text: 'Saved notes' }));
    const view = ok(await v.view('ana', id));
    const A = {}; vm.runInNewContext(read('collab-archive.js'), A);
    const arc = A.TaskitatorCollabArchive.build(view, T0);
    assert.equal(arc.format, 'taskitator-collab-archive'); assert.equal(A.TaskitatorCollabArchive.isArchive(arc), true);
    assert.equal(arc.collab.status, 'in progress'); assert.equal(arc.collab.started_by, '@ana');
    assert.deepEqual(plain(arc.progress.people.map(p => [p.username, p.role, p.assigned, p.done])), [['@ana', 'owner', 0, 0], ['@ben', 'member', 1, 1], ['@cy', 'viewer', 0, 0]]);
    assert.equal(arc.progress.done, 2); assert.equal(arc.progress.total, 3);
    assert.equal(arc.outline.subtasks[0].title, 'Chapter 1'); assert.equal(arc.outline.subtasks[0].done_by, '@ben');
    assert.equal(arc.outline.subtasks[0].subtasks[0].title, 'Intro');
    assert.deepEqual(plain(arc.comments), [{ by: '@cy', at: new Date(T0 + 1234).toISOString(), text: 'Saved notes' }]);
    const text = JSON.stringify(arc);
    for (const k of ['taskitator_tasks', 'taskitator_settings', '"id"', '"parent"', '"ana"', 'cbt:']) assert.ok(!text.includes(k), k);
    assert.ok(!text.includes(id), 'no collab id');
    assert.match(A.TaskitatorCollabArchive.fileName({ title: 'مشروع / Thesis' }, T0), /^taskitator-collab-مشروع-Thesis-2026-12-01\.json$/);
    // Settings import refuses it; export carries friends + collabs as a record
    const settings = read('settings.html');
    assert.match(settings, /if \(window\.TaskitatorCollabArchive\?\.isArchive\(imported\) \|\| imported\?\.format === 'taskitator-collab-archive'\) \{\s*throw new Error\("This is a saved collab, not a backup\. It can't be imported\."\);/);
    assert.ok(settings.indexOf("isArchive(imported)") < settings.indexOf("if (!imported.taskitator_tasks || !imported.taskitator_settings)"));
    assert.match(settings, /taskitator_social: social,/);
    assert.match(settings, /requests_received: \(f\.incoming \|\| \[\]\)\.map\(person\),\s*requests_sent: \(f\.outgoing \|\| \[\]\)\.map\(person\),/);
    assert.doesNotMatch(settings.match(/async function socialExport[\s\S]*?\n\}/)[0], /\bid:/, 'no account ids in the export');
    assert.doesNotMatch(settings, /imported\.taskitator_social/, 'import never reads it');
    assert.match(settings, /src="collab-archive\.js\?v=ca-1"/);
});

test('collab view: finish confirm, save prompt, viewer badge, finished read-only; archive loads on demand', () => {
    const ui = read('collab-ui.js');
    assert.match(ui, /if \(task\.id === 'root'\) \{ \/\/ Phase 7\.6/);
    assert.match(ui, /confirmLabel: t\('Finish collab'\), tone: 'danger'/);
    assert.match(ui, /confirmLabel: t\('Save JSON file'\), cancelLabel: t\('Not now'\)/);
    assert.match(ui, /sc\.src = 'collab-archive\.js\?v=ca-1'/);
    assert.match(ui, /el\('span', 'cb-viewer', t\('Viewer'\)\)/);
    assert.match(ui, /if \(!data\.joined \|\| !data\.pro_ok \|\| data\.finished\) return false;/);
    assert.match(ui, /if \(data\.joined && !data\.finished\) \{\s*const form = el\('form', 'cb-form cb-comment-form'\);/);
    assert.match(read('shell-router.js'), /collab-ui\.js\?v=cb-\d/);
});

// ---------------------------------------------------------------- race bar
function raceCtx() {
    const c = { window: {}, document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: f => f(), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };
    c.window.addEventListener = () => {};
    vm.runInNewContext(read('race-ui.js'), { ...c, window: c.window, globalThis: c });
    return c.window;
}
test('race bar: range spread for Time, goal-relative for Amount, lanes, short names, leader', () => {
    const w = raceCtx(), R = w.TaskitatorRace;
    assert.equal(w.TaskitatorRaceColors.length, 8);
    const m = (username, main, extra = {}) => ({ username, main, second: 0, state: 'in', color: 0, ...extra });
    const time = { status: 'active', type: 'time', metric: 'points', members: [m('a', 40), m('b', 30), m('c', 20)] };
    const tp = R._positions(time);
    assert.equal(tp.get('a'), 92); assert.equal(tp.get('c'), 8); assert.equal(tp.get('b'), 50, 'first to last = the range');
    const close = R._positions({ ...time, members: [m('a', 1), m('b', 0)] });
    assert.ok(close.get('a') < 30, 'a 1-point lead doesn’t fill the track (minimum span)');
    const four = R._positions({ status: 'active', type: 'amount', metric: 'tasks', target: 4, members: [m('a', 1)] }).get('a');
    const twenty = R._positions({ status: 'active', type: 'amount', metric: 'tasks', target: 20, members: [m('a', 1)] }).get('a');
    assert.ok(four - 8 > 4 * (twenty - 8) * 0.99, 'a step of a 4-step goal moves 5x further than of a 20-step goal');
    assert.equal(R._positions({ status: 'active', type: 'amount', metric: 'tasks', target: 4, members: [m('a', 9)] }).get('a'), 92, 'clamped at the finish');
    assert.equal(R._positions({ ...time, status: 'pending' }).get('a'), 8);
    const { map, count } = R._lanes(new Map([['a', 50], ['b', 55], ['c', 90]]));
    assert.equal(count, 2); assert.notEqual(map.get('a'), map.get('b')); assert.equal(map.get('c'), 0);
    assert.equal(R._short('Barbara'), 'Barbara'); assert.equal(R._short('Barbarella'), 'Barba…'); assert.equal(R._short('مازن_العتيبي'), 'مازن_…');
    assert.equal(R._leader(time), 'a');
    assert.equal(R._leader({ ...time, members: [m('a', 3), m('b', 3)] }), null, 'tie: no crown');
    assert.equal(R._leader({ ...time, members: [m('a', 0), m('b', 0)] }), null);
});

test('race bar wiring: Today only, Animations switch (off in Reduced/Static), minimize FAB, polling, precache', () => {
    const ui = read('race-ui.js');
    assert.match(ui, /motionAllowed\?\.\('race'\) === true/);
    assert.match(ui, /window\.TaskitatorShell\?\.current\?\.\(\) === 'tasks' && window\.TaskitatorShell\?\.key\?\.\(\) !== 'general'/);
    assert.match(ui, /list\.after\(dock\)/);
    assert.match(ui, /POLL_MS = 60000, AFTER_SYNC_MS = 5000/);
    assert.match(ui, /'\/friends\/challenges\/live'/);
    assert.match(read('style.css'), /\.race-fab\{position:fixed;bottom:24px;inset-inline-start:24px;/);
    assert.match(read('index.html'), /src="race-ui\.js\?v=race-1"><\/script>\n<script type="text\/taskitator-script" src="friends-ui\.js\?v=fr-v\d">/);
    const settings = read('settings.html');
    assert.match(settings, /data-fx="race"/);
    assert.match(read('theme-boot.js'), /const DECORATIVE = \['particles', 'clouds', 'bird', 'parallax', 'bubbles', 'wipe', 'race'\];/);
    const sw = read('sw.js');
    assert.match(sw, /'\.\/race-ui\.js', '\.\/collab-archive\.js'/);
    assert.match(sw, /CACHE_NAME = 'taskitator-phase4-v82'/);
});

test('Arabic: the most specific pattern wins; new strings translate', () => {
    const store = new Map([['taskitator_lang', JSON.stringify({ v: 1, lang: 'ar', clock: 'auto' })]]);
    const c = { localStorage: { getItem: k => store.get(k) ?? null, setItem() {} }, document: { documentElement: {}, addEventListener() {} }, location: { reload() {} },
        sessionStorage: { getItem: () => null }, CustomEvent: class {}, Intl, Date, Number, String, Object, JSON };
    c.window = { addEventListener() {}, dispatchEvent() {} };
    vm.createContext(c); vm.runInContext(read('i18n.js'), c);
    const a = { window: {}, module: { exports: {} } }; vm.createContext(a); vm.runInContext(read('locales/ar.js'), a);
    c.window.TaskitatorI18n.register('ar', a.module.exports);
    const tr = c.window.TaskitatorI18n.translateText;
    assert.equal(tr('4 days left'), 'بقي 4 أيام', '"{0} days left" beats "{0} left"');
    assert.equal(tr('3 left'), 'متبقٍ 3');
    assert.equal(tr('First to 4 مهام'), 'أول من يصل إلى 4 مهام', 'the unit is translated first, then the sentence');
    assert.equal(tr('@ben won'), 'فاز ‎@ben');
    assert.equal(tr('Save JSON file'), 'حفظ ملف JSON');
    for (const k of ['Challenge race', 'Finish the collab?', 'Viewer', 'Time', 'Amount', 'Goal reached first', 'Remove from my list'])
        assert.ok(a.module.exports[k] || tr(k), k);
});

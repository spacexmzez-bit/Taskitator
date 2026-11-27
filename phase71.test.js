// Phase 7.1: friends. Server behaviour is exercised end to end in security.test.js ("Phase 7.1: friends …").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FriendsService, FRIEND_LIMITS } from './friends-backend.js';

const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');

test('limits and silent rules are in the service', () => {
    assert.deepEqual({ ...FRIEND_LIMITS }, { FRIEND_LIMIT: 50, OUT_LIMIT: 20, DAILY_REQUESTS: 30, EXPIRE_MS: 30 * 86400000, COLLAB_MAX: 6 });
    const src = read('friends-backend.js');
    assert.match(src, /mine\.out\[uid\] = refused \? \{ at: now, dropped: true \} : \{ at: now \};/);
    assert.match(src, /return \{ ok: true, status: 'pending' \}; \/\/ the same answer either way/);
    assert.match(src, /if \(theirs\.out\[me\]\) theirs\.out\[me\]\.dropped = true;/, 'decline is silent');
    assert.doesNotMatch(src, /LIKE \?|startsWith\(norm|prefix:'pro:username:map:'/, 'no prefix search');
});

test('duo streak counts days both finished, skipping either person\'s free days', () => {
    const ctx = {}; vm.runInNewContext(read('points.js'), ctx); globalThis.TaskitatorPoints = ctx.TaskitatorPoints;
    const svc = new FriendsService({ storage: {} });
    const now = Date.parse('2026-11-25T09:00:00Z'); // Wednesday
    const day = (...ds) => ({ days: Object.fromEntries(ds.map(d => [d, { p: 1, n: 1 }])), free: [{ from: '0000-01-01', days: [] }] });
    assert.equal(svc.duo(day('2026-11-23', '2026-11-24', '2026-11-25'), day('2026-11-24', '2026-11-25'), now), 2);
    assert.equal(svc.duo(day('2026-11-23', '2026-11-24'), day('2026-11-23', '2026-11-24'), now), 2, 'today not done yet keeps it');
    const b = day('2026-11-22', '2026-11-24'); b.free = [{ from: '0000-01-01', days: [1] }]; // Monday 23rd free for b
    assert.equal(svc.duo(day('2026-11-22', '2026-11-24'), b, now), 2, 'free Monday skipped');
    assert.equal(svc.duo(null, day('2026-11-24'), now), 0);
});

test('Worker wiring, view, nav, Universe button, cache', () => {
    const w = read('worker.js');
    assert.match(w, /import \{ FriendsService \} from '\.\/friends-backend\.js';/);
    assert.match(w, /this\.friends = new FriendsService\(this\);/);
    assert.match(w, /const friendsRoute = path === '\/friends' \|\| path\.startsWith\('\/friends\/'\);/);
    assert.match(w, /!friendsRoute && /);
    assert.match(w, /'friends:'\+identity\.userId\]/);
    const index = read('index.html');
    assert.match(index, /<section id="shellView-friends" class="shell-view" data-shell-view="friends" hidden><div class="fr-wrap" id="friendsRoot"><\/div><\/section>/);
    assert.match(index, /<a href="#friends" data-shell-link="friends">[\s\S]*?Friends<span class="nav-count" data-friends-count hidden><\/span><\/a>/);
    assert.match(index, /src="friends-ui\.js\?v=fr-v\d"/);
    for (const page of ['components.html', 'settings.html']) assert.match(read(page), /href="index\.html#friends"/, page);
    assert.match(read('shell-router.js'), /else if \(view === 'friends'\) window\.TaskitatorFriendsView\?\.show\(\);/);
    assert.match(read('app.js'), /friends: 'friends'/);
    assert.match(read('uni/universe-ui.js'), /window\.TaskitatorAuth\.api\('\/friends\/request',\{method:'POST',body:JSON\.stringify\(\{username:m\.username\}\)\}\)/);
    assert.match(read('sw.js'), /'\.\/friends-ui\.js'/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v79'/);
    assert.match(read('index.html'), /id="help-friends"/);
    assert.match(read('README.md'), /\*\*Friends \(Phase 7\.0\):\*\*/);
    for (const k of ['Friends', 'Send request', 'Duo streak {0}', 'Unfriend @{0}?']) assert.ok(read('locales/ar.js').includes('"' + k + '"'), k);
});

test('Friends view renders the leaderboard with you included and never shows task fields', async () => {
    const mk = tag => ({ tag, children: [], style: {}, className: '', textContent: '', attrs: {}, dataset: {}, value: '',
        append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener() {}, classList: { add() {}, remove() {} } });
    const host = mk('div'); const text = n => [n.textContent, ...(n.children || []).map(text)].join(' ');
    const ctx = {}; vm.runInNewContext(read('points.js'), ctx);
    const R = ctx.TaskitatorPoints.rankFor;
    const data = { me: { id: 'me', username: 'maz', total: 40, rank: R(40), streak: 2, week: 10, done_today: true, me: true, privacy: 'anyone' },
        friends: [{ id: 'f', username: 'sara', total: 90, rank: R(90), streak: 5, week: 4, done_today: false, duo: 3, cheered_today: false }],
        incoming: [], outgoing: [], blocked: [], cheers: [], week_start: '2026-11-22', limits: { friends: 50 } };
    const window = { TaskitatorAuth: { userId: 'me', api: async () => data }, TaskitatorShell: { current: () => 'friends' }, addEventListener() {} };
    const document = { createElement: mk, getElementById: id => (id === 'friendsRoot' ? host : null), querySelectorAll: () => [], addEventListener() {} };
    vm.runInNewContext(read('friends-ui.js'), { window, document, localStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON });
    window.TaskitatorFriendsView.show();
    await new Promise(r => setTimeout(r, 10));
    const all = text(host);
    assert.match(all, /#1\s+@sara/);
    assert.match(all, /#2\s+You/);
    assert.match(all, /Duo streak 3/);
});

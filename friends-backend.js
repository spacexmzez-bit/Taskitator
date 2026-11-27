/* Phase 7.0: friends (personal Taskitator; nothing to do with Universe except "Add friend" from a member list).
   One Durable Object record per person, keyed by their Clerk user id: friends:<uid>
     { v:1, friends:{uid:{since}}, out:{uid:{at, dropped?}}, in:{uid:{at}}, blocked:{uid:at},
       cheers:[{from, at}], cheered:{uid:'YYYY-MM-DD'}, privacy:'anyone'|'universe'|'nobody', sent:[timestamps] }
   Rules
   - Find people by their exact Taskitator username only (no prefix search, so the user list can't be scraped).
   - A request the other person must never see (they blocked you, or their privacy setting refuses you) is stored on
     your side only, marked dropped: you see "pending" like any other request until it expires (30 days).
   - Declining is silent too: the sender keeps seeing "pending" until it expires.
   - Blocking ends a friendship and cancels requests both ways. You must unblock before sending a request.
   - Friends see each other's points, rank, streak, this week's points and whether today is done. Never tasks.
   - Limits: 50 friends, 20 pending sent requests, 30 requests a day. Everything needs a connection.
   Phase 7.0 Collab: a small shared space for friends, built on the Universe backend (tasks, assignments, AI and human
   reviews, phone blocking with consent all come from Universe). Creating one is a Universe group owned by the creator;
   each chosen friend gets a 7-day invitation (role admin, so everyone can add work) that appears on their Friends page.
   Pro is required for everyone: to create, to be invited, to accept, and for any change inside the collab (reading,
   leaving, withdrawing phone-blocking consent and deleting stay open). collab:<gid> = {owner, title, members, at}. */
const FRIEND_LIMIT = 50, OUT_LIMIT = 20, DAILY_REQUESTS = 30, EXPIRE_MS = 30 * 86400000, CHEER_KEEP_MS = 7 * 86400000;
const PRIVACY = ['anyone', 'universe', 'nobody'];
const COLLAB_MAX = 6, COLLAB_INVITE_S = 7 * 86400; // owner + 5 friends
const gidPattern = /^[A-Za-z0-9_-]{1,100}$/;
const OFFSET = 3 * 3600000;
const key = uid => 'friends:' + uid;
const idPattern = /^[A-Za-z0-9_|-]{1,128}$/;
const riyadhDay = now => new Date(now + OFFSET).toISOString().slice(0, 10);

class FriendError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || 'FRIENDS'; } }
const fail = (status, message, code) => { throw new FriendError(status, message, code); };

function blank() { return { v: 1, friends: {}, out: {}, in: {}, blocked: {}, cheers: [], cheered: {}, privacy: 'anyone', sent: [], collab_in: {}, collabs: {} }; }
function clean(rec, now) {
    const r = rec && rec.v === 1 ? rec : blank();
    for (const k of ['friends', 'out', 'in', 'blocked', 'cheered', 'collab_in', 'collabs']) r[k] = r[k] && typeof r[k] === 'object' ? r[k] : {};
    for (const [id, v] of Object.entries(r.collab_in)) if (!v || now - v.at > COLLAB_INVITE_S * 1000) delete r.collab_in[id];
    r.cheers = Array.isArray(r.cheers) ? r.cheers.filter(c => c && now - c.at < CHEER_KEEP_MS).slice(-30) : [];
    r.sent = Array.isArray(r.sent) ? r.sent.filter(t => now - t < 86400000) : [];
    if (!PRIVACY.includes(r.privacy)) r.privacy = 'anyone';
    for (const side of ['out', 'in']) for (const [id, v] of Object.entries(r[side])) if (!v || now - v.at > EXPIRE_MS) delete r[side][id];
    const today = riyadhDay(now);
    for (const [id, d] of Object.entries(r.cheered)) if (d !== today) delete r.cheered[id];
    return r;
}

export class FriendsService {
    constructor(service) { this.service = service; this.storage = service.storage; }

    async username(uid, store = this.storage) {
        const rec = await store.get('pro:user:username:' + uid);
        if (!rec?.normalizedUsername) return null;
        const owner = await store.get('pro:username:map:' + rec.normalizedUsername);
        return owner?.accountId === uid ? rec.username : null;
    }
    async byUsername(name, store) {
        const norm = String(name || '').trim().replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(norm)) fail(400, 'Enter an exact Taskitator username (3–20 letters, numbers or underscores).', 'FRIENDS_USERNAME');
        const owner = await store.get('pro:username:map:' + norm);
        return owner?.accountId || null;
    }
    // Still a Taskitator account? (deleted accounts drop out of friend lists)
    async alive(uid, store = this.storage) {
        if (!await store.get('identity:' + uid)) return false;
        try { return !(await this.service.deletion?.marker?.({ userId: uid })); } catch { return true; }
    }
    async points(uid, now) {
        const P = globalThis.TaskitatorPoints, link = await this.storage.get('identity:' + uid);
        const state = link?.user ? await this.storage.get('points:' + link.user) : null;
        return { state, summary: P.summary(state, now) };
    }
    async shareUniverse(a, b) {
        try {
            const db = this.service.universe?.database?.();
            if (!db) return false;
            return Boolean(await db.prepare('SELECT 1 FROM universe_members x JOIN universe_members y ON x.group_id=y.group_id WHERE x.account_id=? AND y.account_id=? LIMIT 1').bind(a, b).first());
        } catch { return false; }
    }

    // Days both people finished a task in a row; a day either of them marked free is skipped.
    duo(a, b, now) {
        const P = globalThis.TaskitatorPoints;
        if (!a || !b) return 0;
        const today = P.logicalDate(now, 0);
        const done = (s, d) => P.dayDone(s, d), free = (s, d) => P.isFree(s, d); // 7.2: streak mode + required days
        const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
        let n = 0;
        if (done(a, today) && done(b, today) && !free(a, today) && !free(b, today)) n = 1;
        for (let d = shift(today, -1), i = 0; i < 400; i++, d = shift(d, -1)) {
            if (free(a, d) || free(b, d)) continue;
            if (!done(a, d) || !done(b, d)) break;
            n++;
        }
        return n;
    }
    weekPoints(state, settingsWeekStart) {
        let sum = 0;
        for (const [d, r] of Object.entries(state?.days || {})) if (d >= settingsWeekStart) sum += r.p || 0;
        return sum;
    }

    async handle(identity, path, method, body, settings) {
        const me = identity.userId, now = Date.now();
        try {
            if (method === 'GET' && path === '/friends') return await this.overview(me, now, settings);
            if (method !== 'POST') fail(405, 'Method not allowed.');
            const action = path.slice('/friends/'.length);
            if (action.startsWith('collab/')) return await this.collab(identity, action.slice(7), body || {}, now);
            const target = typeof body?.id === 'string' ? body.id : null;
            if (target != null && (!idPattern.test(target) || target === me)) fail(400, 'Choose a valid person.');
            return await this.storage.transaction(async tx => {
                const mine = clean(await tx.get(key(me)), now);
                const save = async (uid, rec) => tx.put(key(uid), rec);
                const other = async uid => clean(await tx.get(key(uid)), now);
                if (action === 'privacy') {
                    if (!PRIVACY.includes(body?.privacy)) fail(400, 'Choose who can send you requests.');
                    mine.privacy = body.privacy; await save(me, mine); return { ok: true, privacy: mine.privacy };
                }
                if (action === 'request') {
                    if (!await this.username(me, tx)) fail(403, 'Set a username first, so people know who the request is from.', 'FRIENDS_NO_USERNAME');
                    const uid = target || await this.byUsername(body?.username, tx);
                    if (!uid || !await this.alive(uid, tx) || !await this.username(uid, tx)) fail(404, 'No Taskitator user has that username.', 'FRIENDS_NOT_FOUND');
                    if (uid === me) fail(400, 'That’s your own username.');
                    if (mine.friends[uid]) fail(409, 'You’re already friends.', 'FRIENDS_ALREADY');
                    if (mine.blocked[uid]) fail(409, 'You blocked this person. Unblock them first.', 'FRIENDS_BLOCKED_BY_YOU');
                    if (mine.out[uid]) return { ok: true, status: 'pending' };
                    const theirs = await other(uid);
                    // They already asked you: this accepts.
                    if (mine.in[uid] && !theirs.blocked[me]) return await this.befriend(tx, me, mine, uid, theirs, now);
                    if (mine.sent.length >= DAILY_REQUESTS) fail(429, 'You’ve sent the most requests allowed today. Try again tomorrow.', 'FRIENDS_RATE');
                    if (Object.keys(mine.out).length >= OUT_LIMIT) fail(409, `You can have ${OUT_LIMIT} requests waiting. Withdraw one first.`, 'FRIENDS_OUT_LIMIT');
                    if (Object.keys(mine.friends).length >= FRIEND_LIMIT) fail(409, `You can have up to ${FRIEND_LIMIT} friends.`, 'FRIENDS_LIMIT');
                    const refused = theirs.blocked[me] || theirs.privacy === 'nobody' || (theirs.privacy === 'universe' && !await this.shareUniverse(me, uid));
                    mine.out[uid] = refused ? { at: now, dropped: true } : { at: now };
                    mine.sent.push(now);
                    if (!refused) { theirs.in[me] = { at: now }; await save(uid, theirs); }
                    await save(me, mine);
                    return { ok: true, status: 'pending' }; // the same answer either way
                }
                if (!target) fail(400, 'Choose a person.');
                const theirs = await other(target);
                if (action === 'respond') {
                    if (!mine.in[target]) fail(404, 'This request is no longer waiting.', 'FRIENDS_GONE');
                    if (body?.accept === true) {
                        if (theirs.blocked[me] || !theirs.out[me] || theirs.out[me].dropped) {
                            delete mine.in[target]; await save(me, mine); fail(404, 'This request is no longer waiting.', 'FRIENDS_GONE');
                        }
                        return await this.befriend(tx, me, mine, target, theirs, now);
                    }
                    delete mine.in[target];
                    if (theirs.out[me]) theirs.out[me].dropped = true; // silent: they keep seeing "pending" until it expires
                    await save(me, mine); await save(target, theirs);
                    return { ok: true };
                }
                if (action === 'withdraw') {
                    delete mine.out[target]; delete theirs.in[me];
                    await save(me, mine); await save(target, theirs); return { ok: true };
                }
                if (action === 'remove') {
                    delete mine.friends[target]; delete theirs.friends[me];
                    await save(me, mine); await save(target, theirs); return { ok: true };
                }
                if (action === 'block') {
                    delete mine.friends[target]; delete theirs.friends[me];
                    delete mine.out[target]; delete mine.in[target]; delete theirs.out[me]; delete theirs.in[me];
                    mine.blocked[target] = now;
                    await save(me, mine); await save(target, theirs); return { ok: true };
                }
                if (action === 'unblock') { delete mine.blocked[target]; await save(me, mine); return { ok: true }; }
                if (action === 'cheer') {
                    if (!mine.friends[target] || !theirs.friends[me]) fail(403, 'You can only cheer friends.', 'FRIENDS_NOT_FRIENDS');
                    if (mine.cheered[target]) fail(429, 'You already cheered them today.', 'FRIENDS_CHEERED');
                    mine.cheered[target] = riyadhDay(now);
                    theirs.cheers.push({ from: me, at: now });
                    theirs.cheers = theirs.cheers.slice(-30);
                    await save(me, mine); await save(target, theirs); return { ok: true };
                }
                fail(404, 'Endpoint not found.');
            });
        } catch (e) {
            if (e instanceof FriendError) return { __error: { status: e.status, message: e.message, code: e.code } };
            throw e;
        }
    }

    async isPro(uid) { try { return Boolean(await this.service.universe?.entitlement?.({ userId: uid })); } catch { return false; } }
    async groupMembers(gid) {
        const db = this.service.universe?.database?.();
        if (!db) return null;
        try { return (await db.prepare('SELECT account_id FROM universe_members WHERE group_id=?').bind(gid).all()).results.map(r => r.account_id); }
        catch { return null; }
    }
    async myCollabs(me, rec) {
        const out = [];
        for (const [gid, v] of Object.entries(rec.collabs)) {
            const members = await this.groupMembers(gid);
            if (members && !members.includes(me)) continue; // left or removed
            const names = [];
            for (const uid of (members || []).filter(u => u !== me)) names.push(await this.username(uid) || 'Taskitator user');
            out.push({ id: gid, title: v.title, members: names, at: v.at });
        }
        return out.sort((a, b) => b.at - a.at);
    }
    token() { return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''); }
    op() { return 'collab_' + crypto.randomUUID().replace(/-/g, ''); }

    // Collab actions talk to the Universe service first, then update the friends records in one transaction.
    async collab(identity, action, body, now) {
        const me = identity.userId, U = this.service.universe;
        if (!U?.handle) fail(503, 'Collab isn’t available right now.', 'COLLAB_UNAVAILABLE');
        if (action === 'create') {
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            if (!title || title.length > 120) fail(400, 'Give the collab a name (up to 120 characters).', 'COLLAB_TITLE');
            const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(x => typeof x === 'string' && idPattern.test(x) && x !== me) : [];
            if (!ids.length || ids.length > COLLAB_MAX - 1) fail(400, `Choose 1 to ${COLLAB_MAX - 1} friends.`, 'COLLAB_MEMBERS');
            const mine = clean(await this.storage.get(key(me)), now);
            for (const uid of ids) {
                const theirs = clean(await this.storage.get(key(uid)), now);
                if (!mine.friends[uid] || !theirs.friends[me]) fail(403, 'You can only start a collab with friends.', 'COLLAB_NOT_FRIENDS');
            }
            if (!await this.isPro(me)) fail(403, 'Collab needs Pro. Everyone in a collab needs an active Pro license.', 'COLLAB_PRO');
            const missing = [];
            for (const uid of ids) if (!await this.isPro(uid)) missing.push(await this.username(uid) || 'a friend');
            if (missing.length) fail(403, `Everyone in a collab needs Pro. Not on Pro: ${missing.map(n => '@' + n).join(', ')}.`, 'COLLAB_PRO');
            const created = await U.handle(identity, '/universe/groups', 'POST', { operation_id: this.op(), title, purpose: 'Collab · a shared space for friends.' });
            const gid = created.group_id;
            const invites = {};
            for (const uid of ids) {
                const token = this.token();
                await U.handle(identity, '/universe/groups/' + gid + '/invitations', 'POST', { operation_id: this.op(), token, role: 'admin', expires_in_seconds: COLLAB_INVITE_S });
                invites[uid] = token;
            }
            await this.storage.transaction(async tx => {
                await tx.put('collab:' + gid, { owner: me, title, members: [me, ...ids], at: now });
                const m = clean(await tx.get(key(me)), now); m.collabs[gid] = { title, at: now }; await tx.put(key(me), m);
                for (const uid of ids) { const t = clean(await tx.get(key(uid)), now); t.collab_in[gid] = { token: invites[uid], from: me, title, at: now }; await tx.put(key(uid), t); }
            });
            return { ok: true, id: gid };
        }
        const gid = typeof body.id === 'string' && gidPattern.test(body.id) ? body.id : fail(400, 'Choose a collab.');
        const mine = clean(await this.storage.get(key(me)), now);
        const invite = mine.collab_in[gid];
        if (!invite) fail(404, 'This collab invitation is no longer waiting.', 'COLLAB_GONE');
        if (action === 'decline') {
            await this.storage.transaction(async tx => { const m = clean(await tx.get(key(me)), now); delete m.collab_in[gid]; await tx.put(key(me), m); });
            return { ok: true };
        }
        if (action === 'accept') {
            if (!await this.isPro(me)) fail(403, 'Collab needs Pro. Everyone in a collab needs an active Pro license.', 'COLLAB_PRO');
            await U.handle(identity, '/universe/invitations/accept', 'POST', { operation_id: this.op(), token: invite.token });
            await this.storage.transaction(async tx => {
                const m = clean(await tx.get(key(me)), now); delete m.collab_in[gid]; m.collabs[gid] = { title: invite.title, at: now }; await tx.put(key(me), m);
            });
            return { ok: true, id: gid };
        }
        fail(404, 'Endpoint not found.');
    }

    // Called by the Worker before any Universe request. Inside a collab, changes need Pro for every current member.
    async gate(identity, path, method, body) {
        if (method === 'GET') return null;
        const m = /^\/universe\/groups\/([A-Za-z0-9_-]{1,100})(\/.*)?$/.exec(path);
        if (!m || !await this.storage.get('collab:' + m[1])) return null;
        const tail = m[2] || '';
        if (tail === '/leave' || /\/delete$/.test(tail) && !tail.includes('/work/') || (/consent/.test(tail) && body?.enabled === false) || method === 'DELETE') return null;
        const members = await this.groupMembers(m[1]) || [];
        for (const uid of members) if (!await this.isPro(uid)) return { status: 403, code: 'COLLAB_PRO', message: 'Everyone in this collab needs Pro to make changes. You can still read it, leave it or withdraw phone-blocking consent.' };
        return null;
    }

    async befriend(tx, me, mine, uid, theirs, now) {
        if (Object.keys(mine.friends).length >= FRIEND_LIMIT) fail(409, `You can have up to ${FRIEND_LIMIT} friends. Remove one first.`, 'FRIENDS_LIMIT');
        if (Object.keys(theirs.friends).length >= FRIEND_LIMIT) fail(409, 'They’ve reached the friend limit.', 'FRIENDS_LIMIT');
        mine.friends[uid] = { since: now }; theirs.friends[me] = { since: now };
        delete mine.in[uid]; delete mine.out[uid]; delete theirs.in[me]; delete theirs.out[me];
        await tx.put(key(me), mine); await tx.put(key(uid), theirs);
        return { ok: true, status: 'friends' };
    }

    async overview(me, now, settings) {
        const P = globalThis.TaskitatorPoints;
        let rec = clean(await this.storage.get(key(me)), now);
        // Drop people whose accounts are gone.
        let changed = false;
        for (const side of ['friends', 'out', 'in', 'blocked']) for (const id of Object.keys(rec[side])) if (!await this.alive(id)) { delete rec[side][id]; changed = true; }
        if (changed) await this.storage.put(key(me), rec);
        const mineP = await this.points(me, now);
        const today = mineP.summary.today.date;
        const weekStart = (() => { const n = P.nextWeekStart(today, settings || {}); return new Date(Date.parse(n + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10); })();
        const card = async (uid, extra = {}) => {
            const p = await this.points(uid, now);
            return { id: uid, username: await this.username(uid) || 'Taskitator user', total: p.summary.total, rank: p.summary.rank,
                streak: p.summary.streak, week: this.weekPoints(p.state, weekStart), done_today: p.summary.today.done, ...extra, _state: p.state };
        };
        const friends = [];
        for (const [uid, f] of Object.entries(rec.friends)) {
            const c = await card(uid, { since: f.since, cheered_today: Boolean(rec.cheered[uid]) });
            c.duo = this.duo(mineP.state, c._state, now);
            friends.push(c);
        }
        const meCard = await card(me, { me: true });
        for (const c of [...friends, meCard]) delete c._state;
        const people = async obj => Promise.all(Object.entries(obj).map(async ([uid, v]) => ({ id: uid, username: await this.username(uid) || 'Taskitator user', at: typeof v === 'number' ? v : v.at })));
        const cheers = await Promise.all(rec.cheers.filter(c => rec.friends[c.from]).map(async c => ({ from: c.from, username: await this.username(c.from) || 'A friend', at: c.at })));
        return {
            me: { ...meCard, username: await this.username(me), privacy: rec.privacy, streak_best: mineP.summary.best },
            friends: friends.sort((a, b) => b.total - a.total || a.username.localeCompare(b.username)),
            incoming: await people(rec.in), outgoing: await people(rec.out), blocked: await people(rec.blocked),
            cheers, week_start: weekStart, limits: { friends: FRIEND_LIMIT, outgoing: OUT_LIMIT, collab: COLLAB_MAX },
            collab_invites: await Promise.all(Object.entries(rec.collab_in).map(async ([gid, v]) => ({ id: gid, title: v.title, from: v.from, username: await this.username(v.from) || 'A friend', at: v.at }))),
            collabs: await this.myCollabs(me, rec)
        };
    }
}
export const FRIEND_LIMITS = Object.freeze({ FRIEND_LIMIT, OUT_LIMIT, DAILY_REQUESTS, EXPIRE_MS, COLLAB_MAX });

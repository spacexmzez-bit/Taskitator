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
   Phase 7.5 Challenges: a Pro user challenges a friend (the friend needs no Pro) to Points, Tasks or Streak over
   1–30 days (default 5). challenge:<id> = {id, from, to, metric, days, status, at, accepted_at, start, end, result}.
   Status: pending (7-day invite) → active → finished, or declined / cancelled. The challenge starts the day after it
   is accepted (Riyadh day) and scores come from each person's own points ledger, so nothing new is tracked:
     points = points earned; tasks = required (non-bonus) tasks finished;
     streak = longest run of finished days inside the window (a day counts when a required task was finished; one rule
     for both players, whatever their own streak mode; free days skip), ties broken by finished days.
   The result is frozen on the first read after the last day. Forfeit = the other person wins. Limits: 3 active
   challenges each, 10 waiting invites sent. Finished ones stay listed for 30 days.
   Phase 7.6 Challenges (records are v:2; a 7.5 record is read as a two-person Time challenge and keeps its ledger scoring):
     challenge:<id> = {v:2, id, from, type:'time'|'amount', metric, days, target, prize, status, at,
       members:{uid:{s:'invited'|'in'|'left', at, color}}, start, end, started_at, track_from, prog:{uid:{day:{p,r}}}, reached:{uid:at}, result}
     chl:<uid> = {id: end}  running challenges the person is in, read once per sync to log what counts (chRecord).
   - Up to 6 people (you + 5 friends). Pro to send; joining is free. Nobody can join after it starts.
   - Starts the day after the sender presses Start, or by itself 48 h after it was sent if at least one friend joined.
     Waiting invitations expire after 7 days. Rules, prize and people are fixed once sent.
   - Time: the highest score on the last day wins (ties share the win). Amount: the first to reach the goal wins (the
     server's clock at the sync that crossed it); if nobody does, the highest score wins and it's marked "goal not reached".
   - Anti-cheat: scores come only from the Worker (chRecord), per day at most CH_DAY_POINTS points and CH_DAY_TASKS
     tasks, tasks must be 5 minutes old when finished, goals must be reachable but not trivial, the sender can't cancel
     after it starts (forfeit only), leaving after the start is a forfeit with no way back, and blocking someone makes
     you forfeit what you share with them.
   - Prize: optional plain text (40 characters), shown only. Colors: 8, unique within a challenge.
   Phase 7.5 Collab lives in collab-backend.js (the Phase 7.0 Universe-based collab was removed). */
const FRIEND_LIMIT = 50, OUT_LIMIT = 20, DAILY_REQUESTS = 30, EXPIRE_MS = 30 * 86400000, CHEER_KEEP_MS = 7 * 86400000;
const PRIVACY = ['anyone', 'universe', 'nobody'];
const CH_METRICS = ['points', 'tasks', 'streak'], CH_MAX_DAYS = 30, CH_DEFAULT_DAYS = 5, CH_ACTIVE = 3, CH_PENDING = 10;
const CH_INVITE_MS = 7 * 86400000, CH_KEEP_MS = 30 * 86400000;
// Phase 7.6
const CH_TYPES = ['time', 'amount'], CH_MEMBERS = 6, CH_AUTOSTART_MS = 48 * 3600000, CH_LIST = 20, CH_COLORS = 8, CH_PRIZE = 40;
const CH_DAY_POINTS = 50, CH_DAY_TASKS = 15, CH_MIN_AGE_MS = 5 * 60000, CH_LATE_DAYS = 1, CH_LIVE_CACHE_MS = 45000, CH_RECENT_MS = 86400000;
const CH_GOAL_MIN = { points: 10, tasks: 2, streak: 2 }, CH_GOAL_DAY = { points: CH_DAY_POINTS, tasks: CH_DAY_TASKS, streak: 1 };
const chGoalRange = (metric, days) => [CH_GOAL_MIN[metric], CH_GOAL_DAY[metric] * days];
const chPattern = /^ch_[a-f0-9]{24}$/;
const OFFSET = 3 * 3600000;
const key = uid => 'friends:' + uid;
const idPattern = /^[A-Za-z0-9_|-]{1,128}$/;
const riyadhDay = now => new Date(now + OFFSET).toISOString().slice(0, 10);
const shiftDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Prize: plain text the creator types; Taskitator never handles it. Control and direction-override characters are dropped.
const chPrize = v => {
    if (v == null || v === '') return '';
    if (typeof v !== 'string') fail(400, 'Check the prize.', 'CHALLENGE_PRIZE');
    const s = v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > CH_PRIZE) fail(400, `A prize can be up to ${CH_PRIZE} characters.`, 'CHALLENGE_PRIZE');
    return s;
};
const chColor = v => (Number.isInteger(v) && v >= 0 && v < CH_COLORS ? v : fail(400, 'Choose a color.', 'CHALLENGE_COLOR'));

class FriendError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || 'FRIENDS'; } }
const fail = (status, message, code) => { throw new FriendError(status, message, code); };

function blank() { return { v: 1, friends: {}, out: {}, in: {}, blocked: {}, cheers: [], cheered: {}, privacy: 'anyone', sent: [], challenges: {}, cb: {}, cb_in: {} }; }
function clean(rec, now) {
    const r = rec && rec.v === 1 ? rec : blank();
    for (const k of ['friends', 'out', 'in', 'blocked', 'cheered', 'challenges', 'cb', 'cb_in']) r[k] = r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) ? r[k] : {};
    delete r.collab_in; delete r.collabs; // Phase 7.0 Universe-based collab (removed in 7.5)
    for (const [id, v] of Object.entries(r.cb_in)) if (!v || now - v.at > CH_INVITE_MS) delete r.cb_in[id];
    r.cheers = Array.isArray(r.cheers) ? r.cheers.filter(c => c && now - c.at < CHEER_KEEP_MS).slice(-30) : [];
    r.sent = Array.isArray(r.sent) ? r.sent.filter(t => now - t < 86400000) : [];
    if (!PRIVACY.includes(r.privacy)) r.privacy = 'anyone';
    for (const side of ['out', 'in']) for (const [id, v] of Object.entries(r[side])) if (!v || now - v.at > EXPIRE_MS) delete r[side][id];
    const today = riyadhDay(now);
    for (const [id, d] of Object.entries(r.cheered)) if (d !== today) delete r.cheered[id];
    return r;
}

export class FriendsService {
    constructor(service) { this.service = service; this.storage = service.storage; this.liveCache = new Map(); }

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
            if (method === 'GET' && path === '/friends/challenges/live') return await this.challengeLive(me, now);
            if (method !== 'POST') fail(405, 'Method not allowed.');
            const action = path.slice('/friends/'.length);
            if (action.startsWith('challenge/')) return await this.challenge(me, action.slice(10), body || {}, now);
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
                    await this.endChallenges(tx, mine, theirs, me, target, now);
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
    // ---------------------------------------------------------------- Phase 7.5 / 7.6 challenges
    chId() { return 'ch_' + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); }
    // A 7.5 record (two people, scored straight from the points ledger) read as a 7.6 one. track_from stays null, so
    // its scores keep coming from the ledger until it ends; everything started in 7.6 is scored from its own log.
    static chUp(c) {
        if (!c || c.v === 2) return c;
        const members = { [c.from]: { s: 'in', at: c.at, color: 0 }, [c.to]: { s: c.status === 'pending' ? 'invited' : 'in', at: c.accepted_at || c.at, color: c.status === 'pending' ? null : 1 } };
        const out = { v: 2, id: c.id, from: c.from, type: 'time', metric: c.metric, days: c.days, target: null, prize: '', status: c.status, at: c.at, members,
            start: c.start || null, end: c.end || null, started_at: c.accepted_at || null, track_from: null, prog: {}, reached: {}, result: null };
        if (c.result) {
            out.result = { scores: c.result.scores || {}, winners: c.result.winner ? [c.result.winner] : [], how: c.result.forfeit ? 'forfeit' : 'deadline', at: c.result.at, target_missed: false };
            if (c.result.forfeit && members[c.result.forfeit]) members[c.result.forfeit].s = 'left';
        }
        return out;
    }
    async chLoad(id, store = this.storage) { const c = await store.get('challenge:' + id); return c && c.id === id ? FriendsService.chUp(c) : null; }
    async chSave(tx, c) { this.liveCache.delete(c.id); await tx.put('challenge:' + c.id, c); }
    static ins(c) { return Object.keys(c.members).filter(u => c.members[u].s === 'in'); }
    async ledger(uid, store = this.storage) {
        const link = await store.get('identity:' + uid);
        return link?.user ? await store.get('points:' + link.user) : null;
    }
    // One day of one contestant: their challenge log (7.6, caps applied) or, for a 7.5 challenge, their ledger.
    static chRow(c, uid, state, d) {
        if (c.track_from && d >= c.track_from) { const r = c.prog?.[uid]?.[d]; return { p: r?.p || 0, r: r?.r || 0 }; }
        const r = state?.days?.[d];
        return { p: r?.p || 0, r: r ? (r.r ?? r.n ?? 0) : 0 };
    }
    // main = the score; second = finished days (the streak tie-break).
    chScore(c, uid, state, today) {
        const P = globalThis.TaskitatorPoints;
        let main = 0, second = 0, run = 0;
        if (!c.start || c.start > today) return { main, second };
        const last = c.end < today ? c.end : today;
        for (let d = c.start, i = 0; d <= last && i < 40; d = shiftDay(d, 1), i++) {
            const r = FriendsService.chRow(c, uid, state, d);
            if (c.metric === 'points') main += r.p;
            else if (c.metric === 'tasks') main += r.r;
            else if (r.r > 0) { run++; second++; if (run > main) main = run; }
            else if (!((state && P.isFree(state, d)) || d === today)) run = 0; // a free day, or today not done yet, doesn't break the run
        }
        return { main, second };
    }
    async chScores(c, now, store = this.storage) {
        const today = riyadhDay(now), out = {};
        const needLedger = c.metric === 'streak' || !c.track_from; // free days, or a 7.5 challenge
        for (const [uid, m] of Object.entries(c.members)) {
            if (m.s !== 'in' && m.s !== 'left') continue;
            out[uid] = this.chScore(c, uid, needLedger ? await this.ledger(uid, store) : null, today);
        }
        return out;
    }
    // Standing: Amount = who reached the goal first, then the highest score; Time = the highest score
    // (Streak ties go to more finished days). People who left are always last.
    static chOrder(c, scores) {
        const s = u => scores?.[u] || { main: 0, second: 0 }, reached = c.reached || {};
        return Object.keys(c.members).filter(u => ['in', 'left'].includes(c.members[u].s)).sort((a, b) => {
            const la = c.members[a].s === 'left', lb = c.members[b].s === 'left';
            if (la !== lb) return la ? 1 : -1;
            if (c.type === 'amount') { const ra = reached[a] ?? Infinity, rb = reached[b] ?? Infinity; if (ra !== rb) return ra - rb; }
            return s(b).main - s(a).main || (c.metric === 'streak' ? s(b).second - s(a).second : 0);
        });
    }
    // Ends a running challenge when it's over: someone reached the goal (Amount), everyone else left, or the last day passed.
    async chSettle(tx, c, now) {
        if (c.status !== 'active') return false;
        const today = riyadhDay(now);
        const reachedBy = () => Object.keys(c.reached || {}).filter(u => c.members[u]?.s === 'in');
        let how = c.type === 'amount' && reachedBy().length ? 'target' : today > c.end ? 'deadline' : FriendsService.ins(c).length <= 1 ? 'forfeit' : null;
        if (!how) return false;
        if (how !== 'forfeit') { // a deleted account can't win
            for (const u of FriendsService.ins(c)) if (!await this.alive(u, tx)) c.members[u].s = 'left';
            if (how === 'target' && !reachedBy().length) how = today > c.end ? 'deadline' : FriendsService.ins(c).length <= 1 ? 'forfeit' : null;
            if (!how) return false;
        }
        const scores = await this.chScores(c, now, tx), ins = FriendsService.ins(c);
        let winners = [];
        if (how === 'target') winners = [FriendsService.chOrder(c, scores)[0]];
        else if (how === 'forfeit') winners = ins.slice(0, 1);
        else if (ins.length) {
            const top = FriendsService.chOrder(c, scores)[0], k = x => [scores[x].main, c.metric === 'streak' ? scores[x].second : 0].join(':');
            winners = ins.filter(u => k(u) === k(top));
        }
        c.status = 'finished';
        c.result = { scores, winners, how, at: now, target_missed: c.type === 'amount' && how !== 'target' };
        return true;
    }
    // Pending: starts on its own 48 h after it was sent if at least one friend joined; gone after 7 days.
    async chStart(tx, c, now, held = {}) {
        const start = shiftDay(riyadhDay(now), 1);
        for (const [u, m] of Object.entries(c.members)) {
            if (m.s === 'in') continue;
            delete c.members[u];
            await this.chUnindex(tx, u, c.id, held);
        }
        Object.assign(c, { status: 'active', start, end: shiftDay(start, c.days - 1), started_at: now, track_from: start, prog: {}, reached: {} });
        for (const u of FriendsService.ins(c)) { const l = (await tx.get('chl:' + u)) || {}; l[c.id] = c.end; await tx.put('chl:' + u, l); }
    }
    needsTick(c, now) {
        if (c.status === 'pending') return now - c.at > CH_INVITE_MS || (now - c.at >= CH_AUTOSTART_MS && FriendsService.ins(c).some(u => u !== c.from));
        if (c.status === 'active') return riyadhDay(now) > c.end || FriendsService.ins(c).length <= 1 || (c.type === 'amount' && Object.keys(c.reached || {}).length > 0);
        return now - (c.result?.at || 0) > CH_KEEP_MS;
    }
    async chTick(tx, c, now, held) {
        if (!this.needsTick(c, now)) return null;
        if (c.status === 'pending') {
            if (now - c.at >= CH_AUTOSTART_MS && FriendsService.ins(c).some(u => u !== c.from)) { await this.chStart(tx, c, now, held); return 'changed'; }
            return 'drop';
        }
        if (c.status === 'active') return await this.chSettle(tx, c, now) ? 'changed' : null;
        return 'drop';
    }
    async chUnindex(tx, uid, id, held = {}) {
        const r = held[uid] || await tx.get(key(uid));
        if (r?.challenges?.[id] !== undefined) { delete r.challenges[id]; if (!held[uid]) await tx.put(key(uid), r); }
        await this.chUnlive(tx, uid, id);
    }
    async chUnlive(tx, uid, id) {
        const l = await tx.get('chl:' + uid);
        if (l && l[id] !== undefined) { delete l[id]; await (Object.keys(l).length ? tx.put('chl:' + uid, l) : tx.delete('chl:' + uid)); }
    }
    async chDrop(tx, c, held = {}) {
        this.liveCache.delete(c.id);
        await tx.delete('challenge:' + c.id);
        for (const u of Object.keys(c.members)) await this.chUnindex(tx, u, c.id, held);
    }
    // Challenges a person is taking part in (joined, not finished).
    engaged(list, uid) { return list.filter(c => c && ['pending', 'active'].includes(c.status) && c.members[uid]?.s === 'in').length; }
    async chAll(rec, store = this.storage) { return (await Promise.all(Object.keys(rec.challenges || {}).filter(id => chPattern.test(id)).map(id => this.chLoad(id, store)))).filter(Boolean); }

    /* Phase 7.6: called inside the sync transaction with what P.record just awarded. One read when you're in no
       running challenge. Anti-cheat: only completions inside the challenge's days count, a task must be at least
       5 minutes old when finished, and each day counts at most CH_DAY_POINTS points and CH_DAY_TASKS tasks. The
       ledger already awards each task once, caps 150 a day, ignores cascades and refuses backdating past 7 days. */
    async chRecord(tx, uid, awards, state, now) {
        if (!awards?.length) return;
        const live = await tx.get('chl:' + uid);
        if (!live || typeof live !== 'object' || !Object.keys(live).length) return;
        const today = riyadhDay(now);
        let dirty = false;
        for (const [id, end] of Object.entries(live)) {
            const c = typeof end === 'string' && end >= shiftDay(today, -CH_LATE_DAYS) && chPattern.test(id) ? await this.chLoad(id, tx) : null;
            if (!c || c.status !== 'active' || c.members[uid]?.s !== 'in') { delete live[id]; dirty = true; continue; }
            if (c.type === 'amount' && Object.keys(c.reached || {}).length) continue; // someone already won
            const prog = c.prog[uid] || {};
            let hit = false;
            for (const a of awards) {
                if (!a || a.day < c.start || a.day > c.end || !(a.at >= c.started_at)) continue;
                if (Number.isFinite(a.created) && a.at - a.created < CH_MIN_AGE_MS) continue;
                const row = prog[a.day] || { p: 0, r: 0 };
                const p = Math.max(0, Math.min(Math.floor(a.p) || 0, CH_DAY_POINTS - row.p)), r = a.req && row.r < CH_DAY_TASKS ? 1 : 0;
                if (p || r) { row.p += p; row.r += r; prog[a.day] = row; hit = true; }
            }
            if (!hit) continue;
            c.prog[uid] = prog;
            if (c.type === 'amount' && this.chScore(c, uid, state, today).main >= c.target) c.reached[uid] = now; // the server's time, not the device's
            await this.chSave(tx, c);
        }
        if (dirty) await (Object.keys(live).length ? tx.put('chl:' + uid, live) : tx.delete('chl:' + uid));
    }

    async challenge(me, action, body, now) {
        const pro = action === 'create' ? await this.isPro(me) : true; // may call the licence service: outside the transaction
        const gone = () => ({ __error: { status: 404, message: 'This challenge is no longer available.', code: 'CHALLENGE_GONE' } });
        return this.storage.transaction(async tx => {
            const mine = clean(await tx.get(key(me)), now), held = { [me]: mine };
            if (action === 'create') {
                const raw = Array.isArray(body.ids) ? body.ids : typeof body.id === 'string' ? [body.id] : [];
                const ids = [...new Set(raw)].filter(x => typeof x === 'string' && idPattern.test(x) && x !== me);
                if (!ids.length || ids.length > CH_MEMBERS - 1 || ids.length !== raw.length) fail(400, `Choose 1 to ${CH_MEMBERS - 1} friends.`, 'CHALLENGE_MEMBERS');
                const type = body.type === undefined ? 'time' : CH_TYPES.includes(body.type) ? body.type : fail(400, 'Choose Time or Amount.', 'CHALLENGE_TYPE');
                const metric = CH_METRICS.includes(body.metric) ? body.metric : fail(400, 'Choose Points, Tasks or Streak.', 'CHALLENGE_METRIC');
                const days = body.days === undefined ? CH_DEFAULT_DAYS : body.days;
                if (!Number.isInteger(days) || days < 1 || days > CH_MAX_DAYS) fail(400, `A challenge lasts 1 to ${CH_MAX_DAYS} days.`, 'CHALLENGE_DAYS');
                let target = null;
                if (type === 'amount') {
                    const [lo, hi] = chGoalRange(metric, days);
                    if (lo > hi) fail(400, 'A Streak goal needs at least 2 days.', 'CHALLENGE_TARGET');
                    if (!Number.isInteger(body.target) || body.target < lo || body.target > hi) fail(400, `Choose a goal from ${lo} to ${hi}.`, 'CHALLENGE_TARGET');
                    target = body.target;
                }
                const prize = chPrize(body.prize);
                const color = body.color === undefined ? 0 : chColor(body.color);
                const others = {};
                for (const u of ids) {
                    const r = clean(await tx.get(key(u)), now);
                    if (!mine.friends[u] || !r.friends[me] || r.blocked[me]) fail(403, 'You can only challenge friends.', 'CHALLENGE_NOT_FRIENDS');
                    if (Object.keys(r.challenges).length >= CH_LIST) fail(409, 'A friend already has too many challenges listed.', 'CHALLENGE_PENDING_LIMIT');
                    others[u] = r;
                }
                if (!pro) fail(403, 'Starting a challenge needs Pro. Your friends don’t need it to join.', 'CHALLENGE_PRO');
                if (this.engaged(await this.chAll(mine, tx), me) >= CH_ACTIVE) fail(409, `You can be in ${CH_ACTIVE} challenges at a time.`, 'CHALLENGE_ACTIVE_LIMIT');
                if (Object.keys(mine.challenges).length >= CH_LIST) fail(409, 'Remove a finished challenge first.', 'CHALLENGE_PENDING_LIMIT');
                const c = { v: 2, id: this.chId(), from: me, type, metric, days, target, prize, status: 'pending', at: now,
                    members: { [me]: { s: 'in', at: now, color } }, start: null, end: null, started_at: null, track_from: null, prog: {}, reached: {}, result: null };
                for (const u of ids) { c.members[u] = { s: 'invited', at: now, color: null }; others[u].challenges[c.id] = now; await tx.put(key(u), others[u]); }
                mine.challenges[c.id] = now;
                await this.chSave(tx, c); await tx.put(key(me), mine);
                return { ok: true, id: c.id, auto_start_at: c.at + CH_AUTOSTART_MS };
            }
            const id = typeof body.id === 'string' && chPattern.test(body.id) ? body.id : fail(400, 'Choose a challenge.');
            const c = mine.challenges[id] !== undefined ? await this.chLoad(id, tx) : null;
            if (!c || !c.members[me]) return gone();
            const tick = await this.chTick(tx, c, now, held);
            if (tick === 'drop') { await this.chDrop(tx, c, held); await tx.put(key(me), mine); return gone(); }
            if (tick) await this.chSave(tx, c);
            if (!c.members[me]) { await tx.put(key(me), mine); return gone(); } // it started without you
            const m = c.members[me], creator = c.from === me;
            const done = async (extra = {}) => { await this.chSave(tx, c); await tx.put(key(me), mine); return { ok: true, ...extra }; };
            if (action === 'accept') {
                if (c.status !== 'pending' || m.s !== 'invited') fail(409, c.status === 'active' ? 'This challenge already started. Nobody can join now.' : 'This challenge isn’t waiting for you.', 'CHALLENGE_STATE');
                if (this.engaged(await this.chAll(mine, tx), me) >= CH_ACTIVE) fail(409, `You can be in ${CH_ACTIVE} challenges at a time.`, 'CHALLENGE_ACTIVE_LIMIT');
                const used = new Set(Object.values(c.members).map(x => x.color).filter(Number.isInteger));
                const want = body.color === undefined ? null : chColor(body.color);
                m.s = 'in'; m.at = now;
                m.color = want !== null && !used.has(want) ? want : [...Array(CH_COLORS).keys()].find(i => !used.has(i)) ?? 0;
                return done({ auto_start_at: c.at + CH_AUTOSTART_MS });
            }
            if (action === 'decline' || action === 'leave') {
                if (c.status !== 'pending' || creator || m.s !== (action === 'decline' ? 'invited' : 'in')) fail(409, action === 'leave' && c.status === 'active' ? 'It already started. Forfeit instead.' : 'This challenge can’t be ' + (action === 'decline' ? 'declined' : 'left') + ' now.', 'CHALLENGE_STATE');
                delete c.members[me];
                await this.chUnindex(tx, me, id, held);
                return done();
            }
            if (action === 'start') {
                if (!creator || c.status !== 'pending') fail(409, 'Only the person who sent it can start it, before it starts.', 'CHALLENGE_STATE');
                if (!FriendsService.ins(c).some(u => u !== me)) fail(409, 'Wait until at least one friend joins.', 'CHALLENGE_STATE');
                await this.chStart(tx, c, now, held);
                return done({ start: c.start, end: c.end });
            }
            if (action === 'cancel') {
                if (!creator || c.status !== 'pending') fail(409, c.status === 'active' ? 'A running challenge can’t be cancelled. Forfeit instead.' : 'This challenge can’t be cancelled now.', 'CHALLENGE_STATE');
                await this.chDrop(tx, c, held); await tx.put(key(me), mine);
                return { ok: true };
            }
            if (action === 'forfeit') {
                if (c.status !== 'active' || m.s !== 'in') fail(409, 'Only a running challenge can be forfeited.', 'CHALLENGE_STATE');
                m.s = 'left'; m.left_at = now;
                await this.chUnlive(tx, me, id); // stop logging; stays listed
                await this.chSettle(tx, c, now);
                return done();
            }
            if (action === 'color') {
                if (!['pending', 'active'].includes(c.status) || m.s !== 'in') fail(409, 'Join the challenge first.', 'CHALLENGE_STATE');
                const want = chColor(body.color);
                if (Object.entries(c.members).some(([u, x]) => u !== me && x.color === want)) fail(409, 'Someone in this challenge already has that color.', 'CHALLENGE_COLOR');
                m.color = want;
                return done();
            }
            if (action === 'dismiss') { // hide a finished one from your own list
                if (c.status !== 'finished') fail(409, 'Only a finished challenge can be removed.', 'CHALLENGE_STATE');
                delete mine.challenges[id];
                let listed = false;
                for (const u of Object.keys(c.members)) if (u !== me && (await tx.get(key(u)))?.challenges?.[id] !== undefined) listed = true;
                if (!listed) { this.liveCache.delete(id); await tx.delete('challenge:' + id); }
                await tx.put(key(me), mine);
                return { ok: true };
            }
            fail(404, 'Endpoint not found.');
        });
    }
    // Phase 7.6 blocking: you forfeit running challenges you share with them (so blocking a leader can't void a race);
    // a waiting one is cancelled if you sent it, otherwise you leave it.
    async endChallenges(tx, mine, theirs, me, target, now = Date.now()) {
        const held = { [me]: mine, [target]: theirs };
        for (const c of await this.chAll(mine, tx)) {
            if (!c.members[target]) continue;
            if (c.status === 'pending') {
                if (c.from === me) await this.chDrop(tx, c, held);
                else { delete c.members[me]; await this.chUnindex(tx, me, c.id, held); await this.chSave(tx, c); }
            } else if (c.status === 'active' && c.members[me]?.s === 'in') {
                c.members[me].s = 'left'; c.members[me].left_at = now;
                await this.chUnlive(tx, me, c.id);
                await this.chSettle(tx, c, now);
                await this.chSave(tx, c);
            }
        }
    }
    async names(c) { const out = {}; for (const u of Object.keys(c.members)) out[u] = await this.username(u) || 'Taskitator user'; return out; }
    // Every challenge in my list, settled and started as needed. Ticks only open a transaction when something is due.
    async chMine(me, now) {
        const rec = clean(await this.storage.get(key(me)), now), out = [];
        for (const id of Object.keys(rec.challenges)) {
            let c = chPattern.test(id) ? await this.chLoad(id) : null;
            if (!c || !c.members[me] || this.needsTick(c, now)) {
                c = await this.storage.transaction(async tx => {
                    const r = clean(await tx.get(key(me)), now), cur = chPattern.test(id) ? await this.chLoad(id, tx) : null;
                    if (!cur || !cur.members[me]) { delete r.challenges[id]; await tx.put(key(me), r); return null; }
                    const tick = await this.chTick(tx, cur, now, { [me]: r });
                    if (tick === 'drop') { await this.chDrop(tx, cur, { [me]: r }); await tx.put(key(me), r); return null; }
                    if (tick) { await this.chSave(tx, cur); await tx.put(key(me), r); }
                    return cur.members[me] ? cur : null;
                });
                if (!c) continue;
            }
            out.push(c);
        }
        return out;
    }
    // Scores + usernames, cached for 45 s per challenge (cleared whenever it changes), so many viewers cost little.
    async chLive(c, now) {
        const hit = this.liveCache.get(c.id);
        if (hit && now - hit.at < CH_LIVE_CACHE_MS && hit.status === c.status) return hit;
        const scores = c.status === 'finished' ? c.result.scores : c.status === 'active' && riyadhDay(now) >= c.start ? await this.chScores(c, now) : {};
        const entry = { at: now, status: c.status, scores, names: await this.names(c) };
        this.liveCache.set(c.id, entry);
        if (this.liveCache.size > 500) this.liveCache.delete(this.liveCache.keys().next().value);
        return entry;
    }
    chView(c, me, now, live) {
        const today = riyadhDay(now), order = FriendsService.chOrder(c, live.scores);
        const people = [...order, ...Object.keys(c.members).filter(u => !order.includes(u))];
        const mine = c.members[me];
        const res = c.result, outcome = c.status !== 'finished' ? null : res.winners.includes(me) ? (res.winners.length > 1 ? 'draw' : 'win') : res.winners.length ? 'loss' : 'draw';
        return {
            id: c.id, mine: c.from === me, type: c.type, metric: c.metric, days: c.days, target: c.target, prize: c.prize || '',
            status: c.status, at: c.at, start: c.start, end: c.end, today, auto_start_at: c.status === 'pending' ? c.at + CH_AUTOSTART_MS : null,
            state: mine?.s || null, color: mine?.color ?? null, legacy: !c.track_from && c.status !== 'pending',
            by: live.names[c.from],
            members: people.map(u => ({ me: u === me, username: live.names[u], color: c.members[u].color, state: c.members[u].s, creator: u === c.from,
                main: live.scores[u]?.main ?? 0, second: live.scores[u]?.second ?? 0, reached_at: c.reached?.[u] ?? null })),
            result: outcome ? { outcome, how: res.how, winners: res.winners.map(u => live.names[u]), target_missed: Boolean(res.target_missed), forfeit: mine?.s === 'left' } : null
        };
    }
    async challengeList(me, now) {
        const out = [];
        for (const c of await this.chMine(me, now)) out.push(this.chView(c, me, now, await this.chLive(c, now)));
        const order = { pending: 0, active: 1, finished: 2 };
        return out.sort((a, b) => order[a.status] - order[b.status] || b.at - a.at);
    }
    // GET /friends/challenges/live: what the Today race bar shows (running ones you're in, waiting ones you joined,
    // and ones that ended in the last 24 hours).
    async challengeLive(me, now) {
        const out = [];
        for (const c of await this.chMine(me, now)) {
            const s = c.members[me]?.s;
            const show = (c.status === 'active' && ['in', 'left'].includes(s)) || (c.status === 'pending' && s === 'in') ||
                (c.status === 'finished' && now - (c.result?.at || 0) < CH_RECENT_MS && ['in', 'left'].includes(s));
            if (show) out.push(this.chView(c, me, now, await this.chLive(c, now)));
        }
        const order = { active: 0, pending: 1, finished: 2 };
        return { today: riyadhDay(now), challenges: out.sort((a, b) => order[a.status] - order[b.status] || a.at - b.at) };
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
            cheers, week_start: weekStart,
            limits: { friends: FRIEND_LIMIT, outgoing: OUT_LIMIT, challenge_days: CH_MAX_DAYS, challenge_default: CH_DEFAULT_DAYS, challenge_active: CH_ACTIVE,
                challenge_members: CH_MEMBERS, challenge_colors: CH_COLORS, challenge_prize: CH_PRIZE, challenge_goal_min: CH_GOAL_MIN, challenge_goal_day: CH_GOAL_DAY, collab: this.service.collab?.LIMITS?.members || 6 },
            challenges: await this.challengeList(me, now),
            ...(this.service.collab ? await this.service.collab.listFor(me, now) : { collabs: [], collab_invites: [] })
        };
    }
}
export const FRIEND_LIMITS = Object.freeze({ FRIEND_LIMIT, OUT_LIMIT, DAILY_REQUESTS, EXPIRE_MS, CH_MAX_DAYS, CH_DEFAULT_DAYS, CH_ACTIVE, CH_PENDING,
    CH_MEMBERS, CH_AUTOSTART_MS, CH_LIST, CH_COLORS, CH_PRIZE, CH_DAY_POINTS, CH_DAY_TASKS, CH_MIN_AGE_MS });
export { key as friendsKey, clean as cleanFriends, FriendError, riyadhDay };

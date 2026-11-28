/* Phase 7.5: Collab, a shared task tree for friends. Plain Durable Object storage (no D1, R2, AI or Universe).
   Records
     cb:<cid>              {v:1, id, owner, members:[uid] (owner first), invited:{uid:at}, rev, at, total, done, ncomments}
     cbt:<cid>:<tid>       {id, parent, title, notes, due, assignees:[uid], done:{at,by}|null, at, ord}   root id = 'root'
     cbm:<cid>:<at>-<rnd>  {id, by, at, text}
     friends:<uid>.cb      {cid: at}           collabs the person is in (owner or member)
     friends:<uid>.cb_in   {cid: {from, at}}   invitations waiting (7 days)
   Rules
   - The person who starts it (owner) edits everything: tasks, notes, due dates, assignees and who is invited.
   - Members complete what they're assigned: their task and everything under it. Completing a task completes its
     whole subtree; reopening reopens that task and any finished task above it. The owner can complete anything.
   - Several people can share one assignment. Anyone may be assigned while still invited.
   - Pro for everyone: creating, being invited, joining and every change (tasks, assignees, invites, completing)
     need an active Pro licence for every member. Reading, comments, leaving, removing someone and deleting never do.
   - Comments: anyone in the collab, up to 300 characters, timestamped to the second; the author deletes their own.
   - Collab tasks never earn points or count toward streaks or phone lock (they aren't personal tasks).
   - Limits: owner + 5 friends, 150 tasks, 6 levels deep, 200 comments (oldest dropped), 10 collabs per person.
   Phase 7.6
   - Completing the main (root) task finishes the collab for everyone: it becomes read-only (no tasks, assignments,
     invites or comments), waiting invitations are dropped, and everything is deleted 7 days later (on the next read
     after that; the owner can delete it sooner). Finished collabs don't count toward the 10-per-person limit
     (friends:<uid>.cb[cid] becomes {done: purge_at}). "Leave" on a finished collab only removes it from your list.
   - A member with nothing assigned is a viewer (shown in the UI); a viewer still needs Pro, like everyone.
   Phase 7.7 (collab-locks.js): an owner can lock a task (AI check with criteria, shield, phone lock). Assignees of a
     locked task must accept before it binds them (consent {uid:{s:'pending'|'yes'|'no', at, req?, bypass?}}); accepting
     puts a linked copy in their own task list. After accepting they can't unassign themselves or leave without the
     owner's release (release / release_request). AI-checked tasks complete only through the copy's proof.
   - Every change bumps rev. GET /collab/<cid>?rev=N answers {unchanged:true} when nothing changed (cheap polling). */
import { friendsKey as key, cleanFriends as clean, FriendError } from './friends-backend.js';
import { CollabLocks, cleanLocks, hasLocks, mirrorId, LockError } from './collab-locks.js';

export const COLLAB_LIMITS = Object.freeze({ members: 6, tasks: 150, depth: 6, comments: 200, perPerson: 10, title: 150, notes: 600, comment: 300, invite_ms: 7 * 86400000, keep_ms: 7 * 86400000 });
const L = COLLAB_LIMITS;
const cidPattern = /^cb[a-f0-9]{20}$/, tidPattern = /^(root|t[a-f0-9]{12})$/, uidPattern = /^[A-Za-z0-9_|-]{1,128}$/, mPattern = /^\d{13}-[a-f0-9]{8}$/;
const fail = (status, message, code) => { throw new FriendError(status, message, code || 'COLLAB'); };
// Durable Object storage deletes at most 128 keys per call.
const delMany = async (tx, keys) => { for (let i = 0; i < keys.length; i += 128) await tx.delete(keys.slice(i, i + 128)); };
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const text = (v, max, what, required) => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v == null ? '' : fail(400, `Check the ${what}.`);
    if (required && !s) fail(400, `Give it a ${what}.`, 'COLLAB_TEXT');
    if (s.length > max) fail(400, `The ${what} can be up to ${max} characters.`, 'COLLAB_TEXT');
    return s;
};
const notesOf = v => {
    const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : v == null ? '' : fail(400, 'Check the notes.');
    if (s.length > L.notes) fail(400, `Notes can be up to ${L.notes} characters.`, 'COLLAB_TEXT');
    return s;
};
const activeCount = cb => Object.values(cb || {}).filter(v => typeof v === 'number').length; // finished ones are {done}
const dueOf = v => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) fail(400, 'Choose a valid due date.', 'COLLAB_DUE');
    return v;
};

export class CollabService {
    constructor(service, friends) { this.service = service; this.storage = service.storage; this.friends = friends; this.LIMITS = L; this.locks = new CollabLocks(this); }
    // Phase 7.7: open consent requests per person, so the Friends list can say "needs your OK" without loading tasks.
    consentCount(m, tasks) {
        const n = {};
        for (const t of tasks) if (t.locks && !t.done) for (const [u, c] of Object.entries(t.consent || {})) if (c.s === 'pending' || (c.req && u !== m.owner)) {
            const who = c.s === 'pending' ? u : m.owner; n[who] = (n[who] || 0) + 1;
        }
        m.consent_open = n;
    }

    isPro(uid) { return this.friends.isPro(uid); }
    async proMissing(uids) {
        const out = [];
        for (const uid of uids) if (!await this.isPro(uid)) out.push(await this.friends.username(uid) || 'a member');
        return out;
    }
    async meta(cid, store = this.storage) { const m = await store.get('cb:' + cid); return m && m.v === 1 && m.id === cid ? m : null; }
    async tasks(cid, store = this.storage) { return [...(await store.list({ prefix: 'cbt:' + cid + ':' })).values()]; }
    async comments(cid, store = this.storage) { return [...(await store.list({ prefix: 'cbm:' + cid + ':' })).values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)); }
    count(tasks) { return { total: tasks.length, done: tasks.filter(t => t.done).length }; }

    // Everything about a collab, gone (owner deleted it or the owner's account is gone).
    async wipe(tx, m) {
        await this.locks.releaseAll(tx, m, await this.tasks(m.id, tx)); // Phase 7.7: open copies leave everyone's lists
        for (const prefix of ['cbt:' + m.id + ':', 'cbm:' + m.id + ':']) { await delMany(tx, [...(await tx.list({ prefix })).keys()]); }
        await tx.delete('cb:' + m.id);
        for (const uid of [...m.members, ...Object.keys(m.invited || {})]) {
            const r = await tx.get(key(uid));
            if (r && ((r.cb && r.cb[m.id] !== undefined) || (r.cb_in && r.cb_in[m.id]))) { if (r.cb) delete r.cb[m.id]; if (r.cb_in) delete r.cb_in[m.id]; await tx.put(key(uid), r); }
        }
    }
    async usernames(uids) { const out = {}; for (const u of uids) out[u] = await this.friends.username(u) || 'Taskitator user'; return out; }

    // For the Friends page.
    async listFor(me, now) {
        const rec = clean(await this.storage.get(key(me)), now), collabs = [], collab_invites = [];
        let dirty = false;
        for (const cid of Object.keys(rec.cb)) {
            const m = cidPattern.test(cid) ? await this.meta(cid) : null;
            if (!m || !m.members.includes(me)) { delete rec.cb[cid]; dirty = true; continue; }
            if (!await this.friends.alive(m.owner) || (m.finished && now >= m.purge_at)) { await this.storage.transaction(tx => this.wipe(tx, m)); continue; }
            const names = await this.usernames(m.members.filter(u => u !== me));
            collabs.push({ id: cid, title: m.title, owner: m.owner === me, owner_name: m.owner === me ? null : names[m.owner], members: Object.values(names), total: m.total, done: m.done, at: m.at, rev: m.rev,
                finished: m.finished ? m.finished.at : null, purge_at: m.finished ? m.purge_at : null, needs_ok: m.consent_open?.[me] || 0 });
        }
        for (const [cid, v] of Object.entries(rec.cb_in)) {
            const m = cidPattern.test(cid) ? await this.meta(cid) : null;
            if (!m || !m.invited?.[me]) { delete rec.cb_in[cid]; dirty = true; continue; }
            collab_invites.push({ id: cid, title: m.title, from: m.owner, username: await this.friends.username(m.owner) || 'A friend', at: v.at });
        }
        if (dirty) await this.storage.transaction(async tx => { const r = clean(await tx.get(key(me)), now); for (const k of Object.keys(r.cb)) if (!rec.cb[k]) delete r.cb[k]; for (const k of Object.keys(r.cb_in)) if (!rec.cb_in[k]) delete r.cb_in[k]; await tx.put(key(me), r); });
        return { collabs: collabs.sort((a, b) => b.at - a.at), collab_invites };
    }

    async handle(identity, path, method, body, query) {
        const me = identity.userId, now = Date.now();
        try {
            if (method === 'GET') {
                const m = /^\/collab\/(cb[a-f0-9]{20})$/.exec(path);
                if (!m) fail(404, 'Endpoint not found.');
                return await this.view(me, m[1], query, now);
            }
            if (method !== 'POST') fail(405, 'Method not allowed.');
            const action = path.slice('/collab/'.length);
            if (action === 'create') return await this.create(me, body || {}, now);
            const cid = typeof body?.id === 'string' && cidPattern.test(body.id) ? body.id : fail(400, 'Choose a collab.');
            return await this.act(me, cid, action, body, now);
        } catch (e) {
            if (e instanceof FriendError || e instanceof LockError) return { __error: { status: e.status, message: e.message, code: e.code } };
            throw e;
        }
    }

    async view(me, cid, query, now) {
        const m = await this.meta(cid);
        if (!m || !(m.members.includes(me) || m.invited?.[me])) fail(404, 'This collab doesn’t exist or you’re not in it.', 'COLLAB_GONE');
        if (!await this.friends.alive(m.owner)) { await this.storage.transaction(tx => this.wipe(tx, m)); fail(404, 'This collab no longer exists.', 'COLLAB_GONE'); }
        if (m.finished && now >= m.purge_at) { await this.storage.transaction(tx => this.wipe(tx, m)); fail(404, 'This collab finished and its data was deleted.', 'COLLAB_GONE'); }
        if (query?.rev !== undefined && Number(query.rev) === m.rev) return { unchanged: true, rev: m.rev };
        const [tasks, comments] = await Promise.all([this.tasks(cid), this.comments(cid)]);
        const people = [...new Set([...m.members, ...Object.keys(m.invited || {}), ...(m.finished ? [m.finished.by] : [])])];
        const names = await this.usernames(people);
        const missing = [];
        for (const u of m.members) if (!await this.isPro(u)) missing.push(names[u]);
        return {
            id: cid, rev: m.rev, title: m.title, owner: m.owner, me, at: m.at, can_edit: m.owner === me && !m.finished, joined: m.members.includes(me),
            finished: m.finished ? { at: m.finished.at, by: m.finished.by, username: names[m.finished.by] || 'Former member' } : null, purge_at: m.finished ? m.purge_at : null,
            members: m.members.map(u => ({ id: u, username: names[u], owner: u === m.owner })),
            invited: Object.keys(m.invited || {}).map(u => ({ id: u, username: names[u], at: m.invited[u] })),
            pro_ok: !missing.length, pro_missing: missing,
            tasks: tasks.map(t => ({ id: t.id, parent: t.parent, title: t.title, notes: t.notes, due: t.due, assignees: t.assignees, done: t.done, ord: t.ord, at: t.at,
                locks: t.locks || null, consent: t.locks ? (t.consent || {}) : {} })),
            comments: comments.map(c => ({ id: c.id, by: c.by, username: names[c.by] || 'Former member', at: c.at, text: c.text, mine: c.by === me })),
            limits: L
        };
    }

    async create(me, body, now) {
        const title = text(body.title, L.title, 'name', true);
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(x => typeof x === 'string' && uidPattern.test(x) && x !== me) : [];
        if (!ids.length || ids.length > L.members - 1) fail(400, `Choose 1 to ${L.members - 1} friends.`, 'COLLAB_MEMBERS');
        const mine = clean(await this.storage.get(key(me)), now);
        for (const uid of ids) {
            const theirs = clean(await this.storage.get(key(uid)), now);
            if (!mine.friends[uid] || !theirs.friends[me] || theirs.blocked[me]) fail(403, 'You can only start a collab with friends.', 'COLLAB_NOT_FRIENDS');
        }
        if (activeCount(mine.cb) >= L.perPerson) fail(409, `You can be in ${L.perPerson} collabs at a time.`, 'COLLAB_LIMIT');
        if (!await this.isPro(me)) fail(403, 'Collab needs Pro. Everyone in a collab needs an active Pro license.', 'COLLAB_PRO');
        const missing = await this.proMissing(ids);
        if (missing.length) fail(403, `Everyone in a collab needs Pro. Not on Pro: ${missing.map(n => '@' + n).join(', ')}.`, 'COLLAB_PRO');
        const cid = 'cb' + hex(10);
        await this.storage.transaction(async tx => {
            const m = { v: 1, id: cid, owner: me, title, members: [me], invited: Object.fromEntries(ids.map(u => [u, now])), rev: 1, at: now, total: 1, done: 0, ncomments: 0 };
            await tx.put('cb:' + cid, m);
            await tx.put('cbt:' + cid + ':root', { id: 'root', parent: null, title, notes: notesOf(body.notes), due: dueOf(body.due), assignees: [], done: null, at: now, ord: 0 });
            const r = clean(await tx.get(key(me)), now); r.cb[cid] = now; await tx.put(key(me), r);
            for (const uid of ids) { const t = clean(await tx.get(key(uid)), now); t.cb_in[cid] = { from: me, at: now }; await tx.put(key(uid), t); }
        });
        return { ok: true, id: cid };
    }

    // Phase 7.6: root completed. Read-only from now on; deleted keep_ms later.
    async finish(tx, m, by, now) {
        m.finished = { at: now, by }; m.purge_at = now + L.keep_ms;
        for (const uid of Object.keys(m.invited || {})) { const r = await tx.get(key(uid)); if (r?.cb_in?.[m.id]) { delete r.cb_in[m.id]; await tx.put(key(uid), r); } }
        m.invited = {};
        for (const uid of m.members) { const r = await tx.get(key(uid)); if (r?.cb && r.cb[m.id] !== undefined) { r.cb[m.id] = { done: m.purge_at }; await tx.put(key(uid), r); } }
    }

    async act(me, cid, action, body, now) {
        const first = await this.meta(cid);
        if (!first) fail(404, 'This collab no longer exists.', 'COLLAB_GONE');
        const inIt = first.members.includes(me), invitedMe = Boolean(first.invited?.[me]), owner = first.owner === me;
        if (!inIt && !invitedMe) fail(404, 'This collab doesn’t exist or you’re not in it.', 'COLLAB_GONE');
        const FINISHED_OK = ['leave', 'delete', 'decline'];
        const finishedFail = () => fail(409, 'This collab is finished. It’s read-only now.', 'COLLAB_FINISHED');
        if (first.finished && !FINISHED_OK.includes(action)) finishedFail();
        // Pro is checked before the transaction (it may call the licence service); the transaction then makes sure
        // the member list it was checked against is still the current one.
        const PRO_FREE = ['decline', 'leave', 'delete', 'remove', 'comment', 'uncomment', 'refuse', 'release', 'release_request']; // a lock can always be refused or released
        let checked = null;
        if (!PRO_FREE.includes(action) && !first.finished) {
            const people = action === 'accept' ? [...first.members, me] : first.members;
            const missing = await this.proMissing(people);
            if (action === 'invite') {
                const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(x => typeof x === 'string' && uidPattern.test(x)) : [];
                missing.push(...await this.proMissing(ids.filter(u => !first.members.includes(u))));
            }
            if (missing.length) fail(403, action === 'accept' && !await this.isPro(me) ? 'Collab needs Pro. Everyone in a collab needs an active Pro license.'
                : `Everyone in this collab needs Pro to make changes. Not on Pro: ${missing.map(n => '@' + n).join(', ')}. You can still read, comment or leave.`, 'COLLAB_PRO');
            checked = first.members.join(',');
        }
        return this.storage.transaction(async tx => {
            const m = await this.meta(cid, tx);
            if (!m) fail(404, 'This collab no longer exists.', 'COLLAB_GONE');
            if (checked !== null && m.members.join(',') !== checked) fail(409, 'The collab just changed. Try again.', 'COLLAB_RETRY');
            if (m.finished && !FINISHED_OK.includes(action)) finishedFail();
            const bump = async () => { m.rev++; await tx.put('cb:' + cid, m); return { ok: true, rev: m.rev }; };
            const needOwner = () => { if (m.owner !== me) fail(403, 'Only the person who started this collab can change it.', 'COLLAB_OWNER'); };
            const needMember = () => { if (!m.members.includes(me)) fail(403, 'Join the collab first.', 'COLLAB_NOT_MEMBER'); };
            const recount = async () => { const list = await this.tasks(cid, tx); Object.assign(m, this.count(list)); this.consentCount(m, list); };
            const ownerName = async () => await this.friends.username(m.owner, tx) || 'the owner';
            const getTask = async tid => {
                if (typeof tid !== 'string' || !tidPattern.test(tid)) fail(400, 'Choose a task.');
                const t = await tx.get('cbt:' + cid + ':' + tid);
                return t || fail(404, 'This task no longer exists.', 'COLLAB_TASK_GONE');
            };

            if (action === 'accept' || action === 'decline') {
                if (!m.invited?.[me]) fail(404, 'This collab invitation is no longer waiting.', 'COLLAB_GONE');
                const r = clean(await tx.get(key(me)), now);
                if (action === 'accept') {
                    if (now - m.invited[me] > L.invite_ms) fail(404, 'This invitation expired. Ask for a new one.', 'COLLAB_GONE');
                    if (activeCount(r.cb) >= L.perPerson) fail(409, `You can be in ${L.perPerson} collabs at a time. Leave one first.`, 'COLLAB_LIMIT');
                    if (m.members.length >= L.members) fail(409, 'This collab is full.', 'COLLAB_FULL');
                    m.members.push(me); r.cb[cid] = now;
                } else {
                    for (const t of await this.tasks(cid, tx)) if (t.assignees.includes(me)) { t.assignees = t.assignees.filter(u => u !== me); if (t.consent) delete t.consent[me]; await tx.put('cbt:' + cid + ':' + t.id, t); }
                }
                delete m.invited[me]; delete r.cb_in[cid];
                if (action === 'decline') await recount();
                await tx.put(key(me), r);
                return { ...(await bump()), id: cid };
            }
            if (action === 'delete') { needOwner(); await this.wipe(tx, m); return { ok: true }; }
            if (action === 'leave' && m.finished) { // just off your list; the record stays for the others until it's deleted
                const r = await tx.get(key(me));
                if (r?.cb?.[cid] !== undefined) { delete r.cb[cid]; await tx.put(key(me), r); }
                return { ok: true };
            }
            if (action === 'leave' || action === 'remove') {
                const uid = action === 'leave' ? me : (typeof body.uid === 'string' && uidPattern.test(body.uid) ? body.uid : fail(400, 'Choose a person.'));
                if (action === 'remove') needOwner();
                if (uid === m.owner) fail(400, action === 'leave' ? 'You started this collab. Delete it instead of leaving.' : 'The owner can’t be removed.', 'COLLAB_OWNER');
                if (!m.members.includes(uid) && !m.invited?.[uid]) fail(404, 'They aren’t in this collab.', 'COLLAB_NOT_MEMBER');
                const list = await this.tasks(cid, tx);
                if (action === 'leave' && list.some(t => t.locks && !t.done && t.consent?.[me]?.s === 'yes'))
                    fail(409, `You agreed to locked tasks here. Ask @${await ownerName()} to release you first.`, 'COLLAB_LOCKED');
                await this.locks.releaseAll(tx, m, list, uid); // removing someone releases them
                m.members = m.members.filter(u => u !== uid); delete m.invited[uid];
                for (const t of list) if (t.assignees.includes(uid)) { t.assignees = t.assignees.filter(u => u !== uid); if (t.consent) delete t.consent[uid]; await tx.put('cbt:' + cid + ':' + t.id, t); }
                this.consentCount(m, list);
                const r = await tx.get(key(uid));
                if (r) { if (r.cb) delete r.cb[cid]; if (r.cb_in) delete r.cb_in[cid]; await tx.put(key(uid), r); }
                return bump();
            }
            if (action === 'invite') {
                needOwner();
                const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(x => typeof x === 'string' && uidPattern.test(x) && x !== me && !m.members.includes(x) && !m.invited[x]) : [];
                if (!ids.length) fail(400, 'Choose friends to invite.', 'COLLAB_MEMBERS');
                if (m.members.length + Object.keys(m.invited).length + ids.length > L.members) fail(409, `A collab has at most ${L.members} people, you included.`, 'COLLAB_FULL');
                const mine = clean(await tx.get(key(me)), now);
                for (const uid of ids) {
                    const theirs = clean(await tx.get(key(uid)), now);
                    if (!mine.friends[uid] || !theirs.friends[me] || theirs.blocked[me]) fail(403, 'You can only invite friends.', 'COLLAB_NOT_FRIENDS');
                    m.invited[uid] = now; theirs.cb_in[cid] = { from: me, at: now }; await tx.put(key(uid), theirs);
                }
                return bump();
            }
            if (action === 'comment') {
                needMember();
                const body2 = text(body.text, L.comment, 'comment', true);
                const id = String(now).padStart(13, '0') + '-' + hex(4);
                await tx.put('cbm:' + cid + ':' + id, { id, by: me, at: now, text: body2 });
                const all = [...(await tx.list({ prefix: 'cbm:' + cid + ':' })).keys()].sort();
                if (all.length > L.comments) await delMany(tx, all.slice(0, all.length - L.comments));
                m.ncomments = Math.min(all.length, L.comments);
                return { ...(await bump()), comment: id };
            }
            if (action === 'uncomment') {
                const id = typeof body.comment === 'string' && mPattern.test(body.comment) ? body.comment : fail(400, 'Choose a comment.');
                const c = await tx.get('cbm:' + cid + ':' + id);
                if (!c) fail(404, 'This comment is already gone.', 'COLLAB_COMMENT_GONE');
                if (c.by !== me) fail(403, 'You can only delete your own comments.', 'COLLAB_OWNER');
                await tx.delete('cbm:' + cid + ':' + id); m.ncomments = Math.max(0, (m.ncomments || 1) - 1);
                return bump();
            }

            // Task changes
            const all = await this.tasks(cid, tx), byId = new Map(all.map(t => [t.id, t]));
            const kids = id => all.filter(t => t.parent === id);
            const subtree = id => { const out = [], stack = [id]; while (stack.length) { const x = stack.pop(); const t = byId.get(x); if (!t) continue; out.push(t); for (const k of kids(x)) stack.push(k.id); } return out; };
            const depth = id => { let d = 0, t = byId.get(id); while (t && t.parent) { d++; t = byId.get(t.parent); } return d; };
            const save = t => tx.put('cbt:' + cid + ':' + t.id, t);
            if (action === 'add') {
                needOwner();
                const parent = await getTask(body.parent ?? 'root');
                if (all.length >= L.tasks) fail(409, `A collab holds at most ${L.tasks} tasks.`, 'COLLAB_TASK_LIMIT');
                if (depth(parent.id) + 1 >= L.depth) fail(409, `Tasks can be nested ${L.depth} levels deep.`, 'COLLAB_DEPTH');
                for (let p = parent; p; p = byId.get(p.parent)) if (p.done && p.locks) fail(409, 'A finished locked task can’t get new subtasks (it would reopen).', 'COLLAB_LOCKED');
                const due = dueOf(body.due);
                const t = { id: 't' + hex(6), parent: parent.id, title: text(body.title, L.title, 'title', true), notes: notesOf(body.notes), due,
                    assignees: [], done: null, at: now, ord: Math.max(-1, ...kids(parent.id).map(k => k.ord || 0)) + 1, locks: cleanLocks(body.locks, due), consent: {} };
                await save(t);
                if (parent.done) { parent.done = null; await save(parent); for (let p = byId.get(parent.parent); p; p = byId.get(p.parent)) if (p.done) { p.done = null; await save(p); } }
                await recount();
                return { ...(await bump()), task: t.id };
            }
            const t = await getTask(body.task);
            if (action === 'edit') {
                needOwner();
                if (body.title !== undefined) t.title = text(body.title, L.title, 'title', true);
                if (body.notes !== undefined) t.notes = notesOf(body.notes);
                if (body.due !== undefined) t.due = dueOf(body.due);
                const before = t.locks || null, after = body.locks !== undefined ? cleanLocks(body.locks, t.due) : before ? cleanLocks(before, t.due) : null;
                if (t.done && JSON.stringify(before) !== JSON.stringify(after)) fail(409, 'A finished task’s locks can’t change.', 'COLLAB_LOCKED');
                if (JSON.stringify(before) !== JSON.stringify(after)) {
                    // New terms: open copies are removed and every assignee is asked again (or freed when no locks are left).
                    for (const [u, c] of Object.entries(t.consent || {})) if (c.s === 'yes') await this.locks.removeMirrors(tx, u, [mirrorId(cid, t.id)]);
                    t.locks = after; t.consent = after ? Object.fromEntries(t.assignees.map(u => [u, { s: 'pending', at: now }])) : {};
                } else if (after) for (const [u, c] of Object.entries(t.consent || {})) if (c.s === 'yes') await this.locks.updateMirrors(tx, u, m, t);
                await save(t);
                if (t.id === 'root' && body.title !== undefined) m.title = t.title;
                await recount();
                return bump();
            }
            if (action === 'del') {
                needOwner();
                if (t.id === 'root') fail(400, 'Delete the whole collab instead.', 'COLLAB_ROOT');
                await this.locks.releaseAll(tx, m, subtree(t.id));
                await delMany(tx, subtree(t.id).map(x => 'cbt:' + cid + ':' + x.id));
                await recount();
                return bump();
            }
            if (action === 'assign') {
                needOwner();
                const people = new Set([...m.members, ...Object.keys(m.invited)]);
                const list = Array.isArray(body.assignees) ? [...new Set(body.assignees)] : fail(400, 'Choose who is assigned.');
                if (list.some(u => typeof u !== 'string' || !people.has(u))) fail(400, 'You can only assign people in this collab.', 'COLLAB_NOT_MEMBER');
                if (t.locks) {
                    if (t.done) fail(409, 'A finished locked task can’t be reassigned.', 'COLLAB_LOCKED');
                    const consent = {};
                    for (const u of list) consent[u] = t.consent?.[u] || { s: 'pending', at: now };
                    for (const [u, c] of Object.entries(t.consent || {})) if (!list.includes(u) && c.s === 'yes') await this.locks.removeMirrors(tx, u, [mirrorId(cid, t.id)]); // unassigning releases
                    t.consent = consent;
                }
                t.assignees = list; await save(t);
                await recount();
                return bump();
            }
            // Phase 7.7: consent to a locked assignment, refuse it, ask to be released, and the owner's release.
            if (action === 'consent' || action === 'refuse') {
                needMember();
                const c = t.locks ? t.consent?.[me] : null;
                if (!c || !t.assignees.includes(me)) fail(409, 'This task isn’t waiting for your OK.', 'COLLAB_STATE');
                if (t.done) fail(409, 'This task is already done.', 'COLLAB_STATE');
                if (action === 'refuse') {
                    if (c.s === 'yes') fail(409, `You already accepted. Ask @${await ownerName()} to release you.`, 'COLLAB_LOCKED');
                    t.consent[me] = { s: 'no', at: now };
                } else {
                    if (c.s === 'yes') return { ok: true, rev: m.rev };
                    if (!await this.locks.hasSnapshot(tx, me)) fail(409, 'Sync your tasks on this device once first, so the task can be added to your list.', 'COLLAB_SYNC');
                    await this.locks.addMirror(tx, me, m, t, await ownerName(), now);
                    t.consent[me] = { s: 'yes', at: now };
                }
                await save(t); await recount();
                return { ...(await bump()), mirror: action === 'consent' ? mirrorId(cid, t.id) : null };
            }
            if (action === 'release_request') {
                needMember();
                const c = t.locks ? t.consent?.[me] : null;
                if (!c || c.s !== 'yes' || t.done) fail(409, 'You haven’t accepted locks on this task.', 'COLLAB_STATE');
                if (body.cancel === true) delete c.req; else c.req = now;
                await save(t); await recount();
                return bump();
            }
            if (action === 'release') {
                needOwner();
                const uid = typeof body.uid === 'string' && uidPattern.test(body.uid) ? body.uid : fail(400, 'Choose a person.');
                const c = t.locks ? t.consent?.[uid] : null;
                if (!c) fail(404, 'They have no locks on this task.', 'COLLAB_STATE');
                if (body.approve === false) { delete c.req; await save(t); await recount(); return bump(); } // deny a request
                if (c.s === 'yes') await this.locks.removeMirrors(tx, uid, [mirrorId(cid, t.id)]);
                delete t.consent[uid]; t.assignees = t.assignees.filter(u => u !== uid);
                await save(t); await recount();
                return bump();
            }
            if (action === 'complete') {
                needMember();
                // A locked assignment counts only once it's accepted (Phase 7.7).
                const mineOk = x => x.assignees.includes(me) && (!x.locks || x.consent?.[me]?.s === 'yes');
                let allowed = m.owner === me;
                for (let x = t; x && !allowed; x = byId.get(x.parent)) if (mineOk(x)) allowed = true;
                if (!allowed) fail(403, t.locks && t.consent?.[me]?.s === 'pending' ? 'Accept this task’s locks first.' : 'You can complete only what you’re assigned (and the tasks under it).', 'COLLAB_NOT_ASSIGNED');
                if (body.done === false) {
                    if (!t.done) return { ok: true, rev: m.rev };
                    for (let p = t; p; p = byId.get(p.parent)) if (p.done && p.locks) fail(409, 'Locked tasks can’t be reopened. Remove the lock first.', 'COLLAB_LOCKED');
                    t.done = null; await save(t);
                    for (let p = byId.get(t.parent); p; p = byId.get(p.parent)) if (p.done) { p.done = null; await save(p); }
                } else {
                    const block = CollabLocks.blockers(t, subtree(t.id), kids, false);
                    if (block) fail(409, block.message, block.code);
                    const fresh = [];
                    for (const x of subtree(t.id)) if (!x.done) { x.done = { at: now, by: me }; await save(x); fresh.push(x); }
                    await this.locks.closeCopies(tx, m, fresh, now); // everyone who accepted these gets their copy closed
                    if (t.id === 'root') await this.finish(tx, m, me, now); // Phase 7.6: the whole collab is done
                }
                await recount();
                return bump();
            }
            fail(404, 'Endpoint not found.');
        });
    }
}

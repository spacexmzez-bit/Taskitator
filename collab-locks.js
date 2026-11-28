/* Phase 7.7: locked collab assignments. Used by collab-backend.js (collab actions) and worker.js (sync).
   A collab task can carry locks set by its owner: { ai, criteria, shield, phone }.
   - Consent: every assignee of a locked task starts Pending. Nothing binds them until they accept; Pending and Declined
     assignees can't complete that task. The owner sees who accepted, who is waiting and who declined.
   - Accepting adds a linked copy (a "mirror") of the task to the assignee's own task list, written by the Worker
     into their stored snapshot: id cbx_<cid>_<tid>, collab_link {cid, tid, phone, shield, collab}. There the usual
     engines do the work: AI check = ai_locked + proof_criteria (the normal proof review; their own credits or key),
     phone lock = the task counts toward their phone lock on its due date whatever their counting mode (status-count.js
     reads collab_link.phone), and the existing protection rules stop it from being removed.
     Without the phone lock the copy has no due date (undated tasks never lock the phone, AI-checked or not).
   - Shield is a collab rule: a shielded task can't be completed (directly, by its copy, or by completing something
     above it) while any of its subtasks is unfinished.
   - After accepting, the assignee can't remove or weaken the copy, unassign themselves or leave the collab. They can
     ask to be released; the owner approves (the copy is removed and they're unassigned) or denies. The owner can
     release anyone at any time. Emergency Bypass still works; using it on a copy is shown to the owner.
   - Completing the copy (plainly, or through an approved AI proof) completes the collab task and everything under
     it; completing a collab task completes the copies of everyone who accepted it. AI-checked collab tasks are only
     ever completed through a copy's proof (or Emergency Bypass), never from the collab page.
   - Locked tasks can't be reopened. Changing a task's locks asks everyone again (their copies are removed first).
   Every snapshot write goes through service.writeTaskSnapshot(tx, uid, snapshot, {skipCollab:true}), so the
   person's devices pick the change up on their next sync. */
export const LOCK_LIMITS = Object.freeze({ criteria: 1000 });
const FIELDS = ['title', 'due_date', 'status_count', 'collab_link', 'is_bonus', 'dynamic_bonus', 'ai_locked', 'proof_criteria', 'parent_id'];
export const mirrorId = (cid, tid) => 'cbx_' + cid + '_' + tid;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const hasLocks = l => Boolean(l && (l.ai || l.shield || l.phone));

export class LockError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const fail = (status, message, code) => { throw new LockError(status, message, code); };

// Owner input → stored locks (null when none).
export function cleanLocks(raw, due) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Check the locks.', 'COLLAB_LOCKS');
    const l = { ai: raw.ai === true, shield: raw.shield === true, phone: raw.phone === true, criteria: '' };
    if (l.ai) {
        l.criteria = typeof raw.criteria === 'string' ? raw.criteria.replace(/\r\n?/g, '\n').trim() : '';
        if (!l.criteria) fail(400, 'An AI check needs proof criteria: what the proof must show.', 'COLLAB_LOCKS');
        if (l.criteria.length > LOCK_LIMITS.criteria) fail(400, `Proof criteria can be up to ${LOCK_LIMITS.criteria} characters.`, 'COLLAB_LOCKS');
    }
    if (l.phone && !due) fail(400, 'A phone lock needs a due date: the phone locks on that day until it’s done.', 'COLLAB_LOCKS');
    return hasLocks(l) ? l : null;
}

export class CollabLocks {
    constructor(collab) { this.collab = collab; this.service = collab.service; }

    mirror(m, t, ownerName, now) {
        const l = t.locks;
        return {
            id: mirrorId(m.id, t.id), parent_id: null, title: t.title,
            description: `From the collab “${m.title}” by @${ownerName}.` + (t.notes ? '\n' + t.notes : ''),
            tags: [], status: 'active', due_date: l.phone ? t.due : null, created_at: new Date(now).toISOString(), completed_at: null,
            ai_locked: Boolean(l.ai), proof_criteria: l.ai ? l.criteria : '', ...(l.ai ? { raw_proof_criteria: l.criteria, original_proof_criteria: l.criteria } : {}),
            status_count: Boolean(l.phone),
            collab_link: { cid: m.id, tid: t.id, phone: Boolean(l.phone), shield: Boolean(l.shield), collab: m.title }
        };
    }
    // Load, change and save one person's snapshot. fn returns true when it changed something.
    async edit(tx, uid, fn) {
        let read;
        try { read = await this.service.readTaskSnapshot(tx, uid); } catch { return false; } // account gone
        if (!read?.snapshot || !Array.isArray(read.snapshot.tasks)) return false;
        if (!fn(read.snapshot)) return false;
        await this.service.writeTaskSnapshot(tx, uid, read.snapshot, { skipCollab: true });
        return true;
    }
    async hasSnapshot(tx, uid) {
        try { const r = await this.service.readTaskSnapshot(tx, uid); return Boolean(r?.snapshot && Array.isArray(r.snapshot.tasks)); } catch { return false; }
    }
    async addMirror(tx, uid, m, t, ownerName, now) {
        const copy = this.mirror(m, t, ownerName, now);
        return this.edit(tx, uid, s => { s.tasks = s.tasks.filter(x => x.id !== copy.id); s.tasks.push(copy); return true; });
    }
    // Remove still-open copies (finished ones stay as history).
    async removeMirrors(tx, uid, ids) {
        const set = new Set(ids);
        if (!set.size) return false;
        return this.edit(tx, uid, s => { const n = s.tasks.length; s.tasks = s.tasks.filter(x => !(set.has(x.id) && x.status !== 'completed')); return s.tasks.length !== n; });
    }
    async completeMirrors(tx, uid, ids, now) {
        const set = new Set(ids), at = new Date(now).toISOString();
        if (!set.size) return false;
        return this.edit(tx, uid, s => { let c = false; for (const x of s.tasks) if (set.has(x.id) && x.status === 'active') { x.status = 'completed'; x.completed_at = at; c = true; } return c; });
    }
    async updateMirrors(tx, uid, m, t) {
        const id = mirrorId(m.id, t.id);
        return this.edit(tx, uid, s => {
            const x = s.tasks.find(y => y.id === id && y.status === 'active');
            if (!x) return false;
            x.title = t.title; x.due_date = t.locks?.phone ? t.due : null;
            x.description = x.description.split('\n')[0] + (t.notes ? '\n' + t.notes : '');
            x.collab_link = { ...x.collab_link, collab: m.title };
            return true;
        });
    }
    // Who has an open copy of which tasks: {uid: [mirror ids]}.
    accepted(m, tasks) {
        const out = {};
        for (const t of tasks) if (t.locks && !t.done) for (const [u, c] of Object.entries(t.consent || {})) if (c.s === 'yes') (out[u] ||= []).push(mirrorId(m.id, t.id));
        return out;
    }
    async releaseAll(tx, m, tasks, onlyUid) {
        for (const [u, ids] of Object.entries(this.accepted(m, tasks))) if (!onlyUid || u === onlyUid) await this.removeMirrors(tx, u, ids);
    }
    // After collab tasks became done: close everyone's copies of them (except in `held`, a snapshot being saved now).
    async closeCopies(tx, m, doneTasks, now, held) {
        const per = {};
        for (const t of doneTasks) if (t.locks) for (const [u, c] of Object.entries(t.consent || {})) if (c.s === 'yes') (per[u] ||= []).push(mirrorId(m.id, t.id));
        for (const [u, ids] of Object.entries(per)) {
            if (held && held.uid === u) { const set = new Set(ids), at = new Date(now).toISOString(); for (const x of held.snapshot.tasks) if (set.has(x.id) && x.status === 'active') { x.status = 'completed'; x.completed_at = at; } }
            else await this.completeMirrors(tx, u, ids, now);
        }
    }
    // Collab rule shared by the collab page and the copies: may `t` and everything under it be completed now?
    static blockers(t, subtree, kids, viaProof) {
        for (const x of subtree) {
            if (x.done) continue;
            if (x.locks?.ai && !(viaProof && x.id === t.id)) return { code: 'COLLAB_AI_LOCKED', message: x.id === t.id ? 'This task has an AI check: an assignee who accepted it completes it with proof from their own task list.' : 'There’s an AI-checked task under it. It’s completed with proof first.' };
            if (x.locks?.shield && kids(x.id).some(k => !k.done) && !(viaProof && x.id === t.id)) return { code: 'COLLAB_SHIELD', message: x.id === t.id ? 'This task is shielded: complete its subtasks first.' : 'A shielded task under it still has unfinished subtasks.' };
        }
        return null;
    }

    /* Sync push (worker.js, after the protection guards, before saving). Throws {status, code, rejected} like the other
       guards, so the device reverts just the copies it may not change. */
    async guardPush(tx, uid, previous, next) {
        if (!previous) return;
        const before = new Map((previous.tasks || []).filter(t => t?.collab_link).map(t => [t.id, t]));
        const after = new Map((next.tasks || []).map(t => [t.id, t]));
        const rejected = [];
        for (const t of next.tasks || []) if (t?.collab_link && !before.has(t.id)) rejected.push({ id: t.id, code: 'COLLAB_LINK', message: 'Only the Worker adds collab tasks to your list.', related: [] });
        if (!before.size && !rejected.length) return;
        const bypass = before.size ? await this.service.protection.bypass(tx, uid) : false;
        for (const old of before.values()) {
            if (old.status !== 'active') continue;
            const cur = after.get(old.id), link = old.collab_link;
            const ctx = await this.context(tx, link);
            if (!ctx || ctx.t.consent?.[uid]?.s !== 'yes' || ctx.t.done) continue; // released, deleted or done: nothing to protect
            if (bypass) continue;
            const no = (code, message) => rejected.push({ id: old.id, code, message, related: [] });
            if (!cur || cur.status === 'trash') { no('COLLAB_LOCKED', `You agreed to this collab task’s locks. Ask @${ctx.ownerName} to release you, or use Emergency Bypass.`); continue; }
            if (FIELDS.some(f => !same(old[f], cur[f]))) { no('COLLAB_LOCKED', 'This collab task’s title, date and locks are set by the collab’s owner.'); continue; }
            if (cur.status === 'completed') {
                const b = CollabLocks.blockers(ctx.t, ctx.subtree, ctx.kids, Boolean(old.ai_locked));
                if (b && !old.ai_locked) no(b.code === 'COLLAB_SHIELD' ? 'CHILDREN_REQUIRED' : b.code, b.message + ' (in the collab)');
            }
        }
        if (rejected.length) throw Object.assign(new LockError(403, rejected[0].message, rejected[0].code), { rejected });
    }
    async context(tx, link) {
        if (!link || typeof link.cid !== 'string' || typeof link.tid !== 'string') return null;
        const m = await this.collab.meta(link.cid, tx);
        if (!m) return null;
        const tasks = await this.collab.tasks(link.cid, tx), byId = new Map(tasks.map(x => [x.id, x]));
        const t = byId.get(link.tid);
        if (!t) return null;
        const kids = id => tasks.filter(x => x.parent === id);
        const subtree = []; for (const stack = [t.id]; stack.length;) { const x = byId.get(stack.pop()); if (!x) continue; subtree.push(x); for (const k of kids(x.id)) stack.push(k.id); }
        return { m, t, tasks, byId, kids, subtree, ownerName: await this.collab.friends.username(m.owner, tx) || 'the owner' };
    }

    /* After a push (with `previous`) or any server write of the person's snapshot (AI proof approval): a copy that is
       now completed completes its collab task (and everything under it); a copy removed under Emergency Bypass is
       shown to the owner. Changes to `snapshot` itself are made in place (it is saved right after). */
    async reconcile(tx, uid, snapshot, { previous = null, bypass = false, now = Date.now() } = {}) {
        const mine = (snapshot?.tasks || []).filter(t => t?.collab_link);
        const before = new Map((previous?.tasks || []).filter(t => t?.collab_link).map(t => [t.id, t]));
        if (!mine.length && !before.size) return;
        const touched = new Map();
        const load = async cid => { if (!touched.has(cid)) { const m = await this.collab.meta(cid, tx); touched.set(cid, m ? { m, tasks: await this.collab.tasks(cid, tx), dirty: new Set(), done: [] } : null); } return touched.get(cid); };
        for (const x of mine) {
            if (x.status !== 'completed') continue;
            const c = await load(x.collab_link.cid); if (!c) continue;
            const t = c.tasks.find(y => y.id === x.collab_link.tid);
            if (!t || t.done || t.consent?.[uid]?.s !== 'yes') continue;
            const kids = id => c.tasks.filter(y => y.parent === id), byId = new Map(c.tasks.map(y => [y.id, y]));
            const via = x.ai_locked ? (x.verified_model ? 'proof' : 'bypass') : (bypass ? 'bypass' : 'done');
            for (const stack = [t.id]; stack.length;) { const y = byId.get(stack.pop()); if (!y) continue; if (!y.done) { y.done = { at: now, by: uid, ...(y.id === t.id && via !== 'done' ? { via } : {}) }; c.dirty.add(y.id); c.done.push(y); } for (const k of kids(y.id)) stack.push(k.id); }
        }
        for (const old of before.values()) { // removed while protected = Emergency Bypass
            if (old.status !== 'active') continue;
            const cur = (snapshot.tasks || []).find(y => y.id === old.id);
            if (cur && cur.status !== 'trash') continue;
            const c = await load(old.collab_link.cid); if (!c) continue;
            const t = c.tasks.find(y => y.id === old.collab_link.tid);
            if (!t || t.done || t.consent?.[uid]?.s !== 'yes') continue;
            t.consent[uid] = { s: 'no', at: now, bypass: now }; c.dirty.add(t.id);
        }
        for (const c of touched.values()) {
            if (!c || !c.dirty.size) continue;
            for (const id of c.dirty) { const t = c.tasks.find(y => y.id === id); await tx.put('cbt:' + c.m.id + ':' + id, t); }
            await this.closeCopies(tx, c.m, c.done, now, { uid, snapshot });
            const root = c.tasks.find(y => y.id === 'root');
            if (root?.done && !c.m.finished) await this.collab.finish(tx, c.m, uid, now);
            Object.assign(c.m, this.collab.count(c.tasks)); this.collab.consentCount(c.m, c.tasks);
            c.m.rev++; await tx.put('cb:' + c.m.id, c.m);
        }
    }
}

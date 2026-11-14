// Root task completion rules (Phase 3.1).
// 1. Completing an unshielded root moves its unfinished descendants to Trash, except shielded,
//    AI-protected and bonus work (and anything inside a shielded descendant). Tasks that lead to a
//    kept task stay too, so kept work keeps its place in the tree.
// 2. A completed root can be reopened until its logical day ends. After that the root and its whole
//    branch are hidden from every task view. The data stays, so Stats keep counting it.
(function (global) {
    'use strict';
    const exempt = t => Boolean(t.is_bonus || t.ai_locked || t.require_ai_proof || t.strict_prerequisites);

    function childrenMap(tasks) {
        const map = new Map();
        for (const t of tasks) {
            if (!t || t.status === 'trash' || !t.parent_id) continue;
            if (!map.has(t.parent_id)) map.set(t.parent_id, []);
            map.get(t.parent_id).push(t);
        }
        return map;
    }

    // IDs of the unfinished descendants that completing this root moves to Trash.
    function removable(tasks, rootId) {
        const root = tasks.find(t => t && t.id === rootId);
        if (!root || root.parent_id || root.strict_prerequisites) return [];
        const kids = childrenMap(tasks), out = [], seen = new Set([rootId]);
        // Returns true when the node (or something below it) must stay.
        function walk(node, insideShield) {
            let keepBelow = false;
            for (const k of kids.get(node.id) || []) {
                if (seen.has(k.id)) continue;
                seen.add(k.id);
                if (walk(k, insideShield || Boolean(k.strict_prerequisites))) keepBelow = true;
            }
            if (node.id === rootId) return keepBelow;
            if (node.status !== 'active') return keepBelow;
            if (insideShield || exempt(node) || keepBelow) return true;
            out.push(node.id);
            return false;
        }
        walk(root, false);
        return out;
    }

    // IDs hidden from task views: a completed root whose logical day has ended, with no unfinished
    // work left under it, plus its whole branch.
    function hiddenIds(tasks, today, dayOf, pending = () => false) {
        const hidden = new Set();
        if (!Array.isArray(tasks) || typeof dayOf !== 'function' || !today) return hidden;
        const kids = childrenMap(tasks);
        const branch = id => {
            const ids = [], stack = [id], seen = new Set();
            while (stack.length) {
                const cur = stack.pop();
                if (seen.has(cur)) continue;
                seen.add(cur); ids.push(cur);
                for (const k of kids.get(cur) || []) stack.push(k.id);
            }
            return ids;
        };
        for (const t of tasks) {
            if (!t || t.parent_id || t.status !== 'completed' || pending(t.id)) continue;
            const ms = Date.parse(t.completed_at);
            if (!Number.isFinite(ms) || !(dayOf(ms) < today)) continue;
            const ids = branch(t.id);
            if (ids.some(id => id !== t.id && tasks.find(x => x.id === id)?.status === 'active')) continue;
            ids.forEach(id => hidden.add(id));
        }
        return hidden;
    }

    function dayHour(settings) {
        const h = Number(settings?.day_start_hour);
        return Number.isFinite(h) ? Math.max(0, Math.min(4, h)) : 0;
    }

    // Same logical day function as the Projects view and recurrence engine.
    function hiddenNow(tasks, pending, now = Date.now()) {
        const R = global.TaskitatorRecurrence;
        if (!R?.today) return new Set();
        let settings = {};
        try { settings = JSON.parse(global.localStorage?.getItem('taskitator_settings') || '{}'); } catch (_) {}
        const hour = dayHour(settings);
        return hiddenIds(tasks, R.today(now, hour), ms => R.today(ms, hour), pending);
    }

    global.TaskitatorRootCompletion = { exempt, removable, hiddenIds, hiddenNow };
})(typeof window !== 'undefined' ? window : globalThis);

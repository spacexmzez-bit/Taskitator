/* Phase 7.6: a saved copy of a collab — "Save JSON file" in the collab view, and each collab inside the Settings
   account export. It is a record to keep, not a backup: no ids, none of the fields Taskitator imports, and a format tag
   the Settings import refuses. Pure: build() turns the GET /collab/<id> answer into the file's content. */
(function (root) {
    'use strict';
    const FORMAT = 'taskitator-collab-archive';
    const iso = t => (Number.isFinite(t) ? new Date(t).toISOString() : null);
    const at = name => (name && name !== 'Former member' && name !== 'Taskitator user' ? '@' + name : 'Former member');

    function build(v, now = Date.now()) {
        const members = Array.isArray(v?.members) ? v.members : [], invited = Array.isArray(v?.invited) ? v.invited : [];
        const names = new Map([...members, ...invited].map(m => [m.id, at(m.username)]));
        const who = id => names.get(id) || 'Former member';
        const tasks = Array.isArray(v?.tasks) ? v.tasks : [];
        const kids = id => tasks.filter(t => t.parent === id).sort((a, b) => (a.ord - b.ord) || (a.at - b.at));
        const node = (t, depth) => ({
            title: t.title, notes: t.notes || '', due: t.due || null,
            assigned_to: (t.assignees || []).map(who), done: Boolean(t.done),
            done_at: t.done ? iso(t.done.at) : null, done_by: t.done ? who(t.done.by) : null,
            subtasks: depth < 8 ? kids(t.id).map(k => node(k, depth + 1)) : []
        });
        const assigned = id => tasks.filter(t => (t.assignees || []).includes(id));
        const people = [...members.map(m => [m, false]), ...invited.map(m => [m, true])].map(([m, inv]) => {
            const mine = assigned(m.id);
            return { username: at(m.username), role: m.owner ? 'owner' : inv ? 'invited' : mine.length ? 'member' : 'viewer', assigned: mine.length, done: mine.filter(t => t.done).length };
        });
        const done = tasks.filter(t => t.done).length, rootTask = tasks.find(t => t.id === 'root');
        return {
            format: FORMAT, format_version: 1,
            notice: 'A saved record of a Taskitator collab. It isn’t a backup and can’t be imported.',
            saved_at: iso(now),
            collab: {
                title: String(v?.title || ''), started_by: who(v?.owner), started_at: iso(v?.at),
                status: v?.finished ? 'finished' : 'in progress',
                finished_at: v?.finished ? iso(v.finished.at) : null,
                finished_by: v?.finished ? (v.finished.username ? at(v.finished.username) : who(v.finished.by)) : null
            },
            progress: { done, total: tasks.length, percent: tasks.length ? Math.round(100 * done / tasks.length) : 0, people },
            outline: rootTask ? node(rootTask, 0) : null,
            comments: (Array.isArray(v?.comments) ? v.comments : []).map(c => ({ by: at(c.username), at: iso(c.at), text: c.text }))
        };
    }
    const isArchive = data => Boolean(data && typeof data === 'object' && data.format === FORMAT);
    function fileName(v, now = Date.now()) {
        const slug = String(v?.title || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'collab';
        return `taskitator-collab-${slug}-${new Date(now).toISOString().slice(0, 10)}.json`;
    }
    function download(v) {
        const name = fileName(v);
        const blob = new Blob([JSON.stringify(build(v), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return name;
    }
    root.TaskitatorCollabArchive = Object.freeze({ FORMAT, build, isArchive, fileName, download });
})(typeof window === 'undefined' ? globalThis : window);

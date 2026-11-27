// Stats view (views/stats.js): bad data must not freeze the page at its HTML defaults,
// and "today" follows the app's logical day (Riyadh time + day start hour), not UTC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('./views/stats.js', import.meta.url), 'utf8');
const riyadhToday = (ms, hour = 0) => new Date(ms + (3 - hour) * 3600000).toISOString().slice(0, 10);

function page({ store = {}, recurrence = null, engine = null, errors = [] } = {}) {
    const nodes = new Map(), listeners = {};
    const el = () => ({ textContent: '', innerHTML: '', style: {}, title: '', className: '', children: [], appendChild(c) { this.children.push(c); },
        querySelector: () => el(), addEventListener() {} });
    const node = id => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };
    const data = { taskitator_local_owner: 'u1', ...store };
    const window = {
        TaskitatorAuth: { signedIn: true, account: { user: 'u1' } },
        TaskitatorShell: { current: () => 'stats' },
        TaskitatorRecurrence: { today: riyadhToday },
        location: { search: '' },
        addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }
    };
    const ctx = {
        window, document: { getElementById: node, createElement: el },
        localStorage: { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } },
        console: { error: (...a) => errors.push(a.join(' ')) },
        TaskitatorSafety: { escapeHtml: String, cssColor: String, setProjectLabel() {} },
        TaskitatorRecurrenceUI: recurrence ? { state: () => recurrence } : undefined,
        TaskitatorEngine: engine ? { BreakEngine: engine } : undefined,
        setTimeout: f => f(), Date, Math, JSON, Number, Map, Array, String, Object
    };
    vm.runInNewContext(src, ctx);
    return { render: () => window.renderStats(), node, listeners };
}

test('malformed tasks, history and breaks no longer stop the page from drawing', () => {
    const now = new Date().toISOString(), errors = [];
    const p = page({
        errors,
        store: {
            taskitator_tasks: JSON.stringify([
                { id: 'a', status: 'completed', completed_at: now, project_id: 'gone' },
                { id: 'b', status: 'completed', completed_at: Date.now(), ai_locked: true }, // numeric stamp: used to throw
                { id: 'c', status: 'completed' },                                              // no stamp
                null, 5,
                { id: 'd', status: 'active', due_date: riyadhToday(Date.now()) }
            ]),
            taskitator_projects: '{"not":"an array"}'
        },
        recurrence: { history: [{ id: 'x', outcome: 'completed' }, null, { id: 'y', outcome: 'completed', ended_at: now, tasks: [{ status: 'completed' }] }] },
        engine: { current: () => null, getTodayBreaks: () => [{ start: 'x' }], getLogicalDayBounds: () => ({}), getBreakTimestamps() { throw new Error('bad clock'); } }
    });
    p.render();
    assert.equal(p.node('statCompletedToday').textContent, 3, 'string, numeric and history completions all count');
    assert.equal(p.node('statPendingToday').textContent, 1);
    assert.equal(p.node('statTotalActive').textContent, 1);
    assert.equal(p.node('countAiLocked').textContent, 1);
    assert.equal(p.node('countStandard').textContent, 3);
    assert.equal(p.node('breakSlotsCount').textContent, '1 break window configured');
    assert.equal(p.node('totalBreakTime').textContent, '0m');
    assert.equal(p.node('velocityBarsContainer').children.length, 7);
    assert.deepEqual(errors, []);
});

test('a section that fails is logged and the others still draw', () => {
    const errors = [];
    const p = page({ errors, store: { taskitator_tasks: JSON.stringify([{ id: 'a', status: 'completed', completed_at: new Date().toISOString() }]) },
        engine: { current() { throw new Error('boom'); } } });
    p.render();
    assert.equal(p.node('statCompletedToday').textContent, 1);
    assert.equal(p.node('countStandard').textContent, 1);
    assert.match(errors.join('\n'), /stats: breaks could not be drawn/);
});

test('today is the logical day, not the UTC date', () => {
    const src2 = src.replace("const todayStr = statsDay(Date.now(), hour);", "const todayStr = statsDay(Date.parse('2026-11-27T22:00:00Z'), hour);");
    assert.notEqual(src2, src);
    // 21:30 UTC on the 27th is 00:30 on the 28th in Riyadh: same logical day as 22:00 UTC.
    const late = '2026-11-27T21:30:00Z', early = '2026-11-27T20:00:00Z';
    const run = hour => {
        const nodes = new Map(), el = () => ({ textContent: '', innerHTML: '', style: {}, children: [], appendChild(c) { this.children.push(c); }, querySelector: () => el(), addEventListener() {} });
        const node = id => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };
        const data = { taskitator_local_owner: 'u1', taskitator_settings: JSON.stringify({ day_start_hour: hour }),
            taskitator_tasks: JSON.stringify([{ id: 'l', status: 'completed', completed_at: late }, { id: 'e', status: 'completed', completed_at: early },
                { id: 'p', status: 'active', due_date: '2026-11-28' }]) };
        const window = { TaskitatorAuth: { signedIn: true, account: { user: 'u1' } }, TaskitatorShell: { current: () => 'stats' },
            TaskitatorRecurrence: { today: riyadhToday }, location: { search: '' }, addEventListener() {} };
        vm.runInNewContext(src2, { window, document: { getElementById: node, createElement: el }, localStorage: { getItem: k => data[k] ?? null },
            console, TaskitatorSafety: { escapeHtml: String, cssColor: String, setProjectLabel() {} }, setTimeout, Date, Math, JSON, Number, Map, Array, String, Object });
        window.renderStats();
        return [node('statCompletedToday').textContent, node('statPendingToday').textContent];
    };
    assert.deepEqual(run(0), [1, 1], 'midnight start: only the 00:30 completion is today; the task due on the 28th is pending');
    assert.deepEqual(run(2), [2, 0], 'day starts at 02:00: it is still the 27th, both completions count');
});

test('Stats redraws on task, sync, break and sign-in events while open', () => {
    const p = page({ store: { taskitator_tasks: '[]' } });
    for (const type of ['taskitator-synced', 'taskitator-tasks-updated', 'taskitator-breaks-changed', 'taskitator-auth-ready', 'storage'])
        assert.ok(p.listeners[type]?.length, type);
    assert.match(src, /taskitator_\(tasks\|projects\|recurrence_state/);
});

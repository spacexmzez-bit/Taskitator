/* Phase 7.0: points, ranks and streak (personal Taskitator only). Shared by the Worker (which awards and stores)
   and the browser (which only displays). Pure functions; nothing here talks to storage or the network.

   Rules
   - Points are awarded when the Worker sees a task go from not-completed to completed in a sync. The completion time
     decides the day, never the due date, so early, overdue and General-list completions count the same.
   - Each task id is awarded once (kept for AWARD_KEEP_DAYS, longer than any reopen window), so reopen + complete
     gives nothing. Only the task that was tapped earns: a subtask completed by its parent's cascade (same
     completed_at as its completed parent) earns nothing.
   - Weight: the task's own stored priority (never Dynamic Priority) maps evenly from 5 (highest) to 1 (lowest),
     rounded half up; one priority level = 3; no or unknown priority = 1. Fixed at award time.
   - At most DAILY_CAP points per logical day. Completions older than BACKFILL_DAYS (offline) earn nothing.
   - Streak: a day counts when at least one task was completed in it. A free day neither breaks nor adds to the
     streak and earns no points. Today not yet done never breaks it. Missing a day resets it to 0; best is kept.
   - Free days: weekdays (0 = Sunday). Default = your weekend. At most weekend days + 2 (max 5). A change takes
     effect from the start of the next week (the day after your weekend ends), so today can't be made free after
     missing it. */
(function (root) {
    'use strict';
    const DAILY_CAP = 150, BACKFILL_DAYS = 7, AWARD_KEEP_DAYS = 21, DAY_KEEP = 400, FUTURE_SLACK_MS = 5 * 60000;
    const OFFSET = 3 * 3600000; // Riyadh UTC+3, like the rest of the Worker's logical days
    const RANKS = Object.freeze([
        ['Seedling', 0], ['Sprout', 15], ['Sapling', 40], ['Scout', 90], ['Tracker', 180], ['Ranger', 350],
        ['Hunter', 650], ['Pathfinder', 1100], ['Warden', 1800], ['Alpha', 3000], ['Apex', 5000], ['Legend', 8000]
    ].map(([name, min]) => Object.freeze({ name, min })));
    const DEFAULT_PRIORITIES = [{ id: 'prio_high', rank: 1 }, { id: 'prio_med', rank: 2 }, { id: 'prio_low', rank: 3 }];

    function rankFor(points) {
        const p = Math.max(0, Math.floor(Number(points) || 0));
        let i = 0;
        while (i + 1 < RANKS.length && p >= RANKS[i + 1].min) i++;
        const next = RANKS[i + 1] || null;
        return { index: i, name: RANKS[i].name, min: RANKS[i].min, next: next ? next.name : null, next_min: next ? next.min : null };
    }
    function priorities(settings) {
        const list = Array.isArray(settings?.custom_priorities) && settings.custom_priorities.length ? settings.custom_priorities : DEFAULT_PRIORITIES;
        return list.map((p, i) => ({ id: p?.id, rank: Number.isFinite(Number(p?.rank)) ? Number(p.rank) : i + 1, i }))
            .filter(p => p.id != null).sort((a, b) => a.rank - b.rank || a.i - b.i);
    }
    function weight(priorityId, settings) {
        const list = priorities(settings);
        const i = priorityId == null ? -1 : list.findIndex(p => p.id === priorityId);
        if (i < 0) return 1;
        if (list.length === 1) return 3;
        return Math.floor(1 + 4 * (list.length - 1 - i) / (list.length - 1) + 0.5);
    }

    const dayHour = settings => { const h = Number.parseInt(settings?.day_start_hour, 10); return Number.isInteger(h) && h >= 0 && h <= 4 ? h : 0; };
    const logicalDate = (time, hour) => new Date(time + OFFSET - hour * 3600000).toISOString().slice(0, 10);
    const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
    const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
    const dayNumber = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);

    function weekend(settings) {
        const s = Number.parseInt(settings?.weekend_start, 10), e = Number.parseInt(settings?.weekend_end, 10);
        const start = s >= 0 && s <= 6 ? s : 5, end = e >= 0 && e <= 6 ? e : 6;
        const out = [];
        for (let d = start; ; d = (d + 1) % 7) { out.push(d); if (d === end || out.length >= 7) break; }
        return { days: out, end };
    }
    function maxFree(settings) { return Math.min(5, weekend(settings).days.length + 2); }
    // The free days the person chose (settings.streak_free_days), or their weekend.
    function freeDays(settings) {
        const raw = settings?.streak_free_days;
        const days = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : weekend(settings).days.slice().sort();
        return days.slice(0, maxFree(settings));
    }
    // First day of the next week: the first date after `today` that follows the weekend's last day.
    function nextWeekStart(today, settings) {
        const first = (weekend(settings).end + 1) % 7;
        let d = shift(today, 1);
        while (weekday(d) !== first) d = shift(d, 1);
        return d;
    }
    function freeOn(schedule, date) {
        let days = [];
        for (const s of schedule || []) if (s.from <= date) days = s.days;
        return days.includes(weekday(date));
    }

    function emptyState() { return { v: 1, total: 0, best: 0, days: {}, awarded: {}, free: [], hour: 0 }; }
    function normalize(state) {
        const s = state && state.v === 1 ? state : emptyState();
        return { v: 1, total: Math.max(0, Math.floor(s.total) || 0), best: Math.max(0, Math.floor(s.best) || 0), days: { ...(s.days || {}) },
            awarded: { ...(s.awarded || {}) }, free: Array.isArray(s.free) ? s.free.map(x => ({ from: x.from, days: [...x.days] })) : [], hour: dayHour({ day_start_hour: s.hour }) };
    }
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    // Keep the free-day schedule: first setting applies at once; later changes start next week.
    function scheduleFree(state, settings, today) {
        const want = freeDays(settings), list = state.free;
        if (!list.length) { list.push({ from: '0000-01-01', days: want }); return true; }
        const last = list[list.length - 1];
        if (last.from > today) {
            if (same(last.days, want)) return false;
            const before = list.length > 1 ? list[list.length - 2] : null;
            if (before && same(before.days, want)) { list.pop(); return true; } // changed back before it started
            last.days = want; return true;
        }
        if (same(last.days, want)) return false;
        list.push({ from: nextWeekStart(today, settings), days: want });
        while (list.length > 12) list.splice(1, 1);
        return true;
    }

    function streakOf(state, today) {
        const done = d => (state.days[d]?.n || 0) > 0;
        let cur = 0;
        if (done(today) && !freeOn(state.free, today)) cur = 1;
        let d = shift(today, -1);
        for (let guard = 0; guard < DAY_KEEP; guard++, d = shift(d, -1)) {
            if (freeOn(state.free, d)) continue;
            if (!done(d)) break;
            cur++;
        }
        return cur;
    }

    const stamp = value => (typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN);

    /* Award new completions. Returns {state, gained, changed}. `previous` is the stored snapshot (may be null). */
    function record(stateIn, previous, snapshot, now) {
        const state = normalize(stateIn);
        const settings = snapshot?.settings || {};
        const hour = dayHour(settings), today = logicalDate(now, hour);
        let changed = state.hour !== hour;
        state.hour = hour;
        if (scheduleFree(state, settings, today)) changed = true;
        const before = new Map((previous?.tasks || []).map(t => [t.id, t]));
        const byId = new Map((snapshot?.tasks || []).map(t => [t.id, t]));
        const fresh = (snapshot?.tasks || []).filter(t => t && t.status === 'completed' && before.get(t.id)?.status !== 'completed');
        const freshIds = new Set(fresh.map(t => t.id));
        let gained = 0;
        const items = fresh.map(t => ({ t, at: stamp(t.completed_at) })).filter(x => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
        for (const { t, at } of items) {
            if (Object.hasOwn(state.awarded, t.id)) continue;
            if (at > now + FUTURE_SLACK_MS || at < now - BACKFILL_DAYS * 86400000) continue;
            const parent = t.parent_id ? byId.get(t.parent_id) : null;
            if (parent && freshIds.has(parent.id) && parent.completed_at === t.completed_at) continue; // cascade, not a tap
            const day = logicalDate(at, hour);
            const row = state.days[day] || { p: 0, n: 0 };
            const free = freeOn(state.free, day);
            const pts = free ? 0 : Math.max(0, Math.min(weight(t.priority_id, settings), DAILY_CAP - row.p));
            row.p += pts; row.n += 1; state.days[day] = row;
            state.total += pts; gained += pts;
            state.awarded[t.id] = dayNumber(day);
            changed = true;
        }
        // Prune
        const keepFrom = dayNumber(today) - AWARD_KEEP_DAYS;
        for (const [id, n] of Object.entries(state.awarded)) if (n < keepFrom) { delete state.awarded[id]; changed = true; }
        const dayFrom = shift(today, -DAY_KEEP);
        for (const d of Object.keys(state.days)) if (d < dayFrom) { delete state.days[d]; changed = true; }
        const cur = streakOf(state, today);
        if (cur > state.best) { state.best = cur; changed = true; }
        return { state, gained, changed };
    }

    function summary(stateIn, now) {
        const state = normalize(stateIn), today = logicalDate(now, state.hour);
        const row = state.days[today] || { p: 0, n: 0 };
        const streak = streakOf(state, today);
        const upcoming = state.free.find(s => s.from > today) || null;
        let current = [];
        for (const s of state.free) if (s.from <= today) current = s.days;
        const week = [];
        for (let i = 6; i >= 0; i--) { const d = shift(today, -i), r = state.days[d] || { p: 0, n: 0 }; week.push({ date: d, points: r.p, count: r.n, free: freeOn(state.free, d) }); }
        return {
            total: state.total, rank: rankFor(state.total), streak, best: Math.max(state.best, streak), cap: DAILY_CAP,
            today: { date: today, points: row.p, count: row.n, free: freeOn(state.free, today), done: row.n > 0 },
            free_days: current, free_next: upcoming ? { from: upcoming.from, days: upcoming.days } : null, week
        };
    }

    root.TaskitatorPoints = Object.freeze({ RANKS, DAILY_CAP, BACKFILL_DAYS, AWARD_KEEP_DAYS, rankFor, weight, priorities, freeDays, maxFree, weekend,
        nextWeekStart, freeOn, streakOf, record, summary, emptyState, logicalDate });
})(typeof window === 'undefined' ? globalThis : window);

// ============================================================================
// Taskitator server-owned daily break systems (break-systems.js)
// Scheduled planning and Flexible breaks share one record per account and logical
// day. Only this module writes those records; synced snapshots cannot change them.
// ============================================================================
import { fail } from './pro-backend.js';

export const BREAKS = Object.freeze({
    allowance: 180,          // default (and largest) minutes per logical day, shared by both systems
    allowanceMin: 60,        // smallest daily maximum a user can choose
    allowanceStep: 15,       // daily maximum is chosen in 15-minute steps
    flexMinimum: 10,         // minutes before a Flexible break can be ended manually
    presets: Object.freeze([30, 45, 60]),
    window: 600000,          // Scheduled planning window (10 minutes)
    closing: 6 * 3600000,    // Scheduled planning closes 6 hours before the day ends
    minDay: 20 * 3600000,    // shortest logical day a settings change can produce
    retention: 90            // days of records kept for history and statistics
});
export const STRICT = Object.freeze({
    flexMin: 30, flexMax: 60,                  // Flexible Strict Mode minimum (minutes)
    deadlineMin: 60, deadlineMax: 18 * 60, deadlineStep: 15   // Scheduled deadline after day start
});
const MIN = 60000, OPERATION = /^[A-Za-z0-9_-]{8,100}$/;
const core = () => {
    if (!globalThis.TaskitatorBreaks) throw fail(503, 'BREAKS_UNAVAILABLE', 'Break rules are unavailable. Retry shortly.');
    return globalThis.TaskitatorBreaks;
};
const dayKey = (account, date) => 'breaks:day:' + account + ':' + date;
const indexKey = account => 'breaks:index:' + account;
const strictKey = account => 'breaks:strict:' + account;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const addDate = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const pad = n => String(n).padStart(2, '0');
const hourOf = settings => Math.max(0, Math.min(4, Math.trunc(Number(settings?.day_start_hour) || 0)));
// Any started minute counts as a full minute: 30m 0s → 30, 30m 1s → 31.
export const chargeMinutes = (start, end) => Math.max(0, Math.ceil((end - start) / MIN));

function clock(ms, zone) { const p = core().parts(ms, zone); return pad(p.h) + ':' + pad(p.m) + (p.s ? ':' + pad(p.s) : ''); }
function bounds(r) {
    return { dateStr: r.date, start: new Date(r.cycle_start), end: new Date(r.cycle_end), cutoff6h: new Date(r.cycle_end - BREAKS.closing),
        dayStartHour: r.day_start_hour, timezone: r.timezone };
}
function blank(date, zone, hour, start, end, now) {
    return { v: 2, date, timezone: zone, day_start_hour: hour, cycle_start: start, cycle_end: end, created_at: now,
        system: null, locked_at: null, lock_source: null, planning: null,
        scheduled: { breaks: [], saved_at: null }, flexible: { used: 0, active: null, sessions: [] }, revision: 0 };
}
function lock(r, system, source, now) { if (!r.system) { r.system = system; r.locked_at = now; r.lock_source = source; } }
const scheduledLocked = r => r.system === 'scheduled' && (r.v !== 2 || ['lock', 'strict', 'migration'].includes(r.lock_source));
const scheduledMinutes = r => r.scheduled.breaks.reduce((sum, b) => { const t = core().interval(b, bounds(r)); return sum + (t.endTime - t.startTime) / MIN; }, 0);
const planningOpen = (r, now) => !!r.planning && now < r.planning.deadline;

// Existing schedules saved before this update stay Scheduled for their day. A saved
// schedule (locked, or saved inside a still-open window) selects Scheduled; an unsaved
// or expired-without-schedule window leaves the day open. No allowance is invented.
export function migrateLegacy(r, old, now) {
    if (!old || typeof old !== 'object' || !Array.isArray(old.breaks)) return r;
    const checked = old.breaks.length ? core().validate(old.breaks, bounds(r)) : { valid: false };
    if (checked.valid) {
        lock(r, 'scheduled', 'migration', now);
        r.scheduled = { breaks: checked.breaks, saved_at: now };
        const started = Number(old.window_started_at);
        if (!old.locked && Number.isFinite(started) && started > 0 && now - started < BREAKS.window)
            r.planning = { started_at: started, deadline: started + BREAKS.window, saved: true };
    } else if (old.locked && !old.repair_required) lock(r, 'scheduled', 'migration', now);
    return r;
}

// ---- Strict modes -----------------------------------------------------------------
// Config: { flexible:{enabled,minimum}, scheduled:{enabled,deadline_minutes,default:[clocks],
// days:{0..6:{mode:'default'|'custom'|'off',breaks}}}, timezone }. Weekdays follow the
// logical day's date (0 = Sunday). 'off' days are excluded; included days without a plan
// lock with zero breaks.
export function defaultStrict() {
    const days = {};
    for (let d = 0; d < 7; d++) days[d] = { mode: 'default', breaks: [] };
    return { allowance: BREAKS.allowance, flexible: { enabled: false, minimum: STRICT.flexMin },
        scheduled: { enabled: false, deadline_minutes: 8 * 60, default: [], days }, timezone: null };
}
// Daily maximum for a config (older saved configs have none: 3 hours). A day keeps the
// maximum it was locked with, so a later change never rewrites a chosen day.
export const allowanceOf = cfg => Number.isInteger(cfg?.allowance) ? cfg.allowance : BREAKS.allowance;
const limitOf = (r, cfg) => Number.isInteger(r?.allowance) ? r.allowance : allowanceOf(cfg);
// Flexible Strict Mode: after a break ends, the next one can start only once a gap as long
// as the strict minimum has passed. Normal Flexible Breaks have no gap.
export function flexGapUntil(r, cfg) {
    if (!cfg?.flexible?.enabled || r.flexible.active || !r.flexible.sessions.length) return 0;
    return Math.max(...r.flexible.sessions.map(s => s.ended_at)) + cfg.flexible.minimum * MIN;
}
// Strict configs never change a day that already used the previous one: each saved
// version starts on `from` (a logical date); earlier days keep the version before it.
export function strictFor(doc, date) {
    if (!doc?.current) return defaultStrict();
    if (doc.current.from && date < doc.current.from) return doc.previous?.config || defaultStrict();
    return doc.current.config;
}
export const flexMinimum = cfg => cfg?.flexible?.enabled ? cfg.flexible.minimum : BREAKS.flexMinimum;
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
export function strictDay(r, cfg) {
    const s = cfg?.scheduled;
    if (!s?.enabled) return null;
    const day = s.days[weekday(r.date)];
    if (!day || day.mode === 'off') return { covered: false, weekday: weekday(r.date) };
    return { covered: true, weekday: weekday(r.date), mode: day.mode, deadline: Math.min(r.cycle_end, r.cycle_start + s.deadline_minutes * MIN),
        breaks: day.mode === 'custom' ? day.breaks : s.default };
}
// Validate a strict plan's clock times against a real day; strict plans may be empty.
function strictPlan(list, b, label, limit) {
    if (!Array.isArray(list) || list.length > 3) throw fail(400, 'INVALID_STRICT', `${label}: use at most 3 breaks.`);
    if (!list.length) return [];
    const checked = core().validate(list.map(x => ({ start: x?.start, end: x?.end })), b, limit);
    if (!checked.valid) throw fail(400, 'INVALID_STRICT', `${label}: ${checked.error}`);
    return checked.breaks.map(x => ({ start: x.start, end: x.end }));
}
export function normalizeStrict(input, b) {
    if (!input || typeof input !== 'object') throw fail(400, 'INVALID_STRICT', 'Strict settings are missing.');
    const f = input.flexible || {}, s = input.scheduled || {}, out = defaultStrict();
    if (typeof f.enabled !== 'boolean' || typeof s.enabled !== 'boolean') throw fail(400, 'INVALID_STRICT', 'Turn each strict mode on or off.');
    const allowance = input.allowance ?? BREAKS.allowance;
    if (!Number.isInteger(allowance) || allowance < BREAKS.allowanceMin || allowance > BREAKS.allowance || allowance % BREAKS.allowanceStep)
        throw fail(400, 'INVALID_ALLOWANCE', 'Choose a daily maximum from 1 to 3 hours, in 15-minute steps.');
    if (!Number.isInteger(f.minimum) || f.minimum < STRICT.flexMin || f.minimum > STRICT.flexMax)
        throw fail(400, 'INVALID_STRICT', `The Flexible minimum must be ${STRICT.flexMin} to ${STRICT.flexMax} minutes.`);
    const d = s.deadline_minutes;
    if (!Number.isInteger(d) || d < STRICT.deadlineMin || d > STRICT.deadlineMax || d % STRICT.deadlineStep)
        throw fail(400, 'INVALID_STRICT', 'Choose a deadline between 1 and 18 hours after your day starts, in 15-minute steps.');
    if (f.minimum > allowance) throw fail(400, 'INVALID_STRICT', 'The Flexible minimum can’t be longer than your daily maximum.');
    out.allowance = allowance;
    out.flexible = { enabled: f.enabled, minimum: f.minimum };
    out.scheduled.enabled = s.enabled; out.scheduled.deadline_minutes = d;
    out.scheduled.default = strictPlan(s.default ?? [], b, 'Default plan', allowance);
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (let i = 0; i < 7; i++) {
        const day = s.days?.[i] ?? s.days?.[String(i)] ?? { mode: 'default' };
        if (!['default', 'custom', 'off'].includes(day.mode)) throw fail(400, 'INVALID_STRICT', `${names[i]}: choose the default plan, its own plan, or not covered.`);
        out.scheduled.days[i] = { mode: day.mode, breaks: day.mode === 'custom' ? strictPlan(day.breaks ?? [], b, names[i], allowance) : [] };
    }
    out.timezone = typeof input.timezone === 'string' ? core().timezone(input.timezone) : null;
    return out;
}
// Required work for today (same due-date rules as the phone gate, bonus tasks excluded).
// Corrupt entries count as required so they cannot unlock strict settings.
export function requiredTasksToday(snapshot, now = Date.now()) {
    const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    const hour = hourOf(snapshot?.settings), today = new Date(now + 3 * 3600000 - hour * 3600000).toISOString().slice(0, 10);
    const byId = new Map(tasks.filter(t => t && typeof t === 'object').map(t => [t.id, t]));
    const due = task => {
        const seen = new Set();
        while (task) {
            if (seen.has(task)) return '';
            seen.add(task);
            const value = typeof task.due_date === 'string' ? task.due_date.trim().toLowerCase() : '';
            if (value) return value;
            task = byId.get(task.parent_id);
        }
        return '';
    };
    return tasks.filter(t => {
        if (!t || typeof t !== 'object') return true;
        if (t.status !== 'active' || t.is_bonus) return false;
        const d = due(t);
        return !d || d === 'today' || (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today);
    }).length;
}

// Close the planning window and any finished Flexible break as of `now`, then apply
// Scheduled Strict Mode once its deadline has passed. Pure: callers persist the result
// only inside their own transaction, so the outcome does not depend on when (or whether)
// a request arrived at the deadline.
export function settle(r, now, cfg = null) {
    if (r.planning && !r.planning.saved && now >= r.planning.deadline) r.planning = null;
    const strict = strictDay(r, cfg);
    const strictDue = strict?.covered && !r.scheduled.saved_at && !scheduledLocked(r) && now >= strict.deadline;
    const a = r.flexible.active;
    if (a && strictDue && a.started_at < strict.deadline && a.planned_end > strict.deadline)
        finish(r, strict.deadline, 'strict', limitOf(r, cfg));
    else if (a && now >= a.planned_end) finish(r, a.planned_end, 'automatic', limitOf(r, cfg));
    if (strictDue) {
        let breaks = [], invalid = false;
        if (strict.breaks.length) { const c = core().validate(strict.breaks, bounds(r), Math.max(0, limitOf(r, cfg) - r.flexible.used)); breaks = c.valid ? c.breaks : []; invalid = !c.valid; }
        r.allowance = limitOf(r, cfg);
        r.planning = null; // an unsaved planning window is discarded
        r.system = 'scheduled'; r.locked_at = strict.deadline; r.lock_source = 'strict';
        r.scheduled = { breaks, saved_at: strict.deadline, strict: true, ...(invalid ? { strict_invalid: true } : {}) };
    }
    return r;
}
function finish(r, endedAt, reason, limit = limitOf(r)) {
    const a = r.flexible.active, charged = chargeMinutes(a.started_at, endedAt);
    r.flexible.used = Math.min(limit, r.flexible.used + charged);
    r.flexible.sessions.push({ id: a.id, operation_id: a.operation_id, mode: a.mode, minutes: a.minutes,
        started_at: a.started_at, ended_at: endedAt, charged, reason });
    r.flexible.active = null;
}
function usedNow(r, now, limit = limitOf(r)) {
    const a = r.flexible.active;
    return Math.min(limit, r.flexible.used + (a ? chargeMinutes(a.started_at, Math.min(now, a.planned_end)) : 0));
}
function scheduledActive(r, now) {
    if (!r.scheduled.saved_at || planningOpen(r, now)) return false;
    return r.scheduled.breaks.some(b => { const t = core().interval(b, bounds(r)); return now >= t.startTime && now < t.endTime; });
}
const flexibleActive = (r, now) => !!r.flexible.active && now >= r.flexible.active.started_at && now < r.flexible.active.planned_end;

// The synced snapshot keeps a read-only copy so statistics and older views still work.
export function mirror(r, now) {
    const zone = r.timezone, iso = ms => new Date(ms).toISOString();
    const flexible = [...r.flexible.sessions.map(s => [s.started_at, s.ended_at]),
        ...(r.flexible.active ? [[r.flexible.active.started_at, r.flexible.active.planned_end]] : [])]
        .map(([s, e]) => ({ start: clock(s, zone), end: clock(e, zone), start_at: iso(s), end_at: iso(e), kind: 'flexible' }));
    return { date: r.date, timezone: zone, day_start_hour: r.day_start_hour, cycle_start: r.cycle_start, cycle_end: r.cycle_end,
        server_managed: true, system: r.system, window_started_at: r.planning?.started_at ?? null, locked: !planningOpen(r, now),
        breaks: [...r.scheduled.breaks, ...flexible] };
}

export class BreakSystems {
    constructor(service) { this.service = service; this.storage = service.storage; }

    // Resolve the account's current logical day. A day, once created, keeps its pinned
    // boundaries until it ends; settings, timezone or device changes only affect the next
    // day, which always starts where the previous one ended and lasts at least 20 hours.
    async resolve(store, account, snapshot, zone, now) {
        const index = await store.get(indexKey(account)) || { dates: [] };
        const latestDate = index.dates.at(-1), latest = latestDate ? await store.get(dayKey(account, latestDate)) : null;
        if (latest && now >= latest.cycle_start && now < latest.cycle_end) return { record: latest, index, created: false };
        const legacy = core().normalize(snapshot?.today_breaks || {}, null, now);
        const pinned = Object.values(legacy).find(v => Number.isFinite(v.cycle_start) && Number.isFinite(v.cycle_end) &&
            v.cycle_start <= now && now < v.cycle_end && v.cycle_end - v.cycle_start >= BREAKS.minDay && (!latest || v.cycle_start >= latest.cycle_end) && (!latest || v.date > latest.date));
        let date, start, end, hour, z;
        if (pinned) { date = pinned.date; start = pinned.cycle_start; end = pinned.cycle_end; hour = hourOf(pinned); z = core().timezone(pinned.timezone); }
        else {
            z = core().timezone(zone || latest?.timezone); hour = hourOf(snapshot?.settings);
            const b = core().bounds({ day_start_hour: hour }, now, z);
            date = b.dateStr; start = +b.start; end = +b.end;
            if (latest) {
                if (date <= latest.date) { date = addDate(latest.date, 1); start = latest.cycle_end; end = +core().dayBounds(date, hour, z).end; }
                else if (latest.cycle_end > start) start = latest.cycle_end;
            }
            for (let i = 0; i < 4 && (end - start < BREAKS.minDay || end <= now); i++) { date = addDate(date, 1); end = +core().dayBounds(date, hour, z).end; }
        }
        const record = migrateLegacy(blank(date, z, hour, start, end, now), legacy[date], now);
        return { record, index, created: true };
    }

    async persist(tx, account, record, index, created) {
        record.revision++;
        await tx.put(dayKey(account, record.date), record);
        if (!created) return;
        const dates = [...new Set([...index.dates, record.date])].sort();
        const expired = dates.splice(0, Math.max(0, dates.length - BREAKS.retention));
        if (expired.length) await tx.delete(expired.map(d => dayKey(account, d)));
        await tx.put(indexKey(account), { dates });
    }

    view(r, now, cfg = null, extra = {}) {
        const total = limitOf(r, cfg), used = usedNow(r, now, total), reserved = scheduledMinutes(r), remaining = Math.max(0, total - used - reserved), a = r.flexible.active, minimum = flexMinimum(cfg);
        const gapUntil = flexGapUntil(r, cfg), gap = gapUntil > now ? gapUntil : null;
        const untilReset = r.cycle_end - now, saved = !!r.scheduled.saved_at, open = planningOpen(r, now);
        let planReason = '';
        if (open) planReason = '';
        else if (r.lock_source === 'strict') planReason = r.scheduled.breaks.length
            ? 'Scheduled Strict Mode locked today’s plan at its deadline. It can’t be changed until the day resets.'
            : 'Scheduled Strict Mode locked today with no breaks at its deadline. You can plan again after the day resets.';
        else if (saved) planReason = 'Today’s schedule is final. You can plan again after the day resets.';
        else if (now >= r.cycle_end - BREAKS.closing) planReason = 'Scheduled planning closes 6 hours before the day ends.';
        let flexReason = '';
        if (scheduledLocked(r)) flexReason = 'Scheduled breaks are locked for today, so Flexible breaks are unavailable.';
        else if (a) flexReason = 'A Flexible break is already running.';
        else if (gap) flexReason = `Flexible Strict Mode needs ${minimum} minutes between breaks. You can start again in ${Math.ceil((gap - now) / MIN)} min.`;
        else if (remaining < minimum) flexReason = `Less than ${minimum} minutes of today’s break allowance remain.`;
        else if (untilReset < minimum * MIN) flexReason = `Less than ${minimum} minutes remain before the day resets.`;
        const presets = BREAKS.presets.map(minutes => ({ minutes, available: !flexReason && minutes <= remaining && minutes >= minimum,
            reason: flexReason || (minutes < minimum ? `Flexible Strict Mode requires at least ${minimum} minutes.` : minutes > remaining ? `Only ${remaining} minutes of allowance remain.` : '') }));
        const strict = strictDay(r, cfg);
        return {
            date: r.date, timezone: r.timezone, day_start_hour: r.day_start_hour, cycle_start: r.cycle_start, cycle_end: r.cycle_end,
            reset_at: new Date(r.cycle_end).toISOString(), server_now: now, revision: r.revision,
            system: r.system, locked_at: r.locked_at, lock_source: r.lock_source,
            allowance: { total, used, reserved, remaining },
            scheduled: { breaks: r.scheduled.breaks, saved, saved_at: r.scheduled.saved_at, closing_at: r.cycle_end - BREAKS.closing,
                planning: r.planning ? { started_at: r.planning.started_at, deadline: r.planning.deadline, saved: !!r.planning.saved, open } : null,
                can_start_planning: !planReason && !open, can_edit: open, locked: scheduledLocked(r), reason: planReason, final: saved && !open },
            flexible: {
                active: a ? { id: a.id, mode: a.mode, minutes: a.minutes, started_at: a.started_at, ends_at: a.planned_end, can_end_at: a.minimum_end, minimum: a.minimum || BREAKS.flexMinimum } : null,
                minimum, strict: !!cfg?.flexible?.enabled, gap_until: gap, gap_minutes: cfg?.flexible?.enabled ? minimum : 0, presets, max_custom: Math.max(0, remaining), can_start: !flexReason, reason: flexReason,
                sessions: r.flexible.sessions.map(({ operation_id, ...s }) => s)
            },
            strict_today: strict ? { covered: strict.covered, weekday: strict.weekday, ...(strict.covered ? { deadline: strict.deadline, mode: strict.mode,
                breaks: strict.breaks, pending: !r.scheduled.saved_at && !scheduledLocked(r) && now < strict.deadline } : {}) } : null,
            in_break: scheduledActive(r, now) || flexibleActive(r, now),
            record: mirror(r, now),
            ...extra
        };
    }

    async snapshot(store, account) { return (await this.service.readTaskSnapshot(store, account)).snapshot; }

    async strictDoc(store, account) { return await store.get(strictKey(account)) || null; }
    // Break settings (daily maximum and strict modes) are locked while today's required tasks
    // remain, exactly like the phone. A break does not unlock them; an emergency bypass does.
    async bypassActive(store, account) {
        try { return !!(await this.service.protection?.bypass(store, account)); } catch { return false; }
    }
    strictInfo(doc, snapshot, today, now, bypass = false) {
        const required = requiredTasksToday(snapshot, now);
        return { strict: { config: { ...defaultStrict(), ...(doc?.current?.config || {}), allowance: allowanceOf(doc?.current?.config) },
            effective_today: strictFor(doc, today.date),
            pending_from: doc?.current?.from && doc.current.from > today.date ? doc.current.from : null,
            revision: doc?.revision || 0, locked: required > 0 && !bypass, required_tasks: required, bypass: !!bypass,
            limits: { ...STRICT, allowanceMin: BREAKS.allowanceMin, allowanceMax: BREAKS.allowance, allowanceStep: BREAKS.allowanceStep } } };
    }

    async state(account, zone, now = Date.now()) {
        return this.storage.transaction(async tx => {
            const snapshot = await this.snapshot(tx, account), doc = await this.strictDoc(tx, account);
            const { record } = await this.resolve(tx, account, snapshot, zone || doc?.current?.config?.timezone, now);
            const cfg = strictFor(doc, record.date), bypass = await this.bypassActive(tx, account);
            return this.view(settle(record, now, cfg), now, cfg, this.strictInfo(doc, snapshot, record, now, bypass));
        });
    }

    async act(account, body, now = Date.now()) {
        const action = body?.action;
        if (!['lock', 'plan_start', 'plan_cancel', 'schedule_save', 'flex_start', 'flex_end', 'strict_save'].includes(action))
            throw fail(400, 'INVALID_BREAK_ACTION', 'Choose a valid break action.');
        return this.storage.transaction(async tx => {
            const snapshot = await this.snapshot(tx, account), doc = await this.strictDoc(tx, account);
            const { record: r, index, created } = await this.resolve(tx, account, snapshot, body.timezone, now);
            const cfg = strictFor(doc, r.date);
            settle(r, now, cfg); // a passed strict deadline is applied before any conflicting action
            const bypass = await this.bypassActive(tx, account);
            if (action === 'strict_save') {
                const next = await this.saveStrict(tx, account, doc, r, snapshot, body, now, bypass);
                await this.persist(tx, account, r, index, created);
                return this.view(r, now, strictFor(next, r.date), this.strictInfo(next, snapshot, r, now, bypass));
            }
            const replay = this.apply(r, action, body, now, cfg);
            if (r.system && !Number.isInteger(r.allowance)) r.allowance = allowanceOf(cfg); // the day keeps its maximum
            const info = this.strictInfo(doc, snapshot, r, now, bypass);
            if (replay) return { ...this.view(r, now, cfg, info), replayed: true };
            await this.persist(tx, account, r, index, created);
            return this.view(r, now, cfg, info);
        });
    }

    // Any change to break settings (daily maximum, either strict mode) needs today's required
    // (non-bonus) tasks to be done, or an active emergency bypass; a break never unlocks it.
    // A change applies today only while today has no system yet and today's strict deadline
    // has not passed; otherwise it applies from the next logical day, so a locked day is
    // never rewritten.
    async saveStrict(tx, account, doc, r, snapshot, body, now, bypass = false) {
        if (!Number.isSafeInteger(body.revision) || body.revision !== (doc?.revision || 0))
            throw fail(409, 'STRICT_CHANGED', 'Break settings changed on another device. Reload them before saving.');
        const latest = { ...defaultStrict(), ...(doc?.current?.config || {}), allowance: allowanceOf(doc?.current?.config) };
        // An older page that doesn't know the daily maximum keeps the saved one.
        const allowance = body.config?.allowance ?? latest.allowance;
        const next = normalizeStrict({ ...body.config, allowance, timezone: body.timezone ?? body.config?.timezone }, bounds(r));
        const changed = ['allowance', 'flexible', 'scheduled'].some(k => !same(latest[k], next[k]));
        const required = requiredTasksToday(snapshot, now);
        if (required && changed && !bypass)
            throw fail(403, 'STRICT_LOCKED', `Break settings can’t be changed while ${required} required task${required === 1 ? '' : 's'} for today ${required === 1 ? 'is' : 'are'} unfinished. An emergency bypass lifts this.`);
        const deadline = next.scheduled.enabled ? r.cycle_start + next.scheduled.deadline_minutes * MIN : Infinity;
        const today = !r.system && now < deadline && !r.flexible.active;
        const from = today ? r.date : addDate(r.date, 1);
        const previous = doc?.current && (!doc.current.from || doc.current.from <= r.date) ? doc.current : doc?.previous || null;
        const saved = { revision: (doc?.revision || 0) + 1, updated_at: now, current: { config: next, from }, previous };
        await tx.put(strictKey(account), saved);
        return saved;
    }

    // Returns true for a harmless repeat (nothing to store); throws when the action is not allowed.
    apply(r, action, body, now, cfg = null) {
        const open = planningOpen(r, now), minimum = flexMinimum(cfg);
        if (action === 'lock') {
            if (body.system !== 'scheduled') throw fail(400, 'INVALID_SYSTEM', 'Only Scheduled breaks can be locked.');
            if (scheduledLocked(r)) return true;
            if (r.flexible.active) throw fail(409, 'BREAK_ACTIVE', 'End your active Flexible break before locking Scheduled breaks.');
            r.v = 2; r.system = 'scheduled'; r.locked_at = now; r.lock_source = 'lock';
            return false;
        }
        if (action === 'plan_start') {
            if (r.scheduled.saved_at) throw fail(409, 'SCHEDULE_SAVED', open ? 'Your planning window is still open.' : 'Today’s schedule is final.');
            if (open) return true; // another device or retry joins the same window and deadline
            if (now >= r.cycle_end - BREAKS.closing) throw fail(409, 'PLANNING_CLOSED', 'Scheduled planning closes 6 hours before the day ends.');
            r.planning = { started_at: now, deadline: now + BREAKS.window, saved: false };
            return false;
        }
        if (action === 'plan_cancel') {
            if (!r.planning || r.planning.saved) return true; // saved windows are never cancelled
            r.planning = null;
            return false;
        }
        if (action === 'schedule_save') {
            if (!open) throw fail(409, r.scheduled.saved_at ? 'PLANNING_ENDED' : 'PLANNING_REQUIRED',
                r.scheduled.saved_at ? 'The planning window has ended. Today’s last saved schedule is final.' : 'Start a planning window first.');
            const list = body.breaks;
            if (!Array.isArray(list) || list.length > 3) throw fail(400, 'INVALID_SCHEDULE', 'Enter between 1 and 3 complete break times.');
            let breaks = [];
            if (list.length) {
                const checked = core().validate(list, bounds(r), Math.max(0, limitOf(r, cfg) - usedNow(r, now, limitOf(r, cfg))));
                if (!checked.valid) throw fail(400, 'INVALID_SCHEDULE', checked.error);
                breaks = checked.breaks;
            } else if (!r.scheduled.saved_at) throw fail(400, 'INVALID_SCHEDULE', 'Add at least one break before the first save.');
            const reserved = breaks.reduce((sum, b) => { const t = core().interval(b, bounds(r)); return sum + (t.endTime - t.startTime) / MIN; }, 0);
            const active = r.flexible.active;
            if (active && breaks.some(b => { const t = core().interval(b, bounds(r)); return t.startTime < active.planned_end && t.endTime > active.started_at; })) throw fail(409, 'BREAK_OVERLAP', 'A scheduled break cannot overlap the active Flexible break.');
            if (active && reserved + r.flexible.used + active.minutes > limitOf(r, cfg)) throw fail(409, 'ALLOWANCE_LOW', 'The active Flexible break and this schedule exceed the daily allowance.');
            if (!scheduledLocked(r) && cfg?.flexible?.enabled && limitOf(r, cfg) - usedNow(r, now, limitOf(r, cfg)) - reserved < minimum) throw fail(409, 'STRICT_MINIMUM', `Leave at least ${minimum} minutes for Flexible Strict Mode, or lock Scheduled breaks.`);
            r.scheduled = { breaks, saved_at: now };
            r.planning.saved = true;
            if (!r.system) { r.system = 'scheduled'; r.locked_at = now; r.lock_source = 'save'; }
            return false;
        }
        if (action === 'flex_start') {
            const op = body.operation_id;
            if (typeof op !== 'string' || !OPERATION.test(op)) throw fail(400, 'INVALID_OPERATION', 'A valid request ID is required.');
            if (r.flexible.active?.operation_id === op || r.flexible.sessions.some(s => s.operation_id === op)) return true;
            if (scheduledLocked(r)) throw fail(409, 'SYSTEM_LOCKED', 'Scheduled breaks are locked for today.');
            if (r.flexible.active) throw fail(409, 'BREAK_ACTIVE', 'A Flexible break is already running.');
            const gap = flexGapUntil(r, cfg);
            if (gap > now) throw fail(409, 'STRICT_GAP', `Flexible Strict Mode needs ${minimum} minutes between breaks. You can start again in ${Math.ceil((gap - now) / MIN)} min.`);
            const remaining = Math.max(0, limitOf(r, cfg) - r.flexible.used - scheduledMinutes(r));
            if (remaining < minimum) throw fail(409, 'ALLOWANCE_LOW', `Less than ${minimum} minutes of today’s break allowance remain.`);
            if (r.cycle_end - now < minimum * MIN) throw fail(409, 'RESET_SOON', `Less than ${minimum} minutes remain before the day resets.`);
            let minutes = body.minutes;
            if (body.mode === 'preset') {
                if (!BREAKS.presets.includes(minutes)) throw fail(400, 'INVALID_DURATION', 'Choose a 30-, 45- or 60-minute break.');
                if (minutes < minimum) throw fail(409, 'STRICT_MINIMUM', `Flexible Strict Mode requires at least ${minimum} minutes.`);
                if (minutes > remaining) throw fail(409, 'ALLOWANCE_LOW', `Only ${remaining} minutes of allowance remain.`);
            } else if (body.mode === 'custom') {
                if (!Number.isInteger(minutes) || minutes < minimum || minutes > remaining)
                    throw fail(400, 'INVALID_DURATION', `Choose a whole number of minutes from ${minimum} to ${remaining}.`);
            } else if (body.mode === 'until') minutes = remaining;
            else throw fail(400, 'INVALID_DURATION', 'Choose a break length.');
            const intervals = r.scheduled.breaks.map(b => core().interval(b, bounds(r)));
            if (intervals.some(t => now >= t.startTime && now < t.endTime)) throw fail(409, 'BREAK_OVERLAP', 'A Scheduled break is already running.');
            if (intervals.some(t => t.startTime > now && t.startTime < now + minutes * MIN)) throw fail(409, 'BREAK_OVERLAP', 'This Flexible break would overlap a Scheduled break. Choose a shorter break.');
            r.flexible.active = { id: 'brk_' + crypto.randomUUID(), operation_id: op, mode: body.mode, minutes,
                started_at: now, planned_end: Math.min(now + minutes * MIN, r.cycle_end), minimum_end: now + minimum * MIN, minimum };
            lock(r, 'flexible', 'flex_start', now);
            return false;
        }
        // flex_end
        const a = r.flexible.active;
        if (!a) {
            if (body.break_id && r.flexible.sessions.some(s => s.id === body.break_id)) return true;
            throw fail(409, 'NO_ACTIVE_BREAK', 'No Flexible break is running.');
        }
        if (body.break_id && body.break_id !== a.id) throw fail(409, 'BREAK_CHANGED', 'This break has already ended. Refresh the break panel.');
        if (now < a.minimum_end) throw fail(409, 'MINIMUM_NOT_REACHED', `This Flexible break can be ended after ${a.minimum || BREAKS.flexMinimum} minutes.`);
        finish(r, now, 'manual', limitOf(r, cfg));
        return false;
    }

    // Read-only: current-day server state for /status. Never creates or changes records.
    // With Scheduled Strict Mode on, a day nobody has touched is still evaluated, so an
    // automatic strict schedule works even if the app was closed at its deadline.
    async current(store, account, now = Date.now(), snapshot = null) {
        const doc = await this.strictDoc(store, account);
        const index = await store.get(indexKey(account)), date = index?.dates?.at(-1);
        let r = date ? await store.get(dayKey(account, date)) : null;
        if (!(r && now >= r.cycle_start && now < r.cycle_end)) {
            if (!doc?.current || !snapshot) return null;
            r = (await this.resolve(store, account, snapshot, doc.current.config.timezone, now)).record;
        }
        return settle(r, now, strictFor(doc, r.date));
    }
    async inBreak(store, account, now = Date.now(), snapshot = null) {
        const r = await this.current(store, account, now, snapshot);
        return { in_break: !!r && (flexibleActive(r, now) || scheduledActive(r, now)), system: r?.system || null };
    }

    // Replace synced break records with the server-owned copies for every stored day.
    async overlay(store, account, todayBreaks, now = Date.now()) {
        const out = core().normalize(todayBreaks || {}, null, now), index = await store.get(indexKey(account));
        const dates = index?.dates || [];
        if (!dates.length) return out;
        const records = await store.get(dates.map(d => dayKey(account, d)));
        for (const r of records.values()) if (r) out[r.date] = mirror(settle(r, now), now);
        return out;
    }

    async remove(store, account) {
        const days = await store.list({ prefix: dayKey(account, ''), limit: 200 });
        const keys = [...days.keys(), indexKey(account), strictKey(account)];
        for (let i = 0; i < keys.length; i += 100) await store.delete(keys.slice(i, i + 100));
    }
}

// ============================================================================
// Taskitator server-owned daily break systems (break-systems.js)
// Scheduled planning and Flexible breaks share one record per account and logical
// day. Only this module writes those records; synced snapshots cannot change them.
// ============================================================================
import { fail } from './pro-backend.js';

export const BREAKS = Object.freeze({
    allowance: 180,          // minutes per logical day, shared by both systems
    flexMinimum: 10,         // minutes before a Flexible break can be ended manually
    presets: Object.freeze([30, 45, 60]),
    window: 600000,          // Scheduled planning window (10 minutes)
    closing: 6 * 3600000,    // Scheduled planning closes 6 hours before the day ends
    minDay: 20 * 3600000,    // shortest logical day a settings change can produce
    retention: 90            // days of records kept for history and statistics
});
const MIN = 60000, OPERATION = /^[A-Za-z0-9_-]{8,100}$/;
const core = () => {
    if (!globalThis.TaskitatorBreaks) throw fail(503, 'BREAKS_UNAVAILABLE', 'Break rules are unavailable. Retry shortly.');
    return globalThis.TaskitatorBreaks;
};
const dayKey = (account, date) => 'breaks:day:' + account + ':' + date;
const indexKey = account => 'breaks:index:' + account;
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
    return { v: 1, date, timezone: zone, day_start_hour: hour, cycle_start: start, cycle_end: end, created_at: now,
        system: null, locked_at: null, lock_source: null, planning: null,
        scheduled: { breaks: [], saved_at: null }, flexible: { used: 0, active: null, sessions: [] }, revision: 0 };
}
function lock(r, system, source, now) { if (!r.system) { r.system = system; r.locked_at = now; r.lock_source = source; } }
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

// Close the planning window and any finished Flexible break as of `now`. Pure: callers
// persist the result only inside their own transaction.
export function settle(r, now) {
    if (r.planning && !r.planning.saved && now >= r.planning.deadline) r.planning = null;
    const a = r.flexible.active;
    if (a && now >= a.planned_end) finish(r, a.planned_end, 'automatic');
    return r;
}
function finish(r, endedAt, reason) {
    const a = r.flexible.active, charged = chargeMinutes(a.started_at, endedAt);
    r.flexible.used = Math.min(BREAKS.allowance, r.flexible.used + charged);
    r.flexible.sessions.push({ id: a.id, operation_id: a.operation_id, mode: a.mode, minutes: a.minutes,
        started_at: a.started_at, ended_at: endedAt, charged, reason });
    r.flexible.active = null;
}
function usedNow(r, now) {
    const a = r.flexible.active;
    return Math.min(BREAKS.allowance, r.flexible.used + (a ? chargeMinutes(a.started_at, Math.min(now, a.planned_end)) : 0));
}
function scheduledActive(r, now) {
    if (r.system !== 'scheduled' || planningOpen(r, now)) return false;
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
        breaks: r.system === 'flexible' ? flexible : r.scheduled.breaks };
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

    view(r, now) {
        const used = usedNow(r, now), remaining = BREAKS.allowance - used, a = r.flexible.active;
        const untilReset = r.cycle_end - now, saved = !!r.scheduled.saved_at, open = planningOpen(r, now);
        let planReason = '';
        if (r.system === 'flexible') planReason = 'Flexible Breaks are selected for today. Scheduled becomes available after the day resets.';
        else if (saved && open) planReason = '';
        else if (saved) planReason = 'Today’s schedule is final. You can plan again after the day resets.';
        else if (now >= r.cycle_end - BREAKS.closing) planReason = 'Scheduled planning closes 6 hours before the day ends.';
        let flexReason = '';
        if (r.system === 'scheduled') flexReason = 'Scheduled Breaks are selected for today. Flexible becomes available after the day resets.';
        else if (a) flexReason = 'A Flexible break is already running.';
        else if (remaining < BREAKS.flexMinimum) flexReason = `Less than ${BREAKS.flexMinimum} minutes of today’s break allowance remain.`;
        else if (untilReset < BREAKS.flexMinimum * MIN) flexReason = `Less than ${BREAKS.flexMinimum} minutes remain before the day resets.`;
        const presets = BREAKS.presets.map(minutes => ({ minutes, available: !flexReason && minutes <= remaining,
            reason: flexReason || (minutes > remaining ? `Only ${remaining} minutes of allowance remain.` : '') }));
        return {
            date: r.date, timezone: r.timezone, day_start_hour: r.day_start_hour, cycle_start: r.cycle_start, cycle_end: r.cycle_end,
            reset_at: new Date(r.cycle_end).toISOString(), server_now: now, revision: r.revision,
            system: r.system, locked_at: r.locked_at, lock_source: r.lock_source,
            allowance: { total: BREAKS.allowance, used, remaining },
            scheduled: { breaks: r.scheduled.breaks, saved, saved_at: r.scheduled.saved_at, closing_at: r.cycle_end - BREAKS.closing,
                planning: r.planning ? { started_at: r.planning.started_at, deadline: r.planning.deadline, saved: !!r.planning.saved, open } : null,
                can_start_planning: !planReason && !open, can_edit: r.system !== 'flexible' && open, reason: planReason, final: saved && !open },
            flexible: {
                active: a ? { id: a.id, mode: a.mode, minutes: a.minutes, started_at: a.started_at, ends_at: a.planned_end, can_end_at: a.minimum_end } : null,
                minimum: BREAKS.flexMinimum, presets, max_custom: Math.max(0, remaining), can_start: !flexReason, reason: flexReason,
                sessions: r.flexible.sessions.map(({ operation_id, ...s }) => s)
            },
            in_break: scheduledActive(r, now) || flexibleActive(r, now),
            record: mirror(r, now)
        };
    }

    async snapshot(store, account) { return (await this.service.readTaskSnapshot(store, account)).snapshot; }

    async state(account, zone, now = Date.now()) {
        return this.storage.transaction(async tx => {
            const snapshot = await this.snapshot(tx, account);
            const { record } = await this.resolve(tx, account, snapshot, zone, now);
            return this.view(settle(record, now), now);
        });
    }

    async act(account, body, now = Date.now()) {
        const action = body?.action;
        if (!['lock', 'plan_start', 'plan_cancel', 'schedule_save', 'flex_start', 'flex_end'].includes(action))
            throw fail(400, 'INVALID_BREAK_ACTION', 'Choose a valid break action.');
        return this.storage.transaction(async tx => {
            const snapshot = await this.snapshot(tx, account);
            const { record: r, index, created } = await this.resolve(tx, account, snapshot, body.timezone, now);
            settle(r, now);
            const replay = this.apply(r, action, body, now);
            if (replay) return { ...this.view(r, now), replayed: true };
            await this.persist(tx, account, r, index, created);
            return this.view(r, now);
        });
    }

    // Returns true for a harmless repeat (nothing to store); throws when the action is not allowed.
    apply(r, action, body, now) {
        const open = planningOpen(r, now);
        if (action === 'lock') {
            if (!['scheduled', 'flexible'].includes(body.system)) throw fail(400, 'INVALID_SYSTEM', 'Choose Scheduled or Flexible.');
            if (r.system === body.system) return true;
            if (r.system) throw fail(409, 'SYSTEM_LOCKED', `${r.system === 'scheduled' ? 'Scheduled' : 'Flexible'} Breaks are already locked for today.`);
            if (body.system === 'flexible' && r.planning && !r.planning.saved) r.planning = null;
            lock(r, body.system, 'lock', now);
            return false;
        }
        if (action === 'plan_start') {
            if (r.system === 'flexible') throw fail(409, 'SYSTEM_LOCKED', 'Flexible Breaks are selected for today.');
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
            if (r.system === 'flexible') throw fail(409, 'SYSTEM_LOCKED', 'Flexible Breaks are selected for today.');
            if (!open) throw fail(409, r.scheduled.saved_at ? 'PLANNING_ENDED' : 'PLANNING_REQUIRED',
                r.scheduled.saved_at ? 'The planning window has ended. Today’s last saved schedule is final.' : 'Start a planning window first.');
            const list = body.breaks;
            if (!Array.isArray(list) || list.length > 3) throw fail(400, 'INVALID_SCHEDULE', 'Enter between 1 and 3 complete break times.');
            let breaks = [];
            if (list.length) {
                const checked = core().validate(list, bounds(r));
                if (!checked.valid) throw fail(400, 'INVALID_SCHEDULE', checked.error);
                breaks = checked.breaks;
            } else if (!r.scheduled.saved_at) throw fail(400, 'INVALID_SCHEDULE', 'Add at least one break before the first save.');
            r.scheduled = { breaks, saved_at: now };
            r.planning.saved = true;
            lock(r, 'scheduled', 'save', now);
            return false;
        }
        if (action === 'flex_start') {
            const op = body.operation_id;
            if (typeof op !== 'string' || !OPERATION.test(op)) throw fail(400, 'INVALID_OPERATION', 'A valid request ID is required.');
            if (r.flexible.active?.operation_id === op || r.flexible.sessions.some(s => s.operation_id === op)) return true;
            if (r.system === 'scheduled') throw fail(409, 'SYSTEM_LOCKED', 'Scheduled Breaks are selected for today.');
            if (r.flexible.active) throw fail(409, 'BREAK_ACTIVE', 'A Flexible break is already running.');
            const remaining = BREAKS.allowance - r.flexible.used;
            if (remaining < BREAKS.flexMinimum) throw fail(409, 'ALLOWANCE_LOW', `Less than ${BREAKS.flexMinimum} minutes of today’s break allowance remain.`);
            if (r.cycle_end - now < BREAKS.flexMinimum * MIN) throw fail(409, 'RESET_SOON', `Less than ${BREAKS.flexMinimum} minutes remain before the day resets.`);
            let minutes = body.minutes;
            if (body.mode === 'preset') {
                if (!BREAKS.presets.includes(minutes)) throw fail(400, 'INVALID_DURATION', 'Choose a 30-, 45- or 60-minute break.');
                if (minutes > remaining) throw fail(409, 'ALLOWANCE_LOW', `Only ${remaining} minutes of allowance remain.`);
            } else if (body.mode === 'custom') {
                if (!Number.isInteger(minutes) || minutes < BREAKS.flexMinimum || minutes > remaining)
                    throw fail(400, 'INVALID_DURATION', `Choose a whole number of minutes from ${BREAKS.flexMinimum} to ${remaining}.`);
            } else if (body.mode === 'until') minutes = remaining;
            else throw fail(400, 'INVALID_DURATION', 'Choose a break length.');
            if (r.planning && !r.planning.saved) r.planning = null;
            r.flexible.active = { id: 'brk_' + crypto.randomUUID(), operation_id: op, mode: body.mode, minutes,
                started_at: now, planned_end: Math.min(now + minutes * MIN, r.cycle_end), minimum_end: now + BREAKS.flexMinimum * MIN };
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
        if (now < a.minimum_end) throw fail(409, 'MINIMUM_NOT_REACHED', `A Flexible break can be ended after ${BREAKS.flexMinimum} minutes.`);
        finish(r, now, 'manual');
        return false;
    }

    // Read-only: current-day server state for /status. Never creates or changes records.
    async current(store, account, now = Date.now()) {
        const index = await store.get(indexKey(account)), date = index?.dates?.at(-1);
        const r = date ? await store.get(dayKey(account, date)) : null;
        return r && now >= r.cycle_start && now < r.cycle_end ? settle(r, now) : null;
    }
    async inBreak(store, account, now = Date.now()) {
        const r = await this.current(store, account, now);
        return { in_break: !!r && flexibleActive(r, now), system: r?.system || null };
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
        const keys = [...days.keys(), indexKey(account)];
        for (let i = 0; i < keys.length; i += 100) await store.delete(keys.slice(i, i + 100));
    }
}

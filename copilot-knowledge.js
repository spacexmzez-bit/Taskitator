// File: copilot-knowledge.js
// Phase 7.3: condensed product knowledge for Copilot, one entry per page (Settings: per open tab).
// Each request sends only MAP + the current page's entry, so a simple question costs a few hundred
// input tokens, not the whole guide. Budgets are enforced by phase73.test.js:
// MAP <= 560 chars, a page entry <= 1900 chars, Settings tab map + tab entry <= 2300 chars.
// Source of truth: README Part 1. Update the matching entry when a feature changes.
(function (root) {
    'use strict';

    const MAP = 'MAP: Menu → Today, General Tasks, Calendar, Projects, Stats, Trash, Drafts, Friends, Universe, Sleep Lock, Study plans (Pro), Test lab (Pro), Recurring tasks, Help, Settings. Header: Completed, Breaks, Scratchpad, sync dot, Emergency bypass, Copilot. Settings tabs: General, Tasks, Day & week, AI & Pro, Phone lock, Account & data. ' +
        'Answer details only for the current page. For another page, say where it is and that you can explain it there. Only Today and General let you change tasks.';

    const TASKS = [
        'Today = tasks due today or overdue (undated never show). General = every active task as a tree.',
        '+ New task: title required; optional description, project, priority, tags, due date, Repeat, Shield, Bonus, Dynamic options, AI proof, Quick Subtasks. Draft parks it (not a task, no lock). Tap a task → Task Details → Save Changes.',
        'Title shortcuts + space: !name or !N (Nth priority from the top), #Project, @tag, $$ bonus; typing ! # @ shows a pick list.',
        'Subtasks: type + Enter; "$$" marks bonus. Bonus = optional, never blocks its parent. Shield (irreversible): parent completes only after its required subtasks.',
        'AI-locked (irrevocable): proof criteria; completing opens proof upload (1–5 JPG/PNG/WebP/PDF), 7/10 passes, every review costs AI usage. Rename, delete, postpone when overdue or reopen need Emergency Bypass. You cannot create, approve or complete these.',
        'Complete: tap the circle, 10 s Undo. A top-level task trashes its unprotected unfinished subtasks; reopening (same day) restores them.',
        'Overdue banner → Reschedule to date (AI tasks: Bring AI Tasks to Today). Filter (project, priority, tag, date, AND/OR), ⇅ sort, Multiselect (tags, priority, due, bonus, phone lock, delete; Pro batch review). Early task = optional on an earlier day, due date kept. Repeat: next copy appears when the current one is completed or deleted.',
        'Points strip above the list: points by priority (top level 5 … 1), max 150 a day, ranks Seedling → Legend; streak = days in a row with a counted finished task; free days (default weekend) earn nothing and never break it; "Make today required" once per free day (earlier finishes don\'t count). Streak counting mode: Settings → Day & week.',
        'Header: Breaks (one daily allowance; each day Scheduled or Flexible), Scratchpad (timed note), Focus timer, Emergency bypass (15 min, 4 a week).'
    ].join('\n');

    const PAGES = {
        today: TASKS,
        general: TASKS,
        calendar: 'Calendar: month grid, ‹ › change month, Today jumps back. Tap a date for its Agenda; tap a task to open it. Tasks can\'t be completed here (use Today or General). Early tasks show "Early · due {date}". Unscheduled Tasks lists undated tasks with Assign to Today.',
        projects: 'Projects: every account has an Inbox. The + chip creates a project (name, emoji icon, colour) → Save Project. Tap a chip to see its tasks, the date drop-down and + New task (created in that project). ✎ edits the active project (not Inbox). Delete Project asks: move tasks to Inbox, reassign to another project, or delete them.',
        stats: 'Stats: Done Today and Pending Today use your logical day (Settings → Day & week → New day begins at). Rigor Ratio = AI-verified share of all completed tasks. Active Total. 7-Day Completion Velocity. Project Allocation (completed tasks by project). Break & Focus Adherence (today\'s break system and minutes). AI verification (AI Verified vs Standard Done). Distraction Archive: notes from Scratchpad → Extract All (View raw original, delete one, Clear Archive). Completed tasks hidden from task views after their day still count. Points and streak are on the Today points strip.',
        trash: 'Trash: Restore brings back a task and its trashed subtasks (top-level if its parent is gone). Delete Forever removes it permanently; Empty trash removes all. Settings → Account & data → Clear completed & trash deletes finished and trashed tasks. Trashing a parent trashes its subtasks; AI-locked branches and shielded tasks with unfinished subtasks need Emergency Bypass to delete.',
        friends: [
            'Friends (free): friends see only points, rank, streak, this week\'s points and whether you finished a task today. Needs a username (Set username). Add by exact username (no search) → Send request. Requests: Accept, Decline (silent; sender sees Pending until it expires in 30 days), Block. Withdraw cancels yours. Limits: 50 friends, 20 waiting, 30 requests a day.',
            'Leaderboard: All time or This week (starts after your weekend). Duo streak = days you both kept your streak; a free day for either is skipped. Cheer once a day per friend. Unfriend ends it for both. Block also drops their future requests silently; unblock in Privacy → Blocked. Privacy: who can send requests (anyone with your username, only people in your Universes, nobody).',
            'Points: by task priority, max 150 a day; ranks Seedling → Legend; streak modes Loose/Normal/Tight and free days in Settings → Day & week.',
            'Collab (Pro for every member): Collabs → Start a collab, name it, pick up to 5 friends; invites last 7 days; friends join as admins. It opens in the Universe workspace (purple Collab badge). If anyone\'s Pro ends, nobody can change it until renewed (read, leave, withdraw consent still work). Counts toward Universe limits. Unfriending doesn\'t remove someone from a collab.'
        ].join('\n'),
        study_plans: [
            'Study plans (Pro; Free can view, finish, delete): units spread over study days; each day is a shielded parent with one subtask per unit; bonus units come last. Create: + or ask Copilot on Today. Steps: Task info (title, unit name, 1–1,000 units, bonus, chapter labels, priorities), optional AI criteria with {num} (audited units are locked; deleting the plan costs 2 bypass uses), Scheduling (start date, study days 1–365 or units per day, weekdays, per-weekday amounts, skipped units like 8, 10-12, Preview, tap dates, Auto redistribute), optional Early bonus, Summary → Create plan (needs a successful sync). Save draft keeps up to 10.',
            'Manage: Preview, Edit (rename, labels, priorities, add AI criteria, re-plan unfinished units), bonus units (add, remove, move, convert to required), Soft reschedule (Pro, once a day) or Move overdue to today, Export JSON / Import (template or restore), Delete.',
            'Test lab (Pro): write criteria (optional version B), test inputs (title, unit number, up to 5 proof files, reference, note). Validate scores wording; Test runs a real audit; both use credits. Save to criteria library needs 8/10. Saved on this device only.'
        ].join('\n'),
        sleep: 'Sleep Lock: blocks your phone during sleep with the MacroDroid setup (needs a phone token). Enable Sleep Lock, set Bedtime and Wake-up (Riyadh time) → Save schedule. Delay sleep for today: 30 or 60 min, once a night. Gear: Firm mode (from 2 h before bedtime until wake-up: no delay; turning off or moving times later needs Emergency Bypass; earlier is always free) and Today only (different times tonight). Breaks never lift Sleep Lock; Emergency Bypass does.',
        universe: [
            'Universe: shared group workspace, needs a connection. Tabs: My dashboard, Projects, Community, Context, My stats, Controls (owner/admins), Settings. Roles: owner, admin, reviewer, member. Join with an invitation link; create needs Pro (own 2; join 2 Free, 7 Pro; 20 members besides the owner).',
            'Tasks (owners/admins): project → task, assignment Everyone\'s (each completes own copy) or Shared (one completion; type can\'t change), auditing (none, reviewer, AI, member chooses, AI then reviewer), dates in Riyadh time, late entries, Shield/bonus. Members: open assignment → up to 3 files (5 MiB) → Submit proof; states Open → Submitted → In review → Approved or Needs changes.',
            'AI review uses your Gemini key or Universe credits (Pro). Phone blocking: Settings → Allow Universe phone blocking (withdraw anytime); blocks after deadline + 24 h notice. Controls: People, single-use Invitations, Labels. Settings: export, replace from backup, transfer ownership (to a Pro member), delete or leave. Collabs (from Friends) are small Universes.'
        ].join('\n'),
        help: 'Help: the guide in seven units (Start here, Tasks, Focus breaks and your phone, AI, Pro features, Universe, Settings sync and data). Index → unit → section (the section flashes). Try it live opens the real screen and fades everything except the control to use; what you do is real; Do it for me presses it; Skip tour stops. Settings sections offer Show me in Settings. Replay tours: Settings → General → Help & tutorials.',
        blocker_guide: [
            'Phone lock (Android, MacroDroid; not affiliated). Settings → Phone lock → Devices: name → Add device (token starts tkp_; Free 3, Pro 12). Download Bridge (with your token) and App Blocker. In MacroDroid import App Blocker first, then the Bridge; open each → Save macro; grant accessibility and notifications. Pick blocked apps in App Blocker\'s Application Launched trigger; never block the dialer, SMS, Settings, MacroDroid or your browser. Don\'t rename App Blocker. Manual build: HTTP GET Status URL, header Authorization: Bearer <token>; if response contains device_locked = false disable App Blocker, else enable.',
            'Bridge checks every 5 min, on screen on and when MacroDroid opens. Locked while counted tasks due today or overdue are unfinished; unlocked during a break, Emergency Bypass, or when all are done. Undated tasks never count. Counting mode: Settings → Tasks (Harsh/Normal/Limited).',
            'Troubleshooting: import fails → update MacroDroid, use the real .macro file. 401 → wrong or replaced token, add a device again. UnknownHostException → no internet. Nothing blocks → App Blocker enabled, imported first, original name, apps listed.'
        ].join('\n')
    };

    const SETTINGS_MAP = 'SETTINGS TABS: General (language, Copilot name, sounds, sync, tours, colour theme, animations) · Tasks (tags, priorities, criteria check, phone lock counting) · Day & week (day start, weekend, bypass count, streak free days, streak counting, break limits) · AI & Pro (provider, keys, Pro, credits) · Phone lock (devices, tokens, downloads) · Account & data (backup, log out, clear, delete). General, Tasks and Day & week wait for Save changes; AI & Pro and Phone lock save at once.';

    const SETTINGS = {
        general: 'General: Language (per device). Copilot name (20 chars). Sound effects, Vibration (Android), focus-timer volume, Distraction note timer (30 s–5 min). Sync: Refresh after sync, Sync now. Help & tutorials: replay tours (Getting started, Breaks & emergencies, Set up AI, Link your phone, Taskitator Pro, Colour themes). Colour theme: Savannah free; Desert, Jungle, Marina, Fictional need Pro; Icon mix (Pro) mixes animal packs. Animations: Static, Reduced, Normal, Custom (per device).',
        tasks: 'Tasks: Tags (+ Add, ✕). Priorities (+ Add level, rename, colour, reorder; #1 highest). Task checks: Check criteria before locking (AI must rate criteria 7/10). Phone lock counting: Harsh (every task due today; bonus only with Count bonus tasks), Normal (only tasks with Count toward phone lock), Limited (only AI-locked). AI-locked always count. Loosening is locked until today\'s tasks are done or Emergency Bypass is on; tightening is always allowed. Allow changing many tasks at once enables Multiselect → Phone lock.',
        schedule: 'Day & week: New day begins at (00:00–04:00). Weekend start/end (bypass refill, default free days). Emergency Bypass: 4 a week. Streak free days: up to your weekend days + 2; a change starts next week. Streak counting: Loose (any task, default), Normal (required non-bonus only), Tight (AI-locked only); points always count every task; a change starts next week. Break limits & strict modes: daily max 1–3 h; Flexible Strict minimum 30–60 min; Scheduled Strict deadline and weekday plans; editable only when today\'s required tasks are done or bypass is on (Save break settings).',
        ai: 'AI & Pro: AI provider Gemini, Claude or ChatGPT; each keeps its own key. Add or replace key (confirm with password or Google), keys from Google AI Studio, Claude Console or platform.openai.com (a ChatGPT Plus/Pro subscription does not include API access; billing must be set up). Test key uses no quota. Press Switch to <provider> to use it. Show (30 s), Copy, Delete key. ChatGPT uses GPT-6 Luna; Claude and ChatGPT don\'t take HEIC photos. Universe AI reviews use the Gemini key. Free: own key, about 10 credits a day / 220 a month shown as Available, Caution, Critical. Pro: Activate Pro (Keyo license); hosted Taskitator AI with daily and 30-day credits, or tick Use my own API key instead of credits.',
        phone: 'Phone lock: Devices: name → Add device (token tkp_…; Free 3, Pro 12), Remove, Remove all devices. Adding or removing needs today\'s tasks done, a break, or Emergency Bypass. Download Bridge (with your token) and App Blocker; Status URL and Open guide for MacroDroid setup. Counting mode is in Settings → Tasks. Sleep Lock has its own page.',
        account: 'Account & data: signed-in name, Manage account & password, Log out (tick Also erase everything on shared computers). Contact info@mazendev.com. Back up & restore: Download .json; Restore with Merge (adds) or Replace everything. Clear completed & trash. Privacy & terms. Danger zone: Clear this browser (type RESET; cloud account stays); Delete account (turn off MacroDroid blocking on every device, confirm identity, type Macrodroid disabled, Delete my account; deletes workspace, keys and owned Universes; Check deletion status).'
    };

    function settingsTab() {
        const tab = root.document?.querySelector?.('#settingsTabs [aria-selected="true"]')?.dataset?.tab || '';
        const key = String(tab).replace(/^tab-/, '');
        return Object.hasOwn(SETTINGS, key) ? key : 'general';
    }

    // Text appended to the Copilot system prompt for the current page.
    function forPage(page, tab) {
        if (page === 'settings') {
            const key = Object.hasOwn(SETTINGS, tab) ? tab : settingsTab();
            return MAP + '\n' + SETTINGS_MAP + '\nOPEN TAB: ' + SETTINGS[key];
        }
        return Object.hasOwn(PAGES, page) ? MAP + '\n' + PAGES[page] : MAP;
    }

    root.TaskitatorCopilotKnowledge = Object.freeze({ MAP, PAGES, SETTINGS_MAP, SETTINGS, forPage, settingsTab });
})(typeof window !== 'undefined' ? window : globalThis);

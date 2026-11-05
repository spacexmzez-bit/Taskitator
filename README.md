# Taskitator — code and architecture guide

Taskitator is a browser task manager with nested tasks, projects, scheduled breaks, proof-based completion, a focus timer, an AI Copilot, cloud synchronization, phone-blocking integration, and collaborative workspaces called **Universes**. The frontend is static HTML/CSS/JavaScript. Its authenticated backend runs in a Cloudflare Worker and a Durable Object; Universe records use D1, and Universe attachments use R2.

This guide describes the source at [`1b28da2`](https://github.com/spacexmzez-bit/Taskitator/tree/1b28da2d223fb4e613aff1301d883026f4d428e7), inspected on **2 November 2026**. It documents implemented behavior, not proposed features or an assertion about the currently deployed website. All 89 tracked files are catalogued below: 65 text files and 24 PNG assets. Source links and symbol names are included so the relationships can be checked against the code.

## Contents

- [System structure](#system-structure)
- [Startup and browser contracts](#startup-and-browser-contracts)
- [Data ownership and storage](#data-ownership-and-storage)
- [Browser engines](#browser-engines)
- [Pages and inline code](#pages-and-inline-code)
- [Worker and backend engines](#worker-and-backend-engines)
- [Universe subsystem](#universe-subsystem)
- [End-to-end flows](#end-to-end-flows)
- [API families](#api-families)
- [Styles, tutorials, data, and assets](#styles-tutorials-data-and-assets)
- [Build, configuration, and operations](#build-configuration-and-operations)
- [Tests and verification](#tests-and-verification)
- [Maintenance boundaries](#maintenance-boundaries)
- [Alphabetical file catalogue](#alphabetical-file-catalogue)
- [Source navigation index](#source-navigation-index)

## System structure

```mermaid
flowchart TD
    P["HTML pages and browser controllers"] --> C["core.js: auth and sync"]
    P --> A["pro.js: AI client and audit UI"]
    C --> W["worker.js: authenticated routing"]
    A --> W
    W --> D["TaskitatorSync Durable Object"]
    D --> B["pro-backend.js: license and task protection"]
    D --> U["UniverseRules inheritance chain"]
    U --> S["D1 records and R2 attachments"]
    B --> K["Keyo and hosted AI"]
    D --> V["Encrypted BYOK vault and AI gateway"]
```

There are two different programming styles in this repository:

1. **Browser classic scripts** share objects on `window`. Their order is managed by `core.js`. Merely finding an identifier in another file does not mean there is an ES-module import.
2. **Worker ES modules** use explicit imports. `worker.js` imports the Pro gateway and the final Universe service. The Universe classes extend one another, adding and overriding behavior while retaining older schema fallbacks.

Several root files were consolidated from older files. Comments such as `MODULE_START: auth-client.js` identify internal sections; they do **not** mean that `auth-client.js` is still a separate tracked file. Test helpers extract these sections to keep older focused fixtures working.

## Startup and browser contracts

### Authentication before private UI

The main pages start with an `auth-pending` class and hide their contents. App scripts are declared with the inert type `text/taskitator-script`, rather than executing immediately. The regular deferred script is `core.js`.

Its bootstrap performs the following work:

1. If an older service worker controls the page, query it with `TASKITATOR_SECURITY_VERSION`. Wait for the expected cache release or show a recoverable update error. Reload after a controller upgrade because styles/scripts may already have arrived from the old cache.
2. Handle deletion-status and public comparison/legal views separately. Public legal/comparison views remove private navigation and inert private scripts rather than starting the workspace.
3. Initialize Clerk using the public configuration in `TASKITATOR_AUTH_CONFIG`, obtain the current authenticated account from `/auth/me`, and check local account ownership.
4. Redirect to `login.html` if sign-in/account connection is required.
5. Activate the inert scripts **sequentially in document order**, preserving classic-script dependencies. Initialize the vault, dispatch `taskitator-auth-ready`, and reveal the page.
6. Watch Clerk session changes. A changed session clears in-memory vault state, archives the old local workspace, clears active local data, and returns to login.

On `index.html`, the script order is Pro suite, Smart Study, study plan, shared components, focus timer, app controller, and tutorials. `components.html` additionally declares the Universe browser helpers before the common scripts. Those helpers defer authenticated work through their own lifecycle/event checks. `settings.html` also contains a large inert inline settings controller.

### Shared browser interfaces

| Interface | Defined in | Main consumers and responsibility |
| --- | --- | --- |
| `TASKITATOR_AUTH_CONFIG` | `core.js` | Public Clerk publishable key and Worker URL; consumed by authentication and API clients. |
| `TaskitatorAuth` | `core.js` | Clerk session/token access, authenticated API calls, account connection, storage sanitation, sign-out. |
| `SyncEngine` | `core.js` | Used by all personal-workspace writers to mark changes, push/pull snapshots, and handle conflicts. |
| `TaskitatorSafety` | `pro.js` | Safe label rendering and task-tree deletion checks shared by controllers/editors. |
| `ExemplarStore` | `pro.js` | IndexedDB reference files used by editors and proof review. |
| `TaskitatorBreaks` | `pro.js`; equivalent server copy in `worker.js` | Deterministic break normalization, time calculations, validation, and merge rules. |
| `TaskitatorVault` | `pro.js` | Provider/key metadata, provider selection, legacy-key migration, and BYOK generation requests. |
| `TaskitatorEngine` | `pro.js` | Break, emergency, and audit engines. Copilot also attaches through the app suite. |
| `TaskitatorPro` / `ProClient` | `pro.js` | Status, activation, hosted quotes/reviews, personal reviews, confirmation, emergency and entitlement checks. |
| `ProUI`, `TaskitatorProfile`, `TaskitatorTier` | `pro.js` | Pro settings/review dialogs, display username, account-scoped tier presentation. |
| `TaskitatorRecurrence` / `TaskitatorRecurrenceUI` | `components.js` | Pure recurrence rules plus browser persistence/editor controls. |
| `TaskitatorComponents` | `components.js` | Creates shared task/editor/audit UI against a host adapter. |
| `TaskitatorToast`, `TaskitatorNotify`, `TaskitatorConfirm`, `TaskitatorBusy` | `components.js` | Feedback, asynchronous confirmation, and button state shared by the pages. |
| `TaskitatorApp` | `app.js` | Personal tasks, views, completion, selection, sorting, projects, editor entry points, storage/render coordination. |
| `TaskitatorAgent` | `app.js` | Page-scoped Copilot context, model requests, tool execution, reply display, note extraction. |
| `TaskitatorScratchpadBlocked` | `app.js` | Required-work gate reused by scratchpad-related actions. |
| `TaskitatorPomodoro` | `uni/focus-timer.js` | Persistent timer core and browser UI; supersedes the guarded legacy timer in `app.js`. |
| `TaskitatorSmartStudy`, `TaskitatorStudyCore`, `TaskitatorStudy` | `pro/*.js` | Shared schedule logic, task generation, preview and explicit confirmation. |
| `TaskitatorSpotlight`, `TaskitatorTutorials` | `tutorial-*.js` | Tour rendering, tour content, saved progress, and Universe onboarding. |
| `UniverseUX`, `UniverseDialog`, `UniverseShell`, `UniverseTasksUI`, `UniverseReleaseUI`, `UniverseArchive` | `uni/` browser scripts | Collaborative workspace presentation and API-driven interactions; no authority to grant server permissions. |

### Events connecting the modules

| Event or browser signal | Role |
| --- | --- |
| `taskitator-auth-ready` | Starts authenticated controllers after scripts and identity are ready. |
| `taskitator-tasks-updated` | Requests refreshed task views after local/AI changes. |
| `taskitator-synced`, `taskitator-sync-error` | Updates sync indicators and views; editors avoid replacing an active draft. |
| `taskitator-settings-changed`, `taskitator-breaks-changed` | Notifies dependent UI after local settings/break updates. |
| `taskitator-pro-status` | Publishes verified status responses to tier/Pro UI. |
| `taskitator-emergency-updated` | Refreshes bypass displays using the server-managed response. |
| `taskitator-timer-scratchpad` | Closes the focus panel and starts note capture; the scratchpad controller remembers to return to the timer. |
| `taskitator-refresh-safe`, `taskitator-study-closed` | Allows deferred refresh/work after guarded UI closes. |
| `universe-create-task`, `universe-discard` | Opens the Universe editor from the shell and explicitly discards dirty forms. |
| `storage`, `online`, `focus`, `visibilitychange` | Coordinates tabs, sync recovery, view refresh, and timer reconstruction. These signals do not establish server authorization. |

## Data ownership and storage

### Personal workspace

Local browser data is a working copy. The connected account's cloud snapshot is stored in Durable Object storage, with revision checks protecting writes. `TaskitatorSync` is instantiated through a single named Durable Object, `taskitator-v1`; storage keys separate accounts inside that object. It is not one Durable Object per user.

| Data/key family | Content and connections |
| --- | --- |
| `taskitator_tasks` | Personal task array: IDs, `parent_id`, project, title/description, status, due dates, bonus flag, priority, tags, proof/lock/shield and optional recurrence/study metadata. |
| `taskitator_projects` | Personal project catalogue; `project_id` connects tasks to these records. |
| `taskitator_settings` | Preferences, tag/priority catalogues, schedule settings, tutorial progress and account connection metadata. Credentials are stripped from ordinary sync/export paths. |
| `taskitator_daily_breaks` | Read-only, server-written copy of date-keyed break records (system, planning window, pinned cycle bounds/timezone and intervals). Sync never uploads changes to it. |
| `taskitator_break_state` | Account-scoped cache of the last `/breaks` answer, used for display only. |
| `taskitator_audit_ledger` | Client productivity/completion history; not the authoritative hosted billing ledger. |
| `taskitator_saved_criteria` | Reusable proof requirements managed by the task editor. |
| `taskitator_recurrence_state` | Recurrence series/templates, history and reference associations. Must remain consistent with tasks. |
| `taskitator_collapsed_nodes` | Personal tree expansion state included in local backup/account handling. |
| `taskitator_sort_mode` | Locally saved sibling-sort choice, read by the task view. |
| Scratchpad keys | Live notes and `taskitator_archived_notes`; capture/extraction/archive paths use these separately from the ordinary task snapshot payload. |
| `taskitator_focus_v1:<account>` | Local per-account focus timer state; timestamp-based, separate from cloud phone-access authority. |
| Account cache/recovery keys | Archived workspaces and preserved conflicting legacy copies used on logout, account switching, and migration. |
| IndexedDB `TaskitatorExemplarDB` and account-scoped variants | Binary reference exemplars. `ExemplarStore` associates them with task IDs, controls legacy ownership, and supports account cleanup. Ordinary browser JSON exports do not automatically contain all these binaries. |

The task tree is built with `parent_id`, not display indentation. Moving or filtering a view is distinct from changing the stored parent. Several behaviors use the nearest dated ancestor for an undated child, but each gate has its own policy: phone blocking, scratchpad access, and Copilot progress must not be treated as identical predicates.

### Server records

| Storage | Main contents |
| --- | --- |
| Durable Object account/identity records | Clerk identity-to-workspace links, ownership, revisions, snapshot metadata, phone credentials and migration state. |
| `snapshot:<encoded user>:<index>` | Chunked personal snapshot strings; `loadSnapshot` and `saveSnapshot` reconstruct/store them. `CHUNK_CHARS` is 24,576. |
| `pro:entitlement:<account>` | Verified Keyo token, key/binding IDs, validity, status, stored policy and BYOK selection. |
| `pro:usage:<account>:day:<date>` / `month:<month>` | Hosted personal-audit credit usage and reservations. |
| `pro:spend:<account>:<month>` | Personal hosted-audit provider-spend safety accounting. |
| `pro:op:` and `pro:attestation:` families | Audit operation replay state, evidence/task bindings, and completion receipts. |
| `pro:study-validation:`, `pro:study-grant:` | Criteria validation and exact generated-plan authorization used during later sync. |
| Vault/staging/verification/deletion keys | Encrypted provider keys, pending recovery, one-use identity proofs, deletion jobs and receipts. |
| `sleep-lock:<account>`, `sleep-delay:<account>:<night>` | Authoritative Sleep Lock schedule/revision and a night's one-use delay. |
| D1 `universe_*` tables | Membership, shared tasks, reviews, attachment metadata, operation replay, discussion, portability and rules. |
| R2 `TASKITATOR_EVIDENCE` | Private Universe proof/reference bytes and staged export/import contents. |
| KV `TASKITATOR_KV` | Legacy-account migration input; current personal snapshot reads/writes use Durable Object storage. |

## Browser engines

### `core.js` — authentication, account lifecycle and synchronization

This file contains seven marked sections.

**`auth-config.js` section.** Defines the public Clerk key and Worker URL. These settings are read at runtime by clients; they are not license permissions or a place for private keys.

**`auth-client.js` section.** `cleanSettings` removes reusable credentials and optionally export-specific identity data. `cleanSnapshot`, `readSnapshot`, `recoveryCopies`, `preserveCopy`, and `snapshotTime` sanitize and preserve old local archives. `cleanLegacyStorage` migrates credential-bearing archive keys into safer account-scoped names while retaining differing copies instead of blindly merging task arrays. `loadScript` loads Clerk. `TaskitatorAuth.token` retrieves a Clerk token; `api` adds the bearer header, no-store and timeout handling, and readable Worker-version errors. `connect`, `init`, `manageAccount`, and `signOut` implement account connection, session startup/profile, and confirmed logout intent.

**`sync-engine.js` section.** `SyncEngine` tracks session ownership, dirty state, known remote revision, in-flight writes, and a fixed change-triggered synchronization window. Its functional groups are:

| Functions | How they work together |
| --- | --- |
| `getConfig`, `isConfigured`, `accountCacheKey`, `initializeSession`, `sessionMatches` | Resolve the current connected account and stop stale asynchronous work from another local session. |
| `archiveLocalAccount`, `clearLocalAccount`, `beginLogin`, `logout` | Preserve outgoing local data, isolate incoming workspaces, clear active state and coordinate Clerk logout. |
| `needsInitialPull`, `isDirty`, `markLocalModified`, `rememberRemoteVersion` | Distinguish unsent local edits from server versions and initial account startup. |
| `getPayload` | Serializes tasks, projects, sanitized settings, breaks, ledger, saved criteria and recurrence data with the revision/mutation metadata required by the Worker. |
| `push`, `performPush`, `request` | Serialize/retry authenticated writes, keep stable operation identity, accept returned revision and surface conflicts rather than silently replacing cloud data. |
| `readCloud`, `pull` | Fetch the remote snapshot, check account/session and local edits, then apply accepted data and notify views. |
| `scheduleAutoPush`, `queueAutoPush`, `startAutoWindow`, `armAutoSync`, `runAutoSync`, `cancelAutoWindow` | Batch changes without idle cloud polling. Storage events keep the deadline visible across tabs. |
| `flushIfDirty`, `forceImmediateSync`, `syncNow` | Perform explicit or lifecycle-triggered synchronization; manual sync includes both directions and conflict handling. |
| `registerRefreshGuard`, `isSafeToRefresh`, `autoRefreshEnabled`, `maybeRefreshPage` | Defer a page reload while editors or other guarded UI have work in progress. |
| `reportConflict`, `openConflictDialog` | Preserve local edits and offer an explicit resolution/export path when server revisions differ. |
| `changePassword`, `resumePasswordChange`, `fetchMrStudyRules` | Compatibility entry points. Password management belongs to Clerk; the old rules bridge is not an active external rules service. |

**`deletion-client.js` section.** A deletion dialog obtains an action-bound verification, requires the blocker-disabled checkbox and manually typed phrase, confirms proof status immediately before deletion, and saves a random receipt before sending the destructive request. `cleanLocal` removes only the relevant account's local/cache/reference data. Lost responses can be checked using the retained receipt; a timeout alone does not prove deletion was accepted.

**`deletion-status.js` section.** Reads a receipt and polls the narrow deletion-status endpoint for progress and phone recovery information. It can activate without a normal workspace session.

**`login-page.js` section.** Mounts Clerk sign-in/sign-up, displays the signed-in account, connects a new empty workspace or migrates a legacy workspace, exposes recovered copies for download, performs the initial pull, and enters the app only after successful account/sync handling.

**`auth-bootstrap.js` section.** Implements the startup sequence documented above. Changes to script loading, authentication overlays or public/private page separation belong here.

### `components.js` — feedback, recurrence and shared task editing

**Feedback section.** `ensureHost`/`raiseHost` create a top-layer toast host; `inferType` chooses legacy message tone; `show`/`dismiss` manage bounded notifications, close buttons and optional actions. `parseLegacy` adapts old confirmation text. `confirmSheet` returns a promise for a themed confirmation. `setBusy` preserves button state while an action runs. These interfaces replace scattered native feedback where callers support them.

**Recurrence core.** Exposes the same deterministic API as the Worker copy:

| Function | Meaning |
| --- | --- |
| `validDate`, `today` | Validate date strings and calculate a logical Riyadh-offset task date using the configured day-start hour. |
| `schedule`, `nextDate` | Validate supported daily/weekday/monthly/specific-month-day/half-yearly/yearly schedules and find the next valid occurrence inside their bounds. |
| `subtree` | Traverse parent/child IDs without relying on UI rows. |
| `seriesFor`, `canStart` | Find the owning series and validate whether a branch can become a recurrence. |
| `cleanNode`, `start` | Capture allowed template fields, references and branch relationships, create series metadata and attach the initial occurrence. |
| `updateNode` | Keep series template fields in step with permitted task edits. |
| `validateState` | Reject malformed/inconsistent recurrence state before persistence or import. |
| `reconcile` | Reconcile snapshots as occurrences advance, respecting active branches, schedule bounds and history. Both browser and server need compatible rules. |

**Recurrence UI.** `state` and `tasks` read an active editor draft before live storage. `persist`/`save` validate and write a coordinated snapshot. `scheduleForm` renders schedule controls; `captureReferences`, `attachCreated`, `validCreate`, `bindTask`, `applyEdit`, `open`, and `overview` connect recurrence setup/editing to task dialogs and stored reference files. Canceling a task draft must not save its recurrence edits.

**Shared component factory.** `TaskitatorComponents.create(host)` receives a host adapter for tasks, settings, projects, priorities, tags, rendering, persistence and completion. It returns shared editor/audit methods rather than owning a second independent task database. `app.js` and the consolidated workspace views use it.

The component responsibilities are:

- **Draft lifecycle:** `controls`, `dirty`, `discardDraft`, and `commitDraft` track control values, the original task/recurrence snapshot, account session and pending reference changes. Commit detects changes made elsewhere; discard does not mutate live tasks. The draft is exposed as `TaskitatorEditorDraft` for recurrence controls.
- **Catalogues:** saved-criteria helpers, project/tag/priority cloud renderers, quick tag addition, and `refreshConsecutive` coordinate actual user-configured catalogues and verified Pro numbering access.
- **Title input:** `upgradeInput`, input/click/keyboard/paste handlers and `extractCleanTitle` render/resolve supported title and numbering tokens while retaining raw title syntax separately from display text.
- **Create/edit dialogs:** `openTaskCreationModal`, `openTaskDetailModal`, `refreshDetailSubtaskList` and `init` bind parent relationships, bonus/priority/project selection, lock/shield rules, subtasks, saved requirements, numbering and recurrence to explicit saves.
- **Reference files:** base64/file conversion helpers stage exemplars and retain/remove them according to the draft's save result.
- **AI criteria and proof:** `runCriteriaValidation` performs preflight criteria checking; the templates/saved-criteria pickers populate requirements; `openAuditModal` and submit handlers use the audit engine and server-confirmed completion flow. A passing criteria score is not task completion.

### `app.js` — Copilot, personal task views, scratchpad and legacy timer

#### Copilot section (`TaskitatorAgent`)

`getPageContext` resolves consolidated routes and older route aliases. `getCopilotName` applies the user's display preference. `getSystemPrompt` loads `SYSTEM_PROMPT.md`, validates its marker/identity and size, caches it, and falls back to a built-in Taskitator prompt if needed. The tool schemas and runtime context are assembled according to the page; task mutation tools are not exposed on every page.

`executeModelCall` uses the selected vault provider/model. Conversation identity includes provider/key version; `resetConversation` drops old context on a change. `getTrimmedContents` limits history while preserving complete tool turns. `sendMessage` executes bounded model/tool exchanges, with supported provider fallback behavior, and only reports mutations after tool results.

`executeToolCall` reads fresh tasks and dispatches supported task reads, scoped progress, create/update/trash actions and study-plan proposals. It enforces the allowed fields and protected-task restrictions. `commitTasks` saves local results and schedules sync/refresh. Chat tools cannot manufacture an audit approval or authorize protected completion.

`todayProgress` returns only `{title, directory, status}` for its selected active/completed work. It follows nearest ancestor dates, includes relevant overdue work, and requires completed entries to have a completion timestamp in the current logical day. **That narrow tool is not a global privacy boundary:** other offered task context/tools and earlier conversation can contain additional information.

`scratchpadBlocked` detects active non-bonus tasks due today or overdue, including inherited dates, and fails closed on malformed task storage. It does not treat all standalone undated tasks the same way as phone blocking. `extractNotesBatch` gates access, sends captured notes for structured cleanup, and returns processed output. `initUI` renders chat safely through DOM text/limited structure, binds quick commands and sends input; `refreshSystemNames` updates personalized labels.

#### Personal controller (`TaskitatorApp`)

| Function group | Behavior and dependencies |
| --- | --- |
| `getComponents`, modal delegates | Constructs the shared host adapter and opens components-based create/detail/audit dialogs. |
| `getAppTodayStr`, catalogue helpers | Resolve logical day and real projects/tags/priorities; `saveProject` and `deleteProjectWithCascade` persist project changes and chosen task relocation/deletion behavior. |
| `SoundFX`, `UIFX` / `TaskitatorFX` | Audio, haptics and class/animation feedback; they do not authorize mutations. |
| `DistractionDumpEngine` | Reads/saves expiring captured notes, garbage-collects them, opens/closes timed capture, commits on expiry, and opens the saved-notes escrow dialog. Timer-origin capture can reopen the focus panel. |
| `loadStorage`, `saveStorageAndPush` | Reload local task state, reconcile applicable recurrence/study changes, persist it and request sync. |
| `initSyncIndicator`, `updateSyncDot` | Translate sync outcomes to the status UI. |
| `sortTasks` | Sort siblings using the chosen priority (the default), alphabetical, or required-first mode; recursive rendering preserves hierarchy. The sort menu saves `taskitator_sort_mode` and rerenders. |
| `getAllDescendants`, `hasUncompletedDescendant`, `getShieldedAncestor`, `isCompletionBlocked` | Traverse the actual tree and determine shield/prerequisite restrictions. |
| `cascadeProject`, `cascadeTaskStatus` | Propagate applicable project/status changes through descendants while checking the operation's constraints. |
| `handleTaskCompletion`, `startGraceCompletionTimer`, `undoTaskCompletion`, `finalizeTaskCompletion` | Coordinate ordinary completion, a reversible grace interval, actual status changes, ledger updates and protected audit entry points. |
| `deleteTask` | Checks protected descendants and marks the chosen branch as trash rather than immediately erasing records. |
| Filter/selection helpers | Keep draft filters separate until Apply; manage multiselect, select-all and batch-action state. |
| `BreakUI` | Displays planning/locked/active-break states and edits through `TaskitatorEngine.BreakEngine`. |
| `isTaskVisuallyActive`, `renderUnifiedTaskTree` | Resolve current view, filters, subtree visibility, priority styles, bonus/Smart Study appearances and recursive task rows. View inclusion is not a stored status mutation. |
| Completed-list helpers | Show completed work and permit reopening through the appropriate restrictions. |
| `renderUnifiedView`, `setView`, `handleHashRouting`, `init` | Coordinate route/view switching, event binding, menus, quick/bulk actions and safe refresh. |
| `updateEmergencyUI` | Reads server-managed bypass state and updates the emergency control/countdown. |

The sort menu uses a real button, `aria-expanded`, saved radio-style choices, outside-click and Escape dismissal. Header layout, visibility and animations involve `index.html`, `app.js`, and `style.css` together.

The final `pomodoro.js` section retains an older injected timer, oscillator bell, work/break transition loop, fullscreen controls and view listeners. Its guard returns when `TaskitatorPomodoro` already exists. Current pages load `uni/focus-timer.js` first, so that persistent implementation normally wins; deleting the old block or changing load order has different effects from editing the active timer.

### `pro.js` — safety, key management, audits, account presentation

| Internal section | Detailed role |
| --- | --- |
| `safety.js` | `escapeHtml` escapes user text; `setProjectLabel` builds icon/name DOM nodes; `collectSubtree` finds descendants; `deletionError` checks AI locks and pending shielded branches, with the explicit bypass input. |
| `exemplar-store.js` | `getDB` chooses the account-owned IndexedDB; `blobToBase64` serializes bytes. `saveExemplar`, `hasExemplar`, `getExemplar`, `deleteExemplar`, `clearAll`, `deleteAccountFiles` manage bounded local references and legacy ownership. |
| `pro/break-core.js` | `timezone`, `parts`, `time`, `wall`, `dayBounds`, `bounds`, `interval`, `validate`, `normalize`, `migrate`, `activeBreak`, `active`, `merge` form the shared date/break rules. They validate intervals, overlap and total duration, normalize legacy records, pin cycle data, and protect locked planning state during sync. |
| `vault-client.js` | Tracks viewed and active providers separately; renders saved-key metadata and recovered candidates; stages legacy browser keys only for their known owner; removes plaintext only after successful server staging. `selection` returns provider/model/version, and `generate` calls the Worker without embedding the saved provider secret in the request. Sensitive save/reveal/delete actions use password/Google confirmation dialogs and action-bound proof. |
| `audit-engine.js` | `TaskitatorEngine.BreakEngine` adapts shared breaks to local settings/sync and planning-window UI. `EmergencyManager` reads server-managed state and requests activation through the Pro client. `AuditEngine` handles selected provider, validation caching, proof/exemplar conversion, single reviews, hosted quote consent and personal review. |
| `pro/pro-client.js` | `ProClient.request` attaches authenticated headers and normalizes API errors. Other methods retrieve status, activate a license, toggle Pro BYOK, prepare stable audit/confirmation IDs, fetch quotes, approve reviews and apply completion confirmations. Pending maps retain operation identity for retry safety; entitlement checks reject stale account/session results. |
| `pro/pro-ui.js` | Renders the Pro Settings section, activation/BYOK controls, single/batch cost consent and result dialogs. File staging and result eligibility are separate from applying completion. Quote dialogs have cancellation/focus handling; confirmed completion refreshes local task state from the authoritative result. |
| `pro/profile-ui.js` | Fetches/paints the account's display username, provides availability/edit UI and ignores old-session results. The display label is distinct from the immutable login/account identity. |
| `pro/tier-ui.js` | Restores an account-scoped display cache, interprets status/expiry, renders tier cards, sets presentation classes, and refreshes from verified server status. A cached badge does not authorize a Worker operation. |

Breaks offer two systems per logical day, **Scheduled** and **Flexible**, sharing one daily allowance (3 hours by default; adjustable from 1 to 3 hours in 15-minute steps in Settings → Day & week, and each day keeps the maximum it was locked with). Choosing one (first Scheduled save, first Flexible start, or Lock for Today) locks it until the day resets. Scheduled planning has a ten-minute window from its start and closes six hours before the day ends; the shared validator permits one to three intervals, bounded total duration and no overlap. Flexible breaks (30/45/60 minutes, custom, or until the allowance ends) cannot be ended in their first ten minutes and are charged per started minute. Both systems are owned by the Worker (`break-systems.js`, `/breaks`); the browser `BreakEngine` only caches the last server answer. Optional strict modes (Settings → Day & week) are stored on the Worker too: Flexible Strict Mode raises the minimum to 30–60 minutes (never above the daily maximum) and requires the same gap between one break's end and the next start; Scheduled Strict Mode locks Scheduled at a deadline (1–18 hours after day start) with a default or weekday plan, or zero breaks on a covered day without one; weekdays can be excluded. The deadline is evaluated on each request, so it applies even if the app was closed. Break settings (daily maximum and strict modes) can't be changed while today's required non-bonus tasks are unfinished unless an Emergency Bypass is active (a break does not unlock them), and a change never rewrites a day that is already decided (it applies from the next day). Emergency Bypass is server-managed, with four uses per cycle and a fifteen-minute active window; its exact cycle is derived from account settings on the server. Timer breaks are not automatically scheduled phone-access breaks.

### `pro/smart-study.js` and `pro/study-plan.js`

These scripts execute in browser and Worker contexts through a `window`/`globalThis` wrapper.

- **Smart Study:** `normalize` checks modes, selected future units and earlier dates already present in the plan; `nextWeekend` finds the next configured weekend; `decorate` records original schedule metadata and links early appearances to the existing unit tasks. `apply` reacts once to a newly completed early opportunity and can move one eligible required unit into the freed original slot. It distinguishes unaudited completion from timely server-attested proof, rejects late/past rearrangement, and never creates a duplicate unit. `guard` prevents clients from arbitrarily changing `smart_*` fields on existing tasks.
- **Study plan core:** `normalize` validates plan title, units, days, start, weekdays, skips, counts and optional Smart Study configuration. `rows` distributes numbered units across allowed days; `coverage` formats covered-unit ranges; `build` creates shielded parent-day tasks and child units, optionally applying per-unit AI criteria; `defaultDays` derives weekdays from weekend settings.
- **Study plan UI:** `TaskitatorStudy.open` verifies Pro, opens an editable preview, supports skips/titles/daily counts and optional reusable-criteria validation. It checks session/view/storage stability and obtains a server grant before inserting the exact generated tasks locally. `propose` lets Copilot open a preview with a restricted set of planning fields; it cannot supply audit authorization or press the user's confirmation button.

### `uni/focus-timer.js`

Despite its folder, this timer is used by the personal pages as well as shared-workspace pages. `fresh` supplies initial state; `valid` rejects corrupt/out-of-range state; `advance` reconstructs elapsed work/rest/large-break phases from timestamps. `read`/`save` use the current account's local timer key. `exclusive` uses browser locks when available; `tick` and `action` reconstruct state before rendering or changing it.

`mount` creates the tag/dialog and settings, remounting on account changes. `render` updates digits, paused red styling, phase/counter and controls. `unlockAudio`/`notify` provide sound/vibration; `screen` requests/releases an optional wake lock with account/visibility checks. Optional picture-in-picture uses the browser capability when present. The scratchpad button dispatches the timer event. Page/storage/visibility listeners and a short interval recover state; the cloud `/status` endpoint does not read this timer.

## Pages and inline code

### `index.html`

Defines Today/Inbox/Upcoming task containers, shared navigation, the compact “Today's” header and username, multiselect/filter/sort controls, task dialogs, break/scratchpad/emergency/sync UI, Copilot and batch controls. Its IDs and data attributes are the bindings used by `app.js` and `components.js`; changing an ID can break behavior without a JavaScript syntax error. It declares authenticated scripts and CSP metadata rather than owning a separate task engine.

### `components.html`

Consolidates formerly separate pages into route-selected panes: projects, calendar, statistics, trash, blocker guide, comparison/legal, and Universe. Its inline controllers are substantial application code:

| Inline area | Functions and relationships |
| --- | --- |
| Projects | Workspace permission guard, `renderProjectStrip`, `renderProjectWorkspace`, recursive `buildNode`, `openProjectModal`, emoji/color pickers and Copilot drawer setup. Uses `TaskitatorApp` project/task operations and shared components. Exposes `refreshCurrentProjectView` for editor callbacks. |
| Calendar | `loadData`, `saveDataAndSync`, date/recurrence helpers, `renderCalendar`, `renderAgenda`, recursive agenda rows and unscheduled backlog. Converts selected dates into the task editor's create/edit actions. Exposes `renderCalendarView`. |
| Notes archive | Reads `taskitator_archived_notes`, renders archived entries and binds archive actions. This is a distinct access surface from capture on Today; a capture gate alone should not be described as a complete archive security boundary. |
| Statistics | `renderStats` reads task/ledger/break data and builds productivity summaries; the private-workspace guard prevents signed-out cached data from becoming a public view. |
| Trash | `loadTasks`, `saveTasksAndPush`, `renderTrash`, `restoreTask`, recursive child restore and permanent branch deletion. Restoration/permanent deletion remain subject to the applicable tree/protection checks and later server sync rules. |
| Blocker instructions | Phase-one/phase-two progress getters/setters, major/minor/substep toggles, rollup/auto-advance/reset functions and screenshot references. This is setup guidance/progress UI, not the server unlock evaluator. |
| View router | `isAuthenticatedWorkspace` and `activateComponentView` select panes from query/hash, update headings/navigation and invoke the relevant rendering hooks. Public routes are also isolated by the `core.js` bootstrap. |
| Universe | Supplies `#universeWorkspace`; loads the dedicated browser modules rather than routing collaborative tasks through personal localStorage. |

### `settings.html`

Contains general/schedule/AI/phone/Pro settings, import/export and account-deletion/verification markup. Its inline controller owns editable settings state and the save bar.

- `notify`, `ask`, `setBusy`, `replayClass`, `afterAnimation`, and `flashButton` adapt shared feedback and animation helpers.
- `markUnsaved`, `markSaved`, `setSaveBarVisible`, tab-indicator/activation/initial-tab helpers manage dirty state and route-to-tab navigation.
- `renderTags`/`handleAddTag` and `renderPriorities` manage user catalogues. `saveSettings` saves names/colors with ordered ranks, preference/schedule values and sanitized connection settings, dispatches a settings event and marks sync dirty.
- `loadSettings`, logical-day, dump-duration, emergency/break/workweek display helpers restore controls and explain the active schedule.
- Phone setup requests scoped phone credentials, handles copy/reveal/rotation UI and checks current task/protection conditions before changes. The Worker remains authoritative.
- Export constructs a versioned JSON backup with tasks/projects/settings/breaks/ledger/saved criteria/recurrence/collapse data and scrubbed secrets. `processImport` validates the file and recurrence state, supports merge or replace, and preserves current account credentials. It refuses unsafe recurrence merges.
- Sensitive key/deletion/account controls use `pro.js` and `core.js`; their DOM containers live here. Clearing browser data and deleting the cloud account are separate operations.

### `login.html`

Provides sign-in/sign-up mount points, signed-in account controls, legacy migration form, recovered-copy download area and Continue action. Behavior is in `core.js`. It also declares the Pro/components helpers needed for feedback, recurrence and key migration.

### `sleep.html`

A small authenticated page with inline controller for enabled state, bedtime, wake time and a revision number. `load` fetches `/sleep-lock`; `values`/baseline and dirty checks protect unsaved edits; `controls`/`run` serialize actions and disable unavailable controls; `showDelay` displays the night's delay state. Saving sends the current revision. Delay actions request 30 or 60 minutes; bypass uses the server-managed emergency flow. It is independent of the focus timer and ordinary task snapshot settings.

### `uni/setup.html`

A static operator setup/reference page describing the historical Universe phases, schema order, bindings, model/hosted-AI checks, patches and troubleshooting. It does not apply SQL or deploy the Worker. Some phase labels are historical; the latest effective behavior comes from the schema markers and final `UniverseRules` implementation.

## Worker and backend engines

### `worker.js`

The default export validates allowed origins, handles OPTIONS, forwards requests to `TASKITATOR_SYNC.idFromName('taskitator-v1')`, and wraps responses with CORS/security headers. `TaskitatorSync` creates `ActionVerification`, `AccountDeletion`, `KeyVault`, `AIGateway`, `TaskProtection`, `ProGateway`, and the final `UniverseRules` service.

#### Shared recurrence and breaks

The top of the file embeds server copies of recurrence and break rules. Their APIs correspond to the browser cores described earlier. Server reconciliation means a client cannot rely on editing only its local copy to change what sync accepts. The Worker also imports the Smart Study/study-plan scripts for their shared global cores.

#### Identity and action verification

`SecurityError`, JSON/CORS helpers, origin parsing, hashing and random-secret helpers support request handling. `verifySession` verifies Clerk session identity, allowed issuer and session state; `clerkAPI`/`verifiedEmail` obtain trusted account information. `providerId` and `PROVIDERS` restrict provider and model selection.

`ActionVerification.start` creates an expiring proof bound to identity, session, action and optional key-stage/provider context. Password verification checks Clerk's verified session state; Google confirmation creates a nonce/state-bound OAuth round trip and `verifyGoogleToken` checks its result. `get` validates the current proof; `password` and `callback` advance it. Key mutation/reveal and account deletion consume proofs for the intended action rather than treating one reauthentication as unrestricted permission.

#### Account deletion

`AccountDeletion.accept` verifies identity/proof/confirmation, fences off the account, records a recoverable receipt and schedules cleanup. `marker` blocks later account access; `status` exposes a narrow receipt-based progress response. `page`, `legacy`, `deleteClerk`, and `run` perform bounded cleanup of current/legacy account records and external identity state, retrying unfinished work. Phone recovery credentials can temporarily return an unlocked status after deletion so an old macro does not leave the user blocked. Universe account tombstones are coordinated before group data cleanup.

#### Provider key vault

`KeyVault.configuration`, `ready`, and `cryptoKey` resolve the active encryption key and retained key versions. `prefix`, `recordKey`, and `stagePrefix` derive owner/provider-scoped storage names. `aad`, `seal`, and `unseal` authenticate encrypted records against owner/provider/kind/version using AES-GCM; ciphertext is not portable between accounts/providers.

`assertOwner` checks connected, live account ownership. `providerMetadata`, `metadata`, `selectedProvider`, and `select` expose metadata and explicit selection without returning a secret by default. `validateKey`/`recoveredKey` validate submitted/recovered material. `stage` and `recoverClaudeArchives` preserve migration candidates. `context` and `takeProof` check and consume action-specific verification. `save`, `remove`, and `reveal` recheck record/proof versions; `testKey`/`testSaved` test access; `cleanupLegacy` and `TaskitatorSync.migrateVault` remove legacy plaintext only after protected migration succeeds.

#### BYOK AI gateway and provider adapter

`validatePayload` restricts request shape, message parts, tools, supported output formats and generation limits. `toClaudeRequest` translates the Gemini-shaped client contract into Anthropic messages/tools/files/system blocks, preserving tool identifiers and refusing incomplete tool turns. `fromClaudeResponse` translates accepted Claude results and usage back into the common result shape. Output-schema validation rejects malformed or incomplete proof/criteria/notes responses. Bounded response reading avoids exposing provider credentials in forwarded errors.

`AIGateway.generate` validates provider/model, verifies account/key ownership and selected provider, rate-limits account requests, permits at most two in-flight requests per account in its current service instance, decrypts the saved key server-side and makes the provider call. After the response, it rechecks ownership, provider and key version before returning results. It supports Gemini and Claude; a provider switch does not silently use the other provider's secret. **This current gateway does not implement the proposed Free 10/220 credit quota.**

**Pro hosted AI.** For an active Pro account not in personal-key mode, `AIGateway.generate` routes Copilot, notes cleanup and criteria validation (including study-plan and Universe criteria) to Taskitator's hosted Claude key (`HOSTED_AI.model`), so no personal key is needed; `/ai/keys` reports `hosted: true` and the browser vault treats AI as available. Usage is limited by hidden per-account daily caps (`HOSTED_AI.daily`: 30 validations, 500 Copilot/notes requests, Asia/Riyadh day) plus a silent daily provider-spend backstop and a 30,000-token input cap; these are separate from credit allowances, are not exposed to clients, and a reached cap returns `503 Service unavailable temporarily.` A request that produced no answer does not use a slot. Proof reviews keep the hosted review service and its credit ledger.

#### Snapshot, phone and route helpers

| Functions | Responsibility |
| --- | --- |
| `readJson`, `validateUser`, `validateVersion`, `validateSnapshot` | Bound streamed request size and validate account/snapshot/revision/mutation input. |
| `scrubSettings`, `publicRecord` | Remove credentials and request-only mutation/rotation fields from normal snapshots. |
| `loadSnapshot`, `saveSnapshot`, chunk-key helpers | Store/reconstruct a potentially large personal snapshot in bounded chunks. |
| `readTaskSnapshot`, `writeTaskSnapshot` | Resolve the authenticated account and make authoritative task changes while incrementing its revision. |
| `importAccount`, `connectAccount`, `accountFor` | Connect Clerk identities to workspaces and migrate legacy KV accounts under configured migration restrictions. |
| `rateLimit`, `rateBucket` | Maintain request-rate buckets for API scopes and selected expensive/sensitive actions. |
| `ensureAlarm`, `alarm` | Schedule/resume deletion, vault, audit, study, sleep and Universe cleanup. |
| `phoneAccess` | Issue/read/rotate/revoke scoped phone access credentials, subject to server checks. |
| `evaluateStatus` | Compute task/break unlock state from the saved snapshot. Active undated tasks retain their blocking fallback; descendants inherit the nearest due date; future-dated work is excluded until relevant. It is not the scratchpad predicate. |
| `sleepWindow`, `sleepLockActive` | Calculate Riyadh bedtime/wake windows, including overnight periods and valid one-night delays. |
| `TaskitatorSync.fetch` | Classify routes, authenticate, dispatch services and transactionally process sync/status requests. |

Phone tokens matching the `tkp_` format are accepted only for status reads. Ordinary writes require Clerk authentication. Final `/status` reports two independent results. `device_unlocked` applies, in order: personal tasks, an active Scheduled or Flexible break (server state), eligible Universe assignment locks (skipped during a break), then an active server-managed Emergency Bypass. `sleep` is `true` while Sleep Lock is active (breaks do not lift it; a sleep delay or an active Emergency Bypass does) and never changes `device_unlocked`. `format=text` returns two lines, `device_unlocked = true/false` and `sleep = true/false`; macros must match the full line with a contains rule (a bare `true` matches both lines). Normal JSON carries the same fields plus `sleep_lock_active` and additional status fields.

### `pro-backend.js`

This module imports shared security/provider definitions from `worker.js`; the Worker imports its services in return. This circular module relationship is present in the current layout. Avoid moving code into top-level execution that needs an as-yet uninitialized imported binding.

#### Policy, parsing and accounting helpers

`liveAccount` checks identity/workspace ownership and deletion fences. `fail` supplies HTTP status/code errors; `digest` hashes canonical request data. `prepare` validates proof/exemplar files and builds bounded canonical provider payloads. `parseResult` rejects unsupported/truncated/malformed AI results. `newOperation`/`operationTime` create/validate bounded-age operation IDs. `calculateAuditCharge` implements the insufficient-proof adjustment.

The current personal-hosted policy is `hosted-credits-v4`: 45 credits daily, 1,000 per Gregorian calendar month, a 2,000,000,000-nanodollar monthly provider-spend ceiling, a 20,000 input-token safety bound, up to five proof files, five MiB per file, twenty MiB combined payload, and five-minute quotes. Model names in this README describe configured source strings, not a claim that a live provider currently serves them.

`providerCost(I,O)` calculates `I × 100 + O × 500` in internal nanodollar accounting units. For each task in a batch of `N`, `charges` computes:

```text
taskCredits = ceil(cost × exemplarMultiplier × batchMultiplier × 1000
                   / (1,500,000 × N)) / 1000
exemplarMultiplier = 2 when that task has a reference, otherwise 1
batchMultiplier = 0.75 for a batch with at least two tasks, otherwise 1
```

`totalCredits` sums to thousandth-credit precision. `calculateAuditCharge` discounts insufficient-proof results, including the existing small-charge exemption. These Taskitator credits are distinct from provider token counts. `periods` currently uses Riyadh date and **calendar month**, independently of the user's task day-start hour.

#### `KeyoLicenses`

`keyoConfig` combines public defaults with Worker overrides and validates the endpoint/project/JWK. `verifyKeyoToken` validates the signed ES256 Keyo token, account/project, accepted tier and timing fields. The current verifier accepts `pro`/`max` names after its own normalization; Universe entitlement checks separately require `tier === 'pro'`. Keyo itself supplies no automatic tier hierarchy.

`request` calls activation/verification, rejects redirects and invalid responses, and verifies the returned token. `record` stores verified license state and currently assigns **fixed 45/1,000 limits**, not `d_allow`/`m_allow`. `resolve` deduplicates concurrent refreshes per account. `refresh` verifies stored signatures, uses the implemented freshness/cache policy, refreshes online as needed, handles denial/revocation, and can use still-valid signed state on specified availability errors. `updateIfCurrent` writes only if the stored token/status still matches, preserving concurrent BYOK selection.

#### `TaskProtection`

- `read` loads the authoritative task snapshot. `fingerprint` hashes the relevant branch and references in stable order.
- `bind` selects active AI-protected tasks and replaces client-supplied titles/criteria/references with saved server values before preparing an audit.
- `attest` stores an expiring account/session/operation-bound result naming eligible tasks and their fingerprints.
- `complete` validates and consumes the proof grant, checks current branch state and applies completion transactionally through `writeTaskSnapshot`; repeated confirmation uses stored operation state rather than duplicating completion.
- `guardSync` compares old/new tasks to prevent ordinary sync from changing protected criteria/lock state, fabricating protected completion, or removing shield-required work. Applicable server bypass behavior is evaluated explicitly.
- `bypass` checks authoritative expiry; `emergency` reads/activates the limited weekly bypass using the saved account settings.

#### `HostedAudits`

`headers` selects the hosted Anthropic credential. `entitled` rechecks live active verified entitlement and rejects hosted calls in selected personal-key mode. `balance` loads daily/monthly/spend records; `checkBalance` tests both credit limits and spend ceiling. `round` keeps stored credit precision consistent.

`handle` normalizes API errors; `run` binds canonical tasks and a request fingerprint, replays matching operations, counts the full provider input during a price preview and creates an expiring quote. It requires explicit maximum-price acceptance before inference. It reserves worst-case credit/spend atomically, calls inference outside that reservation transaction, and reconciles the reservation to actual validated usage/results. Audit results can create an attestation; they do not bypass explicit completion confirmation. Uncertain/interrupted operations are retained for safe recovery instead of automatically buying another inference. `previewSlot`/`releasePreview` bound preview work; `cleanup` expires or reconciles retained records.

#### `ProGateway`

`handleRequest`/`routeRequest` dispatch status, activation, BYOK selection, audit quote/review/confirmation, and username requests. `getStatus` returns the account's verified subscription state, presentation username, hosted policy and balances. Without entitlement, hosted limits are zero. `toggleByok` changes Pro AI mode without resetting hosted usage. `activateLicense` verifies a Keyo key and saves the binding; it does not make browser Pro flags authoritative.

`personalReview` binds saved task requirements, checks session and operation replay, invokes the selected personal provider through `AIGateway`, parses the audit result and creates an attestation in a storage transaction. Personal batch review requires active Pro with BYOK mode. The current personal-review path has no new Free 10/220 accounting. `checkUsername`, `setUsername`, `getUsernameProfile`, and `resolveUsername` manage the display-name registry and availability/ownership rules; username resolution is not an authentication endpoint.

`UniverseService` at the bottom is the foundation of the separate Universe class chain described next.

## Universe subsystem

### Server inheritance and effective behavior

```mermaid
classDiagram
    UniverseService <|-- UniverseMembership
    UniverseMembership <|-- UniverseTasks
    UniverseTasks <|-- UniverseAI
    UniverseAI <|-- UniverseRelease
    UniverseRelease <|-- UniverseRules
```

`TaskitatorSync` instantiates **`UniverseRules`**. Reading only a base method can give the wrong result: overridden methods in later files take precedence, while `super` calls retain earlier capabilities and compatibility. `availability` methods inspect phase-marker rows and expose only the capabilities the database supports. Source presence alone does not prove a deployed schema has every phase installed.

| File/class | Functions and how the layer connects |
| --- | --- |
| `pro-backend.js` / `UniverseService` | `database` obtains D1 (primary-first session where supported); `availability`/`ready` check feature/schema; `active` fences deleted/blocked identities; `entitlement` resolves owner Pro; `project` projects account capacity; `authorize` checks membership/role. `input`, `operation`, `text` validate input. `mutate` combines replay record and writes in a D1 batch, maps trigger failures and rechecks access. `event` adds activity. `handle` provides group list/create, invitation/member operations. `blockAccount` writes irreversible account tombstones. |
| `uni/universe-membership.js` / `UniverseMembership` | Adds Phase 2 capability detection; `lifecycle`/`state` track owner entitlement lapses; `authorize` and `writable` apply lifecycle/deletion gates; `guard` creates an SQL write precondition. `change` implements edit/leave/delete/role/remove with revisions and role restrictions. `handle` extends routing and invitations. `blockAccount`/`cleanup` fence and clean owned groups. Later rules override the old blanket read-only lapse policy. |
| `uni/universe-tasks.js` / `UniverseTasks` | Adds projects, task records, assignments, evidence, human review and R2. `record`/`task` read group-scoped records; `access`, `manager`, `reviewer`, `submitter`, `checkRevision` enforce boundaries. `bucket` checks evidence storage. `commit`/`replay` combine guarded idempotent mutations. `taskData` validates baseline assignment settings; `handle` routes writes; `read` scopes work/evidence; `cleanup` removes expired evidence. |
| `uni/universe-ai.js` / `UniverseAI` | Adds dedicated Gemini audit quoting/inference and separate Universe ledgers. `configuration` validates model/rates/hosted switch/spend ceiling; `credentials` chooses hosted or saved Gemini key. `context` binds submission, task, assignment and membership epoch; `payload` reads/hash-checks R2 bytes; `provider` makes bounded calls. `totals` includes active/uncertain holds; `publicReview` converts milli-credit records for API output. `quote`, `approve`, `settle`, `cleanup`, `read`, and `handle` implement explicit consent, atomic budgets, receipts, recovery and human-after-AI rules. |
| `uni/universe-release.js` / `UniverseRelease` | Adds Phase 5 phone consent/lock eligibility, comments, exports/import foundations and transfers. `epoch` binds consent to a membership incarnation; `lockStatus` combines eligible assignments. `comments`/`commentWrite` enforce author/reviewer moderation. Transfer helpers read/store manifests and files, validate bounded archive data, preserve hashes and clean expired staging. `bytesHash` and `encode` support integrity/transport. |
| `uni/universe-rules.js` / `UniverseRules` | Final current policy for task trees, shields/bonus/audit modes, catalogues/project options, thresholds, assignee/reviewer privacy, owner overrides, invitation limits, solo lifecycle, Phase 9 ownership transfer and overwrite import. Overrides `handle`, `work`, `taskWrite`, `assignmentWrite`, `read`, `settle`, `lockStatus`, lifecycle and guards. `ancestors`, `requirements`, `finished`, `submissionOpen`, `normalized`, `validateCriteria` and `completionMet` coordinate the tree/review model. `catalog` merges persisted colors; `exportMetadata` includes rules data; `cleanup` handles expired validation/solo work. |

### Important Universe rules

- `everyone` tasks maintain per-member assignments; `shared` tasks are satisfied by a shared approval. `completionMet` also handles all/count/specific-member requirements.
- Audit modes are `none`, `human`, `ai`, `either`, and `both`. `both` requires the applicable AI result before ordinary human approval; `either` retains the selected review path. Owner override privileges are explicit server policy, not inferred from a UI badge.
- Task state, parent links, ordering and closed/deleted flags are kept in separate rule tables. Required descendants and shields affect completion/deletion; bonus work has explicit treatment in those checks.
- Editing evidence-relevant task fields invalidates/supersedes pending proof as required. Revision guards prevent a stale review from silently approving changed work.
- The latest rules permit continued work in an existing Universe after owner Pro lapses; creating Universes, adding members and renaming have their own Pro conditions. Historical base-class grace/read-only rules must not be quoted as the complete current policy.
- A solo Universe has an explicit seven-day lifecycle handled by `expireSolo` and the `universe_solo` table.
- Membership epochs distinguish leave/rejoin from continuous membership; old proof grants and phone consent must not silently attach to the new membership.
- Phone locking requires member consent for the current epoch and eligible required assignment state with deadline/notice checks. Pending review is not an unfinished open assignment lock. Shared tasks are not simply treated as personal phone blockers.
- Read APIs remove assignee/reviewer data where the current role is not entitled to see it; evidence endpoints are narrower than general task listing.
- Phase 9 ownership transfer preserves the Universe identity/work while checking the recipient and current owner authority. Overwrite import replaces content in place with remapped IDs, preserves destination membership, validates references and current revisions, and resets submissions/proofs/completion rather than importing old approvals as live authority.

Universe AI uses separate D1 accounting, not the personal `pro:usage:` counters. Current hosted balances are account 45/1,000 and shared-group 100/2,000 in display credits; stored values are milli-credits. Personal Universe review uses a saved Gemini key; Shared AI uses the group hosted path. Hosted mode also requires its explicit switch, credential and global ceiling. The checked-in Wrangler file disables Universe hosted AI.

### Browser modules

| File | Behavior and collaborators |
| --- | --- |
| `uni/universe-widgets.js` | `UniverseUX.layer` manages stacked overlays, focus trap/restore, scroll lock and mobile visual viewport. `toast`, `errorMessage`, `skeleton`, `pressFeedback` provide consistent feedback without committing data. |
| `uni/universe-shell.js` | `UniverseDialog.open/confirm/prompt` builds accessible action sheets. `UniverseShell.create` builds header, tabs, role-aware Controls/Settings, sidebar and exit actions. `connection`, `canLeave`, `reset` handle status/dirty forms. Keyboard navigation, resize and network listeners update presentation. |
| `uni/universe-ui.js` | Workspace entry/controller: `actor` and epoch checks reject old-session/view results; `api` uses `TaskitatorAuth`; `send` retains an operation ID for retry; `run` serializes actions and feedback. `list` builds Joined/Created/Join-or-create and member counts. `detail` loads role-aware group features, mounts task/release panels, controls people/invitations/labels/settings and exposes personal statistics. Refresh is explicit; offline changes are not silently queued as personal sync snapshots. |
| `uni/universe-tasks-ui.js` | `mount` loads work and builds project/dashboard/task views. Nested helpers provide filters/date groups/tree folding, assignment progress, property/detail panels, staged Save/Cancel editors, criteria validation, cached file uploads, proof/review actions and explicit AI quote approval. Requests go to `/universe/groups/<id>/work` or `/ai`, not personal task storage. |
| `uni/universe-release-ui.js` | `mount` adds per-member phone consent, discussion with author editing/reply and manager moderation, exports/backups, and Phase 9 ownership/import controls when advertised. Its `commentEditor`, `load`/pagination and export/import flows use shared API/send/run wrappers, hash bytes, and stage transfer files before confirmation. A failure in one feature is presented without erasing other settings actions. |
| `uni/universe-archive.js` | Implements a restricted flat ZIP writer/reader plus hash/base64 helpers. Checks stored-entry format, CRC, bounds, safe names and trailing content; rejects unsupported compressed/path-traversal archives. It is an application interchange format, not a general-purpose ZIP extractor. |

### SQL files and migration relationships

Apply only migrations required by the actual database, in dependency order. These files concern Universe tables; they are not the schema for personal snapshots or Keyo's separate database.

| File | Tables and rule contribution |
| --- | --- |
| `uni/universe-schema.sql` | Foundation/version markers, accounts, groups, members, seat reservations, invitations, operations, guard and events. Triggers enforce account tombstones, owner/member/capacity constraints, reservation/acceptance and operation guards. Phase 9-aware owner triggers preserve later transfer behavior when rerun. |
| `uni/universe-phase2.sql` | Lifecycle, deleted group state, cleanup queue and write guard. Triggers prevent resurrection and enforce invitation/join lifecycle state. |
| `uni/universe-phase3.sql` | Projects, tasks, assignments, submissions and file metadata, plus indexes for group/task/state/expiry access. R2 contains the bytes named by these rows. |
| `uni/universe-phase4.sql` | AI review operations, attestations, budget guard, safety state and membership epochs. Join/depart triggers invalidate an older membership incarnation. |
| `uni/universe-phase5.sql` | Lock consent/eligibility, comments, export permissions, transfers and transfer files. Departure removes stale consent. |
| `uni/universe-phase6-7.sql` | Phase markers, solo lifecycle, settings, project options, tag/priority catalogue, profile display names, criteria checks, task tree/state and catalogue colors. Triggers update solo/assignment behavior and default priorities. |
| `uni/universe-phase9.sql` | Transfer/import capability marker and owner-transfer protection; replaces earlier immutability restrictions with guarded ownership transitions. Includes catalogue-color compatibility table. |

The full table/trigger declaration index appears in [Source navigation index](#source-navigation-index). There is no separate tracked Phase 8 SQL file: catalogue styling compatibility is included in the current migrations.

## End-to-end flows

### Editing and normal synchronization

1. A page opens `TaskitatorComponents` through its host adapter. The editor builds a draft of tasks/recurrence and captures control/reference baselines.
2. Save checks draft/session consistency and applies permitted edits locally. The host persists tasks and tells `SyncEngine` they changed.
3. Sync sends a sanitized snapshot with `base_version`, a stable `mutation_id`, and recurrence schema metadata.
4. The Worker validates identity, account ownership and payload, then compares the base revision inside storage handling. Identical retries return the prior successful mutation; conflicting revisions return 409.
5. The server checks study grants, Smart Study metadata and task protection, reconciles recurrence, applies authorized Smart Study adjustments and merges locked breaks before storing the new revision.
6. Pull/response handlers update accepted local data and dispatch view events. An open dirty editor is not simply overwritten by a render callback.

### Protected proof and completion

```mermaid
sequenceDiagram
    participant UI as Editor and audit UI
    participant API as ProGateway
    participant Guard as TaskProtection
    participant AI as Provider
    participant Store as Snapshot storage
    UI->>API: Quote or personal review for saved task IDs
    API->>Guard: Bind saved branch, criteria and reference
    Guard->>Store: Read authoritative snapshot
    API->>AI: Count/quote and explicitly approved inference
    AI-->>API: Validated result and usage
    API->>Guard: Store eligible task attestation
    API-->>UI: Result and job ID
    UI->>API: Explicit completion confirmation
    API->>Guard: Check session, fingerprint and unused grant
    Guard->>Store: Complete tasks and increment revision
    API-->>UI: Authoritative completion result
```

Hosted counting, credit consent and reservation apply to the hosted branch; personal review uses the selected user's saved key. In both branches, an AI answer and a client checkbox are not substitutes for server-bound completion.

### Universe assignment and evidence

The browser uses the group API, not the personal sync array. A manager creates a task and assignments under a revision guard. A submitter reserves/uploads proof metadata/bytes and submits a bound assignment revision. Human/AI review uses the saved evidence and current permissions. The database atomically records decisions and operation receipts; stale role/membership/task changes prevent applying an outdated result. R2 cleanup follows file state/retention rather than deleting bytes merely because a dialog closed.

### Phone status

Settings obtains a restricted phone token. The phone integration polls the Worker `/status` with that token. The Worker reads/reconciles saved personal tasks, applies break rules, obtains eligible Universe locks, checks Sleep Lock and then an authoritative Emergency Bypass. It returns only the integration status response, not unrestricted snapshot/key access. The browser focus timer is separate.

## API families

The exact allowed methods/fields are validated in their handlers; this table locates the contracts rather than promising arbitrary subroutes.

| Routes | Owner and purpose |
| --- | --- |
| `/auth/me`, `/auth/account` | Worker account status/connection/migration; DELETE account uses verified deletion flow. |
| `/auth/verification/start`, `/password`, `/status`, `/google/callback` | Action verification including OAuth callback. |
| `/auth/deletion/status` | Narrow receipt-based deletion recovery/status. |
| `/auth/phone` | Scoped phone credential management. |
| `/sync/pull`, `/sync/push`, root compatibility routes | Personal versioned snapshots. |
| `/status` and status query aliases | Phone-access JSON/text evaluation. |
| `/sync/bridge/mrstudy-rules` | Compatibility bridge returning no linked rules in this source. |
| `/ai/keys`, `/stage`, `/reveal`, `/test`, `/ai/provider` | Encrypted key metadata/actions/provider selection. Suffixes here belong under `/ai/keys` except `/ai/provider`. |
| `/ai/generate` | Authenticated AI gateway: Pro hosted AI by default, otherwise the selected personal-key provider. |
| `/pro/status`, `/pro/activate`, `/pro/byok` | License/status/mode through `ProGateway`. |
| `/pro/ai/quote`, `/review`, `/batch-review`, `/personal-review` | Under `/pro/ai`; audit quotes and inference. |
| `/pro/ai/batch-confirm` | Explicit protected completion confirmation, also used by personal single-review handling. |
| `/pro/username`, `/pro/username/check`, `/pro/username/profile`, `/pro/username/resolve` | Display profile and name registry. |
| `/emergency`, `/pro/emergency` | Server-managed bypass status/activation. |
| `/sleep-lock` | Schedule status/save and one-night delay. |
| `/study-plan` | Reusable-criteria validation and exact generated-plan grant. |
| `/universe/capabilities`, `/universe/groups`, `/universe/invitations/accept` | Capability discovery, group creation/list, invitation acceptance. |
| `/universe/groups/<id>/…` | Membership/roles/activity, work/projects/tasks/assignments/files, AI, consent, discussion, transfers and later rules, routed through the Universe inheritance chain. |
| `/universe/imports…` | Staged import flows; later Phase 9 overwrite behavior is in `UniverseRules`. |

## Styles, tutorials, data, and assets

- **`style.css`:** Main theme tokens, typography, responsive layout, task rows/priority indicators, forms/modals, navigation, Copilot, settings, feedback/animations, timer and legacy Universe styling. Later rules can override earlier ones. Taskitator's active layout depends on CSS selectors matching the controller's classes/IDs.
- **`uni/universe.css`:** Collaborative-workspace theme, shell/tabs/cards, project/task/detail/editor panels, assignments, sheets, mobile layouts, skeleton/toast/status/feedback. It overrides applicable broad legacy Universe/mobile rules in `style.css`.
- **`tutorial-spotlight.js`:** `start`/`stop` own one active tour. `findTarget`, `rich`, `buildVisual`, positioning/render/step navigation and finish handlers handle optional/missing targets, safe bold/code fragments, keyboard navigation, asynchronous step preparation, reduced motion and focus restoration. It refuses to cover an existing modal/sign-in overlay.
- **`tutorial-integration.js`:** Defines account, breaks, AI, phone, Pro and role-aware Universe tours. `state`, `progress`, `mark` store progress in synced settings; tab helpers select/recover Settings context; onboarding and help-hub logic starts/replays tours while avoiding immediate restart loops. Universe tours switch panes and retain per-Universe completion keys.
- **`tutorial-spotlight.css`:** Tour veil/ring/arrow/card/step controls/visuals, responsive and reduced-motion rules; `.tt-universe` supplies the collaborative theme.
- **`SYSTEM_PROMPT.md`:** External Copilot identity and tool policy. Loaded/validated by `TaskitatorAgent`; task text/tool responses are untrusted data. It does not grant tools that the runtime withheld.
- **`CRITERIA_TEMPLATES.json`:** Eleven editable starter proof-criteria records (`id`, `category`, `label`, `template`) for notes, maps, questions, exams, recall and other work. The shared editor loads them; a template is not automatic validation or approval.
- **`manifest.json`:** PWA name, launch URL, standalone display, colors/orientation and two icon references.
- **`icon/icon-192.png`, `icon/icon-512.png`:** PWA/install branding assets referenced by the manifest and service-worker precache.
- **`image/phase1/Ph1_S1.png` through `Ph1_S5.png`:** Five blocker-setup instructional images used by the consolidated guide.
- **`image/phase2/Ph2_S1.png` through `Ph2_S17.png`:** Seventeen Cloud Bridge/setup instructional images used by that guide.

## Build, configuration, and operations

### Local commands

Use Node **22.13.0 or newer**, as declared in `package.json`. The package is private and ES-module based. It declares no npm dependencies or lockfile; the test suites use built-in Node facilities and local fakes, including SQLite support where used.

```bash
npm test
node --experimental-global-webcrypto --test uni/*.test.js
npm run build
```

Serve the repository root using an HTTP static server for browser work; login, fetch, service workers and crypto are not intended to work by opening HTML through `file://`. Clerk/origin/backend configuration still needs to match the environment. Static hosting and Worker deployment are separate operations.

**`build.mjs` is a CSP generator, not a JS bundler.** `rebuildCsp` scans root HTML files, removes old CSP meta tags, hashes nonempty inline scripts, and writes a policy allowing the app's auth/API hosts. It forbids inline script attributes. The `--csp` spelling appears in the header, but the executable script currently calls the rebuild whenever run; it is not a separate compilation mode. It does not recursively rebuild `uni/setup.html`.

### Service worker

`sw.js` uses cache release `taskitator-smart-study-v1`. Installation precaches assets independently so one missing file does not abort installation; activation removes older caches and claims clients. It answers the bootstrap's security-version message. Authorized requests, API families and cross-origin requests are not cached as normal app assets.

HTML navigation is network-first with cached fallback. JavaScript/CSS and the external Copilot prompt refresh from the network with offline fallback. Other same-origin static resources use normalized pathname cache keys and cached/background refresh behavior. Query-string cache busting is therefore not a substitute for understanding service-worker normalization/versioning.

### Cloudflare deployment configuration

`wrangler.toml` points to `worker.js`, preserves configured variables, registers the SQLite-backed `TaskitatorSync` Durable Object migration, and declares KV/D1/R2 bindings.

| Binding/configuration | Relationship |
| --- | --- |
| `TASKITATOR_SYNC` | Required Durable Object binding for the API/router. |
| `TASKITATOR_KV` | Existing legacy data used during migration. |
| `TASKITATOR_DB` | D1 Universe relational database; SQL installation is separate from declaring the binding. |
| `TASKITATOR_EVIDENCE` | Private R2 evidence/transfer object storage. |
| `ALLOWED_ORIGINS` | Worker origin allowlist; not user authentication. |
| Clerk configuration | `CLERK_ISSUER`, `CLERK_JWT_KEY`, `CLERK_SECRET_KEY` as required by session/API verification paths. Browser publishable configuration is in `core.js`. |
| Google verification configuration | OAuth client ID/secret/redirect settings used for sensitive-action reauthentication. |
| `API_VAULT_KEYS`, `API_VAULT_ACTIVE_KEY_ID` | Server encryption key ring and active version; retain old versions until records are migrated. |
| `KEYO_API_ORIGIN`, `KEYO_PROJECT_ID`, `KEYO_PUBLIC_JWK` | Public subscription-verification configuration; no owner/admin secret is needed by normal subscription integration. |
| `ANTHROPIC_API_KEY` / supported `CLAUDE_API_KEY` fallback | Hosted personal audit credential. Personal BYOK credentials live encrypted in the vault instead. |
| `UNIVERSE_FOUNDATION_ENABLED` | Enables the relational subsystem after required setup. |
| `UNIVERSE_GEMINI_MODEL`, verification flag and token-rate variables | Dedicated Universe audit model and accounting configuration. |
| `UNIVERSE_HOSTED_ENABLED`, hosted Gemini key and monthly ceiling | Additional safeguards required for hosted Universe inference; checked-in hosted switch is false. |
| Legacy migration/deletion controls | Restrict importing legacy accounts and enable supported deletion behavior. Inspect the handlers before changing these values. |

Do not publish provider keys, encryption keys, Clerk secrets or OAuth secrets in frontend files. The binding IDs and public verification configuration already in the repository do not establish that a deployment is healthy or a schema migration has run.

`.github/workflows/deploy-worker-security.yml` runs on every push to `main` and on manual `workflow_dispatch`. It uses actions pinned to commit SHAs, Node 22, `npm ci --ignore-scripts` (exact Wrangler from `package-lock.json`), runs `npm test` (root and `uni/` suites), and deploys with GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. `npm run deploy:worker` is the equivalent explicit CLI entry point; it performs a real deployment.

### Historical/support files

- `docs/credit-limits.md` documents the credit-limit implementation and its open review items.
- `CNAME` records the static frontend custom hostname.
- `LICENSE` contains the repository's MIT terms.

## Tests and verification

Tests are source-level/fixture-based evidence, not a live browser or Cloudflare acceptance test. Root suites use fake storage, VM DOM/context fixtures, provider stubs and crypto fixtures. Universe suites additionally use in-memory SQLite/D1 adapters and small UI DOM doubles. These fixtures intentionally exercise server guards and concurrency, not only happy-path UI strings.

| Test file | Main behavior exercised |
| --- | --- |
| `client.test.js` | Auth/storage cleanup, account isolation/sync/conflict behavior, vault/provider UI/migration, Copilot tool loops/context, criteria/proof integration, study preview/confirmation and browser-side guards. |
| `copilot-today.test.js` | Scoped progress payload fields, logical-day filtering and overdue inclusion. It does not prove a system-wide privacy boundary. |
| `phone-access-date.test.js` | Parent/grandparent due-date inheritance, explicit dates, malformed ancestry and break/bypass exceptions in phone status. |
| `pro.test.js` | Hosted cost math/reservations/discounts/quotes, entitlement changes, idempotency/concurrency, task binding/attestation/completion, UI confirmation/focus, recurrence, Keyo behavior, consolidated pages and service-worker asset references. It imports some nested Universe tests as part of the root run. |
| `scratchpad-plan-a.test.js` | Required today/overdue work gate and inherited dates. It does not by itself exercise every archive/read route. |
| `security.test.js` | Authentication, scoped credentials, encrypted vault/reverification/provider isolation, AI translation/output checks, deletion/recovery, sync tampering, protected completion and Universe backend fixture scenarios. |
| `smart-study.test.js` | Early appearances, slot movement, weekend/date choices, audited timing, replay/reopen behavior and metadata tampering. |
| `uni/universe-interface.test.js` | Picker/project/task UI behavior, editor retry safety, role shell and assignment-based dashboard progress. |
| `uni/universe-polish.test.js` | Editor Save/Cancel/layout, role-aware Settings, isolated feature failures, overlay focus/viewport behavior and asynchronous picker counts. |
| `uni/universe-release.test.js` | Flat archive round trip, integrity and rejection of unsafe/unsupported ZIP data. |
| `uni/universe-rules.test.js` | SQLite-backed latest rules: membership/Pro policies, review modes, shields/trees/privacy, stale writes, colors, transfer/import and schema repeatability. |
| `uni/universe-shell.test.js` | Navigation destinations/role controls, dirty-form handling, connection states and action-sheet results. |

`npm test` expands only root `*.test.js` directly. Imports in those tests pull in some nested suites, but the explicit `uni/*.test.js` command is still useful for full nested discovery. Do not add the totals from those two commands as if all tests were unique.

For this documentation update, `npm test` passed **387/387** and the explicit nested command passed **63/63** on the inspected source. Some cases overlap between the commands. No live browser, Clerk, Keyo, provider or Cloudflare deployment verification was performed. These results do not prove production configuration or real AI availability.

## Maintenance boundaries

| Change | Files/relationships to inspect together |
| --- | --- |
| Header, sorting, filtering | `index.html`, `app.js`, `style.css`; classic-script initialization and cache behavior. |
| Task fields, editor saves, lock/shield semantics | `components.js`, `app.js`, relevant inline workspace controllers, `pro-backend.js` protection and `worker.js` snapshot validation. |
| Recurrence field changes | Both embedded recurrence cores, template allowlists/reference handling, sync schema and recurrence tests. |
| Smart Study / numbered study plans | Both `pro/` scripts, editor/Copilot preview entry, Worker grant/guard/apply paths, protection/completion timing. |
| AI provider or payload | `pro.js`, `app.js`, `worker.js` validation/translation/vault, protected audit parsing, criteria/output schemas and provider fixtures. |
| Credit policy | `pro-backend.js` entitlement/status/reservation/settlement, general BYOK gateway, UI and tests; Universe has its own D1 policy and must be considered explicitly. |
| Universe behavior | Final override chain, SQL markers/triggers, related browser module, D1/R2 retention and fixture tests. |
| Phone response | `evaluateStatus`, sleep/bypass, final Universe `lockStatus`, phone credential scope and settings/setup guidance. |
| Inline HTML script | Page controller plus `build.mjs` CSP hashes. |
| Asset/loading release | Page declarations, `sw.js`, bootstrap's expected cache version and referenced files. |

At the inspected revision, **Keyo-configured `d_allow`/`m_allow`, Free BYOK 10/220 limits, Pro activation-anchored 30-day periods, transition resets and the proposed Free three-state quota card are not implemented**. Pro Dynamic Priority is also not an integrated feature here. Documentation must not be mistaken for implementation of those earlier proposals.


## Alphabetical file catalogue

Paths are relative to the repository root. This is the complete inspected file list; the new README itself is additional documentation. PNG assets are catalogued by reference/use rather than treated as executable code.

| File | Role |
| --- | --- |
| [`.github/workflows/deploy-worker-security.yml`](.github/workflows/deploy-worker-security.yml) | Manual security-test and Worker deployment workflow; see Build, configuration, and operations. |
| [`app.js`](app.js) | Copilot engine, personal views/tree/sorting/completion, scratchpad and guarded legacy timer. |
| [`build.mjs`](build.mjs) | Rebuilds root HTML CSP hashes; no JavaScript bundling. |
| [`client.test.js`](client.test.js) | Browser/auth/sync/provider/Copilot/editor/study regression fixtures. |
| [`CNAME`](CNAME) | Static-host custom domain declaration. |
| [`components.html`](components.html) | Consolidated projects/calendar/stats/trash/guide/legal/Universe page with inline controllers. |
| [`components.js`](components.js) | Shared feedback, recurrence core/UI and draft-based task editor/audit components. |
| [`copilot-today.test.js`](copilot-today.test.js) | Scoped progress fields and logical-day selection tests. |
| [`core.js`](core.js) | Public auth configuration, Clerk client, personal sync, deletion/login/bootstrap. |
| [`CRITERIA_TEMPLATES.json`](CRITERIA_TEMPLATES.json) | Eleven structured starter proof-criteria templates consumed by the editor. |
| [`icon/icon-192.png`](icon/icon-192.png) | PWA branding image referenced by manifest.json and service-worker precache. |
| [`icon/icon-512.png`](icon/icon-512.png) | PWA branding image referenced by manifest.json and service-worker precache. |
| [`image/phase1/Ph1_S1.png`](image/phase1/Ph1_S1.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase1/Ph1_S2.png`](image/phase1/Ph1_S2.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase1/Ph1_S3.png`](image/phase1/Ph1_S3.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase1/Ph1_S4.png`](image/phase1/Ph1_S4.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase1/Ph1_S5.png`](image/phase1/Ph1_S5.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S1.png`](image/phase2/Ph2_S1.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S10.png`](image/phase2/Ph2_S10.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S11.png`](image/phase2/Ph2_S11.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S12.png`](image/phase2/Ph2_S12.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S13.png`](image/phase2/Ph2_S13.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S14.png`](image/phase2/Ph2_S14.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S15.png`](image/phase2/Ph2_S15.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S16.png`](image/phase2/Ph2_S16.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S17.png`](image/phase2/Ph2_S17.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S2.png`](image/phase2/Ph2_S2.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S3.png`](image/phase2/Ph2_S3.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S4.png`](image/phase2/Ph2_S4.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S5.png`](image/phase2/Ph2_S5.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S6.png`](image/phase2/Ph2_S6.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S7.png`](image/phase2/Ph2_S7.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S8.png`](image/phase2/Ph2_S8.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`image/phase2/Ph2_S9.png`](image/phase2/Ph2_S9.png) | Instructional screenshot referenced by the blocker/Cloud Bridge guide in components.html. |
| [`index.html`](index.html) | Personal task shell, controls, dialogs and authenticated script declarations. |
| [`LICENSE`](LICENSE) | MIT license text. |
| [`login.html`](login.html) | Clerk sign-in/up and workspace connection/migration markup. |
| [`manifest.json`](manifest.json) | PWA installation metadata and icon references. |
| [`package.json`](package.json) | ES-module/Node version declaration and test/build/deploy commands. |
| [`phone-access-date.test.js`](phone-access-date.test.js) | Phone-status inherited-date and exception tests. |
| [`pro-backend.js`](pro-backend.js) | Hosted policy, Keyo licenses, task protection/audits, Pro API and Universe foundation. |
| [`pro.js`](pro.js) | Browser safety, references, breaks, key vault client, audit/Pro/profile/tier interfaces. |
| [`pro.test.js`](pro.test.js) | Personal hosted/protection/UI/license regression tests and imported nested coverage. |
| [`pro/smart-study.js`](pro/smart-study.js) | Shared early-opportunity validation, decoration, completion adjustment and sync guard. |
| [`pro/study-plan.js`](pro/study-plan.js) | Shared finite study-plan generator and Pro browser preview/authorization. |
| [`scratchpad-plan-a.test.js`](scratchpad-plan-a.test.js) | Required today/overdue and inherited-date scratchpad gate tests. |
| [`security.test.js`](security.test.js) | Worker security, vault/AI/deletion/sync/protection and backend integration fixtures. |
| [`settings.html`](settings.html) | Settings/backup/phone/Pro/account markup and inline preferences controller. |
| [`sleep.html`](sleep.html) | Authenticated revisioned Sleep Lock UI and one-night delay controls. |
| [`smart-study.test.js`](smart-study.test.js) | Smart Study schedule, audit timing, replay and tampering tests. |
| [`style.css`](style.css) | Shared theme/layout/components/motion and timer styling. |
| [`sw.js`](sw.js) | Versioned PWA cache and network/offline resource strategies. |
| [`SYSTEM_PROMPT.md`](SYSTEM_PROMPT.md) | Validated external Focus Copilot system prompt; consumed by app.js. |
| [`tutorial-integration.js`](tutorial-integration.js) | Page/role-specific tour content, synced progress and help/replay integration. |
| [`tutorial-spotlight.css`](tutorial-spotlight.css) | Spotlight overlays/cards/visuals/responsive/motion styles. |
| [`tutorial-spotlight.js`](tutorial-spotlight.js) | Accessible step-based tutorial renderer and target positioning. |
| [`uni/focus-timer.js`](uni/focus-timer.js) | Active persistent per-account browser timer, wake/audio/PiP and scratchpad integration. |
| [`uni/setup.html`](uni/setup.html) | Static operator setup and historical phase guide; does not execute migrations. |
| [`uni/universe-ai.js`](uni/universe-ai.js) | UniverseAI server layer: Gemini quotes, consent, separate budgets and attestations. |
| [`uni/universe-archive.js`](uni/universe-archive.js) | Restricted flat ZIP, CRC, hash and byte encoding helpers in the browser. |
| [`uni/universe-interface.test.js`](uni/universe-interface.test.js) | Collaborative picker/task/project/dashboard interface regression fixtures. |
| [`uni/universe-membership.js`](uni/universe-membership.js) | UniverseMembership server layer: membership/lifecycle/role/deletion guards. |
| [`uni/universe-phase2.sql`](uni/universe-phase2.sql) | Lifecycle, group deletion/cleanup and guarded-write schema/triggers. |
| [`uni/universe-phase3.sql`](uni/universe-phase3.sql) | Projects/tasks/assignments/submissions/evidence metadata schema. |
| [`uni/universe-phase4.sql`](uni/universe-phase4.sql) | AI operations/attestations/budget/safety/membership-epoch schema. |
| [`uni/universe-phase5.sql`](uni/universe-phase5.sql) | Phone consent/eligibility, discussion and transfer schema. |
| [`uni/universe-phase6-7.sql`](uni/universe-phase6-7.sql) | Tree state, solo lifecycle, settings/catalogue/profile/criteria schema and colors. |
| [`uni/universe-phase9.sql`](uni/universe-phase9.sql) | Guarded owner-transfer and overwrite-import capability schema. |
| [`uni/universe-polish.test.js`](uni/universe-polish.test.js) | Editor/role-settings/overlay/async-picker behavior fixtures. |
| [`uni/universe-release-ui.js`](uni/universe-release-ui.js) | Browser consent/discussion/backup/transfer and ownership controls. |
| [`uni/universe-release.js`](uni/universe-release.js) | UniverseRelease server layer: locks, discussion, exports/import foundations and retention. |
| [`uni/universe-release.test.js`](uni/universe-release.test.js) | Archive round-trip and malformed/unsafe ZIP rejection tests. |
| [`uni/universe-rules.js`](uni/universe-rules.js) | Final server policy overrides: trees, audits, privacy, lifecycle, transfer and overwrite. |
| [`uni/universe-rules.test.js`](uni/universe-rules.test.js) | SQLite-backed final rules, migration, assignment and portability tests. |
| [`uni/universe-schema.sql`](uni/universe-schema.sql) | Foundational D1 tables, version markers, membership/capacity/operation triggers. |
| [`uni/universe-shell.js`](uni/universe-shell.js) | Universe navigation/tab/connection/dirty-form shell and confirmation dialogs. |
| [`uni/universe-shell.test.js`](uni/universe-shell.test.js) | Shell roles, connection labels, dirty navigation and dialog tests. |
| [`uni/universe-tasks-ui.js`](uni/universe-tasks-ui.js) | Collaborative project/task editor, tree/dashboard, assignments/proof/review UI. |
| [`uni/universe-tasks.js`](uni/universe-tasks.js) | UniverseTasks server layer: relational work/evidence/human review and R2 cleanup. |
| [`uni/universe-ui.js`](uni/universe-ui.js) | Universe browser entry: group picker, authenticated API/retry wrappers, feature mounting. |
| [`uni/universe-widgets.js`](uni/universe-widgets.js) | Shared Universe overlays/focus/viewport, feedback, skeletons and error messages. |
| [`uni/universe.css`](uni/universe.css) | Collaborative workspace theme, task/editor/shell/mobile/motion styling. |
| [`worker.js`](worker.js) | Cloudflare entry, auth/verification/deletion/vault/AI, personal sync/status/sleep/study router. |
| [`wrangler.toml`](wrangler.toml) | Worker entry, public variables, Durable Object migration and KV/D1/R2 bindings. |

## Source navigation index

The explanations above group related functions by responsibility. This index links named declarations and line-start methods to their definitions so readers can find the smaller helpers inside the consolidated files. It is navigation, not a claim that static naming analysis proves runtime behavior. Anonymous callbacks and embedded markup/styles are explained with their owning controllers. Line references target the inspected source revision and can move after later edits.


### `app.js`

[`isTaskitatorPrompt`](app.js#L49), [`aiSelection`](app.js#L60), [`selectionIdentity`](app.js#L61), [`resetConversation`](app.js#L62), [`getPageContext`](app.js#L67), [`getCopilotName`](app.js#L94), [`getSystemPrompt`](app.js#L106), [`getApiKey`](app.js#L281), [`executeModelCall`](app.js#L289), [`todayProgress`](app.js#L317), [`dueFor`](app.js#L319), [`executeToolCall`](app.js#L345).

[`commitTasks`](app.js#L475), [`getTrimmedContents`](app.js#L499), [`sendMessage`](app.js#L514), [`scratchpadBlocked`](app.js#L607), [`extractNotesBatch`](app.js#L624), [`refreshSystemNames`](app.js#L720), [`initUI`](app.js#L765), [`formatReply`](app.js#L784), [`inline`](app.js#L786), [`appendBubble`](app.js#L797), [`getComponents`](app.js#L910), [`openTaskCreationModal`](app.js#L944).

[`openTaskDetailModal`](app.js#L945), [`openAuditModal`](app.js#L946), [`renderModalTagCloud`](app.js#L947), [`getAppTodayStr`](app.js#L966), [`getAudioContext`](app.js#L979), [`isMuted`](app.js#L989), [`playComplete`](app.js#L997), [`playSuccessAudit`](app.js#L1014), [`playTimeoutAlert`](app.js#L1033), [`reducedMotion`](app.js#L1056), [`hapticsOn`](app.js#L1059), [`vibrate`](app.js#L1067).

[`tap`](app.js#L1071), [`success`](app.js#L1072), [`deny`](app.js#L1073), [`replay`](app.js#L1075), [`shake`](app.js#L1082), [`complete`](app.js#L1087), [`DistractionDumpEngine`](app.js#L1100), [`getNotes`](app.js#L1105), [`saveNotes`](app.js#L1113), [`garbageCollect`](app.js#L1118), [`updateTriggerIcon`](app.js#L1130), [`formatRemainingTTL`](app.js#L1144).

[`openModal`](app.js#L1156), [`forceCommitAndClose`](app.js#L1180), [`closeModal`](app.js#L1198), [`startHardTimer`](app.js#L1206), [`updateUI`](app.js#L1212), [`openEscrowModal`](app.js#L1241), [`getGlobalProjects`](app.js#L1334), [`saveProject`](app.js#L1354), [`deleteProjectWithCascade`](app.js#L1383), [`getGlobalTags`](app.js#L1420), [`getGlobalPriorities`](app.js#L1429), [`saveGlobalTag`](app.js#L1438).

[`getLowestPriorityId`](app.js#L1454), [`isStrictCriteriaModeEnabled`](app.js#L1460), [`isBypassActiveSafe`](app.js#L1472), [`getEmergencyStateSafe`](app.js#L1479), [`getTodayBreaksSafe`](app.js#L1486), [`loadStorage`](app.js#L1511), [`saveStorageAndPush`](app.js#L1538), [`updateSyncDot`](app.js#L1566), [`initSyncIndicator`](app.js#L1580), [`sortTasks`](app.js#L1592), [`getRank`](app.js#L1594), [`getAllDescendants`](app.js#L1617).

[`hasUncompletedDescendant`](app.js#L1631), [`getShieldedAncestor`](app.js#L1643), [`isCompletionBlocked`](app.js#L1657), [`cascadeProject`](app.js#L1675), [`cascadeTaskStatus`](app.js#L1685), [`cascadeChildren`](app.js#L1699), [`finalizeTaskCompletion`](app.js#L1717), [`pushToLedger`](app.js#L1733), [`startGraceCompletionTimer`](app.js#L1781), [`undoTaskCompletion`](app.js#L1812), [`handleTaskCompletion`](app.js#L1826), [`deleteTask`](app.js#L1860).

[`markTrash`](app.js#L1878), [`renderFilterClouds`](app.js#L1896), [`toggleSelectionMode`](app.js#L1958), [`toggleTaskSelection`](app.js#L1972), [`eligibleSelectionTasks`](app.js#L1987), [`refreshSelectAllLabel`](app.js#L1990), [`updateBatchBarUI`](app.js#L1996), [`resize`](app.js#L2004), [`init`](app.js#L2032), [`updateStatusPill`](app.js#L2059), [`openModal`](app.js#L2131), [`closeModal`](app.js#L2137).

[`captureDraft`](app.js#L2141), [`startCountdownTimer`](app.js#L2151), [`autoCommitAndLock`](app.js#L2181), [`getCurrentRowsData`](app.js#L2191), [`renderModal`](app.js#L2203), [`handleStartPlanning`](app.js#L2344), [`addBreakRow`](app.js#L2357), [`saveBreaks`](app.js#L2385), [`showError`](app.js#L2422), [`hideError`](app.js#L2428), [`isTaskVisuallyActive`](app.js#L2448), [`renderUnifiedTaskTree`](app.js#L2458).

[`markEnter`](app.js#L2464), [`belongsToCurrentView`](app.js#L2495), [`hasVisibleDescendant`](app.js#L2507), [`checkDesc`](app.js#L2529), [`buildNodeElement`](app.js#L2563), [`done`](app.js#L2669), [`renderCompletedModalList`](app.js#L2866), [`uncompleteFromModal`](app.js#L2945), [`renderUnifiedView`](app.js#L2971), [`setView`](app.js#L2978), [`handleHashRouting`](app.js#L2999), [`updateEmergencyUI`](app.js#L3007).

[`init`](app.js#L3040), [`updateSortChecks`](app.js#L3049), [`closeSortMenu`](app.js#L3053), [`openBulkRescheduleModal`](app.js#L3275), [`closeReschedule`](app.js#L3302), [`openCopilot`](app.js#L3482), [`closeCopilot`](app.js#L3488), [`initAudio`](app.js#L3708), [`playBell`](app.js#L3718), [`startTimer`](app.js#L3977), [`pauseTimer`](app.js#L3987), [`resetTimer`](app.js#L3995).

[`tick`](app.js#L4003), [`handlePhaseTransition`](app.js#L4014), [`injectDOM`](app.js#L4045), [`renderDigits`](app.js#L4123), [`updateClockUI`](app.js#L4130), [`showSetup`](app.js#L4153), [`showClock`](app.js#L4158), [`toggleFullscreen`](app.js#L4167), [`checkViewVisibility`](app.js#L4197), [`bindEvents`](app.js#L4207).


### `build.mjs`

[`rebuildCsp`](build.mjs#L13).


### `components.html`

[`isProjectsWorkspaceAllowed`](components.html#L1294), [`renderProjectStrip`](components.html#L1302), [`renderProjectWorkspace`](components.html#L1332), [`buildNode`](components.html#L1389), [`openProjectModal`](components.html#L1465), [`renderEmojiGrid`](components.html#L1512), [`renderColorRow`](components.html#L1528), [`initAriCopilot`](components.html#L1544), [`open`](components.html#L1562), [`close`](components.html#L1568), [`isCalendarWorkspaceAllowed`](components.html#L1735), [`loadData`](components.html#L1743).

[`saveDataAndSync`](components.html#L1749), [`getNormalizedTaskDueDate`](components.html#L1757), [`isTaskRecurring`](components.html#L1765), [`renderCalendar`](components.html#L1769), [`renderAgenda`](components.html#L1858), [`checkDesc`](components.html#L1884), [`buildAgendaNode`](components.html#L1912), [`renderUnscheduledBacklog`](components.html#L1978), [`toggleUnscheduledCard`](components.html#L2030), [`getArchivedNotes`](components.html#L2126), [`saveArchivedNotes`](components.html#L2134), [`renderArchiveList`](components.html#L2139).

[`isPrivateWorkspaceAllowed`](components.html#L2196), [`renderStats`](components.html#L2204), [`isTrashWorkspaceAllowed`](components.html#L2433), [`loadTasks`](components.html#L2441), [`saveTasksAndPush`](components.html#L2450), [`renderTrash`](components.html#L2462), [`restoreTask`](components.html#L2508), [`recursiveRestoreChildren`](components.html#L2521), [`permanentlyDeleteTask`](components.html#L2533), [`collectIds`](components.html#L2537), [`getP1SavedState`](components.html#L2661), [`setP1SavedState`](components.html#L2669).

[`toggleP1Major`](components.html#L2673), [`toggleP1Minor`](components.html#L2678), [`openP1MinorAndMajor`](components.html#L2683), [`toggleP1Sub`](components.html#L2702), [`evaluateP1Rollups`](components.html#L2719), [`resetPhase1Progress`](components.html#L2768), [`getSavedState`](components.html#L2815), [`setSavedState`](components.html#L2823), [`toggleMajor`](components.html#L2827), [`toggleMinor`](components.html#L2832), [`openMinorAndMajor`](components.html#L2837), [`toggleSub`](components.html#L2849).

[`evaluateRollups`](components.html#L2866), [`resetPhase2Progress`](components.html#L2915), [`subId`](components.html#L2928), [`isAuthenticatedWorkspace`](components.html#L3074), [`activateComponentView`](components.html#L3085).


### `components.js`

[`fx`](components.js#L13), [`ensureHost`](components.js#L17), [`raiseHost`](components.js#L29), [`inferType`](components.js#L38), [`dismiss`](components.js#L47), [`remove`](components.js#L52), [`show`](components.js#L62), [`arm`](components.js#L112), [`parseLegacy`](components.js#L122), [`confirmSheet`](components.js#L135), [`finish`](components.js#L177), [`cleanup`](components.js#L182).

[`setBusy`](components.js#L204), [`copy`](components.js#L238), [`validDate`](components.js#L239), [`dateMs`](components.js#L243), [`dateString`](components.js#L244), [`today`](components.js#L245), [`schedule`](components.js#L248), [`nextDate`](components.js#L263), [`subtree`](components.js#L291), [`seriesFor`](components.js#L297), [`canStart`](components.js#L300), [`cleanNode`](components.js#L311).

[`start`](components.js#L316), [`updateNode`](components.js#L345), [`validateState`](components.js#L351), [`reconcile`](components.js#L377), [`depth`](components.js#L395), [`idFor`](components.js#L426), [`empty`](components.js#L456), [`state`](components.js#L457), [`tasks`](components.js#L458), [`settings`](components.js#L459), [`today`](components.js#L460), [`persist`](components.js#L461).

[`save`](components.js#L475), [`element`](components.js#L483), [`button`](components.js#L487), [`input`](components.js#L490), [`dialog`](components.js#L494), [`scheduleForm`](components.js#L499), [`change`](components.js#L513), [`captureReferences`](components.js#L517), [`attachCreated`](components.js#L525), [`validCreate`](components.js#L533), [`bindTask`](components.js#L540), [`applyEdit`](components.js#L559).

[`open`](components.js#L576), [`overview`](components.js#L632), [`create`](components.js#L658), [`copy`](components.js#L686), [`controls`](components.js#L687), [`dirty`](components.js#L688), [`discardDraft`](components.js#L689), [`refreshConsecutive`](components.js#L690), [`commitDraft`](components.js#L691), [`getSavedCriteria`](components.js#L736), [`saveSavedCriteriaList`](components.js#L745), [`updateSavedCriteriaBadge`](components.js#L755).

[`fileToBase64Payload`](components.js#L763), [`base64PayloadToFile`](components.js#L780), [`parseTitle`](components.js#L801), [`resolveCriteria`](components.js#L817), [`validateCriteriaForSubmission`](components.js#L839), [`reverseSubstitute`](components.js#L849), [`incrementConsecutiveNum`](components.js#L861), [`updateMrStudyRuleDropdown`](components.js#L870), [`renderModalProjectCloud`](components.js#L897), [`renderModalTagCloud`](components.js#L930), [`handleQuickAddTag`](components.js#L950), [`renderModalPriorityCloud`](components.js#L962).

[`NLPEngine`](components.js#L995), [`upgradeInput`](components.js#L996), [`insertText`](components.js#L1008), [`handleInput`](components.js#L1033), [`handleClick`](components.js#L1155), [`handleKeydown`](components.js#L1218), [`handlePaste`](components.js#L1226), [`extractCleanTitle`](components.js#L1232), [`openAuditModal`](components.js#L1256), [`refreshDetailSubtaskList`](components.js#L1292), [`openTaskDetailModal`](components.js#L1325), [`openTaskCreationModal`](components.js#L1563).

[`init`](components.js#L1671), [`bindConsecutiveToggle`](components.js#L1911), [`runCriteriaValidation`](components.js#L2820), [`switchTemplatesModalTab`](components.js#L3069), [`renderSavedCriteriaList`](components.js#L3092), [`applySavedCriteria`](components.js#L3149), [`openTemplatesPicker`](components.js#L3203).


### `core.js`

[`readSnapshot`](core.js#L22), [`recoveryCopies`](core.js#L27), [`preserveCopy`](core.js#L34), [`snapshotTime`](core.js#L41), [`cleanSettings`](core.js#L45), [`cleanSnapshot`](core.js#L57), [`cleanLegacyStorage`](core.js#L65), [`loadScript`](core.js#L113), [`token`](core.js#L131), [`api`](core.js#L137), [`connect`](core.js#L152), [`signOut`](core.js#L158).

[`manageAccount`](core.js#L180), [`init`](core.js#L181), [`onStatusChange`](core.js#L274), [`notify`](core.js#L278), [`getConfig`](core.js#L293), [`isConfigured`](core.js#L305), [`accountCacheKey`](core.js#L309), [`archiveLocalAccount`](core.js#L313), [`clearLocalAccount`](core.js#L335), [`beginLogin`](core.js#L342), [`initializeSession`](core.js#L373), [`sessionMatches`](core.js#L390).

[`needsInitialPull`](core.js#L398), [`isDirty`](core.js#L402), [`markLocalModified`](core.js#L406), [`rememberRemoteVersion`](core.js#L414), [`getPayload`](core.js#L421), [`push`](core.js#L463), [`run`](core.js#L466), [`performPush`](core.js#L474), [`readCloud`](core.js#L533), [`request`](core.js#L548), [`scheduleAutoPush`](core.js#L563), [`queueAutoPush`](core.js#L568).

[`startAutoWindow`](core.js#L573), [`armAutoSync`](core.js#L581), [`cancelAutoWindow`](core.js#L600), [`runAutoSync`](core.js#L606), [`run`](core.js#L607), [`flushIfDirty`](core.js#L623), [`forceImmediateSync`](core.js#L628), [`syncNow`](core.js#L633), [`run`](core.js#L640), [`registerRefreshGuard`](core.js#L683), [`isSafeToRefresh`](core.js#L687), [`autoRefreshEnabled`](core.js#L695).

[`maybeRefreshPage`](core.js#L700), [`changePassword`](core.js#L716), [`resumePasswordChange`](core.js#L721), [`fetchMrStudyRules`](core.js#L726), [`pull`](core.js#L731), [`reportConflict`](core.js#L830), [`openConflictDialog`](core.js#L841), [`addButton`](core.js#L859), [`close`](core.js#L864), [`downloadBackup`](core.js#L865), [`choose`](core.js#L887), [`run`](core.js#L891).

[`logout`](core.js#L923), [`enforceAuthenticationGuard`](core.js#L942), [`resumePendingWork`](core.js#L966), [`byId`](core.js#L993), [`feedback`](core.js#L997), [`update`](core.js#L998), [`cleanLocal`](core.js#L1005), [`start`](core.js#L1039), [`password`](core.js#L1047), [`googleAuthorizationUrl`](core.js#L1066), [`google`](core.js#L1078), [`confirmDeletion`](core.js#L1087).

[`open`](core.js#L1120), [`check`](core.js#L1182), [`activate`](core.js#L1210), [`runTaskitatorLoginPage`](core.js#L1237), [`show`](core.js#L1241), [`showConnected`](core.js#L1245), [`enter`](core.js#L1279), [`render`](core.js#L1297), [`versionMatches`](core.js#L1379), [`finish`](core.js#L1394), [`check`](core.js#L1400), [`activatePublicView`](core.js#L1424).

[`update`](core.js#L1524).


### `index.html`

No named function declarations indexed. Behavior is in markup, configuration, or anonymous event/initialization handlers described in the file guide.


### `login.html`

No named function declarations indexed. Behavior is in markup, configuration, or anonymous event/initialization handlers described in the file guide.


### `pro-backend.js`

[`liveAccount`](pro-backend.js#L8), [`periods`](pro-backend.js#L25), [`fail`](pro-backend.js#L29), [`digest`](pro-backend.js#L32), [`providerCost`](pro-backend.js#L36), [`charges`](pro-backend.js#L41), [`totalCredits`](pro-backend.js#L47), [`prepare`](pro-backend.js#L49), [`file`](pro-backend.js#L56), [`parseResult`](pro-backend.js#L98), [`newOperation`](pro-backend.js#L117), [`operationTime`](pro-backend.js#L118).

[`calculateAuditCharge`](pro-backend.js#L125), [`issue`](pro-backend.js#L143), [`decode`](pro-backend.js#L144), [`parse`](pro-backend.js#L148), [`keyoConfig`](pro-backend.js#L150), [`verifyKeyoToken`](pro-backend.js#L164), [`KeyoLicenses`](pro-backend.js#L189), [`request`](pro-backend.js#L191), [`report`](pro-backend.js#L193), [`record`](pro-backend.js#L227), [`resolve`](pro-backend.js#L234), [`refresh`](pro-backend.js#L240).

[`inactive`](pro-backend.js#L243), [`updateIfCurrent`](pro-backend.js#L268), [`protectedTask`](pro-backend.js#L281), [`branch`](pro-backend.js#L282), [`stable`](pro-backend.js#L283), [`filePart`](pro-backend.js#L285), [`TaskProtection`](pro-backend.js#L286), [`read`](pro-backend.js#L288), [`fingerprint`](pro-backend.js#L289), [`bind`](pro-backend.js#L294), [`attest`](pro-backend.js#L315), [`complete`](pro-backend.js#L323).

[`guardSync`](pro-backend.js#L371), [`bypass`](pro-backend.js#L401), [`emergency`](pro-backend.js#L402), [`HostedAudits`](pro-backend.js#L422), [`headers`](pro-backend.js#L424), [`entitled`](pro-backend.js#L429), [`balance`](pro-backend.js#L438), [`handle`](pro-backend.js#L446), [`run`](pro-backend.js#L450), [`matches`](pro-backend.js#L460), [`previewSlot`](pro-backend.js#L592), [`releasePreview`](pro-backend.js#L607).

[`cleanup`](pro-backend.js#L615), [`round`](pro-backend.js#L632), [`checkBalance`](pro-backend.js#L633), [`json`](pro-backend.js#L655), [`sha256`](pro-backend.js#L662), [`getRiyadhDateStrings`](pro-backend.js#L669), [`readProJSON`](pro-backend.js#L676), [`ProGateway`](pro-backend.js#L687), [`handleRequest`](pro-backend.js#L697), [`routeRequest`](pro-backend.js#L703), [`getStatus`](pro-backend.js#L768), [`toggleByok`](pro-backend.js#L828).

[`activateLicense`](pro-backend.js#L853), [`personalReview`](pro-backend.js#L876), [`checkUsername`](pro-backend.js#L924), [`setUsername`](pro-backend.js#L944), [`getUsernameProfile`](pro-backend.js#L976), [`resolveUsername`](pro-backend.js#L985), [`universeError`](pro-backend.js#L996), [`UniverseService`](pro-backend.js#L997), [`database`](pro-backend.js#L999), [`statement`](pro-backend.js#L1003), [`availability`](pro-backend.js#L1004), [`ready`](pro-backend.js#L1015).

[`active`](pro-backend.js#L1020), [`entitlement`](pro-backend.js#L1026), [`project`](pro-backend.js#L1030), [`authorize`](pro-backend.js#L1036), [`blockAccount`](pro-backend.js#L1046), [`input`](pro-backend.js#L1062), [`operation`](pro-backend.js#L1066), [`text`](pro-backend.js#L1071), [`mutate`](pro-backend.js#L1076), [`event`](pro-backend.js#L1106), [`handle`](pro-backend.js#L1109).


### `pro.js`

[`escapeHtml`](pro.js#L10), [`setProjectLabel`](pro.js#L16), [`collectSubtree`](pro.js#L24), [`deletionError`](pro.js#L36), [`currentUser`](pro.js#L71), [`getDB`](pro.js#L85), [`blobToBase64`](pro.js#L121), [`deleteAccountFiles`](pro.js#L140), [`saveExemplar`](pro.js#L159), [`hasExemplar`](pro.js#L195), [`getExemplar`](pro.js#L214), [`deleteExemplar`](pro.js#L261).

[`clearAll`](pro.js#L283), [`validDate`](pro.js#L305), [`addDate`](pro.js#L306), [`timezone`](pro.js#L307), [`parts`](pro.js#L308), [`time`](pro.js#L312), [`wall`](pro.js#L313), [`dayBounds`](pro.js#L318), [`boundary`](pro.js#L320), [`bounds`](pro.js#L324), [`interval`](pro.js#L328), [`validate`](pro.js#L339).

[`clock`](pro.js#L348), [`normalize`](pro.js#L357), [`migrate`](pro.js#L367), [`activeBreak`](pro.js#L378), [`active`](pro.js#L391), [`merge`](pro.js#L392), [`auth`](pro.js#L417), [`byId`](pro.js#L418), [`api`](pro.js#L425), [`status`](pro.js#L426), [`acceptMetadata`](pro.js#L440), [`clearReveal`](pro.js#L454).

[`legacyEntries`](pro.js#L459), [`parseSettings`](pro.js#L461), [`render`](pro.js#L481), [`selection`](pro.js#L516), [`refresh`](pro.js#L517), [`initialize`](pro.js#L523), [`generate`](pro.js#L549), [`updateDialog`](pro.js#L558), [`dialogMessage`](pro.js#L566), [`open`](pro.js#L576), [`action`](pro.js#L589), [`start`](pro.js#L590).

[`password`](pro.js#L594), [`googleAuthorizationUrl`](pro.js#L607), [`google`](pro.js#L619), [`confirm`](pro.js#L630), [`byId`](pro.js#L685), [`core`](pro.js#L747), [`settings`](pro.js#L748), [`getDayStartHour`](pro.js#L749), [`getLogicalDayBounds`](pro.js#L750), [`getAllBreakData`](pro.js#L756), [`getBreakRecord`](pro.js#L763), [`saveBreakRecord`](pro.js#L764).

[`getPlanningStatus`](pro.js#L777), [`startPlanningWindow`](pro.js#L793), [`lockTodayBreaks`](pro.js#L795), [`isSelectionWindowOpen`](pro.js#L796), [`getTodayBreaks`](pro.js#L797), [`getBreakTimestamps`](pro.js#L798), [`saveTodayBreaks`](pro.js#L799), [`getActiveBreak`](pro.js#L805), [`isCurrentlyOnBreak`](pro.js#L806), [`getState`](pro.js#L813), [`getCycleIdentifier`](pro.js#L845), [`isBypassActive`](pro.js#L854).

[`getRemainingWindowSeconds`](pro.js#L860), [`activateBypass`](pro.js#L867), [`selection`](pro.js#L877), [`validateFile`](pro.js#L878), [`fileToBase64`](pro.js#L909), [`callGeminiWithParts`](pro.js#L930), [`callGemini`](pro.js#L953), [`callGeminiTextOnly`](pro.js#L957), [`validateCriteria`](pro.js#L961), [`verifyProof`](pro.js#L1086), [`ProClient`](pro.js#L1154), [`defaultTokenProvider`](pro.js#L1162).

[`request`](pro.js#L1183), [`getStatus`](pro.js#L1222), [`checkConsecutiveEntitlement`](pro.js#L1234), [`activate`](pro.js#L1268), [`setUseByok`](pro.js#L1281), [`reviewProof`](pro.js#L1291), [`batchReview`](pro.js#L1325), [`prepareAudit`](pro.js#L1341), [`personalReview`](pro.js#L1358), [`emergencyRequest`](pro.js#L1371), [`emergencyStatus`](pro.js#L1384), [`activateBypass`](pro.js#L1387).

[`quotedReview`](pro.js#L1392), [`round1`](pro.js#L1411), [`round3`](pro.js#L1412), [`credits`](pro.js#L1413), [`batchConfirm`](pro.js#L1451), [`checkUsername`](pro.js#L1470), [`setUsername`](pro.js#L1480), [`getUsernameProfile`](pro.js#L1491), [`resolveUsername`](pro.js#L1498), [`getClient`](pro.js#L1532), [`escapeHtml`](pro.js#L1536), [`fileToBase64`](pro.js#L1545).

[`openBatchReviewModal`](pro.js#L1559), [`close`](pro.js#L1663), [`renderStagedFiles`](pro.js#L1716), [`updateSubmitState`](pro.js#L1734), [`renderBatchResults`](pro.js#L1772), [`renderProSection`](pro.js#L1836), [`bindProEvents`](pro.js#L1911), [`showMsg`](pro.js#L1960), [`refreshProStatus`](pro.js#L1974), [`autoInit`](pro.js#L2038), [`confirmReviewQuote`](pro.js#L2055), [`round1`](pro.js#L2068).

[`round3`](pro.js#L2069), [`getFocusableElements`](pro.js#L2157), [`handleKeydown`](pro.js#L2168), [`handleFocusIn`](pro.js#L2201), [`finish`](pro.js#L2209), [`cancelCurrent`](pro.js#L2230), [`button`](pro.js#L2266), [`owner`](pro.js#L2267), [`nameFor`](pro.js#L2268), [`paint`](pro.js#L2269), [`refresh`](pro.js#L2275), [`open`](pro.js#L2288).

[`close`](pro.js#L2321), [`initialize`](pro.js#L2352), [`userId`](pro.js#L2383), [`readCache`](pro.js#L2384), [`fromStatus`](pro.js#L2390), [`el`](pro.js#L2401), [`renderCard`](pro.js#L2407), [`apply`](pro.js#L2432), [`handle`](pro.js#L2439), [`restore`](pro.js#L2448), [`refresh`](pro.js#L2454).


### `pro/smart-study.js`

[`date`](pro/smart-study.js#L4), [`nextWeekend`](pro/smart-study.js#L5), [`normalize`](pro/smart-study.js#L9), [`decorate`](pro/smart-study.js#L20), [`apply`](pro/smart-study.js#L27), [`guard`](pro/smart-study.js#L45).


### `pro/study-plan.js`

[`dateOK`](pro/study-plan.js#L4), [`int`](pro/study-plan.js#L5), [`normalize`](pro/study-plan.js#L6), [`rows`](pro/study-plan.js#L17), [`coverage`](pro/study-plan.js#L20), [`build`](pro/study-plan.js#L21), [`defaultDays`](pro/study-plan.js#L26), [`node`](pro/study-plan.js#L29), [`open`](pro/study-plan.js#L31), [`button`](pro/study-plan.js#L38), [`run`](pro/study-plan.js#L39), [`field`](pro/study-plan.js#L40).

[`renderSmart`](pro/study-plan.js#L47), [`skipOptions`](pro/study-plan.js#L63), [`render`](pro/study-plan.js#L68).


### `settings.html`

[`fx`](settings.html#L654), [`notify`](settings.html#L655), [`ask`](settings.html#L660), [`setBusy`](settings.html#L664), [`replayClass`](settings.html#L670), [`done`](settings.html#L676), [`afterAnimation`](settings.html#L684), [`run`](settings.html#L686), [`flashButton`](settings.html#L695), [`setSaveBarVisible`](settings.html#L708), [`markUnsaved`](settings.html#L717), [`markSaved`](settings.html#L724).

[`getAppTodayStr`](settings.html#L730), [`placeTabIndicator`](settings.html#L774), [`activateTab`](settings.html#L784), [`initialTab`](settings.html#L832), [`formatDumpDuration`](settings.html#L853), [`renderTags`](settings.html#L863), [`handleAddTag`](settings.html#L893), [`renderPriorities`](settings.html#L923), [`move`](settings.html#L934), [`loadSettings`](settings.html#L1040), [`saveSettings`](settings.html#L1105), [`updateEmergencyDisplay`](settings.html#L1152).

[`updateBreakPlanningStatus`](settings.html#L1163), [`formatHour`](settings.html#L1168), [`updateWorkweekNotice`](settings.html#L1204), [`copyText`](settings.html#L1242), [`phoneChangeAllowed`](settings.html#L1285), [`effectiveDue`](settings.html#L1291), [`setPhoneStatus`](settings.html#L1313), [`refreshPhoneStatus`](settings.html#L1322), [`showImportFeedback`](settings.html#L1378), [`syncImportButtons`](settings.html#L1387), [`processImport`](settings.html#L1439).


### `sleep.html`

[`showDelay`](sleep.html#L21), [`values`](sleep.html#L22), [`dirty`](sleep.html#L23), [`controls`](sleep.html#L24), [`run`](sleep.html#L25), [`load`](sleep.html#L26).


### `sw.js`

No named function declarations indexed. Behavior is in markup, configuration, or anonymous event/initialization handlers described in the file guide.


### `tutorial-integration.js`

[`sleep`](tutorial-integration.js#L4), [`owner`](tutorial-integration.js#L5), [`onIndex`](tutorial-integration.js#L6), [`onSettings`](tutorial-integration.js#L7), [`state`](tutorial-integration.js#L10), [`progress`](tutorial-integration.js#L11), [`mark`](tutorial-integration.js#L12), [`tab`](tutorial-integration.js#L21), [`currentTab`](tutorial-integration.js#L26), [`tierName`](tutorial-integration.js#L27), [`uniTabBtn`](tutorial-integration.js#L102), [`uniTab`](tutorial-integration.js#L103).

[`uniCurrentTab`](tutorial-integration.js#L108), [`universeSteps`](tutorial-integration.js#L116), [`run`](tutorial-integration.js#L150), [`start`](tutorial-integration.js#L164), [`attempt`](tutorial-integration.js#L169), [`launch`](tutorial-integration.js#L171), [`renderHub`](tutorial-integration.js#L180), [`openUniverse`](tutorial-integration.js#L207), [`proActivated`](tutorial-integration.js#L224), [`init`](tutorial-integration.js#L227).


### `tutorial-spotlight.js`

[`reduced`](tutorial-spotlight.js#L10), [`visible`](tutorial-spotlight.js#L11), [`sleep`](tutorial-spotlight.js#L12), [`el`](tutorial-spotlight.js#L14), [`rich`](tutorial-spotlight.js#L21), [`findTarget`](tutorial-spotlight.js#L30), [`buildVisual`](tutorial-spotlight.js#L39), [`start`](tutorial-spotlight.js#L70), [`finish`](tutorial-spotlight.js#L88), [`render`](tutorial-spotlight.js#L98), [`place`](tutorial-spotlight.js#L130), [`onMove`](tutorial-spotlight.js#L174).

[`show`](tutorial-spotlight.js#L180), [`safe`](tutorial-spotlight.js#L199), [`go`](tutorial-spotlight.js#L200), [`onKey`](tutorial-spotlight.js#L205).


### `uni/focus-timer.js`

[`fresh`](uni/focus-timer.js#L4), [`valid`](uni/focus-timer.js#L5), [`advance`](uni/focus-timer.js#L6), [`user`](uni/focus-timer.js#L17), [`read`](uni/focus-timer.js#L18), [`ask`](uni/focus-timer.js#L19), [`el`](uni/focus-timer.js#L20), [`save`](uni/focus-timer.js#L21), [`exclusive`](uni/focus-timer.js#L22), [`run`](uni/focus-timer.js#L22), [`unlockAudio`](uni/focus-timer.js#L23), [`notify`](uni/focus-timer.js#L24).

[`screen`](uni/focus-timer.js#L27), [`render`](uni/focus-timer.js#L32), [`tick`](uni/focus-timer.js#L38), [`action`](uni/focus-timer.js#L39), [`mount`](uni/focus-timer.js#L40), [`button`](uni/focus-timer.js#L50).


### `uni/setup.html`

No named function declarations indexed. Behavior is in markup, configuration, or anonymous event/initialization handlers described in the file guide.


### `uni/universe-ai.js`

[`error`](uni/universe-ai.js#L3), [`creditUnits`](uni/universe-ai.js#L12), [`integer`](uni/universe-ai.js#L13), [`UniverseAI`](uni/universe-ai.js#L14), [`phase4`](uni/universe-ai.js#L15), [`configuration`](uni/universe-ai.js#L16), [`availability`](uni/universe-ai.js#L27), [`taskData`](uni/universe-ai.js#L31), [`credentials`](uni/universe-ai.js#L37), [`context`](uni/universe-ai.js#L43), [`payload`](uni/universe-ai.js#L53), [`provider`](uni/universe-ai.js#L69).

[`totals`](uni/universe-ai.js#L74), [`publicReview`](uni/universe-ai.js#L76), [`handle`](uni/universe-ai.js#L77), [`quote`](uni/universe-ai.js#L107), [`approve`](uni/universe-ai.js#L126), [`settle`](uni/universe-ai.js#L169), [`cleanup`](uni/universe-ai.js#L188), [`read`](uni/universe-ai.js#L195).


### `uni/universe-archive.js`

[`crc`](uni/universe-archive.js#L5), [`safe`](uni/universe-archive.js#L6), [`zip`](uni/universe-archive.js#L7), [`unzip`](uni/universe-archive.js#L12), [`hash`](uni/universe-archive.js#L22), [`base64`](uni/universe-archive.js#L23), [`decode`](uni/universe-archive.js#L24).


### `uni/universe-membership.js`

[`error`](uni/universe-membership.js#L2), [`UniverseMembership`](uni/universe-membership.js#L4), [`phase2`](uni/universe-membership.js#L5), [`availability`](uni/universe-membership.js#L6), [`lifecycle`](uni/universe-membership.js#L7), [`state`](uni/universe-membership.js#L18), [`authorize`](uni/universe-membership.js#L19), [`writable`](uni/universe-membership.js#L25), [`guard`](uni/universe-membership.js#L26), [`change`](uni/universe-membership.js#L31), [`handle`](uni/universe-membership.js#L54), [`blockAccount`](uni/universe-membership.js#L73).

[`cleanup`](uni/universe-membership.js#L78).


### `uni/universe-release-ui.js`

[`el`](uni/universe-release-ui.js#L2), [`ask`](uni/universe-release-ui.js#L3), [`askText`](uni/universe-release-ui.js#L4), [`download`](uni/universe-release-ui.js#L5), [`active`](uni/universe-release-ui.js#L8), [`button`](uni/universe-release-ui.js#L10), [`toast`](uni/universe-release-ui.js#L11), [`field`](uni/universe-release-ui.js#L12), [`loadPhone`](uni/universe-release-ui.js#L17), [`commentEditor`](uni/universe-release-ui.js#L26), [`load`](uni/universe-release-ui.js#L27), [`button`](uni/universe-release-ui.js#L48).


### `uni/universe-release.js`

[`err`](uni/universe-release.js#L4), [`uid`](uni/universe-release.js#L5), [`bytesHash`](uni/universe-release.js#L6), [`encode`](uni/universe-release.js#L7), [`decode`](uni/universe-release.js#L8), [`UniverseRelease`](uni/universe-release.js#L9), [`phase5`](uni/universe-release.js#L10), [`availability`](uni/universe-release.js#L11), [`epoch`](uni/universe-release.js#L12), [`lockStatus`](uni/universe-release.js#L13), [`handle`](uni/universe-release.js#L25), [`recordLock`](uni/universe-release.js#L70).

[`comments`](uni/universe-release.js#L71), [`commentWrite`](uni/universe-release.js#L76), [`transfer`](uni/universe-release.js#L85), [`manifest`](uni/universe-release.js#L86), [`exportRoute`](uni/universe-release.js#L87), [`exportRead`](uni/universe-release.js#L104), [`exportFile`](uni/universe-release.js#L105), [`importRoute`](uni/universe-release.js#L109), [`validateManifest`](uni/universe-release.js#L128), [`cleanup`](uni/universe-release.js#L139).


### `uni/universe-rules.js`

[`error`](uni/universe-rules.js#L4), [`uid`](uni/universe-rules.js#L5), [`manager`](uni/universe-rules.js#L6), [`equal`](uni/universe-rules.js#L7), [`completionMet`](uni/universe-rules.js#L9), [`UniverseRules`](uni/universe-rules.js#L17), [`phase67`](uni/universe-rules.js#L18), [`phase9`](uni/universe-rules.js#L19), [`availability`](uni/universe-rules.js#L20), [`state`](uni/universe-rules.js#L21), [`writable`](uni/universe-rules.js#L22), [`expireSolo`](uni/universe-rules.js#L23).

[`authorize`](uni/universe-rules.js#L29), [`guard`](uni/universe-rules.js#L33), [`profile`](uni/universe-rules.js#L34), [`task`](uni/universe-rules.js#L35), [`reviewer`](uni/universe-rules.js#L41), [`context`](uni/universe-rules.js#L42), [`options`](uni/universe-rules.js#L45), [`rows`](uni/universe-rules.js#L46), [`ancestors`](uni/universe-rules.js#L47), [`assignments`](uni/universe-rules.js#L48), [`finished`](uni/universe-rules.js#L49), [`requirements`](uni/universe-rules.js#L50).

[`submissionOpen`](uni/universe-rules.js#L51), [`assertMembers`](uni/universe-rules.js#L52), [`settings`](uni/universe-rules.js#L53), [`normalized`](uni/universe-rules.js#L54), [`jsonInsertStatements`](uni/universe-rules.js#L80), [`flush`](uni/universe-rules.js#L84), [`overwriteManifest`](uni/universe-rules.js#L88), [`overwriteImportRoute`](uni/universe-rules.js#L109), [`handle`](uni/universe-rules.js#L165), [`requireOwnerPro`](uni/universe-rules.js#L190), [`validateCriteria`](uni/universe-rules.js#L191), [`work`](uni/universe-rules.js#L201).

[`taskWrite`](uni/universe-rules.js#L226), [`assignmentWrite`](uni/universe-rules.js#L257), [`read`](uni/universe-rules.js#L286), [`settle`](uni/universe-rules.js#L301), [`lockStatus`](uni/universe-rules.js#L305), [`catalog`](uni/universe-rules.js#L313), [`exportMetadata`](uni/universe-rules.js#L314), [`cleanup`](uni/universe-rules.js#L315).


### `uni/universe-shell.js`

[`el`](uni/universe-shell.js#L2), [`link`](uni/universe-shell.js#L3), [`button`](uni/universe-shell.js#L4), [`icon`](uni/universe-shell.js#L5), [`dirty`](uni/universe-shell.js#L6), [`key`](uni/universe-shell.js#L13), [`connection`](uni/universe-shell.js#L17), [`canLeave`](uni/universe-shell.js#L18), [`reset`](uni/universe-shell.js#L19), [`create`](uni/universe-shell.js#L20), [`place`](uni/universe-shell.js#L28), [`show`](uni/universe-shell.js#L32).


### `uni/universe-tasks-ui.js`

[`ask`](uni/universe-tasks-ui.js#L2), [`node`](uni/universe-tasks-ui.js#L3), [`date`](uni/universe-tasks-ui.js#L4), [`active`](uni/universe-tasks-ui.js#L7), [`api`](uni/universe-tasks-ui.js#L8), [`button`](uni/universe-tasks-ui.js#L10), [`toast`](uni/universe-tasks-ui.js#L11), [`chevron`](uni/universe-tasks-ui.js#L12), [`stepper`](uni/universe-tasks-ui.js#L14), [`input`](uni/universe-tasks-ui.js#L15), [`select`](uni/universe-tasks-ui.js#L16), [`download`](uni/universe-tasks-ui.js#L17).

[`upload`](uni/universe-tasks-ui.js#L20), [`properties`](uni/universe-tasks-ui.js#L31), [`editor`](uni/universe-tasks-ui.js#L39), [`lateView`](uni/universe-tasks-ui.js#L49), [`priorities`](uni/universe-tasks-ui.js#L51), [`projectMembers`](uni/universe-tasks-ui.js#L55), [`ruleView`](uni/universe-tasks-ui.js#L59), [`auditView`](uni/universe-tasks-ui.js#L61), [`section`](uni/universe-tasks-ui.js#L62), [`wrap`](uni/universe-tasks-ui.js#L63), [`markDirty`](uni/universe-tasks-ui.js#L72), [`showDirty`](uni/universe-tasks-ui.js#L72).

[`unload`](uni/universe-tasks-ui.js#L72), [`assignment`](uni/universe-tasks-ui.js#L79), [`change`](uni/universe-tasks-ui.js#L113), [`list`](uni/universe-tasks-ui.js#L120), [`badges`](uni/universe-tasks-ui.js#L121), [`renderTask`](uni/universe-tasks-ui.js#L124), [`metaChip`](uni/universe-tasks-ui.js#L130), [`openDetail`](uni/universe-tasks-ui.js#L135), [`myDone`](uni/universe-tasks-ui.js#L140), [`effectiveDue`](uni/universe-tasks-ui.js#L141), [`dayOf`](uni/universe-tasks-ui.js#L142), [`bucket`](uni/universe-tasks-ui.js#L143).

[`filter`](uni/universe-tasks-ui.js#L150), [`drawProject`](uni/universe-tasks-ui.js#L160), [`items`](uni/universe-tasks-ui.js#L164), [`move`](uni/universe-tasks-ui.js#L164), [`create`](uni/universe-tasks-ui.js#L166).


### `uni/universe-tasks.js`

[`err`](uni/universe-tasks.js#L4), [`uuid`](uni/universe-tasks.js#L7), [`UniverseTasks`](uni/universe-tasks.js#L8), [`phase3`](uni/universe-tasks.js#L9), [`availability`](uni/universe-tasks.js#L10), [`record`](uni/universe-tasks.js#L11), [`task`](uni/universe-tasks.js#L12), [`access`](uni/universe-tasks.js#L13), [`manager`](uni/universe-tasks.js#L14), [`reviewer`](uni/universe-tasks.js#L15), [`submitter`](uni/universe-tasks.js#L16), [`checkRevision`](uni/universe-tasks.js#L17).

[`bucket`](uni/universe-tasks.js#L18), [`commit`](uni/universe-tasks.js#L19), [`replay`](uni/universe-tasks.js#L24), [`taskData`](uni/universe-tasks.js#L31), [`handle`](uni/universe-tasks.js#L43), [`read`](uni/universe-tasks.js#L135), [`cleanup`](uni/universe-tasks.js#L153).


### `uni/universe-ui.js`

[`ask`](uni/universe-ui.js#L2), [`actor`](uni/universe-ui.js#L6), [`node`](uni/universe-ui.js#L7), [`api`](uni/universe-ui.js#L10), [`send`](uni/universe-ui.js#L11), [`run`](uni/universe-ui.js#L13), [`clearSkeleton`](uni/universe-ui.js#L14), [`toast`](uni/universe-ui.js#L15), [`button`](uni/universe-ui.js#L16), [`field`](uni/universe-ui.js#L17), [`form`](uni/universe-ui.js#L18), [`start`](uni/universe-ui.js#L19).

[`list`](uni/universe-ui.js#L20), [`render`](uni/universe-ui.js#L26), [`detail`](uni/universe-ui.js#L40), [`current`](uni/universe-ui.js#L42), [`clearSkeleton`](uni/universe-ui.js#L44), [`section`](uni/universe-ui.js#L47), [`note`](uni/universe-ui.js#L48), [`feature`](uni/universe-ui.js#L49), [`load`](uni/universe-ui.js#L49), [`change`](uni/universe-ui.js#L50), [`copy`](uni/universe-ui.js#L63).


### `uni/universe-widgets.js`

[`element`](uni/universe-widgets.js#L5), [`focusable`](uni/universe-widgets.js#L6), [`layer`](uni/universe-widgets.js#L8), [`updateViewport`](uni/universe-widgets.js#L13), [`release`](uni/universe-widgets.js#L23), [`requestClose`](uni/universe-widgets.js#L35), [`key`](uni/universe-widgets.js#L40), [`focus`](uni/universe-widgets.js#L50), [`toast`](uni/universe-widgets.js#L59), [`skeleton`](uni/universe-widgets.js#L74), [`pressFeedback`](uni/universe-widgets.js#L80), [`settle`](uni/universe-widgets.js#L83).

[`errorMessage`](uni/universe-widgets.js#L92).


### `worker.js`

[`copy`](worker.js#L16), [`validDate`](worker.js#L17), [`dateMs`](worker.js#L21), [`dateString`](worker.js#L22), [`today`](worker.js#L23), [`schedule`](worker.js#L26), [`nextDate`](worker.js#L41), [`subtree`](worker.js#L69), [`seriesFor`](worker.js#L75), [`canStart`](worker.js#L78), [`cleanNode`](worker.js#L89), [`start`](worker.js#L94).

[`updateNode`](worker.js#L123), [`validateState`](worker.js#L129), [`reconcile`](worker.js#L155), [`depth`](worker.js#L173), [`idFor`](worker.js#L204), [`validDate`](worker.js#L231), [`addDate`](worker.js#L232), [`timezone`](worker.js#L233), [`parts`](worker.js#L234), [`time`](worker.js#L238), [`wall`](worker.js#L239), [`dayBounds`](worker.js#L244).

[`boundary`](worker.js#L246), [`bounds`](worker.js#L250), [`interval`](worker.js#L254), [`validate`](worker.js#L265), [`clock`](worker.js#L274), [`normalize`](worker.js#L283), [`migrate`](worker.js#L293), [`activeBreak`](worker.js#L304), [`active`](worker.js#L317), [`merge`](worker.js#L318), [`SecurityError`](worker.js#L343), [`allowedOrigins`](worker.js#L346).

[`decodeAuthB64`](worker.js#L348), [`sha256`](worker.js#L352), [`randomPhoneToken`](worker.js#L354), [`clerkAPI`](worker.js#L358), [`verifySession`](worker.js#L372), [`verifiedEmail`](worker.js#L412), [`providerId`](worker.js#L426), [`randomSecret`](worker.js#L433), [`base64url`](worker.js#L434), [`decodeVerifyB64`](worker.js#L435), [`verifyGoogleToken`](worker.js#L436), [`ActionVerification`](worker.js#L463).

[`get`](worker.js#L465), [`start`](worker.js#L474), [`password`](worker.js#L518), [`callback`](worker.js#L550), [`accountKey`](worker.js#L595), [`AccountDeletion`](worker.js#L596), [`marker`](worker.js#L598), [`status`](worker.js#L599), [`accept`](worker.js#L608), [`page`](worker.js#L659), [`legacy`](worker.js#L666), [`deleteClerk`](worker.js#L692).

[`run`](worker.js#L697), [`scrubSettings`](worker.js#L758), [`encodeVaultB64`](worker.js#L761), [`decodeVaultB64`](worker.js#L762), [`validId`](worker.js#L763), [`KeyVault`](worker.js#L764), [`configuration`](worker.js#L766), [`ready`](worker.js#L774), [`cryptoKey`](worker.js#L775), [`prefix`](worker.js#L783), [`recordKey`](worker.js#L784), [`stagePrefix`](worker.js#L785).

[`validateKey`](worker.js#L786), [`recoveredKey`](worker.js#L792), [`aad`](worker.js#L798), [`seal`](worker.js#L799), [`unseal`](worker.js#L806), [`assertOwner`](worker.js#L814), [`providerMetadata`](worker.js#L820), [`selectedProvider`](worker.js#L828), [`metadata`](worker.js#L833), [`select`](worker.js#L840), [`recoverClaudeArchives`](worker.js#L853), [`stage`](worker.js#L870).

[`context`](worker.js#L888), [`takeProof`](worker.js#L897), [`reveal`](worker.js#L911), [`testKey`](worker.js#L923), [`save`](worker.js#L939), [`remove`](worker.js#L958), [`testSaved`](worker.js#L968), [`cleanupLegacy`](worker.js#L974), [`validatePayload`](worker.js#L1007), [`inspect`](worker.js#L1016), [`jsonSchema`](worker.js#L1045), [`translateSchema`](worker.js#L1052).

[`toClaudeRequest`](worker.js#L1063), [`add`](worker.js#L1065), [`fromClaudeResponse`](worker.js#L1125), [`validateOutput`](worker.js#L1142), [`responseJSON`](worker.js#L1153), [`AIGateway`](worker.js#L1162), [`generate`](worker.js#L1164), [`object`](worker.js#L1222), [`json`](worker.js#L1223), [`HTTPError`](worker.js#L1226), [`dayHour`](worker.js#L1229), [`logicalDate`](worker.js#L1233).

[`validDate`](worker.js#L1236), [`timestamp`](worker.js#L1240), [`evaluateStatus`](worker.js#L1245), [`effectiveDue`](worker.js#L1254), [`sleepWindow`](worker.js#L1277), [`valid`](worker.js#L1278), [`minutes`](worker.js#L1280), [`sleepLockActive`](worker.js#L1286), [`publicRecord`](worker.js#L1291), [`tokenKey`](worker.js#L1309), [`chunkKey`](worker.js#L1310), [`cleanToken`](worker.js#L1312).

[`readJson`](worker.js#L1314), [`validateUser`](worker.js#L1340), [`validateVersion`](worker.js#L1346), [`validateSnapshot`](worker.js#L1352), [`loadSnapshot`](worker.js#L1373), [`saveSnapshot`](worker.js#L1388), [`conflict`](worker.js#L1404), [`fetch`](worker.js#L1410), [`TaskitatorSync`](worker.js#L1430), [`readTaskSnapshot`](worker.js#L1444), [`writeTaskSnapshot`](worker.js#L1448), [`migrateVault`](worker.js#L1457).

[`importAccount`](worker.js#L1493), [`rateLimit`](worker.js#L1543), [`rateBucket`](worker.js#L1548), [`ensureAlarm`](worker.js#L1560), [`alarm`](worker.js#L1566), [`accountFor`](worker.js#L1596), [`connectAccount`](worker.js#L1611), [`phoneAccess`](worker.js#L1670), [`fetch`](worker.js#L1692).


### D1 table and trigger declarations

Version/guard tables are part of the execution contract. A failed guard constraint aborts a batch; it is not equivalent to a successful zero-row mutation. Foreign keys and triggers complement the JavaScript checks.


#### `uni/universe-phase2.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase2`](uni/universe-phase2.sql#L1) | table | See declaration for constraints and use. |
| [`universe_lifecycle`](uni/universe-phase2.sql#L2) | table | `universe_accounts` |
| [`universe_group_state`](uni/universe-phase2.sql#L3) | table | `universe_groups` |
| [`universe_cleanup`](uni/universe-phase2.sql#L4) | table | `universe_groups` |
| [`universe_write_guard`](uni/universe-phase2.sql#L5) | table | See declaration for constraints and use. |
| [`universe_deleted_permanent`](uni/universe-phase2.sql#L6) | trigger | `universe_group_state` |
| [`universe_invite_lifecycle`](uni/universe-phase2.sql#L7) | trigger | `universe_invitations` |
| [`universe_join_lifecycle`](uni/universe-phase2.sql#L12) | trigger | `universe_members` |
| [`universe_lapse_initial`](uni/universe-phase2.sql#L17) | trigger | `universe_lifecycle` |
| [`universe_lapse_change`](uni/universe-phase2.sql#L20) | trigger | `universe_lifecycle` |

#### `uni/universe-phase3.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase3`](uni/universe-phase3.sql#L2) | table | See declaration for constraints and use. |
| [`universe_projects`](uni/universe-phase3.sql#L3) | table | `universe_groups` |
| [`universe_projects_group`](uni/universe-phase3.sql#L4) | index | `universe_projects` |
| [`universe_tasks`](uni/universe-phase3.sql#L5) | table | `universe_groups`, `universe_projects` |
| [`universe_tasks_group`](uni/universe-phase3.sql#L6) | index | `universe_tasks` |
| [`universe_assignments`](uni/universe-phase3.sql#L7) | table | `universe_groups`, `universe_tasks` |
| [`universe_assignments_task`](uni/universe-phase3.sql#L8) | index | `universe_assignments` |
| [`universe_submissions`](uni/universe-phase3.sql#L9) | table | `universe_assignments` |
| [`universe_submissions_assignment`](uni/universe-phase3.sql#L10) | index | `universe_submissions` |
| [`universe_files`](uni/universe-phase3.sql#L11) | table | See declaration for constraints and use. |
| [`universe_files_cleanup`](uni/universe-phase3.sql#L12) | index | `universe_files` |

#### `uni/universe-phase4.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase4`](uni/universe-phase4.sql#L2) | table | See declaration for constraints and use. |
| [`universe_ai_reviews`](uni/universe-phase4.sql#L3) | table | See declaration for constraints and use. |
| [`universe_ai_balance`](uni/universe-phase4.sql#L15) | index | `universe_ai_reviews` |
| [`universe_ai_submission`](uni/universe-phase4.sql#L16) | index | `universe_ai_reviews` |
| [`universe_ai_attestations`](uni/universe-phase4.sql#L18) | table | See declaration for constraints and use. |
| [`universe_ai_budget_guard`](uni/universe-phase4.sql#L22) | table | See declaration for constraints and use. |
| [`universe_ai_safety`](uni/universe-phase4.sql#L23) | table | See declaration for constraints and use. |
| [`universe_member_epochs`](uni/universe-phase4.sql#L25) | table | See declaration for constraints and use. |
| [`universe_ai_member_join`](uni/universe-phase4.sql#L27) | trigger | `universe_members` |
| [`universe_ai_member_depart`](uni/universe-phase4.sql#L30) | trigger | `universe_members` |

#### `uni/universe-phase5.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase5`](uni/universe-phase5.sql#L2) | table | See declaration for constraints and use. |
| [`universe_lock_consent`](uni/universe-phase5.sql#L3) | table | See declaration for constraints and use. |
| [`universe_lock_eligibility`](uni/universe-phase5.sql#L4) | table | See declaration for constraints and use. |
| [`universe_lock_group`](uni/universe-phase5.sql#L5) | index | `universe_lock_eligibility` |
| [`universe_comments`](uni/universe-phase5.sql#L6) | table | See declaration for constraints and use. |
| [`universe_comments_page`](uni/universe-phase5.sql#L7) | index | `universe_comments` |
| [`universe_export_permissions`](uni/universe-phase5.sql#L8) | table | See declaration for constraints and use. |
| [`universe_transfers`](uni/universe-phase5.sql#L9) | table | See declaration for constraints and use. |
| [`universe_transfers_cleanup`](uni/universe-phase5.sql#L10) | index | `universe_transfers` |
| [`universe_transfer_files`](uni/universe-phase5.sql#L11) | table | See declaration for constraints and use. |
| [`universe_consent_depart`](uni/universe-phase5.sql#L12) | trigger | `universe_members` |

#### `uni/universe-phase6-7.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase6`](uni/universe-phase6-7.sql#L3) | table | See declaration for constraints and use. |
| [`universe_phase7`](uni/universe-phase6-7.sql#L4) | table | See declaration for constraints and use. |
| [`universe_solo`](uni/universe-phase6-7.sql#L5) | table | See declaration for constraints and use. |
| [`universe_settings`](uni/universe-phase6-7.sql#L6) | table | See declaration for constraints and use. |
| [`universe_project_options`](uni/universe-phase6-7.sql#L7) | table | See declaration for constraints and use. |
| [`universe_catalog`](uni/universe-phase6-7.sql#L8) | table | See declaration for constraints and use. |
| [`universe_profiles`](uni/universe-phase6-7.sql#L9) | table | See declaration for constraints and use. |
| [`universe_criteria_checks`](uni/universe-phase6-7.sql#L10) | table | See declaration for constraints and use. |
| [`universe_task_state`](uni/universe-phase6-7.sql#L11) | table | See declaration for constraints and use. |
| [`universe_tree`](uni/universe-phase6-7.sql#L12) | index | `universe_task_state` |
| [`universe_solo_create`](uni/universe-phase6-7.sql#L15) | trigger | `universe_groups` |
| [`universe_solo_join`](uni/universe-phase6-7.sql#L16) | trigger | `universe_members` |
| [`universe_solo_depart`](uni/universe-phase6-7.sql#L17) | trigger | `universe_members` |
| [`universe_assignment_depart`](uni/universe-phase6-7.sql#L24) | trigger | `universe_members` |
| [`universe_default_priorities`](uni/universe-phase6-7.sql#L28) | trigger | `universe_groups` |
| [`universe_catalog_styles`](uni/universe-phase6-7.sql#L31) | table | See declaration for constraints and use. |

#### `uni/universe-phase9.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_phase9`](uni/universe-phase9.sql#L5) | table | See declaration for constraints and use. |
| [`universe_catalog_styles`](uni/universe-phase9.sql#L6) | table | See declaration for constraints and use. |
| [`universe_owner_transfer_guard`](uni/universe-phase9.sql#L14) | trigger | `universe_groups` |
| [`universe_member_owner_update`](uni/universe-phase9.sql#L36) | trigger | `universe_members` |
| [`universe_member_owner_delete`](uni/universe-phase9.sql#L46) | trigger | `universe_members` |

#### `uni/universe-schema.sql`

| Declaration | Kind | Referenced tables / trigger target |
| --- | --- | --- |
| [`universe_schema`](uni/universe-schema.sql#L3) | table | See declaration for constraints and use. |
| [`universe_phase9`](uni/universe-schema.sql#L5) | table | See declaration for constraints and use. |
| [`universe_accounts`](uni/universe-schema.sql#L6) | table | See declaration for constraints and use. |
| [`universe_account_no_unblock`](uni/universe-schema.sql#L10) | trigger | `universe_accounts` |
| [`universe_groups`](uni/universe-schema.sql#L12) | table | `universe_accounts` |
| [`universe_members`](uni/universe-schema.sql#L17) | table | `universe_accounts`, `universe_groups` |
| [`universe_members_account`](uni/universe-schema.sql#L22) | index | `universe_members` |
| [`universe_groups_owner`](uni/universe-schema.sql#L23) | index | `universe_groups` |
| [`universe_reservations`](uni/universe-schema.sql#L24) | table | `universe_accounts` |
| [`universe_reservations_account`](uni/universe-schema.sql#L28) | index | `universe_reservations` |
| [`universe_invitations`](uni/universe-schema.sql#L29) | table | `universe_accounts`, `universe_groups` |
| [`universe_invites_group`](uni/universe-schema.sql#L35) | index | `universe_invitations` |
| [`universe_operations`](uni/universe-schema.sql#L36) | table | `universe_accounts` |
| [`universe_guard`](uni/universe-schema.sql#L43) | table | See declaration for constraints and use. |
| [`universe_events`](uni/universe-schema.sql#L46) | table | `universe_groups` |
| [`universe_owner_immutable`](uni/universe-schema.sql#L51) | trigger | `universe_groups` |
| [`universe_create_guard`](uni/universe-schema.sql#L54) | trigger | `universe_groups` |
| [`universe_owner_membership`](uni/universe-schema.sql#L61) | trigger | `universe_groups` |
| [`universe_member_guard`](uni/universe-schema.sql#L64) | trigger | `universe_members` |
| [`universe_member_owner_update`](uni/universe-schema.sql#L75) | trigger | `universe_members` |
| [`universe_member_owner_delete`](uni/universe-schema.sql#L78) | trigger | `universe_members` |
| [`universe_reservation_guard`](uni/universe-schema.sql#L80) | trigger | `universe_reservations` |
| [`universe_invite_guard`](uni/universe-schema.sql#L89) | trigger | `universe_invitations` |
| [`universe_accept_guard`](uni/universe-schema.sql#L96) | trigger | `universe_invitations` |
| [`universe_accept_member`](uni/universe-schema.sql#L105) | trigger | `universe_invitations` |
| [`universe_operation_guard`](uni/universe-schema.sql#L108) | trigger | `universe_operations` |

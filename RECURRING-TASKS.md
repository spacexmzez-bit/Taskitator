# Recurring tasks: how this update works

## The central rule

There is only one unfinished occurrence of a recurring branch. Missing its due date does not produce another occurrence. The next occurrence appears after the current one is completed or permissibly deleted.

A recurrence belongs to the chosen task and its descendants. It does not repeat ancestors or siblings. For example, a static Root can contain recurring A and one-time B. Completing A replaces A, x, y, and z beneath the same Root. B, alpha, and beta are untouched. Completing a child of A does not independently repeat that child.

Retired occurrence branches leave the active task collection. History keeps summaries rather than adding old branches to the live tree. Current and retired branches are never connected into an ever-growing hierarchy.

## Schedules

- Daily: the next eligible day.
- Selected weekdays: the next selected day strictly after the finished occurrence and its completion/deletion day.
- Monthly: the day number of the starting date, every month.
- Date of month: explicitly choose a day from 1 to 31, independently of the starting date.
- Every six months: six-month steps anchored to the start date.
- Yearly: annual steps anchored to the start date.

Each series has a required start date and optional end date. If a date does not exist in a month, the last day is used. The original day remains the anchor: January 31 becomes February 28, then March 31. February 29 returns in later leap years.

Missed slots are skipped. A Monday/Thursday task completed on Friday creates its next occurrence for Monday. A daily occurrence completed three days late produces the next eligible day, not three catch-up tasks. Early completion does not create an occurrence before the current scheduled date. The end date is inclusive.

Recurrence uses Riyadh UTC+3 and the account's configured day-start hour, matching the Worker. The new occurrence is created immediately after retirement, with its future due date; creation does not wait for that future day to arrive. There is no repeating server timer, cron schedule, or alarm required for this feature.

## Create a repeating task

1. Open Today or General Tasks and tap the new-task button.
2. Fill in the usual title, project, and other details. Use AI Proof and validated criteria if needed.
3. Find Recurrence in the form. Choose a schedule, start date, optional end date, and any weekdays or day number.
4. Save the task. Its descendants follow that branch's recurrence.

You can instead open an existing active task's details, choose Set up recurrence, configure the schedule, then choose Start repeating this branch. The first due date is the earliest eligible date on or after the selected start. Choosing a past start can create one overdue current occurrence, but never a backlog of occurrences.

An independently recurring task cannot be placed inside another recurring branch. Children of A follow A's schedule. A recurring child cannot be moved out of its branch through the ordinary detail editor; the branch root can move beneath an eligible static parent. A static container holding a recurring branch cannot be moved beneath a different recurring branch.

## What gets copied

The future template includes the task titles, descriptions, tags, priorities, project, hierarchy, shields, bonus flags, AI-lock state, proof criteria, and reference files. Newly added children join the recurring branch. Every replacement receives new IDs and cleared completion/model fields.

Dated child tasks keep their relative date offsets. Undated children and children using the special today value receive the new branch's due date, so they do not accidentally make a future occurrence due immediately. Child dates can still differ if they were explicitly set with an offset.

Reference files are stored in shared recurrence metadata instead of repeatedly duplicating the same file for each cycle. This metadata follows cloud sync and backup. Large references can still exhaust a browser's local storage or exceed the existing 20 MiB cloud request ceiling; use small, readable files. The existing audit uploader accepts files up to 5 MB, but that does not promise unlimited backup/storage capacity.

## Completion and deletion

- Complete recurring tasks from Today, General Tasks, or the Projects workspace through the main task handler.
- Regular task completion retains the existing ten-second Undo opportunity. Renewal waits until that window ends. If the browser closes, the Worker can finish renewal when a later pull or status request sees the expired window.
- AI-checked occurrences require their own fresh evidence. The repeated-service-outage auto-completion shortcut is disabled for recurring tasks.
- A parent cannot silently complete an unfinished AI-audited descendant. Finish its proof first, even when the parent has no prerequisite shield.
- Existing shields and deletion restrictions remain active. Deleting AI-locked work still requires emergency bypass.
- Permissibly deleting the branch root advances to the next occurrence and records a deleted outcome rather than awarding completion.
- Deleting one child affects the current occurrence; its template remains available for the next branch. To change the future branch's scope, stop the series and establish the intended replacement branch after finishing the current commitment.
- Completing or removing a static ancestor stops future recurrence beneath it. Existing commitment restrictions can prevent that ancestor from being completed until its protected children are resolved.

Completed/deleted occurrence summaries appear in Recurring tasks & history in the navigation menu. The latest 500 summaries are kept. Completed occurrence summaries are also included in Statistics. The separate existing completion ledger retains its own 200-event limit. History is read-only; retired occurrences cannot be reopened into duplicate active branches. Normal task completions remain governed by the app's existing reopening rules.

## Editing

A recurring task's details include Apply ordinary task edits to:

- This occurrence: editable fields change only on the current occurrence.
- This and future occurrences: the permitted editable fields also update the recurring template.

Existing AI title/due-date/lock protections still apply to the current task. Ordinary field editing does not overwrite separately validated future-only criteria. Due-date edits in the ordinary detail form affect only the current occurrence; future dates follow the configured schedule. Schedule changes are saved through Recurrence & future criteria and apply to later occurrences, leaving the current due date unchanged.

For AI-checked tasks, use Recurrence & future criteria to edit the future proof requirement. Fill all placeholders with concrete values. Validate & save future criteria always performs a new AI validation and requires a passing score of at least 7/10, even when general strict validation is disabled. A failed validation preserves the previous template. The current proof criteria are unchanged.

You can replace or remove a future reference through the same panel; it participates in the new validation. The current occurrence retains its own reference. References for future criteria should be explicitly described in those criteria.

## Stop and resume

Stop future repetition disables the next occurrence. It never removes the current occurrence or waives its evidence requirement. Finish or permissibly delete that current task normally. You can resume future repetition while a current occurrence remains active. Once the branch has been retired with no replacement, establish a new series to restart it.

## Sync and backup

The existing change-triggered two-minute sync window remains unchanged. Sync Now sends changes immediately. The Worker performs the same deterministic renewal in a transaction and uses snapshot versions to reject conflicting writes from two devices. Retry operations do not produce duplicate occurrences.

Cloud data must receive your local completion/deletion before another device or the phone-lock bridge can know about it. The website does not upload changes while fully closed. There is no new idle polling loop.

JSON backups now include recurrence schedules, templates, shared references, and history. Replace restores them with their task IDs. Smart Merge is intentionally blocked when either side contains recurring series: independently merging versions could resurrect an old branch or erase a current occurrence. Export the current account before replacing anything.

Stopping recurrence and cleanup are different. Wiping completed/trashed task records does not erase the separate occurrence history. Logging out isolates recurrence with the other account data. An older open app is asked to refresh before it can overwrite an account that has recurrence data.

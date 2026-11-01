# Universe UI/UX update

Drop the `uni/` files over your existing `uni/` folder, and the three `tutorial-*` files over the ones in your site root. No backend, API, permission or Pro logic changed.
Unchanged: tour content for Getting started, Breaks, AI, Phone and Pro; universe-archive.js, focus-timer.js, components.html, style.css and all shared JS.

## Files
- universe.css: galaxy-violet palette in the personal site's layout (card task rows with priority stripe, tactile buttons, pills, sync badge, accordions, bottom sheets on phones, skeletons, toasts). Also overrides the legacy `.universe-workspace` rules in style.css that made every button full width on phones.
- universe-widgets.js: `UniverseUX.toast(message, {tone, action, onAction})`, `UniverseUX.skeleton()`, `UniverseUX.pressFeedback(button)`.
- universe-shell.js: sliding tab pill, connection badge in words, Back to Tasks / All Universes in the menu, pane enter animation, red confirm style for destructive prompts.
- universe-ui.js: `run(fn, button)` shows busy/done/failed on the pressed button plus an error toast; loading skeletons; picker tabs Joined / Created / Join or create with counts and a Backups button on created cards; Controls split into People / Invitations / Labels; success toasts.
- universe-tasks-ui.js: dashboard summary ring, quick date pills, Overdue / Today / Upcoming / No date / Complete groups, overdue highlighting, animated subtask folding, assignment stepper and state chip, editor unsaved-changes indicator, project header with progress, empty states, success toasts.
- universe-release-ui.js: button feedback and toasts for consent, comments and exports.

## Tutorial files (site root)
- tutorial-integration.js: Universe tour rewritten for the new layout, 12 steps for owners/admins and 10 for reviewers/members: role line, sync + connection states, tabs, dashboard ring, date groups and assignment states, Projects, ＋ create (managers), My stats, Controls People/Invitations/Labels (managers), Settings (owners are told about the per-Universe Backups button), Leave/Delete, Replay. The steps switch tabs themselves and return you to the tab you were on. The "Replay Universe tutorial" button now sits in a "Help" section in Settings, appears once, and a tour can no longer restart itself right after it finishes. Progress key (`universe:<id>`) is unchanged, so finished tours stay finished.
- tutorial-spotlight.js: new optional `theme` argument on `start()`. Other tours are unaffected.
- tutorial-spotlight.css: `.tt-universe` block tints the Universe tour galaxy violet to match.

## Behavior notes
- Export/import tab removed from the picker; the same backups are reached through the Backups button on each created Universe (opens its Settings).
- If you cache-bust these files with query strings, bump them.

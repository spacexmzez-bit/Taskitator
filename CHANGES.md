> Phase 2 is current: encrypted Gemini key storage, protected key actions and the authenticated Worker AI gateway. See PHASE-2-SETUP.html and PHASE-2-CHECKS.md. The release notes below are historical.

# What changed, in plain English

This update starts from Taskitator-main-4.zip. The Taskitator Ari prompt fix is preserved. No account tiering or unrelated product expansion was added.

## New application files

- recurrence-core.js: works out dates, keeps one occurrence, renews only the selected branch, preserves history, and handles month-end/leap-year rules. Both the site and Worker use these same rules.
- recurrence-ui.js: adds schedule choices, recurrence management, ordinary edit scope, future-only proof criteria validation, stopping/resuming, and occurrence history.

## Changed application files

- app.js: handles retirement and renewal when a task is saved, respects the ordinary Undo window, adds recurring badges, and prevents a parent from silently completing an unfinished AI-audited child.
- components.js: connects the new controls to task creation/details, copies reference files for recurring work, protects current criteria, and requires actual evidence approval for recurring tasks even during repeated provider outages.
- sync-engine.js: carries recurrence data across devices, keeps it isolated per account, and includes it in conflict backups.
- agent-engine.js: preserves the Ari fix and makes task changes made through Ari follow the recurrence rules too. Its corrected prompt text is unchanged.
- calendar.html: sends protected/recurring completion to the main task screen so the calendar cannot skip proof or recurrence handling.
- stats.html: includes retired completed occurrences in the existing productivity statistics.
- settings.html: includes recurrence in backup/restore and blocks unsafe Smart Merge combinations involving recurring branches.
- index.html, projects.html, trash.html, login.html: load the new recurrence files before the sync/application code. Other modified pages do the same. Calendar, Trash, and Stats also load the audit engine needed by the future-criteria panel.
- sw.js: changes the cached-app version and caches the new files so the installable web app receives the update.
- cloudflare/worker.js: uses the shared rules inside the existing transactional service. It prevents duplicate renewal, protects against older clients overwriting recurrence, and recovers expired Undo windows during later cloud reads/status requests.

## Deployment and documentation

- .github/workflows/deploy-worker.yml: optional manual GitHub Actions deployment, useful on a phone. It deploys the existing taskitator-sync Worker and runs only when requested.
- README.md, RECURRING-TASKS.md, SETUP.md, CHECKS.md: explain behavior, uploads, deployment, and verification.
- tests/: automated checks for recurrence, UI actions, transactional sync, and existing module behavior. These files are for verification rather than app screens.

## Preserved files and settings

SYSTEM_PROMPT.md, cloudflare/wrangler.toml, the Worker name, existing bindings, CNAME, manifest, icons, and guide images remain unchanged. Existing tasks do not become recurring automatically. Existing accounts and stored task data remain on their current service.

The Worker imports the root recurrence-core.js file. Deploy the project with Wrangler or the included GitHub Actions workflow; a single-file paste into the Cloudflare editor is insufficient.

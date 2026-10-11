# Verification for this update

## Automated checks

The final test run passes 103 checks with zero failures. This count includes Worker-fixture checks exercised by the client suite as well as the standalone Worker suite.

The checks cover:

- All six schedule choices, selected weekdays, optional end dates, month-end clamping, leap years, and Riyadh logical-day rollover.
- One unfinished occurrence, missed-date skipping, branch-only replacement, untouched static ancestors/siblings, new child inheritance, stopped series, permitted deletion, and bounded history after hundreds of cycles.
- Future-only criteria, successful fresh validation, failed validation retaining the old criterion, stopping through the actual UI handler, reference capture, and restoring saved data after simulated storage failure.
- Main completion protecting AI-audited children, actual main deletion renewing only its branch, and calendar routing protected work to the main page.
- Worker renewal, concurrent two-device completion, idempotent lost-response retries, rejection of old clients, malformed recurring hierarchies, and recovery after closing a browser during the ordinary undo window.
- Existing account migration, account separation, version conflicts, large snapshot chunks, password changes, interrupted requests, sync timing, and task/component integration.

All modified JavaScript and every inline HTML script are also parsed for syntax. Local script paths are checked. SYSTEM_PROMPT.md is checked against the supplied archive to confirm the Ari prompt is unchanged. The existing wrangler.toml, domain file, icons, and images are preserved.

## What was not tested live

No Worker was deployed and no GitHub repository was changed from this session. No real Google API calls, Cloudflare account operations, installed-device tests, or MacroDroid lock tests were performed. UI tests execute real handlers in a lightweight DOM fixture; they are not screenshots or a full browser/Android test. A Chromium executable was unavailable in this environment.

## Known practical limits

- One independent recurring series per branch; no nested independent schedules.
- A child follows its recurring ancestor. Completing a child does not independently renew it.
- Archived occurrences are read-only summaries, not attached task trees or a complete uploaded-proof archive.
- Occurrence history retains the latest 500 entries, and the existing completion ledger retains 200 events.
- Criteria changes are validated and future-only. Existing current-task protections remain.
- Reference files now follow recurrence data across devices; large files remain subject to browser storage and the existing cloud body limit. Use compressed, readable references.
- Smart Merge is blocked when either side contains recurring series. Use an exported backup and Replace when deliberately restoring such data.
- Automatic sync still needs the browser to execute and the network to succeed. There is no new repeating poll. The Worker can recover finalized/expired-window recurrence during a later cloud request.

Read RECURRING-TASKS.md for the exact behavior and SETUP.md for a phone-friendly installation sequence.

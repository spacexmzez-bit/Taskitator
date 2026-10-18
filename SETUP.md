> Phase 2 is current: follow PHASE-2-SETUP.html, including the vault secret, identity confirmation, deployment and live checks. The installation instructions below are historical.

# Install this update from your phone

This guide updates the existing Taskitator repository and taskitator-sync Worker. You do not need to create a new account, Worker, database, or domain. The configuration file already contains the existing Worker name and bindings from your supplied version.

Before starting, open the current app, use Sync Now, and download a JSON backup from Settings > Data & Backup. Keep your backup private because the existing export can contain credentials and your Gemini key. Download the current repository ZIP as a separate rollback copy too.

## Important file layout

The extracted Taskitator-main folder contains the app files. Files such as index.html and recurrence-core.js belong at the repository root, not inside an extra Taskitator-main folder. worker.js belongs inside cloudflare. deploy-worker.yml belongs inside .github/workflows, with the plural workflows.

Do not upload the ZIP as a single repository file. Extract it in Files / My Files first. The upload-only ZIP contains the necessary new/changed files; keep the existing icons, images, and unchanged files already in the repository.

## Batch 1: upload the shared rules and Worker

1. Open your existing Taskitator repository in the phone browser. Open Code, then Add file > Upload files. Tap choose your files, select the extracted root recurrence-core.js, and wait for upload.
2. Scroll down to Commit changes. Enter Add recurrence rules and tap Commit changes. This adds the helper without changing the existing app screens yet.
3. On the repository Code page, tap the cloudflare folder. Use Add file > Upload files. Choose the updated worker.js from the extracted cloudflare folder. Uploading within that folder gives it the correct path.
4. Tap Commit changes, enter Update recurring Worker, and confirm Commit changes. Keep the existing wrangler.toml unchanged.

## Batch 2: add manual deployment, if you do not already have it

If you already have a functioning Taskitator deployment workflow that uses cloudflare/wrangler.toml, use it instead. The shared root file must be present in the checked-out repository when the Worker is built.

1. Return to the repository Code page. Tap Add file > Create new file. If the phone layout hides these controls, turn on Desktop site in your browser menu.
2. In Name your file, enter exactly .github/workflows/deploy-worker.yml. GitHub creates the two folders from the slashes.
3. Open deploy-worker.yml from the downloaded update in a text editor. Copy all its contents, including the filename comment at the top, and paste them into GitHub's file editor. Do not paste instructions from this Markdown file.
4. Tap Commit changes, enter Add manual Worker deployment, choose direct commit to main if asked, then tap the final Commit changes button.

## Batch 3: GitHub secrets, if not already configured for this repository

Secrets in a different repository are not automatically available here. The required names are CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. An account ID is not a KV namespace ID.

1. In Cloudflare, open your profile menu > My Profile > API Tokens > Create Token. Choose the Edit Cloudflare Workers template. Select your account as the account resource, review the token permissions/resources, then continue and create the token. Copy it privately; Cloudflare may show its full value only once.
2. Find your Cloudflare account ID in the dashboard account overview or the existing Worker's account details. Use Copy account ID where provided. Keep it distinct from the namespace ID already in wrangler.toml.
3. Return to the Taskitator GitHub repository. Tap Settings, then Secrets and variables > Actions. Tap New repository secret. Name it CLOUDFLARE_API_TOKEN, paste the token as its value, and tap Add secret. If it already exists, update it only if needed.
4. Tap New repository secret again. Name it CLOUDFLARE_ACCOUNT_ID, paste the account ID, and tap Add secret. Never put the API token directly into a committed file.

Cloudflare dashboard navigation can differ between phone layouts. Use the built-in Edit Cloudflare Workers token template for the existing account rather than making a token for an unrelated account.

## Batch 4: deploy the Worker

1. In your Taskitator repository, open Actions. It may be under the top navigation's overflow menu on a phone.
2. Select Deploy Taskitator Worker in the workflow list. If GitHub asks to enable Actions, enable it for this repository.
3. Tap Run workflow, choose main, then tap the Run workflow button inside that menu.
4. Open the newly created run. Wait for the deployment job to turn green, then open its deployment step and confirm it reports taskitator-sync. If it fails, keep the error text and fix deployment before continuing with the website update.

This workflow bundles worker.js together with recurrence-core.js. Do not replace the existing Worker with a fresh empty Worker. No new Durable Object migration is needed; the existing migration and binding are preserved.

## Batch 5: upload the website update

1. Return to Code at the repository root. Tap Add file > Upload files > choose your files.
2. Select the new recurrence-ui.js and all changed root app files in the upload-only ZIP: app.js, components.js, sync-engine.js, agent-engine.js, sw.js, and the changed HTML pages. recurrence-core.js may also be selected again. Keep all filenames exactly as supplied.
3. Wait for upload to finish. Scroll to Commit changes, enter Install recurring tasks update, then confirm Commit changes.
4. If the site is served through GitHub Pages, check its deployment in Actions and wait for it to finish successfully. If your current hosting uses another deployment method, publish these changed website files through that same method.

The Markdown guides and tests are optional uploads for documentation/verification. No icon/image changes are required. The full update includes them so the complete app can also be uploaded as a whole.

## Batch 6: refresh and test

1. Close open Taskitator tabs and the installed app, then reopen the website online. Refresh once; if an older cached app still appears, close and reopen again after the new service worker has installed. Do not clear site data before backing up unsynced work.
2. Open a regular test task. Choose Set up recurrence > Daily with today's start date. Complete it, wait for the ten-second Undo window, and confirm one replacement dated for the next eligible day.
3. Use Sync Now. Open the same account on another device and sync there. Confirm it sees the same replacement rather than a second copy.
4. Test stopping: open the current replacement, choose Stop future repetition, and confirm the current task remains. Finish it and verify no replacement is produced.

Additional useful tests: a weekday schedule, a month-end schedule, recurrence beneath a static parent with an unrelated sibling, a child with AI proof, and a future-only criterion change. The deployment is ready for your own use after these checks pass on your devices. The supplied automated checks do not replace a live provider/phone-automation test.

## Existing terminal deployment, if you prefer your previous method

Your existing Wrangler deployment method still works when run from the updated complete project. It must use cloudflare/wrangler.toml and include recurrence-core.js at the repository root. The GitHub Actions route above runs the same deployment on GitHub's servers and avoids opening a terminal on your phone.

## Rollback

Restore your previous app files and Worker code from the saved repository ZIP. Existing regular data stays on the same service, but the old app does not understand recurring metadata. Before rolling back after creating recurring series, export the updated account and stop/finish those series or keep the updated app available to manage them. Do not blindly overwrite a newer account with an older backup.

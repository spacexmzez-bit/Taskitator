# AI audit attachment fix

## What went wrong

Google rejected the request before reviewing the proof. Some saved reference attachments supplied their file type and file contents in the wrong place. This explains the message about unknown mime_type and data fields. It is a request-format problem, not a verdict about your evidence.

## What changed

- audit-engine.js: puts older reference attachments inside the container Google expects before sending them. Newer attachments already in the correct format stay as they are. The submitted proof and the review instructions still accompany the reference. The same correction applies when the backup model is used.
- sw.js: changes the installed app's cache version so it can fetch the corrected audit engine.

Your tasks, proof criteria, Ari prompt, API key settings, recurrence rules, and Worker are unchanged by this correction. No Worker deployment is required for this fix.

## Upload the small fix from your phone

Use Taskitator-audit-fix-upload.zip if the recurrence update is already uploaded. It contains two replacement website files and this explanation. If you have not installed recurrence yet, use the complete archive and its SETUP.md instead; installing recurrence also requires its Worker update.

1. Download the small ZIP. Open your phone's Files app, open Downloads, tap the ZIP, and choose Extract or Unzip. Keep track of the extracted folder.
2. Open your Taskitator repository on GitHub in your browser. Select the Code tab and the main branch. Stay on the main file list where index.html, app.js, and audit-engine.js appear; do not open the cloudflare folder.
3. Tap Add file, then Upload files. If the button is hidden, open the browser menu and turn on Desktop site. Tap choose your files, navigate to the extracted folder, and select audit-engine.js and sw.js. Upload these files directly, not the ZIP or its enclosing folder. Wait until both names appear on GitHub's upload page.
4. Scroll to Commit changes. Enter Fix AI audit attachment format. Choose Commit directly to the main branch and tap Commit changes. Wait for your website deployment to finish successfully in Actions. Then open the Taskitator website, refresh, close its open tabs and installed app, and reopen it. If it still shows the same error, refresh and reopen once more to allow the new app cache to take over. Do not clear app storage.

## What to test

Submit proof for a task with a reference attachment. The unknown mime_type/data error should disappear and you should receive the normal approval or rejection. Also try a task without a reference attachment. A rejected proof can be a valid review result; it is different from a malformed-request error.

## Verification

108 automated checks pass with zero failures. The five new checks inspect actual outgoing request bodies and exercise the proof-review function with an older reference, an already-correct reference, no reference, a fallback response, and text-only requests. Google responses are simulated. No real Google request or live website deployment was performed here.

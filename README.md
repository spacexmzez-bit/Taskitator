# Taskitator - recurring tasks update

This is the complete updated application, based on Taskitator-main-4.zip, including the Ari prompt fix. The app keeps its existing taskitator-sync Worker, cloud account, custom domain, and database bindings.

Read CHANGES.md for what changed, RECURRING-TASKS.md for how recurrence behaves, SETUP.md for phone-friendly upload/deployment instructions, and CHECKS.md for verification and limits.

The full ZIP includes icons and guide images. The separate upload-only ZIP includes only new or changed files, preserving their paths. Extract either ZIP before uploading its contents. Uploading a ZIP to GitHub does not install its contained files.

Both the website and Worker need this update. The Worker now imports recurrence-core.js from the repository root, so do not paste worker.js alone into Cloudflare's single-file editor.

The optional GitHub Actions deployment file runs only when manually requested. It does not deploy automatically after every commit.

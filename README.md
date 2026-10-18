# Taskitator — Gemini / Claude and policy links (Phase 3)

Start with [PHASE-3-SETUP.html](PHASE-3-SETUP.html), or its TXT equivalent.
This build uses the uploaded Taskitator-main-2.zip as its baseline and includes
Phases 1 and 2. See [PHASE-3-CHECKS.md](PHASE-3-CHECKS.md) for current validation and limits.
The update ZIP preserves your configured auth-config.js. Configure the vault
secret before uploading/deploying if Phase 2 was never configured; otherwise
keep the existing keyring. Gemini and Claude retain separate encrypted keys,
the same one-use verification, and a single existing Worker. Privacy and Terms
are linked under Settings → System. Upload the cumulative update and run the
existing GitHub Actions deployment workflow.

## Earlier login setup reference

Complete project based on the attached Taskitator-main.zip. Taskitator keeps its existing website, Cloudflare Worker, Durable Object account data, KV migration source, recurrence engine, AI audits, and sync conflict handling.

Start with **SECURITY-SETUP.txt**. It explains Clerk production setup, the public frontend key, Cloudflare secrets, email-approved migration, deployment, and the new status-only MacroDroid token. Authentication must be configured before this version can be used.

Pause phone-blocking macros before deploying: old tokens stop working immediately. Existing users connect their old Taskitator account to a verified Clerk login once. New users explicitly create a new account after email verification.

Run the dependency-free regression suite with Node 22 or newer:

```sh
npm test
```

Deploy using the manual `.github/workflows/deploy-worker-security.yml` workflow, or `npm run deploy:worker` after Cloudflare authorization. Do not deploy `worker.js` alone: it imports `cloudflare/auth.js` and the root recurrence module.

The Clerk JavaScript SDK manages sessions; Taskitator obtains short-lived tokens for Worker requests without saving them in app settings. The Worker checks signatures, issuer, origin, expiration, user identity, and live session status. Password management and recovery are in the managed account profile.

See **SECURITY-REVIEW.md** for implementation details and verification limits. Historical recurrence documentation remains in RECURRING-TASKS.md and the earlier sections of CHANGES.md/CHECKS.md. SECURITY-SETUP.txt supersedes older deployment instructions.

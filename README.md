# Taskitator — managed authentication security update

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

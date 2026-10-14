# Authentication changes and validation

Phase 1 adds coordinated deletion and Settings changes on top of this security
build. See PHASE-1-REVIEW.md and PHASE-1-SETUP.html for the current behavior and
required configuration. The current suite has 37 passing tests; the counts below
describe the earlier security-update preparation.

The frontend now uses Clerk's vanilla JavaScript SDK (ClerkJS 6 and its UI bundle). It obtains short-lived tokens for requests without storing credentials in Taskitator settings, localStorage, or exports. The static website hosting and transactional Cloudflare coordinator are preserved.

The Worker uses Clerk's documented manual JWT verification flow with Cloudflare Web Crypto: RS256, a configured public key, expected issuer, numeric token times, authorized origin, subject and session identifiers, and active session status. It then checks the session through Clerk's Backend API for every browser request. A provider outage fails closed. Keys and legacy migration ownership settings must be supplied by the app owner.

Each account is linked to one permanent Clerk user ID. The Worker resolves account ownership itself and ignores caller-supplied username headers. Sync snapshots still use their existing account key and revision numbers after migration. New account keys derive from the case-sensitive Clerk ID without lowercasing that ID.

Legacy migration requires an owner-approved verified primary email, the old password, and an open migration deadline. It can import existing KV registrations/snapshots or link the existing Durable Object account. It does not create missing legacy accounts. Linking removes the active legacy digest and old rotation receipts. Old bearer credentials are refused for every normal endpoint, including phone status. KV is retained as a recovery source and still contains historical secrets; it is not erased by the update.

Phone tokens contain 256 random bits, have a separate namespace, and authorize only status requests. Storage contains their digest and scope. Only one token is active per account. Creating a replacement invalidates the old one immediately. Password changes and browser logout do not revoke phone access; lost-phone access must be revoked explicitly.

Credential cleanup removes old hashes from readable browser settings, account-cache keys/values, and password-rotation recovery records. Distinct readable legacy copies are retained in credential-free recovery archives before any overwrite or removal; the newest dated copy is selected when dates are available. The linked account's login screen offers separate sanitized downloads before synchronization. Unreadable or unwritable old archives are skipped and retained untouched rather than guessed at or deleted; a warning is displayed on login. These damaged originals may still contain historical credentials, but legacy credentials remain rejected by the Worker. Ordinary exports omit authentication and AI secrets, and old backup imports cannot replace the new authenticated account's identity. Existing AI configuration still syncs through the authenticated snapshot system; this update does not introduce end-to-end encryption or an AI proxy.

Rendering fixes cover task titles, raw edit titles, proof criteria, tags, notes, archive entries, and trash titles. Rich-title paste/drop accepts plain text. Static/dynamic inline event handlers have been replaced with event listeners. Each HTML page has a CSP with hashes for its preserved inline scripts and the external hosts required by Clerk and Gemini. `node tools/rebuild-csp.mjs` regenerates hashes after inline-script edits. GitHub Pages cannot enforce `frame-ancestors` through a meta policy; an HTTP-header deployment would be needed to add frontend frame protection.

The frontend waits for server-checked authentication before initializing account UI. Local cache owner mismatches route through login to restore the appropriate cache. This changes cold-start offline behavior: cloud sign-in is required to open the app, while unsynced drafts remain stored. Local task archives are not encrypted or protected from somebody who can inspect the browser profile. On shared computers, use separate browser/device accounts.

Application requests and migration attempts are throttled in the existing Durable Object. Expired rate records are removed by an alarm. Clerk handles password-login and registration abuse protection. Administrator accounts and provider settings remain part of the security boundary.

## Verification

The included Node suite uses genuine RSA-signed fixtures, transactional storage substitutes, and a substituted provider HTTP API. It tests:

- Rejection of anonymous and legacy authentication, without implicit account creation.
- Invalid signatures/algorithms, expired tokens, wrong issuer/origin, pending sessions, and session/user mismatch.
- Live session revocation and fail-closed missing configuration.
- Account isolation, forged usernames, version conflicts, idempotent writes, and snapshot credential removal.
- Status-only phone scope, one-time disclosure, replacement/revocation, and independence from browser logout.
- Owner-approved legacy migration, wrong passwords/emails, closed migration deadlines, KV and existing Durable Object migration, and revision preservation.
- Migration throttling and CORS allowlisting.
- Riyadh due-task/break unlock behavior.
- Browser-storage cleanup without losing drafts, export sanitation, and logout ordering.
- Matching CSP hashes and absence of inline HTML event handlers.
- Security service-worker activation before app startup and preservation of drafts when switching logins.

All 24 included tests passed after the corrective review. Seven new tests cover multiple password-era archives, existing-v2 collisions, corrupt legacy archives, failed recovery writes, first-migration conflict completion, new-account sync retries, and sanitized recovered-copy downloads. JavaScript files and embedded application scripts passed syntax checks. The original recurrence core remains unchanged.

## Corrective bug check

The three confirmed bugs from the initial review are fixed: cleanup no longer discards distinct password-era copies, unreadable unused archives no longer abort authentication, and account connection exposes a working Continue action even if the first pull fails or conflicts. Connection controls are hidden once linking succeeds, and concurrent Continue requests are suppressed. The service-worker version is advanced to `taskitator-security-clerk-v2` so existing installations receive the corrected login code before application initialization.

The follow-up local review covered ordinary login/connect/retry flows, account switching, draft recovery/export, service-worker updates, sync conflicts, Worker account isolation, migration requirements, and phone-token scope/revocation. No additional common-flow defect was confirmed in these checks. This is not an exhaustive security audit or a statistical estimate of bug frequency; obscure failure combinations were not the focus. The backend authentication and Worker source files, public configuration, account ownership rules, migration controls, CSP restrictions, and phone-token permissions are unchanged by these corrections.

No Clerk application credentials, live Cloudflare account, production DNS, or physical phone were supplied. Real provider integration and deployment were not exercised. A browser was unavailable and its download was blocked, so page execution/layout/PWA behavior was not verified here. Complete the first-login, recovery, multi-device and phone checks in SECURITY-SETUP.txt before enabling blocking or admitting public users.

The full project includes every file in the uploaded source. Existing recurrence documentation is retained, with the security setup guide taking precedence for deployment. The existing single Durable Object coordinator remains a scaling constraint; it was preserved to keep storage identity and transactional behavior intact.

## Provider references

- [Clerk JavaScript quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart)
- [Manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
- [Session token retrieval](https://clerk.com/docs/js-frontend/reference/objects/session)
- [Clerk backend API](https://clerk.com/docs/reference/backend-api)
- [Clerk content security policy](https://clerk.com/docs/guides/secure/best-practices/csp-headers)

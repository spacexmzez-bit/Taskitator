# Phase 2 implementation and checks

Built on the uploaded `Taskitator-main-2.zip`. Phase 1 remains included.

Saved Gemini keys now use AES-256-GCM encryption in Durable Object storage.
The keyring is a separate Cloudflare Worker secret; authenticated encryption
binds ciphertext to the Clerk owner, provider, record kind and revision.
Only metadata is returned during normal use. Password or linked-Google
confirmation authorizes one reveal, save or deletion, for one session and
current saved-key revision. Copy uses a verified reveal; temporary display
clears after 30 seconds or when the page is hidden/left.

Copilot, criteria validation, evidence audits and note extraction use the
authenticated Worker gateway. Existing Gemini names, audit prompts, tools and
fallback behavior are retained. Connection checks use a model-metadata GET
with **zero generated tokens**. This does not verify generation quota/billing.
Saving a key performs that check before replacing the active key.

Owned cloud keys are encrypted before removal from the stored snapshot, without
changing tasks or sync revision. Browser/historical keys become encrypted
recovered copies; selecting one as active requires identity confirmation.
New sync snapshots, ordinary exports and conflict backups omit keys. Different
owners' un-migrated archives are retained for their own migration. Ambiguous or
unreadable records and old external backups may still need manual review.
Legacy Claude fields are preserved encrypted, without adding Claude integration.
Phase 1 deletion now removes active, recovered and archived encrypted keys.

## Automated validation

`npm test`: **53 passing tests, zero failures**. Provider HTTP and storage are
substituted; RSA JWT/Google signatures and AES-GCM use real Web Crypto.

The suite covers:

- Missing configuration, expired/forged sessions, live session revocation,
  ownership separation, impersonation and status-only phone restrictions.
- AES-GCM confidentiality, tampering, cross-user ciphertext substitution,
  retained encryption versions and failure when a necessary version is absent.
- Required verification, pending proofs, proof replay, action/session/owner
  binding, invalid-key rejection and invalidation after a saved-key change.
- Linked-Google callback validation, rejection of wrong identity/nonce/audience/
  expiry/signature, one-use callbacks, and key authorization not granting deletion.
- No plaintext key in persisted vault records; header-only provider authentication;
  omission from sync/export; inactive recovery; prevention of sync resurrection.
- Worker payload/tool forwarding, allowlisted models, file/output restrictions,
  provider error redaction and preservation of quota statuses for fallback.
- Browser migration preserving tasks and other owners; originals retained on
  staging failure; no API key in Google redirect/sessionStorage.
- Actual audit/Copilot calls through the gateway and Gemini fallback.
- Google return selecting the Account tab, verified reveal, blocked clipboard
  fallback, and explicit display clearing. This uses DOM substitutes.
- Existing Phase 1 deletion, phone recovery, retrying cleanup, legacy account
  migration, recovery exports, sync conflicts and Tags & Prio default behavior.
- Every HTML inline-script hash matching its CSP and absence of inline event
  attributes.

All JavaScript and inline scripts were also parsed for syntax, and local script
references were checked. App prompt, recurrence/core files, live public config,
Worker configuration/bindings and image assets were compared with the upload.

## Review findings addressed while building

The review caught a Google-return UI problem: Settings normally starts on Tags
& Prio, which could hide the revealed key and the manual clipboard fallback.
Key confirmation now selects Account on return, with a regression check.

Legacy recovery also preserves short or malformed placeholder keys as inactive
encrypted copies, so an old value such as `test` cannot block access to tasks.
Activation still rejects an invalid key. A regression check covers this flow.

The review also checked that unverified browser recovery cannot silently replace
an active key, a failed key check cannot destroy the old key, a deleted key cannot
be restored by ordinary sync, and account deletion removes new vault records.

No unresolved issue affecting the normal flows above was identified in these
checks. Rare scenarios were not exhaustively explored, and this is not a claim
that the app is free of vulnerabilities.

## Deployment and limits

The app has not been deployed from this workspace. No real Google/Clerk login,
paid Gemini generation, live Cloudflare migration/deletion, or visual browser
run was performed. Complete the guide's production checks with a disposable
account before enabling blocking or relying on the new controls.

The operator must add `API_VAULT_KEYS` and `API_VAULT_ACTIVE_KEY_ID` and check the
existing Clerk signed claim and Google confirmation callback. The full HTML
guide includes an offline random-key generator and detailed GitHub steps.

This is encryption at rest, not end-to-end encryption. The Worker can decrypt
keys; compromise of its runtime and secrets can expose them. Old devices,
exported files, browser extensions, clipboard managers and provider operational
backups remain outside the temporary-display protection. Do not remove old
encryption versions or roll back to a pre-vault Worker after migration.

Gateway limits are 30 requests/minute/user, two concurrent generations,
20 MB JSON requests, 5 MB per image/PDF and one candidate up to 16,384 output
tokens. Generation has a 55-second provider timeout; client timeout is 70 seconds.
Each user can retain 16 distinct recovered keys per provider. Verify starts
are limited to eight/minute/user and key checks to six/minute/user.

Claude integration and Settings links to the policy pages remain Phase 3.
Existing privacy and terms pages were updated to describe Phase 2 data flows.

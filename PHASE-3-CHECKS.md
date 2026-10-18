# Phase 3 implementation and verification

This cumulative build starts from the uploaded `Taskitator-main-2.zip` and
includes Phases 1, 2 and 3. The GitHub update ZIP excludes `auth-config.js` and
`cloudflare/wrangler.toml`. The private vault-secret TXT supplied separately
is not part of either project archive.

## Resulting behavior

Settings → Account has a Gemini/Claude selector and model information. Each
provider retains its own AES-256-GCM encrypted key. The selector browses its
key; **Use … for AI** activates that provider only when a saved key exists.
Activation is stored with the cloud account, separately from ordinary snapshots.
Changing providers does not overwrite the other key or route failures to it.

Gemini uses `gemini-3.5-flash-lite` and its existing `gemini-3.1-flash-lite`
fallback. Claude uses `claude-haiku-5-5`. Both run through the existing Worker.
No new Worker, DNS, database, global provider key or OAuth application is needed.
Keep the original Phase 2 encryption keyring and identity-verification setup.

Show, copy, replace, recovered-key activation and key deletion still require
one-use password or linked-Google confirmation. Proofs are bound to owner,
session, action, **provider**, saved-key revision and any recovered-key selection.
Ciphertexts authenticate the provider as well as the owner. Metadata contains
only status, suffixes and identifiers. Copied/revealed keys temporarily enter
the browser; clipboard contents can outlive the display.

Both connection checks fetch model metadata with zero generated tokens. Saving
checks metadata before replacing the old key; failure leaves it intact. Metadata
access is not a generation/quota/billing test. Use a real small AI request after
deployment to verify generation access.

Claude has adapters for chat, tools, image/PDF proof/exemplar review and JSON
results for criteria, evidence and note extraction. Tool IDs survive round trips;
tool results retain complete history boundaries. Existing task mutations and
AI-lock checks remain in the client dispatcher. Claude runs with thinking off
and low effort, omitting Gemini sampling parameters. Truncated, refused,
malformed or schema-invalid results are rejected before an approval or partial
tool response reaches the client. Gemini incomplete/blocked results are also
rejected. Neither provider silently sends content to the other on failure.

Changing provider/key clears Copilot's prior conversation context. Criteria
cache entries are scoped by provider and key revision. In-flight responses
whose provider/key changed are rejected. Other devices refresh AI preferences
on loading/syncing or using Refresh status.

Phase 2 encrypted Claude archives are moved into protected recovered-key storage
without activating them. Inaccessible archives are kept for operator recovery;
the 16-key limit is respected. Coordinated account deletion removes active,
recovered and archived keys for both providers and deletes the provider setting
with the account. Existing phone-unlock recovery behavior remains unchanged.

Settings → System links Privacy Policy, Terms & Conditions and account/data
deletion information. The existing public pages describe Anthropic and active
provider processing. Tags & Prio remains the default Settings tab.

## Validation

**70 automated tests pass, zero failures.** Run with `npm test`.
Provider HTTP, DOM and Durable Object storage use substitutes; RSA signatures
and AES-GCM use real Web Crypto. Tests cover:

- All previous Phase 1/2 authentication, deletion, migration, sync-conflict,
  plaintext-scrubbing, recovery and keyring-version scenarios.
- Separate provider records, explicit/persistent activation, no plaintext keys
  in metadata or storage, zero-generation checks and header authentication.
- Provider-bound proofs, same-user ciphertext substitution rejection,
  one-use Google confirmation for a Claude key and preserved key separation.
- Allowed models, stale provider rejection, shared concurrent-request limits,
  provider error redaction and no automatic provider fallback.
- Claude model/schema conversion, supported images/PDFs, tool schemas, tool
  identifiers/results, refusals, malformed JSON, truncation and output validation.
- Rejection when a provider changes during a running generation, and rejection
  of Gemini output that ended before completion.
- Migration of encrypted Claude archives and removal of both active keys during
  coordinated account deletion.
- Actual provider selector behavior with DOM substitutes; Copilot through the
  Claude adapter; attempted AI-locked task trash remaining blocked; long tool
  conversations; cross-provider context/cache isolation; preserved Gemini fallback.
- Google callback returning to Account controls; protected reveal and clipboard
  fallback; retained drafts and useful instructions on an old-Worker endpoint error.
- System policy links, Tags & Prio default, local reset distinction, CSP hashes
  and no inline event attributes.

JavaScript/inline-script syntax and local script references were checked. The
uploaded public config, Worker config/bindings, system prompt, recurrence/core
task files and all image assets were compared with the original upload.
Archive validation also overlays the cumulative update onto that upload and
checks that it reproduces the completed project before rerunning the suite.

## Review fixes and practical limits

Review caught that a simple eight-message history slice can start with an
orphan tool result, which Claude rejects. It now retains complete user/tool
turns. Provider IDs are preserved through password and Google key flows;
confirmation for one provider cannot operate on the other. Gemini partial
responses cannot bypass the Claude-style protection against incomplete outputs.

The new frontend turns the previous “Endpoint not found / password changes”
startup message into specific GitHub Worker-deployment instructions when the
old Worker is detected. No local data is cleared to work around the error.

No unresolved defect affecting the normal flows above was identified in these
checks. Rare scenarios were not exhaustively tested; passing checks do not
establish that the application has no vulnerabilities.

No live Clerk/Google confirmation, paid provider call, production migration or
deletion, or visual browser run was performed. The external Worker endpoint
could not be reached by the available browsing tool, so its deployed version
was not independently confirmed. Complete the HTML guide's live checks after
deploying and before resuming blockers.

Claude keys must be scoped to a single workspace; this UI does not collect a
separate workspace ID for broader credentials. Claude accepts JPG/PNG/WebP/PDF
here; HEIC requires conversion or Gemini. The existing limits remain 5 MB per
file, 20 MB JSON requests, one output up to 16,384 tokens, 55-second provider
timeout, 70-second client timeout, two concurrent generations and 30 generation
requests/minute/user. Verification starts are capped at eight/minute and key
checks at six/minute. Provider quotas/billing impose their own limits.

Encryption is at rest, not end to end. A compromised Worker and its secret
keyring can expose keys. Old devices, downloaded exports, clipboard managers,
extensions and provider operational backups may retain separate data.
Do not replace the vault secret, remove needed old encryption versions or
roll back to a pre-vault Worker after migration.

The script-free `PHASE-3-SETUP.html` remains readable in HTML previews and
includes complete upload, activation, optional Claude-key and live-test steps.
Official API references are linked there; model and API behavior were checked
against the providers' current primary documentation on October 18, 2026.

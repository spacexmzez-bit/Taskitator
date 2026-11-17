# Worker configuration checklist

Every setting the Worker reads, in one place (audit L6). `wrangler.toml` has `keep_vars = true`, so most of these
live only in the Cloudflare dashboard and a deploy does not show them. Check this list after any dashboard change
and before publishing. No secret values belong in this file.

"Secret" means: set with `wrangler secret put` (or as an encrypted variable). "Var" means a plain variable.

The Worker's error messages mention `SECURITY-SETUP.txt`, `PHASE-1-SETUP.txt`, `PHASE-2-SETUP.html` and
`pro/verification-setup.html`. Those files are not in this repository. Until they are added, this file is the reference.

## Must be set in production

| Name | Kind | Production value |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Var | Exactly `https://taskitator.mazendev.com` (checked in `wrangler.toml`). No localhost, no preview origins. |
| `CLERK_ISSUER` | Var | The production Clerk issuer (`https://clerk.mazendev.com`). Not a `*.clerk.accounts.dev` development instance. |
| `CLERK_JWT_KEY` | Secret | The production instance's JWT public key (PEM). |
| `CLERK_SECRET_KEY` | Secret | A production `sk_live_…` key. Never `sk_test_…`. |
| `API_VAULT_KEYS` | Secret | JSON object of key ID to AES-256 key. Keep old key IDs until every record is re-encrypted. Back it up: losing it makes every saved API key unreadable. |
| `API_VAULT_ACTIVE_KEY_ID` | Var | The key ID in `API_VAULT_KEYS` used for new records. Default `v1`. |
| `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | Secret | Key for hosted Taskitator AI. Set a spend limit on it in the Anthropic console as well. |
| `KEYO_API_ORIGIN`, `KEYO_FALLBACK_ORIGIN`, `KEYO_PROJECT_ID`, `KEYO_PUBLIC_JWK` | Var | Checked in `wrangler.toml`. Public values only. |
| `ACCOUNT_DELETION_ENABLED` | Var | `true`. Otherwise users cannot delete their account. |

## Must NOT be set in production

| Name | Why |
| --- | --- |
| `DEV_PRO_SWITCH` | `on` lets any signed-in app account give itself Pro (`POST /pro/dev`). Development Workers only. |
| `KEYO_API_URL`, `KEYO_CLIENT_ID` | Old names, still read as fallbacks. Use `KEYO_API_ORIGIN` and `KEYO_PROJECT_ID`. |

## Optional

| Name | Kind | Meaning |
| --- | --- | --- |
| `HOSTED_AI_MONTHLY_SPEND_NANODOLLARS` | Var | Monthly ceiling for all spend on the hosted Anthropic key, all accounts together. Unset: $50 (`50000000000`). |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_VERIFICATION_REDIRECT_URI` | Var | Needed for Google confirmation of key and deletion actions. The redirect must be `https://<worker host>/auth/verification/google/callback`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret | Same feature. |
| `GOOGLE_VERIFICATION_MAX_AUTH_AGE_SECONDS` | Var | 60 to 86400. Requires a recent Google sign-in. Only for a published, verified Google OAuth app with "Session age claims" on; otherwise leave unset. |
| `OFFLINE_PRO_PRIVATE_JWK` | Secret | Signs offline Pro tokens. Unset: offline Pro is off. |
| `UNIVERSE_FOUNDATION_ENABLED` | Var | `true` turns Universe on (after the SQL files in `uni/` are applied). |
| `UNIVERSE_GEMINI_MODEL`, `UNIVERSE_AI_MODEL_VERIFIED`, `UNIVERSE_INPUT_NANODOLLARS_PER_TOKEN`, `UNIVERSE_OUTPUT_NANODOLLARS_PER_TOKEN` | Var | Universe AI review model and its prices. Check the prices against Google's pricing page when the model changes. |
| `UNIVERSE_HOSTED_ENABLED` | Var | `false` in `wrangler.toml`. `true` only together with the two settings below. |
| `UNIVERSE_GEMINI_API_KEY` | Secret | Hosted Universe review key. |
| `UNIVERSE_HOSTED_MONTHLY_SPEND_NANODOLLARS` | Var | Required monthly ceiling for hosted Universe review. |
| `LEGACY_MIGRATION_OWNERS` | Var | JSON object: old username to verified email, for accounts allowed to migrate. Remove entries once migrated. |
| `LEGACY_MIGRATION_UNTIL` | Var | ISO date after which legacy migration is refused. After it passes, run `tools/purge-legacy-kv.mjs`. |

## Bindings (in `wrangler.toml`)

`TASKITATOR_SYNC` (Durable Object), `TASKITATOR_KV` (legacy data), `TASKITATOR_DB` (D1), `TASKITATOR_EVIDENCE` (R2).

## Fixed in code, not configurable

- Hosted AI model and token prices: `POLICY` in `pro-backend.js`, `HOSTED_AI` in `worker.js`. Every spend cap is computed from these prices.
- Clerk script versions: `CLERK_JS_VERSION` / `CLERK_UI_VERSION` in `core.js`.
- Clerk publishable key: `core.js`.

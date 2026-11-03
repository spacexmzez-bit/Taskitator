# Credit limits and Keyo allowance update

To install, copy these files over the repository root, keeping their paths. No migration step is needed: existing data is kept, and new state is created the first time each account is used.

## Changed files
- `pro-backend.js`: Keyo `d_allow`/`m_allow`, custom domain with a workers.dev fallback, plan epochs, Pro 30-day cycle, the `CreditLedger` (Free personal-key reservations), half-step rounding, and the new `/pro/status` shape.
- `worker.js`: every personal-key AI request (`AIGateway.generate`) is metered for Free accounts. This covers `/ai/generate` (Copilot, client audits, Smart Study, notes), personal proof review including the Gemini fallback model, study-plan validation, and Universe rule validation.
- `uni/universe-ai.js`: Free personal-key Universe AI reviews draw on the same Free allowance.
- `pro.js` and `style.css`: the Free "Limits" card, Pro limits for the 30-day cycle, the Pro personal-key note, and quote rounding display.
- `sw.js` and `core.js`: service-worker cache bumped to `taskitator-credit-limits-v1`.
- `wrangler.toml`: `KEYO_API_ORIGIN` set to `https://keyo.mazendev.com`, plus a new `KEYO_FALLBACK_ORIGIN`.
- Tests: the new `credit-limits.test.js`, plus updates to `pro.test.js`, `security.test.js`, `client.test.js` and `uni/universe-rules.test.js`.

## Policy as implemented
| Account | Hosted AI | Personal key (BYOK) |
| --- | --- | --- |
| Free | Denied (`PRO_REQUIRED`) | 10 credits per day and 220 per calendar month (Riyadh), hardcoded on the server |
| Pro | `d_allow` per day and `m_allow` per 30-day cycle, from the verified Keyo entitlement | Unlimited and not metered |

- **Rounding:** every charge and every hold rounds up to the next 0.5. Real usage is unrounded (`*_exact`, `credits_exact`, per-task values) and is shown under "View details" to 4 decimals.
- **Personal-key pricing:**
  - Claude Haiku 5.5: $0.10 / $0.50 per million tokens. Above 100K input tokens, the whole request is priced at $0.50 / $2.50.
  - Gemini 3.5 Flash-Lite: $0.30 / $2.50 per million tokens.
  - Gemini 3.1 Flash-Lite: $0.25 / $1.50 per million tokens.
  - Sources were checked on 2026-11-03 and are third-party, not the providers' own pricing pages.
- **Free request flow:**
  1. The user's own provider counts the input tokens first. If counting fails, the request stops and nothing is charged.
  2. The server reserves (input × 1.2) plus the output limit. If the requested output can't be paid for, the output limit is lowered to what the remaining allowance covers. A request is refused if fewer than 256 output tokens fit.
  3. The request settles to the provider's reported usage.
     - An error response from the provider releases the hold.
     - A lost or timed-out response, an unreadable response, or missing usage keeps the full hold.
     - A completed but rejected result (blocked, invalid JSON, refusal) is charged from its usage.
- **Invalid Keyo parameters:** a missing, malformed, negative, fractional or larger-than-1,000,000 `d_allow`/`m_allow` blocks activation with `LICENSE_PARAMETERS_INVALID` ("Contact support"). If the parameters become invalid later, the record is marked `invalid_parameters`: Pro features lock, personal-key use falls back to Free metering, and usage is not reset. Once Keyo is fixed, Pro resumes in the same period with its usage intact.

## Reset periods and transitions
- **Daily reset:** midnight in Asia/Riyadh.
- **Free monthly reset:** the 1st of each Gregorian month (Riyadh).
- **Pro cycle:** 30 days from the stored anchor (`credits:plan:<account>`).
- **Existing Pro accounts:** anchored to their stored `activated_at`. If that is missing, the first verification after deploy is used.
- **Usage carry-over at deploy:** counters start fresh under new keys. The old `pro:usage:*` keys are kept and still feed the provider-spend estimate for the current month.
- **Transitions:** every verified Free↔Pro change starts a new epoch, so all applicable allowances are fresh.
  - Confirmed downgrades: Keyo `REVOKED`/`SUSPENDED`/`EXPIRED`/…, an invalid signature, or a signed `expiresAt` in the past.
  - Free→Pro also sets a new 30-day anchor.
- **What never transitions:**
  - Routine refreshes.
  - Re-activating the same Pro license.
  - `d_allow`/`m_allow` edits. Lowering below current usage blocks access; raising it resumes access.
  - Keyo network errors.
  - A cache that has passed its deadline while Keyo is down. This is metered as Free, but the plan is not changed.
- **In-flight requests:** each request stores the exact day, cycle or epoch keys it reserved and settles only into those keys. A transition or reset during a request cannot affect the new period. Settlement happens once.
- **Hosted provider-spend cap:** the $2 per month cap (calendar month) is unchanged and is never reset by transitions. If `m_allow` is above about 1,333, this cap is reached first.

## When Keyo changes take effect
Taskitator re-verifies with Keyo when the cached entitlement is at least 1 hour old, or immediately if the cached token has invalid parameters. Changes to `d_allow`/`m_allow`, revocations and expirations apply on the next check after that. If Keyo can't be reached, a cache within its signed deadline (at most 24 hours) keeps working. After that deadline, hosted AI is denied and personal-key use is metered as Free until verification succeeds. The fallback origin is tried only on network-level failures (DNS, TLS, connection or timeout), never after an HTTP response.

## Deployment
- Keyo: no changes needed. Both parameters must exist as integer custom parameters, with the IDs `d_allow` and `m_allow`.
- Worker: deploy with the updated `wrangler.toml`. If the dashboard overrides `KEYO_API_ORIGIN` (`keep_vars = true`), update it there too.
- To disable the fallback, set `KEYO_FALLBACK_ORIGIN` to an empty string.

## Existing code mismatches (not changed)
- `UniverseService.entitlement` accepts only `tier === 'pro'`, while Pro AI and status also accept `max`. MAX keys therefore don't get Universe or study-plan Pro features.
- Universe hosted reviews keep their own separate D1 accounting, with fixed 45/1000 account limits. These are not tied to `d_allow`/`m_allow`.

## Limitations
- Free personal-key requests make one extra token-count call to the user's provider. Both providers offer this call at no charge.
- Cache tokens on Claude responses are billed at the full input rate (conservative). Gemini usage is input = prompt + tool-use prompt, output = total − input.
- There is no garbage collection for old `credits:*` usage keys. Like the old `pro:usage:*` keys, they stay in storage.
- If the Worker is interrupted between reserving and settling a Free request, the hold stays charged in its period.

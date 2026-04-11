# Migration Plan: NeverBounce → Bouncer

## Background

We are replacing the NeverBounce email verification integration with Bouncer.
The integration is well-isolated: one core module, one test file, and a handful
of call sites that only need minor updates.

Decision: **allow `risky` addresses** (pass them through). Only block
`undeliverable` and addresses where `domain.disposable === 'yes'`.

---

## Timeout Decision

The current NeverBounce client applies a hard 5-second `AbortSignal.timeout`.
Bouncer's real-time API can take up to 10 seconds (30 in extreme cases).

With a 5-second timeout, any Bouncer response that takes longer is silently
dropped and the send is allowed (fail-open). This means we'd miss some
detections, but it's identical to the current fail-open behaviour on timeout.

**Decision required before implementation:** choose one of:

- **Option A – Keep 5s timeout.** Consistent with current behaviour. Bouncer
  acknowledges ~5% more `unknown` results on the real-time endpoint anyway;
  raising the timeout only marginally improves detection at the cost of slower
  magic-link requests for affected addresses.
- **Option B – Raise timeout to 10s.** Better detection. Magic-link requests
  for addresses Bouncer can't quickly resolve will feel slow (user is waiting
  synchronously).
- **Option C – Per-call timeout parameter.** Keep 5s for the user-facing
  magic-link path; allow callers (e.g. background cron) to pass a longer
  timeout. Adds a small API surface increase.

The plan below is written assuming **Option A** (5s, unchanged) but the only
code change required to switch is a single constant.

---

## API Comparison

| Concern            | NeverBounce                                                       | Bouncer                                                                                                    |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Base URL           | `https://api.neverbounce.com/v4.2/single/check`                   | `https://api.usebouncer.com/v1.1/email/verify`                                                             |
| Auth               | `?key=API_KEY` query param                                        | `x-api-key: API_KEY` request header                                                                        |
| Email param        | `?email=...` query param                                          | `?email=...` query param                                                                                   |
| Result field       | `result: 'valid'\|'invalid'\|'disposable'\|'catchall'\|'unknown'` | `status: 'deliverable'\|'risky'\|'undeliverable'\|'unknown'` + `domain.disposable: 'yes'\|'no'\|'unknown'` |
| Block condition    | `result` in `{'invalid', 'disposable'}`                           | `status === 'undeliverable'` OR `domain.disposable === 'yes'`                                              |
| Allow condition    | anything else (including `catchall`, `unknown`)                   | `deliverable`, `risky`, `unknown`                                                                          |
| Non-success signal | `status !== 'success'` in body                                    | HTTP `4xx` / `5xx` status codes                                                                            |
| Timeout/retry hint | none                                                              | optional `retryAfter` field in body                                                                        |

---

## Files to Change

### 1. `apps/web/src/lib/config.server.ts`

- Remove: `export const NEVERBOUNCE_API_KEY = getEnvVariable('NEVERBOUNCE_API_KEY');`
- Add: `export const BOUNCER_API_KEY = getEnvVariable('BOUNCER_API_KEY');`

### 2. `apps/web/src/lib/email-neverbounce.ts` → rename to `email-bouncer.ts`

Rewrite the module:

- Import `BOUNCER_API_KEY` from config instead of `NEVERBOUNCE_API_KEY`.
- Update the API URL to `https://api.usebouncer.com/v1.1/email/verify`.
- Move auth from a query param to an `x-api-key` request header.
- Replace the `NeverBounceResult`/`NeverBounceResponse` types with Bouncer's
  response shape:
  ```ts
  type BouncerStatus = 'deliverable' | 'risky' | 'undeliverable' | 'unknown';
  type BouncerResponse = {
    email: string;
    status: BouncerStatus;
    reason: string;
    domain?: {
      disposable: 'yes' | 'no' | 'unknown';
      // other fields omitted
    };
  };
  ```
- Update block logic:
  ```ts
  // Block undeliverable addresses and confirmed disposable domains.
  // risky, unknown, and deliverable are all allowed through.
  const isBlocked = data.status === 'undeliverable' || data.domain?.disposable === 'yes';
  ```
- Replace the body-level `status !== 'success'` check with HTTP status code
  checks (already handled by the existing `!response.ok` guard — just remove
  the body-status check entirely).
- Retain all existing behaviour for:
  - Missing API key → return `true` (fail-open).
  - Bypass domains (`icloud.com`, `me.com`) → return `true`.
  - `AbortSignal.timeout(5_000)` → keep unchanged (see Timeout Decision above).
  - Any fetch/network error or non-OK HTTP response → return `true` (fail-open),
    capture to Sentry.
- Update Sentry tags from `source: 'neverbounce'` to `source: 'bouncer'`.
- Update all log prefixes from `[neverbounce]` to `[bouncer]`.

### 3. `apps/web/src/lib/email.ts`

- Update import: `from '@/lib/email-bouncer'` (after file rename).
- Rename the `SendResult` rejection reason:
  `'neverbounce_rejected'` → `'bouncer_rejected'`

### 4. `apps/web/src/app/api/auth/magic-link/route.ts`

- Update the rejection reason check:
  `result.reason === 'neverbounce_rejected'` → `result.reason === 'bouncer_rejected'`

### 5. `apps/web/src/routers/admin/email-testing-router.ts`

- Update import to `from '@/lib/email-bouncer'`.
- Update the error message string:
  `'Email blocked by NeverBounce verification...'` →
  `'Email blocked by Bouncer verification. This address is undeliverable or disposable.'`

### 6. `apps/web/src/lib/kiloclaw/billing-lifecycle-cron.ts`

- Update the comment referencing `neverbounce_rejected` to `bouncer_rejected`.

### 7. `apps/web/src/lib/email-neverbounce.test.ts` → rename to `email-bouncer.test.ts`

Rewrite tests:

- Mock `BOUNCER_API_KEY` instead of `NEVERBOUNCE_API_KEY`.
- Replace `mockNeverBounceResponse` helper to return Bouncer's response shape
  (`status` + optional `domain.disposable`).
- Update test cases:
  - `deliverable` → returns `true`
  - `risky` → returns `true` (explicitly assert this — it's a decision)
  - `unknown` → returns `true`
  - `undeliverable` → returns `false`, Sentry captured
  - `deliverable` with `domain.disposable === 'yes'` → returns `false`, Sentry captured
  - HTTP 402 (out of credits) → returns `true` (fail-open), Sentry captured
  - HTTP 429 (rate limited) → returns `true` (fail-open), Sentry captured
  - Network error → returns `true` (fail-open), Sentry captured
  - No API key → returns `true`, no fetch
  - Bypass domains (`icloud.com`, `me.com`) → returns `true`, no fetch
- Update the URL/auth assertion: check that the request is made to
  `https://api.usebouncer.com/v1.1/email/verify?email=...` with an
  `x-api-key` header (not a `key` query param).

---

## Environment / Secrets

- Add `BOUNCER_API_KEY` to Vercel environment variables (all environments).
- Remove `NEVERBOUNCE_API_KEY` from Vercel once the deploy is confirmed healthy.
- Update `.env.example` or equivalent documentation if present.

---

## Verification

```
pnpm typecheck
pnpm test -- apps/web/src/lib/email-bouncer.test.ts
```

Smoke-test via the admin email testing panel (send a test to a known-good and
a known-bad address) after deploying to staging.

# Rate Limiting Audit

Comprehensive audit of all rate limiting, throttling, and IP-based limits configured across the gateway codebase.

## Summary Table

| Rate Limit | Value | Scope | User Type | Store | HTTP Status | Config Source |
|---|---|---|---|---|---|---|
| Free model IP limit | 200 req / 1 hour | Per-IP | All (anonymous + authenticated) | PostgreSQL `free_model_usage` | 429 | Hardcoded constant |
| Promotion anonymous limit | 10,000 req / 24 hours | Per-IP, anonymous only | Anonymous (unauthenticated) only | PostgreSQL `free_model_usage` | 401 (see note) | Hardcoded constant |
| Deploy dispatcher login | 6 req / 60 seconds | Per-IP per-worker | All login attempts | Cloudflare RateLimit binding | 429 | Wrangler config |
| Device auth IP limit | 5 pending requests | Per-IP | All device auth users | PostgreSQL `device_auth_requests` | Error thrown | Hardcoded constant |
| Webhook in-flight limit | 20 concurrent | Per-trigger | Per webhook trigger | Durable Object SQLite | 429 | Hardcoded constant |
| Abuse detection | Dynamic (velocity/spend heuristics) | User/IP/fingerprint | All users | External service | Not yet enforced | Env vars |

## 1. Free Model IP-Based Rate Limit

**The primary rate limiter for the LLM proxy.**

- **Limit:** 200 requests per 1-hour sliding window
- **Scope:** IP address (extracted from `x-forwarded-for` header)
- **Applies to:** ALL users — both anonymous and authenticated — using Kilo-hosted free models
- **Store:** PostgreSQL `free_model_usage` table (indexed on `ip_address, created_at`)
- **Response:** HTTP 429 with `"Free model usage limit reached"`

### Configuration

```
src/lib/constants.ts:50-52
```

```typescript
export const FREE_MODEL_RATE_LIMIT_WINDOW_HOURS = 1;
export const FREE_MODEL_MAX_REQUESTS_PER_WINDOW = 200;
```

No environment variables — values are hardcoded.

### Implementation

- Rate check: `src/lib/free-model-rate-limiter.ts:42` — `checkFreeModelRateLimit(ipAddress)`
- Usage logging: `src/lib/free-model-rate-limiter.ts:72` — `logFreeModelRequest(ipAddress, model, kiloUserId?)`
- Enforcement: `src/app/api/openrouter/[...path]/route.ts:190-204` — checked before auth for free models
- IP extraction: `src/app/api/openrouter/[...path]/route.ts:182` — first value from `x-forwarded-for`

### Cloud Agent Impact

**This is an IP-based limit that applies equally to all users sharing the same IP.** Cloud agents making requests from shared infrastructure IPs could collectively exhaust the 200 req/hour limit. Since the limit is checked before authentication, even authenticated paid users on shared IPs are affected when using free models.

### Notable Exemptions

Slackbot-only models are exempt from this rate limit since they're gated behind Slack integration auth (`src/app/api/openrouter/[...path]/route.ts:188-189`).

## 2. Promotion / Anonymous User Rate Limit

**Additional limit for unauthenticated users using free models.**

- **Limit:** 10,000 requests per 24-hour sliding window
- **Scope:** IP address, counting only anonymous requests (`kilo_user_id IS NULL`)
- **Applies to:** Anonymous (unauthenticated) users only
- **Store:** PostgreSQL `free_model_usage` table
- **Response:** HTTP 401 (not 429) with `"Sign up for free to continue and explore 500 other models."`

### Configuration

```
src/lib/constants.ts:57-58
```

```typescript
export const PROMOTION_MAX_REQUESTS = 10000;
export const PROMOTION_WINDOW_HOURS = 24;
```

No environment variables — values are hardcoded.

### Implementation

- Rate check: `src/lib/free-model-rate-limiter.ts:57` — `checkPromotionLimit(ipAddress)`
- Enforcement: `src/app/api/openrouter/[...path]/route.ts:238-258` — checked when auth fails
- Uses HTTP 401 instead of 429 — see TODO at line 257: *"Change to 429 once the extension supports it"*

### Stale Documentation

The admin page at `src/app/admin/free-model-usage/page.tsx:49` mentions "600 requests/day" — this is outdated; the actual limit is 10,000/24h.

## 3. Deploy Dispatcher Login Rate Limit

**Protects the Cloudflare deploy infrastructure login endpoint.**

- **Limit:** 6 requests per 60 seconds
- **Scope:** Per-IP, per-worker (key: `{workerName}:{clientIp}`)
- **Applies to:** All login attempts to deploy-infra password-protected workers
- **Store:** Cloudflare's native `RateLimit` binding
- **Response:** HTTP 429 with `"Too many failed attempts. Please try again in a minute."`

### Configuration

```
cloudflare-deploy-infra/dispatcher/wrangler.jsonc:22-28 (production)
cloudflare-deploy-infra/dispatcher/wrangler.jsonc:73-78 (staging)
```

Both production and staging use `{ "limit": 6, "period": 60 }`.

### Implementation

- Middleware: `cloudflare-deploy-infra/dispatcher/src/auth/rate-limit.ts:25-49`
- IP extraction: Uses `CF-Connecting-IP` header (line 14)
- Applied to: `POST /__auth` route (`cloudflare-deploy-infra/dispatcher/src/routes/auth.ts:51`)

## 4. Device Auth IP Rate Limit

**Prevents abuse of the device authorization flow.**

- **Limit:** 5 concurrent pending requests per IP
- **Scope:** Per-IP (counts pending `device_auth_requests` rows)
- **Applies to:** All device auth users
- **Store:** PostgreSQL `device_auth_requests` table

### Configuration

```
src/lib/device-auth/device-auth.ts:10
```

```typescript
const MAX_PENDING_REQUESTS_PER_IP = 5;
```

### Implementation

- Check: `src/lib/device-auth/device-auth.ts:42-57`
- Throws `"Too many pending authorization requests from this IP"` when limit reached
- IP required in production (line 38)

## 5. Webhook Agent In-Flight Request Limit

**Prevents webhook triggers from accumulating too many concurrent requests.**

- **Limit:** 20 concurrent in-flight requests per trigger
- **Scope:** Per-trigger (Durable Object)
- **Store:** Durable Object SQLite

### Configuration

```
cloudflare-webhook-agent-ingest/src/util/constants.ts:9-12
```

```typescript
export const MAX_REQUESTS = 100;         // max retained per trigger
export const MAX_INFLIGHT_REQUESTS = 20; // max concurrent per trigger
```

### Implementation

- Check: `cloudflare-webhook-agent-ingest/src/dos/TriggerDO.ts:420-428`
- Enforcement: `cloudflare-webhook-agent-ingest/src/routes/inbound.ts:127-128` — returns HTTP 429

## 6. Abuse Detection Service (Observe-Only)

**External service that classifies requests for abuse patterns. Currently in observe-only mode.**

- **Signals detected:** `high_velocity`, `free_tier_exhausted`, `premium_harvester`, `suspicious_fingerprint`, `datacenter_ip`, `known_abuser`
- **Verdicts:** `ALLOW`, `CHALLENGE`, `SOFT_BLOCK`, `HARD_BLOCK`
- **Current status:** Logs verdicts but does not enforce them (see `src/lib/abuse-service.ts:304`)

### Environment Variables

- `ABUSE_SERVICE_URL` — defaults to `https://abuse.kiloapps.io` in production (`src/lib/config.server.ts:129-148`)
- `ABUSE_SERVICE_CF_ACCESS_CLIENT_ID` — required in production
- `ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET` — required in production

### Integration

- Called non-blocking before proxying: `src/app/api/openrouter/[...path]/route.ts:311`
- Awaited with 2-second timeout: `src/app/api/openrouter/[...path]/route.ts:522-527`

The `datacenter_ip` signal is relevant for cloud agents — the abuse service could flag requests from known datacenter IP ranges, though no enforcement action is currently taken.

## 7. BYOK (Bring Your Own Key) 429 Pass-Through

When upstream providers rate-limit a user's own API key, the gateway passes through a descriptive error:

```
src/lib/llm-proxy-helpers.ts:121
```

```
429: '[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.'
```

This is not a gateway-imposed limit — it's upstream pass-through.

## Per-Model Rate Limits

**There are no per-model rate limits.** The free model IP limit applies uniformly to all free models (GLM, MiniMax, etc.). Models like `z-ai/glm-5:free` and `minimax/minimax-m2.5:free` are subject to the same 200 req/hour IP-based limit as any other free model.

## Free vs Authenticated vs Paid User Comparison

| Scenario | Free Model IP Limit | Promotion Limit | Paid Model Access |
|---|---|---|---|
| Anonymous user, free model | 200/hour (IP) | 10,000/24h (IP, anon-only) | No access (401) |
| Authenticated free user, free model | 200/hour (IP) | N/A (authenticated) | No access (401) |
| Authenticated paid user, free model | 200/hour (IP) | N/A (authenticated) | Full access |
| Authenticated paid user, paid model | N/A (not a free model) | N/A | Full access |

**Key observations:**
- Paid users are not exempt from the free model IP limit when using free models
- There are no per-user rate limits — all limits are IP-based
- There are no rate limits on paid model usage (beyond the abuse detection service, which is observe-only)

## Architectural Notes

- **No Redis:** All rate limiting uses PostgreSQL or Cloudflare's native rate limiting. No Redis-based stores.
- **No environment-variable-controlled thresholds:** All rate limit values are hardcoded constants. Changing limits requires a code deployment.
- **IP extraction:** The main proxy uses `x-forwarded-for` header; the deploy dispatcher uses Cloudflare's `CF-Connecting-IP` header.
- **Pre-auth check:** The free model rate limit runs before authentication, meaning rate-limited IPs are blocked even before the system knows who the user is.

## Potential Issues for Cloud Features

1. **Shared IP exhaustion:** Cloud agents running from shared infrastructure IPs share the 200 req/hour free model limit. Multiple users' agents on the same IP could collectively exhaust this limit.
2. **Datacenter IP flagging:** The abuse service detects `datacenter_ip` as a signal. If enforcement is enabled in the future, cloud agents from datacenter IPs could be flagged.
3. **No user-level override:** Since limits are purely IP-based with no per-user exemptions, there is no mechanism to whitelist specific users or service accounts from IP-based limits.

# Wasteland Service — Monitoring & Alert Conditions

This document lists the alert conditions that should be configured for the
Wasteland service. These are recommendations — implementation depends on
the monitoring platform (e.g. Grafana, Datadog, Cloudflare Analytics).

## Health Endpoint

`GET /health` returns:

```json
{
  "status": "ok",
  "version": "<CF_VERSION_METADATA.id>",
  "activeWastelands": 42,
  "trpcHealthy": true,
  "sentryConfigured": true,
  "analyticsEngineConfigured": true
}
```

Monitor this endpoint for availability and to detect configuration drift
(e.g. Sentry DSN missing after a deploy).

## Alert Conditions

### Container start failure rate > 5%

- **Source:** Analytics Engine events where `event = 'container.start'` and `error IS NOT NULL`
- **Window:** 5 minutes rolling
- **Threshold:** error_count / total_count > 0.05
- **Severity:** Critical
- **Action:** Check Cloudflare Container logs, verify image availability

### DoltHub API error rate > 10%

- **Source:** Analytics Engine events where `event IN ('wanted.browse', 'wanted.claim', 'wanted.done', 'wanted.post', 'wanted.sync')` and `error IS NOT NULL`
- **Window:** 10 minutes rolling
- **Threshold:** error_count / total_count > 0.10
- **Severity:** Warning
- **Action:** Check DoltHub API status, review credential validity

### Claim/done operation latency p95 > 30s

- **Source:** Analytics Engine `durationMs` (double1) for events `wasteland.claimWantedItem` and `wasteland.markWantedItemDone`
- **Window:** 15 minutes rolling
- **Threshold:** p95(durationMs) > 30000
- **Severity:** Warning
- **Action:** Investigate container cold starts, DoltHub API latency, or large repo sizes

### Container cold start rate > 20% of requests

- **Source:** Analytics Engine events where `event = 'container.cold_start'` vs total container requests
- **Window:** 15 minutes rolling
- **Threshold:** cold_start_count / total_request_count > 0.20
- **Severity:** Warning
- **Action:** Review container keep-alive settings, alarm scheduling, request patterns

### WastelandDO alarm failure (wanted board not refreshing)

- **Source:** Analytics Engine events where `event = 'wanted.sync'`
- **Window:** Check every 30 minutes
- **Threshold:** No `wanted.sync` events in the last 30 minutes for an active wasteland with a configured DoltHub upstream
- **Severity:** Warning
- **Action:** Inspect DO alarm scheduling, check for DO eviction or crash loops

## Rate Limits

Per-user rate limits are enforced at the tRPC middleware layer:

| Operation             | Limit     |
|-----------------------|-----------|
| `claimWantedItem`     | 10/min    |
| `markWantedItemDone`  | 10/min    |
| `postWantedItem`      | 5/min     |
| `browseWantedBoard`   | 60/min    |

Rate limit violations return HTTP 429 (`TOO_MANY_REQUESTS`). Monitor the
rate of 429 responses to detect abuse or misconfigured clients.

## Sentry Integration

Error tracking is configured with:
- Custom tags: `operation`, `userId`, `wastelandId`
- Breadcrumbs for key operations: create, claim, done, post, delete, storeCredential
- Trace sampling at 10% (`tracesSampleRate: 0.1`)

All non-TRPCError exceptions are captured automatically. TRPCErrors
(expected user-facing errors) are not sent to Sentry to reduce noise.

## Analytics Engine Events

All tRPC procedures emit analytics events with:
- `event`: procedure path (e.g. `wasteland.claimWantedItem`)
- `delivery`: `trpc` or `http`
- `userId`, `wastelandId`: for filtering
- `durationMs`: request latency
- `error`: error message if the request failed

Use Cloudflare Analytics Engine SQL API to query these events for
dashboards and alerting.

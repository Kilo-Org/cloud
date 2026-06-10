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

### DoltHub API error rate > 10%

- **Source:** Analytics Engine events where `event IN ('wasteland.browseWantedBoard', 'wasteland.claimWantedItem', 'wasteland.markWantedItemDone', 'wasteland.postWantedItem', 'wasteland.acceptWantedItem', 'wasteland.rejectWantedItem', 'wasteland.closeWantedItem', 'wasteland.publishBranch', 'wasteland.discardBranch', 'wasteland.listMyForkBranches', 'wasteland.listMyPulls', 'wasteland.joinWasteland', 'wasteland.resolveOwnerRepo')` and `error IS NOT NULL`
- **Window:** 10 minutes rolling
- **Threshold:** error_count / total_count > 0.10
- **Severity:** Warning
- **Action:** Check DoltHub API status, review credential validity

### Wanted-board op latency p95 > 30s

- **Source:** Analytics Engine `durationMs` (double1) for events `wasteland.claimWantedItem`, `wasteland.markWantedItemDone`, `wasteland.publishBranch`
- **Window:** 15 minutes rolling
- **Threshold:** p95(durationMs) > 30000
- **Severity:** Warning
- **Action:** Investigate DoltHub API latency or large repo sizes

### Join failure rate > 5%

- **Source:** Analytics Engine events where `event = 'wasteland.joinWasteland'` and `error IS NOT NULL`
- **Window:** 10 minutes rolling
- **Threshold:** error_count / total_count > 0.05
- **Severity:** Warning
- **Action:** Check DoltHub fork API, review the join PR registration path

### WastelandDO alarm failure (cache not refreshing)

- **Source:** Analytics Engine events where `event = 'wasteland.browseWantedBoard'`
- **Window:** Check every 30 minutes
- **Threshold:** No browse traffic for an active wasteland with a configured DoltHub upstream
- **Severity:** Warning
- **Action:** Inspect DO alarm scheduling, check for DO eviction or crash loops

## Rate Limits

Per-user rate limits are enforced at the tRPC middleware layer
(`src/util/rate-limit.util.ts`):

| Operation | Limit |
|---|---|
| `wasteland.claimWantedItem` | 10/min |
| `wasteland.markWantedItemDone` | 10/min |
| `wasteland.postWantedItem` | 5/min |
| `wasteland.browseWantedBoard` | 60/min |

Other procedures — including `joinWasteland`, `listMyForkBranches`,
`discardBranch`, `publishBranch`, `listMyPulls`, and `resolveOwnerRepo` —
are not rate-limited at this layer. Add entries to `RATE_LIMITS` if a
hot user-facing call appears in monitoring.

Rate limit violations return HTTP 429 (`TOO_MANY_REQUESTS`). Monitor the
rate of 429 responses to detect abuse or misconfigured clients.

## Sentry Integration

Error tracking is configured with:

- Custom tags: `operation`, `userId`, `wastelandId`
- Breadcrumbs for key operations: `createWasteland`, `claimWantedItem`,
  `markWantedItemDone`, `postWantedItem`, `deleteWasteland`,
  `storeCredential`, `connectKiloTown`, `disconnectKiloTown`
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

The full procedure surface (see `src/trpc/router.ts`) is:

- Wasteland lifecycle: `createWasteland`, `joinWasteland`,
  `deleteWasteland`, `listWastelands`, `getWasteland`,
  `resolveOwnerRepo`, `updateWastelandConfig`
- Membership: `listMembers`, `addMember`, `removeMember`, `updateMember`
- Credentials: `storeCredential`, `getCredentialStatus`,
  `setUpstreamAdmin`, `deleteCredential`, `verifyUpstreamAdmin`
- Town wiring: `connectKiloTown`, `disconnectKiloTown`,
  `listConnectedTowns`
- Wanted-board reads: `browseWantedBoard`, `getWantedItem`,
  `listMyPendingClaims`
- Branch / PR (fork views): `listMyForkBranches`, `discardBranch`,
  `publishBranch`, `listMyPulls`
- Wanted-board mutations: `claimWantedItem`, `unclaimWantedItem`,
  `postWantedItem`, `markWantedItemDone`, `acceptWantedItem`,
  `rejectWantedItem`, `closeWantedItem`
- Upstream PR management: `mergeUpstreamPR`, `closeUpstreamPR`,
  `commentOnUpstreamPR`
- Inbox / activity: `listInboxItems`, `listRigActivity`
- Rig trust: `listUpstreamRigs`, `getRig`, `setUpstreamRigTrust`
- Upstream bootstrap: `createUpstream`

Use Cloudflare Analytics Engine SQL API to query these events for
dashboards and alerting.

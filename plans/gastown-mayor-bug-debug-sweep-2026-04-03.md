# Mayor bug debug sweep artifact (2026-04-03)

This document captures the end-to-end investigation requested for open GitHub issues matching:

- `state:open label:gt:mayor label:bug`
- Repo: `Kilo-Org/cloud`

## Scope and issue set

Open issues at sweep start:

- #1956 `[Gastown] Repeated re-escalation events emitted after incident fully resolved`
- #1823 `[Gastown] Convoy closed without landing feature branch to target branch`
- #1818 `fix(gastown): Mayor cannot access rig directories without explicit permission grant`
- #1817 `fix(gastown): Mayor requires manual /team reconnect after container restart`
- #1756 `fix(gastown): Mayor loses org billing context after model change — bills to personal account`
- #1640 `Basically not loading or working`
- #1535 `"copy to clipboard" broken`

## Documentation and auth model used

Source docs on branch `gastown-staging`:

- `cloudflare-gastown/docs/post-deploy-monitoring.md`
- `cloudflare-gastown/docs/local-debug-testing.md`

Auth requirements validated from docs and runtime:

- Staging debug endpoints require Cloudflare Access service token headers:
  - `CF-Access-Client-Id`
  - `CF-Access-Client-Secret`
- Unauthenticated debug request result:
  - `GET /debug/towns/8a6f9375-b806-4ee0-ad6e-1697ea2dbfff/status`
  - `HTTP/2 302`
  - `CF-Ray: 9e676c008c5a55c1-DFW`
  - Redirect target: Cloudflare Access login URL

## Reproducible diagnostics executed

Base URL:

- `https://gastown.kiloapps.io`

Primary endpoints used per town:

- `GET /debug/towns/:townId/status`
- `GET /debug/towns/:townId/drain-status`
- `GET /debug/towns/:townId/nudges`

Sample command shape:

```bash
curl -s \
  -H "CF-Access-Client-Id: $GASTOWN_SERVICE_CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $GASTOWN_SERVICE_CF_ACCESS_CLIENT_SECRET" \
  "https://gastown.kiloapps.io/debug/towns/<town-id>/status"
```

### Captured endpoint evidence

Timestamp block: `2026-04-03T10:34:13Z`.

Town `8a6f9375-b806-4ee0-ad6e-1697ea2dbfff`:

- `/status`: `HTTP/2 200`, `CF-Ray: 9e676b684bd355c1-DFW`
  - `agents={working:1,waiting:1,idle:4,stalled:0,dead:0,total:6}`
  - `beads={open:8,inProgress:1,inReview:0,failed:2,triageRequests:5}`
  - `patrol={guppWarnings:0,guppEscalations:0,stalledAgents:0,orphanedHooks:0}`
  - `reconciler={invariantViolations:0,...}`
- `/drain-status`: `HTTP/2 200`, `CF-Ray: 9e676b689c4b55c1-DFW`
  - `{"draining":false,"drainNonce":null}`
- `/nudges`: `HTTP/2 200`, `CF-Ray: 9e676b68ecb255c1-DFW`
  - `nudge_count=20` with historical/stale-looking nudges present.

Town `98172328-9bd1-4b59-ba3e-0ae627058e6b`:

- `/status`: `HTTP/2 200`, `CF-Ray: 9e676b693d0055c1-DFW`
  - `beads={open:0,inProgress:0,inReview:0,failed:0,triageRequests:0}`
  - `reconciler.invariantViolations=1`
- `/drain-status`: `HTTP/2 200`, `CF-Ray: 9e676b699d7055c1-DFW`
  - `{"draining":false,"drainNonce":null}`

Town `93c4e3d9-12ec-472c-9eb3-a2b0075b3c1e`:

- `/status`: `HTTP/2 200`, `CF-Ray: 9e676b6a2e6955c1-DFW`
  - `agents.total=0`
  - `beads={open:0,inProgress:0,inReview:0,failed:0,triageRequests:0}`
  - `alarm.intervalLabel="idle (5m)"`
  - `reconciler=null`
- `/drain-status`: `HTTP/2 200`, `CF-Ray: 9e676b6cd9e455c1-DFW`
  - `{"draining":false,"drainNonce":null}`

## Per-issue outcomes posted

Fresh evidence comments posted on each issue:

- #1956 comment: `https://github.com/Kilo-Org/cloud/issues/1956#issuecomment-4182935126`
- #1823 comment: `https://github.com/Kilo-Org/cloud/issues/1823#issuecomment-4182935134`
- #1818 comment: `https://github.com/Kilo-Org/cloud/issues/1818#issuecomment-4182935136`
- #1817 comment: `https://github.com/Kilo-Org/cloud/issues/1817#issuecomment-4182936017`
- #1756 comment: `https://github.com/Kilo-Org/cloud/issues/1756#issuecomment-4182936010`
- #1640 comment: `https://github.com/Kilo-Org/cloud/issues/1640#issuecomment-4182936736`
- #1535 comment: `https://github.com/Kilo-Org/cloud/issues/1535#issuecomment-4182936735`

Consolidated in-thread summary artifact:

- #1956 summary comment: `https://github.com/Kilo-Org/cloud/issues/1956#issuecomment-4182937367`

## Final issue state, confidence, owner recommendation

- #1956: partially confirmed, confidence `medium`, owner `gt:core` (secondary `gt:mayor`)
- #1823: unconfirmed from current runtime endpoints, confidence `low`, owner `gt:core`
- #1818: unconfirmed from current runtime endpoints, confidence `low`, owner `gt:container` (secondary `gt:mayor`)
- #1817: unconfirmed from current runtime endpoints, confidence `low`, owner `gt:container` (secondary `gt:mayor`)
- #1756: unconfirmed from current runtime endpoints, confidence `low`, owner `gt:core` + `gt:container`
- #1640: confirmed, confidence `high`, owner `gt:core` (secondary impact `gt:mayor`)
- #1535: unconfirmed from server-side endpoints, confidence `medium`, owner `gt:ui`

## Accessibility gaps explicitly recorded

These checks could not be fully confirmed with currently exposed debug payloads:

- mayor permission profile (`external_directory allow/ask`)
- team/provider auth connected state after restart
- effective org billing routing context by agent session
- browser clipboard success/failure telemetry

Each issue note includes the exact inaccessible evidence path and recommended next instrumentation.

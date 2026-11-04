# scim-sync

Polls the [WorkOS Events API](https://workos.com/docs/events/data-syncing/events-api)
for Directory Sync (SCIM) events and logs each one.

**Observe-only.** Nothing is written to Postgres, and no users, organizations,
or memberships are mutated. The cursor is configuration, not state: see
"Cursor" below.

## How it runs

A Durable Object alarm reschedules itself after every poll, so the loop
continues indefinitely without an external trigger. The object hibernates
between ticks, so it is not billed for the waiting time — an always-in-memory
poller would cost roughly 300x more duration for the same work.

| | |
|---|---|
| Interval | `SCIM_POLL_INTERVAL_SECONDS`, default 60, clamped to 10..3600 |
| Page size | 10 events per poll |
| Event filter | all 10 `dsync.*` types |
| Watchdog | `*/5 * * * *` cron calling `ensureScheduled()` |

The cron only re-arms a loop that died, for example an eviction whose alarm
retries were exhausted. `ensureScheduled()` leaves a live alarm untouched.

The interval is read on every alarm, so changing it takes effect on the first
tick after a deploy. A blank or unparseable value falls back to 60 seconds. The
10-second floor exists because a shorter interval would leave no idle window for
hibernation, billing the object's full 128 MB allocation continuously.

## Cursor

`WORKOS_EVENT_CURSOR` is passed as the Events API `after` parameter. Empty means
the request is made without `after`, which returns the oldest available events.

**The cursor does not advance.** It is re-read from configuration on every
tick, so the same events are logged repeatedly until the value is changed and
the Worker redeployed. Each poll logs `lastEventId`, and `/status` reports it, so
the value can be copied forward by hand.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Worker liveness. Does not touch the Durable Object. |
| `GET /status` | Interval, cursor, next alarm time, and the last poll result. |

Both routes are unauthenticated, so the Worker has no *HTTP* ingress: no
`workers_dev` hostname, no `routes`, and no service binding. Neither route is
callable in production; read the poll output from Workers Logs, or stream it
with `wrangler tail` — unlike the previous iteration, there is now traffic to
see, because the cron trigger and the alarm both invoke the Worker. Add
authentication before exposing either route.

## Logging

Only envelope fields are logged: `eventId`, `eventType`, and `eventCreatedAt`.
An event's `data` carries directory user attributes — emails, names, raw IdP
attributes — and is never logged.

## WorkOS client

Uses `@workos-inc/node` (catalog-pinned) rather than hand-rolled requests: its
`exports` map has a first-class `workerd` condition resolving to a
`fetch`-based client with no runtime dependencies, and it supplies the `Event`
and `EventName` types so no local schema is needed. The client is constructed
with `maxRetries: 0`, because the SDK's internal retries would stretch one alarm
across several attempts and hide the failure — the alarm interval is the retry.

The SDK costs about 500 KiB of bundle (93 KiB gzipped) against a 3 MiB limit.

## Secrets

`WORKOS_API_KEY` and `WORKOS_CLIENT_ID` come from the shared Cloudflare Secrets
Store. A single key per name, not per environment: the Events API is scoped to
whichever WorkOS environment issued the key, so that environment's stream is the
only one any deployment reads.

For local work, create the same two names in the local store — omit `--remote`
and wrangler writes to `.wrangler/`:

```sh
npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 \
  --name WORKOS_API_KEY --scopes workers
```

## Commands

```sh
pnpm dev         # wrangler dev --env dev, port 8819
pnpm typecheck
pnpm types       # regenerate worker-configuration.d.ts after config changes
```

`wrangler dev` does not fire cron triggers, so arm the loop by hand:

```sh
curl http://127.0.0.1:8819/cdn-cgi/local/scheduled
```

There are no tests. The poll has one branch worth asserting — the interval
clamp — and everything else is the SDK's behavior or WorkOS's; tests arrive with
the cursor persistence that has real invariants.

## Deployment

Deployed by `deploy-workers.yml`, which auto-discovers any `services/*` folder
containing a `wrangler.jsonc`. The scheduled `deploy-production.yml` run
(`7,27,47 * * * *`) picks up changes once the merge commit is green in CI. No
`env.staging` block, so `deploy-staging.yml` skips this Worker, matching every
other Worker except `usage-ingest`.

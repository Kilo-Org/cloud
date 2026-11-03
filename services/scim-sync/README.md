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
| `GET /status` | Interval, cursor, next alarm time, the last poll result, and PostgreSQL reachability. |

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

## Database

Reads the shared PostgreSQL through the `HYPERDRIVE` binding — the same
instance and Hyperdrive config as every other service in this repo. Workers
cannot hold long-lived connections, so Hyperdrive owns the regional pool and
`getPgDb` opens a `max: 1` pool per call against the string it hands out.

**Read-only for now.** The query modules under `src/db/` only select; nothing
writes. The poll loop does not use them yet, so `/status` is their only caller.

`getPgDb` must be called per operation and never cached in module scope. A
cached client outlives the request or Durable Object context that created it,
and its I/O then fails in whatever context picks it up next. Calling per use is
also why the probe recovers on its own after a database restart.

Four schema facts the query modules encode, each easy to get wrong:

- **`organizations.deleted_at IS NULL` on every org query.** The unique indexes
  on `directory_group_id` and `external_org_id` are *partial*, scoped to live
  rows, so a soft-deleted organization can hold the same binding as a live one.
  Omit the filter and those lookups stop being deterministic.
- **`organization_memberships` has no foreign keys** on either column, so a row
  does not prove the organization or user exists, and neither side is cleaned
  up when the other goes away.
- **`kilocode_users.external_id` is not unique**, so `findUsersByExternalId`
  returns an array. A caller needing exactly one must decide what a duplicate
  means rather than taking the first row.
- **User IDs are `text`, not `uuid`** — OAuth IDs look like `oauth/…`. Never
  validate, parse, or cast one as a UUID.

Group assignments are the exception to the missing-FK rule: a composite foreign
key on `(organization_id, kilo_user_id)` points at `organization_memberships`,
so an assignment cannot exist without a membership and is cascaded away with it.

Timestamps come back as strings shaped `2026-04-29 01:16:12.945+00`, which
strict ISO validators such as `z.string().datetime()` reject. Normalize before
sending them across a strict boundary.

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

```sh
pnpm test:postgres   # query modules against a real database
```

Needs a running local PostgreSQL (`dev/docker-compose.yml`) with migrations
applied. If a query fails on a missing column, the local database is behind the
schema:

```sh
POSTGRES_URL='postgres://postgres:postgres@localhost:5432/postgres' \
  NODE_ENV=development pnpm drizzle migrate
```

The poll loop itself has no tests: its one branch worth asserting is the
interval clamp, and everything else is the SDK's behavior or WorkOS's.

## Deployment

Deployed by `deploy-workers.yml`, which auto-discovers any `services/*` folder
containing a `wrangler.jsonc`. The scheduled `deploy-production.yml` run
(`7,27,47 * * * *`) picks up changes once the merge commit is green in CI. No
`env.staging` block, so `deploy-staging.yml` skips this Worker, matching every
other Worker except `usage-ingest`.

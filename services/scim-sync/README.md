# scim-sync

Polls the [WorkOS Events API](https://workos.com/docs/events/data-syncing/events-api)
for Directory Sync (SCIM) events, logs each event's envelope, and persists the
stream cursor in Durable Object SQLite.

This iteration is observe-only: it writes nothing to Postgres and mutates no
users, organizations, or memberships.

## Why a Durable Object

The Events API is environment-scoped (one API key = one stream) and WorkOS
prescribes a **single serial consumer** that advances one cursor. That is a
single coordination atom, so the service runs exactly one DO instance,
`WORKOS_EVENT_SYNC_DO.getByName('workos-events')`, holding the cursor in its own
SQLite database. A stateless Worker could not keep the cursor consistent under
concurrent invocations.

## Poll loop

| Property | Value |
|---|---|
| Steady-state interval | 60s, via a self-rescheduling DO alarm |
| Page size | 100 (`limit`, the API maximum) |
| Pages per tick | 10 max, then an immediate re-poll if a backlog remains |
| Event filter | all 10 `dsync.*` types (`src/workos/events.ts`) |
| Cold start | `range_start` = the instant the stream was first entered |
| Watchdog | `*/5 * * * *` cron calling `ensureScheduled()` |

Worst case throughput is 1000 events/minute of catch-up, at roughly 0.17% of the
documented 6000 requests/minute key budget.

The cron is only a watchdog. The DO reschedules itself after every poll;
`ensureScheduled()` is a no-op when an alarm is already armed, so the cron
matters solely when the alarm chain dies (DO eviction with exhausted alarm
retries).

## Cursor invariants

- The cursor advances from `data[data.length - 1].id`, **never** from
  `list_metadata.after`. That field is `null` on an empty or final page, and
  writing the null back would rewind the poller to the start of the 90-day
  retention window on the next tick.
- The cursor is committed after each page, so a mid-tick failure never replays
  events that were already logged.
- `range_start` is persisted before the first request, so a crash during the
  very first tick cannot slide the window forward and skip events.
- `after` and `range_start` are mutually exclusive in the API, so the stream
  position is a union type, not two optional fields.

## Failure handling

| Upstream result | Behavior |
|---|---|
| 429 / 5xx | Retry with the **same** cursor. Honors `Retry-After`, else jittered exponential backoff from 5s to 15min. |
| 400 / 422 (rejected cursor) | Drop the cursor, re-enter via `range_start`, log at error. Never retried against the same bad value, because it can never succeed. |
| 401 / 403 | Log the specific reason once with the WorkOS `x-request-id`, then back off 10 minutes. An unusable key cannot recover without an operator, so a 60s retry would only burn quota and flood logs. |
| Empty page | Treated as caught up. Cursor untouched. |

## Logging

Only envelope fields are logged: `eventId`, `eventType`, `eventCreatedAt`, the
sorted key names of `data`, and the WorkOS `x-request-id`. The `data` payload
itself carries directory-user attributes (emails, names, raw IdP attributes) and
is never logged.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /status` | Cursor, stream-entry instant, lifetime event count, consecutive failures, last error, next alarm |

## Secrets

`WORKOS_API_KEY` comes from the shared Cloudflare Secrets Store
(`WORKOS_API_KEY_PROD` / `WORKOS_API_KEY_DEV`). **Both secrets must exist in the
store before this Worker first deploys**, or `wrangler deploy` fails on the
missing binding. Locally, `.dev.vars` supplies it (see `.dev.vars.example`); the
key is environment-scoped, so a dev key tails the WorkOS dev environment's
stream.

## Commands

```sh
pnpm dev                 # wrangler dev --env dev, port 8819
pnpm test                # unit + Durable Object suites (what CI runs)
pnpm test:unit           # unit only, in Node
pnpm test:integration    # DO tests only, in the Workers runtime
pnpm typecheck
pnpm drizzle-kit generate   # after editing src/db/sqlite-schema.ts
```

`test` deliberately runs both suites. CI's `workspace-tests` job
(`.github/workflows/ci.yml`) invokes only `pnpm --filter <name> test`, and it
hardcodes `test:integration` for just two services, so a unit-only `test`
script would leave the cursor and alarm invariants unchecked on every PR.

Migrations apply per DO instance on first access after deploy; see
`docs/do-sqlite-drizzle.md`.

## Next iteration

Reconciling events into Postgres needs:

- A Hyperdrive binding and `@kilocode/db`.
- A per-type discriminated union over the event `data` payload. Shapes differ:
  `dsync.user.*` carries a Directory User without `groups`,
  `dsync.group.user_added` carries `{directory_id, user, group}`,
  `dsync.activated` carries `domains[]`.
- The org linkage, which is Kilo `organizations.id` ⇄ the WorkOS organization's
  `externalId` (no WorkOS org id column exists in Postgres today).
- An ordering guard. `updated_at` on the payload gates most overwrites, but
  group-membership changes do not bump it, so `dsync.group.user_added` /
  `dsync.group.user_removed` need a different rule.

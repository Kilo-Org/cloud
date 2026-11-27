# cloudflare-security-sync

Cloudflare Worker that syncs security alerts on a cron schedule, enqueuing one queue message per enabled owner config.

## Endpoints

- `GET /health` - health check
- `POST /internal/manual-sync` - manual sync command ingress; `MANUAL_SYNC_COMMAND_ROUTING_ENABLED=false` pauses new Worker sync commands
- `POST /internal/dismiss-finding` - dismissal command ingress; `DISMISS_FINDING_COMMAND_ROUTING_ENABLED=false` pauses new Worker dismissal commands
- Cron trigger (`0 */6 * * *`) — queries enabled owners from DB and enqueues sync messages
- Cron trigger (`15 * * * *`) — notification sweep

Only production runs these schedules; `env.dev` has none. `wrangler dev` never runs crons by itself, so trigger a handler by hand against the local server, for example `curl "http://127.0.0.1:8812/cdn-cgi/local/scheduled?cron=15+*+*+*+*"` (sweep) or `?cron=0+*%2F6+*+*+*` (dispatch).

## Queues

- Sync producer: `SYNC_QUEUE` → `security-sync-jobs` (`security-sync-jobs-dev` in dev)
- Sync DLQ: `security-sync-jobs-dlq`
- Dismiss producer: `DISMISS_QUEUE` → `security-dismiss-jobs` (`security-dismiss-jobs-dev` in dev)
- Dismiss DLQ: `security-dismiss-jobs-dlq`

Create the dismiss queues before the first production deploy:

```bash
pnpm --filter cloudflare-security-sync exec wrangler queues create security-dismiss-jobs
pnpm --filter cloudflare-security-sync exec wrangler queues create security-dismiss-jobs-dlq
pnpm --filter cloudflare-security-sync exec wrangler queues create security-dismiss-jobs-dev
pnpm --filter cloudflare-security-sync exec wrangler queues create security-dismiss-jobs-dlq-dev
```

The sync consumer calls `syncOwner`. A scheduled owner run stops at an 8-minute budget, persists progress on `agent_configs.runtime_state.sync_run`, and enqueues a continuation. Owner freshness and config pruning run only after every selected repository has a terminal outcome for that run.

The dismiss consumer is isolated from scheduled sync occupancy. The sync consumer still accepts leftover dismiss messages during deploy drain.

## Secrets source

The two internal routes check `x-internal-api-key` against `INTERNAL_API_SECRET`. The hourly notification sweep (`15 * * * *`) sends the same secret as `X-Internal-Secret` when dispatch is enabled. `SECRETS_SOURCE` selects where both read it (`src/secrets.ts`):

- `secrets-store` (default, also when unset): the `INTERNAL_API_SECRET` Secrets Store binding, as before.
- `sts`: the production STS bundle over the `STS` binding (`props.caller` `cloudflare-security-sync`). It never falls back to the Secrets Store. A keyless request reads no bundle. A failed read answers a route with a generic `503` (`Retry-After: 30`, body `{"success":false,"error":"Internal key unavailable"}`) before the body is read, and skips that tick's dispatch in the sweep. Both log a fixed event with a fixed reason only.

Any other value refuses every read: the routes answer the same `503` and the sweep skips dispatch. Only the production block binds STS; `env.dev` keeps the Secrets Store source.

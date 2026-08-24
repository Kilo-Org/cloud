# cloudflare-security-sync

Cloudflare Worker that syncs security alerts on a cron schedule, enqueuing one queue message per enabled owner config.

## Endpoints

- `GET /health` - health check
- `POST /internal/manual-sync` - manual sync command ingress; `MANUAL_SYNC_COMMAND_ROUTING_ENABLED=false` pauses new Worker sync commands
- `POST /internal/dismiss-finding` - dismissal command ingress; `DISMISS_FINDING_COMMAND_ROUTING_ENABLED=false` pauses new Worker dismissal commands
- Cron trigger (`0 */6 * * *`) — queries enabled owners from DB and enqueues sync messages

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

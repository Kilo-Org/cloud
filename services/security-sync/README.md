# cloudflare-security-sync

Cloudflare Worker that syncs security alerts on a cron schedule, enqueuing one queue message per enabled owner config.

## Endpoints

- `GET /health` - health check
- `POST /internal/manual-sync` - manual sync command ingress; `MANUAL_SYNC_COMMAND_ROUTING_ENABLED=false` pauses new Worker sync commands
- `POST /internal/dismiss-finding` - dismissal command ingress; `DISMISS_FINDING_COMMAND_ROUTING_ENABLED=false` pauses new Worker dismissal commands
- Cron trigger (`0 */6 * * *`) — queries enabled owners from DB and enqueues sync messages

## Queue

- Producer binding: `SYNC_QUEUE`
- Consumer queue: `security-sync-jobs` (`security-sync-jobs-dev` in dev)
- DLQ: `security-sync-jobs-dlq`

The consumer calls `syncOwner` which fetches Dependabot alerts from GitHub, upserts findings into the database, keeps automatic-analysis queue eligibility synchronized, and prunes stale repos from the config for both scheduled and manual sync paths.

# cloudflare-security-sync

Cloudflare Worker that syncs security alerts on a cron schedule, enqueuing one queue message per enabled owner config.

## Endpoints

- `GET /health` - health check
- Cron trigger (`0 */6 * * *`) — queries enabled owners from DB and enqueues sync messages

## Queue

- Producer binding: `SYNC_QUEUE`
- Consumer queue: `security-sync-jobs` (`security-sync-jobs-dev` in dev)
- DLQ: `security-sync-jobs-dlq`

The consumer calls `syncOwner` which fetches Dependabot alerts from GitHub, upserts findings into the database, and prunes stale repos from the config.

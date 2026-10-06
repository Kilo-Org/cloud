# Usage queue

Queue-definition scaffold for future asynchronous usage processing. The Worker
returns HTTP 404 for every request. It does not publish messages or consume the
queue.

| Environment | Worker | `USAGE_QUEUE` queue |
| --- | --- | --- |
| Production (top-level config) | `usage-queue` | `usage-queue` |
| Staging (`env.staging`) | `usage-queue-staging` | `usage-queue-staging` |

## Automatic deployment is disabled

`services/usage-queue` is explicitly excluded from automatic discovery in
`.github/workflows/deploy-workers.yml`. `workers_dev: false` disables the public
Workers subdomain; it does not prevent deployment. There are no routes or preview
URLs configured.

A future PR should remove the exclusion only after the queues are provisioned
and the service is ready for automatic deployment. Explicit manual workflow
dispatch and direct Wrangler deployment remain possible; use them only as part
of an intentional rollout.

## Verify locally

From the repository root, use Node 24 and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm --filter cloudflare-usage-queue types
pnpm --filter cloudflare-usage-queue typecheck
pnpm --filter cloudflare-usage-queue lint
pnpm --filter cloudflare-usage-queue exec wrangler deploy --dry-run
pnpm --filter cloudflare-usage-queue exec wrangler deploy --dry-run --env staging
```

The dry runs build and show bindings without creating queues or deploying a
Worker. The compatibility date matches the repository's pinned workerd runtime.

## Manual setup (future rollout)

These commands change the Cloudflare account and are setup instructions only;
adding this scaffold does not execute them. After explicitly approving rollout,
authenticate Wrangler to the account in `wrangler.jsonc`, create the queues, and
deploy the matching Worker environment:

```bash
# Staging
pnpm --filter cloudflare-usage-queue exec wrangler queues create usage-queue-staging --env staging
pnpm --filter cloudflare-usage-queue exec wrangler deploy --env staging

# Production
pnpm --filter cloudflare-usage-queue exec wrangler queues create usage-queue
pnpm --filter cloudflare-usage-queue exec wrangler deploy
```

Cloudflare allows a queue to exist without a consumer. Publishing and consumption
will be introduced separately; this scaffold requires no secrets or database
access. See the [Queues setup documentation](https://developers.cloudflare.com/queues/get-started/).

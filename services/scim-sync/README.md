# scim-sync

Worker and Durable Object scaffolding for the SCIM sync service.

**This iteration has no behavior.** It exists so the Worker and its Durable
Object namespace are deployed and reachable in production, giving later
iterations something to build on. There is no storage, no polling, no WorkOS
integration, and no database access.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /health` | Worker liveness. Does not touch the Durable Object. |
| `GET /status` | Calls the Durable Object, so a 200 proves the namespace is reachable and not just that the Worker booted. |

## Durable Object

One instance, `SCIM_SYNC_DO.getByName('scim-sync')`, reached through
`getScimSyncDOStub`. Registered as a SQLite-backed class in the `v1` migration
even though it stores nothing yet: a deployed class's storage backend cannot be
switched later, and this class will need storage.

## Commands

```sh
pnpm dev         # wrangler dev --env dev, port 8819
pnpm typecheck
pnpm types       # regenerate worker-configuration.d.ts after config changes
```

There are no tests: a placeholder with no behavior has nothing worth asserting
that would not just restate the source.

## Deployment

Deployed by `deploy-workers.yml`, which auto-discovers any `services/*` folder
containing a `wrangler.jsonc`. The scheduled `deploy-production.yml` run
(`7,27,47 * * * *`) picks up changes once the merge commit is green in CI. No
`env.staging` block, so `deploy-staging.yml` skips this Worker, matching every
other Worker except `usage-ingest`.

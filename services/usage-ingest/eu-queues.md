# EU usage queues

`wrangler.jsonc` selects one source and matching DLQ per environment:

| Environment | Worker | Source / DLQ | Mode and capacity |
|---|---|---|---|
| Production (top-level) | `usage-ingest` | `usage-ingest-processing-eu` / `usage-ingest-processing-dlq-eu` | Processing, batch2/parallelism2/cap200 (up to 400 writer calls) |
| Staging | `usage-ingest-staging` | `usage-ingest-processing-staging-eu` / `usage-ingest-processing-dlq-staging-eu` | Processing, batch2/parallelism2/cap200 (at most400 writer calls) |

Production uses batch2/parallelism2/cap200; staging policy is unchanged.
Complete the production merge gate below before merge, deployment or cohort exposure. Receipt mode at batch1/cap1 belongs
to the preceding EU plumbing prerequisite, which must be deployed and verified first.
**Merging this change arms an automatic production queue cutover.** The production
workflow runs every 20 minutes and selects eligible CI-green main: it will create or
reuse the EU pair, detach the old consumer if present and deploy the new bindings. Do not
assume a separate manual deployment will provide a later approval gate.

## Production merge gate

Deploy and verify the default-off SFO selector and removal of background shadow
publication first. Keep `USAGE_QUEUE_SFO_EXPOSURE=0` until processing is verified. Before merging this queue change, obtain explicit production
cutover authorization, pause all production queue publishers, and reconcile/drain
source/DLQ, pending retries, in-flight work and accepted usage IDs. Verify those
conditions before merge while normal production deployments remain active.

If these prerequisites cannot be completed before merge, production deployments
must be **explicitly held before merge** and kept held until the same authorization,
deployed selector/shadow removal, publisher pause and reconciliation/drain
conditions are verified. This document does not pause deployments or publishers.
A selector that is OFF does not hold the deployment workflow or stop the consumer.
Verify the authenticated Frankfurt writer credential before merge: deployed
processing consumes queued events regardless of gateway exposure. Missing writer
configuration retries; it never ACKs events as receipts.
Keep publishers paused through cutover and post-deployment verification below.

## Automatic deployment preparation

Normal CI runs the [same helper](scripts/provision-queues.mjs) before uploading the
selected usage-ingest Worker. It reads production's top-level config or staging's
config, verifies existing queues have explicit `jurisdiction: "eu"`, and creates
only missing members with that API field (DLQ first, with detail readback). Names
alone do not prove jurisdiction. Unknown/wrong jurisdiction, incomplete/ambiguous
lookup or API failures stop upload; reruns reuse compatible resources.

Preparation verifies the selected source's consumer ownership before detaching
only the obsolete source attachment owned by the selected Worker. All supplied
script-name aliases must match; service metadata must match its default Worker
environment. It reads back detachment. Missing/already-detached obsolete queues
are no-ops; foreign/unknown ownership, permissions or API errors stop deployment.
No queue is deleted, purged or assigned a new jurisdiction; both queue pairs and
messages remain intact. Wrangler then configures the selected consumer normally.
Native resource auto-creation is disabled only for the selected EU usage-ingest
deployment; other Workers retain their existing route.

The helper exports its supported environments. Older selected source revisions
without a helper, or with only the historical staging helper, keep normal global
production deployment. An EU selection without working preparation fails closed.
Current CI rejects selected source with a retired relay binding before upload,
even if an old relay file remains. Use a reviewed direct-writer source; this
workflow does not deploy or fall back to the retired relay.

For an authorized local production deployment, run
`pnpm --filter cloudflare-usage-ingest exec node scripts/provision-queues.mjs production`
before `pnpm --filter cloudflare-usage-ingest exec wrangler deploy --experimental-provision=false`.
Staging keeps `pnpm --filter cloudflare-usage-ingest queues:prepare` before its
existing deployment commands. The helper requires an already injected
`CLOUDFLARE_API_TOKEN`; it does not load credentials/dotenv or log token/body values.
Actual token permissions must support Queue reads/create/consumer removal and
normal Worker deployment; account admin UI access is not required. See
[consumer API permissions](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/delete/).

## Cutover and routing rollback

Before switching an environment's queues, pause its publishers and reconcile
source/DLQ, pending retries, in-flight work and accepted usage IDs empty. Detaching
a consumer does not prove drain. Keep publishing paused until deployment and
verification finish, including on prep or upload failures. Verify a single selected
source attachment before resuming. Old queues stay inactive and intact.

To return to global, **retain the helper and deployment workflow** and restore
only the four source/DLQ references for that environment:

- Production: `usage-ingest-processing` / `usage-ingest-processing-dlq` at top-level.
- Staging: `usage-ingest-processing-staging` / `usage-ingest-processing-dlq-staging`.

Redeploy with that environment paused/drained. Preparation requires the original
global pair to exist, detaches the EU consumer, then Wrangler reconnects global.
No EU queues are deleted; global routing restores native provisioning. Rerun an
interrupted deployment after resolving its error, retaining the same gate.
A full PR revert or older source without production-capable reconciliation does
**not** automate EU detachment. Restore queue selection only, preserving current
mode/capacity and any later processing/drain ownership; receipt mode is not an
accounting rollback once processing has been enabled separately.

Update log queue-field filters and GraphQL/queue backlog/DLQ IDs for the selected
pair; distinguish global/EU during transition and restore global targets on rollback.
EU jurisdiction restricts queue data location, not Worker placement or measured
latency. See [Cloudflare's jurisdiction contract](https://developers.cloudflare.com/queues/configuration/data-location/).

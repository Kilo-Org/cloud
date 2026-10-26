# Staging EU queues

`wrangler.jsonc` declares the EU source/DLQ names and one consumer at cap200/batch2
with processing parallelism2 (at most 400 concurrent writer calls).
The preparation step explicitly supplies `jurisdiction: "eu"` for both queues.

Normal staging deployment has one preparation step before the consumer upload.
The [helper](scripts/provision-queues.mjs) looks up both exact names, verifies existing EU jurisdiction, creates only missing queues with explicit
EU jurisdiction (DLQ first), and reads each creation back. Reruns reuse the pair;
wrong/unknown jurisdiction, ambiguous/incomplete lookup or API/network errors stop
upload. No queue is deleted or modified. Native global auto-provisioning is disabled
for EU deployments. Historical revisions without EU config keep their existing path.

Local deployment uses `pnpm --filter cloudflare-usage-ingest queues:prepare` before
the consumer commands in README, with an already injected
`CLOUDFLARE_API_TOKEN`. No login or credentials file is loaded. Wrangler retains
responsibility for consumer settings; retention remains separately managed as
before. Production, writer/relay code, retry policy and dependencies are unchanged.

## Cutover and revert

Before switching queues, pause/reconcile staging empty (including source/DLQ,
retries, in-flight work and accepted usage IDs). Consumer detachment does not
prove that work has drained. Keep traffic paused until deployment and verification
finish, including when an upload or retry fails.

The same preparation step detaches only the obsolete source's consumer owned by
`usage-ingest-staging`, using the standard Cloudflare consumer-removal API. It
checks ownership (including service environment), reads back detachment, and
leaves both queue pairs/messages intact. A missing queue or already-detached
consumer is a no-op; unknown/foreign ownership or API/permission errors fail
before upload. Wrangler then attaches the selected source. No dashboard/admin
operation is needed. CI's injected token must have account-scoped `Workers Scripts
Write` or `Queues Write` (plus reads and normal Worker deployment permissions);
actual token scope is not inferred from having deployment access. See the
[consumer-removal permissions](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/delete/).

To return to global, **retain this helper and deployment workflow** and restore
only the four staging source/DLQ references in `wrangler.jsonc` to
`usage-ingest-processing-staging` and `usage-ingest-processing-dlq-staging`.
Redeploy with staging paused/drained. Preparation requires that original global
pair to exist, detaches the EU consumer, then Wrangler reconnects the global
source. The EU creation step is skipped and normal native provisioning is enabled.
Verify the resulting single consumer attachment before resuming. Rerunning after
an interrupted deployment safely repeats preparation without deleting resources.

A full PR revert or deployment of an older source without this helper does **not**
automate EU detachment. Use the config-only routing rollback above. This is a
planned deployment switch, not automatic fallback.

Use the EU names for processing-log filters and actual EU source/DLQ IDs for queue
metrics. EU jurisdiction restricts Queue data location, not Worker placement or
latency. See [Cloudflare's jurisdiction contract](https://developers.cloudflare.com/queues/configuration/data-location/).

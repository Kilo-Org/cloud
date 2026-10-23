# Staging EU queue provisioning

Queue names and the single consumer are declared in `wrangler.jsonc`:
`usage-ingest-processing-staging-eu` and `usage-ingest-processing-dlq-staging-eu`,
**one consumer at cap200/batch1**. [`queues.staging.json`](queues.staging.json)
declares `jurisdiction: eu` and four-day retention (`345600` seconds) for both.
Production, the private Frankfurt relay, shared writer and retries stay unchanged.

## Normal deployment

Existing staging CI performs one **Prepare staging EU queues** step before any
Worker upload. The same [entrypoint](scripts/provision-queues.mjs) is available
locally as `pnpm --filter cloudflare-usage-ingest queues:prepare`, followed by the
existing relay and consumer deploy commands in README. It uses the already
injected `CLOUDFLARE_API_TOKEN`; no credentials file or login flow is loaded.

Preparation looks up exact names and verifies both existing resources before
creating anything. Only missing resources are created through the official REST
API with explicit EU jurisdiction and retention, DLQ first and independently
read back before source creation. Compatible resources are reused on redeploy;
wrong/unknown jurisdiction, retention, identity or consumer metadata, ambiguous
names, incomplete pagination and API/network errors stop before uploads.
The source must have no consumer or the expected `usage-ingest-staging` Worker
with the matching EU DLQ; the DLQ must be unconsumed. Nothing is deleted or patched.
A failed/lost create response can leave an accepted resource intact: rerun normal
deployment to discover and verify it. Do not delete/recreate it.

Both initial/retry consumer uploads retain `--experimental-provision=false`.
Pinned Wrangler4.135.0 has no native Queue jurisdiction config field and its
normal auto-create omits jurisdiction. The extra step supplies this required
creation parameter without upgrading Wrangler or wrapping deployment. Historical
selected sources with the original global pair skip this step and keep native
provisioning; production and other Workers keep their existing paths.

## One-time operational prerequisite: detach the old consumer

Automatic queue creation does not detach an existing consumer. Before first EU
cutover, pause staging intake and confirm no source/DLQ messages, pending retries,
in-flight work or unresolved accepted IDs remain. While paused and reconciled
empty, manually detach `usage-ingest-staging` from the original source in the
dashboard. Removing its Wrangler config entry alone does not prove detachment.
Then run normal staging deployment. Before resuming, read back actual queue
jurisdictions/IDs and Worker bindings/attachments: only the EU source has the
consumer at cap200/batch1; both old resources/messages stay intact and disconnected.
Optional later deletion is a separate operational decision. No automated migration,
drain, fallback or dual consumption is supplied.

For observations, keep the Worker service, usage IDs and persistence metrics;
use actual EU source/DLQ IDs for GraphQL `queueID`/backlog/DLQ selectors and EU
queue names for processing-log filters. Queue jurisdiction is not Worker placement
or evidence of a latency improvement.

## Manual routing revert

Pause and reconcile the EU pair empty, manually detach its active consumer, revert
both staging bindings and the single consumer source/DLQ to the verified original
pair, and deploy reviewed config through normal staging CI. Keep the relay and
both pairs intact; verify the resulting single attachment before resuming intake.
This is an operational detach plus config redeploy, with no resource deletion or
jurisdiction change. EU preparation is skipped for the original global topology.

References: [jurisdiction and matching DLQ](https://developers.cloudflare.com/queues/configuration/data-location/),
[Create Queue API](https://developers.cloudflare.com/api/resources/queues/methods/create/),
[Get Queue API](https://developers.cloudflare.com/api/resources/queues/methods/get/).

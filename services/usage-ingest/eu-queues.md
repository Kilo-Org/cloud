# Staging EU queues

`wrangler.jsonc` declares the EU source/DLQ names and one consumer at cap200/batch1.
The preparation step explicitly supplies `jurisdiction: "eu"` for both queues.

Normal staging deployment has one preparation step before the existing relay and
consumer uploads. The [helper](scripts/provision-queues.mjs) looks up both exact
names, verifies existing EU jurisdiction, creates only missing queues with explicit
EU jurisdiction (DLQ first), and reads each creation back. Reruns reuse the pair;
wrong/unknown jurisdiction, ambiguous/incomplete lookup or API/network errors stop
upload. Nothing is deleted or modified. Native global auto-provisioning is disabled
for EU deployments. Historical revisions without EU config keep their existing path.

Local deployment uses `pnpm --filter cloudflare-usage-ingest queues:prepare` before
the existing relay/consumer commands in README, with an already injected
`CLOUDFLARE_API_TOKEN`. No login or credentials file is loaded. Wrangler retains
responsibility for consumer settings; retention remains separately managed as
before. Production, writer/relay code, retry policy and dependencies are unchanged.

## Cutover and revert

Queue creation is automatic; detaching an existing consumer is operational.
Before first cutover, pause/reconcile staging empty (including source/DLQ, retries,
in-flight work and accepted usage IDs), then manually detach the original consumer.
Config omission alone does not prove detachment. After deployment, verify only the
EU source has the consumer before resuming. Keep old queues/messages intact.

To revert, pause/reconcile EU work empty, manually detach its active consumer,
revert the staging bindings/consumer config, and redeploy.
Verify the resulting single attachment before resuming; leave both queue pairs intact.

Use the EU names for processing-log filters and actual EU source/DLQ IDs for queue
metrics. EU jurisdiction restricts Queue data location, not Worker placement or
latency. See [Cloudflare's jurisdiction contract](https://developers.cloudflare.com/queues/configuration/data-location/).

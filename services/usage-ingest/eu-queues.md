# Staging EU queues: setup, cutover and rollback

This change prepares staging only. Production names, receipt mode, policies and
deployment path remain unchanged. The existing Frankfurt service-binding relay,
shared Vercel writer, writer timeout, retry policy and ACK-after-validated-success
behavior remain. No queue/resource has been created or deployed by changing this
repository, and no latency improvement has been measured for this change.

[Cloudflare jurisdiction](https://developers.cloudflare.com/queues/configuration/data-location/)
is immutable at creation. EU constrains Queue message storage/processing, while
Worker producers/consumers can execute anywhere; it does not pin `queue()` to
Frankfurt. A new instance also starts cold, so a later difference is not proof
that jurisdiction alone caused it.

## Resources and writer-call budget

| Role | Original retained resource | EU resource for new intake |
|---|---|---|
| Source | `usage-ingest-processing-staging` | `usage-ingest-processing-staging-eu` |
| DLQ | `usage-ingest-processing-dlq-staging` | `usage-ingest-processing-dlq-staging-eu` |

Account `e115e769bcdd4c3d66af59d3332cb394`; service remains `usage-ingest-staging`.
`USAGE_INGEST_QUEUE` selects the new EU source. `USAGE_INGEST_DLQ` is an unused
producer binding for its matching EU DLQ. Old accepted messages stay on their
source with its original DLQ. Both source consumers remain attached to the same
Worker; neither DLQ has a consumer. There is no dual publishing, copying, purge,
rename, redrive or consumer deletion in this setup.

The original consumer's invocation cap explicitly drops **200 → 1**; the new EU
consumer has cap **199**. At batch size 1 the combined worst-case writer-call
ceiling is `1 × 1 + 199 × 1 = 200`. Batch timeout 0, retries 3, retry delay 60s,
processing mode, relay binding and staging writer URL stay unchanged.

Merge/test order is diagnostics → EU → batching → middleware. Before composing
the independent batching PR, preserve all diagnostics settings and the relay.
With `USAGE_INGEST_PARALLELISM=2`, **both** retained consumers use batch size 2,
legacy cap 1 and EU cap **99**: `2 × (1 + 99) = 200`. Keeping EU199, using EU100
plus legacy1, or blindly setting both caps100 exceeds the budget. The helper
checks explicit positive batch/concurrency bounds and rejects a sum above 200;
tests cover the standalone and exact planned composition. These are ceilings,
not observed concurrency, batch fill, throughput or a scheduler guarantee.

## Explicit existing-resource verification / creation

After review, an authorized operator uses Node 24, pinned pnpm and an already
injected account-scoped `CLOUDFLARE_API_TOKEN`. The helper never loads local
credential/dotenv files or starts login. Do not put credentials in arguments,
logs or evidence. Queue Read is needed for verification, Queue Write for
creation (or documented Worker equivalents); deployment needs normal Worker
permissions. Confirm the plan supports four-day retention.

```bash
# Read-only: if both EU resources already exist, verify rather than recreate.
pnpm --filter cloudflare-usage-ingest queues:verify staging
# If explicitly needed, create only absent EU resources, then read them back.
pnpm --filter cloudflare-usage-ingest queues:create staging
pnpm --filter cloudflare-usage-ingest queues:verify staging
```

The helper inspects all four staging resources before any create. Existing EU
resources must have exact names/IDs, explicit `jurisdiction: "eu"`, retention
345600s, complete consumer metadata, the correct Worker type/owner and matching
DLQ; no DLQ consumer is allowed. Original source/DLQ must exist with matching
jurisdictions. Missing optional metadata fails closed rather than inferring EU.
Inspect unexpected delivery delay/paused state before intake; setup does not
silently change any existing settings. A wrong/global/unknown jurisdiction or
retention aborts with no deletion/recreation/update. A new name or explicit
retention correction needs separate review.

For absent EU resources, [REST Create Queue](https://developers.cloudflare.com/api/resources/queues/methods/create/)
sends `queue_name`, `jurisdiction: "eu"`, and
`settings.message_retention_period: 345600` (also used by pinned Wrangler create).
The EU DLQ is created and independently read back before the source is created.
Exact-name paginated lookup plus resource GET verifies each result. The API
acceptance of these settings, optional-field availability, names and permissions
still need authenticated readback; local fixtures do not establish them.
Failed/lost responses leave resources intact; rerun discovers accepted resources
and reuses them. No cleanup is attempted on failure.

The pinned Wrangler queue schema has no jurisdiction property and its queue-create
CLI has no jurisdiction flag. Do not auto-provision an EU-looking name globally.
CI verifies before each staging consumer upload/retry and passes
`--experimental-provision=false`. Its existing selected-source check skips EU
verification only for the original historical topology with no EU-helper package
declaration; missing/malformed required guards/configs block upload. Relay config
is still required and deployed before the consumer. Production skips this EU path.

Normal staging CI is preferred. The guarded direct equivalent is:

```bash
pnpm --filter cloudflare-usage-ingest deploy:staging
```

It verifies, deploys `wrangler.writer-relay.jsonc`, then deploys the consumer with
provisioning disabled. A failed relay stops the consumer. Any deployment error
can follow partial success: inspect actual versions, bindings and both queue pairs
before resuming. Verification and deployment are not atomic; exclude concurrent
resource deletion/recreation. Merging can trigger normal staging CI, so coordinate
the merge/deploy window as the cutover, after the following gate.

## One fresh empty-state gate, then bounded staging smoke

The owner controls staging traffic and reported the previous run fully reconciled
with queues/DLQs empty. There is no expected migration backlog. Immediately before
cutover, record **one fresh timestamped confirmation** with intake/load paused and
gateway publication/background attempts finished: original and EU source/DLQ
backlogs empty, no pending retry/delayed delivery, no in-flight consumer/writer
call, and no unresolved accepted usage ID. Inspect actual ACK/retry/in-flight/DLQ
state; a lone zero backlog sample cannot establish all of this. If the fresh
confirmation cannot be made, hold cutover and resolve only what is actually found.
Do not manufacture drain work, purge messages, or blindly wait for a long timeout.

Save actual queue IDs, metadata, Worker/relay versions, gateway settings and the
fresh gate. Verify EU resources, deploy in the agreed window, then read back the
producer destination, **both** consumers and matching DLQs, caps, mode, relay and
writer URL. Production has no change. Keep the original resources.

After separate hosted test authorization, send one bounded staging smoke with a
fresh usage ID and verify acceptance, EU delivery, writer recorded/duplicate,
persistence and Queue ACK separately. Observe both pairs. Hold further load on
uncertainty. Keep the relay, payload, offered rate, batch policy and writer fixed
for this jurisdiction experiment; batching and middleware are later separate
changes, each with independent measurements. Existing historical test results and
load scripts are not changed by this PR.

## Queries and observations after the switch

Use [the load-test runbook](load-test.md#eu-queue-targets) for exact target changes.
The Worker service, stable usage-ID joins and persistence metrics remain the same.
Processing `queue` filters and source GraphQL `queueID`/backlog targets must select
the EU source; DLQ queries must select the EU DLQ. Resolve real IDs from resource
readback, never derive them from names. During transition retain separately
labelled legacy-source/legacy-DLQ observations. Missing queue fields in older logs
are unknown rather than proof of legacy origin.

## Routing rollback preserves EU drainage

Pause intake and make the same fresh state confirmation across both pairs. Change
only the selected staging producer destinations to the original source/DLQ pair;
retain the EU consumer and EU DLQ. The helper accepts a coherent original producer
pair but rejects mixed old/EU bindings, and still verifies both pairs before
deploy. Use normal guarded staging CI/direct deployment and read back routing.
Never blind-rollback an old Worker revision that detaches the EU consumer. Preserve
the relay unless a separately reviewed change intentionally removes it.

The original route now has cap1, so keep smoke/traffic bounded accordingly. If a
reviewed rollback needs the prior active-route capacity, redistribute caps to
legacy199/EU1 at batch1 (or legacy99/EU1 at parallel2/batch2) while retaining both
consumers and the combined ceiling200. Do not raise a cap independently of batch
size, and do not strand accepted EU work. Source/DLQ retirement, replay and
retention changes are separate reviewed actions; retention naturally expires
messages, so any unexpected unresolved work must be addressed before expiry.

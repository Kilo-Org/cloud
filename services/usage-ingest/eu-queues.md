# One-time staging EU queue setup

Staging connects `usage-ingest-processing-staging-eu` and its matching DLQ
`usage-ingest-processing-dlq-staging-eu`, with **one EU consumer: cap200, batch1**.
The private Frankfurt relay and shared writer stay unchanged; production is untouched.
The original global pair remains disconnected, with no drain/fallback consumer.

## Manual setup before deployment

An authorized operator performs this once; CI never provisions these EU queues.
Pause staging intake and confirm the previous run is reconciled: no source/DLQ
messages, pending retries, in-flight work or unresolved accepted usage IDs before
switching. If anything remains, hold the switch and resolve it first.
While paused and empty, manually disconnect `usage-ingest-staging` from the old
source in the dashboard before deploying the EU consumer. Removing a Wrangler
consumer entry alone does not guarantee its remote attachment is deleted.

1. In account `e115e769bcdd4c3d66af59d3332cb394`, inspect both exact EU names in
   the dashboard/API. Reuse existing resources only after checking their IDs,
   `jurisdiction: eu`, four-day retention (`345600` seconds), and consumer ownership:
   source unconsumed or owned only by `usage-ingest-staging` with the matching EU
   DLQ; DLQ unconsumed. Unknown/mismatching metadata means stop. Never change a
   jurisdiction or delete/recreate an existing queue.
2. Only for a confirmed missing resource, use the dashboard's EU jurisdiction
   selector or these REST requests with an already injected token. Create the DLQ
   first, read it back, then create the source. Do not assume pinned Wrangler's
   `queues create` supports a jurisdiction flag.

```bash
# Run each POST only if that exact resource is absent.
curl --fail-with-body 'https://api.cloudflare.com/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  --data '{"queue_name":"usage-ingest-processing-dlq-staging-eu","jurisdiction":"eu","settings":{"message_retention_period":345600}}'

# Read back the DLQ and confirm its metadata before this source POST.
curl --fail-with-body 'https://api.cloudflare.com/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  --data '{"queue_name":"usage-ingest-processing-staging-eu","jurisdiction":"eu","settings":{"message_retention_period":345600}}'

# Repeat for each actual queue ID from lookup/create; check success and result.
curl --fail-with-body "https://api.cloudflare.com/client/v4/accounts/e115e769bcdd4c3d66af59d3332cb394/queues/$QUEUE_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

3. Independently GET both actual IDs and verify the metadata above before upload;
   a name ending in `-eu` is insufficient. If a POST response is lost, inspect/reuse
   the existing resource rather than blindly retrying creation.
4. Use normal staging CI (relay first), or the guarded direct commands in README.
   Both CI initial/retry consumer commands use `--experimental-provision=false`.
   Pinned Wrangler4.135.0 otherwise creates missing producer queues without a
   jurisdiction; the flag disables that provisioning path. It does **not** verify
   existing jurisdiction. Do not omit the flag or bypass manual readback.
5. Before resuming traffic, inspect the deployed version/bindings and confirm only
   the EU source has the staging consumer at cap200/batch1 and the old source is
   disconnected. Leave both old resources/messages intact; optional deletion is a
   separate later operation after proving them empty and unreferenced.

For later observations, keep the same Worker service, usage IDs and persistence
metrics; switch processing-log queue filters and GraphQL `queueID`/backlog/DLQ
selectors to the actual EU source/DLQ IDs. Do not reuse old IDs or rewrite history.
EU jurisdiction restricts Queue storage/processing, not Worker placement, and is
not evidence of a latency improvement.

## Manual routing rollback

Pause/reconcile EU work, then manually detach its only consumer in the dashboard.
Change the two staging
producer names and the single consumer source/DLQ back to the verified original
pair, then redeploy reviewed config with provisioning disabled and verify bindings.
This reconnects only the original consumer at cap200/batch1; no dual consumption,
automatic drain, migration or deletion is provided. Preserve the relay and writer.

References: [jurisdiction and matching DLQ](https://developers.cloudflare.com/queues/configuration/data-location/),
[Create Queue REST contract](https://developers.cloudflare.com/api/resources/queues/methods/create/).

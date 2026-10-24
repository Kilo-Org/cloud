# Cloud Agent compute billing operations

The meter owns paid enrollment, rate snapshots and wallet settlement. Cloud Agent always requests
billing admission. Runtime configuration cannot disable meter charges.

Compute requires at least $5 in remaining credit. Exactly $5 permits admission and continued compute.
A lower balance rejects admission or stops running compute. Automatic top-up does not guarantee continuation below this floor.
The meter does not initiate payments. The separate $1 model preflight, $3 capacity threshold and $10 warning retain their owners.

## Release order and activation

1. Keep the admission, capacity and billing-fix changes in one coordinated release. Do not merge or deploy from this runbook without release authorization.
2. Deploy the web/shared billing rules and compatible customer contracts before their Worker consumers.
3. Deploy strict Cloud Agent admission (#8273), the meter capacity contract (#8401), then atomic Cloud Agent capacity (#8274).
   The meter validates RPC inputs strictly. Do not send `enforceCapacity` before the receiving meter supports it.
4. Deploy the reviewed billing fixes before enrolling general traffic. Confirm `billing_unavailable` bounds native admission failures.
5. Create the native SKU catalog entries before starting local or production paid compute. Use the checked-in SKU mapping.
6. Configure `CONTAINER_BILLING_SERVICES` to include `cloud-agent-next`. Set both Cloud Agent payer lists explicitly.
   An empty list enrolls nobody. Explicit IDs enroll only those payers. `*` enrolls every payer of that type.
   Wildcards apply only to the Cloud Agent payer lists. The service list must still enroll the service.
   Personal and organization enrollment remain independent. Gastown retains its existing list semantics.
   Leave the Gastown service and payer settings unchanged.
7. Read one `container_billing_configuration` event from a new isolate. Confirm service names, enrollment booleans and warning threshold.
   Investigate `container_billing_configuration_invalid` before activation. Its field names identify the invalid configuration; logs contain no payer IDs.
8. Verify a paid start, a heartbeat and a controlled stop. Compare the interval, segments, charge rows and wallet delta.
   Replay the same segment and confirm there is no additional debit.

### Migration and spend-alert preparation

Before applying migration 0297, inspect the charge partitions and their sizes:

```sql
SELECT relid::regclass AS partition, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_partition_tree('compute_usage_charge')
WHERE isleaf;
```

The index build takes a SHARE lock and blocks settlement inserts until commit.
Schedule this migration during a low-traffic release window. If partitions have grown,
prepare a separate migration that builds each partition index concurrently and attaches it to the parent.
Do not run a parent partitioned index build concurrently.

Immediately after deploying the web code, rebuild the 720-hour threshold window and anomaly baseline:

```sh
pnpm --filter web script src/scripts/backfill-compute-spend-alerts.ts
```

This command sets `IS_SCRIPT=true` and connects through **`POSTGRES_SCRIPT_URL`**, not `POSTGRES_URL`.
Confirm that target in the web environment before execution. Local verification must set it to this worktree's isolated database.
The script selects only payers with compute charges in the window. It rebuilds their model and compute totals,
one payer per statement, releasing bucket locks between payers. It does not deliver alerts. Reruns cannot double count charges.
The cron remains active. Until the backfill finishes, earlier compute charges are missing from some baselines:
anomaly alerts can fire from an incomplete baseline, and threshold alerts can arrive late.
The current sweep can briefly wait on the payer being rebuilt. If this gap is unacceptable,
do not activate this release until a separate cron pause mechanism is implemented.

Normal sweeps rebuild three hours and cannot repair older buckets. This step applies to existing canary charges too.

## Rollback

Roll back consumers before the meter: #8274, #8401, then #8273. Preserve strict input compatibility.
Removing an account from enrollment affects new intervals only. It does not change an open interval's paid mode.
Use the emergency procedure when existing charges must stop.

## Emergency stop of Cloud Agent charges

An authorized operator performs this procedure. Do not change Gastown billing.

1. Empty `CONTAINER_BILLING_CLOUD_AGENT_USER_IDS` and `CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS`, then deploy the meter.
   New Cloud Agent intervals open in shadow mode after activation.
2. Confirm the target database and the Cloud Agent service scope. Record the count before changing rows:

   ```sql
   SELECT service, count(*)
   FROM container_usage_interval
   WHERE status = 'open' AND billing_mode = 'paid'
     AND service LIKE 'cloud-agent-next-%'
   GROUP BY service;
   ```

3. Change only open Cloud Agent intervals:

   ```sql
   BEGIN;
   UPDATE container_usage_interval
   SET billing_mode = 'shadow', rate_cents_per_unit = NULL
   WHERE status = 'open' AND billing_mode = 'paid'
     AND service LIKE 'cloud-agent-next-%';
   COMMIT;
   ```

   The update waits for concurrent settlement row locks. A settlement already committed remains a valid ledger entry.
   After commit, subsequent settlement for these intervals cannot add paid charges. Previously recorded charges remain unchanged.
4. Verify the query returns no open paid Cloud Agent intervals. Verify a subsequent heartbeat creates no wallet debit.
   Retain the bounded UTC window and aggregate evidence in the incident record.
5. Re-enrollment applies only to new intervals. Do not convert these shadow intervals back to paid.

## Price change

Create a new immutable SKU. Deploy code that selects it, verify new starts use it, then disable the old SKU for new usage.
Keep the old SKU and rate snapshots for settlement and reporting. Disabling a selected SKU prevents admission.
Verify the hourly customer price matches `rate_cents_per_unit * 3600 / 100` dollars per hour.

The new-session picker and session information read the native Medium/Large catalog at runtime.
The usage page reads paid compute directly from PostgreSQL, separately from model analytics.
Customers can group charges by day or session and inspect duration, historical rate, amount and payer.
Organization members see their own charges. Billing roles can inspect all members.
Unassigned charges remain visible to the payer's billing roles. Select one organization in aggregate views.
The external Snowflake pipeline still needs an operator check.

## Organization accounting and recovery

Native Cloudflare Containers compute uses the same organization consumption transaction as model usage.
The transaction updates daily member usage and the paying organization's wallet, then advances Kilo Pass qualifying spend.
The acting member is the session's trusted `identity.userId`. Native bot usage retains it in `metadata.billingUserId`.
Bot actor identity and `onBehalfOf` remain unchanged. Seat-based organizations continue to ignore member limits.
Other organizations use the smaller of wallet balance and remaining daily allowance, with the same $5 compute floor.
An organization top-up does not restore a member's allowance. An owner or admin must adjust that limit when required.
One heartbeat per running container can exceed the remaining wallet or member allowance before compute stops.

Deploy the web internal balance-alert endpoint before the meter, then deploy the native producer.
The meter uses `KILOCODE_BACKEND_BASE_URL` and the `INTERNAL_API_SECRET_PROD` Secrets Store binding.
After commit, a minimum-balance crossing sends one best-effort authenticated request with a three-second HTTP timeout.
The endpoint uses existing configured email and push recipients. Segment replay sends no additional request.
Monitor `organization_compute_balance_alert_failed`; delivery has no durable outbox or automatic retry.

Before organization enrollment, stop old native bot sessions and create newly registered sessions with acting-member attribution.
Restarting only their containers or sending a new message does not upgrade their persisted billing selection.
Do not edit their stored billing context: the fingerprint must continue to permit settlement replay.
If an old paid bot interval remains, the meter settles its measured wallet charge and requests a stop.
It cannot reconstruct that interval's missing member or qualifying-spend attribution. Audit those old charges separately.
New unattributed native organization starts fail billing verification until their configuration is corrected.
Gastown, SDK and Vercel settlement behavior remains unchanged.

## Customer credit adjustment

Identify the payer, exact charge rows and bounded time window. Reconcile against segment idempotency keys first.
Use the existing audited administrative credit-grant workflow with a reason and incident reference.
Do not edit wallet counters or delete ledger rows. Record the adjustment and verify the resulting balance.
Canary organization Kilo Pass compensation requires a separate account/agreement investigation.

## Required monitors

- `container_usage_rpc` outcomes `failed` and `rejected`: alert on failure rate and inspect rejection codes.
- `container_billing_configuration_invalid`: alert on each new invalid configuration event.
- Paid interval starts per hour: alert on an unexpected drop to zero after rollout.
- Admin `usageHealth`: alert on open intervals older than the reconciliation cutoff.
- Producer `Container usage shadow delivery deferred`: alert on sustained delivery failures.
- Admission latency and errors: watch organization bursts that contend for the capacity advisory lock.

Create these monitors through the operations workflow. This repository change does not install external monitors.

## Weekly checks

Run the admin Cloudflare reconciliation. Investigate unexplained charge or duration differences.
Size controlled-stop tails using shadow data:

```sql
SELECT service, count(*) AS intervals,
       count(*) FILTER (WHERE confirmed_seconds = 0) AS zero_second_intervals,
       sum(confirmed_seconds) AS billed_seconds,
       sum(extract(epoch FROM stopped_at - started_at))::bigint AS wall_seconds
FROM container_usage_interval
WHERE service LIKE 'cloud-agent-next-sandbox-containers-%'
  AND status = 'closed' AND close_reason = 'runtime_signal'
  AND started_at > now() - interval '7 days'
GROUP BY service;
```

Paid intervals start at admission, before physical runtime. Their wall-time difference also includes startup.
Snowflake ingestion and provider invoice reconciliation require separate production checks.

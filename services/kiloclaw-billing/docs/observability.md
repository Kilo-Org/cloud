# KiloClaw Billing Observability

## Base Filter

Use this filter for every billing lifecycle query in Axiom:

`billingFlow = "kiloclaw_lifecycle"`

Important dimensions:

| Field              | Meaning                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billingComponent` | `worker`, `side_effects`, `kiloclaw_platform`, or `snowflake_sql_api`                                                                                                                                                                                                         |
| `billingRunId`     | One hourly billing run across all sweeps                                                                                                                                                                                                                                      |
| `billingSweep`     | The current sweep name, including `trial_inactivity_stop` for daily coordination and `trial_inactivity_stop_candidate` for per-instance stop work                                                                                                                             |
| `billingCallId`    | One downstream call from the worker                                                                                                                                                                                                                                           |
| `billingAttempt`   | Queue delivery attempt number                                                                                                                                                                                                                                                 |
| `event`            | `run_started`, `sweep_started`, `sweep_completed`, `sweep_failed`, `queue_retry`, `run_completed`, `run_failed`, `downstream_call`, `downstream_action`, `request_rejected`, `subscription_row_skipped`, and trial-inactivity-specific events such as `trial_inactivity_stop` |
| `outcome`          | `started`, `completed`, `failed`, `retry`, `discarded`, or `skipped`                                                                                                                                                                                                          |
| `durationMs`       | Elapsed time for a sweep or downstream request                                                                                                                                                                                                                                |
| `snowflakeCode`    | Snowflake SQL API error code on failed submit/poll requests                                                                                                                                                                                                                   |
| `snowflakeMessage` | Snowflake SQL API error message on failed submit/poll requests                                                                                                                                                                                                                |

## Saved Queries

### End-to-end run timeline

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `billingRunId = "<run id>"`

Display:

- order by event time ascending
- show `billingComponent`, `billingSweep`, `billingCallId`, `event`, `outcome`, `durationMs`, `statusCode`, `userId`, `instanceId`, `stripeSubscriptionId`

### Sweep health

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `billingComponent = "worker"`
- `event in ("sweep_completed", "sweep_failed")`

Display:

- group by `billingSweep`
- chart count, error count, `durationMs` p50 / p95, and `summary.trial_inactivity_stop_messages_enqueued`

### Downstream failures

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `billingComponent in ("side_effects", "kiloclaw_platform", "snowflake_sql_api")`
- `outcome = "failed"`

Display:

- show `billingRunId`, `billingSweep`, `billingComponent`, `billingCallId`, `action`, `statusCode`, `error`, `userId`, `instanceId`, `stripeSubscriptionId`

### Retry and DLQ precursors

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `event in ("queue_retry", "run_failed")`

Display:

- show `billingRunId`, `billingSweep`, `billingAttempt`, `willGoToDlq`, `error`

### Trial inactivity stop fan-out

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `event = "trial_inactivity_stop_candidates_enqueued"`

Display:

- show `billingRunId`, `billingSweep`, `batchSize`, `enqueuedCount`, `dryRun`

### Trial inactivity skip decisions

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- `billingSweep in ("trial_inactivity_stop", "trial_inactivity_stop_candidate")`
- `event = "subscription_row_skipped"`

Display:

- show `billingRunId`, `userId`, `instanceId`, `subscriptionId`, `reason`, `platformStatus`

### Entity drilldown

Filter:

- `billingFlow = "kiloclaw_lifecycle"`
- one of `userId = "<user id>"`, `instanceId = "<instance id>"`, or `stripeSubscriptionId = "<stripe subscription id>"`

Display:

- order by event time ascending
- show all components to reconstruct the lifecycle for one entity

## Monitors

Create these monitors in Axiom:

1. `billing-run-failed-before-dlq`
   Trigger when `event = "run_failed"` and `willGoToDlq = true`.
   Severity: page.

2. `billing-queue-retry-spike`
   Trigger when `event = "queue_retry"` count is `>= 3` in 15 minutes.
   Severity: ticket.

3. `billing-downstream-failure-spike`
   Trigger when `billingComponent in ("side_effects", "kiloclaw_platform")` and `outcome = "failed"` count is `>= 5` in 15 minutes.
   Severity: ticket.

4. `billing-run-missing-completion`
   Trigger when a `run_started` event has no matching `run_completed` event for the same `billingRunId` within 75 minutes.
   Severity: ticket.

5. `billing-snowflake-failure-spike`
   Trigger when `billingComponent = "snowflake_sql_api"` and `outcome = "failed"` count is `>= 5` in 15 minutes.
   Severity: ticket.

## Notes

- The worker is the source of truth for run and sweep lifecycle state.
- The Next internal route and `kiloclaw` logs are correlated into the same run through the billing headers, not through separate tracing infrastructure.
- Do not add recipient emails, template vars, click IDs, or auth headers to logs.

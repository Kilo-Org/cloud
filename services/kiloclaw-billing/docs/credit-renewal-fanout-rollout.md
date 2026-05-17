# Credit Renewal Fanout Rollout

## Enable fanout path

- Deploy `kiloclaw-billing` with the lifecycle queue consumer handling:
  - `credit_renewal_discovery`
  - `credit_renewal_discovery_continuation`
  - `credit_renewal_item`
  - `credit_renewal_terminal_failure`
- Keep the hourly billing cron unchanged. The `credit_renewal` lifecycle kickoff enqueues discovery, then continues later lifecycle sweeps without waiting for all renewal items.
- Confirm discovery logs emit `credit_renewal_discovery` with `billingRunId`, `billingAttempt`, `cutoffTime`, cursor fields, `pageBudget`, `fetchedCount`, `enqueuedCount`, and `discoveryBacklogLikely`.

## Queue config

- Use the existing lifecycle queue binding for discovery, item, continuation, and terminal-failure messages.
- Lifecycle queue consumer config starts at `max_batch_size = 1`, `max_concurrency = 5`, and `max_retries = 3`.
- Automatic queue retry budget is `BILLING_QUEUE_MAX_RETRIES = 3`.
- Item messages carry `discoveredAt`; item processing logs `itemQueueAgeMs` so operators can monitor queue age.
- Tune `pageBudget`, `wallClockBudgetMs`, queue concurrency, and retry settings from observed discovery backlog, item age, retry rate, and same-user contention. Split credit-renewal item processing into a dedicated queue only if shared lifecycle-queue contention or backlog requires it.

## Monitor rollout health

Base Axiom filter:

`billingFlow = "kiloclaw_lifecycle"`

Watch:

- Discovery backlog: `event = "credit_renewal_discovery"`, `discoveryBacklogLikely = true`, `fetchedCount`, `enqueuedCount`, cursor fields.
- Item queue age: `event = "credit_renewal_item"`, `itemQueueAgeMs` p50/p95/max.
- Item outcomes: `event = "credit_renewal_item"`, grouped by `itemOutcome` (`renewed`, `canceled`, `past_due`, `auto_top_up`, `duplicate`, `skipped`).
- Queue retries/DLQ risk: `event in ("queue_retry", "run_failed")`, `billingSweep = "credit_renewal_item"`, `willGoToDlq = true`.
- Terminal failures: `event = "credit_renewal_terminal_failure"`, `terminalFailureCount`, `oldestUnresolvedTerminalFailureAt`, subscription and boundary fields.

Page if terminal failures are unresolved, if max item age approaches enforcement grace windows, or if discovery backlog remains true across repeated runs.

## Resolve, waive, or retry terminal failures

For each unresolved terminal failure:

1. Identify `subscriptionId`, `renewalBoundary`, `attempts`, and `oldestUnresolvedTerminalFailureAt` from logs or the terminal-failure table.
2. Inspect the subscription and credit ledger for that boundary.
3. Choose one auditable action:
   - Retry the item after the system issue is fixed; successful boundary advancement supersedes older unresolved failures. Generate a retry payload with `pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts retry-message --subscription-id <id> --renewal-boundary <iso>`.
   - Mark resolved after a successful operator retry: `pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts resolve --subscription-id <id> --renewal-boundary <iso> --actor-id <operator> --reason <reason>`.
   - Mark waived only when renewal should not be retried and enforcement protection should be removed: `pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts waive --subscription-id <id> --renewal-boundary <iso> --actor-id <operator> --reason <reason>`.
4. Use `pnpm exec tsx scripts/kiloclaw-terminal-renewal-failure.ts list [--subscription-id <id>]` to list unresolved failures before and after operator action.

Do not convert a terminal system failure into insufficient-credit past-due without confirming the balance decision was safely made.

## Rollback to serial sweep

If fanout creates unsafe backlog, terminal-failure volume, or queue instability:

1. Pause rollout or deploy the previous known-good worker.
2. If code rollback is needed, restore the `credit_renewal` lifecycle path to call the serial `runCreditRenewalSweep` implementation instead of enqueuing discovery/items.
3. Keep downstream enforcement protection for unresolved terminal failures until each failure is resolved, waived, retried successfully, or superseded.
4. Continue monitoring `credit_renewal_terminal_failure` logs and item retry/DLQ logs during rollback.

## Sensitive data guardrail

Do not log recipient emails, tokens, credentials, auth headers, cookies, webhook secrets, payment secrets, or side-effect payloads. Use IDs, renewal boundaries, counters, attempts, outcomes, and non-sensitive cursor data only.

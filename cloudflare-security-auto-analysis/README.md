# cloudflare-security-auto-analysis

Cloudflare Worker that automatically triages and analyzes security findings via a queue-based pipeline. Dispatches due owners on a per-minute cron, claims queued findings with pessimistic locking, runs LLM triage to filter noise, then launches full analysis sessions via `cloud-agent-next`.

## Endpoints

- `GET /health` — health check
- `POST /internal/dispatch` — manual dispatch trigger (bearer-token auth)
- Cron trigger (`* * * * *`) — discovers owners with queued work and enqueues them

## Queue

- Producer binding: `OWNER_QUEUE`
- Consumer queue: `security-auto-analysis-owner-queue` (`-dev` in dev)
- DLQ: `security-auto-analysis-owner-dlq`

The consumer claims rows per-owner with `FOR UPDATE SKIP LOCKED`, resolves an actor, runs triage, and launches analysis via `cloud-agent-next`.

## Service bindings

- `CLOUD_AGENT_NEXT` — launches analysis sessions
- `GIT_TOKEN_SERVICE` — resolves GitHub tokens for repo access (RPC via `GitTokenRPCEntrypoint`)

## Operational commands

```bash
# Trigger the dispatcher cron immediately (dev)
pnpm --filter cloudflare-security-auto-analysis exec wrangler triggers trigger --name security-auto-analysis-dev

# Enqueue a single owner message manually (dev)
pnpm --filter cloudflare-security-auto-analysis exec wrangler queues produce security-auto-analysis-owner-queue-dev \
  '{"ownerType":"org","ownerId":"<org_id>","dispatchId":"manual","enqueuedAt":"2026-01-01T00:00:00.000Z"}'

# Stream worker logs
pnpm --filter cloudflare-security-auto-analysis exec wrangler tail security-auto-analysis-dev

# Inspect queues
pnpm --filter cloudflare-security-auto-analysis exec wrangler queues list
```

---

## Runbook

### Queue states

`security_analysis_queue.queue_status`:

- `queued` — eligible and waiting for claim
- `pending` — claimed by worker consumer, launch in progress
- `running` — launch succeeded, waiting for callback
- `completed` — terminal success (including eligibility skips)
- `failed` — terminal error

### Key invariants

- Exactly one queue row per finding (`UQ_security_analysis_queue_finding_id`)
- Owner XOR: exactly one of `owned_by_organization_id` / `owned_by_user_id`
- `claim_token` must be non-null when state is `pending` or `running`

### Staleness thresholds

- `pending` is stale after 15 minutes
- `running` is stale after 2 hours

> **Note:** There is no automated reconciliation cron for stale rows yet. Stuck rows must be identified and resolved manually using the diagnostic queries below.

### Failure codes

`security_analysis_queue.failure_code`:

- `NETWORK_TIMEOUT` — retryable launch/callback timeout
- `UPSTREAM_5XX` — retryable upstream 5xx
- `TEMP_TOKEN_FAILURE` — token lookup threw (temporary; requeue)
- `START_CALL_AMBIGUOUS` — ambiguous launch result; retry or fail on max attempts
- `REQUEUE_TEMPORARY_PRECONDITION` — generic retryable precondition gate
- `ACTOR_RESOLUTION_FAILED` — no eligible actor; owner blocked
- `GITHUB_TOKEN_UNAVAILABLE` — actor resolved but no GitHub token
- `INVALID_CONFIG` — non-retryable config validation issue
- `MISSING_OWNERSHIP` — invalid owner linkage
- `PERMISSION_DENIED_PERMANENT` — non-retryable 403/forbidden
- `UNSUPPORTED_SEVERITY` — unsupported finding severity
- `INSUFFICIENT_CREDITS` — owner credit block, requeue with cooldown
- `STATE_GUARD_REJECTED` — state guard failure (missing finding/session/user/context)
- `SKIPPED_ALREADY_IN_PROGRESS` — analysis already running elsewhere
- `SKIPPED_NO_LONGER_ELIGIBLE` — finding/config no longer eligible at launch time
- `REOPEN_LOOP_GUARD` — reopen requeue cap reached
- `RUN_LOST` — stale `running` with no terminal progress

`security_analysis_owner_state.block_reason`:

- `INSUFFICIENT_CREDITS`
- `ACTOR_RESOLUTION_FAILED`
- `OPERATOR_PAUSE`

### Log fields for correlation

- `job_id`, `queue_id`, `finding_id`, `claim_token`
- `owned_by_organization_id` or `owned_by_user_id`
- `from_state`, `to_state`, `attempt_count`, `failure_code`
- `actor_user_id`, `actor_resolution_mode`

### Diagnostic: queue lag

```sql
SELECT
  queue_status,
  COUNT(*) AS rows,
  ROUND(EXTRACT(EPOCH FROM (now() - MIN(queued_at))) / 60.0, 1) AS oldest_queued_age_min,
  ROUND(EXTRACT(EPOCH FROM (now() - MAX(queued_at))) / 60.0, 1) AS newest_queued_age_min
FROM security_analysis_queue
GROUP BY queue_status
ORDER BY queue_status;
```

### Diagnostic: stuck pending/running

```sql
SELECT
  q.id, q.finding_id, q.queue_status, q.claim_token,
  q.claimed_by_job_id, q.claimed_at, q.updated_at,
  q.attempt_count, q.failure_code,
  f.analysis_status, f.analysis_started_at, f.analysis_completed_at
FROM security_analysis_queue q
JOIN security_findings f ON f.id = q.finding_id
WHERE (q.queue_status = 'pending' AND q.claimed_at <= now() - interval '15 minutes')
   OR (q.queue_status = 'running' AND q.updated_at <= now() - interval '2 hours')
ORDER BY q.queue_status, q.claimed_at NULLS LAST;
```

For stuck rows, manually transition them:

```sql
-- Requeue a stuck pending row
UPDATE security_analysis_queue
SET queue_status = 'queued', claim_token = NULL, claimed_at = NULL,
    claimed_by_job_id = NULL, failure_code = NULL, updated_at = now()
WHERE id = '<queue_id>' AND queue_status = 'pending';

-- Fail a stuck running row
UPDATE security_analysis_queue
SET queue_status = 'failed', failure_code = 'RUN_LOST',
    last_error_redacted = 'Manual reconciliation', updated_at = now()
WHERE id = '<queue_id>' AND queue_status = 'running';
```

Then trigger the dispatcher manually to resume processing.

### Diagnostic: duplicate launch suspicion

```sql
SELECT finding_id, COUNT(*) AS queue_rows
FROM security_analysis_queue
GROUP BY finding_id
HAVING COUNT(*) > 1;
```

If this returns rows, treat as an invariant violation and escalate.

### Diagnostic: actor resolution failures

```sql
SELECT
  owned_by_organization_id, owned_by_user_id,
  blocked_until, block_reason,
  consecutive_actor_resolution_failures,
  last_actor_resolution_failure_at
FROM security_analysis_owner_state
WHERE block_reason = 'ACTOR_RESOLUTION_FAILED'
   OR consecutive_actor_resolution_failures > 0
ORDER BY updated_at DESC;
```

Fix: ensure the owner has at least one eligible member with a GitHub token, then clear the block and trigger the dispatcher.

### Diagnostic: credit blocking

```sql
SELECT
  s.owned_by_organization_id, s.owned_by_user_id,
  s.block_reason, s.blocked_until,
  COUNT(q.id) FILTER (WHERE q.queue_status = 'queued') AS queued_rows
FROM security_analysis_owner_state s
LEFT JOIN security_analysis_queue q
  ON (s.owned_by_organization_id = q.owned_by_organization_id
      OR s.owned_by_user_id = q.owned_by_user_id)
WHERE s.block_reason = 'INSUFFICIENT_CREDITS'
  AND s.blocked_until > now()
GROUP BY s.owned_by_organization_id, s.owned_by_user_id, s.block_reason, s.blocked_until;
```

Do not clear the block until credits are restored. After top-up, clear the block and trigger the dispatcher.

### Rollback and kill-switch

**Global stop** (fastest):

1. Disable the Cloudflare scheduled trigger for `security-auto-analysis`
2. Pause the `security-auto-analysis-owner-queue` consumer
3. Verify queued backlog is no longer draining

**Owner-scoped stop** (surgical):

```sql
UPDATE security_analysis_owner_state
SET blocked_until = now() + interval '7 days',
    block_reason = 'OPERATOR_PAUSE', updated_at = now()
WHERE owned_by_organization_id = '<org_id>'
   OR owned_by_user_id = '<user_id>';
```

**Config-level disable:**

- Set `auto_analysis_enabled = false` in the owner's `agent_configs.config`
- Or disable the security agent entirely (`agent_configs.is_enabled = false`)

**Unpause owner:**

```sql
UPDATE security_analysis_owner_state
SET blocked_until = NULL, block_reason = NULL, updated_at = now()
WHERE owned_by_organization_id = '<org_id>'
   OR owned_by_user_id = '<user_id>';
```

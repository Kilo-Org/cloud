# Security Agent Observability Implementation Plan

Addresses Finding #15 from `SECURITY_AGENT_REVIEW.md`: "No Operational Observability Across Any Workflow."

---

## Guiding Principles

1. **Use existing infrastructure.** The codebase already has `emitApiMetrics`, `sentryLogger`, Sentry `startSpan`/`startInactiveSpan`, BetterStack heartbeats, and `sentryRootSpan`. The security agent should adopt these — not invent new patterns.
2. **Non-blocking.** All observability must be fire-and-forget or use Next.js `after()`. Metrics emission must never delay user-facing responses.
3. **Incremental delivery.** The plan is ordered by impact. Each phase is independently shippable and testable.

---

## Phase 1: Correlation ID and Structured Logging

**Goal:** Make it possible to trace a single finding through triage -> sandbox -> extraction -> auto-dismiss using one identifier, and replace raw `console.log` with `sentryLogger`.

### 1.1 Introduce `analysisCorrelationId`

Generate a correlation ID at the start of `startSecurityAnalysis` and thread it through every function in the pipeline.

**File: `services/analysis-service.ts`**

- At the top of `startSecurityAnalysis`, generate an ID:
  ```typescript
  import { randomUUID } from 'crypto';
  const correlationId = randomUUID();
  ```
- Pass `correlationId` as a parameter to:
  - `triageSecurityFinding()` (triage-service.ts)
  - `processAnalysisStream()` (analysis-service.ts)
  - `finalizeAnalysis()` (analysis-service.ts)
  - `extractSandboxAnalysis()` (extraction-service.ts)
  - `maybeAutoDismissAnalysis()` (auto-dismiss-service.ts)
- Store `correlationId` in the finding's `analysis` JSONB field so it can be queried later:
  ```typescript
  // In the analysis object written to DB
  { ...analysis, correlationId }
  ```

### 1.2 Replace `console.log` with `sentryLogger` across all services

Replace the ~76 manual `console.log`/`console.error` calls with `sentryLogger` (defined in `src/lib/utils.server.ts`). This gives dual output to console and Sentry with structured tags.

**Per-file logger instances:**

| File | Logger instance |
|------|----------------|
| `analysis-service.ts` | `sentryLogger('security-agent:analysis')` |
| `triage-service.ts` | `sentryLogger('security-agent:triage')` |
| `extraction-service.ts` | `sentryLogger('security-agent:extraction')` |
| `sync-service.ts` | `sentryLogger('security-agent:sync')` |
| `auto-dismiss-service.ts` | `sentryLogger('security-agent:auto-dismiss')` |
| `dependabot-api.ts` | `sentryLogger('security-agent:dependabot-api')` |
| `sync-security-alerts/route.ts` | `sentryLogger('security-agent:cron-sync')` |
| `cleanup-stale-analyses/route.ts` | `sentryLogger('security-agent:cron-cleanup')` |

**Severity mapping for existing logs:**
- Current `console.log` for routine operations -> `sentryLogger(source, 'info')` (only the important ones; remove noisy debug logs instead of converting them)
- Current `console.error` in catch blocks -> `sentryLogger(source, 'error')`
- Operation start/end logs -> `sentryLogger(source, 'info')`

**Include `correlationId` in all log calls** where available:
```typescript
const log = sentryLogger('security-agent:analysis', 'info');
log(`Tier 1 triage complete`, { correlationId, findingId, action: triage.suggestedAction });
```

### 1.3 Add Sentry scope context for the analysis pipeline

In `startSecurityAnalysis`, wrap the full operation in a Sentry scope so all events within the pipeline are tagged:

```typescript
import { withScope } from '@sentry/nextjs';

withScope((scope) => {
  scope.setTag('security_agent.correlation_id', correlationId);
  scope.setTag('security_agent.finding_id', findingId);
  // ... run pipeline
});
```

**Files changed in Phase 1:**
- `services/analysis-service.ts`
- `services/triage-service.ts`
- `services/extraction-service.ts`
- `services/sync-service.ts`
- `services/auto-dismiss-service.ts`
- `github/dependabot-api.ts`
- `app/api/cron/sync-security-alerts/route.ts`
- `app/api/cron/cleanup-stale-analyses/route.ts` (if it exists)
- `core/types.ts` (add `correlationId` to `SecurityFindingAnalysis`)

---

## Phase 2: LLM Call Timing and Token Tracking

**Goal:** Track latency and cost of every LLM call using the existing `emitApiMetrics` infrastructure.

### 2.1 Instrument triage LLM call

**File: `services/triage-service.ts`** — in `triageSecurityFinding()`

Wrap the `sendProxiedChatCompletion` call with timing and extract token usage from the response:

```typescript
const startTime = performance.now();
const result = await sendProxiedChatCompletion(/* ... */);
const durationMs = performance.now() - startTime;

// Extract token usage from response (if available in response body)
const usage = result?.usage; // { prompt_tokens, completion_tokens, total_tokens }

emitApiMetrics({
  kiloUserId: userId,
  organizationId,
  isAnonymous: false,
  isStreaming: false,
  userByok: false,
  mode: 'security-agent-triage',
  provider: 'anthropic',
  requestedModel: model,
  resolvedModel: model,
  toolsAvailable: ['submit_triage_result'],
  toolsUsed: ['submit_triage_result'],
  ttfbMs: durationMs, // non-streaming, so TTFB ~ total
  completeRequestMs: durationMs,
  statusCode: 200,
  tokens: usage ? {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  } : undefined,
  clientSecret: '', // internal call, no client secret
});
```

This requires threading `userId` and `organizationId` into `triageSecurityFinding`. These are already available in the caller (`startSecurityAnalysis`).

### 2.2 Instrument extraction LLM call

**File: `services/extraction-service.ts`** — in `extractSandboxAnalysis()`

Same pattern as triage:
- Wrap `sendProxiedChatCompletion` with `performance.now()` timing
- Extract `usage` from response
- Call `emitApiMetrics` with `mode: 'security-agent-extraction'`

### 2.3 Add Sentry spans for LLM calls

Wrap each LLM call in a Sentry span for trace visibility:

```typescript
import { startSpan } from '@sentry/nextjs';

const triageResult = await startSpan(
  { name: 'security-agent.triage', op: 'ai.inference' },
  async (span) => {
    const result = await sendProxiedChatCompletion(/* ... */);
    span.setAttribute('security_agent.model', model);
    span.setAttribute('security_agent.finding_id', findingId);
    span.setAttribute('security_agent.duration_ms', durationMs);
    if (usage) {
      span.setAttribute('security_agent.input_tokens', usage.prompt_tokens);
      span.setAttribute('security_agent.output_tokens', usage.completion_tokens);
    }
    return result;
  }
);
```

Do the same in extraction with `name: 'security-agent.extraction'`.

**Files changed in Phase 2:**
- `services/triage-service.ts`
- `services/extraction-service.ts`
- `services/analysis-service.ts` (threading userId/orgId to triage/extraction)

---

## Phase 3: Cron Job Heartbeats and Sync Workflow Metrics

**Goal:** Ensure cron jobs are monitored for liveness and that sync performance is measurable.

### 3.1 Implement BetterStack heartbeats

**File: `app/api/cron/sync-security-alerts/route.ts`**

Uncomment and implement the heartbeat pattern already TODO'd in the code. Follow the existing pattern from `cleanup-device-auth/route.ts` and `sync-model-stats/route.ts`:

```typescript
const BETTERSTACK_HEARTBEAT_URL =
  'https://uptime.betterstack.com/api/v1/heartbeat/<NEW_HEARTBEAT_ID>';

// On success (after runFullSync completes):
await fetch(BETTERSTACK_HEARTBEAT_URL).catch(() => {});

// On failure:
await fetch(`${BETTERSTACK_HEARTBEAT_URL}/fail`).catch(() => {});
```

The actual heartbeat ID must be created in the BetterStack dashboard first.

**File: `app/api/cron/cleanup-stale-analyses/route.ts`** (or equivalent)

Same pattern — create a second heartbeat monitor for the cleanup cron.

### 3.2 Add per-repository sync timing

**File: `services/sync-service.ts`** — in `syncDependabotAlertsForRepo()`

```typescript
const repoStartTime = performance.now();
// ... existing sync logic ...
const repoDurationMs = performance.now() - repoStartTime;

log(`Repo sync complete`, {
  correlationId: syncCorrelationId,
  repo: repoFullName,
  durationMs: repoDurationMs,
  alertsSynced: result.synced,
  errors: result.errors,
});
```

This makes it possible to identify slow repositories in the serial loop.

### 3.3 Add GitHub API rate limit tracking

**File: `github/dependabot-api.ts`** — in `fetchAllDependabotAlerts()`

After API calls, read rate limit headers from the Octokit response:

```typescript
// Octokit responses include headers
const alerts = await octokit.paginate(
  octokit.rest.dependabot.listAlertsForRepo,
  { owner, repo, per_page: 100 },
  (response) => {
    const remaining = response.headers['x-ratelimit-remaining'];
    const limit = response.headers['x-ratelimit-limit'];
    if (remaining !== undefined) {
      log(`GitHub API rate limit: ${remaining}/${limit} remaining`, {
        repo: `${owner}/${repo}`,
      });
      if (Number(remaining) < 100) {
        warn(`GitHub API rate limit low: ${remaining} remaining`, {
          repo: `${owner}/${repo}`,
        });
      }
    }
    return response.data;
  }
);
```

Use `sentryLogger('security-agent:dependabot-api', 'warning')` for the low-rate-limit warning so it surfaces in Sentry.

**Files changed in Phase 3:**
- `app/api/cron/sync-security-alerts/route.ts`
- `app/api/cron/cleanup-stale-analyses/route.ts`
- `services/sync-service.ts`
- `github/dependabot-api.ts`

---

## Phase 4: Analysis Pipeline Timing and Retry Instrumentation

**Goal:** Measure end-to-end analysis duration and instrument the R2 retry loop.

### 4.1 End-to-end analysis duration

**File: `services/analysis-service.ts`**

In `processAnalysisStream`, there is already a `const startTime = Date.now()` at line 309 that is never used. Use it:

```typescript
// At stream completion or failure:
const totalDurationMs = Date.now() - startTime;
log(`Analysis stream complete`, {
  correlationId,
  findingId,
  durationMs: totalDurationMs,
  status: 'completed', // or 'failed'
});
```

Also add a Sentry span wrapping the entire `processAnalysisStream`:

```typescript
await startSpan(
  { name: 'security-agent.sandbox-analysis', op: 'ai.pipeline' },
  async (span) => {
    span.setAttribute('security_agent.finding_id', findingId);
    span.setAttribute('security_agent.model', model);
    // ... existing stream processing logic ...
    span.setAttribute('security_agent.duration_ms', totalDurationMs);
  }
);
```

### 4.2 R2 retry loop instrumentation

**File: `services/analysis-service.ts`** — lines 383-391 (the exponential backoff loop for R2 fetches)

Track which attempt succeeds and the total wait time:

```typescript
let attemptNumber = 0;
const retryStartTime = performance.now();

for (const delay of [1500, 3000, 6000, 12000, 15000]) {
  attemptNumber++;
  await new Promise(resolve => setTimeout(resolve, delay));
  const result = await fetchAssistantMessages(/* ... */);
  if (result) {
    const retryDurationMs = performance.now() - retryStartTime;
    log(`R2 fetch succeeded`, {
      correlationId,
      findingId,
      attempt: attemptNumber,
      totalRetryDurationMs: retryDurationMs,
    });
    break;
  }
}
```

If all 5 attempts fail, log a warning with the total delay (~37.5s):

```typescript
warn(`R2 fetch failed after all attempts`, {
  correlationId,
  findingId,
  attempts: 5,
  totalDelayMs: 37500,
});
```

### 4.3 Tier transition timing

Add timing between tier transitions in `startSecurityAnalysis`:

```typescript
const tier1Start = performance.now();
const triage = await triageSecurityFinding(/* ... */);
const tier1DurationMs = performance.now() - tier1Start;

log(`Tier 1 complete`, { correlationId, findingId, durationMs: tier1DurationMs, action: triage.suggestedAction });

if (needsSandbox) {
  const tier2Start = performance.now();
  // ... launch sandbox ...
  // tier2 timing is tracked inside processAnalysisStream (4.1)
}
```

**Files changed in Phase 4:**
- `services/analysis-service.ts`

---

## Phase 5: Outcome Distribution and Degradation Detection

**Goal:** Track triage/extraction outcome distributions and fallback rates to detect silent degradation.

### 5.1 Triage outcome tracking

**File: `services/triage-service.ts`**

After a successful triage, emit a Sentry breadcrumb or span attribute with the outcome:

```typescript
import { addBreadcrumb } from '@sentry/nextjs';

addBreadcrumb({
  category: 'security-agent.triage',
  message: `Triage outcome: ${triage.suggestedAction}`,
  level: 'info',
  data: {
    correlationId,
    findingId,
    suggestedAction: triage.suggestedAction,
    confidence: triage.confidence,
    needsSandbox: triage.needsSandboxAnalysis,
    isFallback: false,
  },
});
```

When `createFallbackTriage` is called, log with `isFallback: true` and severity `'warning'`:

```typescript
warn(`Triage fell back to default`, { correlationId, findingId });

addBreadcrumb({
  category: 'security-agent.triage',
  message: 'Triage fallback used',
  level: 'warning',
  data: { correlationId, findingId, isFallback: true },
});
```

### 5.2 Extraction outcome tracking

**File: `services/extraction-service.ts`**

Same pattern — log extraction outcomes and track fallback usage:

```typescript
addBreadcrumb({
  category: 'security-agent.extraction',
  message: `Extraction outcome: isExploitable=${analysis.isExploitable}`,
  level: 'info',
  data: {
    correlationId,
    findingId,
    isExploitable: analysis.isExploitable,
    suggestedAction: analysis.suggestedAction,
    isFallback: false,
  },
});
```

### 5.3 Auto-dismiss rate tracking

**File: `services/auto-dismiss-service.ts`**

In `maybeAutoDismissAnalysis`, log the outcome:

```typescript
log(`Auto-dismiss decision`, {
  correlationId,
  findingId,
  dismissed: result.dismissed,
  source: result.source, // 'triage' | 'sandbox'
});
```

In `autoDismissEligibleFindings` (bulk), log the summary:

```typescript
log(`Bulk auto-dismiss complete`, {
  dismissed: result.dismissed,
  skipped: result.skipped,
  errors: result.errors,
});
```

### 5.4 Stale analysis cleanup anomaly detection

**File: Cleanup cron route**

After `cleanupStaleAnalyses` returns, check if the count is abnormally high:

```typescript
const STALE_THRESHOLD = 10; // tune based on baseline

if (cleanedCount > STALE_THRESHOLD) {
  sentryLogger('security-agent:cron-cleanup', 'warning')(
    `Abnormally high stale analysis count: ${cleanedCount} (threshold: ${STALE_THRESHOLD})`,
    { cleanedCount }
  );
}
```

**Files changed in Phase 5:**
- `services/triage-service.ts`
- `services/extraction-service.ts`
- `services/auto-dismiss-service.ts`
- Cleanup cron route

---

## Implementation Order and Dependencies

```
Phase 1 (Correlation ID + Structured Logging)
  |
  v
Phase 2 (LLM Timing + Token Tracking)     Phase 3 (Heartbeats + Sync Metrics)
  |                                            |
  v                                            v
Phase 4 (Pipeline Timing + R2 Instrumentation)
  |
  v
Phase 5 (Outcome Distribution + Degradation Detection)
```

- **Phase 1** is prerequisite for all others — the correlation ID and `sentryLogger` adoption are foundational.
- **Phases 2 and 3** are independent of each other and can be done in parallel.
- **Phase 4** builds on the correlation ID from Phase 1.
- **Phase 5** builds on the logging from Phase 1 and can be done any time after Phase 1.

---

## Files Changed Summary

| File | Phase(s) | Changes |
|------|----------|---------|
| `core/types.ts` | 1 | Add `correlationId` to `SecurityFindingAnalysis` |
| `services/analysis-service.ts` | 1, 2, 4 | Correlation ID generation, sentryLogger, Sentry spans, timing, R2 instrumentation |
| `services/triage-service.ts` | 1, 2, 5 | sentryLogger, LLM timing + tokens, emitApiMetrics, outcome tracking |
| `services/extraction-service.ts` | 1, 2, 5 | sentryLogger, LLM timing + tokens, emitApiMetrics, outcome tracking |
| `services/sync-service.ts` | 1, 3 | sentryLogger, per-repo timing |
| `services/auto-dismiss-service.ts` | 1, 5 | sentryLogger, dismiss rate tracking |
| `github/dependabot-api.ts` | 1, 3 | sentryLogger, rate limit tracking |
| `app/api/cron/sync-security-alerts/route.ts` | 1, 3 | sentryLogger, BetterStack heartbeat |
| `app/api/cron/cleanup-stale-analyses/route.ts` | 1, 3, 5 | sentryLogger, BetterStack heartbeat, anomaly detection |

---

## What This Solves (mapped to Finding #15d)

| Gap from review | Addressed by |
|-----------------|-------------|
| "Know if the system is healthy" | Phase 3: BetterStack heartbeats on both crons |
| "Understand performance" | Phase 2: LLM call timing; Phase 3: per-repo sync timing; Phase 4: end-to-end analysis + R2 retry timing |
| "Track costs" | Phase 2: token usage via `emitApiMetrics` |
| "Detect degradation" | Phase 5: triage/extraction fallback rates, auto-dismiss failure rates |
| "Correlate across tiers" | Phase 1: `correlationId` threaded through triage -> sandbox -> extraction -> auto-dismiss |
| "Be alerted proactively" | Phase 3: BetterStack heartbeat failure alerts, GitHub rate limit warnings; Phase 5: stale analysis anomaly warnings |

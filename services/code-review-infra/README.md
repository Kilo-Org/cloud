# Cloudflare Code Review Worker

HTTP API Worker using Durable Objects to manage code review execution. Next.js owns the pending-review queue and per-owner concurrency; this Worker persists each dispatched attempt and routes it to the appropriate cloud-agent backend.

## Architecture

```text
GitHub/GitLab webhook
        |
        v
Next.js creates a pending review and checks owner capacity
        |
        v
POST /review with agentVersion v2
        |
        v
CodeReviewOrchestrator persists queued state and returns 202
        |
        v
waitUntil or fallback alarm starts cloud-agent-next
        |
        v
prepareSession + initiateFromKilocodeSessionV2
        |
        v
cloud-agent-next callback queue posts terminal status to Next.js
        |
        v
Next.js updates the review and dispatches the next pending review
```

New reviews use cloud-agent-next v2 callback execution. The Durable Object records the prepared cloud-agent and Kilo session IDs, then relies on the authenticated callback for terminal status instead of holding an SSE connection open.

The cloud-agent SSE v1 path remains only for legacy/replay payloads or persisted Durable Object state without `agentVersion: 'v2'`. That compatibility path calls `initiateSessionAsync`, processes SSE events, exposes them through `GET /reviews/:reviewId/events`, and also supplies an authenticated completion callback.

## Features

- **DB-based queue**: Next.js stores pending reviews and dispatches them when owner capacity is available.
- **Per-owner concurrency**: Next.js enforces concurrency independently for each organization or user.
- **Durable execution state**: Each review attempt has Durable Object state plus a fallback alarm for accepted queued work.
- **Callback completion**: cloud-agent-next reports terminal v2 status directly to the Next.js internal status endpoint.
- **Legacy compatibility**: cloud-agent SSE v1 remains only for legacy/replay payloads and persisted state without `agentVersion: 'v2'`.
- **Automatic dispatch**: Terminal status handling triggers dispatch of the next pending review.

## Flow

1. A webhook reaches Next.js, which creates a review with `status='pending'`.
2. Next.js checks owner capacity and dispatches an available review to `POST /review` with `agentVersion: 'v2'`.
3. The Worker creates the attempt's `CodeReviewOrchestrator`, persists queued state, schedules a fallback alarm, and returns `202 Accepted`.
4. `runReview()` routes v2 state to cloud-agent-next. A new session uses `prepareSession` followed by `initiateFromKilocodeSessionV2`; an eligible follow-up can continue an existing v2 session.
5. The Worker derives an `X-Callback-Token`, passes the callback target to cloud-agent-next, and records the prepared session IDs.
6. cloud-agent-next delivers terminal status through its callback queue. Next.js updates the database and dispatches the next pending review.
7. Only legacy/replay payloads or persisted state without `agentVersion: 'v2'` use the cloud-agent SSE v1 compatibility flow.

## Setup

### 1. Install Dependencies

From the repository root:

```bash
pnpm install
```

### 2. Configure Environment Variables

For local development, copy `services/code-review-infra/.dev.vars.example` to `services/code-review-infra/.dev.vars` and fill in the values. Production URLs are configured in `wrangler.jsonc`; production secrets should be set with `wrangler secret put`.

Required Worker variables:

| Variable | Configuration | Purpose |
|---|---|---|
| `API_URL` | Wrangler var | Next.js base URL used for status callbacks and usage reporting. |
| `CLOUD_AGENT_NEXT_URL` | Wrangler var | cloud-agent-next endpoint used by the default v2 callback path for new reviews. |
| `CLOUD_AGENT_URL` | Wrangler var | cloud-agent endpoint retained for SSE v1 legacy/replay compatibility. |
| `INTERNAL_API_SECRET` | Secret | Authenticates cloud-agent-next internal procedures and the Next.js usage endpoint. |
| `CALLBACK_TOKEN_SECRET` | Secret | Derives scoped `X-Callback-Token` values for status updates and cloud-agent callbacks. |
| `BACKEND_AUTH_TOKEN` | Secret | Authenticates incoming Next.js requests to this Worker. |

`SENTRY_DSN` is optional. `CODE_REVIEW_ORCHESTRATOR` is a Durable Object binding configured in `wrangler.jsonc`, not an environment variable.

### 3. Deploy Worker

```bash
pnpm --filter kilo-code-review-worker deploy
```

### 4. Configure Next.js Backend

The callback token secret must match the Worker's value so Next.js can validate callback requests.

```bash
CODE_REVIEW_WORKER_URL=https://kilo-code-review-worker.{account}.workers.dev
CODE_REVIEW_WORKER_AUTH_TOKEN=your-worker-auth-token
INTERNAL_API_SECRET=same-internal-secret-as-worker
CALLBACK_TOKEN_SECRET=same-callback-secret-as-worker
```

## Development

### Local Development

```bash
pnpm --filter kilo-code-review-worker dev
```

### Tail Logs

```bash
pnpm --filter kilo-code-review-worker tail
```

## Request Format

The Worker expects authenticated `POST` requests to `/review` with this payload:

```typescript
{
  reviewId: string;
  attemptId?: string;
  authToken: string;
  owner: {
    type: 'user' | 'org';
    id: string;
    userId: string;
  };
  sessionInput: {
    githubRepo?: string;
    gitUrl?: string;
    prompt: string;
    mode: 'code';
    model: string;
    upstreamBranch: string;
  };
  skipBalanceCheck?: boolean; // Bypasses cloud-agent balance validation.
  agentVersion?: string; // New reviews send "v2"; payloads without it are legacy/replay only.
  previousCloudAgentSessionId?: string;
}
```

## Concurrency Control

Per-owner concurrency remains in Next.js dispatch logic:

- Next.js queries the database for active review count before dispatching.
- Reviews remain pending until owner capacity is available.
- Terminal status handling starts dispatch for the next pending review.
- One owner's active reviews do not consume another owner's capacity.

# Cloudflare Code Review Worker

HTTP API worker using Durable Objects for managing code review lifecycle. Concurrency control and dispatch logic handled in Next.js.

## Architecture

```
GitHub Webhook → Next.js (create pending) → tryDispatchPendingReviews()
                                                    ↓
                                          Query DB (active count + pending)
                                                    ↓
                                          Call Worker → CodeReviewOrchestrator DO
                                                              ↓
                                                   Maintain SSE subscription
                                                              ↓
                                        On complete → Update DB → Dispatch next pending
```

## Features

- **DB-Based Queue**: Reviews stored as "pending" in DB, dispatched when slots available
- **Per-Owner Concurrency**: Max 4 concurrent reviews per organization/user
- **Automatic Dispatch**: When review completes, next pending review starts automatically
- **Always Accepts Webhooks**: Never returns 429, all reviews queued as pending
- **Durable Objects**: Each review gets its own DO instance maintaining cloud agent connection
- **Minimal Worker Logic**: All business logic in Next.js, worker just runs reviews

## Flow

1. **Webhook arrives** → Next.js creates review with `status='pending'`
2. **Dispatch check** → Next.js checks available slots for owner
3. **If slots available** → Calls worker to create CodeReviewOrchestrator DO
4. **Review runs** → DO maintains cloud agent SSE connection (5+ minutes)
5. **On completion** → DO updates DB, Next.js dispatches next pending review

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.dev.vars.example` to `.dev.vars` and fill in values:

```bash
cp .dev.vars.example .dev.vars
```

Required variables:

- `API_URL`: Backend API URL for status callbacks (configured in `wrangler.jsonc` vars, e.g., `https://app.kilo.ai`)
- `INTERNAL_API_SECRET`: Shared secret for API authentication (secret, set via `wrangler secret put`)
- `CLOUD_AGENT_URL`: Cloud agent URL (configured in `wrangler.jsonc` vars
- `BACKEND_AUTH_TOKEN`: Token for authenticating Next.js → Worker requests (secret, set via `wrangler secret put`)

### 3. Deploy Worker

```bash
npm run deploy
```

### 4. Configure Next.js Backend

Add to Next.js `.env`:

```bash
# Code Review Worker Configuration
CODE_REVIEW_WORKER_URL=https://kilo-code-review-worker.{account}.workers.dev
CODE_REVIEW_WORKER_AUTH_TOKEN=your-worker-auth-token
INTERNAL_API_SECRET=same-secret-as-worker
```

## Development

### Local Development

```bash
npm run dev
```

### Tail Logs

```bash
npm run tail
```

## Request Format

Worker expects POST requests to `/review` with this payload:

```typescript
{
  reviewId: string;
  authToken: string; // JWT for cloud agent
  owner: {
    type: 'user' | 'org';
    id: string;
    userId: string;
  }
  sessionInput: {
    // Complete cloud agent payload
    githubRepo: string;
    prompt: string;
    model: string;
    // ... etc
  }
}
```

## Concurrency Control

Per-owner concurrency is enforced in Next.js dispatch logic:

- **Max 4 concurrent reviews per owner** (organization or user)
- Next.js queries DB for active review count before dispatching
- Reviews wait in DB as "pending" until slots available
- When review completes, dispatch automatically picks up next pending
- Concurrency is isolated per owner - one user's reviews don't block another's

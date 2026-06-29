# Cloudflare Code Review Worker

HTTP API worker that uses Durable Objects to dispatch and track Code Review sessions on Cloud Agent Next. Next.js owns queueing and per-owner concurrency.

## Flow

1. Next.js stores a pending review and reserves an available owner slot.
2. Next.js sends `POST /review` with the prepared session input.
3. The review Durable Object prepares a Cloud Agent Next session and initiates execution.
4. Follow-up reviews continue a healthy previous session; unhealthy or unavailable sessions fall back to a fresh session.
5. Cloud Agent Next delivers terminal status through the configured callback target.
6. The worker supports cancellation and one fresh-session retry for classified infrastructure failures.

## Configuration

Copy `.dev.vars.example` to `.dev.vars` for local development. Required values are:

- `API_URL`: Next.js backend URL used for status callbacks.
- `INTERNAL_API_SECRET`: Shared secret for internal Cloud Agent Next procedures.
- `CALLBACK_TOKEN_SECRET`: HMAC secret used to derive callback tokens.
- `BACKEND_AUTH_TOKEN`: Token authenticating Next.js requests to this worker.
- `CLOUD_AGENT_NEXT_URL`: Cloud Agent Next service URL.

Production secrets are set with `wrangler secret put`; public URLs are configured in `wrangler.jsonc`.

## Development

```bash
pnpm --filter kilo-code-review-worker dev
pnpm --filter kilo-code-review-worker test
pnpm --filter kilo-code-review-worker typecheck
pnpm --filter kilo-code-review-worker lint
```

## Request

`POST /review` accepts:

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
  previousCloudAgentSessionId?: string;
}
```

The worker returns `202 Accepted` after durable state is created. Execution continues through the Durable Object and Cloud Agent Next callbacks.

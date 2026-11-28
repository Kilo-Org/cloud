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

### Status writes (`CODE_REVIEW_STATUS_CALLBACK_AUTH`)

The review Durable Object writes `running` and failure status to the web app's
`POST /api/internal/code-review-status/{reviewId}` itself. Its credential is
`CODE_REVIEW_STATUS_CALLBACK_AUTH` (`src/status-callback-auth.ts`):

- absent, empty or `legacy`: the `X-Callback-Token` derived from `CALLBACK_TOKEN_SECRET`, as before;
- `sts`: only a `web:code-review.status-callback` STS service
  token in `Authorization: Bearer`, minted over the `STS` binding (`props.caller`
  `kilo-code-review-worker`), never following a redirect. Without a token the write fails; it never
  falls back to the derived token.

Production leaves it unset. Set `sts` only once the web route accepts that token; rollback is
`legacy`. `wrangler.jsonc` binds no STS yet: batch B (#13047) adds the `STS` binding and this
Worker's worker-binding policy, and the registry PR adds the grant. Until then `sts` fails closed
(`sts_binding_missing`). The callback target handed to Cloud Agent Next keeps the derived token:
Cloud Agent Next delivers that callback with its own credential. The test config
(`wrangler.test.jsonc`) binds no STS and stays on `legacy`.

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

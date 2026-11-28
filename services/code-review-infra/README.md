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
`SECRETS_SOURCE` selects where the runtime reads them: `secrets-store` (the bindings above) or `sts`
(the bundle over the `STS` SecretsBroker binding). An unrecognised value refuses every read, and the
`sts` source never falls back to the legacy binding.

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
`legacy`. `wrangler.jsonc` binds `STS` and this Worker's worker-binding policy; the registry PR adds
the status-write grant, and until it lands `sts` fails closed as denied (`unknown_scope`). The
callback target handed to Cloud Agent Next keeps the derived token:
Cloud Agent Next delivers that callback with its own credential. The test config
(`wrangler.test.jsonc`) binds no STS and stays on `legacy`.

### Review route credentials (`BACKEND_CREDENTIAL_ACCEPT`)

Web calls the review routes with one credential in `Authorization: Bearer`, chosen by its own
`CODE_REVIEW_WORKER_SENDER_AUTH`. `BACKEND_CREDENTIAL_ACCEPT` (`src/backend-auth.ts`) selects what
the routes accept:

- absent, empty or `legacy-only`: the `BACKEND_AUTH_TOKEN` bearer, exactly as before, with no
  verifier and no key-set fetch;
- `legacy-and-sts`: the bearer is compared with `BACKEND_AUTH_TOKEN` exactly first; any other value,
  a malformed token included, must be an STS service token, and that refusal is final;
- `sts-only`: only an STS service token; the shared secret is never read;
- `disabled`: every review route answers 401. Any other value answers 500.

The STS token must carry audience `code-review`, the scope of its route and the `web` workload,
from the issuer of `STS_ENVIRONMENT` (`production`, or `development` for `wrangler dev`; there is
no staging deployment):

| Route | Scope |
|---|---|
| `POST /review` | `code-review:review.dispatch` |
| `GET /reviews/:reviewId/status` | `code-review:review.status-read` |
| `POST /reviews/:reviewId/cancel` | `code-review:review.cancel` |
| `POST /reviews/:reviewId/retry-fresh` | `code-review:review.retry-fresh` |

`/health` and unmatched paths keep the `BACKEND_AUTH_TOKEN` check in every mode. In an STS mode,
`GET /.well-known/oauth-protected-resource` serves the RFC 9728 document that every STS challenge
names. Admissions are counted in `kilo_internal_auth` lines (`@kilocode/worker-utils`, aggregated
per minute; the first admission of a bucket is written at once) by route, `auth`
(`legacy_shared_secret` or `sts`) and `caller`, which for `sts` is the verified workload; a refusal
logs `code_review_backend_sts_refused` with the route, status and rule. Neither carries a credential.

Production leaves `BACKEND_CREDENTIAL_ACCEPT` unset until the scopes are registered and granted to
`web`. The flip order is `legacy-and-sts` here, then `sts` on web, then `sts-only` here; rollback is
`legacy-only`.

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

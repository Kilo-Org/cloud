# @kilocode/worker-uts-auth

The phase 4 dual-accept gate for a Worker's user routes (design 7, 9.1, 9.5). It decides, per
request, whether the route's existing legacy check runs unchanged or a UTS access token is verified
with `@kilocode/verify`. Only the Workers that move user routes to UTS import it.

## Use

```ts
import { createUtsUserGate } from '@kilocode/worker-uts-auth';

// Module scope: the gate holds one verifier per UTS environment for the whole isolate.
export const gate = createUtsUserGate({
  audience: 'notifications',
  routes: {
    badgesRead: { scope: 'notifications:badges.read', requiresSession: true, org: 'forbidden' },
  },
});

const decision = await gate.decide(
  extractBearerToken(request.headers.get('authorization')),
  { mode: env.USER_BEARER_ACCEPT, environment: env.WORKER_ENV, feed: env.UTS_FEED },
  'badgesRead',
  promise => ctx.waitUntil(promise)
);
// { kind: 'legacy' }: run the legacy check unchanged.
// { kind: 'uts', caller, claims }: a verified UTS user; keep the route's own account,
//   membership and ownership checks.
// { kind: 'refused', response }: send `response` as is.
```

Serve `gate.metadata(env)` at `/.well-known/oauth-protected-resource` (RFC 9728); every UTS 401
challenge names it.

## Configuration

| Worker setting | Meaning |
|---|---|
| `USER_BEARER_ACCEPT` | `disabled`, `legacy-only` (default when unset), `legacy-and-uts` or `uts-only`. Any other value answers 500 for every bearer. |
| `WORKER_ENV` / `ENVIRONMENT` | `production`, `staging` or `development`: picks the UTS issuer and the resource origin from `@kilocode/uts-contracts`. Any other value accepts no UTS token. |
| `UTS_FEED` | Service binding to the UTS feed Worker (`uts-feed`, `uts-feed-staging` or `uts-feed-local`), entrypoint `FeedReader`, `props.caller` = the Worker's own deployed name. |

## Rules

- UTS issuer only, no PAT port: an STS token and a PAT get 401. The verifier runs with the
  deployment's environment, so a token whose `env` claim names another one, or none, gets 401.
  Each route requires a session explicitly; a token with `act` gets 403 `insufficient_scope`;
  `org: 'forbidden'` refuses an organization-bound token and `org: 'required'` refuses a token
  without one (and, given `requestOrg`, any other organization), each with 403 `org_mismatch`.
- The caller's `client_id` must be one of the scope's registry `allowedClients` (else 403
  `insufficient_scope`), and `exp - iat` must not exceed its `maxLifetimeSeconds` (else 401).
- A missing environment mapping, resource origin or feed binding answers 500 (fail closed).
  Library failures keep their status and headers: 401/403 with the challenge, 503 with
  `Retry-After`. The gate's own 401 and `insufficient_scope` refusals carry the same `no-store`
  challenge, naming the route scope on a 403; `resource_metadata` appears only when the
  deployment serves its metadata. A mode refusal (`disabled`, a family the mode does not accept)
  reads configuration only.
- Mode `legacy-only` builds no verifier and makes no feed call.
- The key-set refresh reads `FeedReader.jwks()`; only a cold isolate reads `FeedReader.bootstrap()`.

## Tests

`@kilocode/worker-uts-auth/testing` serves real signed tokens, a real signed revocation head and
list, and the `FeedReader` answer shapes; `@kilocode/verify` checks every one.

```sh
pnpm --filter @kilocode/worker-uts-auth typecheck
pnpm --filter @kilocode/worker-uts-auth lint
pnpm --filter @kilocode/worker-uts-auth test
```

# auto-routing

## Internal route authentication

`/admin/*` and `POST /decide` are internal routes. Today they take
`Authorization: Bearer <INTERNAL_API_SECRET>`, and they can also take an STS service token with the
`auto-routing` audience. The user-authenticated routes (`/v1/decide` and `/v1/eval/*`) verify the
caller's Kilo token instead, and `/health` keeps the secret in every mode.

`INTERNAL_CREDENTIAL_ACCEPT` (`src/auth.ts`) chooses the credential of the internal routes:

| Value | Internal routes accept |
|---|---|
| unset, empty or `legacy-only` | only the secret, exactly as before; no key set is fetched |
| `legacy-and-sts` | the secret, or an STS token of the route's scope |
| `sts-only` | only an STS token; the secret is never read |
| `disabled` | nothing (401) |

Any other value answers 500. An STS mode also needs `STS_ENVIRONMENT` (`production` in the
production deployment), or an STS token answers 500. `wrangler.jsonc` sets neither, so production
runs `legacy-only`. Rollback is a redeploy with the switch unset or `legacy-only`.

While the switch admits STS, `GET /.well-known/oauth-protected-resource` serves the RFC 9728
metadata that every STS challenge names; otherwise that path stays behind the secret.

Each route takes one scope, and the route also checks the token's workload:

| Scope | Routes | Sender |
|---|---|---|
| `auto-routing:admin.read` | `GET /admin/classifier-model`, `/admin/routing-mode`, `/admin/classifier-analytics` | `web` |
| `auto-routing:admin.write` | `PUT /admin/classifier-model`, `/admin/routing-mode` | `web` |
| `auto-routing:decide` | `POST /decide` | `ai-gateway` |

`GOVERNED_ROUTES` in `src/auth.ts` maps each route; a new internal route needs its entry there.
Both credentials travel in `Authorization`, so a repeated or comma-joined header is refused with
400, and a refused STS token is never retried as the secret. Every admission writes the
`kilo_internal_auth` line with `auth` `legacy_shared_secret` or `sts` and, for STS, the verified
workload as `caller`.

Before `legacy-and-sts`, confirm the secret contains no dots or commas: a bearer shaped like a
compact JWS goes to STS, and a comma reads as two credentials. Before `sts-only`, every caller needs
an STS sender first: the web admin clients and routing-mode API, the gateway's decide calls, and
operator steps such as `scripts/decide-replay.ts`, which today hold only the secret.

The decision ID HMAC (`AUTO_ROUTING_DECISION_SECRET`) is separate and unchanged.

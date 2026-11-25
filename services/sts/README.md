# STS — the secrets broker

STS serves each workload one bundle of runtime secrets read from Infisical Cloud EU, and it records
every delivery in an audit log that a queue relays to the audit pipeline. It is phase 1 of the
secrets design: service-token minting, database leases, CI deploy tokens and the audit queue
consumer are not part of this Worker.

## How a read works

- A Worker in the account binds `SecretsBroker`
  (`services: [{ binding, service: "sts", entrypoint: "SecretsBroker", props: { caller: "<own worker name>" } }]`)
  and STS authorizes on `props.caller` against `policy/*.yaml`. This is deploy-level trust: only a
  deploy right in this Cloudflare account can set `props`. The Durable Object classes
  (`BundleDO`, `RefresherDO`, `SignerDO`) are internal: no other Worker may bind them, and the repo
  check in `test/repo/` fails a config that does.
- A caller outside the account posts a provider OIDC token to `POST /v1/bundle`. STS verifies the
  token against the provider's published keys, maps the claims to the one policy that declares them,
  and answers with the bundle. A provider whose discovery document or key set cannot be fetched
  gets `503` with `Retry-After: 30` (`unavailable`, reason `internal`), never a rejection.
- One Durable Object per environment and workload holds that workload's bundle, sealed with an
  AES-GCM key generated inside the object. A read whose ETag still matches returns `304` (with
  `X-STS-Stale` and `X-STS-Fetched-At`) and writes no audit row, only a per-minute counter; every
  other delivery appends one `ai.kilo.sts.bundle.delivered` row in the same call, and a failed
  append refuses the read. An event too large to travel in a queue message on its own is refused at
  append time, so the read fails closed and the relay never has to skip a row.
- The ETag is an HMAC-SHA256, under a second key that only the bundle object holds, over the
  workload's policy hash and every secret's manager id, version and value. A value replaced under
  the same version (a delete and recreate in Infisical) therefore reaches the workload.
- A copy built under an older policy (for example during a manager outage right after a deploy) is
  cut down to the current grants on read, with its ETag and `missing` list recomputed, so a removed
  grant is never served.
- An empty object (a new workload) asks the refresher for its bundle and waits; concurrent reads
  share one fill, and the refresher merges concurrent fills into one login and one read pair. Each
  Infisical request has an 8-second timeout, so a fill fits the secrets client's 25-second
  first-load window.

Routes: `POST /v1/bundle`, `GET /manager-auth/.well-known/jwks.json` (the manager login key set),
`POST /manager-webhook` (Infisical `secrets.modified`). Production is `https://sts.kiloapps.io`,
staging is `https://sts-staging.kiloapps.io`.

## The refresher

One `RefresherDO` per environment reads the manager in pairs: `GET /api/v4/secrets` for `/workloads`
and for `/shared`, both with `recursive=true`, `expandSecretReferences=false` and
`includeImports=false` (https://infisical.com/docs/api-reference/endpoints/secrets/list). It
revalidates each folder with its ETag, so an unchanged folder costs a 304.

- **Resolution.** A workload's policy names secrets. Each name resolves from
  `/workloads/<workload>` first, then `/shared`; secrets in deeper folders are never served. A name
  found in neither is listed in the bundle's `missing`.
- **Missing folder.** Infisical answers a folder that does not exist with 404 and error
  `SecretPathNotFound`; STS reads that as an empty folder, not an outage. Only a transport error, a
  timeout, 429, 5xx, a refused login or a malformed response counts as unreachable.
- **References.** The `kilo` project uses no secret references. A value that starts with `${` is
  refused: STS keeps the last good copy of that one secret (or leaves it missing), logs
  `sts: manager value refused`, appends one `ai.kilo.sts.manager.reference_refused` audit event per
  refused version (names and versions only), and updates every other secret.
- **Cadence.** Every 4 minutes. A signed `secrets.modified` webhook opens a 30-second merge window;
  the refresh runs at the window's end and never sooner than 30 seconds after the last refresh. A
  policy change after a deploy refreshes within about 5 seconds.
- **Backoff.** After a failed read the next attempt waits 15 s, 30 s, 60 s, 120 s, then 240 s
  (each jittered over its upper half; a 429's `Retry-After` raises it, capped at 4 minutes).
  Webhooks do not shorten a running backoff. Bundle objects keep serving their copies, marked
  stale, and an empty object is filled stale from the refresher's last copy.
- **Token.** The Infisical access token is cached until 60 seconds before it expires; concurrent
  logins merge into one.
- **Starting the loop.** Each bundle object asks the refresher, in the background and at most once
  a minute, to confirm its alarm; the read never waits on it.

## Configuration

No secret is stored in this Worker's configuration. Everything is a plain var, validated with zod
at the start of each entry.

| Var | Meaning |
|---|---|
| `STS_ENVIRONMENT` | `development`, `staging` or `production`. Also the Durable Object name prefix. |
| `STS_ISSUER` | Public base URL, `https://sts.kiloapps.io` in production. |
| `MANAGER_BASE_URL` | Infisical Cloud base URL, `https://eu.infisical.com`. |
| `MANAGER_PROJECT_ID` | The Infisical project `kilo`. |
| `MANAGER_ENVIRONMENT_SLUG` | `development`, `staging` or `production`. |
| `MANAGER_IDENTITY_ID` | The Infisical machine identity STS logs in as, one per environment. |
| `DO_JURISDICTION` | `eu` in production and staging, `none` locally. |

Bindings: `AUDIT_QUEUE` (queue producer), `STS_BUNDLE_DO`, `STS_REFRESHER_DO`, `STS_SIGNER_DO`.

## Policy

One file per workload in `policy/`, named `<workload>.yaml`. The schema is strict: an unknown field,
a non-canonical secret name, or a duplicate identity binding fails the load, and a workload with no
policy is denied. Example:

```yaml
workload: o11y
environments: [development, staging, production]
identity:
  kind: worker-binding
secrets:
  - O11Y_CF_AE_API_TOKEN
```

Identity kinds:

- `worker-binding`: the caller's `props.caller`.
- `fly-oidc`: `org`, `orgId`, `app`, `appId`. The token's `org_id` and `app_id` must match, as well
  as the names, so a recreated app with the same name is refused
  (https://fly.io/docs/security/openid-connect/).
- `github-oidc`: `repositoryId`, `repositoryOwnerId`, plus `environments` (the GitHub environment
  claim), `refs`, or both; both must match when both are set. A policy that grants `production` must
  bind `environments`. Tokens from `pull_request_target`, `workflow_run` and `issue_comment` are
  refused unless `allowedEvents` names the event.

Not yet supported: `vercel-oidc`. The design accepts a Vercel token only with STS's own audience,
which needs the per-audience token exchange and its proof run (design 4.4); it comes with the first
Vercel workload. Until then a Vercel token is refused like any unlisted issuer. A default-audience
Vercel token (`https://vercel.com/<team>`) is shared by every relying party of the team, which is
why the exchange is a prerequisite.

Adding a file also means adding it to `src/policy/registry.ts`; the typed import map in
`src/policy/index.ts` makes the two disagree at typecheck, and `test/repo/policy-files.test.ts`
checks the directory itself and the Worker configs that bind STS.

The first refresher check after a deploy compares the policy hash with the stored one and writes one
`ai.kilo.sts.policy.changed` event naming the workloads and secret names that were added or removed.
Secret values never appear in an audit event, a log line or a Durable Object response.

## Infisical setup, per environment

**Machine identity with JWT Auth** (https://infisical.com/docs/documentation/platform/identities/jwt-auth;
login `POST /api/v1/auth/jwt-auth/login` with `identityId` and `jwt`,
https://infisical.com/docs/api-reference/endpoints/jwt-auth/login):

| Field | Value |
|---|---|
| Configuration | JWKS |
| JWKS URL | `https://sts.kiloapps.io/manager-auth/.well-known/jwks.json` (staging: `https://sts-staging.kiloapps.io/...`) |
| Issuer | `https://sts.kiloapps.io/manager-auth` (staging: `https://sts-staging.kiloapps.io/manager-auth`) |
| Audience | `https://eu.infisical.com/identities/<that identity's id>` |
| Subject | `sts:production:refresher` (staging: `sts:staging:refresher`, local: `sts:development:refresher`) |
| Access token TTL and max TTL | 600 seconds |

Every value is exact, with no `*`. STS signs the login JWT (2-minute lifetime, a fresh `jti`) with an
ECDSA P-256 (`ES256`) key generated inside `SignerDO`; the private half never leaves that object.
The key set is separate from any other STS signing material. To cut STS off at once, take the key
out of the key set the identity trusts (or remove the identity's JWT Auth method): no new login
succeeds, and the last access token expires within 10 minutes (design 4.2).

The identity's project role grants `readValue` on `/workloads/**` and `/shared/**` of its own
environment in the `kilo` project, and no write.

**Webhook.** One `secrets.modified` webhook per environment, scoped to that environment, of type
General, to `https://sts.kiloapps.io/manager-webhook` (staging: `https://sts-staging.kiloapps.io/manager-webhook`),
with a secret key (https://infisical.com/docs/documentation/platform/webhooks). STS checks
`x-infisical-signature` (`t=<ms>;<hex HMAC-SHA256 of the body>`), refuses a timestamp more than
5 minutes from now, and acts only on its own project and environment.

The webhook secret is generated by STS, not stored anywhere else and not bound from the Secrets
Store. The refresher object creates it on its first request. The break-glass owner copies it once:
Cloudflare dashboard → Workers & Pages → `sts` (or `sts-staging`) → Durable Objects →
`RefresherDO` → Data Studio → the object named `production` (or `staging`) → table `webhook_key` →
column `key`, and pastes it into the Infisical webhook's secret key field; Terraform then ignores
that field (design 4.2). Data Studio is available to account members who can already read every
Durable Object's storage, so this adds no reader (https://developers.cloudflare.com/durable-objects/observability/data-studio).
A webhook only shortens the wait for the next read; a forged or lost one cannot change a bundle.

## Local development

```sh
pnpm --filter cloudflare-sts dev     # wrangler dev --env local
```

The local block serves `http://localhost:8825` with `DO_JURISDICTION=none` (workerd enforces no data
residency) and the local queue `kilo-audit-local`. The manager login key set is served at
`http://localhost:8825/manager-auth/.well-known/jwks.json`. Infisical Cloud cannot fetch a key set
from `localhost`, so a local manager login needs a public tunnel and an identity configured with
its URL; without one, a bundle read reports `manager_unreachable_no_copy`.

Local Durable Object state from an earlier revision of this Worker must be wiped
(`rm -rf services/sts/.wrangler/state`): the migrations were regenerated before the first deploy.

## Production prerequisites

1. **DNS and route**: a custom domain `sts.kiloapps.io` on the `kiloapps.io` zone, and
   `sts-staging.kiloapps.io` for staging. `workers_dev` stays false.
2. **Queues**: `kilo-audit` (production) and `kilo-audit-staging`, both EU. The producer binding
   exists here; the consumer is the separate audit-relay service.
3. **Infisical**: per environment, the JWT Auth identity, its role, and the webhook described
   above. `MANAGER_PROJECT_ID` and `MANAGER_IDENTITY_ID` are committed per environment.
4. **Runtime secrets**: every name in a policy file exists in `/workloads/<workload>` or `/shared`
   of that environment. A name the manager does not hold is reported in `missing` rather than
   failing the read.

## Tests

`pnpm --filter cloudflare-sts test` runs the Workers-pool suites in `test/worker/` (identity
acceptance and outages per provider against locally generated key sets, policy schema, bundle
delivery, ETags, policy narrowing, fills, relay and pruning, the refresher against a mocked
Infisical: login, folder reads, resolution, references, backoff, webhooks) and then the Node suite in
`test/repo/` (policy files and the Worker config checks). `typecheck` and `lint` are the usual
package scripts.

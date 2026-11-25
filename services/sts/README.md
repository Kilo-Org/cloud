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
  (`BundleDO`, `RefresherDO`, `SignerDO`, `DenialDO`) are internal: no other Worker may bind them, and the repo
  check in `test/repo/` fails a config that does.
- A caller outside the account posts a provider OIDC token to `POST /v1/bundle`. STS verifies the
  token against the provider's published keys, maps the claims to the one policy that declares them,
  and answers with the bundle. A provider whose discovery document or key set cannot be fetched
  gets `503` with `Retry-After: 30` (`unavailable`, reason `internal`), never a rejection. A
  failed bundle object call answers the same way, over RPC and HTTP.
- **Denials are audited** (design 4.3: STS refuses and audits any other read). A refusal of an
  identified caller (a Worker with valid `props.caller`, or a token whose signature, issuer,
  audience and lifetime verified) goes after the response to one `DenialDO` per environment, the
  `sts:<environment>:denials` stream. Identical denials (same channel, reason, actor and stable
  claims such as `repository_id`, `environment`, `ref`, `event_name`, or `org_id`, `app_id`) merge
  per minute into one `ai.kilo.sts.bundle.denied` event with a `count`; at most 100 distinct
  denials are kept per minute, the rest are counted in one overflow event per reason. Each Worker
  isolate merges first: it sends the first occurrence of a denial in a minute and only counts the
  repeats, which ride on its next hop, so a replayed token costs no extra hop. The token
  itself is never recorded. A token that did not verify gets one structured log line and no audit
  row, since nothing in it can be trusted.
- One Durable Object per environment and workload holds that workload's bundle, sealed with an
  AES-GCM key generated inside the object. A read whose ETag still matches returns `304` (with
  `X-STS-Stale` and `X-STS-Fetched-At`) and writes no audit row, only a per-minute counter; every
  other delivery appends one `ai.kilo.sts.bundle.delivered` row in the same call, and a failed
  append refuses the read. An event too large to travel in a queue message on its own is refused at
  append time, so the read fails closed and the relay never has to skip a row.
- The ETag is an HMAC-SHA256, under a second key that only the bundle object holds, over the
  workload's policy hash and every secret's manager id, version and value. A value replaced under
  the same version (a delete and recreate in Infisical) therefore reaches the workload.
- A bundle whose `fetchedAt` is more than 8 minutes old (two refresh intervals) is served marked
  stale, whatever its flag says, so a copy whose pushes keep failing is never served as fresh.
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

### Internal Durable Objects

`BundleDO`, `RefresherDO`, `SignerDO` and `DenialDO` are internal. Their methods skip the policy
check and the audit row that `SecretsBroker` performs, so no other Worker may reach them: a
`durable_objects.bindings[].script_name`, workflow `script_name`, migration `from_script` or export
`transfer_from` naming `sts`, `sts-staging` or `sts-local`, an `unsafe` binding, or an STS service
binding at any entrypoint other than `SecretsBroker` fails `test/repo/worker-configs.test.ts`.

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
checks the directory itself.

`test/repo/worker-configs.test.ts` reads every `wrangler*.json`, `wrangler*.jsonc` and
`wrangler*.toml` the checkout tracks, or holds untracked and not ignored, test fixtures included
(`cloud-agent-e2e-deploy.yml` deploys `services/cloud-agent-next/test/e2e/wrangler.fake-llm.jsonc`).
Ignored configs stay out: `wrangler.runtime-generated.json` and
`.wrangler/wrangler.e2e-test.jsonc` are rendered at deploy time from a tracked `wrangler.jsonc` this
check already reads. Each file is parsed with Wrangler's own parser, every env block and every
`previews` block included. Every key Wrangler accepts is either modelled with a strict schema or
listed as inert in `test/repo/worker-configs.ts`; a key in neither list fails the check, an unknown
field inside a modelled binding fails the parse, and the suite fails when Wrangler's own schema
gains a key nobody classified. The check fails when:

- any block has an `unsafe` key;
- a Durable Object binding, workflow, tail consumer, dispatch outbound, migration transfer or export
  transfer names `sts`, `sts-*`, `audit-relay` or `audit-relay-*`;
- a service binding to `sts`/`sts-*` uses an entrypoint other than `SecretsBroker`, or any service
  binding targets `audit-relay`/`audit-relay-*`;
- the top-level (production) block binds anything but `sts`, an `<env>` block anything but
  `sts-<env>`, or a `previews` block binds STS at all (a preview runs unreviewed code);
- `props.caller` is not the config's top-level `name`, in any block;
- a config that binds STS has an env block whose `name` is neither absent nor `<name>-<env>`, or two
  configs share a top-level `name`;
- the caller has no `worker-binding` policy listing the environment the binding reaches;
- anything but the STS deployment of that environment (`sts` → `kilo-audit`, `sts-staging` →
  `kilo-audit-staging`, `sts-local` and the test config `sts-test` → `kilo-audit-local`) produces to
  a `kilo-audit*` queue, or anything but the matching `audit-relay*` deployment consumes one or
  dead-letters into one;
- anything but the matching relay deployment binds a `kilo-audit-archive*` bucket (`audit-relay` →
  `kilo-audit-archive`, `audit-relay-staging` → `kilo-audit-archive-staging`, `audit-relay-local` →
  `kilo-audit-archive-local`, the test config `audit-relay-test` → `kilo-audit-archive-test`), as
  `bucket_name` or `preview_bucket_name`, or the production or staging binding lacks
  `"jurisdiction": "eu"`;
- a route outside the STS or relay config covers one of their hostnames;
- a config other than the STS, STS test, relay or relay test config deploys under one of their
  names.

CI runs it whenever any Worker config changes (`scripts/affected-workspaces.mjs` routes every
`wrangler*` file to this workspace).

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
with a secret key (https://infisical.com/docs/documentation/platform/webhooks). The STS Worker
checks `x-infisical-signature` (`t=<ms>;<hex HMAC-SHA256 of the body>`) itself, refuses a timestamp
more than 5 minutes from now, and acts only on its own project and environment; only a verified
`secrets.modified` costs a refresher call. Each isolate loads the secret from the refresher once and
reloads it at most once a minute (after a signature that fails or a load that failed), so a forged
flood costs at most one refresher call per isolate per minute. Request bodies are read through a
byte budget (64 KB for a webhook, 4 KB for a bundle request) and refused with 413 past it, with or
without a Content-Length.

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

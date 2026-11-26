# STS — the secrets broker and service-token service

STS serves each workload one bundle of runtime secrets read from Infisical Cloud EU, it mints
short-lived service tokens (Ed25519 JWTs, one audience and one scope each) for the audiences a
workload's policy grants, and it brokers database leases from Infisical's dynamic PostgreSQL
engine for the lease grants a policy lists. It records every delivery, mint, lease and key change
in audit logs that a queue relays to the audit pipeline. CI deploy tokens and the audit queue
consumer are not part of this Worker.

## How a read works

- A Worker in the account binds `SecretsBroker`
  (`services: [{ binding, service: "sts", entrypoint: "SecretsBroker", props: { caller: "<own worker name>" } }]`)
  and STS authorizes on `props.caller` against `policy/*.yaml`. This is deploy-level trust: only a
  deploy right in this Cloudflare account can set `props`. The Durable Object classes
  (`BundleDO`, `RefresherDO`, `SignerDO`, `DenialDO`, `TokenSignerDO`) are internal: no other
  Worker may bind them, and the repo check in `test/repo/` fails a config that does.
- A caller outside the account posts a provider OIDC token to `POST /v1/bundle`. STS verifies the
  token against the provider's published keys, maps the claims to the one policy that declares them,
  and answers with the bundle. A provider whose discovery document or key set cannot be fetched
  gets `503` with `Retry-After: 30` (`unavailable`, reason `internal`), never a rejection. A
  failed bundle object call answers the same way, over RPC and HTTP. Each isolate caches a
  provider's discovery and key set once a request has fetched them; requests share only that
  result, never a pending fetch, so a cold isolate makes one discovery fetch per issuer for each
  request that arrives before the first lands (today only `web`, a Vercel caller, uses one).
- STS waits at most 20 seconds for the bundle object (a fill attempt takes at most 16), then answers
  `unavailable` with `Retry-After: 30`: a caller cannot cancel an RPC, and a Durable Object waiting
  on one stays in memory until it completes. A fill still running at the deadline finishes inside
  the bundle object and serves the next read. A delivery the object commits after the deadline is
  audited though the caller never received it, and the caller's retry is audited again.
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

Routes: `POST /v1/bundle`, `POST /v1/token` (service tokens), `POST /v1/lease` and
`POST /v1/lease/revoke` (database leases), `GET /.well-known/jwks.json` (the service-token key
set), `GET /manager-auth/.well-known/jwks.json` (the manager login key set), `POST /manager-webhook`
(Infisical `secrets.modified`). Production is `https://sts.kiloapps.io`, staging is
`https://sts-staging.kiloapps.io`.

## Service tokens

A workload asks for up to 8 tokens in one call, one per audience, each with exactly one scope of
that audience (`MintRequestSchema` in `@kilocode/sts-contracts`). A Worker in the account calls
`SecretsBroker.mintTokens(request)` on its `props.caller` binding; a caller outside the account
posts the same body to `POST /v1/token` with its provider OIDC token as `Authorization: Bearer`.
The body is read only after the token verified, through a 4 KB budget like `/v1/bundle`.

- **Answer.** `MintResultSchema`: `ok` with one entry per requested token, in request order, each
  `issued` (token, `jti`, `expiresAt`) or `denied` with a closed reason; or a whole-call
  `invalid_request` (400: not JSON, not the schema, more than 8 tokens, a repeated audience; 413
  past the body budget, same body), `identity_rejected` (401) or `unavailable` (503 with
  `Retry-After`). Every answer is `Cache-Control: no-store`.
- **Per-token decision**, in this order: no policy for the caller in this environment
  (`unknown_workload`), a scope `STS_SCOPE_REGISTRY` does not list (`unknown_scope`), an audience
  the policy does not list (`audience_not_allowed`), a scope the policy does not list
  (`scope_not_allowed`), and an attestation that leaves under 60 seconds (`attestation_expiring`).
  A denied token does not affect the others. A Worker binding whose policy names another identity
  kind is refused whole (`identity_rejected`). A verified provider token that the verifier refuses
  is refused whole too (401 `identity_rejected`), and its denial row carries the verifier's own
  reason: `identity_rejected` (a GitHub environment, ref or event failed), `environment_mismatch`
  (its policy is for another environment) or `unknown_workload` (no policy here names it). Its
  name never reaches the per-token policy check.
- **Claims** (design 5.3, profile `ServiceTokenClaimsSchema`): `iss` = `STS_ISSUER`, `sub` =
  `service:<workload>`, `client_id` = `req` = the workload, `env`, one `aud`, one `scope`, a random
  `jti`, `iat`, and `exp = min(iat + 300, attestation exp)`. A Worker binding has no attestation,
  so its tokens live 300 s. Header: `alg: EdDSA`, `typ: at+jwt`, `kid`.
- **One signer hop.** A whole call makes at most one `TokenSignerDO` call, only when at least one
  token passed the policy. The signer signs every allowed token and appends one
  `ai.kilo.sts.token.issued` row listing each `jti`, audience and scope (parallel lists) in the same
  call; a failed append returns no token (`unavailable`, retry after 10 s). STS waits at most 5 s
  for the signer, then answers `unavailable`; the call is never retried, since a retry after a
  committed append would audit tokens the caller never got.
- **Denials.** Every refused token of an identified caller (valid `props.caller`, or a provider
  token whose signature, issuer, audience and lifetime verified) goes to `DenialDO` as an
  `ai.kilo.sts.token.denied` event with `reason`, `workload`, `audience` and `scope` (a whole-call
  refusal names no audience or scope). They merge per minute like bundle denials, and all denials of
  one call travel in one denial-object hop. A token that did not verify gets one log line and no
  row.

### Token-signing keys and rotation

Four `TokenSignerDO` shards per environment (`eu` jurisdiction in production and staging) each hold
a key ring and the `sts:<environment>:tokens:<shard>` audit stream. STS picks a shard at random for
each mint call, so any shard signs for any workload and one workload's calls spread over all four.
One object has a soft limit of 1,000 requests a second; at 200,000 caller instances plus about
2,200 Vercel instances, each minting once per 4 minutes, STS makes about 843 mint calls a second.
The largest single workload may be the whole fleet: because the shard is chosen per call, not per
workload, each shard still gets about 211 calls a second, about a fifth of the limit. The key set
lists the keys of all four. Keys are Ed25519, generated inside the
object with WebCrypto; the PKCS#8 bytes stay in its KV storage (`token-key-ring`) and signing uses a
non-extractable import. The `kid` is the RFC 7638 thumbprint of the public key. The ring follows
design 5.7, driven by the object's alarm (no cron), with the same changes applied at the start of a
call should the alarm be late:

- the current key signs for 30 days;
- the next key is generated and published 7 days before it becomes current (if the object slept
  through that date, the next key still waits a full 7 days after it is published);
- a retired key drops its private key at once and stays published until 1 minute (the verifier
  clock skew) after the last token it signed expires; after that no legitimate token verifies
  under it. The object keeps that latest `exp` per key, rounded up to a whole minute, so it writes
  it at most once a minute.

Each change appends one `ai.kilo.sts.token_key.rotated` event (`change`: `created`, `published`,
`activated`, `removed`). `GET /.well-known/jwks.json` serves the next, current and retired keys
with `Cache-Control: no-store`: removing a kid from this set is the only recall of an STS token
(design 6.1), so no HTTP cache may hold it or serve it stale while STS answers 503; a verifier
keeps its own copy for 5 minutes and never serves it longer. Each isolate serves it from memory
for 5 minutes, together with the `TOKEN_SIGNING_KIDS_REVOKED` list it was built under; a request
that finds no fresh copy, or a copy built under another list, calls the four shards itself, in
parallel (each bounded at 5 s and retried like the manager key set), and stores the plain result
only when all four answered; otherwise it answers 503 with `Retry-After: 30`. Requests that find the
copy stale at the same moment each load it, because no promise is shared across requests: a few
extra shard calls per isolate per 5 minutes, accepted. So a scheduled removal (a retired key
leaving its ring) reaches verifiers up to 10 minutes later: up to 5 minutes in an isolate copy,
then up to 5 in the verifier's. An emergency removal is filtered from every answer, so it reaches
them within 5 minutes (see the runbook below for the rollout of the list itself).

### Cost per request

- **Mint call:** one Worker request (or RPC call), one signer call when a token passed the policy
  (none when all are denied), one SQL row written for the audit row, at most one KV row written per
  key per minute (the latest `exp`), at most one `setAlarm` per 5-second relay window (the object
  keeps its alarm time in memory, so a mint reads no alarm), and one denial-object call per
  distinct denial per isolate per minute. No row is read on the mint path (the ring is held in
  memory).
- **Relay and pruning:** each shard sends its unsent rows every 5 seconds, 500 rows per queue
  message, then writes one watermark row. The audit queue is the record once a row is relayed, so a
  token signer deletes relayed rows 1 hour after they were written (other objects keep 7 days),
  checked every 5 minutes; an unrelayed row is never deleted. A delete counts as a row written.
- **Per minute** (one mint call per caller instance per 4 minutes, plus about 2,200 Vercel
  instances; shards share calls evenly because the shard is random per call):

  | Caller instances | Calls (= audit rows) per second, total / per shard | Rows per shard per 5 s | Queue messages per minute, per shard / total | Rows kept per shard (1 h + 5 min) | Table size per shard (0.6–1 KB a row) |
  |---|---|---|---|---|---|
  | 10,000 | 51 / 13 | 64 | 12 / 48 | about 50,000 | about 30–50 MB |
  | 50,000 | 218 / 54 | 272 | 12 / 48 | about 212,000 | about 130–210 MB |
  | 200,000 | 843 / 211 | 1,053 | 36 / 144 | about 821,000 | about 0.5–0.8 GB |

  A Durable Object holds 10 GB, so the busiest case uses under a tenth of it. Queue writes stay
  under 2.5 messages a second in total. A batch of 500 rows is about 300–500 KB of JSON before
  compression; the relay refuses to send a message over `AUDIT_BATCH_MAX_COMPRESSED_BYTES` (60 KB,
  under the 128 KB queue message limit) or 1 MB decompressed and splits that batch in two, so at
  worst the message counts above double (288 a minute in total at 200,000).
- **Key set:** one request per isolate per 5 minutes reaches the four shards (four object calls,
  no row written); every other request is served from isolate memory.
- **Rotation alarm:** each shard wakes for the next ring change (about 4 times per 30 days:
  publish, activate, remove) and for relays and prunes it already runs for its audit rows; each
  change writes the ring (one KV row), one audit row and one `setAlarm`.

### Emergency removal of a signing key (runbook)

STS tokens are expiry-bound: verifiers do no revocation lookup for them (decision Q4). To take a
key out of service:

1. Read the exposed `kid` from the token header, or from `GET /.well-known/jwks.json`.
2. Add it to `TOKEN_SIGNING_KIDS_REVOKED` in `wrangler.jsonc` for that environment (a comma list),
   merge, and deploy. A malformed kid fails the repo check (`stsVarProblems`).
3. On the new version the token signer drops the kid from its ring at start: it never signs with it
   again and leaves it out of the key set. If it was the current key, the shard's `next` key goes
   too, because a leak of the shard's storage exposes both: a freshly generated key becomes current
   at once and a fresh next key is published. If it was a next key, a fresh next key is published.
   The Worker also filters the listed kids out of every key-set answer and rebuilds its isolate
   copy when the list changes. One `ai.kilo.sts.token_key.revoked` event per dropped key records
   the kid, its state, the cause (`listed`, or `same_ring` for the next key dropped with its
   current key) and the replacement kid.
4. Remove the policy grant too if the workload itself is the problem (design 6.1).
5. Verify: `curl -s https://sts.kiloapps.io/.well-known/jwks.json` no longer lists the kid or its
   shard's old next kid, and a new token's header names another kid.

Worst case for the removed key: a verifier keeps a removed kid until its own key-set copy expires
(5 minutes; the response is `no-store`, so no HTTP cache adds to that), and a token signed just
before the removal lives up to 300 s, so the old key stops being accepted everywhere about 10
minutes after the deploy.

Worst case for the fresh key: an isolate of the old version that is still serving during the
rollout can answer with its copy of the old set for up to one isolate cache period (5 minutes);
isolates of the new version rebuild at once. A verifier fetches a new set on an unknown `kid` at
most once per 5 minutes. So a verifier that spent its refresh on such an old copy can refuse
tokens under the fresh key for up to about 10 minutes (5 minutes isolate cache plus 5 minutes
unknown-kid limit). Leave the kid in the list; a later cleanup may remove it once no ring holds it.

## The refresher

One `RefresherDO` per environment reads the manager's folders together: `GET /api/v4/secrets` for
`/workloads`, for `/shared` and, where a GitHub policy applies, for `/ci`, each with
`recursive=true`, `expandSecretReferences=false` and
`includeImports=false` (https://infisical.com/docs/api-reference/endpoints/secrets/list). It
revalidates each folder with its ETag, so an unchanged folder costs a 304.

- **Resolution.** A workload's policy names secrets. Each name resolves from the workload's own
  folder first, then `/shared`; secrets in deeper folders are never served. The own folder is
  `/workloads/<workload>`, or `/ci/<workload>` for a GitHub policy. A name found in neither is listed
  in the bundle's `missing`.
- **`/ci`.** The refresher reads `/ci` as a third folder, in the same read and with the same rules,
  only in an environment where at least one GitHub policy applies; elsewhere it makes no `/ci` call.
  A `/ci` read that fails holds back nothing else: `/workloads` and `/shared` are stored and every
  other bundle is rebuilt as usual, while each CI bundle keeps the last `/ci` copy, marked stale, or
  stays empty if `/ci` was never read. STS logs `sts: /ci read failed` and retries at the next
  regular refresh, with no backoff. The refresher records the failure
  (`refresher_state.ci_failed_at`), so until then a fill of an empty CI bundle object makes no
  manager read while `/workloads` and `/shared` are current: a refused `/ci` costs at most one read
  per refresh interval, not one per CI request.
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
- **Backoff.** After a failed read of `/workloads` or `/shared` the next attempt waits 15 s, 30 s,
  60 s, 120 s, then 240 s (each jittered over its upper half; a 429's `Retry-After` raises it,
  capped at 4 minutes). Webhooks do not shorten a running backoff. Bundle objects keep serving their
  copies, marked stale, and an empty object is filled stale from the refresher's last copy.
- **Token.** The Infisical access token is cached until 60 seconds before it expires; concurrent
  logins merge into one.
- **Starting the loop.** A cron trigger (`*/5 * * * *` in production and staging, none locally)
  calls the refresher's `ensureStarted`, so the first refresh and the deploy's policy-change event
  happen within 5 minutes of a deploy, before any read. Each bundle object also asks the refresher,
  in the background and at most once a minute, to confirm its alarm; the read never waits on it.

### Internal Durable Objects

`BundleDO`, `RefresherDO`, `SignerDO`, `DenialDO`, `TokenSignerDO` and `LeaseDO` are internal.
Their methods skip the policy check and the audit row that `SecretsBroker` performs (the token
signer signs what STS's policy check allowed, the lease object leases what it allowed), so no other
Worker may reach them: a `durable_objects.bindings[].script_name`, workflow `script_name`, migration
`from_script` or export `transfer_from` naming `sts`, `sts-staging` or `sts-local`, an `unsafe`
binding, or an STS service binding at any entrypoint other than `SecretsBroker` fails
`test/repo/worker-configs.test.ts`. A config outside `services/sts/` that binds a class named
`BundleDO`, `RefresherDO`, `DenialDO`, `TokenSignerDO` or `LeaseDO` fails too (`SignerDO` is also
the audit relay's own class name).

## Configuration

No secret is stored in this Worker's configuration. Everything is a plain var, validated with zod
at the start of each entry.

| Var | Meaning |
|---|---|
| `STS_ENVIRONMENT` | `development`, `staging` or `production`. Also the Durable Object name prefix. |
| `STS_ISSUER` | Public base URL, `https://sts.kiloapps.io` in production. |
| `MANAGER_BASE_URL` | Infisical Cloud base URL, `https://eu.infisical.com`. |
| `MANAGER_PROJECT_ID` | The Infisical project `kilo`. |
| `MANAGER_PROJECT_SLUG` | The same project's slug, which the lease API takes instead of its id. Empty: this environment has no lease, and every lease request answers `unavailable` ([Database leases](#database-leases)). |
| `MANAGER_ENVIRONMENT_SLUG` | `development`, `staging` or `production`. |
| `MANAGER_IDENTITY_ID` | The Infisical machine identity STS logs in as, one per environment. |
| `DO_JURISDICTION` | `eu` in production and staging, `none` locally. |
| `TOKEN_SIGNING_KIDS_REVOKED` | Comma list of service-token signing kids taken out of service; empty by default (runbook above). |
| `LEASE_CI_MIGRATION_TARGET` | `<host>:<port>/<database>` of the primary's direct endpoint, returned with a `ci-migration` lease; empty returns no target. Plain values, never a credential. |

Wrangler inherits no vars into an env block, so every block sets each var, and
`test/repo/worker-configs.test.ts` checks that each STS block passes the same schema `readConfig`
uses and that its `STS_ISSUER` equals `STS_ISSUERS` in `@kilocode/sts-contracts`.

Bindings: `AUDIT_QUEUE` (queue producer), `STS_BUNDLE_DO`, `STS_REFRESHER_DO`, `STS_SIGNER_DO`,
`STS_DENIAL_DO`, `STS_TOKEN_SIGNER_DO` (migration `v3`), `STS_LEASE_DO` (migration `v4`). Trigger:
cron `*/5 * * * *` in production and staging, `[]` in the local block.

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
- `github-oidc`: `repository`, `repositoryId`, `repositoryOwnerId`, `environment`, `refs`,
  `jobWorkflowRefs`, `events`. Several policies may share a repository. See
  [GitHub Actions callers](#github-actions-callers).

- `vercel-oidc`: `teamSlug`, `teamId`, `projectId`, `projectName`, and `environments`
  (`production`, `preview`, or `{ customEnvironmentId: env_... }`). See
  [Vercel callers](#vercel-callers).

Token grants: `audiences` lists the services a workload may mint for and `scopes` the scopes it may
hold; both default to empty, so a policy without them mints nothing. Every scope must be in
`STS_SCOPE_REGISTRY` (`@kilocode/sts-contracts`; today only the canary scopes `web:sts.canary` and `usage-ingest:sts.canary`) and
belong to a listed audience, every audience needs at least one scope, and no audience may be the
workload itself. `dynamic` lists the database lease grants the workload may request
([Database leases](#database-leases)); it defaults to empty, so a policy without it leases nothing.

```yaml
audiences: [web]
scopes: ['web:sts.canary']
```

The `ai.kilo.sts.policy.changed` event lists added and removed `workload:audience` and
`workload:scope` grants next to the workload and secret changes.

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
- in the `sts` config, the `audit-relay` config or any config that binds STS, a block (its own
  `observability` or the inherited top-level one, `previews` included) does not set
  `observability.traces.enabled` to exactly `false`: a trace records outbound URLs (a Slack webhook
  URL is a secret) and Durable Object SQL bindings (STS writes its webhook secret through one);
- a non-production block (any env block or `previews`) of a config that binds STS reads a secret
  from the production Secrets Store `342a86d9e3a94da698e82d0c6e2a36f0` whose name lacks a `_DEV`,
  `_DEVELOPMENT`, `_LOCAL`, `_STAGING` or `_TEST` suffix;
- the top level of a config that binds STS has crons and an env block inherits them (leaves
  `triggers` out) or, outside `staging`, sets any cron: an accidental `wrangler deploy --env local`
  must not run production schedules;
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

### Vercel callers

A Vercel function's own OIDC token (header `x-vercel-oidc-token`) carries the team-wide audience
`https://vercel.com/<team slug>`, which every project and every preview deployment of the team
shares; STS refuses it. The caller first exchanges it for a token whose only audience is the STS
issuer of the environment it calls (`https://sts.kiloapps.io`, staging
`https://sts-staging.kiloapps.io`). The exchange (`POST https://oidc.vercel.com/~token` with
`{ token, aud }`, what `getVercelOidcToken({ audience })` in `@vercel/oidc` 3.8 or later calls)
keeps the base token's `exp`, sets `aud`, adds `act` `{ iat, aud: "https://vercel.com/<team slug>" }`,
and issues from the team slug issuer (https://vercel.com/docs/oidc/reference,
https://vercel.com/changelog/custom-oidc-token-audiences,
https://github.com/vercel/vercel/blob/main/packages/oidc/src/exchange-vercel-oidc-token.ts; proof run
1 recorded these claims). The base token is therefore a bearer credential for STS through the
exchange: the client reads it inside the request handler, never at module scope, and sends it only
to the exchange.

The exchange allows about 100 exchanges per burst, refilling within about 65 seconds (proof runs 1
and 2). The budget is per project or per team, not per deployment: two fresh deployments fired
together got 42 + 58 = 100 tokens, then 429 (proof run 3, run e; project versus team was not
measured). So overlapping deployments, and if it is team-wide every project of team `kilocode`,
share it. It refuses to exchange an exchanged token (401, proof runs 2 and 3). A
client therefore never exchanges once per instance: it shares the exchanged token through the
Vercel Runtime Cache (decision D10, design 4.4 and Q49), with the algorithm in
`packages/service-token-client/src/vercel/shared-token.ts` (`vercelIdentity` in the client's
`/vercel` subpath; the proof harness re-exports it): key SHA-256 of the base token's `owner_id`,
`project_id`, `environment`, `custom_environment_id` and `deployment_id` and the audience (Vercel
renews the base token during a deployment's life, even mid-wave, so the token itself is not in the
key); memory, then the cache, a cached token used until its own `exp` minus 60 seconds whatever
base token the reader holds; on a miss a random wait and a re-read, then a claim marker so one
request exchanges; others, and an exchanger that got 429, poll the cache with backoff instead of
exchanging again. A cached token STS refuses is dropped and exchanged once more; when STS refuses
the fresh one too, a refusal marker stops every instance of the deployment from exchanging for
that audience for 60 seconds (the client's denied recheck). The cache key is not secret and the
entry holds the whole exchanged token: code that can use the same Runtime Cache partition (other
deployments of the project in the same environment) can read and present that token and can stall
a deployment's exchanges, but cannot make a deployment present another deployment's token (the
reader checks the claims, STS checks the signature). Within one environment a read gains nothing,
since STS takes no deployment claim. Vercel documents separate partitions only for preview and
production, so a custom environment may share the preview partition; the client therefore keeps a
custom environment's token (a base token with `custom_environment_id`, or an `environment` other
than `preview` and `production`) in instance memory only, never in the Runtime Cache, at the cost
of one exchange per instance per base-token renewal for custom environments only. Encrypting
custom-environment entries (AES-GCM under a key only that environment holds, the cache key as
associated data) is the way to share them through the cache again later. The client refuses
redirects on `oidc.vercel.com` (a 3xx fails the exchange), so the base token in the request body
never follows one. There is no early refresh: the exchanged token keeps the base token's `exp`, so
exchanging earlier cannot get a later one. On a miss, a base token with under 60 seconds left fails
the request at once. When the cache is down (the claim marker does not read back), each request
exchanges once and fails at once on a 429: about 100 requests per 65 seconds get a token and the
rest of a cold wave fail fast until the cache is back.

STS verifies the exchanged token against the team slug issuer `https://oidc.vercel.com/<teamSlug>`
(discovery, then the key set it names, each with a 5-second timeout); the team id issuer form
(`https://oidc.vercel.com/team_...`) is refused. Then: RS256 only, a 60-second clock skew, `aud`
exactly the STS issuer as a single string, `iat` and `exp` present and `iat` no later than now plus
the skew, and `act` an object whose `aud` is `https://vercel.com/<teamSlug>` with no nested `act`
(a token exchanged from an already exchanged token, or one without `act`, is refused). A token with
a `user_id` claim is refused in every environment: Vercel puts it on the tokens of a person's
`vercel env pull` and `vercel dev` (those live 12 hours; function tokens live 2 hours), and STS
serves deployments, not people. The refusal is audited with the `user_id`. For the same reason a
policy cannot list the Vercel `development` environment.

Authorization keys on the stable ids only: `owner_id` must be `teamId`, `project_id` must be
`projectId`, and `environment` must be listed, or, for a custom environment, `custom_environment_id`
must equal a listed `customEnvironmentId` (a custom environment's slug never matches). The names
(`owner`, `project`) only have to agree with `sub`
(`owner:<team slug>:project:<project name>:environment:<environment>`) and `owner` with `teamSlug`;
`projectName` is never compared. One project id maps to one workload.

Environment mapping (design 6.2), checked when the policy loads and again on every token:

| Vercel environment | STS environment it may read |
|---|---|
| `production` | `production` only |
| `preview` | `development` only (a preview runs code from any branch) |
| custom environment, by id | `staging` only |

The web app's staging is the custom environment `staging` (id `env_AWLwIFdyYSjUqXEoh7aH9E8Kg39b`,
deployed with `--target=staging`), so its policy lists
`{ customEnvironmentId: env_AWLwIFdyYSjUqXEoh7aH9E8Kg39b }` and STS staging serves exactly that
environment. Anyone with deploy rights on the project can deploy to that custom environment, so
staging values must not be production-grade. Team `kilocode` is `team_ItxRShuUkJaEd9GmXMEEgunb`.

A policy fails to load when a listed Vercel environment can read none of the policy's STS
environments, or when one of its STS environments has no listed Vercel environment that may read it.
A token from a listed Vercel environment that this STS deployment may not serve is refused with
`environment_mismatch`. A refusal of a verified Vercel token is audited with `owner_id`,
`project_id`, `environment`, `custom_environment_id` and `user_id` only (actor
`vercel:<owner_id>/<project_id>` or the policy's workload), never a name or the token. The verified
outcome carries the token's `exp` and `iat` (`attestationExp`, `attestationIat`, seconds). The mint
(`/v1/token`) caps what it issues at `attestationExp`; for a Vercel
token `attestationIat` is the exchange time, not the base token's issue time, so it says nothing
about how old the deployment's token is.

Person tokens: proof runs 2 and 3 pulled `preview`, `production` and `staging` tokens with
`vercel env pull`; each claimed `environment: development` and carried `user_id`, and proof run 3
showed `user_id` survives the exchange, so STS refuses them before and after it. Build tokens:
`scope` equals `sub` (`owner:kilocode:project:<name>:environment:<env>`) for function,
custom-environment and person tokens alike (proof run 3), so STS cannot tell a Vercel build token
from a function token of the same environment: build code is trusted like the deployment's own
code (design 6.2). A staging custom-environment function token carries `environment: staging` and
`custom_environment_id`, so a policy pinned to `production` refuses it on the claim alone.

**Merge gate: passed.** Proof run 3 (2026-11-25, `proof/vercel-exchange/README.md`) passed every
check of the gate run: a 2,500-invocation cold wave on 498 cold instances in `iad1` got every token
with 2 exchanges, 0 × 429, time to token p99 1,954 ms and max 2,623 ms. For every environment pulled
from the throwaway proof project, both the pulled and the exchanged token carry `user_id` (gate:
holds). A Vercel workload may now move to STS.

Cost, with about 2,200 Vercel instance starts per release and 43 releases a day, for R function
regions (the web app's project setting) and one audience (STS):

| | Exchanges per release | Exchanges per day | Bundle calls per day |
|---|---|---|---|
| One exchange per instance (no shared cache) | 2,200, above the limit of about 100 | 94,600 | 94,600 |
| D10 shared cache | about R (a handful of the shared budget; overlapping releases add theirs) | about 43 R, plus about 12 R if Vercel renews the base token every 2 hours | 94,600 |

Runtime Cache reads: a memory hit reads nothing, a cache hit is 1 read, a miss that reaches the claim
is 4 reads and 1 to 2 writes, then 2 reads per poll step. Proof run 2's single-key wave measured
about 1 read per instance, so about 2,200 to 3,000 reads per wave and region (worst case about
120,000 if every instance polls to the deadline) and about 100,000 to 130,000 per day. The client
count (10,000, 50,000 or 200,000) does
not change any row: the instance count drives it. On the STS side each isolate fetches the Vercel
issuer's discovery once and its key set at most once per 10 minutes (jose's default `cacheMaxAge`),
plus at most once per 30 seconds after an unknown `kid` (its cooldown). Requests share only the
finished key set, so a cold isolate makes one fetch pair per request that arrives before the first
pair lands; each fetch gives up after 5 seconds, so that window lasts at most 10 seconds.

### GitHub Actions callers

A CI job proves itself with its GitHub Actions OIDC token
(https://docs.github.com/en/actions/reference/security/oidc), requested with the STS issuer of the
environment it calls as the audience (`https://sts.kiloapps.io`, staging
`https://sts-staging.kiloapps.io`):
`curl -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://sts.kiloapps.io"`.
The job needs `permissions: id-token: write`. It sends that token as the bearer of
`POST /v1/bundle` and gets its policy's bundle. Any other audience, including the GitHub default,
is refused.

```yaml
workload: ci-kilocode-release
environments: [production]
identity:
  kind: github-oidc
  repository: Kilo-Org/kilocode
  repositoryId: '<repository id>'
  repositoryOwnerId: '<owner id>'
  environment: release
  refs: [refs/heads/main]   # the default
  jobWorkflowRefs:
    - Kilo-Org/kilocode/.github/workflows/publish.yml@refs/heads/main
    - Kilo-Org/kilocode/.github/workflows/smoke-test.yml@refs/heads/main
  events: [workflow_dispatch]
secrets: [KILOCODE_ANACONDA_API_KEY, KILOCODE_AUR_KEY, KILOCODE_MAINTAINER_APP_KEY]
```

How a token finds its policy, in this order:

1. **Repository.** `repository_id` and `repository_owner_id` equal the policy's ids. A token of a
   repository no policy names is refused `unknown_workload`.
2. **One policy.** The token's `environment` claim (absent matches a policy without an
   `environment`) and its `job_workflow_ref` select the policy. The loader refuses two policies
   that share a repository, an environment and a workflow file, so at most one matches. A token
   that names the repository but matches no policy is refused `identity_rejected` and audited as
   `github:<repository id>`: a workflow file that no policy lists, or a listed one on another ref.
3. **Exact bindings.** On that policy, `sub` must equal the immutable-format subject
   `repo:<owner>@<owner id>/<repo>@<repository id>:environment:<environment>` (a policy without an
   `environment`: `repo:...:ref:<ref>`), `ref` must be in `refs`, the matched `jobWorkflowRefs`
   entry must be pinned to that same `ref`, and `event_name` must be in `events`. A failure is
   refused `identity_rejected` and audited under the policy's workload.

Rules the loader enforces:

- `jobWorkflowRefs` lists every workflow file whose jobs may use the policy, each as
  `<owner>/<repo>/.github/workflows/<file>@<ref>` with a ref from `refs`, all in the policy's own
  repository, with no wildcard. A token's `job_workflow_ref` must equal an entry whose ref equals the
  token's own `ref`. A called reusable workflow is its own entry: its jobs carry its own
  `job_workflow_ref`, at the ref it was called with, while `ref` and `event_name` come from the
  calling run, so a run on one listed ref that calls a workflow pinned to another listed ref is
  refused. STS does not check the caller (`workflow_ref`) or compare commits (`workflow_sha`,
  `job_workflow_sha`): any workflow on a listed ref that calls a listed reusable workflow at that
  ref, with a listed event and in the policy's environment, gets the bundle, so list a reusable
  workflow only when every caller on that ref may hold it.
- `events` is an allowlist of `push`, `schedule`, `workflow_dispatch` and `workflow_run`. No event
  that a fork author can start (`pull_request`, `pull_request_target`, `issues`, `issue_comment`,
  `pull_request_review`, `discussion`, `merge_group` and the rest) can be listed. A policy that
  lists `workflow_run` lists no other event, binds an `environment`, and does not grant
  `production`: GitHub gives a `workflow_run` job the default branch as its `ref` even when a fork's
  pull request started the upstream run, and STS cannot see that run.
- A policy that grants `production` binds an `environment` and accepts only `refs/heads/main`; a
  policy with token grants binds an `environment`.
- The workload is named `ci-<job>`, and its secrets live in `/ci/<workload>` (then `/shared`). No
  other kind of policy may use a `ci-` name, so a workload's name alone fixes its folder and a
  stored bundle never moves between `/workloads` and `/ci`.

Preconditions on the GitHub side, which STS cannot check:

- **Immutable subjects.** The repository must issue the immutable subject format: repositories
  created after 2026-07-15 do, an older one needs the opt-in in its (or its organization's) OIDC
  settings (https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens).
  A name-only subject (`repo:<owner>/<repo>:...`) is refused, and so is a customized subject
  template.
- **Protected environment.** STS trusts the `environment` claim; the GitHub environment's branch
  rule (`main`) and its required reviewers are what make that claim mean something.
- **Environment names** use only letters, digits, `.`, `_` and `-`, and the workflow spells them
  exactly as the policy does.

Denial rows carry `repository_id`, `repository_owner_id`, `repository`, `environment`, `ref`,
`event_name`, `job_workflow_ref` and `sub_format`, never the token, the raw `sub`, or per-run
claims such as `run_id` (they would make every refusal its own row). `sub_format` names the
subject's shape: `immutable:` or `name-only:` followed by `environment`, `ref` or `pull_request`
for GitHub's default forms, `custom` for a customized template (which can carry per-run claims),
or `absent`. A delivery writes the usual
`ai.kilo.sts.bundle.delivered` row for the policy's workload, plus the verified token's
`jobWorkflowRef`, `runId` and, when present, `runAttempt` as flat string attributes (a run id or
attempt that is not 1-20 decimal digits is left out). GitHub tokens carry no job claim, so the row
names the workflow file and run, not the job.

**Cost per CI job.** One `POST /v1/bundle`: the token check runs in the Worker, with GitHub's
discovery document and key set cached per isolate (a cold isolate fetches both once), then one
`BundleDO` call and one delivery audit row. No manager call: the bundle comes from the object's
copy. At the kilocode CI design's load (about 90 bundle reads a day, at most 1,000 credential jobs
a day) that is under 1,000 Worker requests, `BundleDO` calls and audit rows a day. The refresher
cost of `/ci` is one more conditional `GET /api/v4/secrets` every 4 minutes per environment that
has a GitHub policy (360 a day per environment; a 304 when nothing changed), and one more bundle
push per GitHub policy per refresh: with the 8 kilocode policies, 8 `BundleDO` calls every 4
minutes, or 2,880 a day per environment.

## Database leases

STS brokers one PostgreSQL role per request from Infisical's dynamic PostgreSQL engine (design 4.5,
6.1 job 3). The role exists only for its lease: Infisical creates it with a random password and a
`VALID UNTIL` expiry, and runs the revocation statement (end the role's sessions, drop it) when the
caller revokes it or the lease expires. STS never stores the username or the password; they pass
through the lease object to the caller once.

| Grant | Who may hold it | Infisical dynamic secret | Ceiling | The role | Target STS returns |
|---|---|---|---|---|---|
| `replica-read` | A `worker-binding` policy (bouncer-watch) | `replica-read` in `/dynamic/replica-read` | 8 hours, 4 active | Member of `kilo_lease_replica_read`: `SELECT` on `public`, plus what PostgreSQL grants to every role (see Risks) | None: the consumer keeps its own replica host |
| `ci-migration` | A `github-oidc` policy bound to a GitHub environment | `ci-migration` in `/dynamic/ci-migration` | 1 hour, 2 active | Member of `kilo_lease_migration`, which may `SET ROLE postgres` and inherits none of its rights; its sessions run as `postgres` | `LEASE_CI_MIGRATION_TARGET` (the primary's direct endpoint) |

Each dynamic secret sits alone in its folder because an Infisical `dynamic-secrets` permission is
scoped by environment and folder and cannot name a secret.

**Policy.** `dynamic` lists one entry per grant:

```yaml
workload: bouncer-watch
environments: [staging, production]
identity:
  kind: worker-binding
secrets: [BOUNCER_WATCH_AXIOM_QUERY_TOKEN]
dynamic:
  - grant: replica-read
    maxTtlSeconds: 9000 # the daily run's 150 minutes
    defaultTtlSeconds: 3600 # the hourly run's 60 minutes
    maxActive: 2 # the hourly and daily runs overlap
```

The loader refuses an unknown grant or field, a grant listed twice, a `maxTtlSeconds` above the
grant's ceiling (8 hours, 1 hour), a `defaultTtlSeconds` above `maxTtlSeconds` or below 5 minutes,
a `maxActive` above the grant's ceiling (4, 2), `replica-read` on any identity but
`worker-binding`, and `ci-migration` on any identity but a `github-oidc` one with an
`environment` (a production policy also accepts only `refs/heads/main`, as every GitHub policy
does). A policy without `dynamic` leases nothing.

**Calling it.** A Worker calls its binding; the answer is `LeaseResultSchema` in
`@kilocode/sts-contracts`:

```ts
const lease = await env.STS.lease({ grant: 'replica-read', ttlSeconds: 3600 });
if (lease.status !== 'ok') throw new Error(`no lease: ${lease.status}`);
try {
  // lease.username, lease.password, lease.expiresAt; keep them in memory only
} finally {
  await env.STS.revokeLease(lease.leaseId);
}
```

A CI job posts the same bodies with its GitHub OIDC token (audience: the STS issuer, as for
`/v1/bundle`):

```sh
oidc() { curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://sts.kiloapps.io" | jq -r .value; }
lease=$(curl -sS --fail-with-body -X POST https://sts.kiloapps.io/v1/lease \
  -H "Authorization: Bearer $(oidc)" -H 'content-type: application/json' -d '{"grant":"ci-migration"}')
# ::add-mask:: the username and password, build the connection URL from host, port and database,
# run the migration; then, in an always() step, with a fresh OIDC token (a job token lives minutes):
curl -sS -X POST https://sts.kiloapps.io/v1/lease/revoke -H "Authorization: Bearer $(oidc)" \
  -H 'content-type: application/json' -d "{\"leaseId\":\"$(jq -r .leaseId <<<"$lease")\"}"
```

A `ci-migration` lease is the one STS credential that outlives its attestation (design 6.2): the
GitHub token lives minutes, the lease up to an hour.

| Answer | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | `leaseId`, `grant`, `username`, `password`, `expiresAt`, `ttlSeconds`, `clamped` (the request asked for more than the policy maximum), and `host`, `port`, `database` for `ci-migration` when configured |
| `denied` | 401 or 403 | `identity_rejected` (401), `unknown_workload`, `environment_mismatch`, `grant_not_allowed` |
| `limited` | 429, `Retry-After` | `too_many_active` (the policy's `maxActive` of this grant, a creation in progress included) or `rate_limited` (4 creations by this workload in the last minute, whatever their outcome) |
| `invalid_request` | 400 (413 above 1 KB) | Not `LeaseRequestSchema`: an unknown grant, a lifetime under 5 minutes or above a day |
| `unavailable` | 503, `Retry-After` | Infisical refused or failed, the lease object failed or did not answer in 25 seconds, or the environment has no `MANAGER_PROJECT_SLUG` |

Revoke answers `revoked` (200) for the caller's own lease once STS has revoked it (no Infisical
call then), `unavailable` without an Infisical call once STS stopped its revocation as
`unconfirmed`, and `not_found` (404) for any lease id STS did not hand to this workload, another
workload's included. An expired lease still goes to Infisical, which answers 404 once its own expiry
revocation succeeded: expiry stops new logins, not open sessions. A GitHub caller's lease belongs to
its run: a job of another run of the same workflow gets `not_found` too, and a re-run attempt of the
same run may revoke it.

**How a lease is made.** The Worker checks the caller (props or provider token, as for bundles)
and the policy grant, takes the request's lifetime or the policy default, and shortens it to the
policy maximum. Then one call to `LeaseDO`, one object per environment, bounded at 25 seconds and
never retried (a creation changes the database). The call carries the time STS made it, and the
object's 20-second budget runs from then, so a slow start of the object counts. The object:

1. Refuses a request that reached it after its budget, with no Infisical call. Refuses the
   request at the workload's limits. A creation in progress holds its slot as a `pending` row, so
   concurrent requests cannot pass the limit together.
2. Logs in to Infisical (the 10-minute access token is kept in the object) and calls
   `POST /api/v1/dynamic-secrets/leases` with `dynamicSecretName`, `projectSlug`,
   `environmentSlug`, `path` and `ttl` (https://infisical.com/docs/api-reference/endpoints/dynamic-secrets/create-lease).
   The answer is checked with zod; the SQL provider returns `DB_USERNAME` and `DB_PASSWORD`.
3. Revokes the lease at once and answers `unavailable` when it cannot hand it over: the budget ran
   out before or right after the `lease.created` row was written (`late`), Infisical's expiry is
   more than 2 minutes off the lifetime asked for (`expiry_mismatch`), or the `lease.created` row
   could not be written (`audit_failed`). The password never leaves the object.
4. Otherwise writes `lease.created` and marks the row active in the same output gate, and returns.

Infisical confirms a revocation only with a 200 whose lease row carries no `status`, or with its
404 for a lease it does not have (`Dynamic secret lease with ID '…' not found`). A 200 whose row
says `Failed to delete` (the revocation statement failed at the database; Infisical keeps the
lease and retries it itself every few hours), any other 404 (a missing folder or project), a
malformed answer, a 5xx, a timeout or another refusal leaves the revocation owed on the lease row;
no answer body is logged or kept. The first failure writes `lease.revoked` with result
`revoke_failed` (if that append fails, the next failure writes it), and the object's alarm retries
until Infisical confirms it (a second `lease.revoked` row), also after the lease expired, since
`VALID UNTIL` refuses new logins but ends no open session. A failure after the expiry logs an
error that says the sessions may still be open. A day after the expiry the object stops: it writes
`lease.revoked` with result `unconfirmed`, logs an error naming the lease id, for a person to end
the role's sessions by hand (Risks below), and ends a delivered lease's row in state `unconfirmed`,
so a later revoke does not make it owed again; if that row cannot be written, it tries again 30
seconds later. It stops the same way on a 404 after a recorded `revoke_failed`: until trial check 3
shows that Infisical keeps a lease whose revocation failed until a revocation succeeds, a missing
lease may be one deleted without its role being revoked. The alarm takes at most 5 leases, least recently tried
first, so leases that keep failing cannot hold back a newer one; it retries a lease no sooner than
30 seconds after its last attempt, the caller's included, or after Infisical's `Retry-After` on a
429 when that is longer. A caller's revoke then answers `unavailable`, and the caller may retry
too. A creation that times out may still have made a role at the database. Its password reached no
one, and Infisical drops it at expiry. Rows are deleted a day after their lease ended; a row whose
revocation is still owed stays until the object stops it.

**Audit.** On the `sts:<environment>:leases` stream: `ai.kilo.sts.lease.created` (workload,
identity, channel, grant, lease id, `ttlSeconds`, `requestedTtlSeconds` when given, `clamped`,
`expiresAt`, and a GitHub caller's `jobWorkflowRef`, `runId`, `runAttempt`) and
`ai.kilo.sts.lease.revoked` (`cause`: `caller`, `late`, `expiry_mismatch` or `audit_failed`;
`result`: `revoked`, `gone` when Infisical no longer had it, `revoke_failed` when Infisical did not
confirm it, or `unconfirmed` when the object stopped a day after the expiry or on a 404 after a
recorded failure; the last two with
outcome `failure`). Refusals of an identified caller become
`ai.kilo.sts.lease.denied` through the denial object, merged per minute: the answer's reason, or
for a revoke the caller heard as `not_found`, `not_owner` (another workload's lease), `other_run`
(another GitHub run's lease) or `unknown_lease`. No row carries a username or a password.
Infisical's own audit log records each lease and revocation, the expiry revocation included.

**Replica sessions (design decision Q63).** Infisical creates and drops the role on the primary,
through its direct endpoint; no dynamic engine can write to a standby. The role reaches the replica
through replication, so a consumer that logs in right after the lease is created may have to retry
for the replication delay. The same login also works on the primary: Supabase gives no per-role
host rule (no `pg_hba.conf` access), so nothing stops a `replica-read` holder from connecting to
the primary instead. On the primary, the revocation (and the expiry revocation) ends the role's
sessions, and every later revocation of the same template also ends the sessions of lease roles
whose `VALID UNTIL` has passed. On the replica nothing ends a session: what bounds it is the
consumer's own run deadline (bouncer-watch: 55 and 130 minutes, under the 60 and 150-minute
leases); `VALID UNTIL` and the dropped role refuse a new login on both nodes. The role settings
`statement_timeout` (60 s), `idle_in_transaction_session_timeout` (60 s) and
`idle_session_timeout` (15 min) protect an honest consumer only: a session can change any of them
with `SET`, and a database-level setting is a default too. Only a pooler or a kill job outside the
session enforces a time limit, and on the replica STS has neither. `check.sh` shows on one node
that `VALID UNTIL` refuses new logins and leaves an open session alone until a revocation. So
`replica-read` is staging-only until a replica-side session sweeper ships (a phase 2 follow-up PR
that runs the session-ending function on each replica): no production policy grants it before.

**Risks.**

- A `ci-migration` lease is equivalent to holding the `postgres` owner credential for up to an
  hour, not a bounded capability (design decision Q64, which Igor accepted on 2026-11-26 on these
  terms: it acts as `postgres` for up to an hour, and its effects outlive the revocation). Within
  that hour it can create permanent `LOGIN` roles, grant them
  any right `postgres` holds, plant `SECURITY DEFINER` functions, triggers or event triggers,
  change any object `postgres` owns and read every row. Everything it leaves behind outlives the
  revocation and the expiry, which end only its own logins and sessions. What stands between a
  workflow and it: the GitHub environment's protection (branch `main`, a required reviewer), the
  policy's exact workflow list and event allowlist, the 1-hour expiry, `CONNECTION LIMIT 2`, the
  revocation at the end of the job, and a revocation only the same run can ask for.
- `ci-migration` needs a superuser at setup. On PostgreSQL 16 and later no role holds ADMIN on
  itself, so only a superuser can grant membership in `postgres`; and `postgres` administers every
  role it creates, so a template that `postgres` created and that is a member of `postgres` would
  be a membership cycle. On Supabase the superuser is `supabase_admin`, which a customer does not
  hold, so `ci-migration` stays off unless Supabase runs `setup-ci-migration.sql` (or the project
  is on PostgreSQL 15, where the rules differ; neither path is tested).
- `postgres` administers every role it created, through the ADMIN grant PostgreSQL gives the
  creator, and only a superuser can remove that grant. A role in between does not help: ADMIN
  follows memberships (`check.sh` shows it). So after `setup.sql` alone, `postgres`, and any
  session acting as it, can reset the password of `kilo_lease_replica_admin`.
  `setup-ci-migration.sql` creates the migration login as the superuser and removes that grant on
  the replica login, so once `ci-migration` exists, a `ci-migration` lease cannot reset either
  login's password.
- `kilo_lease_migration_admin` can create a role that runs as `postgres`, so its password is as
  strong as `postgres`. Each login lives only in its dynamic secret's configuration; the
  break-glass owner enters it once, and Terraform ignores the field (design 4.2).
- Neither login can end another role's session: they hold no `pg_signal_backend`. The revocation
  calls `kilo_lease.end_sessions`, a `SECURITY DEFINER` function with a fixed `search_path`, owned
  by `postgres` (which Supabase makes a member of `pg_signal_backend`) or, after the `ci-migration`
  setup, by `kilo_lease_owner` (a member of it). It ends only the
  sessions of the caller's own template's lease roles, as `kilo_lease.lease_role` records them by
  OID at creation: the one being revoked, blocked or expired ones, and dropped ones. A session of a
  dropped role that was never a lease is left alone (PostgreSQL keeps an ordinary role's sessions
  open when the role is dropped). A leaked login can still create roles and use up connections:
  each lease role has a connection limit (4 for `replica-read`, 2 for `ci-migration`; at most 8
  and 4 at the policies' `maxActive`), but the login sets the limit itself when it creates a role,
  so only `max_connections` caps a leaked login. Each login's own `CONNECTION LIMIT 4` caps its
  sessions, not the roles it makes.
- A `replica-read` role is read-only by grant only. The role setting
  `default_transaction_read_only` stops accidental writes; a session can turn it off. Beyond its
  `SELECT` grants, a role holds what PostgreSQL and the installed extensions grant to PUBLIC.
  `setup.sql` removes PUBLIC's `EXECUTE` on the `SECURITY DEFINER` functions that `postgres` owns
  in `public`, and changes the default for functions `postgres` creates later. That default is
  database-wide: it applies in every schema, so a function a later migration adds that PUBLIC
  (or Supabase's Auth hooks) must run needs its own `GRANT`. Invoker functions keep PUBLIC's
  `EXECUTE`: they run with the lease's own rights. It cannot remove what other roles own or
  granted. `report.sql` lists the rest (it counts a volatile function only when it is not SQL or
  PL/pgSQL, such as an extension's C function); on Supabase it is (Supabase knowledge base,
  "Custom role inherits privileges that were not explicitly granted"):
  - `CONNECT` and `TEMPORARY` on the `postgres` database, and `CONNECT` on `template1`: Supabase's
    services need both, so they stay. A lease can make temporary tables, which end with the
    session.
  - The large-object functions: a lease on the primary can create large objects. The revocation
    drops the ones in the `postgres` database. One in `template1` stops the drop: the role then
    stays without login, `report.sql` lists it, and someone drops it by hand, as its admin login
    (`GRANT "<role>" TO <admin> WITH INHERIT TRUE, SET FALSE; DROP OWNED BY "<role>"` in that
    database, then `revoke.sql` again).
  - Advisory locks: a lease on the primary can take the application's advisory lock keys, and
    with an open transaction it can hold a table lock that makes a migration wait. The revocation
    and the expiry end its sessions there.
  - `pg_net`, when enabled: `USAGE` on schema `net`, every right on its request queue (which holds
    the request headers, API keys included) and `EXECUTE` on `net.http_*`, which sends HTTP
    requests. Supabase owns these grants, so they cannot be removed: before the first lease,
    confirm that `pg_net` is off, or accept this.
  - No `USAGE` on `auth`, `storage`, `extensions`, `vault` or `cron`.
- A login checks the committed catalog, so a `NOLOGIN` in the transaction that also drops the role
  would leave a gap: a login landing between the last session scan and the commit would keep a
  session, and a `ci-migration` one would keep acting as `postgres` (its `role` setting made
  `current_user` `postgres` at login). So `revoke.sql` is two transactions in Infisical's one call
  (it runs the parts split on `;` on one connection, between its own `BEGIN` and `COMMIT`): the
  first commits `NOLOGIN` and `VALID UNTIL -infinity` and ends the sessions; the second refuses a
  role that still has its login, waits one second for a login that passed its checks before that
  commit to show in `pg_stat_activity`, ends the sessions, drops what the role owns, ends them
  again and drops the role. `check.sh` runs a reconnect loop through a revocation (3
  `replica-read` rounds and a `ci-migration` round) and finds no session left, of the role or of a
  dropped one, and shows that a one-transaction revocation statement is refused. What remains: a
  login stalled for over a second between its role check and its `pg_stat_activity` entry, which a
  later revocation of the template ends.
- The admin logins hold no lease role's rights. `kilo_lease.revoke_lease` grants the lease role to
  its admin, for `DROP OWNED`, only inside the revocation transaction that drops it (undone if the
  drop fails).
- Infisical puts the generated password into the creation statement as a literal: its PostgreSQL
  engine has no bind parameters. The statement it sends is `SELECT kilo_lease.create_lease(...)`,
  and each admin login carries role settings that keep its statements out of the server log
  whatever the server-wide settings: `log_statement = 'none'`, `log_min_duration_statement = -1`,
  `log_min_error_statement = 'panic'`, and `pgaudit.log = 'none'` and
  `auto_explain.log_min_duration = -1` when those modules are loaded at setup. Supabase lets
  `postgres` set them per role (supautils); the login cannot change them. A failed `CREATE ROLE`
  is raised again without its text, so the error and its context carry no password, and a failed
  creation rolls back, so a password in any error belongs to a role that never existed.
  `check.sh` shows that with the server at `log_statement = 'all'` and
  `log_min_duration_statement = 0`, and with a failed creation. While the call runs,
  `pg_stat_activity` shows the statement to roles that read other sessions' queries
  (`pg_read_all_stats`, which `postgres` holds through `pg_monitor`). After `setup.sql` alone, they
  are `postgres` and the superusers, who can already create such a role; `setup-ci-migration.sql`,
  run as the superuser before any lease can act as `postgres`, sets `track_activities = off` for
  both admin logins, so a `ci-migration` lease cannot read another lease's password there
  (`check.sh`). A pgaudit object audit (`pgaudit.role`) that covers the `kilo_lease` functions, or
  a module enabled after setup, still could log it; the trial checks for both before the first
  lease.
- The setup files never put an admin login's password into a top-level DDL statement either:
  `setup.sql` and `setup-ci-migration.sql` pass it in a transaction-local setting
  (`SELECT set_config(...)`) to a `DO` block that runs the `CREATE ROLE` through `EXECUTE` and
  clears the setting, so `log_statement = 'ddl'` logs neither admin password (`check.sh` runs both
  files with the server at `ddl` and greps the log). The same settings as for a lease password
  still log it, and an admin password lives until someone rotates it, so the trial checks them
  before setup runs.

**Database setup, per environment (staging first).** On the primary's direct endpoint
(`db.<project ref>.supabase.co:5432`, not Supavisor), PostgreSQL 16 or later, as `postgres`:

```sh
psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
  -v replica_admin_password="$(openssl rand -base64 36)" \
  -f services/sts/sql/leases/setup.sql
```

Generate the password into the break-glass owner's session only (or into a variable) and enter it
into the dynamic secret below. `setup.sql` ends with `report.sql`, one row per finding and a
`summary` row; every count in the summary must be 0 (Risks lists the rows that remain by design).
Run `report.sql` again after a migration adds a function or an extension. Igor accepted design
decision Q64 on 2026-11-26; `ci-migration` still needs `setup-ci-migration.sql`, run only as a
superuser with `-v migration_admin_password=...`, which on Supabase needs Supabase's own staff.

What each setup guarantees. After `setup.sql` alone (`replica-read` only), `postgres` owns the
`kilo_lease` schema, its table and its functions and administers the replica login, so whoever
holds `postgres` could change them; no lease acts as `postgres` then, and `postgres` already holds
every right a `replica-read` lease has. `setup-ci-migration.sql` then, before any lease can act as
`postgres`, removes `postgres`'s ADMIN on the replica login, moves the schema, its table and its
functions to `kilo_lease_owner` (no login, created by the superuser, a member of
`pg_signal_backend`), and turns off activity tracking for both admin logins, so a `ci-migration`
lease can neither reset an admin password, replace `kilo_lease.create_lease` to record later
passwords, nor read a creation statement in `pg_stat_activity` (`check.sh`).

**Infisical setup, per environment (staging first).**

1. Folders `/dynamic/replica-read` and `/dynamic/ci-migration` in the environment.
2. Dynamic secret `replica-read` in `/dynamic/replica-read`: service PostgreSQL; host, port 5432
   and database `postgres` of the primary's direct endpoint; user `kilo_lease_replica_admin` with
   its password; the Supabase CA, SSL reject unauthorized on; default TTL `1h`; max TTL `8h`;
   username template `lease_rr_{{lowercase (random 20)}}`, so every name is `lease_rr_` and 20 of
   `[a-z0-9]` (`kilo_lease.check_username` refuses any other name before the creation statement
   quotes it); creation statement `sql/leases/replica-read.create.sql`, revocation statement
   `sql/leases/revoke.sql`, renew statement `sql/leases/renew.sql`, pasted as they are. Infisical
   splits each on `;` and runs the parts in one transaction, so the creation and renew statements
   hold no other semicolon, and the revocation statement's `COMMIT;BEGIN;` commits its first part
   (the login block) before the second (Risks).
3. Dynamic secret `ci-migration` in `/dynamic/ci-migration`, only once `setup-ci-migration.sql`
   ran: the same, with user `kilo_lease_migration_admin`, default and max TTL `1h`, username
   template `lease_cm_{{lowercase (random 20)}}`, and creation statement
   `sql/leases/ci-migration.create.sql`.
4. The STS identity's project role in that environment gains `dynamic-secrets` action `lease` with
   the conditions `environment` equal to the environment and `secretPath` equal to
   `/dynamic/replica-read` (one rule) and `/dynamic/ci-migration` (a second rule); nothing else on
   `dynamic-secrets`, so STS cannot read or change the root credential. `lease` covers create,
   renew and revoke.
5. Network: if the Supabase project restricts addresses, allow Infisical Cloud EU's egress
   addresses (https://infisical.com/docs/documentation/setup/networking).
6. A lease from the Infisical dashboard (trial check 3): create, log in through the replica,
   renew, then let one expire with a session open on the primary and see it ended and the role
   dropped. Revoke one from the dashboard with a session open and see in the Postgres log that the
   two parts ran as two transactions (the role has no login after the first commit). Check that
   neither admin login's statements reach the Postgres log (`select rolname, rolconfig from
   pg_roles where rolname like 'kilo_lease_%admin'` shows the settings) and that no pgaudit
   object audit covers schema `kilo_lease`. Force a revocation failure (for example, revoke
   `EXECUTE` on `kilo_lease.revoke_lease` from the admin login for the test) and check that every
   later revoke answers 200 with the kept row (`status` `Failed to delete`) and never a 404 until a
   revocation succeeds; until this is confirmed, STS treats a 404 after a recorded failure as
   `unconfirmed`.
7. STS: set `MANAGER_PROJECT_SLUG` (Infisical → project settings) and `LEASE_CI_MIGRATION_TARGET`
   in that environment's block of `wrangler.jsonc`, deploy, then add the policy grants. In
   production, grant no `replica-read` until the replica-side session sweeper ships, and leave
   `LEASE_CI_MIGRATION_TARGET` empty and grant no `ci-migration` until `setup-ci-migration.sql` ran
   there.

**Cost.** One lease is one `LeaseDO` call and one Infisical create, plus a login and one `SignerDO`
call when the object's 10-minute token has lapsed (leases are sparse, so assume it has), and one
`lease.created` row; one revocation is the same with a delete and one `lease.revoked` row. A
revocation Infisical does not confirm adds one `lease.revoked` row and, until Infisical confirms
it or a day after the lease's expiry, at most one Infisical delete per 30 seconds per lease: the
alarm skips a lease whose last attempt (a caller's included) is under 30 seconds old, and waits
out a longer `Retry-After`. A caller retrying faster than 30 seconds adds its own deletes. A lease
still unconfirmed a day after its expiry adds one `unconfirmed` row. Worst case, the alarm makes 10
deletes a minute (5 per alarm) whatever the number of owed leases, plus each caller's retries
and, when every call gets 401/403, one login per delete. A refusal costs no
Infisical call; a limit refusal also costs its `LeaseDO` call. At the database, a lease is one
`SELECT kilo_lease.create_lease` (one `CREATE ROLE`, its role settings and one row in
`kilo_lease.lease_role`), a revocation two transactions with three `pg_stat_activity` scans, a
one-second wait, one `DROP OWNED` and one `DROP ROLE`, all on the primary; a revocation holds an
admin connection for about a second. bouncer-watch runs 24 hourly and 1 daily run a day;
sized at twice that for retried runs, 48 and 2 leases, each revoked at the end of its run, it
makes 100 `LeaseDO` calls, at most 200 Infisical requests (against 600 a minute), 100 `SignerDO`
calls and 100 audit rows a day. CI: 2 `LeaseDO` calls, at most 4 Infisical requests, 2 `SignerDO`
calls and 2 audit rows per migration job.

Only a workload whose policy lists a `dynamic` grant makes leases; no client or Vercel request
path does. So lease volume is the same at 10,000, 50,000 or 200,000 clients, at any number of
Vercel instances and releases. Denials: each isolate sends at most one denial-object hop per
distinct denial per minute (reason, grant or lease id, and the caller's claims), and counts the
rest. A workload at its limits on its one grant has two distinct refusals (`too_many_active`,
`rate_limited`), so at most 2 hops per isolate per minute. The worst case is a caller that revokes
many unknown lease ids: one hop per distinct id, until 100 distinct denials in the minute, after
which the isolate counts the rest as one overflow row per reason.

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

Infisical fetches the key set (`GET /manager-auth/.well-known/jwks.json`) for each STS login. Each
isolate serves it from memory for 5 minutes. A cold or expired isolate makes one `SignerDO` call
per request that arrives before the first call lands, since requests share only the stored key
set, never a pending call; while `SignerDO` fails, each request makes its own call (up to 3
attempts) and nothing is cached.

The identity's project role grants `describeSecret` and `readValue` on `/workloads/**` and
`/shared/**` of its own environment in the `kilo` project, and no write. Infisical reads a value
only with both: `readValue` requires `describeSecret` as well
(https://infisical.com/docs/internals/permissions/project-permissions). Before the first GitHub
policy reaches an environment, the role also grants both on `/ci/**` there. Without that grant the
`/ci` read fails: CI bundles in that environment stay empty or go stale, and every other bundle
refreshes as usual. `/ci` holds only folders STS may read: the CI bundles (`/ci/ci-<job>`) and
`/ci/minting`. The STS deploy job's own token lives outside it, under `/sts-deploy` (design 4.2).
Before the first lease in an environment, the role also grants `dynamic-secrets` `lease` on
`/dynamic/replica-read` and `/dynamic/ci-migration` there ([Database leases](#database-leases));
the lease object uses the same identity and login subject as the refresher.

**Webhook.** One `secrets.modified` webhook per environment, scoped to that environment, of type
General, to `https://sts.kiloapps.io/manager-webhook` (staging: `https://sts-staging.kiloapps.io/manager-webhook`),
with a secret key (https://infisical.com/docs/documentation/platform/webhooks). The STS Worker
checks `x-infisical-signature` (`t=<ms>;<hex HMAC-SHA256 of the body>`) itself, refuses a timestamp
more than 5 minutes from now, and acts only on its own project and environment; only a verified
`secrets.modified` costs a refresher call. Each isolate loads the secret from the refresher and
then reloads it at most once a minute (after a signature that fails or a load that failed), so a
forged flood costs at most one refresher call per isolate per minute once the secret is loaded.
Requests share only the loaded secret, never a pending load, so each request that arrives before
the isolate's first load lands makes its own load. After a failed first load, one request a
minute retries and the others answer 503 meanwhile. Request bodies are read through a byte budget
(64 KB for a webhook, 4 KB for a bundle request) and refused with 413 past it, with or without a
Content-Length.

The webhook secret is generated by STS, not stored anywhere else and not bound from the Secrets
Store. The refresher object creates it on its first request. The break-glass owner copies it once:
Cloudflare dashboard → Workers & Pages → `sts` (or `sts-staging`) → Durable Objects →
`RefresherDO` → Data Studio → the object named `production` (or `staging`) → table `webhook_key` →
column `key`, and pastes it into the Infisical webhook's secret key field; Terraform then ignores
that field (design 4.2). Data Studio is available to account members who can already read every
Durable Object's storage, so this adds no reader (https://developers.cloudflare.com/durable-objects/observability/data-studio).
A webhook only shortens the wait for the next read; a forged or lost one cannot change a bundle.
The secret stays in its SQL row for this copy; its one insert is the only statement that binds it.
Residual risk if it leaked (for example through a trace, which `wrangler.jsonc` turns off): forged
webhooks could trigger early refreshes, at most one per 30 seconds per environment through the
merge window, and never change a bundle.

## Key material

Every key STS generates stays inside the Durable Object that made it, in its KV storage
(`ctx.storage.put/get`), never in a SQL row: a Workers trace records each SQL statement's bound
values, while a storage get or put records only the key name
(https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/). That covers
the manager login key (`SignerDO`, `manager-signing-key`), each bundle object's seal and ETag keys
(`bundle-keys`), the refresher's folder seal key (`refresher-seal-key`) and the service-token key
ring (`TokenSignerDO`, `token-key-ring`). The SQL tables an
earlier revision used for them are dropped by the `0001` migrations; the one staging object that
had a key row (`SignerDO`) had already moved it to KV storage. The webhook secret is the one value
kept in SQL, for the Data Studio copy described above. Traces are off in
`wrangler.jsonc` (`observability.traces.enabled: false`, inherited by every environment), so a
dashboard toggle or a changed platform default cannot start recording statements.

## Local development

```sh
pnpm --filter cloudflare-sts dev     # wrangler dev --env local
```

The local block serves `http://localhost:8825` with `DO_JURISDICTION=none` (workerd enforces no data
residency) and the local queue `kilo-audit-local`. The manager login key set is served at
`http://localhost:8825/manager-auth/.well-known/jwks.json`. Infisical Cloud cannot fetch a key set
from `localhost`, so a local manager login needs a public tunnel and an identity configured with
its URL; without one, a bundle read reports `manager_unreachable_no_copy`.

Local Durable Object state from a revision before the KV key storage cannot move its keys (the
`0001` migrations drop the old key tables), so wipe it once: `rm -rf services/sts/.wrangler/state`.

## Merge gate: the merge to main is the first production deploy

The deploy workflow discovers `services/sts` on its own, so merging this Worker deploys `sts` to
production. Complete and verify every item below before merging.

1. **Zone and route.** The `kiloapps.io` zone is in account `e115e769bcdd4c3d66af59d3332cb394`,
   and no DNS record named `sts.kiloapps.io` exists (the deploy creates the custom domain and fails
   on a conflicting record). Verify: Cloudflare dashboard → `kiloapps.io` → DNS shows no
   `sts` record.
2. **Audit queue.** `kilo-audit` exists (a producer binding to a missing queue fails the deploy),
   with a message retention of 14 days. The `*/5` cron starts the refresher within 5 minutes of
   the deploy, and its first audit events wait in `kilo-audit` until the audit relay (PR stack
   part 3) deploys and consumes them. A message older than the retention is dropped and its stream
   then stalls behind a gap, so merge the relay within the retention, which is why it is 14 days
   and not the 4-day default. Verify: `wrangler queues info kilo-audit` prints the queue, and the
   Queues API shows `message_retention_period: 1209600`.
3. **Infisical identity.** The production machine identity `c531ad9b-eec9-4f93-b173-e14d3d94f6ef`
   exists in the `kilo` project with a role that grants `describeSecret` and `readValue` on
   `/workloads/**` and `/shared/**` in `production` and no write. Verify: Infisical → Access
   Control → Machine Identities → that id → Projects shows `kilo` with the role.
4. **Runtime secrets.** Each policy file's names exist in `production` under
   `/workloads/<workload>` or `/shared`. Verify: Infisical → `kilo` → `production` lists them. A
   missing name is reported in the bundle's `missing` list rather than failing the read, so this
   item gates correct values, not the deploy.

After the merge, in this order:

1. **Key set.** `curl -sf https://sts.kiloapps.io/manager-auth/.well-known/jwks.json` answers 200
   with one `ES256` key.
2. **JWT Auth.** Add JWT Auth to the production identity with the values in "Infisical setup".
   Infisical refuses to create JWT Auth until its JWKS URL resolves, which is why this step comes
   after the deploy. Until it exists every manager login fails: the refresher backs off (15 s
   doubling to 4 minutes) and logs `sts: manager read failed` at each attempt; no workload reads
   production values from STS yet, so nothing waits on it.
3. **A refresh.** Within 5 minutes (the cron, or the next backoff attempt) the refresher reads the
   manager: the Infisical audit log shows a secrets read by the production identity, and the Worker
   logs stop showing `sts: manager read failed`.
4. **Webhook.** Copy the webhook secret from Data Studio and create the production webhook as
   described in "Infisical setup".

Staging (`sts-staging`, `sts-staging.kiloapps.io`, queue `kilo-audit-staging`, identity
`5bb6ddef-1c61-4bb2-ba3f-8af511fed4f4`) follows the same list for its own environment.

**Before an environment's first GitHub policy deploys** (a `policy/ci-*.yaml` naming that
environment), in this order:

1. **`/ci` read grant.** Grant the environment's Infisical STS role `describeSecret` and
   `readValue` on `/ci/**` there. Without both, the `/ci` read fails and the CI bundles there stay
   empty (other bundles are not affected). Verify with the STS identity itself, before the deploy:
   Infisical → `kilo` → Access Control → the STS identity → Assume Privileges
   (https://infisical.com/docs/documentation/platform/access-controls/assume-privilege), then open
   that environment's `/ci` and a `/ci/ci-<job>` folder below it: each lists its secrets, and no
   value shows as hidden. Do not reveal a value. Exit the session. Infisical records the session's
   actions under your own account.
2. **Deploy the policy.** The refresher has no `/ci` copy yet, so the CI bundles in that
   environment stay empty until the first `/ci` read after this deploy succeeds; other bundles are
   not affected. After the deploy, check the Infisical audit log for the `/ci` read within 5
   minutes, and that the Worker logs show no `sts: /ci read failed` and no
   `sts: manager hid secret values`.

## Tests

`pnpm --filter cloudflare-sts test` runs the Workers-pool suites in `test/worker/` (identity
acceptance and outages per provider against locally generated key sets, policy schema and token
grants, bundle delivery, ETags, policy narrowing, fills, relay and pruning, the refresher against a
mocked Infisical: login, folder reads, resolution, references, backoff, webhooks; the key-ring
timeline with an injected clock, the token signer, mint over both entry points and token denials;
leases over both entry points against a mocked Infisical lease API: lifetimes, clamping, the
active and per-minute limits, owner-only revocation, undelivered leases, pruning, lease denials)
and then the Node suites: `test/repo/` (policy files, the Worker config checks, and a check that
every `wrangler.jsonc` under `services/` other than a service's own, a symlink included, sits under
`test/fixtures/`, which the production deploy job skips, that no `wrangler.json` and no tracked
`.wrangler` entry (a `.wrangler/deploy/config.json` redirect, or a symlink to one) sits at the
repository root, in `services/` or in a service directory, where Wrangler would read it instead of
the service's `wrangler.jsonc`, and that no directory under `services/` is named `wrangler.json` or
`wrangler.jsonc`) and `test/runtime/`. That suite starts the test-only Worker
in `test/fixtures/runtime/` in local workerd and checks that a `SecretsBroker` call ends when it
returns, even when the caller never disposes the result; that a fill outliving the bundle object
deadline still completes and serves the next read; that a key-set, webhook or workload-token
request still gets its answer from a call of its own when a request that was loading the same value
is cancelled; that two cold key-set requests and two cold mint calls are each served without a
promise of another request; that a bound caller cannot reach the mint authority over RPC; and that
the token signer keeps its key across a restart of the runtime with persisted storage. `typecheck`
and `lint` are the usual package scripts.

**Local end-to-end check of service tokens.** The shipped scope registry lists only the canary scopes, so a
test build of STS in `test/fixtures/e2e/` (STS's own routes, broker and objects, checked against a
test registry and a probe policy) runs next to a probe Worker that binds its broker with
`props.caller` and consumes its audit queue:

```sh
cd services/sts
npx wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
# in another shell, once both are ready (about 7 minutes: it waits for a token to expire)
../../node_modules/.bin/tsx test/fixtures/e2e/check.ts
```

The script mints two tokens, verifies each with `@kilocode/verify` against the served key set,
checks that a forged token (same claims and kid, another key) and an expired token get 401 and a
wrong-audience token 403, and waits for the issued and denied events on the queue.

**Local end-to-end check of a CI bundle.** The same test build also carries two GitHub policies,
`ci-e2e-release` and `ci-e2e-migrate`, and sends its requests for GitHub's issuer and for the
manager to a local fake on port 8830 that `ci-bundle-check.ts` serves (a fresh RS256 key with its
discovery document and key set, and an Infisical stand-in with synthetic values):

```sh
cd services/sts
../../node_modules/.bin/tsx test/fixtures/e2e/ci-bundle-check.ts
# in another shell
npx wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
```

The script signs a job token the way GitHub does and checks that the listed workflow's job gets its
bundle (its `/ci/ci-e2e-release` value and its `/shared` value, not the `/workloads` or `/ci/minting`
decoys), that the refresher read `/ci`, and that a job of another workflow file, a `pull_request`
job, a name-only subject, a customized subject carrying the run id, and a run on the policy's
second listed ref (`refs/heads/release`) calling the workflow pinned to `main` each get 401
`identity_rejected`. It then waits for the `bundle.delivered` row, which must carry the job's
workflow file, run id and attempt, and for the `bundle.denied` rows that name the refused
`job_workflow_ref`, `event_name`, `ref` and `sub_format` and no run id or raw subject, and checks
that no audit row carries a value. It needs empty local state: a bundle kept from an earlier run
skips the refresher read, so run `rm -rf test/fixtures/e2e/.wrangler/state` before
`wrangler dev`.

**Local end-to-end check of database leases.** The probe policy also holds `replica-read`
(maximum 9000 seconds, 2 active) and `ci-e2e-migrate` holds `ci-migration`. `lease-check.ts` serves
the fake GitHub issuer and a fake Infisical lease API on port 8830, so it and `ci-bundle-check.ts`
run one at a time:

```sh
cd services/sts
../../node_modules/.bin/tsx test/fixtures/e2e/lease-check.ts
# in another shell
npx wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
```

It checks that the probe gets a 60-minute `replica-read` lease over its binding (and the request
Infisical received), that an 8-hour request is clamped to 9000 seconds, that a third concurrent
lease is refused `too_many_active` with no Infisical call, that a GitHub job gets a 1-hour
`ci-migration` lease with the primary target over `POST /v1/lease`, that neither caller can revoke
the other's lease while each revokes its own, that a job of another run cannot revoke the job's
lease, and that the `lease.created`, `lease.revoked` and `lease.denied` rows reach the queue with
no username or password.

**Local check of the lease SQL.** `sql/leases/check.sh` starts a throwaway PostgreSQL in Docker
(`PG_IMAGE`, default `postgres:16`; `PG_PORT`, default 55432) shaped like Supabase (`postgres` a
non-superuser owner of the database and `public`, member of `pg_signal_backend`; a stand-in for
`pg_net`'s PUBLIC grants; `dblink` in `extensions`). It runs `setup.sql` as `postgres` and
`setup-ci-migration.sql` as the superuser, and each statement file the way Infisical does. It
proves that the setup report lists what PUBLIC reaches and that `setup.sql` removed PUBLIC's
`EXECUTE` on definer functions in `public`; that under `log_statement = 'ddl'` neither admin
password (both setup files) reaches the server log; that with the server at `log_statement =
'all'` and `log_min_duration_statement = 0` no lease password does, nor that of a failed creation,
whose error carries none; that after `setup-ci-migration.sql` `postgres` cannot read either admin
login's query text in `pg_stat_activity`; that `postgres` can reset the replica
admin's password until `setup-ci-migration.sql` ran and neither afterwards; that a malformed
username is refused; that a `replica-read` role reads and cannot write, create or run a definer
function even with read-only mode turned off; that neither admin login can end an application
session or the other template's sessions; that renewal moves `VALID UNTIL`; that an expired role
cannot log in while its open session lives on until a revocation of any lease ends it; that
revocation ends open sessions, drops what the role owned (a large object, a temporary table) and
the role, and is idempotent; that a client reconnecting through a revocation keeps no session and
leaves none of a dropped role (`replica-read` and `ci-migration`), and that a one-transaction
revocation statement is refused; that a role revocation cannot drop (an object in `template1`, a
right `postgres` granted) stays without login and is listed; that a `ci-migration` session runs
as `postgres`, holds none of its rights after `SET ROLE NONE`, and its DDL (`CREATE EXTENSION`
included) leaves nothing owned by the lease role, and that neither it nor `postgres` can replace,
add or take over a `kilo_lease` function after `setup-ci-migration.sql`; that `DROP ROLE` alone
would leave a session open and unnamed, which the next revocation ends for a lease role; and that
no revocation ends the session of a dropped role that was never a lease.

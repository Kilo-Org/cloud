# STS — the secrets broker and service-token service

STS serves each workload one bundle of runtime secrets read from Infisical Cloud EU, it mints
short-lived service tokens (Ed25519 JWTs, one audience and one scope each) for the audiences a
workload's policy grants, it brokers database leases from Infisical's dynamic PostgreSQL engine
for the lease grants a policy lists, and it mints Cloudflare deploy tokens of up to 1 hour for the GitHub
deploy jobs a policy names. It records every delivery, mint, lease, deploy token and key change in
audit logs that a queue relays to the audit pipeline. The audit queue consumer is not part of this
Worker.

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
  request that arrives before the first lands (today the Vercel callers `web` and `ai-gateway`, which
  share team `kilocode`'s issuer).
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

### Alerts on token denials

The STS canary (services/usage-ingest README, "STS canary") makes one denial on purpose: every
run, the web app's canary route (workload `web`) asks for `canary:denied-probe` (audience
`canary`, `STS_DENIED_PROBE` in `@kilocode/sts-contracts`). That scope is reserved
(`STS_RESERVED_SCOPES`): the registry lists it, so the request passes the registry check, and the
policy loader refuses any policy that grants it or its audience (see [Policy](#policy)), so every
request for it is refused by policy with `audience_not_allowed` and audited as a `token.denied`
row naming the caller: one row per run and environment (`count` 1, as denials merge per minute).

Every detection or alert rule over `token.denied` rows excludes exactly that probe, workload `web`
and scope `canary:denied-probe` together, and nothing broader: a denial of another scope for
`web`, and a request for the probe scope by any other workload, still count. The exclusion is
defined once in `@kilocode/sts-contracts`: `isStsDeniedProbe(attributes)` for code and
`STS_DENIED_PROBE_APL_EXCLUSION` for Axiom, which is this line:

```kusto
| where not(tostring(column_ifexists('data.attributes.workload', '')) == 'web' and tostring(column_ifexists('data.attributes.scope', '')) == 'canary:denied-probe')
```

`column_ifexists` keeps a query valid in a dataset where no row has carried the field yet (Axiom
answers 400 for a field it has never seen; on 2026-11-26 neither audit dataset had
`data.attributes.scope`); `tostring` keeps a whole-call refusal, which names no scope.

No monitor reads `token.denied` rows today. Create this one per environment (Axiom, threshold
monitor):

| Setting | Production | Staging |
|---|---|---|
| Name | `sts: token denied` | `sts-staging: token denied` |
| Dataset | `kilo-audit` | `kilo-audit-staging` |
| Query | the query below | the query below, dataset `kilo-audit-staging` |
| Condition | `denials` above 0 | `denials` above 0 |
| Frequency and range | every 5 minutes, over the last 15 minutes | same |
| Notifier | Slack `notify-kilo-alerts` (no paging) | same |

```kusto
['kilo-audit']
| where type == 'ai.kilo.sts.token.denied'
| where not(tostring(column_ifexists('data.attributes.workload', '')) == 'web' and tostring(column_ifexists('data.attributes.scope', '')) == 'canary:denied-probe')
| summarize denials = count()
```

A row is a refused token of an identified caller: a policy that misses a grant, a caller in the
wrong environment, or a caller asking for what it may not hold. The probe never fires it; the
canary's own monitor checks that the probe row still lands. A synthetic check of the filter, run
in Axiom on 2026-11-26 (`datatable` with the probe row, a `web` denial of `gateway:models.read`, a
`usage-ingest` request for the probe scope, a `web` whole-call refusal with no scope, and a
`token.issued` row), kept exactly the middle three; the monitor query also runs on both audit
datasets today (0 rows).

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
  per refresh interval, not one per CI request. The read drops every entry in `/ci/minting` and
  below before anything else sees it: those are the minting credentials, which only the
  deploy-token object reads, with a read of its own
  ([Cloudflare deploy tokens](#cloudflare-deploy-tokens)).
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

`BundleDO`, `RefresherDO`, `SignerDO`, `DenialDO`, `TokenSignerDO`, `LeaseDO` and `DeployTokenDO`
are internal. Their methods skip the policy check and the audit row that `SecretsBroker` performs
(the token signer signs what STS's policy check allowed, the lease and deploy-token objects lease
and mint what it allowed), so no other Worker may reach them: a
`durable_objects.bindings[].script_name`, workflow `script_name`, migration `from_script` or export
`transfer_from` naming `sts`, `sts-staging` or `sts-local`, an `unsafe` binding, or an STS service
binding at any entrypoint other than `SecretsBroker` fails `test/repo/worker-configs.test.ts`. A
config outside `services/sts/` that binds a class named `BundleDO`, `RefresherDO`, `DenialDO`,
`TokenSignerDO`, `LeaseDO` or `DeployTokenDO` fails too (`SignerDO` is also the audit relay's own
class name).

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
| `MIGRATION_PROXY_AUDIENCE` | The audience a GitHub job's token for the migration proxy carries, `https://migration-proxy.kiloapps.io` (staging `https://migration-proxy-staging.kiloapps.io`); only `attestGithubRun` verifies with it ([Migration run attestation](#migration-run-attestation)). Empty: this environment attests no run. Must differ from `STS_ISSUER`. |
| `LEASE_REPLICA_SWEEP_BINDINGS` | Comma list of the Hyperdrive bindings (`LEASE_SWEEP_<NAME>`) of the read replicas the lease object sweeps once a minute ([Replica sessions](#database-leases)); empty sweeps none. Each name must be a `hyperdrive` binding of the same block (repo check); the binding holds the sweeper login, at Cloudflare, not here. |
| `CF_DEPLOY_ACCOUNT_ID` | The Cloudflare account STS mints CI deploy tokens in (32 hexadecimal characters). Empty: this environment mints none, and every deploy-token request answers `unavailable` ([Cloudflare deploy tokens](#cloudflare-deploy-tokens)). Not a credential. |

Wrangler inherits no vars into an env block, so every block sets each var, and
`test/repo/worker-configs.test.ts` checks that each STS block passes the same schema `readConfig`
uses and that its `STS_ISSUER` equals `STS_ISSUERS` in `@kilocode/sts-contracts`.

Bindings: `AUDIT_QUEUE` (queue producer), the Hyperdrive bindings `LEASE_REPLICA_SWEEP_BINDINGS` names, `STS_BUNDLE_DO`, `STS_REFRESHER_DO`, `STS_SIGNER_DO`,
`STS_DENIAL_DO`, `STS_TOKEN_SIGNER_DO` (migration `v3`), `STS_LEASE_DO` (migration `v4`),
`STS_DEPLOY_TOKEN_DO` (migration `v5`). Trigger: cron `*/5 * * * *` in production and staging, `[]`
in the local block.

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
`STS_SCOPE_REGISTRY` (`@kilocode/sts-contracts`: the canary scopes `web:sts.canary` and
`usage-ingest:sts.canary`, the reserved `canary:denied-probe`, `uts-feed:revocation.read`,
under `uts` the scopes `uts:subjects.revoke`, `uts:browser-sessions.end`,
`uts:api-credentials.revoke` and `uts:token-exchange`, under `bouncer` the scopes `bouncer:decide`,
`bouncer:usage.write`, `bouncer:signup.decide` and `bouncer:signup.history`, and the phase 4
service scopes) and belong to a listed audience, every audience needs at least one scope, and no
audience may be the workload itself. A reserved scope
(`STS_RESERVED_SCOPES`, today `canary:denied-probe`) and its audience fail the load whatever the
registry says: no policy may grant them (see [Alerts on token denials](#alerts-on-token-denials)).
`dynamic` lists the database lease grants the workload may request
([Database leases](#database-leases)) and its Cloudflare deploy-token grant
([Cloudflare deploy tokens](#cloudflare-deploy-tokens)); it defaults to empty, so a policy without
it leases and mints nothing. No policy may name a minting credential (`CLOUDFLARE_MINTING_TOKEN`)
in `secrets`, whatever its identity.

```yaml
audiences: [web]
scopes: ['web:sts.canary']
```

`environmentGrants` adds `audiences`, `scopes` and `secrets` where STS runs in one environment
only, on top of the policy's own lists. Each key must be one of the policy's `environments` and
must grant something. The policy as that environment applies it (its lists plus the key's)
passes every rule above, so a grant there cannot repeat a base grant, name an unregistered scope,
or name a minting credential. Activating a grant in staging or production later is a data
change: add the key. Every read STS makes in an environment (the mint decision, the bundle, the
refresher's push and its policy snapshot and hash) sees only that environment's grants; the
other environments keep the bundle, snapshot and hash they had. The stored snapshot shows the
grants merged into its lists, never as a field of its own, so a rollback's strict reader parses
it.

```yaml
environmentGrants:
  development:
    audiences: [uts-feed]
    scopes: ['uts-feed:revocation.read']
    secrets: [UTS_KILO_WEB_CLIENT_KEY]
```

The `ai.kilo.sts.policy.changed` event lists added and removed `workload:audience` and
`workload:scope` grants next to the workload and secret changes.

Adding a file also means adding it to `src/policy/registry.ts`; the typed import map in
`src/policy/index.ts` makes the two disagree at typecheck, and `test/repo/policy-files.test.ts`
checks the directory itself.

A registration file reserves a workload name before its policy exists. It holds exactly three
fields, and the strict schema refuses any other field, any secret, and `registered` other than
`true`:

```yaml
workload: cloud-agent-next
registered: true
secrets: []
```

A file that sets `registered` is always read as a registration. Its name must be `<workload>.yaml`
and no policy may declare the same workload. The loader keeps registrations out of every read STS
makes: `all`, `has`, `get`, `forEnvironment`, `snapshot`, `hash` and `workloadHash` answer as if the
file did not exist. A registered name therefore matches no token, gets no bundle, refresher push or
grant, is refused as `unknown_workload`, and changes no `policy.changed` event, stored snapshot or
hash. `registered()` lists the names for the repository checks only. The workload's own change turns
its file into a policy, and then every policy and Worker binding check applies, as for a new file;
a config here that binds STS under a registered name still fails, because that name has no
`worker-binding` policy.

Token and secret grants (secrets of the Worker-binding workloads are in their files):

| Workload | Audience: scopes | Secrets | STS environments |
|---|---|---|---|
| `usage-ingest` | `web`: `web:sts.canary`, `web:usage.record` | none | development, staging, production |
| `web` | `usage-ingest`: `usage-ingest:sts.canary`, `usage-ingest:usage.publish` | none | development, staging, production |
| `web` | `o11y`: `o11y:api-metrics.write`, `o11y:alerting.read`, `o11y:alerting.write` | none | development, staging, production |
| `web` | `uts-feed`: `uts-feed:revocation.read` | | development only (`environmentGrants`) |
| `web` | `uts`: `uts:subjects.revoke`, `uts:browser-sessions.end`, `uts:api-credentials.revoke` | | development only (`environmentGrants`) |
| `web` | | `UTS_KILO_WEB_CLIENT_KEY`, `UTS_KILO_WEB_CLIENT_KEY_NEXT` (present only during a rotation) | development only (`environmentGrants`) |
| `web` | `bouncer`: `bouncer:decide`, `bouncer:usage.write`, `bouncer:signup.decide` | | production only (`environmentGrants`) |
| `kilo-mcp` | `uts`: `uts:token-exchange` (registered, reserved) | none | only those its own policy lists, once its Worker config binds STS (below); until then STS refuses it |
| `ai-gateway` | `usage-ingest`: `usage-ingest:usage.publish`; `o11y`: `o11y:api-metrics.write`; `ai-gateway-secure-proxy`: `ai-gateway-secure-proxy:request.forward` | none | development, staging, production |
| `ai-gateway` | `uts-feed`: `uts-feed:revocation.read` | none | development only (`environmentGrants`) |
| `ai-gateway` | `bouncer`: `bouncer:decide`, `bouncer:usage.write` | none | production only (`environmentGrants`) |

Staging and production get the `web` UTS grants with phase 4's activation go. The `bouncer` grants
are production only because Bouncer (`Kilo-Org/bouncer`) runs in production only and accepts only
production STS tokens. `bouncer:signup.history` is registered for the signup-history import job,
and no policy grants it yet. The `kilo-mcp` grant
is reserved: its registration file becomes its policy (`worker-binding`, `props.caller`
`kilo-mcp`, development first) once `services/kilo-mcp/wrangler.jsonc` binds STS, because the
config check below refuses a `worker-binding` policy that no config here binds. Its local block
must bind `sts-local`, the development STS: its `dev` block may only bind `sts-dev`, which STS does
not deploy, so the binding goes in an `env.local` block named `kilo-mcp-local`, with
`observability.traces.enabled: false` in every block.

The dual-accept grants each serve one receiver that already accepts the scope from exactly these
workloads, behind its own switch: `web:usage.record` from `usage-ingest` (the web app's
`USAGE_RECORD_AUTH`), `usage-ingest:usage.publish` from `ai-gateway` on `/usage` and
`/enkrypt-usage` and from `web` on `/exa-usage` (usage-ingest's `USAGE_INGEST_PUBLISH_AUTH`),
`o11y:api-metrics.write` from `ai-gateway` and `web` and both alerting scopes from `web` (o11y's
`ADMIN_CREDENTIAL_ACCEPT`), and `ai-gateway-secure-proxy:request.forward` from `ai-gateway` (the
Secure Proxy's `KILO_AI_GATEWAY_SECURE_PROXY_CREDENTIAL_ACCEPT`). Each receiver repeats the
workload check, so a grant alone opens no route to another caller.

The `ai-gateway` policy (Vercel project `kilocode-ai-gateway`, see [Vercel callers](#vercel-callers))
lists the project's `production`, its custom environment `staging` and its previews, mapped to
production, staging and development STS as for `web`. Its UTS feed read stays development only, in
`environmentGrants`; staging and production get it with phase 4's activation go. Phase 4 activated
it for Bouncer: `bouncer:decide` and `bouncer:usage.write` are a production grant in
`environmentGrants`, and it holds neither signup scope, since the gateway sends no signup call.

Any preview build of `kilocode-ai-gateway`, from any branch, can obtain every scope `ai-gateway`
holds on development STS, the same as `web`'s development grants. If fork or outside pull-request
previews are ever enabled on that project, these grants need a review first.

Workloads with a policy, all over `worker-binding`:

| Workload | Environments | Worker config |
|---|---|---|
| `o11y` | development, staging, production | `services/o11y/wrangler.jsonc` |
| `audit-relay` | development, staging, production | `services/audit-relay/wrangler.jsonc` |
| `usage-ingest` | development, staging, production | `services/usage-ingest/wrangler.jsonc` |
| `bouncer-watch` | production | `watch/wrangler.jsonc` in `Kilo-Org/bouncer`; its STS binding arrives with bouncer's step 2 |
| `notifications` | production | `services/notifications/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |
| `cloudflare-gmail-push` | production | `services/gmail-push/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |
| `kiloclaw-inbound-email` | production | `services/kiloclaw-inbound-email/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |
| `event-service` | production | `services/event-service/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |
| `model-eval-ingest` | production | `services/model-eval-ingest/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |
| `container-usage-meter` | production | `services/container-usage-meter/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |

A Worker's workload is its top-level config `name`, because STS authorizes on `props.caller` and the
config check requires that to be the top-level name; its own secrets live in `/workloads/<name>`.

GitHub Actions workloads (`github-oidc`, production only, `refs/heads/main`, each workflow file
pinned to `@refs/heads/main`, except `ci-kilocode-app-key-v2` on `refs/heads/v2`; see
[GitHub Actions callers](#github-actions-callers)). All are in `Kilo-Org/kilocode` (repository id
`946087422`, owner id `201822503`) and grant no token, lease or deploy token; their bundles are
`/ci/<workload>`:

| Workload | GitHub environment | Workflow files | Events |
|---|---|---|---|
| `ci-kilocode-release` | `release-keys` | `publish.yml` | `workflow_dispatch` |
| `ci-kilocode-release-jetbrains` | `release-jetbrains` | `publish-jetbrains.yml`, `publish-jetbrains-bundled.yml` | `workflow_dispatch` |
| `ci-kilocode-app-key` | `automation` | `nix-hashes.yml`, `prepare-jetbrains-release.yml` | `push`, `workflow_dispatch` |
| `ci-kilocode-app-key-v2` | `automation` | `kilo-v2.yml` at `refs/heads/v2` (its `progress-commit` job) | `push` |
| `ci-kilocode-scan-notify` | `automation` | `security-findings-notify.yml` | `schedule`, `workflow_dispatch` |
| `ci-kilocode-community` | `automation` | `community-sweep.yml` | `schedule`, `workflow_dispatch` |
| `ci-kilocode-notify` | `automation` | `outdated-kilo-deps.yml`, `stale-alerts-report.yml`, `stale-bot-pr-notify.yml`, `v2-upstream-release-notify.yml` | `schedule`, `workflow_dispatch` |
| `ci-kilocode-opencode-watch` | `automation` | `watch-opencode-releases.yml` | `schedule`, `workflow_dispatch` |

`Kilo-Org/kilocode` predates GitHub's immutable subjects and cannot opt in yet, so its eight
policies set `legacySubject: true` (see "Legacy subject" below). Only `ci-kilocode-app-key-v2`
admits the `v2` branch (manager ruling M76): it accepts `refs/heads/v2` alone, with
`kilo-v2.yml@refs/heads/v2` as its one workflow file and `push` as its one event, and grants only
`KILOCODE_MAINTAINER_APP_KEY`. The loader refuses a production policy off `main` unless it equals a
`GITHUB_PRODUCTION_REF_EXCEPTIONS` entry in every field (`src/policy/schema.ts`). No policy admits
`release-v2`.

Three kilocode-side rules hold these policies to what they name:

- None of these workflow files may gain an `on: workflow_call` trigger. A called workflow's jobs
  carry its own `job_workflow_ref` with the caller's `ref` and `event_name`, so any workflow on
  `main` that called it with a listed event would get the bundle.
- The GitHub environments `automation`, `release-keys` and `release-jetbrains` admit deployments
  from `main` only, except `automation`, which admits `main` and `v2` (a deployment branch policy;
  `automation` read back on 2026-11-27). STS trusts the `environment` claim; the branch rule is
  what makes it mean those branches, and the policy's ref and workflow pins hold each policy to its
  own branch.
- `publish.yml`'s `release-push`, `package-managers` and `jetbrains-pin` jobs are the only jobs
  that may declare `environment: release-keys`, and they may run only SHA-pinned GitHub-org actions,
  repository code and runtimes pinned by version and digest: STS cannot tell the jobs of one
  workflow file apart, so another job of `publish.yml` declaring the environment receives the
  bundle too.

A Worker whose config lives in another repository is listed in `EXTERNAL_WORKLOADS` in
`test/repo/worker-configs.ts`. The config check below cannot read that config, so that repository's
review covers its STS binding; this repository refuses any config that deploys under the name.

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
  names;
- a config deploys under the name of a workload in `EXTERNAL_WORKLOADS`: it would replace that
  Worker and, through `props.caller`, read its bundle;
- a `worker-binding` policy names a workload that no config here binds STS as and
  `EXTERNAL_WORKLOADS` does not list, or the list names a workload without such a policy.

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

The AI gateway (`apps/ai-gateway`, workload `ai-gateway`) is the project `kilocode-ai-gateway`
(`prj_cFtsRYRBCm4qa8D35LC2j183FohC`). Its policy lists `production`, `preview` and its own custom
environment `staging` (`env_t9p3Xr8paMqpucgHbz0gg1Xrd4PV`), the same mapping as the web app. Both
projects share the team issuer `https://oidc.vercel.com/kilocode`; the project id alone tells them
apart.

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
  environment: release-keys
  refs: [refs/heads/main]   # the default
  jobWorkflowRefs:
    - Kilo-Org/kilocode/.github/workflows/publish.yml@refs/heads/main
  events: [workflow_dispatch]
secrets: [KILOCODE_AUR_KEY, KILOCODE_MAINTAINER_APP_KEY]
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
   refused `identity_rejected` and audited under the policy's workload. A `legacySubject` policy
   also accepts GitHub's default subject `repo:<owner>/<repo>:environment:<environment>` (or
   `:ref:<ref>`); the id claims and every other binding still apply.

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
- A policy that grants `production` binds an `environment` and accepts only `refs/heads/main`,
  unless it equals an entry of `GITHUB_PRODUCTION_REF_EXCEPTIONS` in every field (today only
  `ci-kilocode-app-key-v2`); a policy with token grants binds an `environment`.
- The workload is named `ci-<job>`, and its secrets live in `/ci/<workload>` (then `/shared`). No
  other kind of policy may use a `ci-` name, so a workload's name alone fixes its folder and a
  stored bundle never moves between `/workloads` and `/ci`.

Preconditions on the GitHub side, which STS cannot check:

- **Immutable subjects.** The repository must issue the immutable subject format: repositories
  created after 2026-07-15 do, an older one needs the opt-in in its (or its organization's) OIDC
  settings (https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens).
  A name-only subject (`repo:<owner>/<repo>:...`) is refused, except on `legacySubject` policies
  (design Q62a), and so is a customized subject template.
- **Legacy subject (Kilo-Org/kilocode only, decision 2026-11-27).** `identity.legacySubject: true`
  accepts the default subject as well; the loader refuses it on any policy whose repository, id and
  owner id are not `Kilo-Org/kilocode`, `946087422` and `201822503`
  (`GITHUB_LEGACY_SUBJECT_REPOSITORY`). Why: npm/cli#9969 (open) makes npm trusted publishing fail
  with "package not found" for repositories using use_immutable_subject, and Azure signing's
  federated credential matches `sub`, so it needs a new trust entry before the switch. How to
  upgrade: when npm fixes #9969, add the Azure federated credential for
  `repo:Kilo-Org@201822503/kilocode@946087422:ref:refs/heads/main`, turn on use_immutable_subject
  for kilocode, prove oidc_check on main and v2, then delete the exception (the flag, its loader
  allowance and the constant). The credential's subject must match the signing job's real
  subject: `...:environment:<env>` instead if that job runs in a GitHub environment; the kilocode
  CI owner checks this at upgrade time.
- **Protected environment.** STS trusts the `environment` claim; the GitHub environment's branch
  rule (`main`, plus `v2` for `automation`) is what makes that claim mean something. `automation`
  has no required reviewers, so the branch rulesets carry the review: `v2` requires an approved
  pull request with no bypass actor, the same bar as `main`. `ci-kilocode-app-key-v2` pins the
  whole `kilo-v2.yml` file, so a job added to that file later with `environment: automation`
  would also receive the key; such a change needs an approved pull request on `v2`.
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
minutes, or 2,880 a day in production.

## Migration run attestation

The migration proxy (`services/migration-proxy`, design Q64a) applies production database
migrations for the deploy workflows' `db-gate` job, which no longer holds a database credential.
The job sends its GitHub OIDC token, requested with the proxy's own audience
(`MIGRATION_PROXY_AUDIENCE`: `https://migration-proxy.kiloapps.io`, staging
`https://migration-proxy-staging.kiloapps.io`), to the proxy; the proxy passes the raw token to
`SecretsBroker.attestGithubRun({ token })` over its STS binding, and STS answers
`GithubRunAttestationResultSchema` (`@kilocode/sts-contracts`):

- `ok`: `workload`, `github` (`repositoryId`, `repositoryOwnerId`, `environment`, `ref`, `sha`,
  `eventName`, `jobWorkflowRef`, `runId`, `runAttempt`, all from the verified token) and
  `expiresAt` (the token's own expiry). The proxy re-checks every value against its own config.
- `denied`: `caller_not_allowed` (any props caller but `migration-proxy`), `identity_rejected`
  (a token that does not verify with the proxy audience: the STS-issuer audience, another ref or
  workflow file, an expired token, a missing `sha` or run claim, or an empty
  `MIGRATION_PROXY_AUDIENCE`), `unknown_workload`, `environment_mismatch`, and
  `grant_not_allowed` (a policy without `migration-run`).
- `unavailable` with `retryAfterSeconds`: GitHub's discovery or key set could not be fetched.

STS verifies the token as for `/v1/bundle` (issuer, exact subject, ref, workflow file, event
allowlist, environment), but only with `MIGRATION_PROXY_AUDIENCE`, and then requires the matched
policy's `migration-run` grant. The audiences never swap: every other route verifies with
`STS_ISSUER`, so a proxy token reads no bundle, mints no token and gets no deploy token, and a
token for STS starts no run. A policy holding `migration-run` is left out of every other route's
verifier, so its job's token opens nothing there even with the STS audience.

**Trigger-only policies.** `ci-db-migrate` (production, `deploy-production.yml`) and
`ci-db-migrate-staging` (staging, `deploy-staging.yml`) hold the dynamic grant
`{ grant: migration-run }` and nothing else. The loader requires: a `github-oidc` identity with an
`environment` (production also only `refs/heads/main`); no secret, audience, scope, other dynamic
grant or environment grant; and no other policy, in any environment, naming one of its workflow
files (on top of the rule that two policies may not share a repository, environment and workflow
file). Q71 carve-out (Igor, 2026-11-27): only such a policy may list `workflow_run` together with
`schedule` and `workflow_dispatch` and grant production; the workflow's `workflow_run` trigger
stays limited to `branches: [main]`. The name `migration-proxy` is registered for the proxy's own
Worker: the change that adds the Worker turns it into its `worker-binding` policy (staging and
production, `MIGRATION_PROXY_DB_PASSWORD` and `MIGRATION_PROXY_GITHUB_APP_KEY` in
`/workloads/migration-proxy`), since the repository check refuses a worker-binding policy no
Worker here binds STS as.

**Audit.** An attestation STS gives writes no row (the proxy writes `run_started`). A refusal of an
identified caller (a props caller, or a token whose signature verified) becomes
`ai.kilo.sts.migration_attest.denied` through the denial object, channel `migration-attest`,
merged per minute like every denial. The proxy's own events (`ai.kilo.migration_proxy.*`,
`MIGRATION_PROXY_AUDIT_TYPES`) travel on its own queues, which audit-relay admits only for
`migration-proxy:<environment>:` streams with source `kilo:migration-proxy:<environment>`.

**Cost.** One RPC per proxy POST or poll: one JWKS-cached verify in the Worker, no Durable Object
hop, and a denial hop only for a refusal. The attestation verifier is its own per-isolate instance
(`src/migration/attest.ts`), apart from the routes' verifier, because it verifies with another
audience and over every policy. So an isolate that serves both may fetch GitHub's discovery
document and key set once more (two small fetches, then cached like the routes' copy), and keeps
one more cached key set in memory, a few kilobytes.

## Database leases

STS brokers one PostgreSQL role per request from Infisical's dynamic PostgreSQL engine (design 4.5,
6.1 job 3). The role exists only for its lease: Infisical creates it with a random password and a
`VALID UNTIL` expiry, and runs the revocation statement (end the role's sessions, drop it) when the
caller revokes it or the lease expires. STS never stores the username or the password; they pass
through the lease object to the caller once.

| Grant | Who may hold it | Infisical dynamic secret | Ceiling | The role | Target STS returns |
|---|---|---|---|---|---|
| `replica-read` | A `worker-binding` policy (bouncer-watch) | `replica-read` in `/dynamic/replica-read` | 8 hours, 4 active | Member of `kilo_lease_replica_read`: `SELECT` on `public`, plus what PostgreSQL grants to every role (see Risks) | None: the consumer keeps its own replica host |

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

The loader refuses an unknown grant or field (`ci-migration` included: it was removed with the
migration proxy, design Q64a), a grant listed twice, a `maxTtlSeconds` above the grant's ceiling
(8 hours), a `defaultTtlSeconds` above `maxTtlSeconds` or below 5 minutes, a `maxActive` above the
grant's ceiling (4), and `replica-read` on any identity but `worker-binding`. A policy without
`dynamic` leases nothing. No lease is served over HTTP: `/v1/lease` and `/v1/lease/revoke` are
gone, since no identity but a Worker binding can hold a grant.

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

| Answer | Meaning |
|---|---|
| `ok` | `leaseId`, `grant`, `username`, `password`, `expiresAt`, `ttlSeconds`, `clamped` (the request asked for more than the policy maximum) |
| `denied` | `identity_rejected` (the binding carries no valid props), `unknown_workload`, `environment_mismatch`, `grant_not_allowed` |
| `limited` | `too_many_active` (the policy's `maxActive` of this grant, a creation in progress included) or `rate_limited` (4 creations by this workload in the last minute, whatever their outcome), with `retryAfterSeconds` |
| `invalid_request` | Not `LeaseRequestSchema`: an unknown grant, a lifetime under 5 minutes or above a day |
| `unavailable` | Infisical refused or failed, the lease object failed or did not answer in 25 seconds, or the environment has no `MANAGER_PROJECT_SLUG` |

Revoke answers `revoked` for the caller's own lease once STS has revoked it (no Infisical call
then), `unavailable` without an Infisical call once STS stopped its revocation as `unconfirmed`,
and `not_found` for any lease id STS did not hand to this workload, another workload's included.
An expired lease still goes to Infisical, which answers 404 once its own expiry revocation
succeeded: expiry stops new logins, not open sessions.

**How a lease is made.** The Worker checks the caller (its binding's props) and the policy grant,
takes the request's lifetime or the policy default, and shortens it to the
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
seconds later. A 404 after a recorded `revoke_failed` is `gone`: trial check 3 showed (staging,
2026-11-26) that Infisical keeps a lease whose revocation failed, answering every later revoke with
200 and the kept row, until a revocation succeeds, and that the 200 of that success still carries
the stale `Failed to delete` status; the 404 that follows is the confirmation. Its row carries
`detail: gone_after_failure` and the object logs a warning (not an error, so it pages no one),
because a forced delete at Infisical answers the same 404 (Risks). Only a 404 whose message names
exactly the lease id asked for counts; one naming another id keeps the revocation owed. The alarm
takes at most 5 leases, least recently tried first, so leases that keep failing cannot hold back a
newer one; it retries a lease no sooner than
30 seconds after its last attempt, the caller's included, or after Infisical's `Retry-After` on a
429 when that is longer. A caller's revoke then answers `unavailable`, and the caller may retry
too. A creation that times out may still have made a role at the database. Its password reached no
one, and Infisical drops it at expiry. Rows are deleted a day after their lease ended; a row whose
revocation is still owed stays until the object stops it.

**Audit.** On the `sts:<environment>:leases` stream: `ai.kilo.sts.lease.created` (workload,
identity, channel, grant, lease id, `ttlSeconds`, `requestedTtlSeconds` when given, `clamped`,
`expiresAt`) and
`ai.kilo.sts.lease.revoked` (`cause`: `caller`, `late`, `expiry_mismatch` or `audit_failed`;
`result`: `revoked`, `gone` when Infisical no longer had it (with `detail: gone_after_failure`
when an earlier attempt had failed), `revoke_failed` when Infisical did not confirm it, or
`unconfirmed` when the object stopped a day after the expiry; the last two with
outcome `failure`). Refusals of an identified caller become
`ai.kilo.sts.lease.denied` through the denial object, merged per minute: the answer's reason, or
for a revoke the caller heard as `not_found`, `not_owner` (another workload's lease) or
`unknown_lease`. `ai.kilo.sts.lease.replica_swept` records one sweep
of one replica that changed something (Replica sessions below): `replica` (the Hyperdrive binding
name) and `result` `ended` with `sessions` and `afterFailures` (a sweep that ended sessions, or the
first to succeed after failures), or `failed` with `consecutiveFailures` and `detail` (the error's
name and code) and outcome `failure` (the first failure of a streak, and the 15th). No row carries
a username, a password or a host. Infisical's own audit log records each lease and revocation, the
expiry revocation included.

**Replica sessions (design decision Q63).** Infisical creates and drops the role on the primary,
through its direct endpoint; no dynamic engine can write to a standby. The role reaches the replica
through replication, so a consumer that logs in right after the lease is created may have to retry
for the replication delay. The same login also works on the primary: Supabase gives no per-role
host rule (no `pg_hba.conf` access), so nothing stops a `replica-read` holder from connecting to
the primary instead. On the primary, the revocation (and the expiry revocation) ends the role's
sessions, and every later revocation of the same template also ends the sessions of lease roles
whose `VALID UNTIL` has passed. Neither reaches a replica: a session open there stays connected
after its role is dropped (its next statement fails with `invalid role OID`, an idle one lingers),
and the role settings `statement_timeout` (60 s), `idle_in_transaction_session_timeout` (60 s) and
`idle_session_timeout` (15 min) protect an honest consumer only: a session can change any of them
with `SET`.

The lease object's sweep ends them. Once a minute its alarm connects to each replica that
`LEASE_REPLICA_SWEEP_BINDINGS` names, through that replica's Hyperdrive binding, as
`kilo_lease_sweeper`, and runs `SELECT kilo_lease.sweep_sessions()` (`setup-replica-sweeper.sql`).
That `SECURITY DEFINER` function ends, on the node it runs on, the sessions of every lease role
`kilo_lease.lease_role` recorded, of either template, that no longer exists, has no login (a
revocation blocked it) or is past `VALID UNTIL` (an expiry whose revocation did not run or failed).
It ends nothing else: not a live lease, `postgres`, a superuser, an admin login or an application
role, and not a dropped role that was never a lease; a role that still exists counts only while it
is a member of its row's template. It takes no role name, so it also covers Infisical's own
expiry, which never calls STS (and STS never stores a lease username). The row of a dropped lease
role stays 7 days after the role went (`setup.sql`'s `end_sessions` forgot it at the next
revocation, possibly before the replica's next sweep), so a sweep that could not reach a replica
for less than 7 days still finds its sessions.

- **Bound.** Each alarm starts the sweep before any other work (the audit relay, owed revocations
  and pruning run beside it, and a throw in them can skip neither the sweep nor the next alarm),
  and a replica's next sweep is due 60 seconds after the alarm that swept it fired. So a replica
  session of a revoked, blocked or expired lease ends at most 60 seconds plus the sweep's own time
  (at most 10 seconds: 5 to connect, 5 for the statement, and the sweeper login's
  `statement_timeout` of 5 seconds) after the role change reaches the replica, plus however late
  the platform runs the alarm, while the replica answers. `replica-sweep-check.ts` measured 55 and
  60 seconds through STS (Tests).
- **Failures.** Each replica gets one attempt per minute and no retry inside the minute; a failure
  is a warning, the 15th in a row (15 minutes) is logged as an error once per streak, and the next
  sweep retries. A listed name without a Hyperdrive binding counts as a failing sweep.
- **Start.** The cron (every 5 minutes) calls `LeaseDO.ensureSweeping` while replicas are
  configured, so the loop runs with no lease call and comes back if the object lost its alarm.
- **Audit.** `ai.kilo.sts.lease.replica_swept` above. A sweep that ended nothing writes no row (it
  would be 1,440 rows a day per replica that change nothing); its failures are audited. A replica
  that flaps (fails, answers, fails) writes two rows per flap, a `failed` row and the `ended` row of
  the recovery: at most one row per replica per minute, 1,440 a day, in the worst case.
- **Why this mechanism.** A call per revocation would miss Infisical's own expiry; pg_cron runs no
  job while a server is in hot standby (https://github.com/citusdata/pg_cron, Setting up
  pg_cron); the lease object already has the alarm, the audit stream and the environment's
  config. Hyperdrive, not a direct socket: a Worker's TLS socket accepts only publicly trusted
  certificates, and Supabase's database certificates chain to Supabase's own CA (the dashboard's
  SSL certificate; a Worker build of a Postgres driver fails the handshake against it,
  https://github.com/porsager/postgres/issues/1213), so a Worker cannot verify a direct
  connection. Hyperdrive verifies it (`--sslmode verify-full` with the uploaded Supabase CA,
  https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
  and holds the sweeper password itself, so no STS code or storage sees it.

While a block's `LEASE_REPLICA_SWEEP_BINDINGS` is empty nothing ends a replica session: what bounds
it is the consumer's own run deadline (bouncer-watch: 55 and 130 minutes, under the 60 and
150-minute leases); `VALID UNTIL` and the dropped role refuse a new login on both nodes. So no
policy grants `replica-read` in an environment before its block names every replica (design
decision Q63). `check.sh` shows on a streaming replica that the revocation leaves the replica
session open and that the sweep ends it, after a revocation, a half-done revocation and an expiry,
and never ends the others.

**Risks.**

- Never force-delete an STS lease or its dynamic secret at Infisical (the lease's or the dynamic
  secret's "force delete" in the dashboard or API). Infisical then drops the lease without running
  the revocation statement, so the role, its login and its sessions stay at the database, and STS
  hears the same 404 as for a confirmed revocation (`gone`, with `detail: gone_after_failure` when
  an earlier attempt failed). To end a lease whose revocation keeps failing, fix the cause (the
  failure's `statusDetails` in the Infisical dashboard) and let STS's retry or a normal revoke run;
  to remove a dynamic secret, first revoke every lease it holds. If a forced delete happened, end
  the role's sessions and drop it by hand as its admin login (`revoke.sql` with the role's name).
- `postgres` administers every role it created, through the ADMIN grant PostgreSQL gives the
  creator, and only a superuser can remove that grant. A role in between does not help: ADMIN
  follows memberships (`check.sh` shows it). So `postgres`, and any session acting as it, can
  reset the password of `kilo_lease_replica_admin`; whoever holds `postgres` already holds every
  right a `replica-read` lease has. The login lives only in its dynamic secret's configuration; the
  break-glass owner enters it once, and Terraform ignores the field (design 4.2).
- The admin login cannot end another role's session: it holds no `pg_signal_backend`. The
  revocation calls `kilo_lease.end_sessions`, a `SECURITY DEFINER` function with a fixed
  `search_path`, owned by `postgres` (which Supabase makes a member of `pg_signal_backend`). It
  ends only the sessions of the lease roles, as `kilo_lease.lease_role` records them by
  OID at creation: the one being revoked, blocked or expired ones, and dropped ones. A session of a
  dropped role that was never a lease is left alone (PostgreSQL keeps an ordinary role's sessions
  open when the role is dropped). A leaked login can still create roles and use up connections:
  each lease role has a connection limit of 4 (at most 16 at the policy's `maxActive`), but the
  login sets the limit itself when it creates a role, so only `max_connections` caps a leaked
  login. The login's own `CONNECTION LIMIT 4` caps its sessions, not the roles it makes.
- The sweeper login `kilo_lease_sweeper` holds `USAGE` on `kilo_lease`, `EXECUTE` on
  `kilo_lease.sweep_sessions` and what PUBLIC holds (the reach `report.sql` lists for a lease,
  without its `SELECT` on `public`). Its sweep ends only sessions of leases that already ended; it
  cannot end a live lease's session or any other one, directly or through another `kilo_lease`
  function (`check.sh`). It logs in on both nodes (no per-role host rule), with `CONNECTION LIMIT
  5`: Hyperdrive may keep up to 5 sweeper connections open and idle on each replica, and they
  count against that replica's `max_connections`. Its password sits in each replica's Hyperdrive
  configuration and in Infisical `/admin`; `postgres` created it and can reset it.
- What the sweep does not bound: a session of an ended lease lives until the next sweep that
  reaches its replica (at most 70 seconds after the role change reaches the replica, plus however
  late the platform runs the alarm). While a replica stays
  unreachable or its replication lags, longer: the error after 15 failed sweeps is the signal, and
  a person ends the sessions by hand (`SELECT kilo_lease.sweep_sessions()` as the sweeper, or
  `pg_terminate_backend` as `postgres`). A replica that `LEASE_REPLICA_SWEEP_BINDINGS` does not name
  is not swept. The row of a role gone over 7 days is forgotten, so a replica the sweep could not
  reach for that long keeps that role's sessions until someone ends them.
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
  session. So `revoke.sql` is two transactions in Infisical's one call
  (it runs the parts split on `;` on one connection, between its own `BEGIN` and `COMMIT`): the
  first commits `NOLOGIN` and `VALID UNTIL -infinity` and ends the sessions; the second refuses a
  role that still has its login, waits one second for a login that passed its checks before that
  commit to show in `pg_stat_activity`, ends the sessions, drops what the role owns, ends them
  again and drops the role. `check.sh` runs a reconnect loop through a revocation (3
  `replica-read` rounds) and finds no session left, of the role or of a
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
  are `postgres` and the superusers, who can already create such a role. A pgaudit object audit
  (`pgaudit.role`) that covers the `kilo_lease` functions, or
  a module enabled after setup, still could log it; the trial checks for both before the first
  lease.
- The setup files never put an admin login's password into a top-level DDL statement either:
  `setup.sql` and `setup-replica-sweeper.sql` pass it in a transaction-local setting
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

Then, as `postgres` too, right after it, the replica sweep's
part (Replica sessions above; the password goes into Infisical `/admin` as
`LEASE_REPLICA_SWEEPER_PASSWORD` and into each replica's Hyperdrive configuration, below):

```sh
psql "<primary direct URL>" -v ON_ERROR_STOP=1 \
  -v sweeper_password="$(openssl rand -hex 32)" \
  -f services/sts/sql/leases/setup-replica-sweeper.sql
```

Generate the password into the break-glass owner's session only (or into a variable) and enter it
into the dynamic secret below. `setup.sql` ends with `report.sql`, one row per finding and a
`summary` row; every count in the summary must be 0 (Risks lists the rows that remain by design).
Run `report.sql` again after a migration adds a function or an extension.

What the setup guarantees. `postgres` owns the `kilo_lease` schema, its table and its functions
and administers the replica login, so whoever holds `postgres` could change them; no lease acts as
`postgres`, and `postgres` already holds every right a `replica-read` lease has.
`setup-replica-sweeper.sql` adds the `gone_since` column (the 7-day row retention), replaces
`kilo_lease.end_sessions` with the version that keeps those rows, and creates
`kilo_lease.sweep_sessions` and the sweeper login.

**Removing the ci-migration trial.** The `ci-migration` grant is gone (design Q64a), but an
environment where the trial's `setup-ci-migration.sql` ran still holds its roles, and
`report.sql` lists each as a `leftover` (`role of the removed ci-migration trial`) until they are
dropped. `sql/leases/remove-ci-migration-trial.sql` does it, in this order (`check.sh` runs it):

1. Read-only listing of `kilo_lease_migration_admin`, `kilo_lease_migration`, the `lease_cm_*`
   roles and `kilo_lease_owner`:
   `psql "<primary direct URL>" -v ON_ERROR_STOP=1 -v list_only=1 -f services/sts/sql/leases/remove-ci-migration-trial.sql`.
   Nothing listed: stop here.
2. Run it again without `list_only`, as a superuser while `kilo_lease_owner` exists (else as
   `postgres`), in one transaction: `REASSIGN OWNED BY kilo_lease_owner TO postgres`; then for each
   `lease_cm_*` role, `kilo_lease_migration_admin`, `kilo_lease_migration` and last
   `kilo_lease_owner`: `DROP OWNED BY` and `DROP ROLE`.
3. Before it commits, it checks that `postgres` owns the `kilo_lease` schema, its table and every
   function again, and rolls back otherwise; then it runs `report.sql`, whose summary must show
   `leftover=0`.

Then remove the Infisical side: the `ci-migration` dynamic secret and `/dynamic/ci-migration`, and
the STS role's `lease` rule for that folder.

**Infisical setup, per environment (staging first).**

1. Folder `/dynamic/replica-read` in the environment.
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
3. The STS identity's project role in that environment gains `dynamic-secrets` action `lease` with
   the conditions `environment` equal to the environment and `secretPath` equal to
   `/dynamic/replica-read`; nothing else on
   `dynamic-secrets`, so STS cannot read or change the root credential. `lease` covers create,
   renew and revoke.
4. Network: if the Supabase project restricts addresses, allow Infisical Cloud EU's egress
   addresses (https://infisical.com/docs/documentation/setup/networking).
5. A lease from the Infisical dashboard (trial check 3): create, log in through the replica,
   renew, then let one expire with a session open on the primary and see it ended and the role
   dropped. Revoke one from the dashboard with a session open and see in the Postgres log that the
   two parts ran as two transactions (the role has no login after the first commit). Check that
   neither admin login's statements reach the Postgres log (`select rolname, rolconfig from
   pg_roles where rolname like 'kilo_lease_%admin'` shows the settings) and that no pgaudit
   object audit covers schema `kilo_lease`. Force a revocation failure (for example, revoke
   `EXECUTE` on `kilo_lease.revoke_lease` from the admin login for the test) and check that every
   later revoke answers 200 with the kept row (`status` `Failed to delete`) and never a 404 until a
   revocation succeeds (confirmed on staging on 2026-11-26: the successful revoke's 200 still
   carried `Failed to delete`, and the next revoke got the 404; STS reads that 404 as `gone`).
6. STS: set `MANAGER_PROJECT_SLUG` (Infisical → project settings) in that environment's block of
   `wrangler.jsonc`, deploy, then add the policy grants. Grant no `replica-read` until the replica
   sweep below runs in that environment.

**Replica sweep setup, per environment (staging first).** After `setup-replica-sweeper.sql`:

1. Infisical `/admin` (human-only, no STS role reads it): `LEASE_REPLICA_SWEEPER_PASSWORD`, the
   password the setup used, so a secret admin can rebuild a Hyperdrive configuration.
2. Cloudflare, once per account: upload Supabase's CA (dashboard → Database settings → SSL
   configuration) with `npx wrangler cert upload certificate-authority --ca-cert
   supabase-ca.crt --name supabase-ca`.
3. One Hyperdrive configuration per read replica of the project, with the replica's direct
   connection string (dashboard → Connect, source: the replica) and the sweeper login:
   `npx wrangler hyperdrive create sts-<environment>-lease-sweep-<replica> --connection-string
   "postgres://kilo_lease_sweeper:<password>@<replica host>:5432/postgres" --ca-certificate-id
   <id> --sslmode verify-full --caching-disabled --origin-connection-limit 5`. `--caching-disabled`
   is load-bearing: the sweep's statement is a `SELECT`, and a cached answer would come back
   without running it, so no session would end.
4. Check each configuration: `npx wrangler hyperdrive get <config id>` shows caching disabled and
   `sslmode` `verify-full` with the uploaded CA.
5. In that environment's block of `wrangler.jsonc`, a `hyperdrive` binding per replica
   (`{ "binding": "LEASE_SWEEP_<REPLICA>", "id": "<config id>" }`) and their names in
   `LEASE_REPLICA_SWEEP_BINDINGS`; deploy. The repo check refuses a listed name without its binding.
6. Trial: with a lease from the Infisical dashboard, open a session on the replica, revoke the
   lease, and see the session end within 70 seconds and an
   `ai.kilo.sts.lease.replica_swept` row with `sessions` 1 in Axiom. Repeat at once with a second
   lease, so that two sweeps in a row each end a session (a cached sweep would end only the first);
   no `failed` row in the next 15 minutes. Then add `replica-read` grants.

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

The replica sweep costs about 1,440 `LeaseDO` alarm runs a day per environment while a replica is
configured (one a minute, whatever the replica and lease counts), and per replica one Hyperdrive
connection and one `SELECT kilo_lease.sweep_sessions()` a minute; Hyperdrive may keep up to 5 idle
sweeper connections open on each replica, which count against its `max_connections`. The
statement scans `pg_stat_activity` (one row per connection) joined with `kilo_lease.lease_role`,
which holds the live leases plus the leases that ended in the last 7 days: up to about 7 times the
daily lease count (bouncer-watch at its sized 50 leases a day: about 350 rows). It writes an audit
row only when it ended sessions or failed, and the cron adds one `LeaseDO` call every 5 minutes
while a replica is configured.

Only a workload whose policy lists a `dynamic` grant makes leases; no client or Vercel request
path does. So lease volume is the same at 10,000, 50,000 or 200,000 clients, at any number of
Vercel instances and releases. Denials: each isolate sends at most one denial-object hop per
distinct denial per minute (reason, grant or lease id, and the caller's claims), and counts the
rest. A workload at its limits on its one grant has two distinct refusals (`too_many_active`,
`rate_limited`), so at most 2 hops per isolate per minute. The worst case is a caller that revokes
many unknown lease ids: one hop per distinct id, until 100 distinct denials in the minute, after
which the isolate counts the rest as one overflow row per reason.

## Cloudflare deploy tokens

STS mints one Cloudflare account API token for one CI deploy (design 4.4, 4.5 and 6.1 job 3). The
deploy job proves itself with its GitHub OIDC token; STS creates the token with a minting
credential that only STS reads, for the permission set the job's policy names, for at most 1 hour.
Cloudflare does not federate GitHub OIDC, so this replaces a stored long-lived deploy token.

**What the token can do, and what it cannot be limited to.** STS cannot limit a minted token to
named Workers. Cloudflare has documented tokens scoped to "Specified Workers" (the `Individual
Workers Admin` and `Editor` groups, account-owned tokens) since 2026-09-15
(https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/), but
creating one fails with `"com.cloudflare.edge.worker.script" is not a supported resource type`,
in the dashboard as through the API (reports from 2026-09-28 to 2026-10-15, for example
https://community.cloudflare.com/t/cannot-create-api-token-scoped-to-one-worker/963400), the
create-token docs still name only the User, Account and Zone resource types
(https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/), and no script
resource key is published. Custom Domains have no per-Worker roles, and creating a new Worker
needs product-level Admin (https://developers.cloudflare.com/workers/authorization/workers/).
Setup check 6 tries such a token; until it works, a token with `Workers Scripts Write` can change
every Worker in the account for its hour, and a token with zone `Workers Routes Write` every route
of its zones. This is the fallback that the bouncer integration design accepts (section 4): an
account-wide deploy right, only for a job of one repository's protected GitHub environment on
`main`, for 1 hour. While staging and production share one
account (below), the loader holds every `cloudflare-deploy` grant, in every environment, to
`refs/heads/main` alone (`CLOUDFLARE_ACCOUNT_SHARED_ACROSS_ENVIRONMENTS` in `src/constants.ts`), so
the gate is `main` whichever environment's policy minted the token. `main` is not the whole gate:
while the account is shared, a staging job on `main` gets production-Worker rights without the
production GitHub environment's protection rules, so the staging deploy environment must carry
the same rules (setup step 6 checks it). A policy's `intendedScripts` lists the Workers the job
deploys, for review and audit only; STS does not and cannot enforce it.
An account-wide deploy right also lets its holder deploy a Worker that binds STS with any
`props.caller` and so read that workload's bundle (design 6.4, deploy-level trust): for its hour,
a minted token is as strong as the stored deploy token it replaces (design decision Q65). That
includes STS itself: STS deploys into the same account, so a minted token can replace the STS
Worker, and the replacement keeps STS's bindings (its signer and Durable Objects), reads
`/ci/minting` and mints with the minting token directly, past the pinned groups, the hour and the
audit. With the minting token it can create account tokens that outlive any hour. The stored
deploy token reaches STS the same way today. Moving STS into its own Cloudflare account, where no
deploy token reaches it, closes this; that is an open owner decision with the staging account
(design Q65).

The hour bounds the token, not what it leaves behind. A misused token can deploy or replace a
Worker, and that Worker keeps running after the token expired: one that binds STS with any
`props.caller` keeps reading that workload's bundle until someone finds and removes it. Staging
and production share one Cloudflare account (the single `account_id` in `wrangler.jsonc`), so a
token minted by staging STS for a staging deploy job can also overwrite production Workers for its
hour; the `sts-<environment>-` name prefix separates only STS's own bookkeeping (the sweep), not
what a token can reach. That is the same reach as the stored deploy token it replaces. A separate
Cloudflare account for staging would close it, and would let the `main`-only rule above relax for
staging; that is an open owner decision (design Q65). The detective control is the window check
below: about 2 minutes after each token's hour ends, STS lists the account's Worker scripts and
its zones' Workers routes, and writes `deploy_token.unexpected_script` or
`deploy_token.unexpected_route` for a change that no token live at the time intended. It cannot
see a Worker created and deleted inside the window. Nor can it see a change to the STS Worker of
its own environment: a token that replaced STS also replaced the code that runs the check. A
monitor outside STS covers that (setup step 7).

**Residual risk, accepted.** A create-tokens credential in STS can mint any permission and roll
all account tokens; accepted by Igor 2026-11-26. Staging check 6 showed it: the account-owned
minting token's own policy is no ceiling, and it reads, rolls and deletes every account token. So
whoever reads `/ci/minting`, or replaces the STS Worker (which any minted deploy token can, above),
controls every account token, not only one hour of deploy rights. Igor declined the alternatives
(STS in its own Cloudflare account; a dedicated member with a restricted role) on 2026-11-26
(design Q65). The detective controls are the window check's `unexpected_script` and
`unexpected_route` rows and the monitor of the STS Worker outside STS (setup step 7). The minting
credential can also roll or delete the monitor's own Cloudflare token; that is why the monitor
posts every run that fails and, through a second workflow that needs no Cloudflare token, every
45 minutes without a successful run.

**Policy.** A `github-oidc` policy bound to a GitHub environment lists one `cloudflare-deploy`
entry in `dynamic`:

```yaml
workload: ci-deploy-bouncer
environments: [production]
identity:
  kind: github-oidc
  repository: Kilo-Org/bouncer
  repositoryId: '<repository id>'
  repositoryOwnerId: '<owner id>'
  environment: production
  jobWorkflowRefs: [Kilo-Org/bouncer/.github/workflows/deploy.yml@refs/heads/main]
  events: [push]
secrets: []
dynamic:
  - grant: cloudflare-deploy
    permissionSet: bouncer-deploy
    permissionGroups: # ids from GET /accounts/<account>/tokens/permission_groups (setup step 3)
      - { id: 'e086da7e2179491d91ee5f35b3ca210a', name: Workers Scripts Write, scope: account }
      - { id: 'bdbcd690c763475a985e8641dddc09f7', name: Workers Containers Write, scope: account }
      - { id: '28f4b596e7d643029c524985477ae49a', name: Workers Routes Write, scope: zone }
    zones: ['9f7103cbcadbe93a052c120f231e8507'] # kiloapps.io
    intendedScripts: [bouncer, bouncer-watch]
    intendedRoutes: [] # zone route patterns the job may add or change; bouncer uses a Custom Domain
    ttlSeconds: 900 # 300 to 3600; the default is 3600
    maxActive: 2 # unexpired tokens at once
    maxPerHour: 12 # mint requests per hour, whatever their outcome; at most 12
```

STS sends only the ids: the `account` groups apply to the account in `CF_DEPLOY_ACCOUNT_ID`, the
`zone` groups to each listed zone. A name never authorizes and is never sent. It is Cloudflare's
name for that id, copied in setup step 3: the minted token must come back with exactly that name
for each id (see "How a token is made"), so a mislabelled id is caught at the first mint. The
loader refuses the grant on any identity but a `github-oidc` one with an `environment`, one that
accepts a ref other than `refs/heads/main` (in every environment while the account is shared; a
production policy also accepts only `refs/heads/main`, as every GitHub policy does), a second
`cloudflare-deploy` entry, a `ttlSeconds` above 3600 or below 300, a `maxActive` above 3, a
`maxPerHour` above 12 or below `maxActive`, a group listed twice, a `zone` group without zones or
zones without a `zone` group, a group whose name matches `API Token` or `member`, and any group or
zone outside the pins in `CLOUDFLARE_DEPLOY_PINS` (`src/constants.ts`). Those pins hold three
lists, filled in at setup step 3 and empty until then: `allowedGroups`, the only groups a grant may
list, each with its scope (the three deploy groups); `allowedZones`, per STS environment, the only
zones a grant of that environment may list (`kiloapps.io` serves staging and production alike, so
it is in both lists and this check cannot separate them; it keeps every other zone out); and
`forbiddenGroupIds`, the token, member, role and account-settings groups, which a deploy token
that can create tokens or manage members could use to make a credential that outlives its hour.
`DeployTokenDO` checks the same pins again before it calls Cloudflare. While `allowedGroups` or
`forbiddenGroupIds` is empty and `CF_DEPLOY_ACCOUNT_ID` is set, it refuses every mint with
`denied` `not_configured` (403, not retryable) and calls nothing, so setup step 5 cannot take
effect before step 3. The minting token's own policy does not stop a token group: it must hold
`Account API Tokens Write` to mint at all, and Cloudflare documents no rule that limits what an
account token may grant to the tokens it creates (the subset rule on
https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ is written
for members). So the pins and the runtime check of the returned token are what keep token
provisioning, and any group beyond the deploy groups, out of a minted token; setup check 6
confirms the minting token's fixed policy bounds it too.

**Calling it.** The job asks with no body and revokes in an `always()` step:

```sh
oidc() { curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://sts.kiloapps.io" | jq -r .value; }
answer=$(curl -sS --fail-with-body -X POST https://sts.kiloapps.io/v1/ci/cloudflare-deploy-token \
  -H "Authorization: Bearer $(oidc)")
echo "::add-mask::$(jq -r .token <<<"$answer")"
# CLOUDFLARE_API_TOKEN=<.token> pnpm run deploy && pnpm run watch:deploy
# then, in an always() step, with a fresh OIDC token:
curl -sS -X POST https://sts.kiloapps.io/v1/ci/cloudflare-deploy-token/revoke \
  -H "Authorization: Bearer $(oidc)" -H 'content-type: application/json' \
  -d "{\"tokenId\":\"$(jq -r .tokenId <<<"$answer")\"}"
```

| Answer | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | `token` (`cfat_...`), `tokenId`, `expiresAt`, `ttlSeconds`, `permissionSet` |
| `denied` | 401 or 403 | `identity_rejected` (401: another workflow, event, ref or GitHub environment, a fork's event, or a token without a run id), `unknown_workload`, `environment_mismatch`, `grant_not_allowed`, `not_configured` (STS's setup step 3 has not pinned the forbidden and allowed groups; no retry helps) |
| `limited` | 429, `Retry-After` | `too_many_active` (the policy's `maxActive` unexpired tokens, one being made or one whose deletion failed included), `rate_limited` (`maxPerHour` mint requests in the last hour) or `account_limit` (this environment holds 100 tokens that may exist at Cloudflare: being made, unexpired, owed a deletion, possibly left by a creation whose outcome is unknown (not one Cloudflare refused or that was never sent), or found by the sweep and not yet deleted; two environments then hold at most 200 of the account's 500, 5 minutes) |
| `invalid_request` | 400 (413 above 1 KB) | A body other than empty or `{}` |
| `unavailable` | 503, `Retry-After` | No minting credential, Cloudflare refused or failed (a 429's `Retry-After` is passed on), the object did not answer in 35 seconds, or the environment has no `CF_DEPLOY_ACCOUNT_ID` |

Revoke answers `revoked` (200) for the caller's own token, also when it is already deleted (no
Cloudflare call then), and `not_found` (404) for any token id STS did not hand to this workload
and run: another workload's, another run's of the same workflow (a re-run attempt of the same run
may revoke it), or one STS never issued. Each `not_found` writes a denial row with its reason
(`not_owner`, `other_run`, `unknown_token`). After a failed deletion, a revoke before the row's
retry time answers `unavailable` with the time left and makes no Cloudflare call: the caller and
the alarm wait for the same retry time.

**How a token is made.** The Worker checks the job's token and the policy grant, then makes one
call to `DeployTokenDO`, one object per environment, bounded at 35 seconds and never retried (a
creation changes the account). The object's 30-second budget runs from when STS called it. The
object:

1. Refuses a request that reached it after its budget, or while Cloudflare's last `Retry-After`
   runs, with no Cloudflare call. Refuses a grant that lists a pinned forbidden group id (the
   loader refuses it too) and a request at the workload's limits. A creation in progress holds
   its slot as a `pending` row, and the object sets its alarm to the row's budget end: if the
   object stops during the creation, the alarm ends the row as an `unknown` outcome (step 5).
2. Reads the minting credential: `CLOUDFLARE_MINTING_TOKEN` in `/ci/minting` of its own
   environment, with `GET /api/v4/secrets` for that folder alone (`recursive=false`), as the STS
   identity. It keeps the value in memory only, for 4 minutes (a rotation reaches it within 4
   minutes) or until Cloudflare answers 401 or 403 to it.
3. Calls `POST /accounts/<CF_DEPLOY_ACCOUNT_ID>/tokens` with `name`
   `sts-<environment>-<workload>-<run id>-<row>`, the policies above, `not_before` now and
   `expires_on` now plus `ttlSeconds`, whole seconds
   (https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/).
4. Deletes the token at once and answers `unavailable` when it cannot hand it over: the budget ran
   out before or right after the `deploy_token.minted` row was written (`late`), Cloudflare's
   `expires_on` is later than the one asked for, or more than 2 minutes earlier
   (`expiry_mismatch`; the job is told the requested lifetime, so a later expiry is never handed
   over), the answer names the token but cannot be read otherwise (`grant_mismatch`), the policies
   Cloudflare returns are not exactly the ones sent (`grant_mismatch`: the same effect, group ids
   and resources per policy, and each group named exactly as the policy declares its id, so a
   group without a name or with another name fails; the loader refuses a declared name like a
   token or member administration group, and step 1 a pinned id, so an exact match holds
   neither), or the row could not be written (`audit_failed`). The token value never leaves the
   object then.
5. Otherwise writes `deploy_token.minted` and marks the row active in the same output gate, and
   returns the token. A creation Cloudflare refused (4xx) writes `deploy_token.mint_failed` with
   outcome `refused` and the status. A creation that timed out, got a 5xx, or got an answer that
   names no token id, or was cut off by the object stopping, may have made a token nobody received: it
   writes `deploy_token.mint_failed` with outcome `unknown` and the token's name, and the sweep
   deletes that token once it expired (it is brought forward to then: the requested expiry plus
   2 minutes, or, for a creation cut off, the budget end plus 1 hour and 2 minutes).

**Deletion, the reaper and the sweep.** An expired Cloudflare token stays in the account and
counts against its cap of 500 account tokens
(https://developers.cloudflare.com/fundamentals/api/reference/limits/), so STS deletes every token
it made: on the owner's revoke, and otherwise at expiry, when the object's alarm marks the row owed
and calls `DELETE /accounts/<account>/tokens/<id>`. A deletion Cloudflare cannot take stays owed on
the row until it succeeds, also after expiry: the first failure writes a row with result
`delete_failed` (if that append fails, the next failure writes it), and the alarm retries no sooner
than 30 seconds after the last attempt, doubling per failure up to 1 hour, or after Cloudflare's
`Retry-After` when longer. One alarm makes at most 5 deletes, least recently tried first, and an
alarm that retried waits 30 seconds before the next retry. A caller's revoke answers `unavailable`
meanwhile, with the time left; a revoke that arrives while the alarm is deleting that token joins
that call and answers from its outcome. Once a day, and once more after a creation whose outcome
STS does not know, the alarm also sweeps the account's token list (`GET
/accounts/<account>/tokens`, 50 a page, 2 pages per
alarm) and deletes every token whose name starts with `sts-<environment>-`, for which STS holds no
row, and that has expired or carries no expiry (STS always sets one, so such a token is not one it
handed over). It never touches another environment's tokens, an unexpired token, or a token
named otherwise. The list asks for expired tokens too (`include_expired=true`): Cloudflare leaves
them out otherwise, and lists them only while recently expired
(https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/list/), so a
lost creation's token is swept 2 minutes after its expiry. A token the sweep cannot delete (a 403,
a 5xx, no answer) does not hold the sweep up: it goes into `deploy_token_sweep_retry`, the sweep
passes over it, finishes its pages and runs again a day later, and the alarm tries that token
again by id, 30 seconds after the failure, doubling per failure up to a day. Its `delete_failed`
row is written once, and its `deleted` (or `gone`) row once Cloudflare takes it. A 401 or a 429
on a sweep delete stops the sweep as on any call (the hold or Cloudflare's wait below, then the
same page again) and adds no wait of the token's own. A 429 without a readable `Retry-After`
waits 1 minute. Until it is deleted, such a token counts against the environment's 100-token
share (`account_limit`), as it does against the account's cap. When Cloudflare answers 401 or 403
to the minting credential on a list, or 401 on a delete or a token creation (a 403 there can refuse
just that request: a group outside the minting token's own policy, or a token an earlier minting
token created, see "Rotation"), the object drops the credential and stores a hold: until it ends,
the alarm makes no Cloudflare call and reads no credential (deletes, the window check and the
sweep all wait for it, the sweep's next run included). The hold starts at 1 minute and doubles
with each refusal up to 1 hour; a call Cloudflare accepts ends it. A mint or revoke a caller asks
for still reads the credential again, so a replaced minting token works at once. Rows are deleted
a day after their token was deleted, and a handed-over token's row only once its window check
ended.

**Window check (detective control).** About 2 minutes after a handed-over token's live window
closes (its deletion or expiry, plus the 2-minute clock tolerance), the alarm lists the account's
Worker scripts (`GET /accounts/<account>/workers/scripts`, one call: the list has no pages,
https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/) and,
for each zone the closed windows' grants list, the zone's Workers routes (`GET
/zones/<zone>/workers/routes`, one call per zone with no pages,
https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/). It
runs before the alarm's deletions, so deletions that keep failing cannot starve it. A window runs
from the token's creation to its deletion or expiry, widened by 2 minutes on each side.

- **Scripts.** Every script whose `modified_on` falls inside a closed window, and not inside a
  window checked before (that check already compared it), is compared with the `intendedScripts`
  of every token live at that moment. A script none of them names gets one
  `deploy_token.unexpected_script` row.
- **Routes.** A route list carries no modification time, so STS keeps each zone's list from its
  previous check and compares: a route added or changed since then (its pattern or its Worker)
  gets one `deploy_token.unexpected_route` row (with the previous Worker) unless a token with that
  zone live since the previous list intends both its Worker (`intendedScripts`) and its pattern
  (`intendedRoutes`). One token must intend the pair, so one token's pattern pointed at another
  token's Worker is reported, and so is a deploy that widens or adds a pattern for its own Worker,
  sending another host's traffic to it. A zone's first list has nothing to compare with, so it
  reports every route outside the intended Workers and patterns (`firstListOfZone: true`); that is
  noise once per zone, chosen over silently trusting the first list. The list is stored with the
  windows' check mark, in one write.
- **Bounds.** At most 20 rows of each kind per check, each with the total; at most 8 zones per
  check (windows with further zones wait for the next alarm, a second later); a zone with more
  than 1,000 routes fails the check.
- **Failures.** A failed check (no credential, a failed or refused list, a row that could not be
  written) counts against each window in it and is tried again 15 minutes later, then 30. After 3
  failures the window gets `deploy_token.script_check_failed` (attempts, last reason) and stops
  holding its row. A 401 or 403 also starts the credential hold above.
- **What it cannot see.** A Worker or route created and deleted inside a window leaves nothing in
  the lists, and that is exactly how a misused token would read a bundle and clean up. A later
  deploy of the same script, inside or after the window, hides an earlier change (only the last
  `modified_on` is visible). A removed route, or one switched to no Worker, is not reported.
  Workers for Platforms dispatch-namespace scripts (`Workers Scripts Write` reaches them too),
  Containers, Custom Domains, secrets and other Worker settings that leave `modified_on` alone are
  not listed. Listed scripts without a name or a time are left out; the check logs how many. A
  change by someone else in a window (the dashboard, another deploy credential, the other
  environment's STS in the shared account) also shows. A change to the STS Worker of the same
  environment is reported only by a check the changed STS still runs, so it is not a control for
  that case (setup step 7).
- **Why not Cloudflare's audit log.** Audit Logs v2
  (https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/)
  name the acting API token (`actor.token_id`, `actor.token_name`) and are kept 18 months
  (https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/), so
  filtered to the minted token they would also show deletions and route changes. STS does not use
  them yet: they need `Audit Logs Read` (or Account Settings Read) on the minting token; the API
  documents only exclusion filters for the token id; the docs cover "about 95 % of
  products" without naming the Workers endpoints, state no ingestion delay and no per-plan
  availability; and without one real entry for a `wrangler deploy`, a check cannot tell a
  script upload from other actions. It is recorded as the stronger option in design Q65, with the
  staging check that would settle it.

The minting token's `Workers Scripts Write` covers the script list and its zone `Workers Routes
Write` the route list.

**Minting credential.** Only `DeployTokenDO` reads `/ci/minting`. The refresher drops every entry
in `/ci/minting` and below from its `/ci` read before it stores or resolves anything, a bundle
resolves only `/ci/<workload>` (a GitHub workload is named `ci-<job>`, so never `minting`) and
`/shared`, and the loader refuses `CLOUDFLARE_MINTING_TOKEN` in any policy's `secrets`. The value
is never written to storage, a log or an audit row: it lives in the object's memory and in the
`Authorization` header of its Cloudflare calls. Error details carry status codes only, never a
response body. Accepted: the refresher's recursive `/ci` read still receives the `/ci/minting`
values over the wire (TLS to Infisical) and drops them in memory. An Infisical permission that
keeps `/ci/minting` out of that read cannot coexist with the one STS identity that must also read
`/ci/minting`, and a second identity only for the minting read would add a credential for no
gain: both reads run in the same Worker.

**Audit.** On the `sts:<environment>:deploy-tokens` stream, with flat attributes and never a
token value or the minting credential: `ai.kilo.sts.deploy_token.minted` (workload, identity,
channel, `provider: cloudflare`, `permissionSet`, `tokenId`, `tokenName`, `ttlSeconds`,
`expiresAt`, `permissionGroups` (ids), `zones`, `intendedScripts`, and the job's `jobWorkflowRef`,
`runId`, `runAttempt`); `ai.kilo.sts.deploy_token.mint_failed` (outcome `unknown` or `refused`,
`slot`, `tokenName`, `httpStatus` for a refusal, the workload, permission set and run);
`ai.kilo.sts.deploy_token.revoked` (`cause`: `caller`, `late`, `expiry_mismatch`,
`grant_mismatch` or `audit_failed`; `result`: `deleted`, `gone` or `delete_failed`, with outcome
`failure`); `ai.kilo.sts.deploy_token.reaped` (`source: ledger` with the workload and run, or
`source: sweep` with the token's name; `result` as above); and
`ai.kilo.sts.deploy_token.unexpected_script` (`script`, `modifiedAt`, and the `tokenIds`,
`workloads`, `runIds` and `intendedScripts` of the tokens live then, `unexpectedInCheck`; outcome
`failure`); `ai.kilo.sts.deploy_token.unexpected_route` (`zone`, `routeId`, `pattern`, `script`,
`previousScript`, `firstListOfZone`, and the tokens as above); and
`ai.kilo.sts.deploy_token.script_check_failed` (the token, its workload and run, `attempts`, the
last `reason`). Refusals go through the denial object as `ai.kilo.sts.deploy_token.denied` with
their reason, the token id for a revoke, and the caller's stable claims.

**Setup, per environment (staging first). Igor approved it on 2026-11-26.** Steps 3 and 7 are in
the repository: `CLOUDFLARE_DEPLOY_PINS` holds the ids below, `CF_DEPLOY_ACCOUNT_ID` is set in the
staging and production blocks of `wrangler.jsonc` (development stays empty), and the monitor of
step 7 runs as two scheduled workflows. Steps 2 and 4 follow the deploy of that change, staging
first; the production deploy policy (step 5) follows the staging proof.

1. **Creator.** The minting credential is an account-owned API token, not a person or a dedicated
   member: account tokens "act as service principals with their own specific set of permissions"
   (https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/). Only a
   member with API Token Provisioning or a Super Administrator can create one (same page); Igor, a
   Super Administrator, does steps 2 and 3 in his own dashboard session. No mailbox, invite or
   member role is needed. Every Super Administrator of the account (8 today) can see and manage
   every account token, so each of them can delete or roll the minting token
   (`PUT /accounts/<account>/tokens/<id>/value`,
   https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/value/methods/update/)
   and so obtain a working value; the value itself is shown once, at creation. Both environments'
   tokens act in the one account staging and production share.
2. **Minting token.** In **Manage account > Account API tokens > Create Token**, create
   `sts-minting-<env>` (`sts-minting-staging`, `sts-minting-production`) with exactly these
   permissions: on the account (`Kilo Code`, `e115e769bcdd4c3d66af59d3332cb394`) `Account API
   Tokens` Edit, `Workers Scripts` Edit and `Containers` Edit; on the zone `kiloapps.io` `Workers
   Routes` Edit. No other permission, zone or account; no IP filter (Workers have no fixed egress
   address); expiry 90 days from creation. The dashboard's Edit is the API's Write. This fixed
   policy replaces the member role: it is what the deploy rights of every minted token are
   expected to stay within, and setup check 6 confirms Cloudflare enforces it.
3. **Permission-group ids.** In the same dashboard session (Super Administrator), read `GET
   /accounts/<account>/tokens/permission_groups`, which lists every group with its id and name
   (https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/);
   copy the ids and Cloudflare's exact names of the deploy groups of step 2 (`Workers Scripts
   Write`, `Workers Containers Write` (the dashboard's "Containers"), `Workers Routes Write`) into
   the policy. Fill `CLOUDFLARE_DEPLOY_PINS` (`src/constants.ts`): `allowedGroups` with those three
   ids and their scopes (account, account, zone); `allowedZones` with the `kiloapps.io` zone id for
   staging and production; and `forbiddenGroupIds` with the ids of every group that reads or writes
   API tokens, members, roles or account settings (`Account API Tokens Read` and `Write`, `Account
   Settings Read` and `Write`, and from `GET /user/tokens/permission_groups` the user-level `API
   Tokens Read` and `Write` and `Memberships Read` and `Write`). Then deploy. Ids are resolved here,
   once, never by name at runtime. While `CF_DEPLOY_ACCOUNT_ID` is set and the pins are empty, STS
   refuses every mint (`not_configured`); here both land in one change.
4. **Infisical.** Store the minting token as `CLOUDFLARE_MINTING_TOKEN` in `/ci/minting` of the
   environment. The STS identity's `readValue` on `/ci/**` (the grant every GitHub policy needs,
   [Infisical setup](#infisical-setup-per-environment)) covers it. No other identity, role or
   person except the break-glass owner may read `/ci/minting`; the STS deploy job's identity reads
   `/sts-deploy` only.
5. **STS.** `CF_DEPLOY_ACCOUNT_ID` and the pins went in with step 3, in one change with two
   throwaway proof policies. After the staging proof passed, the production deploy policy
   (`ci-deploy-bouncer`) lands in its own change and deploys. The proof policies were removed
   after the production proof (2026-11-27), and the proof repository is archived.
6. **Checks in staging.** A staging deploy job gets a token and deploys with it. Try to create a
   token scoped to one Worker ("Specified Workers", `Individual Workers Editor`), once in the
   dashboard and once through `POST /accounts/<account>/tokens` with the minting token; record
   both answers in Q65 before setup goes on. If either works, a follow-up switches minting to
   per-Worker scope (the script resource key still to be confirmed) and reopens Q65; until then
   the pins keep the account-wide groups of step 3. Asking Cloudflare
   with the minting token for a group outside its own policy (for example `DNS Read`) is refused,
   so its policy is the ceiling; if it is not, the pinned ids and the returned-grant check are the
   only limit and Q65 is reopened. A minted token cannot create a token (`POST
   /accounts/<account>/tokens` with it answers 403). The minting token cannot list, roll or delete
   an account token it did not create: have a Super Administrator create a throwaway canary account
   token, try each with the minting token, then delete the canary; if any succeeds, the minting
   token reaches every account token's rights and Q65 is reopened. A minted token that the job did
   not revoke is gone from the account's token list about an hour later. The sweep's list with
   `include_expired=true` returns a token that expired a few minutes ago. Whether a rotated minting
   token still lists and deletes its predecessor's tokens: the list API gives a caller with
   `list_self` only the tokens it created, and the docs do not say which an account token gets; the
   answer only changes the rotation step below, not the code. The window check's script list and
   the zone's route list answer 200 with the minting token. Which rate-limit budget the calls draw
   from: read the `Ratelimit` header (remaining quota) of a call made with the minting token, run a
   deploy with a minted token, then read it again; if the deploy's calls lowered it, the minting
   token and its minted tokens share one budget, if not, each token has its own. Record the answers
   in the cost paragraph below and Q65. Finally, while the account is shared, confirm in each
   deploying repository's settings that the GitHub environment a staging `cloudflare-deploy` policy
   binds carries the same protection rules as production's (required reviewers, deployment branch
   `main`, no self-review): a staging token reaches production Workers.
   **Answers, 2026-11-26 (staging minting token `sts-minting-staging`, by API at 23:07Z, since
   deleted): Q65 was reopened, and Igor accepted the residual risk the same day (above).** A token
   with `DNS Read` on `kiloapps.io`, a group outside the minting token's policy, was created (200):
   its policy is not a ceiling. A Super Administrator's canary token was read, rolled (a new value
   returned) and deleted (200 each): the minting token reaches every account token, including the
   value of each by rolling it. So whoever reads `/ci/minting`, or replaces the STS Worker (which a
   minted deploy token can, see above), controls every account token, not one hour of deploy
   rights. A token scoped to one Worker (`Individual Workers Editor`, resource
   `com.cloudflare.edge.worker.script.<account>.<script>`) was refused (400, code 1001) through the
   API; the dashboard attempt is pending the staging proof. The minting token lists the tokens it
   did not create too (all 24 account tokens), and created, listed and deleted its own child (200
   each). The script list (200) and the zone's route list (200) work. Its calls carry `Ratelimit:
   "default";r=1199;t=1` and `Ratelimit-Policy: "default";q=1200;w=300`; whether a deploy's calls
   lower it is pending the staging proof. Also pending the staging proof: a minted token's own
   token creation answering 403, an unrevoked minted token gone about an hour later, the sweep's
   `include_expired=true` list, and the monitor live test (step 7: the first scheduled watch run
   reports no unexpected deployment; a deployment of `sts-staging` made with a minted staging token
   outside any deploy job is posted; the health workflow's first run is green). GitHub
   environments: no staging `cloudflare-deploy` policy remains (the throwaway proof policies are
   removed); `ci-deploy-bouncer` binds production only.
7. **Monitor of the STS Worker, outside STS.** The window check runs inside STS, so it cannot
   report a change to the STS Worker of its own environment.
   `.github/workflows/sts-deployment-watch.yml` runs every 15 minutes on `main`
   (`scripts/sts-deployment-watch.mjs watch`): it lists the Cloudflare deployments of `sts` and
   `sts-staging` (`GET /accounts/<account>/workers/scripts/<script>/deployments`) and the jobs named
   `Deploy services/sts` of `deploy-production.yml` (production), `deploy-staging.yml` (staging) and
   `deploy-workers.yml` (either), and posts to Slack (`DEPLOY_NOTIFY_SLACK_WEBHOOK_URL`) each
   deployment made since the previous successful scheduled run on `main` started (less 5 minutes)
   that is not a `wrangler deploy` (source `wrangler`, `workers/triggered_by` `deployment`, as every
   CI deploy of STS records) inside a span of a deploy job run on `main` of this repository, from a
   push, schedule, dispatch or workflow event, for its environment (from 1 minute before the job
   started to 2 minutes after it ended). A rollback, a secret change or a dashboard edit is
   reported even inside a job. A `wrangler deploy` with any other credential inside a span of a
   deploy job run on `main` is hidden: Cloudflare records no author for an API token, so nothing
   tells it apart. A run on another branch or from a fork makes no span. Outside a span it is
   reported. A window clamped to 7 days (no successful run for a week) is posted too. It reads
   Cloudflare with `STS_WATCH_CLOUDFLARE_TOKEN`, a repository secret holding an account token
   (`sts-deployment-watch`, only `Workers Scripts Read`, expires 2027-11-27), and GitHub with the
   job's own token (`actions: read`). A run that cannot check fails, posts that it failed (plain
   text), and the next run covers its window. A flood of watch-failure alerts means the watch
   cannot read Cloudflare or GitHub: fix `STS_WATCH_CLOUDFLARE_TOKEN` (a rolled, deleted or expired
   token) before anything else, since STS deployments go unchecked meanwhile.
   `.github/workflows/sts-deployment-watch-health.yml` runs twice an hour with only the GitHub
   token and posts when the watch has had no successful scheduled run on `main` for 45 minutes, so
   a revoked or rolled Cloudflare token, a stopped schedule or a broken workflow cannot silence the
   watch. Budget: per watch run 2 Cloudflare calls, 4 Actions list calls and 1 jobs call per deploy
   run updated inside the window (about 1 to 3), so about 700 GitHub API calls and 200 Cloudflare
   calls a day; the health job adds 2 GitHub calls per run, 96 a day. Together they use about 4,300
   GitHub Actions minutes a month (96 and 48 one-minute runs a day).

**Rotation (every 90 days, or at once on a leak).** A Super Administrator creates the new minting
token as in step 2, puts it into `/ci/minting`, and waits 5 minutes (STS reads it within 4). Then
they wait 1 hour and 5 minutes more, so every token the old credential minted has expired and its
deletion or sweep has run, and look in **Account API tokens** (a Super Administrator sees every
account token) for any `sts-<env>-` token still there. The staging check found that a minting
token lists every account token, not only those it created, so its successor very likely deletes
its predecessor's tokens; if a delete is refused anyway (a 403 fails that deletion alone, which STS
retries up to hourly), delete each by hand (STS's next retry then finds it gone), then delete the
old minting token. On a leak of the minting token, delete it at once instead and clear its
`sts-<env>-` children by hand the same way; on a leak of a minted token, delete it in the
dashboard; it expires within the hour anyway.

**Cost.** Per deploy (one token for both of bouncer's deploy steps, revoked by the job): 2 STS
requests, 2 `DeployTokenDO` calls, 2 Cloudflare API calls (create and delete; a token the job does
not revoke costs the same delete at expiry), 2 audit rows, at most 2 Infisical reads of
`/ci/minting` plus 1 login and 1 `SignerDO` call (deploys are sparse, so assume the cached
credential and access token have lapsed), and the alarms that relay the rows. The window check
adds, per deploy: 1 script list call and 1 route list call per zone of the grant (1 for bouncer),
usually with the credential the revoke read 2 minutes before (at most 1 more read, login and
`SignerDO` call for a token that expired unrevoked), at most 20 rows of each kind, a scan of the
day's rows against the account's scripts (500 at most on a paid plan) and the zone's routes, and
a rewrite of each listed zone's stored route list (1 row delete per stored route and 1 row write
per listed route, plus 1 for the zone: about 2 writes per route of bouncer's zone per deploy).
At 43 releases a day: 86 STS requests, 86 `DeployTokenDO` calls, 172 Cloudflare calls, 86 audit
rows, at most 86 Infisical reads and 43 logins (against Infisical's 600 requests a minute). The
daily sweep adds, once a day: 1 login, 1 `SignerDO` call and 1 Infisical read (the cached
credential has always lapsed by then) and 1 token list call while STS keeps the account clean (at
most 10 at the 500-token cap). A token the sweep can never delete (a 403 that never clears, such
as a predecessor's token after a rotation, or a lasting 5xx) costs, until someone deletes it by
hand: 1 `delete_failed` row in all, 1 stored row, 1 delete call 30 seconds after the failure and
then at doubling waits (12 calls in its first 34 hours), then 1 a day, sharing the alarm's 5
deletes per 30 seconds; it holds one of the environment's 100 places and one of the account's
500 for as long, and the sweep goes on past it. A failed creation adds 1
`deploy_token.mint_failed` row; a failed window check repeats its list calls on each retry, at most
3 times per window, and then writes 1 `deploy_token.script_check_failed` row. Cloudflare's
published limit is 1,200 requests per 5 minutes per user, counted together across the dashboard,
API keys and API tokens; its table lists
the same 1,200 per 5 minutes for "Client API per user/account token"
(https://developers.cloudflare.com/fundamentals/api/reference/limits/). The page does not say
which budget an account-owned token's calls count against (the token's own, or the creator's);
until staging check 6 answers it, assume the worst case: STS's minting calls and every minted
token's own `wrangler deploy` calls draw from one budget (no person uses these tokens, so no
dashboard traffic shares it). STS's own share: 43 deploys inside one 5-minute window make 172
calls (14 %; the window checks come 2 minutes after each revoke, so they may fall into the next
window); deletion retries add at most 5 deletes and 2 list calls per 30 seconds (70 per 5
minutes), and every call stops for a 429's `Retry-After`, so
STS stays under 21 % of the budget even in a burst during a Cloudflare outage. The rest is the
deploys' own calls, which are the same calls the stored deploy token makes today. When Cloudflare
refuses the minting credential (a 401, or a 403 on a list), the credential hold stops the alarm
after its first refused call: a revoked minting token costs 1 login, 1 `SignerDO` call, 1
Infisical read and 1 Cloudflare call per hold, at 1, 2, 4, ... minutes up to 1 hour (6 in the
first hour, then 1 an
hour) until someone replaces it. STS holds at most `maxActive` unexpired tokens per policy (3 at
most), so the 500-token cap is out of reach while the reaper runs. Volume does not grow with
clients or Vercel instances: only GitHub deploy jobs with this grant mint.

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
`/dynamic/replica-read` there ([Database leases](#database-leases));
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
active and per-minute limits, owner-only revocation, undelivered leases, pruning, lease denials;
the replica sweep with a fake sweep function: one attempt per replica per minute through its own
binding, the audit rows (ended sessions, the first and 15th failure, the recovery), warnings until
the one error, a listed name without a binding, no sweep and no alarm without replicas, and the
cron's `ensureSweeping` call only while replicas are configured, and the sweep running first, due
one interval after the alarm fired, while an owed revocation hangs and then throws, with the next
alarm still scheduled;
Cloudflare deploy tokens over HTTP against a fake Cloudflare API and a fake `/ci/minting`: the
request Cloudflare gets, the limits, owner- and run-bound revocation, failed and retried
deletions, the reaper and the sweep, the window check of scripts and routes with its timing,
bounds, retries and give-up, interrupted creations, the credential hold after a refused
credential, the returned-token checks, the pinned forbidden and allowed groups and zones and the
refusal while they are empty, the account limit, the policy rules (`main` only while the account
is shared), the `/ci/minting` filter, and
no token value or credential in storage, logs or audit rows; and the RPC surface of every
Durable Object and the `SecretsBroker` entrypoint: each class's prototype chain up to the runtime
base class holds exactly its RPC methods, and a stub call to an internal method, such as one that
once returned a key, is refused)
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

**Local end-to-end check of service tokens.** The shipped scope registry lists no scope a probe may hold, so a
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

**Local end-to-end check of a CI bundle.** The same test build also carries a GitHub policy,
`ci-e2e-release`, and sends its requests for GitHub's issuer and for the
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
(maximum 9000 seconds, 2 active). `lease-check.ts` serves
a fake Infisical lease API on port 8830, so it and `ci-bundle-check.ts`
run one at a time:

```sh
cd services/sts
../../node_modules/.bin/tsx test/fixtures/e2e/lease-check.ts
# in another shell
npx wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
```

It checks that the probe gets a 60-minute `replica-read` lease over its binding (and the request
Infisical received), that an 8-hour request is clamped to 9000 seconds, that a third concurrent
lease is refused `too_many_active` with no Infisical call, that `POST /v1/lease` and
`/v1/lease/revoke` answer 404, that a lease id STS never issued cannot be revoked while the probe
revokes its own, and that the `lease.created`, `lease.revoked` and `lease.denied` rows reach the
queue with no username or password.

**Local end-to-end check of Cloudflare deploy tokens.** The test build also carries two deploy
policies, `ci-e2e-deploy` (1-hour tokens, account and zone groups) and `ci-e2e-deploy-short`
(5-minute tokens, another repository). `deploy-token-check.ts` serves the fake GitHub issuer, a
fake Infisical with a synthetic `/ci/minting` credential and a fake Cloudflare account token API
that records every request, on port 8830, so it runs alone like the other two:

```sh
cd services/sts
../../node_modules/.bin/tsx test/fixtures/e2e/deploy-token-check.ts
# in another shell
npx wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
```

It checks that a production-shaped deploy job gets a token with exactly the configured permission
groups on the account and the zone, created with the minting credential, with `expires_on` 1 hour
after `not_before`; that a job of another workflow file, a `pull_request` job and a job of another
GitHub environment get 401 with no Cloudflare call; that a creation whose answer is lost (the fake
makes the token, then answers 502) answers `unavailable` and writes `deploy_token.mint_failed`;
that another workload and another run cannot revoke the token while the owner job can; that the
reaper deletes the 5-minute token once it expired (about 6 minutes); that the sweep brought
forward by the lost answer deletes the lost token once it expired (about 8 minutes); that the
window check runs about 2 minutes after the revoke and again after the 5-minute token expired,
listing the Worker scripts and the deploy job's zone routes with the minting credential; that
`deploy_token.unexpected_script` names, once over both checks, the one Worker changed while both
tokens were live that neither token's `intendedScripts` names, with both token ids; that
`deploy_token.unexpected_route` names the one route of the zone repointed at that Worker, with
the token of that zone; and that the `deploy_token.minted`, `.mint_failed`, `.revoked`,
`.reaped`, `.unexpected_script`, `.unexpected_route` and `.denied` rows reach the queue with no
token value and no minting credential.

**Fail-before proof of the deploy-token rules.** Each security rule has a test that fails when the
rule is removed: owner- and run-bound revoke, the denial reason in the audit row, the audited and
retried failed revoke, no credential in logs or audit rows, the `/ci/minting` filter and name
check, the checks of the token Cloudflare returns (unreadable or missing group names, a name other
than the declared one, another effect, account or zone, a group moved between policies, a later
expiry, an answer that names the token but cannot be read), the pinned forbidden and allowed
groups and zones at load and before a mint, the refusal while the pins are empty, the policy
rules (the `main`-only rule of the shared account included), the limits, the account limit and
the `rate_limited` retry time, the revoke that waits for the retry time, the reaper, the sweep's
prefix, expiry and no-expiry rules and its expired-token list, the end of an interrupted creation,
the `mint_failed` rows, the window check (its timing, the once-per-change rule, the route list
against the previous list and `intendedRoutes`, the bounds, the dropped-script count, the retries
and give-up), the credential hold (no call or read during it, the sweep held with it, the
doubling, a 403 that fails one request alone), and the
identity denial row. The mutation script that removes each rule in turn and runs its test is kept
with the PR's proof, not in the repository.

**Local check of the lease SQL.** `sql/leases/check.sh` starts a throwaway PostgreSQL in Docker
(`PG_IMAGE`, default `postgres:16`; `PG_PORT`, default 55432) shaped like Supabase (`postgres` a
non-superuser owner of the database and `public`, member of `pg_signal_backend`; a stand-in for
`pg_net`'s PUBLIC grants; `dblink` in `extensions`), and a second container that is a streaming
hot standby of it (`PG_REPLICA_PORT`, default `PG_PORT` + 1). It runs `setup.sql` and
`setup-replica-sweeper.sql` as `postgres`, and each
statement file the way Infisical does. It
proves that the setup report lists what PUBLIC reaches and that `setup.sql` removed PUBLIC's
`EXECUTE` on definer functions in `public`; that under `log_statement = 'ddl'` neither admin
password (both setup files) reaches the server log; that with the server at `log_statement =
'all'` and `log_min_duration_statement = 0` no lease password does, nor that of a failed creation,
whose error carries none; that `postgres` can reset the replica admin's password; that a malformed
username is refused; that a `replica-read` role reads and cannot write, create or run a definer
function even with read-only mode turned off; that the admin login cannot end an application
session; that renewal moves `VALID UNTIL`; that an expired role
cannot log in while its open session lives on until a revocation of any lease ends it; that
revocation ends open sessions, drops what the role owned (a large object, a temporary table) and
the role, and is idempotent; that a client reconnecting through a revocation keeps no session and
leaves none of a dropped role, and that a one-transaction
revocation statement is refused; that a role revocation cannot drop (an object in `template1`, a
right `postgres` granted) stays without login and is listed; that `DROP ROLE` alone
would leave a session open and unnamed, which the next revocation ends for a lease role; and that
no revocation ends the session of a dropped role that was never a lease. On the replica it proves
that the revocation on the primary leaves the lease's idle replica session open (Q63), and that
`kilo_lease.sweep_sessions()` as `kilo_lease_sweeper` ends it, and the replica sessions of an
expired lease whose revocation did not run, of a lease blocked by a half-done revocation, and of a
lease dropped before a later revocation of its template
(whose row now stays 7 days, then goes); that no sweep ends the replica sessions of `app_pool`,
`postgres`, the superuser, a live lease, the sweeper or a dropped role that was
never a lease; and that the sweeper login cannot end a session directly, call `end_sessions` or
read a table, and its sweep on the primary ends nothing live.

**Local end-to-end check of the replica sweep.** `test/fixtures/e2e/replica-sweep-check.ts` runs
on its own (Docker, psql, and ports 8827 and 8830 free; `PG_IMAGE`, default `postgres:16`):

```sh
cd services/sts
PG_IMAGE=postgres:17 ../../node_modules/.bin/tsx test/fixtures/e2e/replica-sweep-check.ts
```

It starts a primary and a streaming replica in Docker shaped like Supabase, runs the three setup
files, serves a fake Infisical whose lease API runs the real statement files on the primary as the
replica admin and runs its own expiry revocation without STS, and starts the test build of STS and
the probe sweeping the replica through the `LEASE_SWEEP_REPLICA_E2E` Hyperdrive binding (a
temporary copy of `wrangler.sts.jsonc` names it and the sweeper's local connection string). It
checks that a replica session of a lease revoked through STS stays open right after the
revocation and ends within 80 seconds; that the replica sessions of a lease Infisical revoked at
its expiry and of one whose expiry revocation failed end within 80 seconds of the expiry, with no
STS revoke; that live leases keep their sessions through several sweeps; that the sessions of
`app_pool`, `postgres` and a dropped role that was never a lease survive every sweep; that a
paused replica gives a `failed` row and its return an `ended` row with `afterFailures`; and that
no sweep row or log line carries a lease username, a password or a host.

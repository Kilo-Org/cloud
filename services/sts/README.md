# STS — the secrets broker and service-token service

STS serves each workload one bundle of runtime secrets read from Infisical Cloud EU, and it mints
short-lived service tokens (Ed25519 JWTs, one audience and one scope each) for the audiences a
workload's policy grants. It records every delivery, mint and key change in audit logs that a queue
relays to the audit pipeline. Database leases, CI deploy tokens and the audit queue consumer are not
part of this Worker.

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

Routes: `POST /v1/bundle`, `POST /v1/token` (service tokens), `GET /.well-known/jwks.json` (the
service-token key set), `GET /manager-auth/.well-known/jwks.json` (the manager login key set),
`POST /manager-webhook` (Infisical `secrets.modified`). Production is `https://sts.kiloapps.io`,
staging is `https://sts-staging.kiloapps.io`.

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

`BundleDO`, `RefresherDO`, `SignerDO`, `DenialDO` and `TokenSignerDO` are internal. Their methods
skip the policy check and the audit row that `SecretsBroker` performs (the token signer signs what
STS's policy check allowed), so no other Worker may reach them: a
`durable_objects.bindings[].script_name`, workflow `script_name`, migration `from_script` or export
`transfer_from` naming `sts`, `sts-staging` or `sts-local`, an `unsafe` binding, or an STS service
binding at any entrypoint other than `SecretsBroker` fails `test/repo/worker-configs.test.ts`. A
config outside `services/sts/` that binds a class named `BundleDO`, `RefresherDO`, `DenialDO` or
`TokenSignerDO` fails too (`SignerDO` is also the audit relay's own class name).

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
| `TOKEN_SIGNING_KIDS_REVOKED` | Comma list of service-token signing kids taken out of service; empty by default (runbook above). |

Wrangler inherits no vars into an env block, so every block sets each var, and
`test/repo/worker-configs.test.ts` checks that each STS block passes the same schema `readConfig`
uses and that its `STS_ISSUER` equals `STS_ISSUERS` in `@kilocode/sts-contracts`.

Bindings: `AUDIT_QUEUE` (queue producer), `STS_BUNDLE_DO`, `STS_REFRESHER_DO`, `STS_SIGNER_DO`,
`STS_DENIAL_DO`, `STS_TOKEN_SIGNER_DO` (migration `v3`). Trigger: cron `*/5 * * * *` in production
and staging, `[]` in the local block.

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
workload itself. `dynamic` (database leases, CI deploy tokens) fixes the shape for later; its list
of allowed values is empty, so any entry fails the load.

```yaml
audiences: [web]
scopes: ['web:sts.canary']
```

The `ai.kilo.sts.policy.changed` event lists added and removed `workload:audience` and
`workload:scope` grants next to the workload and secret changes.

Adding a file also means adding it to `src/policy/registry.ts`; the typed import map in
`src/policy/index.ts` makes the two disagree at typecheck, and `test/repo/policy-files.test.ts`
checks the directory itself.

Workloads with a policy, all over `worker-binding`:

| Workload | Environments | Worker config |
|---|---|---|
| `o11y` | development, staging, production | `services/o11y/wrangler.jsonc` |
| `audit-relay` | development, staging, production | `services/audit-relay/wrangler.jsonc` |
| `bouncer-watch` | production | `watch/wrangler.jsonc` in `Kilo-Org/bouncer`; its STS binding arrives with bouncer's step 2 |
| `notifications` | production | `services/notifications/wrangler.jsonc`; reads stay on the Secrets Store until `SECRETS_SOURCE` is `sts` |

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
timeline with an injected clock, the token signer, mint over both entry points and token denials)
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

**Local end-to-end check of a CI bundle.** The same test build also carries one GitHub policy,
`ci-e2e-release`, and sends its requests for GitHub's issuer and for the manager to a local fake on
port 8830 that `ci-bundle-check.ts` serves (a fresh RS256 key with its discovery document and key
set, and an Infisical stand-in with synthetic values):

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
that no audit row carries a value.

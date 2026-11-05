# Native session synchronization

## Scope

This service synchronizes native v2 sessions from a Kilo CLI workspace.
The CLI remains the execution owner and continues when the service is unavailable.
The existing session-ingest service remains unchanged during migration.

The first delivery includes authenticated incremental ingestion, durable acknowledgements,
private assets, current-state reads, and producer restart recovery.
It does not include mobile subscriptions, remote commands, ownership transfer, or legacy import.
Those capabilities belong to the agreed design below, not to inactive API implementations.

The producer contract and local capture design live in the CLI repository at
[`specs/v2/session-sync.md`](https://github.com/Kilo-Org/kilocode/blob/v2/specs/v2/session-sync.md).
This document owns service semantics, admission, storage, and rollout gates.

## Decisions

- Local execution never waits for a cloud round trip.
- Workspace synchronization uses the CLI's configured destination.
- The service can decrypt stored content and enforces personal or organization access.
- Native v2 supplies the live protocol; old sessions use a separate historical conversion path.
- Retain current transcript and portable state until deletion or idle expiry, subject to explicit quotas.
- Keep a bounded replay tail rather than permanent per-token revision history.
- Fine-grained durable updates serve watched sessions; background synchronization uses coarser checkpoints.
- Default continuation on an unreachable owner's session creates a fork.
- Preserving identity requires a confirmed handoff at a verified recoverable checkpoint.
- Remote permission replies apply to the current request only.
- Local removal and delete-everywhere are distinct actions.
- No residency restriction applies at launch.

## Authority and identity

Route each session by its authenticated tenant and stable session ID.
Never trust a user or organization ID supplied in session JSON as authorization.

The first producer binds the session to its authenticated creator and source ID.
Another source cannot overwrite that binding implicitly.
A source ID survives normal producer restarts but does not authorize a takeover.

The complete design separates ownership epochs from replica generations.
Ownership epochs fence obsolete producers.
Replica generations invalidate cursors after a reset or operational restore.
Native transcript sequence numbers are not replication revisions.

## Initial HTTP contract

All JSON requests use protocol version `1`.
Errors have an explicit machine-readable code and an appropriate HTTP status.
An unavailable authentication dependency produces a retryable service error, not an invalid-credential response.

| Retryable error | HTTP | Client action |
|---|---|---|
| `service_overloaded` | 503 | Honor `Retry-After: 3` and epoch-ms `error.retryAt`, then add jitter before retrying. |
| `tenant_unavailable` | 503 | Honor the tenant retry deadline; admission remains fail-closed. |
| `rate_limited` | 429 | Honor the rate-limit retry deadline before another request. |

The Worker classifies the platform's `overloaded` flag and documented object-queue
or account-stub-lookup overload messages at the RPC boundary. Overloaded calls
are not retried immediately, including when another retryability flag is present.
The CLI retains the typed error and uses its existing jittered backoff.

| Operation | Route | Meaning |
|---|---|---|
| Exchange credential | `POST /v1/auth/exchange` | Verify the Kilo credential and issue a short-lived tenant-scoped sync grant. |
| Inspect session | `GET /v1/sessions/:id` | Read producer binding, committed source position, revision, and deletion state. |
| Register session | `PUT /v1/sessions/:id` | Bind a session to its source without replacing an existing owner. |
| Apply batch | `POST /v1/sessions/:id/batches` | Atomically apply an incremental batch and return its durable receipt. |
| Read entities | `GET /v1/sessions/:id/entities` | Read bounded pages of the current portable entities. |
| Upload blob | `PUT /v1/sessions/:id/blobs/:hash` | Verify and durably store private content-addressed bytes. |
| Read blob | `GET /v1/sessions/:id/blobs/:hash` | Read bytes after tenant and session authorization. |
| Remove cloud session | `DELETE /v1/sessions/:id` | Tombstone the cloud copy and prevent its automatic recreation. |

A cloud tombstone is the service part of delete-everywhere.
Device propagation belongs to the remote-control delivery, not the initial ingestion client.
No deletion endpoint removes workspace files or credentials.

Credential exchange accepts a personal target or an organization target.
The service verifies current account status and credential revocation before issuing a grant.
Organization exchange also verifies current membership using the shared access rules.
A grant lasts at most five minutes, never beyond the original credential, and has the dedicated `session-sync` audience.
This bounds how long a revoked or blocked account keeps sync access, and keeps exchange load on the account database low.
Do not repeat the account-database lookup for every upload packet.
`ENVIRONMENT` is required and must match the credential's `env` claim. Missing or
empty configuration returns `auth_unavailable` (503) and logs a configuration error;
a credential from another environment is rejected before account SQL.

Registration supplies `{version, sourceID}`.
The creator identity comes from the grant, not the registration body.

A batch supplies `{version, sourceID, batchID, after, through, changes}`.
`after` is the last acknowledged source position.
`through` covers the complete captured change range in this batch.
Source positions can be sparse after local coalescing.
The service checks that `after` matches the committed source position.

Each change has a kind and an entity ID.
The portable kinds are `session`, `message`, `message-part`, `inbox`, `instruction-entry`,
`instruction-state`, `instruction-blob`, and `asset`.
An upsert carries an inline JSON value or a verified blob reference.
A removal carries its semantic cause; maintenance is not a deletion intent.
Inbox delivery uses the `consumed` removal cause, not cancellation.
Native part replacement/removal uses `part-removed` for `message-part` and its `asset`
entities only; a transcript revert retains the `revert` cause.

Assistant messages use an envelope, not an ever-growing content array:
`message` value `{seq, message, parts: {count, through}}`, with the native assistant's
`content` omitted from `message`. Each `message-part` has ID `<messageID>/<ordinal>`
and value `{messageID, ordinal, position, part}`, or `{messageID, ordinal, position,
deferred: true}` while its native body is incomplete. Ordinals are unique nonnegative
integers (gaps are allowed), ordered **numerically**, not by the page's lexical ID ordering.
`through` is the envelope's captured source position; each part's `position` is
captured before the envelope. There is no O(parts) manifest on the envelope.
A reader assembles only a revision-consistent snapshot whose page `position` is
at least `parts.through`, with exactly `count` parts with unique ordinals, no
deferred parts, and no part newer than that frontier. Otherwise it is incomplete,
not a truncated complete message. Large immutable single parts remain private blobs.
These are producer/reader semantics; the service stores opaque bounded JSON.

This is a clean pre-release protocol cutover: the default-on native client has
not been released and both production DO namespaces were verified empty before
this change. No legacy envelope migration or dual-writing compatibility path is needed.

Batch IDs identify immutable payloads.
Retrying an acknowledged batch returns its receipt without applying it again.
Reusing an ID with different content fails.
An obsolete source, conflicting predecessor, or deleted session fails explicitly.
A successful receipt means storage has committed, not that a background task has started.
The receipt includes the SHA-256 digest of the exact UTF-8 request body.
Retry the stored bytes rather than serializing the packet again.
Session inspection exposes `lastReceipt` so a producer can recover a lost acknowledgement or detect a conflicting restored database.

Page reads report both the revision and committed source position they observe.
A reader can require that revision on subsequent pages.
If it changes, return a conflict rather than claiming a consistent snapshot.
Pinned snapshots and resumable live subscriptions extend this contract when clients need them.

## Storage

The baseline uses one SQLite-backed Durable Object per tenant and session.
Use the repository's Drizzle durable-sqlite schema and migration conventions.
Keep current entities and producer receipts in SQLite.
Keep large bodies and assets in private R2 objects scoped to the session.

Normalize or version stored data at the boundary.
Do not persist an entire growing assistant message after every token.
Do not allocate one SQL row for each provider token.
Bound request bytes, changes per batch, inline entity size, and pagination size.
Reject oversized data explicitly; do not skip it and acknowledge success.

A storage transaction applies the batch, records the receipt, and advances the source position.
No external I/O belongs inside that transaction.
A response must not bypass storage output gates.

Upload and verify blobs before admitting references to them.
A batch that requires a missing blob fails without advancing its source position.
Keep receipt metadata bounded without making an old retry eligible to apply again.

Each admitted blob upload has a unique attempt and physical R2 key.
A second same-hash upload receives retryable `upload_in_progress`, including `retryAt`.
Abort, commit, and cleanup operations can affect only their own attempt.
Cleanup claims a bounded page before external I/O and retains unfinished deadlines through deletion.
Failed uploads retain their reservation until cleanup finishes.

The Worker declares its database and worker-utility workspace dependencies directly.
It does not depend on the application-shared package.

The initial storage policy is explicit:

| Resource | Bound |
|---|---|
| Batch body | 512 KiB |
| Changes per batch | 64 |
| Inline entity body | 64 KiB |
| JSON nodes per inline value (keys plus values/containers) | 8,192 |
| JSON container depth per inline value | 64 |
| JSON nodes in the entire batch, including metadata | 32,768 |
| JSON container depth in the entire batch | 67 |
| Active and queued batch text per session object (conservative UTF-16 bytes) | 4 MiB |
| Active and queued batch calls per session object | 8 |
| Entities per page | 100 (default 50) |
| Inline value bytes per page | 2 MiB |
| Blob body | 8 MiB |
| Stored and reserved blob bytes per session | 256 MiB |
| Blob entries per session | 10,000 |
| Inline entity bytes per session | 64 MiB |
| Current entities per session | 100,000 |
| Retained batch receipts | 256 |
| Session idle retention | 90 days since the last accepted batch or blob commit |

Verified uploads without a current entity reference enter `unreferenced` for 15 minutes.
Replacing or removing the last reference sets its cleanup deadline to the batch commit time.
It becomes reclaimable after the one-minute sweep margin, rather than retaining every superseded version.
References before cleanup return the blob to `ready`; duplicate uploads refresh the deadline by 15 minutes.
Reads accept both verified states. Alarms reclaim expired unreferenced blobs like expired uploads:
claim first, delete the private R2 object, then release its reserved bytes.
The cleanup clock-skew margin is one minute. A missing reclaimed hash returns `blob_missing`
with `error.details.hash`, so producers discard their acknowledgement hint and upload again.
Readers that receive `blob_not_found` for a superseded hash re-read current session state.
An old receipt leaving the bounded tail never makes its packet eligible to apply again.

Entity pages seek on the composite `(kind, id)` key. They select identities and sizes first,
then load only values within the 2 MiB inline-byte budget, plus a bounded identity lookahead.
The DO returns a byte-oriented RPC stream that copies stored canonical JSON text
directly into the HTTP response; it does not parse, revalidate, or stringify inline
values on reads. Snapshot rows are loaded inside the transaction, so a later write
cannot change a response already being streamed.

A lexical pass caps whole-batch nodes and nesting **before** `JSON.parse`, including
unknown fields and duplicate keys. Escaped strings do not count as containers.
Each object key and every value (including containers and primitives) costs one
node; keys do not add depth. A root container has depth one, so 64 nested arrays
around a primitive are admissible. The batch envelope adds three container levels.
After parsing, the service separately enforces the inline-value node/depth budget.
Budget failures are explicit `json_budget_exceeded` (413); invalid syntax remains
`invalid_request` (400). Producers externalize values exceeding inline complexity
and split batches exceeding total complexity, even when their byte size is small.

Parsing occurs only inside the serialized write transaction; a queued write does
not retain a parsed tree while tenant admission awaits I/O. Before its first await,
a batch reserves `body.length * 2` bytes and one call slot, including active work.
The 4 MiB / eight-call admission cap returns retryable `rate_limited` with `retryAt`
when full, and releases reservations in `finally` on success, typed rejection, or
an exception. These are deterministic request/write-queue bounds, not a claim
that arbitrary concurrent reads, runtime internals, or an entire production
isolate have a measured absolute memory ceiling.

### Boundary measurement

From this directory, `node scripts/measure-bounds.mjs` runs the focused
`test/integration/large-entity.test.ts` in the real Workers test pool, using only
the local bindings in `wrangler.test.jsonc`. It never deploys or reads production.
The harness uses the workerd inspector's 100 μs CPU profiler and polls
`Runtime.getHeapUsage` every 5 ms, with a garbage-collected baseline before each
scenario. CPU includes pool test/RPC overhead and excludes idle samples.
Used heap and V8 reserved heap are reported separately, plus incremental used
heap above that scenario's baseline. Polling is an observed high-water mark,
**not an exact instantaneous peak**, process RSS, or Cloudflare billing CPU.
The pool's test-loader/import heap is not representative of a standalone DO.

Fixtures cover an exact 512 KiB batch with exact 64 KiB inline strings, 64 changes,
64-deep values, exactly 32,768 total batch nodes with an 8,192-node value, an exact
2 MiB page, 100-item pages, typed over-budget rejection before parsing, and both
queue-admission limits. The harness asserts incremental sampled used heap below
32 MiB; the practical sampled-CPU review target is 100 ms, not a flaky timing test.

Measured 2026-11-05 on the disposable Linux work VM (workerd via Workers pool
0.16.13, Vitest 4.1.12): **7 tests passed**, 17 profiled scenarios, 7.23 s total.
Heap columns are MiB; CPU is sampled active milliseconds.

| Boundary | CPU ms | Peak used heap | Peak V8 reserved heap | Incremental used heap |
|---|---:|---:|---:|---:|
| 512 KiB batch / 64 KiB inline values | 44.119 | 58.34 | 64.25 | 2.97 |
| 64 changes | 34.840 | 55.07 | 59.49 | 0.17 |
| 64 inline container levels | 10.854 | 55.40 | 57.99 | 0.45 |
| 32,768 batch nodes / 8,192 value nodes | 23.310 | 56.12 | 60.24 | 0.99 |
| Exact 2 MiB page | 42.346 | 63.04 | 69.24 | 7.91 |
| 100-item page | 30.692 | 56.44 | 58.99 | 1.49 |
| Full 4 MiB write queue: reject next call | 6.682 | 55.56 | 57.99 | 0.08 |
| Full eight-call queue: reject next call | 6.256 | 55.05 | 57.49 | 0.06 |

Over-budget JSON and 10,000-level pre-parse depth attacks took at most 9.136 ms
sampled CPU and 0.47 MiB incremental used heap. The largest incremental heap
was the 2 MiB page (42.346 ms / 7.91 MiB incremental used heap); this includes the
test client's response buffering, JSON parsing, and schema validation, not just
the DO's streaming path. All samples stayed below the practical review targets.
These observations support the deterministic bounds; they do not prove an
absolute production CPU/memory ceiling or count unsampled allocation spikes.


### Tenant admission

One tenant Durable Object admits session IDs idempotently and accounts for byte leases.
Its schema lives in `src/db/tenant-sqlite-schema.ts`. Generate changes with
`pnpm drizzle-kit generate --config drizzle.tenant.config.ts`; commit the
`drizzle-tenant` SQL, migration barrel, journal, and snapshot together.
The constructor runs tracked migrations inside `blockConcurrencyWhile`, then seeds
the usage row idempotently. Tracked migrations preserve existing lease and usage rows.
The creator index adds no global coordinator or new Durable Object class.
Default personal limits are 10,000 sessions and 100 GiB; organization limits are
200,000 sessions and 2 TiB. Wrangler vars `USER_TENANT_SESSIONS`, `USER_TENANT_BYTES`,
`ORGANIZATION_TENANT_SESSIONS`, and `ORGANIZATION_TENANT_BYTES` override these defaults.
Leases include inline values and all reserved or stored blobs. A session grows its lease in
32 MiB steps, capped at its combined inline/blob bound, only when its usage needs more space.
An alarm shrinks a lease when usage drops at least two steps below it. Deletion releases
the session admission and its whole lease. Tenant calls never run inside SQLite transactions.
Admission mutations are serialized without blocking session reads during tenant RPCs.
Tenant outages return retryable `tenant_unavailable` (503), `Retry-After: 60`, and
an epoch-ms `error.retryAt`; alarm-driven releases and shrinks retry without resetting the session.
Before a shrink can release tenant capacity, the session durably lowers its local lease.
A persisted reconciliation intent retries an uncertain shrink after an outage or object eviction;
new writes cannot consume capacity that the tenant may already have released.
Growth reservations also persist reconciliation intent before the tenant call; an unconfirmed
reservation never increases the local lease and is reconciled against committed usage on alarm.
First-registration intent records its tenant and session before admission. An alarm releases
an abandoned admission only while the session row is still absent, under the same mutation gate
as registration retries; an already-created session adopts that admission instead.
Lowered quotas do not reject an existing admission or a lease that stays equal or shrinks.
Admission denial returns nonretryable `tenant_budget_exceeded` (413) with
`error.details.sessions` and `error.details.bytes` containing the configured limits.

### Account erasure and idle retention

`POST /internal/users/:userID/erase` takes no body and authenticates
`X-Internal-Secret` against the `INTERNAL_API_SECRET_PROD` Secrets Store binding,
using the same convention as session-ingest. It returns `202` only after durably
recording a permanent user admission fence and the cleanup work. Repeated requests
are safe. User-facing sync grants cannot invoke this route.
Non-production web stacks must explicitly configure `SESSION_SYNC_WORKER_URL` to
their isolated service; account erasure has no production default outside production.

Each user's personal tenant object indexes the tenant and session IDs of sessions
they create, including organization sessions. Registration records the index before
tenant admission, so a lost response cannot hide an admitted session from erasure.
Account erasure pages that index from an alarm and uses the existing tombstone,
R2 cleanup, and tenant quota release paths. Organization sessions created by other
members are never erased. Failed cleanup reschedules itself; unfinished uploads
retain their original fencing deadline before their private objects are purged.

The durable web account-deletion task submits erasure before ingest teardown and
anonymization. Its acceptance checkpoint prevents unnecessary requests during later
ingest retries, while an unacknowledged request is retried at least once. Each user
alarm handles only a bounded page and checkpoints individual successful sessions.

An idle session expires 90 days after its latest successful batch or blob commit;
registration anchors an empty session. Reads, repeated registration, and beginning
or aborting an upload do not refresh that deadline. Retention shares the session's
single alarm scheduler with blob sweeping and lease reconciliation, and uses the
same permanent tombstone and quota-release path as explicit deletion. The service
had no stored sessions before this retention-enabled cutover, so every session is
created with its own retention alarm.


### Request admission

Wrangler rate-limit bindings are tunable per deployment and apply per Cloudflare location:

| Binding | Key | Default per 60 seconds |
|---|---|---|
| `EXCHANGE_IP_LIMITER` | Client IP, before credential verification | 120 |
| `EXCHANGE_ACCOUNT_LIMITER` | Verified account, before account SQL | 60 |
| `USER_REQUEST_LIMITER` | Authenticated user, registration, deletion, and blob PUT | 1,200 |
| `USER_BLOB_LIMITER` | Authenticated user, blob PUT | 300 |
| `USER_DATA_BLOCK_LIMITER` | Authenticated user, prepaid read/batch blocks | 120 blocks |

Each binding uses a distinct namespace, including staging and tests.
Denial returns retryable `rate_limited` (429), `Retry-After: 60`, and an epoch-ms
`error.retryAt`. Clients honor both header and JSON deadlines before adding jitter.

State, entity, and blob reads and batch POSTs use an in-memory session-object token
bucket: 1,200 requests initially, refilling at 20 per second. Each user also buys
ten request credits at a time through `USER_DATA_BLOCK_LIMITER`, before admission,
keyed by user ID across sessions and organizations. Credits expire at the next
aligned minute boundary. A purchase crossing that boundary is discarded and charged
again. Unused credits and object eviction can only reduce aggregate admission:
each admitted request consumes a prepaid credit, including each session's first
request. The per-user ceiling remains at most ten times successful block charges
within a limiter period/location; it is not a globally coordinated quota.
Set the block limit to one tenth of the desired read/batch request ceiling.
The session token bucket resets on object eviction; prepaid credits are never
persisted or carried to a new instance. Purchases are serialized within an instance.

Failed R2 cleanup persists a one-minute retry floor. Later writes cannot pull that alarm
forward. A retry that encounters an expired, in-flight cleanup claim waits five seconds.

A tombstone survives entity cleanup.
A deleted ID cannot be registered again.
An operational restore must reapply deletion fences before exposing restored data.
Durable Object SQLite point-in-time recovery retains platform backups for 30 days.
R2 has no backup. Erasure removes live content; it does not shorten platform SQLite
backup retention. Restoring SQLite requires reapplying deletion fences before access.

### Request metrics

`SESSION_SYNC_METRICS` writes one Analytics Engine datapoint per response to
`session_sync_metrics` (`session_sync_staging_metrics` in staging).
The index is the normalized method/route; blobs are route, HTTP status, error code,
and tenant type. Doubles are total ms, DO RPC ms, R2 ms, exchange SQL ms, request
bytes, and response bytes, in that order. Valid Content-Length values supply byte
counts without wrapping streams. JSON responses declare their exact UTF-8 length.
Known-length responses emit when ready; their total ms excludes later body delivery.
Unknown-length streams count consumed bytes and emit on completion or cancellation.
DO RPC duration includes its internal R2 work; these latency fields are not additive.
Metrics do not buffer blobs or page bodies or record user IDs, session IDs, hashes,
credentials, or content. Tests can omit the Analytics Engine binding.

Run `node scripts/profile-metrics.mjs` in the Worker pool to compare the same
synthetic batch/state/error/blob mix with metrics off and each component disabled.
The harness generates variants from the real implementation and removes them after
the run. Its no-op Analytics Engine sink measures call overhead, not remote ingestion.

## Portable checkpoints

A viewable transcript is not necessarily a portable session.
Portability also requires instructions, attachment bytes, native replay information,
and the state needed to reconstruct a recoverable continuation.
Credentials and active machine bindings are never part of a checkpoint.

The complete service distinguishes committed display state from a verified portable checkpoint.
A missing asset remains explicit and cannot count as a complete portable checkpoint.
Provider-bound replay information is retained, but another runner can need a fresh context.
Never replay an ambiguous external tool effect automatically.

## Live delivery and commands

Future live delivery uses hibernatable WebSockets and a bounded committed change feed.
Commit before acknowledging the producer or broadcasting to viewers.
Clients persist their projection and cursor in one local transaction.
An expired cursor returns a reset; it does not return an incomplete success.
A bootstrap snapshot pins its page versions and captured revision.

Remote commands use a durable service inbox and a runner receipt ledger.
Queued, admitted, and model-delivered prompts are different states.
An offline prompt has visible expiry and retains its command ID across retries.
Live cancel and approval commands bind to their run, request, and runner incarnation.
A stale control fails instead of applying to a later run.
Remote permission grants are allow-once or reject.
A transcript revert must not delete command deduplication evidence.

The service does not promise exactly-once provider requests or external tool effects.
A disconnected runner cannot be stopped through cloud fencing alone.

## Future catalog and historical data

A separate sharded catalog serves session discovery and low-rate account updates.
Catalog lag cannot make an existing directly addressed session appear absent.
Do not relay transcript tokens through one account-wide object.

Historical conversion is a throttled lane outside foreground ingestion.
Conversion preserves provenance and reports unavailable data.
It never invents native event history or overwrites a session adopted by a native producer.

Archive older transcript bodies as verified immutable R2 segments.
Advance their manifest only after the objects are durable.
Only then remove covered hot data.
Do not retain transport deltas forever merely to preserve transcript history.

## Performance gate

The synthetic acceptance workload is 100,000 concurrently streaming sessions.
Watched healthy regional paths target source-commit-to-foreground-apply p95 at or below 250 ms.
Intercontinental results are reported separately.
The initial ingestion delivery does not establish these capacity or latency claims.

Compare per-session storage with regional packed group commits before fleet rollout.
Use identical authorization, durability, current-state, replay, and command requirements.
Measure row writes, indexes, cleanup, requests, duration, bytes, and retained storage.
A transaction containing many rows is not one billed row.

Test no viewers, ordinary viewers, full viewing, concentrated fan-out, slow viewers,
reconnect bursts, large output, imports, catch-up, and archive failure.
Measure source-commit-to-client-apply and emission-to-client-apply separately.
Report tail latency, failures, and missed deadlines alongside the main percentile.
Accept the measured cost envelope before production-scale load.

## Isolated staging configuration

The top level of `wrangler.jsonc` is production and `env.local` is local development.
Staging uses a separately rendered `.wrangler/wrangler.staging.json`, following the
config-rendering pattern in `cloud-agent-next/test/e2e/deploy/render-e2e-worker-config.mjs`.
The renderer copies only service code and runtime settings, never the production bindings.
Neither rendering nor the dry-run command creates resources or deploys.

### Missing live prerequisites

The 2026-10-28 read-only account inventory authenticated to the Kilo Code Cloudflare
account, but found **no dedicated session-sync staging Hyperdrive/auth database**
and **no session-sync staging R2 bucket**. Existing Hyperdrives serve customer
support, production, its replica, and Snowflake export; none is a substitute.
In particular, `session-ingest`'s bucket containing `staging` in its name is not an
isolated test stack: that service binds production authentication data and secrets.
No production database query is needed or permitted to prepare this configuration.

Before rendering, an operator must obtain and review all of the following:

1. A dedicated nonproduction PostgreSQL database with the repository auth schema,
   **synthetic accounts only**, and a dedicated least-privilege read-only database
   user. Confirm the actual origin host, database, user, and data provenance, not
   just the resource's name. Exchange reads account pepper/block status, active
   device sessions, and organization membership; seed synthetic rows for the
   positive and denial cases. Do not clone production data.
2. A dedicated Hyperdrive in the verified account pointing to that database.
   Record its real ID and reviewed origin metadata; do not reuse an existing
   production/replica Hyperdrive or local connection string.
   Its query cache must be disabled (`wrangler hyperdrive update <id> --caching-disabled`).
   Review `caching.disabled: true` in the actual Hyperdrive configuration metadata.
   Set `verification.hyperdriveCachingDisabled` only after recording this evidence.
3. A dedicated bucket named `session-sync-staging`, in the same verified account.
   Verify that its public development URL is disabled, it has no public custom
   domains, and it is not exposed by another Worker or public gateway. Only this
   service may access its synthetic session blobs.
4. Independently generated signing secrets, each at least 32 random bytes,
   recorded in the shared engineering vault and installed as Workers-scoped Secrets
   Store entries `session-sync-staging-nextauth` and `session-sync-staging-grants`,
   plus a separate `session-sync-staging-internal` secret shared only with the isolated
   web account-deletion caller.
   Record only the store ID and entry names in configuration. Never copy a
   production auth secret, share the two values, print values, or put them in the
   resource manifest. The first signs synthetic Kilo credentials; the second
   signs only this staging deployment's five-minute sync grants.
5. Confirm that `session-sync-staging` is a dedicated Worker identity, with no
   existing production deployment or production routes. Its SQLite namespace is
   created by the eventual separately authorized deployment's `v1` and `v2` migrations;
   the renderer does not bind another Worker's Durable Objects.

Store a nonsecret resource manifest outside tracked source, for example
`.wrangler/staging-resources.json`. Its required shape is below. The null IDs and
false assertions are intentionally **rejected**, not deployable placeholders:

```json
{
  "accountID": null,
  "hyperdriveID": null,
  "bucketName": "session-sync-staging",
  "secretsStoreID": null,
  "verification": {
    "hyperdriveDedicatedNonproduction": false,
    "databaseSyntheticOnly": false,
    "hyperdriveCachingDisabled": false,
    "r2DedicatedAndPrivate": false,
    "independentSigningSecrets": false,
    "evidence": ""
  }
}
```

Replace IDs with real metadata and set assertions to true **only after** reviewing
the prerequisites above. `evidence` must reference a nonsecret verification record
containing the reviewed account/resource IDs, Hyperdrive origin host/database/user,
synthetic-data provenance, bucket access settings, secret entry names and independent
generation provenance. Do not include connection passwords, token values, peppers,
secret values, or personal data. Assertions are operator attestations, not automatic
proof: this offline renderer validates their presence and configuration shape, but
does not contact Cloudflare, inspect a database, or verify secret contents.

### Commands for the work VM

From `services/session-sync`, use read-only inventory commands when prerequisites
are available; review only nonsecret metadata:

```sh
pnpm exec wrangler whoami
pnpm exec wrangler hyperdrive list
pnpm exec wrangler r2 bucket list
```

After installing the package's declared dependencies and completing the manifest:

```sh
export SESSION_SYNC_STAGING_RESOURCES="$PWD/.wrangler/staging-resources.json"
pnpm run staging:config
pnpm run staging:dry-run
```

`staging:dry-run` renders again and invokes
`wrangler deploy --config .wrangler/wrangler.staging.json --dry-run --outdir .wrangler/staging-dry-run`
only if validation succeeds. Missing/invalid IDs or unverified assertions stop the
command; there is no fallback to local IDs or production configuration. Do not use
an older rendered file after changing resource verification.

The rendered Worker is `session-sync-staging`, has no custom-domain routes, disables
version preview URLs, and uses its own workers.dev endpoint. It sets
`ENVIRONMENT=staging`: synthetic Kilo credentials must carry `env: "staging"`,
match the isolated database's user pepper, and use an eligible human/device
credential policy. Production/development credentials must not exchange successfully.
All secrets use the service's existing Secrets Store `get()` support; absent
bindings fail auth closed. No auth bypass or production secret binding is added.

The dry run only bundles and validates configuration; it does **not** establish
live isolation, resolve remote secrets, or exercise authentication/storage.
After a separately authorized staging deployment, the required live acceptance
proof must cover synthetic personal and organization exchange, wrong signing
secret/environment, blocked/revoked accounts and devices, cross-tenant denial,
private blob upload/read, durable replay and restart recovery, and deletion.
Neither a live deployment nor provisioning is part of these commands.

References:
[Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/),
[Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/deploy/).

## Production prerequisites

Production is provisioned and deploys automatically at `https://session-sync.kiloapps.io`.
The top level of `wrangler.jsonc` holds the production bindings; `pnpm dev` uses `env.local`.
Production uses the private R2 bucket `session-sync`, the Hyperdrive configuration
`session-sync-production`, and the Secrets Store entries `NEXTAUTH_SECRET_PROD`,
`SESSION_SYNC_SECRET_PROD`, and `INTERNAL_API_SECRET_PROD`. Shared secrets live in
the shared engineering vault.
The Hyperdrive configuration connects as `session_sync_reader`, a read-only role with
column grants on only the account, device-session, and membership columns that exchange reads.
Set `ENVIRONMENT=production` explicitly; exchange fails closed if it is absent or
empty and never accepts a credential from a different environment.
Do not copy production credentials into local examples or test fixtures.
Configure a deployment-specific secret for sync grants.
The `HYPERDRIVE` binding must point to a configuration with `caching.disabled: true`,
in production as well as staging. Account, device-session, and membership reads all
use `getWorkerDb(env.HYPERDRIVE.connectionString)`; the database client does not
disable Hyperdrive caching itself. The staging renderer requires an explicit
cache-disabled attestation, not just a resource name. Local PostgreSQL tests cannot
prove remote cache settings. Cloudflare documents that writes do not invalidate
cached reads and recommends a cache-disabled binding for authentication and permissions:
[Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
Verify account and organization authorization on an isolated stack before deployment.
Account deletion and 90-day idle retention are implemented through durable alarm
jobs. Tenant quotas and bounded cleanup are enforced. SQLite point-in-time recovery
is retained by the platform for 30 days; R2 has no backup. Rollout monitoring remains
an operational prerequisite. The CLI uses this production destination by default.

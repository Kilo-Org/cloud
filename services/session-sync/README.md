# Native session synchronization

## Scope

This service synchronizes native v2 sessions from a Kilo CLI workspace.
The CLI remains the execution owner and continues when the service is unavailable.
The existing session-ingest service remains unchanged during migration.

The service includes authenticated incremental ingestion, durable acknowledgements,
private assets, current-state reads, producer recovery, live relay, opaque offline
commands, and per-user CLI presence. Ownership transfer and legacy import remain
outside this delivery. Live payload semantics belong to the runner, not the cloud.

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

Every session read and write requires a session ACL role. The role table includes
`owner`, `viewer`, and `editor`; only the creator's `owner` grant is populated and
accepted today, including within organizations. Tenant membership alone never
permits state, entity, blob, tombstone, ticket, or command access. Existing creator
bindings are migrated to owner grants. Future multiplayer can add explicit grants
without treating organization membership as a session grant.

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

The shared SDK exposes canonical history through
`NativeSyncClient.getSnapshot(sessionID, organizationID?, signal?)`. Its `NativeSnapshot`
retains revision, source position, portable entities/blob references, and ordered
`{seq, message, partOrdinals?, incomplete?}` entries. `message` is the full reconstructed
native value, not a reduced chat view: files, costs/tokens, errors and unmodeled native
metadata remain available. Native message values are validated using the existing
`@kilocode/session-ingest-contracts` Kilo2 message schema without stripping native fields.
The portable session reuses the Kilo2 session fields but carries `origin.directory`
instead of the excluded local `location` binding. The raw snapshot preserves that shape;
projection supplies `location.directory` from origin only to label shared display data.
Origin is never a runtime root, authorization claim, or filesystem grant.

`projectNativeSnapshot(snapshot)` feeds complete canonical messages through the same
`readKilo2Messages` projector as Cloud Agent history. It returns the native session,
revision/source position, shared display messages, and explicit `incompleteMessageIDs`.
Incomplete entries retain their original native envelope but are never rendered as
complete empty answers. A valid uploaded empty session projects to an empty message list;
if the session entity has not arrived, projection fails with `session_metadata_missing`
instead of inventing session metadata. Missing/deleted service errors still propagate.
Sparse sync ordinals remain reconstruction metadata, not shared display part IDs.

Native user files may contain `uri: "media:<sha256>"` instead of inline `data`;
tool results carry file content by URI. The shared schemas accept both native
forms without inventing inline bytes. `getSnapshot` resolves required private
attachment bytes through the same organization-scoped grant as its JSON reads.
Only an asset mapping matching the owning entity, exact JSON pointer, original
reference, MIME and content address can authorize that download. Downloads use
the fixed session blob route, check advertised byte length, share the snapshot's
deadlines/cancellation/revision recovery, and deduplicate bytes by blob hash.
No native local path, raw media URI or credential-bearing service URL is exposed
as an attachment URL. The sidecar `assetURLs` contains actual downloaded bytes as
data URLs keyed by `kilo2AssetKey(displayFileID, originalURI, mime)`; canonical native
messages and asset entities remain unchanged. Missing/mismatched mappings fail
explicitly rather than silently dropping a file or making an unauthenticated fetch.

The shared projector exposes every completed/errored native tool image/document
as an ordinary message FilePart, so specialized tool cards cannot hide files and
the existing file renderer handles images, PDFs and MCP documents for every tool.
The projector has one native-file display authority: ordinary FileParts, not a
parallel `state.attachments` mirror that could duplicate images in generic cards.
Exact tool file content remains available in the canonical native message.
Errored results retain their failure status. Unresolved live private references
stay pending native snapshot recovery; a prior revision's resolved URL cannot
satisfy a different content-addressed URI.
Mutable local-path references require reauthorization after an authoritative update.

This snapshot adapter does not turn sync positions into Cloud event cursors,
replace native live replay, or imply transport/auth/runtime equivalence.
The existing `connectSession` live view remains transport-specific; client integration
must keep its reset, incomplete/recovery and pending-interaction behavior explicit.

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
The exact latest 256 accepted batches retain receipts. The accepted-batch counter
skips pruning until the tail fills; each later acceptance removes its single
oldest indexed source position in the same transaction. Source positions may jump.
Retries and rejected/rolled-back writes do not advance that counter or trim the tail.
This uses the existing `receipts_through_idx` and requires no schema migration.

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
The 4 MiB / eight-call admission cap returns retryable `service_overloaded` with
`Retry-After: 3` and `retryAt` when full, and releases reservations in `finally` on success, typed rejection, or
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
0.16.13, Vitest 4.1.12): **8 tests passed**, 17 profiled scenarios, 7.66 s total.
Heap columns are MiB; CPU is sampled active milliseconds.

| Boundary | CPU ms | Peak used heap | Peak V8 reserved heap | Incremental used heap |
|---|---:|---:|---:|---:|
| 512 KiB batch / 64 KiB inline values | 44.210 | 58.44 | 64.50 | 2.93 |
| 64 changes | 35.729 | 55.23 | 59.99 | 0.19 |
| 64 inline container levels | 14.662 | 55.53 | 58.49 | 0.46 |
| 32,768 batch nodes / 8,192 value nodes | 21.470 | 56.21 | 60.49 | 0.95 |
| Exact 2 MiB page | 46.930 | 63.18 | 69.49 | 7.91 |
| 100-item page | 33.521 | 56.53 | 59.49 | 1.45 |
| Full 4 MiB write queue: reject next call | 8.069 | 55.69 | 58.49 | 0.08 |
| Full eight-call queue: reject next call | 8.093 | 55.18 | 57.99 | 0.06 |

Over-budget JSON and 10,000-level pre-parse depth attacks took at most 9.997 ms
sampled CPU and 0.47 MiB incremental used heap. The largest incremental heap
was the 2 MiB page (46.930 ms / 7.91 MiB incremental used heap); this includes the
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
Leases include inline values and all reserved or stored blobs. The first nonempty
lease rounds to 1 MiB, then doubles through 2/4/8/16/32 MiB as usage requires.
Above 32 MiB, growth uses the existing 32 MiB quantum, capped at the combined
inline/blob bound. Existing stored reservations remain valid; registration
preserves a sufficient lease rather than expanding it to another quantum.
The existing alarm shrink threshold remains 64 MiB of unused capacity. A shrink
or uncertain-growth reconciliation rounds committed usage by the same tier rule.
Deletion durably tombstones the session and releases its admission and whole lease.
Physical blob cleanup follows the fenced upload deadlines and retries independently.
Tenant calls never run inside SQLite transactions.
This trades up to five additional growth reservations through the first 32 MiB
for smaller tiny-session reservations; quotas and session limits are unchanged.
The local concentrated-organization fixture holds 24 two-KiB checkpoints in
24 MiB of leases. That is reservation efficiency, not a throughput measurement.
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
For entity pages, DO RPC ms ends when the stream is returned; it excludes later
page encoding and delivery. Unknown-length page total ms covers consumed body
delivery, including backpressure. Neither latency field is a DO CPU measurement;
the boundary profiler above measures the complete page operation for capacity review.
Metrics do not buffer blobs or page bodies or record user IDs, session IDs, hashes,
credentials, or content. Tests can omit the Analytics Engine binding.

The same binding also emits `diagnostic_v1` stage points, with that literal index.
Blobs are `[version, operation, stage, outcome, cause, tenantType]`. Doubles are
`[durationMs, count, maxQueueDepth, maxRetainedBytes, overloadedFlagCount,
retryableFlagCount, sampleEvery]`. Successful boundary completions sample 1/128
(`sampleEvery=128`, `count=1`). These indicate boundary completion, not necessarily
batch acceptance: a resolved RPC can return a typed rejection recorded separately.
Failure keys aggregate for one second; their duration and flag counts are sums
and queue/retained-byte fields are maxima. The first failure emits immediately.
Each isolate retains at most 128 bounded failure keys, with no timer or pending
I/O. A final aggregate can be lost on eviction/idle shutdown; these are diagnostic
observations, not billing or exact error-accounting counters.
The oldest key is evicted when the map fills, so newly observed causes remain visible;
eviction can discard that key's pending aggregate. A raw-stage point and a
typed-result point can describe the same request: never sum them as distinct
per-request failures.

Operations distinguish state, batch, registration, live authorization, connection,
tenant admission, watch and Sync/Relay/Presence initialization. Stages cover
Worker RPC lookup/call, limiter credit, hashing, validation, actual mutation
transaction attempts, receipt pruning, lease reserve/reapply, mutation/watch queue
wait, watch storage/RPC/budget and scheduling. `lease_required` is an expected
transaction rollback to acquire capacity, not a platform overload.
`queue_admission` reports active/queued batch count; `queue_wait` reports all
active/queued admission-gate calls, including registration/live authorization.
Their retained-byte field counts pending UTF-16 batch bodies. `watch_queue`
reports active/queued watch tasks; it does not measure transport-buffer memory.
The exact fixed label unions are in `src/metrics.ts` and `src/overload.ts`.
Cause labels distinguish `application_queue`, documented platform request/data
queue, queue-timeout, object/account-rate categories, flag-only `platform_unknown`,
watch budget, typed results and explicit unknowns. Raw exceptions are classified
before generic error conversion; client error bodies, retry rules and limits
are unchanged. Phase durations are elapsed work and may overlap; they are not CPU
or hibernation/residency measurements.

Diagnostics contain no raw exception text, payloads, request/session/user IDs or
credentials. An isolated load deployment must bind its own Analytics Engine
dataset as `SESSION_SYNC_METRICS`; omitting it disables both HTTP/stage metrics.
Never bind a production dataset merely to qualify a test.

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

## Live delivery, commands, and presence

The cloud is a thin relay: it authenticates, stamps sender/time/sequence, applies
limits, keeps a short event replay ring, and stores opaque command payloads. It
does not interpret approvals, aborts, slash commands, run IDs, or sync positions.
The runner deduplicates command IDs, validates execution scope, and publishes
semantic outcomes. The service does not promise exactly-once tool/provider effects.

### Endpoints and tickets

All HTTP endpoints below use a `session-sync` bearer grant except WebSocket
upgrades. CLI sockets use a bearer ticket; browser and React Native sockets use
`new WebSocket(url, ["kilo-session-ticket."+ticket])` and the 101 echoes the selected
subprotocol. Query tickets are rejected: ticket credentials must never appear
in Logpush-visible URLs. Never log authorization or subprotocol headers.

| Method | Path | Input / result |
|---|---|---|
| POST | `/v1/sessions/:id/live-ticket` | `{role:"runner"|"viewer"|"controller"}` → `{ticket,expiresAt}` |
| GET | `/v1/sessions/:id/live` | WebSocket upgrade, session-relay ticket |
| POST | `/v1/sessions/:id/commands` | Same command frame as the controller socket |
| GET | `/v1/sessions/:id/commands/:commandID` | Command delivery status, never payload |
| POST | `/v1/presence/ticket` | `{role:"runner"|"viewer"|"controller"}` → `{ticket,expiresAt}` |
| GET | `/v1/presence` | WebSocket upgrade, session-presence ticket |
| POST | `/v1/presence/instances/:instanceID/commands` | Opaque live-only instance command, awaiting reply up to ten seconds |
| GET | `/v1/sessions?limit=50&cursor=…` | Creator-index page `{version:1,items,cursor}` |

Minting session tickets first checks the SyncDO ACL. Tickets are audience,
environment, tenant, subject, role, and session/user bound; their lifetime is at
most 120 seconds and never exceeds the parent grant. Relay and Presence verify
tickets without account-database queries, allowing five seconds issued-at clock
skew. Send `{type:"reauth",ticket}` before expiry. Reauthorization extends lifetime
but cannot change identity or role. All `expiresAt`/`reauthAt` values are ISO8601
strings; expired credentials never authorize frames. Idle session runners are
fenced lazily on the next message/connect, without periodic/expiry alarms or a
pushed `reauth_required`. Runners schedule renewal themselves from `reauthAt`.
Viewer and presence deadlines use alarms. Expiry itself has no clock-skew grace.

### Relay wire protocol

Every server frame is `{v:1,channel,seq,from,at,type,body}`. `channel` is `events`,
`commands`, or `control`; `at` is server Unix milliseconds and `from` is the
authenticated subject (or `server` for control). Only runner events advance the
monotonic event sequence. Durable sequence reservations are allocated in blocks
of 1,024, so hibernation may produce a jump: never assume every integer exists.
Steady runner events perform no SQLite writes or alarm resets. The ring is
memory-only: 30 seconds or 1 MiB, whichever is smaller. A cold object never
pretends its lost ring is complete.

Runner input: `{channel:"events",type,body?}` (missing body defaults to null). The body, including any runner-owned
`syncPosition`, is relayed without interpretation. Viewer/controller input:
`{type:"subscribe",afterSeq}`. Available events replay in order; a gap, expired
tail, unknown future cursor, or lost ring produces `reset_required` and pauses
event delivery. Refetch the durable snapshot, then explicitly resubscribe from
the supplied boundary. A socket that is already subscribed replays only the
entries above the highest sequence it has received, so a repeated `subscribe`
sends the `subscribed` control frame alone; a client that needs an earlier
cursor reconnects instead. The `subscribed` body is `{seq,cursor}`: `seq` is the
current event sequence and `cursor` is the position the replay continued from,
so a client can detect that its requested cursor was advanced. The received
position is held in memory only and is not written to the socket attachment:
after hibernation the replay floor already starts at the stored sequence
ceiling, so a persisted position could never change replay.
The `hello` control frame includes the current event sequence, runner connectivity,
ticket lifetime, and a jittered `reconnectAfterMs`.

Controller input:
`{channel:"commands",type,body?,commandID,liveOnly?:boolean,ttlMs?:number}` (missing body defaults to null).
Runner output commands preserve `type` and wrap the opaque body as
`{commandID,payload,expiresAt,liveOnly}`. Runner acknowledgements are
`{type:"ack",commandID}`. HTTP submission uses exactly the same handler, validation,
rate budget, and mailbox as socket submission.

`queued` means never handed to a runner; `delivered` means handed to one, not
executed or acknowledged. Unacked payloads redeliver oldest-first on reconnect
until ack or TTL. Ack deletes the payload. TTL removes any remaining payload,
marks only never-delivered items `expired`, and preserves `delivered` once handed
off. Semantic execution outcomes are runner events. Finished status tombstones
last up to 24 hours and may be evicted to maintain bounds; unknown/evicted IDs
return 404. Retries must keep command IDs; the runner retains its own dedupe
evidence. Default TTL is 15 minutes, maximum 24 hours. `liveOnly` rejects without
a runner; handed-off live-only payloads are discarded when that runner disconnects
and never replay to its replacement.

Limits: 64 KiB input frames; one runner and at most 100 combined viewers/controllers
per session; 1,000 mailbox items and 10 MiB pending payloads. Per-minute role
budgets are runner 6,000, controller 120, viewer 120. Command-status reads have an
independent budget. Same-user runner reconnect replaces the old socket with close
code 4009 without a false offline transition. Session runners treat 4009 as
terminal for that session and never automatically reconnect; otherwise two
processes can repeatedly evict one another. Overload uses `503 service_overloaded`
and `Retry-After`. Other reconnects respect the independent 1–60 second jitter.

### Presence and watch signals

One hibernatable runner socket per CLI process advertises via
`{type:"heartbeat",instanceID,advertisement}` every 30 seconds. Advertisement:
`{name,projectName,version,kind:"cli"|"remote",startedAt,gitBranch,capabilities,sessions}`.
`startedAt` is Unix milliseconds, `gitBranch` is string or null, capabilities and
sessions are string arrays. Advertisements are bounded; no heartbeat means
offline after 90 seconds. Presence viewer `{type:"subscribe"}` receives `instances`
snapshots, including removals. Snapshots are change-driven: a new or changed
advertisement, an online-state change, or an instance leaving produces one snapshot,
and `lastHeartbeatAt` is the value at that snapshot. Records include `{instanceID,tenant,advertisement,
online,lastHeartbeatAt}`. Same-user/tenant/instance reconnect replaces the previous
socket with code 4009; presence 4009 may retry, unlike session-relay 4009.
No disconnected-instance history is retained. Ads are held
in SQLite and written only when changed; socket attachments hold bounded identity,
liveness and rate metadata below workerd's attachment limit.

Presence control types: `hello`, `heartbeat_ack`, `instances`, `watch`,
`reauthorized`, and `error`. `watch` body is `{tenant,sessionID,watching}` and reaches
only matching, advertised runner sessions. First viewer/controller attach starts
watching; last leave stops it. Watch leases survive hibernation, are refreshed
while watched, and expire if the relay disappears. Reconnecting runners receive
the current watch state. Presence caps are 32 advertised instances, eight separate
provisional runner sockets (permitting reconnect-at-cap), 100 combined viewers/controllers, 128 watched
sessions, bounded advertisements, and snapshots within the 64 KiB frame budget.
New instance admission beyond 32 closes 1013; the ninth provisional connection
receives 503 and Retry-After. Watch admission failures produce an explicit viewer error.

### Headless instance commands

Presence controllers can subscribe to instance snapshots and send
`{channel:"commands",type,body?,commandID,instanceID}` without registering a session.
An online runner in the same user/tenant/instance receives the opaque command
envelope with body `{commandID,instanceID,payload}`; the controller gets
`command_status {commandID,instanceID,status:"delivered"}`. Offline or wrong-tenant
instances reject with `instance_offline` (HTTP 409). No mailbox or command payload
is stored. Runner-owned types include `create_session`, `list_directories`,
`list_models`, and `list_agents`; session commands remain on SessionRelayDO.

Native `list_models` accepts `{cursor?:number}` with a nonnegative integer offset.
Its successful result is `{models:[{id,providerID,name,limit,variants}],nextCursor:number|null}`;
`limit` retains context/input/output token limits and `variants` contains `{id}` entries.
The runner pages encoded model entries within 48 KiB, leaving room for the command
outcome and relay envelope. Consumers use `listNativeModels(connection, instanceID)`
to validate and collect every page until `nextCursor:null`; missing/malformed pages,
unknown outcomes and nonadvancing cursors are errors, never truncated catalogs.

The development web preview is available at `/native-remote` for personal presence
and `/organizations/:id/native-remote` for organization presence. Both routes remain
server-gated to development. Mobile waits for its existing organization selection to
restore before connecting presence; changing scope closes old presence/session
connections and resets selections and drafts. Creator-index session discovery still
spans all tenants and is not an organization authorization check.

Runner reply `{type:"reply",commandID,body?}` routes only to the originating
controller as control `reply {commandID,instanceID,payload}`. Routing metadata
survives hibernation and binds the exact runner connection and tenant; pending
duplicate IDs reject `command_conflict`. Missing command/reply bodies default
to null. A 120-command/min controller budget is shared by HTTP and sockets;
frames/envelopes are bounded at 64 KiB, outstanding metadata at 1,000 routes,
and routes expire after ten seconds.

HTTP uses `POST /v1/presence/instances/:instanceID/commands` with a sync grant and
`{type,body?,commandID}`. Optional socket frame channel and matching instanceID
are accepted. The same handler returns 200
`{commandID,instanceID,status:"replied",body}` if the runner replies within ten
seconds, or 202 `{commandID,instanceID,status:"unknown"}` otherwise. An ambiguous
RPC transport failure also returns 202, adding `outcome:"unknown"` instead of
claiming execution failed. Timeout/transport loss does not prove non-execution.
Late runner `command_not_found` replies are informational: routing has expired
or the controller left; do not retry the reply. Live request/reply needs no fake/control session.

Session discovery pages the user's personal creator index across all tenants,
newest registration first with stable cursor ties, and merges matching presence
into `live`. It may show a creator's session IDs after leaving an organization,
but opening still requires a current grant and session ACL. The index is discovery,
never authorization. Deletion removes entries and durably retries relay purge:
live sockets, mailbox payloads/statuses, replay state, and presence watches are
cleared, and a permanent fence prevents old tickets from reopening the relay.
DELETE/account erasure returns `503 tenant_unavailable` while relay purge is
pending: deletion was accepted, so retry rather than rolling back the local
decision. The SyncDO tombstone retains intent until purge is acknowledged.
Sessions never authorized for live access skip relay creation and purge.

Relay/presence Analytics Engine points index the normalized live operation, with
blobs `[route,role,reason?]` and doubles `[bytes,fanout,latencyMs]`; payloads and identities
are excluded. Presence fan-out points carry the cause of the fan-out in the reason blob.
HTTP request points retain the schema documented above.

### Local end-to-end proof

On an isolated work VM, install workspace dependencies and run
`node scripts/live-e2e.mjs` from this service directory. It launches real
`wrangler dev --local` with `wrangler.test.jsonc`, synthetic signing keys and
temporary storage. A scripted presence runner/viewer/controller creates the first
real session through an instance command before any session exists, and exercises
HTTP instance request/reply. Session runner/viewer/controller sockets then exercise
watch signals, offline queue/replay/ack, live events, cursor replay, HTTP commands,
runner takeover, reauthorization, and discovery over real WebSockets.
No production secret, account, PostgreSQL connection, or Cloudflare
deployment is needed. Durable Object regression suites additionally cover
expiry, resets, caps, rate/size bounds, and stale heartbeat alarms.

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

## Performance qualification

The `scripts/perf-*.mjs` tools separate the native publisher, raw wire reader,
and actual `NativeSyncClient` into independent processes. They use synthetic
session identities and single-use output directories. Local qualification
binds a synthetic relay to `127.0.0.1:18829`; it validates HS256 grant signatures,
environment/expiry, scoped one-use expiring renewal tickets, and strict heartbeat
shape. It remains synthetic generator evidence, not real Worker authentication,
Durable Object storage, enforcement, or UI-rendering proof. The actual-workerd
pipeline is separate evidence.

From this package on an isolated work VM:

```sh
node --test scripts/perf-*.test.mjs
node --import tsx scripts/perf-qualify.mjs smoke /private/native-socket.mjs ../../packages/cloud-agent-sdk/src/native-sync.ts /tmp/sync-smoke
node --import tsx scripts/perf-qualify.mjs local2x /private/native-socket.mjs ../../packages/cloud-agent-sdk/src/native-sync.ts /tmp/sync-local2x plain
node --import tsx scripts/perf-qualify.mjs sdk625 /private/native-socket.mjs ../../packages/cloud-agent-sdk/src/native-sync.ts /tmp/sync-sdk625 instrumented
```

Supply the pinned native `RemoteSocket` module from native revision
`5b3069885d3223b96fdf1b1db51a7bda54e566e8`; `perf-common.mjs` checks its bundle
digest. The SDK source path and digest are recorded independently. The optional
`instrumented` mode adds dequeue and projection timing to an in-memory SDK module
using checked source anchors. It changes no SDK file or public API. Report it
separately from the ordinary `plain` run. Its extra parsing/observer work is part
of its measured overhead.

Population fields are independent: `sessions` registers sessions and presence;
`streamingSources` opens runner sockets and offers 512-byte events at `eventHz`;
`watched` counts distinct viewer-backed sessions, not producers; `sdkViewers`
counts actual `NativeSyncClient` instances. SDK and raw viewers cover exactly
the watched subset (raw mirrors add connections, not distinct sessions).
All viewer-backed sessions must belong to the streaming-source subset.

`sourceTrafficMode: "all-streaming-sources"` explicitly enables a synthetic
service-ingress overload: every declared source sends even without a viewer watch
signal. The watched subset must still receive real watch signals. This does not
change the real CLI's watch-driven suppression or claim that unwatched traffic is
its normal behavior. Producer-only sources have durable checkpoint reconciliation,
not consumer-delivery evidence.

`local2x` offers 6,250 presence connections **and 6,250 streaming sources** at
10 Hz (62,500 events/second), 626 watched sessions/actual SDK viewers, and 1,250
scheduled checkpoints/second. It is twice one 3,125-source/313-viewer shard of
the 32-shard full shape; the changed emitter workload requires fresh per-process
and combined-host qualification, not reuse of the previous watched-only result.
`raw2x` is the same source load with 626 raw readers instead of SDK instances;
`sdk625` exercises 625 sources and actual SDK viewers at 20 Hz. `smoke` deliberately
has 12 sources but only four watched sessions (two SDK and two raw), so qualification
exercises unwatched producer traffic too.

`full` declares 100,000 concurrently streaming sources at 10 Hz, 10,000 watched
sessions and 10,000 actual SDK viewers, with no raw mirrors. Offered ingress is
1,000,000 events/second: 55,000,000 total scheduled sends, including 45,000,000
measured sends. The 10,000 viewers have 4,500,000 measured arrivals/applies.
The remaining 90,000 sources have **no viewer delivery claim**. A separate
100,000-viewer/full-viewing scenario is not configured or proven by this profile.
No capacity is proven until a newly authorized exact-workload run passes;
planning, offline regressions and local relay qualification are not capacity proof.

Each 512-byte event body carries its session/sequence identity, scheduled time,
and producer-send time. A five-byte unique text token carries transcript
correctness; independent padding supplies the remaining wire bytes. This is
not a claim that every byte is user-visible text. Durable message values are
2–8 KiB and contain the exact committed token prefix plus `sourceSequence`.
All registered sessions receive five-second checkpoints and a final checkpoint
with durable receipts. Every streaming source must emit every warm/measured slot,
and its final durable `sourceSequence` must equal its exact sent prefix, including
sources with no viewers. The producer retries the exact final batch to reconcile
its receipt, then checks durable state and entity content for every session.
A local socket send is not an ACK or proof of transient delivery.

Per-event listeners inspect sequence metadata without reading growing text.
Full projected transcript hashes are compared at the fixed drain boundary.
Wire arrivals, SDK callbacks, listener cost, event-loop delay, request concurrency,
source scheduling backlog, checkpoint scheduling lag, resets, reconnects,
duplicates, and live socket counts are retained in bounded counters/samples.
SDK wire-to-callback timing includes queue and projection in `plain` mode;
`instrumented` also reports those stages separately. SDK callback timing does
not measure a browser or native view commit.
Negative clock/skew samples and latency overflow counts are explicit; the
overflow percentile bin is not a measured upper latency bound.

The tools retain one sanitized native error and one native close event.
The `reconnects` counter counts unexpected closes, not completed reconnections.

All rates use the declared 45-second measured denominator after ten seconds of
warm-up; arrivals have a fixed additional ten-second drain. Late/missing events
and source underproduction are explicit failures rather than smaller latency
denominators. Source catch-up preserves every scheduled slot within a bounded
five-slot budget. Checkpoint admission retains at most one pending slot per
session, with a 2,048-slot FIFO queue and one-second scheduling deadline. No skipped
slot is considered success. The producer and viewers close sockets at the fixed
drain even when durable HTTP work is outstanding.
Wire and projection completion at or after the drain are excluded from
acceptance. Every measured viewer arrival must reconcile inside that boundary.
Receipts validate the exact request digest and all response fields; an exact
retry must return the complete original receipt, including its commit timestamp.

The `cold`, `renewal`, `hot100`, `slowreader`, and `organization` profiles prepare
small diagnostic stages. `renewal` uses short synthetic grant lifetimes;
`hot100` has one SDK plus 99 raw readers on one session; `slowreader` pauses
actual raw TCP reads for 20 seconds. These local fixtures do not establish
cloud renewal enforcement, slow-reader eviction, or concentrated-tenant capacity.
Exercise real credential exchange separately: scale viewers disclose their
locally signed synthetic grant path.

### Cloud run gates

Cloud mode requires a reviewed target manifest, exact rendered-config and
source checksums, and an unexpired parent GO matching every workload-config
checksum. The manifest permits a unique `session-sync-<runID>-loadtest`
workers.dev target, identically named R2 bucket, isolated run-specific metrics
dataset, synthetic uncached Hyperdrive origin, and independent staging secrets.
Run `perf-inspect.mjs absent <manifest>` before provisioning: it checks complete
name inventories and verifies the run-derived limiter namespace IDs are unused.

Worker scripts use one unfiltered GET without guessed `page`/`per_page` parameters,
matching the [Worker scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)
and its [SDK `SinglePage` contract](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/scripts.ts).
The complete array is checked regardless of length. Numbered inventories honor
explicit `total_pages`; otherwise a short or empty page terminates traversal using
the response's actual `per_page` when supplied. `total_count` is advisory, never a
reason to skip a full page or chase empty pages. Cursor inventories follow returned
cursors and reject repeats. Unavailable inventories and unsupported pagination or
response schemas fail closed.

Keep limiter names, limits, and periods unchanged. After deployment, `verify`
checks actual deployment/version IDs, the `workers/tag` run marker, deployed
bindings, namespace ownership/classes, private R2 domains and bucket ID, Hyperdrive
origin, and explicit synthetic/TLS database evidence. It also checks custom
domains and zone routes. These are read-only operator commands; their credential
stays on the owned control VM. Generator admission requires a fresh hash-bound
inspection artifact, not a configuration-file hash alone. Generator hosts,
repositories, and absolute normalized output roots are explicitly reviewed in
`manifest.generators`; no developer-specific home-directory prefix is required.
Cluster nodes must match those exact reviewed entries.

Render the run-specific Worker config with `perf-render.mjs <manifest.json>`;
it selects runtime code/settings and dedicated resources without deployment.
Read the run tag and bindings from the deployed version's `annotations` and
`resources.bindings` through `/versions/<versionID>`. Read Logpush and
observability through `/script-settings`.
Wrangler canonicalizes omitted or null remote observability as disabled.
Reject explicit logging or tracing enablement, including nested overrides.

`perf-plan.mjs <profile> <manifest.json> <output-directory>` generates per-node
target/config packages, the cluster plan, and an approval-request record. It
creates neither credentials nor GO files. Supported cloud profiles are `cold`,
`renewal`, `hot100`, `slowreader`, `organization`, and `full`; the last fixes
100,000 sessions and 10,000 actual SDK viewers across 32 shards/four hosts.

Start `perf-teardown.mjs arm <target-manifest.json>` on the owned control VM
before any refresh or seed command. Require its matching heartbeat and live
process before approval or admission.

Planning freezes the workload, source hashes, target, and lifetime budget but
does not freeze live evidence forever. Before **each** seed or launch admission,
run `perf-plan.mjs refresh <same-manifest.json> <same-output-directory>` from the
owned control VM. It re-inspects live ownership/bindings and the current local
watchdog, refuses any frozen config/cluster/manifest/budget change, and writes
per-node `attestation.json` plus current heartbeat copies and a new
`approval-request.json`. Transfer those two current artifacts to each reviewed
root. Parent must explicitly issue renewed `go.json` with `approvedByParent:true`,
the exact config/target/budget hashes and new `attestationHash`, the unchanged
forecast hard limit, and expiry covering the unchanged stop time. Refresh never writes
GO or extends resource lifetime. An old GO cannot authorize refreshed evidence;
inspection/attestation freshness remains 60 seconds and heartbeat freshness ten
seconds. After lengthy seeding, repeat refresh and obtain another parent GO
before launch. Do not overwrite the frozen target/evidence copies or re-plan a
running resource to work around expiry.


Run `perf-control.mjs seed <configs...>` before opening presence sockets.
For one host, `run` creates a fresh live-count barrier. For distributed runs,
`perf-cluster.mjs <cluster-plan.json>` starts `wait` controllers on the exact
owned test hosts, combines fresh samples into one simultaneous population,
and distributes one shared absolute window. It rejects stale/missing samples,
early generator exits, and population drops. A failed node writes task-local
stop markers to its peers. Clock-offset evidence and its uncertainty must be
retained before interpreting cross-host latency.
Readiness and measured samples independently require exact presence, streaming
runner, watched, SDK-instance and total viewer counts. Reports keep ingress offered
rate/sends separate from viewer arrivals and SDK callbacks; durable prefix coverage
includes all sources, not just watched ones.

`perf-budget.mjs <budget-plan.json>` prices gross quantities without allowances:
registration, seed, checkpoint, retry/reconciliation, ticket/exchange, WebSocket,
SQL, Worker CPU, rounded DO duration, rounded R2 operations, Logpush, analytics,
downstream ingestion, VM lifetime, storage/egress, and delayed billing reserve.
Expected activity and pessimistic activity are distinct inputs. Plans reserve
the VM allowance and the full delayed-billing reserve before allocating the
remaining Cloudflare ceiling. They also deduct `alreadySpentUSD` from every
earlier attempt; missing cumulative spend fails admission. The default
`hardLimitUSD` is $50. Only a fresh forecast with explicit parent approval can
raise it, up to $100. Run `node scripts/perf-budget.mjs budget-plan.json`
and save its passing output as the forecast; the planner copies that forecast's
cap into its approval request. Parent GO must explicitly match that exact hashed
forecast cap: a $100 GO cannot expand a $50 forecast. Analytics lag is not an
invoice guarantee.
Each budget stage must explicitly bind `streamingSources`, `sourceTrafficMode`,
`watched`, `sdkViewers`, `viewerConnections` and `eventHz`. Inbound WebSocket
allowances must cover **all** source sends, plus other incoming protocol traffic;
ticket allowances include presence + streaming runners + viewers (and renewals).
The new full stage is `100k-streaming-10k-sdk-10hz-512b-10warm-45measure-10drain`;
old watched-only budgets/approvals cannot authorize it. Current provider pricing
and cumulative prior spending remain required external inputs; neither is inferred
from local regression success or this documentation.

Arm `perf-teardown.mjs arm <target-manifest.json>` as a **finite independent job
on the owned control VM**, separate from generator VMs, before opening cloud
sockets. Do not run an operator/watchdog background service on a developer Mac.
The cluster controller, current inspection, and watchdog PID checks must share
that explicit control-VM runtime. Only the parent's approved **private wrapper**
may capture the pinned repository Wrangler credential resolver's JSON token;
emit status only, never the resolver output/token, and never create credential
files. Do not run the token resolver standalone in a terminal/logged tool call.
The private wrapper may provide only the needed operator token in the finite
control job's `SESSION_SYNC_LOADTEST_OPERATOR_TOKEN` environment (or its private
stdin-to-environment adapter). Never send operator credentials to generators.
Without that private environment, helpers privately capture the pinned resolver
internally; no credential-file parsing is supported.

The watchdog publishes a matching nonce-bound heartbeat; cloud admission consumes
it, and the cluster controller checks freshness and local PID liveness throughout
ramp/load. Admission prices absolute resource lifetime including the 150-second
teardown tail. Transient transport/408/429/5xx REST failures and explicitly
classified Wrangler transient/timeout failures receive at most four attempts
with bounded backoff inside the same absolute tail. Wrangler output is captured
privately within 64 KiB only for safe-category classification: never echo it,
tokens, or raw subprocess errors. Authorization/permission/syntax/unknown failures
and output overflow are permanent. Every CLI retry first rechecks resource
ownership and absence; ambiguous successful Worker/bucket deletion is not repeated,
and object retry checks the owned bucket and reads the exact known key through
`r2 object get --remote --file` directed to the operating system's null device.
Explicit absence counts as already cleaned; object bodies cannot fill the private output buffer.
Replacement or unverified ownership never permits another destructive attempt.
Compute cleanup runs first, then each remaining resource is independently
ownership-checked; unavailable bucket metadata cannot block verified Worker
deletion. Replacements are refused for that resource without abandoning other
independently verifiable cleanup. The complete single-page Worker array and paginated
namespace/secret inventories must prove absence. The private proof records exact observed
leftover IDs/names and `null` for unavailable inventories, never assumed absence.
Exact known synthetic R2 keys must be listed; nonempty or deletion-failed buckets
are failures. Cluster artifacts persist `passed:true` only
after teardown succeeds; workload success with cleanup failure is not PASS.
Generator VMs need their own provider-enforced maximum lifetime. Meter polling
and operator availability never extend the resource deadline.

## Native client demo

`@kilocode/cloud-agent-sdk` exports `NativeSyncClient`, a platform-neutral native-v2
reader/controller with injectable `fetch` and WebSocket implementations. It exchanges
a Kilo credential, mints controller tickets, renews authorization, reconstructs
revision-consistent snapshots, and resumes ordered live events or refetches after a
relay reset. Presence commands retain unknown outcomes on timeout; delivery status
is not execution success. Permission, question, and abort commands require a live
runner and its current incarnation/run identity. `/clear` only clears the local view.

### Shared native conversation display

`NativeSessionState.messages` contains canonical `NativeSnapshotMessage` entries
(`message`, source `seq`, optional source-part ordinals and reconstruction
`incomplete` state), rather than a reduced role/text representation. The native
session metadata and last revision-consistent snapshot position remain available
on the same state. `readNativeConversation` projects complete canonical values
through the existing Cloud `readKilo2Messages` pipeline while retaining the raw
native values for metadata, usage and detail consumers. The web native-session
surface renders that display model with `CloudReadOnlyThread`; mobile's native
session hook passes it to the existing `MessageBubble` component. Neither adds a
parallel transcript renderer.
Mobile also mounts the existing `PartDetailSheetHost` around those messages, so
compact tool cards can open their input/output/error details and an open sheet
continues to resolve the current live part rather than a stale captured value.

The native live reducer retains model/provider metadata, text and reasoning order,
files, tool input/progress/terminal states, errors, retry state, costs, tokens and
completion boundaries. Permission and question inventories live outside the
bounded diagnostic event history, so truncating that history cannot discard an
unanswered interaction or resurrect one already settled. An authoritative runner
inventory replaces the pending controls, including when that inventory is empty.

An initial upload may legitimately contain no canonical session entity yet.
Missing metadata therefore enters the same bounded native snapshot recovery as
incomplete parts; later live frames remain in ordered replay while metadata catches
up. A frame that exposes a missing tool or part is itself retained before its relay
cursor is accepted. Recovery keeps its snapshot revision/position requirement and
native part identity until authoritative state covers the gap. Neither an unchanged
snapshot nor a newer unrelated snapshot proves that a missing tool/result arrived.
Exhausted recovery remains an explicit error, not a complete empty transcript.

Native stored-media and tool-file references retain their original canonical
values. The native reader resolves only authorized asset mappings using the same
tenant-scoped grant, renewal and cancellation path as snapshot requests, and passes
resolved display URLs separately through `assetURLs`. Keys bind the display file
identity, native URI and MIME. Replacing non-content-addressed local file results
invalidates previously resolved bytes until a newer authoritative snapshot
reauthorizes them. Unresolved live attachments remain visibly incomplete; they do
not crash the transcript or silently expose local paths as fetchable display URLs.

Snapshot fetching, relay cursors, replay and recovery remain native-owned.
`session.moved` requires an authoritative canonical snapshot because its event does
not contain the previous native location/project binding. The SDK records the
expected canonical message identity in `pendingSnapshotMessageIDs` and retries
revision-pinned snapshots within the existing recovery bound. A stale snapshot
cannot clear that pending identity. Clients expose the incomplete state until the
canonical message arrives, or an explicit recovery error if the bound is exhausted.
The previous location is never invented from `origin.directory`. The existing
Cloud projector does not render location-switch notices, but the exact canonical
message and its metadata remain available through the shared source.

The browser extension currently has no native-sync inventory or session entry.
Its existing Cloud Agent v2 sessions already use the shared SDK conversation
pipeline; this integration does not introduce a new native-remote extension entry.

Each socket generation owns its frame queue, snapshot reads, and incomplete-transcript
recovery. Reconnect and close cancel those reads and release queued/replay payloads;
late results cannot publish or change the accepted relay cursor. A snapshot has a
two-minute total deadline and a 15-second deadline for each state, page, or blob request.
The raw queue and recovery replay share a 1,024-frame / 4 MiB estimated UTF-16 storage
budget. One active frame is additionally bounded to 512 KiB before JSON parsing.
These are retained-payload limits, not an exact JavaScript heap limit; the bounded
public event history and visible transcript also consume memory.

Backlog overflow preserves the last accepted cursor and reconnects for ordered relay
replay. A successful `subscribed` handshake clears the backlog error when the replay
restores a complete transcript. A relay reset or discarded incomplete-recovery replay
keeps an explicit `NativeSessionState.error` visible through subsequent connections
until the connection is closed. A revision-consistent snapshot alone cannot prove
that missing volatile live effects reached durable storage. Consumers must render
that error alongside the transcript, including when `connection` is `connected`;
the web native-session demo renders it as an alert. Recovery attempts are bounded,
and exhausted incomplete snapshots report an error rather than claiming completeness.
Specific authorization, deletion, and command failures appear alongside the integrity
warning. An individual oversized frame reports its size limit separately from a
combined backlog overflow.

The intentionally minimal web demo is `/native-remote` in development mode.
Its server page returns the not-found page outside development; a feature flag
cannot enable it in a deployed environment. The same-origin
`POST /api/native-remote/token` also requires development mode before authenticating
the web session and issuing a five-minute Kilo credential with credential exchange
disabled. Session-sync enforces all creator ACLs independently of the preview.
The preview defaults to the isolated local Worker at `http://localhost:8817`;
`NEXT_PUBLIC_SESSION_SYNC_URL` selects another development relay. Its connection
permissions are included in the web CSP only in development. The CLI and SDK
production endpoints are unchanged.
The mobile preview also requires a development bundle (`__DEV__`) and an explicit
`EXPO_PUBLIC_SESSION_SYNC_URL`. Release bundles expose neither its Profile entry
nor its route, regardless of remote feature flags.
Browser HTTP reads/commands allow bearer-authenticated CORS from `https://kilo.ai`
and `https://app.kilo.ai`, without cookies. `http://localhost:3000` is allowed only
when the Worker environment is `development`. Browser and React Native WebSockets
authenticate through the ticket subprotocol; CLI sockets use `Authorization: Bearer`.
URL tickets are rejected.

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

## Shared native history design

[The consolidation design](docs/native-history-consolidation.md) defines a proposed hosted history boundary.
It covers write authority, workload grants, replay, retention, deletion, migration, and rollback.
It does not authorize storage migration or change the current production backend.

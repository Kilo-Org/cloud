# Common raw-native history

## Status and scope

**Proposed; not implemented or approved for deployment.**
This document defines a possible common history data plane for native session sync
and hosted Cloud Agent sessions. Source inspection supports the constraints below;
it does not prove the proposed authorization, durability, migration, or capacity.
No storage implementation, deployment, or production migration is part of this design.

Share native contracts and projection first. Consolidating durable history is a
separate authority change. Do not merge orchestration, runtime supervision,
workspace snapshots, command queues, or local-first execution into the history service.

## Write authority

For an opted-in hosted session, a versioned common native-history store is the
**only durable raw-native transcript authority**. Evolve the session-sync data
plane rather than retaining a second hosted transcript store.

The hosted wrapper is the single active producer. Cloud retains execution admission,
lifecycle, pending control interactions, billing obligations, callbacks, and workspace
routing. Its Session DO stores history references and causal checkpoints, not a
second native transcript. Local CLI execution remains offline-capable.

Trusted Cloud registration selects `historyBackend=common-native-v2` before the first
native write. Existing sessions remain on their current backend by default.
Caller-supplied origin, tenant, or runtime version cannot select the authority.
History-service failure must not activate a fallback writer.

Here, raw history means lossless supported native session/message/part/portable-state
values, removals, and completeness evidence. It does not mean an indefinite archive
of every SSE packet or token delta. Preserve native metadata, files, costs, tokens,
and supported schema fields before display reduction. Store current entities plus a
bounded committed-mutation journal, not an unbounded token log.

Reuse the existing Kilo2 schemas in `session-ingest-contracts` and native snapshot
reconstruction through versioned transport adapters. Do not introduce a catch-all
runtime SDK or another display model.

## Current source constraints

Paths in this table are repository-relative. These are implementation constraints,
not claims that the proposed common-store behavior exists.

| Source | Constraint |
|---|---|
| `services/session-sync/src/dos/session-sync/session.ts` | Only the creator-owner is accepted. Source binding is immutable. Tombstones prevent re-registration. Tenant membership does not grant session access. |
| `services/session-sync/src/auth.ts` | Human/device exchange rejects delegated and service credentials. Current sync grants last at most five minutes. Hosted producers need a separate brokered capability. |
| `services/session-sync/src/protocol.ts` and the service README | Current batches have source positions, revisions, exact-body receipts, and entity-key page cursors. Ownership epochs, replica generations, and committed replay cursors below are proposed additions, not an existing takeover API. |
| Service README, assistant envelopes | Numeric ordinals, part counts/frontiers, and deferred-part checks distinguish complete messages from readable prefixes. |
| `services/cloud-agent-next/src/control-plane/session/conversation-events.ts` and `native-events.ts` | Cloud materializes keyed native messages/parts and buffers text. Some events are live-only. Existing persistence is not a full immutable SSE archive. |
| `services/cloud-agent-next/src/control-plane/session/session-do.ts`, `nativeSnapshot` | Cloud snapshots use a fence and log/update/removal phases. Status and pending interactions have separate authority. New runtime generations clear obsolete pending requests. |
| `services/cloud-agent-next/src/kilo-facade/native-event-tail.ts` | The tail opens live transport before snapshot paging, bounds buffering, revalidates identity, and reports unproven continuity rather than guessing. |
| `services/cloud-agent-next/wrapper/src/control-plane/kilo2-history.ts` | Current restore keeps up to 1,000 messages and 32 MiB; omissions and truncation can be tolerated. This is not proof of complete portable continuation. |
| `services/cloud-agent-next/src/control-plane/session/event-queries.ts` | Row IDs and mutation cursors differ. Native cost aggregation currently reads transcript rows. These consumers must move before raw writes are removed. |
| Cloud `session-do.ts` deletion paths and the service README | Cloud route/runtime teardown differs from the sync service's permanent tombstone, account-erasure index, quota release, and asynchronous blob cleanup. A Cloud wipe alone cannot prevent common-history resurrection. |

## Identity and ownership

| Term | Meaning |
|---|---|
| Tenant | Authenticated personal or organization storage/budget scope; never native JSON authorization. |
| History ID | Immutable logical history ID within a tenant. One native session per history; not a workspace ID. |
| Native session ID | Kilo's native ID, preserved verbatim, including child IDs. It is not an access credential. |
| Cloud root ID | Cloud orchestration identity, associated with explicit native child lineage. |
| Producer/source ID | Stable logical capture lineage. Survives verified restart; does not authorize takeover. |
| Run ID | Unique hosted runtime incarnation issued by Cloud. Replacement changes it; reconnect alone does not. |
| Ownership epoch | Monotone store-owned write-lease fence. Invalidates obsolete run/producer grants. |
| Replica generation | Opaque history incarnation changed by destructive repair, reset, or operational restore. Invalidates read/replay cursors; normal restart does not change it. |
| Checkpoint | Committed revision, manifest/coverage digest, and recoverability classification. Display completeness alone does not establish portability. |

Cloud durably binds tenant, creator, root, native session, parent lineage, history ID,
backend/schema version, producer, accepted run/epoch, and deletion state. The history
store keeps the matching immutable binding and current write lease. Registration is
idempotent only for an identical binding. Conflicts fail closed.

Each child has its own history and fence, authorized through explicit owned lineage.
Do not merge child message IDs into root history. Shared worktree membership is not
blanket raw-history access. V1 ingest conversion is outside this rollout; unsupported
v1 history must not appear as a successful empty v2 history.

### Restart and replacement

- Same-run reconnect retries exact pending bytes and reconciles the last receipt
  and predecessor. A socket reconnect does not change the epoch.
- For a new run, Cloud prevents further old-run work, then requests a compare-and-set
  lease transition using the expected epoch and checkpoint. The history store
  serializes this transition with writes. Only its returned epoch authorizes the
  new producer. Old grants cannot mutate, even before their TTL expires.
- A lost transition response is resolved using its persisted transition ID/run/epoch,
  not an unconditional second increment.
- Restore validates generation, native identity, schema, referenced bytes, complete
  parts, instructions, portable state, and coverage. New capture starts at zero in
  a new run-scoped position space. An incomplete restored database cannot delete
  previously committed entities merely because it omitted them.
- Local/hosted identity-preserving handoff is disabled initially. It requires
  separate authorization and fencing at a verified recoverable checkpoint.
  Unreachable or unverifiable ownership defaults to a new history/native-session
  fork with provenance, not takeover.
- Incomplete recovery is visible and read-only by default. Never automatically
  replay an ambiguous external tool effect.

## Brokered workload grants

Keep human/device exchange rules unchanged. Add a separate broker path authenticated
as Cloud infrastructure. Never put a human credential or general internal service
secret in the wrapper.

1. The wrapper authenticates to Cloud as the currently registered runtime. Cloud
   verifies root/child binding, current run, owner/account eligibility, organization
   policy, admission, and deletion state. Wrapper-supplied owner/org claims are not
   authoritative.
2. Cloud requests a grant for the exact pre-registered history and lease. Arbitrary
   registration, creator changes, and lease changes are separate Cloud-authorized
   broker operations, not wrapper capabilities.
3. Proposed claims: version, issuer/key ID, environment, dedicated workload audience,
   workload subject, tenant, creator/policy principal, history/native/root IDs,
   producer, run, ownership epoch, scopes, issued/expiry times, and grant ID.
   Default TTL: **60 seconds**, never beyond current run authorization. Refresh
   through Cloud only while the run remains authorized.
4. Producer scopes permit inspecting its predecessor/receipt, uploading/finalizing
   its own blobs, committing batches, and reading the specific restore checkpoint.
   They exclude listing, sibling access, arbitrary registration, handoff, grant
   issuance, impersonation, deletion, and account erasure.
5. Every mutation, including upload finalize, checks persisted run/epoch and the
   deletion fence. Every content read checks deletion. Fence grants and close
   subscriptions when authorization changes. Issuance/refresh bounds residual
   policy access to 60 seconds unless an immediate revocation fence is required.
6. User-facing readers use separately scoped adapter grants preserving Cloud ACLs;
   they do not borrow producer tokens. Initial hosted adoption is creator-private.
   Shared/viewer sessions stay on the old backend until explicit delegated-read
   policy preserves their real roles and revocation behavior.

Broker/dependency outage fails closed with a typed retryable availability error.
Stale run, revoked policy, wrong scope/tenant/environment, expiry, and tombstone are
terminal for that capability. Refresh cannot recreate a run or retry a command.
Do not log grants, raw values, or private blob URLs.

## Commit and state semantics

Commit identity is `(historyID, replicaGeneration, ownershipEpoch, runID, batchID)`.
The immutable payload carries its exact-byte digest, run-scoped predecessor and
through-position, changes, schema version, and checkpoint coverage. Sparse capture
positions are valid; they are not native message sequence numbers.

One local transaction validates binding, lease, tombstone, and predecessor; applies
entities/removals and blob references; appends a journal entry; advances global
history revision; and records receipt/checkpoint. Blob verification and tenant RPCs
remain outside that transaction with durable attempt/reservation fencing. Recheck
epoch and deletion after external work.

A receipt means durable commit, not delivery or execution. It includes identity,
generation, run/epoch, predecessor/through, revision, batch ID, digest, and commit
time. Exact-byte retry returns the original receipt. Reusing an ID with different
bytes fails. Receipt eviction never makes an old predecessor eligible to apply;
return `receipt_expired` or predecessor conflict when identity cannot be proved.
Never acknowledge skipped oversized, unsupported, or missing-blob entities.

The wrapper retains a bounded exact-byte pending outbox in existing durable local
runtime storage until acknowledgement. This is a delivery buffer, not another
queryable authority. Proposed unacknowledged cap: **4 MiB**. Before overflow, Cloud
stops new-turn admission and pauses/stops the run with `history_unavailable`; it
must not drop data. Destruction can lose an uncommitted suffix: expose incomplete
coverage, not a zero-RPO promise. Final turn completion requires its checkpoint receipt.

Current state retains full canonical session/message/part and required portable
instruction/inbox/asset values. Keep assistant count/frontier/deferred checks.
Distinguish revert, part removal, and consumed intent from maintenance cleanup.

### Journal and live previews

Retain committed mutations/removal intent, not every token. Proposed journal bounds:
**256 commits, 16 MiB, or 24 hours**, whichever expires first. Evict whole commits.
An oversized replay commit requires explicit snapshot reset, not a partial journal
entry. Charge replay and snapshot overhead to quotas. Journal expiry does not delete
current canonical state.

Speculative live events use separate bounded transport, run/event sequence, and
`durable=false`. They do not advance durable cursors or prove tool completion.
After disconnect/reset, replace provisional state from a durable snapshot and show
an uncommitted suffix as pending/incomplete. Disable unsupported previews rather
than weakening durable capture.

## Snapshot and cursor semantics

Keep these distinct types:

| Position | Purpose |
|---|---|
| Native message sequence/part ordinal | Transcript layout and order. |
| Run/source position | Producer write predecessor. |
| Global history revision | Durable commit order across run transitions. |
| Snapshot page token | Opaque tenant/history/generation/pinned-revision/entity-key/expiry continuation; not an access grant. |
| History replay cursor | Opaque history/generation/committed-revision continuation. |
| Cloud lifecycle cursor | Cloud-owned operation/lifecycle order. |

A snapshot pins entity state at revision R and reports identity, run/epoch, coverage,
manifest digest, and completeness. Proposed pin TTL: **60 seconds**, with bounded
pins and bytes. Expiry returns `snapshot_expired`; restart instead of mixing pages.
An implementation may conflict/retry rather than retain long MVCC history, but must
not claim a successful pinned snapshot while pages drift.

Register subscription before paging, read its fenced snapshot, then release committed
journal entries strictly after R. Duplicate revisions are idempotent. Missing replay
interval, generation mismatch, expired pin, or buffer overflow returns
`resnapshot_required`. An empty page does not establish completeness. Backend/cursor
version changes force a clean snapshot; never guess a mapping from old Cloud IDs.

### Cloud lifecycle causality

Cloud keeps its lifecycle journal and small references to history generation,
revision, run, and checkpoint digest. Native order stays in the history store.
Finalize terminal success/stop only after the referenced final checkpoint receipt.
If the runtime dies first, record failed/stopped with incomplete history.

Receipt observation is an idempotent Cloud operation keyed by run/transition ID.
A crash after native commit is repaired by inspecting its checkpoint/receipt; a crash
before commit cannot advance Cloud's history watermark. No cross-object atomic
transaction is assumed.

Cloud/current-run state remains authoritative for executable questions/permissions.
History observations of requests/replies are not actionable grants. Clear stale
pending controls before accepting new-run replies. Assemble transcript and Cloud
status/interactions using matching run/version; retry or report unavailable if the
run changes. Do not advertise a wall-clock merge as a global total order.

## Retention, quotas, deletion, and privacy

Preserve local sync's existing limits: 512 KiB batches, 64 changes, 64 KiB inline
entities, 8 MiB blobs, 64 MiB inline total, 256 MiB blob total, 100,000 entities,
10,000 blob entries, and 256 receipts. Personal admission defaults remain 10,000
sessions/100 GiB; organization defaults remain 200,000 sessions/2 TiB. Replay/pin
overhead needs an explicit reserved budget included in tenant accounting.

Do not shorten existing Cloud retention or restore coverage through migration.
Hosted pilot histories have no new automatic idle expiry until the applicable Cloud
contract is confirmed; quota and explicit deletion/erasure still apply. Local sync's
90-day accepted-write idle policy is unchanged.

Do not introduce storage billing during the pilot. Cloud's billing ledger remains
authoritative. Preserve native cost fields for display/support. Move transcript-row
cost/support readers to the versioned adapter or reconciled aggregates before
removing raw writes. History cleanup cannot discard undelivered billing obligations.

Quotas include values, blobs/reservations, journal, and pinned snapshots. Oversize or
quota denial is explicit and nonretryable without changed admission. Existing committed
state remains readable. Do not create another history to bypass quotas. Separate
logical quota release from physical cleanup.

### Deletion protocol

1. Cloud durably records deletion intent and exact history/child manifest, fencing
   new execution and grant issuance. Preserve a minimal permanent non-content
   deletion locator outside the transcript wipe.
2. The store durably tombstones the history and fences its epoch. Reject content
   reads/writes/renewals and close subscriptions. Owner inspection may return only
   deletion metadata. Acknowledge deletion acceptance only after this fence; resolve
   lost responses idempotently.
3. Cloud settles open turns/report/callback obligations and performs existing
   runtime/workspace cleanup under the requested scope. Retry cleanup separately;
   failure cannot restore content access. Transcript deletion does not imply file
   or credential deletion.
4. Purge entities, journal, pins, and blobs through fenced cleanup attempts. In-flight
   finalize cannot resurrect data. Track tombstoned and physically purged separately.
5. Extend creator indexing and permanent account admission fences to hosted histories
   before account anonymization. Include the user's created organization histories,
   not other members' histories merely sharing a tenant/worktree. Organization
   ownership/retention exceptions need explicit policy approval.
6. Reapply deletion/account-erasure fences before restored data is exposed or grants
   are minted, including migration and rollback copies.

The service documents 30-day platform SQLite backups and no R2 backup. Live erasure
does not shorten platform backup retention. Do not claim instant backup erasure.
Local removal stays local-only. Offline-device propagation is separate from a cloud
tombstone. Blob hashes do not authorize cross-session access.

## Migration and rollback

### Prerequisites

Freeze schema and supported event matrix. Inventory conversation/history restore,
cost/support, children, exports, interactions, and ancillary commit readers. Prove
canonical adapter parity. Review workload grants, epoch fencing, ACLs, deletion, and
restore coverage before hosted adoption. Existing local wire v1 remains unchanged.

### New sessions first

Trusted registration selects the backend once. Common-store sessions suppress native
transcript persistence in Cloud while retaining orchestration records. Old sessions
use their legacy adapter. A flag can stop creating new common-store sessions; it
cannot redirect existing ones. Isolated qualification precedes any production proposal.

### Optional stopped-session migration

Default: do not migrate existing sessions automatically.

1. Quiesce and fence the legacy runtime/control path; flush buffered native writes
   and close stale tails. Export root/child mapping, canonical digest, coverage,
   omissions, metadata, and final legacy cursor.
2. Stage a non-readable, non-writable target under a stable migration ID. Copy and
   validate entities/assets/counts/order/digests/coverage while runtime writes remain
   stopped. Staging is not authoritative.
3. Compare canonical exports and projected display values. Reject incomplete or
   unsupported identity-preserving continuation. Preserve known legacy omissions.
4. Activate the target and compare-and-set the Cloud backend pointer using the
   expected legacy migration fence. Keep execution stopped until both persisted
   states confirm the transition. A durable migration record resolves crash windows;
   authority never depends on which store responds first.
5. Retain the frozen, access-restricted, deletion-aware legacy copy for a proposed
   seven-day rollback window. It is not a fallback reader or writable replica.
   Purge after approved expiry. Temporary migration copies are not dual persistence.

Before activation and new commits, staging can be discarded and verified legacy
authority reopened. After activation, code rollback must retain compatible common
history access. Never point back to stale legacy data. Reverse migration requires
stopping/fencing the producer and repeating a verified export/cutover from the latest
checkpoint. If unsupported, keep history readable but execution disabled.

Deletion cancels migration and purges staging/frozen copies. Reconcile lost transition
responses while execution remains fenced. Timeouts never trigger old-backend fallback.

## Four observable states

| State | Contract | Acceptance observation |
|---|---|---|
| Empty | Authorized registered history with complete revision-0 state and zero messages. Missing, deleted, unsupported, or incomplete is not empty. | Correct distinct result for each case; no inherited v1 or child transcript. |
| Happy | Receipt-backed snapshot plus post-fence replay preserves metadata, files, layout, and current-run interactions. | Exact canonical/asset digests and display parity; acknowledged commits represented once; verified stop/restore/replacement coverage. |
| Retryable | Typed dependency/overload/lost-ACK/snapshot/replay recovery; keep previous committed state. Retry exact bytes or resnapshot. Unknown command effects stay unknown. | Inject faults before/after commit and between pages/transitions; same receipt, no duplicate apply, bounded queues/deadlines, explicit reset. |
| Terminal | Forbidden/revoked/stale-run/conflict/deleted/unsupported/quota errors cannot silently retry or recreate. | Distinct machine codes; no unauthorized bytes, mutations, position advancement, or obsolete interaction replies. Tombstone survives restart/import/rollback. |

Incomplete coverage is a persistent attribute of a readable result. It blocks a
complete-checkpoint claim and automatic identity-preserving continuation by default.
An explicitly authorized partial-context fork is a separate action, not a retry.

## Acceptance measurement

These are proposed gates, not measured results or production SLAs.

### Correctness and access

Use identical synthetic captures for legacy and common adapters: user files,
text/reasoning, tool denial/error/running/completed, compaction/revert/removal, sparse
numeric ordinals, deferred/missing/oversized blobs, costs/tokens, child lineage, and
pending interactions. Compare full canonical values with documented envelope-only
exclusions, asset byte hashes, native order, and existing display projection.
Require zero unexplained differences, missing acknowledged commits, silent truncation,
false-complete snapshots, or cross-history leakage.

Exercise snapshot/write races, duplicate/reordered events, stale/repeated cursors,
receipt eviction, competing leases, restart/replacement, old tokens after fencing,
blob-finalize/deletion races, quota RPC uncertainty, every migration transition crash
window, Cloud/native ACK gaps, erasure, and pre-deletion restore. Independently inspect
persisted outcomes rather than trusting producer/consumer success counters.

Access cases include personal/org creator, same-org non-owner, explicitly permitted
viewer if enabled, cross-tenant, wrong root/child, environment/audience/scope mismatch,
expiry/revocation, replaced run, and erased/deleted identity. Require zero unauthorized
content or mutations, including blobs, subscriptions, inspection, and migration copies.

### Capacity and cost

Freeze source/config hashes, versions, fixture seed, workloads, warm-up, measurement
window, and fixed drain deadline. Keep scheduled work in denominators; report late,
missing, rejected, and source-underproduced work explicitly.

Start in isolation with 1/10/100 hosted sessions, 1/10 readers per history, and a
100-reader hot-history diagnostic. Cover tiny/median/near-limit histories, more than
1,000 messages, 8 MiB assets, and concentrated organization admission. This matrix
alone does not establish production capacity.

Compare like-for-like legacy/common runs: offered/admitted/completed work, durable
bytes, SQL/R2 operations and bytes, tenant reservations, broker/account checks, CPU,
peak retained memory, queues, receipt latency, complete-snapshot latency,
reconnect/resnapshot counts, and restore latency/coverage. Separate elapsed request
time, CPU, SDK callback time, and actual view commit. Do not add overlapping metrics.

Proposed pilot budgets: p95 receipt <=1 second; p99 <=3 seconds; p95 complete 1 MiB
snapshot <=2 seconds; no more than 20% regression in like-for-like stop/restore
latency or storage/request cost per session-hour. Quantify idle grant-renewal cost
separately. A failure cannot be hidden by changing workload or denominator.

During broker/history outage, admission stops before the 4 MiB pending cap. Require
zero silently dropped acknowledged data and visible uncommitted coverage. Measure
tombstone acknowledgement separately from purge. Proposed isolated deletion gate:
access fenced after acknowledgement; live cleanup <=24 hours with retry injection;
backup retention disclosed. Unmeasured cleanup blocks an erasure-complete claim.

### Release gates

- Canonical/display parity and all four states pass through the real wrapper,
  history service boundary, and consuming client adapter.
- Reviewed grants/fences and negative access tests pass with isolated synthetic data.
- Stop/restore/replacement, deletion/erasure, and migration/rollback crash paths pass
  without two active authorities.
- Agreed latency/cost budgets pass; transcript-derived consumers are migrated or
  explicitly remain in legacy cohorts.
- Product/security owners resolve material policy choices before production rollout.

## Material unresolved decisions

1. **Hosted retention and account departure:** Cloud retention contract, organization
   ownership, erasure exceptions, and minimal tombstone lifetime. Default: no new
   hosted idle expiry or automatic existing-session migration.
2. **Shared/viewer access:** exact delegated roles and revocation deadline. Default:
   creator-private hosted cohort; no access broadening.
3. **Partial continuation:** whether today's bounded restore can continue the same
   identity, required portable state, and ambiguous external effects. Default:
   incomplete remains readable; no automatic same-identity resume.
4. **Live durability:** acceptable uncommitted suffix loss versus synchronous execution
   gating. Default: provisional previews, receipt-gated final completion, bounded
   outage admission; no zero-RPO live promise.
5. **Audit and total order:** original-event archive or global lifecycle/transcript
   sequencing requirements. Default: canonical state, bounded committed replay,
   and causal references; no permanent token log or invented global cursor.
6. **Commercial and operating budgets:** hosted quotas/pricing, replay/pin overhead,
   renewal cost, rollback-copy period, latency thresholds, and purge SLO. The values
   above are proposed pilot defaults, not customer policy changes.

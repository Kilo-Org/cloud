# Native session synchronization

## Scope

This service synchronizes native v2 sessions from an opted-in Kilo CLI workspace.
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
- Workspace synchronization requires explicit opt-in.
- The service can decrypt stored content and enforces personal or organization access.
- Native v2 supplies the live protocol; old sessions use a separate historical conversion path.
- Retain the current transcript and portable state until deletion, subject to explicit quotas.
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
A grant lasts at most a minute, never beyond the original credential, and has the dedicated `session-sync` audience.
Do not repeat the account-database lookup for every upload packet.

Registration supplies `{version, sourceID}`.
The creator identity comes from the grant, not the registration body.

A batch supplies `{version, sourceID, batchID, after, through, changes}`.
`after` is the last acknowledged source position.
`through` covers the complete captured change range in this batch.
Source positions can be sparse after local coalescing.
The service checks that `after` matches the committed source position.

Each change has a kind and an entity ID.
The portable kinds are `session`, `message`, `inbox`, `instruction-entry`,
`instruction-state`, `instruction-blob`, and `asset`.
An upsert carries an inline JSON value or a verified blob reference.
A removal carries its semantic cause; maintenance is not a deletion intent.
Inbox delivery uses the `consumed` removal cause, not cancellation.

Batch IDs identify immutable payloads.
Retrying an acknowledged batch returns its receipt without applying it again.
Reusing an ID with different content fails.
An obsolete source, conflicting predecessor, or deleted session fails explicitly.
A successful receipt means storage has committed, not that a background task has started.
The receipt includes the SHA-256 digest of the exact UTF-8 request body.
Retry the stored bytes rather than serializing the packet again.
Session inspection exposes `lastReceipt` so a producer can recover a lost acknowledgement or detect a conflicting restored database.

Page reads report the revision they observe.
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

The initial storage policy is explicit:

| Resource | Bound |
|---|---|
| Batch body | 512 KiB |
| Changes per batch | 64 |
| Inline entity body | 64 KiB |
| Blob body | 8 MiB |
| Stored and reserved blob bytes per session | 256 MiB |
| Blob entries per session | 10,000 |
| Inline entity bytes per session | 64 MiB |
| Current entities per session | 100,000 |
| Retained batch receipts | 256 |

Unreferenced ready blobs count against the storage policy until session deletion in the initial delivery.
An old receipt leaving the bounded tail never makes its packet eligible to apply again.

A tombstone survives entity cleanup.
A deleted ID cannot be registered again.
An operational restore must reapply deletion fences before exposing restored data.
Document backup-retention behavior before production rollout.

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

`wrangler.jsonc` remains local-only. Staging uses a separately rendered
`.wrangler/wrangler.staging.json`, following the config-rendering pattern in
`cloud-agent-next/test/e2e/deploy/render-e2e-worker-config.mjs`. Neither rendering
nor the dry-run command creates resources or deploys. Automatic deployment
continues to exclude this service.

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
3. A dedicated bucket named `session-sync-staging`, in the same verified account.
   Verify that its public development URL is disabled, it has no public custom
   domains, and it is not exposed by another Worker or public gateway. Only this
   service may access its synthetic session blobs.
4. Two independently generated signing secrets, each at least 32 random bytes,
   recorded in the shared engineering vault and installed as Workers-scoped Secrets
   Store entries `session-sync-staging-nextauth` and `session-sync-staging-grants`.
   Record only the store ID and entry names in configuration. Never copy a
   production auth secret, share the two values, print values, or put them in the
   resource manifest. The first signs synthetic Kilo credentials; the second
   signs only this staging deployment's one-minute sync grants.
5. Confirm that `session-sync-staging` is a dedicated Worker identity, with no
   existing production deployment or production routes. Its SQLite namespace is
   created by the eventual separately authorized deployment's `v1` migration;
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
Both secrets use the service's existing Secrets Store `get()` support; absent
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

Provision the Worker, SQLite Durable Object namespace, private R2 bucket, and authentication binding.
Store shared secrets in the shared engineering vault and Cloudflare Secrets Store.
Do not copy production credentials into local examples or test fixtures.
Configure a deployment-specific secret for sync grants.
Verify account and organization authorization on an isolated stack before deployment.
Complete account deletion, backup retention, quota policy, and rollout monitoring before public adoption.
Automatic deployment excludes this service until its real bindings and secrets are provisioned.

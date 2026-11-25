# audit-relay

The audit pipeline sink (design sections 8.1, 8.2 and 8.5). Producers commit an audit row with the
transaction it describes and relay it to the `kilo-audit` queue as one gzipped `AuditBatch` from
`@kilocode/sts-contracts`. This Worker turns that stream of batches into two sinks:

- **Axiom** (`kilo-audit`) — the hot, queryable copy, 90 days.
- **R2** (`kilo-audit-archive`, EU jurisdiction, bucket-lock rule of 400 days) — the immutable
  evidence archive, one gzip object per batch, hash-chained per stream.

It also signs hourly checkpoints over the chain heads and verifies the archive daily and monthly.
The same Worker serves STS now and UTS later; neither producer lives here.

## Message path

One `StreamDO` per audit stream (`idFromName(stream)`) is the single writer for that stream. It
holds the head `{ seq, hash }` and decides what a batch means before any sink is touched:

| State of the batch | Result |
|---|---|
| `fromSeq === head.seq + 1` | accepted, whole batch archived |
| `toSeq <= head.seq` | duplicate: compared with the archive (below), then acked with no archive write; an owed hot-copy range inside it is re-ingested |
| `fromSeq > head.seq + 1` | gap: `message.retry({ delaySeconds: 30 })`, because queues do not preserve order; pages once if the gap persists (below) |
| `fromSeq <= head.seq < toSeq` | accepted, only the `head.seq + 1 .. toSeq` suffix is archived and ingested |

For an accepted batch the Durable Object, in order:

1. `hash = sha256(prevHash || canonicalJson(batch))`, starting from a 64-zero genesis hash.
2. Writes `streams/<stream>/<toSeq, 12 digits>.json.gz` holding `{ batch, prevHash, hash }`. A
   bucket-lock rule rejects the write to an existing key; that counts as success only when the
   stored object's `hash` matches. A different hash (or an object that does not decode) is a
   second writer: the batch is dropped and the page goes out.
3. Records the head in the registry object, then commits the head **and** a `pending` hot-copy row
   for `fromSeq..toSeq` in one storage write. The archive is the evidence store, so the batch is
   committed as soon as its object is stored, and the delivery intent can never be lost behind an
   advanced head.
4. Ingests the events into Axiom (`POST {AXIOM_URL}/v1/datasets/{AXIOM_DATASET}/ingest`) with
   `_time` set from the CloudEvents `time`; the event `id` stays in the body as the dedupe key.
   Success deletes the row.

Axiom is the hot copy and cannot hold the stream hostage. Each row is
`{ stream, fromSeq, toSeq, reason, recordedAt }`, stored under its own key (`hot_copy:<toSeq>`);
rows are the archived ranges, so they never overlap. A failure replaces `reason` with
`axiom_rejected`, `axiom_unavailable`, `secrets_denied` or `secrets_unavailable`, leaving
`pending` only for a range whose ingest was interrupted. A retryable failure (`axiom_unavailable`
for a network error, 401, 403, 408, 429 or 5xx; `secrets_unavailable`) still retries the message,
and the redelivery finds the head already advanced: it ingests the events of the owed rows the
message carries, deletes the rows it fully covers, and acks without touching R2. A 401 or 403 is
retryable because a token rotation produces them until the secrets client revalidates (at most
240 s). A non-retryable failure (`axiom_rejected`, `secrets_denied`) acks the message and pages;
the row stays until a replay job re-ingests that range from the archive (`hotStoreGaps(limit)` to
read, oldest first and pending rows included, and `clearHotStoreGap(fromSeq, toSeq)` to mark done).
One rejected batch therefore never stalls the stream: the next batch is archived normally.

A retry re-runs the same steps idempotently: the archive key already holds the same hash, and Axiom
receives the same event ids. Secrets come from STS through `@kilocode/secrets-client`
(`src/secrets.ts`): `AUDIT_RELAY_AXIOM_TOKEN` and `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. One client
serves the whole isolate, keyed by the binding, so a later batch revalidates with `If-None-Match`
and steady state costs one `not_modified` round trip per 240 s. A read failure surfaces as
`SecretUnavailableError`; `retryable` maps to `secrets_unavailable` (message retried) and a
non-retryable `denied`, `missing` or `not_granted` to `secrets_denied` (hot-store gap, message
acked). Nothing logs or pages an event payload, a token, or a head value other than sequence and
hash.

`canonicalJson` (sorted keys, no insignificant whitespace) is the one serialisation for both the
chain hash and the checkpoint signature. Changing it is a chain migration, not a refactor.

### Duplicates

A redelivered batch is byte-identical to the one archived, so the StreamDO reads the archived
object that ends at the duplicate's `toSeq` before acting on it. A duplicate that covers the whole
object must re-hash, trimmed to the object's range, to the stored chain hash; one that covers only
a suffix of the object (the producer split differently) must serialise like the archived events.
A mismatch (`content`), a `toSeq` no object ends at (`unaligned`) or an object that does not decode
(`corrupt`) pages and acks the message without ingesting anything from it. An R2 failure during
the comparison retries the message. Each duplicate therefore costs one R2 read.

### Stalled gaps

The StreamDO keeps one record per stream of the sequence it waits for (`head.seq + 1`), when it
first turned a batch away for it, and how many batches it turned away. When the same gap has
turned away **10** batches **and** is **5 minutes** old, the next batch is retried as usual and also
pages, once per gap. Both thresholds must hold: queue concurrency routinely delivers a burst of
later batches first, which reaches the count in seconds, while one stuck batch retried every
30 s reaches both together, around the time its `max_retries: 10` sends it to the DLQ. Closing the
gap (the head advances) starts the next gap's count from zero.

### Dead letters

A message that exhausts its retries lands in the DLQ. The DLQ consumer writes each message's raw
bytes to `dead-letter/<stream or unknown>/<enqueue time>-<message id>.gz` in the archive bucket,
pages once per consumer batch with the stream, sequence range, attempt count and key (never the
payload), and only then acks. A failed R2 write retries the message every 5 minutes, up to the
Queues maximum of 100 retries. A main-queue body that does not decode is kept the same way under
`dead-letter/unknown/` instead of being dropped.

A dead-lettered batch stalls its stream: every later batch gap-retries behind it and dead-letters
in turn. To recover, re-send the stored objects' bytes to the main queue as `bytes` messages,
lowest sequence first; the StreamDO archives the missing batch and dedupes the rest.

## Checkpoints and verification

- Hourly (`0 * * * *`): the registry's heads are serialised as
  `{ schemaVersion, time, streams: [{ stream, seq, hash }] }`, signed with the Ed25519 key inside
  `SignerDO`, and written to `checkpoints/<ISO hour>.json` together with `keyId` and `signature`.
  The private key is generated in the Durable Object, kept in its storage as PKCS#8, and never
  returned by an RPC method. Ed25519 is deterministic, so a repeated run in the same hour with
  unchanged heads rewrites an identical file.
- The public key set is served at `GET /.well-known/audit-checkpoint-keys.json`
  (`https://audit-relay.kiloapps.io/.well-known/audit-checkpoint-keys.json`). `kid` is the RFC 7638
  thumbprint of the JWK.
- `VerifierDO` owns verification. A cron only starts a pass; the pass then walks the archive in
  bounded slices, one per Durable Object alarm, with a per-stream cursor saved between slices. A
  slice reads at most 1,000 objects (one R2 `GET`, a gunzip, a schema parse and a SHA-256 each), so
  it stays inside the alarm's 30 s CPU and 10,000-subrequest limits, and the next alarm follows at
  once. Each slice reads the registry heads and walks a stream only up to its head, so objects
  archived during a pass belong to the next one.
- Daily (`30 3 * * *`): the pass anchors on the last checkpoint a daily pass verified (the genesis
  hash before the first one) and lists each stream with `startAfter` that checkpoint's position, so
  it reads only what was archived since. Both the anchor and the newest checkpoint must carry a
  valid signature under the published key, and every stream's chain must land on the newest
  checkpoint's `{ seq, hash }` at an object boundary. Only when every stream verified does the pass
  record the newest checkpoint as the next anchor; a failure leaves the anchor where it was, so the
  next day repeats the same range and pages again.
- Monthly (`0 4 1 * *`): a full pass from the genesis hash of every stream, covering the objects the
  daily pass trusts through its anchor, with the same newest-checkpoint check. The daily cron pages
  while no full pass has completed for 35 days.
- A slice that throws (R2 or a Durable Object hop) retries a minute later; the fifth consecutive
  failure ends the pass with `archive_read`. A mismatch, a failed signature, an unreadable or
  missing object, a stream in the checkpoint but not the registry, or an archive that ends short of
  the registry head ends the pass and pages `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. The text begins with
  `bot: ` and carries only the reason, stream name, sequence and key. `VerifierDO.status()` returns
  the running passes, the anchor, and each kind's last result.

## Bindings and configuration

| Binding | Value |
|---|---|
| `AUDIT_STREAM` | `StreamDO`, one instance per stream |
| `AUDIT_REGISTRY` | `RegistryDO`, the stream index (one key per stream head) the checkpoint and verify jobs read |
| `AUDIT_SIGNER` | `SignerDO`, holder of the checkpoint signing key |
| `AUDIT_VERIFIER` | `VerifierDO`, the daily and full verification passes and the verified anchor |
| `AUDIT_ARCHIVE` | R2 `kilo-audit-archive` (staging `kilo-audit-archive-staging`), EU jurisdiction |
| `STS` | service `sts` (`sts-staging`), entrypoint `SecretsBroker`, `props.caller` = `audit-relay` in every environment (each STS deployment serves one environment) |
| Queue consumer | `kilo-audit` → DLQ `kilo-audit-dlq` (staging `kilo-audit-staging` / `kilo-audit-staging-dlq`) |
| `AXIOM_DATASET` | `kilo-audit` (staging `kilo-audit-staging`, local `kilo-audit-local`) |
| `AXIOM_URL` | `https://api.axiom.co` |
| `AUDIT_ENVIRONMENT` | `production` / `staging` / `local` |

Retries are bounded: `max_retries: 10` with `retry_delay: 60`, and a gap retry consumes one of
them. A message that exhausts them lands in the DLQ, whose consumer keeps it in R2 and pages
(above); the DLQ consumer itself has `max_retries: 100` with `retry_delay: 300`.

## Production prerequisites

Run these once per environment before the first deploy. `wrangler` is the workspace pin
(`pnpm exec wrangler` from this directory).

1. **Queues and the DLQ** (the consumer attachment comes from `wrangler.jsonc`):

   ```sh
   pnpm exec wrangler queues create kilo-audit
   pnpm exec wrangler queues create kilo-audit-dlq
   pnpm exec wrangler queues create kilo-audit-staging
   pnpm exec wrangler queues create kilo-audit-staging-dlq
   ```

2. **R2 bucket in the EU jurisdiction with 400-day lock rules** on the archive, the checkpoints and
   the dead letters:

   ```sh
   pnpm exec wrangler r2 bucket create kilo-audit-archive --jurisdiction eu
   pnpm exec wrangler r2 bucket create kilo-audit-archive-staging --jurisdiction eu

   for bucket in kilo-audit-archive kilo-audit-archive-staging; do
     pnpm exec wrangler r2 bucket lock add "$bucket" \
       --name archive-400-days --prefix streams/ --retention-days 400
     pnpm exec wrangler r2 bucket lock add "$bucket" \
       --name checkpoints-400-days --prefix checkpoints/ --retention-days 400
     pnpm exec wrangler r2 bucket lock add "$bucket" \
       --name dead-letter-400-days --prefix dead-letter/ --retention-days 400
   done
   ```

   The copy of each checkpoint outside the Cloudflare account, which keeps the proof past the lock
   rule, is a separate task owned by Anaconda security.

3. **Axiom dataset and ingest token**: create the dataset `kilo-audit` (staging `kilo-audit-staging`)
   with 90-day retention, and an Axiom API token with ingest-only access to it. Store the token in
   Infisical project `kilo`, environment `production` (resp. `staging`), folder
   `/workloads/audit-relay`, as `AUDIT_RELAY_AXIOM_TOKEN` (design 4.2).

4. **Slack paging webhook**: store it in the same folder as `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`.

5. **STS policy**: add the workload `audit-relay` to the policy file of each STS environment with
   exactly these two secrets, and deploy STS before this Worker. `props.caller` is `audit-relay` in
   every environment block, so the serving STS deployment's environment must match
   `AUDIT_ENVIRONMENT`.

6. **DNS**: the `custom_domain` route creates `audit-relay.kiloapps.io`
   (`audit-relay-staging.kiloapps.io` for staging). If the published key set has to live at a
   different origin, change the route and update the recorded key-set URL.

Deploy prerequisites are what make the sinks immutable: without the lock rules, a rewritten archive
object would pass verification, and without an ingest-only Axiom token, a compromised Worker could
read the hot copy.

## Local development and tests

```sh
cp .dev.vars.example .dev.vars   # fill AUDIT_RELAY_LOCAL_SECRETS
pnpm dev                        # wrangler dev --env local
```

In `local` the Worker reads both secrets from `AUDIT_RELAY_LOCAL_SECRETS` (a JSON object) instead of
STS. A local run has no `sts-local` to call (it needs a manager identity and Infisical access), so
this override stays; the gate is `AUDIT_ENVIRONMENT === 'local'`, which no deployed environment
sets.

```sh
pnpm test        # vitest-pool-workers
pnpm typecheck
pnpm lint
```

The suite covers in-order delivery, duplicates (matching, a matching suffix, forged content, an
unaligned range), gap-then-fill, a stalled gap that pages once, partial overlap, an Axiom failure
retried without a second archive write, Axiom status classification, a rejected batch that leaves a
hot-store gap while the next batch is still archived, a crash between the commit write and the
ingest whose owed range the redelivery replays, a locked key with the same, a different and an
undecodable object, dead letters kept in R2 and paged without the payload, an undecodable
main-queue body kept the same way, a failed dead-letter write retried, checkpoint signing verified
with the published key, the bounded chain walk (budget pause and resume, `startAfter` the anchor,
a checkpoint inside an object or with another hash, an archive short of the head), and one
verifier scenario across slices: the first daily pass from genesis, a daily pass that reads only
the objects above its anchor, a full pass that finds tampering below the anchor, tampering above
the anchor that keeps the anchor in place, a forged checkpoint, and the 35-day full-pass page. The
test config sets `AUDIT_VERIFY_SLICE_OBJECTS` to 2 so every pass resumes from its cursor. Axiom and
Slack are recorded and answered by a stubbed `fetch`.

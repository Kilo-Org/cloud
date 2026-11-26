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
| `toSeq <= head.seq` | duplicate: compared with the archive (below), then acked with no archive write and no ingest |
| `fromSeq > head.seq + 1` | gap: `message.retry({ delaySeconds: 30 })`, because queues do not preserve order; pages once if the gap persists (below) |
| `fromSeq <= head.seq < toSeq` | accepted, only the `head.seq + 1 .. toSeq` suffix is archived and ingested |

Every archived batch is acked: once its object is stored, nothing about the hot copy holds the
message. Only a gap and a failed archive write or duplicate check (R2) retry it.

For an accepted batch the Durable Object, in order:

1. `hash = sha256(prevHash || canonicalJson(batch))`, starting from a 64-zero genesis hash.
2. Writes `streams/<stream>/<toSeq, 12 digits>.json.gz` holding `{ batch, prevHash, hash }` with a
   create-only put (`If-None-Match: *` in `onlyIf`; R2 returns null instead of storing when the
   key is taken,
   https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations),
   and the bucket-lock rule also rejects a write to an existing key. A taken key counts as success
   only when the stored object's `hash` matches. A different hash (or an object that does not
   decode) is a second writer: the batch is dropped and the page goes out.
3. Records the head in the registry object, then commits, in one atomic storage write, the head,
   a `pending` hot-copy row for `fromSeq..toSeq`, and, when no alarm is scheduled, an alarm 5
   minutes out. The archive is the evidence store, so the batch is committed as soon as its object
   is stored, and the delivery intent can never be lost behind an advanced head.
4. Ingests the events into Axiom once (`POST {AXIOM_URL}/v1/datasets/{AXIOM_DATASET}/ingest`)
   with `_time` set from the CloudEvents `time`; the event `id` stays in the body as the dedupe
   key. Success deletes the row. A failure leaves the row to the alarm and the message is acked.

### Hot copy

Axiom is the hot copy and cannot hold the stream hostage. Each owed row is
`{ stream, fromSeq, toSeq, reason, recordedAt }`, stored under its own key (`hot_copy:<toSeq>`);
rows are the archived ranges, so they never overlap, and `recordedAt` stays the archive time. A
failure stamps the row with `axiom_unavailable` (network error, 401, 403, 408, 429 or 5xx; a 401
or 403 follows a token rotation until the secrets client revalidates, at most 240 s),
`axiom_rejected` (400, 413 or 422, the statuses about the payload), `axiom_refused` (any other
4xx, such as a missing or renamed dataset), `secrets_unavailable`, `secrets_denied`,
`archive_unavailable` or `archive_unreadable`.

The StreamDO alarm owns every owed row. It delivers up to 50 rows per run, oldest first, reading
each row's events from its **archive object**, never from a queue message, so a forged redelivery
can never put events into Axiom. A run that listed a full page re-arms at once. A stream-wide
failure stops the run and re-arms with backoff: 30 s doubling per failed run, capped at 15
minutes, with jitter in [0.5, 1). While it is recorded, a new batch skips its own ingest and
leaves the row to the alarm, so an outage costs one Axiom call per stream per backoff step
instead of one per batch.

Only two failures can belong to one row, and the row is then **parked**: moved to
`hot_copy_parked:<toSeq>`, which the alarm never lists, so any number of them cannot block or
slow the rows behind them.

- `archive_unreadable` (the row's archive object is missing, does not decode, or no longer starts
  at the row's `fromSeq`) parks at once: the archive changed under the relay.
- `axiom_rejected` parks only once a later row is delivered in the same alarm run. A rejection
  with no delivery after it, or two rejections in a row, is a stream-wide failure (a dataset or
  schema problem): every row stays owed under backoff and paging, and all of them are delivered
  once it is fixed. A batch whose inline ingest is rejected leaves its row to the alarm, which
  makes that call.

Every other reason, `axiom_refused` included, is stream-wide. A parked row stays in the
StreamDO's storage as a record of a range the archive holds and the hot copy will not; it blocks
nothing, and nothing outside the Worker can read or clear it (the Durable Objects are internal,
below).

Paging is per stream:

- A stream-wide failure pages its start only once it is real: two failed alarm runs in a row, or
  an owed row 5 minutes old. A blip that the next run clears pages nothing, and a change of
  reason is logged, not paged. A paged failure that still owes a row archived over 6 hours ago
  pages once more.
- A parked `axiom_rejected` row pages (`parked seq a..b (axiom_rejected)`).
- Those pages share a cap of one per stream per hour; a page the cap holds back goes out at the
  next failed run after the hour.
- A failure whose start was paged always pages its recovery, from the run that delivers the last
  owed row, and the recovery restarts the hour. A failure that never paged its start pages no
  recovery.
- `archive_unreadable` rows page outside the cap, because a changed archive must never wait an
  hour to be seen: the first at once, then at most one page per stream every 10 minutes summing
  up the rows found since (count, first and last sequence, running total). An alarm makes sure the
  summary goes out even when nothing else is due.

Apart from unreadable archive objects, a stream therefore pages at most twice an hour for its hot
copy (a start, or an age or parked page, plus the recovery of a paged start).

Owed rows are bounded by time, not by count: a row is about 200 bytes and each stream adds at
most one per batch, so a stream sending one batch per 5 s grows by at most 17,280 rows
(about 3.5 MB) per day of outage, far inside a Durable Object's storage, and the 6-hour page fires
long before that matters.

Secrets come from STS through `@kilocode/secrets-client` (`src/secrets.ts`):
`AUDIT_RELAY_AXIOM_TOKEN` and `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. One client serves the whole
isolate, keyed by the binding, so a later batch revalidates with `If-None-Match` and steady state
costs one `not_modified` round trip per 240 s. A read failure surfaces as
`SecretUnavailableError`; `retryable` maps to `secrets_unavailable` and a non-retryable `denied`,
`missing` or `not_granted` to `secrets_denied`; both are stream-wide failures. Nothing logs or
pages an event payload, a token, or a head value other than sequence and hash.

`canonicalJson` (sorted keys, no insignificant whitespace) is the one serialisation for both the
chain hash and the checkpoint signature. Changing it is a chain migration, not a refactor.

### Duplicates

A redelivered batch is byte-identical to the one archived, so the StreamDO compares a duplicate
with the archive before acting on it. When an object ends at the duplicate's `toSeq`, a duplicate
that covers the whole object must re-hash, trimmed to the object's range, to the stored chain
hash, and one that covers only a suffix of the object (the producer split differently) must
serialise like the archived events. When no object ends at `toSeq`, the duplicate is a shorter
redelivery of a range a longer batch archived first (the producer's send threw after the queue
took the message, and it later sent the range again in a longer batch): the StreamDO lists the
first object after `toSeq - 1`, which covers `toSeq`, and the events both share must match. A
mismatch (`content`), no object covering `toSeq` (`unaligned`) or an object that does not decode
(`corrupt`) pages and acks the message. A duplicate never ingests anything: an owed row in its
range is the alarm's, delivered from the archive. An R2 failure during the comparison retries the
message. A duplicate costs one R2 read, plus one list and one read when no object ends at its
`toSeq`.

### Stalled gaps

The StreamDO keeps one record per stream of the sequence it waits for (`head.seq + 1`), when it
first turned a batch away for it, and how many batches it turned away. When the same gap has
turned away **10** batches **and** is **5 minutes** old, the next batch is retried as usual and also
pages, once per gap. Both thresholds must hold: queue concurrency routinely delivers a burst of
later batches first, which reaches the count in seconds, while one stuck batch retried every
30 s reaches both together after about 5 minutes, well before its `max_retries: 24` (about 12
minutes) send it to the DLQ. Closing the
gap (the head advances) starts the next gap's count from zero.

### Dead letters

Since an archived batch is always acked, a message reaches the DLQ only when it stayed behind a
gap for its 24 retries (about 12 minutes) or its archive write kept failing (60 s doubling to a
15-minute cap, about 5.25 hours). The DLQ has **one** consumer (`max_batch_size: 100`,
`max_concurrency: 1`): it groups each batch of messages by stream, runs the streams in parallel
and each stream in sequence order, and offers each decodable batch to its stream again, so
batches an R2 outage or a gap dead-lettered archive themselves once the cause is gone, with no
manual step: an `accepted` batch, or a `duplicate` that matches the archive, is acked with
nothing kept. Once one batch of a stream is still waiting, its later batches in the same
delivery are not offered (they would only gap). Several consumers would hold later chunks of a
stream while an earlier one is still archiving and push them all back behind its gap, so there
is one.

Every other message has its raw bytes written to
`dead-letter/<stream or unknown>/<enqueue time>-<message id>.gz` in the archive bucket
(create-only, 400-day lock rule). A batch still behind a gap is retried after 30 s while its
stream's head has advanced within the last minute (a backlog that is draining), for its first 60
deliveries; otherwise, and after an R2 failure, every 15 minutes, up to the Queues maximum of 100
retries. A message that cannot
recover is paged and acked: a duplicate that disagrees with the archive (`duplicate_content`,
`duplicate_unaligned`, `duplicate_corrupt`), an archive conflict, an undecodable body (main
queue or DLQ), or a batch still waiting at its final delivery, including one whose bytes could
not be stored by then (`store_failed`). Pages carry the stream, sequence range, reason, attempt
count and key (never the payload), and each stream pages at most once an hour (bodies with no
readable stream share one budget); every message is still logged.

A batch lost at its final delivery stalls its stream: every later batch gap-retries behind it.
To recover, re-send the stored object's bytes to the main queue as a `bytes` message; the
StreamDO archives the missing batch and dedupes the rest.

## STS token events

STS's service-token events travel this path like every other event (design 8.3); the relay
treats them as opaque rows. Shapes are built in `services/sts/src/audit/events.ts`;
`test/token-events.test.ts` here decodes, archives and ingests them, and STS's
`test/worker/token-audit-events.test.ts` proves the builders pass the producer-side check
(`assertRelayable`: the event schema, flat attributes only, and the single-message size) at their
largest (8 audiences, 63-character names, 127-character scopes). No event carries a token.

| Type | Stream | OCSF class / activity | Outcome | Attributes |
|---|---|---|---|---|
| `ai.kilo.sts.token.issued` | `sts:<env>:tokens:<shard>` | API Activity 6003 / Create 1 | `success`, actor `workload` | `workload`, `environment`, `identity` (`worker-binding`, `vercel`, `github`, `fly`), `kid`, `issuedAt`, `expiresAt`, `lifetimeSeconds`, `attestationCapped`, `tokenCount`, and the parallel lists `jtis`, `audiences`, `scopes` (one row per mint call) |
| `ai.kilo.sts.token.denied` | `sts:<env>:denials` | API Activity 6003 / Create 1 | `denied`, `outcomeDetail` = reason; actor `workload` (binding) or `service` (HTTP) | `environment`, `channel`, `reason`, `workload` (the actor), `audience` and `scope` (absent for a whole-call refusal), `count` and `windowStart` (identical denials merged per minute), `overflow`, `claims` (stable identity claims as `name=value`) |
| `ai.kilo.sts.token_key.rotated` | `sts:<env>:tokens:<shard>` | API Activity 6003 / Update 3, Delete 4 for `removed` | `success`, `outcomeDetail` = change; actor `system` | `environment`, `change` (`created`, `published`, `activated`, `removed`), `kid`, plus `activatesAt`, `retiredKid` or `lastTokenExpiresAt` |
| `ai.kilo.sts.token_key.revoked` | `sts:<env>:tokens:<shard>` | API Activity 6003 / Delete 4 | `success`, `outcomeDetail` `emergency removal`; actor `system` | `environment`, `kid`, `state`, `cause` (`listed`, `same_ring`), `replacementKid` |

Mints and denials for one workload in Axiom (`kilo-audit`; nested fields are flattened with dots):

```kusto
['kilo-audit']
| where type in ('ai.kilo.sts.token.issued', 'ai.kilo.sts.token.denied')
| where ['data.attributes.workload'] == 'web'
| project _time, source, type, outcome = ['data.outcome'], reason = ['data.attributes.reason'],
    audiences = ['data.attributes.audiences'], audience = ['data.attributes.audience'],
    scopes = ['data.attributes.scopes'], count = ['data.attributes.count']
| order by _time desc
```

Who minted tokens for one audience: `| where type == 'ai.kilo.sts.token.issued' | mv-expand
audience = ['data.attributes.audiences'] | where audience == 'usage-ingest' | summarize mints =
count() by bin(_time, 5m), workload = tostring(['data.attributes.workload'])`.

## Checkpoints and verification

- Hourly (`0 * * * *`): the registry's heads are serialised as
  `{ schemaVersion, time, streams: [{ stream, seq, hash }] }`, signed with the Ed25519 key inside
  `SignerDO`, and written to `checkpoints/<ISO hour>.json` together with `keyId` and `signature`.
  The private key is generated in the Durable Object, kept in its storage as PKCS#8, and never
  returned by an RPC method. The checkpoint is written create-only; a repeated run in the same hour
  finds the existing file and accepts it only when its signature equals the new one (Ed25519 is
  deterministic, so unchanged heads sign identically). A run that cannot write its checkpoint
  pages (`could not write the hourly checkpoint`) and fails, and the next hour retries.
- The public key set is served at `GET /.well-known/audit-checkpoint-keys.json`
  (`https://audit-relay.kiloapps.io/.well-known/audit-checkpoint-keys.json`). `kid` is the RFC 7638
  thumbprint of the JWK.
- `VerifierDO` owns verification. A cron only starts a pass; the pass then walks the archive in
  bounded slices, one per Durable Object alarm, with a per-stream cursor saved between slices. A
  slice reads at most 1,000 objects and stops after the object that passes 64 MiB decompressed
  (each object is one R2 `GET`, a gunzip, a schema parse and a SHA-256, so CPU follows bytes), so
  it stays inside the alarm's 30 s CPU and 10,000-subrequest limits, and the next alarm follows at
  once. Each slice reads the registry heads and walks a stream only up to its head, so objects
  archived during a pass belong to the next one. A cron that finds its pass still running re-arms
  a missing alarm.
- Daily (`30 3 * * *`): the pass first requires a signed checkpoint no older than 2 hours; a
  newer-than-anchor checkpoint missing because the hourly job stopped would otherwise let the pass
  re-verify the old anchor and report success, so it fails with `checkpoint_stale` and pages. It
  then anchors on the last checkpoint a daily pass verified (the genesis
  hash before the first one) and lists each stream with `startAfter` that checkpoint's position, so
  it reads only what was archived since. Both the anchor and the newest checkpoint must carry a
  valid signature under the published key, and every stream's chain must land on the newest
  checkpoint's `{ seq, hash }` at an object boundary. Only when every stream verified does the pass
  record the newest checkpoint as the next anchor; a failure leaves the anchor where it was, so the
  next day repeats the same range and pages again.
- Monthly (`0 4 1 * *`): a full pass from the genesis hash of every stream, covering the objects the
  daily pass trusts through its anchor, with the same newest-checkpoint check. The daily cron pages
  while no full pass has completed for 35 days.
- A slice counts itself as failed before it walks and clears the count when it saves progress, so
  a slice that throws or that the runtime kills (CPU limit, eviction) is counted; the next slice
  retries (a minute later after a throw, at the runtime's alarm retry after a kill), and the fifth
  consecutive unfinished slice ends the pass with `archive_read`. A mismatch, a failed signature, an unreadable or
  missing object, a stream in the checkpoint but not the registry, or an archive that ends short of
  the registry head ends the pass and pages `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. The text begins with
  `bot: ` and carries only the reason, stream name, sequence and key. Each kind's last result is
  kept in the verifier's storage as its record.

## Bindings and configuration

| Binding | Value |
|---|---|
| `AUDIT_STREAM` | `StreamDO`, one instance per stream |
| `AUDIT_REGISTRY` | `RegistryDO`, the stream index (one key per stream head) the checkpoint and verify jobs read |
| `AUDIT_SIGNER` | `SignerDO`, holder of the checkpoint signing key |
| `AUDIT_VERIFIER` | `VerifierDO`, the daily and full verification passes and the verified anchor |
| `AUDIT_ARCHIVE` | R2 `kilo-audit-archive` (staging `kilo-audit-archive-staging`), bound with `"jurisdiction": "eu"` because the buckets are created in the EU jurisdiction; the local binding is miniflare's simulated bucket and has none |
| `STS` | service `sts` (`sts-staging`), entrypoint `SecretsBroker`, `props.caller` = `audit-relay` in every environment (each STS deployment serves one environment) |
| Queue consumer | `kilo-audit` → DLQ `kilo-audit-dlq` (staging `kilo-audit-staging` / `kilo-audit-staging-dlq`) |
| `AXIOM_DATASET` | `kilo-audit` (staging `kilo-audit-staging`, local `kilo-audit-local`) |
| `AXIOM_URL` | `https://api.axiom.co` |
| `AUDIT_ENVIRONMENT` | `production` / `staging` / `local` |

Observability is logs only (`observability.traces.enabled: false`, every environment): a trace
records each outbound fetch with its full URL
(https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), and the
Slack paging webhook URL is itself the secret, in the path, where `redact_query_string` cannot
reach it. Workers Logs and Logpush stay on; they carry the Worker's own log lines, none of which
includes a URL it fetched. Keep traces off while the Worker fetches a secret URL.

Retries are bounded: `max_retries: 24` with `retry_delay: 60`; a gap retry waits 30 s and an
archive failure 60 s doubling to 15 minutes, each consuming one retry. A message that exhausts
them lands in the DLQ (above), whose consumer has `max_retries: 100` with `retry_delay: 900`.

### Internal Durable Objects

`StreamDO`, `RegistryDO`, `SignerDO` and `VerifierDO` are internal, and so is the Worker itself: no other Worker may bind `audit-relay`, `audit-relay-staging` or `audit-relay-local` as a service, a Durable Object `script_name`, a workflow, a tail consumer, a dispatch outbound or a migration/export transfer source. No other Worker may consume or dead-letter into the `kilo-audit*` queues, or bind a `kilo-audit-archive*` bucket. Their methods (`SignerDO.sign`, stream appends) skip the queue path that checks batch contiguity and archives every batch. A foreign archive writer could pre-write a key that the 400-day lock then keeps. `services/sts/test/repo/worker-configs.test.ts` scans every Wrangler config in the repository and fails on any of these. It requires `"jurisdiction": "eu"` on the production and staging archive bindings, and requires this Worker to deploy exactly those three names.

## Merge gate: production prerequisites

**Complete and verify these before merging.** The merge to `main` is the first production deploy:
a green main CI run starts Deploy to Production, which deploys every changed Worker, this one
included. Do each step for production and for staging. `wrangler` is the workspace pin
(`pnpm exec wrangler` from this directory).

Steps 1 and 2 are required for the Worker to work at all: without the queues the deploy fails, and
without the EU bucket and its lock rules the archive is missing or not immutable. Steps 3, 4 and 5
are required for full function. Without the Axiom dataset and token, or while STS does not serve
the policy (step 5), every batch is still archived and checkpointed, but each stream records a
stream-wide hot-copy failure and owes its rows to Axiom until the token can be read (about 3.5 MB
of owed rows per stream per day). Without the Slack webhook, every page fails and only the
`audit_relay.page_failed` log line remains.

1. **Queues and the DLQ** with a 14-day message retention (the consumer attachment comes from
   `wrangler.jsonc`). STS starts sending audit events within 5 minutes of its own deploy, which
   can come before this Worker's; a message older than the retention is dropped and its stream
   stalls behind a gap, so merge this Worker within the retention:

   ```sh
   for queue in kilo-audit kilo-audit-dlq kilo-audit-staging kilo-audit-staging-dlq; do
     pnpm exec wrangler queues create "$queue"
     pnpm exec wrangler queues update "$queue" --message-retention-period-secs 1209600
   done
   ```

   Verify: `pnpm exec wrangler queues info kilo-audit` (and the other three) prints the queue, and
   the Queues API shows `message_retention_period: 1209600` for each.

2. **R2 bucket in the EU jurisdiction with lock rules** on the archive, the checkpoints and the
   dead letters: 400 days in production, 1 day in staging (staging holds test data only):

   ```sh
   lock() { # bucket, retention in days, rule-name suffix
     pnpm exec wrangler r2 bucket create "$1" -J eu
     for rule in archive:streams/ checkpoints:checkpoints/ dead-letter:dead-letter/; do
       pnpm exec wrangler r2 bucket lock add "$1" "${rule%%:*}-$3" "${rule#*:}" \
         --retention-days "$2" -J eu
     done
   }
   lock kilo-audit-archive 400 400-days
   lock kilo-audit-archive-staging 1 1-day
   ```

   Verify: `pnpm exec wrangler r2 bucket info kilo-audit-archive -J eu` shows the bucket,
   `pnpm exec wrangler r2 bucket lock list kilo-audit-archive -J eu` lists exactly the three rules
   at 400 days (staging: at 1 day), and `wrangler deploy --dry-run` shows
   `kilo-audit-archive (eu)` for the binding.
   The copy of each checkpoint outside the Cloudflare account, which keeps the proof past the lock
   rule, is a separate task owned by Anaconda security.

3. **Axiom dataset and ingest token** (full function): create the dataset `kilo-audit` (staging
   `kilo-audit-staging`) with 90-day retention, and an Axiom API token with ingest-only access to
   it. Store the token in Infisical project `kilo`, environment `production` (resp. `staging`),
   folder `/workloads/audit-relay`, as `AUDIT_RELAY_AXIOM_TOKEN` (design 4.2).

   Verify: in Axiom the token's permissions list only ingest on that one dataset; in Infisical the
   folder lists the secret name (never print the value). After the deploy, the first batch logs
   `audit_relay.batch_archived` with `hotCopy: "delivered"` and its events appear in the dataset.

4. **Slack paging webhook** (full function): an incoming webhook for the channel `#kilo-on-call`,
   stored in the same Infisical folder as `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`.

   Verify: Infisical lists the name, and one test message starting with `bot: ` posted to the
   webhook from a trusted shell arrives in `#kilo-on-call`.

5. **STS policy**: `services/sts/policy/audit-relay.yaml`, shipped with the STS broker, grants the
   workload `audit-relay` exactly these two secrets in every environment. `props.caller` is
   `audit-relay` in every environment block, so the serving STS deployment's environment must
   match `AUDIT_ENVIRONMENT`. Until STS serves that policy, secret reads are denied: batches are
   still archived, and the hot copy is owed as in step 3.

   Verify: the policy file names `audit-relay`, its three environments and the two secrets, and
   the STS deployment that the merge produces includes it.

6. **DNS**: the `custom_domain` route creates `audit-relay.kiloapps.io`
   (`audit-relay-staging.kiloapps.io` for staging) on deploy.

   Verify after the deploy: `curl https://audit-relay.kiloapps.io/.well-known/audit-checkpoint-keys.json`
   returns one Ed25519 key. If the key set has to live at a different origin, change the route and
   update the recorded key-set URL.

These prerequisites are what make the sinks immutable: without the lock rules, a rewritten archive
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
unaligned range), gap-then-fill, a stalled gap that pages once, partial overlap, an Axiom outage
that acks every archived batch and delivers it from the alarm (paging the start after two failed
runs, the recovery once, and nothing for a second failure inside the hour), sporadic failures
that page nothing, a rejected row parked once a later row is delivered, a missing dataset and a
payload every row fails that keep all rows owed and deliver them once fixed, 60 unreadable rows
parked without starving the row behind them and paged at once and then once a summary is due, a
stream's later dead letters not offered behind a gap, a backlog spread over several deliveries
drained in a few rounds, the short and long dead-letter retry delays, two streams' dead letters
archived in one parallel pass, a dead
letter that cannot be stored at its final delivery, an owed row re-ingested from the archive and never
from a forged redelivery, Axiom status classification, create-only writes with the same, a
different and an undecodable object, dead-lettered batches that archive themselves once the cause
is gone, a batch still behind a gap retried and paged once an hour at its final delivery, a
dead letter that disagrees with the archive, an undecodable main-queue body kept and paged, a
failed dead-letter write retried, the archive retry delay, checkpoint signing verified with the
published key, the bounded chain walk (object and byte budgets, `startAfter` the anchor, a
checkpoint inside an object or with another hash, an archive short of the head), killed slices
that fail their pass, and one verifier scenario across slices: the first daily pass from genesis,
a daily pass that reads only the objects above its anchor, a full pass that finds tampering below
the anchor, tampering above the anchor that keeps the anchor in place, a forged checkpoint, and the
35-day full-pass page. The test config sets `AUDIT_VERIFY_SLICE_OBJECTS` to 2 so every pass
resumes from its cursor. Axiom and Slack are recorded and answered by a stubbed `fetch`.

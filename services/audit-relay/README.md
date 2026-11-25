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
| `toSeq <= head.seq` | duplicate: ack, no writes |
| `fromSeq > head.seq + 1` | gap: `message.retry({ delaySeconds: 30 })`, because queues do not preserve order |
| `fromSeq <= head.seq < toSeq` | accepted, only the `head.seq + 1 .. toSeq` suffix is archived and ingested |

For an accepted batch the Durable Object, in order:

1. `hash = sha256(prevHash || canonicalJson(batch))`, starting from a 64-zero genesis hash.
2. Writes `streams/<stream>/<toSeq, 12 digits>.json.gz` holding `{ batch, prevHash, hash }`. A
   bucket-lock rule rejects the write to an existing key; that counts as success only when the
   stored object's `hash` matches. A different hash is a second writer: the batch is dropped and
   the page goes out.
3. Ingests the events into Axiom (`POST {AXIOM_URL}/v1/datasets/{AXIOM_DATASET}/ingest`) with
   `_time` set from the CloudEvents `time`; the event `id` stays in the body as the dedupe key.
4. Records the head in the registry object, then advances its own head.

A retry re-runs the same steps idempotently: the archive key already holds the same hash, and Axiom
receives the same event ids. Secrets come from STS through `SecretSource` (`src/secrets.ts`):
`AUDIT_RELAY_AXIOM_TOKEN` and `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. Nothing logs an event payload, a
token, or a head value other than sequence and hash.

`canonicalJson` (sorted keys, no insignificant whitespace) is the one serialisation for both the
chain hash and the checkpoint signature. Changing it is a chain migration, not a refactor.

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
- Daily (`30 3 * * *`): reads the newest checkpoint, verifies its signature against the published
  key, then recomputes every stream from the checkpoint's `{ seq, hash }` to the registry head by
  reading archive objects. The verified checkpoint key is recorded in the registry.
- Monthly (`0 4 1 * *`): the same walk from the genesis hash, covering objects the daily run trusts
  through the checkpoint.
- A mismatch, a failed signature, an unreadable object, or an unreadable checkpoint posts to
  `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`. The text begins with `bot: ` and carries only the reason,
  stream name, and sequence.

## Bindings and configuration

| Binding | Value |
|---|---|
| `AUDIT_STREAM` | `StreamDO`, one instance per stream |
| `AUDIT_REGISTRY` | `RegistryDO`, the stream index the checkpoint and verify jobs read |
| `AUDIT_SIGNER` | `SignerDO`, holder of the checkpoint signing key |
| `AUDIT_ARCHIVE` | R2 `kilo-audit-archive` (staging `kilo-audit-archive-staging`), EU jurisdiction |
| `STS` | service `sts` (`sts-staging`), entrypoint `SecretsBroker`, `props.caller` = `audit-relay` in every environment (each STS deployment serves one environment) |
| Queue consumer | `kilo-audit` → DLQ `kilo-audit-dlq` (staging `kilo-audit-staging` / `kilo-audit-staging-dlq`) |
| `AXIOM_DATASET` | `kilo-audit` (staging `kilo-audit-staging`, local `kilo-audit-local`) |
| `AXIOM_URL` | `https://api.axiom.co` |
| `AUDIT_ENVIRONMENT` | `production` / `staging` / `local` |

Retries are bounded: `max_retries: 10` with `retry_delay: 60`, and a gap retry consumes one of
them. A message that exhausts them lands in the DLQ, whose own consumer logs and acks each message
so a stalled pipeline is visible in Workers Logs instead of a growing backlog.

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

2. **R2 bucket in the EU jurisdiction with a 400-day lock rule**:

   ```sh
   pnpm exec wrangler r2 bucket create kilo-audit-archive --jurisdiction eu
   pnpm exec wrangler r2 bucket create kilo-audit-archive-staging --jurisdiction eu

   pnpm exec wrangler r2 bucket lock add kilo-audit-archive \
     --name archive-400-days --prefix streams/ --retention-days 400
   pnpm exec wrangler r2 bucket lock add kilo-audit-archive \
     --name checkpoints-400-days --prefix checkpoints/ --retention-days 400
   pnpm exec wrangler r2 bucket lock add kilo-audit-archive-staging \
     --name archive-400-days --prefix streams/ --retention-days 400
   pnpm exec wrangler r2 bucket lock add kilo-audit-archive-staging \
     --name checkpoints-400-days --prefix checkpoints/ --retention-days 400
   ```

   The copy of each checkpoint outside the Cloudflare account, which keeps the proof past the lock
   rule, is a separate task owned by Anaconda security.

3. **Axiom dataset and ingest token**: create the dataset `kilo-audit` (staging `kilo-audit-staging`)
   with 90-day retention, and an Axiom API token with ingest-only access to it. Store the token in
   Infisical project `kilo-runtime`, environment `prod` (resp. `staging`), path `/runtime`, as
   `AUDIT_RELAY_AXIOM_TOKEN`.

4. **Slack paging webhook**: store it in the same Infisical path as
   `AUDIT_RELAY_SLACK_WEBHOOK_PAGE`.

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
STS; a deployed environment can never take that path.

```sh
pnpm test        # vitest-pool-workers
pnpm typecheck
pnpm lint
```

The suite covers in-order delivery, duplicates, gap-then-fill, partial overlap, an Axiom failure
retried without a second archive write, a locked key with the same and with a different hash,
checkpoint signing verified with the published key, tamper detection above and below the
checkpoint, a forged checkpoint signature, and each `BundleResult` state of the secrets adapter.
Axiom and Slack are recorded and answered by a stubbed `fetch`.

import { withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import { getRegistryDOStub } from './dos/RegistryDO';
import { getSignerDOStub } from './dos/SignerDO';
import type { Env } from './env';
import {
  ARCHIVE_PREFIX,
  CHECKPOINT_PREFIX,
  archiveSequenceOf,
  listObjectKeys,
  putImmutable,
  readArchivedObject,
} from './relay/archive';
import type { ArchiveBucket } from './relay/archive';
import { canonicalJson } from './relay/canonical';
import { GENESIS_HASH, chainHash } from './relay/chain';
import { errorName } from './relay/error-name';
import { CheckpointPublicKeySchema, verifyEd25519 } from './relay/signing';
import type { CheckpointPublicKey } from './relay/signing';
import { pageSlack } from './relay/slack';
import { createSecretSource } from './secrets';

export const AUDIT_CHECKPOINT_KEYS_PATH = '/.well-known/audit-checkpoint-keys.json';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const CheckpointStreamSchema = z.strictObject({
  stream: z.string().min(1).max(191),
  seq: z.number().int().nonnegative(),
  hash: HashSchema,
});
export type CheckpointStream = z.infer<typeof CheckpointStreamSchema>;

export const CheckpointPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  time: z.iso.datetime(),
  streams: z.array(CheckpointStreamSchema),
});
export type CheckpointPayload = z.infer<typeof CheckpointPayloadSchema>;

export const CheckpointFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  time: z.iso.datetime(),
  streams: z.array(CheckpointStreamSchema),
  keyId: z.string().min(1),
  signature: z.string().min(1),
  algorithm: z.literal('Ed25519'),
});
export type CheckpointFile = z.infer<typeof CheckpointFileSchema>;

export type VerifyFailureReason =
  | 'checkpoint_read'
  | 'checkpoint_signature'
  | 'archive_read'
  | 'chain'
  | 'head';

export type VerifySummary =
  | { kind: 'ok'; streams: number; objects: number; checkpoint: string | null }
  | { kind: 'failed'; reason: VerifyFailureReason; detail: string };

/** The ISO timestamp of the hour a checkpoint covers, truncated: `2026-11-25T10:00:00.000Z`. */
export function checkpointHour(date: Date): string {
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

export function checkpointKey(hour: string): string {
  return `${CHECKPOINT_PREFIX}${hour}.json`;
}

export async function readPublicKeys(env: Env): Promise<CheckpointPublicKey[]> {
  const keys = await withDORetry(
    () => getSignerDOStub(env),
    stub => stub.publicKeys(),
    'publicKeys'
  );
  return keys.map(key => CheckpointPublicKeySchema.parse(key));
}

/**
 * Signs the registry's current heads for the hour and writes the checkpoint as an immutable
 * object. Ed25519 is deterministic, so a repeated run inside the same hour with unchanged heads
 * produces the same file and the locked key is harmless.
 */
export async function createHourlyCheckpoint(
  env: Env,
  now: number = Date.now()
): Promise<{ key: string; streams: number; write: 'written' | 'existing' }> {
  const time = checkpointHour(new Date(now));
  const heads = await withDORetry(
    () => getRegistryDOStub(env),
    stub => stub.listStreams(),
    'listStreams'
  );
  const payload: CheckpointPayload = {
    schemaVersion: 1,
    time,
    streams: heads.map(head => ({ stream: head.stream, seq: head.seq, hash: head.hash })),
  };
  const signed = await withDORetry(
    () => getSignerDOStub(env),
    stub => stub.sign(canonicalJson(payload)),
    'signCheckpoint'
  );
  const file: CheckpointFile = {
    ...payload,
    keyId: signed.keyId,
    signature: signed.signature,
    algorithm: 'Ed25519',
  };

  const key = checkpointKey(time);
  const body = new TextEncoder().encode(JSON.stringify(file));
  const write = await putImmutable(env.AUDIT_ARCHIVE, key, body, 'application/json');
  if (write === 'existing') {
    const stored = await readCheckpointFile(env.AUDIT_ARCHIVE, key);
    if (!stored || stored.signature !== signed.signature) {
      throw new Error(`checkpoint ${key} already exists with a different signature`);
    }
  }
  return { key, streams: payload.streams.length, write };
}

/**
 * The daily job walks each stream from the newest verifiable checkpoint to the registry head and
 * re-derives every hash; the monthly job starts at the genesis hash and covers the whole archive.
 * A mismatch, a failed signature, or an unreadable object pages the on-call webhook.
 */
export async function verifyArchivedChains(
  env: Env,
  options: { full: boolean }
): Promise<VerifySummary> {
  let anchor: { key: string; file: CheckpointFile } | null = null;
  const startStates = new Map<string, { seq: number; hash: string }>();

  if (!options.full) {
    try {
      anchor = await readLatestCheckpoint(env.AUDIT_ARCHIVE);
    } catch (error) {
      return pageFailure(env, 'checkpoint_read', errorName(error));
    }
    if (anchor) {
      const keys = await readPublicKeys(env);
      const publicKey = keys.find(key => key.kid === anchor?.file.keyId);
      if (!publicKey) {
        return pageFailure(
          env,
          'checkpoint_signature',
          `no published key for ${anchor.file.keyId}`
        );
      }
      const signed = canonicalJson({
        schemaVersion: anchor.file.schemaVersion,
        time: anchor.file.time,
        streams: anchor.file.streams,
      });
      if (!(await verifyEd25519(publicKey, anchor.file.signature, signed))) {
        return pageFailure(env, 'checkpoint_signature', anchor.key);
      }
      for (const entry of anchor.file.streams) {
        startStates.set(entry.stream, { seq: entry.seq, hash: entry.hash });
      }
    }
  }

  const heads = await withDORetry(
    () => getRegistryDOStub(env),
    stub => stub.listStreams(),
    'listStreams'
  );
  let objects = 0;
  for (const head of heads) {
    const start = startStates.get(head.stream) ?? { seq: 0, hash: GENESIS_HASH };
    let result: StreamVerification;
    try {
      result = await verifyStream(env.AUDIT_ARCHIVE, head, start);
    } catch (error) {
      return pageFailure(env, 'archive_read', `stream ${head.stream}: ${errorName(error)}`);
    }
    if (!result.ok) {
      return pageFailure(env, result.reason, `stream ${head.stream}: ${result.detail}`);
    }
    objects += result.objects;
  }

  if (anchor) {
    try {
      await withDORetry(
        () => getRegistryDOStub(env),
        stub => stub.recordVerifiedCheckpoint(anchor.key),
        'recordVerifiedCheckpoint'
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.verified_checkpoint_record_failed',
          error: errorName(error),
        })
      );
    }
  }
  return { kind: 'ok', streams: heads.length, objects, checkpoint: anchor?.key ?? null };
}

export type StreamVerification =
  | { ok: true; objects: number }
  | { ok: false; reason: VerifyFailureReason; detail: string };

async function verifyStream(
  bucket: ArchiveBucket,
  head: { stream: string; seq: number; hash: string },
  start: { seq: number; hash: string }
): Promise<StreamVerification> {
  const keys = (await listObjectKeys(bucket, `${ARCHIVE_PREFIX}${head.stream}/`)).sort();
  let seq = start.seq;
  let hash = start.hash;
  let objects = 0;

  for (const key of keys) {
    const objectSeq = archiveSequenceOf(key);
    if (objectSeq === null) {
      return { ok: false, reason: 'archive_read', detail: `unexpected object key ${key}` };
    }
    if (objectSeq <= start.seq) continue;

    const archived = await readArchivedObject(bucket, key);
    if (!archived) {
      return { ok: false, reason: 'archive_read', detail: `missing object ${key}` };
    }
    const { batch } = archived;
    if (batch.stream !== head.stream) {
      return { ok: false, reason: 'chain', detail: `${key} names stream ${batch.stream}` };
    }
    if (batch.toSeq !== objectSeq) {
      return { ok: false, reason: 'chain', detail: `${key} names sequence ${batch.toSeq}` };
    }
    if (batch.fromSeq !== seq + 1) {
      return {
        ok: false,
        reason: 'chain',
        detail: `${key} starts at ${batch.fromSeq}, expected ${seq + 1}`,
      };
    }
    if (archived.prevHash !== hash) {
      return {
        ok: false,
        reason: 'chain',
        detail: `${key} links ${archived.prevHash}, expected ${hash}`,
      };
    }
    const recomputed = await chainHash(archived.prevHash, batch);
    if (recomputed !== archived.hash) {
      return {
        ok: false,
        reason: 'chain',
        detail: `${key} stores a hash that does not match its batch`,
      };
    }
    seq = batch.toSeq;
    hash = archived.hash;
    objects += 1;
  }

  if (seq !== head.seq) {
    return {
      ok: false,
      reason: 'head',
      detail: `archive ends at ${seq}, registry head is ${head.seq}`,
    };
  }
  if (hash !== head.hash) {
    return { ok: false, reason: 'head', detail: `archive hash at ${seq} is not the registry head` };
  }
  return { ok: true, objects };
}

async function readCheckpointFile(
  bucket: ArchiveBucket,
  key: string
): Promise<CheckpointFile | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return CheckpointFileSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

async function readLatestCheckpoint(
  bucket: ArchiveBucket
): Promise<{ key: string; file: CheckpointFile } | null> {
  const keys = (await listObjectKeys(bucket, CHECKPOINT_PREFIX)).sort();
  const key = keys.at(-1);
  if (!key) return null;
  const file = await readCheckpointFile(bucket, key);
  if (!file) throw new Error(`checkpoint ${key} disappeared between list and read`);
  return { key, file };
}

async function pageFailure(
  env: Env,
  reason: VerifyFailureReason,
  detail: string
): Promise<VerifySummary> {
  console.error(JSON.stringify({ event: 'audit_relay.verification_failed', reason, detail }));
  try {
    const webhook = await createSecretSource(env).get('AUDIT_RELAY_SLACK_WEBHOOK_PAGE');
    const delivered = await pageSlack(
      webhook,
      `audit-relay chain verification failed (${reason}): ${detail}`,
      fetch
    );
    if (!delivered) {
      console.error(JSON.stringify({ event: 'audit_relay.page_undelivered', reason }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'audit_relay.page_failed', reason, error: errorName(error) })
    );
  }
  return { kind: 'failed', reason, detail };
}

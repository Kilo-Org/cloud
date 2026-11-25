import { withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import { getRegistryDOStub } from './dos/RegistryDO';
import { getSignerDOStub } from './dos/SignerDO';
import type { Env } from './env';
import { CHECKPOINT_PREFIX, putImmutable } from './relay/archive';
import type { ArchiveBucket } from './relay/archive';
import { canonicalJson } from './relay/canonical';
import { CheckpointPublicKeySchema, verifyEd25519 } from './relay/signing';
import type { CheckpointPublicKey } from './relay/signing';

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

/** The ISO timestamp of the hour a checkpoint covers, truncated: `2026-11-25T10:00:00.000Z`. */
export function checkpointHour(date: Date): string {
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

/** ISO hours sort lexicographically, so the newest checkpoint is the last key of a listing. */
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

/** The stored checkpoint, or null when the key is absent. Throws on an unparseable file. */
export async function readCheckpointFile(
  bucket: ArchiveBucket,
  key: string
): Promise<CheckpointFile | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return CheckpointFileSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

/**
 * The newest checkpoint key strictly after `after` (the whole prefix when null), or null when
 * none is newer. Listing from the last verified key keeps the daily run to one day of keys.
 */
export async function newestCheckpointKeyAfter(
  bucket: ArchiveBucket,
  after: string | null
): Promise<string | null> {
  let newest: string | null = null;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: CHECKPOINT_PREFIX,
      startAfter: after ?? undefined,
      cursor,
      limit: 1000,
    });
    newest = page.objects.at(-1)?.key ?? newest;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return newest;
}

/** True when the file's signature verifies under the published key its `keyId` names. */
export async function checkpointSignatureValid(
  keys: readonly CheckpointPublicKey[],
  file: CheckpointFile
): Promise<boolean> {
  const publicKey = keys.find(key => key.kid === file.keyId);
  if (!publicKey) return false;
  const signed = canonicalJson({
    schemaVersion: file.schemaVersion,
    time: file.time,
    streams: file.streams,
  });
  return verifyEd25519(publicKey, file.signature, signed);
}

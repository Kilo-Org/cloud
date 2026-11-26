import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_CHECKPOINT_KEYS_PATH,
  checkpointKey,
  checkpointSignatureValid,
  createHourlyCheckpoint,
  readCheckpointFile,
} from '../src/checkpoint';
import { getStreamDOStub } from '../src/dos/StreamDO';
import { canonicalJson } from '../src/relay/canonical';
import { verifyEd25519 } from '../src/relay/signing';
import type { CheckpointPublicKey } from '../src/relay/signing';
import { auditBatch, axiomOk, env, recordingFetch, uniqueStream } from './helpers';

const CHECKPOINT_NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const CHECKPOINT_KEY = checkpointKey('2026-11-25T10:00:00.000Z');

async function publishedKeys(): Promise<CheckpointPublicKey[]> {
  const response = await SELF.fetch(`https://audit-relay.test${AUDIT_CHECKPOINT_KEYS_PATH}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { keys: CheckpointPublicKey[] };
  return body.keys;
}

describe('hourly checkpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs the registry heads with a key the Worker publishes', async () => {
    const stream = uniqueStream('checkpoint');
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const outcome = await getStreamDOStub(env, stream).acceptBatch(auditBatch(1, 2, stream));
    if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);

    expect(await createHourlyCheckpoint(env, CHECKPOINT_NOW)).toEqual({
      key: CHECKPOINT_KEY,
      streams: 1,
      write: 'written',
    });
    const file = await readCheckpointFile(env.AUDIT_ARCHIVE, CHECKPOINT_KEY);
    if (!file) throw new Error('checkpoint missing');
    expect(file.streams).toEqual([{ stream, seq: 2, hash: outcome.hash }]);
    expect(file.algorithm).toBe('Ed25519');

    const keys = await publishedKeys();
    expect(keys.map(key => key.kid)).toEqual([file.keyId]);
    const signed = canonicalJson({
      schemaVersion: file.schemaVersion,
      time: file.time,
      streams: file.streams,
    });
    expect(await verifyEd25519(keys[0], file.signature, signed)).toBe(true);
    expect(await checkpointSignatureValid(keys, file)).toBe(true);
    expect(
      await checkpointSignatureValid(keys, { ...file, time: '2026-11-25T11:00:00.000Z' })
    ).toBe(false);
  });
});

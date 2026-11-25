import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIT_CHECKPOINT_KEYS_PATH,
  checkpointKey,
  createHourlyCheckpoint,
  verifyArchivedChains,
} from '../src/checkpoint';
import { getStreamDOStub } from '../src/dos/StreamDO';
import { archiveObjectKey, gzipJson } from '../src/relay/archive';
import { canonicalJson } from '../src/relay/canonical';
import { verifyEd25519 } from '../src/relay/signing';
import type { CheckpointPublicKey } from '../src/relay/signing';
import {
  auditBatch,
  axiomOk,
  env,
  readArchived,
  recordingFetch,
  uniqueStream,
  type CapturedRequest,
} from './helpers';

const CHECKPOINT_NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const CHECKPOINT_KEY = checkpointKey('2026-11-25T10:00:00.000Z');
const SLACK_WEBHOOK = 'https://hooks.slack.test/audit-relay';

type CheckpointBody = {
  schemaVersion: 1;
  time: string;
  streams: Array<{ stream: string; seq: number; hash: string }>;
  keyId: string;
  signature: string;
  algorithm: 'Ed25519';
};

async function readCheckpointBody(): Promise<CheckpointBody> {
  const object = await env.AUDIT_ARCHIVE.get(CHECKPOINT_KEY);
  if (!object) throw new Error(`checkpoint ${CHECKPOINT_KEY} missing`);
  return (await object.json()) as CheckpointBody;
}

async function readRaw(key: string): Promise<Uint8Array> {
  const object = await env.AUDIT_ARCHIVE.get(key);
  if (!object) throw new Error(`object ${key} missing`);
  return new Uint8Array(await object.arrayBuffer());
}

/** Rewrites one archived event's optional field, keeping the batch schema-valid. */
async function tamperArchiveObject(stream: string, toSeq: number): Promise<void> {
  const key = archiveObjectKey(stream, toSeq);
  const stored = await readArchived(stream, toSeq);
  const [first, ...rest] = stored.batch.events;
  await env.AUDIT_ARCHIVE.put(
    key,
    await gzipJson({
      ...stored,
      batch: {
        ...stored.batch,
        events: [{ ...first, data: { ...first.data, outcomeDetail: 'tampered' } }, ...rest],
      },
    })
  );
}

async function publishedKeys(): Promise<CheckpointPublicKey[]> {
  const response = await SELF.fetch(`https://audit-relay.test${AUDIT_CHECKPOINT_KEYS_PATH}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { keys: CheckpointPublicKey[] };
  return body.keys;
}

function pages(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter(request => request.url === SLACK_WEBHOOK);
}

describe('audit checkpoints', () => {
  // One scenario, in order: every step depends on the state the previous one left. Two Durable
  // Objects of one test file share storage, so splitting these into tests would leak a tampered
  // object into the next verification.
  it('signs a checkpoint, publishes its key, and detects tampering at every depth', async () => {
    const stream = uniqueStream('checkpoint');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const outcome = await stub.acceptBatch(auditBatch(1, 2, stream));
    if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);

    expect(await createHourlyCheckpoint(env, CHECKPOINT_NOW)).toEqual({
      key: CHECKPOINT_KEY,
      streams: 1,
      write: 'written',
    });
    const file = await readCheckpointBody();
    expect(file.streams).toEqual([{ stream, seq: 2, hash: outcome.hash }]);
    expect(file.algorithm).toBe('Ed25519');

    const [key] = await publishedKeys();
    expect(key.kid).toBe(file.keyId);
    const signed = canonicalJson({
      schemaVersion: file.schemaVersion,
      time: file.time,
      streams: file.streams,
    });
    expect(await verifyEd25519(key, file.signature, signed)).toBe(true);
    expect(
      await verifyEd25519(
        key,
        file.signature,
        canonicalJson({ ...file, time: '2026-11-25T11:00:00.000Z' })
      )
    ).toBe(false);

    await stub.acceptBatch(auditBatch(3, 5, stream));
    expect(await verifyArchivedChains(env, { full: false })).toMatchObject({
      kind: 'ok',
      streams: 1,
      objects: 1,
      checkpoint: CHECKPOINT_KEY,
    });

    const object5 = await readRaw(archiveObjectKey(stream, 5));
    await tamperArchiveObject(stream, 5);
    expect(await verifyArchivedChains(env, { full: false })).toMatchObject({
      kind: 'failed',
      reason: 'chain',
    });
    const page = pages(http.requests)[0];
    expect(page).toBeDefined();
    expect(JSON.parse(page?.body ?? '{}')).toMatchObject({
      text: expect.stringMatching(/^bot: audit-relay chain verification failed/),
    });
    await env.AUDIT_ARCHIVE.put(archiveObjectKey(stream, 5), object5);
    expect(await verifyArchivedChains(env, { full: false })).toMatchObject({ kind: 'ok' });

    const object2 = await readRaw(archiveObjectKey(stream, 2));
    await tamperArchiveObject(stream, 2);
    expect(await verifyArchivedChains(env, { full: false })).toMatchObject({ kind: 'ok' });
    expect(await verifyArchivedChains(env, { full: true })).toMatchObject({
      kind: 'failed',
      reason: 'chain',
    });
    await env.AUDIT_ARCHIVE.put(archiveObjectKey(stream, 2), object2);
    expect(await verifyArchivedChains(env, { full: true })).toMatchObject({ kind: 'ok' });

    const forged: CheckpointBody = {
      ...file,
      streams: [{ stream, seq: 2, hash: 'a'.repeat(64) }],
    };
    await env.AUDIT_ARCHIVE.put(CHECKPOINT_KEY, JSON.stringify(forged));
    expect(await verifyArchivedChains(env, { full: false })).toMatchObject({
      kind: 'failed',
      reason: 'checkpoint_signature',
    });
  });
});

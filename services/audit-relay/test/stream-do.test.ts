import { abortAllDurableObjects } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStreamDOStub } from '../src/dos/StreamDO';
import type { StreamOutcome } from '../src/dos/StreamDO';
import { archiveObjectKey, listObjectKeys, readArchivedObject } from '../src/relay/archive';
import { GENESIS_HASH } from '../src/relay/chain';
import { auditBatch, axiomOk, env, recordingFetch, requestBodyOf, uniqueStream } from './helpers';

function accepted(outcome: StreamOutcome): Extract<StreamOutcome, { kind: 'accepted' }> {
  if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);
  return outcome;
}

describe('StreamDO', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await abortAllDurableObjects();
  });

  it('accepts contiguous batches and links each one to the previous hash', async () => {
    const stream = uniqueStream('ordering');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const first = accepted(await stub.acceptBatch(auditBatch(1, 2, stream)));
    const second = accepted(await stub.acceptBatch(auditBatch(3, 5, stream)));

    expect(first).toMatchObject({ fromSeq: 1, toSeq: 2, archive: 'written' });
    expect(second).toMatchObject({ fromSeq: 3, toSeq: 5, archive: 'written' });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);

    const stored = await readArchivedObject(env.AUDIT_ARCHIVE, archiveObjectKey(stream, 5));
    expect(stored?.prevHash).toBe(first.hash);
    expect(stored?.hash).toBe(second.hash);

    expect(http.requests).toHaveLength(2);
    expect(requestBodyOf(http.requests[0])).toHaveLength(2);
    expect(requestBodyOf(http.requests[1])).toHaveLength(3);
    expect(http.requests[0].url).toBe('https://api.axiom.co/v1/datasets/kilo-audit-test/ingest');
  });

  it('acks a batch that is fully at or below the head without writing again', async () => {
    const stream = uniqueStream('duplicate');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    accepted(await stub.acceptBatch(auditBatch(1, 2, stream)));
    const duplicate = await stub.acceptBatch(auditBatch(1, 2, stream));

    expect(duplicate).toMatchObject({ kind: 'duplicate', toSeq: 2, headSeq: 2 });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it('retries a gap and accepts the batch once the missing range arrives', async () => {
    const stream = uniqueStream('gap');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const gap = await stub.acceptBatch(auditBatch(3, 5, stream));
    expect(gap).toMatchObject({ kind: 'retry', reason: 'gap', delaySeconds: 30 });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([]);

    accepted(await stub.acceptBatch(auditBatch(1, 2, stream)));
    const filled = accepted(await stub.acceptBatch(auditBatch(3, 5, stream)));
    expect(filled).toMatchObject({ fromSeq: 3, toSeq: 5 });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);
  });

  it('accepts only the new suffix of a partially overlapping batch', async () => {
    const stream = uniqueStream('overlap');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const head = accepted(await stub.acceptBatch(auditBatch(1, 3, stream)));
    const overlap = accepted(await stub.acceptBatch(auditBatch(2, 5, stream)));

    expect(overlap).toMatchObject({ fromSeq: 4, toSeq: 5 });
    const stored = await readArchivedObject(env.AUDIT_ARCHIVE, archiveObjectKey(stream, 5));
    expect(stored?.prevHash).toBe(head.hash);
    expect(stored?.batch.fromSeq).toBe(4);
    expect(stored?.batch.events.map(event => event.data.attributes.seq)).toEqual([4, 5]);
    expect(requestBodyOf(http.requests[1])).toHaveLength(2);
  });

  it('retries an Axiom failure without writing the archive object twice', async () => {
    const stream = uniqueStream('axiom-retry');
    let failing = true;
    const http = recordingFetch(() =>
      failing ? new Response('unavailable', { status: 503 }) : axiomOk()
    );
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const batch = auditBatch(1, 2, stream);
    const failed = await stub.acceptBatch(batch);
    expect(failed).toMatchObject({ kind: 'retry', reason: 'axiom', delaySeconds: 60 });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
    ]);

    failing = false;
    // The head advanced with the archive write, so the retry is a duplicate that re-ingests the
    // recorded hot-store gap instead of writing the archive object again.
    expect(await stub.acceptBatch(batch)).toMatchObject({ kind: 'duplicate', replayed: true });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
    ]);
    expect(http.requests).toHaveLength(2);
    expect(await stub.hotStoreGaps()).toEqual([]);
    expect(await readArchivedObject(env.AUDIT_ARCHIVE, archiveObjectKey(stream, 2))).toMatchObject({
      prevHash: GENESIS_HASH,
      batch: { fromSeq: 1, toSeq: 2 },
    });
  });

  it('records a durable hot-store gap when Axiom rejects a batch', async () => {
    const stream = uniqueStream('axiom-reject');
    const http = recordingFetch(() => new Response('invalid', { status: 400 }));
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    expect(await stub.acceptBatch(auditBatch(1, 2, stream))).toMatchObject({
      kind: 'hot_gap',
      fromSeq: 1,
      toSeq: 2,
      reason: 'axiom_rejected',
    });
    expect(await stub.hotStoreGaps()).toEqual([
      {
        stream,
        fromSeq: 1,
        toSeq: 2,
        reason: 'axiom_rejected',
        recordedAt: expect.any(String),
      },
    ]);

    await stub.clearHotStoreGap(1, 2);
    expect(await stub.hotStoreGaps()).toEqual([]);
  });

  it('accepts and archives the next batch after a hot-store gap', async () => {
    const stream = uniqueStream('axiom-reject-continue');
    let rejectFirst = true;
    const http = recordingFetch(() => {
      if (!rejectFirst) return axiomOk();
      rejectFirst = false;
      return new Response('invalid', { status: 400 });
    });
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    expect(await stub.acceptBatch(auditBatch(1, 2, stream))).toMatchObject({
      kind: 'hot_gap',
    });
    expect(await stub.acceptBatch(auditBatch(3, 5, stream))).toMatchObject({
      kind: 'accepted',
      fromSeq: 3,
      toSeq: 5,
    });
    expect(await listObjectKeys(env.AUDIT_ARCHIVE, `streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);
    expect((await stub.hotStoreGaps()).map(gap => [gap.fromSeq, gap.toSeq])).toEqual([[1, 2]]);

    expect(await stub.acceptBatch(auditBatch(1, 2, stream))).toMatchObject({
      kind: 'duplicate',
      replayed: true,
    });
    expect(await stub.hotStoreGaps()).toEqual([]);
  });
});

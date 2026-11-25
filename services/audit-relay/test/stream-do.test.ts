import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAP_PAGE_AFTER_MS, GAP_PAGE_ATTEMPTS, getStreamDOStub } from '../src/dos/StreamDO';
import type { StreamOutcome } from '../src/dos/StreamDO';
import { archiveObjectKey, writeArchivedBatch } from '../src/relay/archive';
import { GENESIS_HASH, chainHash } from '../src/relay/chain';
import {
  SLACK_WEBHOOK,
  auditBatch,
  axiomOk,
  axiomRequests,
  env,
  eventIds,
  listObjectKeys,
  pageTexts,
  readArchived,
  recordingFetch,
  requestBodyOf,
  uniqueStream,
} from './helpers';

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
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);

    const stored = await readArchived(stream, 5);
    expect(stored.prevHash).toBe(first.hash);
    expect(stored.hash).toBe(second.hash);

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

    const batch = auditBatch(1, 2, stream);
    accepted(await stub.acceptBatch(batch));
    const duplicate = await stub.acceptBatch(batch);

    expect(duplicate).toMatchObject({ kind: 'duplicate', toSeq: 2, headSeq: 2 });
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([archiveObjectKey(stream, 2)]);
    expect(http.requests).toHaveLength(1);
  });

  it('accepts a redelivered suffix of an archived batch that matches it', async () => {
    const stream = uniqueStream('duplicate-suffix');
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stub = getStreamDOStub(env, stream);
    const batch = auditBatch(1, 4, stream);
    accepted(await stub.acceptBatch(batch));

    const suffix = { ...batch, fromSeq: 3, events: batch.events.slice(2) };
    expect(await stub.acceptBatch(suffix)).toMatchObject({ kind: 'duplicate', toSeq: 4 });
  });

  it('reports a duplicate whose content differs from the archive and never replays it', async () => {
    const stream = uniqueStream('duplicate-forged');
    let reject = true;
    const http = recordingFetch(request =>
      reject && request.url !== SLACK_WEBHOOK ? new Response('invalid', { status: 400 }) : axiomOk()
    );
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);
    const batch = auditBatch(1, 2, stream);
    expect(await stub.acceptBatch(batch)).toMatchObject({ kind: 'accepted', hotCopy: 'owed' });
    reject = false;

    const forged = auditBatch(1, 2, stream);
    expect(await stub.acceptBatch(forged)).toEqual({
      kind: 'duplicate_mismatch',
      stream,
      fromSeq: 1,
      toSeq: 2,
      reason: 'content',
    });
    const suffix = { ...forged, fromSeq: 2, events: forged.events.slice(1) };
    expect(await stub.acceptBatch(suffix)).toMatchObject({
      kind: 'duplicate_mismatch',
      reason: 'content',
    });
    expect(axiomRequests(http.requests)).toHaveLength(1);
    expect(await stub.hotStoreGaps()).toHaveLength(1);
  });

  it('reports a duplicate that ends inside an archived batch', async () => {
    const stream = uniqueStream('duplicate-unaligned');
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stub = getStreamDOStub(env, stream);
    const batch = auditBatch(1, 4, stream);
    accepted(await stub.acceptBatch(batch));

    const prefix = { ...batch, toSeq: 2, events: batch.events.slice(0, 2) };
    expect(await stub.acceptBatch(prefix)).toMatchObject({
      kind: 'duplicate_mismatch',
      reason: 'unaligned',
    });
  });

  it('retries a gap and accepts the batch once the missing range arrives', async () => {
    const stream = uniqueStream('gap');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const gap = await stub.acceptBatch(auditBatch(3, 5, stream));
    expect(gap).toMatchObject({ kind: 'retry', reason: 'gap', delaySeconds: 30 });
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);

    accepted(await stub.acceptBatch(auditBatch(1, 2, stream)));
    const filled = accepted(await stub.acceptBatch(auditBatch(3, 5, stream)));
    expect(filled).toMatchObject({ fromSeq: 3, toSeq: 5 });
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);
  });

  it('pages once when a gap outlasts both thresholds, and watches the next gap afresh', async () => {
    const stream = uniqueStream('gap-stalled');
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stub = getStreamDOStub(env, stream);
    const later = auditBatch(3, 5, stream);

    // A burst of batches past the gap reaches the attempt count at once, but not the age.
    for (let attempt = 1; attempt <= GAP_PAGE_ATTEMPTS; attempt += 1) {
      expect(await stub.acceptBatch(later)).toMatchObject({ kind: 'retry', reason: 'gap' });
    }

    // The same gap, first seen past the age threshold: the next batch pages, later ones do not.
    await runInDurableObject(stub, async (_instance, state) => {
      const watch = await state.storage.get<{ since: number }>('gap');
      if (!watch) throw new Error('gap watch missing');
      await state.storage.put('gap', { ...watch, since: Date.now() - GAP_PAGE_AFTER_MS });
    });
    expect(await stub.acceptBatch(later)).toMatchObject({
      kind: 'gap_stalled',
      expectedSeq: 1,
      attempts: GAP_PAGE_ATTEMPTS + 1,
      delaySeconds: 30,
    });
    expect(await stub.acceptBatch(later)).toMatchObject({ kind: 'retry', reason: 'gap' });

    accepted(await stub.acceptBatch(auditBatch(1, 2, stream)));
    expect(await stub.acceptBatch(auditBatch(4, 6, stream))).toMatchObject({
      kind: 'retry',
      reason: 'gap',
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('gap')).toMatchObject({
        expectedSeq: 3,
        attempts: 1,
        paged: false,
      });
    });
  });

  it('accepts only the new suffix of a partially overlapping batch', async () => {
    const stream = uniqueStream('overlap');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    const head = accepted(await stub.acceptBatch(auditBatch(1, 3, stream)));
    const overlap = accepted(await stub.acceptBatch(auditBatch(2, 5, stream)));

    expect(overlap).toMatchObject({ fromSeq: 4, toSeq: 5 });
    const stored = await readArchived(stream, 5);
    expect(stored.prevHash).toBe(head.hash);
    expect(stored.batch.fromSeq).toBe(4);
    expect(stored.batch.events.map(event => event.data.attributes.seq)).toEqual([4, 5]);
    expect(requestBodyOf(http.requests[1])).toHaveLength(2);
  });

  it('acks an archived batch during an Axiom outage and delivers it from the alarm', async () => {
    const stream = uniqueStream('axiom-outage');
    let failing = true;
    const http = recordingFetch(request => {
      if (request.url === SLACK_WEBHOOK) return axiomOk();
      return failing ? new Response('unavailable', { status: 503 }) : axiomOk();
    });
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);
    const first = auditBatch(1, 2, stream);
    const second = auditBatch(3, 5, stream);

    expect(await stub.acceptBatch(first)).toMatchObject({
      kind: 'accepted',
      archive: 'written',
      hotCopy: 'owed',
    });
    // The whole hot copy is failing, so the next batch is archived without its own Axiom call.
    expect(await stub.acceptBatch(second)).toMatchObject({ kind: 'accepted', hotCopy: 'owed' });
    expect(axiomRequests(http.requests)).toHaveLength(1);
    expect((await stub.hotStoreGaps()).map(row => [row.fromSeq, row.toSeq, row.reason])).toEqual([
      [1, 2, 'axiom_unavailable'],
      [3, 5, 'pending'],
    ]);

    // Still down for two alarm runs in a row: that is a real failure, so the second run pages.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(axiomRequests(http.requests)).toHaveLength(2);
    expect(pageTexts(http.requests)).toEqual([]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(axiomRequests(http.requests)).toHaveLength(3);
    expect(await stub.hotStoreGaps()).toHaveLength(2);

    failing = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.hotStoreGaps()).toEqual([]);
    const delivered = axiomRequests(http.requests).slice(-2).map(eventIds);
    expect(delivered).toEqual([first.events.map(e => e.id), second.events.map(e => e.id)]);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
    ]);
    const failingPage = new RegExp(
      `^bot: audit stream ${stream}: the Axiom hot copy is failing \\(axiom_unavailable\\) since `
    );
    const recoveredPage = new RegExp(
      `^bot: audit stream ${stream}: the Axiom hot copy recovered from axiom_unavailable`
    );
    expect(pageTexts(http.requests)).toEqual([
      expect.stringMatching(failingPage),
      expect.stringMatching(recoveredPage),
    ]);

    // A second real failure inside the hour is retried and logged, but pages nothing.
    failing = true;
    expect(await stub.acceptBatch(auditBatch(6, 7, stream))).toMatchObject({ hotCopy: 'owed' });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    failing = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.hotStoreGaps()).toEqual([]);
    expect(pageTexts(http.requests)).toHaveLength(2);
  });

  it('pages nothing for failures the next alarm run clears', async () => {
    const stream = uniqueStream('axiom-sporadic');
    let failing = false;
    const http = recordingFetch(request => {
      if (request.url === SLACK_WEBHOOK) return axiomOk();
      return failing ? new Response('unavailable', { status: 503 }) : axiomOk();
    });
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    for (let round = 0; round < 3; round += 1) {
      failing = true;
      const batch = auditBatch(round * 2 + 1, round * 2 + 2, stream);
      expect(await stub.acceptBatch(batch)).toMatchObject({ hotCopy: 'owed' });
      failing = false;
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await stub.hotStoreGaps()).toEqual([]);
    }
    expect(axiomRequests(http.requests)).toHaveLength(6);
    expect(pageTexts(http.requests)).toEqual([]);
  });

  it('parks a row Axiom rejects and still delivers the batches after it', async () => {
    const stream = uniqueStream('axiom-reject');
    const http = recordingFetch(request => {
      if (request.url === SLACK_WEBHOOK) return axiomOk();
      return requestBodyOf(request).length === 2
        ? new Response('invalid', { status: 400 })
        : axiomOk();
    });
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    expect(await stub.acceptBatch(auditBatch(1, 2, stream))).toMatchObject({ hotCopy: 'owed' });
    expect(await stub.acceptBatch(auditBatch(3, 5, stream))).toMatchObject({
      hotCopy: 'delivered',
    });
    // The parked row is not the alarm's any more: the run finds nothing to deliver.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(axiomRequests(http.requests)).toHaveLength(2);
    expect((await stub.hotStoreGaps()).map(row => [row.fromSeq, row.reason])).toEqual([
      [1, 'axiom_rejected'],
    ]);
    expect(pageTexts(http.requests)).toEqual([
      `bot: audit stream ${stream}: parked seq 1..2 (axiom_rejected); the alarm no longer retries it, check the payload and clear it with clearHotStoreGap`,
    ]);

    await stub.clearHotStoreGap(1, 2);
    expect(await stub.hotStoreGaps()).toEqual([]);
  });

  it('parks 60 undeliverable rows without starving the row behind them', async () => {
    const stream = uniqueStream('poison-rows');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    // Rows 1..60 name archive objects that do not exist (archive_unreadable); 61..62 is genuine.
    const good = auditBatch(61, 62, stream);
    await writeArchivedBatch(env.AUDIT_ARCHIVE, {
      batch: good,
      prevHash: GENESIS_HASH,
      hash: await chainHash(GENESIS_HASH, good),
    });
    const recordedAt = new Date().toISOString();
    await runInDurableObject(stub, async (_instance, state) => {
      const rows: Record<string, unknown> = {};
      for (let seq = 1; seq <= 60; seq += 1) {
        rows[`hot_copy:${String(seq).padStart(12, '0')}`] = {
          stream,
          fromSeq: seq,
          toSeq: seq,
          reason: 'pending',
          recordedAt,
        };
      }
      rows['hot_copy:000000000062'] = {
        stream,
        fromSeq: 61,
        toSeq: 62,
        reason: 'pending',
        recordedAt,
      };
      await state.storage.put(rows);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    // The first run parks 50 rows and, having listed a full page, re-arms at once; the second
    // parks the other 10 and delivers the genuine row.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(axiomRequests(http.requests).map(eventIds)).toEqual([good.events.map(e => e.id)]);
    });
    const gaps = await stub.hotStoreGaps(100);
    expect(gaps).toHaveLength(60);
    expect(gaps.every(row => row.reason === 'archive_unreadable')).toBe(true);
    expect(pageTexts(http.requests)).toHaveLength(1);
  });

  it('re-ingests an owed row from the archive, never from a redelivered message', async () => {
    const stream = uniqueStream('hot-pending');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = getStreamDOStub(env, stream);

    // What the commit write leaves if the instance dies before the ingest: archive objects for
    // 1..2 and 3..4, the head, the pending row for 1..2 and the safety-net alarm.
    const genuine = auditBatch(1, 4, stream);
    const low = { ...genuine, toSeq: 2, events: genuine.events.slice(0, 2) };
    const high = { ...genuine, fromSeq: 3, events: genuine.events.slice(2) };
    const lowHash = await chainHash(GENESIS_HASH, low);
    const highHash = await chainHash(lowHash, high);
    await writeArchivedBatch(env.AUDIT_ARCHIVE, {
      batch: low,
      prevHash: GENESIS_HASH,
      hash: lowHash,
    });
    await writeArchivedBatch(env.AUDIT_ARCHIVE, { batch: high, prevHash: lowHash, hash: highHash });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        head: { seq: 4, hash: highHash },
        'hot_copy:000000000002': {
          stream,
          fromSeq: 1,
          toSeq: 2,
          reason: 'pending',
          recordedAt: new Date().toISOString(),
        },
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    // A redelivery whose prefix is forged ends in the genuine object 3..4, so it compares equal
    // there; its events for the owed row 1..2 are never sent to Axiom.
    const forged = { ...genuine, events: [...auditBatch(1, 2, stream).events, ...high.events] };
    expect(await stub.acceptBatch(forged)).toMatchObject({ kind: 'duplicate', toSeq: 4 });
    expect(http.requests).toEqual([]);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(axiomRequests(http.requests).map(eventIds)).toEqual([low.events.map(e => e.id)]);
    expect(http.requests[0].url).toBe('https://api.axiom.co/v1/datasets/kilo-audit-test/ingest');
    expect(await stub.hotStoreGaps()).toEqual([]);
  });
});

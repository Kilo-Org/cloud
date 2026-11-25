import { decodeAuditBatch, encodeAuditBatch } from '@kilocode/sts-contracts';
import {
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { archiveRetryDelaySeconds } from '../src/queue';
import { GAP_PAGE_AFTER_MS, GAP_PAGE_ATTEMPTS, getStreamDOStub } from '../src/dos/StreamDO';
import { archiveObjectKey, deadLetterKey } from '../src/relay/archive';
import {
  SLACK_WEBHOOK,
  auditBatch,
  axiomOk,
  axiomRequests,
  env,
  listObjectKeys,
  pageTexts,
  recordingFetch,
  uniqueStream,
} from './helpers';

const DLQ_PAGE_HEAD =
  'bot: audit-relay gave up on message(s) from kilo-audit-dlq (at most one page per stream an hour; the rest are in the logs). A stream behind a lost batch stalls until it is re-sent:';

async function runQueue(queue: string, bodies: unknown[], attempts = 1) {
  const batch = createMessageBatch(
    queue,
    bodies.map(body => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts,
      body,
    }))
  );
  const ctx = createExecutionContext();
  await worker.queue?.(batch, env);
  await waitOnExecutionContext(ctx);
  return { batch, result: await getQueueResult(batch, ctx) };
}

async function encoded(stream: string) {
  return (await encodeAuditBatch(auditBatch(1, 2, stream))).buffer;
}

async function storedBytes(key: string): Promise<Uint8Array> {
  const object = await env.AUDIT_ARCHIVE.get(key);
  if (!object) throw new Error(`object ${key} missing`);
  return new Uint8Array(await object.arrayBuffer());
}

describe('queue handler', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await abortAllDurableObjects();
  });

  it('acks an in-order batch and archives it', async () => {
    const stream = uniqueStream('queue-accept');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);

    const { result } = await runQueue('kilo-audit', [await encoded(stream)]);

    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toEqual([]);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([archiveObjectKey(stream, 2)]);
  });

  it('retries a gap message with a delay', async () => {
    const stream = uniqueStream('queue-gap');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);

    const { batch, result } = await runQueue('kilo-audit', [
      (await encodeAuditBatch(auditBatch(3, 5, stream))).buffer,
    ]);

    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toEqual([{ msgId: batch.messages[0].id }]);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);
  });

  it('keeps a body that cannot be decoded under dead-letter/unknown instead of dropping it', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const payload = new TextEncoder().encode('not a gzip frame');

    const { batch, result } = await runQueue('kilo-audit', [payload.buffer]);

    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(1);
    const [message] = batch.messages;
    const key = deadLetterKey(null, message.timestamp, message.id);
    expect(await storedBytes(key)).toEqual(payload);
    const pages = pageTexts(http.requests);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain(`\nunknown stream (undecodable) after 1 attempts at ${key}`);
  });

  it('archives dead-lettered batches of several streams once their cause is gone', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const first = uniqueStream('queue-dlq-resume-a');
    const second = uniqueStream('queue-dlq-resume-b');
    const low = await encodeAuditBatch(auditBatch(1, 2, first));
    const high = await encodeAuditBatch(auditBatch(3, 4, first));
    const other = [1, 3, 5].map(from => encodeAuditBatch(auditBatch(from, from + 1, second)));
    const [otherLow, otherMid, otherHigh] = await Promise.all(other);

    // What an R2 outage leaves: batches of two streams dead-lettered, interleaved and out of order.
    const { result } = await runQueue('kilo-audit-dlq', [
      otherHigh.buffer,
      high.buffer,
      otherLow.buffer,
      low.buffer,
      otherMid.buffer,
    ]);

    expect(result.explicitAcks).toHaveLength(5);
    expect(result.retryMessages).toEqual([]);
    expect(await listObjectKeys(`streams/${first}/`)).toEqual([
      archiveObjectKey(first, 2),
      archiveObjectKey(first, 4),
    ]);
    expect(await listObjectKeys(`streams/${second}/`)).toEqual([
      archiveObjectKey(second, 2),
      archiveObjectKey(second, 4),
      archiveObjectKey(second, 6),
    ]);
    expect(await listObjectKeys(`dead-letter/${first}/`)).toEqual([]);
    expect(await listObjectKeys(`dead-letter/${second}/`)).toEqual([]);
    expect(pageTexts(http.requests)).toEqual([]);

    // A dead letter whose batch is already archived, byte for byte, is acked with nothing kept.
    const again = await runQueue('kilo-audit-dlq', [low.buffer]);
    expect(again.result.explicitAcks).toHaveLength(1);
    expect(await listObjectKeys(`dead-letter/${first}/`)).toEqual([]);
    expect(pageTexts(http.requests)).toEqual([]);
  });

  it("offers only the first of a stream's batches behind a gap and keeps the rest waiting", async () => {
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stream = uniqueStream('queue-dlq-blocked');
    const bodies = await Promise.all(
      [3, 5, 7].map(
        async from => (await encodeAuditBatch(auditBatch(from, from + 1, stream))).buffer
      )
    );

    const { result } = await runQueue('kilo-audit-dlq', bodies);

    expect(result.retryMessages).toHaveLength(3);
    expect(await listObjectKeys(`dead-letter/${stream}/`)).toHaveLength(3);
    await runInDurableObject(getStreamDOStub(env, stream), async (_instance, state) => {
      expect(await state.storage.get('gap')).toMatchObject({ expectedSeq: 1, attempts: 1 });
    });
  });

  it('keeps a batch still behind a gap, retries it, and pages its final delivery once an hour', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stream = uniqueStream('queue-dlq');
    const bytes = await encodeAuditBatch(auditBatch(3, 5, stream));
    const later = await encodeAuditBatch(auditBatch(6, 7, stream));

    const waiting = await runQueue('kilo-audit-dlq', [bytes.buffer]);
    expect(waiting.result.explicitAcks).toEqual([]);
    expect(waiting.result.retryMessages).toEqual([
      expect.objectContaining({ msgId: waiting.batch.messages[0].id }),
    ]);
    const [dead] = waiting.batch.messages;
    const deadKey = deadLetterKey(stream, dead.timestamp, dead.id);
    expect(deadKey).toBe(`dead-letter/${stream}/${dead.timestamp.toISOString()}-${dead.id}.gz`);
    expect(await storedBytes(deadKey)).toEqual(bytes);
    expect(pageTexts(http.requests)).toEqual([]);

    const final = await runQueue('kilo-audit-dlq', [bytes.buffer, 'not bytes'], 101);
    expect(final.result.explicitAcks).toHaveLength(2);
    const [last, odd] = final.batch.messages;
    expect(
      new TextDecoder().decode(await storedBytes(deadLetterKey(null, odd.timestamp, odd.id)))
    ).toBe('not bytes');
    const pages = pageTexts(http.requests);
    expect(pages).toHaveLength(1);
    expect(pages[0].startsWith(DLQ_PAGE_HEAD)).toBe(true);
    expect(pages[0]).toContain(
      `\n${stream} seq 3..5 (gap) after 101 attempts at ${deadLetterKey(stream, last.timestamp, last.id)}`
    );
    const { events } = await decodeAuditBatch(bytes);
    expect(events.some(event => pages[0].includes(event.id))).toBe(false);
    expect(axiomRequests(http.requests)).toEqual([]);

    // A second lost batch of the same stream inside the hour is stored and acked, unpaged.
    const second = await runQueue('kilo-audit-dlq', [later.buffer], 101);
    expect(second.result.explicitAcks).toHaveLength(1);
    expect(pageTexts(http.requests)).toHaveLength(1);
  });

  it('pages a dead letter that disagrees with the archived batch it duplicates', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stream = uniqueStream('queue-dlq-forged');
    await runQueue('kilo-audit', [await encoded(stream)]);

    const { batch, result } = await runQueue('kilo-audit-dlq', [await encoded(stream)]);

    expect(result.explicitAcks).toHaveLength(1);
    const [message] = batch.messages;
    const key = deadLetterKey(stream, message.timestamp, message.id);
    expect(await env.AUDIT_ARCHIVE.head(key)).not.toBe(null);
    expect(pageTexts(http.requests)).toEqual([
      `${DLQ_PAGE_HEAD}\n${stream} seq 1..2 (duplicate_content) after 1 attempts at ${key}`,
    ]);
  });

  it('backs the archive retry off to 15 minutes, covering more than 5 hours in 24 retries', () => {
    const delays = Array.from({ length: 24 }, (_, index) => archiveRetryDelaySeconds(index + 1));
    expect(delays.slice(0, 5)).toEqual([60, 120, 240, 480, 900]);
    expect(delays.slice(4).every(delay => delay === 900)).toBe(true);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(5 * 3600);
  });

  it('retries a dead letter whose R2 write fails and pages nothing for it', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const failingEnv = {
      ...env,
      AUDIT_ARCHIVE: {
        ...env.AUDIT_ARCHIVE,
        put: async () => {
          throw new Error('r2 unavailable');
        },
        head: async () => null,
      },
    };
    const batch = createMessageBatch('kilo-audit-dlq', [
      { id: crypto.randomUUID(), timestamp: new Date(), attempts: 3, body: 'lost' },
    ]);
    const ctx = createExecutionContext();
    await worker.queue?.(batch, failingEnv);
    await waitOnExecutionContext(ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([
      expect.objectContaining({ msgId: batch.messages[0].id }),
    ]);
    expect(pageTexts(http.requests)).toEqual([]);
  });

  it('pages a dead letter whose bytes still cannot be stored at its final delivery', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stream = uniqueStream('queue-dlq-store-failed');
    const failingEnv = {
      ...env,
      AUDIT_ARCHIVE: {
        ...env.AUDIT_ARCHIVE,
        put: async () => {
          throw new Error('r2 unavailable');
        },
        head: async () => null,
      },
    };
    const body = (await encodeAuditBatch(auditBatch(3, 4, stream))).buffer;
    const batch = createMessageBatch('kilo-audit-dlq', [
      { id: crypto.randomUUID(), timestamp: new Date(), attempts: 101, body },
    ]);
    const ctx = createExecutionContext();
    await worker.queue?.(batch, failingEnv);
    await waitOnExecutionContext(ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toHaveLength(1);
    expect(pageTexts(http.requests)).toEqual([
      `${DLQ_PAGE_HEAD}\n${stream} seq 3..4 (gap, store_failed) after 101 attempts and its bytes could not be stored`,
    ]);
  });

  it('acks batches archived without the hot copy and leaves the paging to the alarm', async () => {
    const stream = uniqueStream('queue-drop');
    const http = recordingFetch(request =>
      request.url === SLACK_WEBHOOK ? axiomOk() : new Response('unavailable', { status: 503 })
    );
    vi.stubGlobal('fetch', http.impl);

    const first = await runQueue('kilo-audit', [await encoded(stream)]);
    const second = await runQueue('kilo-audit', [
      (await encodeAuditBatch(auditBatch(3, 4, stream))).buffer,
    ]);

    for (const { result } of [first, second]) {
      expect(result.retryMessages).toEqual([]);
      expect(result.explicitAcks).toHaveLength(1);
    }
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 4),
    ]);
    // One inline call, then the stream leaves its rows to the alarm; a failure no alarm run has
    // confirmed yet pages nothing.
    expect(axiomRequests(http.requests)).toHaveLength(1);
    expect(pageTexts(http.requests)).toEqual([]);
  });

  it('pages and acks a duplicate whose content differs from the archive', async () => {
    const stream = uniqueStream('queue-forged');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    await runQueue('kilo-audit', [await encoded(stream)]);

    const { result } = await runQueue('kilo-audit', [await encoded(stream)]);

    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(1);
    const pages = http.requests.filter(
      request => request.url === 'https://hooks.slack.test/audit-relay'
    );
    expect(pages.map(page => JSON.parse(page.body ?? '{}'))).toEqual([
      {
        text: `bot: audit stream ${stream} received seq 1..2 again and it disagrees with the archive: content`,
      },
    ]);
  });

  it('pages and still retries a batch held behind a stalled gap', async () => {
    const stream = uniqueStream('queue-stalled');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    await runInDurableObject(getStreamDOStub(env, stream), async (_instance, state) => {
      await state.storage.put('gap', {
        expectedSeq: 1,
        since: Date.now() - GAP_PAGE_AFTER_MS,
        attempts: GAP_PAGE_ATTEMPTS - 1,
        paged: false,
      });
    });

    const { batch, result } = await runQueue('kilo-audit', [
      (await encodeAuditBatch(auditBatch(3, 5, stream))).buffer,
    ]);

    expect(result.retryMessages).toEqual([
      expect.objectContaining({ msgId: batch.messages[0].id }),
    ]);
    const pages = http.requests.filter(
      request => request.url === 'https://hooks.slack.test/audit-relay'
    );
    expect(pages.map(page => JSON.parse(page.body ?? '{}'))).toEqual([
      {
        text: expect.stringMatching(
          new RegExp(
            `^bot: audit stream ${stream} has waited \\d+ s for seq 1 and turned away 10 later batches$`
          )
        ),
      },
    ]);
  });
});

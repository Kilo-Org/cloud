import { encodeAuditBatch } from '@kilocode/sts-contracts';
import {
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { archiveObjectKey } from '../src/relay/archive';
import {
  auditBatch,
  axiomOk,
  env,
  listObjectKeys,
  recordingFetch,
  uniqueStream,
} from './helpers';

async function runQueue(queue: string, bodies: unknown[]) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body, index) => ({
      id: `message-${index}`,
      timestamp: Date.now(),
      attempts: 1,
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
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([
      archiveObjectKey(stream, 2),
    ]);
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

  it('acks a body that cannot be decoded instead of retrying it forever', async () => {
    const payload = new TextEncoder().encode('not a gzip frame').buffer;
    const { result } = await runQueue('kilo-audit', [payload]);

    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(1);
  });

  it('acks dead-letter messages without decoding them', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);

    const { result } = await runQueue('kilo-audit-dlq', ['anything']);

    expect(result.explicitAcks).toHaveLength(1);
    expect(http.requests).toEqual([]);
  });

  it('pages and acks a batch archived without the hot copy', async () => {
    const stream = uniqueStream('queue-drop');
    const http = recordingFetch(request =>
      request.url.startsWith('https://api.axiom.co')
        ? new Response('invalid', { status: 400 })
        : axiomOk()
    );
    vi.stubGlobal('fetch', http.impl);

    const { result } = await runQueue('kilo-audit', [await encoded(stream)]);

    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(1);
    const page = http.requests.find(
      request => request.url === 'https://hooks.slack.test/audit-relay'
    );
    expect(page).toBeDefined();
    expect(JSON.parse(page?.body ?? '{}')).toMatchObject({
      text: expect.stringMatching(/^bot: audit stream .* without the hot copy: axiom_rejected$/),
    });
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
});

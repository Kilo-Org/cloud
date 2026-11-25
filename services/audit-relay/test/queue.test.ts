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
import { z } from 'zod';
import worker from '../src';
import { GAP_PAGE_AFTER_MS, GAP_PAGE_ATTEMPTS, getStreamDOStub } from '../src/dos/StreamDO';
import { archiveObjectKey, deadLetterKey } from '../src/relay/archive';
import {
  auditBatch,
  axiomOk,
  env,
  listObjectKeys,
  recordingFetch,
  uniqueStream,
  type CapturedRequest,
} from './helpers';

async function runQueue(queue: string, bodies: unknown[]) {
  const batch = createMessageBatch(
    queue,
    bodies.map(body => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
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

async function storedBytes(key: string): Promise<Uint8Array> {
  const object = await env.AUDIT_ARCHIVE.get(key);
  if (!object) throw new Error(`object ${key} missing`);
  return new Uint8Array(await object.arrayBuffer());
}

const PageSchema = z.object({ text: z.string() });

function pageTexts(requests: CapturedRequest[]): string[] {
  return requests
    .filter(request => request.url === 'https://hooks.slack.test/audit-relay')
    .map(request => PageSchema.parse(JSON.parse(request.body ?? '{}')).text);
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
    expect(pageTexts(http.requests)).toEqual([
      `bot: audit-relay kept 1 undelivered message(s) from kilo-audit in R2; each named stream stalls until its batch is re-sent:\nunknown stream after 1 attempts at ${key}`,
    ]);
  });

  it('keeps each dead letter as raw bytes in R2, pages once without the payload, then acks', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stream = uniqueStream('queue-dlq');
    const bytes = await encodeAuditBatch(auditBatch(3, 5, stream));

    const { batch, result } = await runQueue('kilo-audit-dlq', [bytes.buffer, 'not bytes']);

    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toEqual([]);
    const [dead, odd] = batch.messages;
    const deadKey = deadLetterKey(stream, dead.timestamp, dead.id);
    const oddKey = deadLetterKey(null, odd.timestamp, odd.id);
    expect(deadKey).toBe(`dead-letter/${stream}/${dead.timestamp.toISOString()}-${dead.id}.gz`);
    expect(await storedBytes(deadKey)).toEqual(bytes);
    expect(new TextDecoder().decode(await storedBytes(oddKey))).toBe('not bytes');
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);

    const pages = pageTexts(http.requests);
    expect(pages).toEqual([
      `bot: audit-relay kept 2 undelivered message(s) from kilo-audit-dlq in R2; each named stream stalls until its batch is re-sent:\n${stream} seq 3..5 after 1 attempts at ${deadKey}\nunknown stream after 1 attempts at ${oddKey}`,
    ]);
    const { events } = await decodeAuditBatch(bytes);
    expect(events.some(event => pages[0].includes(event.id))).toBe(false);
    expect(http.requests.filter(request => request.url.startsWith('https://api.axiom.co'))).toEqual(
      []
    );
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

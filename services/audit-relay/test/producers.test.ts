import { encodeAuditBatch, type AuditBatch } from '@kilocode/sts-contracts';
import {
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { archiveObjectKey, deadLetterKey } from '../src/relay/archive';
import {
  auditBatch,
  axiomOk,
  env,
  listObjectKeys,
  pageTexts,
  recordingFetch,
  uniqueStream,
} from './helpers';

async function runQueue(queue: string, batch: AuditBatch) {
  const messages = createMessageBatch(queue, [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: (await encodeAuditBatch(batch)).buffer,
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue?.(messages, env);
  await waitOnExecutionContext(ctx);
  return { messages, result: await getQueueResult(messages, ctx) };
}

/** A migration proxy batch: its own stream name and event source. */
function proxyBatch(stream: string): AuditBatch {
  const batch = auditBatch(1, 2, stream);
  return {
    ...batch,
    events: batch.events.map(event => ({
      ...event,
      source: 'kilo:migration-proxy:production',
      type: 'ai.kilo.migration_proxy.session_sampled',
    })),
  };
}

const proxyStream = (label: string) =>
  `migration-proxy:production:runs-${label}-${crypto.randomUUID()}`;

describe('per-queue producers', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await abortAllDurableObjects();
  });

  it('archives a migration proxy batch from its own queue', async () => {
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stream = proxyStream('own');
    const { result } = await runQueue('kilo-audit-migration-proxy', proxyBatch(stream));
    expect(result.explicitAcks).toHaveLength(1);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([archiveObjectKey(stream, 2)]);
  });

  it('dead-letters and pages an STS stream on the migration proxy queue', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stream = uniqueStream('on-proxy-queue');
    const { messages, result } = await runQueue(
      'kilo-audit-migration-proxy',
      auditBatch(1, 2, stream)
    );
    expect(result.explicitAcks).toHaveLength(1);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);
    const [message] = messages.messages;
    expect(await listObjectKeys(`dead-letter/${stream}/`)).toEqual([]);
    expect(await listObjectKeys('dead-letter/foreign/kilo-audit-migration-proxy/')).toContain(
      deadLetterKey('foreign/kilo-audit-migration-proxy', message.timestamp, message.id)
    );
    const pages = pageTexts(http.requests).join('\n');
    expect(pages).toContain('foreign/kilo-audit-migration-proxy (foreign_producer)');
    expect(pages).not.toContain(stream);
  });

  it('dead-letters a migration proxy stream on the STS queue and its DLQ', async () => {
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    for (const queue of ['kilo-audit', 'kilo-audit-dlq']) {
      const stream = proxyStream(queue);
      const { result } = await runQueue(queue, proxyBatch(stream));
      expect(result.explicitAcks, queue).toHaveLength(1);
      expect(await listObjectKeys(`streams/${stream}/`), queue).toEqual([]);
      expect(await listObjectKeys(`dead-letter/${stream}/`), queue).toEqual([]);
      expect(await listObjectKeys(`dead-letter/foreign/${queue}/`), queue).not.toEqual([]);
    }
  });

  it('dead-letters a batch whose stream is right but whose events name another source', async () => {
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stream = proxyStream('forged-source');
    const { result } = await runQueue('kilo-audit-migration-proxy', auditBatch(1, 2, stream));
    expect(result.explicitAcks).toHaveLength(1);
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);
  });

  it('dead-letters every batch on a queue no producer owns', async () => {
    vi.stubGlobal('fetch', recordingFetch(axiomOk).impl);
    const stream = uniqueStream('unknown-queue');
    await runQueue('kilo-audit-unknown', auditBatch(1, 2, stream));
    expect(await listObjectKeys(`streams/${stream}/`)).toEqual([]);
  });
});

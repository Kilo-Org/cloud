import type { RequestListener } from 'node:http';
import { expect, it } from 'vitest';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaMessage, exaRecord } from './exa-usage.test-fixture';
import { withTaggedConsumerRuntime } from './tagged-consumer.test-fixture';
import { usage } from './usage.test-fixture';

type ExaReply = 'recorded' | 'duplicate' | 'admission' | 'wrong_echo' | 'missing_echo';

it('routes tagged Exa messages through workerd and keeps LLM and Enkrypt dispositions', async () => {
  const calls: { path: string | undefined; body: unknown; source: unknown }[] = [];
  let exaReply: ExaReply = 'recorded';
  const handleWrite: RequestListener = async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    calls.push({ path: request.url, body: event, source: request.headers['x-usage-write-source'] });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/internal/usage/record') {
      response.end(
        JSON.stringify({
          status: 'recorded',
          result: {
            usageId: event.core.id,
            createdAt: event.core.created_at,
            newMicrodollarsUsed: 1,
          },
        })
      );
    } else if (request.url === '/api/internal/enkrypt-usage/record') {
      response.end(JSON.stringify({ status: 'recorded', usageId: event.id }));
    } else if (exaReply === 'admission') {
      response.statusCode = 429;
      response.end(JSON.stringify({ error: 'Usage writer overloaded', reason: 'queue_limit' }));
    } else if (exaReply === 'wrong_echo') {
      response.end(
        JSON.stringify({ status: 'recorded', usageId: '7b2d3f4a-5c6e-4f7a-9b8c-0d1e2f3a4b5c' })
      );
    } else if (exaReply === 'missing_echo') {
      response.end(JSON.stringify({ status: 'recorded' }));
    } else {
      response.end(JSON.stringify({ status: exaReply, usageId: event.id }));
    }
  };
  await withTaggedConsumerRuntime('exa', handleWrite, async ({ deliver, logs }) => {
    const exaCall = { path: '/api/internal/exa-usage/record', body: exaRecord, source: 'queue' };

    for (const reply of ['recorded', 'duplicate'] as const) {
      exaReply = reply;
      const result = await deliver(exaMessage);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual(['queue-0']);
      expect(result.retryMessages).toEqual([]);
      expect(calls.at(-1)).toEqual(exaCall);
    }

    exaReply = 'admission';
    const admission = await deliver(exaMessage);
    expect(admission.outcome).toBe('exception');
    expect(admission.explicitAcks).toEqual([]);
    expect(admission.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
    expect(admission.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(1);
    expect(admission.retryMessages[0].delaySeconds).toBeLessThanOrEqual(4);
    expect(calls.at(-1)).toEqual(exaCall);

    for (const reply of ['wrong_echo', 'missing_echo'] as const) {
      exaReply = reply;
      const result = await deliver(exaMessage);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
      expect(result.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(60);
      expect(result.retryMessages[0].delaySeconds).toBeLessThanOrEqual(120);
      expect(calls.at(-1)).toEqual(exaCall);
    }

    const writesBeforeRejected = calls.length;
    for (const body of [
      { ...exaMessage, v: 2 },
      { ...exaMessage, record: { ...exaRecord, id: 'not-a-uuid' } },
      { ...exaMessage, record: enkryptRecord },
    ]) {
      const result = await deliver(body);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
      expect(result.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(60);
      expect(result.retryMessages[0].delaySeconds).toBeLessThanOrEqual(120);
    }
    expect(calls).toHaveLength(writesBeforeRejected);

    exaReply = 'recorded';
    const mixed = await deliver(usage, enkryptMessage, exaMessage);
    expect(mixed.outcome).toBe('ok');
    expect(mixed.explicitAcks.toSorted()).toEqual(['queue-0', 'queue-1', 'queue-2']);
    expect(mixed.retryMessages).toEqual([]);
    expect(
      calls.slice(-3).toSorted((a, b) => String(a.path).localeCompare(String(b.path)))
    ).toEqual([
      { path: '/api/internal/enkrypt-usage/record', body: enkryptRecord, source: 'queue' },
      exaCall,
      { path: '/api/internal/usage/record', body: usage, source: 'queue' },
    ]);

    const processing = logs
      .map(log => JSON.stringify(log))
      .filter(log => log.includes('usage_ingest_processing'));
    const llmProcessing = processing.filter(log => log.includes(usage.core.id));
    expect(llmProcessing).toHaveLength(1);
    expect(llmProcessing[0]).not.toContain('usage_kind');
    expect(processing.filter(log => log.includes(exaRecord.id))).toHaveLength(6);
    expect(
      processing.filter(log => log.includes(exaRecord.id)).every(log => log.includes('exa_usage'))
    ).toBe(true);
    const serialized = JSON.stringify(logs);
    for (const sensitive of [
      'synthetic-writer-secret',
      'synthetic-bypass-secret',
      exaRecord.userId,
      exaRecord.organizationId,
      exaRecord.occurredAt,
      exaRecord.featureId,
      exaRecord.type,
    ]) {
      if (sensitive) expect(serialized).not.toContain(sensitive);
    }
  });
}, 30_000);

import type { RequestListener } from 'node:http';
import { expect, it } from 'vitest';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { withTaggedConsumerRuntime } from './tagged-consumer.test-fixture';
import { usage } from './usage.test-fixture';

type EnkryptReply = 'recorded' | 'duplicate' | 'admission' | 'wrong_echo' | 'missing_echo';

it('routes tagged Enkrypt messages through workerd and keeps untagged LLM dispositions', async () => {
  const calls: { path: string | undefined; body: unknown; source: unknown }[] = [];
  let enkryptReply: EnkryptReply = 'recorded';
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
    } else if (enkryptReply === 'admission') {
      response.statusCode = 429;
      response.end(JSON.stringify({ error: 'Usage writer overloaded', reason: 'pool_busy' }));
    } else if (enkryptReply === 'wrong_echo') {
      response.end(
        JSON.stringify({ status: 'recorded', usageId: '7b2d3f4a-5c6e-4f7a-9b8c-0d1e2f3a4b5c' })
      );
    } else if (enkryptReply === 'missing_echo') {
      response.end(JSON.stringify({ status: 'recorded' }));
    } else {
      response.end(JSON.stringify({ status: enkryptReply, usageId: event.id }));
    }
  };
  await withTaggedConsumerRuntime('enkrypt', handleWrite, async ({ deliver, logs }) => {
    const enkryptCall = {
      path: '/api/internal/enkrypt-usage/record',
      body: enkryptRecord,
      source: 'queue',
    };

    for (const reply of ['recorded', 'duplicate'] as const) {
      enkryptReply = reply;
      const result = await deliver(enkryptMessage);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual(['queue-0']);
      expect(result.retryMessages).toEqual([]);
      expect(calls.at(-1)).toEqual(enkryptCall);
    }

    enkryptReply = 'admission';
    const admission = await deliver(enkryptMessage);
    expect(admission.outcome).toBe('exception');
    expect(admission.explicitAcks).toEqual([]);
    expect(admission.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
    expect(admission.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(1);
    expect(admission.retryMessages[0].delaySeconds).toBeLessThanOrEqual(4);
    expect(calls.at(-1)).toEqual(enkryptCall);

    for (const reply of ['wrong_echo', 'missing_echo'] as const) {
      enkryptReply = reply;
      const result = await deliver(enkryptMessage);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
      expect(result.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(60);
      expect(result.retryMessages[0].delaySeconds).toBeLessThanOrEqual(120);
      expect(calls.at(-1)).toEqual(enkryptCall);
    }

    const writesBeforeRejected = calls.length;
    for (const body of [
      { kind: 'unknown_usage', v: 1, record: enkryptRecord },
      { kind: 'exa_usage', v: 1, record: enkryptRecord },
      { ...enkryptMessage, v: 2 },
      { ...enkryptMessage, record: { ...enkryptRecord, id: 'not-a-uuid' } },
    ]) {
      const result = await deliver(body);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
      expect(result.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(60);
      expect(result.retryMessages[0].delaySeconds).toBeLessThanOrEqual(120);
    }
    expect(calls).toHaveLength(writesBeforeRejected);

    enkryptReply = 'recorded';
    const mixed = await deliver(usage, enkryptMessage);
    expect(mixed.outcome).toBe('ok');
    expect(mixed.explicitAcks.toSorted()).toEqual(['queue-0', 'queue-1']);
    expect(mixed.retryMessages).toEqual([]);
    expect(
      calls.slice(-2).toSorted((a, b) => String(a.path).localeCompare(String(b.path)))
    ).toEqual([enkryptCall, { path: '/api/internal/usage/record', body: usage, source: 'queue' }]);

    const processing = logs
      .map(log => JSON.stringify(log))
      .filter(log => log.includes('usage_ingest_processing'));
    const llmProcessing = processing.filter(log => log.includes(usage.core.id));
    expect(llmProcessing).toHaveLength(1);
    expect(llmProcessing[0]).not.toContain('usage_kind');
    expect(llmProcessing[0]).toContain('event_age_ms');
    expect(processing.filter(log => log.includes(enkryptRecord.id))).toHaveLength(6);
    expect(
      processing
        .filter(log => log.includes(enkryptRecord.id))
        .every(log => log.includes('enkrypt_usage'))
    ).toBe(true);
    const serialized = JSON.stringify(logs);
    for (const sensitive of [
      'synthetic-writer-secret',
      'synthetic-bypass-secret',
      'unknown_usage',
      enkryptRecord.kiloUserId,
      enkryptRecord.sessionId,
      enkryptRecord.organizationId,
      enkryptRecord.occurredAt,
      usage.metadata.user_prompt_prefix,
    ]) {
      if (sensitive) expect(serialized).not.toContain(sensitive);
    }
  });
}, 30_000);

it('isolates only explicit non-LLM class quota retries within a mixed batch', async () => {
  let llmLimited = false;
  let status = 429;
  let reason = 'queue_limit';
  let marker: string | undefined = 'non_llm';
  const writer: RequestListener = (request, response) => {
    if (request.url === '/api/internal/usage/record' && !llmLimited) {
      response.end(
        JSON.stringify({
          status: 'recorded',
          result: {
            usageId: usage.core.id,
            createdAt: usage.core.created_at,
            newMicrodollarsUsed: 1,
          },
        })
      );
      return;
    }
    response.statusCode = status;
    if (marker) response.setHeader('x-usage-class-limit', marker);
    response.end(JSON.stringify({ error: 'Usage writer overloaded', reason }));
  };
  await withTaggedConsumerRuntime('class-quota', writer, async ({ deliver }) => {
    for (const [code, rejection, header, expected] of [
      [429, 'queue_limit', 'non_llm', 'ok'],
      [429, 'queue_limit', undefined, 'exception'],
      [429, 'queue_limit', 'unknown', 'exception'],
      [429, 'pool_busy', 'non_llm', 'exception'],
      [429, 'pool_waiting', 'non_llm', 'exception'],
      [429, 'unknown', 'non_llm', 'exception'],
      [503, 'queue_limit', 'non_llm', 'exception'],
    ] as const) {
      status = code;
      reason = rejection;
      marker = header;
      const result = await deliver(usage, enkryptMessage);
      expect(result.outcome).toBe(expected);
      expect(result.explicitAcks).toEqual(['queue-0']);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-1']);
      if (expected === 'ok') {
        expect(result.retryMessages[0].delaySeconds).toBeGreaterThanOrEqual(1);
        expect(result.retryMessages[0].delaySeconds).toBeLessThanOrEqual(4);
      }
    }
    status = 429;
    llmLimited = true;
    const result = await deliver(enkryptMessage, usage);
    expect(result.outcome).toBe('exception');
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map(message => message.msgId).toSorted()).toEqual([
      'queue-0',
      'queue-1',
    ]);
  });
}, 30_000);

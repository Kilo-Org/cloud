import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import worker from './index';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

const EVENT = 'usage_ingest_final_attempt_failed';
const env = {
  USAGE_WRITER_URL: 'https://writer.test/api/internal/usage/record',
  USAGE_WRITER_SECRET: 'synthetic-writer-secret',
  USAGE_WRITER_PROTECTION_BYPASS: 'synthetic-bypass',
} as Env;
const enkryptRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3309',
  occurredAt: '2026-11-06T12:00:00.000Z',
  organizationId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
  kiloUserId: 'oauth/github:synthetic-enkrypt-user',
  sessionId: 'ses_synthetic',
  apiKind: 'messages',
  decision: 'blocked',
  creditsCost: 7,
  addedLatencyMs: 212,
  guardrail: 'output',
};

function message(body: unknown, attempts: number) {
  return { id: 'queue-1', timestamp: new Date(), attempts, body, ack: vi.fn(), retry: vi.fn() };
}
function batch(messages: Message<unknown>[]) {
  return {
    queue: 'usage',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  };
}
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const sinks = (['log', 'info', 'warn', 'error'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
  const lines = () =>
    sinks.flatMap(sink =>
      sink.mock.calls
        .map(([value]) => value)
        .filter((value): value is string => typeof value === 'string' && value.includes(EVENT))
    );
  return { fetch, lines, errorSink: sinks[3] };
}
function deliver(messages: ReturnType<typeof message>[]) {
  return Promise.resolve(worker.queue(batch(messages), env));
}
const OVERLOADED = 'Usage writer overloaded (HTTP 429/503)';
function acknowledgement(status: 'recorded' | 'duplicate') {
  return Response.json({
    status,
    result: { usageId: usage.core.id, createdAt: usage.core.created_at, newMicrodollarsUsed: 1 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('final delivery attempt', () => {
  it('logs exactly one bounded error line when the last allowed delivery is retried', async () => {
    const { fetch, lines, errorSink } = setup();
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const final = message(usage, 21);
    await expect(deliver([final])).rejects.toThrow(OVERLOADED);
    expect(final.retry).toHaveBeenCalledOnce();
    expect(final.ack).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
    expect(errorSink.mock.calls.map(([value]) => value)).toEqual(lines());
    expect(JSON.parse(lines()[0])).toStrictEqual({
      level: 'error',
      event: EVENT,
      queue: 'usage',
      usage_kind: 'llm',
      usage_id: usage.core.id,
      queue_message_id: 'queue-1',
      delivery_attempts: 21,
      reason: 'http_error',
    });
    for (const value of [usage.core.kilo_user_id, usage.metadata.message_id, 'synthetic-writer']) {
      expect(lines()[0]).not.toContain(value);
    }
  });

  it.each([1, 2, 20, undefined, Number.NaN])(
    'logs nothing when delivery attempt %s fails and can still be retried',
    async attempts => {
      const { fetch, lines } = setup();
      fetch.mockResolvedValue(new Response(null, { status: 503 }));
      const earlier = message(usage, attempts as number);
      await expect(deliver([earlier])).rejects.toThrow(OVERLOADED);
      expect(earlier.retry).toHaveBeenCalledOnce();
      expect(lines()).toEqual([]);
    }
  );

  it.each(['recorded', 'duplicate'] as const)(
    'logs nothing when the final delivery is acknowledged as %s',
    async status => {
      const { fetch, lines } = setup();
      fetch.mockResolvedValue(acknowledgement(status));
      const final = message(usage, 21);
      await deliver([final]);
      expect(final.ack).toHaveBeenCalledOnce();
      expect(final.retry).not.toHaveBeenCalled();
      expect(lines()).toEqual([]);
    }
  );

  it('logs only the final message of a mixed batch', async () => {
    const { fetch, lines } = setup();
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const earlier = { ...message(usage, 3), id: 'queue-earlier' };
    const final = { ...message(usage, 21), id: 'queue-final' };
    await deliver([earlier, final]);
    expect(lines().map(line => JSON.parse(line).queue_message_id)).toEqual(['queue-final']);
  });

  it('carries usage_kind and the validated usage ID for Enkrypt usage', async () => {
    const { lines } = setup();
    const final = message({ kind: 'enkrypt_usage', v: 1, record: enkryptRecord }, 21);
    await deliver([final]);
    expect(final.retry).toHaveBeenCalledOnce();
    expect(JSON.parse(lines()[0])).toMatchObject({
      usage_kind: 'enkrypt_usage',
      usage_id: enkryptRecord.id,
      delivery_attempts: 21,
    });
    expect(lines()[0]).not.toContain(enkryptRecord.kiloUserId);
  });

  it.each([
    ['an invalid LLM body', { core: { id: usage.core.id } }, { usage_kind: 'llm' }],
    [
      'an invalid Enkrypt record',
      { kind: 'enkrypt_usage', v: 1, record: { ...enkryptRecord, creditsCost: -1 } },
      { usage_kind: 'enkrypt_usage' },
    ],
    ['an unknown tag', { kind: 'other_usage', id: usage.core.id }, { usage_kind: 'unknown' }],
  ])('omits an unvalidated usage ID for %s', async (_label, body, identity) => {
    const { lines } = setup();
    await deliver([message(body, 21)]);
    const line = JSON.parse(lines()[0]);
    expect(line).toMatchObject({ ...identity, delivery_attempts: 21 });
    expect(line).not.toHaveProperty('usage_id');
  });

  it('logs the final retry when processing itself throws', async () => {
    const { lines } = setup();
    const final = { ...message(usage, 21), timestamp: {} as Date };
    await expect(deliver([final])).rejects.toThrow(TypeError);
    expect(final.retry).toHaveBeenCalledOnce();
    expect(JSON.parse(lines()[0])).toMatchObject({
      usage_kind: 'llm',
      usage_id: usage.core.id,
      reason: 'unexpected_error',
    });
  });
});

describe('dead-letter alert wiring', () => {
  const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

  const production = unstable_readConfig({ config });
  const staging = unstable_readConfig({ config, env: 'staging' });

  it('keeps the 20 retries that make delivery 21 final in every environment', () => {
    for (const { queues } of [production, staging]) {
      expect(queues.consumers).toHaveLength(1);
      expect(queues.consumers[0].max_retries).toBe(20);
    }
  });

  it('is watched by the o11y dead-letter alert under the production DLQ name', () => {
    const alertConfig = readFileSync(
      fileURLToPath(new URL('../../o11y/src/alerting/dead-letter-queue.ts', import.meta.url).href),
      'utf8'
    );
    const watched = /DEAD_LETTER_QUEUE_NAME = '([^']+)'/.exec(alertConfig)?.[1];
    expect(watched).toBe(production.queues.consumers[0].dead_letter_queue);
  });
});

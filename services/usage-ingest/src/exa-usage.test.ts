import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_EXA_USAGE_BYTES } from './publish-exa-usage';
import { handleFetch, type Env } from './publish-usage';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaMessage, exaRecord } from './exa-usage.test-fixture';
import { usage } from './usage.test-fixture';

const secret = 'synthetic-publish-secret';

let send: ReturnType<typeof vi.fn>;
let logs: () => Record<string, unknown>[];

beforeEach(() => {
  send = vi.fn().mockResolvedValue(undefined);
  const sinks = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')];
  sinks.forEach(sink => sink.mockImplementation(() => {}));
  logs = () => sinks.flatMap(sink => sink.mock.calls.map(([line]) => JSON.parse(String(line))));
});
afterEach(() => vi.restoreAllMocks());

function env(overrides: Partial<Env> = {}): Env {
  return {
    USAGE_INGEST_PUBLISH_SECRET: secret,
    USAGE_INGEST_QUEUE: { send },
    ...overrides,
  } as unknown as Env;
}

function post(path: string, body: BodyInit | null, authorization?: string, method = 'POST') {
  return new Request(`https://test.invalid${path}`, {
    method,
    headers: authorization ? { authorization } : undefined,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

function trackedBody(text: string) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  });
  return { body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), pull };
}

function expectNoRecordValues() {
  const logged = JSON.stringify(logs());
  for (const value of [
    secret,
    exaRecord.userId,
    exaRecord.organizationId,
    exaRecord.occurredAt,
    exaRecord.featureId,
    exaRecord.type,
  ])
    if (value) expect(logged).not.toContain(value);
}

describe('/exa-usage ingress', () => {
  it('enqueues exactly one tagged envelope and returns 202', async () => {
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(exaRecord), `Bearer ${secret}`),
      env()
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(send).toHaveBeenCalledExactlyOnceWith(exaMessage, { contentType: 'json' });
    expect(logs()).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_enqueue_start',
        usage_id: exaRecord.id,
        usage_kind: 'exa_usage',
        publisher_entry_at_ms: expect.any(Number),
        before_send_at_ms: expect.any(Number),
      },
      {
        level: 'info',
        event: 'usage_ingest_enqueue',
        usage_id: exaRecord.id,
        usage_kind: 'exa_usage',
        outcome: 'accepted',
        publisher_entry_at_ms: expect.any(Number),
        before_send_at_ms: expect.any(Number),
        after_send_at_ms: expect.any(Number),
        send_duration_ms: expect.any(Number),
      },
    ]);
    expectNoRecordValues();
  });

  it('enqueues a personal record with a null organization', async () => {
    const { featureId: _featureId, type: _type, ...rest } = exaRecord;
    const record = { ...rest, organizationId: null, chargedToBalance: false };
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(record), `Bearer ${secret}`),
      env()
    );
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { kind: 'exa_usage', v: 1, record },
      { contentType: 'json' }
    );
  });

  it.each([
    ['missing', undefined],
    ['a wrong secret', 'Bearer wrong'],
    ['the bare secret', secret],
  ])('returns 401 for %s authorization without reading the body', async (_label, authorization) => {
    const tracked = trackedBody(JSON.stringify(exaRecord));
    const response = await handleFetch(post('/exa-usage', tracked.body, authorization), env());
    expect(response.status).toBe(401);
    expect(tracked.pull).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
  });

  it('returns 503 without reading the body when the publish secret is not configured', async () => {
    const tracked = trackedBody(JSON.stringify(exaRecord));
    const response = await handleFetch(
      post('/exa-usage', tracked.body, `Bearer ${secret}`),
      env({ USAGE_INGEST_PUBLISH_SECRET: undefined })
    );
    expect(response.status).toBe(503);
    expect(tracked.pull).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['an LLM usage body', usage],
    ['an Enkrypt usage body', enkryptRecord],
    ['an already tagged envelope', exaMessage],
    ['an Enkrypt envelope', enkryptMessage],
    [
      'a non-RFC UUID organization',
      { ...exaRecord, organizationId: '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f' },
    ],
    ['an unknown key', { ...exaRecord, extra: exaRecord.userId }],
  ])('returns 400 for %s and logs only issue codes and paths', async (_label, body) => {
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(body), `Bearer ${secret}`),
      env()
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid usage payload' });
    expect(send).not.toHaveBeenCalled();
    expect(logs()).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_rejected',
        usage_kind: 'exa_usage',
        category: 'schema_failure',
        issues: expect.any(Array),
        omitted_issue_count: expect.any(Number),
      },
    ]);
    expectNoRecordValues();
  });

  it('names only top-level schema fields in a rejection', async () => {
    const response = await handleFetch(
      post(
        '/exa-usage',
        JSON.stringify({ ...exaRecord, organizationId: 'org-1', path: '/secret', [secret]: 1 }),
        `Bearer ${secret}`
      ),
      env()
    );
    expect(response.status).toBe(400);
    expect(logs()[0].issues).toEqual([
      { code: 'invalid_format', path: ['organizationId'] },
      { code: 'invalid_value', path: ['path'] },
      { code: 'unrecognized_keys', path: [] },
    ]);
    expectNoRecordValues();
  });

  it.each([
    ['malformed JSON', `{"x":"${exaRecord.userId}`, 'malformed_json', 'SyntaxError'],
    ['invalid UTF-8', new Uint8Array([0xff]), 'invalid_utf8', 'TypeError'],
    ['a missing body', null, 'missing_body', undefined],
  ])('rejects %s with 400 and logs only the failed stage', async (_label, body, category, name) => {
    const response = await handleFetch(post('/exa-usage', body, `Bearer ${secret}`), env());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON' });
    expect(send).not.toHaveBeenCalled();
    expect(logs()).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_rejected',
        usage_kind: 'exa_usage',
        category,
        ...(name === undefined ? {} : { error_name: name }),
      },
    ]);
    expectNoRecordValues();
  });

  it('rejects a body over 8 KiB with 413 before parsing it', async () => {
    const oversized = JSON.stringify({ ...exaRecord, type: 'x'.repeat(MAX_EXA_USAGE_BYTES) });
    const response = await handleFetch(post('/exa-usage', oversized, `Bearer ${secret}`), env());
    expect(MAX_EXA_USAGE_BYTES).toBe(8_192);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Usage payload too large' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => vi.fn().mockRejectedValue(new Error(secret))],
    [
      'throws',
      () =>
        vi.fn(() => {
          throw new Error(secret);
        }),
    ],
  ])('returns 503 when the queue send %s', async (_label, failingSend) => {
    send = failingSend();
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(exaRecord), `Bearer ${secret}`),
      env()
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Queue unavailable' });
    expect(send).toHaveBeenCalledOnce();
    expect(logs().at(-1)).toEqual({
      level: 'warn',
      event: 'usage_ingest_enqueue',
      usage_id: exaRecord.id,
      usage_kind: 'exa_usage',
      outcome: 'unavailable',
      error_name: 'Error',
      after_send_at_ms: expect.any(Number),
      send_duration_ms: expect.any(Number),
    });
    expectNoRecordValues();
  });

  it('allows only POST', async () => {
    const response = await handleFetch(post('/exa-usage', null, `Bearer ${secret}`, 'GET'), env());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('other ingress paths with Exa bodies', () => {
  it.each([
    ['/usage', 'an Exa record', exaRecord],
    ['/usage', 'an Exa envelope', exaMessage],
    ['/enkrypt-usage', 'an Exa record', exaRecord],
    ['/enkrypt-usage', 'an Exa envelope', exaMessage],
  ])('%s returns 400 for %s', async (path, _label, body) => {
    const response = await handleFetch(post(path, JSON.stringify(body), `Bearer ${secret}`), env());
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

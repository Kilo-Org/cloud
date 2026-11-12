import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_EXA_USAGE_BYTES } from './publish-exa-usage';
import { handleFetch, type Env } from './publish-usage';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaMessage, exaRecord } from './exa-usage.test-fixture';
import { usage } from './usage.test-fixture';

const llmSecret = 'synthetic-publish-secret';
const exaSecret = 'synthetic-exa-publish-secret';

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
    USAGE_INGEST_PUBLISH_SECRET: llmSecret,
    USAGE_INGEST_EXA_PUBLISH_SECRET: exaSecret,
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
    exaSecret,
    llmSecret,
    exaRecord.userId,
    exaRecord.organizationId,
    exaRecord.type,
    exaRecord.occurredAt,
  ])
    if (value) expect(logged).not.toContain(value);
}

describe('/exa-usage ingress', () => {
  it('enqueues exactly one tagged envelope and returns 202', async () => {
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(exaRecord), `Bearer ${exaSecret}`),
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

  it('reads the body once its own secret matches', async () => {
    const tracked = trackedBody(JSON.stringify(exaRecord));
    const response = await handleFetch(
      post('/exa-usage', tracked.body, `Bearer ${exaSecret}`),
      env()
    );
    expect(response.status).toBe(202);
    expect(tracked.pull).toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['the LLM publish secret', `Bearer ${llmSecret}`],
    ['a wrong secret', 'Bearer wrong'],
    ['the bare secret', exaSecret],
  ])('returns 401 for %s authorization without reading the body', async (_label, authorization) => {
    const tracked = trackedBody(JSON.stringify(exaRecord));
    const response = await handleFetch(post('/exa-usage', tracked.body, authorization), env());
    expect(response.status).toBe(401);
    expect(tracked.pull).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
  });

  it('returns 503 without reading the body when its own secret is not configured', async () => {
    const tracked = trackedBody(JSON.stringify(exaRecord));
    const response = await handleFetch(
      post('/exa-usage', tracked.body, `Bearer ${llmSecret}`),
      env({ USAGE_INGEST_EXA_PUBLISH_SECRET: undefined })
    );
    expect(response.status).toBe(503);
    expect(tracked.pull).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['an LLM usage body', usage],
    ['an Enkrypt record', enkryptRecord],
    ['an already tagged envelope', exaMessage],
    ['a non-UUID organization', { ...exaRecord, organizationId: 'org-1' }],
    ['an unknown key', { ...exaRecord, extra: exaRecord.userId }],
  ])('returns 400 for %s and logs only issue codes and paths', async (_label, body) => {
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(body), `Bearer ${exaSecret}`),
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

  it('names only schema-owned fields in a rejection', async () => {
    const response = await handleFetch(
      post(
        '/exa-usage',
        JSON.stringify({ ...exaRecord, organizationId: 'org-1', [exaRecord.userId]: 1 }),
        `Bearer ${exaSecret}`
      ),
      env()
    );
    expect(response.status).toBe(400);
    expect(logs()[0].issues).toEqual([
      { code: 'invalid_format', path: ['organizationId'] },
      { code: 'unrecognized_keys', path: [] },
    ]);
  });

  it.each([
    ['malformed JSON', `{"x":"${exaRecord.userId}`, 'malformed_json', 'SyntaxError'],
    ['invalid UTF-8', new Uint8Array([0xff]), 'invalid_utf8', 'TypeError'],
    ['a missing body', null, 'missing_body', undefined],
  ])('rejects %s with 400 and logs only the failed stage', async (_label, body, category, name) => {
    const response = await handleFetch(post('/exa-usage', body, `Bearer ${exaSecret}`), env());
    expect(response.status).toBe(400);
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
    const response = await handleFetch(post('/exa-usage', oversized, `Bearer ${exaSecret}`), env());
    expect(MAX_EXA_USAGE_BYTES).toBe(8_192);
    expect(response.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 503 and logs only the error name when the queue send rejects', async () => {
    send = vi.fn().mockRejectedValue(new Error(exaSecret));
    const response = await handleFetch(
      post('/exa-usage', JSON.stringify(exaRecord), `Bearer ${exaSecret}`),
      env()
    );
    expect(response.status).toBe(503);
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
    const response = await handleFetch(
      post('/exa-usage', null, `Bearer ${exaSecret}`, 'GET'),
      env()
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('other ingress paths with Exa bodies', () => {
  it.each([
    ['/usage', 'an Exa record', exaRecord, llmSecret],
    ['/usage', 'an Exa envelope', exaMessage, llmSecret],
    ['/enkrypt-usage', 'an Exa record', exaRecord, llmSecret],
  ])('%s returns 400 for %s', async (path, _label, body, secret) => {
    const response = await handleFetch(post(path, JSON.stringify(body), `Bearer ${secret}`), env());
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['/usage', '/enkrypt-usage'])('%s does not accept the Exa publish secret', async path => {
    const body = path === '/usage' ? usage : enkryptRecord;
    const response = await handleFetch(
      post(path, JSON.stringify(body), `Bearer ${exaSecret}`),
      env()
    );
    expect(response.status).toBe(401);
  });

  it('still sends the Enkrypt envelope unchanged on /enkrypt-usage', async () => {
    const response = await handleFetch(
      post('/enkrypt-usage', JSON.stringify(enkryptRecord), `Bearer ${llmSecret}`),
      env()
    );
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith(enkryptMessage, { contentType: 'json' });
  });
});

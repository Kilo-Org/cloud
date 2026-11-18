import { afterEach, describe, expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';
import worker from './index';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { type Env } from './publish-usage';

type SendResult = Awaited<ReturnType<Env['USAGE_INGEST_QUEUE']['send']>>;
const queueResult: SendResult = {
  metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
};

function setup() {
  const send = vi.fn<Env['USAGE_INGEST_QUEUE']['send']>().mockResolvedValue(queueResult);
  const env: Env = {
    USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret',
    USAGE_INGEST_QUEUE: { send, sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_INGEST_DLQ: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
  };
  return { send, env };
}

function request(body: BodyInit = JSON.stringify(usage), headers: HeadersInit = {}) {
  return new Request('https://example.test/usage', {
    method: 'POST',
    body,
    headers: { Authorization: 'Bearer synthetic-local-secret', ...headers },
    duplex: 'half',
  } as RequestInit);
}

const marker = 'PRIVATE-MARKER-DO-NOT-LOG';
afterEach(() => vi.restoreAllMocks());

function capture() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  return {
    warn,
    events: () => warn.mock.calls.map(([line]) => JSON.parse(line)),
    assertPrivate: () => {
      expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain(marker);
    },
  };
}

describe('authenticated rejection diagnostics at the handler boundary', () => {
  it.each([
    ['malformed_json', () => request(`{"${marker}":`)],
    [
      'missing_body',
      () =>
        new Request('https://example.test/usage', {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic-local-secret' },
        }),
    ],
    ['invalid_utf8', () => request(new Uint8Array([0xff]))],
    [
      'body_read_failure',
      () =>
        request(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(marker));
            },
          })
        ),
    ],
  ] as const)('records one %s event without changing the response', async (category, build) => {
    const logs = capture();
    const { env, send } = setup();
    const req = build();
    req.headers.set('Cookie', marker);
    req.headers.set('X-Private', marker);
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON' });
    expect(send).not.toHaveBeenCalled();
    expect(logs.events()).toEqual([{ level: 'warn', event: 'usage_ingest_rejected', category }]);
    logs.assertPrivate();
  });

  it('records codes, known paths and normalized types with a separately validated UUID', async () => {
    const logs = capture();
    const { env, send } = setup();
    const core = { ...usage.core, cost: 1.5, created_at: marker, organization_id: marker };
    const metadata = { ...usage.metadata, api_kind: marker, user_prompt_prefix: marker };
    const req = request(JSON.stringify({ ...usage, core, metadata, [marker]: marker }), {
      Cookie: marker,
      'X-Private': marker,
    });
    const getReader = vi.spyOn(req.body!, 'getReader');
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid usage payload' });
    expect(send).not.toHaveBeenCalled();
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(logs.events()).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_rejected',
        category: 'schema_failure',
        usage_id: usage.core.id,
        omitted_issue_count: 0,
        issues: [
          {
            code: 'invalid_type',
            path: ['core', 'cost'],
            expected_type: 'integer',
            received_type: 'number',
          },
          {
            code: 'invalid_format',
            path: ['core', 'created_at'],
            expected_type: 'string',
            received_type: 'string',
          },
          {
            code: 'invalid_format',
            path: ['core', 'organization_id'],
            expected_type: 'string',
            received_type: 'string',
          },
          {
            code: 'invalid_value',
            path: ['metadata', 'api_kind'],
            expected_type: 'unknown',
            received_type: 'string',
          },
        ],
      },
    ]);
    logs.assertPrivate();
  });

  it('sanitizes future validator paths, text, expected types and key lists at the handler boundary', async () => {
    const logs = capture();
    const { env, send } = setup();
    const failure = UsageRecordRequestSchema.safeParse({});
    if (failure.success) throw new Error('Expected invalid fixture');
    // Inject future validator output at the schema seam; the request still goes
    // through the real authenticated handler, body reader and diagnostic sink.
    failure.error.issues.splice(
      0,
      failure.error.issues.length,
      {
        code: 'invalid_type',
        path: ['bouncer_usage_event', 'payload', marker, marker, marker],
        expected: marker,
        message: marker,
      },
      { code: 'unrecognized_keys', path: [marker], keys: [marker], message: marker },
      { code: 'invalid_type', path: ['core', marker], expected: 'string', message: marker },
      {
        code: 'invalid_type',
        path: ['metadata', 'max_tokens'],
        expected: 'number',
        message: marker,
      }
    );
    vi.spyOn(UsageRecordRequestSchema, 'safeParse').mockReturnValueOnce(failure);
    const response = await worker.fetch(
      request(
        JSON.stringify({
          ...usage,
          metadata: { ...usage.metadata, max_tokens: null },
          bouncer_usage_event: { request_id: marker, payload: { [marker]: marker } },
        })
      ),
      env
    );
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(logs.events()).toHaveLength(1);
    expect(logs.events()[0].issues).toEqual([
      {
        code: 'invalid_type',
        path: ['bouncer_usage_event', 'payload', '[redacted]'],
        expected_type: 'unknown',
        received_type: 'unknown',
      },
      {
        code: 'unrecognized_keys',
        path: ['[redacted]'],
        expected_type: 'unknown',
        received_type: 'missing',
      },
      {
        code: 'invalid_type',
        path: ['core', '[redacted]'],
        expected_type: 'string',
        received_type: 'missing',
      },
      {
        code: 'invalid_type',
        path: ['metadata', 'max_tokens'],
        expected_type: 'number',
        received_type: 'null',
      },
    ]);
    logs.assertPrivate();
  });

  it('omits an invalid usage ID and caps multiple issues at eight', async () => {
    const logs = capture();
    const { env, send } = setup();
    const response = await worker.fetch(
      request(
        JSON.stringify({
          core: { id: marker, kilo_user_id: marker, [marker]: marker },
          metadata: {},
          posthog_distinct_id: marker,
        })
      ),
      env
    );
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    const [event] = logs.events();
    expect(logs.events()).toHaveLength(1);
    expect(event).not.toHaveProperty('usage_id');
    expect(event.issues).toHaveLength(8);
    expect(event.omitted_issue_count).toBeGreaterThan(0);
    expect(event.issues).toContainEqual({
      code: 'invalid_type',
      path: ['core', 'cost'],
      expected_type: 'number',
      received_type: 'missing',
    });
    expect(JSON.stringify(event).length).toBeLessThan(2000);
    logs.assertPrivate();
  });

  it.each(['malformed', 'schema', 'read'] as const)(
    'isolates a throwing logger for %s',
    async kind => {
      const { env, send } = setup();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        throw new Error(marker);
      });
      const req =
        kind === 'read'
          ? request(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error(marker));
                },
              })
            )
          : request(kind === 'schema' ? '{}' : '{');
      const getReader = vi.spyOn(req.body!, 'getReader');
      const response = await worker.fetch(req, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: kind === 'schema' ? 'Invalid usage payload' : 'Invalid JSON',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(getReader).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('does not read or diagnose failed auth', async () => {
    const logs = capture();
    const { env, send } = setup();
    const req = request(marker, { Authorization: `Bearer ${marker}`, Cookie: marker });
    const body = vi.spyOn(req, 'body', 'get');
    expect((await worker.fetch(req, env)).status).toBe(401);
    expect(body).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logs.events()).toEqual([]);
    logs.assertPrivate();
  });

  it('preserves valid acceptance and send failure even when both log sinks throw', async () => {
    const { env, send } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error(marker);
    });
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error(marker);
    });
    const accepted = Promise.withResolvers<SendResult>();
    send.mockReturnValueOnce(accepted.promise);
    let responded = false;
    const response = worker.fetch(request(), env).then(value => {
      responded = true;
      return value;
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith(usage, { contentType: 'json' })
    );
    expect(responded).toBe(false);
    accepted.resolve(queueResult);
    expect((await response).status).toBe(202);
    send.mockClear().mockRejectedValueOnce(new Error(marker));
    const failed = await worker.fetch(request(), env);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Queue unavailable' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

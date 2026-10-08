import { describe, expect, it, vi } from 'vitest';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import worker from './index';
import { MAX_USAGE_BYTES, type Env } from './publish-usage';

const usage: UsageRecordRequest = {
  core: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    kilo_user_id: 'oauth/synthetic',
    cost: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: '2026-08-05T10:11:12.945Z',
    provider: 'openrouter',
    model: 'synthetic-model',
    requested_model: 'synthetic-model',
    cache_discount: null,
    has_error: false,
    abuse_classification: 0,
    organization_id: null,
    inference_provider: null,
    project_id: null,
  },
  metadata: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    message_id: 'msg-1',
    created_at: '2026-08-05T10:11:12.945Z',
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    user_prompt_prefix: '🙂',
    system_prompt_prefix: null,
    system_prompt_length: null,
    http_user_agent: null,
    max_tokens: null,
    has_middle_out_transform: null,
    status_code: 200,
    upstream_id: null,
    finish_reason: 'stop',
    latency: null,
    moderation_latency: null,
    generation_time: null,
    is_byok: null,
    is_user_byok: false,
    streamed: null,
    cancelled: null,
    editor_name: null,
    api_kind: 'chat_completions',
    has_tools: null,
    machine_id: null,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: null,
    market_cost: null,
    is_free: null,
    abuse_delay: null,
    abuse_downgraded_from: null,
  },
  prior_microdollar_usage: 0,
  posthog_distinct_id: null,
};

type SendResult = Awaited<ReturnType<Env['USAGE_INGEST_QUEUE']['send']>>;
const queueResult: SendResult = {
  metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
};

function setup() {
  const send = vi.fn<Env['USAGE_INGEST_QUEUE']['send']>().mockResolvedValue(queueResult);
  const env: Env = {
    USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret',
    USAGE_INGEST_QUEUE: { send, sendBatch: vi.fn(), metrics: vi.fn() },
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

function chunked(text: string) {
  const bytes = new TextEncoder().encode(text);
  // Split the emoji's UTF-8 bytes across stream chunks.
  const split = bytes.indexOf(0xf0) + 1;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
}

describe('usage publisher', () => {
  it('forwards the exact validated event and waits for queue acceptance', async () => {
    const { send, env } = setup();
    const accepted = Promise.withResolvers<SendResult>();
    send.mockReturnValue(accepted.promise);
    let responded = false;
    const response = worker.fetch(request(chunked(JSON.stringify(usage))), env).then(value => {
      responded = true;
      return value;
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(usage, { contentType: 'json' }));
    expect(responded).toBe(false);
    accepted.resolve(queueResult);
    expect((await response).status).toBe(202);
  });

  it('strips unknown keys before enqueueing the validated event', async () => {
    const { send, env } = setup();
    const body = JSON.stringify({
      ...usage,
      extra: 'discard',
      core: { ...usage.core, extra: 'discard' },
      metadata: { ...usage.metadata, extra: 'discard' },
    });
    expect((await worker.fetch(request(body), env)).status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith(usage, { contentType: 'json' });
  });

  it.each([null, 'Bearer wrong'])('rejects auth %s before accessing the body', async auth => {
    const { send, env } = setup();
    const req = request();
    if (auth === null) req.headers.delete('Authorization');
    else req.headers.set('Authorization', auth);
    const body = vi.spyOn(req, 'body', 'get');
    expect((await worker.fetch(req, env)).status).toBe(401);
    expect(body).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('fails closed with configured secret %s', async secret => {
    const { send, env } = setup();
    env.USAGE_INGEST_PUBLISH_SECRET = secret;
    const req = request();
    const body = vi.spyOn(req, 'body', 'get');
    expect((await worker.fetch(req, env)).status).toBe(503);
    expect(body).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['{', JSON.stringify({ ...usage, core: { ...usage.core, cost: 1.5 } })])(
    'rejects malformed JSON or invalid usage',
    async body => {
      const { send, env } = setup();
      expect((await worker.fetch(request(body), env)).status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid UTF-8 and unreadable streams without enqueueing', async () => {
    const { send, env } = setup();
    const invalidUtf8 = new TextEncoder().encode(JSON.stringify(usage));
    invalidUtf8[invalidUtf8.indexOf(0xf0)] = 0xff;
    const unreadable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic read failure'));
      },
    });
    expect((await worker.fetch(request(invalidUtf8), env)).status).toBe(400);
    expect((await worker.fetch(request(unreadable), env)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it.each<HeadersInit>([{}, { 'Content-Length': '1' }])(
    'limits actual multibyte streamed bytes',
    async headers => {
      const { send, env } = setup();
      const oversized = JSON.stringify({ ...usage, posthog_distinct_id: '🙂'.repeat(30_000) });
      expect(oversized.length).toBeLessThan(MAX_USAGE_BYTES);
      expect((await worker.fetch(request(chunked(oversized), headers), env)).status).toBe(413);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('accepts the serialized boundary but rejects JSON expansion beyond it', async () => {
    const { send, env } = setup();
    const event = { ...usage, posthog_distinct_id: '' };
    event.posthog_distinct_id = 'x'.repeat(
      MAX_USAGE_BYTES - Buffer.byteLength(JSON.stringify(event))
    );
    expect((await worker.fetch(request(JSON.stringify(event)), env)).status).toBe(202);
    send.mockClear();
    // Compact exponent notation grows when the validated event is reserialized.
    const compact = JSON.stringify({
      ...event,
      posthog_distinct_id: event.posthog_distinct_id.slice(3),
      prior_microdollar_usage: 1e20,
    }).replace('100000000000000000000', '1e20');
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(MAX_USAGE_BYTES);
    expect((await worker.fetch(request(compact), env)).status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a safe failure when enqueue rejects', async () => {
    const { send, env } = setup();
    send.mockRejectedValue(new Error('sensitive queue details'));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Queue unavailable' });
  });

  it('rejects deeply nested Bouncer data without enqueueing', async () => {
    const { send, env } = setup();
    // Build JSON text directly so serialization in the test cannot overflow first.
    const depth = 10_000;
    const body = JSON.stringify({
      ...usage,
      bouncer_usage_event: { request_id: 'synthetic', payload: { nested: 0 } },
    }).replace('"nested":0', `"nested":${'['.repeat(depth)}0${']'.repeat(depth)}`);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_USAGE_BYTES);
    const response = await worker.fetch(request(body), env);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Usage payload too large' });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps unrelated paths and unsupported methods out of the queue', async () => {
    const { send, env } = setup();
    expect((await worker.fetch(new Request('https://example.test/elsewhere'), env)).status).toBe(
      404
    );
    const response = await worker.fetch(new Request('https://example.test/usage'), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(send).not.toHaveBeenCalled();
  });
});

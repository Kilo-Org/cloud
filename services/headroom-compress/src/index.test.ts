import { app } from './index';

const model = 'kilo/anthropic/claude-sonnet-4.6';

type CapturedRequest = {
  request: Request;
  body: unknown;
};

function makeEnv(
  options: { token?: string; fetch?: (request: Request) => Promise<Response> } = {}
) {
  const captured: CapturedRequest[] = [];
  const token = options.token ?? 'secret-token';
  const fetch =
    options.fetch ??
    (async (request: Request) => {
      captured.push({ request, body: await request.clone().json() });
      return Response.json({
        messages: [{ role: 'user', content: 'compressed' }],
        tokens_before: 10,
        tokens_after: 5,
        tokens_saved: 5,
        compression_ratio: 0.5,
        transforms_applied: ['test'],
        transforms_summary: { test: 1 },
        ccr_hashes: ['abc'],
      });
    });

  const env = {
    HEADROOM_BEARER_TOKEN: { get: async () => token },
    HEADROOM_CONTAINER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch }),
    },
    HEADROOM_INSTANCE_COUNT: '2',
    HEADROOM_MODEL_ALLOWLIST: model,
    HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: { [model]: 1_000_000 } }),
    HEADROOM_MAX_BODY_BYTES: '1048576',
    HEADROOM_MAX_MESSAGES: '200',
    HEADROOM_MAX_CONTENT_CHARS: '750000',
    HEADROOM_MAX_TOKEN_BUDGET: '256000',
    HEADROOM_CONTAINER_REQUEST_TIMEOUT_MS: '25000',
    ENVIRONMENT: 'production',
    HEADROOM_STATELESS: 'true',
    HEADROOM_TELEMETRY: 'off',
    HEADROOM_SKIP_UPSTREAM_CHECK: '1',
    HEADROOM_NO_CCR_INJECT_TOOL: '1',
    HEADROOM_NO_CCR_MARKER: '1',
    HEADROOM_NO_CCR_PROACTIVE_EXPANSION: '1',
    HEADROOM_LOG_MESSAGES: 'false',
    HEADROOM_RATE_LIMIT_ENABLED: 'false',
    HEADROOM_CODE_AWARE_ENABLED: '1',
    HEADROOM_COMPRESS_USER_MESSAGES: '1',
    HEADROOM_COMPRESS_SYSTEM_MESSAGES: '1',
    HEADROOM_PROTECT_RECENT: '0',
    HEADROOM_LIMIT_CONCURRENCY: '8',
    HEADROOM_COMPRESS_WORKERS: '4',
    HEADROOM_KOMPRESS_MAX_CONCURRENT: '2',
    HEADROOM_TOOL_OUTPUT_COMPRESSION_PARALLELISM: '2',
  } as unknown as Env;

  return { env, captured };
}

function compressRequest(body: unknown, token = 'secret-token'): Request {
  return new Request('https://headroom.kiloapps.io/v1/compress', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('headroom-compress worker', () => {
  it('serves readyz without waking a container', async () => {
    let containerCalls = 0;
    const { env } = makeEnv({
      fetch: async () => {
        containerCalls += 1;
        return Response.json({});
      },
    });

    const response = await app.request('/readyz', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'headroom-compress' });
    expect(containerCalls).toBe(0);
  });

  it('requires bearer auth for compression', async () => {
    const { env } = makeEnv();
    const response = await app.request(
      '/v1/compress',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
      },
      env
    );

    expect(response.status).toBe(401);
  });

  it('forwards valid compression requests and strips authorization', async () => {
    const { env, captured } = makeEnv();
    const response = await app.fetch(
      compressRequest({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        config: { compress_user_messages: true, target_ratio: 0.5 },
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ccr_hashes: ['abc'] });
    expect(captured).toHaveLength(1);
    expect(captured[0].request.headers.get('authorization')).toBeNull();
    expect(captured[0].request.headers.get('x-request-id')).toBeTruthy();
    expect(captured[0].body).toMatchObject({
      model,
      config: { compress_user_messages: true, target_ratio: 0.5 },
    });
  });

  it('rejects disallowed Headroom routes before container fetch', async () => {
    let containerCalls = 0;
    const { env } = makeEnv({
      fetch: async () => {
        containerCalls += 1;
        return Response.json({});
      },
    });

    const response = await app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: '{}',
      },
      env
    );

    expect(response.status).toBe(404);
    expect(containerCalls).toBe(0);
  });

  it('rejects non-allowlisted models', async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      compressRequest({
        model: 'kilo/openai/not-enabled',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'model_not_allowed' },
    });
  });

  it('rejects oversized declared content length', async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      new Request('https://headroom.kiloapps.io/v1/compress', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
          'content-length': '1048577',
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
      }),
      env
    );

    expect(response.status).toBe(413);
  });
});

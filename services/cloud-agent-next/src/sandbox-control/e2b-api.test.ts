import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import {
  createE2BSandbox,
  E2BApiError,
  getE2BSandbox,
  killE2BSandbox,
  listE2BSandboxes,
  readE2BResponseText,
  setE2BSandboxTimeout,
} from './e2b-api.js';
import { e2bCreateMetadata } from './e2b-runtime.js';
import {
  e2bTestConfig,
  e2bTestSandbox,
  E2B_TEST_INTENT_ID,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
} from './e2b-test-fixtures.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(E2B_TEST_NOW);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected test HTTP request')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('E2B bounded management transport', () => {
  it('submits a single fixed-endpoint, secured create with no guest account key', async () => {
    const config = e2bTestConfig();
    const transport = vi.fn(async () => Response.json(e2bTestSandbox(e2bTestConfig()), { status: 201 }));
    vi.stubGlobal('fetch', transport);
    vi.stubEnv('E2B_API_KEY', 'test-only-global-key');
    vi.stubEnv('E2B_API_URL', 'https://invalid.example');
    await expect(createE2BSandbox(E2B_TEST_KEY, config, E2B_TEST_INTENT_ID)).resolves.toEqual({
      sandboxID: E2B_TEST_PHYSICAL_ID,
      templateID: config.templateId,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const request = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (!(request instanceof Request)) throw new Error('Expected request');
    expect(request.url).toBe('https://api.e2b.app/sandboxes');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(request.cache).toBe('no-store');
    expect(request.headers.get('X-API-Key')).toBe(E2B_TEST_KEY);
    const text = await request.text();
    expect(JSON.parse(text)).toEqual({
      templateID: config.templateReference,
      timeout: 300,
      autoPause: false,
      autoResume: { enabled: false },
      secure: true,
      allow_internet_access: true,
      network: { allowPublicTraffic: false },
      metadata: e2bCreateMetadata(config, E2B_TEST_INTENT_ID),
    });
    expect(text).not.toContain(E2B_TEST_KEY);
    expect(text).not.toContain('test-only-global-key');
  });

  it('never retries a lost create response and discards transport error details', async () => {
    const transport = vi.fn().mockRejectedValue(new Error(`test-provider-body ${E2B_TEST_KEY}`));
    vi.stubGlobal('fetch', transport);
    const error = await createE2BSandbox(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID).catch(error => error);
    expect(error).toBeInstanceOf(E2BApiError);
    expect(error).toMatchObject({ code: 'byoc_e2b_unavailable' });
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(E2B_TEST_KEY);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('consumes one page with exact metadata, both states, and an encoded continuation token', async () => {
    const config = e2bTestConfig();
    const transport = vi.fn(async () =>
      Response.json([e2bTestSandbox(e2bTestConfig())], { headers: { 'X-Next-Token': 'next+/=' } })
    );
    vi.stubGlobal('fetch', transport);
    await expect(
      listE2BSandboxes(E2B_TEST_KEY, config, E2B_TEST_INTENT_ID, {
        limit: 20,
        nextToken: 'page+/=',
        deadlineAt: E2B_TEST_NOW + 5000,
      })
    ).resolves.toMatchObject({
      items: [{ sandboxID: E2B_TEST_PHYSICAL_ID }],
      nextToken: 'next+/=',
    });
    const request = vi.mocked(fetch).mock.calls[0]?.[0];
    if (!(request instanceof Request)) throw new Error('Expected request');
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v2/sandboxes');
    expect(url.searchParams.get('state')).toBe('running,paused');
    expect(url.searchParams.get('template')).toBe(config.templateId);
    expect(url.searchParams.get('nextToken')).toBe('page+/=');
    expect(Object.fromEntries(new URLSearchParams(url.searchParams.get('metadata') ?? ''))).toEqual(
      e2bCreateMetadata(config, E2B_TEST_INTENT_ID)
    );
  });

  it('rehydrates the sandbox-scoped envd token from a non-waking exact read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(e2bTestSandbox(e2bTestConfig())))
    );
    await expect(getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID)).resolves.toEqual(
      e2bTestSandbox(e2bTestConfig())
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[0];
    if (!(request instanceof Request)) throw new Error('Expected request');
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`https://api.e2b.app/sandboxes/${E2B_TEST_PHYSICAL_ID}`);
  });

  it.each([401, 403, 408, 429, 500, 503])(
    'preserves HTTP %s as a sanitized failure rather than absence',
    async status => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(E2B_TEST_KEY, { status }))
      );
      const error = await getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID).catch(error => error);
      expect(error).toBeInstanceOf(E2BApiError);
      expect(error.status).toBe(status);
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(E2B_TEST_KEY);
    }
  );

  it('accepts only exact-ID 404 as absence and exact kill completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('test-only-provider-error', { status: 404 }))
    );
    await expect(getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID)).resolves.toBeNull();
    await expect(killE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID)).resolves.toBeUndefined();
    await expect(
      listE2BSandboxes(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID, {
        limit: 20,
        deadlineAt: E2B_TEST_NOW + 5000,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('uses replacement timeout seconds and a single exact-ID kill', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    await setE2BSandboxTimeout(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID, 371);
    await killE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID);
    const requests = vi.mocked(fetch).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      if (!(request instanceof Request)) throw new Error('Expected request');
      expect(request.headers.get('X-API-Key')).toBe(E2B_TEST_KEY);
      expect(request.redirect).toBe('manual');
    }
    if (!(requests[0] instanceof Request) || !(requests[1] instanceof Request))
      throw new Error('Expected requests');
    expect(await requests[0].json()).toEqual({ timeout: 371 });
    expect(requests[1].method).toBe('DELETE');
    expect(new URL(requests[1].url).pathname).toBe(`/sandboxes/${E2B_TEST_PHYSICAL_ID}`);
  });

  it.each([301, 302, 307, 308])('rejects redirect status %s without following it', async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(null, { status, headers: { Location: 'https://invalid.example' } })
      )
    );
    await expect(getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
      status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'key\nheader', ' key ', 'x'.repeat(8193)])(
    'rejects an unsafe or missing explicit key %# without a global fallback',
    async key => {
      vi.stubEnv('E2B_API_KEY', E2B_TEST_KEY);
      await expect(getE2BSandbox(key, E2B_TEST_PHYSICAL_ID)).rejects.toMatchObject({
        code: 'byoc_e2b_credential_invalid',
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('cancels an oversized body even when content-length understates it', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('x'.repeat(256 * 1024 + 1)));
              },
              cancel,
            }),
            { headers: { 'Content-Length': '1' } }
          )
      )
    );
    await expect(getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('aborts a response that never supplies its body', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const reading = readE2BResponseText(
      new Response(new ReadableStream({ cancel })),
      100,
      controller.signal
    );
    controller.abort();
    await expect(reading).rejects.toBeInstanceOf(E2BProviderError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sandboxID: E2B_TEST_KEY },
    { envdAccessToken: E2B_TEST_KEY },
    { metadata: { ...e2bTestSandbox(e2bTestConfig()).metadata, reflectedSecret: E2B_TEST_KEY } },
  ])('rejects an account key reflected into resource or envd data %#', async patch => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...e2bTestSandbox(e2bTestConfig()), ...patch }))
    );
    const error = await getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID).catch(error => error);
    expect(error).toMatchObject({ code: 'byoc_e2b_unavailable' });
    expect(JSON.stringify(error)).not.toContain(E2B_TEST_KEY);
  });

  it('does not reuse an account key reflected into a continuation URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([], { headers: { 'X-Next-Token': E2B_TEST_KEY } }))
    );
    await expect(
      listE2BSandboxes(E2B_TEST_KEY, e2bTestConfig(), E2B_TEST_INTENT_ID, {
        limit: 20,
        deadlineAt: E2B_TEST_NOW + 5000,
      })
    ).rejects.toMatchObject({ code: 'byoc_e2b_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed responses without returning their content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(E2B_TEST_KEY))
    );
    const error = await getE2BSandbox(E2B_TEST_KEY, E2B_TEST_PHYSICAL_ID).catch(error => error);
    expect(error).toMatchObject({ code: 'byoc_e2b_unavailable' });
    expect(String(error)).not.toContain(E2B_TEST_KEY);
  });
});

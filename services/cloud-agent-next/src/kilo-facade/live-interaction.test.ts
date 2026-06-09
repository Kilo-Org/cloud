import { describe, expect, it, vi } from 'vitest';
import type { KiloFacadeHandlerContext } from './contracts.js';
import { openSelectedRootLiveInteraction, readInteractionRequestBody } from './live-interaction.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

const rootSessionID = 'ses_12345678901234567890123456';
const otherSessionID = 'ses_22222222222222222222222222';
const maximumInteractionBodyBytes = 512 * 1024;

function context(params: {
  url?: string;
  root?: { cloudAgentSessionId: string } | null;
  target?: { sandbox: { containerFetch: ReturnType<typeof vi.fn> }; port: number } | null;
}): KiloFacadeHandlerContext {
  const request = new Request(
    params.url ??
      `https://facade.test/kilo/question?directory=/cloud-agent/sessions/${rootSessionID}`
  );
  return {
    request,
    env: {} as KiloFacadeHandlerContext['env'],
    userId: 'user-1',
    url: new URL(request.url),
    kiloPath: '/question',
    deps: {
      resolveRootSessionForKiloSession: vi
        .fn()
        .mockResolvedValue(params.root ?? { cloudAgentSessionId: 'cloud-1' }),
      resolveLiveWrapper: vi.fn().mockResolvedValue(params.target ?? null),
    },
  };
}

const isEntry = (
  value: unknown
): value is Record<string, unknown> & { id: string; sessionID: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'id') === 'string' &&
  typeof Reflect.get(value, 'sessionID') === 'string';

describe('interaction request body', () => {
  const validBody = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && Reflect.get(value, 'accepted') === true;

  it('rejects an oversized declared content length before ownership or wrapper resolution', async () => {
    const testContext = context({});
    testContext.request = new Request(testContext.request.url, {
      method: 'POST',
      headers: { 'content-length': String(maximumInteractionBodyBytes + 1) },
      body: JSON.stringify({ accepted: true }),
    });

    const response = await readInteractionRequestBody(testContext.request, validBody);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: 'KILO_INTERACTION_BODY_INVALID',
    });
    expect(testContext.deps?.resolveRootSessionForKiloSession).not.toHaveBeenCalled();
    expect(testContext.deps?.resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('rejects a streamed body exceeding the limit before ownership or wrapper resolution', async () => {
    const testContext = context({});
    const oversizedChunk = new Uint8Array(maximumInteractionBodyBytes + 1);
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedChunk);
          controller.close();
        },
      }),
      duplex: 'half',
    };
    testContext.request = new Request(testContext.request.url, requestInit);

    expect(testContext.request.headers.has('content-length')).toBe(false);
    const response = await readInteractionRequestBody(testContext.request, validBody);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: 'KILO_INTERACTION_BODY_INVALID',
    });
    expect(testContext.deps?.resolveRootSessionForKiloSession).not.toHaveBeenCalled();
    expect(testContext.deps?.resolveLiveWrapper).not.toHaveBeenCalled();
  });
});

describe('selected-root live interaction', () => {
  it('requires exactly one public directory selector before resolving a wrapper', async () => {
    for (const url of [
      'https://facade.test/kilo/question',
      `https://facade.test/kilo/question?directory=/cloud-agent/sessions/${rootSessionID}&directory=/cloud-agent/sessions/${rootSessionID}`,
      `https://facade.test/kilo/question?directory=/cloud-agent/sessions/${rootSessionID}&limit=1`,
    ]) {
      const testContext = context({ url });
      const result = await openSelectedRootLiveInteraction(testContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
      expect(testContext.deps?.resolveLiveWrapper).not.toHaveBeenCalled();
    }
  });

  it('resolves ownership before returning the stable cold-runtime error', async () => {
    const testContext = context({ target: null });
    const result = await openSelectedRootLiveInteraction(testContext);
    expect(testContext.deps?.resolveRootSessionForKiloSession).toHaveBeenCalledWith(
      expect.objectContaining({ kiloSessionId: rootSessionID })
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    await expect((result as Response).json()).resolves.toMatchObject({
      error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
    });
  });

  it('filters lists and guards mutations on one resolved target', async () => {
    const containerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          { id: 'root-request', sessionID: rootSessionID },
          { id: 'foreign-request', sessionID: otherSessionID },
        ])
      )
      .mockResolvedValueOnce(Response.json([{ id: 'foreign-request', sessionID: otherSessionID }]));
    const testContext = context({ target: { sandbox: { containerFetch }, port: 4312 } });
    const result = await openSelectedRootLiveInteraction(testContext);
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;

    await expect(result.list({ path: '/question', isEntry })).resolves.toEqual([
      { id: 'root-request', sessionID: rootSessionID },
    ]);
    const mutation = await result.mutate({
      listPath: '/question',
      mutationPath: '/question/foreign-request/reject',
      requestID: 'foreign-request',
      isEntry,
    });
    expect(mutation.status).toBe(404);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(testContext.deps?.resolveLiveWrapper).toHaveBeenCalledTimes(1);
  });

  it('returns stable unavailable when a resolved target list fetch rejects', async () => {
    const containerFetch = vi.fn().mockRejectedValue(new Error('container unavailable'));
    const result = await openSelectedRootLiveInteraction(
      context({ target: { sandbox: { containerFetch }, port: 4312 } })
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;

    const list = await result.list({ path: '/question', isEntry });

    expect(list).toBeInstanceOf(Response);
    expect((list as Response).status).toBe(503);
    expect((list as Response).headers.get('Retry-After')).toBe('1');
    await expect((list as Response).json()).resolves.toMatchObject({
      error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
    });
  });

  it('maps wrapper runtime and proxy list failures to stable unavailable responses', async () => {
    for (const [wrapperError, status] of [
      ['KILO_RUNTIME_UNAVAILABLE', 503],
      ['KILO_PROXY_ERROR', 502],
    ] as const) {
      const containerFetch = vi
        .fn()
        .mockResolvedValue(Response.json({ error: wrapperError }, { status }));
      const result = await openSelectedRootLiveInteraction(
        context({ target: { sandbox: { containerFetch }, port: 4312 } })
      );
      expect(result).not.toBeInstanceOf(Response);
      if (result instanceof Response) continue;

      const list = await result.list({ path: '/question', isEntry });
      expect(list).toBeInstanceOf(Response);
      expect((list as Response).status).toBe(503);
      expect((list as Response).headers.get('Retry-After')).toBe('1');
      await expect((list as Response).json()).resolves.toMatchObject({
        error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
      });
    }
  });

  it('returns stable unavailable when mutation preflight succeeds but mutation fetch rejects', async () => {
    const containerFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([{ id: 'root-request', sessionID: rootSessionID }]))
      .mockRejectedValueOnce(new Error('container unavailable'));
    const result = await openSelectedRootLiveInteraction(
      context({ target: { sandbox: { containerFetch }, port: 4312 } })
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;

    const mutation = await result.mutate({
      listPath: '/question',
      mutationPath: '/question/root-request/reject',
      requestID: 'root-request',
      isEntry,
    });

    expect(mutation.status).toBe(503);
    expect(mutation.headers.get('Retry-After')).toBe('1');
    await expect(mutation.json()).resolves.toMatchObject({
      error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
    });
    expect(containerFetch).toHaveBeenCalledTimes(2);
  });

  it('maps wrapper runtime and proxy mutation failures to stable unavailable responses', async () => {
    for (const [wrapperError, status] of [
      ['KILO_RUNTIME_UNAVAILABLE', 503],
      ['KILO_PROXY_ERROR', 502],
    ] as const) {
      const containerFetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json([{ id: 'root-request', sessionID: rootSessionID }]))
        .mockResolvedValueOnce(Response.json({ error: wrapperError }, { status }));
      const result = await openSelectedRootLiveInteraction(
        context({ target: { sandbox: { containerFetch }, port: 4312 } })
      );
      expect(result).not.toBeInstanceOf(Response);
      if (result instanceof Response) continue;

      const mutation = await result.mutate({
        listPath: '/question',
        mutationPath: '/question/root-request/reject',
        requestID: 'root-request',
        isEntry,
      });
      expect(mutation.status).toBe(503);
      await expect(mutation.json()).resolves.toMatchObject({
        error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
      });
    }
  });

  it('preserves genuine native mutation responses', async () => {
    const nativeResponse = Response.json(
      { name: 'BadRequestError' },
      { status: 502, headers: { 'x-native': 'preserved' } }
    );
    const containerFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([{ id: 'root-request', sessionID: rootSessionID }]))
      .mockResolvedValueOnce(nativeResponse);
    const result = await openSelectedRootLiveInteraction(
      context({ target: { sandbox: { containerFetch }, port: 4312 } })
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;

    const mutation = await result.mutate({
      listPath: '/question',
      mutationPath: '/question/root-request/reject',
      requestID: 'root-request',
      isEntry,
    });
    expect(mutation.status).toBe(502);
    expect(mutation.headers.get('x-native')).toBe('preserved');
    await expect(mutation.json()).resolves.toEqual({ name: 'BadRequestError' });
  });

  it('rejects more than 1,000 individually valid entries within the byte limit', async () => {
    const entries = Array.from({ length: 1_001 }, (_, index) => ({
      id: `request-${index}`,
      sessionID: rootSessionID,
    }));
    const responseBody = JSON.stringify(entries);
    expect(new TextEncoder().encode(responseBody).byteLength).toBeLessThan(
      maximumInteractionBodyBytes
    );
    const containerFetch = vi.fn().mockResolvedValue(
      new Response(responseBody, {
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await openSelectedRootLiveInteraction(
      context({ target: { sandbox: { containerFetch }, port: 4312 } })
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;

    const list = await result.list({ path: '/question', isEntry });

    expect(list).toBeInstanceOf(Response);
    expect((list as Response).status).toBe(502);
    await expect((list as Response).json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('returns a stable invalid-upstream error for malformed or oversized lists', async () => {
    for (const response of [
      new Response('{not json', { headers: { 'content-type': 'application/json' } }),
      Response.json([{ id: 'missing-session' }]),
      new Response('[]', { headers: { 'content-length': String(512 * 1024 + 1) } }),
    ]) {
      const containerFetch = vi.fn().mockResolvedValue(response);
      const result = await openSelectedRootLiveInteraction(
        context({ target: { sandbox: { containerFetch }, port: 4312 } })
      );
      expect(result).not.toBeInstanceOf(Response);
      if (result instanceof Response) continue;
      const list = await result.list({ path: '/question', isEntry });
      expect(list).toBeInstanceOf(Response);
      expect((list as Response).status).toBe(502);
      await expect((list as Response).json()).resolves.toMatchObject({
        error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      });
    }
  });
});

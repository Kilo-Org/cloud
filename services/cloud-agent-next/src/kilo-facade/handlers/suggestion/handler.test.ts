import { describe, expect, it, vi } from 'vitest';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { handleSuggestion, isSuggestionRequest, parseSuggestionRoute } from './handler.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

const rootSessionID = 'ses_12345678901234567890123456';
const childSessionID = 'ses_22222222222222222222222222';

function suggestionContext(params: {
  method?: string;
  path?: string;
  body?: string;
  responses: Response[];
}): {
  context: KiloFacadeHandlerContext;
  containerFetch: ReturnType<typeof vi.fn>;
  resolveRootSessionForKiloSession: ReturnType<typeof vi.fn>;
} {
  const path = params.path ?? '/suggestion';
  const request = new Request(
    `https://facade.test/kilo${path}?directory=/cloud-agent/sessions/${rootSessionID}`,
    {
      method: params.method ?? 'GET',
      ...(params.body !== undefined
        ? { body: params.body, headers: { 'content-type': 'application/json' } }
        : {}),
    }
  );
  const containerFetch = vi.fn();
  for (const response of params.responses) containerFetch.mockResolvedValueOnce(response);
  const resolveRootSessionForKiloSession = vi
    .fn()
    .mockResolvedValue({ cloudAgentSessionId: 'cloud-1' });
  return {
    context: {
      request,
      env: {} as KiloFacadeHandlerContext['env'],
      userId: 'user-1',
      url: new URL(request.url),
      kiloPath: path,
      deps: {
        resolveRootSessionForKiloSession,
        resolveLiveWrapper: vi.fn().mockResolvedValue({ sandbox: { containerFetch }, port: 4312 }),
      },
    },
    containerFetch,
    resolveRootSessionForKiloSession,
  };
}

const rootSuggestion = {
  id: 'sug_root',
  sessionID: rootSessionID,
  text: 'Choose an approach',
  actions: [
    { label: 'First', prompt: 'Use the first approach' },
    { label: 'Second', description: 'Use the alternative', prompt: 'Use the second approach' },
  ],
  blocking: false,
  tool: { messageID: 'message-1', callID: 'call-1' },
};
const childSuggestion = {
  id: 'sug_child',
  sessionID: childSessionID,
  text: 'Choose a child approach',
  actions: [{ label: 'Child', prompt: 'Use the child approach' }],
};

describe('suggestion handler', () => {
  it('recognizes only the allowlisted suggestion routes', () => {
    expect(parseSuggestionRoute('GET', '/suggestion')).toEqual({ kind: 'list' });
    expect(parseSuggestionRoute('POST', '/suggestion/request-1/accept')).toEqual({
      kind: 'accept',
      requestID: 'request-1',
    });
    expect(parseSuggestionRoute('POST', '/suggestion/request-1/dismiss')).toEqual({
      kind: 'dismiss',
      requestID: 'request-1',
    });
    expect(parseSuggestionRoute('POST', '/suggestion/request%2F1/accept')).toEqual({
      kind: 'accept',
      requestID: 'request/1',
    });
    expect(parseSuggestionRoute('DELETE', '/suggestion/request-1/dismiss')).toBeNull();
    expect(parseSuggestionRoute('GET', '/suggestion/request-1/accept')).toBeNull();
    expect(parseSuggestionRoute('POST', '/suggestion//accept')).toBeNull();
    expect(parseSuggestionRoute('POST', '/suggestion/%E0%A4%A/accept')).toBeNull();
  });

  it('validates the native SuggestionRequest shape', () => {
    expect(isSuggestionRequest(rootSuggestion)).toBe(true);
    expect(isSuggestionRequest({ ...rootSuggestion, id: 'wrong-suggestion-root' })).toBe(false);
    expect(isSuggestionRequest({ ...rootSuggestion, text: undefined })).toBe(false);
    expect(isSuggestionRequest({ ...rootSuggestion, actions: [{ label: 'Missing prompt' }] })).toBe(
      false
    );
    expect(isSuggestionRequest({ ...rootSuggestion, blocking: 'false' })).toBe(false);
    expect(isSuggestionRequest({ ...rootSuggestion, tool: { messageID: 'message-1' } })).toBe(
      false
    );
  });

  it('requires a selected owned root before opening a live interaction', async () => {
    const { context, containerFetch, resolveRootSessionForKiloSession } = suggestionContext({
      responses: [],
    });
    context.url.search = '';
    context.request = new Request(context.url);

    const response = await handleSuggestion(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('preserves native suggestion entries while filtering child suggestions', async () => {
    const { context, containerFetch, resolveRootSessionForKiloSession } = suggestionContext({
      responses: [Response.json([rootSuggestion, childSuggestion])],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([rootSuggestion]);
    expect(resolveRootSessionForKiloSession).toHaveBeenCalledWith(
      expect.objectContaining({ kiloSessionId: rootSessionID })
    );
    const request = containerFetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/kilo-proxy/suggestion');
    expect(new URL(request.url).search).toBe('');
  });

  it('rejects invalid upstream suggestion entries', async () => {
    const { context } = suggestionContext({
      responses: [Response.json([{ ...rootSuggestion, actions: [{ label: 'Missing prompt' }] }])],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('preflights and forwards a valid accept index to the same live target', async () => {
    const { context, containerFetch } = suggestionContext({
      method: 'POST',
      path: '/suggestion/sug_root/accept',
      body: JSON.stringify({ index: 1 }),
      responses: [Response.json([rootSuggestion]), Response.json(true)],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const mutationRequest = containerFetch.mock.calls[1]?.[0];
    expect(new URL(mutationRequest.url).pathname).toBe('/kilo-proxy/suggestion/sug_root/accept');
    expect(new URL(mutationRequest.url).search).toBe('');
    await expect(mutationRequest.json()).resolves.toEqual({ index: 1 });
  });

  it('rejects accept bodies that are not exactly one non-negative integer index', async () => {
    for (const body of [
      {},
      { index: -1 },
      { index: 1.5 },
      { index: 0, extra: true },
      { index: '0' },
    ]) {
      const { context, containerFetch } = suggestionContext({
        method: 'POST',
        path: '/suggestion/sug_root/accept',
        body: JSON.stringify(body),
        responses: [],
      });

      const response = await handleSuggestion(context);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_BODY_INVALID',
      });
      expect(containerFetch).not.toHaveBeenCalled();
    }
  });

  it('preserves native invalid-index response semantics after preflight', async () => {
    const nativeInvalidIndex = Response.json(
      { name: 'BadRequestError', data: { message: 'Invalid action index' } },
      { status: 400, headers: { 'x-native-suggestion': 'invalid-index' } }
    );
    const { context, containerFetch } = suggestionContext({
      method: 'POST',
      path: '/suggestion/sug_root/accept',
      body: JSON.stringify({ index: 99 }),
      responses: [Response.json([rootSuggestion]), nativeInvalidIndex],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(400);
    expect(response.headers.get('x-native-suggestion')).toBe('invalid-index');
    await expect(response.json()).resolves.toEqual({
      name: 'BadRequestError',
      data: { message: 'Invalid action index' },
    });
    expect(containerFetch).toHaveBeenCalledTimes(2);
  });

  it('preflights and forwards dismiss while preserving its native response', async () => {
    const nativeResult = Response.json(false, { status: 404, headers: { 'x-native': 'dismiss' } });
    const { context, containerFetch } = suggestionContext({
      method: 'POST',
      path: '/suggestion/sug_root/dismiss',
      responses: [Response.json([rootSuggestion]), nativeResult],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-native')).toBe('dismiss');
    await expect(response.json()).resolves.toBe(false);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const mutationRequest = containerFetch.mock.calls[1]?.[0];
    expect(new URL(mutationRequest.url).pathname).toBe('/kilo-proxy/suggestion/sug_root/dismiss');
    expect(await mutationRequest.text()).toBe('');
  });

  it('accepts a native no-underscore ID and uses it for same-root mutation preflight', async () => {
    const nativeSuggestion = { ...rootSuggestion, id: 'suggestion-root' };
    const { context, containerFetch } = suggestionContext({
      method: 'POST',
      path: '/suggestion/suggestion-root/dismiss',
      responses: [Response.json([nativeSuggestion]), Response.json(true)],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(new URL(containerFetch.mock.calls[1]?.[0].url).pathname).toBe(
      '/kilo-proxy/suggestion/suggestion-root/dismiss'
    );
  });

  it('does not authorize a mutation from a malformed upstream suggestion ID', async () => {
    const malformedSuggestion = { ...rootSuggestion, id: 'wrong-suggestion-root' };
    const { context, containerFetch } = suggestionContext({
      method: 'POST',
      path: '/suggestion/suggestion-root/dismiss',
      responses: [Response.json([malformedSuggestion])],
    });

    const response = await handleSuggestion(context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it('returns facade 404 without mutation for stale, child, and foreign suggestion IDs', async () => {
    for (const requestID of ['sug_stale', 'sug_child', 'sug_foreign']) {
      const foreignSuggestion = { ...childSuggestion, id: 'sug_foreign' };
      const { context, containerFetch } = suggestionContext({
        method: 'POST',
        path: `/suggestion/${requestID}/dismiss`,
        responses: [Response.json([childSuggestion, foreignSuggestion])],
      });

      const response = await handleSuggestion(context);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_REQUEST_NOT_FOUND',
      });
      expect(containerFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('returns facade 404 before live-wrapper resolution for an unowned selected root', async () => {
    const { context, containerFetch, resolveRootSessionForKiloSession } = suggestionContext({
      responses: [],
    });
    resolveRootSessionForKiloSession.mockResolvedValue(null);

    const response = await handleSuggestion(context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(containerFetch).not.toHaveBeenCalled();
  });
});

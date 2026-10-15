import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { handleSecureProxyRequest } from './secure-proxy';

const originalFetch = global.fetch;

function proxyRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://secure-proxy.example.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function mockUpstream(response: Response) {
  const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response);
  global.fetch = fetchMock;
  return fetchMock;
}

function onlyFetchCall(fetchMock: jest.Mock<typeof fetch>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init, headers: new Headers(init?.headers) };
}

describe('handleSecureProxyRequest', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('forwards the body without the config to the configured URL with the configured headers', async () => {
    const fetchMock = mockUpstream(new Response('{"ok":true}', { status: 200 }));

    await handleSecureProxyRequest(
      proxyRequest(
        {
          model: 'upstream-model',
          messages: [{ role: 'user', content: 'hello' }],
          kilo_secure_proxy: {
            url: 'https://llm.example.com/v1/chat/completions?api-version=1',
            headers: { authorization: 'Bearer upstream-key', 'x-custom': 'value' },
          },
        },
        { 'x-vercel-protection-bypass': 'bypass-secret', cookie: 'session=1' }
      )
    );

    const { url, init, headers } = onlyFetchCall(fetchMock);
    expect(url).toBe('https://llm.example.com/v1/chat/completions?api-version=1');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'upstream-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(Object.fromEntries(headers)).toEqual({
      authorization: 'Bearer upstream-key',
      'content-type': 'application/json',
      'x-custom': 'value',
    });
  });

  it('returns the upstream body and status with only safe response headers', async () => {
    mockUpstream(
      new Response('data: hello\n\n', {
        status: 429,
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'req-1',
          'set-cookie': 'upstream=1',
          'x-upstream-secret': 'leak',
        },
      })
    );

    const response = await handleSecureProxyRequest(
      proxyRequest({
        kilo_secure_proxy: { url: 'https://llm.example.com/v1/messages', headers: {} },
      })
    );

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe('data: hello\n\n');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('request-id')).toBe('req-1');
    expect(response.headers.get('content-encoding')).toBe('identity');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-upstream-secret')).toBeNull();
  });

  it.each([
    ['a non-JSON body', 'not json'],
    ['a missing config', { model: 'm' }],
    ['a non-HTTPS URL', { kilo_secure_proxy: { url: 'http://llm.example.com', headers: {} } }],
    [
      'an invalid header name',
      { kilo_secure_proxy: { url: 'https://llm.example.com', headers: { 'bad header': 'x' } } },
    ],
  ])('rejects %s without calling upstream', async (_description, body) => {
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(body));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an upstream redirect into an error without exposing the location', async () => {
    mockUpstream(
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com' } })
    );

    const response = await handleSecureProxyRequest(
      proxyRequest({ kilo_secure_proxy: { url: 'https://llm.example.com', headers: {} } })
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error:
        'Upstream responded with a redirect (HTTP 307), which the secure proxy does not follow',
    });
  });

  it('returns 502 without details when the upstream fetch fails', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connect ECONNREFUSED https://llm.example.com'));

    const response = await handleSecureProxyRequest(
      proxyRequest({ kilo_secure_proxy: { url: 'https://llm.example.com', headers: {} } })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Upstream request failed' });
  });
});

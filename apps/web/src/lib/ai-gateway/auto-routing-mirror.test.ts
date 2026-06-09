import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockedWarnExceptInTest = jest.fn();

import { scheduleAutoRoutingMirror } from './auto-routing-mirror';

const originalFetch = globalThis.fetch;
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;

function makeRequest() {
  return new Request('http://localhost:3000/api/openrouter/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer user-token',
      'content-type': 'application/json',
      'x-kilocode-version': '1.2.3',
    },
    body: JSON.stringify({ model: 'auto', messages: [] }),
  });
}

describe('scheduleAutoRoutingMirror', () => {
  let scheduledWork: Array<() => void | Promise<void>>;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduledWork = [];
    globalThis.fetch = mockedFetch;
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('schedules a background mirror request with headers and raw body', async () => {
    scheduleAutoRoutingMirror(
      {
        request: makeRequest(),
        path: '/chat/completions',
        bodyText: '{"model":"auto","messages":[]}',
      },
      work => scheduledWork.push(work),
      {
        workerUrl: 'https://auto-routing.example.com',
        authToken: 'classifier-token',
      }
    );

    expect(scheduledWork).toHaveLength(1);
    await scheduledWork[0]();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('https://auto-routing.example.com/decide');
    expect(init).toMatchObject({ method: 'POST' });
    const payload = JSON.parse(init?.body as string);
    expect(payload).toMatchObject({
      path: '/chat/completions',
      headers: {
        authorization: '[REDACTED]',
        'content-type': 'application/json',
        'x-kilocode-version': '1.2.3',
      },
      body: '{"model":"auto","messages":[]}',
    });
    expect(new Date(payload.receivedAt).toISOString()).toBe(payload.receivedAt);

    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer classifier-token');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('swallows worker failures', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('worker unavailable'));

    scheduleAutoRoutingMirror(
      {
        request: makeRequest(),
        path: '/chat/completions',
        bodyText: '{"model":"auto","messages":[]}',
      },
      work => scheduledWork.push(work),
      {
        workerUrl: 'https://auto-routing.example.com',
        authToken: 'classifier-token',
        onError: (message, data) => mockedWarnExceptInTest(message, data),
      }
    );
    await scheduledWork[0]();

    expect(mockedWarnExceptInTest).toHaveBeenCalledWith('Auto routing mirror request failed', {
      error: 'worker unavailable',
    });
  });
});

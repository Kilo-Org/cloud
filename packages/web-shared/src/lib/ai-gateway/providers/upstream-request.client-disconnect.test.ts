import { captureException } from '@sentry/nextjs';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER } from './definitions/openrouter';
import type { OpenRouterChatCompletionRequest } from './openrouter/types';
import { upstreamRequest } from './upstream-request';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/utils.server') as Record<string, unknown>),
  errorExceptInTest: jest.fn(),
}));

const mockCaptureException = jest.mocked(captureException);
const mockErrorExceptInTest = jest.mocked(errorExceptInTest);
const originalFetch = global.fetch;

/** The reason Next.js aborts `request.signal` with when the client goes away. */
class ResponseAborted extends Error {
  override readonly name = 'ResponseAborted';
}

function request(signal: AbortSignal) {
  const body: OpenRouterChatCompletionRequest = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
  };
  return upstreamRequest({
    chatApi: 'chat_completions',
    search: '',
    method: 'POST',
    body,
    extraHeaders: {},
    provider: OPENROUTER,
    signal,
    vercelRequestId: 'iad1::request-id',
    reasoningEffort: null,
    durationBudgetMs: 60_000,
  });
}

/** Upstream that never sends headers; like undici, the fetch rejects with the abort reason. */
function headersNeverArrive() {
  global.fetch = jest.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('expected a signal');
        signal.addEventListener('abort', () => reject(signal.reason));
      })
  );
}

function expectUpstreamFailureLogged() {
  expect(mockErrorExceptInTest).toHaveBeenCalledWith(
    'AI gateway upstream fetch failed',
    expect.anything()
  );
  expect(mockCaptureException).toHaveBeenCalled();
}

function expectNoUpstreamFailureLogged() {
  expect(mockErrorExceptInTest).not.toHaveBeenCalledWith(
    'AI gateway upstream fetch failed',
    expect.anything()
  );
  expect(mockCaptureException).not.toHaveBeenCalled();
}

describe('upstreamRequest client disconnects', () => {
  let budgetTimer: AbortController;

  beforeEach(() => {
    jest.clearAllMocks();
    budgetTimer = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(budgetTimer.signal);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('answers 499 when Next.js aborts the request signal with ResponseAborted', async () => {
    headersNeverArrive();
    const client = new AbortController();

    const pending = request(client.signal);
    client.abort(new ResponseAborted());
    const result = await pending;

    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(499);
    await expect(result.response.json()).resolves.toMatchObject({
      error_type: 'client_disconnect',
    });
    expect(result.fetchFailure).toEqual({ timedOut: false });
    expectNoUpstreamFailureLogged();
  });

  it('answers 499 when the client leaves before the duration budget runs out', async () => {
    headersNeverArrive();
    const client = new AbortController();

    const pending = request(client.signal);
    client.abort(new ResponseAborted());
    budgetTimer.abort();
    const result = await pending;

    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(499);
    expectNoUpstreamFailureLogged();
  });

  it('keeps a timeout when the client leaves after the duration budget ran out', async () => {
    headersNeverArrive();
    const client = new AbortController();

    const pending = request(client.signal);
    budgetTimer.abort();
    client.abort(new ResponseAborted());
    const result = await pending;

    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toMatchObject({
      error_type: 'upstream_disconnect',
      message:
        'The upstream provider did not send response headers before the gateway timeout. (request id: iad1::request-id)',
    });
    expect(result.fetchFailure).toEqual({ timedOut: true });
    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      'AI gateway upstream fetch failed',
      expect.objectContaining({ failureFamily: 'request_timeout', errorName: 'TimeoutError' })
    );
    expectUpstreamFailureLogged();
  });

  it('keeps an upstream failure when the client leaves after the connection broke', async () => {
    const client = new AbortController();
    global.fetch = jest.fn(async () => {
      client.abort(new ResponseAborted());
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    });

    const result = await request(client.signal);

    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      'AI gateway upstream fetch failed',
      expect.objectContaining({ failureFamily: 'conn_reset' })
    );
    expectUpstreamFailureLogged();
  });
});

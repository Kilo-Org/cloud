import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER } from './definitions/openrouter';
import type { OpenRouterChatCompletionRequest } from './openrouter/types';
import { UpstreamTimeoutError, upstreamRequest } from './upstream-request';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// after() runs once the response is done; in these tests the response never
// finishes before a limit fires, so the timeout listeners must stay attached.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/utils.server') as Record<string, unknown>),
  errorExceptInTest: jest.fn(),
}));

const mockErrorExceptInTest = jest.mocked(errorExceptInTest);
const originalFetch = global.fetch;
const BUDGET_MS = 10 * 60 * 1000;
const STREAMING_HEADER_TIMEOUT_MS = 6 * 60 * 1000;
const encoder = new TextEncoder();

function request(stream: boolean) {
  const body: OpenRouterChatCompletionRequest = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
    stream,
  };
  return upstreamRequest({
    chatApi: 'chat_completions',
    search: '',
    method: 'POST',
    body,
    extraHeaders: {},
    provider: OPENROUTER,
    vercelRequestId: 'iad1::request-id',
    reasoningEffort: null,
  });
}

function signalFrom(init: RequestInit | undefined): AbortSignal {
  if (!init?.signal) throw new Error('expected a signal');
  return init.signal;
}

/** Upstream that never sends headers; the fetch rejects with the abort reason. */
function headersNeverArrive() {
  global.fetch = jest.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = signalFrom(init);
        signal.addEventListener('abort', () => reject(signal.reason));
      })
  );
}

/** Upstream that sends headers, then a chunk each time `push` is called; the body errors on abort. */
function streamingUpstream() {
  let push: (chunk: string) => void = () => {
    throw new Error('stream not started');
  };
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = signalFrom(init);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = chunk => controller.enqueue(encoder.encode(chunk));
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return { push: (chunk: string) => push(chunk) };
}

describe('upstreamRequest timeouts', () => {
  // Stand-ins for the AbortSignal.timeout timers, keyed by duration, so each
  // test decides which limit runs out.
  let timers: Map<number, AbortController>;
  const fire = (ms: number) => {
    const timer = timers.get(ms);
    if (!timer) throw new Error(`no ${ms}ms timer was armed`);
    timer.abort();
  };

  beforeEach(() => {
    mockErrorExceptInTest.mockReset();
    timers = new Map();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const timer = new AbortController();
      timers.set(ms, timer);
      return timer.signal;
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fails a streaming request whose headers do not arrive within the header timeout', async () => {
    headersNeverArrive();

    const pending = request(true);
    fire(STREAMING_HEADER_TIMEOUT_MS);
    const result = await pending;

    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      '[upstreamRequest] gateway timeout after 360000ms waiting for upstream response headers',
      { vercelRequestId: 'iad1::request-id', phase: 'headers' }
    );
    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      'AI gateway upstream fetch failed',
      expect.objectContaining({ failureFamily: 'request_timeout', errorName: 'TimeoutError' })
    );
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toMatchObject({
      error_type: 'upstream_disconnect',
      message:
        'The upstream provider did not send response headers before the gateway timeout. (request id: iad1::request-id)',
    });
  });

  it('lets a non-streaming request wait for headers up to the total budget', async () => {
    headersNeverArrive();

    const pending = request(false);
    expect([...timers.keys()]).toEqual([BUDGET_MS]);
    fire(BUDGET_MS);
    const result = await pending;

    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      '[upstreamRequest] gateway timeout after 600000ms waiting for upstream response headers',
      { vercelRequestId: 'iad1::request-id', phase: 'headers' }
    );
    expect(result.type).toBe('error');
  });

  it('keeps a flowing stream past the header timeout and stops it at the total budget', async () => {
    const upstream = streamingUpstream();
    // The request starts at 1s and its headers arrive at 6s.
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(6_000);

    const result = await request(true);
    if (result.type !== 'success') throw new Error('expected a streaming response');
    const reader = result.response.body?.getReader();
    if (!reader) throw new Error('expected a response body');

    // The header timer running out after the headers arrived changes nothing.
    fire(STREAMING_HEADER_TIMEOUT_MS);
    upstream.push('data: {"choices":[]}\n\n');
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    expect(mockErrorExceptInTest).not.toHaveBeenCalled();

    fire(BUDGET_MS);
    const readError = await reader.read().catch((error: unknown) => error);

    expect(readError).toBeInstanceOf(UpstreamTimeoutError);
    expect(readError).toMatchObject({
      name: 'TimeoutError',
      limitMs: BUDGET_MS,
      headersReceivedAfterMs: 5_000,
    });
    expect(mockErrorExceptInTest).toHaveBeenCalledTimes(1);
    expect(mockErrorExceptInTest).toHaveBeenCalledWith(
      '[upstreamRequest] upstream stream exceeded the gateway duration budget after 600s (headers at 5s)',
      { vercelRequestId: 'iad1::request-id', phase: 'stream' }
    );
  });
});

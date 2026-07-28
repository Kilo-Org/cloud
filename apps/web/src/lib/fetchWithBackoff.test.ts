import { fetchWithBackoff } from './fetchWithBackoff';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const originalFetch = global.fetch;

describe('fetchWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('caps the interval between retries', async () => {
    const response = new Response(null, { status: 404 });
    global.fetch = jest.fn().mockResolvedValue(response);
    jest.spyOn(console, 'warn').mockImplementation();

    const result = fetchWithBackoff('https://example.com/generation', undefined, {
      baseDelayMs: 1_000,
      maxBackoffDelayMs: 2_000,
      maxDelayMs: 7_000,
      retryResponse: candidate => candidate.status === 404,
    });

    await jest.advanceTimersByTimeAsync(4_499);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(1);
    expect(global.fetch).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(1_999);
    expect(global.fetch).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe(response);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('does not retry an aborted overall request', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    controller.abort(abortError);
    global.fetch = jest.fn().mockRejectedValue(abortError);

    await expect(
      fetchWithBackoff('https://example.com/generation', { signal: controller.signal })
    ).rejects.toBe(abortError);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops an inter-retry delay when the overall request aborts', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = fetchWithBackoff(
      'https://example.com/generation',
      { signal: controller.signal },
      {
        baseDelayMs: 10_000,
        retryResponse: candidate => candidate.status === 404,
      }
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    controller.abort(abortError);

    await expect(result).rejects.toBe(abortError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an attempt timeout while the overall request remains active', async () => {
    const overallController = new AbortController();
    const attemptTimeoutError = new DOMException('The operation timed out', 'TimeoutError');
    const overallAbortError = new DOMException('The operation was aborted', 'AbortError');
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(attemptTimeoutError), ms);
      return controller.signal;
    });
    global.fetch = jest.fn((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });

    const result = fetchWithBackoff(
      'https://example.com/generation',
      { signal: overallController.signal },
      { attemptTimeoutMs: 1_000, baseDelayMs: 500, maxDelayMs: 10_000 }
    );

    await jest.advanceTimersByTimeAsync(1_500);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    overallController.abort(overallAbortError);

    await expect(result).rejects.toBe(overallAbortError);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('polls throughout the generation retry budget without rapid requests', async () => {
    const response = new Response(null, { status: 404 });
    global.fetch = jest.fn().mockResolvedValue(response);
    jest.spyOn(console, 'warn').mockImplementation();

    const result = fetchWithBackoff('https://example.com/generation', undefined, {
      baseDelayMs: 2_000,
      maxBackoffDelayMs: 15_000,
      maxDelayMs: 5 * 60 * 1_000 - 1_000,
      retryResponse: candidate => candidate.status === 404,
    });

    await jest.advanceTimersByTimeAsync(296_374);
    expect(global.fetch).toHaveBeenCalledTimes(23);

    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(response);
    expect(global.fetch).toHaveBeenCalledTimes(24);
  });
});

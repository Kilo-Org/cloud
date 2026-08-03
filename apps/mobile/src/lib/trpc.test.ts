import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock expo-constants before any module that imports it.
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        apiBaseUrl: 'https://api.example.com',
        webBaseUrl: 'https://web.example.com',
        appsFlyerDevKey: 'dev-key',
        appsFlyerAppId: 'app-id',
        cloudAgentWsUrl: 'wss://agent.example.com',
        sessionIngestWsUrl: 'wss://ingest.example.com',
        kiloChatUrl: 'https://chat.example.com',
        eventServiceUrl: 'wss://events.example.com',
        notificationsUrl: 'https://notifications.example.com',
        posthogApiKey: 'ph-key',
      },
    },
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();

// Suppress Node.js 24 unhandledRejection from AbortController.abort()
// with a non-DOMException reason during fake-timer tests.
// eslint-disable-next-line @typescript-eslint/no-empty-function
function swallowUnhandledRejection(): void {}

describe('deadlineFetch', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns the response when fetch completes before the deadline', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const { deadlineFetch } = await import('./trpc');
    const response = await deadlineFetch('https://api.example.com/api/trpc');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects with RequestDeadlineError when the deadline expires', async () => {
    vi.useFakeTimers();
    process.on('unhandledRejection', swallowUnhandledRejection);
    try {
      // Fetch never resolves unless its signal aborts — simulates a hanging
      // backend where the only thing that cancels the request is the deadline.
      mockFetch.mockImplementation(
        // eslint-disable-next-line typescript-eslint/promise-function-async
        (_url, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason as Error);
              return;
            }
            const id = setTimeout(resolve, 60_000, new Response('never'));
            signal?.addEventListener('abort', () => {
              clearTimeout(id);
              reject(signal.reason as Error);
            });
          })
      );
      const { deadlineFetch } = await import('./trpc');
      const promise = deadlineFetch('https://api.example.com/api/trpc');

      vi.advanceTimersByTime(15_001);
      // eslint-disable-next-line typescript-eslint/await-thenable
      await vi.runAllTicks();

      await expect(promise).rejects.toThrow('timed out after 15000ms');
    } finally {
      process.off('unhandledRejection', swallowUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const { deadlineFetch } = await import('./trpc');
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    const promise = deadlineFetch('https://api.example.com/api/trpc', {
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow('caller cancelled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects with the caller abort reason when the signal is aborted during fetch', async () => {
    vi.useFakeTimers();
    try {
      // Fetch hangs unless its signal aborts.
      mockFetch.mockImplementation(
        // eslint-disable-next-line typescript-eslint/promise-function-async
        (_url, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason as Error);
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason as Error);
            });
          })
      );

      const { deadlineFetch } = await import('./trpc');
      const controller = new AbortController();
      const promise = deadlineFetch('https://api.example.com/api/trpc', {
        signal: controller.signal,
      });

      // Let the fetch start, then abort from the caller side.
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error('caller cancelled mid-flight'));

      // eslint-disable-next-line typescript-eslint/await-thenable
      await vi.runAllTicks();

      await expect(promise).rejects.toThrow('caller cancelled mid-flight');
    } finally {
      vi.useRealTimers();
    }
  });
});

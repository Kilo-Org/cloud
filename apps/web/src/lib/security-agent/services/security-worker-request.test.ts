import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import {
  postSecurityWorkerJson,
  SECURITY_SERVICE_UNAVAILABLE_MESSAGE,
} from './security-worker-request';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const params = {
  url: 'https://security-auto-analysis.test/internal/manual-analysis-start',
  service: 'analysis' as const,
  body: { schemaVersion: 1 },
};

describe('postSecurityWorkerJson transport classification', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function socketError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  async function rejection(): Promise<TRPCError> {
    let captured: unknown;
    try {
      await postSecurityWorkerJson(params);
      throw new Error('expected throw');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    return captured as TRPCError;
  }

  it('treats a refused connection as a definitive pre-acceptance rejection', async () => {
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', { cause: socketError('ECONNREFUSED') })
    );

    const error = await rejection();

    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.message).toBe(SECURITY_SERVICE_UNAVAILABLE_MESSAGE);
    expect(error.message).not.toContain('security-auto-analysis.test');
    expect(error.message).not.toContain('test-internal-secret');
  });

  it('treats a name-resolution failure across every tried address as definitive', async () => {
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new AggregateError(
          [socketError('ENOTFOUND'), socketError('EAI_AGAIN')],
          'getaddrinfo ENOTFOUND'
        ),
      })
    );

    const error = await rejection();

    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.message).toBe(SECURITY_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it('keeps a reset after the request was delivered ambiguous', async () => {
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', { cause: socketError('ECONNRESET') })
    );

    const error = await rejection();

    expect(error.code).toBe('BAD_GATEWAY');
    expect(error.message).toContain('Try again.');
  });

  it('keeps a partially delivered attempt ambiguous', async () => {
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new AggregateError(
          [socketError('ECONNREFUSED'), socketError('ECONNRESET')],
          'failed'
        ),
      })
    );

    expect((await rejection()).code).toBe('BAD_GATEWAY');
  });

  it('keeps a failure without a socket code ambiguous', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('other') }));

    expect((await rejection()).code).toBe('BAD_GATEWAY');
  });
});

describe('postSecurityWorkerJson', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('keeps the budget armed while the response body is read', async () => {
    jest.useFakeTimers();
    try {
      // The platform couples the request signal to the response body: aborting
      // it errors a body that never finishes. Emulated here, as in
      // `workspace-access-token-adapter.test.ts`.
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{"success":true'));
        },
      });
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => bodyController.error(new Error('aborted')));
        return Promise.resolve(new Response(stalledBody, { status: 202 }));
      });

      let settled = false;
      const outcome = postSecurityWorkerJson(params).catch((error: unknown) => {
        settled = true;
        return error;
      });

      await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS - 1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('BAD_GATEWAY');
      expect((error as TRPCError).message).not.toContain('security-auto-analysis.test');
      expect((error as TRPCError).message).not.toContain('test-internal-secret');
    } finally {
      jest.useRealTimers();
    }
  });
});

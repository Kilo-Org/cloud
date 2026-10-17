import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import { postSecurityWorkerJson } from './security-worker-request';

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

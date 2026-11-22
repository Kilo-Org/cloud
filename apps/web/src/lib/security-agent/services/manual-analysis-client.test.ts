import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import { submitManualAnalysisStart } from './manual-analysis-client';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualAnalysisStart', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits a durable manual analysis command and returns queued state', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        }),
    });

    await expect(
      submitManualAnalysisStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
        requestedModels: { analysisModel: 'analysis/model' },
        forceSandbox: true,
        retrySandboxOnly: true,
        restartActive: true,
      })
    ).resolves.toEqual({
      queued: true,
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-auto-analysis.test/internal/manual-analysis-start',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actorUserId: 'user-123',
          requestedModels: { analysisModel: 'analysis/model' },
          forceSandbox: true,
          retrySandboxOnly: true,
          restartActive: true,
        }),
      })
    );
  });

  it('bounds the Worker call at the shared upstream budget when it never answers', async () => {
    jest.useFakeTimers();
    try {
      // The platform errors a fetch (and its body) when the request signal
      // aborts; emulate that so the bound behaves as in production.
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason))
        );
      });

      let settled = false;
      const outcome = submitManualAnalysisStart(startParams()).catch((error: unknown) => {
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

  it('classifies a non-JSON gateway response as ambiguous transport, not a SyntaxError', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });

    let captured: unknown;
    try {
      await submitManualAnalysisStart(startParams());
      throw new Error('expected a rejection');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
    expect((captured as TRPCError).message).not.toContain('<');
    expect((captured as TRPCError).message).not.toContain('security-auto-analysis.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('classifies a Worker 5xx as ambiguous transport', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'gateway upstream unavailable' }),
    });

    await expect(submitManualAnalysisStart(startParams())).rejects.toMatchObject({
      name: 'TRPCError',
      code: 'BAD_GATEWAY',
    });
  });

  it('keeps a 4xx Worker rejection definitive', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid manual analysis command' }),
      });

      const error = await submitManualAnalysisStart(startParams()).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((error as TRPCError).message).toBe('Security analysis service request was rejected');
      expect((error as TRPCError).message).not.toContain('Invalid manual analysis command');
      expect(errorSpy).toHaveBeenCalledWith('Security analysis Worker rejected the request', {
        route: 'analysis/manual-analysis-start',
        status: 400,
        notes: 'Invalid manual analysis command',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps the known disabled-routing 503 definitive', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'Manual analysis Worker routing is disabled' }),
      });

      const error = await submitManualAnalysisStart(startParams()).catch(
        (caught: unknown) => caught
      );

      expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((error as Error).message).toBe('Security analysis service request was rejected');
      expect((error as Error).message).not.toContain('Manual analysis Worker routing is disabled');
      expect(errorSpy).toHaveBeenCalledWith('Security analysis Worker rejected the request', {
        route: 'analysis/manual-analysis-start',
        status: 503,
        notes: 'Manual analysis Worker routing is disabled',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps the known disabled-routing 503 definitive even with success true (no success requirement)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () =>
          Promise.resolve({
            error: 'Manual analysis Worker routing is disabled',
            success: true,
          }),
      });

      const error = await submitManualAnalysisStart(startParams()).catch(
        (caught: unknown) => caught
      );

      expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((error as Error).message).toBe('Security analysis service request was rejected');
      expect(errorSpy).toHaveBeenCalledWith('Security analysis Worker rejected the request', {
        route: 'analysis/manual-analysis-start',
        status: 503,
        notes: 'Manual analysis Worker routing is disabled',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('classifies a 401 Worker rejection as not-configured and caps the logged body note', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const workerBody = `${'internal secret mismatch '.repeat(20)}end`;
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: workerBody }),
      });

      const error = await submitManualAnalysisStart(startParams()).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((error as TRPCError).message).toBe('Security service is not configured');
      expect((error as TRPCError).message).not.toContain('internal secret mismatch');
      expect(workerBody.length).toBeGreaterThan(200);
      expect(errorSpy).toHaveBeenCalledWith('Security analysis Worker rejected the request', {
        route: 'analysis/manual-analysis-start',
        status: 401,
        notes: workerBody.slice(0, 200),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('submitManualAnalysisStart env configuration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  // `jest.doMock` only affects modules loaded after it, and the top-level
  // static import already loaded the subject, so each test re-imports it
  // dynamically to exercise the mocked-env loading boundary.

  it('throws a stable PRECONDITION_FAILED TRPCError when SECURITY_AUTO_ANALYSIS_WORKER_URL is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
      INTERNAL_API_SECRET: 'test-internal-secret',
      SECURITY_AUTO_ANALYSIS_WORKER_URL: '',
    }));
    const mod = await import('./manual-analysis-client');
    let captured: unknown;
    try {
      await mod.submitManualAnalysisStart(startParams());
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe('TRPCError');
    expect((captured as { code?: string }).code).toBe('PRECONDITION_FAILED');
    expect((captured as Error).message).toBe('Security service is not configured');
    expect((captured as Error).message).not.toContain('test-internal-secret');
  });

  it('throws a stable PRECONDITION_FAILED TRPCError when INTERNAL_API_SECRET is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
      INTERNAL_API_SECRET: '',
      SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
    }));
    const mod = await import('./manual-analysis-client');
    let captured: unknown;
    try {
      await mod.submitManualAnalysisStart(startParams());
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe('TRPCError');
    expect((captured as { code?: string }).code).toBe('PRECONDITION_FAILED');
    expect((captured as Error).message).toBe('Security service is not configured');
    expect((captured as Error).message).not.toContain('test-internal-secret');
  });
});

function startParams() {
  return {
    findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    actorUserId: 'user-123',
  };
}

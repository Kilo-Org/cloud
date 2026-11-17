import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import {
  submitApplyAutoRemediation,
  submitManualRemediationStart,
  submitRemediationCancellation,
} from './manual-remediation-client';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualRemediationStart', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns queued attempt correlation for accepted admission', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          admitted: true,
          remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          attemptNumber: 1,
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({
      queued: true,
      remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      attemptNumber: 1,
    });
  });

  it('returns a typed policy rejection for analysis_required', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          accepted: false,
          admitted: false,
          reason: 'analysis_required',
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({ queued: false, reason: 'analysis_required' });
  });

  it('returns a typed not-found rejection when the finding disappears', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          success: false,
          accepted: false,
          admitted: false,
          reason: 'finding_not_found',
        }),
    });

    await expect(
      submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({ queued: false, reason: 'finding_not_found' });
  });

  it('classifies a non-JSON gateway response as ambiguous transport, not a SyntaxError', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });

    let captured: unknown;
    try {
      await submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { userId: 'user-123' },
        actorUserId: 'user-123',
      });
      throw new Error('expected a rejection');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
    expect((captured as TRPCError).message).not.toContain('<');
  });
});

describe('remediation Worker call sites', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const callSites = [
    {
      name: 'remediation start',
      submit: () =>
        submitManualRemediationStart({
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          owner: { userId: 'user-123' },
          actorUserId: 'user-123',
        }),
    },
    {
      name: 'remediation cancellation',
      submit: () =>
        submitRemediationCancellation({
          attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          owner: { userId: 'user-123' },
          actorUserId: 'user-123',
        }),
    },
    {
      name: 'apply auto-remediation',
      submit: () =>
        submitApplyAutoRemediation({
          commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          owner: { userId: 'user-123' },
          actorUserId: 'user-123',
        }),
    },
  ];

  it.each(callSites)(
    'bounds $name at the shared upstream budget and stays retryable',
    async ({ submit }) => {
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
        const outcome = submit().catch((error: unknown) => {
          settled = true;
          return error;
        });

        await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS - 1);
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        const error = await outcome;
        expect(error).toBeInstanceOf(TRPCError);
        expect((error as TRPCError).code).toBe('BAD_GATEWAY');
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it.each(callSites)(
    'classifies a Worker 5xx on $name as ambiguous transport',
    async ({ submit }) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'internal error' }),
      });

      await expect(submit()).rejects.toMatchObject({ name: 'TRPCError', code: 'BAD_GATEWAY' });
    }
  );

  it.each(callSites)('keeps a 4xx on $name definitive', async ({ submit }) => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid request' }),
    });

    const error: TRPCError = await submit().then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as TRPCError
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe('PRECONDITION_FAILED');
    // The stable rejection sentence is dropped verbatim: the Worker's raw
    // error text never reaches the device.
    expect(error.message).toBe('Security remediation service request was rejected');
    expect(error.message).not.toContain('Invalid request');
  });
});

describe('remediation Worker call sites env configuration', () => {
  const capturedConfigError = async (
    submit: () => Promise<unknown>
  ): Promise<{ name?: string; code?: string; message: string }> => {
    let captured: unknown;
    try {
      await submit();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    return captured as { name?: string; code?: string; message: string };
  };

  it('throws a stable PRECONDITION_FAILED TRPCError when SECURITY_AUTO_ANALYSIS_WORKER_URL is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
      INTERNAL_API_SECRET: 'test-internal-secret',
      SECURITY_AUTO_ANALYSIS_WORKER_URL: '',
    }));
    const mod = await import('./manual-remediation-client');
    const captured = await capturedConfigError(() =>
      mod.submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(captured.name).toBe('TRPCError');
    expect(captured.code).toBe('PRECONDITION_FAILED');
    expect(captured.message).toBe('Security service is not configured');
    expect(captured.message).not.toContain('test-internal-secret');

    const applyCaptured = await capturedConfigError(() =>
      mod.submitApplyAutoRemediation({
        commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(applyCaptured.name).toBe('TRPCError');
    expect(applyCaptured.code).toBe('PRECONDITION_FAILED');
    expect(applyCaptured.message).toBe('Security service is not configured');

    const cancelCaptured = await capturedConfigError(() =>
      mod.submitRemediationCancellation({
        attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(cancelCaptured.name).toBe('TRPCError');
    expect(cancelCaptured.code).toBe('PRECONDITION_FAILED');
    expect(cancelCaptured.message).toBe('Security service is not configured');
  });

  it('throws a stable PRECONDITION_FAILED TRPCError when INTERNAL_API_SECRET is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
      INTERNAL_API_SECRET: '',
      SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
    }));
    const mod = await import('./manual-remediation-client');
    const captured = await capturedConfigError(() =>
      mod.submitManualRemediationStart({
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(captured.name).toBe('TRPCError');
    expect(captured.code).toBe('PRECONDITION_FAILED');
    expect(captured.message).toBe('Security service is not configured');

    const applyCaptured = await capturedConfigError(() =>
      mod.submitApplyAutoRemediation({
        commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(applyCaptured.name).toBe('TRPCError');
    expect(applyCaptured.code).toBe('PRECONDITION_FAILED');
    expect(applyCaptured.message).toBe('Security service is not configured');

    const cancelCaptured = await capturedConfigError(() =>
      mod.submitRemediationCancellation({
        attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actorUserId: 'user-123',
      })
    );
    expect(cancelCaptured.name).toBe('TRPCError');
    expect(cancelCaptured.code).toBe('PRECONDITION_FAILED');
    expect(cancelCaptured.message).toBe('Security service is not configured');
  });
});

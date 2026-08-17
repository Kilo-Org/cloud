import { TRPCError } from '@trpc/server';
import { submitManualFindingDismissal } from './manual-dismiss-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualFindingDismissal', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits the dismissal analytics identity and returns accepted correlation ids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          messageId: 'dismiss-message-123',
        }),
    });

    await expect(
      submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123', email: 'owner@example.com' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
        comment: 'No production usage',
      })
    ).resolves.toEqual({
      accepted: true,
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dismiss-message-123',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-sync.test/internal/dismiss-finding',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
      })
    );
    const request = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).actor).toEqual({
      id: 'user-123',
      email: 'owner@example.com',
    });
  });

  it('passes the stable operation key to the Worker when present', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          messageId: 'dismiss-message-123',
        }),
    });

    await submitManualFindingDismissal({
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123' },
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId: 'installation-123',
      reason: 'not_used',
      operationKey: 'retry-safe-key-123',
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      operationKey: 'retry-safe-key-123',
    });
  });

  it('throws a TRPCError (not a raw Error) when fetch rejects with a transport error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    await expect(
      submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      })
    ).rejects.toMatchObject({
      name: 'TRPCError',
      code: 'BAD_GATEWAY',
    });
  });

  it('classifies a 5xx status as ambiguous transport (BAD_GATEWAY)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'boom' }),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
    expect((captured as TRPCError).message).toContain('502');
    expect((captured as TRPCError).message).not.toContain('boom');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('classifies the known disabled-routing 503 as a definitive pre-acceptance rejection (PRECONDITION_FAILED)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () =>
        Promise.resolve({ success: false, error: 'Finding dismissal Worker routing is disabled' }),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((captured as TRPCError).message).toContain('503');
    // The known body is matched, never echoed back into the message.
    expect((captured as TRPCError).message).not.toContain('disabled');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('keeps a 503 with a non-matching body ambiguous transport (BAD_GATEWAY)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ success: false, error: 'gateway upstream unavailable' }),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
    expect((captured as TRPCError).message).toContain('503');
  });

  it('classifies a 4xx status as a definitive pre-acceptance rejection (PRECONDITION_FAILED)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'invalid' }),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((captured as TRPCError).message).not.toContain('invalid');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('classifies a non-JSON body as ambiguous transport (BAD_GATEWAY)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
  });

  it('classifies a 2xx with lost correlation ids as ambiguous transport (BAD_GATEWAY)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ success: true, accepted: true }),
    });

    let captured: unknown;
    try {
      await submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('BAD_GATEWAY');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });
});

describe('submitManualFindingDismissal env configuration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws a stable PRECONDITION_FAILED TRPCError when SECURITY_SYNC_WORKER_URL is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config.server', () => ({
      INTERNAL_API_SECRET: 'test-internal-secret',
      SECURITY_SYNC_WORKER_URL: '',
    }));
    const mod = await import('./manual-dismiss-client');
    let captured: unknown;
    try {
      await mod.submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
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
    jest.doMock('@/lib/config.server', () => ({
      INTERNAL_API_SECRET: '',
      SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
    }));
    const mod = await import('./manual-dismiss-client');
    let captured: unknown;
    try {
      await mod.submitManualFindingDismissal({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe('TRPCError');
    expect((captured as { code?: string }).code).toBe('PRECONDITION_FAILED');
    expect((captured as Error).message).toBe('Security service is not configured');
  });
});

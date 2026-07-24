import { TRPCError } from '@trpc/server';
import { submitManualSecuritySync } from './manual-sync-client';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
  SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('submitManualSecuritySync', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('submits actor and repository scope to the Worker and returns accepted correlation ids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          accepted: true,
          commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          messageId: 'message-123',
        }),
    });

    await expect(
      submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
        repoFullName: 'kilo/repo',
      })
    ).resolves.toEqual({
      accepted: true,
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      messageId: 'message-123',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://security-sync.test/internal/manual-sync',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
      })
    );
    expect(JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      schemaVersion: 1,
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
      repoFullName: 'kilo/repo',
    });
  });

  it('throws a TRPCError (not a raw Error) when fetch rejects with a transport error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    let captured: unknown;
    await expect(
      submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      })
    ).rejects.toMatchObject({
      name: 'TRPCError',
      code: 'INTERNAL_SERVER_ERROR',
    });

    try {
      await submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('throws a TRPCError when the response body is not valid JSON (e.g. gateway HTML)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });

    let captured: unknown;
    await expect(
      submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      })
    ).rejects.toBeInstanceOf(TRPCError);

    try {
      await submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('throws a TRPCError on a non-2xx JSON error response and does not leak worker error or secret', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'boom' }),
    });

    let captured: unknown;
    try {
      await submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    // Generic status-bearing message; must not echo the worker error or our secret
    expect((captured as TRPCError).message).toContain('500');
    expect((captured as TRPCError).message).not.toContain('boom');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });

  it('throws a TRPCError when the accepted-shape response is missing ids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ success: true }),
    });

    let captured: unknown;
    try {
      await submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
      throw new Error('expected throw');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((captured as TRPCError).message).not.toContain('security-sync.test');
    expect((captured as TRPCError).message).not.toContain('test-internal-secret');
  });
});

describe('submitManualSecuritySync env configuration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws a TRPCError when SECURITY_SYNC_WORKER_URL is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config.server', () => ({
      INTERNAL_API_SECRET: 'test-internal-secret',
      SECURITY_SYNC_WORKER_URL: '',
    }));
    const mod = await import('./manual-sync-client');
    let captured: unknown;
    try {
      await mod.submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe('TRPCError');
    expect((captured as { code?: string }).code).toBe('INTERNAL_SERVER_ERROR');
    expect((captured as Error).message).toContain('not configured');
    expect((captured as Error).message).not.toContain('test-internal-secret');
  });

  it('throws a TRPCError when INTERNAL_API_SECRET is empty (not a raw Error)', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config.server', () => ({
      INTERNAL_API_SECRET: '',
      SECURITY_SYNC_WORKER_URL: 'https://security-sync.test',
    }));
    const mod = await import('./manual-sync-client');
    let captured: unknown;
    try {
      await mod.submitManualSecuritySync({
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe('TRPCError');
    expect((captured as { code?: string }).code).toBe('INTERNAL_SERVER_ERROR');
    expect((captured as Error).message).toContain('not configured');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryAccessibleKiloSessionMock, sessionCache } = vi.hoisted(() => ({
  queryAccessibleKiloSessionMock: vi.fn(),
  sessionCache: {
    getAccess: vi.fn(),
    putValidated: vi.fn(),
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({ select: vi.fn() })),
}));

vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleKiloSession: queryAccessibleKiloSessionMock,
}));

vi.mock('../dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(() => sessionCache),
}));

const { resolveAccessibleKiloSession } = await import('./session-access');

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
} as never;

describe('resolveAccessibleKiloSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('denies a session when the user no longer has current access', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    queryAccessibleKiloSessionMock.mockResolvedValue(null);

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_removed',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toBeNull();
    expect(sessionCache.putValidated).not.toHaveBeenCalled();
  });

  it('caches an authoritative current organization access result', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    queryAccessibleKiloSessionMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
    expect(sessionCache.putValidated).toHaveBeenCalledWith({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
  });

  it('falls back to authoritative access when the cache is unavailable', async () => {
    sessionCache.getAccess.mockRejectedValue(new Error('cache unavailable'));
    queryAccessibleKiloSessionMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_owner',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });
  });

  it('allows authoritative access when the cache write fails', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    sessionCache.putValidated.mockRejectedValue(new Error('cache unavailable'));
    queryAccessibleKiloSessionMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
  });

  it('propagates authoritative lookup failures', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    queryAccessibleKiloSessionMock.mockRejectedValue(new Error('database unavailable'));

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).rejects.toThrow('database unavailable');
    expect(sessionCache.putValidated).not.toHaveBeenCalled();
  });

  it('reuses a recently validated organization access result', async () => {
    sessionCache.getAccess.mockResolvedValue({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
    expect(queryAccessibleKiloSessionMock).not.toHaveBeenCalled();
  });
});

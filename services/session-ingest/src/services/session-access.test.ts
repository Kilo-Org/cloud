import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryAccessibleKiloSessionWithFamilyMock, sessionCache } = vi.hoisted(() => ({
  queryAccessibleKiloSessionWithFamilyMock: vi.fn(),
  sessionCache: {
    getAccess: vi.fn(),
    putValidated: vi.fn(),
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({ select: vi.fn() })),
}));

vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleKiloSessionWithFamily: queryAccessibleKiloSessionWithFamilyMock,
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
    queryAccessibleKiloSessionWithFamilyMock.mockResolvedValue(null);

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
    queryAccessibleKiloSessionWithFamilyMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });
    expect(sessionCache.putValidated).toHaveBeenCalledWith({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });
  });

  it('falls back to authoritative access when the cache is unavailable', async () => {
    sessionCache.getAccess.mockRejectedValue(new Error('cache unavailable'));
    queryAccessibleKiloSessionWithFamilyMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
      cloudAgentFamilyId: null,
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_owner',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
      cloudAgentFamilyId: null,
    });
  });

  it('allows authoritative access when the cache write fails', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    sessionCache.putValidated.mockRejectedValue(new Error('cache unavailable'));
    queryAccessibleKiloSessionWithFamilyMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });
  });

  it('propagates authoritative lookup failures', async () => {
    sessionCache.getAccess.mockResolvedValue(null);
    queryAccessibleKiloSessionWithFamilyMock.mockRejectedValue(new Error('database unavailable'));

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
      cloudAgentFamilyId: null,
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });
    expect(queryAccessibleKiloSessionWithFamilyMock).not.toHaveBeenCalled();
  });

  it('reuses cached access only when the asserted family marker matches', async () => {
    sessionCache.getAccess.mockResolvedValue({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: 'cloud-agent-family-1',
    });

    await expect(
      resolveAccessibleKiloSession(env, {
        kiloUserId: 'usr_member',
        kiloSessionId: 'ses_12345678901234567890123456',
        expectedCloudAgentFamilyId: 'cloud-agent-family-1',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: 'cloud-agent-family-1',
    });
    expect(queryAccessibleKiloSessionWithFamilyMock).not.toHaveBeenCalled();
  });

  it('falls back to authoritative access for a stale family cache entry', async () => {
    sessionCache.getAccess.mockResolvedValue({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: null,
    });
    queryAccessibleKiloSessionWithFamilyMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
      cloudAgentFamilyId: 'cloud-agent-family-1',
    });

    await resolveAccessibleKiloSession(env, {
      kiloUserId: 'usr_member',
      kiloSessionId: 'ses_12345678901234567890123456',
      expectedCloudAgentFamilyId: 'cloud-agent-family-1',
    });

    expect(queryAccessibleKiloSessionWithFamilyMock).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_member',
      kiloSessionId: 'ses_12345678901234567890123456',
      expectedCloudAgentFamilyId: 'cloud-agent-family-1',
    });
    expect(sessionCache.putValidated).toHaveBeenCalledWith(
      expect.objectContaining({ cloudAgentFamilyId: 'cloud-agent-family-1' })
    );
  });
});

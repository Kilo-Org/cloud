import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types.js';

const { queryAccessibleCloudAgentSessionMock } = vi.hoisted(() => ({
  queryAccessibleCloudAgentSessionMock: vi.fn(),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({ select: vi.fn() })),
}));

vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccessibleCloudAgentSessionMock,
}));

const { projectSessionAccessHttpError, requireCurrentSessionAccess } =
  await import('./session-access.js');

function createEnv(): Pick<Env, 'HYPERDRIVE'> {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
  };
}

describe('requireCurrentSessionAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the authoritative current session identity', async () => {
    queryAccessibleCloudAgentSessionMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });

    await expect(
      requireCurrentSessionAccess({
        env: createEnv(),
        kiloUserId: 'usr_owner',
        cloudAgentSessionId: 'agent_owned',
        expectedOrganizationId: 'org_current',
        expectedKiloSessionId: 'ses_12345678901234567890123456',
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
  });

  it('reuses session access already validated for the same request', async () => {
    const validatedSessionAccess = {
      kiloUserId: 'usr_owner',
      cloudAgentSessionId: 'agent_owned',
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    };

    await expect(
      requireCurrentSessionAccess({
        env: createEnv(),
        kiloUserId: 'usr_owner',
        cloudAgentSessionId: 'agent_owned',
        expectedOrganizationId: 'org_current',
        expectedKiloSessionId: 'ses_12345678901234567890123456',
        validatedSessionAccess,
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org_current',
    });
    expect(queryAccessibleCloudAgentSessionMock).not.toHaveBeenCalled();
  });

  it('queries current access when validated access belongs to another session', async () => {
    queryAccessibleCloudAgentSessionMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });

    await expect(
      requireCurrentSessionAccess({
        env: createEnv(),
        kiloUserId: 'usr_owner',
        cloudAgentSessionId: 'agent_owned',
        validatedSessionAccess: {
          kiloUserId: 'usr_owner',
          cloudAgentSessionId: 'agent_other',
          kiloSessionId: 'ses_00000000000000000000000000',
          organizationId: null,
        },
      })
    ).resolves.toEqual({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });
    expect(queryAccessibleCloudAgentSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cloudAgentSessionId: 'agent_owned' })
    );
  });

  it.each([
    ['missing access', null, {}],
    [
      'organization mismatch',
      { kiloSessionId: 'ses_12345678901234567890123456', organizationId: 'org_other' },
      { expectedOrganizationId: 'org_current' },
    ],
    [
      'Kilo session mismatch',
      { kiloSessionId: 'ses_12345678901234567890123456', organizationId: null },
      { expectedKiloSessionId: 'ses_00000000000000000000000000' },
    ],
  ])('denies %s', async (_name, result, expected) => {
    queryAccessibleCloudAgentSessionMock.mockResolvedValue(result);

    await expect(
      requireCurrentSessionAccess({
        env: createEnv(),
        kiloUserId: 'usr_owner',
        cloudAgentSessionId: 'agent_owned',
        ...expected,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed when current access cannot be resolved', async () => {
    queryAccessibleCloudAgentSessionMock.mockRejectedValue(new Error('database unavailable'));

    await expect(
      requireCurrentSessionAccess({
        env: createEnv(),
        kiloUserId: 'usr_owner',
        cloudAgentSessionId: 'agent_owned',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('projectSessionAccessHttpError', () => {
  it('projects authorization failures without exposing infrastructure errors', async () => {
    const denied = projectSessionAccessHttpError(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const unavailable = projectSessionAccessHttpError(new Error('database unavailable'));

    expect(denied.status).toBe(403);
    await expect(denied.text()).resolves.toBe('Session access denied');
    expect(unavailable.status).toBe(503);
    await expect(unavailable.text()).resolves.toBe('Session access is temporarily unavailable');
  });
});

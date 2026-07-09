import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAgentSessionState } from './persistence/types.js';
import type { Env } from './types.js';

const {
  checkCloudAgentAdmissionMock,
  getPgDbMock,
  assertOrganizationMembershipMock,
  requireCurrentSessionAccessMock,
  requireSessionMetadataMock,
} = vi.hoisted(() => ({
  checkCloudAgentAdmissionMock: vi.fn(),
  getPgDbMock: vi.fn(),
  assertOrganizationMembershipMock: vi.fn(),
  requireCurrentSessionAccessMock: vi.fn(),
  requireSessionMetadataMock: vi.fn(),
}));

vi.mock('./cloud-agent-admission.js', () => ({
  checkCloudAgentAdmission: checkCloudAgentAdmissionMock,
}));
vi.mock('./db/pg.js', () => ({ getPgDb: getPgDbMock }));
vi.mock('./session-access.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));
vi.mock('./session/model-preflight.js', () => ({
  requireSessionMetadata: requireSessionMetadataMock,
}));

const { preflightCloudAgentModelBilling } = await import('./model-billing-preflight.js');

const env = {} as Env;
const authToken = 'jwt-token';
const db = {};
const metadata: CloudAgentSessionState = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'agent-existing', userId: 'user-1' },
  auth: { kilocodeToken: 'stored-token' },
  agent: { model: 'stored/model' },
  lifecycle: { version: 1, timestamp: 1 },
};

describe('Cloud Agent model billing preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPgDbMock.mockReturnValue(db);
    checkCloudAgentAdmissionMock.mockResolvedValue({
      classification: 'balance-required',
      balance: 5,
      isDepleted: false,
    });
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org-current',
    });
    requireSessionMetadataMock.mockResolvedValue(metadata);
  });

  it.each([
    ['prepareSession', { model: 'prepared/model' }, 'prepared/model'],
    ['start', { agent: { model: 'started/model' } }, 'started/model'],
    ['initiateFromKilocodeSessionV2', { cloudAgentSessionId: 'agent-existing' }, 'stored/model'],
    ['sendMessageV2', { cloudAgentSessionId: 'agent-existing', model: 'v2/model' }, 'v2/model'],
    [
      'sendMessageV2',
      {
        cloudAgentSessionId: 'agent-existing',
        payload: { type: 'command', command: 'compact' },
        model: 'caller/free-model',
      },
      'stored/model',
    ],
    [
      'send',
      { cloudAgentSessionId: 'agent-existing', agent: { model: 'send/model' } },
      'send/model',
    ],
    [
      'kilo.prompt_async',
      { cloudAgentSessionId: 'agent-existing', agent: { model: 'sdk/model' } },
      'sdk/model',
    ],
  ] as const)('resolves the effective model for %s', async (procedure, body, modelId) => {
    await preflightCloudAgentModelBilling({ env, userId: 'user-1', authToken, procedure, body });

    expect(checkCloudAgentAdmissionMock).toHaveBeenCalledWith({
      env,
      token: authToken,
      modelId,
      owner:
        procedure === 'prepareSession' || procedure === 'start'
          ? { userId: 'user-1' }
          : {
              organizationId: 'org-current',
            },
    });
  });

  it('surfaces the balance returned by the admission check', async () => {
    checkCloudAgentAdmissionMock.mockResolvedValue({
      classification: 'balance-required',
      balance: 0,
      isDepleted: true,
    });

    const result = await preflightCloudAgentModelBilling({
      env,
      userId: 'user-1',
      authToken,
      procedure: 'prepareSession',
      body: { model: 'prepared/model' },
    });

    expect(result).toMatchObject({
      classification: 'balance-required',
      balance: 0,
      isDepleted: true,
      owner: { userId: 'user-1' },
    });
  });

  it('uses current session access rather than a caller-supplied organization', async () => {
    const result = await preflightCloudAgentModelBilling({
      env,
      userId: 'user-1',
      authToken,
      procedure: 'send',
      body: { cloudAgentSessionId: 'agent-existing', kilocodeOrganizationId: 'org-requested' },
    });

    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'user-1',
      cloudAgentSessionId: 'agent-existing',
      expectedOrganizationId: 'org-requested',
      validatedSessionAccess: undefined,
    });
    expect(result.owner).toEqual({ organizationId: 'org-current' });
    expect(result.validatedSessionAccess).toMatchObject({ organizationId: 'org-current' });
  });

  it('checks membership before the admission call for an organization model', async () => {
    await preflightCloudAgentModelBilling({
      env,
      userId: 'user-1',
      authToken,
      procedure: 'start',
      body: {
        agent: { model: 'org/model' },
        options: { kilocodeOrganizationId: 'org-requested' },
      },
    });

    expect(assertOrganizationMembershipMock).toHaveBeenCalledWith(db, 'user-1', 'org-requested');
    expect(checkCloudAgentAdmissionMock).toHaveBeenCalledWith({
      env,
      token: authToken,
      modelId: 'org/model',
      owner: { organizationId: 'org-requested' },
    });
    expect(assertOrganizationMembershipMock.mock.invocationCallOrder[0]).toBeLessThan(
      checkCloudAgentAdmissionMock.mock.invocationCallOrder[0]
    );
  });

  it('does not run the admission call after a membership denial', async () => {
    assertOrganizationMembershipMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this organization' })
    );

    await expect(
      preflightCloudAgentModelBilling({
        env,
        userId: 'user-1',
        authToken,
        procedure: 'prepareSession',
        body: { model: 'org/model', kilocodeOrganizationId: 'org-requested' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(checkCloudAgentAdmissionMock).not.toHaveBeenCalled();
  });

  it('fails before the admission call when existing session metadata is missing', async () => {
    requireSessionMetadataMock.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' })
    );

    await expect(
      preflightCloudAgentModelBilling({
        env,
        userId: 'user-1',
        authToken,
        procedure: 'send',
        body: { cloudAgentSessionId: 'agent-existing' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(checkCloudAgentAdmissionMock).not.toHaveBeenCalled();
  });
});

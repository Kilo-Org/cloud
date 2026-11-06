jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  isWorkerAdminLegacyClaimIssuanceEnabled: jest.fn(),
  isWorkerAdminCapabilityIssuanceEnabled: jest.fn(),
  GASTOWN_CF_ACCESS_CLIENT_ID: '',
  GASTOWN_CF_ACCESS_CLIENT_SECRET: '',
}));
jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'identity-token'),
}));
jest.mock('@/lib/worker-admin/capability-issuer', () => ({
  issueWorkerAdminCapability: jest.fn(),
}));
jest.mock('@/lib/worker-admin/actor-guard', () => {
  class WorkerAdminActorError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  }
  return { requireWorkerAdminActor: jest.fn(), WorkerAdminActorError };
});

import {
  isWorkerAdminCapabilityIssuanceEnabled,
  isWorkerAdminLegacyClaimIssuanceEnabled,
} from '@kilocode/web-shared/lib/config.server';
import { issueWorkerAdminCapability } from '@/lib/worker-admin/capability-issuer';
import { requireWorkerAdminActor, WorkerAdminActorError } from '@/lib/worker-admin/actor-guard';
import { buildAdminHeaders } from './gastown-router';

const user = {
  id: 'user-1',
  is_admin: true,
  api_token_pepper: 'replica-pepper',
} as never;

const params = {
  action: 'rest:GET /api/towns/:townId/config',
  target: { kind: 'town' as const, id: 'town-1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isWorkerAdminCapabilityIssuanceEnabled).mockReturnValue(true);
});

describe('buildAdminHeaders capability safety', () => {
  it('keeps the legacy claim path when legacy issuance is on', async () => {
    jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(true);
    const headers = await buildAdminHeaders(
      { user, credential: 'session', headersList: new Headers() },
      params
    );
    expect(headers.Authorization).toBe('Bearer identity-token');
    expect(headers['X-Kilo-Worker-Capability']).toBeUndefined();
    expect(requireWorkerAdminActor).not.toHaveBeenCalled();
  });

  it('refuses a bearer credential once capability issuance replaces legacy claims', async () => {
    jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(false);
    await expect(
      buildAdminHeaders(
        {
          user,
          credential: 'token',
          headersList: new Headers({ Authorization: 'Bearer personal-api-key' }),
        },
        params
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(requireWorkerAdminActor).not.toHaveBeenCalled();
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });

  it('refuses a session without fresh step-up', async () => {
    jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(false);
    jest
      .mocked(requireWorkerAdminActor)
      .mockRejectedValue(
        new WorkerAdminActorError(403, 'step_up_required', 'Fresh step-up is required')
      );
    await expect(
      buildAdminHeaders({ user, credential: 'session', headersList: new Headers() }, params)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });

  it('mints with the guard primary pepper after fresh step-up', async () => {
    jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(false);
    jest.mocked(requireWorkerAdminActor).mockResolvedValue({
      actor: { assurance: { userId: 'user-1' } },
      sessionBinding: { apiTokenPepper: 'primary-pepper', webSessionPepper: null },
    } as never);
    jest.mocked(issueWorkerAdminCapability).mockResolvedValue({
      capability: 'capability-token',
      capabilityExpiresAt: '2026-01-01T00:01:00.000Z',
      jti: 'jti-1',
      actions: [params.action],
    });

    const headers = await buildAdminHeaders(
      { user, credential: 'session', headersList: new Headers() },
      params
    );

    expect(headers['X-Kilo-Worker-Capability']).toBe('capability-token');
    expect(issueWorkerAdminCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'user-1', api_token_pepper: 'primary-pepper' }),
        target: params.target,
        actions: [params.action],
        ttlSeconds: 60,
      })
    );
  });
});

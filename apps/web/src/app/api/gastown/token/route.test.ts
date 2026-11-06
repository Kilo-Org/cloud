jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/gastown/feature-flags', () => ({
  isGastownEnabled: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getUserOrgMemberships: jest.fn(async () => []),
}));
jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'identity-token'),
}));
jest.mock('@kilocode/web-shared/lib/admin/admin-access-log', () => ({
  recordKiloAdminElevationForRequest: jest.fn(async () => undefined),
  serviceTarget: (id: string) => `service:${id}`,
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  isWorkerAdminLegacyClaimIssuanceEnabled: jest.fn(() => true),
  isWorkerAdminCapabilityIssuanceEnabled: jest.fn(() => true),
  INTERNAL_API_SECRET: 'internal-secret',
}));
jest.mock('@/lib/worker-admin/actor-guard', () => ({
  requireWorkerAdminActor: jest.fn(),
  WorkerAdminActorError: class WorkerAdminActorError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
jest.mock('@/lib/worker-admin/capability-issuer', () => ({
  AdminCapabilityRequestSchema: jest.requireActual('@/lib/worker-admin/capability-issuer')
    .AdminCapabilityRequestSchema,
  WorkerAdminCapabilityIssuanceError: class WorkerAdminCapabilityIssuanceError extends Error {},
  issueWorkerAdminCapability: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { recordKiloAdminElevationForRequest } from '@kilocode/web-shared/lib/admin/admin-access-log';
import { isWorkerAdminLegacyClaimIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import { requireWorkerAdminActor, WorkerAdminActorError } from '@/lib/worker-admin/actor-guard';
import { issueWorkerAdminCapability } from '@/lib/worker-admin/capability-issuer';
import { POST } from './route';

const user = { id: 'user-1', is_admin: true, api_token_pepper: 'pepper-1' };

function request(body?: unknown): Request {
  return new Request('https://app.example.test/api/gastown/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserFromAuth).mockResolvedValue({ user, tokenSource: 'session' } as never);
  jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(true);
});

describe('POST /api/gastown/token', () => {
  it('mints the ordinary identity token with the legacy admin claim by default', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token: 'identity-token' });
    expect(generateApiToken).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ isAdmin: true, gastownAccess: true }),
      { expiresIn: 3600 }
    );
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'service_token_mint' })
    );
  });

  it('records the legacy elevation even when a capability body is sent', async () => {
    jest.mocked(requireWorkerAdminActor).mockResolvedValue({
      actor: { assurance: { userId: 'user-1' } },
      sessionBinding: { apiTokenPepper: 'pepper-1', webSessionPepper: null },
    } as never);
    jest.mocked(issueWorkerAdminCapability).mockResolvedValue({
      capability: 'capability-token',
      capabilityExpiresAt: '2026-01-01T00:05:00.000Z',
      jti: 'jti-1',
      actions: ['trpc:gastown.getTown'],
    });
    await POST(request({ adminCapability: { target: { kind: 'town', id: 'town-1' } } }));
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'service_token_mint' })
    );
  });

  it('stops issuing the legacy admin claim when the flag is off', async () => {
    jest.mocked(isWorkerAdminLegacyClaimIssuanceEnabled).mockReturnValue(false);
    await POST(request());
    expect(generateApiToken).toHaveBeenCalledWith(
      user,
      expect.not.objectContaining({ isAdmin: true }),
      { expiresIn: 3600 }
    );
  });

  it('mints a capability only after the interim actor guard passes', async () => {
    jest
      .mocked(requireWorkerAdminActor)
      .mockRejectedValue(
        new WorkerAdminActorError(403, 'step_up_required', 'Fresh multi-factor step-up is required')
      );
    const response = await POST(
      request({ adminCapability: { target: { kind: 'town', id: 'town-1' } } })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'step_up_required' });
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });

  it('returns the capability once the guard passes', async () => {
    jest.mocked(requireWorkerAdminActor).mockResolvedValue({
      actor: { assurance: { userId: 'user-1' } },
      sessionBinding: { apiTokenPepper: 'pepper-1', webSessionPepper: null },
    } as never);
    jest.mocked(issueWorkerAdminCapability).mockResolvedValue({
      capability: 'capability-token',
      capabilityExpiresAt: '2026-01-01T00:05:00.000Z',
      jti: 'jti-1',
      actions: ['trpc:gastown.getTown'],
    });
    const response = await POST(
      request({ adminCapability: { target: { kind: 'town', id: 'town-1' } } })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capability: 'capability-token',
      capabilityExpiresAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('ignores an unrelated JSON body like it did before capabilities', async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token: 'identity-token' });
    expect(requireWorkerAdminActor).not.toHaveBeenCalled();
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'service_token_mint' })
    );
  });

  it('refuses a guard result for a different user', async () => {
    jest.mocked(requireWorkerAdminActor).mockResolvedValue({
      actor: { assurance: { userId: 'user-2' } },
      sessionBinding: { apiTokenPepper: 'pepper-1', webSessionPepper: null },
    } as never);
    const response = await POST(
      request({ adminCapability: { target: { kind: 'town', id: 'town-1' } } })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Worker admin capabilities require the same authenticated user',
    });
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });

  it('rejects a malformed capability request', async () => {
    const response = await POST(request({ adminCapability: { target: { kind: 'nope' } } }));
    expect(response.status).toBe(400);
    expect(requireWorkerAdminActor).not.toHaveBeenCalled();
  });
});

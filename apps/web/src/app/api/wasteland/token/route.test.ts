jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
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
}));
jest.mock('@/lib/worker-admin/actor-guard', () => ({
  requireWorkerAdminActor: jest.fn(),
  WorkerAdminActorError: class WorkerAdminActorError extends Error {},
}));
jest.mock('@/lib/worker-admin/capability-issuer', () => ({
  AdminCapabilityRequestSchema: jest.requireActual('@/lib/worker-admin/capability-issuer')
    .AdminCapabilityRequestSchema,
  WorkerAdminCapabilityIssuanceError: class WorkerAdminCapabilityIssuanceError extends Error {},
  issueWorkerAdminCapability: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { requireWorkerAdminActor } from '@/lib/worker-admin/actor-guard';
import { issueWorkerAdminCapability } from '@/lib/worker-admin/capability-issuer';
import { recordKiloAdminElevationForRequest } from '@kilocode/web-shared/lib/admin/admin-access-log';
import { POST } from './route';

const user = { id: 'user-1', is_admin: true, api_token_pepper: 'pepper-1' };

function request(body?: unknown): Request {
  return new Request('https://app.example.test/api/wasteland/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserFromAuth).mockResolvedValue({ user, tokenSource: 'session' } as never);
});

describe('POST /api/wasteland/token', () => {
  it('ignores an unrelated JSON body', async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token: 'identity-token',
      admin: true,
      capabilityIssuance: true,
    });
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'service_token_mint' })
    );
  });

  it('records the legacy elevation for a capability request', async () => {
    jest.mocked(requireWorkerAdminActor).mockResolvedValue({
      actor: { assurance: { userId: 'user-1' } },
      sessionBinding: { apiTokenPepper: 'pepper-1', webSessionPepper: null },
    } as never);
    jest.mocked(issueWorkerAdminCapability).mockResolvedValue({
      capability: 'capability-token',
      capabilityExpiresAt: '2026-01-01T00:05:00.000Z',
      jti: 'jti-1',
      actions: ['trpc:wasteland.getWasteland'],
    });
    await POST(request({ adminCapability: { target: { kind: 'wasteland', id: 'w-1' } } }));
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'service_token_mint' })
    );
  });
});

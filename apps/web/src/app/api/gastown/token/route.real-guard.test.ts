jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { query: { kilocode_users: { findFirst: jest.fn() } } },
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
  isWorkerAdminLegacyClaimIssuanceEnabled: jest.fn(() => false),
  isWorkerAdminCapabilityIssuanceEnabled: jest.fn(() => true),
}));
jest.mock('@/lib/worker-admin/capability-issuer', () => {
  const actual = jest.requireActual('@/lib/worker-admin/capability-issuer');
  return {
    ...actual,
    issueWorkerAdminCapability: jest.fn(),
  };
});

import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { issueWorkerAdminCapability } from '@/lib/worker-admin/capability-issuer';
import { POST } from './route';

const user = { id: 'user-1', is_admin: true, api_token_pepper: 'pepper-1' };
const body = JSON.stringify({ adminCapability: { target: { kind: 'town', id: 'town-1' } } });

function request(headers: Record<string, string>): Request {
  return new Request('https://app.example.test/api/gastown/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserFromAuth).mockResolvedValue({ user, tokenSource: 'session' } as never);
});

describe('gastown token route with the real actor guard', () => {
  it('refuses a bearer credential before reading the session', async () => {
    const response = await POST(request({ Authorization: 'Bearer personal-api-key' }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'session_required' });
    expect(getUserFromSessionForCredentialIssuance).not.toHaveBeenCalled();
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });

  it('refuses a session without fresh step-up', async () => {
    jest
      .mocked(getUserFromSessionForCredentialIssuance)
      .mockResolvedValue({ user: { id: 'user-1' } } as never);
    jest.mocked(db.query.kilocode_users.findFirst).mockResolvedValue({
      id: 'user-1',
      is_admin: true,
      is_super_admin: false,
      api_token_pepper: 'pepper-1',
      blocked_at: null,
      google_user_email: 'admin@example.com',
    } as never);

    const response = await POST(request({}));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'step_up_required' });
    expect(issueWorkerAdminCapability).not.toHaveBeenCalled();
  });
});

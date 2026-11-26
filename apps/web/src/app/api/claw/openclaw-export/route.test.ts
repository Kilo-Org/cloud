import { NextRequest } from 'next/server';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { POST } from './route';

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return { ...actual, connection: jest.fn() };
});
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/lib/kiloclaw/access-gate', () => ({ requireKiloClawAccess: jest.fn() }));
jest.mock('@/lib/kiloclaw/instance-registry', () => ({
  getActiveInstance: jest.fn(),
  getActiveOrgInstance: jest.fn(),
  workerInstanceId: jest.fn(() => 'worker-instance'),
}));
const mockExport = jest.fn();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawApiError: class KiloClawApiError extends Error {},
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    exportOpenclawWorkspace: mockExport,
  })),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedOrgInstance = jest.mocked(getActiveOrgInstance);

function postExport(organizationId: string): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/claw/openclaw-export', {
      method: 'POST',
      body: JSON.stringify({ format: 'tar.gz', organizationId }),
    })
  );
}

beforeEach(() => {
  mockedGetUserFromAuth.mockReset();
  mockedOrgInstance.mockReset();
  mockedOrgInstance.mockImplementation(async (userId, organizationId) => ({
    id: 'instance-1',
    userId,
    sandboxId: 'ki_instance-1',
    organizationId,
    name: null,
    inboundEmailEnabled: false,
  }));
  mockExport.mockReset();
  mockExport.mockResolvedValue(
    new Response('archive', { headers: { 'content-type': 'application/gzip' } })
  );
});

afterEach(async () => {
  await cleanupDbForTest();
});

describe('POST /api/claw/openclaw-export for an organization', () => {
  it('exports the workspace of a real member', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createTestOrganization('Export org', owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');
    mockedGetUserFromAuth.mockResolvedValue({ user: member, authFailedResponse: null });

    const response = await postExport(organization.id);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('archive');
  });

  it('refuses a non-member with the existing message', async () => {
    const owner = await insertTestUser();
    const outsider = await insertTestUser();
    const organization = await createTestOrganization('Export org', owner.id, 0);
    mockedGetUserFromAuth.mockResolvedValue({ user: outsider, authFailedResponse: null });

    const response = await postExport(organization.id);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have access to this organization',
    });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('refuses staff without a membership and exports nothing', async () => {
    const owner = await insertTestUser();
    const staff = await insertTestUser({ is_admin: true });
    const organization = await createTestOrganization('Export org', owner.id, 0);
    mockedGetUserFromAuth.mockResolvedValue({ user: staff, authFailedResponse: null });

    const response = await postExport(organization.id);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have access to this organization',
    });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('exports for staff who hold a real membership', async () => {
    const owner = await insertTestUser();
    const staff = await insertTestUser({ is_admin: true });
    const organization = await createTestOrganization('Export org', owner.id, 0);
    await addUserToOrganization(organization.id, staff.id, 'member');
    mockedGetUserFromAuth.mockResolvedValue({ user: staff, authFailedResponse: null });

    const response = await postExport(organization.id);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('archive');
  });
});

import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  addUserToOrganization,
  getOrganizationById,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getAuthorizedOrgContextOrSupport } from '@/lib/organizations/organization-auth';
import { GET } from './route';

jest.mock('@/lib/organizations/organization-auth');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContextOrSupport);

async function requestAs(userId: string, organizationId: string) {
  const organization = await getOrganizationById(organizationId);
  mockedGetAuthorizedOrgContext.mockResolvedValue({
    success: true,
    data: { organization, user: { id: userId } },
  } as never);
  return GET(new NextRequest('http://localhost:3000'), {
    params: Promise.resolve({ id: organizationId }),
  });
}

describe('GET /api/organizations/[id]/browser-policy', () => {
  afterEach(cleanupDbForTest);

  test('returns the stored policy to an organization member', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createTestOrganization('Browser policy', owner.id, 0, {
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com', 'http://localhost:3000'],
    });
    await addUserToOrganization(organization.id, member.id, 'member');

    const response = await requestAs(member.id, organization.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      browserControl: 'playwright_only',
      browserAllowedOrigins: ['https://example.com', 'http://localhost:3000'],
    });
    expect(mockedGetAuthorizedOrgContext).toHaveBeenCalledWith(
      organization.id,
      '/api/organizations/[id]/browser-policy',
      undefined,
      { requestMethod: 'GET' }
    );
  });

  test('returns the defaults when the organization has not set a policy', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('No browser policy', owner.id, 0, {});

    const response = await requestAs(owner.id, organization.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      browserControl: 'allow',
      browserAllowedOrigins: [],
    });
  });

  test('returns the authorization failure unchanged', async () => {
    const failure = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: false,
      nextResponse: failure,
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(response.status).toBe(404);
  });
});

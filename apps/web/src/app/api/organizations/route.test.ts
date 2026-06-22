import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user/server';

jest.mock('@/lib/organizations/organizations', () => ({
  getProfileOrganizations: jest.fn(),
}));
jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const mockedGetProfileOrganizations = jest.mocked(getProfileOrganizations);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /api/organizations', () => {
  test('returns organizations for the authenticated user', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: { id: 'user-1' },
    } as never);
    mockedGetProfileOrganizations.mockResolvedValue([
      { id: 'org-1', name: 'Acme', role: 'owner' },
      { id: 'org-2', name: 'Kilo', role: 'member' },
    ]);

    const response = await GET(new NextRequest('http://localhost:3000/api/organizations'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      organizations: [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Kilo' },
      ],
    });
    expect(mockedGetProfileOrganizations).toHaveBeenCalledWith('user-1');
  });
});

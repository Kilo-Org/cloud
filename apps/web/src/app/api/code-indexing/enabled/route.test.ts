import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  isCodeIndexingEnabled: () => false,
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /api/code-indexing/enabled', () => {
  test('returns disabled without checking organization settings when the feature is off', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: { id: 'user-1' },
    } as never);

    const response = await GET(
      new NextRequest('http://localhost:3000/api/code-indexing/enabled?organizationId=org-1')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });
});

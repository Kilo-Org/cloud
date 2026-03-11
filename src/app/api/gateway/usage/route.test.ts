import { describe, test, expect, beforeAll, afterEach, jest } from '@jest/globals';
import { GET } from './route';
import { NextRequest } from 'next/server';

// Mock dependencies
const mockGetBalanceAndOrgSettings = jest.fn();
const mockDbSelect = jest.fn();

jest.mock('@/lib/user.server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: (...args: any[]) => mockGetBalanceAndOrgSettings(...args),
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

const { getUserFromAuth } = await import('@/lib/user.server');

describe('GET /api/gateway/usage', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should return 401 if not authenticated', async () => {
    (getUserFromAuth as jest.Mock).mockResolvedValue({
      user: null,
      authFailedResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const request = new NextRequest('http://localhost:3000/api/gateway/usage');
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  test('should return limits for org user with limit', async () => {
    (getUserFromAuth as jest.Mock).mockResolvedValue({
      user: { id: 'user-1' },
      authFailedResponse: null,
      organizationId: 'org-1',
    });

    mockGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1.50,
      plan: 'teams',
    });

    // Mock the db query to return a user with a limit
    mockDbSelect.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([
                    {
                      microdollarLimit: 2000000, // $2.00 in microdollars
                      microdollarUsage: 150000, // $1.50 in microdollars
                    },
                  ]),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    // We need to re-import to get fresh mocks
    const { db } = await import('@/lib/drizzle');
    (db as any).select = mockDbSelect;

    const request = new NextRequest('http://localhost:3000/api/gateway/usage');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.limits).toHaveLength(1);
    expect(data.limits[0].period).toBe('daily');
    expect(data.limits[0].used).toBe(1.50);
    expect(data.limits[0].limit).toBe(2.00);
    expect(data.plan).toBe('teams');
    expect(data.balance_usd).toBe(1.50);
  });

  test('should return empty limits for non-org user', async () => {
    (getUserFromAuth as jest.Mock).mockResolvedValue({
      user: { id: 'user-1' },
      authFailedResponse: null,
      organizationId: undefined,
    });

    mockGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      plan: null,
    });

    const request = new NextRequest('http://localhost:3000/api/gateway/usage');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.limits).toEqual([]);
    expect(data.plan).toBeNull();
  });

  test('should return empty limits for user with no limit configured', async () => {
    (getUserFromAuth as jest.Mock).mockResolvedValue({
      user: { id: 'user-1' },
      authFailedResponse: null,
      organizationId: 'org-1',
    });

    mockGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 5.00,
      plan: 'teams',
    });

    // Mock the db query to return null limit (no limit configured)
    mockDbSelect.mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([
                    {
                      microdollarLimit: null, // No limit configured
                      microdollarUsage: 0,
                    },
                  ]),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const { db } = await import('@/lib/drizzle');
    (db as any).select = mockDbSelect;

    const request = new NextRequest('http://localhost:3000/api/gateway/usage');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.limits).toEqual([]); // No limit means unlimited
    expect(data.balance_usd).toBe(5.00);
  });
});

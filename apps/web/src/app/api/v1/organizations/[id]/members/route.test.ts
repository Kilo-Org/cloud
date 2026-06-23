import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { handleTRPCRequest } from '@/lib/trpc-route-handler';
import type { GET as routeGET } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({
  handleTRPCRequest: jest.fn(),
}));

const { handleTRPCRequest: mockedHandleTRPCRequest } = jest.requireMock(
  '@/lib/trpc-route-handler'
) as {
  handleTRPCRequest: jest.MockedFunction<typeof handleTRPCRequest>;
};

let GET: typeof routeGET;

beforeAll(async () => {
  ({ GET } = await import('./route'));
});

describe('GET /api/v1/organizations/[id]/members', () => {
  it('returns public organization members without invited-member invite fields', async () => {
    const invitedMember = {
      email: 'invited@example.com',
      role: 'member' as const,
      inviteDate: '2026-06-22T00:00:00.000Z',
      inviteToken: 'secret-token',
      inviteId: 'invite-id',
      status: 'invited' as const,
      inviteUrl: 'https://example.com/users/accept-invite/secret-token',
      dailyUsageLimitUsd: null,
      currentDailyUsageUsd: null,
    };
    const withMembers = jest.fn(async (_input: { organizationId: string }) => ({
      id: 'org-id',
      name: 'Test Org',
      members: [
        {
          id: 'user-id',
          name: 'Active User',
          email: 'active@example.com',
          role: 'owner' as const,
          status: 'active' as const,
          inviteDate: null,
          dailyUsageLimitUsd: null,
          currentDailyUsageUsd: null,
        },
        invitedMember,
      ],
    }));
    const caller = {
      organizations: {
        withMembers,
      },
    };

    mockedHandleTRPCRequest.mockImplementationOnce(async (_request, handler) => {
      const result = await handler(caller as never);
      return Response.json(result) as never;
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: 'org-id' }),
    });

    expect(withMembers).toHaveBeenCalledWith({ organizationId: 'org-id' });
    expect(invitedMember).toHaveProperty('inviteToken', 'secret-token');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: 'user-id',
        name: 'Active User',
        email: 'active@example.com',
        role: 'owner',
        status: 'active',
        inviteDate: null,
        dailyUsageLimitUsd: null,
        currentDailyUsageUsd: null,
      },
      {
        email: 'invited@example.com',
        role: 'member',
        inviteDate: '2026-06-22T00:00:00.000Z',
        status: 'invited',
        dailyUsageLimitUsd: null,
        currentDailyUsageUsd: null,
      },
    ]);
  });
});

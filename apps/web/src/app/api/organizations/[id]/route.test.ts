import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { resolveOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils.server';
import { GET } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));
jest.mock('@/lib/organizations/organization-route-utils.server', () => ({
  resolveOrganizationRouteIdentifier: jest.fn(),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
const mockedResolveOrganizationRouteIdentifier = jest.mocked(resolveOrganizationRouteIdentifier);

describe('GET /api/organizations/[id]', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedResolveOrganizationRouteIdentifier.mockResolvedValue(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    mockedHandleTRPCRequest.mockImplementation(async (_request, handler) => {
      try {
        const result = await handler({
          organizations: {
            withMembers: jest.fn().mockResolvedValue({
              id: '550e8400-e29b-41d4-a716-446655440000',
              name: 'Acme',
              settings: {},
            }),
          },
        } as never);
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof TRPCError) {
          return NextResponse.json(
            { error: error.message, message: error.message },
            { status: 404 }
          );
        }
        throw error;
      }
    });
  });

  test('resolves the organization route identifier after authentication', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/organizations/acme'), {
      params: Promise.resolve({ id: 'acme' }),
    });

    expect(response.status).toBe(200);
    expect(mockedResolveOrganizationRouteIdentifier).toHaveBeenCalledWith('acme');
  });

  test('does not resolve organization slugs when authentication fails', async () => {
    mockedHandleTRPCRequest.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await GET(new NextRequest('http://localhost:3000/api/organizations/acme'), {
      params: Promise.resolve({ id: 'acme' }),
    });

    expect(response.status).toBe(401);
    expect(mockedResolveOrganizationRouteIdentifier).not.toHaveBeenCalled();
  });
});

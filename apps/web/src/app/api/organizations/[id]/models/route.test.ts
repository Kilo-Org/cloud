import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { resolveOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils.server';
import { GET } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));
jest.mock('@/lib/organizations/organization-route-utils.server', () => ({
  resolveOrganizationRouteIdentifier: jest.fn(),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
const mockedResolveOrganizationRouteIdentifier = jest.mocked(resolveOrganizationRouteIdentifier);
const listAvailableModels = jest.fn();

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'test',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
    supported_parameters: ['tools'],
  };
}

describe('GET /api/organizations/[id]/models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedResolveOrganizationRouteIdentifier.mockResolvedValue(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    listAvailableModels.mockResolvedValue({ data: [makeModel('available/model')] });
    mockedHandleTRPCRequest.mockImplementation(async (_request, handler) => {
      const result = await handler({
        organizations: { settings: { listAvailableModels } },
      } as never);
      return NextResponse.json(result);
    });
  });

  test('resolves the organization route identifier after authentication', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/organizations/acme/models'),
      { params: Promise.resolve({ id: 'acme' }) }
    );

    expect(response.status).toBe(200);
    expect(mockedResolveOrganizationRouteIdentifier).toHaveBeenCalledWith('acme');
    expect(listAvailableModels).toHaveBeenCalledWith({
      organizationId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  test('does not resolve organization slugs when authentication fails', async () => {
    mockedHandleTRPCRequest.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await GET(
      new NextRequest('http://localhost:3000/api/organizations/acme/models'),
      { params: Promise.resolve({ id: 'acme' }) }
    );

    expect(response.status).toBe(401);
    expect(mockedResolveOrganizationRouteIdentifier).not.toHaveBeenCalled();
  });
});

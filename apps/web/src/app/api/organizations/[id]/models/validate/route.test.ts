import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { resolveOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils.server';
import { POST } from './route';
import { TRPCError } from '@trpc/server';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));
jest.mock('@/lib/organizations/organization-route-utils.server', () => ({
  resolveOrganizationRouteIdentifier: jest.fn(),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
const mockedResolveOrganizationRouteIdentifier = jest.mocked(resolveOrganizationRouteIdentifier);
const listAvailableModels = jest.fn();
const ORGANIZATION_ID = '550e8400-e29b-41d4-a716-446655440000';

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

function request(modelId: string) {
  return new NextRequest('http://localhost:3000/api/organizations/acme/models/validate', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
}

describe('POST /api/organizations/[id]/models/validate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedResolveOrganizationRouteIdentifier.mockResolvedValue(ORGANIZATION_ID);
    listAvailableModels.mockResolvedValue({ data: [makeModel('available/model')] });
    mockedHandleTRPCRequest.mockImplementation(async (_request, handler) => {
      try {
        const result = await handler({
          organizations: { settings: { listAvailableModels } },
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

  test('validates against the authorized organization catalog', async () => {
    const response = await POST(request('available/model'), {
      params: Promise.resolve({ id: 'acme' }),
    });

    expect(mockedResolveOrganizationRouteIdentifier).toHaveBeenCalledWith('acme');
    expect(listAvailableModels).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    await expect(response.json()).resolves.toEqual({ valid: true });
  });

  test('reports an organization-unavailable model without policy details', async () => {
    const response = await POST(request('missing/model'), {
      params: Promise.resolve({ id: 'acme' }),
    });

    await expect(response.json()).resolves.toEqual({ valid: false, reason: 'unavailable' });
  });

  test('returns 404 when the route identifier cannot be resolved', async () => {
    mockedResolveOrganizationRouteIdentifier.mockResolvedValue(null);

    const response = await POST(request('available/model'), {
      params: Promise.resolve({ id: 'missing-org' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization not found',
      message: 'Organization not found',
    });
    expect(mockedHandleTRPCRequest).toHaveBeenCalled();
  });

  test('does not resolve organization slugs when authentication fails', async () => {
    mockedHandleTRPCRequest.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await POST(request('available/model'), {
      params: Promise.resolve({ id: 'acme' }),
    });

    expect(response.status).toBe(401);
    expect(mockedResolveOrganizationRouteIdentifier).not.toHaveBeenCalled();
  });

  test('rejects an invalid body before invoking organization authorization', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/organizations/acme/models/validate', {
        method: 'POST',
        body: JSON.stringify({ modelId: '' }),
      }),
      { params: Promise.resolve({ id: 'acme' }) }
    );

    expect(response.status).toBe(400);
    expect(mockedResolveOrganizationRouteIdentifier).not.toHaveBeenCalled();
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
  });
});

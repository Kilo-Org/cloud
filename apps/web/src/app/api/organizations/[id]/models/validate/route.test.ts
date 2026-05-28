import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { POST } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
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

function request(modelId: string) {
  return new NextRequest('http://localhost:3000/api/organizations/org-1/models/validate', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
}

describe('POST /api/organizations/[id]/models/validate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    listAvailableModels.mockResolvedValue({ data: [makeModel('available/model')] });
    mockedHandleTRPCRequest.mockImplementation(async (request, handler) => {
      const result = await handler({
        organizations: { settings: { listAvailableModels } },
      } as never);
      return NextResponse.json(result);
    });
  });

  test('validates against the authorized organization catalog', async () => {
    const response = await POST(request('available/model'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(listAvailableModels).toHaveBeenCalledWith({ organizationId: 'org-1' });
    await expect(response.json()).resolves.toEqual({ valid: true });
  });

  test('reports an organization-unavailable model without policy details', async () => {
    const response = await POST(request('missing/model'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    await expect(response.json()).resolves.toEqual({ valid: false, reason: 'unavailable' });
  });

  test('rejects an invalid body before invoking organization authorization', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/organizations/org-1/models/validate', {
        method: 'POST',
        body: JSON.stringify({ modelId: '' }),
      }),
      { params: Promise.resolve({ id: 'org-1' }) }
    );

    expect(response.status).toBe(400);
    expect(mockedHandleTRPCRequest).not.toHaveBeenCalled();
  });
});

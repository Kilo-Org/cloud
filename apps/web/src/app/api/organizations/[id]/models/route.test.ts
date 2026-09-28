import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { GET } from './route';

jest.mock('@/lib/trpc-route-handler', () => ({ handleTRPCRequest: jest.fn() }));
jest.mock('@/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/auto-model/resolution', () => ({
  getAutoFreeCandidates: jest.fn(),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
const { getCachedRoutingTable } = jest.requireMock('@/lib/ai-gateway/auto-routing-table-cache');
const { getAutoFreeCandidates } = jest.requireMock('@/lib/ai-gateway/auto-model/resolution');
const mockedGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);
const mockedGetAutoFreeCandidates = jest.mocked(getAutoFreeCandidates);
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

function request(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/organizations/org-1/models', { headers });
}

describe('GET /api/organizations/[id]/models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetCachedRoutingTable.mockResolvedValue(null);
    mockedGetAutoFreeCandidates.mockResolvedValue([]);
    mockedHandleTRPCRequest.mockImplementation(async (request, handler) => {
      const result = await handler({
        organizations: { settings: { listAvailableModels } },
      } as never);
      return NextResponse.json(result);
    });
  });

  test('annotates the organization catalog with auto-routing choices', async () => {
    const efficientModel = makeModel('kilo-auto/efficient');
    const allowedModel = makeModel('openai/gpt-5.4-mini');
    const deniedModel = 'anthropic/claude-opus-4.8';
    listAvailableModels.mockResolvedValue({
      data: [efficientModel, allowedModel],
    });
    mockedGetCachedRoutingTable.mockResolvedValue({
      routes: {
        'implementation/code_generation': [{ model: allowedModel.id }, { model: deniedModel }],
      },
    } as never);

    const response = await GET(request(), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    // Candidates outside the organization catalog (e.g. deny-listed) must not appear.
    expect(listAvailableModels).toHaveBeenCalledWith({
      organizationId: 'org-1',
    });
    await expect(response.json()).resolves.toEqual({
      data: [{ ...efficientModel, autoRouting: { models: [allowedModel.id] } }, allowedModel],
    });
  });

  test('returns the catalog unchanged when auto models are absent', async () => {
    const model = makeModel('openai/gpt-5.4-mini');
    listAvailableModels.mockResolvedValue({ data: [model] });

    const response = await GET(request(), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    await expect(response.json()).resolves.toEqual({ data: [model] });
    expect(mockedGetCachedRoutingTable).not.toHaveBeenCalled();
    expect(mockedGetAutoFreeCandidates).not.toHaveBeenCalled();
  });
});

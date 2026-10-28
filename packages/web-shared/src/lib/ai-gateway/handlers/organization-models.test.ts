import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { handleTRPCRequest } from '@kilocode/web-shared/lib/organizations/organization-settings-route-handler';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { handleOrganizationModelsRequest } from './organization-models';

jest.mock('@kilocode/web-shared/lib/organizations/organization-settings-route-handler', () => ({
  handleTRPCRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/resolution', () => ({
  getAutoFreeCandidates: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog', () => ({
  getCustomLlmsById: jest.fn(),
}));

const mockedHandleTRPCRequest = jest.mocked(handleTRPCRequest);
const { getCachedRoutingTable } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache'
);
const { getAutoFreeCandidates } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/auto-model/resolution'
);
const mockedGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);
const mockedGetAutoFreeCandidates = jest.mocked(getAutoFreeCandidates);
const listAvailableModels = jest.fn();
const { getCustomLlmsById } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog'
);
const mockedGetCustomLlmsById = jest.mocked(getCustomLlmsById);
const countryDeniedCustomLlm: CustomLlm = {
  public_id: 'acme/country-denied',
  encrypted_api_key: null,
  definition: {
    display_name: 'Country-denied custom LLM',
    context_length: 1000,
    max_completion_tokens: 100,
    base_url: 'https://upstream.example.com/v1',
    organization_ids: ['00000000-0000-4000-8000-000000000001'],
    country_deny_list: ['CU'],
  },
};

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

function request(headers?: Record<string, string>, search = '') {
  return new NextRequest(`http://localhost:3000/api/organizations/org-1/models${search}`, {
    headers,
  });
}

describe('GET /api/organizations/[id]/models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetCachedRoutingTable.mockResolvedValue(null);
    mockedGetAutoFreeCandidates.mockResolvedValue([]);
    mockedGetCustomLlmsById.mockResolvedValue(
      new Map([[countryDeniedCustomLlm.public_id, countryDeniedCustomLlm]])
    );
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

    const response = await handleOrganizationModelsRequest(request(), {
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

  test('preserves organization custom routers for both organization target pickers', async () => {
    const model = makeModel('openai/gpt-5.4-mini');
    const router = {
      ...makeModel('kilo-auto/custom/org/coding'),
      autoRouting: { models: [model.id] },
    };
    listAvailableModels.mockResolvedValue({ data: [model, router] });

    const response = await handleOrganizationModelsRequest(request(), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(listAvailableModels).toHaveBeenCalledWith({ organizationId: 'org-1' });
    await expect(response.json()).resolves.toEqual({ data: [model, router] });
  });

  test('returns the catalog unchanged when auto models are absent', async () => {
    const model = makeModel('openai/gpt-5.4-mini');
    listAvailableModels.mockResolvedValue({ data: [model] });

    const response = await handleOrganizationModelsRequest(request(), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    await expect(response.json()).resolves.toEqual({ data: [model] });
    expect(mockedGetCachedRoutingTable).not.toHaveBeenCalled();
    expect(mockedGetAutoFreeCandidates).not.toHaveBeenCalled();
  });

  test('passes the shared-services audience to the catalog', async () => {
    listAvailableModels.mockResolvedValue({ data: [] });

    await handleOrganizationModelsRequest(request(undefined, '?audience=shared_services'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(listAvailableModels).toHaveBeenCalledWith({
      organizationId: 'org-1',
      audience: 'shared_services',
    });
  });

  test('hides custom LLMs denied in the request country', async () => {
    const allowedModel = makeModel('openai/gpt-5.4-mini');
    listAvailableModels.mockResolvedValue({
      data: [allowedModel, makeModel('acme/country-denied')],
    });

    const deniedResponse = await handleOrganizationModelsRequest(
      request({ 'x-vercel-ip-country': 'CU' }),
      { params: Promise.resolve({ id: 'org-1' }) }
    );
    const unknownCountryResponse = await handleOrganizationModelsRequest(request(), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    await expect(deniedResponse.json()).resolves.toEqual({ data: [allowedModel] });
    await expect(unknownCountryResponse.json()).resolves.toEqual({
      data: [allowedModel, makeModel('acme/country-denied')],
    });
  });

  test('rejects an unknown audience', async () => {
    const response = await handleOrganizationModelsRequest(request(undefined, '?audience=bot'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(response.status).toBe(400);
    expect(listAvailableModels).not.toHaveBeenCalled();
  });
});
